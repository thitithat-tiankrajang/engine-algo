// End-to-end tests of the HTTP surface: authorization, turn rules, staleness,
// metering, and the failure modes the client has to handle.
//
// The engine is stubbed here so these run in milliseconds and assert POLICY.
// That the policy is applied to a REAL search is covered in engine.test.ts.
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { EngineCancelledError, EngineFailureError, EngineTimeoutError } from "../src/engineRunner.js";
import { BOT_TIER_CONFIG } from "../src/levels.js";
import { EngineQueue } from "../src/queue.js";
import { JobRegistry } from "../src/jobRegistry.js";
import { ComputeBudget, ConcurrencyLimit } from "../src/rateLimit.js";
import { RoomAccessError } from "../src/roomContext.js";
import {
  GAME_ID,
  baseConfig,
  fakeEngineResponse,
  fakeSource,
  fakeVerify,
  type FakeSourceOptions,
} from "./helpers.js";

type Overrides = {
  source?: FakeSourceOptions;
  config?: Record<string, unknown>;
  engine?: () => Promise<ReturnType<typeof fakeEngineResponse>>;
  /** Share one queue between harnesses, to model two users on one instance. */
  queue?: EngineQueue;
  /** Share one registry between harnesses, to model two CALLERS reaching the
   *  same jobs on one instance — which is what discovery has to get right. */
  registry?: JobRegistry;
};

