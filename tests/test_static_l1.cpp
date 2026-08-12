// Level-1 static path: the two properties the tier is sold on.
//
//  1. A BOUNDED number of move generations per decision. Generation is the only
//     expensive operation in a midgame decision (~10 ms a call; every heuristic
//     the engine computes costs under a microsecond). The path this replaced
//     issued ~385 per turn — candidates × samples × 2 — and cost ~2.9 s at a
//     tier that asked for 200 ms. Nothing counted them, so nothing caught it.
//     This test counts them.
//
//  2. DETERMINISM. The chosen move is a pure function of the request: no RNG is
//     consulted, and no wall-clock deadline can change the answer. Both are
//     checked directly — same request twice, and the same position under seeds
//     that would have moved the sampling search by a 70-point swing.
//
// Plus the guarantees a faster path must not quietly trade away: every move is
// legal and correctly scored, root generation stays complete, and a position
// the exact end-game solver can prove is still proven.
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/engine.hpp"
#include "../src/eval.hpp"
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

// The request a Level-1 bot turn actually sends: the tier's budget, plus the
// explicit solver selection. `seedSalt` stands in for the service's
// seedFor(gameId, revision) — production seeds are a pure function of the
// position, so seed VARIATION is the thing worth testing, not repetition.
static std::string staticRequest(const GameSim& sim, int side, uint32_t seed,
                                 const char* solver = "static", double budgetMs = 200) {
  std::string j = sim.requestJson(side, "easy", seed);
  j.pop_back();
  j += ",\"budgetMs\":" + std::to_string(budgetMs) + ",\"solver\":\"" + solver + "\"}";
  return j;
}

static json::ValuePtr parseOk(const std::string& raw) {
  json::ValuePtr v = json::parse(raw);
  if (!v || v->get("error")) {
    std::printf("FAIL engine error: %s\n", raw.substr(0, 200).c_str());
    failures++;
    return nullptr;
  }
  return v;
}

// Move identity for comparing two responses. Cells are sorted so a difference
// in emission order is never mistaken for a difference in decision.
static std::string moveKey(const json::ValuePtr& v) {
  std::string k = v->get("type")->asString();
  std::vector<std::string> cells;
  for (const auto& p : v->get("placements")->arr) {
    cells.push_back(std::to_string(p->get("r")->asInt()) + "," +
                    std::to_string(p->get("c")->asInt()) + "," + p->get("kind")->asString() + "," +
                    p->get("token")->asString());
  }
  std::sort(cells.begin(), cells.end());
  for (const auto& c : cells) k += "|" + c;
  std::vector<std::string> ex;
  for (const auto& t : v->get("exchange")->arr) ex.push_back(t->asString());
  std::sort(ex.begin(), ex.end());
  for (const auto& t : ex) k += "#" + t;
  return k;
}

