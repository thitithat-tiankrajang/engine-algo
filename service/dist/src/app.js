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
//   2. METERING         per-user compute budget and concurrency (rateLimit.ts)
//   3. AUTHORIZATION    what Postgres says this user may do here (roomContext.ts)
//   4. TURN RULES       enforced below, and only below — the UI's copy of these
//                       rules is a convenience, never the decision
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { AnalysisUnavailableError, buildAnalysis } from "./analysis.js";
import { UnauthenticatedError, bearerFrom, createTokenVerifier } from "./auth.js";
import { toEngineRequest } from "./adapter.js";
import { CanonicalStateError, otherSide } from "./canonical.js";
import { EngineCancelledError, EngineFailureError, EngineTimeoutError, runEngine, } from "./engineRunner.js";
import { ANALYSIS_LEVEL_CONFIG, BOT_PRIORITY, BOT_TIER_CONFIG, isAnalysisLevel, } from "./levels.js";
import { EngineQueue, QueueFullError } from "./queue.js";
import { ComputeBudget, ConcurrencyLimit } from "./rateLimit.js";
import { RoomAccessError } from "./roomContext.js";
/** How many trailing commands to read for the scoreless-turn streak. The rule
 *  ends a game at six, so anything beyond this cannot change the answer. */
const STREAK_LOOKBACK = 24;
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
function wantsStream(c) {
    return (c.req.header("Accept") ?? "").includes("text/event-stream");
}
function fail(code, message, detail) {
    return detail ? { error: message, code, detail } : { error: message, code };
}
/**
 * Run a search with its progress streamed, then send the result.
 *
 * The contract on the wire is three event kinds — `progress`, `result`,
 * `error` — and exactly one of `result` or `error` ends the stream. A client
 * that sees neither has lost the connection, which is a case it must handle
 * anyway.
 *
 * Progress is throttled: the engine reports every sample, which on a long
 * search is hundreds of messages nobody reads. One per 400ms is enough to keep
 * a progress bar honest and the connection warm.
 */
function streamResult(c, start, present, onFailure, onSettled) {
    return streamSSE(c, async (stream) => {
        let lastSent = 0;
        try {
            const response = await start((progress) => {
                const now = Date.now();
                if (now - lastSent < 400)
                    return;
                lastSent = now;
                void stream.writeSSE({
                    event: "progress",
                    data: JSON.stringify({
                        phase: progress.phase,
                        percent: progress.percent,
                        elapsedMs: Math.round(progress.elapsedMs),
                        etaMs: Math.round(progress.etaMs),
                        detail: progress.detail,
                    }),
                });
            });
            await stream.writeSSE({ event: "result", data: JSON.stringify(present(response)) });
        }
        catch (error) {
            onFailure();
            const described = describeStreamError(error);
            await stream.writeSSE({ event: "error", data: JSON.stringify(described) });
        }
        finally {
            onSettled?.();
        }
    });
}
/** The same coded errors the JSON path returns, for a failure that arrives
 *  after the status line has already been sent. */
