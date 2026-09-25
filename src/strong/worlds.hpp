// STRONG's shared hidden-world schedule, matching search/worlds.ts.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <unordered_set>
#include <vector>

namespace amath::strong {

struct WorldPartition {
  std::vector<std::string> opponentRack;
  std::vector<std::string> pendingReturn;
  std::vector<std::string> bag;  // draw order, front first as in EnvState
};

inline uint32_t jsToUint32(double number) {
  if (!std::isfinite(number) || number == 0) return 0;
  double residue = std::fmod(std::trunc(number), 4294967296.0);
  if (residue < 0) residue += 4294967296.0;
  return static_cast<uint32_t>(residue);
}

class Mulberry32 {
 public:
  explicit Mulberry32(uint32_t seed) : state_(seed) {}
  double next() {
    state_ += 0x6d2b79f5u;
    uint32_t t = state_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }

 private:
  uint32_t state_;
};

inline std::vector<WorldPartition> sampleWorlds(
    const std::vector<std::string>& opponentRack,
    const std::vector<std::string>& pendingReturn,
    const std::vector<std::string>& bag,
    const std::vector<std::string>& known,
    int count, double seed) {
  if (count < 1) return {};
  const std::unordered_set<std::string> seen(known.begin(), known.end());
  std::vector<std::string> pinned, pool = bag;
  int need = 0;
  for (const std::string& id : opponentRack) {
    if (seen.contains(id)) pinned.push_back(id);
    else { pool.push_back(id); ++need; }
  }
  pool.insert(pool.end(), pendingReturn.begin(), pendingReturn.end());
  std::sort(pool.begin(), pool.end());
  std::vector<WorldPartition> worlds;
  worlds.reserve(count);
  for (int index = 0; index < count; ++index) {
    // JS evaluates this expression as binary64 before >>> 0. At large seeds the
    // product exceeds 2^53, so integer modular multiplication gives a different
    // shuffle. Separate stores preserve JS's two rounding points.
    volatile double product = seed * 2654435761.0;
    volatile double withIndex = product + static_cast<double>(index) * 40503.0;
    const uint32_t worldSeed = jsToUint32(withIndex + 1.0);
    Mulberry32 random(worldSeed);
    std::vector<std::string> shuffled = pool;
    for (int i = static_cast<int>(shuffled.size()) - 1; i > 0; --i) {
      const int j = static_cast<int>(std::floor(random.next() * (i + 1)));
      std::swap(shuffled[i], shuffled[j]);
    }
    WorldPartition world;
    world.opponentRack = pinned;
    world.opponentRack.insert(world.opponentRack.end(), shuffled.begin(), shuffled.begin() + need);
    const auto pileStart = shuffled.begin() + need;
    const auto pileEnd = pileStart + pendingReturn.size();
    world.pendingReturn.assign(pileStart, pileEnd);
    world.bag.assign(pileEnd, shuffled.end());
    worlds.push_back(std::move(world));
  }
  return worlds;
}

}  // namespace amath::strong
