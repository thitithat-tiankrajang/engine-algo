// Engine self-tests:
//  1. rational arithmetic
//  2. line validation (cases mirrored from EQ-Lab semantics)
//  3. movegen soundness  — every generated move passes the full validator with
//     the same score, and no duplicates are produced
//  4. movegen completeness — matches a brute-force reference enumerator on
//     random positions with small racks
#include <cassert>
#include <cstdio>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/movegen.hpp"
#include "../src/rational.hpp"
#include "../src/rules.hpp"
#include "../src/tiles.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
      failures++;                                                      \
    }                                                                  \
  } while (0)

// ── helpers ──────────────────────────────────────────────────────────────────

static std::vector<uint8_t> toks(const std::vector<std::string>& parts) {
  std::vector<uint8_t> out;
  for (const auto& p : parts) {
    const int t = assignedTokenFromString(p);
    assert(t >= 0);
    out.push_back(static_cast<uint8_t>(t));
  }
  return out;
}

static bool lineValid(const std::vector<std::string>& parts) {
  const auto t = toks(parts);
  return validateLine(t.data(), static_cast<int>(t.size())).valid;
}

static std::string moveSignature(const Move& m) {
  std::vector<std::string> parts;
  for (const Placement& p : m.placements) {
    std::ostringstream ss;
    ss << int(p.row) << "," << int(p.col) << "," << int(p.kind) << "," << int(p.token);
    parts.push_back(ss.str());
  }
  std::sort(parts.begin(), parts.end());
  std::string sig;
  for (const auto& s : parts) sig += s + ";";
  return sig;
}

// ── 1. rational ──────────────────────────────────────────────────────────────

static void testRational() {
  const Rational a = Rational::fromInt(1) / Rational::fromInt(3);
  const Rational b = Rational::fromInt(2) / Rational::fromInt(6);
  CHECK(a == b);
  CHECK((a * Rational::fromInt(3)) == Rational::fromInt(1));
  CHECK(!(Rational::fromInt(1) / Rational::fromInt(0)).isValid());
  const Rational half = Rational::fromInt(1) / Rational::fromInt(2);
  const Rational sum = half + half;
  CHECK(sum == Rational::fromInt(1));
  const Rational neg = Rational::fromInt(0) - half;
  CHECK(neg.num == -1 && neg.den == 2);
  // 3/2 == 6/4 exactly (float would also pass; exactness is the contract)
  CHECK((Rational::fromInt(3) / Rational::fromInt(2)) ==
        (Rational::fromInt(6) / Rational::fromInt(4)));
}

// ── 2. line validation ───────────────────────────────────────────────────────

