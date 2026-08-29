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
  for (const FixtureCell& c : kEndgameBoard) {
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

/** Preference order, lowest is best. Written out rather than derived from the
 *  enum so that reordering the enum cannot silently redefine the hierarchy. */
static int rank(const std::string& outcome) {
  if (outcome == "forced_win") return 0;
  if (outcome == "conditional_win") return 1;
  if (outcome == "unknown") return 2;
  if (outcome == "forced_draw") return 3;
  return 4;  // forced_loss
}

struct Answer {
  std::string outcome;
  int margin = 0;
  int threshold = 0;
  bool hasReach = false;
  int reach = 0;
  bool reachProven = false;
  std::string cells;  // "(r,c)token …", so a changed move is legible in the diff
};

static bool askJson(const std::string& req, Answer& out);

static bool ask(int oppScore, Answer& out) { return askJson(request(oppScore), out); }

/** The same board, but with a wall-clock budget small enough that the
 *  reachability pass cannot finish. */
static bool askBounded(int oppScore, int budgetMs, Answer& out) {
  std::string r = request(oppScore);
  r.pop_back();  // drop the closing brace
  r += ",\"budgetMs\":" + std::to_string(budgetMs) + "}";
  // `unlimited` and `budgetMs` together would keep the unlimited ceiling.
  const size_t u = r.find("\"unlimited\":true,");
  if (u != std::string::npos) r.erase(u, std::string("\"unlimited\":true,").size());
  return askJson(r, out);
}

static bool askJson(const std::string& req, Answer& out) {
  json::ValuePtr v = json::parse(handleRequest(req));
  if (!v || v->get("error")) {
    std::printf("FAIL: engine returned no answer\n");
    failures++;
    return false;
  }
  CHECK(v->get("solver")->asString() == "endgame");
  CHECK(v->get("endgameSolved")->asBool());
  out.outcome = v->get("outcome") ? v->get("outcome")->asString() : "";
  out.margin = static_cast<int>(v->get("expectedFinalDiff")->asInt(0));
  out.threshold = static_cast<int>(v->get("winThreshold")->asInt(0));
  if (auto rp = v->get("winReachabilityProven")) out.reachProven = rp->asBool();
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

  // ── the proven non-winning classes, and the epistemic one ────────────────
  // These three were a single `no_win` bucket, so a draw, a loss and a search
  // that simply ran out of time all said the same thing. They are different
  // facts and the caller is entitled to know which it has.
  std::printf("a proven draw is reported as a draw, not as a loss...\n");
  // A real position whose guarantee is exactly the threshold AND where no better
  // line exists even against a mistake. Both halves matter: guarantee == T alone
  // is not a draw if a win is still reachable — that is a conditional win, and
  // the first board is exactly that case at its own boundary.
  {
    std::string j = "{\"board\":[";
    bool first = true;
    for (const FixtureCell& c : kDrawBoard) {
      if (!first) j += ",";
      first = false;
      j += "{\"r\":" + std::to_string(c.r) + ",\"c\":" + std::to_string(c.c) + ",\"kind\":\"" +
           c.kind + "\",\"token\":\"" + c.token + "\"}";
    }
    j += "],\"rack\":[";
    first = true;
    for (const char* t : kDrawRack) {
      if (!first) j += ",";
      first = false;
      j += std::string("\"") + t + "\"";
    }
    j += "],\"bagCount\":0,\"oppRackCount\":" + std::to_string(kDrawOppRack) +
         ",\"myScore\":0,\"oppScore\":" + std::to_string(kDrawThreshold) +
         ",\"exchangeAllowed\":false,\"unlimited\":true,\"seed\":1}";
    Answer proven;
    if (!askJson(j, proven)) return 1;
    CHECK(proven.outcome == "forced_draw");
    CHECK(proven.margin == kDrawThreshold);   // ends exactly level
    CHECK(proven.threshold == kDrawThreshold);
    CHECK(proven.reachProven);                // and we looked all the way
    CHECK(proven.outcome != "forced_loss");   // the distinction this class exists for
    std::printf("  proven draw at T=%+d, final margin %+d\n", proven.threshold, proven.margin);
  }

  Answer draw;
  // Threshold exactly equal to the guarantee: best play ends level. Not a win
  // (a win must EXCEED T), and emphatically not a loss.
  if (!ask(kGuaranteed, draw)) return 1;
  // Whichever it is, it must never be reported as a loss: level is not behind.
  CHECK(draw.outcome != "forced_loss");

  std::printf("a proven loss is reported as a loss...\n");
  Answer loss;
  if (!ask(200, loss)) return 1;
  CHECK(loss.outcome == "forced_loss");
  CHECK(loss.margin < loss.threshold);   // genuinely behind against best play
  CHECK(loss.reachProven);               // and we searched far enough to say so

  std::printf("an unfinished proof says UNKNOWN, never 'cannot win'...\n");
  // THE REGRESSION THIS CLASS EXISTS FOR. Same board, same threshold, same
  // everything except the clock. With budget it is a conditional win; without,
  // the reachability pass aborts. It must then say it does not know — the one
  // thing it must not say is that the win is unreachable, because a larger
  // budget proves it reachable.
  Answer bounded;
  if (!askBounded(kGuaranteed + 14, 120, bounded)) return 1;
  CHECK(bounded.outcome == "unknown" || bounded.outcome == "conditional_win");
  if (bounded.outcome == "unknown") {
    CHECK(!bounded.reachProven);
    CHECK(mustGamble.outcome == "conditional_win");  // the same position, unbounded
  }
  CHECK(bounded.outcome != "forced_loss");
  CHECK(bounded.outcome != "forced_draw");

  std::printf("the guarantees, as control flow rather than as an ordering...\n");
  // Nothing in the engine compares two EndgameOutcome values; the preference is
  // enforced by which return fires first. These three checks pin that mechanism
  // at its observable boundary — the outcome the engine reports.
  {
    // (a) A completed ForcedDraw cannot be replaced by Unknown through candidate
    //     ranking, because it never reaches candidate ranking. Corpus position 13
    //     with the proof deliberately aborted: the draw comes back through the
    //     proven channel with no candidate set built at all.
    std::string j = "{\"board\":[";
    bool first = true;
    for (const FixtureCell& c : kDrawTrapBoard) {
      if (!first) j += ",";
      first = false;
      j += "{\"r\":" + std::to_string(c.r) + ",\"c\":" + std::to_string(c.c) + ",\"kind\":\"" +
           c.kind + "\",\"token\":\"" + c.token + "\"}";
    }
    j += "],\"rack\":[";
    first = true;
    for (const char* t : kDrawTrapRack) {
      if (!first) j += ",";
      first = false;
      j += std::string("\"") + t + "\"";
    }
    j += "],\"bagCount\":0,\"oppRackCount\":" + std::to_string(kDrawTrapOppRack) +
         ",\"myScore\":0,\"oppScore\":" + std::to_string(kDrawTrapThreshold) +
         ",\"exchangeAllowed\":false,\"budgetMs\":140,\"seed\":1,\"topN\":4}";
    json::ValuePtr v = json::parse(handleRequest(j));
    CHECK(v && !v->get("error"));
    if (v && !v->get("error")) {
      CHECK(v->get("outcome")->asString() == "forced_draw");
      CHECK(v->get("solver")->asString() == "endgame");
      // The proof of the mechanism: no candidates were built, so no ranking could
      // have displaced it. Unknown never had the chance to compete.
      CHECK(v->get("stats")->get("candidates")->asInt(0) == 0);
    }
  }
  // (b) ConditionalWin still outranks ForcedDraw where a real one is proven: the
  //     same first board at its own draw boundary (guarantee == T) reports a
  //     conditional win, because a win is still reachable there.
  CHECK(draw.outcome == "conditional_win");
  CHECK(draw.hasReach && draw.reach > draw.threshold);
  // (c) ForcedWin outranks everything, including a conditional class that can
  //     show a bigger number.
  CHECK(level.outcome == "forced_win");
  CHECK(mustGamble.reach > level.margin);

  std::printf("the classes, as reported...\n");
  // ForcedWin > ConditionalWin > Unknown > ForcedDraw > ForcedLoss.
  // Checked as rank comparisons so the ordering is a property of the test rather
  // than of the enum's declaration order.
  CHECK(rank(level.outcome) < rank(mustGamble.outcome));       // forced  > conditional
  CHECK(rank(mustGamble.outcome) < rank("unknown"));           // conditional > unknown
  CHECK(rank("unknown") < rank("forced_draw"));                // unknown > draw
  CHECK(rank("forced_draw") < rank(loss.outcome));             // draw    > loss
  // And the one that must never invert, whatever the margins say: the forced win
  // guarantees +36 while the conditional class can show +68.
  CHECK(mustGamble.reach > level.margin);
  CHECK(rank(level.outcome) < rank(mustGamble.outcome));

  std::printf("win unreachable: best play, no pointless gamble...\n");
  // Past every reachable win, the gamble buys nothing — a hopeless position is
  // played out properly rather than thrown at a miracle. This is the case a
  // "maximise variance when behind" rule gets wrong.
  if (!ask(200, hopeless)) return 1;
  CHECK(hopeless.outcome == "forced_loss");
  CHECK(hopeless.margin == kGuaranteed);
  CHECK(hopeless.cells == level.cells);  // identical to the forced-win move

  if (!ask(5000, hopeless2)) return 1;
  CHECK(hopeless2.outcome == "forced_loss");
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
