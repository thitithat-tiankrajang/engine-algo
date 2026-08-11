export type EngineProgress = {
    phase: "movegen" | "sim" | "endgame";
    percent: number;
    elapsedMs: number;
    etaMs: number;
    bestScore: number;
    detail: string;
};
export type EngineCandidate = {
    type: "place" | "exchange" | "pass";
    placements: Array<{
        r: number;
        c: number;
        kind: string;
        token: string;
    }>;
    exchange: string[];
    score: number;
    scoreComp: number;
    leave: number;
    potential: number;
    oppReply: number;
    mean: number;
    stddev: number;
    value: number;
    chosen: boolean;
    proven?: boolean;
};
export type EngineResponse = {
    type: "place" | "exchange" | "pass";
    placements: Array<{
        r: number;
        c: number;
        kind: string;
        token: string;
    }>;
    exchange: string[];
    score: number;
    equity: number;
    solver: "greedy" | "sim" | "endgame";
    endgameSolved: boolean;
    expectedFinalDiff?: number;
    stats: {
        moves: number;
        nodes: number;
        elapsedMs: number;
        candidates: number;
        samples: number;
    };
    candidates?: EngineCandidate[];
    error?: string;
};
export declare class EngineTimeoutError extends Error {
    readonly timeoutMs: number;
    readonly name = "EngineTimeoutError";
    constructor(timeoutMs: number);
}
export declare class EngineCancelledError extends Error {
    readonly name = "EngineCancelledError";
    constructor();
}
export declare class EngineFailureError extends Error {
    readonly detail?: string | undefined;
    readonly name = "EngineFailureError";
    constructor(message: string, detail?: string | undefined);
}
export type RunOptions = {
    binaryPath: string;
    request: unknown;
    /** Hard wall-clock ceiling. The engine's own `budgetMs` should be comfortably
     *  below this; reaching this bound means the engine overshot and is killed. */
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (progress: EngineProgress) => void;
    /** Refuse an engine response larger than this. The engine's own output is
     *  bounded by `topN`, so anything near this bound is a malfunction. */
    maxResponseBytes?: number;
};
export declare function runEngine(options: RunOptions): Promise<EngineResponse>;