static void testLines() {
  CHECK(lineValid({"1", "+", "2", "=", "3"}));
  CHECK(lineValid({"3", "=", "3"}));
  CHECK(lineValid({"1", "2", "=", "12"}));           // digits 1,2 vs tens tile 12
  CHECK(lineValid({"1", "2", "=", "3", "×", "4"}));  // 12 = 3×4
  CHECK(lineValid({"2", "0", "=", "20"}));
  CHECK(lineValid({"20", "=", "2", "0"}));
  CHECK(lineValid({"12", "20", "=", "1"}) == false);       // tens tiles adjacent
  CHECK(lineValid({"1", "12", "=", "1"}) == false);        // digit adjacent to tens tile
  CHECK(lineValid({"12", "1", "=", "1"}) == false);        // tens tile adjacent to digit
  CHECK(lineValid({"1", "0", "+", "2", "=", "12"}));       // 10+2 = tens 12
  CHECK(lineValid({"1", "0", "+", "2", "=", "1", "2"}));   // 10+2=12 via digits
  CHECK(lineValid({"-", "1", "+", "2", "=", "1"}));            // leading unary minus
  CHECK(lineValid({"1", "-", "2", "=", "-", "1"}));            // unary minus after =
  CHECK(lineValid({"=", "1"}) == false);                       // starts with operator
  CHECK(lineValid({"1", "="}) == false);                       // ends with operator
  CHECK(lineValid({"1", "+", "+", "2", "=", "3"}) == false);   // adjacent operators
  CHECK(lineValid({"1", "=", "1", "=", "1"}));                 // multiple equals
  CHECK(lineValid({"1", "=", "1", "=", "2"}) == false);
  CHECK(lineValid({"4", "÷", "0", "=", "4"}) == false);        // "/0"
  CHECK(lineValid({"0", "÷", "4", "=", "0"}));                 // 0/4 fine
  CHECK(lineValid({"-", "0", "=", "0"}) == false);             // "-0"
  CHECK(lineValid({"5", "-", "0", "=", "5"}));                 // binary minus zero fine
  CHECK(lineValid({"1", "2", "3", "4", "=", "4"}) == false);  // 4-digit number
  CHECK(lineValid({"1", "2", "3", "+", "1", "=", "1", "2", "4"}));  // 123+1=124
  CHECK(lineValid({"0", "5", "=", "5"}) == false);             // leading zero
  CHECK(lineValid({"0", "=", "0"}));
  CHECK(lineValid({"1", "0", "=", "10"}));                     // digits 1,0 vs tens 10
  CHECK(lineValid({"1", "+", "2", "3"}) == false);             // missing equals
  CHECK(lineValid({"2", "+", "3", "×", "4", "=", "1", "4"}));  // precedence: 2+12=14
  CHECK(lineValid({"2", "+", "3", "×", "4", "=", "20"}) == false);
  CHECK(lineValid({"1", "÷", "2", "=", "2", "÷", "4"}));       // exact fractions
  CHECK(lineValid({"1", "÷", "3", "=", "2", "÷", "6"}));
  CHECK(lineValid({"7", "÷", "2", "÷", "2", "=", "7", "÷", "4"}));  // chained division
  CHECK(lineValid({"-", "2", "×", "3", "+", "7", "=", "1"}));  // -(2×3)+7 = 1
  CHECK(lineValid({"20", "×", "20", "=", "4", "0", "0"}));
  CHECK(lineValid({"19", "+", "1", "=", "20"}));
  CHECK(lineValid({"1", "0", "0", "=", "9", "9"}) == false);   // 100 != 99
  CHECK(lineValid({"1", "0", "0", "=", "10", "×", "10"}));     // 100 = 10×10
}

// ── board building helpers ───────────────────────────────────────────────────

struct Bag {
  std::vector<uint8_t> tiles;
  std::mt19937 rng;

  explicit Bag(uint32_t seed) : rng(seed) {
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      for (int i = 0; i < TILE_COUNTS[k]; i++) tiles.push_back(k);
    }
    std::shuffle(tiles.begin(), tiles.end(), rng);
  }

  bool draw(uint8_t& kind) {
    if (tiles.empty()) return false;
    kind = tiles.back();
    tiles.pop_back();
    return true;
  }
};

static void applyMove(Board& board, TileCounts& rack, const Move& m) {
  for (const Placement& p : m.placements) {
    board.place(p.row, p.col, p.kind, p.token);
    rack.sub(p.kind);
  }
}

// ── 3+4. movegen soundness & completeness ────────────────────────────────────

// Brute-force reference: enumerate every subset of empty cells on a single
// line (with continuity through existing tiles), every distinct assignment of
// rack tiles to those cells, and keep what the full validator accepts.
static void bruteForce(const Board& board, const TileCounts& rack,
                       std::set<std::pair<std::string, int>>& found) {
  std::vector<Placement> current;

  struct Rec {
    const Board& board;
    std::set<std::pair<std::string, int>>& found;
    std::vector<Placement>& current;
    TileCounts rack;

    void assign(const std::vector<std::pair<int, int>>& cells, size_t i) {
      if (i == cells.size()) {
        const MoveValidation v = validatePlaceMove(board, current);
        if (v.valid) {
          Move m;
          m.placements = current;
          found.insert({moveSignature(m), v.score});
        }
        return;
      }
      for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
        if (rack.n[kind] == 0) continue;
        uint32_t mask = kindAssignMask(kind);
        while (mask) {
          const uint8_t token = static_cast<uint8_t>(__builtin_ctz(mask));
          mask &= mask - 1;
          rack.sub(kind);
          current.push_back({static_cast<uint8_t>(cells[i].first),
                             static_cast<uint8_t>(cells[i].second), kind, token});
          assign(cells, i + 1);
          current.pop_back();
          rack.add(kind);
        }
      }
    }
  };

  Rec rec{board, found, current, rack};

  for (int axis = 0; axis < 2; axis++) {
    for (int line = 0; line < BOARD_SIZE; line++) {
      // Empty cells along this line.
      std::vector<std::pair<int, int>> empties;
      for (int i = 0; i < BOARD_SIZE; i++) {
        const int r = axis == 0 ? line : i;
        const int c = axis == 0 ? i : line;
        if (!board.at(r, c).occupied()) empties.push_back({r, c});
      }
      const int n = static_cast<int>(empties.size());
      const int maxK = std::min(rack.total, n);
      // All subsets up to maxK (bitmask over empties, n <= 15).
      for (uint32_t bits = 1; bits < (1u << n); bits++) {
        if (__builtin_popcount(bits) > maxK) continue;
        std::vector<std::pair<int, int>> cells;
        for (int i = 0; i < n; i++) {
          if (bits & (1u << i)) cells.push_back(empties[i]);
        }
        // Quick continuity check to keep the search tractable: span between
        // first and last chosen cell must have no empty holes.
        bool contiguous = true;
        {
          const int lo = axis == 0 ? cells.front().second : cells.front().first;
          const int hi = axis == 0 ? cells.back().second : cells.back().first;
          size_t next = 0;
          for (int v = lo; v <= hi && contiguous; v++) {
            const int r = axis == 0 ? line : v;
            const int c = axis == 0 ? v : line;
            if (next < cells.size() && cells[next].first == r && cells[next].second == c) {
              next++;
            } else if (!board.at(r, c).occupied()) {
              contiguous = false;
            }
          }
        }
        if (!contiguous) continue;
        rec.assign(cells, 0);
      }
    }
  }
}

