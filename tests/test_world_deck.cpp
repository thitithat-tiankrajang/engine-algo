#include <cstdio>

#include "../src/world_deck.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static bool sameWorld(const HiddenWorld& a, const HiddenWorld& b) {
  return a.opponentRack.n == b.opponentRack.n &&
         a.opponentRack.total == b.opponentRack.total && a.orderedBag == b.orderedBag &&
         a.randomTapeKey == b.randomTapeKey;
}

static TileCounts inventoryOf(const HiddenWorld& world) {
  TileCounts counts = world.opponentRack;
  for (uint8_t kind : world.orderedBag) counts.add(kind);
  return counts;
}

static void testDeterminismAndPrefixStability() {
  TileCounts unseen;
  unseen.add(1, 3);
  unseen.add(2, 2);
  unseen.add(K_ADD, 2);
  unseen.add(K_EQUALS, 3);

  const WorldDeckResult two = WorldDeck::build(unseen, 4, 6, 0x12345678ULL, 2, 2);
  const WorldDeckResult four = WorldDeck::build(unseen, 4, 6, 0x12345678ULL, 2, 4);
  CHECK(two.ok);
  CHECK(four.ok);
  CHECK(two.worlds.size() == 2);
  CHECK(four.worlds.size() == 4);
  CHECK(sameWorld(two.worlds[0], four.worlds[0]));
  CHECK(sameWorld(two.worlds[1], four.worlds[1]));

  for (const HiddenWorld& world : four.worlds) {
    CHECK(world.opponentRack.total == 4);
    CHECK(world.orderedBag.size() == 6);
    const TileCounts inventory = inventoryOf(world);
    CHECK(inventory.n == unseen.n);
    CHECK(inventory.total == unseen.total);
    CHECK(world.weight == 0.25);
  }
}

static void testPositionAndEventKeysMatter() {
  TileCounts unseen;
  for (uint8_t kind = 0; kind < 10; kind++) unseen.add(kind);

  const WorldDeckResult a = WorldDeck::build(unseen, 4, 6, 11, 1, 2);
  const WorldDeckResult b = WorldDeck::build(unseen, 4, 6, 12, 1, 2);
  CHECK(a.ok && b.ok);
  CHECK(!sameWorld(a.worlds[0], b.worlds[0]));
  CHECK(WorldDeck::eventSeed(a.worlds[0], 77, 1, 0) ==
        WorldDeck::eventSeed(a.worlds[0], 77, 1, 0));
  CHECK(WorldDeck::eventSeed(a.worlds[0], 77, 1, 0) !=
        WorldDeck::eventSeed(a.worlds[0], 78, 1, 0));
}

static void testRejectsInconsistentCounts() {
  TileCounts unseen;
  unseen.add(1, 3);
  CHECK(!WorldDeck::build(unseen, 2, 2, 1, 1, 1).ok);
}

int main() {
  testDeterminismAndPrefixStability();
  testPositionAndEventKeysMatter();
  testRejectsInconsistentCounts();
  if (failures == 0) {
    std::printf("ALL WORLD-DECK TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
