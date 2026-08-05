// Verification harness (not shipped): reach bag==0 positions deterministically,
// then record the engine's endgame verdict so pre/post-change runs can be
// diffed bit-for-bit. Positions are produced by a fast, engine-free greedy
// constructor (identical across builds), so the ONLY thing that can differ
// between runs is the endgame solver's output.
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

// Capped brute-force reference (no pruning, no TT) — the same exactness check
// tests/test_bot.cpp performs, but only invoked for small rack totals so the
// harness stays fast. Returns INT32_MIN when the cap is hit (skip).
static long long g_cap = 0;
static int refNegamax(Board& b, TileCounts r[2], int side, int streak) {
  if (++g_cap > 30'000'000) return INT32_MIN;
  std::vector<Move> mv; generatePlaceMoves(b, r[side], mv, nullptr);
  int best = -(1 << 20);
  for (const Move& m : mv) {
    for (const Placement& p : m.placements){ b.place(p.row,p.col,p.kind,p.token); r[side].sub(p.kind);}
    int v; if (r[side].total==0) v = m.score + 2*r[1-side].points();
    else { int s=refNegamax(b,r,1-side,0); v = s==INT32_MIN?INT32_MIN:m.score-s; }
    for (const Placement& p : m.placements){ b.remove(p.row,p.col); r[side].add(p.kind);}
    if (v==INT32_MIN) return INT32_MIN; if (v>best) best=v;
  }
  { int v; if (streak+1>=NO_SCORE_STREAK_LENGTH) v=r[1-side].points()-r[side].points();
    else { int s=refNegamax(b,r,1-side,streak+1); v=s==INT32_MIN?INT32_MIN:-s; }
    if (v==INT32_MIN) return INT32_MIN; if (v>best) best=v; }
  return best;
}

static std::string moveCanon(const json::ValuePtr& res) {
  const std::string type = res->get("type") ? res->get("type")->asString() : "?";
  if (type != "place") return type;
  std::string s = "place";
  auto ps = res->get("placements");
  if (ps) for (const auto& c : ps->arr)
    s += " (" + std::to_string(c->get("r")->asInt()) + "," + std::to_string(c->get("c")->asInt())
       + "," + c->get("kind")->asString() + "," + c->get("token")->asString() + ")";
  return s;
}

static std::string chooseMoveJson(const GameSim& sim, int side) {
  // DETERMINISTIC reach: bound generation by NODE COUNT (machine-independent),
  // never wall-clock time — otherwise the captured bag==0 positions differ from
  // run to run and pre/post comparison is meaningless. premiumOrder keeps the
  // best moves first so truncation still yields a sensible greedy choice.
  GenOptions o; o.dedup = true; o.premiumOrder = true;
  GenStats st; st.nodeLimit = 1'000'000;
  std::vector<Move> moves; generatePlaceMoves(sim.board, sim.racks[side], moves, &st, o);
  auto out = json::makeObject();
  if (moves.empty()) { out->obj["type"] = json::makeString("pass"); return json::stringify(out); }
  size_t best = 0; for (size_t i=1;i<moves.size();i++) if (moves[i].score>moves[best].score) best=i;
  const Move& m = moves[best];
  out->obj["type"] = json::makeString("place");
  auto arr = json::makeArray();
  for (const Placement& p : m.placements) {
    auto e = json::makeObject();
    e->obj["r"]=json::makeInt(p.row); e->obj["c"]=json::makeInt(p.col);
    e->obj["kind"]=json::makeString(tileKindToString(p.kind));
    e->obj["token"]=json::makeString(assignedTokenToString(p.token));
    arr->arr.push_back(e);
  }
  out->obj["placements"]=arr; out->obj["score"]=json::makeInt(m.score);
  return json::stringify(out);
}

int main(int argc, char** argv) {
  const int want = argc>1 ? std::atoi(argv[1]) : 30;
  const int maxTot = argc>2 ? std::atoi(argv[2]) : 16;  // cap total tiles to keep solves fast
  int captured = 0;
  for (uint32_t seed=1; seed<=2000 && captured<want; seed++) {
    GameSim sim(seed); int side=0; bool cap=false; int capSide=0;
    for (int turn=0; turn<250 && !sim.finished; turn++) {
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total>0 && sim.racks[1-side].total>0) {
        const int t = sim.racks[side].total + sim.racks[1-side].total;
        if (t>=2 && t<=maxTot){ cap=true; capSide=side; break; }
      }
      if (!sim.applyResponse(side, chooseMoveJson(sim, side))) break;
      side=1-side;
    }
    if(!cap) continue;
    const int rA=sim.racks[capSide].total, rB=sim.racks[1-capSide].total;
    // Engine verdict (current build).
    const std::string res = handleRequest(sim.requestJson(capSide, "max", 12345));
    auto p = json::parse(res);
    std::string solver = p&&p->get("solver")?p->get("solver")->asString():"?";
    long long diff = p&&p->get("expectedFinalDiff")?p->get("expectedFinalDiff")->asInt():-999999;
    bool solved = p&&p->get("endgameSolved")?p->get("endgameSolved")->asBool():false;
    std::string mv = p?moveCanon(p):"parse_err";
    // Keep this prefix byte-identical to the baseline so before/after diffs cleanly.
    std::printf("seed=%u rA=%d rB=%d solver=%s solved=%d diff=%lld move=%s",
                seed,rA,rB,solver.c_str(),solved?1:0,diff,mv.c_str());
    // Capped exactness check on small totals only (keeps the harness fast).
    if (rA + rB <= 11) {
      g_cap = 0; Board b = sim.board; TileCounts r[2] = {sim.racks[capSide], sim.racks[1-capSide]};
      int ref = refNegamax(b, r, 0, sim.noScoreStreak);
      if (ref != INT32_MIN)
        std::printf("  [brute=%d %s]", ref, (solved && diff==ref) ? "OK" : "MISMATCH");
    }
    std::printf("\n");
    std::fflush(stdout);
    captured++;
  }
  std::printf("captured=%d\n", captured);
  return 0;
}
