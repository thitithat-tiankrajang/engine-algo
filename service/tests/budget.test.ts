// The compute budget, sized against the thing it meters.
//
// It exists to stop one account owning a shared instance's CPU. What it must
// never do is refuse a player who is taking turns, because the wall clock has
// already limited them far more than any ration could: a `max` move takes 108
// seconds, so ten minutes buys about five of them however generous the budget.
//
// It used to do exactly that. Every tier was priced by rank rather than by the
// compute it uses — 2 for `medium`, 8 for `max`, a 4x spread for tiers whose
// real cost differs by 32x — so the fast tier ran out of ration first while
// barely touching the CPU, and a player at `medium` was refused mid-game.
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { BOT_TIER_CONFIG, BOT_TIERS } from "../src/levels.js";
import { ComputeBudget } from "../src/rateLimit.js";

/** Bot moves in a long game.
 *
 * Past twenty turns a side, and passes and exchanges add more. Deliberately
 * ABOVE thirty: thirty `medium` moves at the old price came to exactly the old
 * allowance, so a test at thirty sat on the boundary and passed while the
 * player one move further along was refused. */
const MOVES_IN_A_LONG_GAME = 40;

/** Roughly what each tier costs the engine, in seconds, measured at an opening
 *  position on the reference machine. `medium` and `hard` are bounded by the
 *  sampler's three-sample floor rather than by their budgets. */
const ENGINE_SECONDS: Record<string, number> = { medium: 3.4, hard: 3.4, max: 108, super: 143 };

const defaults = loadConfig({
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  ENGINE_ALLOWED_ORIGINS: "https://example.com",
});

describe("what the budget prices", () => {
  it("prices every tier by the compute it uses, not by its rank", () => {
    // One unit is about four engine-seconds. Checked as a RATIO so the table
    // cannot drift back into pricing by name: if a tier costs 30x the compute,
    // it has to cost far more than 4x the units.
    for (const tier of BOT_TIERS) {
      const seconds = ENGINE_SECONDS[tier]!;
      const cost = BOT_TIER_CONFIG[tier].cost;
      const secondsPerUnit = seconds / cost;
      expect(secondsPerUnit, `${tier} is priced at ${secondsPerUnit.toFixed(1)}s per unit`).
        toBeGreaterThan(1.5);
      expect(secondsPerUnit, `${tier} is priced at ${secondsPerUnit.toFixed(1)}s per unit`).
        toBeLessThan(8);
    }
  });
});

describe("a player taking turns", () => {
  it("plays a long game at any tier without being refused", () => {
    // The regression, stated the way the player met it: thirty bot moves.
    for (const tier of BOT_TIERS) {
      const budget = new ComputeBudget({
        perWindow: defaults.budgetPerWindow,
        windowMs: defaults.budgetWindowMs,
      });
      const cost = BOT_TIER_CONFIG[tier].cost;
      // A tier nobody could physically play thirty times inside one window is
      // held to what the clock actually allows.
      const reachable = Math.min(
        MOVES_IN_A_LONG_GAME,
        Math.ceil(defaults.budgetWindowMs / 1000 / ENGINE_SECONDS[tier]!),
      );
      for (let move = 0; move < reachable; move += 1) {
        const decision = budget.charge("player", cost);
        expect(decision.allowed, `${tier} was refused on move ${move + 1} of ${reachable}`).toBe(
          true,
        );
      }
    }
  });

  it("still refuses a caller who is not waiting for its moves", () => {
    // The case the ration is actually for: requests fired in parallel, with
    // nobody waiting for a move before asking for the next one.
    const budget = new ComputeBudget({
      perWindow: defaults.budgetPerWindow,
      windowMs: defaults.budgetWindowMs,
    });
    let refused = false;
    for (let request = 0; request < 5_000 && !refused; request += 1) {
      refused = !budget.charge("script", BOT_TIER_CONFIG.medium.cost).allowed;
    }
    expect(refused).toBe(true);
  });
});

describe("metering turned off", () => {
  it("never refuses, and says so through `remaining`", () => {
    const budget = new ComputeBudget({ perWindow: 1, windowMs: 1_000, enforced: false });
    for (let request = 0; request < 1_000; request += 1) {
      expect(budget.charge("player", 99).allowed).toBe(true);
    }
    expect(budget.remaining("player")).toBe(Number.POSITIVE_INFINITY);
  });

  it("is on unless the environment turns it off, and reads the switch strictly", () => {
    expect(defaults.budgetEnforced).toBe(true);
    expect(
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
        ENGINE_ALLOWED_ORIGINS: "https://example.com",
        ENGINE_BUDGET_ENFORCED: "false",
      }).budgetEnforced,
    ).toBe(false);
    // A typo must not quietly turn metering off.
    expect(() =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
        ENGINE_ALLOWED_ORIGINS: "https://example.com",
        ENGINE_BUDGET_ENFORCED: "nope",
      }),
    ).toThrow();
  });
});
