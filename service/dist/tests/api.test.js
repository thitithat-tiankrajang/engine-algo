// End-to-end tests of the HTTP surface: authorization, turn rules, staleness,
// metering, and the failure modes the client has to handle.
//
// The engine is stubbed here so these run in milliseconds and assert POLICY.
// That the policy is applied to a REAL search is covered in engine.test.ts.
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { EngineFailureError, EngineTimeoutError } from "../src/engineRunner.js";
import { EngineQueue } from "../src/queue.js";
import { ComputeBudget, ConcurrencyLimit } from "../src/rateLimit.js";
import { RoomAccessError } from "../src/roomContext.js";
import { GAME_ID, baseConfig, fakeEngineResponse, fakeSource, fakeVerify, } from "./helpers.js";
function harness(overrides = {}) {
    const config = baseConfig(overrides.config);
    const source = fakeSource(overrides.source);
    const queue = new EngineQueue({ concurrency: config.concurrency, maxWaiting: config.maxWaiting });
    const budget = new ComputeBudget({
        perWindow: config.budgetPerWindow,
        windowMs: config.budgetWindowMs,
    });
    const analysisSlots = new ConcurrencyLimit(config.maxAnalysisPerUser);
    // Typed so `mock.calls[0][0].request` is checkable — several tests assert on
    // exactly what the adapter handed the engine.
    const runEngine = vi.fn(overrides.engine ?? (async () => fakeEngineResponse()));
    const app = createApp({
        config,
        source,
        queue,
        budget,
        analysisSlots,
        runEngine: runEngine,
        verifyToken: fakeVerify,
    });
    const call = (path, body, headers = {}) => app.request(`/v1/games/${GAME_ID}${path}`, {
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
        const request = runEngine.mock.calls[0]?.[0]?.request;
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
        const body = (await response.json());
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
        const body = (await (await call("/analysis", { expectedRevision: 7 })).json());
        expect(body.recommendation.recommended).toBe(true);
        expect(body.recommendation.evaluationGap).toBe(0);
        expect(body.alternatives.every((entry) => !entry.recommended)).toBe(true);
        for (const alternative of body.alternatives) {
            expect(alternative.evaluation).toBeLessThanOrEqual(body.recommendation.evaluation);
            expect(alternative.evaluationGap).toBeGreaterThanOrEqual(0);
        }
    });
    it("recommends the move the engine itself chose, not a re-ranked one", async () => {
        // The highest immediate score here is the 30-point play, but the engine
        // chose the 24-point one. Analysis must agree with the engine, or it is
        // explaining a decision nobody made.
        const { call } = harness();
        const body = (await (await call("/analysis", { expectedRevision: 7 })).json());
        expect(body.recommendation.immediateScore).toBe(24);
        expect(body.alternatives.some((entry) => entry.immediateScore === 30)).toBe(true);
    });
    it("grounds every reported factor in a number the engine produced", async () => {
        const { call } = harness();
        const body = (await (await call("/analysis", { expectedRevision: 7 })).json());
        const byKey = Object.fromEntries(body.recommendation.factors.map((factor) => [factor.key, factor.value]));
        expect(byKey.score).toBe(24);
        expect(byKey.leave).toBeCloseTo(8.5, 5);
        expect(byKey.potential).toBeCloseTo(6.2, 5);
        expect(byKey.oppReply).toBeCloseTo(12.1, 5);
        expect(byKey.risk).toBeCloseTo(3.2, 5);
    });
    it("omits the risk factor on the greedy path, which never sampled", async () => {
        const { call } = harness({
            engine: async () => fakeEngineResponse({
                solver: "greedy",
                candidates: fakeEngineResponse().candidates?.map((candidate) => ({
                    ...candidate,
                    stddev: 0,
                    potential: 0,
                })),
            }),
        });
        const body = (await (await call("/analysis", { expectedRevision: 7 })).json());
        expect(body.method.solver).toBe("greedy");
        const keys = body.recommendation.factors.map((factor) => factor.key);
        expect(keys).not.toContain("risk");
        expect(keys).not.toContain("potential");
    });
    it("describes an endgame result as proven rather than estimated", async () => {
        const { call } = harness({
            engine: async () => fakeEngineResponse({
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
        const body = (await (await call("/analysis", { expectedRevision: 7 })).json());
        expect(body.method.proven).toBe(true);
        expect(body.recommendation.provenMargin).toBe(18);
        expect(body.summary).toContain("solve exactly");
    });
    it("says so when the search was cut short instead of presenting it as settled", async () => {
        const { call } = harness({
            engine: async () => fakeEngineResponse({
                stats: { moves: 10, nodes: 10, elapsedMs: 10, candidates: 3, samples: 2 },
            }),
        });
        const body = (await (await call("/analysis", { expectedRevision: 7 })).json());
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
        const request = runEngine.mock.calls[0]?.[0]?.request;
        expect(request.sampleCap).toBe(40);
        expect(request.topN).toBe(16);
    });
    it("derives the same seed for the same position and level", async () => {
        const first = harness();
        await first.call("/analysis", { expectedRevision: 7, level: "normal" });
        const second = harness();
        await second.call("/analysis", { expectedRevision: 7, level: "normal" });
        const seedOf = (h) => (h.runEngine.mock.calls[0]?.[0]?.request).seed;
        expect(seedOf(first)).toBe(seedOf(second));
    });
    it("derives a different seed once the game advances", async () => {
        const first = harness({ source: { revision: 7 } });
        await first.call("/analysis", { expectedRevision: 7, level: "normal" });
        const second = harness({ source: { revision: 8 } });
        await second.call("/analysis", { expectedRevision: 8, level: "normal" });
        const seedOf = (h) => (h.runEngine.mock.calls[0]?.[0]?.request).seed;
        expect(seedOf(first)).not.toBe(seedOf(second));
    });
    it("falls back to the cheapest level when asked for one that does not exist", async () => {
        const { call, runEngine } = harness();
        await call("/analysis", { expectedRevision: 7, level: "ultra-max-please" });
        const request = runEngine.mock.calls[0]?.[0]?.request;
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
        let release;
        const gate = new Promise((resolve) => {
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
    const sse = (call, path, body) => call(path, body, { Accept: "text/event-stream" });
    async function collect(response) {
        const text = await response.text();
        return text
            .split("\n\n")
            .map((block) => block.trim())
            .filter(Boolean)
            .map((block) => {
            const event = /^event:\s*(.+)$/m.exec(block)?.[1] ?? "message";
            const data = /^data:\s*(.+)$/m.exec(block)?.[1] ?? "null";
            return { event, data: JSON.parse(data) };
        });
    }
    it("streams progress and then the result", async () => {
        const { call } = harness({
            engine: (async (options) => {
                options.onProgress?.({
                    phase: "sim",
                    percent: 50,
                    elapsedMs: 900,
                    etaMs: 900,
                    bestScore: 24,
                    detail: "candidates=16 samples=2/4",
                });
                return fakeEngineResponse();
            }),
        });
        const response = await sse(call, "/analysis", { expectedRevision: 7 });
        expect(response.headers.get("Content-Type")).toContain("text/event-stream");
        const events = await collect(response);
        expect(events.map((entry) => entry.event)).toEqual(["progress", "result"]);
        expect(events[1]?.data).toMatchObject({ revision: 7 });
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
        const bodies = (await Promise.all([1, 2, 3].map(async () => (await call("/analysis", { expectedRevision: 7, level: "quick" })).json())));
        const [first, ...rest] = bodies;
        for (const body of rest) {
            expect(body.recommendation.immediateScore).toBe(first?.recommendation.immediateScore);
            expect(body.revision).toBe(first?.revision);
        }
    });
});
//# sourceMappingURL=api.test.js.map