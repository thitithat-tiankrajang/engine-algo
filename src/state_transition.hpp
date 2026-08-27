#pragma once

#include <cstdint>
#include <vector>

#include "board.hpp"
#include "rules.hpp"

namespace amath {

enum class TerminalReason : uint8_t {
  None,
  RackOut,
  NoScoreStreak,
};

enum class TransitionError : uint8_t {
  None,
  AlreadyTerminal,
  InvalidSide,
  PendingReturnAtActionStart,
  IllegalPlacement,
  ScoreMismatch,
  TileNotOwned,
  ExchangeNotAllowed,
  EmptyExchange,
};

struct SearchState {
  Board board;
  TileCounts racks[2];
  std::vector<uint8_t> bag;  // draw from back
  std::vector<uint8_t> pendingReturn[2];
  int scores[2] = {0, 0};
  int noScoreStreak = 0;
  bool openingPlacementCompleted = false;
  int sideToMove = 0;
  bool terminal = false;
  TerminalReason terminalReason = TerminalReason::None;
};

struct TransitionUndo {
  SearchState before;
  bool valid = false;
};

struct TransitionResult {
  bool ok = false;
  TransitionError error = TransitionError::None;
  TransitionUndo undo;
};

class StateTransition {
 public:
  // Applies one complete versus action: action, terminal check, refill,
  // exchange return/shuffle, then hand-off. shuffleSeed is consulted only for
  // a nonterminal exchange.
  static TransitionResult apply(SearchState& state, const Move& move,
                                uint64_t shuffleSeed = 0);

  static void undo(SearchState& state, const TransitionUndo& undo);
};

}  // namespace amath
