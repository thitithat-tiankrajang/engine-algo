#include "reply_index.hpp"

#include <map>
#include <utility>

namespace amath {
namespace {

void markRow(MovegenStartMasks& masks, int row) {
  if (row < 0 || row >= BOARD_SIZE) return;
  for (int col = 0; col < BOARD_SIZE; col++) masks.horizontal[Board::idx(row, col)] = 1;
}

void markColumn(MovegenStartMasks& masks, int col) {
  if (col < 0 || col >= BOARD_SIZE) return;
  for (int row = 0; row < BOARD_SIZE; row++) masks.vertical[Board::idx(row, col)] = 1;
}

MovegenStartMasks dependencyStartMasks(const Board& board,
                                       const std::vector<Placement>& candidate) {
  MovegenStartMasks masks;
  for (const Placement& placement : candidate) {
    // Replies whose main equation contains a candidate tile.
    markRow(masks, placement.row);
    markColumn(masks, placement.col);

    // Horizontal replies can depend on a candidate through a vertical cross
    // equation only at either empty end of the occupied run containing it.
    int row = placement.row;
    while (row >= 0 && board.at(row, placement.col).occupied()) row--;
    markRow(masks, row);
    row = placement.row;
    while (row < BOARD_SIZE && board.at(row, placement.col).occupied()) row++;
    markRow(masks, row);

    // Vertical replies have the symmetric horizontal-cross dependency.
    int col = placement.col;
    while (col >= 0 && board.at(placement.row, col).occupied()) col--;
    markColumn(masks, col);
    col = placement.col;
    while (col < BOARD_SIZE && board.at(placement.row, col).occupied()) col++;
    markColumn(masks, col);
  }
  return masks;
}

}  // namespace

ReplyIndexResult ReplyIndex::build(const Board& baseBoard, const TileCounts& opponentRack,
                                   WorkLedger& ledger, uint64_t requestedNodeLimit) {
  ReplyIndexResult result;
  auto permit = ledger.reserveGeneration(WorkPurpose::ReplyIndexBase, requestedNodeLimit);
  if (!permit) return result;

  GenStats stats;
  stats.nodeLimit = static_cast<long long>(permit->nodeLimit);
  GenOptions options;
  options.dedup = false;
  options.premiumOrder = true;
  generatePlaceMoves(baseBoard, opponentRack, result.basePlacements, &stats, options);
  const bool accounted =
      ledger.commit(*permit, static_cast<uint64_t>(stats.nodesVisited),
                    static_cast<uint64_t>(stats.movesEmitted));
  result.complete = accounted && !stats.truncated;
  result.nodes = static_cast<uint64_t>(stats.nodesVisited);
  result.emittedAssignments = static_cast<uint64_t>(stats.movesEmitted);
  return result;
}

ReplySet ReplyIndex::recover(const ReplyIndexResult& index, const Board& boardAfterCandidate,
                             const std::vector<Placement>& candidatePlacements,
                             const TileCounts& opponentRack, WorkLedger& ledger,
                             uint64_t requestedDeltaNodeLimit) {
  ReplySet result;
  std::map<std::string, Move> merged;
  for (const Move& indexed : index.basePlacements) {
    const MoveValidation validation = validatePlaceMove(boardAfterCandidate, indexed.placements);
    result.revalidated++;
    if (!validation.valid) continue;
    Move move = indexed;
    move.score = validation.score;
    merged[canonicalMoveKey(move)] = std::move(move);
  }
  ledger.chargeReplyRevalidation(result.revalidated);

  bool deltaComplete = true;
  if (!candidatePlacements.empty()) {
    auto permit = ledger.reserveGeneration(WorkPurpose::ReplyDelta, requestedDeltaNodeLimit);
    if (!permit) {
      deltaComplete = false;
    } else {
      const MovegenStartMasks masks =
          dependencyStartMasks(boardAfterCandidate, candidatePlacements);
      std::vector<Move> delta;
      GenStats stats;
      stats.nodeLimit = static_cast<long long>(permit->nodeLimit);
      GenOptions options;
      options.dedup = false;
      options.premiumOrder = true;
      options.allowedStarts = &masks;
      generatePlaceMoves(boardAfterCandidate, opponentRack, delta, &stats, options);
      const bool accounted =
          ledger.commit(*permit, static_cast<uint64_t>(stats.nodesVisited),
                        static_cast<uint64_t>(stats.movesEmitted));
      deltaComplete = accounted && !stats.truncated;
      result.deltaNodes = static_cast<uint64_t>(stats.nodesVisited);
      result.deltaAssignments = static_cast<uint64_t>(stats.movesEmitted);
      for (Move& move : delta) merged[canonicalMoveKey(move)] = std::move(move);
    }
  }

  result.placements.reserve(merged.size());
  for (auto& [key, move] : merged) result.placements.push_back(std::move(move));
  result.complete = index.complete && deltaComplete;
  return result;
}

}  // namespace amath
