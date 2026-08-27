// Native CLI: benchmark, engine-vs-engine self-play (full EQ-Lab rules), and
// golden-corpus generation for cross-checking against the TypeScript
// validator in EQ-Lab.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <sstream>

#include "board.hpp"
#include "decision_search.hpp"
#include "deep_bench.hpp"
#include "engine.hpp"
#include "eval.hpp"
#include "json.hpp"
#include "movegen.hpp"
#include "reply_index.hpp"
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

DecisionPosition decisionPosition(const GameSim& sim, int side) {
  DecisionPosition position;
  position.board = sim.board;
  position.myRack = sim.racks[side];
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    position.unseen.add(kind, TILE_COUNTS[kind]);
  }
  for (const Cell& cell : sim.board.cells) {
    if (cell.occupied()) position.unseen.sub(cell.kind);
  }
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    if (sim.racks[side].n[kind]) position.unseen.sub(kind, sim.racks[side].n[kind]);
  }
  position.physicalBagCount = static_cast<int>(sim.bag.size());
  position.opponentRackCount = sim.racks[1 - side].total;
  position.myScore = sim.scores[side];
  position.opponentScore = sim.scores[1 - side];
  position.noScoreStreak = sim.noScoreStreak;
  position.openingPlacementCompleted = !sim.board.empty();
  return position;
}

const char* searchVariantName(SearchVariant variant) {
  switch (variant) {
    case SearchVariant::SimV2Reference: return "reference";
    case SearchVariant::ReplyIndexUniform: return "reply-index";
    case SearchVariant::PairedReplyIndex: return "paired-reply-index";
    case SearchVariant::ReplyIndexAdaptiveUniform: return "adaptive-uniform";
    case SearchVariant::ReplyIndexAdaptivePaired: return "adaptive-paired";
  }
  return "unknown";
}

bool parseSearchVariant(const std::string& text, SearchVariant& variant) {
  if (text == "reference") {
    variant = SearchVariant::SimV2Reference;
    return true;
  }
  if (text == "reply-index") {
    variant = SearchVariant::ReplyIndexUniform;
    return true;
  }
  if (text == "paired" || text == "paired-reply-index") {
    variant = SearchVariant::PairedReplyIndex;
    return true;
  }
  if (text == "adaptive-uniform") {
    variant = SearchVariant::ReplyIndexAdaptiveUniform;
    return true;
  }
  if (text == "adaptive-paired" || text == "adaptive") {
    variant = SearchVariant::ReplyIndexAdaptivePaired;
    return true;
  }
  return false;
}

const char* searchEffortName(SearchEffort effort) {
  switch (effort) {
    case SearchEffort::Instant: return "instant";
    case SearchEffort::Interactive: return "interactive";
    case SearchEffort::Strong: return "strong";
    case SearchEffort::Deep: return "deep";
  }
  return "unknown";
}

bool parseSearchEffort(const std::string& text, SearchEffort& effort) {
  if (text == "interactive") {
    effort = SearchEffort::Interactive;
    return true;
  }
  if (text == "strong") {
    effort = SearchEffort::Strong;
    return true;
  }
  if (text == "deep") {
    effort = SearchEffort::Deep;
    return true;
  }
  return false;
}

