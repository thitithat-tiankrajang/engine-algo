// ── Service configuration ────────────────────────────────────────────────────
//
// Read once at startup and validated loudly. Authentication configuration must
// never degrade quietly into a service that accepts anything.

import { type CpuDetection, MAX_CONCURRENCY, defaultConcurrency, detectCpuLimit } from "./cpu.js";

export type ServiceConfig = {
  port: number;
  /** Path to the compiled `amath_cli`. */
  enginePath: string;
  supabaseUrl: string;
  /** Low-privilege API key. The caller's JWT, not this key, supplies identity. */
  supabasePublishableKey: string;
  /** Origins allowed to call this service. Never `*`: requests carry a bearer
   *  token, and a wildcard would let any page spend a signed-in user's budget. */
  allowedOrigins: string[];
  /** Simultaneous `amath_cli` PROCESSES, not simultaneous HTTP requests. */
  concurrency: number;
  /** Whether `concurrency` came from the environment or was derived. */
  concurrencySource: "env" | "derived";
  /** What the CPU allowance actually turned out to be, and how we know. */
  cpu: CpuDetection;
  maxWaiting: number;
  /** How long a job may sit in the queue before it is refused. Bounding the
   *  DEPTH alone is not enough: at concurrency 1 a queue of eight `max`
   *  searches is a 40-minute wait, and a refusal the caller can retry beats an
   *  acceptance it will abandon. */
  maxQueueWaitMs: number;
  /** Largest request body accepted. The API takes identifiers, not positions,
   *  so this is generous by an order of magnitude already. */
  maxBodyBytes: number;
  /**
   * Per-user compute budget: cost units per window. Always applies to bot
   * turns; applies to analysis only when `analysisBudgeted` is on.
   *
   * One unit is roughly four engine-seconds (see `cost` in levels.ts), so the
   * default of 300 is about twice what a single engine process could produce in
   * the ten-minute window. That is deliberate: one player taking turns cannot
   * reach it at ANY tier, because the wall clock stops them first — a `max`
   * move takes 108s, so ten minutes buys about five of them, and five costs
   * 135. What it does still bound is the thing the budget is actually for:
   * parallel or scripted use, where nobody is waiting for a move before asking
   * for the next one.
   *
   * The previous 60 was sized as though every request cost the same. It did
   * not, and a player at `medium` — three seconds a move — was refused after
   * thirty moves of a game that needs about twenty-five.
   */
  budgetPerWindow: number;
  budgetWindowMs: number;
  /**
   * Whether the budget refuses anything at all.
   *
   * Off is for a single-user machine, where the ration protects nobody: there
   * is no other account to be fair to and no shared instance to monopolise. It
   * is a separate switch rather than an enormous `budgetPerWindow` so that a
   * deployment cannot arrive at "effectively unlimited" by accident, and so the
   * boot log can say plainly that metering is off.
   */
  budgetEnforced: boolean;
  /**
   * Analysis jobs one account may have IN FLIGHT at once — queued or running,
   * because a job waiting its turn is work this account has already asked for.
   *
   * This is the limit that survives, and it is deliberately the shape of "one
   * at a time" rather than "N per hour": a player may analyse as many times as
   * they like over a session, but each request waits for the previous one. What
   * that bounds is how much of the queue one account can occupy at any instant;
   * what it does not do is run out.
   */
  maxAnalysisPerUser: number;
  /**
   * Whether analysis also spends the sliding-window compute budget above.
   *
   * Off by default: a budget is a RATION, and rationing a study aid is the one
   * thing this service should not do — it fails the player mid-game, on the
   * turn they actually stopped to think about, and no amount of waiting gets
   * them an answer. The one-at-a-time cap above expresses the same fairness
   * without that failure mode: press analyse as often as you like, each one
   * takes its turn in the queue.
   *
   * Bot moves are budgeted either way — those are not paced by a player sitting
   * and waiting for the answer.
   *
   * Set `ENGINE_ANALYSIS_BUDGETED=true` to ration analysis as well.
   */
  analysisBudgeted: boolean;
  /** How long a completed analysis result is served from cache. Analysis is a
   *  pure function of an immutable (position, settings), so a returning player
   *  can be shown the answer without paying for the search again. */
  analysisResultTtlMs: number;
  /** How long a completed bot move is served from cache. Short by design: it
   *  pins one move to one canonical turn across a reconnect, and must not make
   *  the bot deterministic across turns. */
  botResultTtlMs: number;
  /** Hard ceiling on cached engine results, evicted least-recently-used. */
  jobCacheMax: number;
  /**
   * Whether Champion clients may run the Super search on their own device.
   *
   * The rollout switch, and deliberately a SERVER-side one: the point of the
   * client-side path is that it costs this service nothing, so the moment it
   * misbehaves the fix has to be available without shipping anything to a
   * browser. Off, every Super turn falls back to the existing backend path,
   * which is left completely intact.
   *
   * It gates OFFERING the path, not the engine's correctness. A client already
   * mid-game when this is turned off finishes that game on the device it
   * started on — the versions are pinned to the game (superConfig.ts), and
   * switching engines mid-match is the one thing pinning exists to prevent.
   */
  clientSideSuper: boolean;
  /**
   * WHICH signed-in users may run Super on their own device.
   *
   * `clientSideSuper` above is the master switch; this is the audience. Both
   * must agree before a client is offered the local path, and the audience
   * defaults to NOBODY — an empty list with the flag on serves the backend path
   * to everyone.
   *
   * That default is the point. The beta is explicitly Champions-only, and the
   * failure mode of a deployment-wide boolean is silent and total: flip it and
   * every signed-in player starts computing Super moves on their own laptop,
   * with no way to tell from the flag alone that it happened. Failing closed
   * means the blast radius of a mistaken `CLIENT_SIDE_SUPER=true` is zero
   * players rather than all of them.
   *
   * Entries are Supabase user ids (`auth.uid()`), compared case-insensitively.
   * The single entry `*` means every authenticated user and is how this beta
   * eventually graduates — spelled out, so general availability is something
   * somebody typed rather than something an empty variable did by accident.
   */
  clientSideSuperUserIds: string[];
  /**
   * EXPERIMENTAL: let the client trade Super's playing strength for latency.
   *
   * When true the client may cap the opponent-rack sample schedule to fit the
   * served latency targets, so a slower device plays a WEAKER bot rather than
   * a later one. That is a product decision nobody has taken and an effect
   * nobody has measured, which is why it is a flag and why the flag is off.
   *
   * The default path gives every device the identical full schedule and lets
   * the slow ones wait. See `superConfig.ts`.
   */
  superAdaptiveBudget: boolean;
  /**
   * Simultaneous legality validations. Tiny, and separate from
   * `concurrency` on purpose: a validation is a few microseconds of rules
   * arithmetic with no search in it, and making it queue behind a five-minute
   * analysis would mean a client that computed its own move in ten seconds then
   * waited minutes for permission to play it.
   */
  validationConcurrency: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required. Refusing to start without it.`);
  }
  return value.trim();
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return Math.floor(value);
}

/** Bounded integer, refusing anything outside the range loudly. A concurrency
 *  of 0 or 500 is a typo, and starting with it is worse than not starting. */
function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number, got "${raw}".`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}, got "${raw}".`);
  }
  return value;
}

/** A switch, read strictly. An unrecognised spelling is refused rather than
 *  quietly taken as `false`: a typo that silently turns metering off is the
 *  kind of degradation this file exists to prevent. */
function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  throw new Error(`${name} must be true or false, got "${env[name]}".`);
}

export type LoadConfigOptions = {
  /** Injectable so the CPU-detection behaviour can be tested without a
   *  container. */
  cpu?: CpuDetection;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): ServiceConfig {
  const origins = (env.ENGINE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error(
      "ENGINE_ALLOWED_ORIGINS is required (comma-separated). A wildcard is not accepted: " +
        "requests carry a bearer token and any origin could spend a signed-in user's budget.",
    );
  }
  if (origins.includes("*")) {
    throw new Error("ENGINE_ALLOWED_ORIGINS must name origins explicitly; \"*\" is not accepted.");
  }

  // The Champion allowlist. Lowercased once here so the per-request check is a
  // plain comparison rather than a case fold on every config fetch.
  const championIds = (env.CLIENT_SIDE_SUPER_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (championIds.includes("*") && championIds.length > 1) {
    // Ambiguous, and ambiguity here decides how many people get the beta. `*`
    // alongside named ids reads as "these Champions, plus everyone", which is
    // either a mistake or a leftover from graduating the beta — and both want
    // a human to look rather than a guess.
    throw new Error(
      'CLIENT_SIDE_SUPER_USER_IDS may be "*" (everyone) or a list of user ids, not both.',
    );
  }

  // The CPU allowance the container actually has — the cgroup quota, not the
  // host's core count. See cpu.ts for why those differ and why it matters.
  const cpu = options.cpu ?? detectCpuLimit();
  const derivedConcurrency = defaultConcurrency(cpu.cpus);
  const explicitConcurrency = env.ENGINE_CONCURRENCY?.trim();
  const concurrency = boundedInteger(
    env,
    "ENGINE_CONCURRENCY",
    derivedConcurrency,
    1,
    MAX_CONCURRENCY,
  );

  // Queue depth scales with what the queue can actually drain. A fixed 64 means
  // something quite different at concurrency 1 than at concurrency 8, and at
  // concurrency 1 it means a wait no player would sit through.
  const derivedMaxWaiting = Math.min(64, Math.max(8, concurrency * 8));

  return {
    port: integer(env, "PORT", 8787),
    enginePath: env.ENGINE_BINARY_PATH?.trim() || "/usr/local/bin/amath_cli",
    supabaseUrl: required(env, "SUPABASE_URL"),
    supabasePublishableKey: required(env, "SUPABASE_PUBLISHABLE_KEY"),
    allowedOrigins: origins,
    concurrency,
    concurrencySource: explicitConcurrency ? "env" : "derived",
    cpu,
    maxWaiting: boundedInteger(env, "ENGINE_MAX_WAITING", derivedMaxWaiting, 1, 1024),
    maxQueueWaitMs: integer(env, "ENGINE_MAX_QUEUE_WAIT_MS", 120_000),
    maxBodyBytes: integer(env, "ENGINE_MAX_BODY_BYTES", 8 * 1024),
    budgetPerWindow: integer(env, "ENGINE_BUDGET_PER_WINDOW", 300),
    budgetWindowMs: integer(env, "ENGINE_BUDGET_WINDOW_MS", 10 * 60 * 1000),
    budgetEnforced: flag(env, "ENGINE_BUDGET_ENFORCED", true),
    maxAnalysisPerUser: integer(env, "ENGINE_MAX_ANALYSIS_PER_USER", 1),
    analysisBudgeted: flag(env, "ENGINE_ANALYSIS_BUDGETED", false),
    analysisResultTtlMs: integer(env, "ENGINE_ANALYSIS_RESULT_TTL_MS", 30 * 60 * 1000),
    botResultTtlMs: integer(env, "ENGINE_BOT_RESULT_TTL_MS", 30 * 60 * 1000),
    jobCacheMax: boundedInteger(env, "ENGINE_JOB_CACHE_MAX", 256, 1, 100_000),
    clientSideSuper: flag(env, "CLIENT_SIDE_SUPER", false),
    clientSideSuperUserIds: championIds,
    // EXPERIMENTAL, and off unless somebody deliberately turns it on. True
    // makes the client pick a reduced opponent-rack sample budget to fit the
    // latency targets, which is a change to how STRONG the bot plays and not
    // merely to how long it takes. There is no measurement of what that costs
    // in playing strength, so it must never become a default.
    superAdaptiveBudget: flag(env, "SUPER_ADAPTIVE_BUDGET", false),
    validationConcurrency: boundedInteger(env, "ENGINE_VALIDATION_CONCURRENCY", 4, 1, 64),
  };
}

/**
 * May this signed-in user run Super on their own device?
 *
 * Both halves must agree: the deployment-wide switch must be on AND the user
 * must be in the audience. Deliberately one function rather than two checks at
 * the call site — a rollout gate that can be half-applied is a rollout gate
 * that eventually is.
 */
export function clientSuperAllowedFor(config: ServiceConfig, userId: string): boolean {
  if (!config.clientSideSuper) return false;
  const audience = config.clientSideSuperUserIds;
  if (audience.length === 0) return false;
  if (audience.length === 1 && audience[0] === "*") return true;
  // Folded HERE rather than trusting `loadConfig` to have done it. This function
  // is exported and takes a plain `ServiceConfig`, so it is reachable with a
  // hand-built one — and the bug that would cause is a Champion silently
  // dropped from their own beta because a UUID was pasted in the wrong case.
  const wanted = userId.trim().toLowerCase();
  return audience.some((id) => id.trim().toLowerCase() === wanted);
}
