#include "eval.hpp"

#include <algorithm>

namespace amath {

LeaveWeights g_leave;

float leaveValue(const TileCounts& rack) {
  float v = 0.0f;
  int digits = 0;

  for (uint8_t k = 0; k < KIND_COUNT; k++) {
    const int n = rack.n[k];
    if (n == 0) continue;
    if (k == K_EQUALS) continue;  // handled by the schedule
    v += g_leave.kindValue[k] * n;
    if (k <= K_NUM20) digits += n;
    if (n > 1) v -= g_leave.duplicatePenalty * (n - 1);
  }

  v += g_leave.equalsSchedule[std::min<int>(rack.n[K_EQUALS], RACK_SIZE)];

  if (rack.total > 0) {
    const float idealDigits = rack.total * 0.6f;
    v -= g_leave.balancePenalty * std::abs(digits - idealDigits);
  }
  return v;
}

float defensePenalty(const Board& board, const std::vector<Placement>& placements) {
  float penalty = 0.0f;
  static const int D[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
  // A premium cell is counted once even when two placements touch it.
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

float staticEquity(const Board& board, const TileCounts& rack, const Move& move) {
  if (move.type == MoveType::Pass) {
    return leaveValue(rack) - 4.0f;  // BIAS: passing forfeits a turn (~tempo cost)
  }
  if (move.type == MoveType::Exchange) {
    TileCounts after = rack;
    for (uint8_t k : move.exchangeKinds) after.sub(k);
    return leaveValue(after) +
           g_leave.freshTileValue * static_cast<float>(move.exchangeKinds.size()) - 2.0f;
  }
  TileCounts after = rack;
  for (const Placement& p : move.placements) after.sub(p.kind);
  return static_cast<float>(move.score) + leaveValue(after) - defensePenalty(board, move.placements);
}

}  // namespace amath
