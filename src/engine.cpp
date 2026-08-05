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

// ── engine configuration (BIAS POINTS for M5 tuning) ─────────────────────────
//
// One model, one strength: the strongest the resources allow. Budgets are
// generous (RAM stays bounded by dedup + a capped TT, so only time grows). The
// `difficulty` field is ignored; a single configuration is always used.

struct Config {
  int simTopK = 60;                       // placement candidates carried into sim
  int simSamples = 160;                   // opponent-rack scenarios per candidate
  long long endgameNodeBudget = 80'000'000;
  int endgameBeamFallback = 32;           // beam width for the approximate retry
  double defaultBudgetMs = 100'000;       // overall think ceiling (RAM-safe)
  double genBudgetMs = 40'000;            // wall-clock ceiling for root generation
};

Config configFor(const std::string& /*difficulty*/) { return Config{}; }

// ── exchange candidates ──────────────────────────────────────────────────────

// Enumerate exchange candidates — one per swap size (1..maxDrawable). For each
// size we keep the tiles that make the strongest *kept* leave (greedy: drop the
// tile whose removal most improves the kept rack). The actual value of each
// candidate — including what the bag is likely to give back — is decided later
// by the simulation, which draws real replacement tiles from the unseen pool.
// Emitting every size lets "swap 5 to fish" compete fairly with "swap 2".
std::vector<Move> enumerateExchanges(const Request& req, const BoardContext& ctx) {
  std::vector<Move> out;
  const int drawable = std::min({req.rack.total, req.bagCount, 7});
  if (drawable <= 0) return out;

  TileCounts working = req.rack;
  std::vector<uint8_t> removed;
  for (int step = 1; step <= drawable; step++) {
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
    Move m;
    m.type = MoveType::Exchange;
    m.exchangeKinds = removed;
    out.push_back(m);
  }
  return out;
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
  std::vector<float> myLeaveAfter(candidates.size(), 0.0f);
  // For exchange candidates, the kept rack; its value is completed per sample by
  // drawing real replacement tiles from the unseen pool (bag fishing).
  std::vector<TileCounts> keptRack(candidates.size());
  Board board = req.board;

  // Per-candidate value base for the moves whose value does NOT depend on what
  // the bag gives back (placement, pass). Exchange is handled inside the sample
  // loop so it can draw actual tiles from the pool.
  for (size_t i = 0; i < candidates.size(); i++) {
    const Move& c = candidates[i];
    if (c.type == MoveType::Exchange) {
      keptRack[i] = req.rack;
      for (uint8_t k : c.exchangeKinds) keptRack[i].sub(k);
    } else if (c.type == MoveType::Pass) {
      myLeaveAfter[i] = leaveValue(req.rack, ctx) - 4.0f;  // BIAS: pass tempo cost
    } else {
      TileCounts after = req.rack;
      for (const Placement& p : c.placements) after.sub(p.kind);
      myLeaveAfter[i] = leaveValue(after, ctx);
    }
  }

  // Sample-major with common random numbers: every candidate is scored against
  // the SAME opponent racks (and, for exchanges, the SAME drawn replacements),
  // so the comparison stays fair even when the budget stops us early. A sample
  // is committed only when every candidate has finished it.
  int done = 0;
  std::vector<double> rowVal(candidates.size(), 0.0);
  std::vector<uint8_t> drawPool;  // shuffled per sample; exchanges draw its prefix
  for (int s = 0; s < static_cast<int>(racks.size()); s++) {
    // Tiles that could be drawn on an exchange this sample = unseen pool minus
    // the opponent's sampled rack (the same physical tiles can't be in both).
    drawPool.clear();
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      int avail = req.unseen.n[k] - racks[s].n[k];
      for (int j = 0; j < avail; j++) drawPool.push_back(k);
    }
    std::mt19937 drawRng(req.seed * 2654435761u + static_cast<uint32_t>(s) + 1u);
    std::shuffle(drawPool.begin(), drawPool.end(), drawRng);

    bool rowComplete = true;
    for (size_t i = 0; i < candidates.size(); i++) {
      if (msSince(start) > budgetMs && done >= 3) {
        rowComplete = false;
        break;
      }
      const Move& cand = candidates[i];
      applyPlacements(board, cand.placements);  // no-op for exchange / pass

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

      float myVal;
      if (cand.type == MoveType::Exchange) {
        // Draw real replacement tiles and value the resulting full rack — this
        // is what makes fishing (swapping several tiles for what the bag holds)
        // worthwhile when the kept tiles alone are weak.
        TileCounts newRack = keptRack[i];
        const int count = static_cast<int>(cand.exchangeKinds.size());
        for (int d = 0; d < count && d < static_cast<int>(drawPool.size()); d++)
          newRack.add(drawPool[d]);
        myVal = leaveValue(newRack, ctx) - g_leave.exchangeTempoCost;
        if (ctx.scoreDiff > 0) myVal -= g_leave.leadDumpPenalty;      // ahead: keep it tight
        else if (ctx.scoreDiff < 0) myVal += g_leave.trailFishBonus;  // behind: fish
      } else {
        myVal = cand.score + myLeaveAfter[i];
      }
      rowVal[i] = myVal - oppBest;

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
  if (req.bagCount == 0 && req.unseen.total == req.oppRackCount &&
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

  // ── build one candidate set: placements + exchange + pass ──────────────────
  // Exchange and pass compete on the SAME 2-ply footing as placements, so the
  // bot swaps tiles whenever keeping a playable rack (judged by leave value)
  // beats a weak placement — rather than "play whatever is legal". There is no
  // score gate; the simulation decides.
  std::vector<std::pair<float, size_t>> ranked;
  ranked.reserve(moves.size());
  for (size_t i = 0; i < moves.size(); i++)
    ranked.push_back({staticEquity(req.board, req.rack, moves[i], ctx), i});
  std::sort(ranked.begin(), ranked.end(),
            [](const auto& a, const auto& b) { return a.first > b.first; });

  std::vector<Move> candidates;
  if (req.oppRackCount > 0) {
    const int k = std::min<int>(cfg.simTopK, static_cast<int>(ranked.size()));
    candidates.reserve(k + 3);
    if (!moves.empty()) {
      size_t topScoreIdx = 0;
      for (size_t i = 0; i < moves.size(); i++)
        if (moves[i].score > moves[topScoreIdx].score) topScoreIdx = i;
      bool topIncluded = false;
      for (int i = 0; i < k; i++) {
        candidates.push_back(moves[ranked[i].second]);
        if (ranked[i].second == topScoreIdx) topIncluded = true;
      }
      if (!topIncluded) candidates.push_back(moves[topScoreIdx]);  // always simulate the top scorer
    }
    if (req.exchangeAllowed && req.rack.total > 0) {
      // One candidate per swap size, so the sim can pick how many to fish for.
      for (Move& ex : enumerateExchanges(req, ctx)) candidates.push_back(std::move(ex));
    }
    candidates.push_back(Move{});  // pass (MoveType::Pass by default)

    const SimResult sim =
        simulate(req, candidates, cfg.simSamples, budgetMs * 0.9, start, rng, stats, ctx);
    if (sim.bestIndex >= 0) {
      const Move& chosen = candidates[sim.bestIndex];
      return respond(chosen, sim.bestValue, "sim", false, 0, false, stats, msSince(start),
                     static_cast<int>(candidates.size()), sim.samplesUsed, rootMoves);
    }
  }

  // ── fallback (opponent rack unknown/empty): static equity, exchange included ─
  float bestEq = ranked.empty() ? -1e9f : ranked.front().first;
  Move chosen = ranked.empty() ? Move{} : moves[ranked.front().second];
  if (req.exchangeAllowed && req.rack.total > 0) {
    for (const Move& ex : enumerateExchanges(req, ctx)) {
      const float exEq = staticEquity(req.board, req.rack, ex, ctx);
      if (exEq > bestEq) {
        bestEq = exEq;
        chosen = ex;
      }
    }
  }
  return respond(chosen, bestEq, "greedy", false, 0, false, stats, msSince(start), 0, 0, rootMoves);
}

}  // namespace amath
