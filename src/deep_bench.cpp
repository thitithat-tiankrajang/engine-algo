// Deep/Max compute-allocation experiments.
//
// Everything here answers one question: for a fixed amount of deterministic
// work, which allocation of that work picks the best move most often? So every
// measurement is paired — the same frozen positions, the same shared world
// schedule, the same admitted candidates — and every policy is scored against
// the same wider reference run rather than against wall clock.
#include "deep_bench.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "decision_search.hpp"
#include "engine.hpp"
#include "json.hpp"
#include "selfplay.hpp"

namespace amath {
namespace {

using Clock = std::chrono::steady_clock;

// ── frozen corpus ────────────────────────────────────────────────────────────
//
// Positions are built by deterministic static self-play, so the corpus is a
// property of the seeds below and not of any sampling policy under test. The
// legacy sampler is never used to build them: a corpus chosen by one of the
// competitors would be a rigged comparison.
constexpr uint32_t CORPUS_SEEDS[] = {20260813, 20260901, 20261007, 20261115};

struct CorpusEntry {
  DecisionPosition position;
  int boardTiles = 0;
  uint32_t seed = 0;
  int turn = 0;
};

DecisionPosition decisionPosition(const GameSim& sim, int side) {
  DecisionPosition position;
  position.board = sim.board;
  position.myRack = sim.racks[side];
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) position.unseen.add(kind, TILE_COUNTS[kind]);
  for (const Cell& cell : sim.board.cells)
    if (cell.occupied()) position.unseen.sub(cell.kind);
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++)
    if (sim.racks[side].n[kind]) position.unseen.sub(kind, sim.racks[side].n[kind]);
  position.physicalBagCount = static_cast<int>(sim.bag.size());
  position.opponentRackCount = sim.racks[1 - side].total;
  position.myScore = sim.scores[side];
  position.opponentScore = sim.scores[1 - side];
  position.noScoreStreak = sim.noScoreStreak;
  position.openingPlacementCompleted = !sim.board.empty();
  return position;
}

std::vector<CorpusEntry> buildCorpus(int wanted) {
  std::vector<CorpusEntry> corpus;
  for (uint32_t seed : CORPUS_SEEDS) {
    if (static_cast<int>(corpus.size()) >= wanted) break;
    GameSim sim(seed);
    const GameSim::TierSpec builder{"easy", "static", 200};
    int side = 0;
    for (int turn = 0; turn < 80 && !sim.finished; turn++) {
      if (turn >= 2 && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          sim.racks[side].total > 0 && sim.racks[1 - side].total > 0) {
        CorpusEntry entry;
        entry.position = decisionPosition(sim, side);
        entry.boardTiles = sim.board.tileCount;
        entry.seed = seed;
        entry.turn = turn;
        corpus.push_back(std::move(entry));
        if (static_cast<int>(corpus.size()) >= wanted) break;
      }
      const std::string response =
          handleRequest(sim.requestJson(side, builder, 9000 + static_cast<uint32_t>(turn)));
      if (!sim.applyResponse(side, response)) break;
      side = 1 - side;
    }
  }
  return corpus;
}

// ── reference run ────────────────────────────────────────────────────────────
//
// The oracle every policy is scored against: exact replies, no elimination, a
// deliberately wider admission than any policy under test, and many more shared
// worlds. It is slow on purpose. Its per-candidate means are the stand-in for
// "the value of this move", which is what makes regret measurable at all.
//
// It runs on the adaptive-uniform arm with the stopping rules switched off and
// credits it cannot exhaust. That is not to make it adaptive: it is so a single
// world whose reply set will not fit the per-call ceiling is skipped instead of
// ending the oracle's schedule early. A fixed-schedule oracle silently returned
// as few as a handful of worlds on some positions, and an oracle that noisy
// makes every regret number downstream meaningless.
constexpr uint32_t ORACLE_CANDIDATE_CAP = 48;
constexpr uint32_t ORACLE_WORLDS = 20;
constexpr uint64_t ORACLE_CREDITS = 40'000'000'000ULL;

struct Oracle {
  bool ok = false;
  std::string bestKey;
  int32_t bestValue = 0;
  std::map<std::string, int32_t> valueByKey;
  uint64_t modeledCost = 0;
  uint32_t worldsCompleted = 0;
};

Oracle runOracle(const DecisionPosition& position) {
  SearchQuery query;
  query.position = position;
  query.effort = SearchEffort::Deep;
  SearchOverrides overrides;
  overrides.candidateCap = ORACLE_CANDIDATE_CAP;
  overrides.maxWorlds = ORACLE_WORLDS;
  overrides.searchCostCredits = ORACLE_CREDITS;
  overrides.disableIndifferenceStop = true;
  const SearchDecision decision =
      DecisionSearch::benchmark(query, SearchVariant::ReplyIndexAdaptiveUniform, overrides);

  Oracle oracle;
  if (!decision.ok || decision.worldsCompleted == 0) return oracle;
  for (const CandidateEvidence& candidate : decision.candidates) {
    oracle.valueByKey[candidate.canonicalKey] = candidate.meanValue;
  }
  oracle.bestKey = canonicalMoveKey(decision.move);
  oracle.bestValue = decision.value;
  oracle.modeledCost = decision.modeledCost;
  oracle.worldsCompleted = decision.worldsCompleted;
  oracle.ok = true;
  return oracle;
}

