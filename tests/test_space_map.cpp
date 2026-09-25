// Phase 0 test: prove SpaceMap is the board's real opportunity map, and that it
// agrees with the generator wherever the generator is right.
//
// ── the oracle ──────────────────────────────────────────────────────────────
//
// Ground truth is `validatePlaceMove` (src/rules.cpp), the Shared Constraint
// Core that mirrors EQ-Lab's game.ts. It is independent of BOTH things under
// test: it does not consult a cross mask and it does not consult the generator.
// For every empty cell and every assigned token we ask it whether one tile
// played there is legal and what it scores; that answer set is what SpaceMap
// must reproduce exactly.
//
// Complete move generation is then checked against the SAME oracle as a second
// party. That comparison is what found the defect described below — and it is
// why the oracle is the rules and not the generator: had this test been written
// against `generatePlaceMoves`, it would have canonised the bug.
//
// ── a defect this test found, now fixed ───────────────────────────────────
//
// The first run of this test showed `generatePlaceMoves` dropping every legal
// ONE-TILE placement of an operator other than '-' when no tile adjoined the
// cell in the main direction: singles come from the horizontal pass, `startAt`
// seeds `LineState` from the left prefix alone, and with no prefix the token was
// judged as the first token of a line that did not exist. The generator's own
// cross mask, SpaceMap, `validateLine` and `validatePlaceMove` all called those
// moves legal; only that one gate refused them.
//
// It is fixed in movegen.cpp (see `runStaysSolo`), and the disagreement is no
// longer tolerated here in either direction. tests/test_movegen_singles.cpp is
// the dedicated regression for it.

#include <algorithm>
#include <array>
#include <chrono>
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

#define CHECK_EQ(a, b)                                                                  \
  do {                                                                                  \
    const long long va_ = static_cast<long long>(a);                                    \
    const long long vb_ = static_cast<long long>(b);                                    \
    if (va_ != vb_) {                                                                   \
      std::printf("FAIL %s:%d %s == %s (%lld vs %lld)\n", __FILE__, __LINE__, #a, #b,   \
                  va_, vb_);                                                            \
      failures++;                                                                       \
    }                                                                                   \
  } while (0)

// ── ground truth from the rules ─────────────────────────────────────────────

struct RulesTruth {
  std::map<std::pair<int, int>, int> score;  // (cell, token) -> score, canonical kind
  std::set<int> cells;                       // any token legal here
  std::set<int> nonEqualsCells;
  std::set<int> equalsOnlyCells;
  std::set<int> heavyCells;
  std::array<std::set<int>, KIND_COUNT> kindCells;
};

static RulesTruth rulesTruth(const Board& board) {
  RulesTruth truth;
  std::set<int> equalsCells;
  for (int row = 0; row < BOARD_SIZE; row++) {
    for (int col = 0; col < BOARD_SIZE; col++) {
      if (board.at(row, col).occupied()) continue;
      const int cell = Board::idx(row, col);
      for (uint8_t token = 0; token < ASSIGNED_COUNT; token++) {
        const uint8_t kind = canonicalKindForToken(token);
        if (kind == K_NONE) continue;
        std::vector<Placement> one{
            {static_cast<uint8_t>(row), static_cast<uint8_t>(col), kind, token}};
        const MoveValidation v = validatePlaceMove(board, one);
        if (!v.valid) continue;
        truth.score[{cell, token}] = v.score;
        truth.cells.insert(cell);
        if (token == T_EQ) equalsCells.insert(cell);
        else truth.nonEqualsCells.insert(cell);
        if (token >= 10 && token <= T_NUM20) truth.heavyCells.insert(cell);
        // Any physical tile that can be ASSIGNED this token reaches this cell.
        for (uint8_t k = 0; k < KIND_COUNT; k++) {
          if (kindAssignMask(k) & (1u << token)) truth.kindCells[k].insert(cell);
        }
      }
    }
  }
  for (int cell : equalsCells) {
    if (!truth.nonEqualsCells.count(cell)) truth.equalsOnlyCells.insert(cell);
  }
  return truth;
}

