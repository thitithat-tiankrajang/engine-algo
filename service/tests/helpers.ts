// Test fixtures: a lawful canonical position, and stand-ins for the two things
// the service does not own — the database and the engine process.
import { TILE_TOKENS, type AmathToken, type Side, type TilePlacement } from "../src/canonical.js";
import type { EngineResponse } from "../src/engineRunner.js";
import type { EngineRoomContext, GameStateSource } from "../src/roomContext.js";
import type { Caller } from "../src/auth.js";

export const GAME_ID = "11111111-2222-3333-4444-555555555555";

/**
 * Build a lawful 100-tile inventory.
 *
 * Every tile is accounted for exactly once, because the service re-proves that
 * before it will search a position — a fixture that cheats here would only prove
 * the checker is off.
 */
export function buildInventory(options: {
  rackA?: AmathToken[];
  rackB?: AmathToken[];
  board?: Array<{ token: AmathToken; row: number; col: number; by: Side; assigned?: string }>;
} = {}): TilePlacement[] {
  const inventory = new Array<TilePlacement | undefined>(TILE_TOKENS.length);
  const taken = new Set<number>();

  const claimOrdinal = (token: AmathToken): number => {
    for (let ordinal = 0; ordinal < TILE_TOKENS.length; ordinal += 1) {
      if (TILE_TOKENS[ordinal] === token && !taken.has(ordinal)) {
        taken.add(ordinal);
        return ordinal;
      }
    }
    throw new Error(`The physical set has no spare "${token}" tile left.`);
  };

  (options.board ?? []).forEach((cell) => {
    const ordinal = claimOrdinal(cell.token);
    inventory[ordinal] = {
      at: "board",
      row: cell.row,
      col: cell.col,
      placedTurn: 1,
      by: cell.by,
      ...(cell.assigned ? { assigned: cell.assigned } : {}),
    };
  });

  (["A", "B"] as const).forEach((side) => {
    const rack = side === "A" ? options.rackA : options.rackB;
    (rack ?? []).forEach((token, seq) => {
      const ordinal = claimOrdinal(token);
      inventory[ordinal] = { at: "rack", side, seq };
    });
  });

  let bagSeq = 0;
  for (let ordinal = 0; ordinal < TILE_TOKENS.length; ordinal += 1) {
    if (!inventory[ordinal]) inventory[ordinal] = { at: "bag", seq: bagSeq++ };
  }
  return inventory as TilePlacement[];
}

export function buildCanonicalPayload(options: {
  revision?: number;
  activeSide?: Side;
  phase?: string;
  status?: string;
  rackA?: AmathToken[];
  rackB?: AmathToken[];
  board?: Array<{ token: AmathToken; row: number; col: number; by: Side; assigned?: string }>;
  scores?: Record<Side, number>;
} = {}): Record<string, unknown> {
  return {
    v: 1,
    gameId: GAME_ID,
    revision: options.revision ?? 7,
    gameMode: "versus",
    drawMode: "play",
    startingSide: "A",
    turnNumber: 4,
    activeSide: options.activeSide ?? "A",
    phase: options.phase ?? "choose_action",
    status: options.status ?? "playing",
    scores: options.scores ?? { A: 30, B: 25 },
    appliedCommands: [],
    inventory: buildInventory(options),
  };
}

export type FakeSourceOptions = Partial<
  Pick<
    EngineRoomContext,
    | "revision"
    | "botSide"
    | "botDifficulty"
    | "activeSide"
    | "callerControlsActiveSide"
    | "activeSideIsBot"
    | "status"
  >
> & {
  canonical?: Record<string, unknown>;
  /** Throw this instead of answering — models an RLS refusal. */
  failWith?: Error;
  commands?: Array<{ kind: string }>;
};

