// ── HTTP surface ─────────────────────────────────────────────────────────────
//
// Two computations are offered, and they are the same search read out
// differently:
//
//   POST /v1/games/:gameId/bot-move   what the room's bot plays on its own turn
//   POST /v1/games/:gameId/analysis   what the engine would do on YOUR turn, explained
//
// Neither accepts a position. A caller names a game and the revision it believes
// the game is at; the server looks up what is actually true and refuses if the
// two disagree. There is deliberately no endpoint that evaluates a board handed
// over by the client — that would be a free compute service with an engine
// attached, and it would leak hidden information the moment someone described a
// position they are not entitled to know.
//
// Every request passes four gates, in this order, cheapest first:
//
//   1. AUTHENTICATION   a verified Supabase access token (auth.ts)
//   2. METERING         per-user concurrency and compute budget (rateLimit.ts).
//                       An account holds ONE analysis at a time (queued counts
//                       as held), and that is the whole of the analysis limit:
//                       the sliding-window budget applies to bot turns, and to
//                       analysis only under ENGINE_ANALYSIS_BUDGETED.
//   3. AUTHORIZATION    what Postgres says this user may do here (roomContext.ts)
//   4. TURN RULES       enforced below, and only below — the UI's copy of these
//                       rules is a convenience, never the decision

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import {
  type AnalysisResult,
  type StudyAnalysisResponse,
  AnalysisUnavailableError,
  buildAnalysis,
  buildStudyAnalysis,
} from "./analysis.js";
import { type Caller, UnauthenticatedError, bearerFrom, createTokenVerifier } from "./auth.js";
import { seedFor, toEngineRequest, toStudyEngineRequest } from "./adapter.js";
import { CanonicalStateError, otherSide } from "./canonical.js";
import { clientSuperAllowedFor, type ServiceConfig } from "./config.js";
import {
  EngineCancelledError,
  EngineFailureError,
  EngineTimeoutError,
  type EngineProgress,
  type EngineResponse,
  runEngine,
  runEngineValidation,
} from "./engineRunner.js";
import {
  ANALYSIS_LEVEL_CONFIG,
  BOT_PRIORITY,
  BOT_REPORT_TOP_N,
  BOT_TIERS,
  BOT_TIER_CONFIG,
  STUDY_PRIORITY,
  STUDY_TOP_N,
  type AnalysisLevel,
  isAnalysisLevel,
  isBotTier,
} from "./levels.js";
import {
  EngineQueue,
  QueueCancelledError,
  QueueFullError,
  QueueWaitTimeoutError,
  type QueuePosition,
} from "./queue.js";
import { JobRegistry, type JobKind, type JobObserver, type JobParams } from "./jobRegistry.js";
import { ComputeBudget, ConcurrencyLimit } from "./rateLimit.js";
import { StudyPositionError, parseStudyPosition, studyFingerprint } from "./study.js";
import {
  SUPER_ENGINE_VERSION,
  SUPER_WEIGHTS_VERSION,
  isKnownWeightsVersion,
  superClientConfig,
} from "./superConfig.js";
import {
  RoomAccessError,
  loadContextAndCommands,
  type EngineRoomContext,
  type GameStateSource,
} from "./roomContext.js";

/** How many trailing commands to read for the scoreless-turn streak. The rule
 *  ends a game at six, so anything beyond this cannot change the answer. */
const STREAK_LOOKBACK = 24;

/** Default and maximum page size for the bot reasoning report. The report is
 *  read a page at a time so opening the panel costs one small response rather
 *  than the whole ranking. */
const REASONING_PAGE_DEFAULT = 6;
const REASONING_PAGE_MAX = 24;

/**
 * How far behind the current revision a reasoning report may be requested.
 *
 * The panel only ever asks about the bot move that is still the latest one on
 * the board — one revision back, or the same revision when the move has been
 * computed but not yet committed. The small window absorbs a client that is a
 * beat behind (a refill commit, a resync landing mid-read) without turning this
 * into a way to walk the result cache backwards through a game.
 */
const REASONING_LOOKBACK = 4;

/**
 * Whether the caller wants progress streamed.
 *
 * A `max` search legitimately runs for minutes, and an HTTP request held open
 * that long with no bytes flowing is exactly what proxies and load balancers
 * kill. Streaming solves the same problem twice: the connection stays warm
 * because the engine reports every sample, and the player sees the search move
 * instead of watching a spinner.
 *
 * Once the stream is open the status code is already sent, so failures after
 * that point arrive as an `error` EVENT. Everything that can be decided before
 * the engine starts — authentication, authorization, turn rules, staleness — is
 * decided first, and those still answer with a real status code.
 */
function wantsStream(c: Context): boolean {
  return (c.req.header("Accept") ?? "").includes("text/event-stream");
}

/**
 * Where the time before the engine went, reported to the caller as
 * `Server-Timing`.
 *
 * Everything measured here happens BEFORE the response head is written, which is
 * what makes a standard header the right carrier: by the time the client can
 * read it, all of it is already true. It carries durations and nothing else — no
 * identifiers, no position, no token — so it is safe to expose cross-origin, and
 * it is what turns "the bot feels slow" into a number attributable to a stage.
 */
class RequestTiming {
  readonly #start = performance.now();
  #last = performance.now();
  readonly #marks: Array<[string, number]> = [];

  mark(name: string): void {
    const now = performance.now();
    this.#marks.push([name, now - this.#last]);
    this.#last = now;
  }

  header(): string {
    const parts = this.#marks.map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`);
    parts.push(`total;dur=${(performance.now() - this.#start).toFixed(1)}`);
    return parts.join(", ");
  }

  applyTo(c: Context): void {
    c.header("Server-Timing", this.header());
  }
}

/**
 * Read one paging number off the query string, clamped into range.
 *
 * Clamped rather than refused: a pager that 400s on an out-of-range page is a
 * pager the client has to predict the bounds of, and the bounds (how many
 * candidates the engine actually reported) are only knowable from the response.
 * What was actually served comes back in `page`, so a clamped request is
 * self-describing rather than silently wrong. A value that is not a number at
 * all is a different thing — that is a caller mistake, and it takes the default.
 */
function pageNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return Math.min(Math.max(fallback, min), max);
  const value = Number(raw);
  if (!Number.isInteger(value)) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(value, min), max);
}

export type AppDependencies = {
  config: ServiceConfig;
  source: GameStateSource;
  queue: EngineQueue;
  /** Owns engine jobs independently of any request. Built from `queue` when not
   *  injected; tests inject one to share and inspect it. */
  registry?: JobRegistry;
  budget: ComputeBudget;
  analysisSlots: ConcurrencyLimit;
  /** Injectable so tests can drive the whole request path without a compiler
   *  or a several-second search. */
  runEngine?: typeof runEngine;
  /** Injectable for the same reason, and separately: a legality check is a
   *  different question with a different answer shape. */
  runValidation?: typeof runEngineValidation;
  verifyToken?: (token: string) => Promise<Caller>;
};

type ApiError = { error: string; code: string; detail?: string };

function fail(code: string, message: string, detail?: string): ApiError {
  return detail ? { error: message, code, detail } : { error: message, code };
}

/** The hooks a queued-and-then-executed search reports its life through. */
export type RunHooks = {
  onQueued?: (state: QueuePosition) => void;
  onRunning?: () => void;
  onProgress?: (progress: EngineProgress) => void;
};

