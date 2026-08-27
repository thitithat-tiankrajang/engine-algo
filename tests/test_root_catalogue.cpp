#include <algorithm>
#include <cstdio>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "../src/root_catalogue.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static std::string placementKey(const Move& move) {
  std::vector<std::string> cells;
  for (const Placement& p : move.placements) {
    cells.push_back(std::to_string(p.row) + "," + std::to_string(p.col) + "," +
                    std::to_string(p.kind) + "," + std::to_string(p.token));
  }
  std::sort(cells.begin(), cells.end());
  std::string key;
  for (const std::string& cell : cells) key += cell + ";";
  return key + "@" + std::to_string(move.score);
}

static std::string exchangeKey(const Move& move) {
  std::ostringstream out;
  for (uint8_t kind : move.exchangeKinds) out << int(kind) << ',';
  return out.str();
}

static void testOneCompleteAssignmentAwareGeneration() {
  Board board;
  TileCounts rack;
  rack.add(K_BLANK);
  rack.add(1);
  rack.add(K_EQUALS);

  WorkEnvelope envelope;
  envelope.maxFullGenCalls = 1;
  envelope.maxMovegenNodes = 10'000'000;
  WorkLedger ledger(envelope);
  const RootCatalogueResult catalogue =
      RootCatalogue::build(board, rack, 5, RACK_SIZE, ledger, 10'000'000);

  CHECK(catalogue.placementEnumerationComplete);
  CHECK(!ledger.report().invariantFailure);
  CHECK(ledger.report().fullGenCalls == 1);
  CHECK(ledger.report().byPurpose[workPurposeIndex(WorkPurpose::Root)].calls == 1);

  std::vector<Move> legacy;
  GenStats stats;
  generatePlaceMoves(board, rack, legacy, &stats);
  CHECK(!stats.truncated);

  std::set<std::string> expected;
  for (const Move& move : legacy) expected.insert(placementKey(move));
  std::set<std::string> actual;
  int passCount = 0;
  for (const RootAction& action : catalogue.actions) {
    if (action.move.type == MoveType::Place) actual.insert(placementKey(action.move));
    if (action.move.type == MoveType::Pass) passCount++;
  }
  CHECK(actual == expected);
  CHECK(catalogue.emittedAssignments == legacy.size());
  CHECK(passCount == 1);
}

static void testAllUniqueExchangeMultisets() {
  Board board;
  TileCounts rack;
  rack.add(1, 2);
  rack.add(2);

  WorkEnvelope envelope;
  envelope.maxFullGenCalls = 1;
  envelope.maxMovegenNodes = 1'000'000;
  WorkLedger ledger(envelope);
  const RootCatalogueResult catalogue =
      RootCatalogue::build(board, rack, 5, RACK_SIZE, ledger, 1'000'000);

  std::set<std::string> exchanges;
  for (const RootAction& action : catalogue.actions) {
    if (action.move.type == MoveType::Exchange) exchanges.insert(exchangeKey(action.move));
  }
  const std::set<std::string> expected = {"1,", "1,1,", "1,1,2,", "1,2,", "2,"};
  CHECK(exchanges == expected);
}

int main() {
  testOneCompleteAssignmentAwareGeneration();
  testAllUniqueExchangeMultisets();

  if (failures == 0) {
    std::printf("ALL ROOT-CATALOGUE TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
