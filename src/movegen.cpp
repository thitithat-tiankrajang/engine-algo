#include "movegen.hpp"

#include <array>

namespace amath {

namespace {

constexpr uint32_t ALL_TOKENS = (1u << ASSIGNED_COUNT) - 1;

struct CrossInfo {
  uint32_t mask = ALL_TOKENS;  // tokens keeping the perpendicular run valid
  int fixedSum = 0;            // points of the fixed perpendicular tiles
  bool has = false;            // a perpendicular run of length >= 2 would form
};

// Per-cell premium as (tileMult, eqMult).
inline void premiumOf(int row, int col, int& tileMult, int& eqMult) {
  tileMult = 1;
  eqMult = 1;
  switch (PREMIUM[Board::idx(row, col)]) {
    case PX2: tileMult = 2; break;
    case PX3: tileMult = 3; break;
    case EX2: eqMult = 2; break;
    case EX3: eqMult = 3; break;
    default: break;
  }
}

struct Generator {
  const Board& board;
  TileCounts rack;
  std::vector<Move>& out;
  GenStats* stats;

  // Main direction of the current pass.
  int dr = 0, dc = 1;
  bool isHorizontalPass = true;

  std::array<CrossInfo, BOARD_CELLS> cross{};

  // Contact pruning: emptiesToContact[cell] = minimum number of tiles we must
  // still place (walking in the main direction, starting at that cell) before
  // the run can touch the existing structure. INF where unreachable.
  static constexpr int CONTACT_INF = 64;
  std::array<uint8_t, BOARD_CELLS> emptiesToContact{};

  // DFS state for the current line.
  std::vector<Placement> placed;
  std::vector<uint8_t> runTokens;  // full current run: prefix + placed/absorbed
  LineState lineState;
  int mainSum = 0;   // main-run tile points (with tile premiums)
  int mainMult = 1;  // main-run equation multiplier
  int crossPlacedCount = 0;  // placed cells that create a cross equation
  bool runHasExisting = false;
  bool runCoversCenter = false;

  bool connected() const { return runHasExisting || crossPlacedCount > 0; }

  Generator(const Board& b, const TileCounts& r, std::vector<Move>& o, GenStats* s)
      : board(b), rack(r), out(o), stats(s) {}

  void computeCross(int pdr, int pdc) {
    for (int row = 0; row < BOARD_SIZE; row++) {
      for (int col = 0; col < BOARD_SIZE; col++) {
        CrossInfo& info = cross[Board::idx(row, col)];
        info = CrossInfo{};
        if (board.at(row, col).occupied()) continue;
        const bool up = inBounds(row - pdr, col - pdc) && board.at(row - pdr, col - pdc).occupied();
        const bool down = inBounds(row + pdr, col + pdc) && board.at(row + pdr, col + pdc).occupied();
        if (!up && !down) continue;

        info.has = true;
        // Fixed tiles above and below the hole.
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
      }
    }
  }

  // Fill emptiesToContact for the current pass direction, scanning each line
  // from its far end backwards.
  void computeContact() {
    for (int line = 0; line < BOARD_SIZE; line++) {
      int carry = CONTACT_INF;
      for (int i = BOARD_SIZE - 1; i >= 0; i--) {
        const int row = isHorizontalPass ? line : i;
        const int col = isHorizontalPass ? i : line;
        const int idx = Board::idx(row, col);
        if (board.at(row, col).occupied()) {
          carry = 0;
        } else if (cross[idx].has) {
          carry = 1;
        } else {
          carry = carry >= CONTACT_INF ? CONTACT_INF : carry + 1;
        }
        emptiesToContact[idx] = static_cast<uint8_t>(std::min(carry, CONTACT_INF));
      }
    }
  }

  int crossScoreFor(int row, int col, uint8_t kind) const {
    const CrossInfo& info = cross[Board::idx(row, col)];
    if (!info.has) return 0;
    int tileMult, eqMult;
    premiumOf(row, col, tileMult, eqMult);
    return (info.fixedSum + TILE_POINTS[kind] * tileMult) * eqMult;
  }

  void emitIfValid() {
    const int runLen = static_cast<int>(runTokens.size());
    const int placedCount = static_cast<int>(placed.size());
    if (placedCount == 1 && !isHorizontalPass) return;  // singles: horizontal pass only

    int score = 0;
    int equations = 0;

    if (runLen >= 2) {
      if (!lineState.complete()) return;
      const LineResult lr = evaluateLine(runTokens.data(), runLen);
      if (!lr.valid) return;
      score += mainSum * mainMult;
      equations++;
    }

    bool touches = runHasExisting;
    for (const Placement& p : placed) {
      const CrossInfo& info = cross[Board::idx(p.row, p.col)];
      if (info.has) {
        touches = true;
        score += crossScoreFor(p.row, p.col, p.kind);
        equations++;
      }
    }

    if (equations == 0) return;
    if (board.empty()) {
      if (!runCoversCenter) return;
    } else if (!touches) {
      return;
    }

    Move mv;
    mv.type = MoveType::Place;
    mv.placements = placed;
    mv.score = score + (placedCount >= RACK_SIZE ? BINGO_BONUS : 0);
    out.push_back(std::move(mv));
    if (stats) stats->movesEmitted++;
  }

  // Advance through existing tiles starting at (row, col); returns count
  // absorbed, or -1 when the run becomes structurally illegal (any tokens
  // pushed before the failure are popped again, so runTokens is unchanged).
  int absorb(int row, int col, LineState& st) {
    int n = 0;
    int r = row, c = col;
    while (inBounds(r, c) && board.at(r, c).occupied()) {
      const Cell& cell = board.at(r, c);
      if (!st.advance(cell.token)) {
        undoAbsorb(n);
        return -1;
      }
      runTokens.push_back(cell.token);
      mainSum += TILE_POINTS[cell.kind];
      runHasExisting = true;
      if (r == CENTER && c == CENTER) runCoversCenter = true;
      n++;
      r += dr;
      c += dc;
    }
    return n;
  }

