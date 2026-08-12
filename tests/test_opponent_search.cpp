#include <cstdio>
#include <cmath>

#include "../src/opponent_search.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static WorkLedger opponentLedger() {
  WorkEnvelope envelope;
  envelope.maxFullGenCalls = 1;
  envelope.maxMovegenNodes = 5'000'000;
  return WorkLedger(envelope);
}

static SearchState opponentTurn() {
  SearchState state;
  state.sideToMove = 1;
  state.racks[1].add(1, 2);
  state.racks[1].add(K_EQUALS);
  state.racks[0].add(3);
  state.racks[0].add(4);
  state.bag = {5, 6, 7, 8, 9};
  return state;
}

static void testEndpointIsSymmetric() {
  SearchState state;
  state.scores[0] = 30;
  state.scores[1] = 10;
  state.racks[0].add(K_BLANK);
  state.racks[0].add(K_EQUALS);
  state.racks[1].add(19);
  state.racks[1].add(K_ADD);
  state.bag = {1, 2, 3};

  const int value = EndpointEvaluator::evaluate(state);
  std::swap(state.scores[0], state.scores[1]);
  std::swap(state.racks[0], state.racks[1]);
  CHECK(EndpointEvaluator::evaluate(state) == -value);

  state.terminal = true;
  state.scores[0] = 91;
  state.scores[1] = 87;
  CHECK(EndpointEvaluator::evaluate(state) == 4 * ENDPOINT_SCALE);
}

static void testOpponentCannotSeeHiddenAllocationOrOrder() {
  SearchState first = opponentTurn();
  SearchState second = first;

  // Keep the combined hidden multiset identical while changing which tiles
  // Aether holds and the exact future bag order.
  second.racks[0] = TileCounts{};
  second.racks[0].add(9);
  second.racks[0].add(8);
  second.bag = {3, 7, 4, 6, 5};

  WorkLedger firstLedger = opponentLedger();
  WorkLedger secondLedger = opponentLedger();
  const OpponentSearchResult a = OpponentSearch::choose(first, firstLedger, 5'000'000);
  const OpponentSearchResult b = OpponentSearch::choose(second, secondLedger, 5'000'000);

  CHECK(a.ok && b.ok);
  CHECK(a.complete && b.complete);
  CHECK(a.canonicalKey == b.canonicalKey);
  CHECK(a.policyValue == b.policyValue);
  CHECK(a.move.type == MoveType::Place);
  CHECK(firstLedger.report().fullGenCalls == 1);
  CHECK(secondLedger.report().fullGenCalls == 1);
}

static void testInformationProjectionContainsNoFutureOrder() {
  const SearchState state = opponentTurn();
  const OpponentInformationSet info = OpponentPolicyEvaluator::project(state);
  CHECK(info.opponentRack.n == state.racks[1].n);
  CHECK(info.aetherRackCount == state.racks[0].total);
  CHECK(info.publicPhysicalBagCount == static_cast<int>(state.bag.size()));
  CHECK(info.publicUnseen.total == state.racks[0].total + static_cast<int>(state.bag.size()));
}

static void testFallbackWorkIsLabeledSeparately() {
  SearchState state = opponentTurn();
  WorkLedger ledger = opponentLedger();
  const OpponentSearchResult reply = OpponentSearch::choose(
      state, ledger, 5'000'000, WorkPurpose::ReplyFallback);
  CHECK(reply.ok && reply.complete);
  CHECK(ledger.report().byPurpose[workPurposeIndex(WorkPurpose::ReplyFallback)].calls == 1);
  CHECK(ledger.report().byPurpose[workPurposeIndex(WorkPurpose::OpponentReference)].calls == 0);
}

static void testPlacementPolicyIncludesExpectedRefill() {
  SearchState state = opponentTurn();
  state.racks[1].add(K_ADD);
  const OpponentInformationSet info = OpponentPolicyEvaluator::project(state);
  Move move;
  move.type = MoveType::Place;
  move.placements = {{7, 6, 1, 1}, {7, 7, K_EQUALS, T_EQ}, {7, 8, 1, 1}};
  const MoveValidation validation = validatePlaceMove(info.board, move.placements);
  CHECK(validation.valid);
  move.score = validation.score;

  TileCounts after = info.opponentRack;
  for (const Placement& placement : move.placements) after.sub(placement.kind);
  const BoardContext context = makeContext(
      info.board, info.publicUnseen, info.publicPhysicalBagCount,
      static_cast<float>(info.scores[info.opponentSide] - info.scores[1 - info.opponentSide]));
  const int draws = std::min<int>(RACK_SIZE - after.total, info.publicPhysicalBagCount);
  const int32_t expected = static_cast<int32_t>(std::lround(
      (move.score + leaveValue(after, context) + context.freshTileValue * draws) *
      ENDPOINT_SCALE));
  CHECK(OpponentPolicyEvaluator::evaluate(info, move) == expected);
}

int main() {
  testEndpointIsSymmetric();
  testOpponentCannotSeeHiddenAllocationOrOrder();
  testInformationProjectionContainsNoFutureOrder();
  testFallbackWorkIsLabeledSeparately();
  testPlacementPolicyIncludesExpectedRefill();
  if (failures == 0) {
    std::printf("ALL OPPONENT-SEARCH TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
