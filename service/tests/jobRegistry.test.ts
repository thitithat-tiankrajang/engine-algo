// The registry's whole reason to exist is that PAGE LIFETIME ≠ JOB LIFETIME.
// These tests pin the two halves of that: what a disconnect must NOT do (cancel),
// and what is actually allowed to stop a job (explicit cancel, a superseded
// position). They also cover the bounded result cache — reuse, the bot/analysis
// TTL split, LRU eviction, and the rule that a failure is never remembered as a
// result.
//
// The queue is real; the "engine" is a controllable stand-in so a run can be
// held open, cancelled, or made to fail on command without a real search.
import { describe, expect, it } from "vitest";

import { EngineCancelledError, type EngineResponse } from "../src/engineRunner.js";
import { JobRegistry, type JobRun, type JobSpec } from "../src/jobRegistry.js";
import { EngineQueue } from "../src/queue.js";
import { fakeEngineResponse } from "./helpers.js";

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A run the test drives by hand: it resolves when `open()` is called, and
 *  rejects as a cancellation the moment its signal aborts. `runs` counts how
 *  many times the registry actually invoked it. */
function controllableRun(result: EngineResponse = fakeEngineResponse()) {
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const counter = { runs: 0 };
  const run: JobRun = async ({ signal }) => {
    counter.runs += 1;
    if (signal.aborted) throw new EngineCancelledError();
    await Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new EngineCancelledError()), { once: true });
      }),
    ]);
    return result;
  };
  return { run, open: resolveGate, counter };
}

function makeRegistry(
  overrides: Partial<ConstructorParameters<typeof JobRegistry>[1]> = {},
  queue = new EngineQueue({ concurrency: 4, maxWaiting: 16 }),
) {
  return new JobRegistry(queue, {
    analysisResultTtlMs: 5 * 60 * 1000,
    botResultTtlMs: 60 * 1000,
    maxCached: 256,
    ...overrides,
  });
}

function spec(overrides: Partial<JobSpec> & Pick<JobSpec, "key" | "run">): JobSpec {
  return {
    priority: 0,
    kind: "analysis",
    gameId: "game-1",
    admittedRevision: 7,
    ...overrides,
  };
}

describe("disconnect is not cancellation", () => {
  it("keeps a running job alive after its observer detaches", async () => {
    const registry = makeRegistry();
    const engine = controllableRun();
    const attachment = registry.submit(spec({ key: "analysis:game-1:7:deep", run: engine.run }));
    await tick();

    // The only observer goes away.
    attachment.detach();
    await tick();

    // The run keeps going and finishes on its own terms.
    engine.open();
    await expect(attachment.promise).resolves.toMatchObject({ type: "place" });
    expect(engine.counter.runs).toBe(1);
  });

  it("lets a returning caller re-attach to the same run, not a second one", async () => {
    const registry = makeRegistry();
    const engine = controllableRun();
    const first = registry.submit(spec({ key: "analysis:game-1:7:deep", run: engine.run }));
    await tick();
    first.detach();

    // A different caller (a returning tab) attaches to the SAME in-flight job.
    const second = registry.attach("analysis:game-1:7:deep");
    expect(second).not.toBeNull();

    engine.open();
    await expect(second!.promise).resolves.toMatchObject({ type: "place" });
    // One search served both callers.
    expect(engine.counter.runs).toBe(1);
  });

  it("returns null when there is no job to attach to", () => {
    const registry = makeRegistry();
    expect(registry.attach("analysis:game-1:7:deep")).toBeNull();
    expect(registry.inspect("analysis:game-1:7:deep")).toBeNull();
  });
});

describe("deliberate cancellation", () => {
  it("stops a job on an explicit cancel", async () => {
    const registry = makeRegistry();
    const engine = controllableRun();
    const attachment = registry.submit(spec({ key: "analysis:game-1:7:deep", run: engine.run }));
    await tick();

    expect(registry.cancel("analysis:game-1:7:deep")).toBe(true);
    await expect(attachment.promise).rejects.toBeInstanceOf(EngineCancelledError);
  });

  it("retires a superseded job when a newer revision for the same game arrives", async () => {
    const registry = makeRegistry();
    const stale = controllableRun();
    const staleJob = registry.submit(
      spec({ key: "bot:game-1:7:hard", kind: "bot", admittedRevision: 7, run: stale.run }),
    );
    await tick();

    // The game moved on and a new bot turn is admitted at revision 8.
    const fresh = controllableRun();
    const freshJob = registry.submit(
      spec({ key: "bot:game-1:8:hard", kind: "bot", admittedRevision: 8, run: fresh.run }),
    );
    await tick();

    // The revision-7 answer is about a board that no longer exists; it is dropped.
    await expect(staleJob.promise).rejects.toBeInstanceOf(EngineCancelledError);

    // The revision-8 job is untouched and finishes normally.
    fresh.open();
    await expect(freshJob.promise).resolves.toMatchObject({ type: "place" });
  });

  it("does not retire a job at the same or a higher revision", async () => {
    const registry = makeRegistry();
    const keep = controllableRun();
    const keepJob = registry.submit(
      spec({ key: "analysis:game-1:8:deep", admittedRevision: 8, run: keep.run }),
    );
    await tick();

    // A different level at the SAME revision is a distinct, still-valid question.
    const other = controllableRun();
    registry.submit(spec({ key: "analysis:game-1:8:quick", admittedRevision: 8, run: other.run }));
    await tick();

    keep.open();
    await expect(keepJob.promise).resolves.toMatchObject({ type: "place" });
  });
});

