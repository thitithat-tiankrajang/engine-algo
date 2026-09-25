// A gradient-boosted regression forest, walked over a buffer nobody had to parse.
//
// These are the three models STRONG's tiers 1 and 2 price a position with, exported verbatim
// from the frozen research models. Nothing here fits anything: this walks a tree that already
// exists, and it has to walk it to the same leaf the TypeScript does or the port is a different
// bot wearing the same name.
//
// THRESHOLDS STAY DOUBLE. The exported model compares a feature against an f64, and narrowing
// that to f32 moves decision boundaries — a feature landing a hair either side of a threshold
// takes a different branch and the whole subtree changes. The features themselves are f64 for
// the same reason.
//
// The buffer is produced by `scratchpad/authur/convert-forests.ts` in amath-bot-lab and is
// little-endian and fixed-width, so loading is pointer arithmetic rather than a reader. It is
// NOT embedded in the binary: EQ-Lab already serves these models to its TypeScript bot, so the
// worker fetches the same bytes and hands them over once.
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace amath::strong {

class Forest {
 public:
  Forest() = default;

  /** Returns an empty string on success, or why the buffer was refused. */
  std::string load(const uint8_t* bytes, size_t length) {
    clear();
    if (bytes == nullptr || length < 20) return "forest buffer is too short to hold a header";
    if (std::memcmp(bytes, "AFST", 4) != 0) return "forest buffer is not AFST";
    size_t at = 4;
    const uint32_t version = readU32(bytes, at);
    if (version != 1) return "unsupported forest version " + std::to_string(version);
    const uint32_t treeCount = readU32(bytes, at);
    baseline_ = readF64(bytes, at);
    if (treeCount == 0) return "forest has no trees";
    if (length < at + 4ull * treeCount) return "forest buffer ends inside the tree table";

    offsets_.reserve(treeCount + 1);
    offsets_.push_back(0);
    uint64_t total = 0;
    for (uint32_t i = 0; i < treeCount; ++i) {
      const uint32_t n = readU32(bytes, at);
      if (n == 0) return "forest tree " + std::to_string(i) + " has no nodes";
      total += n;
      offsets_.push_back(static_cast<uint32_t>(total));
    }
    const uint64_t need = at + total * (4 + 8 + 4 + 4 + 8 + 1);
    if (length < need) return "forest buffer is shorter than its node table";

    feature_.resize(total);
    threshold_.resize(total);
    left_.resize(total);
    right_.resize(total);
    value_.resize(total);
    isLeaf_.resize(total);
    for (uint64_t i = 0; i < total; ++i) feature_[i] = readI32(bytes, at);
    for (uint64_t i = 0; i < total; ++i) threshold_[i] = readF64(bytes, at);
    for (uint64_t i = 0; i < total; ++i) left_[i] = readI32(bytes, at);
    for (uint64_t i = 0; i < total; ++i) right_[i] = readI32(bytes, at);
    for (uint64_t i = 0; i < total; ++i) value_[i] = readF64(bytes, at);
    for (uint64_t i = 0; i < total; ++i) isLeaf_[i] = bytes[at++];

    // A split pointing outside its own tree would walk into a neighbour's nodes and still
    // return a number, so the structure is checked once here rather than trusted per decision.
    for (uint32_t t = 0; t + 1 < offsets_.size(); ++t) {
      const uint32_t begin = offsets_[t];
      const uint32_t end = offsets_[t + 1];
      for (uint32_t i = begin; i < end; ++i) {
        if (isLeaf_[i]) continue;
        const int32_t l = left_[i];
        const int32_t r = right_[i];
        const uint32_t span = end - begin;
        if (l < 0 || r < 0 || static_cast<uint32_t>(l) >= span || static_cast<uint32_t>(r) >= span)
          return "forest tree " + std::to_string(t) + " has a split leaving the tree";
        if (feature_[i] < 0) return "forest tree " + std::to_string(t) + " splits on no feature";
        if (static_cast<size_t>(feature_[i]) + 1 > features_) features_ = feature_[i] + 1;
      }
    }
    trees_ = offsets_.size() - 1;
    nodes_ = total;
    return {};
  }

  /**
   * Sum every tree's leaf onto the baseline, then floor the result at zero.
   *
   * THE FLOOR IS PART OF THE MODEL, not a tidy-up. These forests predict an expected SCORE for
   * a turn, and a turn cannot score less than nothing, so the TypeScript ends `s < 0 ? 0 : s`
   * and the numbers the search was tuned against are the floored ones. Six of the first 1 200
   * gate cases land below zero, which is exactly how this was found.
   *
   * `features` must hold at least `featureCount()` values; a shorter vector would read past its
   * end on a split this forest happens to take, which is a wrong answer rather than a crash.
   */
  double predict(const double* features, size_t count) const {
    if (trees_ == 0 || count < features_) return baseline_;
    double sum = baseline_;
    for (uint32_t t = 0; t < trees_; ++t) {
      const uint32_t begin = offsets_[t];
      uint32_t node = 0;
      // Bounded by the tree's own size: a cycle in a corrupt tree would otherwise hang a turn.
      const uint32_t limit = offsets_[t + 1] - begin;
      for (uint32_t step = 0; step <= limit; ++step) {
        const uint32_t at = begin + node;
        if (isLeaf_[at]) {
          sum += value_[at];
          break;
        }
        node = features[static_cast<size_t>(feature_[at])] <= threshold_[at]
                   ? static_cast<uint32_t>(left_[at])
                   : static_cast<uint32_t>(right_[at]);
      }
    }
    return sum < 0 ? 0 : sum;
  }

  double predict(const std::vector<double>& features) const {
    return predict(features.data(), features.size());
  }

  bool loaded() const { return trees_ > 0; }
  uint32_t trees() const { return trees_; }
  uint64_t nodes() const { return nodes_; }
  size_t featureCount() const { return features_; }
  double baseline() const { return baseline_; }

 private:
  void clear() {
    offsets_.clear();
    feature_.clear();
    threshold_.clear();
    left_.clear();
    right_.clear();
    value_.clear();
    isLeaf_.clear();
    trees_ = 0;
    nodes_ = 0;
    features_ = 0;
    baseline_ = 0;
  }
  static uint32_t readU32(const uint8_t* b, size_t& at) {
    uint32_t v;
    std::memcpy(&v, b + at, 4);
    at += 4;
    return v;
  }
  static int32_t readI32(const uint8_t* b, size_t& at) {
    int32_t v;
    std::memcpy(&v, b + at, 4);
    at += 4;
    return v;
  }
  static double readF64(const uint8_t* b, size_t& at) {
    double v;
    std::memcpy(&v, b + at, 8);
    at += 8;
    return v;
  }

  std::vector<uint32_t> offsets_;   // first node index of each tree, plus the end
  std::vector<int32_t> feature_;
  std::vector<double> threshold_;
  std::vector<int32_t> left_;       // child indices are RELATIVE to the tree's first node
  std::vector<int32_t> right_;
  std::vector<double> value_;
  std::vector<uint8_t> isLeaf_;
  uint32_t trees_ = 0;
  uint64_t nodes_ = 0;
  size_t features_ = 0;
  double baseline_ = 0;
};

}  // namespace amath::strong
