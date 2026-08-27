#include "paired_race.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace amath {

PairedRace::PairedRace(size_t candidateCount, RaceConfig config)
    : config_(config), active_(candidateCount, true), values_(candidateCount) {}

bool PairedRace::commitBatch(
    const std::vector<std::pair<size_t, int32_t>>& observations) {
  if (invariantFailure_) return false;
  const std::vector<size_t> expected = activeIndices();
  if (observations.size() != expected.size()) {
    invariantFailure_ = true;
    return false;
  }

  std::vector<bool> seen(active_.size(), false);
  for (const auto& [candidate, value] : observations) {
    (void)value;
    if (candidate >= active_.size() || !active_[candidate] || seen[candidate]) {
      invariantFailure_ = true;
      return false;
    }
    seen[candidate] = true;
  }
  for (size_t candidate : expected) {
    if (!seen[candidate]) {
      invariantFailure_ = true;
      return false;
    }
  }

  for (const auto& [candidate, value] : observations) values_[candidate].push_back(value);
  completedBatches_++;
  const size_t before = expected.size();
  if (completedBatches_ >= config_.minimumBatches) eliminateSeparatedCandidates();
  const size_t after = activeIndices().size();
  if (after < before) eliminationRounds_++;
  activeCountHistory_.push_back(static_cast<uint32_t>(after));
  return true;
}

PairedGap PairedRace::gapAgainstLeader(size_t candidate) const {
  return gapAgainst(candidate, leader());
}

PairedGap PairedRace::gapAgainst(size_t candidate, size_t best) const {
  PairedGap gap;
  if (best >= active_.size() || candidate >= values_.size() || candidate == best) return gap;

  const size_t count = std::min(values_[candidate].size(), values_[best].size());
  if (count == 0) return gap;

  double sum = 0.0;
  for (size_t i = 0; i < count; i++) sum += values_[candidate][i] - values_[best][i];
  const double pairedMean = sum / count;
  double variance = 0.0;
  if (count > 1) {
    for (size_t i = 0; i < count; i++) {
      const double difference = values_[candidate][i] - values_[best][i];
      variance += (difference - pairedMean) * (difference - pairedMean);
    }
    variance /= count - 1;
  }
  gap.ok = true;
  gap.candidate = candidate;
  gap.observations = static_cast<uint32_t>(count);
  gap.mean = pairedMean;
  gap.standardError = std::sqrt(variance / count);
  gap.bound = pairedMean + config_.standardErrorMultiplier * gap.standardError;
  gap.upper = gap.bound + config_.modelAllowance;
  return gap;
}

// The active candidate whose paired difference is least separated from the
// leader: the one another world is most likely to be decided by.
PairedGap PairedRace::closestChallenger() const {
  PairedGap closest;
  const size_t best = leader();
  for (size_t candidate = 0; candidate < active_.size(); candidate++) {
    if (!active_[candidate] || candidate == best) continue;
    const PairedGap gap = gapAgainstLeader(candidate);
    if (!gap.ok) continue;
    if (!closest.ok || gap.upper > closest.upper) closest = gap;
  }
  return closest;
}

std::vector<size_t> PairedRace::activeIndices() const {
  std::vector<size_t> indices;
  for (size_t i = 0; i < active_.size(); i++) {
    if (active_[i]) indices.push_back(i);
  }
  return indices;
}

int32_t PairedRace::mean(size_t candidate) const {
  if (candidate >= values_.size() || values_[candidate].empty()) return 0;
  int64_t sum = 0;
  for (int32_t value : values_[candidate]) sum += value;
  return static_cast<int32_t>(sum / static_cast<int64_t>(values_[candidate].size()));
}

uint32_t PairedRace::observations(size_t candidate) const {
  return candidate < values_.size() ? static_cast<uint32_t>(values_[candidate].size()) : 0;
}

size_t PairedRace::leader() const {
  size_t best = active_.size();
  int32_t bestMean = std::numeric_limits<int32_t>::min();
  for (size_t candidate = 0; candidate < active_.size(); candidate++) {
    if (!active_[candidate]) continue;
    const int32_t candidateMean = mean(candidate);
    if (best == active_.size() || candidateMean > bestMean) {
      best = candidate;
      bestMean = candidateMean;
    }
  }
  return best;
}

void PairedRace::eliminateSeparatedCandidates() {
  const size_t best = leader();
  if (best >= active_.size()) return;

  // Only non-leaders are deactivated, so `best` remains the leader throughout
  // and every candidate in this round is judged against the same baseline.
  for (size_t candidate = 0; candidate < active_.size(); candidate++) {
    if (!active_[candidate] || candidate == best) continue;
    const PairedGap gap = gapAgainst(candidate, best);
    if (!gap.ok || gap.observations < config_.minimumBatches) continue;
    if (gap.upper < 0.0) active_[candidate] = false;
  }
}

}  // namespace amath