describe("result cache", () => {
  it("serves a completed analysis without re-running the search", async () => {
    const registry = makeRegistry();
    const engine = controllableRun();
    const first = registry.submit(spec({ key: "analysis:game-1:7:deep", run: engine.run }));
    engine.open();
    await first.promise;

    const again = registry.submit(spec({ key: "analysis:game-1:7:deep", run: engine.run }));
    await expect(again.promise).resolves.toMatchObject({ type: "place" });
    // The cache answered; the run was never invoked a second time.
    expect(engine.counter.runs).toBe(1);
    expect(registry.inspect("analysis:game-1:7:deep")).toMatchObject({ status: "completed" });
  });

  it("pins one bot move per turn, but a new revision computes afresh", async () => {
    const registry = makeRegistry();
    const turn7 = controllableRun(fakeEngineResponse({ score: 24 }));
    const first = registry.submit(
      spec({ key: "bot:game-1:7:hard", kind: "bot", admittedRevision: 7, run: turn7.run }),
    );
    turn7.open();
    await first.promise;

    // Same turn (same key) → the identical move, no new search: this is what
    // makes a reconnect within a turn return the move already being committed.
    const reconnect = registry.submit(
      spec({ key: "bot:game-1:7:hard", kind: "bot", admittedRevision: 7, run: turn7.run }),
    );
    await reconnect.promise;
    expect(turn7.counter.runs).toBe(1);

    // A different turn (different key) is a different question → a fresh search.
    const turn8 = controllableRun();
    const next = registry.submit(
      spec({ key: "bot:game-1:8:hard", kind: "bot", admittedRevision: 8, run: turn8.run }),
    );
    turn8.open();
    await next.promise;
    expect(turn8.counter.runs).toBe(1);
  });

  it("never remembers a failure as a result", async () => {
    const registry = makeRegistry();
    let attempts = 0;
    const failingRun: JobRun = async () => {
      attempts += 1;
      throw new Error("engine blew up");
    };
    await expect(
      registry.submit(spec({ key: "analysis:game-1:7:deep", run: failingRun })).promise,
    ).rejects.toThrow("engine blew up");

    // A retry re-runs; the failure was not cached as though it were an answer.
    await expect(
      registry.submit(spec({ key: "analysis:game-1:7:deep", run: failingRun })).promise,
    ).rejects.toThrow("engine blew up");
    expect(attempts).toBe(2);
    expect(registry.inspect("analysis:game-1:7:deep")).toBeNull();
  });

  it("expires a cached result after its TTL", async () => {
    const registry = makeRegistry({ analysisResultTtlMs: 20 });
    const engine = controllableRun();
    const job = registry.submit(spec({ key: "analysis:game-1:7:deep", run: engine.run }));
    engine.open();
    await job.promise;
    expect(registry.inspect("analysis:game-1:7:deep")).toMatchObject({ status: "completed" });

    await tick(40);
    expect(registry.inspect("analysis:game-1:7:deep")).toBeNull();
    expect(registry.attach("analysis:game-1:7:deep")).toBeNull();
  });

  it("evicts the least-recently-used result past the bound", async () => {
    const registry = makeRegistry({ maxCached: 2 });
    for (const rev of [1, 2, 3]) {
      const engine = controllableRun();
      const job = registry.submit(
        spec({ key: `analysis:game-1:${rev}:deep`, admittedRevision: rev, run: engine.run }),
      );
      engine.open();
      await job.promise;
    }
    expect(registry.stats().cached).toBe(2);
    // The oldest is gone; the two most recent remain.
    expect(registry.inspect("analysis:game-1:1:deep")).toBeNull();
    expect(registry.inspect("analysis:game-1:2:deep")).toMatchObject({ status: "completed" });
    expect(registry.inspect("analysis:game-1:3:deep")).toMatchObject({ status: "completed" });
  });
});
