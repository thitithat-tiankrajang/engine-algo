// ── Service configuration ────────────────────────────────────────────────────
//
// Read once at startup and validated loudly. Authentication configuration must
// never degrade quietly into a service that accepts anything.

import { availableParallelism } from "node:os";

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
  concurrency: number;
  maxWaiting: number;
  /** Largest request body accepted. The API takes identifiers, not positions,
   *  so this is generous by an order of magnitude already. */
  maxBodyBytes: number;
  /** Per-user compute budget: cost units per window. */
  budgetPerWindow: number;
  budgetWindowMs: number;
  /** Concurrent analysis jobs one user may hold. */
  maxAnalysisPerUser: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
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

  // Leave a core for the event loop, so cancellations and health checks stay
  // answerable while every other core is inside a search.
  const defaultConcurrency = Math.max(1, availableParallelism() - 1);

  return {
    port: integer(env, "PORT", 8787),
    enginePath: env.ENGINE_BINARY_PATH?.trim() || "/usr/local/bin/amath_cli",
    supabaseUrl: required(env, "SUPABASE_URL"),
    supabasePublishableKey: required(env, "SUPABASE_PUBLISHABLE_KEY"),
    allowedOrigins: origins,
    concurrency: integer(env, "ENGINE_CONCURRENCY", defaultConcurrency),
    maxWaiting: integer(env, "ENGINE_MAX_WAITING", 64),
    maxBodyBytes: integer(env, "ENGINE_MAX_BODY_BYTES", 8 * 1024),
    budgetPerWindow: integer(env, "ENGINE_BUDGET_PER_WINDOW", 60),
    budgetWindowMs: integer(env, "ENGINE_BUDGET_WINDOW_MS", 10 * 60 * 1000),
    maxAnalysisPerUser: integer(env, "ENGINE_MAX_ANALYSIS_PER_USER", 1),
  };
}