function harness(overrides: Overrides = {}) {
  const config = baseConfig(overrides.config) as ReturnType<typeof baseConfig> &
    Parameters<typeof createApp>[0]["config"];
  const source = fakeSource(overrides.source);
  const queue =
    overrides.queue ??
    new EngineQueue({
      concurrency: config.concurrency,
      maxWaiting: config.maxWaiting,
      maxWaitMs: config.maxQueueWaitMs,
    });
  const registry =
    overrides.registry ??
    new JobRegistry(queue, {
      analysisResultTtlMs: config.analysisResultTtlMs,
      botResultTtlMs: config.botResultTtlMs,
      maxCached: config.jobCacheMax,
    });
  const budget = new ComputeBudget({
    perWindow: config.budgetPerWindow,
    windowMs: config.budgetWindowMs,
    // Read from the config so a harness cannot meter while its config says it
    // does not, or the reverse.
    enforced: config.budgetEnforced,
  });
  const analysisSlots = new ConcurrencyLimit(config.maxAnalysisPerUser);
  // Typed so `mock.calls[0][0].request` is checkable — several tests assert on
  // exactly what the adapter handed the engine.
  const runEngine = vi.fn<(options: { request: Record<string, unknown> }) => Promise<unknown>>(
    overrides.engine ?? (async () => fakeEngineResponse()),
  );

  const app = createApp({
    config,
    source,
    queue,
    registry,
    budget,
    analysisSlots,
    runEngine: runEngine as unknown as Parameters<typeof createApp>[0]["runEngine"],
    verifyToken: fakeVerify,
  });

  const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1/games/${GAME_ID}${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  return { app, call, runEngine, source, queue, registry, budget, analysisSlots };
}

/** A second caller on the SAME instance: same registry and queue, a different
 *  view of who they are. What discovery must never do is let this one learn
 *  about work the first one's authorization would not have shown them. */
function harnessSharing(base: ReturnType<typeof harness>, source: FakeSourceOptions) {
  return harness({ source, registry: base.registry, queue: base.queue });
}

describe("authentication", () => {
  it("refuses a request with no bearer token before doing any work", async () => {
    const { app, runEngine } = harness();
    const response = await app.request(`/v1/games/${GAME_ID}/analysis`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 7 }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
    expect(runEngine).not.toHaveBeenCalled();
  });
});

describe("room authorization", () => {
  it("reports a game it may not read as absent, confirming nothing", async () => {
    // The RPC is gated on can_read_live_game and returns zero rows either way,
    // so "forbidden" and "no such game" must be indistinguishable.
    const { call, runEngine } = harness({
      source: { failWith: new RoomAccessError("No such game, or it is not yours to read.", 404) },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(runEngine).not.toHaveBeenCalled();
  });

  it("refuses a spectator who does not control the turn", async () => {
    const { call, runEngine } = harness({
      source: { callerControlsActiveSide: false },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "analysis_not_allowed" });
    expect(runEngine).not.toHaveBeenCalled();
  });
});

describe("revision validation", () => {
  it("rejects an analysis composed against an older revision", async () => {
    const { call, runEngine } = harness({ source: { revision: 9 } });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "stale_revision",
      currentRevision: 9,
      requestedRevision: 7,
    });
    expect(runEngine).not.toHaveBeenCalled();
  });

  it("rejects a bot move composed against a revision the game has passed", async () => {
    const { call } = harness({
      source: { revision: 12, botSide: "B", botDifficulty: "medium", activeSide: "B" },
    });
    const response = await call("/bot-move", { expectedRevision: 11 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_revision", currentRevision: 12 });
  });

  it("requires an expected revision at all", async () => {
    const { call } = harness();
    const response = await call("/analysis", {});
    expect(response.status).toBe(400);
  });

  it("returns the revision it answered for, so a stale result is detectable", async () => {
    const { call } = harness({ source: { revision: 7 } });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 7 });
  });
});

describe("turn rules", () => {
  it("refuses a bot move when it is not the engine's turn", async () => {
    const { call, runEngine } = harness({
      source: { botSide: "B", botDifficulty: "medium", activeSide: "A" },
    });
    const response = await call("/bot-move", { expectedRevision: 7 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "turn_rule" });
    expect(runEngine).not.toHaveBeenCalled();
  });

  it("refuses a bot move in a room with no engine player", async () => {
    const { call } = harness({ source: { botSide: null } });
    const response = await call("/bot-move", { expectedRevision: 7 });
    expect(response.status).toBe(409);
  });

  it("refuses analysis during the bot's turn even for the room's owner", async () => {
    // The frontend hides the button here. This asserts the endpoint refuses
    // regardless, which is the property that actually matters.
    const { call, runEngine } = harness({
      source: {
        botSide: "B",
        botDifficulty: "hard",
        activeSide: "B",
        activeSideIsBot: true,
        callerControlsActiveSide: true,
      },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "analysis_not_allowed" });
    expect(runEngine).not.toHaveBeenCalled();
  });

  it("allows analysis on the human turn of a human-vs-AI room", async () => {
    const { call } = harness({
      source: {
        botSide: "B",
        botDifficulty: "hard",
        activeSide: "A",
        activeSideIsBot: false,
        callerControlsActiveSide: true,
      },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(200);
  });

  it("refuses to think about a finished game", async () => {
    const { call } = harness({
      source: {
        canonical: (await import("./helpers.js")).buildCanonicalPayload({ status: "finished" }),
      },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "turn_rule" });
  });
});

describe("hidden information", () => {
  it("never sends the opponent rack or the bag to the engine", async () => {
    const { call, runEngine } = harness({
      source: { activeSide: "A", callerControlsActiveSide: true },
    });
    await call("/analysis", { expectedRevision: 7 });

    const request = runEngine.mock.calls[0]?.[0]?.request as Record<string, unknown>;
    expect(request).toBeTruthy();
    // The opponent is a COUNT, and the bag is a COUNT. There is no field on the
    // wire that could carry a tile the requester may not see.
    expect(typeof request.oppRackCount).toBe("number");
    expect(typeof request.bagCount).toBe("number");
    expect(Object.keys(request)).not.toContain("oppRack");
    expect(Object.keys(request)).not.toContain("bag");
    expect(JSON.stringify(request)).not.toContain("rackB");
  });

  it("returns only the move from a bot request, never its reasoning", async () => {
    // The candidate report explains the BOT's rack. Handing it to the opponent
    // would name tiles they are not entitled to know.
    const { call } = harness({
      source: { botSide: "B", botDifficulty: "medium", activeSide: "B", activeSideIsBot: true },
    });
    const response = await call("/bot-move", { expectedRevision: 7 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("candidates");
    expect(JSON.stringify(body)).not.toContain("oppReply");
    expect(JSON.stringify(body)).not.toContain("leave");
    expect(body.move).toMatchObject({ type: "place" });
  });

  it("returns no canonical state, inventory or bag order to the client", async () => {
    const { call } = harness();
    const response = await call("/analysis", { expectedRevision: 7 });
    const text = await response.text();
    expect(text).not.toContain("inventory");
    expect(text).not.toContain("appliedCommands");
    expect(text).not.toContain("pendingReturn");
    expect(text).not.toContain("\"at\":\"bag\"");
  });
});

describe("analysis result", () => {
  it("marks exactly one candidate as recommended and ranks the rest behind it", async () => {
    const { call } = harness();
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      recommendation: { recommended: boolean; evaluationGap: number; evaluation: number };
      alternatives: Array<{ recommended: boolean; evaluationGap: number; evaluation: number }>;
    };
    expect(body.recommendation.recommended).toBe(true);
    expect(body.recommendation.evaluationGap).toBe(0);
    expect(body.alternatives.every((entry) => !entry.recommended)).toBe(true);
    for (const alternative of body.alternatives) {
      expect(alternative.evaluation).toBeLessThanOrEqual(body.recommendation.evaluation);
      expect(alternative.evaluationGap).toBeGreaterThanOrEqual(0);
    }
  });

  it("explains an alternative by what it LOSES on, not by a strength it happens to have", async () => {
    // The fixture's runner-up scores 6 more points but hands the opponent 10.3
    // more. Leading with the largest difference in either direction would
    // describe it purely by the extra points and then say it ranks behind,
    // which argues the wrong side and reads as a contradiction.
    const { call } = harness();
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      alternatives: Array<{ immediateScore: number; note: string }>;
    };
    const higherScoring = body.alternatives.find((entry) => entry.immediateScore === 30);
    expect(higherScoring).toBeTruthy();
    // The reason it is not the pick: it concedes more to the opponent.
    expect(higherScoring?.note).toMatch(/hands the opponent/i);
    // And its compensating strength is acknowledged, as the concession.
    expect(higherScoring?.note).toMatch(/though it scores 6 more now/i);
  });

  it("never claims an alternative is behind without naming a term", async () => {
    const { call } = harness();
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      alternatives: Array<{ note: string }>;
    };
    for (const alternative of body.alternatives) {
      expect(alternative.note.length).toBeGreaterThan(0);
      // Every note is either a named comparison or an explicit "too close to
      // separate" — never a bare verdict with no reason attached.
      expect(alternative.note).toMatch(
        /scores|rack|next turn|opponent|Close alternative|proven final margin/i,
      );
    }
  });

  it("recommends the move the engine itself chose, not a re-ranked one", async () => {
    // The highest immediate score here is the 30-point play, but the engine
    // chose the 24-point one. Analysis must agree with the engine, or it is
    // explaining a decision nobody made.
    const { call } = harness();
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      recommendation: { immediateScore: number };
      alternatives: Array<{ immediateScore: number }>;
    };
    expect(body.recommendation.immediateScore).toBe(24);
    expect(body.alternatives.some((entry) => entry.immediateScore === 30)).toBe(true);
  });

  it("grounds every reported factor in a number the engine produced", async () => {
    const { call } = harness();
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      recommendation: { factors: Array<{ key: string; value: number }> };
    };
    const byKey = Object.fromEntries(
      body.recommendation.factors.map((factor) => [factor.key, factor.value]),
    );
    expect(byKey.score).toBe(24);
    expect(byKey.leave).toBeCloseTo(8.5, 5);
    expect(byKey.potential).toBeCloseTo(6.2, 5);
    expect(byKey.oppReply).toBeCloseTo(12.1, 5);
    expect(byKey.risk).toBeCloseTo(3.2, 5);
  });

  it("omits the risk factor on the greedy path, which never sampled", async () => {
    const { call } = harness({
      engine: async () =>
        fakeEngineResponse({
          solver: "greedy",
          candidates: fakeEngineResponse().candidates?.map((candidate) => ({
            ...candidate,
            stddev: 0,
            potential: 0,
          })),
        }),
    });
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      recommendation: { factors: Array<{ key: string }> };
      method: { solver: string };
    };
    expect(body.method.solver).toBe("greedy");
    const keys = body.recommendation.factors.map((factor) => factor.key);
    expect(keys).not.toContain("risk");
    expect(keys).not.toContain("potential");
  });

  it("describes an endgame result as proven rather than estimated", async () => {
    const { call } = harness({
      engine: async () =>
        fakeEngineResponse({
          solver: "endgame",
          endgameSolved: true,
          candidates: [
            {
              type: "place",
              placements: [{ r: 7, c: 7, kind: "5", token: "5" }],
              exchange: [],
              score: 12,
              scoreComp: 12,
              leave: 0,
              potential: 0,
              oppReply: 0,
              mean: 18,
              stddev: 0,
              value: 18,
              chosen: true,
              proven: true,
            },
          ],
        }),
    });
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      recommendation: { provenMargin: number | null };
      method: { proven: boolean };
      summary: string;
    };
    expect(body.method.proven).toBe(true);
    expect(body.recommendation.provenMargin).toBe(18);
    expect(body.summary).toContain("solve exactly");
  });

  it("says so when the search was cut short instead of presenting it as settled", async () => {
    const { call } = harness({
      engine: async () =>
        fakeEngineResponse({
          stats: { moves: 10, nodes: 10, elapsedMs: 10, candidates: 3, samples: 2 },
        }),
    });
    const body = (await (await call("/analysis", { expectedRevision: 7 })).json()) as {
      method: { complete: boolean };
      summary: string;
    };
    // quick asks for 4 samples; only 2 came back.
    expect(body.method.complete).toBe(false);
    expect(body.summary).toContain("provisional");
  });

  it("reports unavailable rather than inventing advice when nothing was weighed", async () => {
    const { call } = harness({
      engine: async () => fakeEngineResponse({ candidates: [] }),
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "analysis_unavailable" });
  });
});

