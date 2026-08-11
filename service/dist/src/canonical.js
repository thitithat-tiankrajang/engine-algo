// ── Canonical state, as the engine service reads it ──────────────────────────
//
// EQ-Lab owns this shape (`src/domain/canonical.ts` + `src/domain/inventory.ts`).
// This module is a READER, not a second definition: it parses the stored
// canonical payload, re-proves that it describes the closed 100-tile set, and
// exposes the few projections the engine adapter needs.
//
// It deliberately re-proves the invariant instead of assuming it. The payload
// arrives from the database, but the database stores what a client computed —
// `commit_live_game_command` does compare-and-set and appends the log; it does
// not re-run the reducer. So "the server has it" is not the same as "the server
// derived it", and a position the engine is about to spend a CPU-minute on is
// worth one linear pass to check.
/** Tokens exactly as EQ-Lab's `AmathToken` spells them. */
export const TOKEN_ORDER = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
    "+", "-", "x", "/", "+/-", "x//", "=", "?",
];
/** Copies of each token in the physical set. Mirrors EQ-Lab's
 *  `constants/tileDefinitions.ts` and the engine's `TILE_COUNTS`. */
const TOKEN_COUNTS = {
    "0": 5, "1": 6, "2": 6, "3": 5, "4": 5, "5": 4, "6": 4, "7": 4, "8": 4, "9": 4,
    "10": 2, "11": 1, "12": 2, "13": 1, "14": 1, "15": 1, "16": 1, "17": 1,
    "18": 1, "19": 1, "20": 1,
    "+": 4, "-": 4, x: 4, "/": 4, "+/-": 5, "x//": 4, "=": 11, "?": 4,
};
export const TILE_COUNT = 100;
export const RACK_SIZE = 8;
/** Exchange needs this many tiles left in reserve. Mirrors EQ-Lab's
 *  `EXCHANGE_MIN_RESERVE`. */
export const EXCHANGE_MIN_RESERVE = 5;
/** Ordinal → intrinsic token, built in the same declaration order EQ-Lab uses,
 *  so ordinal N means the same physical tile on both sides of the wire. */
export const TILE_TOKENS = (() => {
    const tokens = [];
    for (const token of TOKEN_ORDER) {
        for (let copy = 0; copy < TOKEN_COUNTS[token]; copy += 1)
            tokens.push(token);
    }
    return Object.freeze(tokens);
})();
if (TILE_TOKENS.length !== TILE_COUNT) {
    throw new Error(`The tile manifest describes ${TILE_TOKENS.length} tiles but the physical set has ${TILE_COUNT}.`);
}
export class CanonicalStateError extends Error {
    name = "CanonicalStateError";
}
const BOARD_SIZE = 15;
function isSide(value) {
    return value === "A" || value === "B";
}
/**
 * Parse the stored canonical payload and prove it is the physical set.
 *
 * Every failure is a refusal, never a repair. A position missing a tile is not
 * recoverable by guessing which one, and a bot move computed on a board that is
 * not the real board is worse than no move at all.
 */