// Regret in equity points: how much worse the oracle believes this move is than
// the oracle's own choice. A move the oracle never scored is reported as
// unscorable rather than silently given zero regret.
bool oracleRegret(const Oracle& oracle, const std::string& key, double& regret) {
  const auto found = oracle.valueByKey.find(key);
  if (found == oracle.valueByKey.end()) return false;
  regret = static_cast<double>(oracle.bestValue - found->second) / ENDPOINT_SCALE;
  return true;
}

// ── small statistics ─────────────────────────────────────────────────────────

double mean(const std::vector<double>& values) {
  if (values.empty()) return 0;
  double total = 0;
  for (double value : values) total += value;
  return total / values.size();
}

double percentile(std::vector<double> values, double fraction) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  return values[static_cast<size_t>(fraction * (values.size() - 1))];
}

double maximum(const std::vector<double>& values) {
  double best = 0;
  for (double value : values) best = std::max(best, value);
  return best;
}

const char* stopReasonName(StopReason reason) {
  switch (reason) {
    case StopReason::ScheduleComplete: return "schedule";
    case StopReason::SingleCandidate: return "single";
    case StopReason::Indifferent: return "indifferent";
    case StopReason::CreditsExhausted: return "credits";
    case StopReason::DeckExhausted: return "deck";
    case StopReason::LedgerExhausted: return "ledger";
    case StopReason::IncompleteWorld: return "incomplete";
  }
  return "?";
}

// ── legacy Deep, for the A row ───────────────────────────────────────────────
//
// The shipped analysis `deep` level: the legacy sampler at its production
// sample cap, reached through the same JSON entry point production uses.
struct LegacyResult {
  bool ok = false;
  std::string moveKey;
  double ms = 0;
  long long genCalls = 0;
  long long nodes = 0;
  int samples = 0;
  int candidates = 0;
};

LegacyResult runLegacyDeep(const DecisionPosition& position, int sampleCap) {
  auto request = json::makeObject();
  request->obj["difficulty"] = json::makeString("max");
  request->obj["sampleCap"] = json::makeInt(sampleCap);
  request->obj["seed"] = json::makeInt(20260813);
  auto cells = json::makeArray();
  for (int row = 0; row < BOARD_SIZE; row++) {
    for (int col = 0; col < BOARD_SIZE; col++) {
      const Cell& cell = position.board.at(row, col);
      if (!cell.occupied()) continue;
      auto entry = json::makeObject();
      entry->obj["r"] = json::makeInt(row);
      entry->obj["c"] = json::makeInt(col);
      entry->obj["kind"] = json::makeString(tileKindToString(cell.kind));
      entry->obj["token"] = json::makeString(assignedTokenToString(cell.token));
      cells->arr.push_back(entry);
    }
  }
  request->obj["board"] = cells;
  auto rack = json::makeArray();
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    for (int copy = 0; copy < position.myRack.n[kind]; copy++)
      rack->arr.push_back(json::makeString(tileKindToString(kind)));
  }
  request->obj["rack"] = rack;
  request->obj["bagCount"] = json::makeInt(position.physicalBagCount);
  request->obj["oppRackCount"] = json::makeInt(position.opponentRackCount);
  request->obj["myScore"] = json::makeInt(position.myScore);
  request->obj["oppScore"] = json::makeInt(position.opponentScore);
  request->obj["exchangeAllowed"] = json::makeBool(
      position.physicalBagCount + position.opponentRackCount - RACK_SIZE >= EXCHANGE_MIN_RESERVE);

  const auto start = Clock::now();
  const std::string responseText = handleRequest(json::stringify(request));
  const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();

  LegacyResult result;
  const json::ValuePtr response = json::parse(responseText);
  if (!response) return result;
  Move move;
  const std::string type = response->get("type") ? response->get("type")->asString() : "";
  if (type == "place") {
    move.type = MoveType::Place;
    if (auto placements = response->get("placements")) {
      for (const json::ValuePtr& entry : placements->arr) {
        Placement placement;
        placement.row = static_cast<uint8_t>(entry->get("r")->asInt(0));
        placement.col = static_cast<uint8_t>(entry->get("c")->asInt(0));
        placement.kind = tileKindFromString(entry->get("kind")->asString());
        placement.token = assignedTokenFromString(entry->get("token")->asString());
        move.placements.push_back(placement);
      }
    }
  } else if (type == "exchange") {
    move.type = MoveType::Exchange;
    if (auto exchange = response->get("exchange")) {
      for (const json::ValuePtr& entry : exchange->arr)
        move.exchangeKinds.push_back(tileKindFromString(entry->asString()));
    }
  } else {
    move.type = MoveType::Pass;
  }
  result.moveKey = canonicalMoveKey(move);
  result.ms = ms;
  if (auto stats = response->get("stats")) {
    result.genCalls = stats->get("genCalls") ? stats->get("genCalls")->asInt(0) : 0;
    result.nodes = stats->get("nodes") ? stats->get("nodes")->asInt(0) : 0;
    result.samples = stats->get("samples") ? static_cast<int>(stats->get("samples")->asInt(0)) : 0;
    result.candidates =
        stats->get("candidates") ? static_cast<int>(stats->get("candidates")->asInt(0)) : 0;
  }
  result.ok = true;
  return result;
}

