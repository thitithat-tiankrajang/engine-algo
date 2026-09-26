import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { JobRegistry } from "../src/jobRegistry.js";
import { EngineQueue } from "../src/queue.js";
import { ComputeBudget, ConcurrencyLimit } from "../src/rateLimit.js";
import { baseConfig, fakeSource } from "./helpers.js";

function appWithAccessLog() {
  const config = { ...baseConfig(), accessLog: true } as ReturnType<typeof baseConfig> &
    Parameters<typeof createApp>[0]["config"];
  const queue = new EngineQueue({
    concurrency: config.concurrency,
    maxWaiting: config.maxWaiting,
    maxWaitMs: config.maxQueueWaitMs,
  });
  return createApp({
    config,
    source: fakeSource(),
    queue,
    registry: new JobRegistry(queue, {
      analysisResultTtlMs: config.analysisResultTtlMs,
      botResultTtlMs: config.botResultTtlMs,
      maxCached: config.jobCacheMax,
    }),
    budget: new ComputeBudget({
      perWindow: config.budgetPerWindow,
      windowMs: config.budgetWindowMs,
      enforced: config.budgetEnforced,
    }),
    analysisSlots: new ConcurrencyLimit(config.maxAnalysisPerUser),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("access log", () => {
  it("logs one JSON line per request with an id the response also carries, and no token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await appWithAccessLog().request("/v1/games/g-1/bot-move", {
      method: "POST",
      headers: { Authorization: "Bearer secret-token-value", "Content-Type": "application/json" },
      body: "{}",
    });

    const id = response.headers.get("X-Request-Id");
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"access"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      t: "access",
      id,
      method: "POST",
      path: "/v1/games/g-1/bot-move",
      status: response.status,
    });
    expect(lines[0]).not.toContain("secret-token-value");
  });

  it("keeps a well-formed incoming request id and leaves health probes out", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = appWithAccessLog();
    const response = await app.request("/v1/games/g-1/jobs?revision=1", {
      headers: { "X-Request-Id": "edge-1234abcd" },
    });
    expect(response.headers.get("X-Request-Id")).toBe("edge-1234abcd");
    await app.request("/health");
    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"access"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("edge-1234abcd");
  });
});
