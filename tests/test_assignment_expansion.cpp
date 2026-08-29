// Dedup collapses a FOOTPRINT — the same cells holding the same physical tile
// kinds — down to its highest-scoring member, and what it throws away is the
// FACE a choice tile was going to be played as: a blank as `-` or as `+`, a
// `x//` as `×` or `÷`.
//
// That is sound for ranking and unsound for everything after it. Within a
// footprint `leave` (kinds spent) and `defense` (cells used) are identical by
// construction, so the highest-scoring member is also the highest static equity
// — dedup ranks correctly. But the face lands on the board, and the simulation
// then scores an opponent reply and our own next turn against that board. Two
// members of one footprint are two different positions.
//
// In the end-game position this was found in, four moves put the same two kinds
// on the same two cells for the same 14 points and the same −11.12 equity, and
// the exact solver proves them at +36, +15, +15 and +15. The +36 is a forced
// win. Two members tie on score, so which one dedup keeps is decided by
// enumeration order, and the forced win lost that coin flip — it was gone before
// ranking, which is why no candidate cap could have saved it.
//
// These tests pin the whole chain: the identity dedup uses, the property that
// makes post-admission expansion lossless, that expansion actually restores
// every face, that it stays bounded, and that it does NOT touch moves whose
// cells differ (equation rearrangements are distinct positions and always were).
#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/engine.hpp"
#include "../src/eval.hpp"
#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"
#include "endgame_outcome_position.hpp"

using namespace amath;
using namespace amath_test;

static int failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                 \
    }                                                             \
  } while (0)

using Footprint = std::vector<std::pair<int, uint8_t>>;

static Footprint footprintOf(const std::vector<Placement>& ps) {
  Footprint f;
  for (const Placement& p : ps) f.push_back({Board::idx(p.row, p.col), p.kind});
  std::sort(f.begin(), f.end());
  return f;
}

/** Full move identity: cells, kinds AND faces. */
static std::string identity(const std::vector<Placement>& ps) {
  std::vector<std::string> parts;
  for (const Placement& p : ps) {
    parts.push_back(std::to_string(p.row) + "," + std::to_string(p.col) + "," +
                    tileKindToString(p.kind) + "," + assignedTokenToString(p.token));
  }
  std::sort(parts.begin(), parts.end());
  std::string s;
  for (const std::string& x : parts) s += x + "|";
  return s;
}

static void loadPosition(Board& board, TileCounts& rack, TileCounts& unseen) {
  for (uint8_t k = 0; k < KIND_COUNT; k++) unseen.add(k, TILE_COUNTS[k]);
  for (const FixtureCell& c : kEndgameBoard) {
    const int kind = tileKindFromString(c.kind);
    const int token = assignedTokenFromString(c.token);
    board.place(c.r, c.c, static_cast<uint8_t>(kind), static_cast<uint8_t>(token));
    if (unseen.n[kind] > 0) unseen.sub(static_cast<uint8_t>(kind));
  }
  for (const char* t : kEndgameRack) {
    const int kind = tileKindFromString(t);
    rack.add(static_cast<uint8_t>(kind));
    if (unseen.n[kind] > 0) unseen.sub(static_cast<uint8_t>(kind));
  }
}

/** The engine's answer for this board at a stated score, as parsed JSON. */
static json::ValuePtr ask(int oppScore, int topN) {
  std::string j = "{\"board\":[";
  bool first = true;
  for (const FixtureCell& c : kEndgameBoard) {
    if (!first) j += ",";
    first = false;
    j += "{\"r\":" + std::to_string(c.r) + ",\"c\":" + std::to_string(c.c) + ",\"kind\":\"" +
         c.kind + "\",\"token\":\"" + c.token + "\"}";
  }
  j += "],\"rack\":[";
  first = true;
  for (const char* t : kEndgameRack) {
    if (!first) j += ",";
    first = false;
    j += std::string("\"") + t + "\"";
  }
  j += "],\"bagCount\":0,\"oppRackCount\":" + std::to_string(kEndgameOppRack) +
       ",\"myScore\":0,\"oppScore\":" + std::to_string(oppScore) +
       ",\"exchangeAllowed\":false,\"unlimited\":true,\"seed\":1,\"topN\":" +
       std::to_string(topN) + "}";
  return json::parse(handleRequest(j));
}

