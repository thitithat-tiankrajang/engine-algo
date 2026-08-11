export type QueuedTask<T> = {
    key: string;
    priority: number;
    run: (signal: AbortSignal) => Promise<T>;
};
export declare class QueueFullError extends Error {
    readonly waiting: number;
    readonly name = "QueueFullError";
    constructor(waiting: number);
}
export type QueueStats = {
    running: number;
    waiting: number;
    concurrency: number;
};
export declare class EngineQueue {
    #private;
    constructor(options: {
        concurrency: number;
        maxWaiting: number;
    });
    stats(): QueueStats;
    /** How many callers are attached to a live run, or 0 if it is not running. */
    refsFor(key: string): number;
    /**
     * Submit work, or attach to the identical work already in flight.
     *
     * The returned promise is per-caller; the underlying run is shared. A caller
     * that goes away decrements the reference count, and the engine process is
     * cancelled only when the LAST interested caller has gone. One player
     * navigating away must not cancel the analysis their opponent is watching.
     */
    submit<T>(task: QueuedTask<T>, callerSignal?: AbortSignal): Promise<T>;
    /** Cancel a live run regardless of reference count. Used by an explicit
     *  cancel request from the caller that owns the job. */
    cancel(key: string): boolean;
}
