// Full-rules game simulator shared by the CLI (self-play, golden corpus)
// and the bot tests. Implements EQ-Lab turn mechanics: draw-to-8 racks,
// exchange with delayed tile return, rack-out and no-score-streak endings.
#pragma once

#include <random>
#include <string>
#include <vector>

#include "board.hpp"
#include "engine.hpp"
#include "json.hpp"
#include "movegen.hpp"
#include "rules.hpp"

namespace amath {

struct GameSim {
  Board board;
  std::vector<uint8_t> bag;
  TileCounts racks[2];
  std::vector<uint8_t> pendingReturn[2];
  int scores[2] = {0, 0};
  int noScoreStreak = 0;
  std::mt19937 rng;
  bool finished = false;
  std::string endReason;

  explicit GameSim(uint32_t seed) : rng(seed) {
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      for (int i = 0; i < TILE_COUNTS[k]; i++) bag.push_back(k);
    }
    std::shuffle(bag.begin(), bag.end(), rng);
    for (int side = 0; side < 2; side++) refill(side);
  }

  void refill(int side) {
    while (racks[side].total < RACK_SIZE && !bag.empty()) {
      racks[side].add(bag.back());
      bag.pop_back();
    }
    if (!pendingReturn[side].empty()) {
      for (uint8_t k : pendingReturn[side]) bag.push_back(k);
      pendingReturn[side].clear();
      std::shuffle(bag.begin(), bag.end(), rng);
    }
  }

  std::string requestJson(int side, const std::string& difficulty, uint32_t seed) const {
    auto o = json::makeObject();
    auto cells = json::makeArray();
    for (int r = 0; r < BOARD_SIZE; r++) {
      for (int c = 0; c < BOARD_SIZE; c++) {
        const Cell& cell = board.at(r, c);
        if (!cell.occupied()) continue;
        auto e = json::makeObject();
        e->obj["r"] = json::makeInt(r);
        e->obj["c"] = json::makeInt(c);
        e->obj["kind"] = json::makeString(tileKindToString(cell.kind));
        e->obj["token"] = json::makeString(assignedTokenToString(cell.token));
        cells->arr.push_back(e);
      }
    }
    o->obj["board"] = cells;
    auto rackArr = json::makeArray();
    for (uint8_t k = 0; k < KIND_COUNT; k++) {
      for (int i = 0; i < racks[side].n[k]; i++) {
        rackArr->arr.push_back(json::makeString(tileKindToString(k)));
      }
    }
    o->obj["rack"] = rackArr;
    // From this side's viewpoint the "bag" is the physical bag plus every
    // pending-return tile (they are unseen and will come back).
    const int bagCount = static_cast<int>(bag.size() + pendingReturn[0].size() +
                                          pendingReturn[1].size());
    o->obj["bagCount"] = json::makeInt(bagCount);
    o->obj["oppRackCount"] = json::makeInt(racks[1 - side].total);
    o->obj["myScore"] = json::makeInt(scores[side]);
    o->obj["oppScore"] = json::makeInt(scores[1 - side]);
    o->obj["noScoreStreak"] = json::makeInt(noScoreStreak);
    const int reserve = bagCount + racks[1 - side].total - RACK_SIZE;
    o->obj["exchangeAllowed"] = json::makeBool(reserve >= EXCHANGE_MIN_RESERVE);
    o->obj["difficulty"] = json::makeString(difficulty);
    o->obj["seed"] = json::makeInt(seed);
    return json::stringify(o);
  }

  // Applies an engine response; returns false on any rule violation.
  bool applyResponse(int side, const std::string& responseJson) {
    auto res = json::parse(responseJson);
    if (!res || res->get("error")) {
      endReason = "engine error: " + (res && res->get("error") ? res->get("error")->asString() : "?");
      return false;
    }
    const std::string type = res->get("type") ? res->get("type")->asString() : "";

    if (type == "place") {
      std::vector<Placement> ps;
      for (const auto& cell : res->get("placements")->arr) {
        const int kind = tileKindFromString(cell->get("kind")->asString());
        const int token = assignedTokenFromString(cell->get("token")->asString());
        if (kind < 0 || token < 0) return false;
        ps.push_back({static_cast<uint8_t>(cell->get("r")->asInt()),
                      static_cast<uint8_t>(cell->get("c")->asInt()), static_cast<uint8_t>(kind),
                      static_cast<uint8_t>(token)});
      }
      const MoveValidation v = validatePlaceMove(board, ps);
      const int claimed = static_cast<int>(res->get("score")->asInt());
      if (!v.valid || v.score != claimed) {
        endReason = "ILLEGAL/MISSCORED move from engine";
        return false;
      }
      for (const Placement& p : ps) {
        if (racks[side].n[p.kind] == 0) {
          endReason = "engine used a tile not in rack";
          return false;
        }
        racks[side].sub(p.kind);
        board.place(p.row, p.col, p.kind, p.token);
      }
      scores[side] += v.score;
      noScoreStreak = 0;

      if (racks[side].total == 0) {
        const int remaining = racks[1 - side].total + static_cast<int>(bag.size());
        if (remaining <= RACK_SIZE) {
          int bagPts = 0;
          for (uint8_t k : bag) bagPts += TILE_POINTS[k];
          scores[side] += 2 * (racks[1 - side].points() + bagPts);
          finished = true;
          endReason = "rack_out";
          return true;
        }
      }
      refill(side);
      return true;
    }

    if (type == "exchange") {
      for (const auto& t : res->get("exchange")->arr) {
        const int kind = tileKindFromString(t->asString());
        if (kind < 0 || racks[side].n[kind] == 0) {
          endReason = "bad exchange";
          return false;
        }
        racks[side].sub(kind);
        pendingReturn[side].push_back(static_cast<uint8_t>(kind));
      }
      noScoreStreak++;
    } else {  // pass
      noScoreStreak++;
    }

    if (noScoreStreak >= NO_SCORE_STREAK_LENGTH) {
      const int a = racks[0].points(), b = racks[1].points();
      if (a < b) scores[0] += b - a;
      else if (b < a) scores[1] += a - b;
      finished = true;
      endReason = "no_score_streak";
      return true;
    }
    refill(side);
    return true;
  }
};

}  // namespace amath
