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

  // True for the candidate-specific full-generation reference, whose call
  // ceiling scales with worlds x candidates rather than with worlds alone.
  bool referenceReplies = false;

  // Adaptive allocation only. `worlds` becomes the screening prefix every
  // admitted candidate is measured on; after that the schedule continues for
  // as long as the contenders are unresolved and credits remain.
  bool adaptive = false;
  bool eliminate = false;
  uint32_t maxWorlds = 0;
  uint64_t searchCostCredits = 0;
  int32_t indifferenceMargin = 0;

  // How far behind the leader a candidate must be before the race is willing to
  // stop paying for it. It is an allowance for evaluator and truncation error,
  // not a confidence level, and it is the single most consequential number in
  // the allocation policy: too small and good moves are dropped, too large and
  // nothing is ever dropped and the race degenerates into uniform allocation.
  int32_t modelAllowance = RaceConfig{}.modelAllowance;
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
    policy.maxWorlds = 8;
    policy.searchCostCredits = 40'000'000;
  } else if (effort == SearchEffort::Strong) {
    policy.envelope = {5, 60, 800'000'000, 0, 4};
    policy.rootNodeLimit = 20'000'000;
    policy.opponentNodeLimit = 12'000'000;
    policy.worlds = 4;
    policy.minimumWorlds = 2;
    policy.candidateCap = 15;
    policy.correctionEnvelope = 70 * ENDPOINT_SCALE;
    policy.maxWorlds = 24;
    policy.searchCostCredits = 120'000'000;
  } else {
    policy.envelope = {9, 184, 2'400'000'000ULL, 0, 8};
    policy.rootNodeLimit = 24'000'000;
    // A world whose reply set does not fit the per-call ceiling has to be
    // dropped, and the racks that overflow are the ones with the most replies —
    // exactly the dangerous ones. At 12M, 4-8% of Deep's worlds were dropped
    // and the sample was biased toward quiet opponent racks; measured over a
    // 24-world deck, 48M drops none of them.
    policy.opponentNodeLimit = 48'000'000;
    policy.worlds = 8;
    policy.minimumWorlds = 2;
    policy.candidateCap = 23;
    policy.correctionEnvelope = 90 * ENDPOINT_SCALE;
    // Deep's envelope is a ceiling on work, not a quota to consume, and it is
    // set from where the measured quality curve stops rising rather than from a
    // round number. On the 24-position corpus uniform allocation reaches its
    // best agreement and regret at about 60M modelled cost; 120M and 240M buy
    // more worlds and no better decisions. Re-derive this whenever the corpus
    // or the endpoint evaluator changes. See deep-compute-allocation-report.md.
    policy.maxWorlds = 64;
    policy.searchCostCredits = 60'000'000;
  }

  if (variant == SearchVariant::SimV2Reference) {
    // Reference mode performs one candidate-specific full reply generation per
    // contender/world. Keep its fixed envelope aligned with the design's
    // opponent-call allowances: 7 interactive, 32 strong, 96 deep.
    const uint32_t opponentCallAllowance = effort == SearchEffort::Interactive
                                               ? 7
                                               : effort == SearchEffort::Strong ? 32 : 96;
    policy.referenceReplies = true;
    policy.candidateCap = std::min<size_t>(
        policy.candidateCap, opponentCallAllowance / std::max<uint32_t>(policy.worlds, 1));
    policy.envelope.maxFullGenCalls = 1 + policy.worlds * policy.candidateCap;
    policy.envelope.maxDeltaGenCalls = 0;
    return policy;
  }

  // Exact ReplyIndex needs one full base generation per world; every
  // candidate-local recovery is separately bounded and reported as delta.
  // The remaining full-call allowance is reserved for exact fallback if a
  // base or delta generation is incomplete.
  const uint32_t opponentCallAllowance = effort == SearchEffort::Interactive
                                             ? 8
                                             : effort == SearchEffort::Strong ? 32 : 96;
  policy.envelope.maxFullGenCalls = 1 + opponentCallAllowance;
  policy.envelope.maxDeltaGenCalls = policy.worlds * policy.candidateCap;

  if (!usesAdaptiveAllocation(variant)) return policy;

  policy.adaptive = true;
  policy.eliminate = variant == SearchVariant::ReplyIndexAdaptivePaired;
  policy.minimumWorlds = std::min<uint32_t>(policy.worlds, 3);
  policy.indifferenceMargin = ENDPOINT_SCALE / 2;
  policy.modelAllowance = RaceConfig{}.modelAllowance;
  // The ledger ceilings become the outer safety net; the credit envelope is
  // what actually stops the search, so these are sized to the world ceiling.
  policy.envelope.maxWorlds = policy.maxWorlds;
  policy.envelope.maxFullGenCalls = 1 + policy.maxWorlds + opponentCallAllowance;
  policy.envelope.maxDeltaGenCalls =
      static_cast<uint32_t>(policy.maxWorlds * policy.candidateCap);
  policy.envelope.maxMovegenNodes =
      std::max<uint64_t>(policy.envelope.maxMovegenNodes, 4 * policy.searchCostCredits);
  return policy;
}

