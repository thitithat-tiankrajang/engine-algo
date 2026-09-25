// Authur's decision layer — STRONG's selector, ported.
//
// The shape is the original's and the constants are the original's; this file's job is to be
// the same function in a faster language, not a better one. Anything that looks like an
// improvement here is a bug, because the gate is "does it choose the move the TypeScript
// chooses", and a better move fails it exactly as a worse one does.
//
// WHAT MAKES IT STRONG RATHER THAN GREEDY, in the original's own order:
//
//   0  COMPLETE root generation. Every legal action, outside any budget. An action is never
//      dropped for scoring few points now — the whole premise is that delayed value can beat
//      immediate points, so the cut that follows must not be a score cut.
//   1  a cheap score for every one of them: immediate score plus the quality of the rack it
//      would LEAVE. Ordering only; the two are not in the same unit.
//   2  a strategically DIVERSE shortlist. Not the head of one ranking — quotas from three
//      different rankings, then one of every placement SIZE from two of them, then exchanges
//      by size, then pass. A move that is best by leave and mediocre by score survives here,
//      and that is the point.
//   3  tiers 1 and 2 price each candidate across shared determinized worlds as
//      `gain − opponentReply + ownNext`, the last two from the frozen forests. Tier 2 spends
//      more worlds on fewer candidates. Only a COMPLETED tier may move the committed action.
//   4  a non-PLACE must clear the best PLACE by a margin before it is chosen, because the
//      future-score signal is evidence rather than proof and is known to invent reversals.
//
// TIER 3 IS NOT HERE YET. The original buys a real bounded opponent reply for the last few
// contenders, ordered by danger. Until that lands, this is STRONG with `tier3Rounds: 0`, which
// is a configuration the original supports and can therefore be gated against exactly.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../rules.hpp"
#include "../state_transition.hpp"
#include "forest.hpp"

namespace amath::strong {

/** Frozen in Stage 5X-D on development positions. Not tuned here. */
struct StrongConfig {
  int shortlist = 224;
  int worldsTier1 = 24;
  int worldsTier2 = 96;
  int finalists = 4;
  /** Points an EXCHANGE must beat the best PLACE by before it is chosen. */
  double reversalMargin = 20;
  /** Points PASS must beat the best PLACE by. */
  double passMargin = 25;
};

enum class Family { Place, Exchange, Pass };

struct Candidate {
  Move move;
  std::string id;
  Family family = Family::Place;
  int size = 0;
  double keep = 0;   // quality of the rack this action would leave
  double cheap = 0;  // immediate score + keep, for PLACE; keep alone for EXCHANGE
  double q = 0;      // the tier value that last spoke for it
  int tier = 0;      // which tier that was; 0 means nothing has priced it
  int worlds = 0;
};

struct StrongDecision {
  Move action;
  std::string id;
  double q = 0;
  double qBestPlace = 0;
  int tiersCompleted = 0;
  int legalPlace = 0;
  int legalExchange = 0;
  int shortlisted = 0;
  int evaluations = 0;
  /** The shortlist with whatever tier reached it, best first. Diagnostics only. */
  std::vector<Candidate> candidates;
};

/**
 * Choose one action for the side to move.
 *
 * `root` must be a real position: this reads the bag it is given and never invents one. The
 * two forests are `reply-opponent` and `reply-self`; both must be loaded, because tiers 1 and 2
 * are nothing without them and a silently unpriced candidate would fall back to its cheap score
 * and look like a greedy bot having a bad day.
 */
StrongDecision decideStrong(const SearchState& root, const Forest& opponentReply,
                            const Forest& ownNext, uint32_t seed,
                            const StrongConfig& config = {});

}  // namespace amath::strong
