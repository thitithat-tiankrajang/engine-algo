#include <cstdio>
#include <vector>

#include "../src/paired_race.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static void testNoEliminationBeforeMinimumBatch() {
  PairedRace race(4, RaceConfig{2, 1000, 2.0});
  CHECK(race.commitBatch({{0, 100000}, {1, 99000}, {2, 1000}, {3, 0}}));
  CHECK(race.activeIndices().size() == 4);
  CHECK(race.completedBatches() == 1);
}

static void testEliminatesOnlySeparatedCandidates() {
  PairedRace race(4, RaceConfig{2, 1000, 2.0});
  CHECK(race.commitBatch({{0, 100000}, {1, 99000}, {2, 1000}, {3, 0}}));
  CHECK(race.commitBatch({{0, 102000}, {1, 100000}, {2, 2000}, {3, -1000}}));
  const std::vector<size_t> active = race.activeIndices();
  CHECK(active.size() == 2);
  CHECK(active[0] == 0);
  CHECK(active[1] == 1);
  CHECK(race.leader() == 0);
  CHECK(race.observations(0) == 2);
  CHECK(race.observations(2) == 2);
}

static void testRejectsPartialOrDuplicateBatch() {
  PairedRace race(3, RaceConfig{1, 0, 1.0});
  CHECK(!race.commitBatch({{0, 1}, {1, 2}}));
  CHECK(!race.commitBatch({{0, 1}, {0, 2}, {2, 3}}));
  CHECK(race.completedBatches() == 0);
  CHECK(race.invariantFailure());
}

// The allocator asks two questions of the race: who is still worth spending a
// world on, and by how much could that spend still change the answer. Both come
// from the same statistic elimination uses, so they cannot disagree with it.
static void testReportsTheGapEliminationWouldUse() {
  PairedRace race(3, RaceConfig{2, 1000, 2.0});
  CHECK(race.commitBatch({{0, 10000}, {1, 9800}, {2, -50000}}));
  CHECK(race.commitBatch({{0, 10400}, {1, 10100}, {2, -49000}}));

  CHECK(race.leader() == 0);
  const PairedGap close = race.closestChallenger();
  CHECK(close.ok);
  CHECK(close.candidate == 1);          // 2 is eliminated, so 1 is all that is left
  CHECK(close.observations == 2);
  CHECK(close.mean < 0.0);              // the challenger trails
  CHECK(close.upper > close.bound);     // the allowance only ever loosens
  CHECK(race.wasEliminated(2));
  CHECK(!race.wasEliminated(1));
  CHECK(race.eliminationRounds() == 1);
  CHECK(race.activeCountHistory().size() == 2);
  CHECK(race.activeCountHistory()[0] == 3);
  CHECK(race.activeCountHistory()[1] == 2);
}

// A candidate that stopped receiving worlds must still be compared on the
// worlds it did share with the leader, never on a ragged tail.
static void testGapPairsOnlyTheSharedPrefix() {
  PairedRace race(2, RaceConfig{100, 0, 2.0});  // minimum so high nothing is cut
  CHECK(race.commitBatch({{0, 5000}, {1, 4000}}));
  CHECK(race.commitBatch({{0, 5000}, {1, 4000}}));
  const PairedGap gap = race.gapAgainstLeader(1);
  CHECK(gap.ok);
  CHECK(gap.observations == 2);
  CHECK(gap.mean == -1000.0);
  CHECK(gap.standardError == 0.0);
}

int main() {
  testNoEliminationBeforeMinimumBatch();
  testEliminatesOnlySeparatedCandidates();
  testRejectsPartialOrDuplicateBatch();
  testReportsTheGapEliminationWouldUse();
  testGapPairsOnlyTheSharedPrefix();
  if (failures == 0) {
    std::printf("ALL PAIRED-RACE TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
