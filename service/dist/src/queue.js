// ── The compute queue ────────────────────────────────────────────────────────
//
// The engine is CPU-bound and can run for minutes. Left unmanaged, a handful of
// simultaneous requests would take every core and the HTTP server would stop
// answering — the failure the brief calls "one engine request starving the whole
// backend". So every engine run goes through here, and three properties are
// enforced structurally rather than by convention:
//
//   BOUNDED   At most `concurrency` engine processes exist at once, chosen well
//             below the core count so the event loop always has a core to
//             answer health checks and cancellations on.
//   ORDERED   Waiting work is served by priority, then by arrival. Bot turns
//             carry priority 0, so active gameplay is never queued behind a
//             study request no matter how much analysis is pending.
//   BOUNDED   The queue itself has a ceiling. Past it, work is REFUSED rather
//   AGAIN     than accepted into a line that will never be reached — a request
//             that will time out anyway is better declined immediately.
//
// Deduplication lives here too: two callers asking for the same computation
// share one run. That is both a fairness measure and the mechanism that makes a
// re-asked analysis return the same answer instead of recomputing it.
export class QueueFullError extends Error {
    waiting;
    name = "QueueFullError";
    constructor(waiting) {
        super(`The engine queue is full (${waiting} waiting).`);
        this.waiting = waiting;
    }
}
export class EngineQueue {
    #concurrency;
    #maxWaiting;
    #running = 0;
    #sequence = 0;
    #waiting = [];
    /** Live runs by key, so identical work is shared rather than duplicated. */
    #inflight = new Map();
    constructor(options) {
        this.#concurrency = Math.max(1, options.concurrency);
        this.#maxWaiting = Math.max(1, options.maxWaiting);
    }
    stats() {
        return { running: this.#running, waiting: this.#waiting.length, concurrency: this.#concurrency };
    }
    /** How many callers are attached to a live run, or 0 if it is not running. */
    refsFor(key) {
        return this.#inflight.get(key)?.refs ?? 0;
    }
    /**
     * Submit work, or attach to the identical work already in flight.
     *
     * The returned promise is per-caller; the underlying run is shared. A caller
     * that goes away decrements the reference count, and the engine process is
     * cancelled only when the LAST interested caller has gone. One player
     * navigating away must not cancel the analysis their opponent is watching.
     */
    submit(task, callerSignal) {
        const existing = this.#inflight.get(task.key);
        if (existing) {
            existing.refs += 1;
            return this.#attach(task.key, existing.promise, callerSignal);
        }
        if (this.#waiting.length >= this.#maxWaiting) {
            return Promise.reject(new QueueFullError(this.#waiting.length));
        }
        const controller = new AbortController();
        const promise = new Promise((resolve, reject) => {
            const entry = {
                key: task.key,
                priority: task.priority,
                sequence: this.#sequence++,
                start: () => {
                    this.#running += 1;
                    task
                        .run(controller.signal)
                        .then(resolve, reject)
                        .finally(() => {
                        this.#running -= 1;
                        this.#inflight.delete(task.key);
                        this.#pump();
                    });
                },
            };
            this.#waiting.push(entry);
            this.#pump();
        });
        // Nothing else observes this promise, so an unhandled rejection here would
        // be reported against the shared run rather than against a caller.
        promise.catch(() => { });
        this.#inflight.set(task.key, { promise, controller, refs: 1 });
        return this.#attach(task.key, promise, callerSignal);
    }
    /** Cancel a live run regardless of reference count. Used by an explicit
     *  cancel request from the caller that owns the job. */
    cancel(key) {
        const entry = this.#inflight.get(key);
        if (!entry) {
            // Still queued: drop it before it ever starts.
            const index = this.#waiting.findIndex((candidate) => candidate.key === key);
            if (index < 0)
                return false;
            this.#waiting.splice(index, 1);
            return true;
        }
        entry.controller.abort();
        return true;
    }
    #attach(key, promise, callerSignal) {
        if (!callerSignal)
            return promise;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            const entry = this.#inflight.get(key);
            if (!entry)
                return;
            entry.refs -= 1;
            if (entry.refs <= 0)
                entry.controller.abort();
        };
        const onAbort = () => release();
        if (callerSignal.aborted) {
            release();
        }
        else {
            callerSignal.addEventListener("abort", onAbort, { once: true });
        }
        return promise.finally(() => {
            callerSignal.removeEventListener("abort", onAbort);
            released = true; // the run is over; releasing now would abort a fresh run
        });
    }
    #pump() {
        while (this.#running < this.#concurrency && this.#waiting.length > 0) {
            // Priority first, arrival order within a priority. Sorting on pump rather
            // than on insert keeps submission O(1) and the queue short by design.
            this.#waiting.sort((first, second) => first.priority - second.priority || first.sequence - second.sequence);
            const next = this.#waiting.shift();
            if (!next)
                return;
            next.start();
        }
    }
}
//# sourceMappingURL=queue.js.map