// ── The Super bot's configuration, versioned and served ──────────────────────
//
// The Super search now runs in the player's browser. That moves the CPU cost
// off this server, and it takes something else with it: the ability to change
// how the bot plays by deploying this service. A weight compiled into a WASM
// module is a weight that needs a 252 KB redownload by every player to change,
// and a game played last month can never be replayed under the weights it was
// actually played with.
//
// So the tuning travels the other way. This file is the source of truth for
// what the client-side engine is configured with, the client fetches it and
// caches it, and a game PINS the versions it started under.
//
// This is NOT a security mechanism and must never be read as one. The weights
// are served to the client in plain JSON, the client could ignore them, and for
// a trusted Champion beta that is fine. What versioning buys is remote tuning,
// A/B testing, rollback, reproducibility, and the ability to explain a game
// afterwards.

/**
 * The compiled engine the client is expected to be running.
 *
 * Bumped when the WASM artifact changes in a way that could change a move:
 * a new solver, a changed schedule, a fixed bug in generation. It is NOT
 * bumped for weights — that is what `weightsVersion` is for, and keeping them
 * separate is the whole reason a weight change no longer needs a rebuild.
 *
 * A client reporting a different engine version is not refused. It is recorded:
 * a Champion who has not reloaded is playing a real game, and stopping it to
 * force a refresh is worse than knowing which build played it.
 */
export const SUPER_ENGINE_VERSION = "super-v10";

/** The weights a NEW game is pinned to. Change this to roll out a retune;
 *  change it back to roll one back. */
export const SUPER_WEIGHTS_VERSION = "v1";

/**
 * One tunable set, as the engine's `weights` request field takes it.
 *
 * `kindValue` is keyed by TOKEN, not by array index, so a document survives a
 * change to the engine's internal tile ordering. Every key is validated by the
 * engine and an unrecognised one is an ERROR rather than a silent no-op — a
 * weights version that quietly applies nothing would report an A/B difference
 * the engine never made.
 */
export type SuperWeights = {
  /**
   * Per-tile base leave value, keyed by the tile's own token — the 29 keys the
   * engine accepts and no others:
   *
   *   "0" … "20"   the number tiles
   *   "+"  "-"  "x"  "/"     the fixed operators
   *   "+/-"  "x//"           the choice tiles
   *   "="  "?"               equals and blank
   *
   * Anything else is an ERROR from the engine, not a no-op. `"//"` and `"÷"`
   * are the two that get typed by mistake; the divide TILE is `"/"`, while
   * `"÷"` is what a placed tile displays.
   */
  kindValue?: Record<string, number>;
  equalsSchedule?: number[];
  zeroMulDivSynergy?: number;
  zeroNoMulDivPenalty?: number;
  heavyBurden?: number;
  operatorRatio?: number;
  operatorStarvation?: number;
  noOperatorPenalty?: number;
  heavyFlankPenalty?: number;
  duplicatePenalty?: number;
  balancePenalty?: number;
  exposeEx3?: number;
  exposeEx2?: number;
  exposePx3?: number;
  exchangeConsiderBar?: number;
  leadDumpPenalty?: number;
  trailFishBonus?: number;
  exchangeTempoCost?: number;
  nextTurnPotentialWeight?: number;
  riskAversionBase?: number;
  riskAversionLeadPer50?: number;
  /** How far the risk coefficient may go BELOW zero when trailing, i.e. the
   *  most variance-seeking the bot ever gets. Defaults to 1.0 in the engine. */
  riskAversionMaxGamble?: number;
};

/**
 * Every weights version this deployment can still serve, including retired
 * ones.
 *
 * Retired versions are kept because a game pinned to one is still a game. A
 * registry that only held the current version would make "reproduce this
 * finished match" impossible the first time anybody retuned anything, which is
 * the single thing pinning exists to prevent.
 *
 * `v1` is deliberately EMPTY: it is the engine's compiled defaults, stated as a
 * version rather than as an absence. Naming it means the first retune is a
 * change from something to something, and a game played today can be told
 * apart from one played under a future `v2` — which an unpinned game could not.
 */
