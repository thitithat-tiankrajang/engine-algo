// ── The boundary adapter: canonical game state → engine request ──────────────
//
// One direction, one place. For a GAME, everything the engine is told about a
// position is derived HERE from the stored canonical state, and nothing the
// caller sends is ever mixed in. That is the whole trust story of this service:
// a client names a game and a revision, and the server looks up what is
// actually true.
//
// `toStudyEngineRequest` at the bottom is the one deliberate exception, and it
// is an exception to the INPUT, not to the guarantee. A study position has no
// room to look up and no opponent to hide anything from — the caller invented
// every tile in it, including their own rack. `study.ts` validates it against
// the physical tile set before it reaches this file; what it must never be is
// a way to ask about a real game's position, which is why it takes a
// `StudyPosition` and not a game id.
//
// This is also the file that has to agree, field for field, with what the
// browser used to compute in `EQ-Lab/src/bot/botController.ts::buildBotRequest`.
// Where that function had a quirk, the quirk is reproduced deliberately and
// commented, because "equivalent gameplay" means the engine sees the same
// numbers it saw before, not the numbers we would pick today.

import {
  EXCHANGE_MIN_RESERVE,
  RACK_SIZE,
  type AmathToken,
  type CanonicalState,
  type Side,
  bagSize,
  boardCells,
  otherSide,
  pendingReturnSize,
  rackSize,
  rackTokens,
} from "./canonical.js";
import { studyExchangeAllowed, studyFingerprint, type StudyPosition } from "./study.js";

export type EngineRequest = {
  board: Array<{ r: number; c: number; kind: string; token: string }>;
  rack: string[];
  bagCount: number;
  oppRackCount: number;
  myScore: number;
  oppScore: number;
  noScoreStreak: number;
  exchangeAllowed: boolean;
  difficulty: string;
  /** Which decision procedure the engine runs after the exact end-game path
   *  declines the position. Omitted means the engine's default (`"sim"`), so
   *  every existing caller keeps its behaviour. */
  solver?: "static" | "sim";
  budgetMs?: number;
  /** Take every wall-clock ceiling off the search and let it run its schedule
   *  to completion. Omitted for every tier but `super`. */
  unlimited?: boolean;
  sampleCap?: number;
  topN?: number;
  seed: number;
};

/**
 * Whether the side on move may exchange.
 *
 * Mirrors `EQ-Lab/src/gameplay/tilebag.ts::getExchangeRule`, including the part
 * that looks inconsistent next to `bagCount` below: the reserve test counts the
 * BAG ONLY, while the engine's `bagCount` also folds in tiles waiting to be
 * returned. Both are intentional and they are answering different questions —
 * "can these tiles be swapped for others right now" versus "how many tiles are
 * still unseen". Collapsing them would change when the bot is allowed to
 * exchange near the end of a game.
 */
export function exchangeAllowed(state: CanonicalState): boolean {
  const bag = bagSize(state);
  if (state.gameMode === "solo") return bag >= EXCHANGE_MIN_RESERVE;
  const opponentRack = rackSize(state, otherSide(state.activeSide));
  return bag + opponentRack - RACK_SIZE >= EXCHANGE_MIN_RESERVE;
}

/** A committed command, as `live_game_events.command` stores it. */
export type CommittedCommand = { kind: string };

/**
 * Trailing run of scoreless turns.
 *
 * The browser read this off the rendered turn log; the server reads it off the
 * committed event log, which is the same sequence with the same ordering
 * guarantee. Draw/refill/returnDraw are bookkeeping within a turn and are
 * skipped, exactly as the old `trailingNoScoreStreak` skipped `end_game`.
 */
