// ── The job registry ─────────────────────────────────────────────────────────
//
// The queue (queue.ts) answers "how many engine processes may run and in what
// order". It deliberately couples a run to the callers waiting on it: when the
// last caller's signal aborts, the run is cancelled. That is exactly right for a
// single request whose client has gone away, and exactly WRONG for a bot turn or
// an analysis whose player has merely navigated to another page.
//
// The registry sits on top of the queue and breaks that coupling. It owns the
// job. Callers OBSERVE a job; observing and un-observing never start or stop the
// underlying search. The engine keeps running with nobody watching, and a caller
// that returns re-attaches to the same run — or, if it already finished, reads
// its cached result.
//
//   PAGE LIFETIME ≠ ENGINE JOB LIFETIME
//
// What is allowed to stop a job is a matter of USEFULNESS, not connectivity:
//
//   • explicit cancellation      — a player pressed "cancel" on their analysis
//   • superseded position        — a newer request for the same game arrived at
//                                  a higher revision; the old answer is about a
//                                  board that no longer exists
//   • timeout                    — enforced inside the engine runner
//   • server shutdown            — the process is draining
//
// A disconnected observer is none of these. It is just a page that closed.
//
// The registry also remembers COMPLETED results for a bounded, TTL'd window, so a
// player returning to the game sees the answer immediately instead of paying for
// the same search twice. Failures are never remembered as results.

import type { EngineProgress, EngineResponse } from "./engineRunner.js";
import { EngineQueue, type QueuePosition } from "./queue.js";

/** A completed result is cached under this namespace. A process restart already
 *  wipes the in-memory cache, so its role today is forward-compatibility: if a
 *  durable store is ever added, bumping this invalidates results computed by an
 *  older engine/rules build. */
export const CACHE_NAMESPACE = "v1";

export type JobKind = "bot" | "analysis";

/** Where a job is, from the registry's point of view. */
export type JobStatus = "queued" | "running" | "completed" | "failed";

/** What a caller learns by asking whether a job exists, WITHOUT starting one. */
export type JobSnapshot =
  | { status: "queued"; position: QueuePosition | null }
  | { status: "running"; progress: EngineProgress | null }
  | { status: "completed"; result: EngineResponse }
  | { status: "failed" };

/** Best-effort lifecycle notifications for one observer. Never affects the run. */
export type JobObserver = {
  onQueued?: (state: QueuePosition) => void;
  onRunning?: () => void;
  onProgress?: (progress: EngineProgress) => void;
};

/** What the caller gets back from submit/attach: the shared run, and a way to
 *  stop observing that does NOT stop the run. */
export type JobAttachment = {
  promise: Promise<EngineResponse>;
  /** Stop receiving lifecycle events. Idempotent. Never cancels the job. */
  detach: () => void;
};

/** The run the registry executes, composed by the caller (app.ts). It is handed
 *  everything the caller needs to make the run correct and observable:
 *   • `signal`   — aborts on explicit/superseded/timeout cancellation
 *   • `waited`   — whether the job sat in the queue before starting, so the
 *                  caller can re-check staleness only when it actually mattered
 *   • `onProgress` — the sink that fans progress out to every current observer */
export type JobRun = (ctx: {
  signal: AbortSignal;
  waited: boolean;
  onProgress: (progress: EngineProgress) => void;
}) => Promise<EngineResponse>;

export type JobSpec = {
  key: string;
  priority: number;
  kind: JobKind;
  gameId: string;
  /** The revision the job was admitted against. A later request for the same
   *  game at a higher revision supersedes this one. */
  admittedRevision: number;
  run: JobRun;
};

type ActiveJob = {
  key: string;
  kind: JobKind;
  gameId: string;
  admittedRevision: number;
  status: "queued" | "running";
  waited: boolean;
  lastPosition: QueuePosition | null;
  lastProgress: EngineProgress | null;
  promise: Promise<EngineResponse>;
  observers: Set<JobObserver>;
  createdAt: number;
};

