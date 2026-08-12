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

int main() {
  testNoEliminationBeforeMinimumBatch();
  testEliminatesOnlySeparatedCandidates();
  testRejectsPartialOrDuplicateBatch();
  if (failures == 0) {
    std::printf("ALL PAIRED-RACE TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
