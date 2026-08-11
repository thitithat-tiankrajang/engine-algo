// ── The compute queue ────────────────────────────────────────────────────────
//
// The engine is CPU-bound and can run for minutes. Left unmanaged, a handful of
// simultaneous requests would take every core and the HTTP server would stop
// answering — the failure the brief calls "one engine request starving the whole
// backend". So every engine run goes through here, and these properties are
// enforced structurally rather than by convention:
//
//   BOUNDED   At most `concurrency` engine processes exist at once, chosen from
//   RUNNING   the CPU allowance the container actually has (see cpu.ts) so the
//             event loop always keeps enough to answer health checks and
//             cancellations while every search is busy.
//   ORDERED   Waiting work is served by priority, then by arrival. Bot turns
//             carry priority 0, so active gameplay is never queued behind a
//             study request no matter how much analysis is pending.
//   BOUNDED   The queue itself has a ceiling, in DEPTH and in TIME. Past either,
//   WAITING   work is REFUSED rather than accepted into a line that will not be
//             reached in a useful amount of time.
//   OBSERVED  A waiting caller is told it is waiting, and told how many jobs
//             outrank it right now. Nothing here fabricates a completion
//             estimate; the count is a fact about the queue at this instant.
//
// Deduplication lives here too: two callers asking for the same computation
// share one run. That is both a fairness measure and the mechanism that makes a
// re-asked analysis return the same answer instead of recomputing it.
//
// One rule the implementation is built around: **capacity is released the
// moment work stops being wanted**. A cancelled job that is still waiting is
// dropped from the line immediately rather than waiting its turn to be started
// and instantly killed. Under a burst of disconnects the difference is a queue
// full of corpses against a queue that is actually empty.

export type QueuedTask<T> = {
  key: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
};

/** Where a caller's job is, as far as the queue is concerned. */
export type QueuePosition = {
  /** Jobs that will be served before this one, given the queue as it stands.
   *  A later bot turn can still overtake — this is a snapshot, not a promise,
   *  and every change is reported. */
  ahead: number;
  /** `ahead + 1`, for callers that want to say "2nd in line". */
  position: number;
};

/** Lifecycle notifications for one caller. All optional, all best-effort:
 *  nothing here is allowed to affect whether the job runs. */
export type QueueListener = {
  /** The job did not start immediately. Fires at most once per caller. */
  onQueued?: (state: QueuePosition) => void;
  /** The job is still waiting and its place in line changed. */
  onPosition?: (state: QueuePosition) => void;
  /** The engine is now actually running this job. Fires at most once. */
  onStart?: () => void;
};

export class QueueFullError extends Error {
  override readonly name = "QueueFullError";
  constructor(readonly waiting: number) {
    super(`The engine queue is full (${waiting} waiting).`);
  }
}

/** Waited longer than the queue is willing to make anyone wait. Reported to the
 *  caller as the same "server busy" condition as a full queue: from where they
 *  stand the two are the same event. */
export class QueueWaitTimeoutError extends Error {
  override readonly name = "QueueWaitTimeoutError";
  constructor(readonly waitedMs: number) {
    super(`The engine queue did not reach this job within ${waitedMs}ms.`);
  }
}

/** Cancelled before it ever started. Distinct from the engine runner's
 *  cancellation, which is about a process that had already been spawned. */
export class QueueCancelledError extends Error {
  override readonly name = "QueueCancelledError";
  constructor() {
    super("The queued request was cancelled before it started.");
  }
}

export type QueueStats = {
  running: number;
  waiting: number;
  concurrency: number;
  maxWaiting: number;
};

type Job = {
  key: string;
  priority: number;
  sequence: number;
  state: "waiting" | "running";
  refs: number;
  controller: AbortController;
  promise: Promise<unknown>;
  settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void };
  run: (signal: AbortSignal) => Promise<unknown>;
  listeners: Set<QueueListener>;
  /** The last `ahead` reported, so position updates only fire on a change. */
  announced: number | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
};

export class EngineQueue {
  readonly #concurrency: number;
  readonly #maxWaiting: number;
  readonly #maxWaitMs: number;
  #running = 0;
  #sequence = 0;
  #waiting: Job[] = [];
  /** Live jobs by key — waiting or running — so identical work is shared
   *  rather than duplicated. */
  readonly #jobs = new Map<string, Job>();

  constructor(options: { concurrency: number; maxWaiting: number; maxWaitMs?: number }) {
    this.#concurrency = Math.max(1, Math.floor(options.concurrency));
    this.#maxWaiting = Math.max(1, Math.floor(options.maxWaiting));
    // `Infinity` disables the wait deadline, which is what the unit tests of
    // ordering want: they care about who runs first, not about the clock.
    this.#maxWaitMs = options.maxWaitMs ?? Number.POSITIVE_INFINITY;
  }

  stats(): QueueStats {
    return {
      running: this.#running,
      waiting: this.#waiting.length,
      concurrency: this.#concurrency,
      maxWaiting: this.#maxWaiting,
    };
  }

  /** How many callers are attached to a live job, or 0 if there is none. */
  refsFor(key: string): number {
    return this.#jobs.get(key)?.refs ?? 0;
  }

