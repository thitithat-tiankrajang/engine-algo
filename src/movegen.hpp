// Complete legal-move enumeration.
//
// Strategy (A-Math adaptation of Scrabble anchor generation):
//  - Two passes: horizontal main lines, then vertical main lines.
//  - Per empty cell, a precomputed 26-bit cross-check mask says which assigned
//    tokens keep the perpendicular run a valid equation (exact validation —
//    the perpendicular tiles are fixed, so validity depends only on the one
//    new token). Cross-equation scores are computed from the same data.
//  - Within a line, DFS over "leftmost new tile" start cells extends
//    rightward, consuming rack tile kinds (counts, so no permutation
//    duplicates), absorbing existing tiles, and pruning with the incremental
//    LineState structural automaton plus the cross masks.
//  - A move closes when the run is maximal; the main line is then evaluated
//    with exact rational arithmetic.
//  - Single-tile moves are emitted by the horizontal pass only (the vertical
//    pass skips them) so no move is ever produced twice.
#pragma once

#include <vector>

#include "board.hpp"
#include "rules.hpp"

namespace amath {

struct IncrementalBoard;  // src/inc_board.hpp — optional maintained cross/contact state

struct GenStats {
  long long nodesVisited = 0;
  int movesEmitted = 0;
  // When nodeLimit > 0, generation stops after visiting that many DFS nodes.
  long long nodeLimit = 0;
  // Set when generation stopped early (node limit or time budget). A truncated
  // run is still safe to use, but is not guaranteed complete.
  bool truncated = false;
};

// Options controlling how much work generation does and how it is bounded.
//
// Defaults reproduce exact, complete, board-order enumeration — every existing
// caller (endgame solver, tests, brute-force checks) relies on that and must
// pass no options. The midgame decision path opts into the bounded, RAM-safe,
// fairness-ordered mode.
struct GenOptions {
  // Wall-clock budget in milliseconds (0 = unlimited). Split evenly across the
  // horizontal and vertical passes so both directions are always explored.
  double budgetMs = 0;

  // Collapse blank/choice-assignment variants of the same physical placement,
  // keeping the highest-scoring one. Leave value depends only on which tile
  // KINDS are spent (a placed blank is spent regardless of its assigned token)
  // and defense only on which CELLS are used, so the best-scoring realization
  // of a given (cells, kinds) footprint is also its best-equity realization.
  // This bounds stored moves by board geometry, independent of blank count.
  // MUST stay off for the exact endgame, where a blank's assigned token lands
  // on the board and changes future play.
  bool dedup = false;

  // Explore anchors near high-premium squares first, so that if the budget is
  // exhausted the most valuable moves have already been found (no silent,
  // position-order-biased loss of the board's right/bottom).
  bool premiumOrder = false;
};

// Enumerates legal Place moves for `rack` on `board`.
//
// `inc` (optional): a maintained IncrementalBoard whose cross-check/contact state
// matches `board`. When given, generation reuses that state instead of rebuilding
// it (Phase 3). Debug builds still recompute and assert equality. `board` and
// `inc->board` must be the same position; pass nullptr for the classic path.
void generatePlaceMoves(const Board& board, const TileCounts& rack, std::vector<Move>& out,
                        GenStats* stats = nullptr, const GenOptions& opts = {},
                        const IncrementalBoard* inc = nullptr);

}  // namespace amath
