// P2 profiling harness: attribute work INSIDE the movegen DFS extend() during a
// real exact bag==0 endgame solve. Analysis only; not part of the shipped engine.
//
// It reaches a fixed, deterministically-reached bag==0 position (same reach loop
// as bench_endgame), then runs the exact endgame solve (handleRequest "max") —
// which drives generatePlaceMovesStream -> startAt -> extend() at every search
// node — and dumps the amath::prof() work-volume counters for that ONE solve.
//
// Build with -O3 -DNDEBUG -DAMATH_PROFILE so it exercises the shipped incremental
// cross/contact path (no per-node rebuild) and the prof counters are live. The
// counters are exact and deterministic; they say HOW MUCH of each sub-operation
// extend() performs per DFS node. Pair with `sample` for wall-clock time%.
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/engine.hpp"
#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/prof.hpp"
#include "../src/rules.hpp"
#include "../src/selfplay.hpp"

using namespace amath;

// Bounded greedy mover used ONLY to reach a bag==0 position (its extend() work is
// excluded from the report — prof() is reset after the position is reached).
static std::string chooseMoveJson(const GameSim& sim, int side) {
  GenOptions o;
  o.dedup = true;
  o.premiumOrder = true;
  GenStats st;
  st.nodeLimit = 1'000'000;
  std::vector<Move> moves;
  generatePlaceMoves(sim.board, sim.racks[side], moves, &st, o);
  auto out = json::makeObject();
  if (moves.empty()) {
    out->obj["type"] = json::makeString("pass");
    return json::stringify(out);
  }
  size_t best = 0;
  for (size_t i = 1; i < moves.size(); i++)
    if (moves[i].score > moves[best].score) best = i;
  const Move& m = moves[best];
  out->obj["type"] = json::makeString("place");
  auto arr = json::makeArray();
  for (const Placement& p : m.placements) {
    auto e = json::makeObject();
    e->obj["r"] = json::makeInt(p.row);
    e->obj["c"] = json::makeInt(p.col);
    e->obj["kind"] = json::makeString(tileKindToString(p.kind));
    e->obj["token"] = json::makeString(assignedTokenToString(p.token));
    arr->arr.push_back(e);
  }
  out->obj["placements"] = arr;
  out->obj["score"] = json::makeInt(m.score);
  return json::stringify(out);
}

static long long statsNodes(const std::string& res) {
  auto p = json::parse(res);
  if (p && p->get("stats") && p->get("stats")->get("nodes"))
    return p->get("stats")->get("nodes")->asInt();
  return -1;
}

static double pct(uint64_t a, uint64_t b) { return b ? 100.0 * double(a) / double(b) : 0.0; }
static double per(uint64_t a, uint64_t b) { return b ? double(a) / double(b) : 0.0; }

int main(int argc, char** argv) {
  const int loTot = argc > 1 ? std::atoi(argv[1]) : 10;
  const int hiTot = argc > 2 ? std::atoi(argv[2]) : 13;
  const int reps = argc > 3 ? std::atoi(argv[3]) : 5;

  for (uint32_t seed = 1; seed <= 2000; seed++) {
    GameSim sim(seed);
    int side = 0;
    bool cap = false;
    int capSide = 0;
    for (int turn = 0; turn < 250 && !sim.finished; turn++) {
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total > 0 && sim.racks[1 - side].total > 0) {
        const int t = sim.racks[side].total + sim.racks[1 - side].total;
        if (t >= loTot && t <= hiTot) {
          cap = true;
          capSide = side;
          break;
        }
      }
      if (!sim.applyResponse(side, chooseMoveJson(sim, side))) break;
      side = 1 - side;
    }
    if (!cap) continue;

    const int rA = sim.racks[capSide].total, rB = sim.racks[1 - capSide].total;
    const std::string reqJson = sim.requestJson(capSide, "max", 12345);

    // Warm the caches (its counters are discarded by the reset below).
    handleRequest(reqJson);

    // Timing: best-of-reps wall clock for the whole exact solve.
    double bestMs = 1e18;
    long long nodes = 0;
    for (int r = 0; r < reps; r++) {
      auto t0 = std::chrono::steady_clock::now();
      const std::string res = handleRequest(reqJson);
      double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0)
                      .count();
      if (ms < bestMs) {
        bestMs = ms;
        nodes = statsNodes(res);
      }
    }

    // Profiled solve: reset the counters, run exactly one solve, read them back.