// ── what complete generation actually produces ──────────────────────────────

struct GenView {
  std::map<std::pair<int, int>, int> score;  // (cell, token) -> score, canonical kind
  std::array<std::set<int>, KIND_COUNT> kindCells;
};

static GenView generateView(const Board& board) {
  GenView view;
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    TileCounts rack;
    rack.add(kind);
    std::vector<Move> moves;
    GenStats stats;   // nodeLimit 0 = unbounded: enumeration must be complete
    GenOptions opts;  // defaults: no dedup, no budget, no start restriction
    generatePlaceMoves(board, rack, moves, &stats, opts);
    CHECK(!stats.truncated);
    for (const Move& move : moves) {
      CHECK_EQ(move.placements.size(), 1);
      if (move.placements.size() != 1) continue;
      const Placement& p = move.placements[0];
      const int cell = Board::idx(p.row, p.col);
      view.kindCells[kind].insert(cell);
      if (canonicalKindForToken(p.token) == kind) view.score[{cell, p.token}] = move.score;
    }
  }
  return view;
}

// ── coverage census ─────────────────────────────────────────────────────────

struct Coverage {
  int boards = 0;
  int maskZeroCells = 0;
  int singleTokenSites = 0;
  int equalsGatedSites = 0;
  int nonEqualsKeySites = 0;
  int crossOnlySites = 0;
  int extendOnlySites = 0;
  int bothRunSites = 0;
  int bothRunDeadCells = 0;
  int heavySites = 0;
  int longExtendRegions = 0;
  int equalsRunExtends = 0;
  int crossingBoards = 0;
  int nearlyClosedBoards = 0;
};

// ── the whole check, run on one position ────────────────────────────────────