describe("analysis levels", () => {
  it("bounds work by sample count, so a level is reproducible", async () => {
    const { call, runEngine } = harness();
    await call("/analysis", { expectedRevision: 7, level: "deep" });
    const request = runEngine.mock.calls[0]?.[0]?.request as Record<string, unknown>;
    expect(request.sampleCap).toBe(40);
    expect(request.topN).toBe(16);
  });

  it("derives the same seed for the same position and level", async () => {
    const first = harness();
    await first.call("/analysis", { expectedRevision: 7, level: "normal" });
    const second = harness();
    await second.call("/analysis", { expectedRevision: 7, level: "normal" });
    const seedOf = (h: typeof first) =>
      (h.runEngine.mock.calls[0]?.[0]?.request as Record<string, unknown>).seed;
    expect(seedOf(first)).toBe(seedOf(second));
  });

  it("derives a different seed once the game advances", async () => {
    const first = harness({ source: { revision: 7 } });
    await first.call("/analysis", { expectedRevision: 7, level: "normal" });
    const second = harness({ source: { revision: 8 } });
    await second.call("/analysis", { expectedRevision: 8, level: "normal" });
    const seedOf = (h: typeof first) =>
      (h.runEngine.mock.calls[0]?.[0]?.request as Record<string, unknown>).seed;
    expect(seedOf(first)).not.toBe(seedOf(second));
  });

  it("falls back to the cheapest level when asked for one that does not exist", async () => {
    const { call, runEngine } = harness();
    await call("/analysis", { expectedRevision: 7, level: "ultra-max-please" });
    const request = runEngine.mock.calls[0]?.[0]?.request as Record<string, unknown>;
    expect(request.sampleCap).toBe(4);
  });
});

describe("engine failures", () => {
  it("reports a timeout as a timeout, not as a broken server", async () => {
    const { call } = harness({
      engine: async () => {
        throw new EngineTimeoutError(1000);
      },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "engine_timeout" });
  });

  it("does not leak engine internals when the process fails", async () => {
    const { call } = harness({
      engine: async () => {
        throw new EngineFailureError("engine exited with SIGSEGV", "/opt/amath/src/engine.cpp:812");
      },
    });
    const response = await call("/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("SIGSEGV");
    expect(text).not.toContain("engine.cpp");
  });

  it("refunds the compute budget when the engine fails", async () => {
    const { call, budget } = harness({
      config: { analysisBudgeted: true },
      engine: async () => {
        throw new EngineFailureError("boom");
      },
    });
    await call("/analysis", { expectedRevision: 7, level: "deep" });
    // deep costs 10; a failed run must not be charged for.
    const decision = budget.charge("user-1", 60);
    expect(decision.allowed).toBe(true);
  });
});

describe("compute protection", () => {
  it("refuses a body larger than the limit", async () => {
    const { app } = harness({ config: { maxBodyBytes: 64 } });
    const response = await app.request(`/v1/games/${GAME_ID}/analysis`, {
      method: "POST",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, padding: "x".repeat(500) }),
    });
    expect(response.status).toBe(413);
  });

  it("never runs an account out of analyses, however expensive the level", async () => {
    // Four DISTINCT `max` analyses, one after another — none of them the cache
    // hit that would be free under any policy. At 30 cost units each, a budget
    // of 60 would have refused the third. There is no budget on analysis: a
    // player who waits their turn is never told they have had enough.
    const { call, source, runEngine, budget, analysisSlots } = harness();
    for (let revision = 7; revision < 11; revision += 1) {
      source.advanceTo(revision);
      const response = await call("/analysis", { expectedRevision: revision, level: "max" });
      expect(response.status).toBe(200);
    }
    expect(runEngine).toHaveBeenCalledTimes(4);
    expect(budget.remaining("user-1")).toBe(60);
    // And the account is left holding nothing, so the next press is free to go.
    expect(analysisSlots.heldBy("user-1")).toBe(0);
  });

  it("counts a QUEUED analysis as in flight, and leaves it in its place", async () => {
    // The player's analysis has not started — it is behind another search on a
    // one-at-a-time queue. That is still an analysis this account has asked for
    // and is about to be given, so a press on a DIFFERENT game is refused until
    // it is done. The waiting job is not cancelled or overtaken to make room:
    // it keeps its place in line and then answers.
    const OTHER_GAME = "99999999-8888-7777-6666-555555555555";
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 8, maxWaitMs: 30_000 });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Someone else's search owns the one engine slot.
    const occupier = harness({
      queue,
      engine: async () => {
        await held;
        return fakeEngineResponse();
      },
    });
    const occupying = occupier.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const player = harness({ queue });
    const queued = player.call("/analysis", { expectedRevision: 7, level: "deep" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Nothing of the player's is running yet — and the second game is refused
    // on those grounds alone.
    expect(player.runEngine).not.toHaveBeenCalled();
    const otherGame = await player.app.request(`/v1/games/${OTHER_GAME}/analysis`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 7, level: "quick" }),
    });
    expect(otherGame.status).toBe(429);
    expect(await otherGame.json()).toMatchObject({ code: "analysis_in_progress" });

    release?.();
    expect((await occupying).status).toBe(200);
    expect((await queued).status).toBe(200);
    // Once it is done the account is clear, and the game it was refused for
    // goes through — the refusal was "wait", not "no".
    expect(player.analysisSlots.heldBy("user-1")).toBe(0);
    const retried = await player.app.request(`/v1/games/${OTHER_GAME}/analysis`, {
      method: "POST",
      headers: {
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 7, level: "quick" }),
    });
    expect(retried.status).toBe(200);
  });

  it("still budgets bot moves, which no player is sitting and waiting for", async () => {
    // Dropping the analysis budget is not dropping the budget. A bot turn is charged
    // exactly as before — `max` costs 8, and a budget of 12 buys one. The
    // second is a different turn, so it is a real second search rather than the
    // cached answer to the first.
    const { call, source } = harness({
      config: { budgetPerWindow: 12 },
      source: { botSide: "A", botDifficulty: "max" },
    });
    expect((await call("/bot-move", { expectedRevision: 7 })).status).toBe(200);
    source.advanceTo(8);
    const second = await call("/bot-move", { expectedRevision: 8 });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "budget_exhausted" });
  });

  it("stops a user who has spent their budget", async () => {
    const { call } = harness({ config: { budgetPerWindow: 12, analysisBudgeted: true } });
    // deep costs 10, so the first succeeds and the second is over.
    expect((await call("/analysis", { expectedRevision: 7, level: "deep" })).status).toBe(200);
    const second = await call("/analysis", { expectedRevision: 7, level: "deep" });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "budget_exhausted" });
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });

  it("refuses a second analysis while this account already has one in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { call } = harness({
      engine: async () => {
        await gate;
        return fakeEngineResponse();
      },
    });
    // Two DIFFERENT analyses. The cap bounds concurrent searches, so what it has
    // to refuse is a second distinct one — asking the same question twice is
    // deduplicated below rather than refused.
    const first = call("/analysis", { expectedRevision: 7, level: "quick" });
    // Give the first request time to acquire the slot.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await call("/analysis", { expectedRevision: 7, level: "deep" });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "analysis_in_progress" });
    release?.();
    expect((await first).status).toBe(200);
  });

  it("shares one search between identical analyses instead of refusing the second", async () => {
    // Two tabs of the same game, or a reconnect racing a fresh request. They ask
    // the same question about the same position: that is ONE search, and the
    // second caller must be answered from it rather than told it is too busy —
    // being refused for work you already caused is how a returning player ended
    // up pressing Analyze again.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { call, runEngine, analysisSlots, budget } = harness({
      config: { budgetPerWindow: 100, analysisBudgeted: true },
      engine: async () => {
        await gate;
        return fakeEngineResponse();
      },
    });
    const first = call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release?.();

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // One position, one level, one engine process.
    expect(runEngine).toHaveBeenCalledTimes(1);
    // And one charge: the attaching caller spent no CPU. `quick` costs 1.
    expect(budget.remaining("user-1")).toBe(99);
    expect(analysisSlots.heldBy("user-1")).toBe(0);
  });

  it("does not charge an analysis slot against a request refused on turn rules", async () => {
    const { call, analysisSlots } = harness({ source: { activeSideIsBot: true } });
    await call("/analysis", { expectedRevision: 7 });
    expect(analysisSlots.heldBy("user-1")).toBe(0);
  });
});

