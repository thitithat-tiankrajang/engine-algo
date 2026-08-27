#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "board.hpp"

namespace amath {

struct HiddenWorld {
  TileCounts opponentRack;
  std::vector<uint8_t> orderedBag;  // draw from back
  uint64_t randomTapeKey = 0;
  double weight = 0.0;
};

struct WorldDeckResult {
  bool ok = false;
  std::string error;
  std::vector<HiddenWorld> worlds;
};

class WorldDeck {
 public:
  static WorldDeckResult build(const TileCounts& unseen, int opponentRackCount,
                               int physicalBagCount, uint64_t canonicalPositionHash,
                               uint32_t policyVersion, uint32_t maxWorlds);

  static uint64_t eventSeed(const HiddenWorld& world, uint64_t candidateKey,
                            uint32_t ply, uint32_t eventOrdinal);
};

}  // namespace amath