static void checkPosition(const Board& board, const char* where, Coverage& cov) {
  cov.boards++;

  IncrementalBoard inc;
  inc.board = board;
  inc.rebuild();
  CHECK(inc.assertConsistent(where));

  const SpaceMap map = SpaceMap::build(board);
  const SpaceMap fromInc = SpaceMap::build(inc);
  const RulesTruth truth = rulesTruth(board);
  const GenView gen = generateView(board);

  // (0) both construction routes agree; the map is internally consistent; and
  //     it sees the same board topology the generator's own state describes.
  CHECK(map.assertConsistent(board, where));
  CHECK(fromInc.assertConsistent(board, where));
  CHECK(map.assertTopologyMatches(inc, where));
  CHECK_EQ(map.hookSiteCount, fromInc.hookSiteCount);
  CHECK_EQ(map.extendCapacity, fromInc.extendCapacity);

  // ── SpaceMap vs THE RULES: exact, no exceptions ──────────────────────────

  std::set<int> hookCells;
  for (const HookSite& site : map.hooks) hookCells.insert(site.cell);
  CHECK(hookCells == truth.cells);

  for (const HookSite& site : map.hooks) {
    const int row = site.cell / BOARD_SIZE, col = site.cell % BOARD_SIZE;
    CHECK(site.playMask != 0);
    for (uint8_t token = 0; token < ASSIGNED_COUNT; token++) {
      const bool mapSays = (site.playMask >> token) & 1u;
      const auto it = truth.score.find({site.cell, token});
      const bool rulesSay = it != truth.score.end();
      if (mapSays != rulesSay) {
        std::printf("FAIL %s: cell(%d,%d) token %s map=%d rules=%d\n", where, row, col,
                    assignedTokenToString(token).c_str(), mapSays, rulesSay);
        failures++;
        continue;
      }
      if (!rulesSay) continue;
      const int mine = oneTileScore(inc, row, col, canonicalKindForToken(token));
      if (mine != it->second) {
        std::printf("FAIL %s: cell(%d,%d) token %s score map=%d rules=%d\n", where, row, col,
                    assignedTokenToString(token).c_str(), mine, it->second);
        failures++;
      }
    }
    int best = -1;
    uint8_t bestToken = T_NONE;
    for (uint8_t token = 0; token < ASSIGNED_COUNT; token++) {
      if (!((site.playMask >> token) & 1u)) continue;
      const int score = oneTileScore(inc, row, col, canonicalKindForToken(token));
      if (score > best) { best = score; bestToken = token; }
    }
    CHECK_EQ(site.bestScore, best);
    CHECK_EQ(site.bestToken, bestToken);
  }

  for (uint8_t token = 0; token < ASSIGNED_COUNT; token++) {
    int sites = 0, best = 0;
    for (const auto& entry : truth.score) {
      if (entry.first.second != token) continue;
      sites++;
      best = std::max(best, entry.second);
    }
    CHECK_EQ(map.sitesForToken[token], sites);
    CHECK_EQ(map.bestScoreForToken[token], best);
  }

  // Per-KIND reach, including the blank and the two choice tiles — the view
  // that a token-keyed table cannot express.
  for (uint8_t kind = 0; kind < KIND_COUNT; kind++) {
    CHECK_EQ(map.sitesForKind[kind], truth.kindCells[kind].size());
  }
  CHECK_EQ(map.sitesForKind[K_BLANK], map.hookSiteCount);
  CHECK(truth.kindCells[K_BLANK] == truth.cells);

  CHECK_EQ(map.equalsGatedSites, truth.equalsOnlyCells.size());
  CHECK_EQ(map.equalsFreeSites, truth.nonEqualsCells.size());
  CHECK_EQ(map.heavyPlaceableSites, truth.heavyCells.size());
  CHECK_EQ(map.hookSiteCount, truth.cells.size());

  int deadExpected = 0;
  for (int idx = 0; idx < BOARD_CELLS; idx++) {
    if (inc.anchor[idx] && !truth.cells.count(idx)) deadExpected++;
  }
  CHECK_EQ(map.deadCells, deadExpected);

  // ── movegen vs THE RULES: equal except for the quarantined defect ────────

  for (const auto& entry : truth.score) {
    const int cell = entry.first.first;
    const uint8_t token = static_cast<uint8_t>(entry.first.second);
    const auto it = gen.score.find(entry.first);
    if (it == gen.score.end()) {
      std::printf("FAIL %s: cell(%d,%d) token %s legal by rules, NOT generated\n", where,
                  cell / BOARD_SIZE, cell % BOARD_SIZE, assignedTokenToString(token).c_str());
      failures++;
      continue;
    }
    if (it->second != entry.second) {
      std::printf("FAIL %s: cell(%d,%d) token %s SCORE gen=%d rules=%d\n", where,
                  cell / BOARD_SIZE, cell % BOARD_SIZE, assignedTokenToString(token).c_str(),
                  it->second, entry.second);
      failures++;
    }
  }

  // The reverse can never be tolerated: generation must not invent a move the
  // rules reject.
  for (const auto& entry : gen.score) {
    if (truth.score.count(entry.first)) continue;
    std::printf("FAIL %s: cell(%d,%d) token %s GENERATED but illegal by rules\n", where,
                entry.first.first / BOARD_SIZE, entry.first.first % BOARD_SIZE,
                assignedTokenToString(static_cast<uint8_t>(entry.first.second)).c_str());
    failures++;
  }

  // ── extendCapacity, recounted by an independent scan of occupancy ────────
  uint32_t capacity = 0;
  int newEqRegions = 0;
  for (int dir = 0; dir < 2; dir++) {
    const bool horizontal = dir == 1;
    for (int line = 0; line < BOARD_SIZE; line++) {
      int run = 0;
      bool touched = false;
      for (int i = 0; i <= BOARD_SIZE; i++) {
        const bool occupied =
            i < BOARD_SIZE && board.at(horizontal ? line : i, horizontal ? i : line).occupied();
        if (i < BOARD_SIZE && !occupied) {
          if (run == 0 && i > 0) touched = true;
          run++;
        } else {
          if (run > 0 && (touched || i < BOARD_SIZE)) {
            capacity += run;
            if (run >= 3) newEqRegions++;
          }
          run = 0;
          touched = false;
        }
      }
    }
  }
  CHECK_EQ(map.extendCapacity, capacity);
  CHECK_EQ(map.newEquationCapacity, newEqRegions);

  // ── census ───────────────────────────────────────────────────────────────
  bool sawBothRun = false;
  int live = 0, dead = 0;
  for (const HookSite& site : map.hooks) {
    live++;
    if (site.tokenCount == 1) {
      cov.singleTokenSites++;
      if (site.playMask == EQUALS_TOKEN_MASK) cov.equalsGatedSites++;
      else cov.nonEqualsKeySites++;
    }
    if (site.hasV && site.hasH) { cov.bothRunSites++; sawBothRun = true; }
    else if (site.hasV) cov.crossOnlySites++;
    else cov.extendOnlySites++;
    if (site.playMask & TENS_TOKEN_MASK) cov.heavySites++;
  }
  for (int idx = 0; idx < BOARD_CELLS; idx++) {
    if (!inc.anchor[idx] || hookCells.count(idx)) continue;
    dead++;
    cov.maskZeroCells++;
    if (inc.crossV[idx].has && inc.crossH[idx].has) cov.bothRunDeadCells++;
  }
  for (const ExtendSite& site : map.extends) {
    if (site.length >= 4) cov.longExtendRegions++;
    if (site.runHasEquals) cov.equalsRunExtends++;
  }
  if (sawBothRun) cov.crossingBoards++;
  if (dead > live && live > 0) cov.nearlyClosedBoards++;
}