describe("streaming", () => {
  const sse = (call: ReturnType<typeof harness>["call"], path: string, body: unknown) =>
    call(path, body, { Accept: "text/event-stream" });

  async function collect(response: Response): Promise<Array<{ event: string; data: unknown }>> {
    const text = await response.text();
    return text
      .split("\n\n")
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        const event = /^event:\s*(.+)$/m.exec(block)?.[1] ?? "message";
        const data = /^data:\s*(.+)$/m.exec(block)?.[1] ?? "null";
        return { event, data: JSON.parse(data) as unknown };
      });
  }

  it("streams progress and then the result", async () => {
    const { call } = harness({
      engine: (async (options: {
        onProgress?: (progress: Record<string, unknown>) => void;
      }) => {
        options.onProgress?.({
          phase: "sim",
          percent: 50,
          elapsedMs: 900,
          etaMs: 900,
          bestScore: 24,
          detail: "candidates=16 samples=2/4",
        });
        return fakeEngineResponse();
      }) as unknown as () => Promise<ReturnType<typeof fakeEngineResponse>>,
    });

    const response = await sse(call, "/analysis", { expectedRevision: 7 });
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await collect(response);
    // No `queued`: a free slot means the search started at once, and saying
    // otherwise would be a lie the UI would faithfully render.
    expect(events.map((entry) => entry.event)).toEqual(["running", "progress", "result"]);
    expect(events.at(-1)?.data).toMatchObject({ revision: 7 });
  });

  it("still refuses on turn rules with a real status code, before any stream opens", async () => {
    // Everything decidable up front stays a status code. Only failures after
    // the head is written have to become events.
    const { call } = harness({ source: { activeSideIsBot: true } });
    const response = await sse(call, "/analysis", { expectedRevision: 7 });
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).not.toContain("text/event-stream");
  });

  it("reports an engine failure as an error event, not a broken stream", async () => {
    const { call } = harness({
      engine: async () => {
        throw new EngineTimeoutError(1000);
      },
    });
    const events = await collect(await sse(call, "/analysis", { expectedRevision: 7 }));
    expect(events.at(-1)).toMatchObject({
      event: "error",
      data: { code: "engine_timeout" },
    });
  });

  it("releases the per-user analysis slot when a streamed run ends", async () => {
    const { call, analysisSlots } = harness();
    await collect(await sse(call, "/analysis", { expectedRevision: 7 }));
    expect(analysisSlots.heldBy("user-1")).toBe(0);
  });

  it("streams a bot move too, so a long max search keeps the connection warm", async () => {
    const { call } = harness({
      source: { botSide: "B", botDifficulty: "max", activeSide: "B", activeSideIsBot: true },
    });
    const events = await collect(await sse(call, "/bot-move", { expectedRevision: 7 }));
    expect(events.at(-1)?.event).toBe("result");
    expect(JSON.stringify(events.at(-1)?.data)).not.toContain("oppReply");
  });
});

