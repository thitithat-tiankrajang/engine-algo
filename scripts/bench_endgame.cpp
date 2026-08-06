// Phase 3 benchmark: time the exact bag==0 solve (handleRequest "max") on a
// fixed, deterministically-reached position. Reports total latency + the movegen
// DFS node count the engine surfaces, so Phase-2 (rebuild every node) and Phase-3
// (incremental) can be compared on the identical position. Build with -DNDEBUG.
#include <chrono>
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

static std::string chooseMoveJson(const GameSim& sim, int side) {
  GenOptions o; o.dedup = true; o.premiumOrder = true;
  GenStats st; st.nodeLimit = 1'000'000;
  std::vector<Move> moves; generatePlaceMoves(sim.board, sim.racks[side], moves, &st, o);
  auto out = json::makeObject();
  if (moves.empty()) { out->obj["type"] = json::makeString("pass"); return json::stringify(out); }
  size_t best = 0; for (size_t i=1;i<moves.size();i++) if (moves[i].score>moves[best].score) best=i;
  const Move& m = moves[best];
  out->obj["type"] = json::makeString("place");
  auto arr = json::makeArray();
  for (const Placement& p : m.placements) { auto e=json::makeObject();
    e->obj["r"]=json::makeInt(p.row); e->obj["c"]=json::makeInt(p.col);
    e->obj["kind"]=json::makeString(tileKindToString(p.kind));
    e->obj["token"]=json::makeString(assignedTokenToString(p.token)); arr->arr.push_back(e); }
  out->obj["placements"]=arr; out->obj["score"]=json::makeInt(m.score);
  return json::stringify(out);
}

int main(int argc, char** argv) {
  const int loTot = argc>1 ? std::atoi(argv[1]) : 10;
  const int hiTot = argc>2 ? std::atoi(argv[2]) : 13;
  const int reps  = argc>3 ? std::atoi(argv[3]) : 1;

  for (uint32_t seed=1; seed<=2000; seed++) {
    GameSim sim(seed); int side=0; bool cap=false; int capSide=0;
    for (int turn=0; turn<250 && !sim.finished; turn++) {
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total>0 && sim.racks[1-side].total>0) {
        const int t=sim.racks[side].total+sim.racks[1-side].total;
        if (t>=loTot && t<=hiTot){ cap=true; capSide=side; break; }
      }
      if (!sim.applyResponse(side, chooseMoveJson(sim, side))) break;
      side=1-side;
    }
    if(!cap) continue;
    const std::string reqJson = sim.requestJson(capSide, "max", 12345);
    // warm + timed reps
    double bestMs = 1e18; long long nodes=0; long long diff=0; bool solved=false;
    for (int r=0;r<reps;r++){
      auto t0=std::chrono::steady_clock::now();
      const std::string res = handleRequest(reqJson);
      double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count();
      if (ms<bestMs) bestMs=ms;
      auto p=json::parse(res);
      if (p){ if(p->get("stats")&&p->get("stats")->get("nodes")) nodes=p->get("stats")->get("nodes")->asInt();
              if(p->get("endgameSolved")) solved=p->get("endgameSolved")->asBool();
              if(p->get("expectedFinalDiff")) diff=p->get("expectedFinalDiff")->asInt(); }
    }
    std::printf("seed=%u rA=%d rB=%d solved=%d diff=%lld | latency=%.1f ms | movegenNodes=%lld | %.0f knodes/s\n",
                seed, sim.racks[capSide].total, sim.racks[1-capSide].total, solved?1:0, diff,
                bestMs, nodes, nodes/(bestMs));  // nodes per ms == knodes/s
    return 0;  // one position is enough for a paired A/B comparison
  }
  std::printf("no position captured in [%d,%d]\n", loTot, hiTot);
  return 1;
}