// ── fixtures ────────────────────────────────────────────────────────────────

static void put(Board& board, int row, int col, const char* tok) {
  const int kind = tileKindFromString(tok);
  const int token = assignedTokenFromString(tok);
  if (kind < 0 || token < 0) { std::printf("bad fixture token %s\n", tok); failures++; return; }
  board.place(row, col, static_cast<uint8_t>(kind), static_cast<uint8_t>(token));
}

static const HookSite* siteAt(const SpaceMap& map, int row, int col) {
  for (const HookSite& s : map.hooks) {
    if (s.cell == Board::idx(row, col)) return &s;
  }
  return nullptr;
}

// Hand-built positions for the classes a self-play corpus does not reach.
// Every claim below is independently confirmed by validatePlaceMove inside
// checkPosition, so a wrong fixture fails rather than passing quietly.
static void runFixtures(Coverage& cov) {
  // (A) a key site whose single token is NOT '=': "1 _ 5=5" reads 1×5=5 and
  //     nothing else balances.
  {
    Board b;
    put(b, 6, 7, "1");
    put(b, 8, 7, "5");
    put(b, 9, 7, "=");
    put(b, 10, 7, "5");
    const SpaceMap map = SpaceMap::build(b);
    const HookSite* hole = siteAt(map, 7, 7);
    CHECK(hole != nullptr);
    if (hole) {
      CHECK_EQ(hole->tokenCount, 1);
      CHECK_EQ(hole->playMask, 1u << T_MUL);
      CHECK(hole->hasV && !hole->hasH);
    }
    checkPosition(b, "fixture:key-times", cov);
  }

  // (B) an equals-gated site: two lone 7s straddling a hole read "7=7" and
  //     nothing else — no digit (a 3-digit number holds no '='), no operator.
  {
    Board b;
    put(b, 6, 7, "7");
    put(b, 8, 7, "7");
    const SpaceMap map = SpaceMap::build(b);
    const HookSite* hole = siteAt(map, 7, 7);
    CHECK(hole != nullptr);
    if (hole) {
      CHECK_EQ(hole->playMask, EQUALS_TOKEN_MASK);
      CHECK_EQ(hole->tokenCount, 1);
    }
    CHECK_EQ(map.equalsGatedSites, 1);
    checkPosition(b, "fixture:equals-gated", cov);
  }

  // (C) mask = 0 at both ends of a finished equation: nothing extends "3+4=7"
  //     by exactly one tile in its own direction.
  {
    Board b;
    put(b, 7, 4, "3");
    put(b, 7, 5, "+");
    put(b, 7, 6, "4");
    put(b, 7, 7, "=");
    put(b, 7, 8, "7");
    IncrementalBoard inc; inc.board = b; inc.rebuild();
    CHECK_EQ(inc.crossH[Board::idx(7, 9)].mask, 0u);
    CHECK_EQ(inc.crossH[Board::idx(7, 3)].mask, 0u);
    const SpaceMap map = SpaceMap::build(b);
    CHECK(siteAt(map, 7, 9) == nullptr);
    CHECK(siteAt(map, 7, 3) == nullptr);
    CHECK(map.deadCells >= 2);
    checkPosition(b, "fixture:dead-ends", cov);
  }

  // (D) two runs meeting at one hole whose masks intersect to NOTHING. Reading
  //     either direction alone calls this an equals-gated site; the
  //     intersection is what makes it dead. This is the misreading `playMask`
  //     exists to prevent.
  {
    Board b;
    put(b, 7, 4, "3");
    put(b, 7, 5, "+");
    put(b, 7, 6, "4");
    put(b, 7, 7, "=");
    put(b, 7, 8, "7");
    put(b, 6, 9, "7");
    put(b, 8, 9, "7");
    IncrementalBoard inc; inc.board = b; inc.rebuild();
    const int hole = Board::idx(7, 9);
    CHECK(inc.crossV[hole].has && inc.crossH[hole].has);
    CHECK_EQ(inc.crossV[hole].mask, EQUALS_TOKEN_MASK);  // vertical alone says '='
    CHECK_EQ(inc.crossH[hole].mask, 0u);                 // horizontal says nothing
    const SpaceMap map = SpaceMap::build(b);
    CHECK(siteAt(map, 7, 9) == nullptr);
    checkPosition(b, "fixture:conflicting-runs", cov);
  }

  // (E) two runs meeting at one hole whose masks AGREE: four lone 7s around a
  //     gap. One '=' completes "7=7" in both directions and scores both.
  {
    Board b;
    put(b, 6, 7, "7");
    put(b, 8, 7, "7");
    put(b, 7, 6, "7");
    put(b, 7, 8, "7");
    const SpaceMap map = SpaceMap::build(b);
    const HookSite* hole = siteAt(map, 7, 7);
    CHECK(hole != nullptr);
    if (hole) {
      CHECK(hole->hasV && hole->hasH);
      CHECK_EQ(hole->playMask, EQUALS_TOKEN_MASK);
      // scored twice — once per equation completed
      CHECK_EQ(hole->bestScore, 14);
    }
    checkPosition(b, "fixture:two-run-site", cov);
  }

  // (F) a long extension region: one equation on an otherwise empty board
  //     leaves the rest of its row and column as room to grow into.
  {
    Board b;
    put(b, 7, 6, "6");
    put(b, 7, 7, "=");
    put(b, 7, 8, "6");
    const SpaceMap map = SpaceMap::build(b);
    int longest = 0;
    bool sawEqualsRun = false;
    for (const ExtendSite& s : map.extends) {
      longest = std::max<int>(longest, s.length);
      if (s.runHasEquals) sawEqualsRun = true;
    }
    CHECK(longest >= 6);
    CHECK(map.extendCapacity > 0);
    CHECK(sawEqualsRun);
    checkPosition(b, "fixture:long-extend", cov);
  }

  // (G) the empty board: no runs, so no sites and no capacity. The degenerate
  //     case every counter has to survive.
  {
    Board b;
    const SpaceMap map = SpaceMap::build(b);
    CHECK_EQ(map.hookSiteCount, 0);
    CHECK_EQ(map.deadCells, 0);
    CHECK_EQ(map.extendCapacity, 0);
    CHECK_EQ(map.equalsGatedSites, 0);
    CHECK_EQ(map.equalsFreeSites, 0);
    CHECK_EQ(map.newEquationCapacity, 0);
    checkPosition(b, "fixture:empty", cov);
  }
}