int runV2Bench(int positions, SearchVariant variant, SearchEffort effort) {
  GameSim sim(20260813);
  const GameSim::TierSpec builder{"easy", "static", 200};
  int side = 0;
  std::vector<double> latency;
  long long calls = 0;
  long long deltaCalls = 0;
  long long nodes = 0;
  int measured = 0;

  for (int turn = 0; turn < 80 && !sim.finished && measured < positions; turn++) {
    if (turn >= 2 && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty()) {
      SearchQuery query;
      query.position = decisionPosition(sim, side);
      query.effort = effort;
      const auto start = std::chrono::steady_clock::now();
      const SearchDecision decision = DecisionSearch::benchmark(query, variant);
      const double ms = std::chrono::duration<double, std::milli>(
                            std::chrono::steady_clock::now() - start)
                            .count();
      if (!decision.ok) {
        std::printf("v2 bench failed: %s\n", decision.error.c_str());
        return 1;
      }
      latency.push_back(ms);
      calls += decision.work.fullGenCalls;
      deltaCalls += decision.work.deltaGenCalls;
      nodes += static_cast<long long>(decision.work.movegenNodes);
      std::printf("v2 %-18s pos %2d: board=%3d candidates=%zu worlds=%u full=%u delta=%u "
                  "nodes=%llu latency=%.1fms completion=%d\n",
                  searchVariantName(variant), measured + 1, sim.board.tileCount,
                  decision.candidates.size(),
                  decision.worldsCompleted, decision.work.fullGenCalls,
                  decision.work.deltaGenCalls,
                  static_cast<unsigned long long>(decision.work.movegenNodes), ms,
                  static_cast<int>(decision.completion));
      measured++;
    }

    const std::string response =
        handleRequest(sim.requestJson(side, builder, 9000 + static_cast<uint32_t>(turn)));
    if (!sim.applyResponse(side, response)) {
      std::printf("v2 bench builder failed: %s\n", sim.endReason.c_str());
      return 1;
    }
    side = 1 - side;
  }

  if (latency.empty()) return 1;
  std::sort(latency.begin(), latency.end());
  auto percentile = [&](double fraction) {
    return latency[static_cast<size_t>(fraction * (latency.size() - 1))];
  };
  double total = 0;
  for (double value : latency) total += value;
  std::printf("v2 %s/%s baseline: positions=%d mean=%.1fms p50=%.1fms p95=%.1fms "
              "fullCalls=%.2f deltaCalls=%.2f nodes=%.0f\n",
              searchVariantName(variant), searchEffortName(effort), measured,
              total / latency.size(), percentile(0.50), percentile(0.95),
              static_cast<double>(calls) / measured,
              static_cast<double>(deltaCalls) / measured,
              static_cast<double>(nodes) / measured);
  return measured == positions ? 0 : 1;
}

std::map<std::string, int> placementSet(const std::vector<Move>& moves) {
  std::map<std::string, int> set;
  for (const Move& move : moves) set[canonicalMoveKey(move)] = move.score;
  return set;
}

