// Study positions: the one endpoint that takes a position instead of a game id.
//
// Two things are worth testing here and nothing else is interesting. First that
// the position is DERIVED and validated rather than believed — the hidden
// inventory in particular, which is the number a client could otherwise use to
// have the engine reason about a bag that cannot exist. Second that the ranking
// is written down: the whole point of the feature is a record that outlives the
// tab it was requested from.
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { EngineQueue } from "../src/queue.js";
import { JobRegistry } from "../src/jobRegistry.js";
import { ComputeBudget, ConcurrencyLimit } from "../src/rateLimit.js";
import { TILE_TOKENS, type AmathToken } from "../src/canonical.js";
import { StudyPositionError, parseStudyPosition } from "../src/study.js";
import { baseConfig, fakeEngineResponse, fakeSource, fakeVerify } from "./helpers.js";

/** A rack and an empty board, unless a test says otherwise. */
function position(overrides: Record<string, unknown> = {}) {
  return {
    scoreSelf: 40,
    scoreOpponent: 55,
    board: [
      { r: 7, c: 6, kind: "2", token: "2" },
      { r: 7, c: 7, kind: "+", token: "+" },
      { r: 7, c: 8, kind: "3", token: "3" },
      { r: 7, c: 9, kind: "=", token: "=" },
      { r: 7, c: 10, kind: "5", token: "5" },
    ],
    rack: ["1", "2", "3", "+", "=", "5", "9", "?"],
    level: "medium",
    ...overrides,
  };
}

function harness(engine?: () => Promise<ReturnType<typeof fakeEngineResponse>>) {
  const config = baseConfig() as ReturnType<typeof baseConfig> &
    Parameters<typeof createApp>[0]["config"];
  const source = fakeSource();
  const queue = new EngineQueue({
    concurrency: config.concurrency,
    maxWaiting: config.maxWaiting,
    maxWaitMs: config.maxQueueWaitMs,
  });
  const registry = new JobRegistry(queue, {
    analysisResultTtlMs: config.analysisResultTtlMs,
    botResultTtlMs: config.botResultTtlMs,
    maxCached: config.jobCacheMax,
  });
  const runEngine = vi.fn<(options: { request: Record<string, unknown> }) => Promise<unknown>>(
    engine ?? (async () => fakeEngineResponse()),
  );
  const app = createApp({
    config,
    source,
    queue,
    registry,
    budget: new ComputeBudget({
      perWindow: config.budgetPerWindow,
      windowMs: config.budgetWindowMs,
      enforced: config.budgetEnforced,
    }),
    analysisSlots: new ConcurrencyLimit(config.maxAnalysisPerUser),
    runEngine: runEngine as unknown as Parameters<typeof createApp>[0]["runEngine"],
    verifyToken: fakeVerify,
  });

  const study = (body: unknown) =>
    app.request("/v1/study/analysis", {
      method: "POST",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  return { app, study, runEngine, source };
}

describe("reading a study position", () => {
  it("derives a full opponent rack and the rest as bag while tiles remain", () => {
    const parsed = parseStudyPosition(position());
    expect(parsed.oppRackCount).toBe(8);
    // 100 physical tiles, less 5 on the board and 8 in hand, less the
    // opponent's 8.
    expect(parsed.bagCount).toBe(100 - 5 - 8 - 8);
  });

  it("gives the opponent everything left once the bag is empty", () => {
    // 100 - 89 on the board - 8 in hand leaves 3 unseen, which cannot be a full
    // rack. All three are the opponent's, and the bag is empty — the case that
    // puts the engine on its exact end-game path, where the opponent's tiles are
    // known rather than sampled.
    // Built from the real manifest, minus the rack: a board of 89 tiles the set
    // does not actually contain would be refused by the check above, and rightly.
    const rack: AmathToken[] = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const pool = [...TILE_TOKENS];
    for (const token of rack) pool.splice(pool.indexOf(token), 1);
    const board = pool.slice(0, 89).map((kind, index) => ({
      r: Math.floor(index / 15),
      c: index % 15,
      kind,
      token: kind,
    }));
    const parsed = parseStudyPosition(position({ board, rack }));
    expect(parsed.oppRackCount).toBe(3);
    expect(parsed.bagCount).toBe(0);
  });

  it("refuses a position that uses more copies of a tile than exist", () => {
    // The set has four `?`. Asking about a rack of eight is not a hard puzzle,
    // it is a different game.
    expect(() => parseStudyPosition(position({ rack: Array(8).fill("?") }))).toThrow(
      StudyPositionError,
    );
  });

  it("refuses two tiles on one square", () => {
    expect(() =>
      parseStudyPosition(
        position({
          board: [
            { r: 7, c: 7, kind: "1", token: "1" },
            { r: 7, c: 7, kind: "2", token: "2" },
          ],
        }),
      ),
    ).toThrow(StudyPositionError);
  });

  it("refuses a tile the game does not have", () => {
    expect(() => parseStudyPosition(position({ rack: ["1", "%"] }))).toThrow(StudyPositionError);
  });
});

describe("POST /v1/study/analysis", () => {
  it("analyses the position and writes the top ten to the record", async () => {
    const { study, runEngine, source } = harness();
    const response = await study(position());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const candidates = body.candidates as unknown[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(body.recordId).toBe("study-1");
    expect(body.saveError).toBeNull();

    // The record holds the position it was asked about, not just the answer:
    // a ranking nobody can reconstruct the board for is not a study note.
    const saved = source.savedStudies[0];
    expect(saved?.level).toBe("medium");
    expect(saved?.oppRackCount).toBe(8);
    expect(saved?.scoreSelf).toBe(40);
    expect((saved?.candidates as unknown[]).length).toBe(candidates.length);

    // The engine was asked about the caller's rack and the derived inventory —
    // never about a bag the caller named.
    const request = runEngine.mock.calls[0]?.[0].request as Record<string, unknown>;
    expect(request.bagCount).toBe(100 - 5 - 8 - 8);
    expect(request.oppRackCount).toBe(8);
    expect(request.myScore).toBe(40);
    expect(request.oppScore).toBe(55);
  });

  it("ignores a bag the caller tries to name", async () => {
    const { study, runEngine } = harness();
    await study(position({ bagCount: 0, oppRackCount: 0 }));
    const request = runEngine.mock.calls[0]?.[0].request as Record<string, unknown>;
    expect(request.bagCount).toBe(100 - 5 - 8 - 8);
    expect(request.oppRackCount).toBe(8);
  });

  it("refuses a level that is not a bot tier", async () => {
    const { study, runEngine } = harness();
    const response = await study(position({ level: "easy" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("bad_request");
    expect(runEngine).not.toHaveBeenCalled();
  });

  it("still returns the ranking when the record cannot be saved", async () => {
    // The compute is already spent. Losing the answer to a database hiccup is
    // the one failure the player cannot cheaply retry.
    const { study, source } = harness();
    source.saveStudyAnalysis = async () => {
      throw new Error("database unavailable");
    };

    const response = await study(position());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.candidates as unknown[]).length).toBeGreaterThan(0);
    expect(body.recordId).toBeNull();
    expect(body.saveError).toContain("database unavailable");
  });

  it("asks the engine for the position, never for a game", async () => {
    const { study, source } = harness();
    await study(position());
    // `loadContext` is how every game endpoint reaches a room. A study must not
    // touch it: there is no room, and reaching for one would be the bug that
    // lets a position request read a real game.
    expect(source.calls).toBe(0);
  });
});
