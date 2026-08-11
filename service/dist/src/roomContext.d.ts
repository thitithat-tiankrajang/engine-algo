import { type CanonicalState } from "./canonical.js";
import { type BotTier } from "./levels.js";
export type EngineRoomContext = {
    gameId: string;
    revision: number;
    status: string;
    gameMode: string;
    modeKey: string | null;
    botSide: "A" | "B" | null;
    botDifficulty: BotTier | null;
    activeSide: "A" | "B";
    turnNumber: number;
    phase: string;
    canonical: CanonicalState;
    /** Whether the caller controls the side currently on move. The database's
     *  answer, from `controls_live_game_side`. */
    callerControlsActiveSide: boolean;
    activeSideIsBot: boolean;
};
export declare class RoomAccessError extends Error {
    readonly status: 403 | 404;
    readonly name = "RoomAccessError";
    constructor(message: string, status?: 403 | 404);
}
export type CommittedCommandRow = {
    revision: number;
    command: {
        kind?: string;
    };
};
export interface GameStateSource {
    loadContext(gameId: string, token: string): Promise<EngineRoomContext>;
    /** The tail of the committed command log, ending at `revision`. */
    loadRecentCommands(gameId: string, token: string, revision: number, count: number): Promise<Array<{
        kind: string;
    }>>;
}
export declare function createSupabaseSource(supabaseUrl: string, publishableKey: string): GameStateSource;