  /**
   * Submit work, or attach to the identical work already in flight.
   *
   * The returned promise is per-caller; the underlying run is shared. A caller
   * that goes away decrements the reference count, and the engine process is
   * cancelled only when the LAST interested caller has gone. One player
   * navigating away must not cancel the analysis their opponent is watching.
   */
  submit<T>(
    task: QueuedTask<T>,
    callerSignal?: AbortSignal,
    listener?: QueueListener,
  ): Promise<T> {
    const existing = this.#jobs.get(task.key);
    if (existing) {
      existing.refs += 1;
      if (listener) {
        existing.listeners.add(listener);
        // A caller joining mid-flight is told where things stand right now,
        // rather than being left with no lifecycle event at all.
        if (existing.state === "waiting") listener.onQueued?.(this.#positionOf(existing));
        else listener.onStart?.();
      }
      return this.#attach(task.key, existing.promise as Promise<T>, callerSignal);
    }

    if (this.#waiting.length >= this.#maxWaiting) {
      return Promise.reject(new QueueFullError(this.#waiting.length));
    }

    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nothing else observes this promise, so an unhandled rejection here would
    // be reported against the shared run rather than against a caller.
    promise.catch(() => {});

    const job: Job = {
      key: task.key,
      priority: task.priority,
      sequence: this.#sequence++,
      state: "waiting",
      refs: 1,
      controller: new AbortController(),
      promise,
      settle: { resolve, reject },
      run: task.run as (signal: AbortSignal) => Promise<unknown>,
      listeners: new Set(listener ? [listener] : []),
      announced: null,
      waitTimer: null,
    };

    // A job cancelled while still queued gives its place back at once.
    job.controller.signal.addEventListener(
      "abort",
      () => {
        if (job.state === "waiting") this.#abandon(job, new QueueCancelledError());
      },
      { once: true },
    );

    this.#jobs.set(job.key, job);
    this.#waiting.push(job);
    this.#pump();

    if (job.state === "waiting") this.#beginWaiting(job);
    this.#syncPositions();

    return this.#attach(task.key, promise as Promise<T>, callerSignal);
  }

  /** Cancel a live job regardless of reference count. Used by an explicit
   *  cancel request from the caller that owns the job. */
  cancel(key: string): boolean {
    const job = this.#jobs.get(key);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #positionOf(job: Job): QueuePosition {
    let ahead = 0;
    for (const other of this.#waiting) {
      if (other === job) continue;
      if (other.priority < job.priority) ahead += 1;
      else if (other.priority === job.priority && other.sequence < job.sequence) ahead += 1;
    }
    return { ahead, position: ahead + 1 };
  }

  #beginWaiting(job: Job): void {
    if (this.#maxWaitMs !== Number.POSITIVE_INFINITY) {
      job.waitTimer = setTimeout(() => {
        if (job.state === "waiting") {
          this.#abandon(job, new QueueWaitTimeoutError(this.#maxWaitMs));
        }
      }, this.#maxWaitMs);
      job.waitTimer.unref?.();
    }
    const at = this.#positionOf(job);
    job.announced = at.ahead;
    for (const observer of job.listeners) observer.onQueued?.(at);
  }

  /** Drop a job that is still waiting: free its place, tell its callers. */
  #abandon(job: Job, error: Error): void {
    const index = this.#waiting.indexOf(job);
    if (index >= 0) this.#waiting.splice(index, 1);
    if (job.waitTimer) clearTimeout(job.waitTimer);
    job.waitTimer = null;
    // Only delete the map entry if it is still this job's. Defensive: a key is
    // never reused while live, but deleting someone else's entry would silently
    // un-deduplicate a running search.
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    job.settle.reject(error);
    this.#syncPositions();
  }

  /** Report a changed place in line to everyone still waiting. Cheap by
   *  construction: the queue is bounded and short. */
  #syncPositions(): void {
    for (const job of this.#waiting) {
      const at = this.#positionOf(job);
      if (job.announced === at.ahead) continue;
      job.announced = at.ahead;
      for (const observer of job.listeners) observer.onPosition?.(at);
    }
  }

  #pump(): void {
    while (this.#running < this.#concurrency && this.#waiting.length > 0) {
      // Priority first, arrival order within a priority. Sorting on pump rather
      // than on insert keeps submission O(1) and the queue short by design.
      this.#waiting.sort(
        (first, second) => first.priority - second.priority || first.sequence - second.sequence,
      );
      const next = this.#waiting.shift();
      if (!next) return;
      this.#start(next);
    }
  }

  #start(job: Job): void {
    if (job.waitTimer) clearTimeout(job.waitTimer);
    job.waitTimer = null;
    job.state = "running";
    this.#running += 1;
    for (const observer of job.listeners) observer.onStart?.();

    // `run` is caller-supplied. A synchronous throw from it must not leave the
    // running count incremented forever — that would shrink the pool by one on
    // every occurrence until nothing could run at all.
    let work: Promise<unknown>;
    try {
      work = job.run(job.controller.signal);
    } catch (error) {
      work = Promise.reject(error);
    }

    // Accounting happens BEFORE the caller is answered, so the slot is free the
    // instant anyone can observe the job as finished — including `/health` and
    // the next request through the door. Settling first and tidying afterwards
    // would leave a window in which the queue reports capacity it already has.
    const finish = () => {
      this.#running -= 1;
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
      this.#pump();
      this.#syncPositions();
    };
    work.then(
      (value) => {
        finish();
        job.settle.resolve(value);
      },
      (error: unknown) => {
        finish();
        job.settle.reject(error);
      },
    );
  }

  #attach<T>(key: string, promise: Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (!callerSignal) return promise;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const job = this.#jobs.get(key);
      if (!job) return;
      job.refs -= 1;
      if (job.refs <= 0) job.controller.abort();
    };

    const onAbort = () => release();
    if (callerSignal.aborted) {
      release();
    } else {
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }

    return promise.finally(() => {
      callerSignal.removeEventListener("abort", onAbort);
      released = true; // the run is over; releasing now would abort a fresh run
    });
  }
}