  void undoAbsorb(int n) {
    for (int i = 0; i < n; i++) runTokens.pop_back();
  }

  // DFS: place the next new tile at (row, col), which must be an empty cell.
  void extend(int row, int col) {
    if (stats) {
      stats->nodesVisited++;
      if (stats->nodeLimit > 0 && stats->nodesVisited > stats->nodeLimit) {
        stats->truncated = true;
        return;
      }
    }

    // Prune: the run must be able to reach the existing structure (or the
    // center star on the first move) with the tiles we still hold.
    if (board.empty()) {
      if (!runCoversCenter) {
        const int pos = isHorizontalPass ? col : row;
        if (pos > CENTER) return;
        if (CENTER - pos + 1 > rack.total) return;
      }
    } else if (!connected()) {
      if (emptiesToContact[Board::idx(row, col)] > rack.total) return;
    }

    const CrossInfo& info = cross[Board::idx(row, col)];
    int tileMult, eqMult;
    premiumOf(row, col, tileMult, eqMult);

    for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
      if (rack.n[kind] == 0) continue;
      uint32_t candidates = kindAssignMask(kind) & info.mask;
      while (candidates) {
        const uint8_t token = static_cast<uint8_t>(__builtin_ctz(candidates));
        candidates &= candidates - 1;

        const LineState savedState = lineState;
        if (!lineState.advance(token)) {
          lineState = savedState;
          continue;
        }

        // Apply.
        rack.sub(kind);
        placed.push_back({static_cast<uint8_t>(row), static_cast<uint8_t>(col), kind, token});
        runTokens.push_back(token);
        const int savedSum = mainSum;
        const int savedMult = mainMult;
        const bool savedCenter = runCoversCenter;
        const bool savedExisting = runHasExisting;
        mainSum += TILE_POINTS[kind] * tileMult;
        mainMult *= eqMult;
        if (info.has) crossPlacedCount++;
        if (row == CENTER && col == CENTER) runCoversCenter = true;

        // Absorb any existing tiles directly after this cell.
        const LineState preAbsorb = lineState;
        const int savedSum2 = mainSum;
        const bool savedExisting2 = runHasExisting;
        const bool savedCenter2 = runCoversCenter;
        const int absorbed = absorb(row + dr, col + dc, lineState);
        if (absorbed >= 0) {
          emitIfValid();
          const int nr = row + dr * (absorbed + 1);
          const int nc = col + dc * (absorbed + 1);
          if (inBounds(nr, nc) && rack.total > 0) extend(nr, nc);
          undoAbsorb(absorbed);
        }
        lineState = preAbsorb;
        mainSum = savedSum2;
        runHasExisting = savedExisting2;
        runCoversCenter = savedCenter2;

        // Undo placement.
        if (info.has) crossPlacedCount--;
        mainSum = savedSum;
        mainMult = savedMult;
        runCoversCenter = savedCenter;
        runHasExisting = savedExisting;
        runTokens.pop_back();
        placed.pop_back();
        rack.add(kind);
        lineState = savedState;
      }
    }
  }

  // Enumerate all moves whose leftmost new tile is at (row, col).
  void startAt(int row, int col) {
    if (board.at(row, col).occupied()) return;
    // The run's left boundary: existing tiles immediately left of the start.
    std::vector<const Cell*> prefix;
    int r = row - dr, c = col - dc;
    while (inBounds(r, c) && board.at(r, c).occupied()) {
      prefix.push_back(&board.at(r, c));
      r -= dr;
      c -= dc;
    }

    placed.clear();
    runTokens.clear();
    lineState = LineState{};
    mainSum = 0;
    mainMult = 1;
    crossPlacedCount = 0;
    runHasExisting = false;
    runCoversCenter = false;

    int pr = row - dr * static_cast<int>(prefix.size());
    int pc = col - dc * static_cast<int>(prefix.size());
    for (auto it = prefix.rbegin(); it != prefix.rend(); ++it) {
      const Cell* cell = *it;
      if (!lineState.advance(cell->token)) return;  // cannot happen on legal boards
      runTokens.push_back(cell->token);
      mainSum += TILE_POINTS[cell->kind];
      runHasExisting = true;
      if (pr == CENTER && pc == CENTER) runCoversCenter = true;
      pr += dr;
      pc += dc;
    }

    extend(row, col);
  }

  void runPass(bool horizontal) {
    isHorizontalPass = horizontal;
    dr = horizontal ? 0 : 1;
    dc = horizontal ? 1 : 0;
    computeCross(horizontal ? 1 : 0, horizontal ? 0 : 1);
    computeContact();

    if (board.empty()) {
      // First move: only the center line can cover the star.
      if (horizontal) {
        for (int col = 0; col < BOARD_SIZE; col++) startAt(CENTER, col);
      } else {
        for (int row = 0; row < BOARD_SIZE; row++) startAt(row, CENTER);
      }
      return;
    }
    for (int row = 0; row < BOARD_SIZE; row++) {
      for (int col = 0; col < BOARD_SIZE; col++) {
        startAt(row, col);
      }
    }
  }
};

}  // namespace

void generatePlaceMoves(const Board& board, const TileCounts& rack, std::vector<Move>& out,
                        GenStats* stats) {
  Generator gen(board, rack, out, stats);
  gen.runPass(true);
  gen.runPass(false);
}

}  // namespace amath
