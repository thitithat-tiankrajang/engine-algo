// The adapter is the correctness boundary: if it disagrees with what the
// browser used to compute, the bot plays a different game after the migration.
// These tests pin the fields that were easy to get subtly wrong.
import { describe, expect, it } from "vitest";

import { exchangeAllowed, noScoreStreak, seedFor, toEngineRequest } from "../src/adapter.js";
import { parseCanonical, CanonicalStateError, bagSize, rackTokens } from "../src/canonical.js";
import { buildCanonicalPayload, buildInventory } from "./helpers.js";

describe("canonical parsing", () => {
  it("accepts a lawful hundred-tile position", () => {
    const state = parseCanonical(buildCanonicalPayload());
    expect(state.inventory).toHaveLength(100);
    expect(state.activeSide).toBe("A");
  });

  it("refuses a position that is not the physical set", () => {
    const payload = buildCanonicalPayload();
    (payload.inventory as unknown[]).pop();
    expect(() => parseCanonical(payload)).toThrow(CanonicalStateError);
  });

  it("refuses two tiles on one square rather than picking a winner", () => {
    const inventory = buildInventory({
      board: [
        { token: "5", row: 7, col: 7, by: "A" },
        { token: "6", row: 7, col: 7, by: "A" },
      ],
    });
    expect(() => parseCanonical({ ...buildCanonicalPayload(), inventory })).toThrow(
      /Two tiles occupy square/,
    );
  });

  it("refuses a tile off the board", () => {
    const inventory = buildInventory({ board: [{ token: "5", row: 7, col: 7, by: "A" }] });
    inventory[inventory.findIndex((entry) => entry.at === "board")] = {
      at: "board",
      row: 40,
      col: 2,
      placedTurn: 1,
      by: "A",
    };
    expect(() => parseCanonical({ ...buildCanonicalPayload(), inventory })).toThrow(
      /outside the board/,
    );
  });
});

