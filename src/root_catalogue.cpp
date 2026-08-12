#include "root_catalogue.hpp"

#include <algorithm>
#include <functional>
#include <sstream>

#include "tiles.hpp"

namespace amath {
namespace {

void buildExchangeMultisets(const TileCounts& rack, std::vector<Move>& out) {
  std::vector<uint8_t> selected;
  std::function<void(int)> visit = [&](int kind) {
    if (kind == KIND_COUNT) {
      if (!selected.empty()) {
        Move move;
        move.type = MoveType::Exchange;
        move.exchangeKinds = selected;
        out.push_back(std::move(move));
      }
      return;
    }
    const size_t priorSize = selected.size();
    for (int count = 0; count <= rack.n[kind]; count++) {
      visit(kind + 1);
      selected.push_back(static_cast<uint8_t>(kind));
    }
    selected.resize(priorSize);
  };
  visit(0);
}

}  // namespace

std::vector<Move> enumerateExchangeMultisets(const TileCounts& rack) {
  std::vector<Move> moves;
  buildExchangeMultisets(rack, moves);
  return moves;
}

std::string canonicalMoveKey(const Move& move) {
  std::ostringstream out;
  out << static_cast<int>(move.type) << ':';
  if (move.type == MoveType::Place) {
    std::vector<Placement> placements = move.placements;
    std::sort(placements.begin(), placements.end(), [](const Placement& a, const Placement& b) {
      if (a.row != b.row) return a.row < b.row;
      if (a.col != b.col) return a.col < b.col;
      if (a.kind != b.kind) return a.kind < b.kind;
      return a.token < b.token;
    });
    for (const Placement& placement : placements) {
      out << static_cast<int>(placement.row) << ',' << static_cast<int>(placement.col) << ','
          << static_cast<int>(placement.kind) << ',' << static_cast<int>(placement.token) << ';';
    }
  } else if (move.type == MoveType::Exchange) {
    std::vector<uint8_t> kinds = move.exchangeKinds;
    std::sort(kinds.begin(), kinds.end());
    for (uint8_t kind : kinds) out << static_cast<int>(kind) << ',';
  }
  return out.str();
}

RootCatalogueResult RootCatalogue::build(const Board& board, const TileCounts& rack,
                                         int physicalBagCount, int opponentRackCount,
                                         WorkLedger& ledger, uint64_t requestedNodeLimit) {
  RootCatalogueResult result;

  auto permit = ledger.reserveGeneration(WorkPurpose::Root, requestedNodeLimit);
  if (permit) {
    std::vector<Move> placements;
    GenStats stats;
    stats.nodeLimit = static_cast<long long>(permit->nodeLimit);
    GenOptions options;
    options.dedup = false;
    options.premiumOrder = true;
    generatePlaceMoves(board, rack, placements, &stats, options);
    const bool accounted =
        ledger.commit(*permit, static_cast<uint64_t>(stats.nodesVisited),
                      static_cast<uint64_t>(stats.movesEmitted));
    result.nodes = static_cast<uint64_t>(stats.nodesVisited);
    result.emittedAssignments = placements.size();
    result.placementEnumerationComplete = accounted && !stats.truncated;
    for (Move& move : placements) {
      move.type = MoveType::Place;
      result.actions.push_back({std::move(move), {}});
    }
  }

  const int reserve = physicalBagCount + opponentRackCount - RACK_SIZE;
  if (reserve >= EXCHANGE_MIN_RESERVE) {
    std::vector<Move> exchanges = enumerateExchangeMultisets(rack);
    for (Move& move : exchanges) result.actions.push_back({std::move(move), {}});
  }

  Move pass;
  pass.type = MoveType::Pass;
  result.actions.push_back({std::move(pass), {}});

  for (RootAction& action : result.actions) action.canonicalKey = canonicalMoveKey(action.move);
  std::sort(result.actions.begin(), result.actions.end(),
            [](const RootAction& a, const RootAction& b) {
              return a.canonicalKey < b.canonicalKey;
            });
  return result;
}

}  // namespace amath
