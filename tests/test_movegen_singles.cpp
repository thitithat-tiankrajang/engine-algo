// Regression test: a one-tile placement that the RULES accept must be
// generated, and everything generated must be accepted by the rules.
//
// ── the defect this was written for ─────────────────────────────────────────
//
// `generatePlaceMoves` dropped every legal one-tile placement of an operator
// other than '-' when no tile adjoined the cell in the main direction. Singles
// are emitted by the horizontal pass only, and `startAt` seeds `LineState` from
// the left-hand prefix alone; with no prefix the new token was judged as the
// FIRST TOKEN OF A LINE, and `LineState::advance` refuses a leading operator.
// But a tile standing alone in the main direction forms a run of length one,
// which is not a line at all — `validatePlaceMove` skips it explicitly with
// `if (run.size() < 2) continue`. A structural rule was being enforced against
// a line that does not exist.
//
// The class is not about '=' or '×'. It is about a state — an EMPTY line prefix
// — so the test enumerates every operator the rules allow and lets the rules say
// which ones should appear.
//
// Part 1 pins the defect to one component. Part 2 is the two-way equivalence
// over a real corpus, which is what keeps it fixed.
#include <array>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "../src/board.hpp"
#include "../src/inc_board.hpp"
#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/rules.hpp"
#include "../src/selfplay.hpp"
#include "../src/space_map.hpp"

using namespace amath;

static int failures = 0;
#define CHECK(cond)                                                                     \
  do {                                                                                  \
    if (!(cond)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); failures++; } \
  } while (0)

static void put(Board& board, int row, int col, const char* tok) {
  const int kind = tileKindFromString(tok);
  const int token = assignedTokenFromString(tok);
  if (kind < 0 || token < 0) { std::printf("bad fixture token %s\n", tok); failures++; return; }
  board.place(row, col, static_cast<uint8_t>(kind), static_cast<uint8_t>(token));
}

// Does complete generation produce this exact one-tile move?
static bool generated(const Board& board, int row, int col, uint8_t kind, uint8_t token,
                      int& scoreOut) {
  TileCounts rack;
  rack.add(kind);
  std::vector<Move> moves;
  GenStats stats;   // nodeLimit 0 = unbounded
  GenOptions opts;  // no dedup, no budget, no start restriction
  generatePlaceMoves(board, rack, moves, &stats, opts);
  CHECK(!stats.truncated);
  for (const Move& m : moves) {
    if (m.placements.size() != 1) continue;
    const Placement& p = m.placements[0];
    if (p.row == row && p.col == col && p.token == token) {
      scoreOut = m.score;
      return true;
    }
  }
  scoreOut = 0;
  return false;
}

// The vertical run of tokens through (row, col) with `token` dropped into it.
static std::vector<uint8_t> verticalRun(const Board& board, int row, int col, uint8_t token) {
  std::vector<uint8_t> above;
  for (int r = row - 1; r >= 0 && board.at(r, col).occupied(); r--) {
    above.push_back(board.at(r, col).token);
  }
  std::vector<uint8_t> run(above.rbegin(), above.rend());
  run.push_back(token);
  for (int r = row + 1; r < BOARD_SIZE && board.at(r, col).occupied(); r++) {
    run.push_back(board.at(r, col).token);
  }
  return run;
}

// ── Part 1: reproduce the two reported cases and localise the fault ─────────
//
// For each case the test asks five independent components the same question and
// prints their answers, so the disagreement is attributed rather than asserted.
static void localise(const char* name, const Board& board, int row, int col, const char* tokStr) {
  const uint8_t kind = static_cast<uint8_t>(tileKindFromString(tokStr));
  const uint8_t token = static_cast<uint8_t>(assignedTokenFromString(tokStr));

  // (a) the rules core, on the run that would actually form
  const std::vector<uint8_t> run = verticalRun(board, row, col, token);
  const LineResult lr = validateLine(run.data(), static_cast<int>(run.size()));

  // (b) the rules, on the whole move
  std::vector<Placement> one{
      {static_cast<uint8_t>(row), static_cast<uint8_t>(col), kind, token}};
  const MoveValidation mv = validatePlaceMove(board, one);

  // (c) the cross mask the generator itself maintains
  IncrementalBoard inc;
  inc.board = board;
  inc.rebuild();
  const int idx = Board::idx(row, col);
  const bool maskAllows = (inc.crossV[idx].mask >> token) & 1u;

  // (d) SpaceMap, built from that same mask
  const SpaceMap map = SpaceMap::build(board);
  bool spaceMapAllows = false;
  for (const HookSite& s : map.hooks) {
    if (s.cell == idx && ((s.playMask >> token) & 1u)) spaceMapAllows = true;
  }

  // (e) LineState asked the question the generator asks it: "may this token
  //     START a line?" — the one component that says no.
  LineState fresh;
  const bool lineStateAllows = fresh.advance(token);

  // (f) complete generation
  int genScore = 0;
  const bool gen = generated(board, row, col, kind, token, genScore);

  std::printf("  %-22s '%s' at (%d,%d)\n", name, tokStr, row, col);
  std::printf("      validateLine(actual run)   : %s\n", lr.valid ? "VALID" : "invalid");
  std::printf("      validatePlaceMove          : %s (score %d)\n",
              mv.valid ? "VALID" : "invalid", mv.score);
  std::printf("      crossV mask                : %s\n", maskAllows ? "allows" : "forbids");
  std::printf("      SpaceMap playMask          : %s\n", spaceMapAllows ? "allows" : "forbids");
  std::printf("      LineState::advance at len 0: %s   <-- the generator's gate\n",
              lineStateAllows ? "allows" : "REFUSES");
  std::printf("      generatePlaceMoves         : %s (score %d)\n",
              gen ? "emits" : "DOES NOT EMIT", genScore);

  // The move is legal. Four components agree; the fifth is the generator's use
  // of LineState, and that is where the fault is.
  CHECK(lr.valid);
  CHECK(mv.valid);
  CHECK(maskAllows);
  CHECK(spaceMapAllows);
  // The cell must genuinely have no main-direction (horizontal) neighbour, or
  // the refusal would be correct rather than premature.
  CHECK(!(col > 0 && board.at(row, col - 1).occupied()));
  CHECK(!(col + 1 < BOARD_SIZE && board.at(row, col + 1).occupied()));
  // What the fix has to deliver: generation emits it, and scores it as the
  // rules do.
  CHECK(gen);
  if (gen) CHECK(genScore == mv.score);
}

