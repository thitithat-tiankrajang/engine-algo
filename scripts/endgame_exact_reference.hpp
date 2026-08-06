// REFERENCE DESIGN (not wired into the build): an exact-or-incomplete bag==0
// solver. Compiles conceptually against board.hpp / movegen.hpp / rules.hpp.
//
// Contract:
//   solve() returns {PROVEN, value, move}      — value is the game-theoretic
//                                                 final margin, mathematically exact
//   or       {INCOMPLETE, ...}                 — budget/complexity limit hit;
//                                                 NO exact claim, NO approximate move.
//
// Every technique below is either (C) correctness-critical or (E) pure
// efficiency. Efficiency techniques only PERMUTE the complete move list or
// MEMOISE exact-to-terminal values, so they cannot change the returned value.
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <random>
#include <vector>
#include "../src/board.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"

namespace amath {

enum class ProofStatus { Proven, Incomplete };

struct ExactResult {
  ProofStatus status = ProofStatus::Incomplete;
  int value = 0;      // AI-perspective margin (my total gain − opp total gain)
  Move move;          // best move (or Pass); meaningful only when Proven
};

// Two INDEPENDENT Zobrist tables → a 128-bit state signature. A false TT hit
// requires BOTH 64-bit hashes to collide: probability ~2^-128 per pair, i.e.
// far below the machine's own ECC/soft-error rate. (For a literally exact
// guarantee, store a full board+rack fingerprint and memcmp on hit instead.)
struct Zobrist2 {
  uint64_t cellA[BOARD_CELLS][KIND_COUNT][ASSIGNED_COUNT];
  uint64_t cellB[BOARD_CELLS][KIND_COUNT][ASSIGNED_COUNT];
  uint64_t rackA[2][KIND_COUNT][RACK_SIZE + 1], rackB[2][KIND_COUNT][RACK_SIZE + 1];
  uint64_t sideA, sideB, streakA[8], streakB[8];
  Zobrist2() {
    std::mt19937_64 r(0xE7D6C5B4A3921100ULL);
    auto fill = [&](auto& t){ for (auto& a : t) for (auto& b : a) for (auto& v : b) v = r(); };
    fill(cellA); fill(cellB);
    for (auto& s : {&rackA, &rackB}) for (auto& a : *s) for (auto& b : a) for (auto& v : b) v = r();
    sideA = r(); sideB = r();
    for (auto& v : streakA) v = r();
    for (auto& v : streakB) v = r();
  }
};

struct ExactEndgame {
  Board board;
  TileCounts rack[2];               // rack[0] = side to move at the root
  const Zobrist2& z;
  uint64_t hA = 0, hB = 0;          // incremental board hashes (dual)

  long long nodeBudget = 0, nodes = 0;
  double timeBudgetMs = 0;
  Clock::time_point start;
  bool aborted = false;
  static constexpr int INF = 1 << 20;

  // ── collision-proof transposition table ────────────────────────────────────
  struct Slot {
    uint64_t key = 0, check = 0;    // 128-bit signature
    int value = 0;
    uint32_t subtree = 0;           // nodes under this entry → depth-preferred replace
    int32_t bestMove = -1;          // index into the (deterministic) move list; -1 = pass
    uint8_t flag = 0;               // 0 exact, 1 lower, 2 upper
    uint8_t used = 0;
  };
  std::vector<Slot> tt;
  uint64_t ttMask = 0;

  // ── killers & history (ordering only) ──────────────────────────────────────
  static constexpr int MAXD = 40;
  std::array<std::array<int, 2>, MAXD> killer{};   // move signatures per depth
  std::array<std::array<int32_t, ASSIGNED_COUNT>, BOARD_CELLS> history{};