export const SUPER_WEIGHTS: Record<string, SuperWeights> = {
  v1: {},
};

export function isKnownWeightsVersion(version: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPER_WEIGHTS, version);
}

// ── device calibration ───────────────────────────────────────────────────────
//
// Calibration answers exactly one question:
//
//     How fast can THIS device run the SAME Super search?
//
// It does NOT answer "how much can we weaken Super on this device?". That
// distinction is the entire point of this section, and it was not always true:
// an earlier revision served a table of sample budgets and had the client pick
// the largest one that fitted the latency targets. The effect was that a device
// measured at reference speed played 8 of Super's 160 opponent-rack samples,
// while the backend fallback played all 160 — two different opponents, chosen
// by hardware, with no measurement of what the difference was worth.
//
// The rule now is: every Champion gets the full Super schedule, and the device
// decides only how long it waits for it. Nothing in this file may shorten a
// search, and nothing in it may refuse one for being slow — a player who does
// not want to wait for Super picks a weaker BOT, which is a choice they make
// and not one made for them by their hardware.

/**
 * The benchmark the client is expected to run, by name.
 *
 * Named because a throughput number is only comparable against numbers from the
 * SAME benchmark. If the engine's calibration position or node cap ever
 * changes, this changes with it, every cached client calibration becomes
 * unrecognised, and devices re-measure — rather than being tiered against a
 * reference that no longer describes the same work.
 */
export const CALIBRATION_BENCHMARK = "gen-nodes-v1";

/**
 * What the reference device measured, and what it then actually waited for a
 * FULL Super move.
 *
 * The two halves of the prediction. A client runs the same benchmark, and the
 * ratio against `nodesPerSec` is how much slower (or faster) it is; the full
 * Super latency is what that ratio is applied to.
 *
 * There is one latency here rather than a table of them, and that is
 * deliberate. A per-budget table invites a per-device budget, which is the
 * thing this design forbids. The only schedule any device runs is the full one,
 * so the only latency worth serving is the full one's.
 *
 * MEASURED, not assumed — see docs/client-side-super-benchmark.md for the
 * corpus, the run, and the spread behind every number.
 */
export type FullSuperMeasurement = {
  p50Ms: number;
  p95Ms: number;
  /** How many positions the quantiles were taken over. Served because a p95
   *  over 13 samples is a much weaker claim than a p95 over 500, and a reader
   *  deciding how much to trust a device estimate deserves to know which. */
  positions: number;
};

export type CalibrationReference = {
  benchmark: string;
  device: string;
  nodesPerSec: number;
  /** What the reference device waited for a full-schedule Super move. */
  fullSuper: FullSuperMeasurement;
};

/**
 * A latency target — and one that DOES NOT APPLY TO SUPER.
 *
 * The type survives because the experimental adaptive budget needs something to
 * fit a schedule to. It is deliberately not part of the Super path any more,
 * and it is not served at the top level of the calibration document, because
 * every place a latency target can be reached from the default path is a place
 * somebody can reintroduce a cutoff.
 *
 * The history is the argument. `15s p50 / 30s p95` began as a UX target, and
 * then quietly became the thing that CHOSE Super's sample schedule — so a
 * device that could not hit 15 seconds was given a smaller search rather than a
 * longer wait. Super is the strongest bot on offer; its defining property is
 * that it searches exhaustively, and a Super that fits a stopwatch is a
 * different bot wearing the name. A player unwilling to wait has a real remedy
 * already: choose `max`, `hard` or `medium`.
 */
export type LatencyTargets = { p50Ms: number; p95Ms: number };

/**
 * Performance tiers, by estimated p50 for a FULL Super move.
 *
 * A LABEL describing WAIT, and nothing but that. It feeds the report and the
 * line of copy that warns a player their machine will take a while; it gates
 * nothing, selects nothing, and refuses nothing. Since every device runs the
 * identical schedule, the tier is the only thing that legitimately varies
 * between devices.
 *
 * The bands are wide and the numbers are large because full Super is genuinely
 * expensive: minutes, not seconds. Bands drawn at 10 and 20 seconds would put
 * every device on earth in the bottom one and tell a reader nothing.
 *
 * `NOT_RECOMMENDED` is a description, not a refusal — the device still plays
 * full Super, and its owner is told the wait will be long.
 */
