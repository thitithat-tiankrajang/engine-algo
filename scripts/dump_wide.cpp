// Reach a real bag==0 position and print the exact request JSON the engine sees,
// so we can feed variants (e.g. with pending-return tiles counted in bagCount)
// to reproduce the dispatch behaviour.
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
  const int want = argc>1 ? std::atoi(argv[1]) : 2;   // seed index to capture
  int found = 0;
  for (uint32_t seed=1; seed<=200; seed++) {
    GameSim sim(seed); int side=0; bool cap=false; int capSide=0;
    for (int turn=0; turn<250 && !sim.finished; turn++) {
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total>0 && sim.racks[1-side].total>0) {
        const int t=sim.racks[side].total+sim.racks[1-side].total;
        if (t>=15 && t<=16){ cap=true; capSide=side; break; }
      }
      if (!sim.applyResponse(side, chooseMoveJson(sim, side))) break;
      side=1-side;
    }
    if(!cap) continue;
    if (++found < want) continue;
    std::printf("%s\n", sim.requestJson(capSide, "max", 12345).c_str());
    return 0;
  }
  std::fprintf(stderr, "no position captured\n");
  return 1;
}
