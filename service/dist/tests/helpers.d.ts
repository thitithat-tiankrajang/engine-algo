import { type AmathToken, type Side, type TilePlacement } from "../src/canonical.js";
import type { EngineResponse } from "../src/engineRunner.js";
import type { EngineRoomContext, GameStateSource } from "../src/roomContext.js";
import type { Caller } from "../src/auth.js";
export declare const GAME_ID = "11111111-2222-3333-4444-555555555555";
/**
 * Build a lawful 100-tile inventory.
 *
 * Every tile is accounted for exactly once, because the service re-proves that
 * before it will search a position — a fixture that cheats here would only prove
 * the checker is off.
 */
export declare function buildInventory(options?: {
    rackA?: AmathToken[];
    rackB?: AmathToken[];
    board?: Array<{
        token: AmathToken;
        row: number;
        col: number;
        by: Side;
        assigned?: string;
    }>;
}): TilePlacement[];
export declare function buildCanonicalPayload(options?: {
    revision?: number;
    activeSide?: Side;
    phase?: string;
    status?: string;
    rackA?: AmathToken[];
    rackB?: AmathToken[];
    board?: Array<{
        token: AmathToken;
        row: number;
        col: number;
        by: Side;
        assigned?: string;
    }>;
    scores?: Record<Side, number>;
}): Record<string, unknown>;
export type FakeSourceOptions = Partial<Pick<EngineRoomContext, "revision" | "botSide" | "botDifficulty" | "activeSide" | "callerControlsActiveSide" | "activeSideIsBot" | "status">> & {
    canonical?: Record<string, unknown>;
    /** Throw this instead of answering — models an RLS refusal. */
    failWith?: Error;
    commands?: Array<{
        kind: string;
    }>;
};
export declare function fakeSource(options?: FakeSourceOptions): GameStateSource & {
    calls: number;
};
export declare const CALLER: Caller;
export declare function fakeVerify(): Promise<Caller>;
/** A plausible sim-path engine response with a ranked candidate report. */
export declare function fakeEngineResponse(overrides?: Partial<EngineResponse>): EngineResponse;
export declare function baseConfig(overrides?: Record<string, unknown>): {
    port: number;
    enginePath: string;
    supabaseUrl: string;
    supabasePublishableKey: string;
    allowedOrigins: string[];
    concurrency: number;
    maxWaiting: number;
    maxBodyBytes: number;
    budgetPerWindow: number;
    budgetWindowMs: number;
    maxAnalysisPerUser: number;
};
