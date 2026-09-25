// Phase 0 — the board's opportunity map, derived from the generator's own data.
//
// `Generator::computeCross()` (src/movegen.cpp) already answers, for every empty
// cell, EXACTLY which assigned tokens keep the perpendicular run a valid
// equation — and `IncrementalBoard` already maintains that answer across
// make/unmake as `crossV` / `crossH`. Today both are consumed only to prune the
// DFS and are then discarded; nothing in eval.cpp ever sees them, so the leave
// model judges a board by one scalar (`BoardContext::mobility`, an anchor count)
// and cannot tell a board where every open cell demands '=' from one where none
// do.
//
// SpaceMap is that data, kept. It ADDS NO KNOWLEDGE: every field below is a
// restatement of crossV/crossH plus board occupancy, and tests/test_space_map.cpp
// proves each one against complete move generation rather than against a second
// opinion.
//
// ── what is claimed, and what is NOT ────────────────────────────────────────
//
// CLAIMED (and proven): everything here describes ONE-TILE placements exactly.
// A cell is a HookSite iff a rack holding a single tile can legally play there,
// `playMask` is exactly the set of tokens that can be that tile, and `bestScore`
// is exactly the score movegen awards for it.
//
// NOT CLAIMED: multi-tile playability. `deadCells` counts cells where no SINGLE
// tile is legal — a two-tile move may still reach them. `ExtendSite` is a purely
// TOPOLOGICAL measure (empty cells lying alongside an existing run); it does not
// assert that any particular multi-tile extension is legal. Phase 0 deliberately
// stops where proof stops.
#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "board.hpp"
#include "inc_board.hpp"
#include "tiles.hpp"

namespace amath {

// Tokens 10..20: the numbers that cannot sit beside another number, so a cell
// accepting one of them is qualitatively different from a cell that does not.
inline constexpr uint32_t TENS_TOKEN_MASK = [] {
  uint32_t m = 0;
  for (uint8_t t = 10; t <= T_NUM20; t++) m |= 1u << t;
  return m;
}();

inline constexpr uint32_t EQUALS_TOKEN_MASK = 1u << T_EQ;
inline constexpr uint32_t ALL_TOKEN_MASK = (1u << ASSIGNED_COUNT) - 1;

// Which physical tile is meant when a site is described by an assigned TOKEN.
// Scores depend on the KIND (TILE_POINTS), not the token, so a token-keyed
// score needs one designated kind; the natural one is the tile whose fixed
// token IS that token. Choice tiles and blanks are covered separately by
// `sitesForKind`, where their own point values apply.
inline uint8_t canonicalKindForToken(uint8_t token) {
  if (token <= T_NUM20) return token;
  switch (token) {
    case T_ADD: return K_ADD;
    case T_SUB: return K_SUB;
    case T_MUL: return K_MUL;
    case T_DIV: return K_DIV;
    case T_EQ: return K_EQUALS;
    default: return K_NONE;
  }
}

// A cell where a single tile can be played, with the exact constraint on it.
//
// `dir` is not a field: a cell is one site, and the two directions it may form
// an equation in are both recorded, because a tile dropped here forms BOTH at
// once and must satisfy BOTH. That intersection is `playMask`, and conflating
// it with either single-direction mask is the misreading this struct exists to
// prevent.
struct HookSite {
  uint16_t cell = 0;
  uint32_t maskV = ALL_TOKEN_MASK;  // crossV mask; meaningless unless hasV
  uint32_t maskH = ALL_TOKEN_MASK;  // crossH mask; meaningless unless hasH
  uint32_t playMask = 0;            // tokens legal as a ONE-TILE move here
  uint8_t tokenCount = 0;           // popcount(playMask)
  bool hasV = false;                // a vertical run forms through this cell
  bool hasH = false;                // a horizontal run forms through this cell
  bool equalsAdjacentV = false;     // the vertical fixed run already holds '='
  bool equalsAdjacentH = false;     // the horizontal fixed run already holds '='
  int16_t bestScore = 0;            // best one-tile score over playMask
  uint8_t bestToken = T_NONE;       // the token achieving it (lowest on a tie)
};

// A maximal run of empty cells lying alongside an existing run, in the same
// direction — the room an equation has to grow into.
//
// TOPOLOGY ONLY (see the header comment). Counted once per (line, region), so a
// single empty cell can belong to one horizontal and one vertical region; that
// is intended, because extending a row and extending a column are two different
// plays.
struct ExtendSite {
  uint16_t firstCell = 0;    // lowest-index empty cell of the region
  uint8_t dir = 0;           // 0 = extends a VERTICAL run, 1 = a HORIZONTAL run
  uint8_t length = 0;        // consecutive empty cells
  bool touchesLow = false;   // occupied cell immediately before the region
  bool touchesHigh = false;  // occupied cell immediately after the region
  bool runHasEquals = false; // an adjoining existing run already contains '='
  uint8_t adjacentRunLen = 0;  // longest adjoining existing run
};

struct SpaceMap {
  std::vector<HookSite> hooks;
  std::vector<ExtendSite> extends;

