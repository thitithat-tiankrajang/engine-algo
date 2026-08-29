// A move that plays the last tile ENDS THE GAME, and when it does the final
// score is already known — there is no reply to guess and nothing to sample.
//
// The rule (state_transition.cpp, and endGame.ts in the app): the rack-out check
// runs BEFORE the refill, so the game ends when the mover has played their last
// tile and `opponent rack + bag <= RACK_SIZE`; the mover then scores twice
// whatever is left in the opponent's rack AND the bag.
//
// What makes that computable without knowing the opponent's hand: the bonus is
// charged on the UNION of their rack and the bag, and that union is exactly the
// unseen pool. Which hidden tile sits where never enters the arithmetic. So this
// is a proof, not an estimate, and it holds at any bag count rather than only at
// bag 0 — which matters, because bag 0 is the one case the tree search already
// covers.
//
// These tests exist because this class is exactly the one a static-equity
// ranking cannot see: the value is the ×2 bonus, and `staticEquity` has no term
// for it. A move worth 4 points on the board can win the game outright.
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/engine.hpp"
#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"
#include "../src/selfplay.hpp"
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

static TileCounts counts(const std::vector<const char*>& kinds) {
  TileCounts t;
  for (const char* k : kinds) t.add(static_cast<uint8_t>(tileKindFromString(k)));
  return t;
}

static Move placeMove(int score, const std::vector<Placement>& ps) {
  Move m;
  m.type = MoveType::Place;
  m.score = score;
  m.placements = ps;
  return m;
}

static Placement at(int r, int c, const char* kind, const char* token) {
  return {static_cast<uint8_t>(r), static_cast<uint8_t>(c),
          static_cast<uint8_t>(tileKindFromString(kind)),
          static_cast<uint8_t>(assignedTokenFromString(token))};
}