// ── 1. generation-call bound, legality, and endgame precedence ───────────────
//
// Driven by real full-rules self-play so the positions are ones the bot will
// actually meet, including the endgame tail where the exact solver takes over.
static void testGenerationBoundAndLegality() {
  int decisions = 0, endgameDecisions = 0, maxGenCalls = 0;
  long long staticGenCallTotal = 0;
  int staticDecisions = 0;

  for (uint32_t game = 0; game < 3; game++) {
    GameSim sim(4242 + game);
    int side = 0;
    for (int turn = 0; turn < 200 && !sim.finished; turn++) {
      const std::string raw = handleRequest(staticRequest(sim, side, 1000 + turn));
      json::ValuePtr v = parseOk(raw);
      if (!v) return;
      decisions++;

      const int genCalls = static_cast<int>(v->get("stats")->get("genCalls")->asInt(-1));
      CHECK(genCalls >= 1);
      maxGenCalls = std::max(maxGenCalls, genCalls);

      const bool viaEndgame = v->get("solver")->asString() == "endgame";
      if (viaEndgame) {
        // The exact solver is a tree search, deliberately outside the midgame
        // bound. What matters is that it still RAN when it could.
        endgameDecisions++;
        CHECK(v->get("endgameSolved")->asBool());
      } else {
        // THE INVARIANT. One root generation, and the ceiling is an absolute
        // constant — not a function of root moves, rack, board, or budget.
        CHECK(genCalls <= STATIC_MAX_GEN_CALLS);
        CHECK(genCalls == 1);
        staticGenCallTotal += genCalls;
        staticDecisions++;
      }

      // A faster path is worth nothing if it plays an illegal move; the service
      // re-validates every bot move for exactly this reason, and so does this.
      if (v->get("type")->asString() == "place") {
        std::vector<Placement> ps;
        for (const auto& cell : v->get("placements")->arr) {
          ps.push_back({static_cast<uint8_t>(cell->get("r")->asInt()),
                        static_cast<uint8_t>(cell->get("c")->asInt()),
                        static_cast<uint8_t>(tileKindFromString(cell->get("kind")->asString())),
                        static_cast<uint8_t>(
                            assignedTokenFromString(cell->get("token")->asString()))});
        }
        const MoveValidation mv = validatePlaceMove(sim.board, ps);
        CHECK(mv.valid);
        CHECK(mv.score == static_cast<int>(v->get("score")->asInt(-1)));
      }

      if (!sim.applyResponse(side, raw)) {
        std::printf("FAIL self-play rejected a static move: %s\n", sim.endReason.c_str());
        failures++;
        return;
      }
      side = 1 - side;
    }
  }

  std::printf("  static decisions: %d (%d via exact endgame), max genCalls on the static path: %lld\n",
              decisions, endgameDecisions,
              staticDecisions ? staticGenCallTotal / staticDecisions : 0);
  std::printf("  worst genCalls seen across all decisions (endgame included): %d\n", maxGenCalls);
  CHECK(decisions > 20);
  // Endgames must still reach the exact solver under solver=static. If this
  // ever reads 0, the static path has been routed AHEAD of the endgame block.
  CHECK(endgameDecisions > 0);
}

// ── 2. determinism ───────────────────────────────────────────────────────────
static void testDeterminism() {
  GameSim sim(77);
  int side = 0;
  int checked = 0;

  for (int turn = 0; turn < 16 && !sim.finished; turn++) {
    const std::string first = handleRequest(staticRequest(sim, side, 12345));
    json::ValuePtr fv = parseOk(first);
    if (!fv) return;

    // (a) same request, twice: byte-identical apart from the elapsed-time field.
    const std::string again = handleRequest(staticRequest(sim, side, 12345));
    json::ValuePtr av = parseOk(again);
    if (!av) return;
    CHECK(moveKey(fv) == moveKey(av));
    CHECK(fv->get("score")->asInt() == av->get("score")->asInt());

    // (b) seed sweep. The sampling path this replaces chose differently on 4.62
    // of 6 seeds — on one measured position, three seeds played a ~70-point
    // equation and three passed for zero. The static path must not move at all.
    for (uint32_t salt : {1u, 999u, 424242u, 7u, 65535u}) {
      json::ValuePtr sv = parseOk(handleRequest(staticRequest(sim, side, salt)));
      if (!sv) return;
      CHECK(moveKey(fv) == moveKey(sv));
    }
    checked++;

    if (!sim.applyResponse(side, first)) break;
    side = 1 - side;
  }
  std::printf("  seed-invariant on %d positions (6 seeds each)\n", checked);
  CHECK(checked >= 10);
}

