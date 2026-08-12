#include <cstdio>
#include <string>

#include "../src/decision_search.hpp"
#include "../src/json.hpp"
#include "../src/selfplay.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static DecisionPosition openingPosition() {
  DecisionPosition position;
  position.myRack.add(1, 2);
  position.myRack.add(K_EQUALS);
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    position.unseen.add(kind, TILE_COUNTS[kind]);
  }
  position.unseen.sub(1, 2);
  position.unseen.sub(K_EQUALS);
  position.opponentRackCount = RACK_SIZE;
  position.physicalBagCount = position.unseen.total - position.opponentRackCount;
  position.openingPlacementCompleted = false;
  return position;
}

static void checkLegal(const DecisionPosition& position, const Move& move) {
  if (move.type == MoveType::Place) {
    const MoveValidation validation = validatePlaceMove(position.board, move.placements);
    CHECK(validation.valid);
    CHECK(validation.score == move.score);
    TileCounts rack = position.myRack;
    for (const Placement& placement : move.placements) {
      CHECK(rack.n[placement.kind] > 0);
      if (rack.n[placement.kind] > 0) rack.sub(placement.kind);
    }
  }
}

static void testDeterministicReferenceDecision() {
  SearchQuery query;
  query.position = openingPosition();
  query.effort = SearchEffort::Interactive;

  const SearchDecision first =
      DecisionSearch::benchmark(query, SearchVariant::SimV2Reference);
  const SearchDecision second =
      DecisionSearch::benchmark(query, SearchVariant::SimV2Reference);
  CHECK(first.ok && second.ok);
  CHECK(first.method == SearchMethod::PairedOpponentSearch);
  CHECK(first.valueKind == ValueKind::ExpectedEquity);
  CHECK(canonicalMoveKey(first.move) == canonicalMoveKey(second.move));
  CHECK(first.value == second.value);
  CHECK(first.work.fullGenCalls == second.work.fullGenCalls);
  CHECK(first.work.fullGenCalls <= 8);
  CHECK(first.work.byPurpose[workPurposeIndex(WorkPurpose::Root)].calls == 1);
  CHECK(first.work.byPurpose[workPurposeIndex(WorkPurpose::OpponentReference)].calls ==
        first.candidates.size() * first.worldsCompleted);
  CHECK(first.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyIndexBase)].calls == 0);
  CHECK(first.work.deltaGenCalls == 0);
  CHECK(first.work.byPurpose[workPurposeIndex(WorkPurpose::SelectiveThirdPly)].calls == 0);
  CHECK(first.work.staticEvaluations == first.rootPlacementCount + first.rootExchangeCount +
                                            first.rootPassCount);
  CHECK(first.work.endpointEvaluations ==
        first.candidates.size() * first.worldsCompleted);
  checkLegal(query.position, first.move);
}

static void testDefaultPolicyRemainsTheReference() {
  SearchQuery query;
  query.position = openingPosition();
  query.effort = SearchEffort::Interactive;
  const SearchDecision decision = DecisionSearch::decide(query);
  CHECK(decision.ok);
  CHECK(decision.variant == SearchVariant::SimV2Reference);
  CHECK(decision.work.byPurpose[workPurposeIndex(WorkPurpose::OpponentReference)].calls > 0);
  CHECK(decision.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyIndexBase)].calls == 0);
}

static void testReplyIndexMatchesReference() {
  SearchQuery referenceQuery;
  referenceQuery.position = openingPosition();
  referenceQuery.effort = SearchEffort::Interactive;
  SearchQuery indexedQuery = referenceQuery;

  const SearchDecision reference =
      DecisionSearch::benchmark(referenceQuery, SearchVariant::SimV2Reference);
  const SearchDecision indexed =
      DecisionSearch::benchmark(indexedQuery, SearchVariant::ReplyIndexUniform);
  CHECK(reference.ok && indexed.ok);
  CHECK(reference.rootScopeFingerprint == indexed.rootScopeFingerprint);
  CHECK(reference.worldsCompleted == indexed.worldsCompleted);
  CHECK(reference.candidates.size() == indexed.candidates.size());
  CHECK(canonicalMoveKey(reference.move) == canonicalMoveKey(indexed.move));
  CHECK(reference.value == indexed.value);
  for (size_t i = 0; i < reference.candidates.size() && i < indexed.candidates.size(); i++) {
    CHECK(reference.candidates[i].canonicalKey == indexed.candidates[i].canonicalKey);
    CHECK(reference.candidates[i].meanValue == indexed.candidates[i].meanValue);
    CHECK(reference.candidates[i].observations == indexed.candidates[i].observations);
  }
  CHECK(indexed.work.byPurpose[workPurposeIndex(WorkPurpose::OpponentReference)].calls == 0);
  CHECK(indexed.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyIndexBase)].calls == 1);
  CHECK(indexed.work.deltaGenCalls == indexed.admittedPlacementCount);
}

