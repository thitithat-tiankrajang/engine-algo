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

 private:
  void eliminateSeparatedCandidates();

  RaceConfig config_;
  std::vector<bool> active_;
  std::vector<std::vector<int32_t>> values_;
  uint32_t completedBatches_ = 0;
  bool invariantFailure_ = false;
};

}  // namespace amath
