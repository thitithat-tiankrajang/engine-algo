// Movegen profiling counters + attribution helpers.
//
// ALL of this compiles to nothing unless AMATH_PROFILE is defined, so the
// shipped engine (WASM / release CLI) is byte-for-byte unaffected. It exists
// only so the profiling harness can measure where generatePlaceMoves() spends
// its time — exact work-volume counters, plus PROF_NOINLINE to keep the hot
// leaf functions visible to a sampling profiler (they are `inline` in headers
// and would otherwise be merged into their callers).
#pragma once

#ifdef AMATH_PROFILE
#include <cstdint>
namespace amath {
struct Prof {
  uint64_t extendCalls = 0;      // DFS nodes (== GenStats.nodesVisited)
  uint64_t emitCalls = 0;        // emitIfValid entered
  uint64_t evalLineCalls = 0;    // evaluateLine run (main-line arithmetic)
  uint64_t validateLineCalls = 0;  // validateLine run (cross-check build)
  uint64_t dedupKeyBuilds = 0;   // std::string dedup keys constructed
  uint64_t dedupFind = 0;        // dedup map lookups
  uint64_t dedupInsert = 0;      // dedup map inserts (unique moves)
  uint64_t moveConstruct = 0;    // Move objects built (placements vector copy)
  uint64_t absorbCalls = 0;      // absorb() invocations
  uint64_t startAtCalls = 0;     // startAt() invocations
  uint64_t lineAdvance = 0;      // LineState::advance in the DFS token loop
  uint64_t crossCellCalls = 0;   // crossCell() during cross-check rebuild
  void reset() { *this = Prof{}; }
};
inline Prof& prof() { static Prof p; return p; }
}  // namespace amath
#define PROF(stmt) do { ::amath::prof().stmt; } while (0)
#define PROF_NOINLINE __attribute__((noinline))
#else
#define PROF(stmt) do {} while (0)
#define PROF_NOINLINE
#endif
