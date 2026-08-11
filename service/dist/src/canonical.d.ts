/** Tokens exactly as EQ-Lab's `AmathToken` spells them. */
export declare const TOKEN_ORDER: readonly ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "+", "-", "x", "/", "+/-", "x//", "=", "?"];
export type AmathToken = (typeof TOKEN_ORDER)[number];
export declare const TILE_COUNT = 100;
export declare const RACK_SIZE = 8;
/** Exchange needs this many tiles left in reserve. Mirrors EQ-Lab's
 *  `EXCHANGE_MIN_RESERVE`. */
export declare const EXCHANGE_MIN_RESERVE = 5;
/** Ordinal → intrinsic token, built in the same declaration order EQ-Lab uses,
 *  so ordinal N means the same physical tile on both sides of the wire. */
export declare const TILE_TOKENS: readonly AmathToken[];
export type Side = "A" | "B";
export type TilePlacement = {
    at: "bag";
    seq: number;
} | {
    at: "rack";
    side: Side;
    seq: number;
} | {
    at: "pendingReturn";
    side: Side;
    seq: number;
} | {
    at: "board";
    row: number;
    col: number;
    placedTurn: number;
    by: Side;
    assigned?: string;
};
export type CanonicalState = {
    gameId: string;
    revision: number;
    inventory: readonly TilePlacement[];
    gameMode: "versus" | "solo";
    drawMode: "manual" | "play";
    startingSide: Side;
    turnNumber: number;
    activeSide: Side;
    phase: "refill" | "choose_action" | "perform_action";
    status: "playing" | "draft" | "finished";
    scores: Record<Side, number>;
};
export declare class CanonicalStateError extends Error {
    readonly name = "CanonicalStateError";
}
/**
 * Parse the stored canonical payload and prove it is the physical set.
 *
 * Every failure is a refusal, never a repair. A position missing a tile is not
 * recoverable by guessing which one, and a bot move computed on a board that is
 * not the real board is worse than no move at all.
 */
export declare function parseCanonical(payload: unknown): CanonicalState;
export declare function tokenOfOrdinal(ordinal: number): AmathToken;
/** Rack tokens for a side, in rack order. */
export declare function rackTokens(state: CanonicalState, side: Side): AmathToken[];
export declare function rackSize(state: CanonicalState, side: Side): number;
export declare function bagSize(state: CanonicalState): number;
export declare function pendingReturnSize(state: CanonicalState): number;
export type BoardCell = {
    r: number;
    c: number;
    kind: AmathToken;
    token: string;
};
/** Board tiles in the engine's wire shape: `kind` is the physical tile, `token`
 *  is the face it is being played as (they differ only for ? +/- x//). */
export declare function boardCells(state: CanonicalState): BoardCell[];
export declare function otherSide(side: Side): Side;
