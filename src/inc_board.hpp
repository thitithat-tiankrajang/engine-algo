// Phase 2 — Incremental board state.
//
// A persistent board wrapper that maintains, across make/unmake, everything the
// move generator otherwise rebuilds from scratch at every search node:
//   - cross-check masks + fixed cross-sums (both directions)
//   - anchors (empty cells adjacent to the existing structure)
//   - contact-distance info (both pass directions)
//   - a Zobrist board hash
//
// Correctness contract: after any sequence of makeMove()/undoMove() the
// maintained state is byte-identical to a full rebuild() on the same board.
// assertConsistent() proves this (used by tests / debug builds). This module is
// ADDITIVE in Phase 2 — it is not yet consumed by movegen or the search, so
// production behavior is unchanged. Phase 3 makes the generator read this state.
//
// The cross/contact primitives below are ported verbatim from
// src/movegen.cpp (computeCross / computeContact) so that when Phase 3 unifies
// them there is a single source of truth.
#pragma once

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

#include "board.hpp"
#include "rules.hpp"

namespace amath {

// Mirrors movegen's CrossInfo (same defaults: full mask, no fixed sum, no run).
struct XCross {
  uint32_t mask = (1u << ASSIGNED_COUNT) - 1;
  int fixedSum = 0;
  bool has = false;
  bool operator==(const XCross& o) const {
    return mask == o.mask && fixedSum == o.fixedSum && has == o.has;
  }
  bool operator!=(const XCross& o) const { return !(*this == o); }
};

// Independent Zobrist table for the maintained board hash. (It only needs to be
// internally consistent for the equality contract; it is not tied to the
// search's own hash in Phase 2.)
struct IncZobrist {
  uint64_t cell[BOARD_CELLS][KIND_COUNT][ASSIGNED_COUNT];
  IncZobrist() {
    std::mt19937_64 r(0x9E3779B97F4A7C15ULL);
    for (auto& a : cell)
      for (auto& b : a)
        for (auto& v : b) v = r();
  }
};
inline const IncZobrist& incZob() {
  static const IncZobrist z;
  return z;
}

struct IncrementalBoard {
  static constexpr int CONTACT_INF = 64;

  Board board;
  // crossV: perpendicular = vertical (pdr=1,pdc=0) — used by the HORIZONTAL pass.
  // crossH: perpendicular = horizontal (pdr=0,pdc=1) — used by the VERTICAL pass.
  std::array<XCross, BOARD_CELLS> crossV{};
  std::array<XCross, BOARD_CELLS> crossH{};
  // contactHpass uses crossV (row scan); contactVpass uses crossH (col scan).
  std::array<uint8_t, BOARD_CELLS> contactHpass{};
  std::array<uint8_t, BOARD_CELLS> contactVpass{};
  std::array<uint8_t, BOARD_CELLS> anchor{};  // 1 = empty cell adjacent to structure
  uint64_t hash = 0;

  // ── primitives (ported verbatim from movegen.cpp) ──────────────────────────

  // Cross info for one EMPTY cell along (pdr,pdc). Occupied cells get the default.
  XCross crossCell(int row, int col, int pdr, int pdc) const {
    XCross info{};
    if (board.at(row, col).occupied()) return info;
    const bool up = inBounds(row - pdr, col - pdc) && board.at(row - pdr, col - pdc).occupied();
    const bool down = inBounds(row + pdr, col + pdc) && board.at(row + pdr, col + pdc).occupied();
    if (!up && !down) return info;

    info.has = true;
    info.fixedSum = 0;
    std::vector<uint8_t> tokens;
    int r = row - pdr, c = col - pdc;
    std::vector<uint8_t> above;
    while (inBounds(r, c) && board.at(r, c).occupied()) {
      above.push_back(board.at(r, c).token);
      info.fixedSum += TILE_POINTS[board.at(r, c).kind];
      r -= pdr;
      c -= pdc;
    }
    for (auto it = above.rbegin(); it != above.rend(); ++it) tokens.push_back(*it);
    const size_t hole = tokens.size();
    tokens.push_back(T_NONE);
    r = row + pdr;
    c = col + pdc;
    while (inBounds(r, c) && board.at(r, c).occupied()) {
      tokens.push_back(board.at(r, c).token);
      info.fixedSum += TILE_POINTS[board.at(r, c).kind];
      r += pdr;
      c += pdc;
    }
    uint32_t mask = 0;
    for (uint8_t t = 0; t < ASSIGNED_COUNT; t++) {
      tokens[hole] = t;
      const LineResult lr = validateLine(tokens.data(), static_cast<int>(tokens.size()));
      if (lr.valid) mask |= 1u << t;
    }
    info.mask = mask;
    return info;
  }

  // Recompute contactHpass for one row (scan its columns), using crossV.
  void contactLineH(int row) {
    int carry = CONTACT_INF;
    for (int col = BOARD_SIZE - 1; col >= 0; col--) {
      const int idx = Board::idx(row, col);
      if (board.at(row, col).occupied()) carry = 0;
      else if (crossV[idx].has) carry = 1;
      else carry = carry >= CONTACT_INF ? CONTACT_INF : carry + 1;
      contactHpass[idx] = static_cast<uint8_t>(std::min(carry, CONTACT_INF));
    }
  }
  // Recompute contactVpass for one column (scan its rows), using crossH.
  void contactLineV(int col) {
    int carry = CONTACT_INF;
    for (int row = BOARD_SIZE - 1; row >= 0; row--) {
      const int idx = Board::idx(row, col);
      if (board.at(row, col).occupied()) carry = 0;
      else if (crossH[idx].has) carry = 1;
      else carry = carry >= CONTACT_INF ? CONTACT_INF : carry + 1;
      contactVpass[idx] = static_cast<uint8_t>(std::min(carry, CONTACT_INF));
    }
  }

