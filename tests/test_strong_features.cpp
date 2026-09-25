// Gate the entire cheap feature extraction against real TypeScript afterstates.
#include <array>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../src/json.hpp"
#include "../src/strong/features.hpp"
#include "../src/strong/forest.hpp"

using amath::json::ValuePtr;

static void addKinds(amath::TileCounts& out, const ValuePtr& values) {
  for (const auto& item : values->arr) {
    const int kind = amath::tileKindFromString(item->asString());
    if (kind >= 0) out.add(static_cast<uint8_t>(kind));
  }
}

static bool loadForest(amath::strong::Forest& forest, const char* path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return false;
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                                   std::istreambuf_iterator<char>());
  return forest.load(bytes.data(), bytes.size()).empty();
}

template <size_t N>
static int compare(const std::array<double, N>& got, const ValuePtr& want,
                   const ValuePtr& names, const std::string& key, const char* label) {
  if (want == nullptr || want->arr.size() != N) {
    std::printf("  BAD FIXTURE %s %s: expected %zu values\n", key.c_str(), label, N);
    return 1;
  }
  int mismatches = 0;
  for (size_t i = 0; i < N; ++i) {
    const double expected = want->arr[i]->asDouble();
    if (got[i] == expected) continue;
    if (mismatches < 5) {
      const char* name = i < names->arr.size() ? names->arr[i]->s.c_str() : "?";
      std::printf("  %s %s [%zu %s] got %.17g want %.17g\n",
                  key.c_str(), label, i, name, got[i], expected);
    }
    ++mismatches;
  }
  return mismatches;
}

int main() {
  std::ifstream file("tests/strong_feature_cases.json");
  if (!file) {
    std::printf("FAIL: strong_feature_cases.json missing; regenerate with "
                "amath-bot-lab/scratchpad/authur/dump-feature-cases.ts\n");
    return 1;
  }
  std::stringstream buffer;
  buffer << file.rdbuf();
  const ValuePtr fixture = amath::json::parse(buffer.str());
  if (!fixture || !fixture->get("cases") || !fixture->get("names")) return 1;
  const ValuePtr names = fixture->get("names");
  const ValuePtr cases = fixture->get("cases");
  if (names->arr.size() != amath::strong::REPLY_FEATURE_COUNT || cases->arr.empty()) return 1;
  amath::strong::Forest selfModel, opponentModel, nextTurnModel;
  if (!loadForest(selfModel, "models/reply-self.afst") ||
      !loadForest(opponentModel, "models/reply-opponent.afst") ||
      !loadForest(nextTurnModel, "models/next-turn.afst")) {
    std::printf("FAIL: STRONG models missing or invalid\n");
    return 1;
  }

  int mismatches = 0;
  int predictionMismatches = 0;
  for (const auto& one : cases->arr) {
    const ValuePtr input = one->get("state");
    if (!input) return 1;
    amath::Board board;
    for (const auto& cell : input->get("board")->arr) {
      const int index = static_cast<int>(cell->get("index")->asInt());
      const int kind = amath::tileKindFromString(cell->get("kind")->asString());
      const int face = amath::assignedTokenFromString(cell->get("face")->asString());
      if (index < 0 || index >= amath::BOARD_CELLS || kind < 0 || face < 0) {
        std::printf("FAIL: invalid board cell in fixture\n");
        return 1;
      }
      board.place(index / amath::BOARD_SIZE, index % amath::BOARD_SIZE,
                  static_cast<uint8_t>(kind), static_cast<uint8_t>(face));
    }
    amath::TileCounts rackA, rackB, bag;
    addKinds(rackA, input->get("rackA"));
    addKinds(rackB, input->get("rackB"));
    addKinds(bag, input->get("bag"));
    const auto& scores = input->get("scores")->arr;
    const int active = input->get("activeSide")->asString() == "A" ? 0 : 1;
    const int self = input->get("selfSide")->asString() == "A" ? 0 : 1;
    const amath::strong::FeatureState state{
        board, rackA, rackB, bag,
        static_cast<int>(scores[0]->asInt()), static_cast<int>(scores[1]->asInt()),
        active, static_cast<int>(input->get("turnNumber")->asInt()),
        static_cast<int>(input->get("noScoreTailSize")->asInt())};
    const std::string key = one->get("key")->asString();
    const auto selfFeatures = amath::strong::replyFeatures(state, self);
    const auto opponentFeatures = amath::strong::replyFeatures(state, 1 - self);
    const auto nextFeatures = amath::strong::nextTurnFeatures(state);
    mismatches += compare(selfFeatures, one->get("self"),
                          names, key, "self");
    mismatches += compare(opponentFeatures, one->get("opponent"),
                          names, key, "opponent");
    mismatches += compare(nextFeatures, one->get("nextTurn"),
                          names, key, "nextTurn");
    const ValuePtr predictions = one->get("predictions");
    if (!predictions || predictions->arr.size() != 3) return 1;
    const double got[] = {
        selfModel.predict(selfFeatures.data(), selfFeatures.size()),
        opponentModel.predict(opponentFeatures.data(), opponentFeatures.size()),
        nextTurnModel.predict(nextFeatures.data(), nextFeatures.size()),
    };
    for (int i = 0; i < 3; ++i) {
      const double want = predictions->arr[i]->asDouble();
      if (got[i] == want) continue;
      if (predictionMismatches < 5)
        std::printf("  %s prediction %d got %.17g want %.17g\n",
                    key.c_str(), i, got[i], want);
      ++predictionMismatches;
    }
  }
  std::printf("GATE — C++ STRONG features vs TypeScript\n"
              "  real afterstates  %zu\n"
              "  feature values    %zu\n"
              "  mismatches        %d\n"
              "  predictions      %zu\n"
              "  pred mismatches   %d\n"
              "  VERDICT %s\n",
              cases->arr.size(), cases->arr.size() * (62 + 62 + 57),
              mismatches, cases->arr.size() * 3, predictionMismatches,
              mismatches == 0 && predictionMismatches == 0 ? "PASS" : "FAIL");
  return mismatches == 0 && predictionMismatches == 0 ? 0 : 1;
}