// ── one measured policy ──────────────────────────────────────────────────────

struct PolicyRun {
  std::string label;
  SearchVariant variant = SearchVariant::ReplyIndexUniform;
  SearchOverrides overrides;
};

struct PolicyTotals {
  std::vector<double> latency;
  std::vector<double> regret;
  uint64_t rootCandidates = 0;
  uint64_t admitted = 0;
  uint64_t worldsPlanned = 0;
  uint64_t worldsCompleted = 0;
  uint64_t observations = 0;
  uint64_t fullCalls = 0;
  uint64_t deltaCalls = 0;
  uint64_t revalidations = 0;
  uint64_t nodes = 0;
  uint64_t nodesRoot = 0;
  uint64_t nodesBase = 0;
  uint64_t nodesDelta = 0;
  uint64_t nodesReference = 0;
  uint64_t nodesFallback = 0;
  uint64_t modeledCost = 0;
  double worstCreditRatio = 0;
  int overEnvelope = 0;
  uint64_t worldsDiscarded = 0;
  uint64_t fallbackCalls = 0;
  uint64_t eliminationRounds = 0;
  uint64_t finalActive = 0;
  int64_t gapSum = 0;
  uint32_t gapCount = 0;
  int agreements = 0;
  int scorable = 0;
  int unscorable = 0;
  int positions = 0;
  std::map<std::string, int> stopReasons;
};

void accumulate(PolicyTotals& totals, const SearchDecision& decision, double ms,
                const Oracle& oracle) {
  totals.positions++;
  totals.latency.push_back(ms);
  totals.rootCandidates +=
      decision.rootPlacementCount + decision.rootExchangeCount + decision.rootPassCount;
  totals.admitted +=
      decision.admittedPlacementCount + decision.admittedExchangeCount + decision.admittedPassCount;
  totals.worldsPlanned += decision.worldsPlanned;
  totals.worldsCompleted += decision.worldsCompleted;
  for (const CandidateEvidence& candidate : decision.candidates)
    totals.observations += candidate.observations;
  totals.fullCalls += decision.work.fullGenCalls;
  totals.deltaCalls += decision.work.deltaGenCalls;
  totals.revalidations += decision.work.replyRevalidations;
  totals.nodes += decision.work.movegenNodes;
  totals.nodesRoot += decision.work.byPurpose[workPurposeIndex(WorkPurpose::Root)].nodes;
  totals.nodesBase += decision.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyIndexBase)].nodes;
  totals.nodesDelta += decision.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyDelta)].nodes;
  totals.nodesReference +=
      decision.work.byPurpose[workPurposeIndex(WorkPurpose::OpponentReference)].nodes;
  totals.nodesFallback +=
      decision.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyFallback)].nodes;
  totals.modeledCost += decision.modeledCost;
  if (decision.costCredits > 0) {
    const double ratio =
        static_cast<double>(decision.modeledCost) / static_cast<double>(decision.costCredits);
    totals.worstCreditRatio = std::max(totals.worstCreditRatio, ratio);
    if (decision.modeledCost > decision.costCredits) totals.overEnvelope++;
  }
  totals.worldsDiscarded += decision.work.worldsDiscarded;
  totals.fallbackCalls +=
      decision.work.byPurpose[workPurposeIndex(WorkPurpose::ReplyFallback)].calls;
  totals.eliminationRounds += decision.eliminationRounds;
  totals.finalActive += decision.activeCandidatesFinal;
  if (decision.leaderChallengerKnown) {
    totals.gapSum += decision.leaderChallengerGap;
    totals.gapCount++;
  }
  totals.stopReasons[stopReasonName(decision.stopReason)]++;

  const std::string key = canonicalMoveKey(decision.move);
  if (oracle.ok) {
    if (key == oracle.bestKey) totals.agreements++;
    double regret = 0;
    if (oracleRegret(oracle, key, regret)) {
      totals.regret.push_back(regret);
      totals.scorable++;
    } else {
      totals.unscorable++;
    }
  }
}

