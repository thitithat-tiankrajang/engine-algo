// The end-game decision hierarchy: FORCED_WIN > CONDITIONAL_WIN > best margin.
//
// The bot's objective is to WIN. Margin is a tiebreak inside a class, never a
// reason to move between classes — and the property that matters most here is a
// negative one: a conditional win must never outrank a forced win because its
// number looks bigger. Winning by 1 for certain beats winning by 40 if they slip.
//
// What this replaces: `argmax(guaranteed margin)`, which never read the score at
// all. That rule cannot tell "win by 1" from "lose by 40" — both are just points
// on one axis — so it played a position with no forced win toward the prettiest
// LOSS and conceded games that were still winnable.
//
// One real board drives every case (see endgame_outcome_position.hpp). Only the
// score moves, which is the point: the position is identical, so any change in
// the chosen move is the objective talking and nothing else.
#include <cstdio>
#include <string>

#include "../src/engine.hpp"
#include "../src/json.hpp"
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

// The one board, at a stated score. `myScore` stays 0 and the threshold is moved
// with the opponent's, so `T = oppScore` reads directly.
static std::string request(int oppScore) {
  std::string j = "{\"board\":[";
  bool first = true;
  for (const Cell& c : kEndgameBoard) {
    if (!first) j += ",";
    first = false;
    j += "{\"r\":" + std::to_string(c.r) + ",\"c\":" + std::to_string(c.c) +
         ",\"kind\":\"" + c.kind + "\",\"token\":\"" + c.token + "\"}";
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
       ",\"exchangeAllowed\":false,\"unlimited\":true,\"seed\":1}";
  return j;
}

struct Answer {
  std::string outcome;
  int margin = 0;
  int threshold = 0;
  bool hasReach = false;
  int reach = 0;
  std::string cells;  // "(r,c)token …", so a changed move is legible in the diff
};

static bool ask(int oppScore, Answer& out) {
  json::ValuePtr v = json::parse(handleRequest(request(oppScore)));
  if (!v || v->get("error")) {
    std::printf("FAIL: engine returned no answer at oppScore=%d\n", oppScore);
    failures++;
    return false;
  }
  CHECK(v->get("solver")->asString() == "endgame");
  CHECK(v->get("endgameSolved")->asBool());
  out.outcome = v->get("outcome") ? v->get("outcome")->asString() : "";
  out.margin = static_cast<int>(v->get("expectedFinalDiff")->asInt(0));
  out.threshold = static_cast<int>(v->get("winThreshold")->asInt(0));
  if (auto r = v->get("reachableFinalDiff")) {
    out.hasReach = true;
    out.reach = static_cast<int>(r->asInt(0));
  }
  out.cells.clear();
  for (const auto& p : v->get("placements")->arr) {
    out.cells += "(" + std::to_string(p->get("r")->asInt()) + "," +
                 std::to_string(p->get("c")->asInt()) + ")" + p->get("token")->asString() + " ";
  }
  if (out.cells.empty()) out.cells = "(pass)";
  return true;
}

int main() {
  // The guarantee available on this board. Everything below is stated relative
  // to it, so the thresholds are not magic numbers.
  constexpr int kGuaranteed = 36;

  Answer level, tight, mustGamble, hopeless, hopeless2;

  std::printf("forced win: taken whenever it exists...\n");
  if (!ask(0, level)) return 1;
  CHECK(level.outcome == "forced_win");
  CHECK(level.margin == kGuaranteed);
  CHECK(!level.hasReach);  // never consulted; the guarantee already wins

  // Still forced with the deficit almost swallowing the margin.
  if (!ask(kGuaranteed - 6, tight)) return 1;
  CHECK(tight.outcome == "forced_win");
  CHECK(tight.margin == kGuaranteed);
  // Same class, same board ⇒ same move. The score must not perturb a forced win.
  CHECK(tight.cells == level.cells);

  std::printf("no forced win: keep the win reachable, not the margin...\n");
  if (!ask(kGuaranteed + 14, mustGamble)) return 1;
  CHECK(mustGamble.outcome == "conditional_win");
  CHECK(mustGamble.hasReach);
  // THE RULE. It must beat the threshold on REACHABILITY...
  CHECK(mustGamble.reach > mustGamble.threshold);
  // ...and it must be willing to give up guaranteed margin to do it. If this
  // ever stops holding, the hierarchy has collapsed back into argmax(margin).
  CHECK(mustGamble.margin < kGuaranteed);
  CHECK(mustGamble.cells != level.cells);

  std::printf("win unreachable: best play, no pointless gamble...\n");
  // Past every reachable win, the gamble buys nothing — a hopeless position is
  // played out properly rather than thrown at a miracle. This is the case a
  // "maximise variance when behind" rule gets wrong.
  if (!ask(200, hopeless)) return 1;
  CHECK(hopeless.outcome == "no_win");
  CHECK(hopeless.margin == kGuaranteed);
  CHECK(hopeless.cells == level.cells);  // identical to the forced-win move

  if (!ask(5000, hopeless2)) return 1;
  CHECK(hopeless2.outcome == "no_win");
  CHECK(hopeless2.cells == hopeless.cells);  // hopeless is hopeless; no escalation

  std::printf("a forced win is never traded for a bigger conditional one...\n");
  // The forced-win move guarantees +36. The conditional class can show +68. At a
  // threshold both classes could satisfy, the guarantee has to win — this is the
  // single comparison the whole hierarchy exists to get right.
  CHECK(level.outcome == "forced_win");
  CHECK(mustGamble.hasReach && mustGamble.reach > level.margin);

  std::printf("\n  threshold %+5d -> %-16s margin %+4d   %s\n", level.threshold,
              level.outcome.c_str(), level.margin, level.cells.c_str());
  std::printf("  threshold %+5d -> %-16s margin %+4d   reachable %+d   %s\n",
              mustGamble.threshold, mustGamble.outcome.c_str(), mustGamble.margin,
              mustGamble.reach, mustGamble.cells.c_str());
  std::printf("  threshold %+5d -> %-16s margin %+4d   %s\n", hopeless.threshold,
              hopeless.outcome.c_str(), hopeless.margin, hopeless.cells.c_str());

  if (failures == 0) {
    std::printf("\nALL ENDGAME-OUTCOME TESTS PASSED\n");
    return 0;
  }
  std::printf("\n%d FAILURES\n", failures);
  return 1;
}