export function noScoreStreak(commands: readonly CommittedCommand[]): number {
  let streak = 0;
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const kind = commands[index]?.kind;
    if (kind === "draw" || kind === "refill" || kind === "returnDraw" || kind === "endGame") {
      continue;
    }
    if (kind === "pass" || kind === "exchange") {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

/**
 * Seed for the engine's RNG.
 *
 * The browser hashed `gameId:turnNumber`. The server hashes `gameId:revision`
 * instead: revision is the finer and strictly monotonic key, so two different
 * positions inside one turn (a refill and then the action) cannot collide, and
 * re-asking about the SAME position always reproduces the same search. That is
 * what makes a repeated analysis request answerable from cache without the
 * advice quietly changing under the player.
 */
export function seedFor(gameId: string, revision: number, salt = ""): number {
  const text = `${gameId}:${revision}${salt ? `:${salt}` : ""}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

export type AdapterOptions = {
  /** Which side the engine is playing as. The bot path passes the bot's side;
   *  analysis passes the human's own side. */
  side: Side;
  difficulty: string;
  solver?: "static" | "sim";
  budgetMs?: number;
  unlimited?: boolean;
  sampleCap?: number;
  topN?: number;
  events: readonly CommittedCommand[];
  seedSalt?: string;
};

export type StudyAdapterOptions = {
  difficulty: string;
  solver?: "static" | "sim";
  budgetMs?: number;
  unlimited?: boolean;
  topN?: number;
};

/**
 * Build the engine request for a STUDY position — one the caller invented
 * rather than one the server is holding.
 *
 * The hidden-information guarantee `toEngineRequest` provides structurally (the
 * opponent's tiles become a COUNT before they reach the engine) is not weakened
 * here: there is no opponent whose tiles could leak, and the only rack in the
 * request is the caller's own. What `study.ts` guarantees instead is that the
 * position is one the physical tile set can actually produce.
 */
export function toStudyEngineRequest(
  position: StudyPosition,
  options: StudyAdapterOptions,
): EngineRequest {
  return {
    board: position.board,
    rack: position.rack,
    bagCount: position.bagCount,
    oppRackCount: position.oppRackCount,
    myScore: position.scoreSelf,
    oppScore: position.scoreOpponent,
    // A study position has no history, so there is no scoreless run behind it.
    // Inventing one would change how the engine reasons about ending a game
    // that never happened.
    noScoreStreak: 0,
    exchangeAllowed: studyExchangeAllowed(position),
    difficulty: options.difficulty,
    ...(options.solver != null ? { solver: options.solver } : {}),
    ...(options.budgetMs != null ? { budgetMs: options.budgetMs } : {}),
    ...(options.unlimited ? { unlimited: true } : {}),
    ...(options.topN != null ? { topN: options.topN } : {}),
    // Keyed by the position itself: the same puzzle at the same strength is the
    // same search, and must not quietly rank differently on a second visit.
    seed: seedFor(studyFingerprint(position, options.difficulty), 0),
  };
}

/**
 * Build the engine request for one side of one position.
 *
 * The rack handed over is `options.side`'s rack and only that rack. The
 * opponent's tiles are reduced to a COUNT before they ever reach the engine
 * process, so no engine output — not a chosen move, not a candidate row, not a
 * progress line — can carry a tile the requester is not entitled to see. The
 * hidden-information guarantee is structural here, not a filter applied later.
 */
export function toEngineRequest(
  state: CanonicalState,
  options: AdapterOptions,
): EngineRequest {
  const side = options.side;
  const opponent = otherSide(side);
  const rack: AmathToken[] = rackTokens(state, side);

  return {
    board: boardCells(state),
    rack,
    // Tiles a player has swapped out are off-board and out of every rack, but
    // from the engine's accounting view they are still unseen — they rejoin the
    // bag at the end of that player's next draw. Counting them keeps
    // `unseen.total == oppRackCount + bagCount`, which is the exact predicate
    // the engine uses to decide a position is endgame-eligible.
    bagCount: bagSize(state) + pendingReturnSize(state),
    oppRackCount: rackSize(state, opponent),
    myScore: state.scores[side],
    oppScore: state.scores[opponent],
    noScoreStreak: noScoreStreak(options.events),
    exchangeAllowed: exchangeAllowed(state),
    difficulty: options.difficulty,
    ...(options.solver != null ? { solver: options.solver } : {}),
    ...(options.budgetMs != null ? { budgetMs: options.budgetMs } : {}),
    ...(options.unlimited ? { unlimited: true } : {}),
    ...(options.sampleCap != null ? { sampleCap: options.sampleCap } : {}),
    ...(options.topN != null ? { topN: options.topN } : {}),
    seed: seedFor(state.gameId, state.revision, options.seedSalt),
  };
}