/**
 * Run a search with its lifecycle streamed, then send the result.
 *
 * The contract on the wire is five event kinds, and exactly one of `result` or
 * `error` ends the stream:
 *
 *   queued    {ahead, position}   the engine is busy; this job is in line.
 *                                 Re-sent whenever the place in line changes.
 *   running   {}                  an engine process is now working on it
 *   progress  {phase, percent, …} the engine's own report, throttled
 *   result    <the answer>
 *   error     {code, error}
 *
 * A client that sees neither `result` nor `error` has lost the connection,
 * which is a case it must handle anyway.
 *
 * Every one of these is a FACT the server holds. `queued` is emitted only when
 * the job really did not start, `running` only once a process exists, and
 * `progress` only carries numbers the engine itself reported — there is no
 * synthesised percentage anywhere in this path, because a made-up progress bar
 * is worse than an honest indeterminate one.
 *
 * Progress is throttled: the engine reports every sample, which on a long
 * search is hundreds of messages nobody reads. One per 400ms is enough to keep
 * a progress bar honest and the connection warm.
 */
function streamResult<T>(
  c: Context,
  start: (hooks: RunHooks) => Promise<EngineResponse>,
  /** May be async: the study endpoint persists the ranking before it is sent,
   *  so a record exists whether or not the client is still listening. A failure
   *  here lands in the same catch as an engine failure and is reported as one. */
  present: (response: EngineResponse) => T | Promise<T>,
  onFailure: () => void,
  onSettled?: () => void,
) {
  return streamSSE(c, async (stream) => {
    // Lifecycle events are raised from callbacks that cannot await, so writes
    // are serialised through one chain. Without it a `running` raised during a
    // `queued` write could reach the client first, and the client would read
    // the job as going backwards.
    let chain: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown) => {
      chain = chain
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {
          // The client is gone. The queue learns that from the request signal;
          // failing the search over a failed write would be the wrong order of
          // events.
        });
      return chain;
    };

    let lastSent = 0;
    try {
      const response = await start({
        onQueued: (state) => send("queued", { ahead: state.ahead, position: state.position }),
        onRunning: () => send("running", {}),
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastSent < 400) return;
          lastSent = now;
          send("progress", {
            phase: progress.phase,
            percent: progress.percent,
            elapsedMs: Math.round(progress.elapsedMs),
            etaMs: Math.round(progress.etaMs),
            detail: progress.detail,
          });
        },
      });
      send("result", await present(response));
      await chain;
    } catch (error) {
      onFailure();
      send("error", describeStreamError(error));
      await chain;
    } finally {
      onSettled?.();
    }
  });
}

/** The same coded errors the JSON path returns, for a failure that arrives
 *  after the status line has already been sent. */
function describeStreamError(error: unknown): Record<string, unknown> {
  if (error instanceof EngineTimeoutError) {
    return { code: "engine_timeout", error: "The engine ran out of time on this position." };
  }
  if (error instanceof EngineCancelledError || error instanceof QueueCancelledError) {
    return { code: "cancelled", error: "The request was cancelled." };
  }
  if (error instanceof QueueFullError || error instanceof QueueWaitTimeoutError) {
    // Two causes, one meaning for the caller: the server is oversubscribed and
    // this request should be made again rather than waited on.
    return { code: "queue_full", error: "The engine is busy. Try again shortly." };
  }
  if (error instanceof StaleRevisionError) {
    // Reached the front of the queue for a position the game has already left.
    return {
      code: "stale_revision",
      error: "The position changed while this request was waiting.",
      currentRevision: error.current,
      requestedRevision: error.requested,
    };
  }
  if (error instanceof AnalysisUnavailableError) {
    return { code: "analysis_unavailable", error: error.message };
  }
  if (error instanceof RoomAccessError) {
    return { code: error.status === 404 ? "not_found" : "forbidden", error: error.message };
  }
  if (error instanceof EngineFailureError) {
    console.error("engine failure (stream)", error.message, error.detail ?? "");
    return { code: "engine_failed", error: "The engine could not complete this request." };
  }
  console.error("unhandled (stream)", error);
  return { code: "internal", error: "Something went wrong." };
}

