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

struct GenStats {
  long long nodesVisited = 0;
  int movesEmitted = 0;
  // When nodeLimit > 0, generation stops after visiting that many DFS nodes
  // (truncated is set). Bounded, slightly incomplete enumeration is used for
  // opponent-reply estimates inside the simulation solver.
  long long nodeLimit = 0;
  bool truncated = false;
};

// Enumerates every legal Place move for `rack` on `board`.
void generatePlaceMoves(const Board& board, const TileCounts& rack, std::vector<Move>& out,
                        GenStats* stats = nullptr);

}  // namespace amath