void reportPolicy(const PolicyTotals& totals) {
  const double n = std::max(1, totals.positions);
  std::printf(
      "  candidates: root %.1f -> admitted %.1f | worlds planned %.1f completed %.1f "
      "dropped %.1f | observations %.1f\n",
      totals.rootCandidates / n, totals.admitted / n, totals.worldsPlanned / n,
      totals.worldsCompleted / n, totals.worldsDiscarded / n, totals.observations / n);
  std::printf(
      "  generation: full %.2f (fallback %.2f) delta %.2f revalidations %.0f | "
      "elimination rounds %.2f final active %.2f\n",
      totals.fullCalls / n, totals.fallbackCalls / n, totals.deltaCalls / n,
      totals.revalidations / n, totals.eliminationRounds / n, totals.finalActive / n);
  std::printf(
      "  nodes/decision %.0f (root %.0f, index base %.0f, delta %.0f, reference %.0f, "
      "fallback %.0f)\n",
      totals.nodes / n, totals.nodesRoot / n, totals.nodesBase / n, totals.nodesDelta / n,
      totals.nodesReference / n, totals.nodesFallback / n);
  std::printf("  modelled cost/decision %.0f | latency mean %.0fms p50 %.0f p95 %.0f p99 %.0f\n",
              totals.modeledCost / n, mean(totals.latency), percentile(totals.latency, 0.50),
              percentile(totals.latency, 0.95), percentile(totals.latency, 0.99));
  if (totals.worstCreditRatio > 0) {
    // The credit envelope is what the search aims at; the ledger ceilings are
    // the hard bound. This says how close the aim actually is, because a policy
    // that routinely doubles its stated envelope is not a bounded search.
    std::printf("  envelope adherence: worst spend %.2fx credits, %d/%d decisions over\n",
                totals.worstCreditRatio, totals.overEnvelope, totals.positions);
  }
  if (totals.gapCount > 0) {
    std::printf("  final leader-challenger paired gap %.3f pt over %u positions\n",
                static_cast<double>(totals.gapSum) / totals.gapCount / ENDPOINT_SCALE,
                totals.gapCount);
  }
  std::printf("  reference agreement %.1f%% | regret mean %.3f p95 %.3f max %.3f pt"
              " (scored %d, unscorable %d)\n",
              100.0 * totals.agreements / n, mean(totals.regret),
              percentile(totals.regret, 0.95), maximum(totals.regret), totals.scorable,
              totals.unscorable);
  std::printf("  completion:");
  for (const auto& [reason, count] : totals.stopReasons) std::printf(" %s=%d", reason.c_str(), count);
  std::printf("\n");
}

std::vector<PolicyRun> deepPolicySet() {
  std::vector<PolicyRun> runs;

  // B: the frozen reference. Its own policy shrinks admission to fit its
  // call allowance, which is exactly what makes it expensive per candidate.
  runs.push_back({"B sim_v2-reference (fixed 8 worlds)", SearchVariant::SimV2Reference, {}});

  // C: same allocation, exact replies. Pinned to the reference's admitted
  // count so the row isolates the reply mechanism and nothing else.
  PolicyRun matched;
  matched.label = "C ReplyIndex uniform (reference admission)";
  matched.variant = SearchVariant::ReplyIndexUniform;
  matched.overrides.candidateCap = 12;
  runs.push_back(matched);

  // C': what the shipped ReplyIndex policy would actually admit at Deep.
  runs.push_back({"C' ReplyIndex uniform (Deep admission)", SearchVariant::ReplyIndexUniform, {}});

  // D: elimination over the same fixed schedule — the current PairedRace.
  runs.push_back({"D PairedRace (fixed 8 worlds)", SearchVariant::PairedReplyIndex, {}});

  // E/F: the credit envelope, uniform against concentrated.
  runs.push_back({"E adaptive uniform (credit envelope)",
                  SearchVariant::ReplyIndexAdaptiveUniform, {}});
  runs.push_back({"F adaptive paired (credit envelope)",
                  SearchVariant::ReplyIndexAdaptivePaired, {}});
  return runs;
}

}  // namespace

