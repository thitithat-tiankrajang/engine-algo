// Measurement harness (analysis only; not part of the shipped engine).
// Reaches real bag==0 positions via full-rules self-play, then counts SEARCH
// nodes for the identical position under a progression of techniques:
//   brute (no prune/TT) -> alpha-beta -> +move ordering -> +TT -> +PVS.
// All variants compute the exact same game value (asserted equal to brute).
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>

#include "../src/board.hpp"
#include "../src/engine.hpp"
#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"
#include "../src/selfplay.hpp"

using namespace amath;
static constexpr int INF = 1 << 20;

// ----- Zobrist for the measurement TT -----
struct Zob {
  uint64_t cell[BOARD_CELLS][KIND_COUNT][ASSIGNED_COUNT];
  uint64_t rk[2][KIND_COUNT][RACK_SIZE + 1];
  uint64_t side, streak[NO_SCORE_STREAK_LENGTH + 1];
  Zob() {
    std::mt19937_64 r(123);
    for (auto&a:cell) for(auto&b:a) for(auto&v:b) v=r();
    for (auto&a:rk) for(auto&b:a) for(auto&v:b) v=r();
    side=r(); for(auto&v:streak) v=r();
  }
} ZOB;

struct Ctx {
  Board board; TileCounts racks[2];
  bool prune, order, tt, pvs;
  long long nodes = 0, cap = (long long)4e9;
  bool aborted = false;
  long long bfSum = 0, bfCnt = 0, bfMax = 0; int maxDepth = 0;
  std::unordered_map<uint64_t,std::pair<int,uint8_t>> table; // val, flag(0 exact,1 low,2 high)
  uint64_t bh = 0;
  void initHash() {
    bh = 0;
    for (int r=0;r<BOARD_SIZE;r++) for(int c=0;c<BOARD_SIZE;c++){
      const Cell& x = board.at(r,c);
      if (x.occupied()) bh ^= ZOB.cell[Board::idx(r,c)][x.kind][x.token];
    }
  }
  uint64_t key(int side,int streak) const {
    uint64_t h = bh ^ ZOB.streak[streak]; if(side==1) h^=ZOB.side;
    for(int p=0;p<2;p++) for(uint8_t k=0;k<KIND_COUNT;k++) h^=ZOB.rk[p][k][racks[(p+side)%2].n[k]];
    return h;
  }
};

// Negamax; value for side to move = my_gain - opp_gain to end.
static int search(Ctx& X, int side, int streak, int alpha, int beta, int depth=0) {
  if (X.aborted) return 0;
  if (++X.nodes > X.cap) { X.aborted = true; return 0; }
  if (depth > X.maxDepth) X.maxDepth = depth;
  const int a0 = alpha;
  uint64_t h = 0;
  if (X.tt) {
    h = X.key(side, streak);
    auto it = X.table.find(h);
    if (it != X.table.end()) {
      const int val = it->second.first; const uint8_t fl = it->second.second;
      if (fl==0) return val;
      if (fl==1 && val>=beta) return val;
      if (fl==2 && val<=alpha) return val;
    }
  }
  TileCounts& my = X.racks[side]; TileCounts& opp = X.racks[1-side];
  std::vector<Move> moves; generatePlaceMoves(X.board, my, moves, nullptr);
  const long long bf = (long long)moves.size() + 1;
  X.bfSum += bf; X.bfCnt++; if (bf > X.bfMax) X.bfMax = bf;
  if (X.order) std::sort(moves.begin(),moves.end(),[](const Move&x,const Move&y){return x.score>y.score;});

  int best = -INF; bool first = true;
  for (const Move& m : moves) {
    for (const Placement& p : m.placements){ X.board.place(p.row,p.col,p.kind,p.token); if(X.tt) X.bh^=ZOB.cell[Board::idx(p.row,p.col)][p.kind][p.token]; my.sub(p.kind);}
    int v;
    if (my.total==0) v = m.score + 2*opp.points();
    else if (X.pvs && !first) {
      v = m.score - search(X,1-side,0,-alpha-1,-alpha,depth+1);
      if (v>alpha && v<beta) v = m.score - search(X,1-side,0,-beta,-alpha,depth+1);
    } else v = m.score - search(X,1-side,0,-beta,-alpha,depth+1);
    for (const Placement& p : m.placements){ X.board.remove(p.row,p.col); if(X.tt) X.bh^=ZOB.cell[Board::idx(p.row,p.col)][p.kind][p.token]; my.add(p.kind);}
    if (X.aborted) return 0;
    if (v>best) best=v;
    if (X.prune){ if(best>alpha) alpha=best; if(alpha>=beta) break; }
    first = false;
  }
  if (X.prune ? alpha<beta : true) {
    int v;
    if (streak+1>=NO_SCORE_STREAK_LENGTH) v = opp.points()-my.points();
    else v = -search(X,1-side,streak+1,-beta,-alpha,depth+1);
    if (X.aborted) return 0;
    if (v>best) best=v;
    if (X.prune && best>alpha) alpha=best;
  }
  if (X.tt) {
    uint8_t fl = best<=a0 ? 2 : (best>=beta ? 1 : 0);
    if (X.table.size() < 8'000'000) X.table[h] = {best, fl};
  }
  return best;
}

