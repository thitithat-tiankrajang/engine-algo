// Deterministic shared hidden worlds must match the TypeScript sampler exactly.
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../src/json.hpp"
#include "../src/strong/worlds.hpp"

static std::vector<std::string> strings(const amath::json::ValuePtr& values) {
  std::vector<std::string> out;
  for (const auto& item : values->arr) out.push_back(item->asString());
  return out;
}

int main() {
  std::ifstream file("tests/strong_world_cases.json");
  if (!file) return 1;
  std::stringstream buffer;
  buffer << file.rdbuf();
  const auto cases = amath::json::parse(buffer.str());
  if (!cases || cases->arr.empty()) return 1;
  int mismatches = 0, compared = 0;
  for (const auto& one : cases->arr) {
    const auto worlds = amath::strong::sampleWorlds(
        strings(one->get("opponentRack")), strings(one->get("pendingReturn")),
        strings(one->get("bag")), strings(one->get("known")),
        static_cast<int>(one->get("count")->asInt()), one->get("seed")->asDouble());
    const auto& expected = one->get("worlds")->arr;
    if (worlds.size() != expected.size()) return 1;
    for (size_t i = 0; i < worlds.size(); ++i) {
      const bool same =
          worlds[i].opponentRack == strings(expected[i]->get("opponentRack")) &&
          worlds[i].pendingReturn == strings(expected[i]->get("pendingReturn")) &&
          worlds[i].bag == strings(expected[i]->get("bag"));
      ++compared;
      if (same) continue;
      if (mismatches < 5)
        std::printf("  mismatch %s world %zu\n", one->get("key")->asString().c_str(), i);
      ++mismatches;
    }
  }
  std::printf("GATE — C++ STRONG worlds vs TypeScript: %d worlds, %d mismatches, %s\n",
              compared, mismatches, mismatches ? "FAIL" : "PASS");
  return mismatches ? 1 : 0;
}
