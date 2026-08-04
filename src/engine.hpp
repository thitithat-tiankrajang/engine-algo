// Engine orchestrator: request/response protocol, solver selection,
// simulation under hidden information, and the exact endgame solver.
#pragma once

#include <string>

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
//   "stats": {"moves":410,"nodes":81234,"elapsedMs":1830,"candidates":16,"samples":24}
// }
std::string handleRequest(const std::string& requestJson);

}  // namespace amath