  ExactEndgame(const Board& b, const TileCounts& me, const TileCounts& opp,
               const Zobrist2& zz, int ttBits)
      : board(b), z(zz) {
    rack[0] = me; rack[1] = opp;
    tt.assign(size_t(1) << ttBits, Slot{});
    ttMask = tt.size() - 1;
    for (auto& k : killer) k = {-1, -1};
    recomputeHash();
  }
  void recomputeHash() {
    hA = hB = 0;
    for (int r = 0; r < BOARD_SIZE; r++)
      for (int c = 0; c < BOARD_SIZE; c++) {
        const Cell& x = board.at(r, c);
        if (x.occupied()) { hA ^= z.cellA[Board::idx(r,c)][x.kind][x.token];
                            hB ^= z.cellB[Board::idx(r,c)][x.kind][x.token]; }
      }
  }
  void key(int side, int streak, uint64_t& ka, uint64_t& kb) const {
    ka = hA ^ z.streakA[streak]; kb = hB ^ z.streakB[streak];
    if (side == 1) { ka ^= z.sideA; kb ^= z.sideB; }
    for (int p = 0; p < 2; p++)
      for (uint8_t k = 0; k < KIND_COUNT; k++) {
        ka ^= z.rackA[p][k][rack[(p + side) % 2].n[k]];
        kb ^= z.rackB[p][k][rack[(p + side) % 2].n[k]];
      }
  }
  static int sig(const Move& m) {                 // stable move identity for killers/TT
    if (m.placements.empty()) return -1;           // pass
    const Placement& p = m.placements.front();
    return (Board::idx(p.row, p.col) << 6) | (p.token & 0x3F);
  }

  bool overBudget() {
    if (aborted) return true;
    if (++nodes > nodeBudget ||
        (nodes % 8192 == 0 && msSince(start) > timeBudgetMs)) aborted = true;
    return aborted;
  }

