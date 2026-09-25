#include "space_map.hpp"

#include <algorithm>
#include <cstdio>

namespace amath {

namespace {

// True when a contiguous existing run adjoining (row,col) along (dr,dc) holds
// an '='. Walked straight off the board — no mask involved — because "the board
// already supplies the '='" is a statement about tiles, not about legality.
bool runHasEquals(const Board& board, int row, int col, int dr, int dc, int& lenOut) {
  bool found = false;
  int len = 0;
  int r = row + dr, c = col + dc;
  while (inBounds(r, c) && board.at(r, c).occupied()) {
    if (board.at(r, c).token == T_EQ) found = true;
    len++;
    r += dr;
    c += dc;
  }
  lenOut = len;
  return found;
}

// One direction's contribution to a single-tile score: the fixed tiles of the
// perpendicular run plus this tile, under the cell's premium.
int directionScore(const XCross& cross, int row, int col, uint8_t kind) {
  if (!cross.has) return 0;
  int tileMult = 1, eqMult = 1;
  premiumMultipliers(row, col, tileMult, eqMult);
  return (cross.fixedSum + TILE_POINTS[kind] * tileMult) * eqMult;
}

}  // namespace

int oneTileScore(const IncrementalBoard& inc, int row, int col, uint8_t kind) {
  const int idx = Board::idx(row, col);
  return directionScore(inc.crossV[idx], row, col, kind) +
         directionScore(inc.crossH[idx], row, col, kind);
}

SpaceMap SpaceMap::build(const Board& board) {
  IncrementalBoard inc;
  inc.board = board;
  inc.rebuild();
  return build(inc);
}

SpaceMap SpaceMap::build(const IncrementalBoard& inc) {
  SpaceMap map;
  const Board& board = inc.board;
  map.bestScoreForToken.fill(0);

  // ── hooks: every empty cell where a perpendicular run would form ──────────
  for (int row = 0; row < BOARD_SIZE; row++) {
    for (int col = 0; col < BOARD_SIZE; col++) {
      const int idx = Board::idx(row, col);
      if (board.at(row, col).occupied()) continue;
      const XCross& xv = inc.crossV[idx];
      const XCross& xh = inc.crossH[idx];
      if (!xv.has && !xh.has) continue;  // not adjacent to structure at all

      HookSite site;
      site.cell = static_cast<uint16_t>(idx);
      site.hasV = xv.has;
      site.hasH = xh.has;
      site.maskV = xv.mask;
      site.maskH = xh.mask;
      // A tile dropped here forms EVERY run it touches, and all of them must be
      // valid — so the legal set is the intersection, with a direction that
      // forms no run imposing no constraint.
      site.playMask = (xv.has ? xv.mask : ALL_TOKEN_MASK) &
                      (xh.has ? xh.mask : ALL_TOKEN_MASK);
      site.tokenCount = static_cast<uint8_t>(__builtin_popcount(site.playMask));

      int lenUp = 0, lenDown = 0, lenLeft = 0, lenRight = 0;
      const bool eqUp = runHasEquals(board, row, col, -1, 0, lenUp);
      const bool eqDown = runHasEquals(board, row, col, 1, 0, lenDown);
      const bool eqLeft = runHasEquals(board, row, col, 0, -1, lenLeft);
      const bool eqRight = runHasEquals(board, row, col, 0, 1, lenRight);
      site.equalsAdjacentV = eqUp || eqDown;
      site.equalsAdjacentH = eqLeft || eqRight;

      if (site.playMask == 0) {
        map.deadCells++;
        continue;  // no ONE-TILE move is legal here; not a hook site
      }

      uint32_t bits = site.playMask;
      while (bits) {
        const uint8_t token = static_cast<uint8_t>(__builtin_ctz(bits));
        bits &= bits - 1;
        const uint8_t kind = canonicalKindForToken(token);
        const int score = oneTileScore(inc, row, col, kind);
        // Tokens arrive lowest-first, so ">" keeps the lowest token on a tie.
        if (site.bestToken == T_NONE || score > site.bestScore) {
          site.bestScore = static_cast<int16_t>(score);
          site.bestToken = token;
        }
        map.sitesForToken[token]++;
        map.bestScoreForToken[token] =
            std::max<int16_t>(map.bestScoreForToken[token], static_cast<int16_t>(score));
      }

      // Per-KIND site counts: a physical tile can reach this cell when any token
      // it may be assigned to is legal here. This is where blanks and the two
      // choice tiles differ from the token view — a blank reaches every hook.
      for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
        if (kindAssignMask(kind) & site.playMask) map.sitesForKind[kind]++;
      }

      if (site.playMask == EQUALS_TOKEN_MASK) map.equalsGatedSites++;
      if (site.playMask & ~EQUALS_TOKEN_MASK) map.equalsFreeSites++;
      if (site.playMask & TENS_TOKEN_MASK) map.heavyPlaceableSites++;
      map.hooks.push_back(site);
    }
  }
  map.hookSiteCount = static_cast<uint16_t>(map.hooks.size());

