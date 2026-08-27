// ── Metering ─────────────────────────────────────────────────────────────────
//
// The queue keeps the SERVER healthy under load. This keeps one user from
// consuming the whole queue while it does so — a service that is perfectly
// stable while one account occupies every slot has still failed everyone else.
//
// Two independent limits, because they fail differently:
//
//   • A cost budget over a sliding window, weighted by how expensive the work
//     actually is — charging by wall-clock potential rather than by request
//     count is the only way to express that a `max` search is not one request.
//   • A cap on concurrent jobs per user, so a single account cannot hold
//     several queue slots at once no matter how much budget it has left.
//
// WHO each applies to is `app.ts`'s decision, not this file's. Today the
// concurrency cap governs analysis — one in flight per account, queued or
// running — while the budget governs bot turns, generously, because a bot move
// is a consequence of a game the user is legitimately playing and the turn
// structure already paces it. Analysis is NOT budgeted unless
// `ENGINE_ANALYSIS_BUDGETED` says so: serialising a player's requests is fair,
// running them out of requests mid-game is not. config.ts argues that in full.
//
// In-memory and therefore per-instance. That is honest for a single-instance
// deployment and documented as a limitation for a scaled-out one, where this
// would move to Redis.

export type BudgetDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; remaining: number; retryAfterMs: number };

type Window = { spent: number; resetAt: number };

export class ComputeBudget {
  readonly #perWindow: number;
  readonly #windowMs: number;
  readonly #windows = new Map<string, Window>();

  readonly #enforced: boolean;

  constructor(options: { perWindow: number; windowMs: number; enforced?: boolean }) {
    this.#perWindow = options.perWindow;
    this.#windowMs = options.windowMs;
    this.#enforced = options.enforced ?? true;
  }

  /** Charge `cost` to a user. Rejected charges cost nothing, so a user who is
   *  over budget is not pushed further over by retrying. */
  charge(userId: string, cost: number, now = Date.now()): BudgetDecision {
    // Handled here rather than at each call site so that every path — charge,
    // refund, the remaining-budget read, and any path added later — agrees
    // about whether metering is on. A conditional per call site is how one of
    // them ends up still charging.
    if (!this.#enforced) return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    const window = this.#windows.get(userId);
    if (!window || window.resetAt <= now) {
      this.#windows.set(userId, { spent: cost, resetAt: now + this.#windowMs });
      return { allowed: true, remaining: this.#perWindow - cost };
    }
    if (window.spent + cost > this.#perWindow) {
      return {
        allowed: false,
        remaining: Math.max(0, this.#perWindow - window.spent),
        retryAfterMs: window.resetAt - now,
      };
    }
    window.spent += cost;
    return { allowed: true, remaining: this.#perWindow - window.spent };
  }

  /** Hand budget back when work was refused before it ran. */
  refund(userId: string, cost: number): void {
    const window = this.#windows.get(userId);
    if (window) window.spent = Math.max(0, window.spent - cost);
  }

  /** What a user has left in the current window, without charging anything.
   *  Read-only: for diagnostics and for asserting that attaching to an existing
   *  search costs nothing. */
  remaining(userId: string, now = Date.now()): number {
    if (!this.#enforced) return Number.POSITIVE_INFINITY;
    const window = this.#windows.get(userId);
    if (!window || window.resetAt <= now) return this.#perWindow;
    return Math.max(0, this.#perWindow - window.spent);
  }

  /** Drop windows that have expired. Called on a timer so an idle service does
   *  not hold a map entry per user who ever visited. */
  sweep(now = Date.now()): void {
    for (const [userId, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(userId);
    }
  }

  get size(): number {
    return this.#windows.size;
  }
}

export class ConcurrencyLimit {
  readonly #max: number;
  readonly #held = new Map<string, number>();

  constructor(max: number) {
    this.#max = Math.max(1, max);
  }

  tryAcquire(userId: string): boolean {
    const held = this.#held.get(userId) ?? 0;
    if (held >= this.#max) return false;
    this.#held.set(userId, held + 1);
    return true;
  }

  release(userId: string): void {
    const held = this.#held.get(userId) ?? 0;
    if (held <= 1) this.#held.delete(userId);
    else this.#held.set(userId, held - 1);
  }

  heldBy(userId: string): number {
    return this.#held.get(userId) ?? 0;
  }
}