int runDeepPolicyBench(int positions, const std::string& variantFilter) {
  // These runs take minutes. Line buffering keeps a redirected log readable
  // while it is still going rather than only after it finishes.
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  const std::vector<CorpusEntry> corpus = buildCorpus(positions);
  if (corpus.empty()) {
    std::printf("deep-bench: empty corpus\n");
    return 1;
  }
  std::printf("deep policy bench: %zu positions, oracle = ReplyIndex uniform cap %u x %u worlds\n",
              corpus.size(), ORACLE_CANDIDATE_CAP, ORACLE_WORLDS);

  std::vector<Oracle> oracles;
  oracles.reserve(corpus.size());
  uint64_t oracleCost = 0;
  uint64_t oracleWorlds = 0;
  uint32_t oracleWorstWorlds = ORACLE_WORLDS;
  for (const CorpusEntry& entry : corpus) {
    oracles.push_back(runOracle(entry.position));
    oracleCost += oracles.back().modeledCost;
    oracleWorlds += oracles.back().worldsCompleted;
    oracleWorstWorlds = std::min(oracleWorstWorlds, oracles.back().worldsCompleted);
  }
  int usable = 0;
  for (const Oracle& oracle : oracles) usable += oracle.ok ? 1 : 0;
  std::printf("oracle: %d/%zu positions scored, mean worlds %.1f (worst %u of %u), "
              "mean modelled cost %.0f\n\n",
              usable, corpus.size(), static_cast<double>(oracleWorlds) / corpus.size(),
              oracleWorstWorlds, ORACLE_WORLDS,
              static_cast<double>(oracleCost) / corpus.size());

  const bool wantLegacy = variantFilter.empty() || variantFilter == "legacy";
  if (wantLegacy) {
    std::vector<double> latency;
    int agreements = 0, scorable = 0, unscorable = 0;
    std::vector<double> regrets;
    long long genCalls = 0, nodes = 0, samples = 0, candidates = 0;
    for (size_t i = 0; i < corpus.size(); i++) {
      const LegacyResult legacy = runLegacyDeep(corpus[i].position, 40);
      if (!legacy.ok) continue;
      latency.push_back(legacy.ms);
      genCalls += legacy.genCalls;
      nodes += legacy.nodes;
      samples += legacy.samples;
      candidates += legacy.candidates;
      if (!oracles[i].ok) continue;
      if (legacy.moveKey == oracles[i].bestKey) agreements++;
      double regret = 0;
      if (oracleRegret(oracles[i], legacy.moveKey, regret)) {
        regrets.push_back(regret);
        scorable++;
      } else {
        unscorable++;
      }
    }
    const double n = std::max<size_t>(1, latency.size());
    std::printf("A legacy sim Deep (sampleCap 40)\n");
    std::printf("  candidates %.1f | samples %.1f | generation calls %.1f | DFS nodes %.0f\n",
                candidates / n, samples / n, genCalls / n, nodes / n);
    std::printf("  latency mean %.0fms p50 %.0f p95 %.0f p99 %.0f\n", mean(latency),
                percentile(latency, 0.50), percentile(latency, 0.95), percentile(latency, 0.99));
    std::printf("  reference agreement %.1f%% | regret mean %.3f p95 %.3f max %.3f pt"
                " (scored %d, unscorable %d)\n\n",
                100.0 * agreements / n, mean(regrets), percentile(regrets, 0.95),
                maximum(regrets), scorable, unscorable);
  }

  // Rows B and C are the same search with a different reply mechanism, so they
  // must agree move for move and value for value on every position, not merely
  // in aggregate. Aggregate agreement can hide two positions that differ in
  // opposite directions; this cannot.
  std::vector<std::string> referenceMove(corpus.size());
  std::vector<int32_t> referenceValue(corpus.size(), 0);
  std::vector<uint32_t> referenceObservations(corpus.size(), 0);
  int exactnessChecked = 0;
  int exactnessMismatches = 0;

  for (const PolicyRun& run : deepPolicySet()) {
    if (!variantFilter.empty() && variantFilter != "all" &&
        run.label.find(variantFilter) == std::string::npos)
      continue;
    const bool isReferenceRow = run.label.rfind("B ", 0) == 0;
    const bool isMatchedIndexRow = run.label.rfind("C ", 0) == 0;
    PolicyTotals totals;
    for (size_t i = 0; i < corpus.size(); i++) {
      SearchQuery query;
      query.position = corpus[i].position;
      query.effort = SearchEffort::Deep;
      const auto start = Clock::now();
      const SearchDecision decision =
          DecisionSearch::benchmark(query, run.variant, run.overrides);
      const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
      if (!decision.ok) {
        std::printf("%s failed at position %zu: %s\n", run.label.c_str(), i, decision.error.c_str());
        return 1;
      }
      accumulate(totals, decision, ms, oracles[i]);

      const std::string key = canonicalMoveKey(decision.move);
      uint32_t observations = 0;
      for (const CandidateEvidence& candidate : decision.candidates)
        observations += candidate.observations;
      if (isReferenceRow) {
        referenceMove[i] = key;
        referenceValue[i] = decision.value;
        referenceObservations[i] = observations;
      } else if (isMatchedIndexRow && !referenceMove[i].empty()) {
        exactnessChecked++;
        if (key != referenceMove[i] || decision.value != referenceValue[i] ||
            observations != referenceObservations[i]) {
          exactnessMismatches++;
          std::printf("  EXACTNESS MISMATCH at position %zu: reference %s (%d, %u obs) vs "
                      "indexed %s (%d, %u obs)\n",
                      i, referenceMove[i].c_str(), referenceValue[i], referenceObservations[i],
                      key.c_str(), decision.value, observations);
        }
      }
    }
    std::printf("%s\n", run.label.c_str());
    reportPolicy(totals);
    if (isMatchedIndexRow && exactnessChecked > 0) {
      std::printf("  exactness vs reference: %d/%d positions identical (move, value, "
                  "observation count)\n",
                  exactnessChecked - exactnessMismatches, exactnessChecked);
    }
    std::printf("\n");
  }
  return exactnessMismatches == 0 ? 0 : 1;
}

