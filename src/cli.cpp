// Native CLI: benchmark, engine-vs-engine self-play (full EQ-Lab rules), and
// golden-corpus generation for cross-checking against the TypeScript
// validator in EQ-Lab.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>

#include "board.hpp"
#include "engine.hpp"
#include "eval.hpp"
#include "json.hpp"
#include "movegen.hpp"
#include "rules.hpp"
#include "selfplay.hpp"

using namespace amath;

namespace {

// ── shared helpers ───────────────────────────────────────────────────────────


// The tiers the SERVICE actually ships (service/src/levels.ts), so a gauntlet
// compares what players get rather than two difficulty strings the engine
// ignores. `easy-sim` is the pre-static `easy` — the thing the static path
// replaced — kept so the two can be played head to head.
GameSim::TierSpec tierFor(const std::string& name) {
  if (name == "easy") return {"easy", "static", 200};
  if (name == "easy-sim") return {"easy", "sim", 200};
  if (name == "medium") return {"medium", "sim", 1000};
  if (name == "hard") return {"hard", "sim", 4000};
  if (name == "max") return {"max", "sim", 0};
  return {name, "", 0};  // raw difficulty string, engine defaults
}

// Per-side measurements a tier change has to be judged on. Latency is reported
// as a distribution because a mean hides exactly the tail that matters, and
// generation calls are reported because they are the only cost in a midgame
// decision worth watching (~10 ms each; every heuristic is under a microsecond).
struct SideStats {
  std::vector<double> ms;
  long long genCalls = 0;
  long long moves = 0, passes = 0, exchanges = 0;
  long long placedTiles = 0, score = 0;

