// ── Study positions: analysing a board nobody played ─────────────────────────
//
// Every other engine request in this service names a ROOM and a REVISION, and
// the position is read out of the server's own state. That rule exists because
// a client must not be able to ask about a board that has moved on, or about
// tiles it is not entitled to see.
//
// A study position is the one case where neither risk exists. There is no room,
// no opponent and no turn order: the caller invented the whole position,
// including their own rack, so there is nothing here they could learn that they
// did not already type in. What replaces the room's authority is this module —
// the position still has to be a position, and "the caller made it up" is not
// the same as "anything goes".
//
// What is checked, and why each one matters:
//
//   • The tiles have to exist. A rack of eight `=` and a board holding twelve
//     more is not a hard puzzle, it is a different game, and the engine's whole
//     model of the unseen pool is derived by subtraction from the physical set.
//   • Squares have to be on the board and hold one tile each.
//   • The hidden inventory is DERIVED here, never accepted from the caller. It
//     is the one number a client could use to make the engine reason about a
//     bag that cannot exist.

import {
  BOARD_SIZE,
  EXCHANGE_MIN_RESERVE,
  RACK_SIZE,
  TILE_COUNT,
  TILE_TOKENS,
  TOKEN_ORDER,
  type AmathToken,
} from "./canonical.js";

export class StudyPositionError extends Error {
  override readonly name = "StudyPositionError";
}

export type StudyBoardCell = {
  r: number;
  c: number;
  /** The physical tile. */
  kind: AmathToken;
  /** The face it is played as; differs from `kind` only for `?`, `+/-`, `x//`. */
  token: string;
};

export type StudyPosition = {
  scoreSelf: number;
  scoreOpponent: number;
  board: StudyBoardCell[];
  rack: AmathToken[];
  /**
   * How many tiles the opponent holds, and how many are still in the bag.
   *
   * Derived, not asked for. The rule is the game's own: a player holds a full
   * rack while there are tiles to draw, so the opponent has `RACK_SIZE` until
   * the unseen pool falls below it — and once the bag is empty the opponent
   * holds ALL of it. That last case is the one that matters most for study,
   * because it is what puts the engine on its exact end-game path: with the bag
   * at zero the opponent's rack is not a guess, it is everything the board and
   * your own rack do not account for, and the answer comes back proven rather
   * than sampled.
   */
  oppRackCount: number;
  bagCount: number;
};

const TOKENS = new Set<string>(TOKEN_ORDER);

/** Copies of each token in the physical set, derived from the one manifest
 *  rather than restated — a second copy of these numbers is a second thing to
 *  get wrong. */
const TOKEN_COPIES = ((): ReadonlyMap<AmathToken, number> => {
  const counts = new Map<AmathToken, number>();
  for (const token of TILE_TOKENS) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
})();

function isToken(value: unknown): value is AmathToken {
  return typeof value === "string" && TOKENS.has(value);
}

function wholeNumber(value: unknown, name: string, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new StudyPositionError(`${name} must be a whole number between 0 and ${max}.`);
  }
  return parsed;
}

/**
 * Read a study position from a request body, or refuse it with a reason a
 * player can act on.
 *
 * Nothing here trusts the caller beyond the shape of what they typed: the board
 * and rack are theirs to invent, and everything downstream of them — the unseen
 * pool, the bag, whether an exchange is even legal — is computed from the
 * physical tile set.
 */
export function parseStudyPosition(body: Record<string, unknown>): StudyPosition {
  const scoreSelf = wholeNumber(body.scoreSelf ?? 0, "scoreSelf", 9999);
  const scoreOpponent = wholeNumber(body.scoreOpponent ?? 0, "scoreOpponent", 9999);

  const rawBoard = Array.isArray(body.board) ? body.board : [];
  const rawRack = Array.isArray(body.rack) ? body.rack : null;
  if (!rawRack) throw new StudyPositionError("A rack is required.");
  if (rawRack.length < 1 || rawRack.length > RACK_SIZE) {
    throw new StudyPositionError(`The rack must hold between 1 and ${RACK_SIZE} tiles.`);
  }

  const occupied = new Set<number>();
  const board: StudyBoardCell[] = rawBoard.map((raw) => {
    const cell = (raw ?? {}) as Record<string, unknown>;
    const r = wholeNumber(cell.r, "board row", BOARD_SIZE - 1);
    const c = wholeNumber(cell.c, "board column", BOARD_SIZE - 1);
    if (!isToken(cell.kind)) {
      throw new StudyPositionError(`"${String(cell.kind)}" is not a tile this game has.`);
    }
    const square = r * BOARD_SIZE + c;
    if (occupied.has(square)) {
      throw new StudyPositionError(`Two tiles were placed on the same square (${r}, ${c}).`);
    }
    occupied.add(square);
    // A face the caller did not state is the tile's own: only `?`, `+/-` and
    // `x//` can be played as something else.
    const token = typeof cell.token === "string" && cell.token ? cell.token : cell.kind;
    return { r, c, kind: cell.kind, token };
  });

  const rack: AmathToken[] = rawRack.map((raw) => {
    if (!isToken(raw)) {
      throw new StudyPositionError(`"${String(raw)}" is not a tile this game has.`);
    }
    return raw;
  });

  // The set is finite and the position has to fit inside it.
  const used = new Map<AmathToken, number>();
  for (const cell of board) used.set(cell.kind, (used.get(cell.kind) ?? 0) + 1);
  for (const token of rack) used.set(token, (used.get(token) ?? 0) + 1);
  for (const [token, count] of used) {
    const available = TOKEN_COPIES.get(token) ?? 0;
    if (count > available) {
      throw new StudyPositionError(
        `The set has ${available} "${token}" tile${available === 1 ? "" : "s"}, ` +
          `but this position uses ${count}.`,
      );
    }
  }

  const unseen = TILE_COUNT - board.length - rack.length;
  if (unseen < 0) {
    throw new StudyPositionError("This position uses more tiles than the game contains.");
  }
  const oppRackCount = Math.min(RACK_SIZE, unseen);

  return {
    scoreSelf,
    scoreOpponent,
    board,
    rack,
    oppRackCount,
    bagCount: unseen - oppRackCount,
  };
}

/**
 * Whether the side to move may exchange here.
 *
 * Mirrors the versus rule in EQ-Lab's `getExchangeRule` — the reserve counts the
 * opponent's rack alongside the bag — so a study position offers exactly the
 * moves the same position would offer in a real game. Getting this wrong would
 * not error; it would quietly add or remove a legal move from the ranking.
 */
export function studyExchangeAllowed(position: StudyPosition): boolean {
  return position.bagCount + position.oppRackCount - RACK_SIZE >= EXCHANGE_MIN_RESERVE;
}

/**
 * A stable identity for a position + strength.
 *
 * Two identical puzzles asked at the same level are the same search, so this is
 * both the engine's seed and the job key: the second ask joins the first rather
 * than paying for it again, and the same puzzle always returns the same ranking
 * instead of drifting between visits.
 */
export function studyFingerprint(position: StudyPosition, level: string): string {
  const cells = position.board
    .map((cell) => `${cell.r},${cell.c},${cell.kind},${cell.token}`)
    .sort()
    .join("|");
  const rack = [...position.rack].sort().join(",");
  return [
    cells,
    rack,
    position.scoreSelf,
    position.scoreOpponent,
    position.oppRackCount,
    position.bagCount,
    level,
  ].join("#");
}