describe("the queue, through the API", () => {
  const sse = (call: ReturnType<typeof harness>["call"], path: string, body: unknown) =>
    call(path, body, { Accept: "text/event-stream" });

  async function collect(response: Response): Promise<Array<{ event: string; data: unknown }>> {
    const text = await response.text();
    return text
      .split("\n\n")
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        const event = /^event:\s*(.+)$/m.exec(block)?.[1] ?? "message";
        const data = /^data:\s*(.+)$/m.exec(block)?.[1] ?? "null";
        return { event, data: JSON.parse(data) as unknown };
      });
  }

  /** A gate the fake engine waits on, so a search can be held mid-flight. */
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it("tells a waiting caller it is queued, then that it started", async () => {
    // One CPU, one slot. The second caller must be able to distinguish "the
    // server has not begun" from "the server is thinking", or the UI can only
    // draw a spinner that might be dead.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4, maxWaitMs: 30_000 });
    const held = gate();
    let first = true;
    const occupier = harness({
      queue,
      engine: async () => {
        if (first) {
          first = false;
          await held.promise;
        }
        return fakeEngineResponse();
      },
    });

    const running = sse(occupier.call, "/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const waiter = harness({ queue, source: { revision: 7 } });
    const queuedResponse = await sse(waiter.call, "/analysis", {
      expectedRevision: 7,
      level: "deep",
    });
    held.open();

    const events = await collect(queuedResponse);
    const names = events.map((entry) => entry.event);
    expect(names[0]).toBe("queued");
    expect(names).toContain("running");
    expect(names.at(-1)).toBe("result");
    // `queued` must come before `running`; a UI that saw them the other way
    // round would show the search going backwards.
    expect(names.indexOf("queued")).toBeLessThan(names.indexOf("running"));
    expect(events[0]?.data).toMatchObject({ ahead: 0, position: 1 });

    await collect(await running);
  });

  it("puts a bot turn ahead of analysis that was already waiting", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 8, maxWaitMs: 30_000 });
    const held = gate();
    const order: string[] = [];
    let occupied = false;

    const engineFor = (label: string) => async () => {
      if (!occupied) {
        occupied = true;
        order.push("occupier");
        await held.promise;
        return fakeEngineResponse();
      }
      order.push(label);
      return fakeEngineResponse();
    };

    const occupier = harness({ queue, engine: engineFor("occupier") });
    const running = occupier.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const analyst = harness({ queue, engine: engineFor("analysis") });
    const analysis = analyst.call("/analysis", { expectedRevision: 7, level: "deep" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const player = harness({
      queue,
      engine: engineFor("bot"),
      source: { botSide: "B", botDifficulty: "hard", activeSide: "B", activeSideIsBot: true },
    });
    const bot = player.call("/bot-move", { expectedRevision: 7 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    held.open();
    const [runningResponse, analysisResponse, botResponse] = await Promise.all([
      running,
      analysis,
      bot,
    ]);
    expect(runningResponse.status).toBe(200);
    expect(analysisResponse.status).toBe(200);
    expect(botResponse.status).toBe(200);
    // Gameplay ran at the next free slot despite arriving last.
    expect(order).toEqual(["occupier", "bot", "analysis"]);
  });

  it("refuses an overflowing queue with a coded 503, never an ambiguous 500", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 1, maxWaitMs: 30_000 });
    const held = gate();
    let first = true;
    const engine = async () => {
      if (first) {
        first = false;
        await held.promise;
      }
      return fakeEngineResponse();
    };

    const a = harness({ queue, engine });
    const running = a.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const b = harness({ queue, engine });
    const waiting = b.call("/analysis", { expectedRevision: 7, level: "normal" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const c = harness({ queue, engine });
    const refused = await c.call("/analysis", { expectedRevision: 7, level: "deep" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "queue_full" });
    expect(refused.headers.get("Retry-After")).toBeTruthy();

    held.open();
    await Promise.all([running, waiting]);
  });

  it("reports a full queue as an error event once a stream is already open", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 1, maxWaitMs: 30_000 });
    const held = gate();
    let first = true;
    const engine = async () => {
      if (first) {
        first = false;
        await held.promise;
      }
      return fakeEngineResponse();
    };
    const a = harness({ queue, engine });
    const running = a.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const b = harness({ queue, engine });
    const waiting = b.call("/analysis", { expectedRevision: 7, level: "normal" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const c = harness({ queue, engine });
    const events = await collect(
      await sse(c.call, "/analysis", { expectedRevision: 7, level: "deep" }),
    );
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "queue_full" } });

    held.open();
    await Promise.all([running, waiting]);
  });

  it("refuses to spend a slot on a position the game left while the job waited", async () => {
    // The case queueing creates. Admitted at revision 7, waits, and by the time
    // the CPU is free the game is at 8. Spending a minute of a shared engine on
    // a board that no longer exists is the thing to avoid, so the check happens
    // BEFORE the process is spawned, not after the answer comes back.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4, maxWaitMs: 30_000 });
    const held = gate();
    const occupier = harness({
      queue,
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    const running = occupier.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const waiter = harness({ queue, source: { revision: 7 } });
    const queued = waiter.call("/analysis", { expectedRevision: 7, level: "deep" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A move lands while the analysis is still in line.
    waiter.source.advanceTo(8);
    held.open();

    const response = await queued;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "stale_revision",
      currentRevision: 8,
      requestedRevision: 7,
    });
    // The engine was never asked about the dead position.
    expect(waiter.runEngine).not.toHaveBeenCalled();
    await running;
  });

  it("refuses a stale queued bot turn rather than playing into a changed board", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4, maxWaitMs: 30_000 });
    const held = gate();
    const occupier = harness({
      queue,
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    const running = occupier.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const player = harness({
      queue,
      source: { revision: 7, botSide: "B", botDifficulty: "hard", activeSide: "B" },
    });
    const bot = player.call("/bot-move", { expectedRevision: 7 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    player.source.advanceTo(9);
    held.open();

    const response = await bot;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_revision", currentRevision: 9 });
    expect(player.runEngine).not.toHaveBeenCalled();
    await running;
  });

  it("stamps a bot result with the revision it was computed for", async () => {
    // The client's last line of defence: a result that arrives after the game
    // moved on is detectable without trusting the timing of anything.
    const { call } = harness({
      source: { revision: 12, botSide: "B", botDifficulty: "hard", activeSide: "B" },
    });
    const body = (await (await call("/bot-move", { expectedRevision: 12 })).json()) as {
      revision: number;
    };
    expect(body.revision).toBe(12);
  });

  it("keeps a queued job alive when its only observer disconnects", async () => {
    // A disconnect is NOT a cancellation. A player who starts an analysis (or
    // whose bot turn is queued) and then navigates away, closes the tab, or
    // loses the network has not decided to abandon the computation — they may
    // return to it. So a lost observer must leave the job exactly where it was,
    // still in line, still going to run. Capacity is reclaimed by usefulness
    // (superseded / explicit cancel / timeout), never by a closed connection —
    // that policy is exercised directly in jobRegistry.test.ts.
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 2, maxWaitMs: 30_000 });
    const held = gate();
    const occupier = harness({
      queue,
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    const running = occupier.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const abandoning = new AbortController();
    const waiter = harness({ queue });
    const abandoned = Promise.resolve(
      waiter.app.request(`/v1/games/${GAME_ID}/analysis`, {
        method: "POST",
        headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 7, level: "deep" }),
        signal: abandoning.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.stats().waiting).toBe(1);

    // The observer goes away.
    abandoning.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Still in line, and no process spawned for it yet: the disconnect changed
    // nothing about the job itself.
    expect(queue.stats().waiting).toBe(1);
    expect(waiter.runEngine).not.toHaveBeenCalled();

    // When capacity frees, the still-wanted job runs to completion — proof that
    // the lost connection never killed it.
    held.open();
    await running;
    await abandoned.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(waiter.runEngine).toHaveBeenCalledTimes(1);
    expect(queue.stats().waiting).toBe(0);
  });
});

describe("health", () => {
  it("reports the queue state an operator needs and nothing about anybody", async () => {
    const { app, queue } = harness();
    const body = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.queue).toMatchObject({
      running: 0,
      waiting: 0,
      concurrency: queue.stats().concurrency,
      maxWaiting: queue.stats().maxWaiting,
    });
    // The misconfiguration this service is most likely to have is a concurrency
    // derived from the host's cores rather than the container's quota, so the
    // evidence is here.
    expect(body.cpu).toMatchObject({ source: "cgroup-v2", parallelism: 8 });
    expect(body.retention).toEqual({
      analysisResultTtlMs: 5 * 60 * 1000,
      botResultTtlMs: 60 * 1000,
    });
    // How the queue numbers above should be read: analysis is serialised per
    // account rather than rationed, so its load arrives in this queue.
    expect(body.metering).toEqual({
      analysisInFlight: 1,
      analysisBudget: "unlimited",
      botBudget: "rationed",
      // Reported so an operator can see what the ration actually is, rather
      // than only that one exists.
      budgetPerWindow: baseConfig().budgetPerWindow,
      budgetWindowMs: baseConfig().budgetWindowMs,
    });

    const text = JSON.stringify(body);
    for (const leak of ["user", "game", "token", GAME_ID, "rack", "canonical", "key"]) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("shows live depth without naming a single job", async () => {
    const queue = new EngineQueue({ concurrency: 1, maxWaiting: 4, maxWaitMs: 30_000 });
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const busy = harness({
      queue,
      engine: async () => {
        await held;
        return fakeEngineResponse();
      },
    });
    const running = busy.call("/analysis", { expectedRevision: 7, level: "quick" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waiter = harness({ queue });
    const queued = waiter.call("/analysis", { expectedRevision: 7, level: "deep" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const body = (await (await busy.app.request("/health")).json()) as {
      queue: { running: number; waiting: number };
    };
    expect(body.queue).toMatchObject({ running: 1, waiting: 1 });

    open();
    await Promise.all([running, queued]);
  });
});

describe("concurrent requests", () => {
  it("shares one engine run between callers asking the identical question", async () => {
    const { call, runEngine } = harness({ config: { maxAnalysisPerUser: 4 } });
    const responses = await Promise.all([
      call("/analysis", { expectedRevision: 7, level: "quick" }),
      call("/analysis", { expectedRevision: 7, level: "quick" }),
      call("/analysis", { expectedRevision: 7, level: "quick" }),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    // Same game, same revision, same level: one search, three answers.
    expect(runEngine).toHaveBeenCalledTimes(1);
  });

  it("gives every concurrent caller the same answer", async () => {
    const { call } = harness({ config: { maxAnalysisPerUser: 4 } });
    const bodies = (await Promise.all(
      [1, 2, 3].map(async () =>
        (await call("/analysis", { expectedRevision: 7, level: "quick" })).json(),
      ),
    )) as Array<{ recommendation: { immediateScore: number }; revision: number }>;
    const [first, ...rest] = bodies;
    for (const body of rest) {
      expect(body.recommendation.immediateScore).toBe(first?.recommendation.immediateScore);
      expect(body.revision).toBe(first?.revision);
    }
  });
});

// The reconnect surface: a returning player attaching to a job (or its cached
// result) they already caused. The invariant that matters as much as the feature
// is that reconnecting is not a loophole — every gate the starting request passes
// is passed here too, and reconnecting never STARTS work or spends a budget.
describe("reconnect + cancel", () => {
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  async function collect(response: Response): Promise<Array<{ event: string; data: unknown }>> {
    const text = await response.text();
    return text
      .split("\n\n")
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        const event = /^event:\s*(.+)$/m.exec(block)?.[1] ?? "message";
        const data = /^data:\s*(.+)$/m.exec(block)?.[1] ?? "null";
        return { event, data: JSON.parse(data) as unknown };
      });
  }

  const get = (h: ReturnType<typeof harness>, query: string) =>
    h.app.request(`/v1/games/${GAME_ID}${query}`, {
      headers: { Authorization: "Bearer token-1" },
    });

  it("reconnects to a running job and shares one search", async () => {
    const held = gate();
    const h = harness({
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    // Start the analysis (streaming), leave it running.
    const started = h.call("/analysis", { expectedRevision: 7, level: "quick" }, {
      Accept: "text/event-stream",
    });
    const startResp = await started;
    await tick();

    // A returning tab attaches to the SAME job.
    const reconnect = await get(h, "/analysis?revision=7&level=quick");
    await tick();

    held.open();
    const [startEvents, reconnectEvents] = await Promise.all([
      collect(startResp),
      collect(reconnect),
    ]);
    expect(startEvents.at(-1)).toMatchObject({ event: "result", data: { revision: 7 } });
    expect(reconnectEvents.map((e) => e.event)).toContain("running");
    expect(reconnectEvents.at(-1)).toMatchObject({ event: "result", data: { revision: 7 } });
    // One search served both.
    expect(h.runEngine).toHaveBeenCalledTimes(1);
  });

  it("serves a completed result on reconnect without recomputing", async () => {
    const h = harness();
    await (await h.call("/analysis", { expectedRevision: 7, level: "quick" })).json();
    const events = await collect(await get(h, "/analysis?revision=7&level=quick"));
    expect(events.at(-1)).toMatchObject({ event: "result", data: { revision: 7 } });
    // The cache answered the reconnect; the engine ran exactly once, for the POST.
    expect(h.runEngine).toHaveBeenCalledTimes(1);
  });

  it("reports idle when there is no job for the position", async () => {
    const h = harness();
    const events = await collect(await get(h, "/analysis?revision=7&level=quick"));
    expect(events).toEqual([{ event: "idle", data: {} }]);
    expect(h.runEngine).not.toHaveBeenCalled();
  });

  it("reconnects to a running bot job the same way", async () => {
    const held = gate();
    const h = harness({
      source: { botSide: "B", botDifficulty: "hard", activeSide: "B", activeSideIsBot: true },
      engine: (async (options: {
        onProgress?: (progress: Record<string, unknown>) => void;
      }) => {
        options.onProgress?.({
          phase: "sim",
          percent: 50,
          elapsedMs: 900,
          etaMs: 900,
          detail: "samples=2/4",
        });
        await held.promise;
        return fakeEngineResponse();
      }) as unknown as () => Promise<ReturnType<typeof fakeEngineResponse>>,
    });
    const started = h.call("/bot-move", { expectedRevision: 7 }, { Accept: "text/event-stream" });
    const startResp = await started;
    await tick();
    const reconnect = await get(h, "/bot-move?revision=7");
    await tick();
    held.open();
    const [, reconnectEvents] = await Promise.all([collect(startResp), collect(reconnect)]);
    expect(reconnectEvents).toContainEqual(
      expect.objectContaining({
        event: "progress",
        data: expect.objectContaining({ percent: 50 }),
      }),
    );
    expect(reconnectEvents.at(-1)).toMatchObject({ event: "result", data: { revision: 7 } });
    // The bot's reasoning about its own rack never crosses the wire.
    expect(JSON.stringify(reconnectEvents.at(-1)?.data)).not.toContain("oppReply");
    expect(h.runEngine).toHaveBeenCalledTimes(1);
  });

  it("enforces authorization on reconnect, before any stream opens", async () => {
    const h = harness({ source: { callerControlsActiveSide: false } });
    const response = await get(h, "/analysis?revision=7&level=quick");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "analysis_not_allowed" });
    expect(h.runEngine).not.toHaveBeenCalled();
  });

  it("refuses a reconnect composed against a stale revision", async () => {
    const h = harness({ source: { revision: 9 } });
    const response = await get(h, "/analysis?revision=7&level=quick");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_revision", currentRevision: 9 });
  });

  it("cancels an in-flight analysis on an explicit request", async () => {
    const held = gate();
    const h = harness({
      engine: ((options: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new EngineCancelledError()),
            { once: true },
          );
          // Never resolves on its own; only cancellation ends it.
          void held;
        })) as unknown as () => Promise<ReturnType<typeof fakeEngineResponse>>,
    });
    const started = h.call("/analysis", { expectedRevision: 7, level: "quick" }, {
      Accept: "text/event-stream",
    });
    const startResp = await started;
    await tick();

    const cancelled = await h.app.request(`/v1/games/${GAME_ID}/analysis/cancel`, {
      method: "POST",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, level: "quick" }),
    });
    expect(await cancelled.json()).toEqual({ cancelled: true });

    const events = await collect(startResp);
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "cancelled" } });
  });

  it("refuses to cancel for someone who does not control the turn", async () => {
    const h = harness({ source: { callerControlsActiveSide: false } });
    const response = await h.app.request(`/v1/games/${GAME_ID}/analysis/cancel`, {
      method: "POST",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, level: "quick" }),
    });
    expect(response.status).toBe(403);
  });
});