struct RunOut { long long nodes; int val; bool done; long long bfMax; double bfAvg; int depth; };
static RunOut run(const Board& b, TileCounts ra, TileCounts rb, int streak,
                  bool prune,bool order,bool tt,bool pvs, long long cap) {
  Ctx X; X.board=b; X.racks[0]=ra; X.racks[1]=rb;
  X.prune=prune; X.order=order; X.tt=tt; X.pvs=pvs; X.cap=cap;
  if (tt) X.initHash();
  int v = search(X,0,streak,-INF,INF);
  return {X.nodes, v, !X.aborted, X.bfMax, X.bfCnt? (double)X.bfSum/X.bfCnt:0, X.maxDepth};
}

// Fast, engine-free mover for the REACH phase: bounded movegen, pick the
// best-scoring placement, emit the JSON response GameSim::applyResponse expects
// (so all tile-accounting / refill / endings stay exactly correct). We only need
// a legal, tile-consistent path to bag==0 — not strong play.
static std::string chooseMoveJson(const GameSim& sim, int side) {
  GenOptions o; o.budgetMs = 20; o.dedup = true; o.premiumOrder = true;
  std::vector<Move> moves; generatePlaceMoves(sim.board, sim.racks[side], moves, nullptr, o);
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
  const int bruteMaxTot = argc>1 ? std::atoi(argv[1]) : 12;   // full ladder only up to this total
  const int wantCaptures = argc>2 ? std::atoi(argv[2]) : 25;
  const long long SOLVE_CAP = 300'000'000;  // real-solver node ceiling
  std::printf("# rootMv/bfMax/bfAvg/depth measured on the FIRST bag==0 position; solver=ab+ord+tt(+pvs)\n");
  std::printf("seed| rA rB tot | rootMv bfMax bfAvg depth | REAL:ab+ord+tt nodes done | +pvs nodes | LADDER brute/ab/ab+tt (tot<=%d)\n", bruteMaxTot);
  std::fflush(stdout);
  int captured=0;
  for (uint32_t seed=1; seed<=1200 && captured<wantCaptures; seed++) {
    GameSim sim(seed); int side=0; bool cap=false; int capSide=0, capStreak=0;
    for (int turn=0; turn<250 && !sim.finished; turn++) {
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total>0 && sim.racks[1-side].total>0) {
        const int t = sim.racks[side].total + sim.racks[1-side].total;
        if (t>=2 && t<=16){ cap=true; capSide=side; capStreak=sim.noScoreStreak; break; }
      }
      const std::string res = chooseMoveJson(sim, side);
      if (!sim.applyResponse(side,res)) break;
      side=1-side;
    }
    if(!cap) continue;
    const int rA=sim.racks[capSide].total, rB=sim.racks[1-capSide].total, tot=rA+rB;
    TileCounts ra=sim.racks[capSide], rb=sim.racks[1-capSide];
    std::vector<Move> rm; generatePlaceMoves(sim.board, ra, rm, nullptr);
    const int rootMv = (int)rm.size();

    // Real solver (mirrors shipped: alpha-beta + TT; +ordering, then +pvs), capped.
    RunOut R  = run(sim.board,ra,rb,capStreak,true,true,true,false,SOLVE_CAP);
    RunOut Rp = run(sim.board,ra,rb,capStreak,true,true,true,true ,SOLVE_CAP);

    std::printf("%4u| %2d %2d %3d | %6d %5lld %5.1f %5d | %11lld %4s | %10lld ",
                seed,rA,rB,tot, rootMv, R.bfMax, R.bfAvg, R.depth,
                R.nodes, R.done?"yes":"NO", Rp.nodes);
    // rootMv = bfMax at depth0 already ~ root; print explicit root count:
    // (bfMax is over all interior nodes; root count = first node's bf, captured as depthmax not needed)

    if (tot<=bruteMaxTot) {
      RunOut B  = run(sim.board,ra,rb,capStreak,false,false,false,false,SOLVE_CAP);
      RunOut A  = run(sim.board,ra,rb,capStreak,true ,false,false,false,SOLVE_CAP);
      RunOut T  = run(sim.board,ra,rb,capStreak,true ,false,true ,false,SOLVE_CAP);
      const bool okv = B.done && (B.val==A.val && A.val==T.val && T.val==R.val && R.val==Rp.val);
      std::printf("| %s/%s/%s val=%d%s",
        B.done?std::to_string(B.nodes).c_str():">cap",
        A.done?std::to_string(A.nodes).c_str():">cap",
        T.done?std::to_string(T.nodes).c_str():">cap",
        R.val, okv?"":(B.done?" MISMATCH":""));
    } else std::printf("| (ladder skipped, tot>%d) val=%d", bruteMaxTot, R.val);
    std::printf("\n"); std::fflush(stdout);
    captured++;
  }
  std::printf("done\n");
  return 0;
}