export function fakeSource(
  options: FakeSourceOptions = {},
): GameStateSource & {
  calls: number;
  /** Every `loadRecentCommands` call, so a test can prove the command window was
   *  opened once and at the right revision. */
  commandWindows: number[];
  advanceTo(revision: number): void;
} {
  let revision = options.revision ?? 7;
  const activeSide = options.activeSide ?? "A";
  const state = {
    calls: 0,
    commandWindows: [] as number[],
    /** Model the game moving on underneath a request that is already queued. */
    advanceTo(next: number) {
      revision = next;
    },
    async loadContext(gameId: string): Promise<EngineRoomContext> {
      state.calls += 1;
      if (options.failWith) throw options.failWith;
      const canonical = options.canonical ?? buildCanonicalPayload({ revision, activeSide });
      const { parseCanonical } = await import("../src/canonical.js");
      return {
        gameId,
        revision,
        status: options.status ?? "playing",
        gameMode: "versus",
        modeKey: options.botSide ? `aether_${options.botDifficulty ?? "medium"}` : "local_versus",
        botSide: options.botSide ?? null,
        botDifficulty: options.botDifficulty ?? null,
        activeSide,
        turnNumber: 4,
        phase: "choose_action",
        canonical: parseCanonical(canonical),
        callerControlsActiveSide: options.callerControlsActiveSide ?? true,
        activeSideIsBot: options.activeSideIsBot ?? false,
      };
    },
    async loadRecentCommands(_gameId: string, _token: string, atRevision: number) {
      state.commandWindows.push(atRevision);
      return options.commands ?? [{ kind: "place" }];
    },
  };
  return state;
}

export const CALLER: Caller = {
  userId: "user-1",
  token: "token-1",
  expiresAt: Date.now() + 60_000,
};

export async function fakeVerify(): Promise<Caller> {
  return CALLER;
}

/** A plausible sim-path engine response with a ranked candidate report. */
export function fakeEngineResponse(overrides: Partial<EngineResponse> = {}): EngineResponse {
  return {
    type: "place",
    placements: [
      { r: 7, c: 7, kind: "5", token: "5" },
      { r: 7, c: 8, kind: "+", token: "+" },
    ],
    exchange: [],
    score: 24,
    equity: 31.5,
    solver: "sim",
    endgameSolved: false,
    stats: { moves: 410, nodes: 81234, elapsedMs: 1830, candidates: 16, samples: 4 },
    candidates: [
      {
        type: "place",
        placements: [
          { r: 7, c: 7, kind: "5", token: "5" },
          { r: 7, c: 8, kind: "+", token: "+" },
        ],
        exchange: [],
        score: 24,
        scoreComp: 24,
        leave: 8.5,
        potential: 6.2,
        oppReply: 12.1,
        mean: 26.6,
        stddev: 3.2,
        value: 24.1,
        chosen: true,
      },
      {
        type: "place",
        placements: [{ r: 8, c: 7, kind: "9", token: "9" }],
        exchange: [],
        score: 30,
        scoreComp: 30,
        leave: 2.1,
        potential: 3.0,
        oppReply: 22.4,
        mean: 20.3,
        stddev: 5.1,
        value: 17.7,
        chosen: false,
      },
      {
        type: "exchange",
        placements: [],
        exchange: ["13", "19"],
        score: 0,
        scoreComp: 0,
        leave: 11.4,
        potential: 7.9,
        oppReply: 10.0,
        mean: 12.3,
        stddev: 2.0,
        value: 11.3,
        chosen: false,
      },
    ],
    ...overrides,
  };
}

export function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    port: 0,
    enginePath: "/nonexistent/amath_cli",
    supabaseUrl: "https://example.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    allowedOrigins: ["http://127.0.0.1:5173"],
    concurrency: 2,
    concurrencySource: "env" as const,
    cpu: { cpus: 4, source: "cgroup-v2" as const, parallelism: 8 },
    maxWaiting: 16,
    // The ordering and admission tests care about who runs, not about the
    // clock. Tests that mean to exercise the deadline set it themselves.
    maxQueueWaitMs: 60_000,
    maxBodyBytes: 8 * 1024,
    budgetPerWindow: 60,
    budgetWindowMs: 600_000,
    maxAnalysisPerUser: 1,
    analysisResultTtlMs: 5 * 60 * 1000,
    botResultTtlMs: 60 * 1000,
    jobCacheMax: 256,
    ...overrides,
  };
}
