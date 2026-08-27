// Tests that run the REAL compiled engine.
//
// Everything else in this suite stubs the engine to assert policy quickly. This
// file exists to prove the other half: that the policy is applied to an actual
// C++ search, that the adapter builds a request the engine accepts, and that
// what comes back is a legal move in the position we asked about.
//
// Skipped with a clear message when the binary has not been built, so a
// checkout without a compiler still runs the rest of the suite.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { toEngineRequest, toStudyEngineRequest } from "../src/adapter.js";
import { buildAnalysis } from "../src/analysis.js";
import { parseCanonical, rackTokens } from "../src/canonical.js";
import { EngineTimeoutError, runEngine } from "../src/engineRunner.js";
import { ANALYSIS_LEVEL_CONFIG, BOT_TIER_CONFIG } from "../src/levels.js";
import { EngineQueue } from "../src/queue.js";
import { parseStudyPosition } from "../src/study.js";
import { buildCanonicalPayload } from "./helpers.js";

const ENGINE = fileURLToPath(new URL("../../build/amath_cli", import.meta.url));
const available = existsSync(ENGINE);
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(`[skip] engine binary not built at ${ENGINE}. Run \`make cli\` in amath-engine.`);
}

/** A midgame position: a scoring row on the board and a workable rack. */
function position(revision = 7) {
  return buildCanonicalPayload({
    revision,
    activeSide: "A",
    rackA: ["1", "2", "3", "+", "=", "5", "9", "?"],
    rackB: ["4", "6", "7", "8", "=", "+", "1", "2"],
    board: [
      { token: "2", row: 7, col: 6, by: "B" },
      { token: "+", row: 7, col: 7, by: "B" },
      { token: "3", row: 7, col: 8, by: "B" },
      { token: "=", row: 7, col: 9, by: "B" },
      { token: "5", row: 7, col: 10, by: "B" },
    ],
  });
}