int runReplyIndexBench(int positions) {
  GameSim sim(20260814);
  const GameSim::TierSpec builder{"easy", "static", 200};
  int side = 0;
  int measured = 0;
  uint64_t fullNodesTotal = 0, indexedNodesTotal = 0;
  double fullMsTotal = 0, indexedMsTotal = 0;

  for (int turn = 0; turn < 100 && !sim.finished && measured < positions; turn++) {
    if (turn >= 4 && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty()) {
      const DecisionPosition position = decisionPosition(sim, side);
      std::vector<Move> roots;
      GenStats rootStats;
      rootStats.nodeLimit = 24'000'000;
      GenOptions rootOptions;
      rootOptions.premiumOrder = true;
      generatePlaceMoves(position.board, position.myRack, roots, &rootStats, rootOptions);
      if (!rootStats.truncated && !roots.empty()) {
        const BoardContext context =
            makeContext(position.board, position.unseen, position.physicalBagCount,
                        static_cast<float>(position.myScore - position.opponentScore));
        std::sort(roots.begin(), roots.end(), [&](const Move& a, const Move& b) {
          const float av = staticEquity(position.board, position.myRack, a, context);
          const float bv = staticEquity(position.board, position.myRack, b, context);
          if (av != bv) return av > bv;
          return canonicalMoveKey(a) < canonicalMoveKey(b);
        });
        if (roots.size() > 7) roots.resize(7);

        const WorldDeckResult deck =
            WorldDeck::build(position.unseen, position.opponentRackCount,
                             position.physicalBagCount, 0xabc000ULL + measured, 2, 1);
        if (!deck.ok) return 1;
        const TileCounts opponentRack = deck.worlds[0].opponentRack;

        std::vector<std::map<std::string, int>> truth;
        uint64_t fullNodes = 0;
        bool complete = true;
        auto start = std::chrono::steady_clock::now();
        for (const Move& root : roots) {
          Board after = position.board;
          for (const Placement& placement : root.placements)
            after.place(placement.row, placement.col, placement.kind, placement.token);
          std::vector<Move> replies;
          GenStats stats;
          stats.nodeLimit = 24'000'000;
          generatePlaceMoves(after, opponentRack, replies, &stats);
          fullNodes += stats.nodesVisited;
          if (stats.truncated) complete = false;
          truth.push_back(placementSet(replies));
        }
        const double fullMs = std::chrono::duration<double, std::milli>(
                                  std::chrono::steady_clock::now() - start)
                                  .count();

        WorkEnvelope envelope;
        envelope.maxFullGenCalls = 1;
        envelope.maxDeltaGenCalls = static_cast<uint32_t>(roots.size());
        envelope.maxMovegenNodes = 200'000'000;
        WorkLedger ledger(envelope);
        start = std::chrono::steady_clock::now();
        const ReplyIndexResult index =
            ReplyIndex::build(position.board, opponentRack, ledger, 24'000'000);
        if (!index.complete) complete = false;
        for (size_t i = 0; i < roots.size(); i++) {
          Board after = position.board;
          for (const Placement& placement : roots[i].placements)
            after.place(placement.row, placement.col, placement.kind, placement.token);
          const ReplySet replies =
              ReplyIndex::recover(index, after, roots[i].placements, opponentRack, ledger,
                                  24'000'000);
          if (!replies.complete || placementSet(replies.placements) != truth[i]) {
            std::printf("reply-index set mismatch at position %d candidate %zu\n", measured + 1,
                        i);
            return 1;
          }
        }
        const double indexedMs = std::chrono::duration<double, std::milli>(
                                     std::chrono::steady_clock::now() - start)
                                     .count();
        if (complete) {
          const uint64_t indexedNodes = ledger.report().movegenNodes;
          const double reduction =
              fullNodes ? 100.0 * (1.0 - static_cast<double>(indexedNodes) / fullNodes) : 0;
          std::printf("reply-index pos %2d: candidates=%zu full=%llu nodes/%.1fms "
                      "indexed=%llu nodes/%.1fms reduction=%.1f%%\n",
                      measured + 1, roots.size(), static_cast<unsigned long long>(fullNodes),
                      fullMs, static_cast<unsigned long long>(indexedNodes), indexedMs, reduction);
          fullNodesTotal += fullNodes;
          indexedNodesTotal += indexedNodes;
          fullMsTotal += fullMs;
          indexedMsTotal += indexedMs;
          measured++;
        }
      }
    }

    const std::string response =
        handleRequest(sim.requestJson(side, builder, 12000 + static_cast<uint32_t>(turn)));
    if (!sim.applyResponse(side, response)) return 1;
    side = 1 - side;
  }

  if (measured == 0) return 1;
  std::printf("reply-index baseline: positions=%d fullNodes=%llu indexedNodes=%llu "
              "nodeReduction=%.1f%% full=%.1fms indexed=%.1fms latencyReduction=%.1f%%\n",
              measured, static_cast<unsigned long long>(fullNodesTotal),
              static_cast<unsigned long long>(indexedNodesTotal),
              100.0 * (1.0 - static_cast<double>(indexedNodesTotal) / fullNodesTotal),
              fullMsTotal, indexedMsTotal, 100.0 * (1.0 - indexedMsTotal / fullMsTotal));
  return measured == positions ? 0 : 1;
}

