// Board representation and the standard 15x15 A-Math premium layout
// (mirrors EQ-Lab src/constants/boardLayout.ts).
#pragma once

#include <array>
#include <cstdint>

#include "tiles.hpp"

namespace amath {

constexpr int BOARD_SIZE = 15;
constexpr int BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
constexpr int CENTER = 7;

enum SlotType : uint8_t { PX1 = 0, PX2 = 1, PX3 = 2, EX2 = 3, EX3 = 4 };
// px3star scores exactly like px3; the star only marks the first-move cell.

// clang-format off
constexpr std::array<uint8_t, BOARD_CELLS> PREMIUM = [] {
  std::array<uint8_t, BOARD_CELLS> p{};
  auto set = [&p](int r, int c, SlotType t) { p[r * BOARD_SIZE + c] = t; };
  const int E3[][2] = {{0,0},{0,7},{0,14},{7,0},{7,14},{14,0},{14,7},{14,14}};
  const int E2[][2] = {{1,1},{1,13},{2,2},{2,12},{3,3},{3,11},{11,3},{11,11},{12,2},{12,12},{13,1},{13,13}};
  const int P3[][2] = {{1,5},{1,9},{4,4},{4,10},{5,1},{5,5},{5,9},{5,13},{7,7},
                       {9,1},{9,5},{9,9},{9,13},{10,4},{10,10},{13,5},{13,9}};
  const int P2[][2] = {{0,3},{0,11},{2,6},{2,8},{3,0},{3,7},{3,14},{6,2},{6,6},{6,8},{6,12},
                       {7,3},{7,11},{8,2},{8,6},{8,8},{8,12},{11,0},{11,7},{11,14},
                       {12,6},{12,8},{14,3},{14,11}};
  for (auto& rc : E3) set(rc[0], rc[1], EX3);
  for (auto& rc : E2) set(rc[0], rc[1], EX2);
  for (auto& rc : P3) set(rc[0], rc[1], PX3);
  for (auto& rc : P2) set(rc[0], rc[1], PX2);
  return p;
}();
// clang-format on

struct Cell {
  uint8_t kind = K_NONE;     // physical tile kind (points come from this)
  uint8_t token = T_NONE;    // assigned/display token (semantics come from this)
  bool occupied() const { return kind != K_NONE; }
};

struct Board {
  std::array<Cell, BOARD_CELLS> cells{};
  int tileCount = 0;

  static int idx(int row, int col) { return row * BOARD_SIZE + col; }
  const Cell& at(int row, int col) const { return cells[idx(row, col)]; }

  bool empty() const { return tileCount == 0; }

  void place(int row, int col, uint8_t kind, uint8_t token) {
    Cell& c = cells[idx(row, col)];
    if (!c.occupied()) tileCount++;
    c.kind = kind;
    c.token = token;
  }

  void remove(int row, int col) {
    Cell& c = cells[idx(row, col)];
    if (c.occupied()) tileCount--;
    c.kind = K_NONE;
    c.token = T_NONE;
  }
};

inline bool inBounds(int row, int col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

// Rack / bag as tile-kind counts.
struct TileCounts {
  std::array<uint8_t, KIND_COUNT> n{};
  int total = 0;

  void add(uint8_t kind, int c = 1) {
    n[kind] = static_cast<uint8_t>(n[kind] + c);
    total += c;
  }
  void sub(uint8_t kind, int c = 1) {
    n[kind] = static_cast<uint8_t>(n[kind] - c);
    total -= c;
  }
  int points() const {
    int s = 0;
    for (int k = 0; k < KIND_COUNT; k++) s += n[k] * TILE_POINTS[k];
    return s;
  }
};

}  // namespace amath
