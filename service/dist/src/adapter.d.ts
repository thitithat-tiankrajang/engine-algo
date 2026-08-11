import { type CanonicalState, type Side } from "./canonical.js";
export type EngineRequest = {
    board: Array<{
        r: number;
        c: number;
        kind: string;
        token: string;
    }>;
    rack: string[];
    bagCount: number;
    oppRackCount: number;
    myScore: number;
    oppScore: number;
    noScoreStreak: number;
    exchangeAllowed: boolean;
    difficulty: string;
    budgetMs?: number;
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
export declare function exchangeAllowed(state: CanonicalState): boolean;
/** A committed command, as `live_game_events.command` stores it. */
export type CommittedCommand = {
    kind: string;
};
/**
 * Trailing run of scoreless turns.
 *
 * The browser read this off the rendered turn log; the server reads it off the
 * committed event log, which is the same sequence with the same ordering
 * guarantee. Draw/refill/returnDraw are bookkeeping within a turn and are
 * skipped, exactly as the old `trailingNoScoreStreak` skipped `end_game`.
 */
export declare function noScoreStreak(commands: readonly CommittedCommand[]): number;
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
export declare function seedFor(gameId: string, revision: number, salt?: string): number;
export type AdapterOptions = {
    /** Which side the engine is playing as. The bot path passes the bot's side;
     *  analysis passes the human's own side. */
    side: Side;
    difficulty: string;
    budgetMs?: number;
    sampleCap?: number;
    topN?: number;
    events: readonly CommittedCommand[];
    seedSalt?: string;
};
/**
 * Build the engine request for one side of one position.
 *
 * The rack handed over is `options.side`'s rack and only that rack. The
 * opponent's tiles are reduced to a COUNT before they ever reach the engine
 * process, so no engine output — not a chosen move, not a candidate row, not a
 * progress line — can carry a tile the requester is not entitled to see. The
 * hidden-information guarantee is structural here, not a filter applied later.
 */
export declare function toEngineRequest(state: CanonicalState, options: AdapterOptions): EngineRequest;