static void testMovegen() {
  std::mt19937 rng(12345);

  for (uint32_t seed = 1; seed <= 6; seed++) {
    Bag bag(seed);
    Board board;
    TileCounts rack;
    for (int i = 0; i < RACK_SIZE; i++) {
      uint8_t k;
      if (bag.draw(k)) rack.add(k);
    }

    // Play up to 10 random engine moves to build a position, checking
    // soundness at every step.
    for (int turn = 0; turn < 10; turn++) {
      std::vector<Move> moves;
      GenStats stats;
      generatePlaceMoves(board, rack, moves, &stats);

      // Soundness + no duplicates.
      std::set<std::string> sigs;
      for (const Move& m : moves) {
        const MoveValidation v = validatePlaceMove(board, m.placements);
        if (!v.valid || v.score != m.score) {
          std::printf("  seed=%u turn=%d BAD MOVE (valid=%d gen=%d val=%d)\n", seed, turn,
                      int(v.valid), m.score, v.score);
          CHECK(false);
        }
        if (!sigs.insert(moveSignature(m)).second) {
          std::printf("  seed=%u turn=%d DUPLICATE move\n", seed, turn);
          CHECK(false);
        }
      }

      if (moves.empty()) break;
      const Move& pick = moves[rng() % moves.size()];
      applyMove(board, rack, pick);
      while (rack.total < RACK_SIZE) {
        uint8_t k;
        if (!bag.draw(k)) break;
        rack.add(k);
      }
    }

    // Completeness on this final position with a small rack (subset of the
    // real rack, sized 2..4 to keep brute force tractable).
    for (int sub = 2; sub <= 4; sub++) {
      TileCounts small;
      int taken = 0;
      for (uint8_t k = 0; k < KIND_COUNT && taken < sub; k++) {
        for (int i = 0; i < rack.n[k] && taken < sub; i++) {
          small.add(k);
          taken++;
        }
      }
      if (small.total == 0) continue;

      std::vector<Move> moves;
      generatePlaceMoves(board, small, moves, nullptr);
      std::set<std::pair<std::string, int>> genSet;
      for (const Move& m : moves) genSet.insert({moveSignature(m), m.score});

      std::set<std::pair<std::string, int>> refSet;
      bruteForce(board, small, refSet);

      if (genSet != refSet) {
        std::printf("  seed=%u sub=%d COMPLETENESS MISMATCH gen=%zu ref=%zu\n", seed, sub,
                    genSet.size(), refSet.size());
        for (const auto& e : refSet) {
          if (!genSet.count(e)) std::printf("    missing: %s score=%d\n", e.first.c_str(), e.second);
        }
        for (const auto& e : genSet) {
          if (!refSet.count(e)) std::printf("    extra:   %s score=%d\n", e.first.c_str(), e.second);
        }
        CHECK(false);
      }
    }
  }
}

int main() {
  testRational();
  testLines();
  testMovegen();
  if (failures == 0) {
    std::printf("ALL TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