type CachedResult = {
  kind: JobKind;
  gameId: string;
  admittedRevision: number;
  result: EngineResponse;
  completedAt: number;
};

export type JobRegistryOptions = {
  /** How long a completed ANALYSIS result stays served. Analysis is a pure
   *  function of an immutable (position, settings), so this can be generous. */
  analysisResultTtlMs: number;
  /** How long a completed BOT result stays served. The key includes the
   *  revision, so retaining it can only pin one move to that same canonical
   *  turn; a later turn always has a different key. */
  botResultTtlMs: number;
  /** Hard ceiling on cached results, evicted least-recently-used. */
  maxCached: number;
};

export class JobRegistry {
  readonly #queue: EngineQueue;
  readonly #options: JobRegistryOptions;
  readonly #active = new Map<string, ActiveJob>();
  /** Insertion/access order is LRU order: Map preserves it, and re-inserting on
   *  read moves an entry to the end. */
  readonly #cache = new Map<string, CachedResult>();

  constructor(queue: EngineQueue, options: JobRegistryOptions) {
    this.#queue = queue;
    this.#options = options;
  }

  /**
   * Start the job, or attach to the identical one already in flight, or return
   * its cached result. This is the POST path: it is allowed to start work.
   */
  submit(spec: JobSpec, observer?: JobObserver): JobAttachment {
    // A newer request for the same game retires stale in-flight work first: the
    // old answer is about a board this request proves has moved on.
    this.#cancelSuperseded(spec.gameId, spec.admittedRevision);

    const cached = this.#readCache(spec.key);
    if (cached) {
      // Already answered. No lifecycle to replay; hand back the result.
      return { promise: Promise.resolve(cached.result), detach: () => {} };
    }

    const existing = this.#active.get(spec.key);
    if (existing) return this.#observe(existing, observer);

    return this.#start(spec, observer);
  }

  /**
   * Attach to an existing job or its cached result WITHOUT starting anything.
   * This is the reconnect (GET) path: a returning client asks "is there already
   * work for this exact position?" and gets to watch it, but never causes a new
   * search or spends a budget. Returns null when there is nothing to attach to.
   */
  attach(key: string, observer?: JobObserver): JobAttachment | null {
    const cached = this.#readCache(key);
    if (cached) return { promise: Promise.resolve(cached.result), detach: () => {} };
    const existing = this.#active.get(key);
    if (existing) return this.#observe(existing, observer);
    return null;
  }

  /** A read-only look at a job's state, for a caller that wants to answer
   *  QUEUED/RUNNING/COMPLETED/NOT_FOUND without attaching a stream. */
  inspect(key: string): JobSnapshot | null {
    const cached = this.#readCache(key);
    if (cached) return { status: "completed", result: cached.result };
    const active = this.#active.get(key);
    if (!active) return null;
    return active.status === "queued"
      ? { status: "queued", position: active.lastPosition }
      : { status: "running", progress: active.lastProgress };
  }