export function createApp(deps: AppDependencies) {
  const { config, source, queue, budget, analysisSlots } = deps;
  const engine = deps.runEngine ?? runEngine;
  const validateWithEngine = deps.runValidation ?? runEngineValidation;
  // Per-account, and tiny. A validation is microseconds of rules arithmetic, so
  // this is not a CPU protection — it is the bound that stops one account
  // spawning processes in a loop. It is deliberately NOT the search queue:
  // making a move submission wait behind a five-minute analysis would mean a
  // player who computed their bot move in ten seconds then waited minutes for
  // permission to play it.
  const validationSlots = new ConcurrencyLimit(config.validationConcurrency);
  const verify = deps.verifyToken ?? createTokenVerifier(config.supabaseUrl);
  const registry =
    deps.registry ??
    new JobRegistry(queue, {
      analysisResultTtlMs: config.analysisResultTtlMs,
      botResultTtlMs: config.botResultTtlMs,
      maxCached: config.jobCacheMax,
    });

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.allowedOrigins,
      allowMethods: ["POST", "GET", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      // Durations only — see RequestTiming. Without this the browser drops the
      // header on a cross-origin read and the client can measure nothing but
      // the round trip as a whole.
      exposeHeaders: ["Server-Timing"],
      maxAge: 600,
    }),
  );

  // Liveness, plus the handful of numbers an operator needs to decide whether
  // this instance is sized correctly. Deliberately says nothing about games,
  // users, rooms or individual jobs: everything here is an aggregate about this
  // process, and none of it identifies anybody.
  //
  // `cpu` is included because the single most likely misconfiguration is a
  // concurrency derived from the host's core count instead of the container's
  // quota, and this is where that shows up before it becomes a slow afternoon.
  app.get("/health", (c) =>
    c.json({
      ok: true,
      queue: {
        ...queue.stats(),
        maxWaitMs: config.maxQueueWaitMs,
      },
      cpu: {
        detected: Math.round(config.cpu.cpus * 100) / 100,
        source: config.cpu.source,
        parallelism: config.cpu.parallelism,
        concurrencySource: config.concurrencySource,
      },
      retention: {
        analysisResultTtlMs: config.analysisResultTtlMs,
        botResultTtlMs: config.botResultTtlMs,
      },
      // The rollout switch and what it would hand out, so an operator can read
      // the client-side Super state off the same page as the queue rather than
      // inferring it from an environment they cannot see. Enabled here does not
      // mean every Super turn left this instance: a client whose browser cannot
      // run a worker, or that failed to fetch its config, falls back to the
      // backend path and shows up in the queue like any other bot turn. Being
      // SLOW is not among the reasons — a slow device runs full Super locally
      // and simply takes longer over it.
      //
      // `adaptiveBudget` is surfaced because it is the one switch that changes
      // how STRONG the client-side bot plays rather than how fast, and an
      // operator should never have to read the environment to find out whether
      // it is on. It is off in every normal deployment.
      clientSuper: {
        enabled: config.clientSideSuper,
        // WHO actually gets it. `enabled: true` with an audience of 0 serves the
        // backend path to everybody, which looks like a broken rollout unless
        // the audience is on the same screen as the switch.
        audience:
          !config.clientSideSuper
            ? "nobody (flag off)"
            : config.clientSideSuperUserIds.length === 0
              ? "nobody (no CLIENT_SIDE_SUPER_USER_IDS set)"
              : config.clientSideSuperUserIds[0] === "*"
                ? "everyone (general availability)"
                : `${config.clientSideSuperUserIds.length} champion(s)`,
        engineVersion: SUPER_ENGINE_VERSION,
        weightsVersion: SUPER_WEIGHTS_VERSION,
        adaptiveBudget: config.superAdaptiveBudget ? "ON (reduces Super strength)" : "off",
      },
      // How analysis load is bounded changes how the numbers above should be
      // read: a deployment that rations analysis sheds load a deployment that
      // only serialises it will instead put in this queue. Stated here rather
      // than inferred from a dashboard.
      metering: {
        analysisInFlight: config.maxAnalysisPerUser,
        // `botBudget` used to be the literal string "rationed" whatever the
        // configuration said. An operator checking whether metering is on got
        // "yes" either way.
        analysisBudget:
          config.budgetEnforced && config.analysisBudgeted ? "rationed" : "unlimited",
        botBudget: config.budgetEnforced ? "rationed" : "unlimited",
        ...(config.budgetEnforced
          ? { budgetPerWindow: config.budgetPerWindow, budgetWindowMs: config.budgetWindowMs }
          : {}),
      },
    }),
  );

  // ── shared request handling ────────────────────────────────────────────────

  async function authenticate(c: Context): Promise<Caller> {
    const token = bearerFrom(c.req.header("Authorization"));
    if (!token) throw new UnauthenticatedError("An access token is required.");
    return verify(token);
  }

  async function readBody(c: Context): Promise<Record<string, unknown>> {
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      throw new BodyTooLargeError();
    }
    const text = await c.req.text();
    // Content-Length is a claim; the body is the fact.
    if (text.length > config.maxBodyBytes) throw new BodyTooLargeError();
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new BadRequestError("The request body must be a JSON object.");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      throw new BadRequestError("The request body is not valid JSON.");
    }
  }

  /**
   * Prove the caller is asking about the position that actually exists.
   *
   * A revision mismatch is not a soft warning. An answer computed for revision N
   * is about a board that no longer exists at N+1, and the single most damaging
   * thing this service could do is let one be presented as if it still applied.
   */
  function requireRevision(context: EngineRoomContext, claimed: unknown): void {
    if (claimed === undefined || claimed === null) {
      throw new BadRequestError("expectedRevision is required.");
    }
    const revision = Number(claimed);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new BadRequestError("expectedRevision must be a whole number.");
    }
    if (revision !== context.revision) {
      throw new StaleRevisionError(context.revision, revision);
    }
  }

  /**
   * Put one engine run on the queue, and guard the two things queueing breaks.
   *
   * **Staleness.** The revision was checked at admission. A job that then waited
   * in line has been holding an answer to a question about a board that may no
   * longer exist. So a job that actually waited re-reads the authoritative
   * revision at the moment it reaches the front, BEFORE a process is spawned,
   * and refuses if the game has moved on. This is not belt-and-braces: it is the
   * difference between spending a minute of a shared CPU on a dead position and
   * not spending it. The client checks again on the way in, because a result can
   * also go stale during the search itself.
   *
   * **Invisibility.** Waiting is reported, not hidden. `onQueued` fires only when
   * the job genuinely did not start, and `onRunning` only once a process exists.
   */
  function runQueued(options: {
    key: string;
    priority: number;
    kind: JobKind;
    gameId: string;
    params: JobParams;
    caller: Caller;
    /** The revision the request was admitted against. */
    admittedRevision: number;
    request: unknown;
    timeoutMs: number;
    signal: AbortSignal;
    hooks: RunHooks;
    /**
     * Re-checked at the moment the job actually starts, if it waited in the
     * queue. Defaults to the game rule: the room must still be at the revision
     * the request was admitted against, or the answer would be about a position
     * the game has already left.
     *
     * Study passes a no-op. A made-up position cannot go stale — there is no
     * room to move on — and the default would try to load a game id that does
     * not exist.
     */
    revalidate?: () => Promise<void>;
    /** Called with `true` when this request joined an existing search instead of
     *  starting one, so the caller can undo metering it did not earn. */
    onReused?: () => void;
  }): Promise<EngineResponse> {
    const observer: JobObserver = {
      onQueued: (state) => options.hooks.onQueued?.(state),
      onRunning: () => options.hooks.onRunning?.(),
      onProgress: (progress) => options.hooks.onProgress?.(progress),
    };
    const attachment = registry.submit(
      {
        key: options.key,
        priority: options.priority,
        kind: options.kind,
        gameId: options.gameId,
        admittedRevision: options.admittedRevision,
        params: options.params,
        run: async ({ signal, waited, onProgress }) => {
          if (waited) {
            if (options.revalidate) await options.revalidate();
            else {
              const fresh = await source.loadContext(options.gameId, options.caller.token);
              if (fresh.revision !== options.admittedRevision) {
                throw new StaleRevisionError(fresh.revision, options.admittedRevision);
              }
            }
            if (signal.aborted) throw new EngineCancelledError();
          }
          return engine({
            binaryPath: config.enginePath,
            request: options.request,
            timeoutMs: options.timeoutMs,
            signal,
            onProgress,
          });
        },
      },
      observer,
    );
    // Joining an existing search costs this caller nothing, so it must not be
    // billed for one. Two tabs of the same game, or a reconnect that raced a
    // fresh POST, share one engine process and one charge.
    if (attachment.reused) options.onReused?.();
    // The request signal now DETACHES this observer when the client disconnects;
    // it does NOT cancel the search. A page that navigates away, a tab that
    // closes, or a dropped socket stops watching — the job keeps running for any
    // other observer and for the player when they return. Cancellation is a
    // separate, deliberate decision the registry makes (superseded/explicit/
    // timeout), never a consequence of a lost connection.
    if (options.signal.aborted) attachment.detach();
    else options.signal.addEventListener("abort", () => attachment.detach(), { once: true });
    return attachment.promise;
  }

  /**
   * Reconnect to an existing job (or its cached result) for `key`, streaming its
   * lifecycle. Starts nothing and charges nothing: a returning client is only
   * ever allowed to WATCH work it already caused, never to cause new work here.
   * Emits `idle` and closes when there is nothing to attach to.
   */
  function streamReconnect(
    c: Context,
    key: string,
    present: (response: EngineResponse) => unknown,
  ) {
    return streamSSE(c, async (stream) => {
      let chain: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        chain = chain
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => {});
        return chain;
      };

      let lastSent = 0;
      const observer: JobObserver = {
        onQueued: (state) => send("queued", { ahead: state.ahead, position: state.position }),
        onRunning: () => send("running", {}),
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastSent < 400) return;
          lastSent = now;
          send("progress", {
            phase: progress.phase,
            percent: progress.percent,
            elapsedMs: Math.round(progress.elapsedMs),
            etaMs: Math.round(progress.etaMs),
            detail: progress.detail,
          });
        },
      };

      const attachment = registry.attach(key, observer);
      if (!attachment) {
        await send("idle", {});
        await chain;
        return;
      }

      const signal = c.req.raw.signal;
      const onAbort = () => attachment.detach();
      if (signal.aborted) attachment.detach();
      else signal.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await attachment.promise;
        await send("result", present(response));
        await chain;
      } catch (error) {
        await send("error", describeStreamError(error));
        await chain;
      } finally {
        signal.removeEventListener("abort", onAbort);
        attachment.detach();
      }
    });
  }

  function requirePlayable(context: EngineRoomContext): void {
    if (context.canonical.status !== "playing") {
      throw new TurnRuleError("This game is not in progress.");
    }
    if (context.canonical.phase === "refill") {
      // Mid-refill there is no decision to make: tiles are still being drawn and
      // the rack the engine would reason about is not the rack that will play.
      throw new TurnRuleError("The side on move is still drawing tiles.");
    }
  }

  // ── POST /v1/games/:gameId/bot-move ────────────────────────────────────────

  app.post("/v1/games/:gameId/bot-move", async (c) => {
    const timing = new RequestTiming();
    const caller = await authenticate(c);
    timing.mark("auth");
    const gameId = c.req.param("gameId");
    const body = await readBody(c);

    // Both database reads at once. The command window is opened at the revision
    // the caller claims; `requireRevision` below is what makes that safe.
    const { context, events } = await loadContextAndCommands(
      source,
      gameId,
      caller.token,
      Number(body.expectedRevision),
      STREAK_LOOKBACK,
    );
    timing.mark("context");
    requireRevision(context, body.expectedRevision);
    requirePlayable(context);

    // The bot plays only its own side, and only in a room configured as a bot
    // room by the row itself. `bot_side` is a column fixed at creation, so a
    // client cannot nominate a side to have played for it.
    if (!context.botSide || !context.botDifficulty) {
      throw new TurnRuleError("This game has no engine player.");
    }
    if (context.activeSide !== context.botSide) {
      throw new TurnRuleError("It is not the engine's turn.");
    }
    // The human on the other side of the board is the one entitled to make the
    // bot move; a spectator watching the room is not. `can_write_live_game`
    // already said who may advance this game — reuse that answer.
    if (!context.callerControlsActiveSide) {
      throw new ForbiddenError("You do not control this game.");
    }

    const tier = BOT_TIER_CONFIG[context.botDifficulty];
    const cost = tier.cost;
    const charged = budget.charge(caller.userId, cost);
    if (!charged.allowed) throw new BudgetError(charged.retryAfterMs, charged.remaining);
    timing.mark("gates");
    // A charge is undone at most once per request. Reuse and failure can both
    // ask for it, and crediting twice would hand out budget that was never
    // spent.
    let refunded = false;
    const refund = () => {
      if (refunded) return;
      refunded = true;
      budget.refund(caller.userId, cost);
    };

    const request = toEngineRequest(context.canonical, {
      side: context.botSide,
      difficulty: context.botDifficulty,
      solver: tier.solver,
      ...(tier.budgetMs != null ? { budgetMs: tier.budgetMs } : {}),
      ...(tier.unlimited ? { unlimited: true } : {}),
      // Ask for a full ranking rather than the engine's default handful. This
      // changes nothing about the search or the move — see BOT_REPORT_TOP_N —
      // and it is what the reasoning endpoint below pages through.
      topN: BOT_REPORT_TOP_N,
      events,
    });

    // Only the move goes back on THIS response. The candidate report describes
    // the bot's own rack, so it is not shipped alongside a move the opponent's
    // client applies; it is served separately, one page at a time, by
    // `GET .../bot-move/reasoning` — same room, same controller, and only after
    // the move it explains has been played. `mapBotResponse` in the client needs
    // the move and nothing else.
    const present = (response: EngineResponse) => ({
      revision: context.revision,
      gameId,
      side: context.botSide,
      move: {
        type: response.type,
        placements: response.placements,
        exchange: response.exchange,
        score: response.score,
      },
      solver: response.solver,
      endgameSolved: response.endgameSolved,
      stats: {
        elapsedMs: Math.round(response.stats.elapsedMs),
        nodes: response.stats.nodes,
        samples: response.stats.samples,
      },
    });

    // Keyed by position, so two tabs of the same game share one search instead
    // of each starting their own.
    const key = `bot:${gameId}:${context.revision}:${context.botDifficulty}`;
    const difficulty = context.botDifficulty;
    const start = (hooks: RunHooks) =>
      runQueued({
        key,
        // Gameplay outranks every analysis level. A player waiting on their
        // opponent to move is a worse experience than a study aid taking
        // longer, and this ordering is what makes that guarantee structural.
        priority: BOT_PRIORITY,
        kind: "bot",
        gameId,
        params: { difficulty },
        caller,
        admittedRevision: context.revision,
        request,
        timeoutMs: tier.timeoutMs,
        signal: c.req.raw.signal,
        hooks,
        onReused: refund,
      });

    timing.applyTo(c);
    if (wantsStream(c)) {
      return streamResult(c, start, present, refund);
    }

    try {
      return c.json(present(await start({})));
    } catch (error) {
      refund();
      throw error;
    }
  });

  // ── GET /v1/bot-config ─────────────────────────────────────────────────────
  //
  // What a client-side Super engine is supposed to be running, and whether it
  // is allowed to run at all.
  //
  // Authenticated, because the flag is a rollout decision about a signed-in
  // population and there is no reason to publish it wider. It is NOT secret:
  // the weights it carries are served in plain JSON to a browser that will hand
  // them to a WASM module the player could read anyway. Guarding them would buy
  // nothing and cost the one thing this endpoint exists for — being able to
  // retune the bot without shipping a new engine to everybody.
  //
  // `?weightsVersion=` asks for a SPECIFIC version rather than the current one.
  // That is what makes a finished game reproducible: a game pinned to `v1`
  // fetches `v1` for as long as it runs, and for as long as anyone wants to
  // replay it, even after `v2` becomes the default for new games.
  app.get("/v1/bot-config", async (c) => {
    const caller = await authenticate(c);
    const requested = c.req.query("weightsVersion");
    if (requested !== undefined && !isKnownWeightsVersion(requested)) {
      // Refused, not silently defaulted. A game pinned to a version this
      // deployment no longer carries must fail loudly and fall back to the
      // backend engine, because answering with DIFFERENT weights under the
      // requested version's name is the one outcome pinning exists to prevent.
      throw new BadRequestError(`This deployment does not carry weights version "${requested}".`);
    }
    // Cacheable for a short while and never shared. This matters more now that
    // the response varies per CALLER: `private` keeps it in the requesting
    // browser's own cache, where a shared cache holding one Champion's
    // `clientSuperEnabled: true` cannot serve it to a general user.
    c.header("Cache-Control", "private, max-age=300");
    return c.json(
      superClientConfig({
        // Per-CALLER, not per-deployment. The flag is the master switch and the
        // allowlist is the audience; a signed-in player who is not a Champion
        // gets `false` here and plays the backend path, which is untouched.
        clientSuperEnabled: clientSuperAllowedFor(config, caller.userId),
        adaptiveBudgetEnabled: config.superAdaptiveBudget,
        ...(requested !== undefined ? { weightsVersion: requested } : {}),
      }),
    );
  });

  // ── POST /v1/games/:gameId/bot-move/validate ───────────────────────────────
  //
  // Is this move legal from the position this server is holding?
  //
  // That is the WHOLE claim. It is deliberately not "is this the move the
  // engine would have played" — proving that means running the Super search
  // again, which is precisely the CPU cost the client-side path exists to
  // remove. For a trusted Champion beta, legality is the useful half: it
  // catches an engine bug, a desynced rack and a stale position, which are the
  // three ways a client-computed move actually goes wrong.
  //
  // Everything the verdict is computed against comes from canonical state at a
  // revision the caller had to name correctly. The submitted move is the only
  // thing the caller contributes, so a caller cannot make an illegal move legal
  // by also describing a board on which it would be.
  app.post("/v1/games/:gameId/bot-move/validate", async (c) => {
    const timing = new RequestTiming();
    const caller = await authenticate(c);
    timing.mark("auth");
    const gameId = c.req.param("gameId");
    const body = await readBody(c);

    const move = body.move;
    if (!move || typeof move !== "object") {
      throw new BadRequestError("A move is required.");
    }

    const { context, events } = await loadContextAndCommands(
      source,
      gameId,
      caller.token,
      Number(body.expectedRevision),
      STREAK_LOOKBACK,
    );
    timing.mark("context");
    requireRevision(context, body.expectedRevision);
    requirePlayable(context);

    if (!context.botSide || !context.botDifficulty) {
      throw new TurnRuleError("This game has no engine player.");
    }
    if (context.activeSide !== context.botSide) {
      throw new TurnRuleError("It is not the engine's turn.");
    }
    if (!context.callerControlsActiveSide) {
      throw new ForbiddenError("You do not control this game.");
    }

    if (!validationSlots.tryAcquire(caller.userId)) {
      // Not budget_exhausted: nothing was rationed and nothing was spent. The
      // caller simply has more of these in flight than one account needs, and
      // the honest answer is to retry immediately.
      c.header("Retry-After", "1");
      throw new BadRequestError("Too many move validations in flight. Retry.");
    }
    timing.mark("gates");
    try {
      // Built by the SERVER from canonical state, exactly as a bot search is —
      // then given a mode instead of a budget. No search runs.
      const request = {
        ...toEngineRequest(context.canonical, {
          side: context.botSide,
          difficulty: context.botDifficulty,
          events,
        }),
        mode: "validate",
        move,
      };
      const verdict = await validateWithEngine({
        binaryPath: config.enginePath,
        request,
        // Generous for something that takes microseconds. It is a reaper for a
        // wedged process, not a bound on the work.
        timeoutMs: 5_000,
        signal: c.req.raw.signal,
      });
      timing.applyTo(c);
      return c.json({
        revision: context.revision,
        gameId,
        side: context.botSide,
        ...verdict,
      });
    } finally {
      validationSlots.release(caller.userId);
    }
  });

  // ── POST /v1/games/:gameId/analysis ────────────────────────────────────────

  app.post("/v1/games/:gameId/analysis", async (c) => {
    const timing = new RequestTiming();
    const caller = await authenticate(c);
    timing.mark("auth");
    const gameId = c.req.param("gameId");
    const body = await readBody(c);

    const level: AnalysisLevel = isAnalysisLevel(body.level) ? body.level : "quick";
    const tier = ANALYSIS_LEVEL_CONFIG[level];

    const { context, events } = await loadContextAndCommands(
      source,
      gameId,
      caller.token,
      Number(body.expectedRevision),
      STREAK_LOOKBACK,
    );
    timing.mark("context");
    requireRevision(context, body.expectedRevision);
    requirePlayable(context);

    // ── the analysis permission rule ──────────────────────────────────────────
    //
    // Analysis is help with YOUR OWN decision. Two conditions, both enforced
    // here and neither delegated to the UI:
    //
    //   • The turn must be controlled by a human. On the bot's turn there is no
    //     human decision to assist, and answering would hand the player the
    //     engine's read of a rack they cannot see.
    //   • The caller must be the one who controls that turn. In a human-vs-human
    //     room either player may analyse on their own turn; a spectator may
    //     analyse on nobody's.
    //
    // Hiding the button is not one of these conditions. The endpoint is the
    // authority and it answers the same way whether or not a button exists.
    if (context.activeSideIsBot) {
      throw new AnalysisNotAllowedError(
        "Analysis is only available on a turn a human is playing.",
      );
    }
    if (!context.callerControlsActiveSide) {
      throw new AnalysisNotAllowedError("Analysis is only available on your own turn.");
    }

    const key = `analysis:${gameId}:${context.revision}:${level}`;

    // ── metering ──────────────────────────────────────────────────────────────
    //
    // ONE AT A TIME, not N per hour. An account may hold `maxAnalysisPerUser`
    // analyses in flight — and "in flight" includes QUEUED, because a job
    // waiting its turn is work this account has already asked for and is about
    // to be given. So while the analysis of one game is still in the queue,
    // asking about a different game is refused until that one is done; the
    // first is not cancelled, hurried, or moved — it keeps its place in line.
    //
    // What this deliberately is NOT is a ration. There is no per-window quota
    // on analysis by default (`analysisBudgeted` in config.ts): a player may
    // press analyse as often as they like, for as long as they like, and each
    // press waits for the previous one rather than being told they are out.
    // Rationing fails a player mid-game on the turn they stopped to think
    // about, and nothing they do — including waiting — produces the answer.
    //
    // Joining a search that already exists for this exact position and level is
    // not a second analysis and takes no slot: that is one search with two
    // observers, and refusing the second is how a returning player, or a second
    // tab, got told to wait for work that was already theirs.
    const alreadyRunning = registry.inspect(key) !== null;
    let holdsSlot = false;
    if (!alreadyRunning) {
      if (!analysisSlots.tryAcquire(caller.userId)) {
        throw new TooManyAnalysesError(analysisSlots.heldBy(caller.userId));
      }
      holdsSlot = true;
    }

    if (config.analysisBudgeted) {
      const charged = budget.charge(caller.userId, tier.cost);
      if (!charged.allowed) {
        if (holdsSlot) analysisSlots.release(caller.userId);
        throw new BudgetError(charged.retryAfterMs, charged.remaining);
      }
    }
    timing.mark("gates");
    let refunded = false;
    const refund = () => {
      if (!config.analysisBudgeted || refunded) return;
      refunded = true;
      budget.refund(caller.userId, tier.cost);
    };
    const releaseSlot = () => {
      if (!holdsSlot) return;
      holdsSlot = false;
      analysisSlots.release(caller.userId);
    };

    let streamOwnsSlot = false;
    try {
      // Analysed from the perspective of the side on move — which, by the rule
      // above, is the caller's own side. The adapter hands over that rack only;
      // the opponent reaches the engine as a count.
      const side = context.activeSide;
      const request = toEngineRequest(context.canonical, {
        side,
        // The engine ignores this string and is steered by the numbers below;
        // it is passed through for the engine's own logging.
        difficulty: "analysis",
        sampleCap: tier.sampleCap,
        topN: tier.topN,
        // Generous relative to the sample cap: the cap is meant to be the
        // binding constraint, so the result stays reproducible.
        budgetMs: tier.timeoutMs,
        events,
        seedSalt: `analysis:${level}`,
      });

      const start = (hooks: RunHooks) =>
        runQueued({
          key,
          priority: tier.priority,
          kind: "analysis",
          gameId,
          params: { level },
          caller,
          admittedRevision: context.revision,
          request,
          timeoutMs: tier.timeoutMs,
          signal: c.req.raw.signal,
          hooks,
          onReused: () => {
            refund();
            releaseSlot();
          },
        });

      const present = (response: EngineResponse): AnalysisResult =>
        buildAnalysis({
          response,
          level,
          gameId,
          revision: context.revision,
          turnNumber: context.turnNumber,
          side,
          requestedSamples: tier.sampleCap,
        });

      timing.applyTo(c);
      if (wantsStream(c)) {
        // Streaming hands off the slot: this handler returns as soon as the
        // response head is written, long before the search finishes, so the
        // `finally` below must not release a slot the stream is still holding.
        streamOwnsSlot = true;
        return streamResult(c, start, present, refund, releaseSlot);
      }

      return c.json(present(await start({})));
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      refund();
      throw error;
    } finally {
      if (!streamOwnsSlot) releaseSlot();
    }
  });

  // ── GET /v1/games/:gameId/bot-move  (reconnect) ────────────────────────────
  //
  // A returning client asks: "is there already a bot search for this exact
  // position?" It attaches to a running/queued job or reads its cached move, and
  // is told `idle` when there is none. It never STARTS a search and never spends
  // a budget — starting is the POST's job. Every gate the POST applies is applied
  // here too, so reconnecting can never see something the caller could not
  // otherwise obtain: a cache hit does not bypass auth or authorization.
  app.get("/v1/games/:gameId/bot-move", async (c) => {
    const caller = await authenticate(c);
    const gameId = c.req.param("gameId");

    const context = await source.loadContext(gameId, caller.token);
    requireRevision(context, c.req.query("revision"));
    requirePlayable(context);
    if (!context.botSide || !context.botDifficulty) {
      throw new TurnRuleError("This game has no engine player.");
    }
    if (context.activeSide !== context.botSide) {
      throw new TurnRuleError("It is not the engine's turn.");
    }
    if (!context.callerControlsActiveSide) {
      throw new ForbiddenError("You do not control this game.");
    }

    const botSide = context.botSide;
    const present = (response: EngineResponse) => ({
      revision: context.revision,
      gameId,
      side: botSide,
      move: {
        type: response.type,
        placements: response.placements,
        exchange: response.exchange,
        score: response.score,
      },
      solver: response.solver,
      endgameSolved: response.endgameSolved,
      stats: {
        elapsedMs: Math.round(response.stats.elapsedMs),
        nodes: response.stats.nodes,
        samples: response.stats.samples,
      },
    });

    const key = `bot:${gameId}:${context.revision}:${context.botDifficulty}`;
    return streamReconnect(c, key, present);
  });

  // ── GET /v1/games/:gameId/bot-move/reasoning ───────────────────────────────
  //
  // "Why did the bot play that?" — the engine's own ranking for a bot move that
  // has already been played, read A PAGE AT A TIME.
  //
  // ### Why this is a separate endpoint
  //
  // The move response is applied to the board by a client that is mid-turn, and
  // it must stay small and arrive fast. The candidate report is the opposite
  // kind of payload: dozens of rows with a full value decomposition, wanted by
  // one player, occasionally, after the fact. Shipping it with every move would
  // pay for it on every turn whether or not anyone opened the panel. So it is
  // read on demand and in pages, and nothing is recomputed to serve it — the
  // registry already holds the completed search for `botResultTtlMs`.
  //
  // ### What this widens, and what it does not
  //
  // The candidate report describes the BOT's rack: the alternatives it weighed
  // name tiles it holds. This endpoint therefore serves it only to the one
  // caller who is already entitled to that rack — the player who controls this
  // bot room, the same person the POST above requires. A spectator is refused
  // here exactly as they are refused there, and a human-vs-human room has no
  // engine player to explain.
  //
  // (Within THIS deployment the incremental exposure is nil in any case:
  // `get_live_game_snapshot` already returns the full inventory, both racks
  // included, to anyone who can read the game. That is a pre-existing property
  // documented in ENGINE_BACKEND.md §5 and is not relied on here — the gate
  // below stands on its own.)
  //
  // Never starts a search, never spends a budget, and answers only about a move
  // that has already been made.
  app.get("/v1/games/:gameId/bot-move/reasoning", async (c) => {
    const caller = await authenticate(c);
    const gameId = c.req.param("gameId");

    // A SELECT gated on `can_read_live_game`: no read access is a 404 here, as
    // everywhere else, and says nothing about whether the room exists.
    const context = await source.loadContext(gameId, caller.token);
    if (!context.botSide || !context.botDifficulty) {
      throw new TurnRuleError("This game has no engine player.");
    }
    if (!context.callerControlsActiveSide) {
      throw new ForbiddenError("You do not control this game.");
    }

    // Deliberately NOT `requirePlayable`, and deliberately not `requireRevision`.
    //
    // The move being explained is in the past: by the time the panel opens, the
    // game has advanced past the revision the search was admitted at, and it may
    // have ENDED on that very move. Refusing either case would hide the report
    // for the one position players most want it — the last one.
    const requested = c.req.query("revision");
    if (requested === undefined) throw new BadRequestError("revision is required.");
    const revision = Number(requested);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new BadRequestError("revision must be a whole number.");
    }
    if (revision > context.revision || context.revision - revision > REASONING_LOOKBACK) {
      throw new StaleRevisionError(context.revision, revision);
    }

    const snapshot = registry.inspect(`bot:${gameId}:${revision}:${context.botDifficulty}`);
    if (!snapshot) {
      // Nothing is held for this position. Retention is bounded and in-memory,
      // so an old move or a restarted service is an ordinary, expected outcome —
      // said plainly rather than dressed up as a failure.
      throw new ReasoningUnavailableError(
        "The engine no longer holds its reasoning for that move.",
      );
    }
    if (snapshot.status !== "completed") {
      throw new ReasoningUnavailableError("That search has not finished yet.");
    }

    const result = snapshot.result;
    // Ranked by value, chosen move first among equals — the engine's own order,
    // preserved. Paging is a window onto it, never a re-sort.
    const ranked = result.candidates ?? [];
    const offset = pageNumber(c.req.query("offset"), 0, 0, Math.max(0, ranked.length));
    const limit = pageNumber(c.req.query("limit"), REASONING_PAGE_DEFAULT, 1, REASONING_PAGE_MAX);
    const chosenIndex = ranked.findIndex((candidate) => candidate.chosen);

    return c.json({
      gameId,
      revision,
      side: context.botSide,
      difficulty: context.botDifficulty,
      solver: result.solver,
      endgameSolved: result.endgameSolved,
      ...(result.expectedFinalDiff != null ? { expectedFinalDiff: result.expectedFinalDiff } : {}),
      score: result.score,
      equity: result.equity,
      stats: {
        moves: result.stats.moves,
        nodes: result.stats.nodes,
        elapsedMs: Math.round(result.stats.elapsedMs),
        candidates: result.stats.candidates,
        samples: result.stats.samples,
        ...(result.stats.genCalls != null ? { genCalls: result.stats.genCalls } : {}),
      },
      page: { offset, limit, total: ranked.length },
      candidates: ranked.slice(offset, offset + limit),
      // The two rows every page needs regardless of which page it is: the
      // chosen move anchors the Δ column, and the runner-up is the comparison
      // the summary sentence is about. Repeating two rows per page is what lets
      // a client render any page without having fetched page one.
      chosenIndex: chosenIndex >= 0 ? chosenIndex : null,
      ...(chosenIndex >= 0 ? { chosen: ranked[chosenIndex] } : {}),
      ...(ranked.length > 1
        ? { runnerUp: ranked[chosenIndex === 0 || chosenIndex < 0 ? 1 : 0] }
        : {}),
    });
  });

  // ── GET /v1/games/:gameId/analysis  (reconnect) ────────────────────────────
  //
  // The same reconnect contract for analysis. The level is part of the job's
  // identity, so it is named in the query. Cached-or-in-flight only; never starts
  // a search, never charges a budget, never takes an analysis slot.
  app.get("/v1/games/:gameId/analysis", async (c) => {
    const caller = await authenticate(c);
    const gameId = c.req.param("gameId");
    const levelParam = c.req.query("level");
    const level: AnalysisLevel = isAnalysisLevel(levelParam) ? levelParam : "quick";

    const context = await source.loadContext(gameId, caller.token);
    requireRevision(context, c.req.query("revision"));
    requirePlayable(context);
    if (context.activeSideIsBot) {
      throw new AnalysisNotAllowedError("Analysis is only available on a turn a human is playing.");
    }
    if (!context.callerControlsActiveSide) {
      throw new AnalysisNotAllowedError("Analysis is only available on your own turn.");
    }

    const side = context.activeSide;
    const tier = ANALYSIS_LEVEL_CONFIG[level];
    const present = (response: EngineResponse): AnalysisResult =>
      buildAnalysis({
        response,
        level,
        gameId,
        revision: context.revision,
        turnNumber: context.turnNumber,
        side,
        requestedSamples: tier.sampleCap,
      });

    const key = `analysis:${gameId}:${context.revision}:${level}`;
    return streamReconnect(c, key, present);
  });

  // ── GET /v1/games/:gameId/jobs  (discovery) ────────────────────────────────
  //
  // "What is already running for this position?"
  //
  // Without this the browser had to REMEMBER what it started, because an
  // analysis is identified partly by its level and the level is not derivable
  // from the game row. That note lived in one tab's session storage, so losing
  // it — a second tab, a cleared cache, a mistimed reset — made a running search
  // permanently unreachable while the registry still held it, and the only way
  // out was to press Analyze and pay for it again.
  //
  // This never starts work, never spends budget, and never returns an answer:
  // it returns the SHAPE of what exists, so the client knows which attach
  // endpoint to open. Reading a result still goes through those endpoints, which
  // apply the same presentation rules — so nothing here can widen what a caller
  // may see.
  //
  // Each kind is gated by exactly the rule its own attach endpoint applies, so
  // discovery can never reveal the existence of work the caller could not
  // otherwise observe.
  app.get("/v1/games/:gameId/jobs", async (c) => {
    const caller = await authenticate(c);
    const gameId = c.req.param("gameId");

    // `loadContext` is a SELECT gated on `can_read_live_game`, so a caller with
    // no read access gets 404 here exactly as everywhere else.
    const context = await source.loadContext(gameId, caller.token);
    requireRevision(context, c.req.query("revision"));

    const controlsActiveSide = context.callerControlsActiveSide;
    const mayDiscoverBot =
      context.botSide !== null &&
      context.activeSide === context.botSide &&
      controlsActiveSide;
    const mayDiscoverAnalysis = !context.activeSideIsBot && controlsActiveSide;

    const jobs = registry
      .listForGame(gameId, context.revision)
      .filter((job) => (job.kind === "bot" ? mayDiscoverBot : mayDiscoverAnalysis))
      .map((job) => ({
        kind: job.kind,
        // Only the discriminator its own kind uses. A bot job's difficulty is
        // already a column the caller can read; an analysis level is the
        // caller's own choice coming back to them.
        ...(job.params.level != null ? { level: job.params.level } : {}),
        ...(job.params.difficulty != null ? { difficulty: job.params.difficulty } : {}),
        status: job.status,
        // The engine's own numbers, identical to what the attach stream would
        // replay one round trip later. Included so a returning client paints the
        // true percentage on its first frame instead of a fabricated zero.
        ...(job.progress
          ? {
              progress: {
                phase: job.progress.phase,
                percent: job.progress.percent,
                elapsedMs: Math.round(job.progress.elapsedMs),
                etaMs: Math.round(job.progress.etaMs),
                detail: job.progress.detail,
              },
            }
          : {}),
        ...(job.position ? { queue: { ahead: job.position.ahead, position: job.position.position } } : {}),
      }));

    return c.json({ gameId, revision: context.revision, jobs });
  });

  // ── POST /v1/games/:gameId/analysis/cancel ─────────────────────────────────
  //
  // Explicit cancellation — the player pressed "cancel". Distinct from a
  // disconnect, which never cancels. Only the human who controls this turn may
  // cancel their own analysis; the same authorization gate as starting it.
  app.post("/v1/games/:gameId/analysis/cancel", async (c) => {
    const caller = await authenticate(c);
    const gameId = c.req.param("gameId");
    const body = await readBody(c);
    const level: AnalysisLevel = isAnalysisLevel(body.level) ? body.level : "quick";

    const context = await source.loadContext(gameId, caller.token);
    requireRevision(context, body.expectedRevision);
    if (!context.callerControlsActiveSide) {
      throw new AnalysisNotAllowedError("Analysis is only available on your own turn.");
    }

    const key = `analysis:${gameId}:${context.revision}:${level}`;
    return c.json({ cancelled: registry.cancel(key) });
  });

  // ── failure translation ────────────────────────────────────────────────────
  //
  // One place, so no handler can accidentally leak an internal message. Every
  // response says what the caller can do about it and nothing about the game
  // they were refused.

  // ── POST /v1/study/analysis ────────────────────────────────────────────────
  //
  // Analyse a position the caller invented. No room, no revision, no turn: the
  // body IS the position, which is why `study.ts` validates it against the
  // physical tile set before anything downstream believes it.
  //
  // Three things make this safe to accept as input where a game position never
  // would be:
  //
  //   • There is nothing to leak. The only rack in the request is the caller's
  //     own, and they typed it. The hidden-information rule that shapes every
  //     other endpoint has no subject here.
  //   • There is nothing to go stale. A made-up position has no game moving on
  //     underneath it, so there is no revision to check and none is invented.
  //   • It cannot reach a real game. It takes a position, not a game id, so
  //     there is no identifier a caller could substitute to have the server
  //     read a board it is not entitled to.
  //
  // It is metered exactly like the compute it is: a bot tier's cost, and the
  // same one-at-a-time slot analysis uses. It queues BEHIND every analysis
  // level and every bot turn, because a study aid must never make somebody's
  // live game wait.
  app.post("/v1/study/analysis", async (c) => {
    const timing = new RequestTiming();
    const caller = await authenticate(c);
    timing.mark("auth");
    const body = await readBody(c);

    if (!isBotTier(body.level)) {
      throw new BadRequestError(
        `level must be one of ${BOT_TIERS.join(", ")}; got "${String(body.level)}".`,
      );
    }
    const level = body.level;
    const tier = BOT_TIER_CONFIG[level];

    let position;
    try {
      position = parseStudyPosition(body);
    } catch (error) {
      if (error instanceof StudyPositionError) throw new BadRequestError(error.message);
      throw error;
    }
    timing.mark("context");

    // Same shape as analysis: one in flight per account, queued included. A
    // second identical study joins the first instead of taking a slot.
    const key = `study:${seedFor(studyFingerprint(position, level), 0)}:${level}`;
    const alreadyRunning = registry.inspect(key) !== null;
    let holdsSlot = false;
    if (!alreadyRunning) {
      if (!analysisSlots.tryAcquire(caller.userId)) {
        throw new TooManyAnalysesError(analysisSlots.heldBy(caller.userId));
      }
      holdsSlot = true;
    }

    const charged = budget.charge(caller.userId, tier.cost);
    if (!charged.allowed) {
      if (holdsSlot) analysisSlots.release(caller.userId);
      throw new BudgetError(charged.retryAfterMs, charged.remaining);
    }
    timing.mark("gates");

    let refunded = false;
    const refund = () => {
      if (refunded) return;
      refunded = true;
      budget.refund(caller.userId, tier.cost);
    };
    const releaseSlot = () => {
      if (!holdsSlot) return;
      holdsSlot = false;
      analysisSlots.release(caller.userId);
    };

    let streamOwnsSlot = false;
    try {
      const request = toStudyEngineRequest(position, {
        difficulty: level,
        solver: tier.solver,
        ...(tier.budgetMs != null ? { budgetMs: tier.budgetMs } : {}),
        ...(tier.unlimited ? { unlimited: true } : {}),
        // Ask for more than the ten that are kept, so the ten are the top of a
        // real ranking rather than everything the engine happened to report.
        topN: BOT_REPORT_TOP_N,
      });

      const start = (hooks: RunHooks) =>
        runQueued({
          key,
          priority: STUDY_PRIORITY,
          kind: "analysis",
          gameId: key,
          params: { difficulty: level },
          caller,
          admittedRevision: 0,
          request,
          timeoutMs: tier.timeoutMs,
          signal: c.req.raw.signal,
          hooks,
          // Nothing to re-check: see `revalidate` on runQueued.
          revalidate: async () => {},
          onReused: () => {
            refund();
            releaseSlot();
          },
        });

      const present = async (response: EngineResponse): Promise<StudyAnalysisResponse> => {
        const described = buildStudyAnalysis({
          response,
          // Bot tiers bound time, not samples, so "did it finish the schedule"
          // is the engine's own sample count against the full one.
          requestedSamples: response.stats.samples,
          limit: STUDY_TOP_N,
        });

        // The answer is worth returning even if the archive write fails: the
        // compute is already spent, and losing the ranking over a database
        // hiccup would be the one failure the player cannot retry cheaply.
        let recordId: string | null = null;
        let saveError: string | null = null;
        try {
          recordId = await source.saveStudyAnalysis(
            {
              scoreSelf: position.scoreSelf,
              scoreOpponent: position.scoreOpponent,
              board: position.board,
              rack: position.rack,
              oppRackCount: position.oppRackCount,
              bagCount: position.bagCount,
              level,
              summary: described.summary,
              method: described.method,
              candidates: described.candidates,
            },
            caller.token,
          );
        } catch (error) {
          saveError = error instanceof Error ? error.message : "The result could not be saved.";
          console.error("study save failed", saveError);
        }

        return {
          recordId,
          saveError,
          level,
          position: {
            scoreSelf: position.scoreSelf,
            scoreOpponent: position.scoreOpponent,
            board: position.board,
            rack: position.rack,
            oppRackCount: position.oppRackCount,
            bagCount: position.bagCount,
          },
          candidates: described.candidates,
          summary: described.summary,
          method: described.method,
        };
      };

      timing.applyTo(c);
      if (wantsStream(c)) {
        streamOwnsSlot = true;
        return streamResult(c, start, present, refund, releaseSlot);
      }
      return c.json(await present(await start({})));
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      refund();
      throw error;
    } finally {
      if (!streamOwnsSlot) releaseSlot();
    }
  });

  app.onError((error, c) => {
    if (error instanceof UnauthenticatedError) {
      return c.json(fail("unauthenticated", error.message), 401);
    }
    if (error instanceof ForbiddenError) {
      return c.json(fail("forbidden", error.message), 403);
    }
    if (error instanceof AnalysisNotAllowedError) {
      return c.json(fail("analysis_not_allowed", error.message), 403);
    }
    if (error instanceof RoomAccessError) {
      return c.json(
        fail(error.status === 404 ? "not_found" : "forbidden", error.message),
        error.status,
      );
    }
    if (error instanceof StaleRevisionError) {
      return c.json(
        {
          ...fail("stale_revision", error.message),
          currentRevision: error.current,
          requestedRevision: error.requested,
        },
        409,
      );
    }
    if (error instanceof TurnRuleError) {
      return c.json(fail("turn_rule", error.message), 409);
    }
    if (error instanceof ReasoningUnavailableError) {
      // Retention expired, or the service restarted. Nothing is wrong and
      // nothing can be retried into existence; the caller shows the honest
      // sentence rather than an empty table.
      return c.json(fail("reasoning_unavailable", error.message), 404);
    }
    if (error instanceof BadRequestError) {
      return c.json(fail("bad_request", error.message), 400);
    }
    if (error instanceof BodyTooLargeError) {
      return c.json(fail("body_too_large", "The request body is too large."), 413);
    }
    if (error instanceof CanonicalStateError) {
      // The stored position is not the 100-tile set. Reported, never repaired.
      return c.json(fail("invalid_state", "The stored game state is not a lawful position."), 422);
    }
    if (error instanceof BudgetError) {
      c.header("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
      return c.json(
        {
          ...fail("budget_exhausted", "You have used your engine budget for now."),
          retryAfterMs: error.retryAfterMs,
        },
        429,
      );
    }
    if (error instanceof TooManyAnalysesError) {
      return c.json(
        fail("analysis_in_progress", "An analysis is already running for you. Wait for it or cancel it."),
        429,
      );
    }
    if (error instanceof QueueFullError || error instanceof QueueWaitTimeoutError) {
      // An overload is an EXPECTED condition, not a fault. It gets its own code
      // and a retry hint, never a generic 500 the client has to guess about.
      c.header("Retry-After", "10");
      return c.json(fail("queue_full", "The engine is busy. Try again shortly."), 503);
    }
    if (error instanceof EngineTimeoutError) {
      return c.json(fail("engine_timeout", "The engine ran out of time on this position."), 504);
    }
    if (error instanceof EngineCancelledError || error instanceof QueueCancelledError) {
      return c.json(fail("cancelled", "The request was cancelled."), 499 as 500);
    }
    if (error instanceof AnalysisUnavailableError) {
      return c.json(fail("analysis_unavailable", error.message), 422);
    }
    if (error instanceof EngineFailureError) {
      // The engine's own message is operational detail; the caller gets the
      // fact, the log gets the cause.
      console.error("engine failure", error.message, error.detail ?? "");
      return c.json(fail("engine_failed", "The engine could not complete this request."), 502);
    }
    console.error("unhandled", error);
    return c.json(fail("internal", "Something went wrong."), 500);
  });

  app.notFound((c) => c.json(fail("not_found", "No such endpoint."), 404));

  return app;
}

