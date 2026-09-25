// What a rack we would KEEP is worth — STRONG's leave heuristic, ported exactly.
//
// ORDERING ONLY, NEVER A VALUE. It is added to an immediate score to rank candidates before
// anything expensive looks at them, and the two are not in the same unit. Nothing downstream
// may read the sum as points.
//
// The shape is deliberate and each term answers a different way a rack goes wrong:
//   * `balance` rewards having some of each thing, and saturates — a fifth number is worth
//     nothing where a first operator is worth four,
//   * blanks are paid twice, inside `balance` as both an operator and an equals, and again
//     outright, because a blank is whichever tile the board turns out to need,
//   * numbers past five are penalised, because a rack that is all numbers cannot make an
//     equation at all,
//   * points enter at 0.15, small enough to break ties without ever outweighing shape.
//
// This is a straight port of `keepQuality` in amath-bot-lab's `src/strong/selector.ts`, gated
// against it in `tests/test_strong_keep.cpp`. The constants are frozen there, not tuned here.
#pragma once

#include <algorithm>

#include "../tiles.hpp"

namespace amath::strong {

/** Point value of a physical tile kind, indexed by TileKind. Mirrors EQ-Lab's tile table. */
inline int kindPoints(uint8_t kind) {
  static constexpr int kPoints[] = {
      1, 1, 1, 1, 2, 2, 2, 2, 2, 2,  // 0..9
      3, 4, 3, 6, 4, 4, 4, 6, 4, 7,  // 10..19
      5,                             // 20
      2, 2, 2, 2,                    // + - × ÷
      1, 1,                          // +/-  x//
      1,                             // =
      0,                             // ?
  };
  return kind < (sizeof(kPoints) / sizeof(kPoints[0])) ? kPoints[kind] : 0;
}

/** `kinds` is a rack as TileKind values — the tiles that would be LEFT, not the ones played. */
inline double keepQuality(const uint8_t* kinds, size_t count) {
  int digits = 0;
  int ops = 0;
  int eq = 0;
  int blanks = 0;
  int heavy = 0;
  int points = 0;
  for (size_t i = 0; i < count; ++i) {
    const uint8_t k = kinds[i];
    points += kindPoints(k);
    if (k <= K_NUM20 && k <= 9) digits += 1;              // 0..9
    else if (k == K_EQUALS) eq += 1;
    else if (k == K_BLANK) blanks += 1;
    else if (k == K_ADD || k == K_SUB || k == K_MUL || k == K_DIV || k == K_PM || k == K_MD)
      ops += 1;
    else heavy += 1;                                       // 10..20
  }
  const int numbers = digits + heavy;
  const int balance =
      std::min(numbers, 4) * 2 + std::min(ops + blanks, 2) * 4 + std::min(eq + blanks, 1) * 6;
  const int shape = balance + blanks * 3 - std::max(0, numbers - 5) * 2;
  // The multiply is given its own statement so the compiler cannot fuse it with the add.
  // `-O2` on this machine contracts `shape + points * 0.15` into an FMA, which rounds once
  // where JavaScript rounds twice; that is a one-ulp difference, and one ulp is enough to
  // break a tie the other way and choose a different move. Measured: 23 of 3 629 racks.
  const double weightedPoints = points * 0.15;
  return shape + weightedPoints;
}

template <typename Container>
inline double keepQuality(const Container& kinds) {
  return keepQuality(kinds.data(), kinds.size());
}

}  // namespace amath::strong