#ifdef AMATH_PROFILE
    prof().reset();
#endif
    auto t0 = std::chrono::steady_clock::now();
    const std::string res = handleRequest(reqJson);
    double profMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    (void)res;

    std::printf("=== extend() profile ===\n");
    std::printf("position : seed=%u rA=%d rB=%d tot=%d (first bag==0 in tot[%d,%d])\n", seed, rA, rB,
                rA + rB, loTot, hiTot);
    std::printf("solve    : searchNodes=%lld  latency=%.1f ms (best of %d)  profiledSolve=%.1f ms\n",
                nodes, bestMs, reps, profMs);

#ifdef AMATH_PROFILE
    const Prof& p = prof();
    const uint64_t E = p.extendCalls;
    std::printf("\n-- work volume (this one profiled solve) --\n");
    std::printf("  %-18s %14llu\n", "extendCalls", (unsigned long long)E);
    std::printf("  %-18s %14llu   (%.2f / extend)\n", "startAtCalls",
                (unsigned long long)p.startAtCalls, per(p.startAtCalls, E));
    std::printf("  %-18s %14llu   (%.2f / extend)\n", "lineAdvance",
                (unsigned long long)p.lineAdvance, per(p.lineAdvance, E));
    std::printf("  %-18s %14llu   (%.2f / extend)\n", "absorbCalls",
                (unsigned long long)p.absorbCalls, per(p.absorbCalls, E));
    std::printf("  %-18s %14llu   (%.2f / extend)\n", "emitCalls", (unsigned long long)p.emitCalls,
                per(p.emitCalls, E));
    std::printf("  %-18s %14llu   (%.2f / extend, %.1f%% of emits)\n", "evalLineCalls",
                (unsigned long long)p.evalLineCalls, per(p.evalLineCalls, E),
                pct(p.evalLineCalls, p.emitCalls));
    std::printf("  %-18s %14llu   (%.2f / extend)\n", "crossCellCalls",
                (unsigned long long)p.crossCellCalls, per(p.crossCellCalls, E));
    std::printf("  %-18s %14llu   (%.2f / extend)\n", "validateLineCalls",
                (unsigned long long)p.validateLineCalls, per(p.validateLineCalls, E));
    std::printf("  %-18s %14llu\n", "dedupKeyBuilds", (unsigned long long)p.dedupKeyBuilds);
    std::printf("  %-18s %14llu\n", "dedupFind", (unsigned long long)p.dedupFind);
    std::printf("  %-18s %14llu\n", "dedupInsert", (unsigned long long)p.dedupInsert);
    std::printf("  %-18s %14llu\n", "moveConstruct", (unsigned long long)p.moveConstruct);

    std::printf("\n-- per-node shape of extend() --\n");
    std::printf("  candidate tokens tried / node : %.2f   (lineAdvance / extend)\n",
                per(p.lineAdvance, E));
    std::printf("  absorb() calls / node         : %.2f\n", per(p.absorbCalls, E));
    std::printf("  emitIfValid() / node          : %.2f\n", per(p.emitCalls, E));
    std::printf("  evaluateLine() / node         : %.2f   (main-line arithmetic)\n",
                per(p.evalLineCalls, E));
    std::printf("  ns / extend node (profiled)   : %.1f\n",
                E ? 1e6 * profMs / double(E) : 0.0);
#else
    std::printf("\n(build with -DAMATH_PROFILE to see work-volume counters)\n");
#endif
    std::printf("\ndone\n");
    return 0;
  }
  std::printf("no position captured in tot[%d,%d]\n", loTot, hiTot);
  return 1;
}
