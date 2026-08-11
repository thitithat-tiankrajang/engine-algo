// Process entry point: build the dependencies, start listening, shut down
// without cutting a search off mid-flight when the platform asks us to stop.
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EngineQueue } from "./queue.js";
import { ComputeBudget, ConcurrencyLimit } from "./rateLimit.js";
import { createSupabaseSource } from "./roomContext.js";

const config = loadConfig();

const queue = new EngineQueue({
  concurrency: config.concurrency,
  maxWaiting: config.maxWaiting,
});
const budget = new ComputeBudget({
  perWindow: config.budgetPerWindow,
  windowMs: config.budgetWindowMs,
});
const analysisSlots = new ConcurrencyLimit(config.maxAnalysisPerUser);

// Expired rate-limit windows are dropped periodically so an instance that has
// seen many users does not hold a map entry for each of them forever.
const sweeper = setInterval(() => budget.sweep(), Math.min(config.budgetWindowMs, 60_000));
sweeper.unref();

const app = createApp({
  config,
  source: createSupabaseSource(config.supabaseUrl, config.supabasePublishableKey),
  queue,
  budget,
  analysisSlots,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `amath engine service listening on ${info.port} ` +
      `(engine=${config.enginePath}, concurrency=${config.concurrency})`,
  );
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
