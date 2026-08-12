#include "world_deck.hpp"

#include <algorithm>

#include "tiles.hpp"

namespace amath {
namespace {

uint64_t mix64(uint64_t value) {
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

uint64_t next64(uint64_t& state) {
  state += 0x9e3779b97f4a7c15ULL;
  return mix64(state);
}

void shuffle(std::vector<uint8_t>& tiles, uint64_t seed) {
  for (size_t i = tiles.size(); i > 1; i--) {
    const size_t j = static_cast<size_t>(next64(seed) % i);
    std::swap(tiles[i - 1], tiles[j]);
  }
}

}  // namespace

WorldDeckResult WorldDeck::build(const TileCounts& unseen, int opponentRackCount,
                                 int physicalBagCount, uint64_t canonicalPositionHash,
                                 uint32_t policyVersion, uint32_t maxWorlds) {
  WorldDeckResult result;
  if (opponentRackCount < 0 || physicalBagCount < 0 || maxWorlds == 0 ||
      unseen.total != opponentRackCount + physicalBagCount) {
    result.error = "inconsistent hidden inventory";
    return result;
  }

  std::vector<uint8_t> base;
  base.reserve(unseen.total);
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    for (int copy = 0; copy < unseen.n[kind]; copy++) base.push_back(kind);
  }

  result.worlds.reserve(maxWorlds);
  for (uint32_t index = 0; index < maxWorlds; index++) {
    uint64_t seed = mix64(canonicalPositionHash ^
                          (static_cast<uint64_t>(policyVersion) << 32) ^ index);
    std::vector<uint8_t> pool = base;
    shuffle(pool, seed);

    HiddenWorld world;
    for (int tile = 0; tile < opponentRackCount; tile++) {
      world.opponentRack.add(pool.back());
      pool.pop_back();
    }
    world.orderedBag = std::move(pool);
    world.randomTapeKey = mix64(seed ^ 0xd1b54a32d192ed03ULL);
    world.weight = 1.0 / static_cast<double>(maxWorlds);
    result.worlds.push_back(std::move(world));
  }
  result.ok = true;
  return result;
}

uint64_t WorldDeck::eventSeed(const HiddenWorld& world, uint64_t candidateKey,
                              uint32_t ply, uint32_t eventOrdinal) {
  uint64_t key = world.randomTapeKey;
  key ^= mix64(candidateKey + 0x9e3779b97f4a7c15ULL);
  key ^= mix64((static_cast<uint64_t>(ply) << 32) | eventOrdinal);
  return mix64(key);
}

}  // namespace amath