describe("engine request", () => {
  const state = parseCanonical(
    buildCanonicalPayload({
      activeSide: "A",
      rackA: ["1", "2", "3", "+", "=", "5", "9", "?"],
      rackB: ["4", "6", "7", "8"],
      board: [
        { token: "2", row: 7, col: 6, by: "B" },
        { token: "+", row: 7, col: 7, by: "B" },
        { token: "?", row: 7, col: 8, by: "B", assigned: "3" },
      ],
      scores: { A: 30, B: 25 },
    }),
  );

  const request = toEngineRequest(state, {
    side: "A",
    difficulty: "hard",
    budgetMs: 4000,
    events: [],
  });

  it("hands over only the analysed side's rack", () => {
    expect([...request.rack].sort()).toEqual([...rackTokens(state, "A")].sort());
    expect(request.rack).toHaveLength(8);
  });

  it("reduces the opponent to a count", () => {
    expect(request.oppRackCount).toBe(4);
    expect(JSON.stringify(request)).not.toContain("oppRack\":[");
  });

  it("distinguishes a blank's tile kind from the face it is played as", () => {
    const blank = request.board.find((cell) => cell.kind === "?");
    expect(blank).toBeTruthy();
    expect(blank?.token).toBe("3");
  });

  it("scores from the analysed side's point of view", () => {
    expect(request.myScore).toBe(30);
    expect(request.oppScore).toBe(25);
  });

  it("counts tiles awaiting return as still unseen", () => {
    // This is what keeps `unseen.total == oppRackCount + bagCount`, the exact
    // predicate the engine uses to decide a position is endgame-eligible.
    const withPending = parseCanonical({
      ...buildCanonicalPayload({ rackA: ["1"], rackB: ["2"] }),
    });
    const inventory = [...withPending.inventory];
    const bagIndex = inventory.findIndex((entry) => entry.at === "bag");
    inventory[bagIndex] = { at: "pendingReturn", side: "B", seq: 0 };
    const patched = { ...withPending, inventory };
    const built = toEngineRequest(patched, { side: "A", difficulty: "max", events: [] });
    expect(built.bagCount).toBe(bagSize(patched) + 1);
  });

  it("orders board cells stably so the same position produces the same bytes", () => {
    const again = toEngineRequest(state, {
      side: "A",
      difficulty: "hard",
      budgetMs: 4000,
      events: [],
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(request));
  });

  it("omits budgetMs entirely when the tier does not set one", () => {
    // `max` sends none so the engine falls back to its own ceilings — sending 0
    // would silently mean "no budget" and change how the engine reads it.
    const maxRequest = toEngineRequest(state, { side: "A", difficulty: "max", events: [] });
    expect("budgetMs" in maxRequest).toBe(false);
  });

  it("passes the tier's solver through, and omits it when unset", () => {
    // Which decision procedure to run is stated, not inferred from budgetMs.
    // Inferring it is what let a 200 ms tier cost ~2.9 s a move: the sampling
    // search cannot return before three complete opponent samples, so its
    // budget was advice it was unable to take.
    const staticRequest = toEngineRequest(state, {
      side: "A",
      difficulty: "static",
      solver: "static",
      budgetMs: 200,
      events: [],
    });
    expect(staticRequest.solver).toBe("static");
    // Callers that say nothing keep the engine's default (the sampling search),
    // so adding the field changed no existing path.
    expect("solver" in request).toBe(false);
  });

  it("passes `unlimited` only when the tier asks for it", () => {
    // The flag has to be ABSENT rather than false for every other tier: the
    // engine reads presence, and a stray `unlimited: false` on the hot path
    // would be one more thing to get wrong later.
    const superRequest = toEngineRequest(state, {
      side: "A",
      difficulty: "super",
      unlimited: true,
      events: [],
    });
    expect(superRequest.unlimited).toBe(true);
    expect("unlimited" in request).toBe(false);
    expect(
      "unlimited" in
        toEngineRequest(state, { side: "A", difficulty: "max", unlimited: false, events: [] }),
    ).toBe(false);
  });
});

describe("exchange rule", () => {
  const withCounts = (rackB: number, bagKeep: number) => {
    const payload = buildCanonicalPayload({
      activeSide: "A",
      rackA: ["1", "2", "3", "4", "5", "6", "7", "8"],
      rackB: Array.from({ length: rackB }, () => "=" as const),
    });
    const state = parseCanonical(payload);
    // Park everything except `bagKeep` bag tiles on the board so the reserve
    // arithmetic has something to bite on.
    const inventory = [...state.inventory];
    let seen = 0;
    let row = 0;
    let col = 0;
    for (let ordinal = 0; ordinal < inventory.length; ordinal += 1) {
      if (inventory[ordinal]?.at !== "bag") continue;
      seen += 1;
      if (seen <= bagKeep) continue;
      inventory[ordinal] = { at: "board", row, col, placedTurn: 1, by: "B" };
      col += 1;
      if (col === 15) {
        col = 0;
        row += 1;
      }
    }
    return { ...state, inventory };
  };

  it("mirrors the client rule: bag + opponent rack - 8 >= 5", () => {
    expect(exchangeAllowed(withCounts(8, 5))).toBe(true);
    expect(exchangeAllowed(withCounts(8, 4))).toBe(false);
    expect(exchangeAllowed(withCounts(4, 9))).toBe(true);
    expect(exchangeAllowed(withCounts(0, 12))).toBe(false);
  });

  it("uses the bag alone in solo, as the client does", () => {
    const versus = withCounts(8, 5);
    expect(exchangeAllowed({ ...versus, gameMode: "solo" })).toBe(true);
    const thin = withCounts(8, 4);
    expect(exchangeAllowed({ ...thin, gameMode: "solo" })).toBe(false);
  });
});

describe("scoreless streak", () => {
  it("counts the trailing run of passes and exchanges", () => {
    expect(noScoreStreak([{ kind: "place" }, { kind: "pass" }, { kind: "exchange" }])).toBe(2);
  });

  it("stops at the last scoring play", () => {
    expect(noScoreStreak([{ kind: "pass" }, { kind: "place" }, { kind: "pass" }])).toBe(1);
  });

  it("looks through bookkeeping commands that are not turns", () => {
    // A refill sits between an exchange and the next action; treating it as a
    // turn would reset the streak and stop a game from ever ending on it.
    expect(
      noScoreStreak([
        { kind: "place" },
        { kind: "pass" },
        { kind: "refill" },
        { kind: "exchange" },
        { kind: "refill" },
      ]),
    ).toBe(2);
  });

  it("is zero on a fresh game", () => {
    expect(noScoreStreak([])).toBe(0);
  });
});

describe("seed", () => {
  it("is stable for a position", () => {
    expect(seedFor("game-1", 12)).toBe(seedFor("game-1", 12));
  });

  it("changes when the game advances", () => {
    expect(seedFor("game-1", 12)).not.toBe(seedFor("game-1", 13));
  });

  it("separates games", () => {
    expect(seedFor("game-1", 12)).not.toBe(seedFor("game-2", 12));
  });

  it("separates analysis levels, so one level is not the other's cache", () => {
    expect(seedFor("g", 1, "analysis:quick")).not.toBe(seedFor("g", 1, "analysis:deep"));
  });

  it("stays inside the engine's accepted range", () => {
    for (let revision = 0; revision < 200; revision += 1) {
      const seed = seedFor("some-game-id", revision);
      expect(seed).toBeGreaterThan(0);
      expect(seed).toBeLessThan(2147483647);
    }
  });
});
