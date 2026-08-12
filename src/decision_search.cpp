#include "decision_search.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <set>
#include <sstream>
#include <utility>

#include "paired_race.hpp"
#include "reply_index.hpp"

namespace amath {
namespace {

struct SearchPolicy {
  WorkEnvelope envelope;
  uint64_t rootNodeLimit = 0;
  uint64_t opponentNodeLimit = 0;
  uint32_t worlds = 0;
  uint32_t minimumWorlds = 1;
  size_t candidateCap = 1;
  int32_t correctionEnvelope = 0;
};

struct RankedAction {
  RootAction root;
  int32_t staticValue = 0;
};

SearchPolicy policyFor(SearchEffort effort, SearchVariant variant) {
  SearchPolicy policy;
  if (effort == SearchEffort::Instant) {
    policy.envelope = {1, 0, 12'000'000, 0, 0};
    policy.rootNodeLimit = 12'000'000;
    return policy;
  }
  if (effort == SearchEffort::Interactive) {
    policy.envelope = {2, 7, 120'000'000, 0, 1};
    policy.rootNodeLimit = 12'000'000;
    policy.opponentNodeLimit = 12'000'000;
    policy.worlds = 1;
    policy.minimumWorlds = 1;
    policy.candidateCap = 7;
    policy.correctionEnvelope = 50 * ENDPOINT_SCALE;
  } else if (effort == SearchEffort::Strong) {
    policy.envelope = {5, 60, 800'000'000, 0, 4};
    policy.rootNodeLimit = 20'000'000;
    policy.opponentNodeLimit = 12'000'000;
    policy.worlds = 4;
    policy.minimumWorlds = 2;
    policy.candidateCap = 15;
    policy.correctionEnvelope = 70 * ENDPOINT_SCALE;
  } else {
    policy.envelope = {9, 184, 2'400'000'000ULL, 0, 8};
    policy.rootNodeLimit = 24'000'000;
    policy.opponentNodeLimit = 12'000'000;
    policy.worlds = 8;
    policy.minimumWorlds = 2;
    policy.candidateCap = 23;
    policy.correctionEnvelope = 90 * ENDPOINT_SCALE;
  }

  if (variant == SearchVariant::SimV2Reference) {
    // Reference mode performs one candidate-specific full reply generation per
    // contender/world. Keep its fixed envelope aligned with the design's
    // opponent-call allowances: 7 interactive, 32 strong, 96 deep.
    const uint32_t opponentCallAllowance = effort == SearchEffort::Interactive
                                               ? 7
                                               : effort == SearchEffort::Strong ? 32 : 96;
    policy.candidateCap = std::min<size_t>(
        policy.candidateCap, opponentCallAllowance / std::max<uint32_t>(policy.worlds, 1));
    policy.envelope.maxFullGenCalls = 1 + policy.worlds * policy.candidateCap;
    policy.envelope.maxDeltaGenCalls = 0;
  } else {
    // Exact ReplyIndex needs one full base generation per world; every
    // candidate-local recovery is separately bounded and reported as delta.
    // The remaining full-call allowance is reserved for exact fallback if a
    // base or delta generation is incomplete.
    const uint32_t opponentCallAllowance = effort == SearchEffort::Interactive
                                               ? 8
                                               : effort == SearchEffort::Strong ? 32 : 96;
    policy.envelope.maxFullGenCalls = 1 + opponentCallAllowance;
    policy.envelope.maxDeltaGenCalls = policy.worlds * policy.candidateCap;
  }
  return policy;
}

uint64_t hashByte(uint64_t hash, uint8_t byte) {
  return (hash ^ byte) * 1099511628211ULL;
}

template <typename T>
uint64_t hashInteger(uint64_t hash, T value) {
  using Unsigned = std::make_unsigned_t<T>;
  Unsigned bits = static_cast<Unsigned>(value);
  for (size_t i = 0; i < sizeof(T); i++) {
    hash = hashByte(hash, static_cast<uint8_t>(bits & 0xff));
    bits >>= 8;
  }
  return hash;
}

uint64_t canonicalPositionHash(const DecisionPosition& position) {
  uint64_t hash = 1469598103934665603ULL;
  for (const Cell& cell : position.board.cells) {
    hash = hashByte(hash, cell.kind);
    hash = hashByte(hash, cell.token);
  }
  for (uint8_t value : position.myRack.n) hash = hashByte(hash, value);
  for (uint8_t value : position.unseen.n) hash = hashByte(hash, value);
  hash = hashInteger(hash, position.physicalBagCount);
  hash = hashInteger(hash, position.opponentRackCount);
  hash = hashInteger(hash, position.myScore);
  hash = hashInteger(hash, position.opponentScore);
  hash = hashInteger(hash, position.noScoreStreak);
  return hashByte(hash, position.openingPlacementCompleted ? 1 : 0);
}

uint64_t hashKey(const std::string& key) {
  uint64_t hash = 1469598103934665603ULL;
  for (unsigned char byte : key) hash = hashByte(hash, byte);
  return hash;
}

std::string fingerprint(const std::vector<RankedAction>& actions) {
  uint64_t hash = 1469598103934665603ULL;
  for (const RankedAction& action : actions) {
    for (unsigned char byte : action.root.canonicalKey) hash = hashByte(hash, byte);
    hash = hashByte(hash, 0xff);
  }
  std::ostringstream out;
  out << std::hex << std::setw(16) << std::setfill('0') << hash;
  return out.str();
}

std::vector<RankedAction> selectRootScope(std::vector<RankedAction> ranked, size_t cap,
                                         int32_t correctionEnvelope) {
  std::sort(ranked.begin(), ranked.end(), [](const RankedAction& a, const RankedAction& b) {
    if (a.staticValue != b.staticValue) return a.staticValue > b.staticValue;
    return a.root.canonicalKey < b.root.canonicalKey;
  });
  if (ranked.size() <= cap) return ranked;

  std::vector<size_t> mandatory;
  mandatory.push_back(0);
  size_t scoreLeader = 0;
  for (size_t i = 1; i < ranked.size(); i++) {
    if (ranked[i].root.move.score > ranked[scoreLeader].root.move.score) scoreLeader = i;
  }
  mandatory.push_back(scoreLeader);
  std::set<size_t> exchangeSizes;
  for (size_t i = 0; i < ranked.size(); i++) {
    const Move& move = ranked[i].root.move;
    if (move.type == MoveType::Pass) mandatory.push_back(i);
    if (move.type == MoveType::Exchange && exchangeSizes.insert(move.exchangeKinds.size()).second)
      mandatory.push_back(i);
  }

  std::vector<RankedAction> selected;
  std::set<std::string> keys;
  for (size_t index : mandatory) {
    if (selected.size() == cap) break;
    if (keys.insert(ranked[index].root.canonicalKey).second) selected.push_back(ranked[index]);
  }
  for (const RankedAction& action : ranked) {
    if (selected.size() == cap) break;
    if (ranked.front().staticValue - action.staticValue > correctionEnvelope) continue;
    if (keys.insert(action.root.canonicalKey).second) selected.push_back(action);
  }
  std::sort(selected.begin(), selected.end(), [](const RankedAction& a, const RankedAction& b) {
    return a.root.canonicalKey < b.root.canonicalKey;
  });
  return selected;
}

SearchState makeWorldState(const DecisionPosition& position, const HiddenWorld& world) {
  SearchState state;
  state.board = position.board;
  state.racks[0] = position.myRack;
  state.racks[1] = world.opponentRack;
  state.bag = world.orderedBag;
  state.scores[0] = position.myScore;
  state.scores[1] = position.opponentScore;
  state.noScoreStreak = position.noScoreStreak;
  state.openingPlacementCompleted = position.openingPlacementCompleted;
  state.sideToMove = 0;
  return state;
}

}  // namespace

static SearchDecision decideWithVariant(const SearchQuery& query, SearchVariant variant) {
  SearchDecision decision;
  decision.variant = variant;
  const DecisionPosition& position = query.position;
  if (position.myRack.total <= 0 || position.opponentRackCount < 0 ||
      position.physicalBagCount < 0 ||
      position.unseen.total != position.opponentRackCount + position.physicalBagCount) {
    decision.error = "invalid position inventory";
    return decision;
  }

  const SearchPolicy policy = policyFor(query.effort, variant);
  WorkLedger ledger(policy.envelope);
  RootCatalogueResult root = RootCatalogue::build(
      position.board, position.myRack, position.physicalBagCount,
      position.opponentRackCount, ledger, policy.rootNodeLimit);
  if (root.actions.empty() || ledger.report().invariantFailure) {
    decision.error = "root catalogue failed";
    decision.work = ledger.report();
    return decision;
  }

  for (const RootAction& action : root.actions) {
    if (action.move.type == MoveType::Place)
      decision.rootPlacementCount++;
    else if (action.move.type == MoveType::Exchange)
      decision.rootExchangeCount++;
    else
      decision.rootPassCount++;
  }

  const BoardContext rootContext =
      makeContext(position.board, position.unseen, position.physicalBagCount,
                  static_cast<float>(position.myScore - position.opponentScore));
  std::vector<RankedAction> ranked;
  ranked.reserve(root.actions.size());
  for (RootAction& action : root.actions) {
    const int32_t value = static_cast<int32_t>(
        std::lround(staticEquity(position.board, position.myRack, action.move, rootContext) *
                    ENDPOINT_SCALE));
    ranked.push_back({std::move(action), value});
    ledger.chargeStaticEvaluation();
  }
  std::sort(ranked.begin(), ranked.end(), [](const RankedAction& a, const RankedAction& b) {
    if (a.staticValue != b.staticValue) return a.staticValue > b.staticValue;
    return a.root.canonicalKey < b.root.canonicalKey;
  });

  const RankedAction staticLeader = ranked.front();
  decision.ok = true;
  decision.move = staticLeader.root.move;
  decision.value = staticLeader.staticValue;
  decision.rootComplete = root.placementEnumerationComplete;
  decision.completion = root.placementEnumerationComplete ? Completion::Complete
                                                           : Completion::RootLimited;

  if (query.effort == SearchEffort::Instant || policy.worlds == 0) {
    decision.method = SearchMethod::Static;
    decision.valueKind = ValueKind::StaticEquity;
    decision.rootScope = root.placementEnumerationComplete
                             ? ReferenceRootScope::Exhaustive
                             : ReferenceRootScope::FrozenSubset;
    decision.work = ledger.report();
    return decision;
  }

  const bool exhaustive = root.placementEnumerationComplete &&
                          ranked.size() <= policy.candidateCap;
  std::vector<RankedAction> candidates =
      selectRootScope(std::move(ranked), policy.candidateCap, policy.correctionEnvelope);
  decision.rootScope = exhaustive ? ReferenceRootScope::Exhaustive
                                  : ReferenceRootScope::FrozenSubset;
  decision.rootScopeFingerprint = fingerprint(candidates);
  decision.method = SearchMethod::PairedOpponentSearch;
  decision.valueKind = ValueKind::ExpectedEquity;
  decision.candidates.reserve(candidates.size());
  for (const RankedAction& candidate : candidates) {
    CandidateEvidence evidence;
    evidence.move = candidate.root.move;
    evidence.canonicalKey = candidate.root.canonicalKey;
    evidence.staticValue = candidate.staticValue;
    evidence.meanValue = candidate.staticValue;
    decision.candidates.push_back(std::move(evidence));
    if (candidate.root.move.type == MoveType::Place)
      decision.admittedPlacementCount++;
    else if (candidate.root.move.type == MoveType::Exchange)
      decision.admittedExchangeCount++;
    else
      decision.admittedPassCount++;
  }

  const WorldDeckResult deck =
      WorldDeck::build(position.unseen, position.opponentRackCount,
                       position.physicalBagCount, canonicalPositionHash(position), 2,
                       policy.worlds);
  if (!deck.ok) {
    decision.ok = false;
    decision.error = deck.error;
    decision.work = ledger.report();
    return decision;
  }

  const bool usesReplyIndex = variant != SearchVariant::SimV2Reference;
  const bool usesPairedElimination = variant == SearchVariant::PairedReplyIndex;
  const uint32_t eliminationStart =
      usesPairedElimination ? policy.minimumWorlds : policy.worlds + 1;
  PairedRace race(candidates.size(), RaceConfig{eliminationStart, 3000, 2.0});
  for (uint32_t worldIndex = 0; worldIndex < deck.worlds.size(); worldIndex++) {
    if (!ledger.reserveWorld()) break;
    const HiddenWorld& world = deck.worlds[worldIndex];
    ReplyIndexResult replyIndex;
    if (usesReplyIndex) {
      replyIndex = ReplyIndex::build(position.board, world.opponentRack, ledger,
                                     policy.opponentNodeLimit);
    }
    const std::vector<size_t> active = race.activeIndices();
    std::vector<std::pair<size_t, int32_t>> row;
    row.reserve(active.size());
    bool complete = true;
    for (size_t candidateIndex : active) {
      const RankedAction& candidate = candidates[candidateIndex];
      SearchState state = makeWorldState(position, world);
      const uint64_t candidateHash = hashKey(candidate.root.canonicalKey);
      const TransitionResult rootTransition =
          StateTransition::apply(state, candidate.root.move,
                                 WorldDeck::eventSeed(world, candidateHash, 0, 0));
      ledger.chargeTransition();
      if (!rootTransition.ok) {
        complete = false;
        break;
      }
      if (!state.terminal) {
        OpponentSearchResult reply;
        if (usesReplyIndex && replyIndex.complete) {
          const ReplySet replySet =
              ReplyIndex::recover(replyIndex, state.board, candidate.root.move.placements,
                                  world.opponentRack, ledger, policy.opponentNodeLimit);
          if (replySet.complete) {
            reply = OpponentSearch::chooseFromPlacements(state, replySet.placements, true);
          } else {
            reply = OpponentSearch::choose(state, ledger, policy.opponentNodeLimit,
                                           WorkPurpose::ReplyFallback);
          }
        } else if (usesReplyIndex) {
          reply = OpponentSearch::choose(state, ledger, policy.opponentNodeLimit,
                                         WorkPurpose::ReplyFallback);
        } else {
          reply = OpponentSearch::choose(state, ledger, policy.opponentNodeLimit);
        }
        ledger.chargeOpponentPolicyEvaluation(reply.actionsEvaluated);
        if (!reply.ok || !reply.complete) {
          complete = false;
          break;
        }
        const TransitionResult replyTransition =
            StateTransition::apply(state, reply.move,
                                   WorldDeck::eventSeed(world, candidateHash, 1, 0));
        ledger.chargeTransition();
        if (!replyTransition.ok) {
          complete = false;
          break;
        }
      }
      row.push_back({candidateIndex, EndpointEvaluator::evaluate(state)});
      ledger.chargeEndpointEvaluation();
    }
    if (!complete) {
      ledger.discardWorld();
      break;
    }
    ledger.commitWorld();
    if (!race.commitBatch(row)) {
      decision.ok = false;
      decision.error = "paired race invariant failure";
      decision.work = ledger.report();
      return decision;
    }
    for (const auto& [candidateIndex, value] : row) {
      (void)value;
      decision.candidates[candidateIndex].observations = race.observations(candidateIndex);
      decision.candidates[candidateIndex].meanValue = race.mean(candidateIndex);
    }
    if (usesPairedElimination && race.activeIndices().size() == 1) break;
  }

  decision.worldsCompleted = ledger.report().worldsCompleted;
  if (decision.worldsCompleted == 0) {
    decision.completion = root.placementEnumerationComplete ? Completion::WorkLimited
                                                             : Completion::RootLimited;
  } else {
    const size_t best = race.leader();
    decision.move = decision.candidates[best].move;
    decision.value = decision.candidates[best].meanValue;
    decision.activeCandidatesFinal = static_cast<uint32_t>(race.activeIndices().size());
    decision.completion =
        root.placementEnumerationComplete &&
                (decision.worldsCompleted == policy.worlds ||
                 (usesPairedElimination && decision.activeCandidatesFinal == 1))
            ? Completion::Complete
            : (root.placementEnumerationComplete ? Completion::WorkLimited
                                                   : Completion::RootLimited);
  }
  decision.work = ledger.report();
  return decision;
}

SearchDecision DecisionSearch::decide(const SearchQuery& query) {
  return decideWithVariant(query, SearchVariant::SimV2Reference);
}

SearchDecision DecisionSearch::benchmark(const SearchQuery& query, SearchVariant variant) {
  return decideWithVariant(query, variant);
}

}  // namespace amath