  // Negamax to terminal. Value = margin for the side to move. alpha/beta are
  // side-relative. Returns fail-soft. depth used only for killer indexing.
  int negamax(int side, int streak, int alpha, int beta, int depth) {
    if (overBudget()) return 0;
    const int alphaOrig = alpha;

    uint64_t ka, kb; key(side, streak, ka, kb);
    Slot& slot = tt[ka & ttMask];
    int ttMove = -2;                               // -2 = none
    if (slot.used && slot.key == ka && slot.check == kb) {  // collision-proof hit
      if (slot.flag == 0) return slot.value;                     // exact
      if (slot.flag == 1 && slot.value >= beta) return slot.value; // lower ≥ β
      if (slot.flag == 2 && slot.value <= alpha) return slot.value; // upper ≤ α
      ttMove = slot.bestMove;                       // reuse for ordering even w/o cutoff
    }

    TileCounts& me = rack[side];
    TileCounts& opp = rack[1 - side];

    std::vector<Move> moves;
    GenStats gs; gs.nodeLimit = 0;                  // 0 = uncapped; abort handled by RAM/geometry
    generatePlaceMoves(board, me, moves, &gs);      // COMPLETE — never truncated, never beamed
    if (gs.truncated) { aborted = true; return 0; } // explicit failure, not silent approximation

    // ── move ordering (permutation only ⇒ exact) ──
    orderMoves(moves, ttMove, depth);

    const long long nodes0 = nodes;
    int best = -INF, bestIdx = -1;
    bool first = true;
    for (int i = 0; i < (int)moves.size(); i++) {
      const Move& m = moves[i];
      applyMove(m, me);
      int v;
      if (me.total == 0) {
        v = m.score + 2 * opp.points();             // rack-out: double opp remainder
      } else if (first) {
        v = m.score - negamax(1 - side, 0, -beta, -alpha, depth + 1);
      } else {                                       // PVS scout (sound in negamax)
        v = m.score - negamax(1 - side, 0, -alpha - 1, -alpha, depth + 1);
        if (v > alpha && v < beta)
          v = m.score - negamax(1 - side, 0, -beta, -alpha, depth + 1);
      }
      undoMove(m, me);
      if (aborted) return 0;
      if (v > best) { best = v; bestIdx = i; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {                           // fail-high → record killer/history
        recordCutoff(m, depth);
        break;
      }
      first = false;
    }

    // Pass is always legal (fail-soft; do not skip even after fail-high—already broke out).
    if (alpha < beta) {
      int v;
      if (streak + 1 >= NO_SCORE_STREAK_LENGTH) v = opp.points() - me.points();
      else v = -negamax(1 - side, streak + 1, -beta, -alpha, depth + 1);
      if (aborted) return 0;
      if (v > best) { best = v; bestIdx = -1; }      // -1 = pass chosen
      if (best > alpha) alpha = best;
    }

    // ── store: uniform negamax flags (fail-high⇒lower, fail-low⇒upper) ──
    const uint8_t flag = best <= alphaOrig ? 2 : (best >= beta ? 1 : 0);
    const uint32_t sub = (uint32_t)std::min<long long>(nodes - nodes0, 0xFFFFFFFF);
    if (!slot.used || flag == 0 || sub >= slot.subtree) {   // depth/exact-preferred replace
      slot = Slot{ka, kb, best, sub, bestIdx, flag, 1};
    }
    return best;
  }

  ExactResult solveRoot(int rootStreak) {
    ExactResult R;
    int v = negamax(0, rootStreak, -INF, INF, 0);
    if (aborted) { R.status = ProofStatus::Incomplete; return R; }
    R.status = ProofStatus::Proven; R.value = v;
    // Recover the root move from the TT (exact entry stored above).
    uint64_t ka, kb; key(0, rootStreak, ka, kb);
    Slot& s = tt[ka & ttMask];
    std::vector<Move> moves; GenStats gs; generatePlaceMoves(board, rack[0], moves, &gs);
    if (s.used && s.key == ka && s.check == kb && s.bestMove >= 0 &&
        s.bestMove < (int)moves.size()) R.move = moves[s.bestMove];
    // else: pass is optimal (R.move left as default Pass)
    return R;
  }

 private:
  void applyMove(const Move& m, TileCounts& me) {
    for (const Placement& p : m.placements) {
      board.place(p.row, p.col, p.kind, p.token);
      hA ^= z.cellA[Board::idx(p.row,p.col)][p.kind][p.token];
      hB ^= z.cellB[Board::idx(p.row,p.col)][p.kind][p.token];
      me.sub(p.kind);
    }
  }
  void undoMove(const Move& m, TileCounts& me) {
    for (const Placement& p : m.placements) {
      board.remove(p.row, p.col);
      hA ^= z.cellA[Board::idx(p.row,p.col)][p.kind][p.token];
      hB ^= z.cellB[Board::idx(p.row,p.col)][p.kind][p.token];
      me.add(p.kind);
    }
  }
  void orderMoves(std::vector<Move>& moves, int ttMove, int depth) {
    const int k0 = killer[depth][0], k1 = killer[depth][1];
    auto rank = [&](const Move& m) -> long long {
      const int s = sig(m);
      if (ttMove != -2 && s == ttMove) return 1LL << 40;        // TT move first
      if (s == k0 || s == k1)          return 1LL << 39;        // then killers
      long long h = m.placements.empty() ? 0 :
          history[Board::idx(m.placements[0].row, m.placements[0].col)][m.placements[0].token];
      return ((long long)m.score << 20) + h;                    // then score, then history
    };
    std::sort(moves.begin(), moves.end(),
              [&](const Move& a, const Move& b){ return rank(a) > rank(b); });
  }
  void recordCutoff(const Move& m, int depth) {
    const int s = sig(m);
    if (killer[depth][0] != s) { killer[depth][1] = killer[depth][0]; killer[depth][0] = s; }
    if (!m.placements.empty())
      history[Board::idx(m.placements[0].row, m.placements[0].col)][m.placements[0].token]
          += depth * depth;
  }
};

}  // namespace amath
