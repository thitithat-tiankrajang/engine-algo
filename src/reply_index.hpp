#pragma once

#include <cstdint>
#include <vector>

#include "root_catalogue.hpp"
#include "work_ledger.hpp"

namespace amath {

struct ReplyIndexResult {
  std::vector<Move> basePlacements;
  bool complete = false;
  uint64_t nodes = 0;
  uint64_t emittedAssignments = 0;
};

struct ReplySet {
  std::vector<Move> placements;
  bool complete = false;
  uint64_t revalidated = 0;
  uint64_t deltaNodes = 0;
  uint64_t deltaAssignments = 0;
};

class ReplyIndex {
 public:
  static ReplyIndexResult build(const Board& baseBoard, const TileCounts& opponentRack,
                                WorkLedger& ledger, uint64_t requestedNodeLimit);

  static ReplySet recover(const ReplyIndexResult& index, const Board& boardAfterCandidate,
                          const std::vector<Placement>& candidatePlacements,
                          const TileCounts& opponentRack, WorkLedger& ledger,
                          uint64_t requestedDeltaNodeLimit);
};

}  // namespace amath