export type PerformanceTier = "EXCELLENT" | "GOOD" | "SLOW" | "NOT_RECOMMENDED";

export type TierBand = {
  tier: PerformanceTier;
  /** Upper bound of estimated full-Super p50 for this band, in ms. The last
   *  band has none. */
  maxEstimatedMoveMs: number | null;
};

/**
 * The retired per-budget table, kept as EXPERIMENTAL data and nothing else.
 *
 * These are real measurements and throwing them away would be wasteful: if
 * anybody ever runs the strength experiment that a reduced budget needs before
 * it can ship, this is the latency half of it, already collected.
 *
 * What it must never become again is the default. `enabled` is served from an
 * environment flag that is OFF unless somebody deliberately turns it on, and
 * the client refuses to apply a cap unless it sees that flag true. A reduced
 * budget is a STRENGTH change; it needs its own product decision and its own
 * evidence, neither of which exists.
 */
export type BudgetMeasurement = {
  /** Opponent-rack samples. `null` is the full Super schedule (160). */
  sampleCap: number | null;
  p50Ms: number;
  p95Ms: number;
};

export type AdaptiveBudgetConfig = {
  /** OFF unless `SUPER_ADAPTIVE_BUDGET` is explicitly set. When false the
   *  client must run the full schedule regardless of what `budgets` says. */
  enabled: boolean;
  budgets: BudgetMeasurement[];
  /** The latency the experiment would fit a schedule to. It lives HERE, inside
   *  the flagged experiment, rather than at the top of the calibration document
   *  — so that the default path has no latency target within reach and cannot
   *  grow a cutoff by accident. */
  targets: LatencyTargets;
};

export type SuperClientConfig = {
  clientSuperEnabled: boolean;
  engineVersion: string;
  weightsVersion: string;
  weights: SuperWeights;
  calibration: {
    benchmark: string;
    reference: CalibrationReference;
    tiers: TierBand[];
    /**
     * Estimated p50 above which the player is TOLD the wait will be long.
     *
     * Copy, and only copy. There is deliberately no `minimumTier` beside it any
     * more: an earlier revision had one, and a device below it was refused
     * local play on the strength of a latency estimate. Even though the backend
     * fallback runs the same schedule — so nothing got weaker — it was still a
     * latency-based cutoff sitting in the middle of the Super path, and the
     * next person to touch it would have found the hard part already built.
     *
     * A device that will take ten minutes runs full Super and says so. A player
     * who does not want that picks a weaker bot.
     */
    warnAboveMs: number;
    /** Experimental. See `AdaptiveBudgetConfig`. */
    adaptiveBudget: AdaptiveBudgetConfig;
  };
};

export const CALIBRATION_REFERENCE: CalibrationReference = {
  benchmark: CALIBRATION_BENCHMARK,
  device: "Apple M3 (8 core, 16 GB), macOS 14.6.1, WASM",
  /**
   * Re-measured, and it corrects a real error.
   *
   * This served 5_730_000 until it was checked against the machine it claims to
   * describe. Five fresh runs of `gen-nodes-v1` on that exact machine — four in
   * Chrome through the production worker, one under Node — landed between
   * 8.65M and 8.94M with a median of ~8.75M. The old figure was ~35% low.
   *
   * That error was not harmless, and it is worth being precise about which way
   * it cut. This number is the DENOMINATOR of every device estimate: a device
   * is judged fast or slow by `reference.nodesPerSec / its own`. Understating
   * the reference makes every device look faster than it is, so a machine
   * identical to this one was told to expect ~147 s a move when it would
   * actually wait ~225 s — and the warning that exists to prepare a player for
   * a long wait would have been the thing that under-promised it.
   *
   * The two halves of the reference must come from the SAME machine or the
   * ratio means nothing, and they now do: the latency below was measured on
   * this Mac, and so was this.
   */
  nodesPerSec: 8_700_000,
  // Measured over 13 positions — every turn of one side across two complete
  // games, trimmed to 13 because at ~3.75 minutes a move the full corpus is an
  // hour of wall time. `scripts/bench_reference.mjs` prints this block from the
  // run itself, so what is served is the run rather than a transcription.
  fullSuper: { p50Ms: 225_466, p95Ms: 334_240, positions: 13 },
};