int main() {
  Board board;
  TileCounts rack, unseen;
  loadPosition(board, rack, unseen);

  std::vector<Move> complete, deduped;
  GenStats g1, g2;
  GenOptions plain;
  GenOptions ddOpts;
  ddOpts.dedup = true;
  ddOpts.premiumOrder = true;
  generatePlaceMoves(board, rack, complete, &g1, plain);
  generatePlaceMoves(board, rack, deduped, &g2, ddOpts);

  std::printf("generation: complete=%zu deduped=%zu (collapsed %zu)\n", complete.size(),
              deduped.size(), complete.size() - deduped.size());
  CHECK(complete.size() > deduped.size());  // this position must actually exercise dedup

  // ── 1. dedup's identity is the footprint, and it keeps the top score ───────
  std::map<Footprint, std::vector<const Move*>> groups;
  for (const Move& m : complete) groups[footprintOf(m.placements)].push_back(&m);

  std::printf("dedup keeps the highest-scoring member of each footprint...\n");
  int multi = 0;
  for (const Move& rep : deduped) {
    const auto& group = groups[footprintOf(rep.placements)];
    CHECK(!group.empty());
    if (group.size() > 1) multi++;
    int best = group.front()->score;
    for (const Move* m : group) best = std::max(best, m->score);
    // THE PROPERTY the whole design rests on. If this ever fails, expanding
    // after admission is no longer lossless, because a member that deserved a
    // slot could have been represented by one that did not get one.
    CHECK(rep.score == best);
  }
  CHECK(multi > 0);
  std::printf("  %d footprints had more than one assignment\n", multi);

  // ── 2. same footprint ⇒ same leave and same defense ⇒ same equity ordering ─
  // This is the other half of the losslessness argument, and it is checked
  // rather than asserted in prose.
  std::printf("within a footprint, only the score can differ...\n");
  const BoardContext ctx = makeContext(board, unseen, 0, 0.0f);
  for (const auto& [foot, group] : groups) {
    if (group.size() < 2) continue;
    const float d0 = defensePenalty(board, group[0]->placements);
    TileCounts after0 = rack;
    for (const Placement& p : group[0]->placements) after0.sub(p.kind);
    const float l0 = leaveValue(after0, ctx);
    for (const Move* m : group) {
      CHECK(defensePenalty(board, m->placements) == d0);
      TileCounts after = rack;
      for (const Placement& p : m->placements) after.sub(p.kind);
      CHECK(leaveValue(after, ctx) == l0);
    }
  }

  // ── 3. expansion restores every face of every admitted footprint ───────────
  std::printf("expansion restores every assignment of what was admitted...\n");
  std::vector<Move> admitted(deduped.begin(),
                             deduped.begin() + std::min<size_t>(60, deduped.size()));
  std::vector<Footprint> admittedFeet;
  for (const Move& m : admitted) admittedFeet.push_back(footprintOf(m.placements));
  const size_t before = admitted.size();
  expandAdmittedAssignments(board, rack, admitted);

  size_t expected = 0;
  for (const Footprint& f : admittedFeet) expected += groups[f].size();
  CHECK(admitted.size() == expected);
  for (const Footprint& f : admittedFeet) {
    for (const Move* m : groups[f]) {
      bool found = false;
      for (const Move& c : admitted)
        if (identity(c.placements) == identity(m->placements)) found = true;
      CHECK(found);
    }
  }
  std::printf("  %zu admitted footprints -> %zu candidates\n", before, admitted.size());

  // ── 4. bounded: expansion is not a back door to the whole legal-move set ───
  std::printf("expansion stays bounded...\n");
  // Expansion may reconstruct the complete list, but only when every footprint
  // was admitted — as happens here, 35 footprints under a cap of 60. What must
  // never happen is a candidate set larger than the legal-move set, or one
  // containing a footprint that admission did not choose.
  CHECK(admitted.size() <= complete.size());
  CHECK(admitted.size() == expected);
  if (before < deduped.size()) {
    // When the cap actually binds, expansion must stay strictly below complete.
    CHECK(admitted.size() < complete.size());
  }
  // Nothing outside the admitted footprints may appear.
  for (const Move& c : admitted) {
    const Footprint f = footprintOf(c.placements);
    CHECK(std::find(admittedFeet.begin(), admittedFeet.end(), f) != admittedFeet.end());
  }

  // ── 5. cell layout is untouched: rearrangements were never the problem ─────
  // 6+0=6 and 6=6+0 occupy different cells, so they are different footprints and
  // dedup never merged them. Expansion must not merge them either.
  std::printf("different cell layouts stay distinct moves...\n");
  std::map<std::string, int> cellsOnly;
  for (const Move& m : complete) {
    std::string key;
    std::vector<int> idx;
    for (const Placement& p : m.placements) idx.push_back(Board::idx(p.row, p.col));
    std::sort(idx.begin(), idx.end());
    for (int i : idx) key += std::to_string(i) + ".";
    cellsOnly[key]++;
  }
  CHECK(cellsOnly.size() > 1);
  // Every distinct cell layout in the complete list survives dedup as at least
  // one move: dedup can only ever merge WITHIN a layout, never across.
  std::map<std::string, int> dedupLayouts;
  for (const Move& m : deduped) {
    std::string key;
    std::vector<int> idx;
    for (const Placement& p : m.placements) idx.push_back(Board::idx(p.row, p.col));
    std::sort(idx.begin(), idx.end());
    for (int i : idx) key += std::to_string(i) + ".";
    dedupLayouts[key]++;
  }
  CHECK(dedupLayouts.size() == cellsOnly.size());
  std::printf("  %zu distinct cell layouts, preserved exactly\n", cellsOnly.size());

  // ── 6. the actual forced win reaches the candidate set ────────────────────
  // (11,4) blank played as `-` with (12,4) `0`. Same cells, same kinds and the
  // same 14 points as the `+` version dedup kept; proven +36 against its +15.
  std::printf("the forced-win assignment survives to the candidate set...\n");
  std::vector<Placement> forcedWin = {
      {11, 4, static_cast<uint8_t>(tileKindFromString("?")),
       static_cast<uint8_t>(assignedTokenFromString("-"))},
      {12, 4, static_cast<uint8_t>(tileKindFromString("0")),
       static_cast<uint8_t>(assignedTokenFromString("0"))}};
  const std::string wanted = identity(forcedWin);

  bool inComplete = false, inDeduped = false, inExpanded = false;
  for (const Move& m : complete)
    if (identity(m.placements) == wanted) inComplete = true;
  for (const Move& m : deduped)
    if (identity(m.placements) == wanted) inDeduped = true;
  for (const Move& m : admitted)
    if (identity(m.placements) == wanted) inExpanded = true;
  CHECK(inComplete);   // it is legal
  CHECK(!inDeduped);   // dedup dropped it — the defect, pinned so it stays visible
  CHECK(inExpanded);   // expansion brings it back
  std::printf("  legal=%d survives-dedup=%d survives-expansion=%d\n", inComplete, inDeduped,
              inExpanded);

  // ── 7. end to end: the engine still proves and plays the +36 ──────────────
  // The exact solver generates its own un-deduped list, so this passed before
  // the fix too. It is here so that a future change which routes the endgame
  // through the deduped candidate set fails loudly instead of quietly.
  std::printf("the engine still returns the proven +36 move...\n");
  json::ValuePtr v = ask(0, 8);
  CHECK(v && !v->get("error"));
  if (v && !v->get("error")) {
    CHECK(v->get("solver")->asString() == "endgame");
    CHECK(v->get("outcome")->asString() == "forced_win");
    CHECK(v->get("expectedFinalDiff")->asInt(0) == 36);
    std::vector<Placement> got;
    for (const auto& p : v->get("placements")->arr) {
      got.push_back({static_cast<uint8_t>(p->get("r")->asInt()),
                     static_cast<uint8_t>(p->get("c")->asInt()),
                     static_cast<uint8_t>(tileKindFromString(p->get("kind")->asString())),
                     static_cast<uint8_t>(assignedTokenFromString(p->get("token")->asString()))});
    }
    CHECK(identity(got) == wanted);
  }

  if (failures == 0) {
    std::printf("\nALL ASSIGNMENT-EXPANSION TESTS PASSED\n");
    return 0;
  }
  std::printf("\n%d FAILURES\n", failures);
  return 1;
}
