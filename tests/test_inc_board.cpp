// Phase 2 test: prove the incrementally-maintained board state is byte-identical
// to a full rebuild after every make/unmake, on real move sequences, and that
// undoMove exactly restores the prior state. Also benchmarks incremental
// make+unmake vs full rebuild.
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/inc_board.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"
#include "../src/selfplay.hpp"

using namespace amath;

static int failures = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); failures++; } \
  } while (0)

// A deterministic legal placement chosen from complete generation (node-bounded
// so the reach is machine-independent).
static bool pickMove(const Board& b, const TileCounts& rack, Move& out) {
  GenOptions o; o.dedup = true; o.premiumOrder = true;
  GenStats st; st.nodeLimit = 1'000'000;
  std::vector<Move> moves; generatePlaceMoves(b, rack, moves, &st, o);
  if (moves.empty()) return false;
  size_t best = 0; for (size_t i = 1; i < moves.size(); i++) if (moves[i].score > moves[best].score) best = i;
  out = moves[best];
  return true;
}

int main() {
  int stepsChecked = 0, undoChecked = 0;

  for (uint32_t seed = 1; seed <= 40; seed++) {
    GameSim sim(seed);
    IncrementalBoard inc;              // starts empty
    inc.rebuild();
    CHECK(inc.assertConsistent("empty"));

    int side = 0;
    std::vector<std::vector<Placement>> history;  // for full unwind
    for (int turn = 0; turn < 60 && !sim.finished; turn++) {
      Move m;
      if (!pickMove(sim.board, sim.racks[side], m)) {
        // no legal placement: pass (advances the sim, no board change)
        if (!sim.applyResponse(side, "{\"type\":\"pass\"}")) break;
        side = 1 - side;
        continue;
      }

      // (a) undo round-trip: make then immediately unmake must restore state.
      const uint64_t hBefore = inc.hash;
      inc.makeMove(m.placements);
      CHECK(inc.assertConsistent("after-make"));
      inc.undoMove(m.placements);
      CHECK(inc.hash == hBefore);
      CHECK(inc.assertConsistent("after-undo"));
      undoChecked++;

      // (b) commit the move for real, into BOTH the sim and the incremental board.
      auto resp = json::makeObject();
      resp->obj["type"] = json::makeString("place");
      auto arr = json::makeArray();
      for (const Placement& p : m.placements) {
        auto e = json::makeObject();
        e->obj["r"] = json::makeInt(p.row); e->obj["c"] = json::makeInt(p.col);
        e->obj["kind"] = json::makeString(tileKindToString(p.kind));
        e->obj["token"] = json::makeString(assignedTokenToString(p.token));
        arr->arr.push_back(e);
      }
      resp->obj["placements"] = arr; resp->obj["score"] = json::makeInt(m.score);
      if (!sim.applyResponse(side, json::stringify(resp))) {
        std::printf("seed %u: sim rejected engine move — harness bug\n", seed);
        break;
      }
      inc.makeMove(m.placements);
      history.push_back(m.placements);
      CHECK(inc.assertConsistent("committed"));
      stepsChecked++;
      side = 1 - side;
    }

    // (c) full unwind: undo every committed move; must land back on empty state.
    for (auto it = history.rbegin(); it != history.rend(); ++it) {
      inc.undoMove(*it);
      CHECK(inc.assertConsistent("unwind"));
    }
    IncrementalBoard emptyRef; emptyRef.rebuild();
    CHECK(inc.hash == emptyRef.hash);
  }

  std::printf("consistency: %d committed steps + %d undo round-trips verified\n",
              stepsChecked, undoChecked);

  // ── benchmark: incremental make+unmake vs full rebuild on a mid-full board ──
  {
    GameSim sim(7);
    int side = 0;
    for (int t = 0; t < 30 && !sim.finished; t++) {
      Move m; if (!pickMove(sim.board, sim.racks[side], m)) break;
      auto resp = json::makeObject(); resp->obj["type"] = json::makeString("place");
      auto arr = json::makeArray();
      for (const Placement& p : m.placements) { auto e = json::makeObject();
        e->obj["r"]=json::makeInt(p.row); e->obj["c"]=json::makeInt(p.col);
        e->obj["kind"]=json::makeString(tileKindToString(p.kind));
        e->obj["token"]=json::makeString(assignedTokenToString(p.token)); arr->arr.push_back(e); }
      resp->obj["placements"]=arr; resp->obj["score"]=json::makeInt(m.score);
      if (!sim.applyResponse(side, json::stringify(resp))) break; side = 1 - side;
    }
    IncrementalBoard inc; inc.board = sim.board; inc.rebuild();
    std::printf("benchmark board: %d tiles\n", sim.board.tileCount);

    // a single legal one-tile-ish move to make/unmake repeatedly
    Move probe; bool have = pickMove(sim.board, sim.racks[side], probe);
    const int iters = 200000;
    using Clock = std::chrono::steady_clock;

    double rebuildMs = 0, incMs = 0;
    {
      auto t0 = Clock::now();
      for (int i = 0; i < iters; i++) inc.rebuild();
      rebuildMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    }
    if (have) {
      auto t0 = Clock::now();
      for (int i = 0; i < iters; i++) { inc.makeMove(probe.placements); inc.undoMove(probe.placements); }
      incMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
      CHECK(inc.assertConsistent("post-bench"));
    }
    // representative deep-search case: a SINGLE-tile make/unmake (most nodes deep
    // in the tree place one tile). Any empty cell works for timing the state
    // maintenance; consistency is re-asserted afterwards.
    double inc1Ms = 0;
    {
      int er = -1, ec = -1;
      for (int r = 0; r < BOARD_SIZE && er < 0; r++)
        for (int c = 0; c < BOARD_SIZE; c++)
          if (!inc.board.at(r, c).occupied()) { er = r; ec = c; break; }
      if (er >= 0) {
        std::vector<Placement> one{{(uint8_t)er, (uint8_t)ec, (uint8_t)1, (uint8_t)1}};  // kind=1 (num "1"), token=1
        auto t0 = Clock::now();
        for (int i = 0; i < iters; i++) { inc.makeMove(one); inc.undoMove(one); }
        inc1Ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
        CHECK(inc.assertConsistent("post-bench-1tile"));
      }
    }
    std::printf("full rebuild:               %.1f ns/op\n", rebuildMs * 1e6 / iters);
    std::printf("incremental mk+un (multi):  %.1f ns/op\n", incMs * 1e6 / iters);
    std::printf("incremental mk+un (1 tile): %.1f ns/op\n", inc1Ms * 1e6 / iters);
    if (incMs > 0) std::printf("speedup multi (rebuild/inc): %.1fx\n", rebuildMs / incMs);
    if (inc1Ms > 0) std::printf("speedup 1-tile (rebuild/inc): %.1fx\n", rebuildMs / inc1Ms);
  }

  if (failures == 0) { std::printf("ALL INC-BOARD TESTS PASSED\n"); return 0; }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