// ── self-play corpus ────────────────────────────────────────────────────────

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

int main(int argc, char** argv) {
  const int games = argc > 1 ? std::atoi(argv[1]) : 12;
  Coverage cov;

  runFixtures(cov);

  // Real positions: play games out with a deterministic top-score picker and
  // check the map after every committed move, so the corpus spans openings,
  // crowded midgames and the closed boards games end on.
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
          "selfplay seed=" + std::to_string(seed) + " turn=" + std::to_string(turn);
      checkPosition(sim.board, where.c_str(), cov);
      side = 1 - side;
    }
  }

  // ── coverage the suite must have exercised ───────────────────────────────
  struct Class { const char* name; int count; bool required; };
  const Class classes[] = {
      {"cells adjacent to structure, no 1-tile move", cov.maskZeroCells, true},
      {"single-token sites", cov.singleTokenSites, true},
      {"  ... gated on '='", cov.equalsGatedSites, true},
      {"  ... keyed on a non-'=' tile", cov.nonEqualsKeySites, true},
      {"vertical-run-only sites", cov.crossOnlySites, true},
      {"horizontal-run-only sites", cov.extendOnlySites, true},
      {"two-run sites (one tile, two equations)", cov.bothRunSites, true},
      {"two-run cells whose masks conflict", cov.bothRunDeadCells, true},
      {"extend regions of length >= 4", cov.longExtendRegions, true},
      {"extends alongside a run holding '='", cov.equalsRunExtends, true},
      {"boards with crossing runs", cov.crossingBoards, true},
      {"nearly-closed boards (dead > live)", cov.nearlyClosedBoards, true},
      // Not required: a 10..20 token needs an operator or a boundary on both
      // sides of its run, and a fragment adjoining a hole is either a complete
      // equation (which ends in a number) or a lone tile — so a ONE-TILE heavy
      // placement appears to be structurally impossible. Reported, not asserted:
      // the corpus can show it is rare, not that it is impossible.
      {"heavy-placeable sites (informational)", cov.heavySites, false},
  };
  std::printf("\ncoverage over %d positions:\n", cov.boards);
  for (const Class& c : classes) {
    const bool missing = c.count == 0 && c.required;
    std::printf("  %-44s %7d%s\n", c.name, c.count, missing ? "   <-- NOT COVERED" : "");
    if (missing) failures++;
  }

  // ── cost of attaching a SpaceMap to a decision ───────────────────────────
  {
    GameSim sim(3);
    int side = 0;
    for (int t = 0; t < 24 && !sim.finished; t++) {
      Move move;
      if (!pickMove(sim.board, sim.racks[side], move)) break;
      if (!sim.applyResponse(side, placeResponse(move))) break;
      side = 1 - side;
    }
    IncrementalBoard inc; inc.board = sim.board; inc.rebuild();
    const int iters = 2000;
    uint32_t sink = 0;
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iters; i++) sink += SpaceMap::build(inc).hookSiteCount;
    const auto t1 = std::chrono::steady_clock::now();
    for (int i = 0; i < iters; i++) sink += SpaceMap::build(sim.board).hookSiteCount;
    const auto t2 = std::chrono::steady_clock::now();
    std::printf("\ncost on a %d-tile board: %.4f ms from maintained cross state, "
                "%.4f ms including a full IncrementalBoard rebuild (checksum %u)\n",
                sim.board.tileCount,
                std::chrono::duration<double, std::milli>(t1 - t0).count() / iters,
                std::chrono::duration<double, std::milli>(t2 - t1).count() / iters, sink);
  }

  if (failures == 0) std::printf("\ntest_space_map: OK\n");
  else std::printf("\ntest_space_map: %d FAILURES\n", failures);
  return failures == 0 ? 0 : 1;
}
