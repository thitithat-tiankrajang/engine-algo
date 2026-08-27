// The two endpoints the client-side Super bot needs, and the promises they make.
//
// `/v1/bot-config` is the rollout switch and the versioned tuning. What it must
// never do is answer a request for one weights version with a different one:
// a game pinned to `v1` that silently receives `v2` was played by two
// opponents, and nothing written afterwards can say which move belonged to
// which.
//
// `/bot-move/validate` is what is left of server-side verification once the
// search moved to the device. It checks legality against the position the
// server actually holds, and deliberately nothing more — proving the move is
// the one the engine would have chosen means running the search again, which is
// the exact cost the client-side path exists to remove.
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { EngineQueue } from "../src/queue.js";
import { JobRegistry } from "../src/jobRegistry.js";
import { ComputeBudget, ConcurrencyLimit } from "../src/rateLimit.js";
import { SUPER_ENGINE_VERSION, SUPER_WEIGHTS_VERSION } from "../src/superConfig.js";
import { GAME_ID, baseConfig, fakeSource, fakeVerify, type FakeSourceOptions } from "./helpers.js";

type Overrides = {
  source?: FakeSourceOptions;
  config?: Record<string, unknown>;
  validation?: () => Promise<{ valid: boolean; score: number; reason?: string }>;
};

