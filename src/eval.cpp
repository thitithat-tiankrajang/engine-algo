#include "eval.hpp"

#include <algorithm>
#include <cmath>

namespace amath {

LeaveWeights g_leave;

BoardContext makeContext(const Board& board, const TileCounts& unseen, int bagSize,
                         float scoreDiff) {
  BoardContext ctx;
  ctx.bagSize = bagSize;
  ctx.scoreDiff = scoreDiff;
  ctx.unseenTotal = unseen.total;

  // Mobility: fraction of the board that is an "anchor" — an empty cell touching
  // the existing structure, where a new equation can attach. Normalized so a
  // typical midgame sits near 1.0. An empty board is treated as fully open.
  if (board.empty()) {
    ctx.mobility = 1.0f;
  } else {
    static const int D[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
    int anchors = 0;
    for (int r = 0; r < BOARD_SIZE; r++) {
      for (int c = 0; c < BOARD_SIZE; c++) {
        if (board.at(r, c).occupied()) continue;
        for (auto& d : D) {
          const int nr = r + d[0], nc = c + d[1];
          if (inBounds(nr, nc) && board.at(nr, nc).occupied()) {
            anchors++;
            break;
          }
        }
      }
    }
    ctx.mobility = std::clamp(anchors / 40.0f, 0.15f, 1.5f);
  }

  // Expected worth of a tile drawn from the unseen pool (bag + opponent rack),
  // so exchanging is judged against what is actually left to draw. A pool full
  // of heavy tiles is worth less to fish in than one full of flexible glue.
  if (unseen.total > 0) {
    float sum = 0.0f;
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      if (unseen.n[k] == 0) continue;
      const float worth = std::max(0.0f, g_leave.kindValue[k]) + 0.4f;  // any draw enables play
      sum += worth * unseen.n[k];
    }
    ctx.freshTileValue = sum / unseen.total;
  } else {
    ctx.freshTileValue = 0.0f;
  }
  return ctx;
}

float leaveValue(const TileCounts& rack, const BoardContext& ctx) {
  float v = 0.0f;
  int digits = 0, heavy = 0;
  const int mulDiv = rack.n[K_MUL] + rack.n[K_DIV] + rack.n[K_MD];

  for (uint8_t k = 0; k < KIND_COUNT; k++) {
    const int n = rack.n[k];
    if (n == 0) continue;
    if (k == K_EQUALS) continue;  // handled by the schedule
    v += g_leave.kindValue[k] * n;
    if (k <= K_NUM20) digits += n;
    if (k >= 10 && k <= K_NUM20) heavy += n;
    if (n > 1) v -= g_leave.duplicatePenalty * (n - 1);
  }

  // 0 loves × and ÷; it is awkward held with only + and −.
  const int zeros = rack.n[0];
  if (zeros > 0) {
    v += g_leave.zeroMulDivSynergy * std::min(zeros, mulDiv);
    if (mulDiv == 0) v -= g_leave.zeroNoMulDivPenalty * zeros;
  }

  // Heavy-tile hoarding is a burden, eased when the board is open enough to
  // place them.
  if (heavy > 1) {
    const float ease = 1.4f - 0.4f * std::clamp(ctx.mobility, 0.0f, 1.5f);
    v -= g_leave.heavyBurden * static_cast<float>((heavy - 1) * (heavy - 1)) * ease;
  }

  // '=' is only useful where there is room to build; its upside scales with
  // mobility, but an over-supply is dead weight regardless of the board.
  float eq = g_leave.equalsSchedule[std::min<int>(rack.n[K_EQUALS], RACK_SIZE)];
  if (eq > 0.0f) eq *= std::clamp(0.5f + 0.6f * ctx.mobility, 0.4f, 1.3f);
  v += eq;

  if (rack.total > 0) {
    const float idealDigits = rack.total * 0.6f;
    v -= g_leave.balancePenalty * std::abs(digits - idealDigits);
  }
  return v;
}

float defensePenalty(const Board& board, const std::vector<Placement>& placements) {
  float penalty = 0.0f;
  static const int D[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
  bool counted[BOARD_CELLS] = {};
  auto isPending = [&](int r, int c) {
    for (const Placement& p : placements) {
      if (p.row == r && p.col == c) return true;
    }
    return false;
  };
  for (const Placement& p : placements) {
    for (auto& d : D) {
      const int r = p.row + d[0], c = p.col + d[1];
      if (!inBounds(r, c)) continue;
      const int idx = Board::idx(r, c);
      if (counted[idx] || board.at(r, c).occupied() || isPending(r, c)) continue;
      counted[idx] = true;
      switch (PREMIUM[idx]) {
        case EX3: penalty += g_leave.exposeEx3; break;
        case EX2: penalty += g_leave.exposeEx2; break;
        case PX3: penalty += g_leave.exposePx3; break;
        default: break;
      }
    }
  }
  return penalty;
}

float staticEquity(const Board& board, const TileCounts& rack, const Move& move,
                   const BoardContext& ctx) {
  if (move.type == MoveType::Pass) {
    return leaveValue(rack, ctx) - 4.0f;  // BIAS: passing forfeits a turn
  }
  if (move.type == MoveType::Exchange) {
    TileCounts after = rack;
    for (uint8_t k : move.exchangeKinds) after.sub(k);
    return leaveValue(after, ctx) +
           ctx.freshTileValue * static_cast<float>(move.exchangeKinds.size()) -
           g_leave.exchangeTempoCost;
  }
  TileCounts after = rack;
  for (const Placement& p : move.placements) after.sub(p.kind);
  return static_cast<float>(move.score) + leaveValue(after, ctx) -
         defensePenalty(board, move.placements);
}

}  // namespace amath
