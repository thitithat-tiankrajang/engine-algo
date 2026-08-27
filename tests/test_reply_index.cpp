#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <random>
#include <string>
#include <vector>

#include "../src/reply_index.hpp"
#include "../src/opponent_search.hpp"

using namespace amath;

static int failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static std::map<std::string, int> moveSet(const std::vector<Move>& moves) {
  std::map<std::string, int> set;
  for (const Move& move : moves) set[canonicalMoveKey(move)] = move.score;
  return set;
}

static void checkBestReplyAndEndpoint(const Board& board, const TileCounts& opponentRack,
                                      const std::vector<Move>& indexed,
                                      const std::vector<Move>& full) {
  SearchState indexedState;
  indexedState.board = board;
  indexedState.racks[1] = opponentRack;
  indexedState.racks[0].add(6, 2);
  indexedState.racks[0].add(K_ADD);
  indexedState.racks[0].add(K_EQUALS);
  indexedState.sideToMove = 1;
  indexedState.openingPlacementCompleted = !board.empty();
  SearchState fullState = indexedState;

  const OpponentSearchResult indexedReply =
      OpponentSearch::chooseFromPlacements(indexedState, indexed, true);
  const OpponentSearchResult fullReply =
      OpponentSearch::chooseFromPlacements(fullState, full, true);
  CHECK(indexedReply.ok && fullReply.ok);
  CHECK(indexedReply.complete && fullReply.complete);
  CHECK(indexedReply.canonicalKey == fullReply.canonicalKey);
  CHECK(indexedReply.policyValue == fullReply.policyValue);
  if (!indexedReply.ok || !fullReply.ok) return;

  const TransitionResult indexedTransition =
      StateTransition::apply(indexedState, indexedReply.move, 9173);
  const TransitionResult fullTransition = StateTransition::apply(fullState, fullReply.move, 9173);
  CHECK(indexedTransition.ok && fullTransition.ok);
  if (indexedTransition.ok && fullTransition.ok) {
    CHECK(EndpointEvaluator::evaluate(indexedState) == EndpointEvaluator::evaluate(fullState));
  }
}

static Move firstPlacement(const Board& board, const TileCounts& rack) {
  std::vector<Move> moves;
  generatePlaceMoves(board, rack, moves, nullptr);
  CHECK(!moves.empty());
  return moves.empty() ? Move{} : moves.front();
}

static void apply(Board& board, const Move& move) {
  for (const Placement& placement : move.placements) {
    board.place(placement.row, placement.col, placement.kind, placement.token);
  }
}

static void checkExact(const Board& base, const Move& candidate, const TileCounts& opponentRack) {
  WorkEnvelope limits;
  limits.maxFullGenCalls = 1;
  limits.maxDeltaGenCalls = 1;
  limits.maxMovegenNodes = 40'000'000;
  WorkLedger ledger(limits);

  const ReplyIndexResult index = ReplyIndex::build(base, opponentRack, ledger, 20'000'000);
  CHECK(index.complete);

  Board after = base;
  apply(after, candidate);
  const ReplySet recovered =
      ReplyIndex::recover(index, after, candidate.placements, opponentRack, ledger, 20'000'000);
  CHECK(recovered.complete);

  std::vector<Move> full;
  GenStats stats;
  stats.nodeLimit = 40'000'000;
  generatePlaceMoves(after, opponentRack, full, &stats);
  CHECK(!stats.truncated);
  CHECK(moveSet(recovered.placements) == moveSet(full));
  checkBestReplyAndEndpoint(after, opponentRack, recovered.placements, full);
  CHECK(ledger.report().fullGenCalls == 1);
  CHECK(ledger.report().deltaGenCalls == 1);
}

static void testOpeningCandidateExactness() {
  Board base;
  TileCounts myRack;
  myRack.add(1, 2);
  myRack.add(K_EQUALS);
  const Move candidate = firstPlacement(base, myRack);

  TileCounts opponentRack;
  opponentRack.add(2, 2);
  opponentRack.add(K_EQUALS);
  opponentRack.add(K_BLANK);
  checkExact(base, candidate, opponentRack);
}

static void testExtensionAndCrossDependencyExactness() {
  Board base;
  base.place(7, 6, 1, 1);
  base.place(7, 7, K_EQUALS, T_EQ);
  base.place(7, 8, 1, 1);

  TileCounts myRack;
  myRack.add(K_EQUALS);
  myRack.add(2, 2);
  const Move candidate = firstPlacement(base, myRack);

  TileCounts opponentRack;
  opponentRack.add(3, 2);
  opponentRack.add(K_EQUALS);
  opponentRack.add(K_PM);
  checkExact(base, candidate, opponentRack);
}

static void testRandomCandidateSetEquality() {
  Board base;
  base.place(7, 6, 1, 1);
  base.place(7, 7, K_EQUALS, T_EQ);
  base.place(7, 8, 1, 1);
  std::mt19937 rng(20260813);

  for (int fixture = 0; fixture < 12; fixture++) {
    TileCounts candidateRack;
    const uint8_t digit = static_cast<uint8_t>(2 + fixture % 5);
    candidateRack.add(digit, 2);
    candidateRack.add(K_EQUALS);
    candidateRack.add(fixture % 2 == 0 ? K_PM : K_MD);
    std::vector<Move> candidates;
    generatePlaceMoves(base, candidateRack, candidates, nullptr);
    CHECK(!candidates.empty());
    if (candidates.empty()) continue;
    const Move& candidate = candidates[rng() % candidates.size()];

    TileCounts opponentRack;
    const uint8_t replyDigit = static_cast<uint8_t>(1 + (fixture * 3) % 8);
    opponentRack.add(replyDigit, 2);
    opponentRack.add(K_EQUALS);
    opponentRack.add(fixture % 3 == 0 ? K_BLANK : K_ADD);
    checkExact(base, candidate, opponentRack);
  }
}

