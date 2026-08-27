#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "movegen.hpp"
#include "work_ledger.hpp"

namespace amath {

struct RootAction {
  Move move;
  std::string canonicalKey;
};

struct RootCatalogueResult {
  std::vector<RootAction> actions;
  bool placementEnumerationComplete = false;
  uint64_t nodes = 0;
  uint64_t emittedAssignments = 0;
};

std::string canonicalMoveKey(const Move& move);
std::vector<Move> enumerateExchangeMultisets(const TileCounts& rack);

class RootCatalogue {
 public:
  static RootCatalogueResult build(const Board& board, const TileCounts& rack,
                                   int physicalBagCount, int opponentRackCount,
                                   WorkLedger& ledger, uint64_t requestedNodeLimit);
};

}  // namespace amath
