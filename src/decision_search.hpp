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
enum class SearchVariant : uint8_t {
  SimV2Reference,
  ReplyIndexUniform,
  PairedReplyIndex,
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

struct SearchDecision {
  bool ok = false;
  std::string error;
  Move move;
  int32_t value = 0;
  SearchMethod method = SearchMethod::Static;
  ValueKind valueKind = ValueKind::StaticEquity;
  Completion completion = Completion::WorkLimited;
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
  uint32_t worldsCompleted = 0;
  uint32_t activeCandidatesFinal = 0;
  WorkReport work;
  std::vector<CandidateEvidence> candidates;
};

class DecisionSearch {
 public:
  static SearchDecision decide(const SearchQuery& query);

  // Benchmark-only comparison seam. Product tiers call decide() and cannot
  // select an experimental implementation through SearchQuery.
  static SearchDecision benchmark(const SearchQuery& query, SearchVariant variant);
};

}  // namespace amath
