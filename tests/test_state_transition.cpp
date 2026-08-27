#include <cstdio>
#include <vector>

#include "../src/state_transition.hpp"

using namespace amath;

static int failures = 0;
static constexpr uint8_t K1 = 1;
static constexpr uint8_t K8 = 8;
static constexpr uint8_t K9 = 9;
static constexpr uint8_t K10 = 10;
static constexpr uint8_t K11 = 11;
static constexpr uint8_t K12 = 12;
static constexpr uint8_t K19 = 19;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static SearchState baseState() {
  SearchState state;
  state.sideToMove = 0;
  return state;
}

static bool sameState(const SearchState& a, const SearchState& b) {
  if (a.racks[0].n != b.racks[0].n || a.racks[0].total != b.racks[0].total ||
      a.racks[1].n != b.racks[1].n || a.racks[1].total != b.racks[1].total ||
      a.bag != b.bag ||
      a.pendingReturn[0] != b.pendingReturn[0] ||
      a.pendingReturn[1] != b.pendingReturn[1] || a.scores[0] != b.scores[0] ||
      a.scores[1] != b.scores[1] || a.noScoreStreak != b.noScoreStreak ||
      a.openingPlacementCompleted != b.openingPlacementCompleted ||
      a.sideToMove != b.sideToMove || a.terminal != b.terminal ||
      a.terminalReason != b.terminalReason || a.board.tileCount != b.board.tileCount) {
    return false;
  }
  for (int r = 0; r < BOARD_SIZE; r++) {
    for (int c = 0; c < BOARD_SIZE; c++) {
      const Cell& x = a.board.at(r, c);
      const Cell& y = b.board.at(r, c);
      if (x.kind != y.kind || x.token != y.token) return false;
    }
  }
  return true;
}

static void testExchangeDrawsBeforeReturn() {
  SearchState state = baseState();
  for (uint8_t kind = 0; kind < RACK_SIZE; kind++) state.racks[0].add(kind);
  state.racks[1].add(K1, RACK_SIZE);
  state.bag = {K8, K9, K10, K11, K12};
  const SearchState before = state;

  Move exchange;
  exchange.type = MoveType::Exchange;
  exchange.exchangeKinds = {K_NUM0};
  const TransitionResult result = StateTransition::apply(state, exchange, 1234);

  CHECK(result.ok);
  CHECK(!state.terminal);
  CHECK(state.racks[0].n[K_NUM0] == 0);
  CHECK(state.racks[0].n[K12] == 1);  // back of the physical bag, never the return
  CHECK(state.racks[0].total == RACK_SIZE);
  CHECK(state.pendingReturn[0].empty());
  CHECK(state.bag.size() == 5);
  CHECK(state.noScoreStreak == 1);
  CHECK(state.sideToMove == 1);

  StateTransition::undo(state, result.undo);
  CHECK(sameState(state, before));
}

static void testOpeningPassesDoNotEndTheGame() {
  SearchState state = baseState();
  state.noScoreStreak = 5;
  state.racks[0].add(K19);
  state.racks[1].add(K1);

  Move pass;
  pass.type = MoveType::Pass;
  const TransitionResult result = StateTransition::apply(state, pass);
  CHECK(result.ok);
  CHECK(!state.terminal);
  CHECK(state.noScoreStreak == 6);
  CHECK(state.sideToMove == 1);
}

static void testNoScoreTerminalUsesPostActionRacks() {
  SearchState state = baseState();
  state.openingPlacementCompleted = true;
  state.noScoreStreak = 5;
  state.racks[0].add(K19);  // 7 points
  state.racks[1].add(K1);   // 1 point

  Move pass;
  pass.type = MoveType::Pass;
  const TransitionResult result = StateTransition::apply(state, pass);
  CHECK(result.ok);
  CHECK(state.terminal);
  CHECK(state.terminalReason == TerminalReason::NoScoreStreak);
  CHECK(state.scores[0] == 0);
  CHECK(state.scores[1] == 6);
  CHECK(state.sideToMove == 0);
}

static void testPlacementRackOutBeforeRefillAndUndo() {
  SearchState state = baseState();
  state.openingPlacementCompleted = true;
  state.board.place(7, 7, K_EQUALS, T_EQ);
  state.board.place(7, 8, K1, T_NUM0 + 1);
  state.racks[0].add(K1);
  state.racks[1].add(K19);
  const SearchState before = state;

  Move move;
  move.type = MoveType::Place;
  move.placements = {{7, 6, K1, T_NUM0 + 1}};
  const MoveValidation validation = validatePlaceMove(state.board, move.placements);
  CHECK(validation.valid);
  move.score = validation.score;

  const TransitionResult result = StateTransition::apply(state, move);
  CHECK(result.ok);
  CHECK(state.terminal);
  CHECK(state.terminalReason == TerminalReason::RackOut);
  CHECK(state.racks[0].total == 0);
  CHECK(state.scores[0] == move.score + 2 * TILE_POINTS[K19]);
  CHECK(state.sideToMove == 0);

  StateTransition::undo(state, result.undo);
  CHECK(sameState(state, before));
}

int main() {
  testExchangeDrawsBeforeReturn();
  testOpeningPassesDoNotEndTheGame();
  testNoScoreTerminalUsesPostActionRacks();
  testPlacementRackOutBeforeRefillAndUndo();

  if (failures == 0) {
    std::printf("ALL STATE-TRANSITION TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
