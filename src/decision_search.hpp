#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "opponent_search.hpp"
#include "world_deck.hpp"

namespace amath {

enum class SearchEffort : uint8_t {
  Instant,
  Interactive,
  Strong,
  Deep,
};

// All variants share transitions, worlds, objective, opponent policy, and root
// scope. Only reply generation/allocation changes, so optimized paths can be
// compared bit-for-bit with the reference behind one DecisionSearch seam.
//
// The first three are frozen: their published baselines are the oracles the
// optimized policies are judged against, so their behaviour must not drift.
// The adaptive pair replaces the fixed world count with a deterministic cost
// envelope, which is the only way an allocation policy can spend the work it
// saves rather than merely not spending it.
enum class SearchVariant : uint8_t {
  SimV2Reference,
  ReplyIndexUniform,
  PairedReplyIndex,
  ReplyIndexAdaptiveUniform,
  ReplyIndexAdaptivePaired,
};

inline constexpr bool usesAdaptiveAllocation(SearchVariant variant) {
  return variant == SearchVariant::ReplyIndexAdaptiveUniform ||
         variant == SearchVariant::ReplyIndexAdaptivePaired;
}

// Why the world loop stopped. Distinguishing "resolved" from "ran out" is the
// difference between a Deep decision that finished thinking and one that was
// cut off, and the two must never be reported as the same outcome.
enum class StopReason : uint8_t {
  ScheduleComplete,
  SingleCandidate,
  Indifferent,
  CreditsExhausted,
  DeckExhausted,
  LedgerExhausted,
  IncompleteWorld,
};

enum class SearchMethod : uint8_t {
  Static,
  PairedOpponentSearch,
  ExactEndgame,
  CompleteHiddenEndgame,
};

enum class ValueKind : uint8_t {
  StaticEquity,
  ExpectedEquity,
  ProvenFinalMargin,
  CompleteWinProbability,
};

enum class Completion : uint8_t {
  Complete,
  RootLimited,
  WorkLimited,
};

enum class ReferenceRootScope : uint8_t {
  Exhaustive,
  FrozenSubset,
};

struct DecisionPosition {
  Board board;
  TileCounts myRack;
  TileCounts unseen;
  int physicalBagCount = 0;
  int opponentRackCount = 0;
  int myScore = 0;
  int opponentScore = 0;
  int noScoreStreak = 0;
  bool openingPlacementCompleted = false;
};

struct SearchQuery {
  DecisionPosition position;
  SearchEffort effort = SearchEffort::Interactive;
};

struct CandidateEvidence {
  Move move;
  std::string canonicalKey;
  int32_t staticValue = 0;
  int32_t meanValue = 0;
  uint32_t observations = 0;
};

// Benchmark-only knobs. They exist so an experiment can hold admission and the
// world schedule fixed while changing one thing, and so the harness can build
// the wider oracle runs G6 and G7 are measured against. Nothing in the product
// path can reach these: `decide` does not take them.
struct SearchOverrides {
  uint32_t candidateCap = 0;         // 0 keeps the effort's own cap
  uint32_t worlds = 0;               // 0 keeps the effort's own fixed schedule
  uint32_t maxWorlds = 0;            // 0 keeps the adaptive ceiling
  uint64_t searchCostCredits = 0;    // 0 keeps the adaptive credit envelope
  int32_t correctionEnvelope = -1;   // <0 keeps the effort's admission envelope
  int32_t modelAllowance = -1;       // <0 keeps the registered elimination allowance
  int32_t indifferenceMargin = -1;   // <0 keeps the policy stopping margin
  uint64_t worldSeedSalt = 0;        // re-rolls the shared world schedule
  bool disableIndifferenceStop = false;
};

struct SearchDecision {
  bool ok = false;
  std::string error;
  Move move;
  int32_t value = 0;
  SearchMethod method = SearchMethod::Static;
  ValueKind valueKind = ValueKind::StaticEquity;
  Completion completion = Completion::WorkLimited;
  StopReason stopReason = StopReason::ScheduleComplete;
  bool proven = false;
  SearchVariant variant = SearchVariant::SimV2Reference;
  bool rootComplete = false;
  ReferenceRootScope rootScope = ReferenceRootScope::FrozenSubset;
  std::string rootScopeFingerprint;
  uint32_t rootPlacementCount = 0;
  uint32_t rootExchangeCount = 0;
  uint32_t rootPassCount = 0;
  uint32_t admittedPlacementCount = 0;
  uint32_t admittedExchangeCount = 0;
  uint32_t admittedPassCount = 0;
  uint32_t worldsPlanned = 0;
  uint32_t worldsCompleted = 0;
  uint32_t activeCandidatesFinal = 0;
  uint32_t eliminationRounds = 0;
  std::vector<uint32_t> activeCandidatesPerRound;

  // The unresolved margin the search stopped on, in endpoint fixed point.
  // `leaderChallengerGap` is the paired mean of (challenger - leader), so it is
  // negative when the leader is ahead; `...Upper` adds the same allowance the
  // elimination rule uses. Together they say whether one more world could still
  // have changed the answer.
  bool leaderChallengerKnown = false;
  int32_t leaderChallengerGap = 0;
  int32_t leaderChallengerGapUpper = 0;
  uint32_t leaderChallengerObservations = 0;

  // Deterministic modelled cost actually spent, and the envelope it was spent
  // against. Both are counts, never wall clock.
  uint64_t modeledCost = 0;
  uint64_t costCredits = 0;
  WorkReport work;
  std::vector<CandidateEvidence> candidates;
};

// Deterministic cost model. Movegen nodes alone understate a ReplyIndex
// decision, because revalidating the base index against each candidate board is
// real work the node counter never sees: measured on the Deep corpus it is
// about 30% of the time at roughly 154 nodes per revalidation, hence the
// node-equivalent weight below. The constant is frozen policy, so two runs of
// the same query spend identical credits on any machine.
inline constexpr uint64_t REVALIDATION_NODE_EQUIVALENT = 48;

inline uint64_t modeledSearchCost(const WorkReport& report) {
  return report.movegenNodes + REVALIDATION_NODE_EQUIVALENT * report.replyRevalidations;
}

class DecisionSearch {
 public:
  static SearchDecision decide(const SearchQuery& query);

  // Benchmark-only comparison seam. Product tiers call decide() and cannot
  // select an experimental implementation through SearchQuery.
  static SearchDecision benchmark(const SearchQuery& query, SearchVariant variant);
  static SearchDecision benchmark(const SearchQuery& query, SearchVariant variant,
                                  const SearchOverrides& overrides);
};

}  // namespace amath