  bool anchorAt(int row, int col) const {
    if (board.at(row, col).occupied()) return false;
    const int d[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
    for (auto& o : d)
      if (inBounds(row + o[0], col + o[1]) && board.at(row + o[0], col + o[1]).occupied()) return true;
    return false;
  }

  // ── full rebuild (ground truth) ────────────────────────────────────────────
  void rebuild() {
    hash = 0;
    for (int row = 0; row < BOARD_SIZE; row++) {
      for (int col = 0; col < BOARD_SIZE; col++) {
        const int idx = Board::idx(row, col);
        const Cell& cell = board.at(row, col);
        if (cell.occupied()) hash ^= incZob().cell[idx][cell.kind][cell.token];
        crossV[idx] = crossCell(row, col, 1, 0);
        crossH[idx] = crossCell(row, col, 0, 1);
        anchor[idx] = anchorAt(row, col) ? 1 : 0;
      }
    }
    for (int line = 0; line < BOARD_SIZE; line++) {
      contactLineH(line);
      contactLineV(line);
    }
  }

  // ── incremental make / unmake ──────────────────────────────────────────────
  // Placing (or removing) tiles changes: (a) the hash for those cells; (b) crossV
  // only within the placed cells' COLUMNS and crossH only within their ROWS
  // (a perpendicular run is confined to one line); (c) contactHpass for any row,
  // and contactVpass for any column, containing a changed cell; (d) anchors of
  // the placed cells and their orthogonal neighbours.
  void makeMove(const std::vector<Placement>& ps) { apply(ps, /*place=*/true); }
  void undoMove(const std::vector<Placement>& ps) { apply(ps, /*place=*/false); }

  void apply(const std::vector<Placement>& ps, bool place) {
    // 1) mutate board + hash for each cell.
    for (const Placement& p : ps) {
      const int idx = Board::idx(p.row, p.col);
      hash ^= incZob().cell[idx][p.kind][p.token];  // XOR is its own inverse
      if (place) board.place(p.row, p.col, p.kind, p.token);
      else board.remove(p.row, p.col);
    }
    // 2) refresh cross masks on affected columns (crossV) and rows (crossH),
    //    recording which rows/cols saw a change so contact can follow. Each
    //    affected column/row is recomputed AT MOST ONCE even when a move places
    //    several tiles in it (all tiles are already down by step 1, so one pass
    //    captures them all).
    std::array<bool, BOARD_SIZE> touchRowH{};  // contactHpass rows to refresh
    std::array<bool, BOARD_SIZE> touchColV{};  // contactVpass cols to refresh
    std::array<bool, BOARD_SIZE> colDone{}, rowDone{};
    for (const Placement& p : ps) {
      if (!colDone[p.col]) {  // crossV lives in this cell's column
        colDone[p.col] = true;
        for (int row = 0; row < BOARD_SIZE; row++) {
          const int idx = Board::idx(row, p.col);
          const XCross nv = board.at(row, p.col).occupied() ? XCross{} : crossCell(row, p.col, 1, 0);
          if (nv != crossV[idx]) { crossV[idx] = nv; touchRowH[row] = true; }
        }
      }
      if (!rowDone[p.row]) {  // crossH lives in this cell's row
        rowDone[p.row] = true;
        for (int col = 0; col < BOARD_SIZE; col++) {
          const int idx = Board::idx(p.row, col);
          const XCross nh = board.at(p.row, col).occupied() ? XCross{} : crossCell(p.row, col, 0, 1);
          if (nh != crossH[idx]) { crossH[idx] = nh; touchColV[col] = true; }
        }
      }
      // occupancy change in this row/col affects contact of that very line too.
      touchRowH[p.row] = true;
      touchColV[p.col] = true;
      // anchors: this cell + orthogonal neighbours.
      anchor[Board::idx(p.row, p.col)] = anchorAt(p.row, p.col) ? 1 : 0;
      const int d[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
      for (auto& o : d) {
        const int rr = p.row + o[0], cc = p.col + o[1];
        if (inBounds(rr, cc)) anchor[Board::idx(rr, cc)] = anchorAt(rr, cc) ? 1 : 0;
      }
    }
    // 3) refresh contact for the affected lines.
    for (int row = 0; row < BOARD_SIZE; row++)
      if (touchRowH[row]) contactLineH(row);
    for (int col = 0; col < BOARD_SIZE; col++)
      if (touchColV[col]) contactLineV(col);
  }

  // ── consistency proof ──────────────────────────────────────────────────────
  // Rebuild a fresh copy from the same board and compare every maintained field.
  bool assertConsistent(const char* where = "") const {
    IncrementalBoard fresh;
    fresh.board = board;
    fresh.rebuild();
    bool ok = true;
    auto fail = [&](const char* what, int idx) {
      std::fprintf(stderr, "IncrementalBoard MISMATCH (%s) at %s idx=%d (r=%d,c=%d)\n", what, where,
                   idx, idx / BOARD_SIZE, idx % BOARD_SIZE);
      ok = false;
    };
    if (hash != fresh.hash) { std::fprintf(stderr, "hash mismatch at %s\n", where); ok = false; }
    for (int i = 0; i < BOARD_CELLS; i++) {
      if (crossV[i] != fresh.crossV[i]) fail("crossV", i);
      if (crossH[i] != fresh.crossH[i]) fail("crossH", i);
      if (contactHpass[i] != fresh.contactHpass[i]) fail("contactHpass", i);
      if (contactVpass[i] != fresh.contactVpass[i]) fail("contactVpass", i);
      if (anchor[i] != fresh.anchor[i]) fail("anchor", i);
    }
    return ok;
  }
};

}  // namespace amath