static void part1() {
  std::printf("part 1: the reported cases, attributed component by component\n");

  // A lone '=' hooking two isolated 7s into "7=7". The most valuable member of
  // the class and the one an A-Math player reaches for constantly.
  {
    Board b;
    put(b, 6, 7, "7");
    put(b, 8, 7, "7");
    localise("lone '=' hook", b, 7, 7, "=");
  }

  // A lone '×' completing "1×5=5".
  {
    Board b;
    put(b, 6, 7, "1");
    put(b, 8, 7, "5");
    put(b, 9, 7, "=");
    put(b, 10, 7, "5");
    localise("lone 'x' hook", b, 7, 7, "x");
  }

  // '+' and '÷', so the fix is shown to be about the empty line prefix and not
  // about two particular tokens.
  {
    Board b;                       // 2 _ 3 = 5   vertically  ->  '+'
    put(b, 6, 7, "2");
    put(b, 8, 7, "3");
    put(b, 9, 7, "=");
    put(b, 10, 7, "5");
    localise("lone '+' hook", b, 7, 7, "+");
  }
  {
    Board b;                       // 6 _ 3 = 2   vertically  ->  '/'
    put(b, 6, 7, "6");
    put(b, 8, 7, "3");
    put(b, 9, 7, "=");
    put(b, 10, 7, "2");
    localise("lone '/' hook", b, 7, 7, "/");
  }

  // The control: with a horizontal neighbour the run really is a line, so the
  // refusal is correct and must SURVIVE the fix.
  {
    Board b;
    put(b, 7, 4, "3");
    put(b, 7, 5, "+");
    put(b, 7, 6, "4");
    put(b, 7, 7, "=");
    put(b, 7, 8, "7");
    put(b, 6, 9, "7");
    put(b, 8, 9, "7");
    const uint8_t eq = T_EQ;
    std::vector<Placement> one{{7, 9, K_EQUALS, eq}};
    const MoveValidation mv = validatePlaceMove(b, one);
    int score = 0;
    const bool gen = generated(b, 7, 9, K_EQUALS, eq, score);
    std::printf("  %-22s '=' at (7,9)\n", "control: real line");
    std::printf("      validatePlaceMove          : %s\n", mv.valid ? "VALID" : "invalid");
    std::printf("      generatePlaceMoves         : %s\n", gen ? "emits" : "does not emit");
    // "3+4=7" + "=" would be a horizontal line ending in an operator: illegal.
    CHECK(!mv.valid);
    CHECK(!gen);
  }
}

// ── Part 2: two-way equivalence over real positions ─────────────────────────
//
// Every one-tile placement the rules accept must be generated, and every
// one-tile placement generated must be accepted. No exceptions, no quarantine.
struct Stats {
  int positions = 0;
  int rulesLegal = 0;
  int missedByGen = 0;
  int inventedByGen = 0;
  int scoreMismatch = 0;
};

