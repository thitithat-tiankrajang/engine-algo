// GATE — the C++ `keepQuality` is the same function as the TypeScript one.
//
// The cases are every tile kind on its own plus 400 random racks at each size 0..8, so every
// branch of the port is exercised: the saturating terms at their caps, the numbers-past-five
// penalty on and off, and blanks paid through all three of the places that pay them.
//
// Bit-identical, not near: this number orders the shortlist, and two candidates that tie in
// TypeScript must tie here or the tie-break picks a different move.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <vector>

#include "../src/json.hpp"
#include "../src/strong/keep_quality.hpp"

int main() {
  std::ifstream file("tests/strong_keep_cases.json");
  if (!file) {
    std::printf("FAIL: tests/strong_keep_cases.json is missing\n");
    return 1;
  }
  std::stringstream buffer;
  buffer << file.rdbuf();
  const amath::json::ValuePtr cases = amath::json::parse(buffer.str());
  if (cases == nullptr || cases->arr.empty()) {
    std::printf("FAIL: no cases parsed\n");
    return 1;
  }

  int compared = 0;
  int mismatches = 0;
  double worst = 0;
  for (const auto& one : cases->arr) {
    std::vector<uint8_t> kinds;
    for (const auto& k : one->get("kinds")->arr)
      kinds.push_back(static_cast<uint8_t>(k->asDouble(0)));
    const double want = one->get("want")->asDouble(0);
    const double got = amath::strong::keepQuality(kinds);
    compared += 1;
    worst = std::max(worst, std::fabs(got - want));
    if (got != want) {
      if (mismatches < 5) {
        std::printf("  MISMATCH rack [");
        for (size_t i = 0; i < kinds.size(); ++i)
          std::printf("%s%d", i ? " " : "", static_cast<int>(kinds[i]));
        std::printf("]  got %.17g want %.17g\n", got, want);
      }
      mismatches += 1;
    }
  }
  std::printf("\nGATE — C++ keepQuality against the TypeScript keepQuality\n");
  std::printf("  racks compared       %d\n", compared);
  std::printf("  not bit-identical    %d\n", mismatches);
  std::printf("  largest difference   %.3g\n", worst);
  std::printf("  VERDICT %s\n", mismatches == 0 ? "PASS" : "FAIL");
  return mismatches == 0 ? 0 : 1;
}
