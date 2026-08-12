// Bot-level tests: endgame exactness.
//
// Real endgame positions are produced by full-rules self-play (so tile
// accounting is airtight: distribution − board − my rack == opponent rack
// exactly when the bag is empty). The engine's alpha-beta+TT endgame value
// must equal a plain brute-force negamax with no pruning and no table.
#include <cstdio>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/engine.hpp"
#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"
#include "../src/selfplay.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

static long long g_refNodes = 0;
static constexpr long long REF_NODE_CAP = 3'000'000;

// Plain reference negamax: no pruning, no transposition table.
// Returns INT32_MIN when the node cap is hit (position too big to verify).
static int refNegamax(Board& board, TileCounts racks[2], int side, int streak) {
  if (++g_refNodes > REF_NODE_CAP) return INT32_MIN;

  std::vector<Move> moves;
  generatePlaceMoves(board, racks[side], moves, nullptr);

  int best = -(1 << 20);
  for (const Move& m : moves) {
    for (const Placement& p : m.placements) {
      board.place(p.row, p.col, p.kind, p.token);
      racks[side].sub(p.kind);
    }
    int v;
    if (racks[side].total == 0) {
      v = m.score + 2 * racks[1 - side].points();
    } else {
      const int sub = refNegamax(board, racks, 1 - side, 0);
      v = sub == INT32_MIN ? INT32_MIN : m.score - sub;
    }
    for (const Placement& p : m.placements) {
      board.remove(p.row, p.col);
      racks[side].add(p.kind);
    }
    if (v == INT32_MIN) return INT32_MIN;
    if (v > best) best = v;
  }
  {
    int v;
    if (streak + 1 >= NO_SCORE_STREAK_LENGTH) {
      v = racks[1 - side].points() - racks[side].points();
    } else {
      const int sub = refNegamax(board, racks, 1 - side, streak + 1);
      v = sub == INT32_MIN ? INT32_MIN : -sub;
    }
    if (v == INT32_MIN) return INT32_MIN;
    if (v > best) best = v;
  }
  return best;
}

int main() {
  int tested = 0;
  const GameSim::TierSpec fixtureBuilder{"easy", "static", 200};
  for (uint32_t seed = 1; seed <= 60 && tested < 8; seed++) {
    // Play a real game until the bag is empty and both racks are small.
    GameSim sim(seed);
    int side = 0;
    bool captured = false;
    int capturedSide = 0;
    int capturedStreak = 0;
    for (int turn = 0; turn < 200 && !sim.finished; turn++) {
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total > 0 && sim.racks[side].total <= 4 &&
          sim.racks[1 - side].total > 0 && sim.racks[1 - side].total <= 4) {
        captured = true;
        capturedSide = side;
        capturedStreak = sim.noScoreStreak;
        break;
      }
      // This loop only constructs legal endgame fixtures. The static path is
      // deterministic and avoids making this exactness test spend minutes in
      // the unrelated legacy sampler on every setup turn.
      const std::string res =
          handleRequest(sim.requestJson(side, fixtureBuilder, seed * 31 + turn));
      if (!sim.applyResponse(side, res)) {
        std::printf("seed %u: self-play broke: %s\n", seed, sim.endReason.c_str());
        CHECK(false);
        break;
      }
      side = 1 - side;
    }
    if (!captured) continue;

    // Ask the engine (through the public API) for its endgame verdict.
    const std::string res = handleRequest(sim.requestJson(capturedSide, "max", 12345));
    auto parsed = json::parse(res);
    if (!parsed || parsed->get("error")) {
      std::printf("seed %u: engine error\n", seed);
      CHECK(false);
      continue;
    }
    if (parsed->get("solver")->asString() != "endgame" || !parsed->get("endgameSolved")->asBool()) {
      continue;  // e.g. no legal placement at root; nothing exact to compare
    }
    const int engineValue = static_cast<int>(parsed->get("expectedFinalDiff")->asInt());

    // Brute-force the same position.
    g_refNodes = 0;
    Board board = sim.board;
    TileCounts racks[2] = {sim.racks[capturedSide], sim.racks[1 - capturedSide]};
    const int refValue = refNegamax(board, racks, 0, capturedStreak);
    if (refValue == INT32_MIN) continue;  // too big to brute force; skip

    if (engineValue != refValue) {
      std::printf("seed %u: engine=%d ref=%d (racks %d vs %d, streak %d)\n", seed, engineValue,
                  refValue, racks[0].total, racks[1].total, capturedStreak);
      CHECK(false);
    } else {
      std::printf("seed %u: endgame value %d confirmed (racks %d vs %d)\n", seed, engineValue,
                  racks[0].total, racks[1].total);
    }
    tested++;
  }
  std::printf("endgame exactness verified on %d positions\n", tested);
  CHECK(tested >= 3);

  if (failures == 0) {
    std::printf("ALL BOT TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
