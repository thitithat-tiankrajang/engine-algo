#include "rules.hpp"

#include <algorithm>
#include <set>

namespace amath {

namespace {

struct PendingLookup {
  const std::vector<Placement>* placements;
  const Placement* at(int row, int col) const {
    for (const Placement& p : *placements) {
      if (p.row == row && p.col == col) return &p;
    }
    return nullptr;
  }
};

struct RunCell {
  int row, col;
  uint8_t kind;
  uint8_t token;
  bool isNew;
};

// Collect the maximal run through (row, col) in direction (dr, dc), reading
// from the board plus pending placements.
std::vector<RunCell> collectRun(const Board& board, const PendingLookup& pending,
                                int row, int col, int dr, int dc) {
  auto tileAt = [&](int r, int c, RunCell& out) -> bool {
    if (!inBounds(r, c)) return false;
    const Placement* p = pending.at(r, c);
    if (p) {
      out = {r, c, p->kind, p->token, true};
      return true;
    }
    const Cell& cell = board.at(r, c);
    if (!cell.occupied()) return false;
    out = {r, c, cell.kind, cell.token, false};
    return true;
  };

  int sr = row, sc = col;
  RunCell tmp;
  while (tileAt(sr - dr, sc - dc, tmp)) {
    sr -= dr;
    sc -= dc;
  }
  std::vector<RunCell> run;
  int r = sr, c = sc;
  while (tileAt(r, c, tmp)) {
    run.push_back(tmp);
    r += dr;
    c += dc;
  }
  return run;
}

int scoreRun(const std::vector<RunCell>& run) {
  int sum = 0;
  int mult = 1;
  for (const RunCell& cell : run) {
    const int point = TILE_POINTS[cell.kind];
    if (!cell.isNew) {
      sum += point;
      continue;
    }
    switch (PREMIUM[Board::idx(cell.row, cell.col)]) {
      case PX2: sum += point * 2; break;
      case PX3: sum += point * 3; break;  // px3star included
      case EX2: sum += point; mult *= 2; break;
      case EX3: sum += point; mult *= 3; break;
      default: sum += point; break;
    }
  }
  return sum * mult;
}

}  // namespace

MoveValidation validatePlaceMove(const Board& board, const std::vector<Placement>& placements) {
  MoveValidation out;
  if (placements.empty()) {
    out.error = "Place at least one tile.";
    return out;
  }

  PendingLookup pending{&placements};

  // Bounds / overlap / duplicates / assignments.
  for (size_t i = 0; i < placements.size(); i++) {
    const Placement& p = placements[i];
    if (!inBounds(p.row, p.col)) {
      out.error = "A tile is outside the board.";
      return out;
    }
    if (board.at(p.row, p.col).occupied()) {
      out.error = "A new tile overlaps an occupied cell.";
      return out;
    }
    for (size_t j = 0; j < i; j++) {
      if (placements[j].row == p.row && placements[j].col == p.col) {
        out.error = "More than one new tile is in the same cell.";
        return out;
      }
    }
    if (p.token >= ASSIGNED_COUNT || !(kindAssignMask(p.kind) & (1u << p.token))) {
      out.error = "Invalid tile assignment.";
      return out;
    }
  }

  // Single line.
  bool sameRow = true, sameCol = true;
  for (const Placement& p : placements) {
    if (p.row != placements[0].row) sameRow = false;
    if (p.col != placements[0].col) sameCol = false;
  }
  if (!sameRow && !sameCol) {
    out.error = "Tiles placed in one turn must be in a single line.";
    return out;
  }

  // Continuity along the placement axis.
  {
    const bool axisRow = sameRow;
    const int fixed = axisRow ? placements[0].row : placements[0].col;
    int lo = 1 << 20, hi = -1;
    for (const Placement& p : placements) {
      const int v = axisRow ? p.col : p.row;
      lo = std::min(lo, v);
      hi = std::max(hi, v);
    }
    for (int v = lo; v <= hi; v++) {
      const int r = axisRow ? fixed : v;
      const int c = axisRow ? v : fixed;
      if (!board.at(r, c).occupied() && !pending.at(r, c)) {
        out.error = "Placed tiles must be continuous with no gaps.";
        return out;
      }
    }
  }

  // Connectivity: touch existing tiles, or cover the center star on move 1.
  if (!board.empty()) {
    bool touches = false;
    static const int D[4][2] = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
    for (const Placement& p : placements) {
      for (auto& d : D) {
        const int r = p.row + d[0], c = p.col + d[1];
        if (inBounds(r, c) && board.at(r, c).occupied()) {
          touches = true;
          break;
        }
      }
      if (touches) break;
    }
    if (!touches) {
      out.error = "New tiles must connect to existing board tiles.";
      return out;
    }
  } else {
    bool coversCenter = false;
    for (const Placement& p : placements) {
      if (p.row == CENTER && p.col == CENTER) coversCenter = true;
    }
    if (!coversCenter) {
      out.error = "The first equation must cover the center star.";
      return out;
    }
  }

  // Detect and validate every run of length >= 2 through a placement.
  std::set<std::vector<int>> seen;
  int totalScore = 0;
  int equationCount = 0;
  for (const Placement& p : placements) {
    for (int dir = 0; dir < 2; dir++) {
      const int dr = dir == 0 ? 0 : 1;
      const int dc = dir == 0 ? 1 : 0;
      std::vector<RunCell> run = collectRun(board, pending, p.row, p.col, dr, dc);
      if (run.size() < 2) continue;
      std::vector<int> key;
      key.push_back(dir);
      for (const RunCell& cell : run) key.push_back(Board::idx(cell.row, cell.col));
      if (!seen.insert(key).second) continue;

      std::vector<uint8_t> tokens;
      tokens.reserve(run.size());
      for (const RunCell& cell : run) tokens.push_back(cell.token);
      const LineResult lr = validateLine(tokens.data(), static_cast<int>(tokens.size()));
      if (!lr.valid) {
        out.error = "Invalid equation in move.";
        return out;
      }
      totalScore += scoreRun(run);
      equationCount++;
    }
  }

  if (equationCount == 0) {
    out.error = "The move must create at least one equation.";
    return out;
  }

  out.valid = true;
  out.equationCount = equationCount;
  out.bingo = placements.size() >= RACK_SIZE ? BINGO_BONUS : 0;
  out.score = totalScore + out.bingo;
  return out;
}

}  // namespace amath