static void testPairedCheckpointHasCompleteRows() {
  SearchQuery query;
  query.position = openingPosition();
  query.effort = SearchEffort::Interactive;
  const SearchDecision decision =
      DecisionSearch::benchmark(query, SearchVariant::PairedReplyIndex);
  CHECK(decision.ok);
  CHECK(decision.worldsCompleted >= 1);
  CHECK(!decision.candidates.empty());
  for (const CandidateEvidence& candidate : decision.candidates) {
    CHECK(candidate.observations == decision.worldsCompleted);
  }
  CHECK(decision.rootScope == ReferenceRootScope::Exhaustive ||
        !decision.rootScopeFingerprint.empty());
}

static DecisionPosition fromGame(const GameSim& sim, int side) {
  DecisionPosition position;
  position.board = sim.board;
  position.myRack = sim.racks[side];
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++)
    position.unseen.add(kind, TILE_COUNTS[kind]);
  for (const Cell& cell : sim.board.cells)
    if (cell.occupied()) position.unseen.sub(cell.kind);
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++)
    if (position.myRack.n[kind]) position.unseen.sub(kind, position.myRack.n[kind]);
  position.physicalBagCount = static_cast<int>(sim.bag.size());
  position.opponentRackCount = sim.racks[1 - side].total;
  position.myScore = sim.scores[side];
  position.opponentScore = sim.scores[1 - side];
  position.noScoreStreak = sim.noScoreStreak;
  position.openingPlacementCompleted = !sim.board.empty();
  return position;
}

static std::string responseFor(const SearchDecision& decision) {
  auto response = json::makeObject();
  const char* type = decision.move.type == MoveType::Place
                         ? "place"
                         : decision.move.type == MoveType::Exchange ? "exchange" : "pass";
  response->obj["type"] = json::makeString(type);
  response->obj["score"] = json::makeInt(decision.move.score);
  auto placements = json::makeArray();
  for (const Placement& placement : decision.move.placements) {
    auto cell = json::makeObject();
    cell->obj["r"] = json::makeInt(placement.row);
    cell->obj["c"] = json::makeInt(placement.col);
    cell->obj["kind"] = json::makeString(tileKindToString(placement.kind));
    cell->obj["token"] = json::makeString(assignedTokenToString(placement.token));
    placements->arr.push_back(cell);
  }
  response->obj["placements"] = placements;
  auto exchange = json::makeArray();
  for (uint8_t kind : decision.move.exchangeKinds)
    exchange->arr.push_back(json::makeString(tileKindToString(kind)));
  response->obj["exchange"] = exchange;
  return json::stringify(response);
}

static void testOpeningNoScoreStreakDoesNotEndTheGame() {
  for (uint32_t seed : {7u, 19u, 41u}) {
    GameSim sim(seed);
    int side = 0;
    for (int turn = 0; turn < NO_SCORE_STREAK_LENGTH && sim.board.empty(); turn++) {
      SearchQuery query;
      query.position = fromGame(sim, side);
      query.effort = SearchEffort::Interactive;
      const SearchDecision decision = DecisionSearch::decide(query);
      CHECK(decision.ok);
      if (!decision.ok) break;
      CHECK(sim.applyResponse(side, responseFor(decision)));
      side = 1 - side;
    }
    CHECK(!sim.finished || sim.endReason != "no_score_streak");
  }
}

int main() {
  testDeterministicReferenceDecision();
  testDefaultPolicyRemainsTheReference();
  testPairedCheckpointHasCompleteRows();
  testReplyIndexMatchesReference();
  testOpeningNoScoreStreakDoesNotEndTheGame();
  if (failures == 0) {
    std::printf("ALL DECISION-SEARCH TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
