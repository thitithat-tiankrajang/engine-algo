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
  const int eqCount = rack.n[K_EQUALS];
  float eq = g_leave.equalsSchedule[std::min<int>(eqCount, RACK_SIZE)];
  if (eq > 0.0f) eq *= std::clamp(0.5f + 0.6f * ctx.mobility, 0.4f, 1.3f);
  v += eq;

  // ── structural playability: can these tiles actually form equations? ──────
  const int operators = rack.n[K_ADD] + rack.n[K_SUB] + rack.n[K_MUL] + rack.n[K_DIV] +
                        rack.n[K_PM] + rack.n[K_MD];
  const int flankSupply = operators + eqCount;  // tiles that can sit beside a number

  // Operators are the scarce structural ingredient; being short of them (relative
  // to the number tiles held) makes the rack hard to play. Eased a little on an
  // open board, where single tiles can be tacked onto existing equations.
  const float wantedOps = digits * g_leave.operatorRatio;
  if (flankSupply < wantedOps) {
    const float ease = std::clamp(1.2f - 0.3f * ctx.mobility, 0.6f, 1.2f);
    v -= g_leave.operatorStarvation * (wantedOps - flankSupply) * ease;
  }
  // A rack of numbers with no operator at all can barely move.
  if (operators == 0 && digits >= 2) v -= g_leave.noOperatorPenalty;

  // Heavy numbers can't touch other numbers, so each one needs an operator/'='
  // to flank it. Holding more heavies than the flank supply is a real handicap —
  // this is why an all-heavy, no-operator leave is much worse than it looks.
  if (heavy > flankSupply) v -= g_leave.heavyFlankPenalty * (heavy - flankSupply);

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

// ── how much variance we want, given the score ───────────────────────────────
//
// The sim ranks candidates by mean − λ·stddev, so this one number decides
// whether spread is a liability or an asset. λ rises with our lead: a winning
// position is protected by taking the steady line. λ falls as we trail, and it
// IS ALLOWED TO GO NEGATIVE — that is the whole of "gamble when behind".
//
// This used to be `std::max(0.0f, ...)`, which meant the second half of that
// sentence was never implemented. λ bottomed out at 0 as soon as the deficit
// reached 41 points, so trailing by 41 and trailing by 300 produced
// byte-identical rankings, and no weights document could say otherwise because
// the clamp sat below them.
//
// Ranking a losing position by its MEAN is the mistake. Points are not the
// objective — finishing ahead is — and a player 200 down does not get there by
// choosing the steady line. That is not an abstraction: in the position this was
// found in (a ×9 lane still open, 195 behind, 25 tiles in the bag), the steady
// line was a bingo that sealed the lane for both sides, and the engine took it
// because +59.2 mean beat +42.9 mean. Against a negative λ the same numbers read
// the other way, because the move that keeps the game live is exactly the one
// whose value is still spread out (σ 83.0 against the bingo's 36.6).
//
// The spread is measured across sampled OPPONENT RACKS, so a negative λ is
// literally "prefer the move whose value depends most on what the opponent turns
// out to be holding". When behind, handing the game to a coin flip is the
// improvement.
float riskAversionLambda(float scoreDiff) {
  return std::max(-g_leave.riskAversionMaxGamble,
                  g_leave.riskAversionBase +
                      g_leave.riskAversionLeadPer50 * (scoreDiff / 50.0f));
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