int runDeepCreditCurve(int positions) {
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  const std::vector<CorpusEntry> corpus = buildCorpus(positions);
  if (corpus.empty()) return 1;
  std::vector<Oracle> oracles;
  for (const CorpusEntry& entry : corpus) oracles.push_back(runOracle(entry.position));

  std::printf("Deep credit curve: %zu positions\n", corpus.size());
  std::printf("%-10s %-18s %12s %10s %8s %10s %10s\n", "credits", "policy", "cost/decision",
              "worlds", "agree%", "regret", "p95");
  for (uint64_t credits : {30'000'000ULL, 60'000'000ULL, 120'000'000ULL, 240'000'000ULL,
                           480'000'000ULL}) {
    for (SearchVariant variant : {SearchVariant::ReplyIndexAdaptiveUniform,
                                  SearchVariant::ReplyIndexAdaptivePaired}) {
      PolicyTotals totals;
      for (size_t i = 0; i < corpus.size(); i++) {
        SearchQuery query;
        query.position = corpus[i].position;
        query.effort = SearchEffort::Deep;
        SearchOverrides overrides;
        overrides.searchCostCredits = credits;
        const auto start = Clock::now();
        const SearchDecision decision = DecisionSearch::benchmark(query, variant, overrides);
        const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        if (!decision.ok) return 1;
        accumulate(totals, decision, ms, oracles[i]);
      }
      const double n = std::max(1, totals.positions);
      std::printf("%-10llu %-18s %12.0f %10.1f %8.1f %10.3f %10.3f\n",
                  static_cast<unsigned long long>(credits / 1'000'000),
                  variant == SearchVariant::ReplyIndexAdaptiveUniform ? "uniform" : "paired",
                  totals.modeledCost / n, totals.worldsCompleted / n,
                  100.0 * totals.agreements / n, mean(totals.regret),
                  percentile(totals.regret, 0.95));
    }
  }

  // Width against depth at one envelope. Concentrating credits on fewer
  // contenders and concentrating them on more candidates are the two ways to
  // spend the same budget, and an extra world costs a base generation whatever
  // the active count is, so wide batches amortise that fixed cost and narrow
  // ones do not. This is the row that says which direction actually pays.
  std::printf("\nwidth vs depth at 120M credits (adaptive uniform)\n");
  std::printf("%-8s %-12s %-10s %-12s %-9s %-9s %s\n", "cap", "admitted", "worlds",
              "cost", "agree%", "regret", "p95");
  for (uint32_t cap : {7u, 12u, 17u, 23u, 32u, 48u}) {
    PolicyTotals totals;
    for (size_t i = 0; i < corpus.size(); i++) {
      SearchQuery query;
      query.position = corpus[i].position;
      query.effort = SearchEffort::Deep;
      SearchOverrides overrides;
      overrides.candidateCap = cap;
      overrides.searchCostCredits = 120'000'000;
      const auto start = Clock::now();
      const SearchDecision decision = DecisionSearch::benchmark(
          query, SearchVariant::ReplyIndexAdaptiveUniform, overrides);
      const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
      if (!decision.ok) return 1;
      accumulate(totals, decision, ms, oracles[i]);
    }
    const double n = std::max(1, totals.positions);
    std::printf("%-8u %-12.1f %-10.1f %-12.0f %-9.1f %-9.3f %.3f\n", cap, totals.admitted / n,
                totals.worldsCompleted / n, totals.modeledCost / n,
                100.0 * totals.agreements / n, mean(totals.regret),
                percentile(totals.regret, 0.95));
  }
  return 0;
}

// ── G6: does admission keep the move that turns out to be best? ──────────────