// Re-derive the ledger ceilings from whatever the knobs now say. An override
// that widened admission or lengthened the schedule without widening the
// ceilings would not fail loudly: generations would simply be refused, replies
// would fall back or truncate, and the run would report a weaker search as if
// it were the policy under test. So the ceilings are computed in one place,
// from the final values, and never patched field by field.
void sizeEnvelope(SearchPolicy& policy) {
  const uint32_t worldCeiling = policy.adaptive ? policy.maxWorlds : policy.worlds;
  const uint32_t candidates = static_cast<uint32_t>(policy.candidateCap);
  policy.envelope.maxWorlds = worldCeiling;
  if (policy.referenceReplies) {
    policy.envelope.maxFullGenCalls = 1 + worldCeiling * candidates;
    policy.envelope.maxDeltaGenCalls = 0;
  } else {
    // One base index per world, plus headroom for the exact full-generation
    // fallback, plus one delta per candidate per world.
    policy.envelope.maxFullGenCalls = 1 + worldCeiling * 2 + 96;
    policy.envelope.maxDeltaGenCalls = worldCeiling * candidates;
  }
  if (policy.adaptive) {
    policy.envelope.maxMovegenNodes =
        std::max<uint64_t>(policy.envelope.maxMovegenNodes, 4 * policy.searchCostCredits);
  }
}

