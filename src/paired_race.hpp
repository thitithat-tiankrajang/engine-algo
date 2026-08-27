#pragma once

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace amath {

struct RaceConfig {
  uint32_t minimumBatches = 2;
  int32_t modelAllowance = 3000;
  double standardErrorMultiplier = 2.0;
};

// A paired difference against the current leader, in endpoint fixed point.
// `mean` is negative when the candidate trails.
//
// `bound` is mean + k*standardError: how much better than the leader this
// candidate could still turn out to be, and therefore the regret an allocator
// accepts by stopping now. `upper` adds the pre-registered model allowance and
// is the elimination statistic. Keeping them apart matters: elimination has to
// be conservative about discarding a move, while a stopping rule has to be
// honest about the risk it is taking.
struct PairedGap {
  bool ok = false;
  size_t candidate = 0;
  uint32_t observations = 0;
  double mean = 0.0;
  double standardError = 0.0;
  double bound = 0.0;
  double upper = 0.0;
};

class PairedRace {
 public:
  explicit PairedRace(size_t candidateCount, RaceConfig config = {});

  // A batch must contain each currently-active candidate exactly once.
  bool commitBatch(const std::vector<std::pair<size_t, int32_t>>& observations);

  std::vector<size_t> activeIndices() const;
  size_t leader() const;
  int32_t mean(size_t candidate) const;
  uint32_t observations(size_t candidate) const;
  uint32_t completedBatches() const { return completedBatches_; }
  bool invariantFailure() const { return invariantFailure_; }

  // Allocation and reporting surface. `gapAgainstLeader` is the same statistic
  // elimination uses, exposed so a work allocator can decide whether another
  // world can still change the answer, and so a benchmark can report why the
  // search stopped.
  PairedGap gapAgainstLeader(size_t candidate) const;
  PairedGap closestChallenger() const;
  uint32_t eliminationRounds() const { return eliminationRounds_; }
  const std::vector<uint32_t>& activeCountHistory() const { return activeCountHistory_; }
  bool wasEliminated(size_t candidate) const {
    return candidate < active_.size() && !active_[candidate];
  }

 private:
  void eliminateSeparatedCandidates();
  PairedGap gapAgainst(size_t candidate, size_t best) const;

  RaceConfig config_;
  std::vector<bool> active_;
  std::vector<std::vector<int32_t>> values_;
  std::vector<uint32_t> activeCountHistory_;
  uint32_t completedBatches_ = 0;
  uint32_t eliminationRounds_ = 0;
  bool invariantFailure_ = false;
};

}  // namespace amath