function harness(overrides: Overrides = {}) {
  const config = baseConfig(overrides.config) as ReturnType<typeof baseConfig> &
    Parameters<typeof createApp>[0]["config"];
  const queue = new EngineQueue({
    concurrency: config.concurrency,
    maxWaiting: config.maxWaiting,
    maxWaitMs: config.maxQueueWaitMs,
  });
  const runValidation = vi.fn<(options: { request: Record<string, unknown> }) => Promise<unknown>>(
    overrides.validation ?? (async () => ({ valid: true, score: 12 })),
  );
  const app = createApp({
    config,
    source: fakeSource(overrides.source),
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
    runValidation: runValidation as unknown as Parameters<typeof createApp>[0]["runValidation"],
    verifyToken: fakeVerify,
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { Authorization: "Bearer token-1", ...headers } });

  const validate = (body: unknown) =>
    app.request(`/v1/games/${GAME_ID}/bot-move/validate`, {
      method: "POST",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  return { app, get, validate, runValidation };
}

/** The user id `fakeVerify` hands back for `Bearer token-1`. */
const HARNESS_USER_ID = "user-1";

/** A deployment where the calling user IS a Champion — both halves of the gate
 *  agreeing, which is the only combination that serves the local path. */
function champion(overrides: Overrides = {}) {
  return harness({
    ...overrides,
    config: {
      clientSideSuper: true,
      clientSideSuperUserIds: [HARNESS_USER_ID],
      ...overrides.config,
    },
  });
}

/** A bot room whose turn belongs to the engine — the only state in which any of
 *  this is reachable. */
const BOT_TURN: FakeSourceOptions = {
  botSide: "B",
  botDifficulty: "super",
  activeSide: "B",
};

describe("GET /v1/bot-config", () => {
  it("requires a signed-in caller", async () => {
    const { app } = harness();
    const response = await app.request("/v1/bot-config");
    expect(response.status).toBe(401);
  });

  it("reports the rollout flag as the deployment has it", async () => {
    const off = await harness().get("/v1/bot-config");
    expect(await off.json()).toMatchObject({ clientSuperEnabled: false });

    const on = await champion().get("/v1/bot-config");
    expect(await on.json()).toMatchObject({ clientSuperEnabled: true });
  });

  // ── who gets the beta ─────────────────────────────────────────────────────
  //
  // The rollout is Champions-only, and `clientSuperEnabled` is the single field
  // that decides whether a browser computes Super moves. These tests are the
  // guard on the audience, and the reason they are worth having is that the
  // failure they prevent is silent and total: a deployment-wide boolean, once
  // flipped, hands the local path to every signed-in player at once and nothing
  // in the flag itself records that it happened.

  it("refuses a signed-in user who is not a Champion", async () => {
    const response = await harness({
      config: { clientSideSuper: true, clientSideSuperUserIds: ["someone-else"] },
    }).get("/v1/bot-config");
    // Not an error — a general user is not being refused a game, only the local
    // engine. They play the backend path, which is untouched.
    expect(await response.json()).toMatchObject({ clientSuperEnabled: false });
  });

  it("serves NOBODY when the flag is on but no audience is set", async () => {
    // The fail-closed default, and the one most worth pinning down: setting
    // CLIENT_SIDE_SUPER=true and forgetting the allowlist must reach zero
    // players, not all of them.
    const response = await harness({ config: { clientSideSuper: true } }).get("/v1/bot-config");
    expect(await response.json()).toMatchObject({ clientSuperEnabled: false });
  });

  it("refuses a Champion when the master switch is off", async () => {
    // Both halves have to agree. The switch is what an operator reaches for
    // when the client-side path misbehaves, and an allowlist that could
    // override it would make that reach useless.
    const response = await harness({
      config: { clientSideSuper: false, clientSideSuperUserIds: [HARNESS_USER_ID] },
    }).get("/v1/bot-config");
    expect(await response.json()).toMatchObject({ clientSuperEnabled: false });
  });

  it("matches a Champion id case-insensitively", async () => {
    // Supabase user ids are UUIDs, which get pasted into a dashboard by hand in
    // whatever case the source happened to use. A Champion silently left out of
    // their own beta because someone upper-cased a UUID is a bad afternoon.
    const response = await harness({
      config: { clientSideSuper: true, clientSideSuperUserIds: [HARNESS_USER_ID.toUpperCase()] },
    }).get("/v1/bot-config");
    expect(await response.json()).toMatchObject({ clientSuperEnabled: true });
  });

  it("opens the path to everyone only when `*` is spelled out", async () => {
    const response = await harness({
      config: { clientSideSuper: true, clientSideSuperUserIds: ["*"] },
    }).get("/v1/bot-config");
    expect(await response.json()).toMatchObject({ clientSuperEnabled: true });
  });

  it("names the versions a new game will be pinned to", async () => {
    const response = await champion().get("/v1/bot-config");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.engineVersion).toBe(SUPER_ENGINE_VERSION);
    expect(body.weightsVersion).toBe(SUPER_WEIGHTS_VERSION);
    expect(body.weights).toBeTypeOf("object");
  });

  it("carries what a client needs to predict its own full-Super wait", async () => {
    const response = await harness().get("/v1/bot-config");
    const body = (await response.json()) as {
      calibration: {
        benchmark: string;
        reference: {
          nodesPerSec: number;
          fullSuper: { p50Ms: number; p95Ms: number; positions: number };
        };
        tiers: Array<{ tier: string; maxEstimatedMoveMs: number | null }>;
        warnAboveMs: number;
        adaptiveBudget: {
          enabled: boolean;
          budgets: Array<{ sampleCap: number | null; p50Ms: number; p95Ms: number }>;
          targets: { p50Ms: number; p95Ms: number };
        };
      };
    };
    // The benchmark is NAMED because a throughput number only means something
    // against the same work. A client holding a cached measurement from a
    // different benchmark must re-measure rather than compare.
    expect(body.calibration.benchmark).toBe("gen-nodes-v1");
    expect(body.calibration.reference.nodesPerSec).toBeGreaterThan(0);

    // ONE latency, and it is the full schedule's — because the full schedule is
    // the only one any device runs. A table of per-budget latencies is what a
    // per-device budget is built out of, and serving one invites the client to
    // start choosing again.
    const { fullSuper } = body.calibration.reference;
    expect(fullSuper.p50Ms).toBeGreaterThan(0);
    expect(fullSuper.p95Ms).toBeGreaterThanOrEqual(fullSuper.p50Ms);
    // How many positions the quantiles came from, so a reader can tell a p95
    // worth trusting from one taken over a handful of moves.
    expect(fullSuper.positions).toBeGreaterThan(0);

    // A threshold for a line of COPY. That it is the only number of its kind at
    // this level is the point — see the next test.
    expect(body.calibration.warnAboveMs).toBeGreaterThan(0);

    // The bands must be ordered and open-ended at the top, or a slow enough
    // device would fall off the end of the table and be tiered as nothing.
    const bounds = body.calibration.tiers.map((band) => band.maxEstimatedMoveMs);
    expect(bounds[bounds.length - 1]).toBeNull();
  });

  it("puts no latency target and no tier gate on the Super path", async () => {
    // Super is the strongest bot on offer and searches exhaustively; that is
    // what makes it Super. A latency target reachable from the default path is
    // how the schedule came to be chosen to fit a stopwatch the first time, and
    // a `minimumTier` is how a device came to be refused for being slow.
    //
    // Neither belongs here. A player who does not want to wait picks a weaker
    // bot — `max`, `hard` or `medium` — which is a choice they make rather than
    // one their hardware makes for them.
    const response = await harness().get("/v1/bot-config");
    const calibration = ((await response.json()) as { calibration: Record<string, unknown> })
      .calibration;
    expect("targets" in calibration).toBe(false);
    expect("minimumTier" in calibration).toBe(false);

    // The targets still exist — inside the flagged experiment, which is the one
    // place fitting a schedule to a clock is a legitimate thing to be doing.
    const adaptive = calibration.adaptiveBudget as { enabled: boolean; targets: unknown };
    expect(adaptive.enabled).toBe(false);
    expect(adaptive.targets).toBeDefined();
  });

  it("ships the reduced-sample budget switched OFF", async () => {
    // The single most important assertion in this file.
    //
    // A reduced sample budget is a change to how STRONG the bot plays, not to
    // how long it takes, and nobody has measured what the change is worth. An
    // earlier revision shipped it as the default and a reference-speed M3 ended
    // up playing 8 of Super's 160 samples against a backend fallback that
    // played all 160 — no error, no warning, just a weaker opponent on slower
    // hardware. If this assertion ever fails, that is back.
    const response = await harness().get("/v1/bot-config");
    const body = (await response.json()) as {
      calibration: {
        adaptiveBudget: {
          enabled: boolean;
          budgets: Array<{ sampleCap: number | null; p50Ms: number; p95Ms: number }>;
        };
      };
    };
    expect(body.calibration.adaptiveBudget.enabled).toBe(false);

    // The measurements themselves are kept — they are real, and a future
    // strength experiment would need the latency half of the comparison — but
    // kept is all they are while the flag is off.
    const { budgets } = body.calibration.adaptiveBudget;
    expect(budgets.length).toBeGreaterThan(1);
    for (const budget of budgets) {
      expect(budget.p50Ms).toBeGreaterThan(0);
      expect(budget.p95Ms).toBeGreaterThanOrEqual(budget.p50Ms);
    }
  });

  it("tiers the reference device against its own full-Super measurement", async () => {
    // The reference sits at ratio 1.0, so its estimate IS the served
    // full-Super latency and it must land in one of the published bands. A
    // device falling off the end of the table would be tiered as nothing.
    //
    // Note what is NOT asserted: that the band is a good one. The reference M3
    // takes ~225s a move and lands in `SLOW`, and that is the honest finding
    // rather than a configuration error — full Super is minutes of single-core
    // work. Nothing follows from the tier except a line of copy.
    const response = await harness().get("/v1/bot-config");
    const body = (await response.json()) as {
      calibration: {
        reference: { fullSuper: { p50Ms: number } };
        tiers: Array<{ tier: string; maxEstimatedMoveMs: number | null }>;
      };
    };
    const { fullSuper } = body.calibration.reference;
    const band = body.calibration.tiers.find(
      (candidate) =>
        candidate.maxEstimatedMoveMs === null || fullSuper.p50Ms <= candidate.maxEstimatedMoveMs,
    );
    expect(band).toBeDefined();
  });

  it("serves a specific weights version when asked for one", async () => {
    const response = await harness().get(
      `/v1/bot-config?weightsVersion=${SUPER_WEIGHTS_VERSION}`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { weightsVersion: string }).toMatchObject({
      weightsVersion: SUPER_WEIGHTS_VERSION,
    });
  });

  it("REFUSES a weights version it does not carry rather than substituting one", async () => {
    // The whole value of pinning. Answering with different weights under the
    // requested version's name would make a finished game unreproducible and
    // would do it silently.
    const response = await harness().get("/v1/bot-config?weightsVersion=v99");
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "bad_request" });
  });
});