/**
 * NOT a Super target. The experiment's fitting constraint, and nothing else.
 *
 * These are the numbers the brief originally proposed as UX targets. They are
 * kept at their original values so the retired experiment stays reproducible,
 * and they are reachable only through `adaptiveBudget`.
 */
export const EXPERIMENT_LATENCY_TARGETS: LatencyTargets = { p50Ms: 15_000, p95Ms: 30_000 };

/**
 * Estimated full-Super p50 above which the UI warns about the wait.
 *
 * One minute: long enough that a player who has not been warned wonders whether
 * the app has hung, short enough that the warning is not saved for the extreme
 * cases. Purely presentational — crossing it changes what is SAID, never what
 * is searched.
 */
export const WARN_ABOVE_MS = 60_000;

/**
 * Bands over estimated full-Super p50.
 *
 * For orientation: the reference M3 lands at ~225 s and is therefore `SLOW`.
 * That is not a bug in the bands, it is the finding — full Super is minutes of
 * single-core work and no device measured so far makes it feel otherwise.
 * A device would need roughly 2x the reference to reach `GOOD` and roughly 8x
 * to reach `EXCELLENT`.
 */
export const TIER_BANDS: TierBand[] = [
  { tier: "EXCELLENT", maxEstimatedMoveMs: 30_000 },
  { tier: "GOOD", maxEstimatedMoveMs: 120_000 },
  { tier: "SLOW", maxEstimatedMoveMs: 600_000 },
  { tier: "NOT_RECOMMENDED", maxEstimatedMoveMs: null },
];

/** The retired budget table. Served only as experimental data; see
 *  `AdaptiveBudgetConfig` for why it is not a default. */
export const EXPERIMENTAL_BUDGETS: BudgetMeasurement[] = [
  // n=23, max 9.0s
  { sampleCap: 4, p50Ms: 3466, p95Ms: 8215 },
  // n=23, max 17.2s
  { sampleCap: 8, p50Ms: 7703, p95Ms: 14328 },
  // n=23, max 37.7s
  { sampleCap: 16, p50Ms: 15739, p95Ms: 33150 },
  // n=13, max 358.4s — the full schedule, for comparison against the caps.
  { sampleCap: null, p50Ms: 225466, p95Ms: 334240 },
];

/** The document served to a client that is about to play, or is deciding
 *  whether it can. */
export function superClientConfig(options: {
  clientSuperEnabled: boolean;
  weightsVersion?: string;
  /** Experimental reduced-sample budgets. Defaults to OFF: a caller that does
   *  not pass this gets full-strength Super, which is the only safe default. */
  adaptiveBudgetEnabled?: boolean;
}): SuperClientConfig {
  const version = options.weightsVersion ?? SUPER_WEIGHTS_VERSION;
  return {
    clientSuperEnabled: options.clientSuperEnabled,
    engineVersion: SUPER_ENGINE_VERSION,
    weightsVersion: version,
    weights: SUPER_WEIGHTS[version] ?? {},
    calibration: {
      benchmark: CALIBRATION_BENCHMARK,
      reference: CALIBRATION_REFERENCE,
      tiers: TIER_BANDS,
      warnAboveMs: WARN_ABOVE_MS,
      adaptiveBudget: {
        enabled: options.adaptiveBudgetEnabled ?? false,
        budgets: EXPERIMENTAL_BUDGETS,
        targets: EXPERIMENT_LATENCY_TARGETS,
      },
    },
  };
}