int runGate6(int positions) {
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  const std::vector<CorpusEntry> corpus = buildCorpus(positions);
  if (corpus.empty()) return 1;
  std::printf("G6 admission recall: %zu positions, reference admission cap %u\n", corpus.size(),
              ORACLE_CANDIDATE_CAP);
  std::vector<Oracle> oracles;
  oracles.reserve(corpus.size());
  for (const CorpusEntry& entry : corpus) oracles.push_back(runOracle(entry.position));

  // Admission is a static policy, so one world is enough to read out which
  // candidates it would have admitted, and both of its knobs can be swept
  // cheaply. Reporting the admitted count alongside the cap is what separates
  // "the cap is binding" from "the plausibility envelope is binding" — turning
  // the wrong one buys nothing.
  struct AdmissionPoint {
    uint32_t cap;
    int32_t envelope;
  };
  const AdmissionPoint points[] = {
      {7, -1},  {12, -1}, {15, -1}, {23, -1}, {32, -1}, {48, -1},
      {48, 20 * ENDPOINT_SCALE},  {48, 60 * ENDPOINT_SCALE},
      {48, 120 * ENDPOINT_SCALE}, {48, 240 * ENDPOINT_SCALE},
  };

  std::printf("%-6s %-10s %-10s %-8s %-8s %-9s %-9s %s\n", "cap", "envelope", "admitted",
              "recall", "meanReg", "p95Reg", "maxReg", "catastrophic(>10pt)");

  for (const AdmissionPoint& point : points) {
    int recalled = 0, measured = 0, catastrophic = 0;
    double admittedTotal = 0;
    std::vector<double> regrets;
    for (size_t index = 0; index < corpus.size(); index++) {
      const CorpusEntry& entry = corpus[index];
      const Oracle& oracle = oracles[index];
      if (!oracle.ok) continue;

      SearchQuery query;
      query.position = entry.position;
      query.effort = SearchEffort::Deep;
      SearchOverrides overrides;
      overrides.candidateCap = point.cap;
      overrides.correctionEnvelope = point.envelope;
      overrides.worlds = 1;
      const SearchDecision admitted =
          DecisionSearch::benchmark(query, SearchVariant::ReplyIndexUniform, overrides);
      if (!admitted.ok) continue;

      measured++;
      admittedTotal += admitted.candidates.size();
      bool containsOracleBest = false;
      bool haveBest = false;
      int32_t bestAdmittedValue = 0;
      for (const CandidateEvidence& candidate : admitted.candidates) {
        if (candidate.canonicalKey == oracle.bestKey) containsOracleBest = true;
        const auto found = oracle.valueByKey.find(candidate.canonicalKey);
        if (found == oracle.valueByKey.end()) continue;
        if (!haveBest || found->second > bestAdmittedValue) {
          bestAdmittedValue = found->second;
          haveBest = true;
        }
      }
      if (containsOracleBest) recalled++;
      // Regret of the admission step alone: the best move admission left
      // available, valued by the oracle, against the oracle's own choice.
      const double regret =
          haveBest ? static_cast<double>(oracle.bestValue - bestAdmittedValue) / ENDPOINT_SCALE
                   : static_cast<double>(oracle.bestValue) / ENDPOINT_SCALE;
      regrets.push_back(regret);
      if (regret > 10.0) catastrophic++;
    }
    char envelopeText[16];
    if (point.envelope < 0)
      std::snprintf(envelopeText, sizeof(envelopeText), "policy");
    else
      std::snprintf(envelopeText, sizeof(envelopeText), "%d pt", point.envelope / ENDPOINT_SCALE);
    std::printf("%-6u %-10s %-10.1f %-8.1f %-8.3f %-9.3f %-9.3f %d\n", point.cap, envelopeText,
                measured ? admittedTotal / measured : 0.0,
                measured ? 100.0 * recalled / measured : 0.0, mean(regrets),
                percentile(regrets, 0.95), maximum(regrets), catastrophic);
  }
  std::printf("\nThresholds (design G6): recall >= 99%%, mean regret <= 0.25 pt, "
              "p95 <= 2 pt, no miss > 10 pt.\n");
  std::printf("Deep's shipped admission is cap 23 with a %d pt envelope; the reference "
              "variant narrows it to cap 12.\n",
              90);
  return 0;
}

// ── G7: uniform against paired at a normalised work envelope ─────────────────

