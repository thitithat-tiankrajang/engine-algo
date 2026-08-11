// ── Metering ─────────────────────────────────────────────────────────────────
//
// The queue keeps the SERVER healthy under load. This keeps one user from
// consuming the whole queue while it does so — a service that is perfectly
// stable while one account occupies every slot has still failed everyone else.
//
// Two independent limits, because they fail differently:
//
//   • A cost budget over a sliding window, weighted by how expensive a level
//     actually is. Asking for `max` analysis repeatedly is what has to be
//     expensive to do, and charging by wall-clock potential rather than by
//     request count is the only way to express that.
//   • A cap on concurrent analysis jobs per user, so a single account cannot
//     hold several queue slots at once no matter how much budget it has left.
//
// Bot moves are metered too, but generously: a bot move is a consequence of a
// game the user is legitimately playing, and the turn structure already limits
// how often one can be requested.
//
// In-memory and therefore per-instance. That is honest for a single-instance
// deployment and documented as a limitation for a scaled-out one, where this
// would move to Redis.
export class ComputeBudget {
    #perWindow;
    #windowMs;
    #windows = new Map();
    constructor(options) {
        this.#perWindow = options.perWindow;
        this.#windowMs = options.windowMs;
    }
    /** Charge `cost` to a user. Rejected charges cost nothing, so a user who is
     *  over budget is not pushed further over by retrying. */
    charge(userId, cost, now = Date.now()) {
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
    refund(userId, cost) {
        const window = this.#windows.get(userId);
        if (window)
            window.spent = Math.max(0, window.spent - cost);
    }
    /** Drop windows that have expired. Called on a timer so an idle service does
     *  not hold a map entry per user who ever visited. */
    sweep(now = Date.now()) {
        for (const [userId, window] of this.#windows) {
            if (window.resetAt <= now)
                this.#windows.delete(userId);
        }
    }
    get size() {
        return this.#windows.size;
    }
}
export class ConcurrencyLimit {
    #max;
    #held = new Map();
    constructor(max) {
        this.#max = Math.max(1, max);
    }
    tryAcquire(userId) {
        const held = this.#held.get(userId) ?? 0;
        if (held >= this.#max)
            return false;
        this.#held.set(userId, held + 1);
        return true;
    }
    release(userId) {
        const held = this.#held.get(userId) ?? 0;
        if (held <= 1)
            this.#held.delete(userId);
        else
            this.#held.set(userId, held - 1);
    }
    heldBy(userId) {
        return this.#held.get(userId) ?? 0;
    }
}
//# sourceMappingURL=rateLimit.js.map