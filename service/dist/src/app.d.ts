import { Hono } from "hono";
import { type Caller } from "./auth.js";
import { otherSide } from "./canonical.js";
import type { ServiceConfig } from "./config.js";
import { runEngine } from "./engineRunner.js";
import { EngineQueue } from "./queue.js";
import { ComputeBudget, ConcurrencyLimit } from "./rateLimit.js";
import { type GameStateSource } from "./roomContext.js";
export type AppDependencies = {
    config: ServiceConfig;
    source: GameStateSource;
    queue: EngineQueue;
    budget: ComputeBudget;
    analysisSlots: ConcurrencyLimit;
    /** Injectable so tests can drive the whole request path without a compiler
     *  or a several-second search. */
    runEngine?: typeof runEngine;
    verifyToken?: (token: string) => Promise<Caller>;
};
export declare function createApp(deps: AppDependencies): Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export declare class BadRequestError extends Error {
    readonly name = "BadRequestError";
}
export declare class BodyTooLargeError extends Error {
    readonly name = "BodyTooLargeError";
}
export declare class ForbiddenError extends Error {
    readonly name = "ForbiddenError";
}
export declare class AnalysisNotAllowedError extends Error {
    readonly name = "AnalysisNotAllowedError";
}
export declare class TurnRuleError extends Error {
    readonly name = "TurnRuleError";
}
export declare class StaleRevisionError extends Error {
    readonly current: number;
    readonly requested: number;
    readonly name = "StaleRevisionError";
    constructor(current: number, requested: number);
}
export declare class BudgetError extends Error {
    readonly retryAfterMs: number;
    readonly remaining: number;
    readonly name = "BudgetError";
    constructor(retryAfterMs: number, remaining: number);
}
export declare class TooManyAnalysesError extends Error {
    readonly held: number;
    readonly name = "TooManyAnalysesError";
    constructor(held: number);
}
export { otherSide };