describe("POST /bot-move/validate", () => {
  it("answers with the engine's verdict, against server-held state", async () => {
    const { validate, runValidation } = harness({ source: BOT_TURN });
    const response = await validate({
      expectedRevision: 7,
      move: { type: "place", placements: [{ r: 7, c: 7, kind: "5", token: "5" }], exchange: [] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valid: true, score: 12, revision: 7, side: "B" });

    // The request the engine received is built from canonical state, and the
    // caller contributed only the move. A board or rack supplied by the client
    // would let an illegal move be validated against a position on which it
    // would be legal.
    const sent = runValidation.mock.calls[0]![0].request as Record<string, unknown>;
    expect(sent.mode).toBe("validate");
    expect(sent.board).toBeInstanceOf(Array);
    expect(sent.rack).toBeInstanceOf(Array);
    expect(sent.move).toBeTruthy();
  });

  it("runs NO search — no budget, no queue, no sampling", async () => {
    const { validate, runValidation } = harness({ source: BOT_TURN });
    await validate({ expectedRevision: 7, move: { type: "pass", placements: [], exchange: [] } });
    const sent = runValidation.mock.calls[0]![0].request as Record<string, unknown>;
    // A budget or a sample cap here would mean somebody had made this endpoint
    // think. It must not: it is the cheap half of what the server can still say
    // about a move the device computed.
    expect(sent.budgetMs).toBeUndefined();
    expect(sent.unlimited).toBeUndefined();
    expect(sent.sampleCap).toBeUndefined();
  });

  it("reports an illegal move as a successful call, not a failure", async () => {
    // `valid: false` is an answer. Turning it into a 5xx would make the client
    // retry a move that will never become legal.
    const { validate } = harness({
      source: BOT_TURN,
      validation: async () => ({ valid: false, score: 0, reason: "New tiles must connect." }),
    });
    const response = await validate({
      expectedRevision: 7,
      move: { type: "place", placements: [{ r: 0, c: 0, kind: "5", token: "5" }], exchange: [] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valid: false, reason: "New tiles must connect." });
  });

  it("refuses a move composed against a revision the game has left", async () => {
    const { validate } = harness({ source: BOT_TURN });
    const response = await validate({
      expectedRevision: 3,
      move: { type: "pass", placements: [], exchange: [] },
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "stale_revision" });
  });

  it("refuses when it is not the engine's turn", async () => {
    const { validate } = harness({
      source: { botSide: "B", botDifficulty: "super", activeSide: "A" },
    });
    const response = await validate({
      expectedRevision: 7,
      move: { type: "pass", placements: [], exchange: [] },
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "turn_rule" });
  });

  it("refuses a caller who does not control the game", async () => {
    const { validate } = harness({
      source: { ...BOT_TURN, callerControlsActiveSide: false },
    });
    const response = await validate({
      expectedRevision: 7,
      move: { type: "pass", placements: [], exchange: [] },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a request with no move in it", async () => {
    const { validate } = harness({ source: BOT_TURN });
    const response = await validate({ expectedRevision: 7 });
    expect(response.status).toBe(400);
  });
});

describe("/health", () => {
  it("says whether client-side Super is enabled and what it would hand out", async () => {
    const { app } = harness({ config: { clientSideSuper: true } });
    const body = (await (await app.request("/health")).json()) as {
      clientSuper: {
        enabled: boolean;
        audience: string;
        engineVersion: string;
        weightsVersion: string;
        adaptiveBudget: string;
      };
    };
    expect(body.clientSuper).toEqual({
      enabled: true,
      // The switch is on and nobody is listed, which is a live misconfiguration
      // rather than a working rollout — so /health says so in words instead of
      // reporting a cheerful `enabled: true` that reaches no one.
      audience: "nobody (no CLIENT_SIDE_SUPER_USER_IDS set)",
      engineVersion: SUPER_ENGINE_VERSION,
      weightsVersion: SUPER_WEIGHTS_VERSION,
      // The one switch that changes how STRONG the client-side bot plays.
      // Readable off /health so an operator never has to inspect an environment
      // to find out whether Super is running at full strength.
      adaptiveBudget: "off",
    });
  });

  it("shouts on /health when the strength-reducing experiment is on", async () => {
    const { app } = harness({
      config: { clientSideSuper: true, superAdaptiveBudget: true },
    });
    const body = (await (await app.request("/health")).json()) as {
      clientSuper: { adaptiveBudget: string };
    };
    // Deliberately not a bare `true`. An operator scanning /health should not
    // have to know what "adaptiveBudget: true" implies about the bot.
    expect(body.clientSuper.adaptiveBudget).toBe("ON (reduces Super strength)");
  });
});
