// Static evaluation: immediate score + rack-leave value − defensive exposure.
//
// ═══════════════════════════════════════════════════════════════════════════
// BIAS POINTS (hand-set weights — the M5 self-play tuner should optimize
// every constant in this file; see LeaveWeights below and the defense
// constants). Everything is in "board points" units so the terms compose
// directly with move scores.
// ═══════════════════════════════════════════════════════════════════════════
#pragma once

#include "board.hpp"
#include "rules.hpp"

namespace amath {

struct LeaveWeights {
  // Per-kind base value of holding one tile after the move.
  // Index by TileKind. Hand-set from A-Math intuition:
  //  - small digits are flexible glue; 1..3 especially
  //  - '=' is mandatory for most new equations → first one is precious
  //  - choice tiles and blanks are the most flexible tiles in the game
  //  - tens tiles score well but are hard to fit → slight penalty to hoard
  float kindValue[KIND_COUNT] = {
      // 0     1     2     3     4     5     6     7     8     9
      0.4f, 1.2f, 1.2f, 1.0f, 0.8f, 0.8f, 0.7f, 0.6f, 0.7f, 0.6f,
      // 10    11    12    13    14    15    16    17    18    19    20
      -0.2f, -0.5f, -0.2f, -0.7f, -0.5f, -0.5f, -0.5f, -0.7f, -0.5f, -0.8f, -0.4f,
      // +     -     ×     ÷
      0.9f, 0.7f, 1.1f, 0.3f,
      // +/-   x/÷   =     ?
      1.4f, 1.6f, 0.0f, 4.5f};  // '=' handled by the schedule below

  // Diminishing value of multiple '=' tiles: first is near-essential, a
  // second is insurance, more of them clog the rack.
  float equalsSchedule[RACK_SIZE + 1] = {0.0f, 2.6f, 3.2f, 2.6f, 1.4f, 0.0f, -1.6f, -3.2f, -4.8f};

  // Penalty per duplicate copy beyond the first of the same digit/operator.
  float duplicatePenalty = 0.6f;

  // Ideal digit count in a full leave is ~60%; deviation costs per tile.
  float balancePenalty = 0.45f;

  // Defense: static premium exposure created by our own placements.
  // Counted on empty premium cells orthogonally adjacent to newly placed
  // tiles (they become directly playable-through anchors for the opponent).
  float exposeEx3 = 3.0f;
  float exposeEx2 = 1.5f;
  float exposePx3 = 0.8f;

  // Exchange policy (used when placements are weak or impossible):
  // estimated value of a fresh random tile, and the immediate-score bar under
  // which an exchange is considered at all.
  float freshTileValue = 1.0f;
  float exchangeConsiderBar = 6.0f;
};

extern LeaveWeights g_leave;

// Leave value of a rack (after a hypothetical move).
float leaveValue(const TileCounts& rack);

// Static defensive penalty of a placement set on `board` (board BEFORE move).
float defensePenalty(const Board& board, const std::vector<Placement>& placements);

// Full static equity of a move: immediate score + leave(rack − used) − defense.
float staticEquity(const Board& board, const TileCounts& rack, const Move& move);

}  // namespace amath
