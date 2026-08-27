#pragma once

#include <cstdint>
#include <string>

#include "eval.hpp"
#include "root_catalogue.hpp"
#include "state_transition.hpp"
#include "work_ledger.hpp"

namespace amath {

inline constexpr int ENDPOINT_SCALE = 1000;

struct OpponentInformationSet {
  Board board;
  TileCounts opponentRack;
  TileCounts publicUnseen;
  int aetherRackCount = 0;
  int publicPhysicalBagCount = 0;
  int scores[2] = {0, 0};
  int opponentSide = 1;
  int noScoreStreak = 0;
  bool openingPlacementCompleted = false;
};

class EndpointEvaluator {
 public:
  static int32_t evaluate(const SearchState& state);
};

class OpponentPolicyEvaluator {
 public:
  static OpponentInformationSet project(const SearchState& state);
  static int32_t evaluate(const OpponentInformationSet& info, const Move& move);

  // The board context is a property of the information set, not of the move
  // being scored, so a ranking loop builds it once. `evaluate` above is the
  // same function with the context built inline, kept for single-move callers.
  static BoardContext context(const OpponentInformationSet& info);
  static int32_t evaluate(const OpponentInformationSet& info, const BoardContext& context,
                          const Move& move);
};

struct OpponentSearchResult {
  bool ok = false;
  bool complete = false;
  Move move;
  std::string canonicalKey;
  int32_t policyValue = 0;
  uint64_t nodes = 0;
  uint64_t emittedAssignments = 0;
  uint64_t actionsEvaluated = 0;
};

class OpponentSearch {
 public:
  static OpponentSearchResult choose(const SearchState& state, WorkLedger& ledger,
                                     uint64_t requestedNodeLimit,
                                     WorkPurpose purpose = WorkPurpose::OpponentReference);

  static OpponentSearchResult chooseFromPlacements(const SearchState& state,
                                                   const std::vector<Move>& placements,
                                                   bool placementSetComplete);
};

}  // namespace amath
