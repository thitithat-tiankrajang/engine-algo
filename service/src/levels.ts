// ── Strength tiers, in the two currencies the engine understands ─────────────
//
// Bot play and turn analysis ask the SAME engine for the same search; they
// differ only in how the work is bounded and how much of the result is read
// back out. Both tables live here so the difference between "what the bot would
// do" and "what analysis recommends" is one file, not an emergent property.

/** Bot tiers, weakest first. Each names a decision procedure and how the search
 *  is bounded: a wall-clock budget, the engine's own ceilings, or nothing at
 *  all. */
export const BOT_TIERS = ["medium", "hard", "max", "super"] as const;
export type BotTier = (typeof BOT_TIERS)[number];

export type BotTierConfig = {
  /** Passed to the engine as `budgetMs`. `null` means send none, so the engine
   *  falls back to its own ceilings (120s midgame / 300s endgame). */
  budgetMs: number | null;
  /**
   * Remove every wall-clock ceiling the engine has — mid-game, end-game and
   * root generation alike — and let the search run its planned schedule to
   * completion.
   *
   * The distinction from `max` is not "a bigger budget". `max` runs the same
   * schedule but stops at 120s (300s in the end-game), so its progress line
   * ends wherever the deadline fell — typically well short of the full sample
   * count on an open board. An unlimited search stops because it is FINISHED,
   * and the 100% it reports is a real 100%. The work is bounded by the
   * schedule (`simSamples` samples over a capped candidate set, plus a
   * node-bounded end-game proof), so this terminates on its own.
   */
  unlimited: boolean;
  /** Hard ceiling enforced by the service. Above the engine's own ceiling, so
   *  under normal operation the engine stops itself and this never fires. */
  timeoutMs: number;
  /** Which decision procedure the engine should run once the exact end-game
   *  path has declined the position.
   *
   *  `"static"` is the deterministic static-equity ranking: one root move
   *  generation and no sampling. `"sim"` is the 2-ply search over sampled
   *  opponent racks.
   *
   *  This is stated per tier rather than inferred from `budgetMs`, because
   *  inferring it is what went wrong before: `budgetMs` is advice about time,
   *  the sampler cannot honour a deadline below three complete samples, and so
   *  the 200 ms tier below quietly cost ~2.9 s a move. */
  solver: "static" | "sim";
  /**
   * Cost units charged against the caller's compute budget.
   *
   * ONE UNIT IS ROUGHLY FOUR ENGINE-SECONDS. Priced that way because the budget
   * rations COMPUTE, and pricing by tier rank instead priced it by name: at 2
   * for `medium` and 8 for `max` the ratio was 4x for tiers whose real cost
   * differs by 32x, so the cheap tier — the one most games are actually played
   * at — ran out of ration first while barely touching the CPU. A player got
   * `budget_exhausted` after thirty three-second moves.
   *
   * Stated per tier rather than at the call site, because the call site is one
   * ternary that a new tier silently falls off the end of.
   */
  cost: number;
};

export const BOT_TIER_CONFIG: Record<BotTier, BotTierConfig> = {
  // The simulating tiers. Note they are not as fast as they look: the
  // simulation takes a minimum of three opponent-rack samples before a deadline
  // can stop it, so anything under roughly three seconds is unreachable on a
  // full board — medium and hard both land near 3.4s at the opening on the
  // reference machine.
  medium: { budgetMs: 1_000, unlimited: false, timeoutMs: 60_000, solver: "sim", cost: 1 },
  hard: { budgetMs: 4_000, unlimited: false, timeoutMs: 90_000, solver: "sim", cost: 1 },
  // Full strength under the engine's own ceilings, including the exact endgame
  // proof. A single move here can legitimately run for two minutes mid-game and
  // five in the endgame.
  max: { budgetMs: null, unlimited: false, timeoutMs: 330_000, solver: "sim", cost: 27 },
  // The same search as `max` with the clock taken off it: it returns when the
  // schedule is complete, not when a deadline fires.
  //
  // `timeoutMs` here is NOT a strength ceiling and must never be read as one.
  // It is the reaper for a process that has stopped making progress — wedged,
  // not thinking. It sits far above any real search so that under normal
  // operation the engine always finishes first and this never fires.
  //
  // Measured on the reference machine at the opening (an empty board, 68
  // candidates, the widest schedule a game has): `max` stopped at 108s having
  // completed 122 of 160 samples; `super` ran all 160 in 143s. At four engine-
  // seconds to the unit that is 27 and 36.
  super: { budgetMs: null, unlimited: true, timeoutMs: 3_600_000, solver: "sim", cost: 36 },
};

export function isBotTier(value: unknown): value is BotTier {
  return typeof value === "string" && (BOT_TIERS as readonly string[]).includes(value);
}

/** Tiers that no longer exist, and what a room recorded under one now plays as.
 *  Rooms outlive tier tables: a game created against `easy` is still a game,
 *  and dropping the tier must not turn it into a room with no engine player. */
const RETIRED_BOT_TIERS: Record<string, BotTier> = {
  easy: "medium",
};

/**
 * Read a stored tier, resolving retired names to the tier that replaced them.
 *
 * `isBotTier` alone would answer "no" for `easy` and leave the room with a null
 * difficulty — which the bot endpoint reports as "this game has no engine
 * player", i.e. an in-progress game that can no longer be played.
 */
export function resolveBotTier(value: unknown): BotTier | null {
  if (isBotTier(value)) return value;
  if (typeof value === "string") return RETIRED_BOT_TIERS[value] ?? null;
  return null;
}

/**
 * How many ranked alternatives a bot search reports.
 *
 * `topN` bounds only how much of an already-computed ranking is SERIALISED — it
 * does not change move generation, evaluation, sampling, or the move chosen.
 * (`serializeRows` in the engine sorts, truncates, and prints; nothing upstream
 * of it reads the number.) So raising it costs a few kilobytes of stdout and
 * buys the "why did it play that" report a real ranking to show instead of the
 * default handful.
 *
 * It is stated once, for every tier, because the report is about explaining the
 * decision rather than about strength: a `medium` move deserves the same
 * explanation depth as a `super` one.
 */
export const BOT_REPORT_TOP_N = 24;

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

/**
 * How many ranked moves a study record keeps.
 *
 * The engine reports a longer tail (`BOT_REPORT_TOP_N`) and the search does not
 * change either way — this is how much of the ranking is WRITTEN DOWN. Ten is
 * enough to see the shape of the position (what the engine liked, what it
 * nearly liked, and how far behind the rest fell) without turning a study note
 * into a data dump.
 */
export const STUDY_TOP_N = 10;

/**
 * Study runs last.
 *
 * Larger is later, and this sits above every analysis level, which in turn sit
 * above bot turns. A study position is nobody's live game: there is no
 * opponent waiting on it and no clock running against it, so it must never be
 * the reason a real game's move is queued behind something.
 */
export const STUDY_PRIORITY = 50;

/** Bot turns outrank every analysis level. A game waiting on its opponent is a
 *  worse experience than a study aid taking longer, and this is the ordering
 *  that guarantees analysis load can never stall active play. */
export const BOT_PRIORITY = 0;