// ── job discovery ────────────────────────────────────────────────────────────
//
// "What is already running for this position?" — the question the browser could
// not previously ask. Without it, an analysis was identified partly by a level
// that only one tab's session storage remembered, so losing that note stranded a
// live search behind a button the player had to press (and pay for) again.
describe("job discovery", () => {
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  const jobs = (h: ReturnType<typeof harness>, query: string) =>
    h.app.request(`/v1/games/${GAME_ID}/jobs${query}`, {
      headers: { Authorization: "Bearer token-1" },
    });

  it("reports nothing for a position with no work", async () => {
    const h = harness();
    const response = await jobs(h, "?revision=7");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ gameId: GAME_ID, revision: 7, jobs: [] });
    expect(h.runEngine).not.toHaveBeenCalled();
  });

  it("finds a running analysis by position alone, naming the level the client lost", async () => {
    const held = gate();
    const h = harness({
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    void h.call("/analysis", { expectedRevision: 7, level: "deep" }, {
      Accept: "text/event-stream",
    });
    await tick();

    const found = (await (await jobs(h, "?revision=7")).json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(found.jobs).toHaveLength(1);
    // The level is the whole point: it is the one part of the job's identity a
    // returning client cannot derive from the game row.
    expect(found.jobs[0]).toMatchObject({ kind: "analysis", level: "deep", status: "running" });
    held.open();
  });

  it("reports the engine's real progress, so a returning client paints no fake zero", async () => {
    const held = gate();
    const h = harness({
      engine: (async (options: {
        onProgress?: (progress: Record<string, unknown>) => void;
      }) => {
        options.onProgress?.({
          phase: "sim",
          percent: 63,
          elapsedMs: 4200,
          etaMs: 2500,
          bestScore: 0,
          detail: "samples=5/8",
        });
        await held.promise;
        return fakeEngineResponse();
      }) as unknown as () => Promise<ReturnType<typeof fakeEngineResponse>>,
    });
    void h.call("/analysis", { expectedRevision: 7, level: "quick" }, {
      Accept: "text/event-stream",
    });
    await tick();

    const found = (await (await jobs(h, "?revision=7")).json()) as {
      jobs: Array<{ progress?: { percent: number; phase: string } }>;
    };
    expect(found.jobs[0]?.progress).toMatchObject({ percent: 63, phase: "sim" });
    held.open();
  });

  it("reports a completed job so a returning client reads the answer instead of recomputing", async () => {
    const h = harness();
    expect((await h.call("/analysis", { expectedRevision: 7, level: "quick" })).status).toBe(200);

    const found = (await (await jobs(h, "?revision=7")).json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(found.jobs).toEqual([
      expect.objectContaining({ kind: "analysis", level: "quick", status: "completed" }),
    ]);
    // The listing describes; it never answers. Reading the result still goes
    // through the attach endpoint, which applies the presentation rules.
    expect(JSON.stringify(found.jobs)).not.toContain("recommendation");
    expect(JSON.stringify(found.jobs)).not.toContain("oppReply");
  });

  it("never starts work and never spends budget", async () => {
    const h = harness();
    const before = h.budget.remaining("user-1");
    await jobs(h, "?revision=7");
    expect(h.runEngine).not.toHaveBeenCalled();
    expect(h.budget.remaining("user-1")).toBe(before);
    expect(h.analysisSlots.heldBy("user-1")).toBe(0);
  });

  it("refuses a revision the game has left, naming the current one", async () => {
    const h = harness({ source: { revision: 9 } });
    const response = await jobs(h, "?revision=7");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_revision", currentRevision: 9 });
  });

  it("requires authentication", async () => {
    const h = harness();
    const response = await h.app.request(`/v1/games/${GAME_ID}/jobs?revision=7`);
    expect(response.status).toBe(401);
  });

  it("reports a game it may not read as absent", async () => {
    const h = harness({
      source: { failWith: new RoomAccessError("No such game, or it is not yours to read.", 404) },
    });
    const response = await jobs(h, "?revision=7");
    expect(response.status).toBe(404);
  });

  it("hides an analysis from someone who does not control the turn", async () => {
    // The same rule the analysis attach endpoint applies. A spectator must not
    // even learn that the player on move is consulting the engine.
    const held = gate();
    const running = harness({
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    void running.call("/analysis", { expectedRevision: 7, level: "quick" }, {
      Accept: "text/event-stream",
    });
    await tick();

    // Same registry, a caller who does not control the turn.
    const spectator = harnessSharing(running, { callerControlsActiveSide: false });
    const found = (await (
      await spectator.app.request(`/v1/games/${GAME_ID}/jobs?revision=7`, {
        headers: { Authorization: "Bearer token-1" },
      })
    ).json()) as { jobs: unknown[] };
    expect(found.jobs).toEqual([]);
    held.open();
  });

  it("hides a bot search from a caller who does not control the bot's game", async () => {
    const held = gate();
    const running = harness({
      source: { botSide: "A", botDifficulty: "hard", activeSideIsBot: true },
      engine: async () => {
        await held.promise;
        return fakeEngineResponse();
      },
    });
    void running.call("/bot-move", { expectedRevision: 7 }, { Accept: "text/event-stream" });
    await tick();

    const owner = (await (
      await running.app.request(`/v1/games/${GAME_ID}/jobs?revision=7`, {
        headers: { Authorization: "Bearer token-1" },
      })
    ).json()) as { jobs: Array<Record<string, unknown>> };
    expect(owner.jobs).toEqual([
      expect.objectContaining({ kind: "bot", difficulty: "hard", status: "running" }),
    ]);

    const spectator = harnessSharing(running, {
      botSide: "A",
      botDifficulty: "hard",
      activeSideIsBot: true,
      callerControlsActiveSide: false,
    });
    const hidden = (await (
      await spectator.app.request(`/v1/games/${GAME_ID}/jobs?revision=7`, {
        headers: { Authorization: "Bearer token-1" },
      })
    ).json()) as { jobs: unknown[] };
    expect(hidden.jobs).toEqual([]);
    held.open();
  });
});

// ── the database reads in front of a search ──────────────────────────────────
describe("canonical context acquisition", () => {
  it("opens the command window once, at the revision the caller claimed", async () => {
    const h = harness();
    await h.call("/analysis", { expectedRevision: 7, level: "quick" });
    // One read, speculatively windowed on the claim, which the revision gate
    // then proves correct. Previously this waited on the context read first.
    expect(h.source.commandWindows).toEqual([7]);
  });

  it("re-reads the window when the caller's claim disagrees with the database", async () => {
    // The claim was wrong, so the speculative window may be wrong too. The
    // request is refused either way, but the engine must never be handed a
    // command window opened at a revision the database does not hold.
    const h = harness({ source: { revision: 9 } });
    const response = await h.call("/analysis", { expectedRevision: 7, level: "quick" });
    expect(response.status).toBe(409);
    expect(h.source.commandWindows).toEqual([7, 9]);
    expect(h.runEngine).not.toHaveBeenCalled();
  });

  it("reports where the pre-engine time went, in durations and nothing else", async () => {
    const h = harness();
    const response = await h.call("/analysis", { expectedRevision: 7, level: "quick" });
    const timing = response.headers.get("Server-Timing");
    expect(timing).toMatch(/auth;dur=/);
    expect(timing).toMatch(/context;dur=/);
    expect(timing).toMatch(/total;dur=/);
    // Durations only: no identifiers, no token, no position.
    expect(timing).not.toContain(GAME_ID);
    expect(timing).not.toContain("token");
  });
});

// ── two tabs, one turn ───────────────────────────────────────────────────────
//
// The same player with the game open twice is ordinary, and so is a reconnect
// racing a fresh request. Both produce two callers asking the same question
// about the same position at the same moment. Exactly one search may run, and
// exactly one answer may come back — the DB commit is idempotent on the client
// side, but the CPU is spent here and cannot be un-spent.
describe("two callers, one canonical turn", () => {
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

  it("computes a bot turn once and charges for it once", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      source: { botSide: "B", botDifficulty: "medium", activeSide: "B" },
      engine: async () => {
        await gate;
        return fakeEngineResponse();
      },
    });

    const tabA = h.call("/bot-move", { expectedRevision: 7 });
    await tick();
    const tabB = h.call("/bot-move", { expectedRevision: 7 });
    await tick();
    release?.();

    const [first, second] = await Promise.all([tabA, tabB]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // One engine process for one canonical turn.
    expect(h.runEngine).toHaveBeenCalledTimes(1);
    // And both tabs are told the same move, for the same revision, so whichever
    // of them writes it writes the same thing.
    const a = (await first.json()) as { revision: number; move: unknown };
    const b = (await second.json()) as { revision: number; move: unknown };
    expect(a.revision).toBe(7);
    expect(b).toEqual(a);
    // Charged ONCE, not twice — which is the claim, not the price. Derived from
    // the tier table so a legitimate reprice does not read as a regression here.
    expect(h.budget.remaining("user-1")).toBe(
      baseConfig().budgetPerWindow - BOT_TIER_CONFIG.medium.cost,
    );
  });

  it("serves a second caller from the cached result rather than re-searching", async () => {
    const h = harness({ source: { botSide: "B", botDifficulty: "medium", activeSide: "B" } });
    expect((await h.call("/bot-move", { expectedRevision: 7 })).status).toBe(200);
    const again = await h.call("/bot-move", { expectedRevision: 7 });
    expect(again.status).toBe(200);
    expect(h.runEngine).toHaveBeenCalledTimes(1);
    expect(h.budget.remaining("user-1")).toBe(
      baseConfig().budgetPerWindow - BOT_TIER_CONFIG.medium.cost,
    );
  });

  it("does not let a cached turn answer for the NEXT position", async () => {
    // The retention that makes a reconnect cheap must not make the bot
    // deterministic across turns: the revision is part of the key.
    const h = harness({ source: { botSide: "B", botDifficulty: "medium", activeSide: "B" } });
    await h.call("/bot-move", { expectedRevision: 7 });
    h.source.advanceTo(8);
    await h.call("/bot-move", { expectedRevision: 8 });
    expect(h.runEngine).toHaveBeenCalledTimes(2);
  });
});

// ── explaining a move that has already been played ───────────────────────────
//
// The move response carries the move and nothing else, on purpose. The engine's
// ranking is read afterwards, on demand, a page at a time, out of the result the
// registry already holds — no second search, and no payload paid for on turns
// where nobody opens the panel.
describe("bot reasoning", () => {
  const BOT_ROOM: FakeSourceOptions = {
    botSide: "B",
    botDifficulty: "medium",
    activeSide: "B",
  };

  /** A ranking long enough to page through. Descending by value, chosen first —
   *  the order the engine itself serialises. */
  function rankedResponse(count = 20) {
    return fakeEngineResponse({
      equity: 31.5,
      stats: { moves: 410, nodes: 81234, elapsedMs: 1830, candidates: count, samples: 4 },
      candidates: Array.from({ length: count }, (_, index) => ({
        type: "place" as const,
        placements: [{ r: 7, c: 7 + index, kind: "5", token: "5" }],
        exchange: [],
        score: 30 - index,
        scoreComp: 30 - index,
        leave: 8.5,
        potential: 6.2,
        oppReply: 12.1,
        mean: 26.6 - index,
        stddev: 3.2,
        value: 24.1 - index,
        chosen: index === 0,
      })),
    });
  }

  const read = (h: ReturnType<typeof harness>, query: string) =>
    h.app.request(`/v1/games/${GAME_ID}/bot-move/reasoning${query}`, {
      headers: { Authorization: "Bearer token-1" },
    });

  /** Play the bot's turn at revision 7, then let the game advance past it — the
   *  state the panel is actually opened in. */
  async function playedTurn(overrides: FakeSourceOptions = {}) {
    const h = harness({
      source: { ...BOT_ROOM, ...overrides },
      engine: async () => rankedResponse(),
    });
    expect((await h.call("/bot-move", { expectedRevision: 7 })).status).toBe(200);
    h.source.advanceTo(8);
    return h;
  }

  it("asks the engine for a full ranking, not the default handful", async () => {
    const h = harness({ source: BOT_ROOM });
    await h.call("/bot-move", { expectedRevision: 7 });
    expect(h.runEngine.mock.calls[0]?.[0].request).toMatchObject({ topN: 24 });
  });

  it("serves the first page with the numbers the move response withholds", async () => {
    const h = await playedTurn();
    const response = await read(h, "?revision=7");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      equity: number;
      stats: { candidates: number; moves: number };
      page: { offset: number; limit: number; total: number };
      candidates: Array<{ value: number; chosen: boolean }>;
      chosenIndex: number;
      chosen: { chosen: boolean };
      runnerUp: { value: number };
    };
    // Exactly the fields `toBotResponse` on the client had to zero-fill.
    expect(body.equity).toBe(31.5);
    expect(body.stats).toMatchObject({ candidates: 20, moves: 410 });
    expect(body.page).toEqual({ offset: 0, limit: 6, total: 20 });
    expect(body.candidates).toHaveLength(6);
    expect(body.chosenIndex).toBe(0);
    expect(body.chosen.chosen).toBe(true);
    expect(body.runnerUp.value).toBe(23.1);
    // No second search: the report came out of the registry's cached result.
    expect(h.runEngine).toHaveBeenCalledTimes(1);
  });

  it("pages through the ranking without re-running the search", async () => {
    const h = await playedTurn();
    const body = (await (await read(h, "?revision=7&offset=6&limit=6")).json()) as {
      page: { offset: number; total: number };
      candidates: Array<{ value: number }>;
      chosen: { value: number };
      runnerUp: { value: number };
    };
    expect(body.page).toMatchObject({ offset: 6, total: 20 });
    expect(body.candidates.map((candidate) => Math.round(candidate.value * 10) / 10)).toEqual([
      18.1, 17.1, 16.1, 15.1, 14.1, 13.1,
    ]);
    // Repeated on every page, so a client can render page four without ever
    // having fetched page one.
    expect(body.chosen.value).toBe(24.1);
    expect(body.runnerUp.value).toBe(23.1);
    expect(h.runEngine).toHaveBeenCalledTimes(1);
  });

  it("clamps a page past the end instead of failing, and says what it served", async () => {
    const h = await playedTurn();
    const body = (await (await read(h, "?revision=7&offset=999&limit=500")).json()) as {
      page: { offset: number; limit: number; total: number };
      candidates: unknown[];
    };
    expect(body.page).toEqual({ offset: 20, limit: 24, total: 20 });
    expect(body.candidates).toEqual([]);
  });

  it("still explains the move that ENDED the game", async () => {
    // The last move of a game is the one players most want explained, and by
    // then the room is no longer `playing`.
    const h = await playedTurn({ status: "finished" });
    expect((await read(h, "?revision=7")).status).toBe(200);
  });

  it("refuses a spectator, exactly as the move endpoint does", async () => {
    const h = await playedTurn();
    const spectator = harnessSharing(h, { ...BOT_ROOM, callerControlsActiveSide: false });
    const response = await read(spectator, "?revision=7");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  it("has nothing to explain in a room with no engine player", async () => {
    const h = harness({ source: { botSide: null, botDifficulty: null } });
    const response = await read(h, "?revision=7");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "turn_rule" });
  });

  it("says plainly when the reasoning is no longer held", async () => {
    // Retention is bounded and in memory. An old move, or a restarted service,
    // is an ordinary outcome the client shows as a sentence — not an error.
    const h = harness({ source: { ...BOT_ROOM, revision: 8 } });
    const response = await read(h, "?revision=7");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "reasoning_unavailable" });
  });

  it("refuses to walk the cache backwards through the game", async () => {
    const h = harness({ source: { ...BOT_ROOM, revision: 40 } });
    const response = await read(h, "?revision=7");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_revision" });
  });

  it("refuses a revision the game has not reached", async () => {
    const h = harness({ source: BOT_ROOM });
    expect((await read(h, "?revision=99")).status).toBe(409);
  });

  it("requires a revision at all", async () => {
    const h = harness({ source: BOT_ROOM });
    const response = await read(h, "");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad_request" });
  });
});
