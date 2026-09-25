// STRONG's cheap state summaries, in the exact order used by the TypeScript forests.
#pragma once

#include <array>
#include <algorithm>

#include "../board.hpp"

namespace amath::strong {

inline constexpr size_t BASE_FEATURE_COUNT = 57;
inline constexpr size_t REPLY_FEATURE_COUNT = 62;

// A read-only view of the information the TS EnvState feature functions consume.
// The bag is a multiset here: these features never inspect draw order.
struct FeatureState {
  const Board& board;
  const TileCounts& rackA;
  const TileCounts& rackB;
  const TileCounts& bag;
  int scoreA;
  int scoreB;
  int activeSide;  // 0 = A, 1 = B
  int turnNumber;
  int noScoreTailSize;
};

inline const TileCounts& rackFor(const FeatureState& state, int side) {
  return side == 0 ? state.rackA : state.rackB;
}

inline std::array<double, BASE_FEATURE_COUNT> baseFeatures(const FeatureState& state, int side) {
  const TileCounts& rack = rackFor(state, side);
  const TileCounts& opp = rackFor(state, 1 - side);
  const Board& board = state.board;

  int rackPoints = 0, rackMax = 0, distinctKinds = 0;
  int nDigit = 0, nHeavy = 0, nZero = 0, nSmall = 0, nBig = 0;
  int nPlus = 0, nMinus = 0, nTimes = 0, nDivide = 0;
  int nEquals = 0, nBlank = 0, nChoice = 0;
  int digitPoints = 0, heavyPoints = 0;
  for (int kind = 0; kind < KIND_COUNT; ++kind) {
    const int count = rack.n[kind];
    if (!count) continue;
    const int points = TILE_POINTS[kind];
    rackPoints += count * points;
    rackMax = std::max(rackMax, points);
    ++distinctKinds;
    if (kind <= 9) {
      nDigit += count;
      digitPoints += count * points;
      if (kind == 0) nZero += count;
      else if (kind <= 4) nSmall += count;
      else nBig += count;
    } else if (kind <= K_NUM20) {
      nHeavy += count;
      heavyPoints += count * points;
    } else if (kind == K_ADD) nPlus += count;
    else if (kind == K_SUB) nMinus += count;
    else if (kind == K_MUL) nTimes += count;
    else if (kind == K_DIV) nDivide += count;
    else if (kind == K_EQUALS) nEquals += count;
    else if (kind == K_BLANK) nBlank += count;
    else nChoice += count;
  }
  const int nOps = nPlus + nMinus + nTimes + nDivide;
  const int nOperatorCapable = nOps + nChoice + nBlank;
  const int equalsCapable = nEquals + nBlank;

  int boardTiles = 0, boardEquals = 0, boardDigits = 0, boardOps = 0;
  for (const Cell& cell : board.cells) {
    if (!cell.occupied()) continue;
    ++boardTiles;
    if (cell.token == T_EQ) ++boardEquals;
    else if (cell.token >= T_ADD && cell.token <= T_DIV) ++boardOps;
    else ++boardDigits;
  }

  int anchors = 0, openPx2 = 0, openPx3 = 0, openPx3star = 0, openEx2 = 0, openEx3 = 0;
  int anchorPx = 0, anchorEx = 0, anchorPremiumPoints = 0, anchorFreeSum = 0;
  std::array<uint8_t, BOARD_SIZE> anchorRow{}, anchorCol{};
  for (int c = 0; c < BOARD_CELLS; ++c) {
    if (board.cells[c].occupied()) continue;
    const bool star = c == Board::idx(CENTER, CENTER);
    const uint8_t slot = PREMIUM[c];
    if (slot == PX2) ++openPx2;
    else if (slot == PX3 && star) ++openPx3star;
    else if (slot == PX3) ++openPx3;
    else if (slot == EX2) ++openEx2;
    else if (slot == EX3) ++openEx3;
    const int r = c / BOARD_SIZE, q = c % BOARD_SIZE;
    const bool touching =
        (r > 0 && board.cells[c - BOARD_SIZE].occupied()) ||
        (r < BOARD_SIZE - 1 && board.cells[c + BOARD_SIZE].occupied()) ||
        (q > 0 && board.cells[c - 1].occupied()) ||
        (q < BOARD_SIZE - 1 && board.cells[c + 1].occupied());
    if (!touching) continue;
    ++anchors;
    anchorRow[r] = anchorCol[q] = 1;
    if (slot == PX2) { ++anchorPx; anchorPremiumPoints += 2; }
    else if (slot == PX3) { ++anchorPx; anchorPremiumPoints += 3; }
    else if (slot == EX2) { ++anchorEx; anchorPremiumPoints += 2; }
    else if (slot == EX3) { ++anchorEx; anchorPremiumPoints += 3; }
    const int dr[] = {0, 0, 1, -1};
    const int dq[] = {1, -1, 0, 0};
    for (int d = 0; d < 4; ++d) {
      int rr = r + dr[d], qq = q + dq[d], run = 0;
      while (inBounds(rr, qq) && !board.at(rr, qq).occupied() && run < 8) {
        ++run;
        rr += dr[d];
        qq += dq[d];
      }
      anchorFreeSum += run;
    }
  }

  int maxOpenSpan = 0;
  for (int axis = 0; axis < 2; ++axis) {
    for (int i = 0; i < BOARD_SIZE; ++i) {
      int run = 0;
      bool touched = false;
      for (int k = 0; k < BOARD_SIZE; ++k) {
        const int r = axis == 0 ? i : k;
        const int q = axis == 0 ? k : i;
        const int c = Board::idx(r, q);
        if (!board.cells[c].occupied()) {
          ++run;
          if ((r > 0 && board.cells[c - BOARD_SIZE].occupied()) ||
              (r < BOARD_SIZE - 1 && board.cells[c + BOARD_SIZE].occupied()) ||
              (q > 0 && board.cells[c - 1].occupied()) ||
              (q < BOARD_SIZE - 1 && board.cells[c + 1].occupied())) touched = true;
        } else {
          if (touched) maxOpenSpan = std::max(maxOpenSpan, run);
          run = 0;
          touched = true;
        }
      }
      if (touched) maxOpenSpan = std::max(maxOpenSpan, run);
    }
  }
  int anchorRows = 0, anchorCols = 0;
  for (int i = 0; i < BOARD_SIZE; ++i) {
    anchorRows += anchorRow[i];
    anchorCols += anchorCol[i];
  }

  int unseenEquals = 0, unseenBlank = 0, unseenOps = 0, unseenHeavy = 0;
  for (int kind = 0; kind < KIND_COUNT; ++kind) {
    const int count = state.bag.n[kind] + opp.n[kind];
    if (kind == K_EQUALS) unseenEquals += count;
    else if (kind == K_BLANK) unseenBlank += count;
    else if ((kind >= K_ADD && kind <= K_DIV) || kind == K_PM || kind == K_MD)
      unseenOps += count;
    else if (kind >= 10 && kind <= K_NUM20) unseenHeavy += count;
  }
  const int scoreSelf = side == 0 ? state.scoreA : state.scoreB;
  const int scoreOpp = side == 0 ? state.scoreB : state.scoreA;
  return {
      double(rack.total), double(rackPoints), double(rackMax),
      rack.total ? double(rackPoints) / rack.total : 0,
      double(nDigit), double(nHeavy), double(nZero), double(nSmall), double(nBig),
      double(nPlus), double(nMinus), double(nTimes), double(nDivide), double(nOps),
      double(nEquals), double(nBlank), double(nChoice), double(nOperatorCapable),
      double(equalsCapable), double(distinctKinds), double(digitPoints), double(heavyPoints),
      double(boardTiles), double(BOARD_CELLS - boardTiles), double(anchors),
      double(boardEquals), double(boardDigits), double(boardOps), double(openPx2),
      double(openPx3), double(openPx3star), double(openEx2), double(openEx3),
      double(anchorPx), double(anchorEx), double(anchorPremiumPoints), double(maxOpenSpan),
      anchors ? double(anchorFreeSum) / anchors : 0, double(anchorRows), double(anchorCols),
      double(state.bag.total), double(opp.total), double(state.turnNumber),
      double(scoreSelf), double(scoreOpp), double(scoreSelf - scoreOpp),
      double(state.noScoreTailSize), double(unseenEquals), double(unseenBlank),
      double(unseenOps), double(unseenHeavy), double(state.bag.total + opp.total),
      double(rackPoints * anchorEx), double(rackPoints * anchorPx),
      double(equalsCapable * anchors), double(nBlank * anchors),
      double(nOperatorCapable * nDigit),
  };
}

inline std::array<double, REPLY_FEATURE_COUNT> replyFeatures(const FeatureState& state, int side) {
  const auto base = baseFeatures(state, side);
  std::array<double, REPLY_FEATURE_COUNT> result{};
  std::copy(base.begin(), base.end(), result.begin());
  const int mine = rackFor(state, side).total;
  const int theirs = rackFor(state, 1 - side).total;
  result[57] = state.activeSide == side ? 1 : 0;
  result[58] = mine;
  result[59] = theirs;
  result[60] = mine - theirs;
  result[61] = std::min(mine, state.bag.total + mine);
  return result;
}

inline std::array<double, BASE_FEATURE_COUNT> nextTurnFeatures(const FeatureState& state) {
  return baseFeatures(state, state.activeSide);
}

}  // namespace amath::strong
