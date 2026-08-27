// The one property the parallel sample loop exists to protect.
//
// Super's schedule is a fixed product constant: every device runs the identical
// 160 opponent-rack samples and may differ only in how LONG that takes. Running
// those samples on several cores keeps that promise ONLY if the decision comes
// back unchanged — not "an equally good move", the same move, with the same
// per-candidate numbers behind it.
//
// The thing that would break it is arithmetic, not search. `accum[i] +=` runs
// once per sample in `double`, and double addition is not associative: threads
// racing to that accumulator would sum in completion order, and on an open board
// where the top candidates are near-tied, the winner would be decided by thread
// timing. So each sample writes its own row and the rows are reduced in sample
// order after the join. This test is what holds that line.
//
// Two fields are allowed to differ, and only two: `elapsedMs` (the point of the
// exercise) and `genCalls` (each thread keeps its own memo, so a few cached
// values get recomputed — a pure-function cache can change how often a value is
// computed, never what it is).
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/engine.hpp"
#include "../src/json.hpp"
#include "../src/selfplay.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

// ── the parallel path must actually have run ─────────────────────────────────
// Without this the whole test could pass by never threading at all. The engine
// only names a thread count in its progress detail on the parallel path, so
// seeing it is the proof the sequential branch was not silently taken.
static int lastReportedThreads = 0;

static void captureProgress(const char* json) {
  const char* at = std::strstr(json, "threads=");
  if (!at) return;
  lastReportedThreads = std::atoi(at + 8);
}

// ── response comparison ──────────────────────────────────────────────────────

static bool volatileKey(const std::string& key) {
  return key == "elapsedMs" || key == "genCalls";
}

static bool sameValue(const json::ValuePtr& a, const json::ValuePtr& b, const std::string& path,
                      std::string* where) {
  if (!a || !b) {
    if (a == b) return true;
    *where = path + " (one side missing)";
    return false;
  }
  if (a->type != b->type) {
    *where = path + " (type)";
    return false;
  }
  switch (a->type) {
    case json::Value::Type::Null:
      return true;
    case json::Value::Type::Bool:
      if (a->b != b->b) { *where = path; return false; }
      return true;
    case json::Value::Type::Int:
      if (a->i != b->i) { *where = path; return false; }
      return true;
    case json::Value::Type::Double:
      // Bit equality, deliberately. "Close enough" is exactly the failure this
      // test exists to catch: an unordered reduction drifts in the last places
      // and only shows up as a different move on a near-tie.
      if (a->d != b->d) { *where = path; return false; }
      return true;
    case json::Value::Type::String:
      if (a->s != b->s) { *where = path; return false; }
      return true;
    case json::Value::Type::Array:
      if (a->arr.size() != b->arr.size()) { *where = path + " (length)"; return false; }
      for (size_t i = 0; i < a->arr.size(); i++) {
        if (!sameValue(a->arr[i], b->arr[i], path + "[" + std::to_string(i) + "]", where))
          return false;
      }
      return true;
    case json::Value::Type::Object:
      if (a->obj.size() != b->obj.size()) { *where = path + " (key count)"; return false; }
      for (const auto& [key, av] : a->obj) {
        if (volatileKey(key)) continue;
        auto it = b->obj.find(key);
        if (it == b->obj.end()) { *where = path + "." + key + " (missing)"; return false; }
        if (!sameValue(av, it->second, path + "." + key, where)) return false;
      }
      return true;
  }
  return true;
}

// ── requests ─────────────────────────────────────────────────────────────────

// A Super request, at a small sample cap so the test stays a test. The cap does
// not weaken what is being checked: the parallel path is taken on `unlimited`,
// and it either reduces in sample order or it does not.
static std::string superRequest(const GameSim& sim, int side, uint32_t seed, int threads,
                                int sampleCap) {
  std::string j = sim.requestJson(side, "super", seed);
  j.pop_back();
  j += ",\"solver\":\"sim\",\"unlimited\":true,\"sampleCap\":" + std::to_string(sampleCap) +
       ",\"threads\":" + std::to_string(threads) + "}";
  return j;
}

static std::string staticRequest(const GameSim& sim, int side, uint32_t seed) {
  std::string j = sim.requestJson(side, "easy", seed);
  j.pop_back();
  j += ",\"solver\":\"static\"}";
  return j;
}

int main() {
  setProgressCallback(captureProgress);

  const int sampleCap = 4;
  const std::vector<int> threadCounts = {2, 4, 8};

  // Positions come from self-play at the cheap static tier, so they are boards a
  // real game passes through rather than boards chosen to be convenient.
  GameSim sim(20260828);
  int checked = 0;

  for (int turn = 0; turn < 24 && !sim.finished; turn++) {
    const int side = turn % 2;

    // Only the sampling search is parallelised. Skip the opening (nothing to
    // sample against yet) and anything close enough to a bag-empty position to
    // be taken by the exact end-game solver instead.
    const bool sampling = sim.board.tileCount > 0 && sim.bag.size() > 20;
    if (sampling && checked < 3) {
      const uint32_t seed = 4242u + static_cast<uint32_t>(turn);

      lastReportedThreads = 0;
      const std::string one = handleRequest(superRequest(sim, side, seed, 1, sampleCap));
      json::ValuePtr baseline = json::parse(one);
      CHECK(baseline != nullptr);
      if (!baseline || baseline->get("error")) {
        std::printf("FAIL engine error at turn %d: %s\n", turn, one.substr(0, 160).c_str());
        failures++;
        break;
      }
      CHECK(baseline->get("solver") && baseline->get("solver")->asString() == "sim");

      for (int threads : threadCounts) {
        lastReportedThreads = 0;
        const std::string many = handleRequest(superRequest(sim, side, seed, threads, sampleCap));
        json::ValuePtr parallel = json::parse(many);
        CHECK(parallel != nullptr);
        if (!parallel) continue;

        // Vacuity guard: the engine names its thread count only on the parallel
        // path, so a zero here means the sequential branch ran and the
        // comparison below would prove nothing.
        CHECK(lastReportedThreads > 1);

        std::string where;
        if (!sameValue(baseline, parallel, "response", &where)) {
          std::printf("FAIL turn %d, threads=%d: decision differs at %s\n", turn, threads,
                      where.c_str());
          failures++;
        }
      }
      checked++;
      std::printf("  turn %2d (%d tiles, bag %2d): identical at threads = 1, 2, 4, 8\n", turn,
                  sim.board.tileCount, static_cast<int>(sim.bag.size()));
    }

    // Advance the game cheaply; the expensive path is only for the comparison.
    if (!sim.applyResponse(side, handleRequest(staticRequest(sim, side, 1000 + turn)))) break;
  }

  setProgressCallback(nullptr);

  CHECK(checked == 3);
  if (failures == 0) {
    std::printf("compared %d positions x 3 thread counts, %d samples each\n", checked, sampleCap);
    std::printf("ALL PARALLEL-SIM TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