function describeStreamError(error) {
    if (error instanceof EngineTimeoutError) {
        return { code: "engine_timeout", error: "The engine ran out of time on this position." };
    }
    if (error instanceof EngineCancelledError) {
        return { code: "cancelled", error: "The request was cancelled." };
    }
    if (error instanceof QueueFullError) {
        return { code: "queue_full", error: "The engine is busy. Try again shortly." };
    }
    if (error instanceof AnalysisUnavailableError) {
        return { code: "analysis_unavailable", error: error.message };
    }
    if (error instanceof EngineFailureError) {
        console.error("engine failure (stream)", error.message, error.detail ?? "");
        return { code: "engine_failed", error: "The engine could not complete this request." };
    }
    console.error("unhandled (stream)", error);
    return { code: "internal", error: "Something went wrong." };
}
export function createApp(deps) {
    const { config, source, queue, budget, analysisSlots } = deps;
    const engine = deps.runEngine ?? runEngine;
    const verify = deps.verifyToken ?? createTokenVerifier(config.supabaseUrl);
    const app = new Hono();
    app.use("*", cors({
        origin: config.allowedOrigins,
        allowMethods: ["POST", "GET", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: 600,
    }));
    // Liveness only. Deliberately says nothing about games, users or load beyond
    // the queue depth an operator needs to see.
    app.get("/health", (c) => c.json({ ok: true, queue: queue.stats() }));
    // ── shared request handling ────────────────────────────────────────────────
    async function authenticate(c) {
        const token = bearerFrom(c.req.header("Authorization"));
        if (!token)
            throw new UnauthenticatedError("An access token is required.");
        return verify(token);
    }
    async function readBody(c) {
        const declared = Number(c.req.header("Content-Length") ?? "0");
        if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
            throw new BodyTooLargeError();
        }
        const text = await c.req.text();
        // Content-Length is a claim; the body is the fact.
        if (text.length > config.maxBodyBytes)
            throw new BodyTooLargeError();
        if (!text.trim())
            return {};
        try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new BadRequestError("The request body must be a JSON object.");
            }
            return parsed;
        }
        catch (error) {
            if (error instanceof BadRequestError)
                throw error;
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
    function requireRevision(context, claimed) {
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
    function requirePlayable(context) {
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
        const caller = await authenticate(c);
        const gameId = c.req.param("gameId");
        const body = await readBody(c);
        const context = await source.loadContext(gameId, caller.token);
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
        const cost = context.botDifficulty === "max" ? 8 : 2;
        const charged = budget.charge(caller.userId, cost);
        if (!charged.allowed)
            throw new BudgetError(charged.retryAfterMs, charged.remaining);
        const events = await source.loadRecentCommands(gameId, caller.token, context.revision, STREAK_LOOKBACK);
        const request = toEngineRequest(context.canonical, {
            side: context.botSide,
            difficulty: context.botDifficulty,
            ...(tier.budgetMs != null ? { budgetMs: tier.budgetMs } : {}),
            events,
        });
        // Only the move goes back. The candidate report is the engine's reasoning
        // about the BOT's rack, and the player on the other side is not entitled to
        // it — it would name tiles the bot holds. `mapBotResponse` in the client
        // needs the move and nothing else.
        const present = (response) => ({
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
        const start = (onProgress) => queue.submit({
            key,
            priority: BOT_PRIORITY,
            run: (signal) => engine({
                binaryPath: config.enginePath,
                request,
                timeoutMs: tier.timeoutMs,
                signal,
                ...(onProgress ? { onProgress } : {}),
            }),
        }, c.req.raw.signal);
        if (wantsStream(c)) {
            return streamResult(c, start, present, () => budget.refund(caller.userId, cost));
        }
        try {
            return c.json(present(await start()));
        }
        catch (error) {
            budget.refund(caller.userId, cost);
            throw error;
        }
    });
    // ── POST /v1/games/:gameId/analysis ────────────────────────────────────────
    app.post("/v1/games/:gameId/analysis", async (c) => {
        const caller = await authenticate(c);
        const gameId = c.req.param("gameId");
        const body = await readBody(c);
        const level = isAnalysisLevel(body.level) ? body.level : "quick";
        const tier = ANALYSIS_LEVEL_CONFIG[level];
        const context = await source.loadContext(gameId, caller.token);
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
            throw new AnalysisNotAllowedError("Analysis is only available on a turn a human is playing.");
        }
        if (!context.callerControlsActiveSide) {
            throw new AnalysisNotAllowedError("Analysis is only available on your own turn.");
        }
        if (!analysisSlots.tryAcquire(caller.userId)) {
            throw new TooManyAnalysesError(analysisSlots.heldBy(caller.userId));
        }
        const charged = budget.charge(caller.userId, tier.cost);
        if (!charged.allowed) {
            analysisSlots.release(caller.userId);
            throw new BudgetError(charged.retryAfterMs, charged.remaining);
        }
        let streamOwnsSlot = false;
        try {
            const events = await source.loadRecentCommands(gameId, caller.token, context.revision, STREAK_LOOKBACK);
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
            const key = `analysis:${gameId}:${context.revision}:${level}`;
            const start = (onProgress) => queue.submit({
                key,
                priority: tier.priority,
                run: (signal) => engine({
                    binaryPath: config.enginePath,
                    request,
                    timeoutMs: tier.timeoutMs,
                    signal,
                    ...(onProgress ? { onProgress } : {}),
                }),
            }, c.req.raw.signal);
            const present = (response) => buildAnalysis({
                response,
                level,
                gameId,
                revision: context.revision,
                turnNumber: context.turnNumber,
                side,
                requestedSamples: tier.sampleCap,
            });
            if (wantsStream(c)) {
                // Streaming hands off the slot: this handler returns as soon as the
                // response head is written, long before the search finishes, so the
                // `finally` below must not release a slot the stream is still holding.
                streamOwnsSlot = true;
                return streamResult(c, start, present, () => {
                    budget.refund(caller.userId, tier.cost);
                }, () => {
                    analysisSlots.release(caller.userId);
                });
            }
            return c.json(present(await start()));
        }
        catch (error) {
            if (error instanceof BudgetError)
                throw error;
            budget.refund(caller.userId, tier.cost);
            throw error;
        }
        finally {
            if (!streamOwnsSlot)
                analysisSlots.release(caller.userId);
        }
    });
    // ── failure translation ────────────────────────────────────────────────────
    //
    // One place, so no handler can accidentally leak an internal message. Every
    // response says what the caller can do about it and nothing about the game
    // they were refused.
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
            return c.json(fail(error.status === 404 ? "not_found" : "forbidden", error.message), error.status);
        }
        if (error instanceof StaleRevisionError) {
            return c.json({
                ...fail("stale_revision", error.message),
                currentRevision: error.current,
                requestedRevision: error.requested,
            }, 409);
        }
        if (error instanceof TurnRuleError) {
            return c.json(fail("turn_rule", error.message), 409);
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
            return c.json({
                ...fail("budget_exhausted", "You have used your engine budget for now."),
                retryAfterMs: error.retryAfterMs,
            }, 429);
        }
        if (error instanceof TooManyAnalysesError) {
            return c.json(fail("analysis_in_progress", "An analysis is already running for you. Wait for it or cancel it."), 429);
        }
        if (error instanceof QueueFullError) {
            c.header("Retry-After", "10");
            return c.json(fail("queue_full", "The engine is busy. Try again shortly."), 503);
        }
        if (error instanceof EngineTimeoutError) {
            return c.json(fail("engine_timeout", "The engine ran out of time on this position."), 504);
        }
        if (error instanceof EngineCancelledError) {
            return c.json(fail("cancelled", "The request was cancelled."), 499);
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
    name = "BadRequestError";
}
export class BodyTooLargeError extends Error {
    name = "BodyTooLargeError";
}
export class ForbiddenError extends Error {
    name = "ForbiddenError";
}
export class AnalysisNotAllowedError extends Error {
    name = "AnalysisNotAllowedError";
}
export class TurnRuleError extends Error {
    name = "TurnRuleError";
}
export class StaleRevisionError extends Error {
    current;
    requested;
    name = "StaleRevisionError";
    constructor(current, requested) {
        super(`This request was composed against revision ${requested}, but the game is at revision ${current}.`);
        this.current = current;
        this.requested = requested;
    }
}
export class BudgetError extends Error {
    retryAfterMs;
    remaining;
    name = "BudgetError";
    constructor(retryAfterMs, remaining) {
        super("Engine budget exhausted.");
        this.retryAfterMs = retryAfterMs;
        this.remaining = remaining;
    }
}
export class TooManyAnalysesError extends Error {
    held;
    name = "TooManyAnalysesError";
    constructor(held) {
        super("Too many analyses in flight.");
        this.held = held;
    }
}
export { otherSide };
//# sourceMappingURL=app.js.map