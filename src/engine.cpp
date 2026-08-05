#include "engine.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
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
  bool forceHidden = false;  // test hook: route eligible endgames through the hidden solver
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
  req.forceHidden = root->get("forceHidden") ? root->get("forceHidden")->asBool() : false;
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
  long long endgameNodeBudget = 200'000'000;
  int endgameBeamFallback = 32;           // beam width for the approximate retry
  double defaultBudgetMs = 120'000;       // 2-min mid-game ceiling
  double endgameBudgetMs = 300'000;       // 5-min end-game ceiling (bag ≤ threshold)
  double genBudgetMs = 40'000;            // wall-clock ceiling for root generation
  int endgameBagThreshold = 5;            // eventual target for exact end-game reasoning
  // Largest bag for which we run the EXACT hidden-info proof. Kept at 1: bag 0
  // and 1 are validated bit-exact against a pure-minimax ground truth (bag 0:
  // 86/86, bag 1: 16/16). bag ≥ 2 still uses the sampling search — the 2-tile
  // draw handling has a known discrepancy (scratchpad bag2_fail.json) to fix
  // before raising this. Bumping past 1 without re-validating risks an unsound
  // "proven win".
  int endgameExactBagMax = 1;
  // Cap on how many distinct opponent-rack scenarios we enumerate before giving
  // up on an exact proof (RAM/time bound); over this we fall back to sampling.
  int endgameMaxAssignments = 4'000;
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

// Best immediate score a rack could make on a board — our next-turn scoring
// power, including the bingo bonus for an 8-tile play. Node-bounded so it stays
// cheap inside the sim.
int bestPlaceScore(const Board& board, const TileCounts& rack) {
  if (rack.total == 0) return 0;
  std::vector<Move> mv;
  GenStats gs;
  gs.nodeLimit = 150'000;
  GenOptions o;
  o.dedup = true;
  o.premiumOrder = true;
  generatePlaceMoves(board, rack, mv, &gs, o);
  int best = 0;
  for (const Move& m : mv) best = std::max(best, m.score);
  return best;
}

struct SimResult {
  int bestIndex = -1;
  float bestValue = -1e9f;
  int samplesUsed = 0;
};

// Per-candidate reasoning, surfaced to the UI so a human can see WHY one move
// beat another — every term the engine weighed, averaged over the samples.
struct CandidateDiag {
  int candIndex = 0;
  bool evaluated = false;  // false = never sampled (skip in the UI report)
  float scoreComp = 0;  // immediate move score
  float leave = 0;      // avg leave value of the resulting rack
  float potential = 0;  // avg β·(best score the resulting rack could make next turn)
  float oppReply = 0;   // avg opponent best-reply value subtracted
  float mean = 0;       // avg total value (score + leave + potential − oppReply)
  float stddev = 0;     // spread across samples (risk)
  float value = 0;      // risk-adjusted score used to rank: mean − λ·stddev
};