int main() {
  // ── 1. the arithmetic, against the rule as written ────────────────────────
  // Rack "1 6": playing both empties it. Unseen = opponent's 2 tiles + a 3-tile
  // bag = 5 tiles, under the rackful gate, so the game ends and the bonus is
  // twice the WHOLE pool — bag included, which is the part that is easy to get
  // wrong.
  std::printf("terminal arithmetic: score + 2 x (opponent rack + bag)...\n");
  {
    const TileCounts unseen = counts({"19", "17", "13", "0", "0"});  // 7+6+6+1+1 = 21
    CHECK(unseen.points() == 21);
    const Move out = placeMove(4, {at(7, 7, "1", "1"), at(7, 8, "6", "6")});
    const auto margin = immediateOutMargin(unseen, /*myRackTotal=*/2, /*oppRackCount=*/2,
                                           /*bagCount=*/3, out);
    CHECK(margin.has_value());
    CHECK(*margin == 4 + 2 * 21);  // 46
    // A 4-point move worth 46. This is the gap static equity cannot see.
    std::printf("  4-point move, unseen worth 21 -> final margin %d\n", margin.value_or(0));
  }

  // ── 2. it only fires when the game really ends ────────────────────────────
  std::printf("it does not fire when the game continues...\n");
  {
    const TileCounts unseen = counts({"19", "17", "13", "0", "0"});
    // Rack still holds a tile afterwards: no rack-out.
    CHECK(!immediateOutMargin(unseen, 3, 2, 3,
                              placeMove(4, {at(7, 7, "1", "1"), at(7, 8, "6", "6")}))
               .has_value());
    // Opponent + bag exceeds a rackful: the rule's gate fails, play continues.
    const TileCounts big = counts({"19", "17", "13", "0", "0", "1", "2", "3", "4"});
    CHECK(!immediateOutMargin(big, 2, 4, 5,
                              placeMove(4, {at(7, 7, "1", "1"), at(7, 8, "6", "6")}))
               .has_value());
    // Unseen does not account for opponent + bag: we cannot read the bonus off
    // it, so we must decline rather than answer with a wrong number.
    CHECK(!immediateOutMargin(unseen, 2, 2, 9,
                              placeMove(4, {at(7, 7, "1", "1"), at(7, 8, "6", "6")}))
               .has_value());
    // A pass never ends the game this way.
    CHECK(!immediateOutMargin(unseen, 0, 2, 3, Move{}).has_value());
  }

  // ── 3. WIN is judged against the real score, never against zero ───────────
  std::printf("the threshold is the actual score difference...\n");
  {
    const TileCounts unseen = counts({"19", "17", "13", "0", "0"});
    const Move out = placeMove(4, {at(7, 7, "1", "1"), at(7, 8, "6", "6")});
    const int margin = *immediateOutMargin(unseen, 2, 2, 3, out);  // 46
    // Behind by 45 -> 46 > 45, a win. Behind by 46 -> a draw, NOT a win.
    // Behind by 47 -> a loss. All three from the same move.
    CHECK(margin > (300 - 255));   // 45 behind: win
    CHECK(!(margin > (300 - 254)));  // 46 behind: draw, not a win
    CHECK(!(margin > (300 - 253)));  // 47 behind: loss
    // And a zero-difference assumption would have called all three a win.
    CHECK(margin > 0);
    std::printf("  margin %d: win at -45, draw at -46, loss at -47\n", margin);
  }

  // ── 4. blank assignments are judged individually ──────────────────────────
  // Same cells, same kinds, different faces: the bonus is identical because the
  // same tiles left the rack, so the two differ exactly by their board score —
  // which is why dedup keeping the higher-scoring member is safe for THIS class,
  // and it is checked rather than assumed.
  std::printf("blank assignments differ only by board score...\n");
  {
    const TileCounts unseen = counts({"19", "17"});
    const Move asMinus = placeMove(9, {at(7, 7, "?", "-"), at(7, 8, "0", "0")});
    const Move asPlus = placeMove(5, {at(7, 7, "?", "+"), at(7, 8, "0", "0")});
    const auto a = immediateOutMargin(unseen, 2, 2, 0, asMinus);
    const auto b = immediateOutMargin(unseen, 2, 2, 0, asPlus);
    CHECK(a.has_value() && b.has_value());
    CHECK(*a - *b == asMinus.score - asPlus.score);
  }

  // ── 5. terminal moves never reach the simulation ──────────────────────────
  // The simulation cannot price a terminal move: it applies the placement, asks
  // for the opponent's best reply on a board where the game is already over,
  // values a leave and a next turn for a rack that no longer exists, and never
  // adds the ×2 bonus. Measured on a real 8+8 position, a move whose true final
  // margin is +108 came back at 140.1 — a different axis, not a rounding error.
  //
  // So they are decided before the search and held out of it. This checks the
  // consequence that is observable from outside: a position full of terminal
  // moves must not inflate the candidate count.
  std::printf("terminal moves do not enter the candidate set...\n");
  {
    int worstCandidates = 0, positionsWithOuts = 0;
    for (uint32_t seed = 1; seed <= 40 && positionsWithOuts < 6; seed++) {
      GameSim sim(seed);
      int side = 0;
      for (int turn = 0; turn < 250 && !sim.finished; turn++) {
        const int mine = sim.racks[side].total, theirs = sim.racks[1 - side].total;
        if (sim.bag.empty() && mine > 0 && theirs > 0 && sim.pendingReturn[0].empty() &&
            sim.pendingReturn[1].empty()) {
          std::vector<Move> all;
          GenStats gs;
          generatePlaceMoves(sim.board, sim.racks[side], all, &gs, GenOptions{});
          int outs = 0;
          for (const Move& m : all)
            if (immediateOutMargin(sim.racks[1 - side], mine, theirs, 0, m)) outs++;
          if (outs >= 5) {
            // A timed tier, so the exact proof cannot finish and the request
            // genuinely falls through to the candidate path.
            std::string req = sim.requestJson(side, "max", 11);
            req.pop_back();
            req += ",\"budgetMs\":2500,\"oppScore\":999999}";
            json::ValuePtr v = json::parse(handleRequest(req));
            if (v && !v->get("error") && v->get("stats")) {
              const int cands = static_cast<int>(v->get("stats")->get("candidates")->asInt(0));
              worstCandidates = std::max(worstCandidates, cands);
              positionsWithOuts++;
              // 60 admitted footprints + top scorer + exchanges + pass, plus the
              // assignment expansion of those footprints. Terminal moves add
              // nothing, so this cannot run to the hundreds the force-admission
              // path produced (68 → 1021 measured).
              CHECK(cands <= 200);
            }
          }
        }
        if (!sim.applyResponse(side, [&] {
              GenOptions o;
              o.dedup = true;
              GenStats st;
              st.nodeLimit = 1'000'000;
              std::vector<Move> mv;
              generatePlaceMoves(sim.board, sim.racks[side], mv, &st, o);
              auto out = json::makeObject();
              if (mv.empty()) {
                out->obj["type"] = json::makeString("pass");
                return json::stringify(out);
              }
              size_t b = 0;
              for (size_t i = 1; i < mv.size(); i++)
                if (mv[i].score > mv[b].score) b = i;
              out->obj["type"] = json::makeString("place");
              auto arr = json::makeArray();
              for (const Placement& p : mv[b].placements) {
                auto e = json::makeObject();
                e->obj["r"] = json::makeInt(p.row);
                e->obj["c"] = json::makeInt(p.col);
                e->obj["kind"] = json::makeString(tileKindToString(p.kind));
                e->obj["token"] = json::makeString(assignedTokenToString(p.token));
                arr->arr.push_back(e);
              }
              out->obj["placements"] = arr;
              out->obj["score"] = json::makeInt(mv[b].score);
              return json::stringify(out);
            }())) {
          break;
        }
        side = 1 - side;
      }
    }
    std::printf("  %d positions with >=5 terminal moves, worst candidate count %d\n",
                positionsWithOuts, worstCandidates);
    CHECK(positionsWithOuts > 0);
  }

  // ── 6. a proven terminal DRAW survives the terminal filter ────────────────
  // The regression this class of test exists for. Only proven LOSSES may be
  // filtered; a draw is a floor and has to still be there when the search picks.
  std::printf("a proven terminal draw survives filtering and is chosen...\n");
  {
    std::string j = "{\"board\":[";
    bool first = true;
    for (const FixtureCell& c : kTerminalDrawBoard) {
      if (!first) j += ",";
      first = false;
      j += "{\"r\":" + std::to_string(c.r) + ",\"c\":" + std::to_string(c.c) + ",\"kind\":\"" +
           c.kind + "\",\"token\":\"" + c.token + "\"}";
    }
    j += "],\"rack\":[";
    first = true;
    int rackSize = 0;
    for (const char* t : kTerminalDrawRack) {
      if (!first) j += ",";
      first = false;
      rackSize++;
      j += std::string("\"") + t + "\"";
    }
    j += "],\"bagCount\":0,\"oppRackCount\":" + std::to_string(kTerminalDrawOppRack) +
         ",\"myScore\":0,\"oppScore\":" + std::to_string(kTerminalDrawThreshold) +
         ",\"exchangeAllowed\":false,\"budgetMs\":140,\"seed\":1,\"topN\":4}";
    json::ValuePtr v = json::parse(handleRequest(j));
    CHECK(v && !v->get("error"));
    if (v && !v->get("error")) {
      // A small budget on purpose: the exact proof must abort so the decision
      // genuinely falls through, which is where the draw used to be thrown away.
      const int played = static_cast<int>(v->get("placements")->arr.size());
      CHECK(played == rackSize);  // it played out — the terminal draw, not the +1 trap
      CHECK(played != kTerminalDrawTrapValue);
      // POLICY C. The draw is not offered to the search at all; it is returned as
      // the proven fact it is. So it comes back through the proven channel, and
      // no simulation ran to rank it against anything unproven.
      CHECK(v->get("solver")->asString() == "endgame");
      CHECK(v->get("outcome")->asString() == "forced_draw");
      CHECK(v->get("expectedFinalDiff")->asInt(0) == kTerminalDrawThreshold);
      CHECK(v->get("winThreshold")->asInt(0) == kTerminalDrawThreshold);
      const int cands = static_cast<int>(v->get("stats")->get("candidates")->asInt(0));
      CHECK(cands == 0);  // no candidate set was built; nothing to explode
      std::printf("  played out (%d tiles), outcome=%s, candidates %d\n", played,
                  v->get("outcome")->asString().c_str(), cands);
    }
  }

  // ── 7. an Unknown search can no longer take the draw's place ──────────────
  // The regression in its sharpest form. Corpus position 13 offered a proven draw
  // at Δ = T = 61; when the draw was admitted to the simulation instead of being
  // returned, the search ranked it 24th (value 19.0 against a leader's 60.9) and
  // played a move whose true value is +49 — a real loss. The search is not able
  // to price a terminal move, so what it produces here is not a comparison.
  std::printf("an unproven search cannot displace a proven draw...\n");
  {
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
    int rackSize = 0;
    for (const char* t : kDrawTrapRack) {
      if (!first) j += ",";
      first = false;
      rackSize++;
      j += std::string("\"") + t + "\"";
    }
    j += "],\"bagCount\":0,\"oppRackCount\":" + std::to_string(kDrawTrapOppRack) +
         ",\"myScore\":0,\"oppScore\":" + std::to_string(kDrawTrapThreshold) +
         ",\"exchangeAllowed\":false,\"budgetMs\":140,\"seed\":1,\"topN\":4}";
    json::ValuePtr v = json::parse(handleRequest(j));
    CHECK(v && !v->get("error"));
    if (v && !v->get("error")) {
      CHECK(v->get("outcome")->asString() == "forced_draw");
      CHECK(v->get("expectedFinalDiff")->asInt(0) == kDrawTrapThreshold);
      // It must be the rack-out, not the losing move the search preferred.
      CHECK(static_cast<int>(v->get("placements")->arr.size()) == rackSize);
      std::printf("  T=%d: returned the proven draw, not the Δ=+%d loss\n", kDrawTrapThreshold,
                  kDrawTrapLossValue);
    }
  }

  // ── 8. the top-scorer guard cannot undo the terminal filter ───────────────
  // Admission keeps a "always simulate the highest scorer" fallback so a spent
  // generation budget can never drop the board's biggest play. It used to scan
  // the RAW move list, which put back exactly what the terminal filter had just
  // removed: a rack-out's ×2 bonus is not in its board score, yet playing out the
  // rack tends to score well, so the top scorer is very often a terminal move.
  // Measured over the bag-0 corpus: the top scorer was a filtered proven LOSS in
  // 16 of 23 positions, and the engine then played that certain loss in 7.
  std::printf("the top-scorer fallback cannot re-admit a filtered terminal loss...\n");
  {
    int checked = 0, terminalPicked = 0;
    for (uint32_t seed = 1; seed <= 40 && checked < 8; seed++) {
      GameSim sim(seed);
      int side = 0;
      for (int turn = 0; turn < 250 && !sim.finished; turn++) {
        const int mine = sim.racks[side].total, theirs = sim.racks[1 - side].total;
        if (sim.bag.empty() && mine > 0 && theirs > 0 && sim.pendingReturn[0].empty() &&
            sim.pendingReturn[1].empty()) {
          std::vector<Move> all;
          GenStats gs;
          generatePlaceMoves(sim.board, sim.racks[side], all, &gs, GenOptions{});
          // Is the highest-scoring move on the board a rack-out?
          int bestScore = -1, bestTerminal = -1;
          for (const Move& m : all) {
            if (m.score > bestScore) {
              bestScore = m.score;
              bestTerminal = immediateOutMargin(sim.racks[1 - side], mine, theirs, 0, m) ? 1 : 0;
            }
          }
          if (bestTerminal == 1) {
            // Put the threshold out of reach so every terminal move is a proven
            // LOSS, then abort the proof so the decision really goes through
            // admission. Nothing certain-to-lose may come back out.
            std::string req = sim.requestJson(side, "max", 5);
            req.pop_back();
            req += ",\"budgetMs\":800,\"oppScore\":999999}";
            json::ValuePtr v = json::parse(handleRequest(req));
            if (v && !v->get("error") && v->get("solver")->asString() == "sim") {
              checked++;
              const int played = static_cast<int>(v->get("placements")->arr.size());
              if (played == mine) terminalPicked++;
              // THE INVARIANT: a proven loss is never the answer while unproven
              // alternatives exist.
              CHECK(played != mine);
            }
          }
        }
        if (!sim.applyResponse(side, [&] {
              GenOptions o;
              o.dedup = true;
              GenStats st;
              st.nodeLimit = 1'000'000;
              std::vector<Move> mv;
              generatePlaceMoves(sim.board, sim.racks[side], mv, &st, o);
              auto out = json::makeObject();
              if (mv.empty()) {
                out->obj["type"] = json::makeString("pass");
                return json::stringify(out);
              }
              size_t b = 0;
              for (size_t i = 1; i < mv.size(); i++)
                if (mv[i].score > mv[b].score) b = i;
              out->obj["type"] = json::makeString("place");
              auto arr = json::makeArray();
              for (const Placement& p : mv[b].placements) {
                auto e = json::makeObject();
                e->obj["r"] = json::makeInt(p.row);
                e->obj["c"] = json::makeInt(p.col);
                e->obj["kind"] = json::makeString(tileKindToString(p.kind));
                e->obj["token"] = json::makeString(assignedTokenToString(p.token));
                arr->arr.push_back(e);
              }
              out->obj["placements"] = arr;
              out->obj["score"] = json::makeInt(mv[b].score);
              return json::stringify(out);
            }())) {
          break;
        }
        side = 1 - side;
      }
    }
    std::printf("  %d positions whose top scorer is a terminal loss; %d played it\n", checked,
                terminalPicked);
    CHECK(checked > 0);        // a vacuous pass would hide the whole regression
    CHECK(terminalPicked == 0);
  }

  // ── 9. cross-check against the exact solver, on real positions ────────────
  // The only check that can catch a rules mismatch: wherever both the detector
  // and the tree search apply, they must agree exactly. Self-play supplies the
  // positions so they are ones the bot actually meets.
  std::printf("agreeing with the exact end-game solver on real positions...\n");
  int compared = 0, gamesScanned = 0;
  for (uint32_t seed = 1; seed <= 60 && compared < 12; seed++) {
    GameSim sim(seed);
    int side = 0;
    gamesScanned++;
    for (int turn = 0; turn < 250 && !sim.finished; turn++) {
      const int mine = sim.racks[side].total;
      const int theirs = sim.racks[1 - side].total;
      const int bag = static_cast<int>(sim.bag.size());
      if (sim.bag.empty() && sim.pendingReturn[0].empty() && sim.pendingReturn[1].empty() &&
          mine > 0 && theirs > 0 && mine + theirs <= 12 && compared < 12) {
        // Every root move that ends the game, priced by the detector, then by
        // the solver through the engine's own reported per-move margins.
        std::vector<Move> all;
        GenStats gs;
        generatePlaceMoves(sim.board, sim.racks[side], all, &gs, GenOptions{});
        TileCounts unseen = sim.racks[1 - side];
        bool anyOut = false;
        for (const Move& m : all)
          if (immediateOutMargin(unseen, mine, theirs, bag, m)) anyOut = true;
        if (anyOut) {
          json::ValuePtr v = json::parse(handleRequest(sim.requestJson(side, "max", 7)));
          if (v && !v->get("error") && v->get("endgameSolved") &&
              v->get("endgameSolved")->asBool() && v->get("candidates")) {
            for (const auto& c : v->get("candidates")->arr) {
              if (!c->get("placements") || c->get("placements")->arr.empty()) continue;
              Move m;
              m.type = MoveType::Place;
              m.score = static_cast<int>(c->get("score")->asInt(0));
              for (const auto& p : c->get("placements")->arr) {
                m.placements.push_back(
                    at(static_cast<int>(p->get("r")->asInt()),
                       static_cast<int>(p->get("c")->asInt()),
                       p->get("kind")->asString().c_str(), p->get("token")->asString().c_str()));
              }
              const auto quick = immediateOutMargin(unseen, mine, theirs, bag, m);
              if (!quick) continue;
              const int proven = static_cast<int>(c->get("value")->asInt(0));
              // THE CROSS-CHECK. Two independent implementations of the same
              // terminal rule, on a position the bot actually reached.
              if (*quick != proven) {
                std::printf("FAIL seed %u turn %d: detector %d, solver %d\n", seed, turn, *quick,
                            proven);
                failures++;
              }
              compared++;
            }
          }
        }
      }
      if (!sim.applyResponse(side, [&] {
            GenOptions o;
            o.dedup = true;
            GenStats st;
            st.nodeLimit = 1'000'000;
            std::vector<Move> mv;
            generatePlaceMoves(sim.board, sim.racks[side], mv, &st, o);
            auto out = json::makeObject();
            if (mv.empty()) {
              out->obj["type"] = json::makeString("pass");
              return json::stringify(out);
            }
            size_t best = 0;
            for (size_t i = 1; i < mv.size(); i++)
              if (mv[i].score > mv[best].score) best = i;
            out->obj["type"] = json::makeString("place");
            auto arr = json::makeArray();
            for (const Placement& p : mv[best].placements) {
              auto e = json::makeObject();
              e->obj["r"] = json::makeInt(p.row);
              e->obj["c"] = json::makeInt(p.col);
              e->obj["kind"] = json::makeString(tileKindToString(p.kind));
              e->obj["token"] = json::makeString(assignedTokenToString(p.token));
              arr->arr.push_back(e);
            }
            out->obj["placements"] = arr;
            out->obj["score"] = json::makeInt(mv[best].score);
            return json::stringify(out);
          }())) {
        break;
      }
      side = 1 - side;
    }
  }
  std::printf("  %d out-moves cross-checked against the solver over %d games\n", compared,
              gamesScanned);
  CHECK(compared > 0);  // a vacuous pass here would hide a rules mismatch

  if (failures == 0) {
    std::printf("\nALL IMMEDIATE-OUT TESTS PASSED\n");
    return 0;
  }
  std::printf("\n%d FAILURES\n", failures);
  return 1;
}