int runGate7(int positions) {
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  const std::vector<CorpusEntry> corpus = buildCorpus(positions);
  if (corpus.empty()) return 1;
  std::vector<Oracle> oracles;
  for (const CorpusEntry& entry : corpus) oracles.push_back(runOracle(entry.position));

  std::printf("G7 uniform vs paired: %zu positions, equal credit envelope, shared worlds\n\n",
              corpus.size());

  struct Arm {
    const char* label;
    SearchVariant variant;
  };
  const Arm arms[] = {{"uniform", SearchVariant::ReplyIndexAdaptiveUniform},
                      {"paired", SearchVariant::ReplyIndexAdaptivePaired}};

  std::map<std::string, std::vector<std::string>> chosenByArm;
  std::map<std::string, std::vector<std::string>> chosenBySaltedArm;
  for (const Arm& arm : arms) {
    PolicyTotals totals;
    int eliminationMistakes = 0;
    for (size_t i = 0; i < corpus.size(); i++) {
      SearchQuery query;
      query.position = corpus[i].position;
      query.effort = SearchEffort::Deep;
      const auto start = Clock::now();
      const SearchDecision decision = DecisionSearch::benchmark(query, arm.variant, {});
      const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
      if (!decision.ok) return 1;
      accumulate(totals, decision, ms, oracles[i]);
      chosenByArm[arm.label].push_back(canonicalMoveKey(decision.move));

      // An elimination mistake is the move the oracle prefers being dropped by
      // the race: it was admitted, it was observed, and it still went away.
      if (oracles[i].ok && arm.variant == SearchVariant::ReplyIndexAdaptivePaired) {
        bool admittedOracleBest = false;
        bool survived = false;
        for (const CandidateEvidence& candidate : decision.candidates) {
          if (candidate.canonicalKey != oracles[i].bestKey) continue;
          admittedOracleBest = true;
          survived = candidate.observations == decision.worldsCompleted;
        }
        if (admittedOracleBest && !survived &&
            canonicalMoveKey(decision.move) != oracles[i].bestKey)
          eliminationMistakes++;
      }

      // Seed-salt sensitivity: the same envelope on a different shared world
      // schedule. A policy whose answer moves when only the worlds move is
      // reporting noise, not strength.
      SearchOverrides salted;
      salted.worldSeedSalt = 0x5eed5a1701ULL;
      const SearchDecision saltedDecision =
          DecisionSearch::benchmark(query, arm.variant, salted);
      chosenBySaltedArm[arm.label].push_back(
          saltedDecision.ok ? canonicalMoveKey(saltedDecision.move) : std::string("!"));
    }
    std::printf("%s\n", arm.label);
    reportPolicy(totals);
    if (arm.variant == SearchVariant::ReplyIndexAdaptivePaired)
      std::printf("  elimination mistakes: %d\n", eliminationMistakes);
    int stable = 0;
    for (size_t i = 0; i < chosenByArm[arm.label].size(); i++)
      stable += chosenByArm[arm.label][i] == chosenBySaltedArm[arm.label][i] ? 1 : 0;
    std::printf("  seed-salt stability: %.1f%% (%d/%zu unchanged under a re-rolled deck)\n\n",
                100.0 * stable / std::max<size_t>(1, chosenByArm[arm.label].size()), stable,
                chosenByArm[arm.label].size());
  }

  int agree = 0;
  for (size_t i = 0; i < corpus.size(); i++)
    agree += chosenByArm["uniform"][i] == chosenByArm["paired"][i] ? 1 : 0;
  std::printf("uniform vs paired top-action agreement: %.1f%% (%d/%zu)\n\n",
              100.0 * agree / corpus.size(), agree, corpus.size());

  // The elimination allowance decides whether the race is a race at all. At the
  // registered 3.0 points almost nothing separates, so paired allocation
  // degenerates toward uniform; too small and it starts discarding the move the
  // oracle wanted. This sweep is what says where between those the policy sits.
  std::printf("elimination allowance sweep (adaptive paired, same credits)\n");
  std::printf("%-12s %-8s %-8s %-10s %-10s %-9s %-9s %s\n", "allowance", "worlds", "active",
              "elimRnds", "cost", "agree%", "regret", "elimMistakes");
  for (int32_t allowance : {0, 250, 500, 1000, 2000, 3000, 6000}) {
    PolicyTotals totals;
    int mistakes = 0;
    for (size_t i = 0; i < corpus.size(); i++) {
      SearchQuery query;
      query.position = corpus[i].position;
      query.effort = SearchEffort::Deep;
      SearchOverrides overrides;
      overrides.modelAllowance = allowance;
      const auto start = Clock::now();
      const SearchDecision decision = DecisionSearch::benchmark(
          query, SearchVariant::ReplyIndexAdaptivePaired, overrides);
      const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
      if (!decision.ok) return 1;
      accumulate(totals, decision, ms, oracles[i]);
      if (!oracles[i].ok) continue;
      for (const CandidateEvidence& candidate : decision.candidates) {
        if (candidate.canonicalKey != oracles[i].bestKey) continue;
        if (candidate.observations < decision.worldsCompleted &&
            canonicalMoveKey(decision.move) != oracles[i].bestKey)
          mistakes++;
      }
    }
    const double n = std::max(1, totals.positions);
    std::printf("%-12.3f %-8.1f %-8.2f %-10.2f %-10.0f %-9.1f %-9.3f %d\n",
                static_cast<double>(allowance) / ENDPOINT_SCALE, totals.worldsCompleted / n,
                totals.finalActive / n, totals.eliminationRounds / n, totals.modeledCost / n,
                100.0 * totals.agreements / n, mean(totals.regret), mistakes);
  }
  std::printf("\nThresholds (design G7): agreement >= 95%%, mean reference regret <= 0.5 pt, "
              "p95 <= 3 pt,\nmedian opponent-generation calls -30%% or better, seed-salt "
              "sensitivity no worse than uniform.\n");
  return 0;
}

}  // namespace amath
