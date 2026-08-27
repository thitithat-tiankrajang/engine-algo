#include <cstdio>

#include "../src/work_ledger.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static void testFullGenerationAccounting() {
  WorkEnvelope limits;
  limits.maxFullGenCalls = 2;
  limits.maxDeltaGenCalls = 1;
  limits.maxMovegenNodes = 100;

  WorkLedger ledger(limits);
  auto root = ledger.reserveGeneration(WorkPurpose::Root, 80);
  CHECK(root.has_value());
  CHECK(root->nodeLimit == 80);
  CHECK(ledger.commit(*root, 60, 14));

  auto reply = ledger.reserveGeneration(WorkPurpose::OpponentReference, 80);
  CHECK(reply.has_value());
  CHECK(reply->nodeLimit == 40);
  CHECK(ledger.commit(*reply, 40, 9));

  CHECK(!ledger.reserveGeneration(WorkPurpose::OpponentReference, 1).has_value());

  const WorkReport report = ledger.report();
  CHECK(report.fullGenCalls == 2);
  CHECK(report.deltaGenCalls == 0);
  CHECK(report.movegenNodes == 100);
  CHECK(report.movesEmitted == 23);
  CHECK(report.byPurpose[workPurposeIndex(WorkPurpose::Root)].calls == 1);
  CHECK(report.byPurpose[workPurposeIndex(WorkPurpose::Root)].nodes == 60);
  CHECK(report.byPurpose[workPurposeIndex(WorkPurpose::OpponentReference)].calls == 1);
  CHECK(report.exhausted);
  CHECK(!report.invariantFailure);
}

static void testDeltaAndOvershoot() {
  WorkEnvelope limits;
  limits.maxFullGenCalls = 1;
  limits.maxDeltaGenCalls = 1;
  limits.maxMovegenNodes = 12;

  WorkLedger ledger(limits);
  auto delta = ledger.reserveGeneration(WorkPurpose::ReplyDelta, 100);
  CHECK(delta.has_value());
  CHECK(delta->nodeLimit == 12);
  CHECK(!ledger.commit(*delta, 13, 1));
  CHECK(ledger.report().invariantFailure);
  CHECK(!ledger.reserveGeneration(WorkPurpose::Root, 1).has_value());
  CHECK(ledger.report().invariantFailure);
}

static void testWorldCheckpoints() {
  WorkEnvelope limits;
  limits.maxWorlds = 2;
  WorkLedger ledger(limits);

  CHECK(ledger.reserveWorld());
  CHECK(ledger.commitWorld());
  CHECK(ledger.reserveWorld());
  ledger.discardWorld();
  CHECK(ledger.reserveWorld());
  CHECK(ledger.commitWorld());
  CHECK(!ledger.reserveWorld());
  CHECK(ledger.report().worldsCompleted == 2);
  CHECK(ledger.report().worldsDiscarded == 1);
}

static void testNonGenerationAccounting() {
  WorkLedger ledger({});
  ledger.chargeTransition(3);
  ledger.chargeReplyRevalidation(17);
  ledger.chargeStaticEvaluation(11);
  ledger.chargeOpponentPolicyEvaluation(29);
  ledger.chargeEndpointEvaluation(5);
  const WorkReport report = ledger.report();
  CHECK(report.transitions == 3);
  CHECK(report.replyRevalidations == 17);
  CHECK(report.staticEvaluations == 11);
  CHECK(report.opponentPolicyEvaluations == 29);
  CHECK(report.endpointEvaluations == 5);
}

int main() {
  testFullGenerationAccounting();
  testDeltaAndOvershoot();
  testWorldCheckpoints();
  testNonGenerationAccounting();

  if (failures == 0) {
    std::printf("ALL WORK-LEDGER TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