suite("the real engine", () => {
  it("accepts what the adapter builds and returns a move", async () => {
    const state = parseCanonical(position());
    const request = toEngineRequest(state, {
      side: "A",
      difficulty: "analysis",
      sampleCap: 1,
      topN: 8,
      budgetMs: 20_000,
      events: [{ kind: "place" }],
    });

    const response = await runEngine({
      binaryPath: ENGINE,
      request,
      timeoutMs: 90_000,
    });

    expect(["place", "exchange", "pass"]).toContain(response.type);
    expect(response.candidates?.length).toBeGreaterThan(0);
  }, 120_000);

  it("runs the static solver in one generation, and plays the same move every time", async () => {
    // No shipped tier uses this path any more — the 200 ms `easy` tier it was
    // built for is retired — but the engine still offers it and the CLI's
    // gauntlets still measure against it, so its contract stays under test:
    // one root generation, no sampling, and a move that does not depend on the
    // seed.
    const state = parseCanonical(position());

    const build = (salt: string) =>
      toEngineRequest(state, {
        side: "A",
        difficulty: "static",
        solver: "static",
        budgetMs: 200,
        events: [],
        seedSalt: salt,
      });

    const first = await runEngine({ binaryPath: ENGINE, request: build(""), timeoutMs: 30_000 });
    expect(["place", "exchange", "pass"]).toContain(first.type);
    // One root generation. This is the bound the path is sold on, checked
    // through the real service path rather than only in the C++ test.
    expect(first.stats.genCalls).toBe(1);
    expect(first.stats.samples).toBe(0);

    // Seed-invariant. Production seeds are seedFor(gameId, revision), so the
    // interesting question is not "does the same request repeat" but "would a
    // different game id have played something else". Under the old path it
    // would have: six seeds produced ~4.6 distinct moves.
    const identity = (r: typeof first) =>
      JSON.stringify([r.type, r.placements, r.exchange, r.score]);
    for (const salt of ["a", "b", "zzz"]) {
      const again = await runEngine({
        binaryPath: ENGINE,
        request: build(salt),
        timeoutMs: 30_000,
      });
      expect(identity(again)).toBe(identity(first));
    }
  }, 120_000);

  it("runs the super tier until the schedule is finished, not until a clock says stop", async () => {
    const state = parseCanonical(position());
    const tier = BOT_TIER_CONFIG.super;
    expect(tier.unlimited).toBe(true);
    expect(tier.budgetMs).toBeNull();

    // The tier's real schedule is 160 samples and takes minutes on an open
    // board. `sampleCap` shortens the SCHEDULE without putting a clock back on
    // the search, which is exactly the distinction under test.
    const build = (bound: { unlimited?: boolean; budgetMs?: number }) =>
      toEngineRequest(state, {
        side: "A",
        difficulty: "super",
        solver: tier.solver,
        sampleCap: 6,
        topN: 8,
        events: [],
        ...bound,
      });

    const unlimited = await runEngine({
      binaryPath: ENGINE,
      request: build({ unlimited: true }),
      timeoutMs: 180_000,
    });
    expect(["place", "exchange", "pass"]).toContain(unlimited.type);
    // Every planned sample, not "as many as fitted".
    expect(unlimited.stats.samples).toBe(6);

    // The same schedule under a deadline stops at the sampler's floor of three
    // complete samples. This is the behaviour `super` exists to remove, and
    // asserting it here is what keeps the tier from quietly becoming `max`.
    const deadlined = await runEngine({
      binaryPath: ENGINE,
      request: build({ budgetMs: 1 }),
      timeoutMs: 180_000,
    });
    expect(deadlined.stats.samples).toBeLessThan(unlimited.stats.samples);
  }, 400_000);

  it("accepts a study position built from raw input, not from a room", async () => {
    // The study path builds its request from a position the caller typed rather
    // than from stored state, so the seam most likely to break is whether the
    // engine accepts what that builder produces at all.
    const position = parseStudyPosition({
      scoreSelf: 40,
      scoreOpponent: 55,
      board: [
        { r: 7, c: 6, kind: "2", token: "2" },
        { r: 7, c: 7, kind: "+", token: "+" },
        { r: 7, c: 8, kind: "3", token: "3" },
        { r: 7, c: 9, kind: "=", token: "=" },
        { r: 7, c: 10, kind: "5", token: "5" },
      ],
      rack: ["1", "2", "3", "+", "=", "5", "9"],
    });

    const request = toStudyEngineRequest(position, {
      difficulty: "medium",
      solver: "sim",
      budgetMs: 1_000,
      topN: 12,
    });
    const response = await runEngine({ binaryPath: ENGINE, request, timeoutMs: 60_000 });

    expect(["place", "exchange", "pass"]).toContain(response.type);
    expect((response.candidates ?? []).length).toBeGreaterThan(0);
    // The rack it reasoned about is the one that was typed: nothing else was
    // available to it.
    for (const placement of response.placements) {
      expect(position.rack).toContain(placement.kind);
    }
  }, 120_000);

  it("only ever plays tiles that are on the analysed rack", async () => {
    // The legality property that matters most: a recommendation the player
    // cannot physically make is worse than no recommendation.
    const state = parseCanonical(position());
    const rack = rackTokens(state, "A");
    const request = toEngineRequest(state, {
      side: "A",
      difficulty: "analysis",
      sampleCap: 1,
      topN: 16,
      budgetMs: 20_000,
      events: [],
    });

    const response = await runEngine({ binaryPath: ENGINE, request, timeoutMs: 90_000 });

    for (const candidate of response.candidates ?? []) {
      const remaining = [...rack];
      const used = [
        ...candidate.placements.map((placement) => placement.kind),
        ...candidate.exchange,
      ];
      for (const kind of used) {
        const index = remaining.indexOf(kind as (typeof remaining)[number]);
        expect(
          index,
          `candidate uses "${kind}" which is not (or no longer) on the rack`,
        ).toBeGreaterThanOrEqual(0);
        remaining.splice(index, 1);
      }
    }
  }, 120_000);

  it("never names a tile the opponent holds", async () => {
    // Structural, not filtered: the opponent reached the engine as a count, so
    // there is no path by which their tiles could appear in the output.
    const state = parseCanonical(position());
    const request = toEngineRequest(state, {
      side: "A",
      difficulty: "analysis",
      sampleCap: 1,
      topN: 16,
      budgetMs: 20_000,
      events: [],
    });
    expect(request).not.toHaveProperty("oppRack");
    expect(JSON.stringify(request)).not.toContain("rackB");

    const response = await runEngine({ binaryPath: ENGINE, request, timeoutMs: 90_000 });
    const analysis = buildAnalysis({
      response,
      level: "quick",
      gameId: state.gameId,
      revision: state.revision,
      turnNumber: state.turnNumber,
      side: "A",
      requestedSamples: 1,
    });
    const serialized = JSON.stringify(analysis);
    expect(serialized).not.toContain("inventory");
    expect(serialized).not.toContain("oppRackCount");
  }, 120_000);

  it("produces the same result twice for the same position, seed and level", async () => {
    // Reproducibility is what lets an analysis be re-shown without its advice
    // quietly changing. Bounding by sample count rather than wall clock is the
    // mechanism; this is the check that the mechanism holds.
    const state = parseCanonical(position());
    const level = ANALYSIS_LEVEL_CONFIG.quick;
    const request = toEngineRequest(state, {
      side: "A",
      difficulty: "analysis",
      sampleCap: level.sampleCap,
      topN: level.topN,
      budgetMs: level.timeoutMs,
      events: [],
      seedSalt: "analysis:quick",
    });

    const [first, second] = await Promise.all([
      runEngine({ binaryPath: ENGINE, request, timeoutMs: 200_000 }),
      runEngine({ binaryPath: ENGINE, request, timeoutMs: 200_000 }),
    ]);

    expect(second.type).toBe(first.type);
    expect(second.score).toBe(first.score);
    expect(second.placements).toEqual(first.placements);
    expect(second.candidates?.map((candidate) => candidate.value)).toEqual(
      first.candidates?.map((candidate) => candidate.value),
    );
  }, 240_000);

  it("recommends exactly the move the engine chose", async () => {
    const state = parseCanonical(position());
    const request = toEngineRequest(state, {
      side: "A",
      difficulty: "analysis",
      sampleCap: 2,
      topN: 12,
      budgetMs: 60_000,
      events: [],
    });
    const response = await runEngine({ binaryPath: ENGINE, request, timeoutMs: 120_000 });
    const analysis = buildAnalysis({
      response,
      level: "quick",
      gameId: state.gameId,
      revision: state.revision,
      turnNumber: state.turnNumber,
      side: "A",
      requestedSamples: 2,
    });

    expect(analysis.recommendation.kind).toBe(response.type);
    if (response.type === "place") {
      expect(analysis.recommendation.placements).toEqual(response.placements);
      expect(analysis.recommendation.immediateScore).toBe(response.score);
    }
    // And no alternative outranks it on the engine's own key.
    for (const alternative of analysis.alternatives) {
      expect(alternative.evaluation).toBeLessThanOrEqual(analysis.recommendation.evaluation);
    }
  }, 150_000);

  it("kills a search that overruns its wall-clock ceiling", async () => {
    // `budgetMs` is the engine's own advice to itself. The service's timeout is
    // the guarantee: here the engine is told to think for far longer than it is
    // allowed to, and the process must be stopped from outside.
    const state = parseCanonical(position());
    const request = toEngineRequest(state, {
      side: "A",
      difficulty: "max",
      budgetMs: 300_000,
      events: [],
    });

    await expect(
      runEngine({ binaryPath: ENGINE, request, timeoutMs: 1_500 }),
    ).rejects.toBeInstanceOf(EngineTimeoutError);
  }, 60_000);

  it("reports a missing engine as a failure rather than hanging", async () => {
    await expect(
      runEngine({
        binaryPath: "/nonexistent/amath_cli",
        request: { board: [], rack: [] },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  }, 20_000);

  // ── the queue against real processes ───────────────────────────────────────
  //
  // The unit tests in queue.test.ts prove the SCHEDULING with stand-ins. These
  // prove the thing that actually matters on a 1-CPU box: that what gets
  // serialised is real `amath_cli` processes, not just promises.

  /** A cheap but genuine search. */
  const smallRequest = (revision: number) =>
    toEngineRequest(parseCanonical(position(revision)), {
      side: "A",
      difficulty: "analysis",
      sampleCap: 1,
      topN: 4,
      budgetMs: 2_000,
      events: [{ kind: "place" }],
    });

  it("runs one engine process at a time at concurrency 1", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 8 });
    const spans: Array<{ start: number; end: number }> = [];

    await Promise.all(
      [0, 1, 2].map((index) =>
        queue.submit({
          key: `serial-${index}`,
          priority: 0,
          run: async (signal) => {
            const start = Date.now();
            await runEngine({
              binaryPath: ENGINE,
              request: smallRequest(7 + index),
              timeoutMs: 60_000,
              signal,
            });
            spans.push({ start, end: Date.now() });
          },
        }),
      ),
    );

    expect(spans).toHaveLength(3);
    spans.sort((first, second) => first.start - second.start);
    // No two searches were alive at the same moment. Three processes sharing
    // one CPU is the failure this whole design exists to prevent, and it is
    // observable here as overlapping wall-clock spans.
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.start).toBeGreaterThanOrEqual(spans[index - 1]!.end - 20);
    }
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0 });
  }, 180_000);

  it("never exceeds its limit at concurrency 2", async () => {
    const queue = new EngineQueue({ concurrency: 2, maxWaiting: 8 });
    let live = 0;
    let peak = 0;

    await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        queue.submit({
          key: `pool-${index}`,
          priority: 0,
          run: async (signal) => {
            live += 1;
            peak = Math.max(peak, live);
            try {
              await runEngine({
                binaryPath: ENGINE,
                request: smallRequest(7 + index),
                timeoutMs: 60_000,
                signal,
              });
            } finally {
              live -= 1;
            }
          },
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(queue.stats().running).toBe(0);
  }, 240_000);

  it("kills a real engine process on cancellation and gives the slot back", async () => {
    // Cancellation has to free actual CPU, not just stop a caller waiting. The
    // proof is that the next job runs at all: at concurrency 1 it cannot start
    // until the previous process is gone.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    const controller = new AbortController();

    const cancelled = queue.submit(
      {
        key: "long-search",
        priority: 0,
        run: (signal) =>
          runEngine({
            binaryPath: ENGINE,
            request: toEngineRequest(parseCanonical(position()), {
              side: "A",
              difficulty: "max",
              budgetMs: 120_000,
              events: [],
            }),
            timeoutMs: 300_000,
            signal,
          }),
      },
      controller.signal,
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(queue.stats().running).toBe(1);
    controller.abort();
    await expect(cancelled).rejects.toThrow();

    const started = Date.now();
    await queue.submit({
      key: "follows-on",
      priority: 0,
      run: (signal) =>
        runEngine({
          binaryPath: ENGINE,
          request: smallRequest(9),
          timeoutMs: 60_000,
          signal,
        }),
    });
    // Well under the 120s the cancelled search was told to take: the process
    // really was killed rather than left to finish.
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0 });
  }, 180_000);

  it("gives the slot back when a real engine run times out", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    await expect(
      queue.submit({
        key: "overruns",
        priority: 0,
        run: (signal) =>
          runEngine({
            binaryPath: ENGINE,
            request: toEngineRequest(parseCanonical(position()), {
              side: "A",
              difficulty: "max",
              budgetMs: 300_000,
              events: [],
            }),
            timeoutMs: 1_500,
            signal,
          }),
      }),
    ).rejects.toBeInstanceOf(EngineTimeoutError);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.stats().running).toBe(0);
    await expect(
      queue.submit({
        key: "after-timeout",
        priority: 0,
        run: (signal) =>
          runEngine({ binaryPath: ENGINE, request: smallRequest(11), timeoutMs: 60_000, signal }),
      }),
    ).resolves.toBeTruthy();
  }, 180_000);

  it("gives the slot back when a real engine process fails to start", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4 });
    await expect(
      queue.submit({
        key: "no-binary",
        priority: 0,
        run: (signal) =>
          runEngine({
            binaryPath: "/nonexistent/amath_cli",
            request: smallRequest(7),
            timeoutMs: 5_000,
            signal,
          }),
      }),
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0 });
  }, 60_000);
});