void applyOverrides(SearchPolicy& policy, const SearchOverrides& overrides) {
  bool resize = false;
  if (overrides.candidateCap != 0) {
    policy.candidateCap = overrides.candidateCap;
    resize = true;
  }
  if (overrides.worlds != 0) {
    policy.worlds = overrides.worlds;
    policy.minimumWorlds = std::min(policy.minimumWorlds, policy.worlds);
    resize = true;
  }
  if (overrides.maxWorlds != 0) {
    policy.maxWorlds = overrides.maxWorlds;
    resize = true;
  }
  if (overrides.searchCostCredits != 0) {
    policy.searchCostCredits = overrides.searchCostCredits;
    resize = true;
  }
  if (overrides.correctionEnvelope >= 0) policy.correctionEnvelope = overrides.correctionEnvelope;
  if (overrides.modelAllowance >= 0) policy.modelAllowance = overrides.modelAllowance;
  if (overrides.indifferenceMargin >= 0) policy.indifferenceMargin = overrides.indifferenceMargin;
  if (overrides.disableIndifferenceStop) policy.indifferenceMargin = 0;
  if (resize) sizeEnvelope(policy);
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

// What one more world would cost, from what the completed worlds actually
// cost. Integer arithmetic throughout, so the projection — and therefore the
// stopping point — is identical on every machine.
//
// The mean is not enough on its own. World cost is heavy-tailed: opponent racks
// differ by an order of magnitude in how many replies they generate, so a
// mean-priced world that turns out to be a big one can carry the search well
// past its envelope — measured overshoot was over 30% before this took the
// worst completed world into account. Pricing the next world at the worst one
// seen so far is conservative and still deterministic. It cannot make the bound
// absolute, because the next world can always be worse than every previous one;
// the ledger's hard ceilings remain the guarantee, and the credits are what the
// search actually aims at.
uint64_t projectedWorldCost(uint64_t baseCostSum, uint32_t baseCostWorlds,
                            uint64_t observationCostSum, uint64_t observationCount,
                            uint64_t worstWorldCost, size_t activeCandidates) {
  if (baseCostWorlds == 0 || observationCount == 0) return 0;
  const uint64_t base = baseCostSum / baseCostWorlds;
  const uint64_t perObservation = observationCostSum / observationCount;
  const uint64_t typical = base + perObservation * activeCandidates;
  return std::max(typical, worstWorldCost);
}

// True when no surviving challenger could beat the leader by more than the
// declared indifference margin. This is what lets an easy position stop early:
// the remaining candidates are not separated, but the decision between them is
// worth less than the margin, so more worlds cannot buy a better move.
bool indifferenceResolved(const PairedRace& race, int32_t indifferenceMargin) {
  if (indifferenceMargin <= 0) return false;
  const PairedGap challenger = race.closestChallenger();
  if (!challenger.ok) return false;
  return challenger.bound <= static_cast<double>(indifferenceMargin);
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

static SearchDecision decideWithVariant(const SearchQuery& query, SearchVariant variant,
                                        const SearchOverrides& overrides) {
  SearchDecision decision;
  decision.variant = variant;
  const DecisionPosition& position = query.position;
  if (position.myRack.total <= 0 || position.opponentRackCount < 0 ||
      position.physicalBagCount < 0 ||
      position.unseen.total != position.opponentRackCount + position.physicalBagCount) {
    decision.error = "invalid position inventory";
    return decision;
  }

  SearchPolicy policy = policyFor(query.effort, variant);
  applyOverrides(policy, overrides);
  decision.costCredits = policy.adaptive ? policy.searchCostCredits : 0;
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
    decision.modeledCost = modeledSearchCost(decision.work);
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

  // World `i` depends only on the position hash and its own index, so a longer
  // deck is a superset of a shorter one. Every policy compared here therefore
  // sees the same world 0, world 1, ... and candidates are compared on common
  // random numbers both within a policy and across policies.
  const uint32_t plannedWorlds = policy.adaptive ? policy.maxWorlds : policy.worlds;
  const WorldDeckResult deck =
      WorldDeck::build(position.unseen, position.opponentRackCount,
                       position.physicalBagCount,
                       canonicalPositionHash(position) ^ overrides.worldSeedSalt, 2,
                       plannedWorlds);
  if (!deck.ok) {
    decision.ok = false;
    decision.error = deck.error;
    decision.work = ledger.report();
    decision.modeledCost = modeledSearchCost(decision.work);
    return decision;
  }
  decision.worldsPlanned = plannedWorlds;

  const bool usesReplyIndex = variant != SearchVariant::SimV2Reference;
  const bool usesPairedElimination =
      variant == SearchVariant::PairedReplyIndex || policy.eliminate;
  const uint32_t eliminationStart =
      usesPairedElimination ? policy.minimumWorlds : plannedWorlds + 1;

  // Cost attribution, so the allocator can price the next world instead of
  // guessing: a world costs one base generation plus one observation per active
  // candidate, and those two have very different scaling.
  uint64_t baseCostSum = 0;
  uint32_t baseCostWorlds = 0;
  uint64_t observationCostSum = 0;
  uint64_t observationCount = 0;
  uint64_t worstWorldCost = 0;
  uint64_t deltaCostSum = 0;
  uint64_t deltaObservationCount = 0;
  uint64_t indexSizeSum = 0;
  uint32_t indexSizeCount = 0;
  StopReason stopReason =
      policy.adaptive ? StopReason::DeckExhausted : StopReason::ScheduleComplete;

  PairedRace race(candidates.size(), RaceConfig{eliminationStart, policy.modelAllowance, 2.0});
  for (uint32_t worldIndex = 0; worldIndex < deck.worlds.size(); worldIndex++) {
    if (policy.adaptive && worldIndex > 0) {
      const uint64_t spent = modeledSearchCost(ledger.report());
      if (worldIndex < policy.minimumWorlds) {
        // Still screening. The minimum batch is what makes any of the paired
        // statistics meaningful, so it is not skipped to save credits — but a
        // screening prefix that has already overrun the envelope stops here
        // rather than continuing to spend against a budget it has used up.
        if (spent >= policy.searchCostCredits) {
          stopReason = StopReason::CreditsExhausted;
          break;
        }
      } else {
        if (race.activeIndices().size() <= 1) {
          stopReason = StopReason::SingleCandidate;
          break;
        }
        if (indifferenceResolved(race, policy.indifferenceMargin)) {
          stopReason = StopReason::Indifferent;
          break;
        }
        const uint64_t projected =
            projectedWorldCost(baseCostSum, baseCostWorlds, observationCostSum, observationCount,
                               worstWorldCost, race.activeIndices().size());
        if (spent + projected > policy.searchCostCredits) {
          stopReason = StopReason::CreditsExhausted;
          break;
        }
      }
    }
    if (!ledger.reserveWorld()) {
      stopReason = StopReason::LedgerExhausted;
      break;
    }
    const uint64_t costAtWorldStart = modeledSearchCost(ledger.report());
    const uint64_t deltaNodesAtWorldStart =
        ledger.report().byPurpose[workPurposeIndex(WorkPurpose::ReplyDelta)].nodes;
    const HiddenWorld& world = deck.worlds[worldIndex];
    ReplyIndexResult replyIndex;
    if (usesReplyIndex) {
      replyIndex = ReplyIndex::build(position.board, world.opponentRack, ledger,
                                     policy.opponentNodeLimit);
    }
    const uint64_t costAfterBase = modeledSearchCost(ledger.report());

    const std::vector<size_t> active = race.activeIndices();

    // Once the index exists its size is known exactly, and it is what drives
    // the rest of the world: every active candidate revalidates every indexed
    // reply. That is the term a projection from previous worlds cannot see —
    // reply-set size varies by an order of magnitude between opponent racks, so
    // an outlier world costs a multiple of the mean no matter how many worlds
    // preceded it. Pricing the observations from this world's own index and
    // abandoning it before paying for them is the only point at which the
    // search can react.
    if (policy.adaptive && usesReplyIndex && worldIndex >= policy.minimumWorlds) {
      const uint64_t indexSize = replyIndex.basePlacements.size();
      uint64_t perObservationDelta =
          deltaObservationCount > 0 ? deltaCostSum / deltaObservationCount : 0;
      // Delta generation scales with the reply set too, so the historical mean
      // is scaled by how much larger this world's index is than the ones it was
      // measured on. Without this an outlier world is priced at the average
      // world's delta cost, which is exactly the case that overruns.
      if (indexSizeCount > 0 && indexSizeSum > 0) {
        const uint64_t meanIndexSize = indexSizeSum / indexSizeCount;
        if (meanIndexSize > 0 && indexSize > meanIndexSize)
          perObservationDelta = perObservationDelta * indexSize / meanIndexSize;
      }
      const uint64_t projectedObservations =
          active.size() * (REVALIDATION_NODE_EQUIVALENT * indexSize + perObservationDelta);
      if (costAfterBase + projectedObservations > policy.searchCostCredits) {
        ledger.discardWorld();
        stopReason = StopReason::CreditsExhausted;
        break;
      }
    }

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
      // A world whose reply set cannot be enumerated completely within the
      // envelope contributes nothing: committing a truncated row would quietly
      // hand the opponent a weaker move list in that world only. A fixed
      // schedule has no budget to recover with and stops; an adaptive one drops
      // the world and continues, because the credits it did not spend here are
      // still worth spending on a world it can finish. Dropped worlds remain
      // visible as `worldsDiscarded`.
      ledger.discardWorld();
      if (!policy.adaptive) {
        stopReason = StopReason::IncompleteWorld;
        break;
      }
      continue;
    }
    ledger.commitWorld();
    if (!race.commitBatch(row)) {
      decision.ok = false;
      decision.error = "paired race invariant failure";
      decision.work = ledger.report();
      decision.modeledCost = modeledSearchCost(decision.work);
      return decision;
    }
    const uint64_t costAtWorldEnd = modeledSearchCost(ledger.report());
    baseCostSum += costAfterBase - costAtWorldStart;
    baseCostWorlds++;
    observationCostSum += costAtWorldEnd - costAfterBase;
    observationCount += row.size();
    worstWorldCost = std::max(worstWorldCost, costAtWorldEnd - costAtWorldStart);
    deltaCostSum += ledger.report().byPurpose[workPurposeIndex(WorkPurpose::ReplyDelta)].nodes -
                    deltaNodesAtWorldStart;
    deltaObservationCount += row.size();
    if (usesReplyIndex) {
      indexSizeSum += replyIndex.basePlacements.size();
      indexSizeCount++;
    }
    for (const auto& [candidateIndex, value] : row) {
      (void)value;
      decision.candidates[candidateIndex].observations = race.observations(candidateIndex);
      decision.candidates[candidateIndex].meanValue = race.mean(candidateIndex);
    }
    if (usesPairedElimination && race.activeIndices().size() == 1) {
      stopReason = StopReason::SingleCandidate;
      break;
    }
  }

  decision.stopReason = stopReason;
  decision.eliminationRounds = race.eliminationRounds();
  decision.activeCandidatesPerRound = race.activeCountHistory();
  const PairedGap finalGap = race.closestChallenger();
  if (finalGap.ok) {
    decision.leaderChallengerKnown = true;
    decision.leaderChallengerGap = static_cast<int32_t>(std::llround(finalGap.mean));
    decision.leaderChallengerGapUpper = static_cast<int32_t>(std::llround(finalGap.bound));
    decision.leaderChallengerObservations = finalGap.observations;
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
    // A fixed schedule is complete when it ran; an adaptive one is complete
    // only when it stopped because the decision was settled. Stopping on
    // credits is a bounded search, and is reported as one.
    const bool resolved =
        policy.adaptive ? (stopReason == StopReason::SingleCandidate ||
                           stopReason == StopReason::Indifferent)
                        : (decision.worldsCompleted == policy.worlds ||
                           (usesPairedElimination && decision.activeCandidatesFinal == 1));
    decision.completion =
        root.placementEnumerationComplete && resolved
            ? Completion::Complete
            : (root.placementEnumerationComplete ? Completion::WorkLimited
                                                   : Completion::RootLimited);
  }
  decision.work = ledger.report();
  decision.modeledCost = modeledSearchCost(decision.work);
  return decision;
}

SearchDecision DecisionSearch::decide(const SearchQuery& query) {
  return decideWithVariant(query, SearchVariant::SimV2Reference, SearchOverrides{});
}

SearchDecision DecisionSearch::benchmark(const SearchQuery& query, SearchVariant variant) {
  return decideWithVariant(query, variant, SearchOverrides{});
}

SearchDecision DecisionSearch::benchmark(const SearchQuery& query, SearchVariant variant,
                                         const SearchOverrides& overrides) {
  return decideWithVariant(query, variant, overrides);
}

}  // namespace amath
