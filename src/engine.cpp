#include "engine.hpp"

#include <algorithm>
#include <chrono>
#include <random>
#include <unordered_map>

#include "board.hpp"
#include "eval.hpp"
#include "json.hpp"
#include "movegen.hpp"
#include "rules.hpp"

namespace amath {

namespace {

ProgressFn g_progress = nullptr;

using Clock = std::chrono::steady_clock;

double msSince(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

void report(const std::string& phase, double percent, double elapsedMs, double etaMs,
            int bestScore, const std::string& detail) {
  if (!g_progress) return;
  auto o = json::makeObject();
  o->obj["phase"] = json::makeString(phase);
  o->obj["percent"] = json::makeDouble(percent);
  o->obj["elapsedMs"] = json::makeDouble(elapsedMs);
  o->obj["etaMs"] = json::makeDouble(etaMs);
  o->obj["bestScore"] = json::makeInt(bestScore);
  o->obj["detail"] = json::makeString(detail);
  const std::string s = json::stringify(o);
  g_progress(s.c_str());
}

// ── request model ────────────────────────────────────────────────────────────

struct Request {
  Board board;
  TileCounts rack;
  TileCounts unseen;  // full distribution − board − my rack
  int bagCount = 0;
  int oppRackCount = 0;
  int myScore = 0;
  int oppScore = 0;
  int noScoreStreak = 0;
  bool exchangeAllowed = false;
  std::string difficulty = "normal";
  double budgetMs = 0;
  uint32_t seed = 1;
};

bool parseRequest(const std::string& text, Request& req, std::string& error) {
  json::ValuePtr root = json::parse(text);
  if (!root || root->type != json::Value::Type::Object) {
    error = "bad request json";
    return false;
  }

  for (uint8_t k = 0; k < KIND_COUNT; k++) req.unseen.add(k, TILE_COUNTS[k]);

  if (auto cells = root->get("board"); cells && cells->type == json::Value::Type::Array) {
    for (const auto& cell : cells->arr) {
      const int r = static_cast<int>(cell->get("r") ? cell->get("r")->asInt(-1) : -1);
      const int c = static_cast<int>(cell->get("c") ? cell->get("c")->asInt(-1) : -1);
      const int kind = tileKindFromString(cell->get("kind") ? cell->get("kind")->asString() : "");
      const int token =
          assignedTokenFromString(cell->get("token") ? cell->get("token")->asString() : "");
      if (!inBounds(r, c) || kind < 0 || token < 0) {
        error = "bad board cell";
        return false;
      }
      req.board.place(r, c, static_cast<uint8_t>(kind), static_cast<uint8_t>(token));
      if (req.unseen.n[kind] > 0) req.unseen.sub(kind);
    }
  }

  if (auto rack = root->get("rack"); rack && rack->type == json::Value::Type::Array) {
    for (const auto& t : rack->arr) {
      const int kind = tileKindFromString(t->asString());
      if (kind < 0) {
        error = "bad rack tile";
        return false;
      }
      req.rack.add(static_cast<uint8_t>(kind));
      if (req.unseen.n[kind] > 0) req.unseen.sub(kind);
    }
  }

  auto readInt = [&](const char* key, int fallback) {
    auto v = root->get(key);
    return v ? static_cast<int>(v->asInt(fallback)) : fallback;
  };
  req.bagCount = readInt("bagCount", 0);
  req.oppRackCount = readInt("oppRackCount", 0);
  req.myScore = readInt("myScore", 0);
  req.oppScore = readInt("oppScore", 0);
  req.noScoreStreak = readInt("noScoreStreak", 0);
  req.exchangeAllowed = root->get("exchangeAllowed") ? root->get("exchangeAllowed")->asBool() : false;
  if (auto d = root->get("difficulty")) req.difficulty = d->asString();
  if (auto b = root->get("budgetMs")) req.budgetMs = b->asDouble(0);
  if (auto s = root->get("seed")) req.seed = static_cast<uint32_t>(s->asInt(1));
  return true;
}

// ── difficulty configuration (BIAS POINTS for M5 tuning) ─────────────────────

struct Config {
  bool useLeave = true;        // static equity vs raw score
  int pickFromTop = 1;         // easy picks randomly among the best N
  int simTopK = 0;             // 0 = no simulation
  int simSamples = 0;
  bool endgameExact = false;
  long long endgameNodeBudget = 0;
  int endgameBeamFallback = 0;  // beam width for the approximate retry
  double defaultBudgetMs = 800;
  // Wall-clock ceiling for root move generation. Generation is premium-ordered
  // and RAM-bounded (dedup), so hitting this ceiling loses only off-premium
  // long-tail moves, never the board's best plays. A blank-heavy position can
  // legitimately want tens of seconds to enumerate fully.
  double genBudgetMs = 500;
};

Config configFor(const std::string& difficulty) {
  Config c;
  if (difficulty == "easy") {
    c.useLeave = false;
    c.pickFromTop = 5;
    c.defaultBudgetMs = 300;
    c.genBudgetMs = 400;
  } else if (difficulty == "hard") {
    c.simTopK = 20;
    c.simSamples = 30;
    c.endgameExact = true;
    c.endgameNodeBudget = 3'000'000;
    c.endgameBeamFallback = 16;
    c.defaultBudgetMs = 12'000;
    c.genBudgetMs = 6'000;
  } else if (difficulty == "max") {
    c.simTopK = 40;
    c.simSamples = 80;
    c.endgameExact = true;
    c.endgameNodeBudget = 40'000'000;
    c.endgameBeamFallback = 24;
    c.defaultBudgetMs = 110'000;   // stay under the 2-minute user ceiling
    c.genBudgetMs = 45'000;
  } else {  // normal
    c.endgameExact = true;
    c.endgameNodeBudget = 1'000'000;
    c.endgameBeamFallback = 12;
    c.defaultBudgetMs = 2'000;
    c.genBudgetMs = 1'200;
  }
  return c;
}

// ── exchange candidates ──────────────────────────────────────────────────────

// Choose which tiles to swap by what the rack actually NEEDS, judged against
// the live board (mobility, phase) and the real unseen pool — not by fixed
// per-tile constants. Greedily removes the tile whose removal most improves the
// rack toward a strong leave, then draws fresh from the pool. Score situation
// tilts the appetite: when ahead, resist dumping many; when behind, fish harder.
Move bestExchange(const Request& req, const BoardContext& ctx) {
  Move best;
  best.type = MoveType::Exchange;

  const int drawable = std::min({req.rack.total, req.bagCount, 6});
  if (drawable <= 0) return best;

  TileCounts working = req.rack;
  std::vector<uint8_t> removed;
  float bestVal = -1e9f;

  for (int step = 1; step <= drawable; step++) {
    // Pick the tile whose removal yields the best remaining leave.
    int bestKind = -1;
    float bestLeaveAfter = -1e9f;
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      if (working.n[k] == 0) continue;
      working.sub(k);
      const float leaveAfter = leaveValue(working, ctx);
      working.add(k);
      if (leaveAfter > bestLeaveAfter) {
        bestLeaveAfter = leaveAfter;
        bestKind = k;
      }
    }
    if (bestKind < 0) break;
    working.sub(static_cast<uint8_t>(bestKind));
    removed.push_back(static_cast<uint8_t>(bestKind));

    // Value of exchanging this many: remaining leave + expected fresh draws,
    // minus the tempo cost, adjusted for the score situation.
    float val = bestLeaveAfter + ctx.freshTileValue * step - g_leave.exchangeTempoCost;
    if (ctx.scoreDiff > 0) val -= g_leave.leadDumpPenalty * step;      // ahead: keep it tight
    else if (ctx.scoreDiff < 0) val += g_leave.trailFishBonus * step;  // behind: fish

    if (val > bestVal) {
      bestVal = val;
      best.exchangeKinds = removed;
    }
  }
  return best;
}

// ── opponent rack sampling ───────────────────────────────────────────────────

std::vector<TileCounts> sampleOpponentRacks(const Request& req, int samples, std::mt19937& rng) {
  std::vector<uint8_t> pool;
  for (uint8_t k = 0; k < KIND_COUNT; k++) {
    for (int i = 0; i < req.unseen.n[k]; i++) pool.push_back(k);
  }
  const int take = std::min<int>(req.oppRackCount, static_cast<int>(pool.size()));
  std::vector<TileCounts> out;
  out.reserve(samples);
  for (int s = 0; s < samples; s++) {
    std::shuffle(pool.begin(), pool.end(), rng);
    TileCounts rack;
    for (int i = 0; i < take; i++) rack.add(pool[i]);
    out.push_back(rack);
  }
  return out;
}

// ── board apply/undo helpers ─────────────────────────────────────────────────

void applyPlacements(Board& board, const std::vector<Placement>& ps) {
  for (const Placement& p : ps) board.place(p.row, p.col, p.kind, p.token);
}
void undoPlacements(Board& board, const std::vector<Placement>& ps) {
  for (const Placement& p : ps) board.remove(p.row, p.col);
}

// ── 2-ply simulation under hidden information ────────────────────────────────

struct SimResult {
  int bestIndex = -1;
  float bestValue = -1e9f;
  int samplesUsed = 0;
};

SimResult simulate(const Request& req, const std::vector<Move>& candidates, int samples,
                   double budgetMs, Clock::time_point start, std::mt19937& rng,
                   GenStats& stats, const BoardContext& ctx) {
  const std::vector<TileCounts> racks = sampleOpponentRacks(req, samples, rng);
  std::vector<double> accum(candidates.size(), 0.0);
  std::vector<int> seen(candidates.size(), 0);
  std::vector<float> myLeaveAfter(candidates.size());
  Board board = req.board;

  for (size_t i = 0; i < candidates.size(); i++) {
    TileCounts after = req.rack;
    for (const Placement& p : candidates[i].placements) after.sub(p.kind);
    myLeaveAfter[i] = leaveValue(after, ctx);
  }

  // Sample-major with common random numbers: every candidate is scored against
  // the SAME opponent racks, so the comparison stays fair and low-variance even
  // when the budget stops us early. A sample is committed only when every
  // candidate has finished it; a mid-sample timeout discards the partial row so
  // all retained means rest on identical sample sets. The opponent's best reply
  // is estimated with a fast, premium-ordered, node-bounded generation.
  int done = 0;
  std::vector<double> rowVal(candidates.size(), 0.0);
  for (int s = 0; s < static_cast<int>(racks.size()); s++) {
    bool rowComplete = true;
    for (size_t i = 0; i < candidates.size(); i++) {
      if (msSince(start) > budgetMs && done >= 3) {
        rowComplete = false;
        break;
      }
      const Move& cand = candidates[i];
      applyPlacements(board, cand.placements);

      std::vector<Move> replies;
      GenStats replyStats;
      replyStats.nodeLimit = 200'000;  // fast: keeps the sample count high
      GenOptions replyOpts;
      replyOpts.dedup = true;          // bound RAM against blank-heavy opp racks
      replyOpts.premiumOrder = true;   // best reply found first, before the cap
      generatePlaceMoves(board, racks[s], replies, &replyStats, replyOpts);
      stats.nodesVisited += replyStats.nodesVisited;
      float oppBest = leaveValue(racks[s], ctx) - 4.0f;  // opponent passes
      for (const Move& reply : replies) {
        const float v = staticEquity(board, racks[s], reply, ctx);
        if (v > oppBest) oppBest = v;
      }
      rowVal[i] = (cand.score + myLeaveAfter[i]) - oppBest;

      undoPlacements(board, cand.placements);
    }
    if (!rowComplete) break;
    for (size_t i = 0; i < candidates.size(); i++) {
      accum[i] += rowVal[i];
      seen[i]++;
    }
    done = s + 1;

    const double elapsed = msSince(start);
    const double eta = std::min(elapsed / done * (racks.size() - done),
                                std::max(0.0, budgetMs - elapsed));
    int bestScore = 0;
    double bestAcc = -1e18;
    for (size_t i = 0; i < candidates.size(); i++)
      if (accum[i] > bestAcc) { bestAcc = accum[i]; bestScore = candidates[i].score; }
    report("sim", 100.0 * done / racks.size(), elapsed, eta, bestScore,
           "candidates=" + std::to_string(candidates.size()) + " samples=" +
               std::to_string(done) + "/" + std::to_string(racks.size()));
    if (elapsed > budgetMs && done >= 3) break;
  }

  // Every retained candidate saw the same `done` samples → means are directly
  // comparable.
  SimResult res;
  res.samplesUsed = done;
  for (size_t i = 0; i < candidates.size(); i++) {
    if (seen[i] == 0) continue;
    const float v = static_cast<float>(accum[i] / seen[i]);
    if (v > res.bestValue) {
      res.bestValue = v;
      res.bestIndex = static_cast<int>(i);
    }
  }
  return res;
}

// ── exact endgame solver ─────────────────────────────────────────────────────

struct Zobrist {
  uint64_t cell[BOARD_CELLS][KIND_COUNT][ASSIGNED_COUNT];
  uint64_t rack[2][KIND_COUNT][RACK_SIZE + 1];
  uint64_t side;
  uint64_t streak[NO_SCORE_STREAK_LENGTH + 1];

