// Static evaluation: immediate score + rack-leave value − defensive exposure.
//
// The leave model encodes A-Math domain knowledge (contributed by a strong
// human player) about which tiles are worth keeping and when:
//   • 0 combines easily with × and ÷ to extend equations, but is awkward with
//     + and − (few operand pairs end in a matching digit).
//   • Heavy numbers 13/17/19 (and the other 10–20 tiles) score big, so one is
//     an asset, but hoarding several is a burden — eased on an open board.
//   • = is only useful where there is room to build a new equation, and a
//     second = in hand is insurance while a third is dead weight.
// All of this is judged against the live board through BoardContext.
//
// ═══════════════════════════════════════════════════════════════════════════
// BIAS POINTS — every constant here and in configFor() is hand-set and is what
// the M5 self-play tuner should optimize. Units are "board points".
// ═══════════════════════════════════════════════════════════════════════════
#pragma once

#include "board.hpp"
#include "rules.hpp"

namespace amath {

// Live situation the leave model judges tiles against. Computed once per turn.
struct BoardContext {
  float mobility = 1.0f;       // board openness: ~0 closed, ~1 typical, ~1.5 wide open
  float freshTileValue = 1.0f; // expected leave worth of one tile drawn from the unseen pool
  int bagSize = 0;             // tiles still in the bag (phase signal)
  float scoreDiff = 0.0f;      // my score − opponent score (situation)
  int unseenTotal = 0;
};

struct LeaveWeights {
  // Per-kind base value of holding one tile after the move. Index by TileKind.
  //  digits 1–3 are flexible glue; heavy tiles carry scoring upside but are
  //  hard to place; choice tiles and blanks are the most flexible in the game.
  float kindValue[KIND_COUNT] = {
      //0     1     2     3     4     5     6     7     8     9
        0.8f, 1.4f, 1.4f, 1.2f, 1.0f, 0.3f, 0.8f, 0.6f, 0.8f, 0.7f,

      //10    11      12    13    14      15      16      17    18      19    20
        -0.3f, 0.2f,  0.3f, 2.5f, -0.2f,  -0.2f,  -0.2f,  2.5f, -0.2f,  3.2f, -0.3f,

      //+     -     ×     ÷
        0.9f, 1.5f, 1.2f, 0.6f,

      //+/-   ×/÷   =     ?
        2.0f, 1.8f, 0.0f, 10.0f};  // '=' handled by the schedule below

  // Value of holding N '=' tiles: first is near-essential, a second is
  // insurance, a third+ clogs the rack.
  float equalsSchedule[RACK_SIZE + 1] = {1.5f, 3.0f, 0.5f, -3.0f, -7.0f, -11.0f, -15.0f, -20.0f, -25.0f};

  // 0 combines with × and ÷: bonus per (0, mul/div-tile) pairing held.
  float zeroMulDivSynergy = 1.2f;
  // 0 with no × / ÷ in hand is awkward.
  float zeroNoMulDivPenalty = 1.2f;

  // Convex burden for hoarding heavy (10–20) tiles, per extra beyond the first.
  float heavyBurden = 3.0f;

  // ── structural playability ──────────────────────────────────────────────
  // An A-Math equation needs operators and an '='. A number-rich, operator-poor
  // rack plays badly; a rack of numbers with no operator at all is nearly dead.
  float operatorRatio = 0.45f;      // desired operators+equals per number tile
  float operatorStarvation = 7.0f;  // penalty per operator short of that
  float noOperatorPenalty = 10.0f;   // flat penalty: ≥2 numbers and zero operators
  // Heavy numbers (10–20) cannot touch another number, so each one demands an
  // operator/'=' to flank it — needing operator supply beyond light numbers.
  float heavyFlankPenalty = 6.0f;   // penalty per heavy beyond the operator+equals supply

  // Penalty per duplicate copy beyond the first of the same kind.
  float duplicatePenalty = 1.0f;
  // Deviation from ~60% digits costs per tile.
  float balancePenalty = 1.2f;

  // Static premium exposure created for the opponent by our placements.
  float exposeEx3 = 4.0f;
  float exposeEx2 = 2.0f;
  float exposePx3 = 1.2f;

  // Exchange policy.
  float exchangeConsiderBar = 6.0f;  // only weigh exchanging when best score ≤ this
  float leadDumpPenalty = 0.6f;      // when ahead, discourage dumping many tiles
  float trailFishBonus = 0.4f;       // when behind, encourage fishing
  float exchangeTempoCost = 1.0f;    // a turn spent exchanging scores nothing

  // Look one more ply ahead on our own side: how much the resulting rack could
  // score next turn (the actual best move it can make on the resulting board).
  // This is what lets the bot exchange to set up a bingo, and prefer placements
  // whose leave keeps real scoring power — discounted because the opponent moves
  // in between and the draw is uncertain.
  float nextTurnPotentialWeight = 0.60f;

  // Risk aversion: candidates are ranked by mean − λ·stddev of their sampled
  // value, so a move that is usually fine but occasionally lets the opponent
  // punish it hard (e.g. opening a ×9 double word square) is penalized for that
  // downside. λ grows when we are ahead (protect a lead) and shrinks when behind.
  float riskAversionBase = 0.18f;
  float riskAversionLeadPer50 = 0.22f;  // extra λ per 50 points of lead
};

extern LeaveWeights g_leave;

// Board openness: empty cells adjacent to the existing structure, normalized.
BoardContext makeContext(const Board& board, const TileCounts& unseen, int bagSize,
                         float scoreDiff);

// Leave value of a rack (after a hypothetical move), judged against context.
float leaveValue(const TileCounts& rack, const BoardContext& ctx);

// Static defensive penalty of a placement set on `board` (board BEFORE move).
float defensePenalty(const Board& board, const std::vector<Placement>& placements);

// Full static equity of a move: immediate score + leave(rack − used) − defense.
float staticEquity(const Board& board, const TileCounts& rack, const Move& move,
                   const BoardContext& ctx);

}  // namespace amath