static void checkBoard(const Board& board, const char* where, Stats& st) {
  st.positions++;

  // Everything the rules allow, per (cell, token) at that token's own tile.
  std::map<std::pair<int, int>, int> legal;
  for (int row = 0; row < BOARD_SIZE; row++) {
    for (int col = 0; col < BOARD_SIZE; col++) {
      if (board.at(row, col).occupied()) continue;
      for (uint8_t token = 0; token < ASSIGNED_COUNT; token++) {
        const uint8_t kind = canonicalKindForToken(token);
        if (kind == K_NONE) continue;
        std::vector<Placement> one{
            {static_cast<uint8_t>(row), static_cast<uint8_t>(col), kind, token}};
        const MoveValidation v = validatePlaceMove(board, one);
        if (v.valid) legal[{Board::idx(row, col), token}] = v.score;
      }
    }
  }
  st.rulesLegal += static_cast<int>(legal.size());

  // Everything generation produces, from one-tile racks.
  std::map<std::pair<int, int>, int> emitted;
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    TileCounts rack;
    rack.add(kind);
    std::vector<Move> moves;
    GenStats stats;
    GenOptions opts;
    generatePlaceMoves(board, rack, moves, &stats, opts);
    CHECK(!stats.truncated);
    for (const Move& m : moves) {
      if (m.placements.size() != 1) continue;
      const Placement& p = m.placements[0];
      if (canonicalKindForToken(p.token) != kind) continue;  // canonical view only
      emitted[{Board::idx(p.row, p.col), p.token}] = m.score;
    }
  }

  for (const auto& e : legal) {
    const auto it = emitted.find(e.first);
    if (it == emitted.end()) {
      if (st.missedByGen < 6) {
        std::printf("FAIL %s: (%d,%d) '%s' legal by rules, NOT generated\n", where,
                    e.first.first / BOARD_SIZE, e.first.first % BOARD_SIZE,
                    assignedTokenToString(static_cast<uint8_t>(e.first.second)).c_str());
      }
      st.missedByGen++;
      failures++;
    } else if (it->second != e.second) {
      if (st.scoreMismatch < 6) {
        std::printf("FAIL %s: (%d,%d) '%s' score gen=%d rules=%d\n", where,
                    e.first.first / BOARD_SIZE, e.first.first % BOARD_SIZE,
                    assignedTokenToString(static_cast<uint8_t>(e.first.second)).c_str(),
                    it->second, e.second);
      }
      st.scoreMismatch++;
      failures++;
    }
  }
  for (const auto& e : emitted) {
    if (legal.count(e.first)) continue;
    if (st.inventedByGen < 6) {
      std::printf("FAIL %s: (%d,%d) '%s' GENERATED but illegal by rules\n", where,
                  e.first.first / BOARD_SIZE, e.first.first % BOARD_SIZE,
                  assignedTokenToString(static_cast<uint8_t>(e.first.second)).c_str());
    }
    st.inventedByGen++;
    failures++;
  }
}

static bool pickMove(const Board& board, const TileCounts& rack, Move& out) {
  GenOptions opts; opts.dedup = true; opts.premiumOrder = true;
  GenStats stats; stats.nodeLimit = 1'000'000;
  std::vector<Move> moves;
  generatePlaceMoves(board, rack, moves, &stats, opts);
  if (moves.empty()) return false;
  size_t best = 0;
  for (size_t i = 1; i < moves.size(); i++) if (moves[i].score > moves[best].score) best = i;
  out = moves[best];
  return true;
}

static std::string placeResponse(const Move& move) {
  auto resp = json::makeObject();
  resp->obj["type"] = json::makeString("place");
  auto arr = json::makeArray();
  for (const Placement& p : move.placements) {
    auto e = json::makeObject();
    e->obj["r"] = json::makeInt(p.row);
    e->obj["c"] = json::makeInt(p.col);
    e->obj["kind"] = json::makeString(tileKindToString(p.kind));
    e->obj["token"] = json::makeString(assignedTokenToString(p.token));
    arr->arr.push_back(e);
  }
  resp->obj["placements"] = arr;
  resp->obj["score"] = json::makeInt(move.score);
  return json::stringify(resp);
}

static void part2(int games, Stats& st) {
  std::printf("\npart 2: two-way equivalence with the rules, over real positions\n");
  for (uint32_t seed = 1; seed <= static_cast<uint32_t>(games); seed++) {
    GameSim sim(seed);
    int side = 0;
    for (int turn = 0; turn < 40 && !sim.finished; turn++) {
      Move move;
      if (!pickMove(sim.board, sim.racks[side], move)) {
        if (!sim.applyResponse(side, "{\"type\":\"pass\"}")) break;
        side = 1 - side;
        continue;
      }
      if (!sim.applyResponse(side, placeResponse(move))) break;
      const std::string where =
          "seed=" + std::to_string(seed) + " turn=" + std::to_string(turn);
      checkBoard(sim.board, where.c_str(), st);
      side = 1 - side;
    }
  }
  std::printf("  %d positions, %d legal one-tile placements\n", st.positions, st.rulesLegal);
  std::printf("  legal but not generated : %d\n", st.missedByGen);
  std::printf("  generated but illegal   : %d\n", st.inventedByGen);
  std::printf("  score mismatches        : %d\n", st.scoreMismatch);
}

int main(int argc, char** argv) {
  const int games = argc > 1 ? std::atoi(argv[1]) : 12;
  part1();
  Stats st;
  part2(games, st);
  if (failures == 0) std::printf("\nALL MOVEGEN-SINGLES TESTS PASSED\n");
  else std::printf("\ntest_movegen_singles: %d FAILURES\n", failures);
  return failures == 0 ? 0 : 1;
}