  Zobrist() {
    std::mt19937_64 rng(0xA3A7C0DEULL);
    for (auto& a : cell)
      for (auto& b : a)
        for (auto& v : b) v = rng();
    for (auto& a : rack)
      for (auto& b : a)
        for (auto& v : b) v = rng();
    side = rng();
    for (auto& v : streak) v = rng();
  }
};

struct TTEntry {
  int value;
  uint8_t flag;  // 0 exact, 1 lower, 2 upper
};

struct EndgameSolver {
  Board board;
  TileCounts racks[2];  // 0 = side to move at root
  long long nodeBudget;
  int beamWidth;  // INT32_MAX = exact
  bool aborted = false;
  long long nodes = 0;
  Clock::time_point start;
  double budgetMs;
  const Zobrist& zob;
  std::unordered_map<uint64_t, TTEntry> tt;
  uint64_t boardHash = 0;

  EndgameSolver(const Request& req, const TileCounts& oppRack, const Zobrist& z)
      : board(req.board), nodeBudget(0), beamWidth(0), zob(z) {
    racks[0] = req.rack;
    racks[1] = oppRack;
    for (int r = 0; r < BOARD_SIZE; r++) {
      for (int c = 0; c < BOARD_SIZE; c++) {
        const Cell& cell = board.at(r, c);
        if (cell.occupied()) boardHash ^= zob.cell[Board::idx(r, c)][cell.kind][cell.token];
      }
    }
  }

