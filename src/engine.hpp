// Engine orchestrator: request/response protocol, solver selection,
// simulation under hidden information, and the exact endgame solver.
#pragma once

#include <optional>
#include <string>
#include <vector>

#include "board.hpp"
#include "rules.hpp"

namespace amath {

// Host-provided progress sink; receives a small JSON document:
// {phase, percent, elapsedMs, etaMs, bestScore, detail}
using ProgressFn = void (*)(const char* jsonUtf8);
void setProgressCallback(ProgressFn fn);

// Handles one AIRequest (JSON in), returns one AIResponse (JSON out).
//
// Request:
// {
//   "board":   [{"r":7,"c":7,"kind":"5","token":"5"}, ...],
//   "rack":    ["5","+","=","?", ...]            // AmathToken keys
//   "bagCount": 42,
//   "oppRackCount": 8,
//   "myScore": 120, "oppScore": 95,
//   "noScoreStreak": 0,          // trailing pass/exchange run length (all sides)
//   "exchangeAllowed": true,
//   "difficulty": "easy" | "normal" | "hard" | "max",
//   "solver": "sim" | "static",  // optional; default "sim". See below.
//   "budgetMs": 4000,            // optional override
//   "seed": 12345
// }
//
// Response:
// {
//   "type": "place" | "exchange" | "pass",
//   "placements": [{"r":7,"c":8,"kind":"?","token":"+"}, ...],
//   "exchange": ["13","19"],
//   "score": 24,                 // immediate score of the chosen placement
//   "equity": 31.5,
//   "solver": "greedy" | "sim" | "endgame",
//   "endgameSolved": true,       // exact solve completed (endgame solver only)
//   "expectedFinalDiff": 12,     // proven final score margin (endgame only)
//   "stats": {"moves":410,"nodes":81234,"elapsedMs":1830,"candidates":16,
//             "samples":24,"genCalls":1}
// }
std::string handleRequest(const std::string& requestJson);

// ── the "static" solver's contract ───────────────────────────────────────────
//
// `"solver":"static"` selects a deterministic static-equity ranking instead of
// the 2-ply sampling search. Two properties are guaranteed, and both are
// enforced by tests/test_static_l1.cpp rather than by convention:
//
//  1. DETERMINISM. The answer is a pure function of the request. No RNG is
//     consulted and no wall-clock deadline can change which move is chosen, so
//     the same position returns the same move on any machine under any load.
//     (`seed` is still accepted and still ignored on this path.)
//
//  2. A BOUNDED NUMBER OF MOVE GENERATIONS. Generation is the only expensive
//     operation in a midgame decision — ~10 ms a call, against under a
//     microsecond for every heuristic the engine computes. The path this
//     replaced issued roughly 385 generations per turn (candidates × samples ×
//     2) and so cost ~2.9 s at a tier that asked for 200 ms. The static path
//     issues ONE, and the ceiling below is an absolute constant: it does not
//     scale with the number of root moves, rack contents, board state, elapsed
//     time, candidate count, or any sampling setting.
//
// The bound covers the midgame DECISION path. The exact end-game solver is a
// tree search and is deliberately outside it — it is bounded by its own node
// and time budgets, and it runs BEFORE solver selection so that a provable
// position is still proven when "static" is requested.
inline constexpr long long STATIC_MAX_GEN_CALLS = 1 + 8;

// Undo root-generation's `dedup` for the candidates that survived admission.
//
// Dedup collapses a FOOTPRINT — the same cells holding the same physical tile
// kinds — to its highest-scoring member, discarding the FACE a choice tile would
// have been played as. That is sound for ranking (within a footprint, leave and
// defense are identical, so the top score is also the top equity) and unsound
// afterwards, because the face lands on the board and the simulation scores the
// opponent's reply and our own next turn against exactly that board.
//
// Expanding AFTER admission is lossless with respect to the candidate cap: if
// any member of a footprint deserved a slot, its representative — which is the
// maximum by static equity in its group — took one. Exposed here so
// tests/test_assignment_expansion.cpp can check that property directly rather
// than inferring it from a chosen move.
void expandAdmittedAssignments(const Board& board, const TileCounts& rack,
                               std::vector<Move>& admitted);

// The exact final margin of a move that ENDS THE GAME on this turn, or nothing
// when it does not end it.
//
// Playing the last tile ends the game before any refill, provided the opponent's
// rack plus the bag is at most a rackful; the mover then scores twice that whole
// remainder. The bonus is charged on the union of the opponent's rack and the
// bag, and that union is exactly the unseen pool — so the number does not depend
// on which hidden tile sits where, and this is a proof rather than an estimate
// at any bag count, not only at bag 0.
//
// Exposed so tests can check it against the exact end-game solver wherever both
// apply, which is the only cross-check that can catch a rules mismatch.
std::optional<int> immediateOutMargin(const TileCounts& unseen, int myRackTotal,
                                      int oppRackCount, int bagCount, const Move& move);

}  // namespace amath
