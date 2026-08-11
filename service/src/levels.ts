// ── Strength tiers, in the two currencies the engine understands ─────────────
//
// Bot play and turn analysis ask the SAME engine for the same search; they
// differ only in how the work is bounded and how much of the result is read
// back out. Both tables live here so the difference between "what the bot would
// do" and "what analysis recommends" is one file, not an emergent property.

/** Bot tiers. Steered by wall-clock budget, preserving the browser's behaviour
 *  exactly — including the ceilings `max` inherits from the engine itself. */
export const BOT_TIERS = ["easy", "medium", "hard", "max"] as const;
export type BotTier = (typeof BOT_TIERS)[number];

export type BotTierConfig = {
  /** Passed to the engine as `budgetMs`. `null` means send none, so the engine
   *  falls back to its own ceilings (120s midgame / 300s endgame). */
  budgetMs: number | null;
  /** Hard ceiling enforced by the service. Above the engine's own ceiling, so
   *  under normal operation the engine stops itself and this never fires. */
  timeoutMs: number;
};

export const BOT_TIER_CONFIG: Record<BotTier, BotTierConfig> = {
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

export function isBotTier(value: unknown): value is BotTier {
  return typeof value === "string" && (BOT_TIERS as readonly string[]).includes(value);
}

/** Analysis levels, chosen by the player and independent of the room's bot. */
export const ANALYSIS_LEVELS = ["quick", "normal", "deep", "max"] as const;
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

export const ANALYSIS_LEVEL_CONFIG: Record<AnalysisLevel, AnalysisLevelConfig> = {
  quick: { sampleCap: 4, timeoutMs: 30_000, topN: 8, cost: 1, priority: 10 },
  normal: { sampleCap: 12, timeoutMs: 60_000, topN: 12, cost: 3, priority: 20 },
  deep: { sampleCap: 40, timeoutMs: 150_000, topN: 16, cost: 10, priority: 30 },
  // The full sample count the bot's own `max` tier uses. Same search, read out
  // in more detail.
  max: { sampleCap: 160, timeoutMs: 330_000, topN: 24, cost: 30, priority: 40 },
};

export function isAnalysisLevel(value: unknown): value is AnalysisLevel {
  return typeof value === "string" && (ANALYSIS_LEVELS as readonly string[]).includes(value);
}

/** Bot turns outrank every analysis level. A game waiting on its opponent is a
 *  worse experience than a study aid taking longer, and this is the ordering
 *  that guarantees analysis load can never stall active play. */
export const BOT_PRIORITY = 0;