static TileCounts randomRack(std::mt19937& rng, int size, int flavor) {
  TileCounts rack;
  if (flavor % 11 == 0 && size > 0) rack.add(K_BLANK);
  if (flavor % 13 == 0 && rack.total < size) rack.add(K_PM);
  while (rack.total < size) {
    const uint8_t kind = static_cast<uint8_t>(rng() % KIND_COUNT);
    if (rack.n[kind] < TILE_COUNTS[kind]) rack.add(kind);
  }
  return rack;
}

static std::vector<Board> randomizedBoardCorpus(std::mt19937& rng) {
  std::vector<Board> boards;
  Board board;
  board.place(7, 6, 1, 1);
  board.place(7, 7, K_EQUALS, T_EQ);
  board.place(7, 8, 1, 1);
  boards.push_back(board);

  for (int fixture = 1; fixture < 32; fixture++) {
    if (fixture % 8 == 0 || board.tileCount > 36) board = boards.front();
    bool extended = false;
    for (int attempt = 0; attempt < 80 && !extended; attempt++) {
      const TileCounts rack = randomRack(rng, 5, fixture + attempt);
      std::vector<Move> moves;
      GenStats stats;
      stats.nodeLimit = 8'000'000;
      generatePlaceMoves(board, rack, moves, &stats);
      if (!stats.truncated && !moves.empty()) {
        const Move& move = moves[rng() % moves.size()];
        apply(board, move);
        extended = true;
      }
    }
    boards.push_back(board);
  }
  return boards;
}

static void testRandomizedTripleGate(int requestedTriples, uint32_t seed) {
  if (requestedTriples <= 0) return;
  std::mt19937 rng(seed);
  const std::vector<Board> boards = randomizedBoardCorpus(rng);
  int verified = 0;

  for (int group = 0; verified < requestedTriples && group < requestedTriples * 4; group++) {
    const Board& base = boards[rng() % boards.size()];
    const TileCounts opponentRack = randomRack(rng, 4, group * 3 + 1);
    const TileCounts candidateRack = randomRack(rng, 5, group * 5 + 2);

    std::vector<Move> candidates;
    GenStats candidateStats;
    candidateStats.nodeLimit = 12'000'000;
    generatePlaceMoves(base, candidateRack, candidates, &candidateStats);
    if (candidateStats.truncated || candidates.empty()) continue;
    std::shuffle(candidates.begin(), candidates.end(), rng);
    const int inGroup = std::min<int>(8, requestedTriples - verified);
    if (static_cast<int>(candidates.size()) > inGroup) candidates.resize(inGroup);

    WorkEnvelope limits;
    limits.maxFullGenCalls = 1;
    limits.maxDeltaGenCalls = static_cast<uint32_t>(candidates.size());
    limits.maxMovegenNodes = 300'000'000;
    WorkLedger ledger(limits);
    const ReplyIndexResult index = ReplyIndex::build(base, opponentRack, ledger, 24'000'000);
    if (!index.complete) continue;

    for (const Move& candidate : candidates) {
      Board after = base;
      apply(after, candidate);
      const ReplySet recovered = ReplyIndex::recover(
          index, after, candidate.placements, opponentRack, ledger, 24'000'000);
      if (!recovered.complete) break;

      std::vector<Move> full;
      GenStats fullStats;
      fullStats.nodeLimit = 24'000'000;
      generatePlaceMoves(after, opponentRack, full, &fullStats);
      if (fullStats.truncated) break;
      const std::map<std::string, int> indexedSet = moveSet(recovered.placements);
      const std::map<std::string, int> fullSet = moveSet(full);
      if (indexedSet != fullSet) {
        std::printf("randomized mismatch seed=%u group=%d triple=%d boardTiles=%d "
                    "indexed=%zu full=%zu\n",
                    seed, group, verified, base.tileCount, indexedSet.size(), fullSet.size());
        CHECK(false);
        return;
      }
      checkBestReplyAndEndpoint(after, opponentRack, recovered.placements, full);
      verified++;
    }
  }
  std::printf("reply-index randomized equality: %d/%d triples (seed=%u)\n",
              verified, requestedTriples, seed);
  CHECK(verified == requestedTriples);
}

int main(int argc, char** argv) {
  const int randomizedTriples = argc > 1 ? std::atoi(argv[1]) : 64;
  const uint32_t seed = argc > 2 ? static_cast<uint32_t>(std::strtoul(argv[2], nullptr, 10))
                                 : 20260813u;
  testOpeningCandidateExactness();
  testExtensionAndCrossDependencyExactness();
  testRandomCandidateSetEquality();
  testRandomizedTripleGate(randomizedTriples, seed);
  if (failures == 0) {
    std::printf("ALL REPLY-INDEX TESTS PASSED\n");
    return 0;
  }
  std::printf("%d FAILURES\n", failures);
  return 1;
}
