// Risk aversion: the sign of λ is the bot's attitude to variance, and the score
// is what sets it.
//
// The bug this pins: λ was computed as `std::max(0.0f, ...)`, so it could never
// be negative. The engine could stop being cautious, but it could never actually
// gamble — and because the clamp sat BELOW the tunable weights, no weights
// document could restore the behaviour either. Every deficit past 41 points
// produced identical rankings, which is why a bot 195 behind played the same
// steady line it would have played level: a bingo that sealed the board's last
// ×9 lane for both sides, chosen because its mean was higher.
//
// What is tested here is the shape of λ, not one position's answer. A test that
// asserted "this position picks that move" would need a full sampling search
// (~70 s) and would drift with any retuning; the property that must hold is
// simpler and exact.
#include <cstdio>

#include "../src/eval.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

int main() {
  g_leave = LeaveWeights{};  // the shipped defaults are what these numbers describe

  // 1) Monotone in the score difference: more lead, more caution. Always.
  std::printf("monotonicity...\n");
  float previous = riskAversionLambda(-600.0f);
  for (float diff = -580.0f; diff <= 600.0f; diff += 20.0f) {
    const float lambda = riskAversionLambda(diff);
    CHECK(lambda >= previous);
    previous = lambda;
  }

  // 2) Ahead and level are unchanged by this fix. The engine was tuned in this
  //    regime and nothing here may move it.
  std::printf("lead and level behaviour preserved...\n");
  CHECK(riskAversionLambda(0.0f) > 0.17f && riskAversionLambda(0.0f) < 0.19f);   // base
  CHECK(riskAversionLambda(50.0f) > 0.39f && riskAversionLambda(50.0f) < 0.41f); // base + slope
  CHECK(riskAversionLambda(195.0f) > riskAversionLambda(0.0f));

  // 3) THE REGRESSION. Trailing badly must produce a negative λ — the ranking
  //    has to prefer spread, not merely tolerate it.
  std::printf("trailing seeks variance...\n");
  CHECK(riskAversionLambda(-195.0f) < 0.0f);
  CHECK(riskAversionLambda(-300.0f) < 0.0f);

  //    And it must be negative ENOUGH to matter. In the position this was found
  //    in, the game-preserving move had mean 42.9 / σ 83.0 against the sealing
  //    bingo's 59.2 / 36.6, so it wins exactly when λ < (42.9 − 59.2)/(83.0 −
  //    36.6) = −0.35. A λ that dips below zero but not below that would leave
  //    the bug in place while looking fixed.
  CHECK(riskAversionLambda(-195.0f) < -0.35f);

  // 4) Trailing by 41 and trailing by 300 must NOT be the same decision. This is
  //    the specific thing the old clamp destroyed.
  std::printf("deficit magnitude is not flattened...\n");
  CHECK(riskAversionLambda(-300.0f) < riskAversionLambda(-100.0f));
  CHECK(riskAversionLambda(-100.0f) < riskAversionLambda(-41.0f));

  // 5) The gamble is bounded. Past the floor the ranking would stop being about
  //    the position and start being about whichever candidate has the fattest
  //    tail, so λ saturates rather than running away.
  std::printf("gamble is bounded...\n");
  CHECK(riskAversionLambda(-100000.0f) == -g_leave.riskAversionMaxGamble);
  CHECK(riskAversionLambda(-300.0f) >= -g_leave.riskAversionMaxGamble);

  // 6) The floor travels with the request like every other weight, so a rollout
  //    can dial the aggression without reshipping the WASM module.
  std::printf("floor is tunable...\n");
  g_leave.riskAversionMaxGamble = 0.25f;
  CHECK(riskAversionLambda(-1000.0f) == -0.25f);
  g_leave = LeaveWeights{};

  if (failures == 0) {
    std::printf("ALL RISK-AVERSION TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
