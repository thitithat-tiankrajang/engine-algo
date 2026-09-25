// GATE — the C++ forest walk reproduces the TypeScript one, exactly.
//
// The cases come from real harvested positions: `scratchpad/authur/dump-forest-cases.ts` in
// amath-bot-lab writes the feature vector it handed each model and the number that model gave
// back. This reads the same vectors and demands the same numbers.
//
// EXACTLY, not nearly. A forest is a sum of leaves reached by comparisons, so two walks either
// take the same branches or they do not; there is no rounding to forgive. A tolerance here
// would hide precisely the bug this gate exists to catch — a threshold narrowed to float, or a
// comparison written `<` where the original wrote `<=`.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../src/json.hpp"
#include "../src/strong/forest.hpp"

using namespace amath::strong;

static std::vector<uint8_t> readAll(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)),
                              std::istreambuf_iterator<char>());
}

static std::vector<double> numbers(const amath::json::ValuePtr& array) {
  std::vector<double> out;
  if (array == nullptr) return out;
  for (const auto& item : array->arr) out.push_back(item->asDouble(0));
  return out;
}

int main() {
  struct Model {
    const char* name;
    const char* file;
    const char* inKey;
    const char* outKey;
    Forest forest;
  };
  Model models[] = {
      {"reply-self", "models/reply-self.afst", "selfIn", "selfOut", {}},
      {"reply-opponent", "models/reply-opponent.afst", "oppIn", "oppOut", {}},
      {"next-turn", "models/next-turn.afst", "afterIn", "afterOut", {}},
  };

  for (auto& m : models) {
    const std::vector<uint8_t> bytes = readAll(m.file);
    if (bytes.empty()) {
      std::printf("FAIL %s: could not read %s\n", m.name, m.file);
      return 1;
    }
    const std::string error = m.forest.load(bytes.data(), bytes.size());
    if (!error.empty()) {
      std::printf("FAIL %s: %s\n", m.name, error.c_str());
      return 1;
    }
    std::printf("  %-15s %u trees  %llu nodes  %zu features  baseline %.15g\n", m.name,
                m.forest.trees(), static_cast<unsigned long long>(m.forest.nodes()),
                m.forest.featureCount(), m.forest.baseline());
  }

  std::ifstream casesFile("tests/strong_forest_cases.json");
  if (!casesFile) {
    std::printf("FAIL: tests/strong_forest_cases.json is missing — regenerate it from "
                "amath-bot-lab with scratchpad/authur/dump-forest-cases.ts\n");
    return 1;
  }
  std::stringstream buffer;
  buffer << casesFile.rdbuf();
  const amath::json::ValuePtr cases = amath::json::parse(buffer.str());
  if (cases == nullptr || cases->arr.empty()) {
    std::printf("FAIL: no cases parsed\n");
    return 1;
  }

  int compared = 0;
  int mismatches = 0;
  double worst = 0;
  for (const auto& one : cases->arr) {
    for (auto& m : models) {
      const std::vector<double> in = numbers(one->get(m.inKey));
      const amath::json::ValuePtr expected = one->get(m.outKey);
      if (in.empty() || expected == nullptr) continue;
      const double got = m.forest.predict(in);
      const double want = expected->asDouble(0);
      compared += 1;
      const double diff = std::fabs(got - want);
      if (diff > worst) worst = diff;
      if (got != want) {
        if (mismatches < 5)
          std::printf("  MISMATCH %-15s got %.17g want %.17g (diff %.3g)\n", m.name, got, want,
                      diff);
        mismatches += 1;
      }
    }
  }

  std::printf("\nGATE — C++ forest against the TypeScript forest\n");
  std::printf("  predictions compared   %d\n", compared);
  std::printf("  not bit-identical      %d\n", mismatches);
  std::printf("  largest difference     %.3g\n", worst);
  std::printf("  VERDICT %s\n", mismatches == 0 ? "PASS" : "FAIL");
  return mismatches == 0 ? 0 : 1;
}
