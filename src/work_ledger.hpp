#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace amath {

enum class WorkPurpose : uint8_t {
  Root,
  OpponentReference,
  ReplyIndexBase,
  ReplyDelta,
  ReplyFallback,
  SelectiveThirdPly,
  ExactEndgame,
  Count,
};

inline constexpr size_t WORK_PURPOSE_COUNT = static_cast<size_t>(WorkPurpose::Count);

inline constexpr size_t workPurposeIndex(WorkPurpose purpose) {
  return static_cast<size_t>(purpose);
}

inline constexpr bool isDeltaPurpose(WorkPurpose purpose) {
  return purpose == WorkPurpose::ReplyDelta;
}

struct WorkEnvelope {
  uint32_t maxFullGenCalls = 0;
  uint32_t maxDeltaGenCalls = 0;
  uint64_t maxMovegenNodes = 0;
  uint64_t maxEndgameNodes = 0;
  uint32_t maxWorlds = 0;
};

struct PurposeWorkReport {
  uint32_t calls = 0;
  uint64_t nodes = 0;
  uint64_t movesEmitted = 0;
};

struct WorkReport {
  uint32_t fullGenCalls = 0;
  uint32_t deltaGenCalls = 0;
  uint64_t movegenNodes = 0;
  uint64_t endgameNodes = 0;
  uint64_t movesEmitted = 0;
  uint64_t transitions = 0;
  uint64_t replyRevalidations = 0;
  uint64_t staticEvaluations = 0;
  uint64_t opponentPolicyEvaluations = 0;
  uint64_t endpointEvaluations = 0;
  uint32_t worldsCompleted = 0;
  uint32_t worldsDiscarded = 0;
  bool exhausted = false;
  bool invariantFailure = false;
  std::array<PurposeWorkReport, WORK_PURPOSE_COUNT> byPurpose{};
};

struct GenerationPermit {
  WorkPurpose purpose = WorkPurpose::Root;
  uint64_t nodeLimit = 0;

 private:
  uint64_t id = 0;
  friend class WorkLedger;
};

class WorkLedger {
 public:
  explicit WorkLedger(WorkEnvelope envelope) : envelope_(envelope) {}

  std::optional<GenerationPermit> reserveGeneration(WorkPurpose purpose,
                                                     uint64_t requestedNodeLimit) {
    if (report_.invariantFailure || activePermitId_ != 0 || purpose == WorkPurpose::Count) {
      report_.invariantFailure = true;
      return std::nullopt;
    }

    const bool delta = isDeltaPurpose(purpose);
    const uint32_t calls = delta ? report_.deltaGenCalls : report_.fullGenCalls;
    const uint32_t callLimit = delta ? envelope_.maxDeltaGenCalls : envelope_.maxFullGenCalls;
    const uint64_t remainingNodes =
        report_.movegenNodes < envelope_.maxMovegenNodes
            ? envelope_.maxMovegenNodes - report_.movegenNodes
            : 0;
    if (calls >= callLimit || remainingNodes == 0) {
      report_.exhausted = true;
      return std::nullopt;
    }

    GenerationPermit permit;
    permit.purpose = purpose;
    permit.nodeLimit = requestedNodeLimit == 0 ? remainingNodes
                                               : (requestedNodeLimit < remainingNodes
                                                      ? requestedNodeLimit
                                                      : remainingNodes);
    permit.id = nextPermitId_++;
    activePermitId_ = permit.id;
    if (delta)
      report_.deltaGenCalls++;
    else
      report_.fullGenCalls++;
    report_.byPurpose[workPurposeIndex(purpose)].calls++;
    return permit;
  }

  bool commit(GenerationPermit& permit, uint64_t nodes, uint64_t movesEmitted) {
    if (permit.id == 0 || permit.id != activePermitId_) {
      report_.invariantFailure = true;
      return false;
    }

    activePermitId_ = 0;
    permit.id = 0;
    PurposeWorkReport& purpose = report_.byPurpose[workPurposeIndex(permit.purpose)];
    purpose.nodes += nodes;
    purpose.movesEmitted += movesEmitted;
    report_.movegenNodes += nodes;
    report_.movesEmitted += movesEmitted;

    if (nodes > permit.nodeLimit || report_.movegenNodes > envelope_.maxMovegenNodes) {
      report_.invariantFailure = true;
      return false;
    }
    if (report_.movegenNodes == envelope_.maxMovegenNodes) report_.exhausted = true;
    return true;
  }

  bool reserveWorld() {
    if (worldReserved_) {
      report_.invariantFailure = true;
      return false;
    }
    if (report_.worldsCompleted >= envelope_.maxWorlds) {
      report_.exhausted = true;
      return false;
    }
    worldReserved_ = true;
    return true;
  }

  bool commitWorld() {
    if (!worldReserved_) {
      report_.invariantFailure = true;
      return false;
    }
    worldReserved_ = false;
    report_.worldsCompleted++;
    if (report_.worldsCompleted == envelope_.maxWorlds) report_.exhausted = true;
    return true;
  }

  void discardWorld() {
    if (!worldReserved_) {
      report_.invariantFailure = true;
      return;
    }
    worldReserved_ = false;
    report_.worldsDiscarded++;
  }

  void chargeTransition(uint64_t count = 1) { report_.transitions += count; }
  void chargeReplyRevalidation(uint64_t count = 1) {
    report_.replyRevalidations += count;
  }
  void chargeStaticEvaluation(uint64_t count = 1) {
    report_.staticEvaluations += count;
  }
  void chargeOpponentPolicyEvaluation(uint64_t count = 1) {
    report_.opponentPolicyEvaluations += count;
  }
  void chargeEndpointEvaluation(uint64_t count = 1) {
    report_.endpointEvaluations += count;
  }

  const WorkEnvelope& envelope() const { return envelope_; }
  WorkReport report() const { return report_; }

 private:
  WorkEnvelope envelope_;
  WorkReport report_;
  uint64_t nextPermitId_ = 1;
  uint64_t activePermitId_ = 0;
  bool worldReserved_ = false;
};

}  // namespace amath