SimResult simulate(const Request& req, const std::vector<Move>& candidates, int samples,
                   double budgetMs, Clock::time_point start, std::mt19937& rng,
                   GenStats& stats, const BoardContext& ctx,
                   std::vector<CandidateDiag>* diag = nullptr) {
  const std::vector<TileCounts> racks = sampleOpponentRacks(req, samples, rng);
  std::vector<double> accum(candidates.size(), 0.0);
  std::vector<double> accumSq(candidates.size(), 0.0);
  std::vector<double> sumLeave(candidates.size(), 0.0);
  std::vector<double> sumPot(candidates.size(), 0.0);
  std::vector<double> sumOpp(candidates.size(), 0.0);
  std::vector<int> seen(candidates.size(), 0);
  std::vector<float> scoreComp(candidates.size(), 0.0f);
  std::vector<float> leaveStatic(candidates.size(), 0.0f);  // placement/pass: constant
  std::vector<float> potTerm(candidates.size(), 0.0f);
  // For exchange candidates, the kept rack; its value is completed per sample by
  // drawing real replacement tiles from the unseen pool (bag fishing).
  std::vector<TileCounts> keptRack(candidates.size());
  Board board = req.board;
  const float beta = g_leave.nextTurnPotentialWeight;

  // Per-candidate value base for the moves whose value does NOT depend on what
  // the bag gives back (placement, pass). Each includes a discounted look at how
  // much the resulting rack could score NEXT turn, so a placement that keeps
  // scoring power (or sets up a big follow-up) is preferred. Exchange is handled
  // inside the sample loop so it can draw actual tiles from the pool.
  for (size_t i = 0; i < candidates.size(); i++) {
    const Move& c = candidates[i];
    if (c.type == MoveType::Exchange) {
      keptRack[i] = req.rack;
      for (uint8_t k : c.exchangeKinds) keptRack[i].sub(k);
    } else if (c.type == MoveType::Pass) {
      leaveStatic[i] = leaveValue(req.rack, ctx) - 4.0f;
      potTerm[i] = beta * bestPlaceScore(req.board, req.rack);
    } else {
      TileCounts after = req.rack;
      for (const Placement& p : c.placements) after.sub(p.kind);
      applyPlacements(board, c.placements);
      const int potential = bestPlaceScore(board, after);
      undoPlacements(board, c.placements);
      scoreComp[i] = static_cast<float>(c.score);
      leaveStatic[i] = leaveValue(after, ctx);
      potTerm[i] = beta * potential;
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
      float sampLeave;  // this-sample leave component (for the diag breakdown)
      float sampPot;    // this-sample next-turn potential component
      if (cand.type == MoveType::Exchange) {
        // Draw real replacement tiles and value the resulting full rack — both
        // its leave and how much it could SCORE next turn (bingo potential).
        // This is what makes fishing worthwhile, e.g. swapping for a bingo.
        TileCounts newRack = keptRack[i];
        const int count = static_cast<int>(cand.exchangeKinds.size());
        for (int d = 0; d < count && d < static_cast<int>(drawPool.size()); d++)
          newRack.add(drawPool[d]);
        sampLeave = leaveValue(newRack, ctx);
        sampPot = beta * bestPlaceScore(board, newRack);
        myVal = sampLeave + sampPot - g_leave.exchangeTempoCost;
        if (ctx.scoreDiff > 0) myVal -= g_leave.leadDumpPenalty;      // ahead: keep it tight
        else if (ctx.scoreDiff < 0) myVal += g_leave.trailFishBonus;  // behind: fish
      } else {
        sampLeave = leaveStatic[i];
        sampPot = potTerm[i];
        myVal = scoreComp[i] + sampLeave + sampPot;
      }
      rowVal[i] = myVal - oppBest;
      if (diag) {
        sumLeave[i] += sampLeave;
        sumPot[i] += sampPot;
        sumOpp[i] += oppBest;
      }

      undoPlacements(board, cand.placements);
    }
    if (!rowComplete) break;
    for (size_t i = 0; i < candidates.size(); i++) {
      accum[i] += rowVal[i];
      accumSq[i] += rowVal[i] * rowVal[i];
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

  // Rank by mean − λ·stddev: a move that is usually good but occasionally lets
  // the opponent punish it hard (a high-variance downside, like opening a ×9) is
  // discounted for that risk. λ rises with our lead — protect a winning position,
  // gamble when behind. Every retained candidate saw the same `done` samples.
  const float lambda =
      std::max(0.0f, g_leave.riskAversionBase + g_leave.riskAversionLeadPer50 *
                                                    (ctx.scoreDiff / 50.0f));
  if (diag) diag->assign(candidates.size(), CandidateDiag{});
  SimResult res;
  res.samplesUsed = done;
  for (size_t i = 0; i < candidates.size(); i++) {
    if (seen[i] == 0) continue;
    const double mean = accum[i] / seen[i];
    const double var = std::max(0.0, accumSq[i] / seen[i] - mean * mean);
    const double sd = std::sqrt(var);
    const float v = static_cast<float>(mean - lambda * sd);
    if (diag) {
      CandidateDiag& d = (*diag)[i];
      d.candIndex = static_cast<int>(i);
      d.evaluated = true;
      d.scoreComp = scoreComp[i];
      d.leave = static_cast<float>(sumLeave[i] / seen[i]);
      d.potential = static_cast<float>(sumPot[i] / seen[i]);
      d.oppReply = static_cast<float>(sumOpp[i] / seen[i]);
      d.mean = static_cast<float>(mean);
      d.stddev = static_cast<float>(sd);
      d.value = v;
    }
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
  // Per-root-move proven margins, surfaced to the UI so the player can see the
  // exact final-score outcome of every end-game option (best move is exact; the
  // rest are lower bounds under alpha-beta, which is fine for display).
  std::vector<std::pair<Move, int>> rootMoveValues;

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
      rootMoveValues.push_back({m, v});
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
      if (!aborted) rootMoveValues.push_back({Move{}, v});
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

// ── hidden-information end-game for a nearly-empty bag (bag ≤ 2) ──────────────
//
// With only 1–2 tiles left in the bag the opponent's rack is almost pinned down:
// the bag is some size-`bagCount` submultiset of the unseen pool and the
// opponent holds the rest. For a PROVEN outcome we take the worst case over
// every such scenario AND over every possible draw. Inside one scenario the game
// is perfect-information apart from the draw of those ≤2 bag tiles, so we run an
// AI-perspective minimax: AI maximises; the opponent AND every random draw are
// minimised. The value is AI_total − Opp_total played out to the end, matching
// the exact bag==0 solver above (which this reduces to when the bag is empty).
struct HiddenBagSolver {
  Board board;
  long long nodeBudget = 0;
  double budgetMs = 0;
  Clock::time_point start;
  long long nodes = 0;
  bool aborted = false;
  static constexpr int INF = 1 << 20;

  // ── DP / transposition table for the bag-empty phase ────────────────────────
  // A fixed-size, direct-mapped table: RAM stays bounded no matter how many
  // positions the search visits (no multi-dimensional array, no unbounded map —
  // exactly the "node tree keyed by score" the design calls for). Keyed by a
  // Zobrist hash of (board, both racks, side to move, no-score streak). Enabled
  // only once the bag is empty, which is the whole deep sub-tree.
  struct TTSlot {
    uint64_t key = 0;
    int value = 0;
    uint8_t flag = 0;  // 0 exact, 1 lower bound, 2 upper bound
    bool used = false;
  };
  const Zobrist* zob = nullptr;
  std::vector<TTSlot> tt;
  uint64_t boardHash = 0;

  void initTT(int bits) { tt.assign(size_t(1) << bits, TTSlot{}); }
  void recomputeBoardHash() {
    boardHash = 0;
    for (int r = 0; r < BOARD_SIZE; r++)
      for (int c = 0; c < BOARD_SIZE; c++) {
        const Cell& cell = board.at(r, c);
        if (cell.occupied()) boardHash ^= zob->cell[Board::idx(r, c)][cell.kind][cell.token];
      }
  }
  uint64_t stateKey(int side, const TileCounts& ai, const TileCounts& opp, int streak) const {
    uint64_t h = boardHash ^ zob->streak[streak];
    if (side == 1) h ^= zob->side;
    for (uint8_t k = 0; k < KIND_COUNT; k++)
      h ^= zob->rack[0][k][ai.n[k]] ^ zob->rack[1][k][opp.n[k]];
    return h;
  }

  bool overBudget() {
    if (aborted) return true;
    if (++nodes > nodeBudget || (nodes % 8192 == 0 && msSince(start) > budgetMs)) aborted = true;
    return aborted;
  }

  // A refill draws `draw` tiles into the side that just moved. Draws are random,
  // so for a PROVEN result they are worst-case for AI → a MIN node over which
  // tiles come out, then play continues at `nextSide` with a reset streak.
  // alpha/beta prune this min node exactly (values are unaffected).
  int drawWorst(int draw, int moverSide, TileCounts& ai, TileCounts& opp, TileCounts& bag,
                int nextSide, int alpha, int beta) {
    if (aborted) return 0;
    if (draw == 0) return mm(nextSide, ai, opp, bag, 0, alpha, beta);
    TileCounts& mover = moverSide == 0 ? ai : opp;
    int best = INF;
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      if (bag.n[k] == 0) continue;
      bag.sub(k);
      mover.add(k);
      const int v = drawWorst(draw - 1, moverSide, ai, opp, bag, nextSide, alpha, beta);
      mover.sub(k);
      bag.add(k);
      if (aborted) return 0;
      best = std::min(best, v);
      beta = std::min(beta, best);
      if (alpha >= beta) break;
    }
    return best;
  }

  // Value from AI's perspective (AI_total − Opp_total to the end). side 0 = AI
  // (max), 1 = opponent (min). alpha/beta are AI-perspective bounds.
  int mm(int side, TileCounts& ai, TileCounts& opp, TileCounts& bag, int streak, int alpha,
         int beta) {
    if (overBudget()) return 0;

    // Memoise once the bag is empty (the deep sub-tree). Transpositions — the
    // same board+racks reached by different move orders — collapse to one entry.
    const bool useTT = bag.total == 0 && !tt.empty();
    const int alphaOrig = alpha, betaOrig = beta;
    uint64_t key = 0;
    size_t idx = 0;
    if (useTT) {
      key = stateKey(side, ai, opp, streak);
      idx = key & (tt.size() - 1);
      const TTSlot& e = tt[idx];
      if (e.used && e.key == key) {
        if (e.flag == 0) return e.value;                        // exact
        if (e.flag == 1 && e.value >= beta) return e.value;     // lower bound ≥ β
        if (e.flag == 2 && e.value <= alpha) return e.value;    // upper bound ≤ α
      }
    }

    TileCounts& mover = side == 0 ? ai : opp;

    std::vector<Move> moves;
    GenStats gs;
    gs.nodeLimit = 2'000'000;
    generatePlaceMoves(board, mover, moves, &gs);
    if (gs.truncated) {
      aborted = true;
      return 0;
    }

    int best = side == 0 ? -INF : INF;
    // Fold an option value into `best` with alpha-beta; returns true on cutoff.
    auto consider = [&](int v) -> bool {
      if (side == 0) {
        best = std::max(best, v);
        alpha = std::max(alpha, best);
      } else {
        best = std::min(best, v);
        beta = std::min(beta, best);
      }
      return alpha >= beta;
    };

    for (const Move& m : moves) {
      for (const Placement& p : m.placements) {
        board.place(p.row, p.col, p.kind, p.token);
        boardHash ^= zob->cell[Board::idx(p.row, p.col)][p.kind][p.token];
        mover.sub(p.kind);
      }
      const int sd = side == 0 ? m.score : -m.score;
      int v;
      if (mover.total == 0 && bag.total == 0) {
        const int oppRemain = side == 0 ? opp.points() : ai.points();
        v = sd + (side == 0 ? 2 * oppRemain : -2 * oppRemain);  // rack-out: double the remainder
      } else {
        const int draw = std::min(RACK_SIZE - mover.total, bag.total);
        // Child window is shifted by the immediate delta sd (v = sd + child).
        v = sd + drawWorst(draw, side, ai, opp, bag, 1 - side, alpha - sd, beta - sd);
      }
      for (const Placement& p : m.placements) {
        board.remove(p.row, p.col);
        boardHash ^= zob->cell[Board::idx(p.row, p.col)][p.kind][p.token];
        mover.add(p.kind);
      }
      if (aborted) return 0;
      if (consider(v)) {
        // Cutoff bound is side-dependent: side 0 maximises, so a cutoff is a
        // fail-HIGH → lower bound (flag 1); side 1 minimises, so a cutoff is a
        // fail-LOW → upper bound (flag 2). Storing flag 1 unconditionally (the
        // previous behaviour) mislabels every min-node cutoff and can hand back
        // a too-high value on a later probe. Matches the pass-branch store below.
        if (useTT) tt[idx] = TTSlot{key, best, static_cast<uint8_t>(side == 0 ? 1 : 2), true};
        return best;
      }
    }

    // Pass is always available (a no-score turn; sd = 0, window unchanged).
    int pv;
    if (streak + 1 >= NO_SCORE_STREAK_LENGTH) {
      pv = opp.points() - ai.points();  // game ends: each side loses its own remainder
    } else {
      pv = mm(1 - side, ai, opp, bag, streak + 1, alpha, beta);
    }
    if (aborted) return 0;
    if (consider(pv) && useTT) {
      tt[idx] = TTSlot{key, best, static_cast<uint8_t>(side == 0 ? 1 : 2), true};
      return best;
    }
    if (useTT) {
      const uint8_t flag = best <= alphaOrig ? 2 : (best >= betaOrig ? 1 : 0);
      tt[idx] = TTSlot{key, best, flag, true};
    }
    return best;
  }
};

// All distinct size-`count` submultisets of `pool` (count ≤ 2). Each is a
// possible bag composition; the opponent holds pool − bag.
std::vector<TileCounts> enumerateBags(const TileCounts& pool, int count) {
  std::vector<TileCounts> out;
  if (count <= 0) {
    out.push_back(TileCounts{});
    return out;
  }
  for (uint8_t a = 0; a < KIND_COUNT; a++) {
    if (pool.n[a] == 0) continue;
    if (count == 1) {
      TileCounts b;
      b.add(a);
      out.push_back(b);
    } else {  // count == 2
      for (uint8_t c = a; c < KIND_COUNT; c++) {
        if (pool.n[c] == 0) continue;
        if (c == a && pool.n[a] < 2) continue;
        TileCounts b;
        b.add(a);
        b.add(c);
        out.push_back(b);
      }
    }
  }
  return out;
}

struct HiddenResult {
  bool found = false;
  bool solved = false;  // every scenario proven within budget
  Move move;
  int value = -(1 << 20);
  std::vector<std::pair<Move, int>> rootVals;  // per-AI-root-move guaranteed margin
};

// Proven end-game under hidden information, for bag ∈ {0,1}. bag==0 is the exact
// perfect-information endgame (one scenario, no draws); bag==1 adds the handful
// of possible opponent racks. Returns found=false (caller falls back to
// sampling) when the position is too large to prove within budget. When solved,
// `value` is the worst-case (guaranteed) final margin.
HiddenResult solveHiddenEndgame(const Request& req, long long nodeBudget, double budgetMs,
                                int maxScenarios) {
  HiddenResult res;
  const std::vector<TileCounts> scenarios = enumerateBags(req.unseen, req.bagCount);
  if (scenarios.empty() || static_cast<int>(scenarios.size()) > maxScenarios) return res;

  std::vector<Move> aiMoves;
  GenStats gs;
  gs.nodeLimit = 4'000'000;
  generatePlaceMoves(req.board, req.rack, aiMoves, &gs);
  if (gs.truncated) return res;

  const int passIdx = static_cast<int>(aiMoves.size());  // pass is the last "move"
  std::vector<int> guaranteed(aiMoves.size() + 1, HiddenBagSolver::INF);

  HiddenBagSolver solver;
  solver.nodeBudget = nodeBudget;
  solver.budgetMs = budgetMs;
  solver.start = Clock::now();
  solver.zob = &zobrist();
  solver.initTT(22);  // 4M-slot direct-mapped DP table (~64 MB), RAM-bounded

  for (size_t s = 0; s < scenarios.size(); s++) {
    TileCounts oppRack = req.unseen;
    for (uint8_t k = 0; k < KIND_COUNT; k++) oppRack.sub(k, scenarios[s].n[k]);
    TileCounts bag = scenarios[s];
    solver.board = req.board;
    solver.recomputeBoardHash();

    // Each AI root move, evaluated against this fixed scenario.
    for (size_t i = 0; i < aiMoves.size(); i++) {
      const Move& m = aiMoves[i];
      TileCounts ai = req.rack;
      for (const Placement& p : m.placements) {
        solver.board.place(p.row, p.col, p.kind, p.token);
        solver.boardHash ^= solver.zob->cell[Board::idx(p.row, p.col)][p.kind][p.token];
        ai.sub(p.kind);
      }
      TileCounts scenarioBag = bag;
      int v;
      if (ai.total == 0 && scenarioBag.total == 0) {
        v = m.score + 2 * oppRack.points();
      } else {
        const int draw = std::min(RACK_SIZE - ai.total, scenarioBag.total);
        // Full window: each root move needs its exact value for the min-aggregation.
        v = m.score + solver.drawWorst(draw, 0, ai, oppRack, scenarioBag, 1,
                                       -HiddenBagSolver::INF, HiddenBagSolver::INF);
      }
      for (const Placement& p : m.placements) {
        solver.board.remove(p.row, p.col);
        solver.boardHash ^= solver.zob->cell[Board::idx(p.row, p.col)][p.kind][p.token];
      }
      if (solver.aborted) return res;  // could not prove — fall back
      guaranteed[i] = std::min(guaranteed[i], v);
    }

    // AI passes at the root.
    {
      TileCounts ai = req.rack;
      TileCounts scenarioBag = bag;
      int v;
      if (req.noScoreStreak + 1 >= NO_SCORE_STREAK_LENGTH) {
        v = oppRack.points() - ai.points();
      } else {
        v = solver.mm(1, ai, oppRack, scenarioBag, req.noScoreStreak + 1, -HiddenBagSolver::INF,
                      HiddenBagSolver::INF);
      }
      if (solver.aborted) return res;
      guaranteed[passIdx] = std::min(guaranteed[passIdx], v);
    }
  }

  // Aggregate: pick the AI option with the best guaranteed (worst-case) margin.
  for (size_t i = 0; i < aiMoves.size(); i++) {
    res.rootVals.push_back({aiMoves[i], guaranteed[i]});
    if (!res.found || guaranteed[i] > res.value) {
      res.found = true;
      res.value = guaranteed[i];
      res.move = aiMoves[i];
    }
  }
  res.rootVals.push_back({Move{}, guaranteed[passIdx]});  // pass
  if (!res.found || guaranteed[passIdx] > res.value) {
    res.found = true;
    res.value = guaranteed[passIdx];
    res.move = Move{};
  }
  res.solved = res.found;
  return res;
}

// ── response serialization ───────────────────────────────────────────────────

// One serialized alternative for the UI's "why this move" table. Every solver
// path (sim / greedy / endgame) fills these, so the panel shows a ranked
// breakdown no matter how the move was chosen.
struct ReportRow {
  const Move* move = nullptr;
  float scoreComp = 0;  // immediate move score
  float leave = 0;      // value of the rack left behind
  float potential = 0;  // discounted next-turn scoring power (sim only)
  float oppReply = 0;   // value handed to the opponent (subtracted)
  float mean = 0;       // net value before risk adjustment
  float stddev = 0;     // spread across samples (sim only; 0 = deterministic)
  float value = 0;      // ranking key
  bool chosen = false;
  bool proven = false;  // endgame: value is an exact proven final-score margin
};

bool movesEqual(const Move& a, const Move& b) {
  if (a.type != b.type) return false;
  if (a.type == MoveType::Place) {
    if (a.placements.size() != b.placements.size()) return false;
    for (size_t i = 0; i < a.placements.size(); i++) {
      const Placement& x = a.placements[i];
      const Placement& y = b.placements[i];
      if (x.row != y.row || x.col != y.col || x.kind != y.kind || x.token != y.token) return false;
    }
    return true;
  }
  if (a.type == MoveType::Exchange) return a.exchangeKinds == b.exchangeKinds;
  return true;  // both pass
}

void writeMoveCells(const json::ValuePtr& o, const Move& m) {
  const char* type = m.type == MoveType::Place ? "place"
                     : m.type == MoveType::Exchange ? "exchange"
                                                    : "pass";
  o->obj["type"] = json::makeString(type);
  auto cells = json::makeArray();
  for (const Placement& p : m.placements) {
    auto cell = json::makeObject();
    cell->obj["r"] = json::makeInt(p.row);
    cell->obj["c"] = json::makeInt(p.col);
    cell->obj["kind"] = json::makeString(tileKindToString(p.kind));
    cell->obj["token"] = json::makeString(assignedTokenToString(p.token));
    cells->arr.push_back(cell);
  }
  o->obj["placements"] = cells;
  auto ex = json::makeArray();
  for (uint8_t k : m.exchangeKinds) ex->arr.push_back(json::makeString(tileKindToString(k)));
  o->obj["exchange"] = ex;
  o->obj["score"] = json::makeInt(m.type == MoveType::Place ? m.score : 0);
}

// Rank rows by value (desc), keep the top N, serialize with the full breakdown.
json::ValuePtr serializeRows(std::vector<ReportRow> rows, int topN = 16) {
  std::sort(rows.begin(), rows.end(),
            [](const ReportRow& a, const ReportRow& b) { return a.value > b.value; });
  if (static_cast<int>(rows.size()) > topN) rows.resize(topN);
  auto arr = json::makeArray();
  for (const ReportRow& row : rows) {
    if (!row.move) continue;
    auto o = json::makeObject();
    writeMoveCells(o, *row.move);
    o->obj["scoreComp"] = json::makeDouble(row.scoreComp);
    o->obj["leave"] = json::makeDouble(row.leave);
    o->obj["potential"] = json::makeDouble(row.potential);
    o->obj["oppReply"] = json::makeDouble(row.oppReply);
    o->obj["mean"] = json::makeDouble(row.mean);
    o->obj["stddev"] = json::makeDouble(row.stddev);
    o->obj["value"] = json::makeDouble(row.value);
    o->obj["chosen"] = json::makeBool(row.chosen);
    o->obj["proven"] = json::makeBool(row.proven);
    arr->arr.push_back(o);
  }
  return arr;
}

// Sim path: turn the per-candidate diagnostics into report rows.
json::ValuePtr buildCandidateReport(const std::vector<Move>& moves,
                                    const std::vector<CandidateDiag>& diag, int chosenIdx) {
  std::vector<ReportRow> rows;
  for (size_t i = 0; i < diag.size(); i++) {
    if (!diag[i].evaluated) continue;
    const CandidateDiag& d = diag[i];
    rows.push_back(ReportRow{&moves[i], d.scoreComp, d.leave, d.potential, d.oppReply, d.mean,
                             d.stddev, d.value, static_cast<int>(i) == chosenIdx, false});
  }
  return serializeRows(std::move(rows));
}

// Greedy path (opponent rack unknown/empty): rows are the static-equity
// decomposition — score + leave − defense — so the player can see the ranking.
json::ValuePtr buildGreedyReport(const Board& board, const TileCounts& rack,
                                 const BoardContext& ctx, const std::vector<Move>& moves,
                                 const std::vector<std::pair<float, size_t>>& ranked,
                                 const std::vector<Move>& exchanges, const Move& chosen) {
  std::vector<ReportRow> rows;
  const int k = std::min<int>(16, static_cast<int>(ranked.size()));
  for (int i = 0; i < k; i++) {
    const Move& m = moves[ranked[i].second];
    TileCounts after = rack;
    for (const Placement& p : m.placements) after.sub(p.kind);
    const float leave = leaveValue(after, ctx);
    const float eq = ranked[i].first;
    // eq = score + leave − defense  ⇒  defense = score + leave − eq (shown as oppReply).
    const float defense = static_cast<float>(m.score) + leave - eq;
    rows.push_back(ReportRow{&m, static_cast<float>(m.score), leave, 0.0f, defense, eq, 0.0f, eq,
                             movesEqual(m, chosen), false});
  }
  for (const Move& ex : exchanges) {
    TileCounts after = rack;
    for (uint8_t t : ex.exchangeKinds) after.sub(t);
    const float leave = leaveValue(after, ctx);
    const float eq = staticEquity(board, rack, ex, ctx);
    rows.push_back(ReportRow{&ex, 0.0f, leave, 0.0f, 0.0f, eq, 0.0f, eq, movesEqual(ex, chosen), false});
  }
  return serializeRows(std::move(rows));
}

// End-game path: every root option with its proven final-score margin (my total
// − opponent total). Positive = a proven win by that margin.
json::ValuePtr buildEndgameReport(const std::vector<std::pair<Move, int>>& rootVals,
                                  const Move& chosen) {
  std::vector<ReportRow> rows;
  for (const auto& rv : rootVals) {
    const float v = static_cast<float>(rv.second);
    const float sc = rv.first.type == MoveType::Place ? static_cast<float>(rv.first.score) : 0.0f;
    rows.push_back(
        ReportRow{&rv.first, sc, 0, 0, 0, v, 0, v, movesEqual(rv.first, chosen), true});
  }
  return serializeRows(std::move(rows));
}

std::string respond(const Move& move, float equity, const std::string& solver, bool endgameSolved,
                    int expectedFinalDiff, bool hasFinalDiff, const GenStats& stats,
                    double elapsedMs, int candidates, int samples, int rootMoves,
                    json::ValuePtr candidateReport = nullptr) {
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
  if (candidateReport) o->obj["candidates"] = candidateReport;
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

  // Test hook: force even a bag==0 position through the hidden-info solver so it
  // can be cross-checked against the trusted negamax on the same board.
  if (req.forceHidden && req.oppRackCount > 0 &&
      req.unseen.total == req.oppRackCount + req.bagCount &&
      req.bagCount <= cfg.endgameExactBagMax) {
    const double egBudget = req.budgetMs > 0 ? req.budgetMs : cfg.endgameBudgetMs;
    const HiddenResult hr = solveHiddenEndgame(req, cfg.endgameNodeBudget, egBudget * 0.9,
                                               cfg.endgameMaxAssignments);
    if (!hr.found) return respondError("hidden_no_result");
    json::ValuePtr report = buildEndgameReport(hr.rootVals, hr.move);
    return respond(hr.move, static_cast<float>(hr.value), "endgame", hr.solved, hr.value, true,
                   stats, msSince(start), 0, 0, rootMoves, report);
  }

  const bool endgameEligible =
      req.oppRackCount > 0 && req.unseen.total == req.oppRackCount + req.bagCount;
  const double egBudget = req.budgetMs > 0 ? req.budgetMs : cfg.endgameBudgetMs;  // 5-min ceiling

  // ── nearly-empty bag (bag ≤ endgameExactBagMax): exact endgame proof ───────
  // Once the bag is (nearly) empty the game is a finite tree; we solve it EXACTLY
  // — every legal first move + pass, then the whole sub-tree — with an
  // AI-perspective minimax + a fixed-size DP/transposition table (RAM bounded).
  // bag==0 is perfect information (opponent rack fully known); bag==1 also takes
  // the worst case over the few possible opponent racks + draws. Exact and never
  // over-optimistic, so a reported win is a real 100% win. Rack-out scoring
  // (going out doubles the opponent's remainder and ends the game) is handled.
  // Validated bit-exact vs a pure-minimax ground truth (bag 0: 86/86, bag 1:
  // 16/16). It gets almost the whole endgame budget; if it can't finish it aborts
  // and we fall back below.
  if (endgameEligible && req.bagCount <= cfg.endgameExactBagMax) {
    const HiddenResult hr = solveHiddenEndgame(req, cfg.endgameNodeBudget, egBudget * 0.92,
                                               cfg.endgameMaxAssignments);
    // PROVEN: the exact solver finished. This is the only path that returns a
    // move through the "endgame" channel, and it is always endgameSolved=true.
    if (hr.found && hr.solved) {
      json::ValuePtr report = buildEndgameReport(hr.rootVals, hr.move);
      return respond(hr.move, static_cast<float>(hr.value), "endgame", true, hr.value, true, stats,
                     msSince(start), 0, 0, rootMoves, report);
    }

    // INCOMPLETE: the exact proof did not finish within budget. We do NOT fall
    // back to an approximate endgame move (the old beam-limited EndgameSolver is
    // removed): a beam result is not a proof, and returning it through the
    // "endgame" channel would mislabel an approximation as exact. Instead the
    // request falls through to the sampling search below, whose move is labelled
    // solver="sim" (never "endgame"), so a non-proven move is never presented as
    // exact. The endgame solver's contract is therefore PROVEN or INCOMPLETE only.
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

    std::vector<CandidateDiag> diag;
    const SimResult sim =
        simulate(req, candidates, cfg.simSamples, budgetMs * 0.9, start, rng, stats, ctx, &diag);
    if (sim.bestIndex >= 0) {
      const Move& chosen = candidates[sim.bestIndex];
      json::ValuePtr report = buildCandidateReport(candidates, diag, sim.bestIndex);
      return respond(chosen, sim.bestValue, "sim", false, 0, false, stats, msSince(start),
                     static_cast<int>(candidates.size()), sim.samplesUsed, rootMoves, report);
    }
  }

  // ── fallback (opponent rack unknown/empty): static equity, exchange included ─
  float bestEq = ranked.empty() ? -1e9f : ranked.front().first;
  Move chosen = ranked.empty() ? Move{} : moves[ranked.front().second];
  std::vector<Move> exchanges;
  if (req.exchangeAllowed && req.rack.total > 0) {
    exchanges = enumerateExchanges(req, ctx);
    for (const Move& ex : exchanges) {
      const float exEq = staticEquity(req.board, req.rack, ex, ctx);
      if (exEq > bestEq) {
        bestEq = exEq;
        chosen = ex;
      }
    }
  }
  json::ValuePtr greedyReport =
      buildGreedyReport(req.board, req.rack, ctx, moves, ranked, exchanges, chosen);
  return respond(chosen, bestEq, "greedy", false, 0, false, stats, msSince(start), 0, 0, rootMoves,
                 greedyReport);
}

}  // namespace amath