  double pct(double p) const {
    if (ms.empty()) return 0;
    std::vector<double> s = ms;
    std::sort(s.begin(), s.end());
    return s[static_cast<size_t>(p * (s.size() - 1))];
  }
  double meanMs() const {
    double t = 0;
    for (double v : ms) t += v;
    return ms.empty() ? 0 : t / ms.size();
  }
};

void reportSide(const char* label, const std::string& name, const SideStats& s) {
  const long long decisions = s.moves + s.passes + s.exchanges;
  std::printf("%s (%s): mean %.1f ms | p50 %.1f | p95 %.1f | p99 %.1f | max %.1f\n", label,
              name.c_str(), s.meanMs(), s.pct(0.50), s.pct(0.95), s.pct(0.99), s.pct(1.0));
  std::printf("%s          gen calls %.2f/decision | place %lld pass %lld exchange %lld"
              " | %.2f tiles/place\n",
              label, decisions ? double(s.genCalls) / decisions : 0.0, s.moves, s.passes,
              s.exchanges, s.moves ? double(s.placedTiles) / s.moves : 0.0);
}

int runSelfplay(int games, const std::string& nameA, const std::string& nameB, uint32_t seed0) {
  const GameSim::TierSpec tierA = tierFor(nameA), tierB = tierFor(nameB);
  int winsA = 0, winsB = 0, draws = 0;
  int endReasons[3] = {0, 0, 0};  // rack_out, streak, turn-limit
  SideStats stats[2];
  long long marginSum = 0;

  for (int g = 0; g < games; g++) {
    GameSim sim(seed0 + g);
    int side = g % 2;  // alternate first player
    // Which SIDE index each tier is playing this game, so per-tier stats stay
    // attached to the tier and not to the seat.
    const int seatOfA = g % 2;
    int turns = 0;
    bool broken = false;
    while (!sim.finished && turns < 200) {
      const GameSim::TierSpec& tier = side == seatOfA ? tierA : tierB;
      SideStats& st = stats[side == seatOfA ? 0 : 1];
      const auto t0 = std::chrono::steady_clock::now();
      const std::string res =
          handleRequest(sim.requestJson(side, tier, seed0 * 1000 + g * 100 + turns));
      st.ms.push_back(
          std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
      if (auto parsed = json::parse(res)) {
        if (auto s = parsed->get("stats")) st.genCalls += s->get("genCalls")->asInt(0);
        const std::string type = parsed->get("type") ? parsed->get("type")->asString() : "";
        if (type == "place") {
          st.moves++;
          st.placedTiles += static_cast<long long>(parsed->get("placements")->arr.size());
        } else if (type == "exchange") {
          st.exchanges++;
        } else {
          st.passes++;
        }
      }
      if (!sim.applyResponse(side, res)) {
        std::printf("game %d BROKEN: %s\n", g, sim.endReason.c_str());
        broken = true;
        break;
      }
      side = 1 - side;
      turns++;
    }
    if (broken) return 1;
    if (sim.endReason == "rack_out") endReasons[0]++;
    else if (sim.endReason == "no_score_streak") endReasons[1]++;
    else endReasons[2]++;
    const int scoreA = sim.scores[seatOfA], scoreB = sim.scores[1 - seatOfA];
    stats[0].score += scoreA;
    stats[1].score += scoreB;
    marginSum += scoreA - scoreB;
    if (scoreA > scoreB) winsA++;
    else if (scoreB > scoreA) winsB++;
    else draws++;
    std::printf("game %2d: A(%s)=%d B(%s)=%d  end=%s turns=%d\n", g, nameA.c_str(), scoreA,
                nameB.c_str(), scoreB, sim.endReason.c_str(), turns);
  }

  std::printf("\nA(%s) wins %d, B(%s) wins %d, draws %d\n", nameA.c_str(), winsA, nameB.c_str(),
              winsB, draws);
  std::printf("mean score A %.1f  B %.1f  mean margin (A−B) %+.1f\n",
              double(stats[0].score) / std::max(1, games), double(stats[1].score) / std::max(1, games),
              double(marginSum) / std::max(1, games));
  std::printf("ends: rack_out=%d streak=%d turn_limit=%d\n", endReasons[0], endReasons[1],
              endReasons[2]);
  reportSide("A", nameA, stats[0]);
  reportSide("B", nameB, stats[1]);
  return 0;
}

int runBench() {
  // Build a midgame position with normal-bot self-play, then measure movegen.
  GameSim sim(42);
  int side = 0;
  for (int t = 0; t < 14 && !sim.finished; t++) {
    const std::string res = handleRequest(sim.requestJson(side, "normal", 1000 + t));
    if (!sim.applyResponse(side, res)) return 1;
    side = 1 - side;
  }
  std::printf("bench position: %d tiles on board, rack=%d\n", sim.board.tileCount,
              sim.racks[side].total);

  GenStats stats;
  std::vector<Move> moves;
  const auto t0 = std::chrono::steady_clock::now();
  const int iters = 200;
  for (int i = 0; i < iters; i++) {
    moves.clear();
    generatePlaceMoves(sim.board, sim.racks[side], moves, &stats);
  }
  const double ms =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::printf("movegen: %zu legal moves, %.2f ms/position, %.0f moves/s\n", moves.size(),
              ms / iters, moves.size() * iters / (ms / 1000.0));
  return 0;
}

int runGolden(int positions, uint32_t seed, const std::string& outPath) {
  std::ofstream out(outPath);
  if (!out) {
    std::fprintf(stderr, "cannot open %s\n", outPath.c_str());
    return 1;
  }
  std::mt19937 rng(seed);
  int emitted = 0;

  for (int gp = 0; gp < positions; gp++) {
    GameSim sim(seed + gp * 7);
    int side = 0;
    const int depth = 1 + static_cast<int>(rng() % 12);
    for (int t = 0; t < depth && !sim.finished; t++) {
      const std::string res = handleRequest(sim.requestJson(side, "normal", seed + t));
      if (!sim.applyResponse(side, res)) break;
      side = 1 - side;
    }

    std::vector<Move> moves;
    generatePlaceMoves(sim.board, sim.racks[side], moves, nullptr);
    if (moves.empty()) continue;

    auto emit = [&](const std::vector<Placement>& ps) {
      const MoveValidation v = validatePlaceMove(sim.board, ps);
      auto o = json::makeObject();
      auto cells = json::makeArray();
      for (int r = 0; r < BOARD_SIZE; r++) {
        for (int c = 0; c < BOARD_SIZE; c++) {
          const Cell& cell = sim.board.at(r, c);
          if (!cell.occupied()) continue;
          auto e = json::makeObject();
          e->obj["r"] = json::makeInt(r);
          e->obj["c"] = json::makeInt(c);
          e->obj["kind"] = json::makeString(tileKindToString(cell.kind));
          e->obj["token"] = json::makeString(assignedTokenToString(cell.token));
          cells->arr.push_back(e);
        }
      }
      o->obj["board"] = cells;
      auto parr = json::makeArray();
      for (const Placement& p : ps) {
        auto e = json::makeObject();
        e->obj["r"] = json::makeInt(p.row);
        e->obj["c"] = json::makeInt(p.col);
        e->obj["kind"] = json::makeString(tileKindToString(p.kind));
        e->obj["token"] = json::makeString(assignedTokenToString(p.token));
        parr->arr.push_back(e);
      }
      o->obj["placements"] = parr;
      o->obj["expectValid"] = json::makeBool(v.valid);
      o->obj["expectScore"] = json::makeInt(v.valid ? v.score : 0);
      out << json::stringify(o) << "\n";
      emitted++;
    };

    // A sample of generated (valid) moves...
    for (int i = 0; i < 8 && i < static_cast<int>(moves.size()); i++) {
      emit(moves[rng() % moves.size()].placements);
    }
    // ...and mutations (mostly invalid; the corpus records OUR verdict either way).
    for (int i = 0; i < 8; i++) {
      std::vector<Placement> ps = moves[rng() % moves.size()].placements;
      Placement& p = ps[rng() % ps.size()];
      switch (rng() % 4) {
        case 0: p.token = static_cast<uint8_t>(rng() % ASSIGNED_COUNT); break;
        case 1: p.row = static_cast<uint8_t>(rng() % BOARD_SIZE); break;
        case 2: p.col = static_cast<uint8_t>(rng() % BOARD_SIZE); break;
        case 3:
          p.kind = static_cast<uint8_t>(rng() % KIND_COUNT);
          p.token = static_cast<uint8_t>(rng() % ASSIGNED_COUNT);
          break;
      }
      // Only emit assignments the real game can express: EQ-Lab's UI never
      // lets a tile carry an out-of-domain assignment, so coerce the token
      // back into the tile's domain (choice tiles keep a random legal pick).
      if (!(kindAssignMask(p.kind) & (1u << p.token))) {
        if (kindNeedsAssignment(p.kind)) {
          uint32_t mask = kindAssignMask(p.kind);
          int nth = static_cast<int>(rng() % static_cast<uint32_t>(__builtin_popcount(mask)));
          for (int b = 0; b < nth; b++) mask &= mask - 1;
          p.token = static_cast<uint8_t>(__builtin_ctz(mask));
        } else {
          p.token = kindFixedToken(p.kind);
        }
      }
      emit(ps);
    }
  }
  std::printf("golden corpus: %d cases -> %s\n", emitted, outPath.c_str());
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr,
                 "usage:\n"
                 "  amath_cli bench\n"
                 "  amath_cli selfplay <games> <tierA> <tierB> [seed]\n"
                 "      tiers: easy (static) | easy-sim (pre-static easy) |\n"
                 "             medium | hard | max, or a raw difficulty string\n"
                 "  amath_cli golden <positions> <seed> <out.jsonl>\n"
                 "  amath_cli request   (JSON on stdin)\n"
                 "  amath_cli worker    (JSON on stdin, response on stdout,\n"
                 "                       NDJSON progress on stderr)\n");
    return 2;
  }
  const std::string mode = argv[1];
  if (mode == "bench") return runBench();
  if (mode == "selfplay") {
    const int games = argc > 2 ? std::atoi(argv[2]) : 4;
    const std::string dA = argc > 3 ? argv[3] : "normal";
    const std::string dB = argc > 4 ? argv[4] : "normal";
    const uint32_t seed = argc > 5 ? std::atoi(argv[5]) : 777;
    return runSelfplay(games, dA, dB, seed);
  }
  if (mode == "golden") {
    const int positions = argc > 2 ? std::atoi(argv[2]) : 40;
    const uint32_t seed = argc > 3 ? std::atoi(argv[3]) : 99;
    const std::string out = argc > 4 ? argv[4] : "build/golden.jsonl";
    return runGolden(positions, seed, out);
  }
  if (mode == "request") {
    std::ostringstream ss;
    ss << std::cin.rdbuf();
    setProgressCallback([](const char* j) { std::fprintf(stderr, "progress: %s\n", j); });
    std::printf("%s\n", handleRequest(ss.str()).c_str());
    return 0;
  }
  // One request per process, machine-readable both ways. The backend engine
  // service runs the engine like this: JSON request on stdin, progress as NDJSON
  // on stderr (flushed per line so a stream stays live), and exactly one JSON
  // response line on stdout. A process per request is what makes a wall-clock
  // timeout and a cancellation into the same, always-available operation: kill
  // it. Nothing is retained between requests, so no request can influence
  // another's search.
  if (mode == "worker") {
    std::ostringstream ss;
    ss << std::cin.rdbuf();
    setProgressCallback([](const char* j) {
      std::fprintf(stderr, "%s\n", j);
      std::fflush(stderr);
    });
    const std::string out = handleRequest(ss.str());
    std::fwrite(out.data(), 1, out.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
    return 0;
  }
  std::fprintf(stderr, "unknown mode %s\n", mode.c_str());
  return 2;
}
