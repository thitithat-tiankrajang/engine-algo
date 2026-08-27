#include "root_catalogue.hpp"

#include <algorithm>
#include <functional>
#include <string>

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

// Decimal formatting of one small non-negative field, byte-for-byte what
// `ostringstream << int` produced. The key is a total order used for every
// deterministic tie-break in the engine, so its BYTES are load-bearing: any
// change to the encoding silently reorders equal-value moves and changes which
// move the search returns.
void appendDecimal(std::string& out, unsigned value) {
  char digits[3];
  int length = 0;
  do {
    digits[length++] = static_cast<char>('0' + value % 10);
    value /= 10;
  } while (value != 0);
  while (length > 0) out.push_back(digits[--length]);
}

bool placementPrecedes(const Placement& a, const Placement& b) {
  if (a.row != b.row) return a.row < b.row;
  if (a.col != b.col) return a.col < b.col;
  if (a.kind != b.kind) return a.kind < b.kind;
  return a.token < b.token;
}

}  // namespace

std::vector<Move> enumerateExchangeMultisets(const TileCounts& rack) {
  std::vector<Move> moves;
  buildExchangeMultisets(rack, moves);
  return moves;
}

// Hot: called once per reply per candidate per world. The previous
// ostringstream implementation was 26% of a Deep decision's CPU on its own
// (locale lookup and num_put dominate), which is why this hand-formats into a
// reserved buffer and sorts an index array instead of copying the placements.
std::string canonicalMoveKey(const Move& move) {
  std::string out;
  appendDecimal(out, static_cast<unsigned>(move.type));
  out.push_back(':');

  if (move.type == MoveType::Place) {
    const size_t count = move.placements.size();
    out.reserve(out.size() + count * 12);
    // A placement set is at most one rack, so the ordering runs in a stack
    // buffer. The oversized case keeps the general path rather than truncating.
    if (count <= RACK_SIZE) {
      uint8_t order[RACK_SIZE];
      for (size_t i = 0; i < count; i++) order[i] = static_cast<uint8_t>(i);
      for (size_t i = 1; i < count; i++) {
        const uint8_t held = order[i];
        size_t j = i;
        while (j > 0 && placementPrecedes(move.placements[held], move.placements[order[j - 1]])) {
          order[j] = order[j - 1];
          j--;
        }
        order[j] = held;
      }
      for (size_t i = 0; i < count; i++) {
        const Placement& placement = move.placements[order[i]];
        appendDecimal(out, placement.row);
        out.push_back(',');
        appendDecimal(out, placement.col);
        out.push_back(',');
        appendDecimal(out, placement.kind);
        out.push_back(',');
        appendDecimal(out, placement.token);
        out.push_back(';');
      }
    } else {
      std::vector<Placement> placements = move.placements;
      std::sort(placements.begin(), placements.end(), placementPrecedes);
      for (const Placement& placement : placements) {
        appendDecimal(out, placement.row);
        out.push_back(',');
        appendDecimal(out, placement.col);
        out.push_back(',');
        appendDecimal(out, placement.kind);
        out.push_back(',');
        appendDecimal(out, placement.token);
        out.push_back(';');
      }
    }
  } else if (move.type == MoveType::Exchange) {
    std::vector<uint8_t> kinds = move.exchangeKinds;
    std::sort(kinds.begin(), kinds.end());
    out.reserve(out.size() + kinds.size() * 3);
    for (uint8_t kind : kinds) {
      appendDecimal(out, kind);
      out.push_back(',');
    }
  }
  return out;
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