  // ── extends: maximal empty regions lying alongside an existing run ────────
  // Scanned per line, in both directions. `dir` names the direction of the run
  // being extended, so a horizontal region (dir=1) is found by scanning a row.
  for (int dir = 0; dir < 2; dir++) {
    const bool horizontal = dir == 1;
    for (int line = 0; line < BOARD_SIZE; line++) {
      int i = 0;
      while (i < BOARD_SIZE) {
        const int row0 = horizontal ? line : i;
        const int col0 = horizontal ? i : line;
        if (board.at(row0, col0).occupied()) {
          i++;
          continue;
        }
        int j = i;
        while (j < BOARD_SIZE) {
          const int r = horizontal ? line : j;
          const int c = horizontal ? j : line;
          if (board.at(r, c).occupied()) break;
          j++;
        }
        // [i, j) is a maximal empty region on this line.
        const bool low = i > 0;
        const bool high = j < BOARD_SIZE;
        if (low || high) {
          const int dr = horizontal ? 0 : 1;
          const int dc = horizontal ? 1 : 0;
          ExtendSite site;
          site.firstCell = static_cast<uint16_t>(Board::idx(row0, col0));
          site.dir = static_cast<uint8_t>(dir);
          site.length = static_cast<uint8_t>(j - i);
          site.touchesLow = low;
          site.touchesHigh = high;
          int lenLow = 0, lenHigh = 0;
          const bool eqLow = low && runHasEquals(board, row0, col0, -dr, -dc, lenLow);
          const int lastRow = horizontal ? line : j - 1;
          const int lastCol = horizontal ? j - 1 : line;
          const bool eqHigh = high && runHasEquals(board, lastRow, lastCol, dr, dc, lenHigh);
          site.runHasEquals = eqLow || eqHigh;
          site.adjacentRunLen = static_cast<uint8_t>(std::max(lenLow, lenHigh));
          // A region only extends a run when a run is actually there.
          if (site.adjacentRunLen > 0) {
            map.extendCapacity += site.length;
            if (site.length >= 3) map.newEquationCapacity++;
            map.extends.push_back(site);
          }
        }
        i = j + 1;  // skip the occupied cell that closed the region
      }
    }
  }
  return map;
}

bool SpaceMap::assertConsistent(const Board& board, const char* where) const {
  const SpaceMap fresh = SpaceMap::build(board);
  bool ok = true;
  auto fail = [&](const char* what) {
    std::fprintf(stderr, "SpaceMap MISMATCH (%s) at %s\n", what, where);
    ok = false;
  };
  if (hooks.size() != fresh.hooks.size()) fail("hooks.size");
  else {
    for (size_t i = 0; i < hooks.size(); i++) {
      const HookSite& a = hooks[i];
      const HookSite& b = fresh.hooks[i];
      if (a.cell != b.cell || a.playMask != b.playMask || a.maskV != b.maskV ||
          a.maskH != b.maskH || a.hasV != b.hasV || a.hasH != b.hasH ||
          a.tokenCount != b.tokenCount || a.bestScore != b.bestScore ||
          a.bestToken != b.bestToken || a.equalsAdjacentV != b.equalsAdjacentV ||
          a.equalsAdjacentH != b.equalsAdjacentH) {
        fail("hook");
        break;
      }
    }
  }
  if (extends.size() != fresh.extends.size()) fail("extends.size");
  else {
    for (size_t i = 0; i < extends.size(); i++) {
      const ExtendSite& a = extends[i];
      const ExtendSite& b = fresh.extends[i];
      if (a.firstCell != b.firstCell || a.dir != b.dir || a.length != b.length ||
          a.touchesLow != b.touchesLow || a.touchesHigh != b.touchesHigh ||
          a.runHasEquals != b.runHasEquals || a.adjacentRunLen != b.adjacentRunLen) {
        fail("extend");
        break;
      }
    }
  }
  if (sitesForToken != fresh.sitesForToken) fail("sitesForToken");
  if (bestScoreForToken != fresh.bestScoreForToken) fail("bestScoreForToken");
  if (sitesForKind != fresh.sitesForKind) fail("sitesForKind");
  if (hookSiteCount != fresh.hookSiteCount) fail("hookSiteCount");
  if (equalsGatedSites != fresh.equalsGatedSites) fail("equalsGatedSites");
  if (equalsFreeSites != fresh.equalsFreeSites) fail("equalsFreeSites");
  if (heavyPlaceableSites != fresh.heavyPlaceableSites) fail("heavyPlaceableSites");
  if (deadCells != fresh.deadCells) fail("deadCells");
  if (extendCapacity != fresh.extendCapacity) fail("extendCapacity");
  if (newEquationCapacity != fresh.newEquationCapacity) fail("newEquationCapacity");

  // Internal identities that must hold by construction. A hook always has a
  // non-empty playMask, so it is either gated on '=' or usable without one —
  // never both, never neither.
  if (hookSiteCount != static_cast<uint16_t>(hooks.size())) fail("hookSiteCount/size");
  if (static_cast<uint32_t>(equalsGatedSites) + equalsFreeSites != hookSiteCount)
    fail("gated+free!=hooks");
  return ok;
}

