#include "opponent_search.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>
#include <vector>

namespace amath {
namespace {

TileCounts bagCounts(const SearchState& state) {
  TileCounts counts;
  for (uint8_t kind : state.bag) counts.add(kind);
  return counts;
}

int32_t fixed(float value) {
  return static_cast<int32_t>(std::lround(value * ENDPOINT_SCALE));
}

OpponentSearchResult rankReplies(const SearchState& state, std::vector<Move> moves,
                                 bool placementSetComplete) {
  OpponentSearchResult result;
  const OpponentInformationSet info = OpponentPolicyEvaluator::project(state);
  const int reserve = info.publicPhysicalBagCount + info.aetherRackCount - RACK_SIZE;
  if (reserve >= EXCHANGE_MIN_RESERVE) {
    std::vector<Move> exchanges = enumerateExchangeMultisets(info.opponentRack);
    moves.insert(moves.end(), std::make_move_iterator(exchanges.begin()),
                 std::make_move_iterator(exchanges.end()));
  }
  Move pass;
  pass.type = MoveType::Pass;
  moves.push_back(std::move(pass));

  int32_t bestValue = std::numeric_limits<int32_t>::min();
  std::string bestKey;
  for (const Move& move : moves) {
    const int32_t value = OpponentPolicyEvaluator::evaluate(info, move);
    const std::string key = canonicalMoveKey(move);
    if (value > bestValue || (value == bestValue && (bestKey.empty() || key < bestKey))) {
      bestValue = value;
      bestKey = key;
      result.move = move;
    }
  }

  result.ok = !moves.empty();
  result.complete = result.ok && placementSetComplete;
  result.canonicalKey = std::move(bestKey);
  result.policyValue = bestValue;
  result.actionsEvaluated = moves.size();
  return result;
}

}  // namespace

int32_t EndpointEvaluator::evaluate(const SearchState& state) {
  const int scoreDifference = state.scores[0] - state.scores[1];
  if (state.terminal) return scoreDifference * ENDPOINT_SCALE;

  const TileCounts bag = bagCounts(state);
  const BoardContext aContext =
      makeContext(state.board, bag, static_cast<int>(state.bag.size()), scoreDifference);
  const BoardContext bContext =
      makeContext(state.board, bag, static_cast<int>(state.bag.size()), -scoreDifference);
  return scoreDifference * ENDPOINT_SCALE + fixed(leaveValue(state.racks[0], aContext)) -
         fixed(leaveValue(state.racks[1], bContext));
}

OpponentInformationSet OpponentPolicyEvaluator::project(const SearchState& state) {
  OpponentInformationSet info;
  info.board = state.board;
  info.opponentSide = state.sideToMove;
  const int aetherSide = 1 - info.opponentSide;
  info.opponentRack = state.racks[info.opponentSide];
  info.publicUnseen = state.racks[aetherSide];
  for (uint8_t kind : state.bag) info.publicUnseen.add(kind);
  info.aetherRackCount = state.racks[aetherSide].total;
  info.publicPhysicalBagCount = static_cast<int>(state.bag.size());
  info.scores[0] = state.scores[0];
  info.scores[1] = state.scores[1];
  info.noScoreStreak = state.noScoreStreak;
  info.openingPlacementCompleted = state.openingPlacementCompleted;
  return info;
}

int32_t OpponentPolicyEvaluator::evaluate(const OpponentInformationSet& info,
                                          const Move& move) {
  const int otherSide = 1 - info.opponentSide;
  const BoardContext context =
      makeContext(info.board, info.publicUnseen, info.publicPhysicalBagCount,
                  static_cast<float>(info.scores[info.opponentSide] - info.scores[otherSide]));

  if (move.type == MoveType::Place) {
    TileCounts after = info.opponentRack;
    for (const Placement& placement : move.placements) after.sub(placement.kind);
    if (after.total == 0 && info.publicUnseen.total <= RACK_SIZE) {
      return (move.score + 2 * info.publicUnseen.points()) * ENDPOINT_SCALE;
    }
    const int drawCount = std::min<int>(RACK_SIZE - after.total,
                                        info.publicPhysicalBagCount);
    const float expectedRackEquity =
        leaveValue(after, context) + context.freshTileValue * drawCount;
    return fixed(static_cast<float>(move.score) + expectedRackEquity);
  }

  // Pass and exchange reuse the same declared leave/tempo policy. Exchange's
  // static evaluator already adds one expected fresh-tile term per return.
  return fixed(staticEquity(info.board, info.opponentRack, move, context));
}

OpponentSearchResult OpponentSearch::choose(const SearchState& state, WorkLedger& ledger,
                                            uint64_t requestedNodeLimit,
                                            WorkPurpose purpose) {
  const OpponentInformationSet info = OpponentPolicyEvaluator::project(state);
  auto permit = ledger.reserveGeneration(purpose, requestedNodeLimit);
  if (!permit) return {};

  std::vector<Move> moves;
  GenStats stats;
  stats.nodeLimit = static_cast<long long>(permit->nodeLimit);
  GenOptions options;
  options.dedup = false;
  options.premiumOrder = true;
  generatePlaceMoves(info.board, info.opponentRack, moves, &stats, options);
  const bool accounted =
      ledger.commit(*permit, static_cast<uint64_t>(stats.nodesVisited),
                    static_cast<uint64_t>(stats.movesEmitted));

  OpponentSearchResult result = rankReplies(state, std::move(moves), accounted && !stats.truncated);
  result.ok = result.ok && accounted;
  result.nodes = static_cast<uint64_t>(stats.nodesVisited);
  result.emittedAssignments = static_cast<uint64_t>(stats.movesEmitted);
  return result;
}

OpponentSearchResult OpponentSearch::chooseFromPlacements(
    const SearchState& state, const std::vector<Move>& placements,
    bool placementSetComplete) {
  return rankReplies(state, placements, placementSetComplete);
}

}  // namespace amath
