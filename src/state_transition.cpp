#include "state_transition.hpp"

#include <algorithm>
#include <cstddef>

#include "tiles.hpp"

namespace amath {
namespace {

uint64_t splitmix64(uint64_t& state) {
  state += 0x9e3779b97f4a7c15ULL;
  uint64_t z = state;
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
  z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
  return z ^ (z >> 31);
}

void shuffleBag(std::vector<uint8_t>& bag, uint64_t seed) {
  for (size_t i = bag.size(); i > 1; i--) {
    const size_t j = static_cast<size_t>(splitmix64(seed) % i);
    std::swap(bag[i - 1], bag[j]);
  }
}

void refill(SearchState& state, int side, uint64_t shuffleSeed) {
  while (state.racks[side].total < RACK_SIZE && !state.bag.empty()) {
    state.racks[side].add(state.bag.back());
    state.bag.pop_back();
  }
  if (!state.pendingReturn[side].empty()) {
    state.bag.insert(state.bag.end(), state.pendingReturn[side].begin(),
                     state.pendingReturn[side].end());
    state.pendingReturn[side].clear();
    shuffleBag(state.bag, shuffleSeed);
  }
}

void finishNoScoreGame(SearchState& state) {
  const int a = state.racks[0].points();
  const int b = state.racks[1].points();
  if (a < b) state.scores[0] += b - a;
  if (b < a) state.scores[1] += a - b;
  state.terminal = true;
  state.terminalReason = TerminalReason::NoScoreStreak;
}

TransitionResult failure(const SearchState& before, TransitionError error) {
  TransitionResult result;
  result.error = error;
  result.undo.before = before;
  return result;
}

}  // namespace

TransitionResult StateTransition::apply(SearchState& state, const Move& move,
                                        uint64_t shuffleSeed) {
  const SearchState before = state;
  if (state.terminal) return failure(before, TransitionError::AlreadyTerminal);
  if (state.sideToMove < 0 || state.sideToMove > 1)
    return failure(before, TransitionError::InvalidSide);
  if (!state.pendingReturn[0].empty() || !state.pendingReturn[1].empty())
    return failure(before, TransitionError::PendingReturnAtActionStart);

  const int side = state.sideToMove;
  const int other = 1 - side;

  if (move.type == MoveType::Place) {
    if (move.placements.empty()) return failure(before, TransitionError::IllegalPlacement);
    const MoveValidation validation = validatePlaceMove(state.board, move.placements);
    if (!validation.valid) return failure(before, TransitionError::IllegalPlacement);
    if (validation.score != move.score) return failure(before, TransitionError::ScoreMismatch);

    TileCounts remaining = state.racks[side];
    for (const Placement& placement : move.placements) {
      if (placement.kind >= KIND_COUNT || remaining.n[placement.kind] == 0)
        return failure(before, TransitionError::TileNotOwned);
      remaining.sub(placement.kind);
    }

    state.racks[side] = remaining;
    for (const Placement& placement : move.placements) {
      state.board.place(placement.row, placement.col, placement.kind, placement.token);
    }
    state.scores[side] += move.score;
    state.openingPlacementCompleted = true;
    state.noScoreStreak = 0;

    const int remainingTiles = state.racks[other].total + static_cast<int>(state.bag.size());
    if (state.racks[side].total == 0 && remainingTiles <= RACK_SIZE) {
      int bagPoints = 0;
      for (uint8_t kind : state.bag) bagPoints += TILE_POINTS[kind];
      state.scores[side] += 2 * (state.racks[other].points() + bagPoints);
      state.terminal = true;
      state.terminalReason = TerminalReason::RackOut;
    } else {
      refill(state, side, shuffleSeed);
      state.sideToMove = other;
    }
  } else if (move.type == MoveType::Exchange) {
    if (move.exchangeKinds.empty()) return failure(before, TransitionError::EmptyExchange);
    const int reserve = static_cast<int>(state.bag.size()) + state.racks[other].total - RACK_SIZE;
    if (reserve < EXCHANGE_MIN_RESERVE)
      return failure(before, TransitionError::ExchangeNotAllowed);

    TileCounts remaining = state.racks[side];
    for (uint8_t kind : move.exchangeKinds) {
      if (kind >= KIND_COUNT || remaining.n[kind] == 0)
        return failure(before, TransitionError::TileNotOwned);
      remaining.sub(kind);
    }
    state.racks[side] = remaining;
    state.pendingReturn[side] = move.exchangeKinds;
    state.noScoreStreak++;
    if (state.openingPlacementCompleted && state.noScoreStreak >= NO_SCORE_STREAK_LENGTH) {
      finishNoScoreGame(state);
    } else {
      refill(state, side, shuffleSeed);
      state.sideToMove = other;
    }
  } else {
    state.noScoreStreak++;
    if (state.openingPlacementCompleted && state.noScoreStreak >= NO_SCORE_STREAK_LENGTH) {
      finishNoScoreGame(state);
    } else {
      state.sideToMove = other;
    }
  }

  TransitionResult result;
  result.ok = true;
  result.undo.before = before;
  result.undo.valid = true;
  return result;
}

void StateTransition::undo(SearchState& state, const TransitionUndo& undo) {
  if (undo.valid) state = undo.before;
}

}  // namespace amath