  // ── aggregates: the numbers a future leave model would read ──────────────
  // Every one is a count over `hooks` / `extends` and is recomputed from
  // scratch by assertConsistent().
  std::array<uint16_t, ASSIGNED_COUNT> sitesForToken{};
  std::array<int16_t, ASSIGNED_COUNT> bestScoreForToken{};
  std::array<uint16_t, KIND_COUNT> sitesForKind{};

  uint16_t hookSiteCount = 0;       // == hooks.size()
  uint16_t equalsGatedSites = 0;    // playMask == {'='} exactly
  uint16_t equalsFreeSites = 0;     // playMask holds at least one non-'=' token
  // PROVABLY ALWAYS ZERO for one-tile placements, and kept only so the proof has
  // somewhere to fail if it is wrong. A 10..20 token may not touch a number, so
  // both its neighbours inside the run must be operators or absent. On a legal
  // board a fragment adjoining the hole is either a maximal run of length >= 2 —
  // which is a valid equation, and so ends in a number and starts with a number
  // or a unary '-' — or a single tile. Every surviving arrangement forces the
  // hole's value to 0: prepending X to a side that begins with unary '-' shifts
  // that side by exactly X, so balance requires X = 0. A heavy tile therefore
  // only ever enters play as part of a MULTI-TILE move, and Phase 1's
  // heavy-placement signal has to be defined over those instead.
  uint16_t heavyPlaceableSites = 0; // playMask holds at least one 10..20 token
  uint16_t deadCells = 0;           // anchor cells where NO single tile is legal
  uint32_t extendCapacity = 0;      // Σ ExtendSite::length, both directions
  uint16_t newEquationCapacity = 0; // empty regions long enough (≥3) to host a
                                    // whole new equation, topology only

  // ── construction ─────────────────────────────────────────────────────────
  // Both forms produce identical maps; the second avoids rebuilding cross state
  // a caller already maintains. `inc.board` must be the position being mapped.
  static SpaceMap build(const Board& board);
  static SpaceMap build(const IncrementalBoard& inc);

  // ── consistency proof (test/debug builds) ────────────────────────────────
  // Rebuild from the same board and compare every field, exactly as
  // IncrementalBoard::assertConsistent does. Cheap enough to call per position
  // in tests; never called from the product path.
  bool assertConsistent(const Board& board, const char* where = "") const;

  // Every hook cell is an anchor, every anchor is a hook or a dead cell, and
  // every ExtendSite boundary that touches structure has the matching
  // cross-run flag set. This is the "same topology" check: it fails if SpaceMap
  // and the generator ever disagree about where the board's edges are.
  bool assertTopologyMatches(const IncrementalBoard& inc, const char* where = "") const;
};

// Score of placing one tile of `kind` at (row, col), summed over whichever
// perpendicular runs it completes — the same arithmetic movegen's emitIfValid
// performs for a single placement, expressed once.
int oneTileScore(const IncrementalBoard& inc, int row, int col, uint8_t kind);

}  // namespace amath