export function parseCanonical(payload) {
    if (!payload || typeof payload !== "object") {
        throw new CanonicalStateError("Canonical state is missing.");
    }
    const raw = payload;
    const inventory = raw.inventory;
    if (!Array.isArray(inventory)) {
        throw new CanonicalStateError("Canonical state carries no tile placements.");
    }
    if (inventory.length !== TILE_COUNT) {
        throw new CanonicalStateError(`Canonical state describes ${inventory.length} tiles, not the ${TILE_COUNT}-tile set.`);
    }
    const squares = new Set();
    const placements = [];
    for (let ordinal = 0; ordinal < TILE_COUNT; ordinal += 1) {
        const entry = inventory[ordinal];
        if (!entry || typeof entry !== "object") {
            throw new CanonicalStateError(`Tile ${ordinal} has no location.`);
        }
        switch (entry.at) {
            case "bag":
                placements.push({ at: "bag", seq: Number(entry.seq ?? 0) });
                break;
            case "rack":
            case "pendingReturn": {
                if (!isSide(entry.side)) {
                    throw new CanonicalStateError(`Tile ${ordinal} claims an unknown side.`);
                }
                placements.push({
                    at: entry.at,
                    side: entry.side,
                    seq: Number(entry.seq ?? 0),
                });
                break;
            }
            case "board": {
                const row = Number(entry.row);
                const col = Number(entry.col);
                if (!Number.isInteger(row) || !Number.isInteger(col) ||
                    row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
                    throw new CanonicalStateError(`Tile ${ordinal} is on a square outside the board.`);
                }
                const square = row * BOARD_SIZE + col;
                if (squares.has(square)) {
                    throw new CanonicalStateError(`Two tiles occupy square (${row}, ${col}).`);
                }
                squares.add(square);
                if (!isSide(entry.by)) {
                    throw new CanonicalStateError(`Tile ${ordinal} on the board has no owner.`);
                }
                placements.push({
                    at: "board",
                    row,
                    col,
                    placedTurn: Number(entry.placedTurn ?? 0),
                    by: entry.by,
                    ...(typeof entry.assigned === "string" ? { assigned: entry.assigned } : {}),
                });
                break;
            }
            default:
                throw new CanonicalStateError(`Tile ${ordinal} is in an unknown location.`);
        }
    }
    const scores = (raw.scores ?? {});
    const activeSide = raw.activeSide;
    if (!isSide(activeSide)) {
        throw new CanonicalStateError("Canonical state has no active side.");
    }
    return {
        gameId: String(raw.gameId ?? ""),
        revision: Number(raw.revision ?? 0),
        inventory: placements,
        gameMode: raw.gameMode === "solo" ? "solo" : "versus",
        drawMode: raw.drawMode === "play" ? "play" : "manual",
        startingSide: isSide(raw.startingSide) ? raw.startingSide : "A",
        turnNumber: Number(raw.turnNumber ?? 1),
        activeSide,
        phase: (raw.phase ?? "choose_action"),
        status: (raw.status ?? "playing"),
        scores: { A: Number(scores.A ?? 0), B: Number(scores.B ?? 0) },
    };
}
// ── Projections ──────────────────────────────────────────────────────────────
export function tokenOfOrdinal(ordinal) {
    const token = TILE_TOKENS[ordinal];
    if (token === undefined) {
        throw new CanonicalStateError(`Tile ordinal ${ordinal} is outside the set.`);
    }
    return token;
}
/** Rack tokens for a side, in rack order. */
export function rackTokens(state, side) {
    const held = [];
    state.inventory.forEach((placement, ordinal) => {
        if (placement.at === "rack" && placement.side === side) {
            held.push({ seq: placement.seq, token: tokenOfOrdinal(ordinal) });
        }
    });
    held.sort((first, second) => first.seq - second.seq);
    return held.map((entry) => entry.token);
}
export function rackSize(state, side) {
    let total = 0;
    for (const placement of state.inventory) {
        if (placement.at === "rack" && placement.side === side)
            total += 1;
    }
    return total;
}
export function bagSize(state) {
    let total = 0;
    for (const placement of state.inventory) {
        if (placement.at === "bag")
            total += 1;
    }
    return total;
}
export function pendingReturnSize(state) {
    let total = 0;
    for (const placement of state.inventory) {
        if (placement.at === "pendingReturn")
            total += 1;
    }
    return total;
}
/** Board tiles in the engine's wire shape: `kind` is the physical tile, `token`
 *  is the face it is being played as (they differ only for ? +/- x//). */
export function boardCells(state) {
    const cells = [];
    state.inventory.forEach((placement, ordinal) => {
        if (placement.at !== "board")
            return;
        const kind = tokenOfOrdinal(ordinal);
        cells.push({
            r: placement.row,
            c: placement.col,
            kind,
            token: placement.assigned ?? kind,
        });
    });
    // Stable order so the same position always produces the same request bytes,
    // which is what makes an analysis result cacheable by position.
    cells.sort((first, second) => first.r - second.r || first.c - second.c);
    return cells;
}
export function otherSide(side) {
    return side === "A" ? "B" : "A";
}
//# sourceMappingURL=canonical.js.map