  uint64_t stateHash(int side, int streak) const {
    uint64_t h = boardHash ^ zob.streak[streak];
    if (side == 1) h ^= zob.side;
    for (int p = 0; p < 2; p++) {
      for (uint8_t k = 0; k < KIND_COUNT; k++) {
        h ^= zob.rack[p][k][racks[(p + side) % 2].n[k]];
      }
    }
    return h;
  }

  static constexpr int INF = 1 << 20;

  // Negamax over the exact remaining game; returns the optimal final score
  // margin (my total gain − opponent total gain from here on) for the side to
  // move (`side`: 0 root mover, 1 opponent).
  int solve(int side, int streak, int alpha, int beta) {
    if (aborted) return 0;
    if (++nodes > nodeBudget || (nodes % 4096 == 0 && msSince(start) > budgetMs)) {
      aborted = true;
      return 0;
    }

    const uint64_t h = stateHash(side, streak);
    const int alphaOrig = alpha;
    if (auto it = tt.find(h); it != tt.end()) {
      const TTEntry& e = it->second;
      if (e.flag == 0) return e.value;
      if (e.flag == 1 && e.value >= beta) return e.value;
      if (e.flag == 2 && e.value <= alpha) return e.value;
    }

    TileCounts& my = racks[side];
    TileCounts& opp = racks[1 - side];

    std::vector<Move> moves;
    GenStats gs;
    gs.nodeLimit = 2'000'000;  // a truncated enumeration would break exactness
    generatePlaceMoves(board, my, moves, &gs);
    if (gs.truncated) {
      aborted = true;
      return 0;
    }
    std::sort(moves.begin(), moves.end(),
              [](const Move& a, const Move& b) { return a.score > b.score; });
    if (static_cast<int>(moves.size()) > beamWidth) moves.resize(beamWidth);

    int best = -INF;
    for (const Move& m : moves) {
      // apply
      for (const Placement& p : m.placements) {
        board.place(p.row, p.col, p.kind, p.token);
        boardHash ^= zob.cell[Board::idx(p.row, p.col)][p.kind][p.token];
        my.sub(p.kind);
      }
      int v;
      if (my.total == 0) {
        v = m.score + 2 * opp.points();  // rack out: double opponent remainder
      } else {
        v = m.score - solve(1 - side, 0, -beta, -alpha);
      }
      // undo
      for (const Placement& p : m.placements) {
        board.remove(p.row, p.col);
        boardHash ^= zob.cell[Board::idx(p.row, p.col)][p.kind][p.token];
        my.add(p.kind);
      }
      if (aborted) return 0;
      best = std::max(best, v);
      alpha = std::max(alpha, v);
      if (alpha >= beta) break;
    }

    // Pass is always available.
    if (alpha < beta) {
      int v;
      if (streak + 1 >= NO_SCORE_STREAK_LENGTH) {
        v = opp.points() - my.points();  // lower rack total receives the difference
      } else {
        v = -solve(1 - side, streak + 1, -beta, -alpha);
      }
      if (!aborted) best = std::max(best, v);
    }

    TTEntry e;
    e.value = best;
    e.flag = best <= alphaOrig ? 2 : (best >= beta ? 1 : 0);
    if (tt.size() < 4'000'000) tt[h] = e;
    return best;
  }

