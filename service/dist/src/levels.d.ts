/** Bot tiers. Steered by wall-clock budget, preserving the browser's behaviour
 *  exactly — including the ceilings `max` inherits from the engine itself. */
export declare const BOT_TIERS: readonly ["easy", "medium", "hard", "max"];
export type BotTier = (typeof BOT_TIERS)[number];
export type BotTierConfig = {
    /** Passed to the engine as `budgetMs`. `null` means send none, so the engine
     *  falls back to its own ceilings (120s midgame / 300s endgame). */
    budgetMs: number | null;
    /** Hard ceiling enforced by the service. Above the engine's own ceiling, so
     *  under normal operation the engine stops itself and this never fires. */
    timeoutMs: number;
};
export declare const BOT_TIER_CONFIG: Record<BotTier, BotTierConfig>;
export declare function isBotTier(value: unknown): value is BotTier;
/** Analysis levels, chosen by the player and independent of the room's bot. */
export declare const ANALYSIS_LEVELS: readonly ["quick", "normal", "deep", "max"];
export type AnalysisLevel = (typeof ANALYSIS_LEVELS)[number];
export type AnalysisLevelConfig = {
    /** Opponent-rack samples. Bounding the WORK rather than the TIME is what
     *  makes a level reproducible: a wall-clock cutoff stops the simulation at
     *  whatever sample the machine happened to reach, so the same position could
     *  rank candidates differently on a busy server. */
    sampleCap: number;
    /** Safety net only. If this fires the result is incomplete and is reported as
     *  such rather than presented as a considered opinion. */
    timeoutMs: number;
    /** How many ranked alternatives to read back. */
    topN: number;
    /** Cost weight for the per-user compute budget. */
    cost: number;
    /** Queue priority. Larger runs later; bot turns always run first. */
    priority: number;
};
export declare const ANALYSIS_LEVEL_CONFIG: Record<AnalysisLevel, AnalysisLevelConfig>;
export declare function isAnalysisLevel(value: unknown): value is AnalysisLevel;
/** Bot turns outrank every analysis level. A game waiting on its opponent is a
 *  worse experience than a study aid taking longer, and this is the ordering
 *  that guarantees analysis load can never stall active play. */
export declare const BOT_PRIORITY = 0;
