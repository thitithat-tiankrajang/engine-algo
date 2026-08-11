// End-to-end tests of the HTTP surface: authorization, turn rules, staleness,
// metering, and the failure modes the client has to handle.
//
// The engine is stubbed here so these run in milliseconds and assert POLICY.
// That the policy is applied to a REAL search is covered in engine.test.ts.
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { EngineCancelledError, EngineFailureError, EngineTimeoutError } from "../src/engineRunner.js";
import { EngineQueue } from "../src/queue.js";
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
  const budget = new ComputeBudget({
    perWindow: config.budgetPerWindow,
    windowMs: config.budgetWindowMs,
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

  return { app, call, runEngine, source, queue, budget, analysisSlots };
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

  it("stops a user who has spent their budget", async () => {
    const { call } = harness({ config: { budgetPerWindow: 12 } });
    // deep costs 10, so the first succeeds and the second is over.
    expect((await call("/analysis", { expectedRevision: 7, level: "deep" })).status).toBe(200);
    const second = await call("/analysis", { expectedRevision: 7, level: "deep" });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "budget_exhausted" });
    expect(second.headers.get("Retry-After")).toBeTruthy();
  });

  it("holds one analysis slot per user, so one account cannot fill the queue", async () => {
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
    const first = call("/analysis", { expectedRevision: 7 });
    // Give the first request time to acquire the slot.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await call("/analysis", { expectedRevision: 7 });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "analysis_in_progress" });
    release?.();
    expect((await first).status).toBe(200);
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
      config: { maxAnalysisPerUser: 4 },
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

    const waiter = harness({ queue, config: { maxAnalysisPerUser: 4 }, source: { revision: 7 } });
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
