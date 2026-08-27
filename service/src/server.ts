// Process entry point: build the dependencies, start listening, shut down
// without cutting a search off mid-flight when the platform asks us to stop.
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JobRegistry } from "./jobRegistry.js";
import { EngineQueue } from "./queue.js";
import { ComputeBudget, ConcurrencyLimit } from "./rateLimit.js";
import { createSupabaseSource } from "./roomContext.js";

const config = loadConfig();

const queue = new EngineQueue({
  concurrency: config.concurrency,
  maxWaiting: config.maxWaiting,
  maxWaitMs: config.maxQueueWaitMs,
});
// Owns engine jobs independently of the request that triggered them: a bot turn
// or an analysis keeps running when the player navigates away, and a returning
// player re-attaches to it or reads its cached result instead of paying twice.
const registry = new JobRegistry(queue, {
  analysisResultTtlMs: config.analysisResultTtlMs,
  botResultTtlMs: config.botResultTtlMs,
  maxCached: config.jobCacheMax,
});
const budget = new ComputeBudget({
  perWindow: config.budgetPerWindow,
  windowMs: config.budgetWindowMs,
  enforced: config.budgetEnforced,
});
const analysisSlots = new ConcurrencyLimit(config.maxAnalysisPerUser);

// Expired rate-limit windows are dropped periodically so an instance that has
// seen many users does not hold a map entry for each of them forever.
const sweeper = setInterval(() => budget.sweep(), Math.min(config.budgetWindowMs, 60_000));
sweeper.unref();

// Cached engine results past their TTL are dropped on the same cadence, so an
// instance that has served many positions does not hold every result forever.
const cacheSweeper = setInterval(() => registry.sweep(), 60_000);
cacheSweeper.unref();

const app = createApp({
  config,
  source: createSupabaseSource(config.supabaseUrl, config.supabasePublishableKey),
  queue,
  registry,
  budget,
  analysisSlots,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  // The CPU line is printed every boot on purpose. Deriving concurrency from a
  // host core count the container is not allowed to use is the failure mode
  // that looks like "the engine got slower" rather than like a misconfiguration,
  // so the evidence goes where an operator will actually see it.
  console.log(
    `amath engine service listening on ${info.port} (engine=${config.enginePath})`,
  );
  console.log(
    `cpu: ${config.cpu.cpus.toFixed(2)} effective via ${config.cpu.source} ` +
      `(affinity reports ${config.cpu.parallelism}); ` +
      `concurrency=${config.concurrency} (${config.concurrencySource}), ` +
      `maxWaiting=${config.maxWaiting}, maxQueueWait=${config.maxQueueWaitMs}ms`,
  );
  console.log(
    config.budgetEnforced
      ? `budget: ${config.budgetPerWindow} units per ${Math.round(config.budgetWindowMs / 1000)}s per user`
      : "budget: OFF — no per-user compute metering (ENGINE_BUDGET_ENFORCED=false)",
  );
  if (!config.budgetEnforced) {
    // Said loudly and every boot. A shared deployment running without metering
    // is one account away from owning the queue, and the failure looks like
    // "the engine got slow" rather than like a setting.
    console.warn(
      "Per-user compute metering is disabled. That is right for a single-user machine and " +
        "wrong for anything shared: one caller can hold the queue indefinitely.",
    );
  }
  if (config.concurrencySource === "derived" && config.cpu.source === "parallelism") {
    console.warn(
      "No cgroup CPU quota was readable, so concurrency was derived from the affinity mask. " +
        "Under a container CPU limit that number can be far too high — set ENGINE_CONCURRENCY explicitly.",
    );
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received; refusing new work and finishing in-flight searches.`);
    server.close(() => process.exit(0));
    // A `max` search can legitimately still be running. Give it a bounded
    // window rather than killing a move a player is waiting on.
    setTimeout(() => process.exit(0), 30_000).unref();
  });
}