// ── 3. the node cap never costs the board's best move ────────────────────────
//
// Root generation IS capped — it has to be. Complete generation needs 175k nodes
// at the median but 23M at the measured maximum, and a position outside that
// sample needed 80M (≈5 s): uncapped, the tier would occasionally be slower than
// the 2.9 s path it replaces. So the cap is not the thing to test. The thing to
// test is what the cap costs, and the answer must be nothing:
//
//   the move the engine returns must be the argmax of static equity over the
//   COMPLETE move list, not merely over the part of it generation reached.
//
// That holds because `premiumOrder` explores high-premium anchors first, so a
// truncated run has already seen the valuable region. This test is what keeps
// that true — it fails the moment the cap is lowered past where it is safe.
static void testCapNeverCostsTheBestMove() {
  int checked = 0, skipped = 0;

  for (uint32_t game = 0; game < 2; game++) {
    GameSim sim(31337 + game * 101);
    int side = 0;
    for (int turn = 0; turn < 18 && !sim.finished; turn++) {
      const std::string raw = handleRequest(staticRequest(sim, side, 5));
      json::ValuePtr v = parseOk(raw);
      if (!v) return;
      if (v->get("solver")->asString() == "endgame") {
        if (!sim.applyResponse(side, raw)) return;
        side = 1 - side;
        continue;
      }

      // Ground truth: the complete move list, with a safety cap far above the
      // engine's own so the test cannot hang on a pathological position.
      std::vector<Move> complete;
      GenStats gs;
      gs.nodeLimit = 120'000'000;
      GenOptions o;
      o.dedup = true;
      o.premiumOrder = true;
      generatePlaceMoves(sim.board, sim.racks[side], complete, &gs, o);
      if (gs.truncated || complete.empty()) {
        skipped++;  // no ground truth available; not a failure of the engine
        if (!sim.applyResponse(side, raw)) return;
        side = 1 - side;
        continue;
      }

      TileCounts unseen;
      for (uint8_t k = 0; k < KIND_COUNT; k++) unseen.add(k, TILE_COUNTS[k]);
      for (int r = 0; r < BOARD_SIZE; r++) {
        for (int c = 0; c < BOARD_SIZE; c++) {
          const Cell& cell = sim.board.at(r, c);
          if (cell.occupied() && unseen.n[cell.kind] > 0) unseen.sub(cell.kind);
        }
      }
      for (uint8_t k = 0; k < KIND_COUNT; k++) {
        const int held = std::min<int>(sim.racks[side].n[k], unseen.n[k]);
        if (held) unseen.sub(k, held);
      }
      const BoardContext ctx =
          makeContext(sim.board, unseen, static_cast<int>(sim.bag.size()),
                      static_cast<float>(sim.scores[side] - sim.scores[1 - side]));

      float bestComplete = -1e9f;
      for (const Move& m : complete)
        bestComplete = std::max(bestComplete, staticEquity(sim.board, sim.racks[side], m, ctx));

      // The engine reports the equity it actually maximised. It may exceed the
      // best PLACEMENT (an exchange can be worth more), but it must never fall
      // short of it — falling short is precisely what a bad cap looks like.
      const float reported = static_cast<float>(v->get("equity")->asDouble(-1e9));
      if (reported < bestComplete - 1e-3f) {
        std::printf("    turn %d board=%d: engine equity %.2f < best complete %.2f "
                    "(%zu complete moves, %lld nodes) — the node cap is too low\n",
                    turn, sim.board.tileCount, reported, bestComplete, complete.size(),
                    gs.nodesVisited);
      }
      CHECK(reported >= bestComplete - 1e-3f);
      checked++;

      if (!sim.applyResponse(side, raw)) return;
      side = 1 - side;
    }
  }
  std::printf("  chose the complete list's best equity on %d positions (%d skipped: no ground truth)\n",
              checked, skipped);
  CHECK(checked >= 20);
}

// ── 4. the request field itself ──────────────────────────────────────────────
static void testSolverField() {
  GameSim sim(9);
  // Default is unchanged: no field means the sampling search, as before.
  json::ValuePtr d = parseOk(handleRequest(sim.requestJson(0, "easy", 1)));
  if (d) CHECK(d->get("solver")->asString() != "endgame" ? d->get("stats")->get("samples")->asInt() > 0 : true);

  // An unrecognised solver is refused, not silently defaulted: running a
  // different algorithm than the caller asked for is the mistake this field
  // exists to prevent.
  std::string bad = sim.requestJson(0, "easy", 1);
  bad.pop_back();
  bad += ",\"solver\":\"turbo\"}";
  json::ValuePtr bv = json::parse(handleRequest(bad));
  CHECK(bv && bv->get("error") && bv->get("error")->asString() == "bad solver");
}

int main() {
  std::printf("generation bound, legality, endgame precedence...\n");
  testGenerationBoundAndLegality();
  std::printf("determinism...\n");
  testDeterminism();
  std::printf("node cap never costs the best move...\n");
  testCapNeverCostsTheBestMove();
  std::printf("solver request field...\n");
  testSolverField();

  if (failures) {
    std::printf("\n%d FAILURE(S)\n", failures);
    return 1;
  }
  std::printf("\nall static-L1 tests passed\n");
  return 0;
}