// ── position corpus for latency benchmarking ─────────────────────────────────
//
// Dumps the engine REQUEST the bot would receive at each turn of a self-played
// game, one JSON object per line, tagged with the phase signals a latency
// number has to be read against (turn index, tiles on the board, bag size).
//
// The dump deliberately carries NO tier fields — no `solver`, no `budgetMs`,
// no `unlimited`. A corpus that pinned a tier would only ever measure that
// tier, and the whole point of this file is to run the SAME positions through
// `super` natively and `super` in WASM and compare. The harness adds the tier.
//
// The games themselves are played at the cheap static tier: how the corpus was
// reached does not change how long a `super` search on it takes, and playing
// 25 turns at `super` to produce 25 positions would cost an hour a game.
int runPositions(int games, uint32_t seed0, const std::string& outPath) {
  std::ofstream out(outPath);
  if (!out) {
    std::fprintf(stderr, "cannot open %s\n", outPath.c_str());
    return 1;
  }
  const GameSim::TierSpec fast = tierFor("easy");  // static solver, one generation
  int emitted = 0;
  for (int g = 0; g < games; g++) {
    GameSim sim(seed0 + static_cast<uint32_t>(g) * 7919u);
    int side = 0;
    for (int turn = 0; turn < 60 && !sim.finished; turn++) {
      int boardTiles = 0;
      for (int r = 0; r < BOARD_SIZE; r++) {
        for (int c = 0; c < BOARD_SIZE; c++) {
          if (sim.board.at(r, c).occupied()) boardTiles++;
        }
      }
      const int unplayed = sim.racks[0].total + sim.racks[1].total +
                           static_cast<int>(sim.bag.size());
      out << "{\"game\":" << g << ",\"turn\":" << turn << ",\"side\":" << side
          << ",\"boardTiles\":" << boardTiles
          << ",\"bagCount\":" << sim.bag.size()
          << ",\"unplayed\":" << unplayed
          << ",\"request\":"
          << sim.requestJson(side, std::string("super"), seed0 + static_cast<uint32_t>(turn))
          << "}\n";
      emitted++;
      const std::string res = handleRequest(sim.requestJson(side, fast, seed0 + turn));
      if (!sim.applyResponse(side, res)) break;
      side = 1 - side;
    }
  }
  std::fprintf(stderr, "wrote %d positions to %s\n", emitted, outPath.c_str());
  return emitted > 0 ? 0 : 1;
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
                 "  amath_cli v2-bench [positions] [reference|reply-index|paired|"
                 "adaptive-uniform|adaptive-paired] [interactive|strong|deep]\n"
                 "  amath_cli reply-index-bench [positions]\n"
                 "  amath_cli deep-bench [positions] [label-substring]\n"
                 "  amath_cli deep-credit-curve [positions]\n"
                 "  amath_cli g6 [positions]      (admission recall/regret)\n"
                 "  amath_cli g7 [positions]      (uniform vs paired at equal credits)\n"
                 "  amath_cli selfplay <games> <tierA> <tierB> [seed]\n"
                 "      tiers: easy (static) | easy-sim (pre-static easy) |\n"
                 "             medium | hard | max, or a raw difficulty string\n"
                 "  amath_cli golden <positions> <seed> <out.jsonl>\n"
                 "  amath_cli positions <games> <seed> <out.jsonl>\n"
                 "      engine requests from self-play, for latency benchmarking\n"
                 "  amath_cli request   (JSON on stdin)\n"
                 "  amath_cli worker    (JSON on stdin, response on stdout,\n"
                 "                       NDJSON progress on stderr)\n");
    return 2;
  }
  const std::string mode = argv[1];
  if (mode == "bench") return runBench();
  if (mode == "v2-bench") {
    SearchVariant variant = SearchVariant::SimV2Reference;
    if (argc > 3 && !parseSearchVariant(argv[3], variant)) {
      std::fprintf(stderr, "unknown v2 variant %s\n", argv[3]);
      return 2;
    }
    SearchEffort effort = SearchEffort::Interactive;
    if (argc > 4 && !parseSearchEffort(argv[4], effort)) {
      std::fprintf(stderr, "unknown v2 effort %s\n", argv[4]);
      return 2;
    }
    return runV2Bench(argc > 2 ? std::atoi(argv[2]) : 8, variant, effort);
  }
  if (mode == "reply-index-bench")
    return runReplyIndexBench(argc > 2 ? std::atoi(argv[2]) : 8);
  if (mode == "deep-bench")
    return runDeepPolicyBench(argc > 2 ? std::atoi(argv[2]) : 16, argc > 3 ? argv[3] : "");
  if (mode == "deep-credit-curve") return runDeepCreditCurve(argc > 2 ? std::atoi(argv[2]) : 16);
  if (mode == "g6") return runGate6(argc > 2 ? std::atoi(argv[2]) : 16);
  if (mode == "g7") return runGate7(argc > 2 ? std::atoi(argv[2]) : 16);
  if (mode == "selfplay") {
    const int games = argc > 2 ? std::atoi(argv[2]) : 4;
    const std::string dA = argc > 3 ? argv[3] : "normal";
    const std::string dB = argc > 4 ? argv[4] : "normal";
    const uint32_t seed = argc > 5 ? std::atoi(argv[5]) : 777;
    return runSelfplay(games, dA, dB, seed);
  }
  if (mode == "positions") {
    const int games = argc > 2 ? std::atoi(argv[2]) : 8;
    const uint32_t seed = argc > 3 ? static_cast<uint32_t>(std::atoi(argv[3])) : 20260827;
    const std::string out = argc > 4 ? argv[4] : "build/positions.jsonl";
    return runPositions(games, seed, out);
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