  // Returns the best root move (or pass) and its proven value.
  struct RootResult {
    bool found = false;
    Move move;   // Pass move when passing is optimal
    int value = -INF;
    bool solved = false;
  };

  RootResult solveRoot(int rootStreak, long long budget, int beam, double timeMs) {
    nodeBudget = budget;
    beamWidth = beam;
    budgetMs = timeMs;
    start = Clock::now();
    aborted = false;
    nodes = 0;
    tt.clear();

    std::vector<Move> moves;
    GenStats gs;
    gs.nodeLimit = 4'000'000;
    generatePlaceMoves(board, racks[0], moves, &gs);
    if (gs.truncated) aborted = true;
    std::sort(moves.begin(), moves.end(),
              [](const Move& a, const Move& b) { return a.score > b.score; });

    RootResult res;
    int alpha = -INF, beta = INF;
    const size_t total = moves.size() + 1;
    size_t doneCount = 0;

    for (const Move& m : moves) {
      TileCounts& my = racks[0];
      for (const Placement& p : m.placements) {
        board.place(p.row, p.col, p.kind, p.token);
        boardHash ^= zob.cell[Board::idx(p.row, p.col)][p.kind][p.token];
        my.sub(p.kind);
      }
      int v;
      if (my.total == 0) {
        v = m.score + 2 * racks[1].points();
      } else {
        v = m.score - solve(1, 0, -beta, -alpha);
      }
      for (const Placement& p : m.placements) {
        board.remove(p.row, p.col);
        boardHash ^= zob.cell[Board::idx(p.row, p.col)][p.kind][p.token];
        my.add(p.kind);
      }
      if (aborted) break;
      doneCount++;
      if (!res.found || v > res.value) {
        res.found = true;
        res.value = v;
        res.move = m;
      }
      alpha = std::max(alpha, v);
      report("endgame", 100.0 * doneCount / total, msSince(start),
             msSince(start) / doneCount * (total - doneCount), m.score,
             "root " + std::to_string(doneCount) + "/" + std::to_string(total) +
                 " nodes=" + std::to_string(nodes));
    }

    if (!aborted) {
      int v;
      if (rootStreak + 1 >= NO_SCORE_STREAK_LENGTH) {
        v = racks[1].points() - racks[0].points();
      } else {
        v = -solve(1, rootStreak + 1, -beta, -alpha);
      }
      if (!aborted && (!res.found || v > res.value)) {
        res.found = true;
        res.value = v;
        res.move = Move{};  // pass
      }
    }

    res.solved = !aborted && beamWidth == INT32_MAX;
    return res;
  }
};

const Zobrist& zobrist() {
  static Zobrist z;
  return z;
}

// ── response serialization ───────────────────────────────────────────────────

std::string respond(const Move& move, float equity, const std::string& solver, bool endgameSolved,
                    int expectedFinalDiff, bool hasFinalDiff, const GenStats& stats,
                    double elapsedMs, int candidates, int samples, int rootMoves) {
  auto o = json::makeObject();
  const char* type = move.type == MoveType::Place ? "place"
                     : move.type == MoveType::Exchange ? "exchange"
                                                       : "pass";
  o->obj["type"] = json::makeString(type);

  auto arr = json::makeArray();
  for (const Placement& p : move.placements) {
    auto cell = json::makeObject();
    cell->obj["r"] = json::makeInt(p.row);
    cell->obj["c"] = json::makeInt(p.col);
    cell->obj["kind"] = json::makeString(tileKindToString(p.kind));
    cell->obj["token"] = json::makeString(assignedTokenToString(p.token));
    arr->arr.push_back(cell);
  }
  o->obj["placements"] = arr;

  auto ex = json::makeArray();
  for (uint8_t k : move.exchangeKinds) ex->arr.push_back(json::makeString(tileKindToString(k)));
  o->obj["exchange"] = ex;

  o->obj["score"] = json::makeInt(move.type == MoveType::Place ? move.score : 0);
  o->obj["equity"] = json::makeDouble(equity);
  o->obj["solver"] = json::makeString(solver);
  o->obj["endgameSolved"] = json::makeBool(endgameSolved);
  if (hasFinalDiff) o->obj["expectedFinalDiff"] = json::makeInt(expectedFinalDiff);

  auto st = json::makeObject();
  st->obj["moves"] = json::makeInt(rootMoves);
  st->obj["nodes"] = json::makeInt(stats.nodesVisited);
  st->obj["elapsedMs"] = json::makeDouble(elapsedMs);
  st->obj["candidates"] = json::makeInt(candidates);
  st->obj["samples"] = json::makeInt(samples);
  o->obj["stats"] = st;
  return json::stringify(o);
}

std::string respondError(const std::string& message) {
  auto o = json::makeObject();
  o->obj["error"] = json::makeString(message);
  return json::stringify(o);
}

}  // namespace

void setProgressCallback(ProgressFn fn) { g_progress = fn; }

std::string handleRequest(const std::string& requestJson) {
  const auto start = Clock::now();

  Request req;
  std::string error;
  if (!parseRequest(requestJson, req, error)) return respondError(error);

  const Config cfg = configFor(req.difficulty);
  const double budgetMs = req.budgetMs > 0 ? req.budgetMs : cfg.defaultBudgetMs;
  std::mt19937 rng(req.seed);

  // Judge tiles against the live board: openness, the real unseen pool, phase
  // and the score situation.
  const BoardContext ctx = makeContext(req.board, req.unseen, req.bagCount,
                                       static_cast<float>(req.myScore - req.oppScore));

  report("movegen", 0, 0, 0, 0, "");

  // Root generation: premium-ordered (so a spent budget never silently drops
  // the board's best plays), dedup'd (RAM bounded by geometry, not by blanks),
  // time-bounded. Endgame generation below stays complete for exactness.
  GenStats stats;
  std::vector<Move> moves;
  GenOptions genOpts;
  genOpts.budgetMs = cfg.genBudgetMs;
  genOpts.dedup = true;
  genOpts.premiumOrder = true;
  generatePlaceMoves(req.board, req.rack, moves, &stats, genOpts);
  const int rootMoves = static_cast<int>(moves.size());

  // ── endgame: bag empty means the opponent rack is fully known ──────────────
  if (cfg.endgameExact && req.bagCount == 0 && req.unseen.total == req.oppRackCount &&
      req.oppRackCount > 0 && !moves.empty()) {
    EndgameSolver solver(req, req.unseen, zobrist());
    auto res = solver.solveRoot(req.noScoreStreak, cfg.endgameNodeBudget, INT32_MAX,
                                budgetMs * 0.85);
    bool solved = res.solved && res.found;
    if (!solved && cfg.endgameBeamFallback > 0) {
      EndgameSolver retry(req, req.unseen, zobrist());
      auto res2 = retry.solveRoot(req.noScoreStreak, cfg.endgameNodeBudget,
                                  cfg.endgameBeamFallback, budgetMs * 0.6);
      if (res2.found) res = res2;
    }
    if (res.found) {
      return respond(res.move, static_cast<float>(res.value), "endgame", solved, res.value, true,
                     stats, msSince(start), 0, 0, rootMoves);
    }
    // fall through to the normal path when nothing was found at all
  }

  // ── no placement available: exchange or pass ───────────────────────────────
  if (moves.empty()) {
    if (req.exchangeAllowed && req.rack.total > 0) {
      Move ex = bestExchange(req, ctx);
      if (!ex.exchangeKinds.empty()) {
        return respond(ex, staticEquity(req.board, req.rack, ex, ctx), "greedy", false, 0, false,
                       stats, msSince(start), 0, 0, rootMoves);
      }
    }
    Move pass;
    return respond(pass, staticEquity(req.board, req.rack, pass, ctx), "greedy", false, 0, false,
                   stats, msSince(start), 0, 0, rootMoves);
  }

  // ── static ranking ─────────────────────────────────────────────────────────
  std::vector<std::pair<float, size_t>> ranked;
  ranked.reserve(moves.size());
  for (size_t i = 0; i < moves.size(); i++) {
    const float eq = cfg.useLeave ? staticEquity(req.board, req.rack, moves[i], ctx)
                                  : static_cast<float>(moves[i].score);
    ranked.push_back({eq, i});
  }
  std::sort(ranked.begin(), ranked.end(),
            [](const auto& a, const auto& b) { return a.first > b.first; });

  // easy: random pick among the top few
  if (cfg.pickFromTop > 1) {
    const int n = std::min<int>(cfg.pickFromTop, static_cast<int>(ranked.size()));
    const auto& pick = ranked[rng() % n];
    return respond(moves[pick.second], pick.first, "greedy", false, 0, false, stats,
                   msSince(start), 0, 0, rootMoves);
  }

  // ── simulation (hard / max) ────────────────────────────────────────────────
  if (cfg.simTopK > 0 && req.oppRackCount > 0) {
    const int k = std::min<int>(cfg.simTopK, static_cast<int>(ranked.size()));
    std::vector<Move> candidates;
    candidates.reserve(k + 1);
    bool topScoreIncluded = false;
    size_t topScoreIdx = 0;
    for (size_t i = 0; i < moves.size(); i++)
      if (moves[i].score > moves[topScoreIdx].score) topScoreIdx = i;
    for (int i = 0; i < k; i++) {
      candidates.push_back(moves[ranked[i].second]);
      if (ranked[i].second == topScoreIdx) topScoreIncluded = true;
    }
    // Guarantee the highest-scoring move is always simulated, even if its
    // static equity ranked it just outside the top-K.
    if (!topScoreIncluded) candidates.push_back(moves[topScoreIdx]);

    const SimResult sim =
        simulate(req, candidates, cfg.simSamples, budgetMs * 0.9, start, rng, stats, ctx);
    if (sim.bestIndex >= 0) {
      const Move& chosen = candidates[sim.bestIndex];
      // Consider exchanging instead only when everything on the board is weak.
      // Compare on the same STATIC baseline as the greedy path — the sim value
      // is a margin net of the opponent's reply and would make any exchange
      // look attractive on an open board.
      if (req.exchangeAllowed && chosen.score <= g_leave.exchangeConsiderBar) {
        Move ex = bestExchange(req, ctx);
        const float exEq = staticEquity(req.board, req.rack, ex, ctx);
        if (!ex.exchangeKinds.empty() &&
            exEq > staticEquity(req.board, req.rack, chosen, ctx)) {
          return respond(ex, exEq, "sim", false, 0, false, stats, msSince(start),
                         static_cast<int>(candidates.size()), sim.samplesUsed, rootMoves);
        }
      }
      return respond(chosen, sim.bestValue, "sim", false, 0, false, stats, msSince(start),
                     static_cast<int>(candidates.size()), sim.samplesUsed, rootMoves);
    }
  }

  // ── greedy (normal, or fallback) ───────────────────────────────────────────
  const auto& top = ranked.front();
  const Move& chosen = moves[top.second];
  if (req.exchangeAllowed && chosen.score <= g_leave.exchangeConsiderBar && cfg.useLeave) {
    Move ex = bestExchange(req, ctx);
    const float exEq = staticEquity(req.board, req.rack, ex, ctx);
    if (!ex.exchangeKinds.empty() && exEq > top.first) {
      return respond(ex, exEq, "greedy", false, 0, false, stats, msSince(start), 0, 0, rootMoves);
    }
  }
  return respond(chosen, top.first, "greedy", false, 0, false, stats, msSince(start), 0, 0,
                 rootMoves);
}

}  // namespace amath
