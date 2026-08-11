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
  /** Per-user compute budget: cost units per window. */
  budgetPerWindow: number;
  budgetWindowMs: number;
  /** Concurrent analysis jobs one user may hold. */
  maxAnalysisPerUser: number;
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
    budgetPerWindow: integer(env, "ENGINE_BUDGET_PER_WINDOW", 60),
    budgetWindowMs: integer(env, "ENGINE_BUDGET_WINDOW_MS", 10 * 60 * 1000),
    maxAnalysisPerUser: integer(env, "ENGINE_MAX_ANALYSIS_PER_USER", 1),
    analysisResultTtlMs: integer(env, "ENGINE_ANALYSIS_RESULT_TTL_MS", 30 * 60 * 1000),
    botResultTtlMs: integer(env, "ENGINE_BOT_RESULT_TTL_MS", 30 * 60 * 1000),
    jobCacheMax: boundedInteger(env, "ENGINE_JOB_CACHE_MAX", 256, 1, 100_000),
  };
}