// ── error kinds ──────────────────────────────────────────────────────────────

export class BadRequestError extends Error {
  override readonly name = "BadRequestError";
}
export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
}
export class AnalysisNotAllowedError extends Error {
  override readonly name = "AnalysisNotAllowedError";
}
export class TurnRuleError extends Error {
  override readonly name = "TurnRuleError";
}
/** The engine's reasoning for a move is no longer held — retention lapsed, or
 *  the process restarted. Not a fault: the result cache is bounded and in
 *  memory by design, and the move itself was applied long ago. */
export class ReasoningUnavailableError extends Error {
  override readonly name = "ReasoningUnavailableError";
}
export class StaleRevisionError extends Error {
  override readonly name = "StaleRevisionError";
  constructor(readonly current: number, readonly requested: number) {
    super(
      `This request was composed against revision ${requested}, but the game is at revision ${current}.`,
    );
  }
}
export class BudgetError extends Error {
  override readonly name = "BudgetError";
  constructor(readonly retryAfterMs: number, readonly remaining: number) {
    super("Engine budget exhausted.");
  }
}
export class TooManyAnalysesError extends Error {
  override readonly name = "TooManyAnalysesError";
  constructor(readonly held: number) {
    super("Too many analyses in flight.");
  }
}

export { otherSide };