bool SpaceMap::assertTopologyMatches(const IncrementalBoard& inc, const char* where) const {
  bool ok = true;
  auto fail = [&](const char* what, int idx) {
    std::fprintf(stderr, "SpaceMap TOPOLOGY MISMATCH (%s) at %s idx=%d (r=%d,c=%d)\n", what,
                 where, idx, idx / BOARD_SIZE, idx % BOARD_SIZE);
    ok = false;
  };

  // (a) every hook cell is an anchor of the maintained board.
  std::vector<uint8_t> isHook(BOARD_CELLS, 0);
  for (const HookSite& site : hooks) {
    isHook[site.cell] = 1;
    if (!inc.anchor[site.cell]) fail("hook-not-anchor", site.cell);
    if (!site.hasV && !site.hasH) fail("hook-without-run", site.cell);
  }

  // (b) every anchor is either a hook or a counted dead cell. The generator's
  //     anchors and this map's sites must partition the same set of cells; a
  //     cell that is one but not the other means the two disagree about where
  //     the board's live edge is.
  int anchors = 0, dead = 0;
  for (int idx = 0; idx < BOARD_CELLS; idx++) {
    if (!inc.anchor[idx]) continue;
    anchors++;
    if (isHook[idx]) continue;
    const uint32_t play = (inc.crossV[idx].has ? inc.crossV[idx].mask : ALL_TOKEN_MASK) &
                          (inc.crossH[idx].has ? inc.crossH[idx].mask : ALL_TOKEN_MASK);
    if (play != 0) fail("anchor-playable-but-not-hook", idx);
    dead++;
  }
  if (anchors != hookSiteCount + deadCells) {
    std::fprintf(stderr, "SpaceMap TOPOLOGY MISMATCH (anchor partition) at %s: %d anchors vs %d hooks + %d dead\n",
                 where, anchors, hookSiteCount, deadCells);
    ok = false;
  }
  if (dead != deadCells) fail("deadCells", -1);

  // (c) an ExtendSite that touches structure has the matching cross-run flag on
  //     its boundary cell: extending a row means the boundary cell has a
  //     horizontal run (crossH), extending a column means crossV.
  for (const ExtendSite& site : extends) {
    const int row = site.firstCell / BOARD_SIZE;
    const int col = site.firstCell % BOARD_SIZE;
    const bool horizontal = site.dir == 1;
    if (site.touchesLow) {
      const int idx = Board::idx(row, col);
      const XCross& x = horizontal ? inc.crossH[idx] : inc.crossV[idx];
      if (!x.has) fail("extend-low-no-run", idx);
    }
    if (site.touchesHigh) {
      const int lastRow = horizontal ? row : row + site.length - 1;
      const int lastCol = horizontal ? col + site.length - 1 : col;
      const int idx = Board::idx(lastRow, lastCol);
      const XCross& x = horizontal ? inc.crossH[idx] : inc.crossV[idx];
      if (!x.has) fail("extend-high-no-run", idx);
    }
  }
  return ok;
}

}  // namespace amath