  /** Explicitly cancel a live job by key. A cancelled job's observers see a
   *  cancellation, exactly as if it had been cancelled for any other reason. */
  cancel(key: string): boolean {
    if (!this.#active.has(key)) return false;
    return this.#queue.cancel(key);
  }

  /** Drop cached results past their TTL. Cheap: the cache is bounded. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.#cache) {
      if (now - entry.completedAt >= this.#ttlFor(entry.kind)) this.#cache.delete(key);
    }
  }

  /** For diagnostics/tests: how many jobs are live and how many results cached. */
  stats(): { active: number; cached: number } {
    return { active: this.#active.size, cached: this.#cache.size };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #start(spec: JobSpec, observer?: JobObserver): JobAttachment {
    const job: ActiveJob = {
      key: spec.key,
      kind: spec.kind,
      gameId: spec.gameId,
      admittedRevision: spec.admittedRevision,
      status: "queued",
      waited: false,
      lastPosition: null,
      lastProgress: null,
      // Filled in immediately below; the queue call is synchronous up to the
      // first await inside the run.
      promise: undefined as unknown as Promise<EngineResponse>,
      observers: new Set(observer ? [observer] : []),
      createdAt: Date.now(),
    };
    this.#active.set(spec.key, job);

    const promise = this.#queue.submit(
      {
        key: spec.key,
        priority: spec.priority,
        run: (signal) =>
          spec.run({
            signal,
            // Read at the moment the run begins: if it waited, `onQueued` has
            // already fired and flipped this to true.
            waited: job.waited,
            onProgress: (progress) => {
              job.lastProgress = progress;
              for (const observed of job.observers) observed.onProgress?.(progress);
            },
          }),
      },
      // No caller signal: the queue must NOT treat an observer going away as a
      // reason to cancel. The registry cancels explicitly when it decides to.
      undefined,
      {
        onQueued: (state) => {
          job.status = "queued";
          job.waited = true;
          job.lastPosition = state;
          for (const observed of job.observers) observed.onQueued?.(state);
        },
        onPosition: (state) => {
          job.lastPosition = state;
          for (const observed of job.observers) observed.onQueued?.(state);
        },
        onStart: () => {
          job.status = "running";
          for (const observed of job.observers) observed.onRunning?.();
        },
      },
    );
    job.promise = promise;

    // The registry's own bookkeeping. Observers await `promise` directly and see
    // the same settlement; this handler only moves the job out of "active" and,
    // on success, into the result cache. A failure is never cached.
    promise.then(
      (result) => {
        if (this.#active.get(spec.key) === job) this.#active.delete(spec.key);
        this.#cache.set(this.#cacheKey(spec.key), {
          kind: spec.kind,
          gameId: spec.gameId,
          admittedRevision: spec.admittedRevision,
          result,
          completedAt: Date.now(),
        });
        this.#evictOverflow();
      },
      () => {
        if (this.#active.get(spec.key) === job) this.#active.delete(spec.key);
      },
    );

    return { promise, detach: this.#detacher(job, observer) };
  }

  #observe(job: ActiveJob, observer?: JobObserver): JobAttachment {
    if (observer) {
      job.observers.add(observer);
      // A caller joining mid-flight is told where things stand right now, rather
      // than being left with no lifecycle event until the next transition.
      if (job.status === "queued") {
        if (job.lastPosition) observer.onQueued?.(job.lastPosition);
      } else {
        observer.onRunning?.();
        if (job.lastProgress) observer.onProgress?.(job.lastProgress);
      }
    }
    return { promise: job.promise, detach: this.#detacher(job, observer) };
  }

  #detacher(job: ActiveJob, observer?: JobObserver): () => void {
    let detached = false;
    return () => {
      if (detached || !observer) return;
      detached = true;
      job.observers.delete(observer);
      // Deliberately nothing else. An empty observer set does not cancel the job.
    };
  }

  #cancelSuperseded(gameId: string, admittedRevision: number): void {
    for (const job of this.#active.values()) {
      if (job.gameId === gameId && job.admittedRevision < admittedRevision) {
        this.#queue.cancel(job.key);
      }
    }
  }

  #ttlFor(kind: JobKind): number {
    return kind === "bot" ? this.#options.botResultTtlMs : this.#options.analysisResultTtlMs;
  }

  #cacheKey(key: string): string {
    return `${CACHE_NAMESPACE}::${key}`;
  }

  /** Read a cached result if present and unexpired; touch it as most-recently
   *  used so eviction favours cold entries. */
  #readCache(key: string): CachedResult | null {
    const cacheKey = this.#cacheKey(key);
    const entry = this.#cache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.completedAt >= this.#ttlFor(entry.kind)) {
      this.#cache.delete(cacheKey);
      return null;
    }
    // Re-insert to move to the end of the LRU order.
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, entry);
    return entry;
  }

  #evictOverflow(): void {
    while (this.#cache.size > this.#options.maxCached) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
