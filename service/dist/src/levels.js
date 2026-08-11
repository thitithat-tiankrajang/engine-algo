// ── Strength tiers, in the two currencies the engine understands ─────────────
//
// Bot play and turn analysis ask the SAME engine for the same search; they
// differ only in how the work is bounded and how much of the result is read
// back out. Both tables live here so the difference between "what the bot would
// do" and "what analysis recommends" is one file, not an emergent property.
/** Bot tiers. Steered by wall-clock budget, preserving the browser's behaviour
 *  exactly — including the ceilings `max` inherits from the engine itself. */
export const BOT_TIERS = ["easy", "medium", "hard", "max"];
export const BOT_TIER_CONFIG = {
    // These four numbers are the browser's, unchanged. Note that the low tiers
    // are not as fast as they look: the simulation takes a minimum of three
    // opponent-rack samples before a deadline can stop it, so anything under
    // roughly three seconds is unreachable on a full board. Measured on the
    // reference machine, easy/medium/hard all land near 3.4s at the opening.
    easy: { budgetMs: 200, timeoutMs: 60_000 },
    medium: { budgetMs: 1_000, timeoutMs: 60_000 },
    hard: { budgetMs: 4_000, timeoutMs: 90_000 },
    // Full strength, including the exact endgame proof. A single move here can
    // legitimately run for two minutes mid-game and five in the endgame.
    max: { budgetMs: null, timeoutMs: 330_000 },
};
export function isBotTier(value) {
    return typeof value === "string" && BOT_TIERS.includes(value);
}
/** Analysis levels, chosen by the player and independent of the room's bot. */
export const ANALYSIS_LEVELS = ["quick", "normal", "deep", "max"];
export const ANALYSIS_LEVEL_CONFIG = {
    quick: { sampleCap: 4, timeoutMs: 30_000, topN: 8, cost: 1, priority: 10 },
    normal: { sampleCap: 12, timeoutMs: 60_000, topN: 12, cost: 3, priority: 20 },
    deep: { sampleCap: 40, timeoutMs: 150_000, topN: 16, cost: 10, priority: 30 },
    // The full sample count the bot's own `max` tier uses. Same search, read out
    // in more detail.
    max: { sampleCap: 160, timeoutMs: 330_000, topN: 24, cost: 30, priority: 40 },
};
export function isAnalysisLevel(value) {
    return typeof value === "string" && ANALYSIS_LEVELS.includes(value);
}
/** Bot turns outrank every analysis level. A game waiting on its opponent is a
 *  worse experience than a study aid taking longer, and this is the ordering
 *  that guarantees analysis load can never stall active play. */
export const BOT_PRIORITY = 0;
//# sourceMappingURL=levels.js.map