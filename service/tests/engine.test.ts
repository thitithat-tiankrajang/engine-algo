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

import { toEngineRequest } from "../src/adapter.js";
import { buildAnalysis } from "../src/analysis.js";
import { parseCanonical, rackTokens } from "../src/canonical.js";
import { EngineTimeoutError, runEngine } from "../src/engineRunner.js";
import { ANALYSIS_LEVEL_CONFIG } from "../src/levels.js";
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
});
