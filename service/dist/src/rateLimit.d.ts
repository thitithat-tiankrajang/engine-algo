export type BudgetDecision = {
    allowed: true;
    remaining: number;
} | {
    allowed: false;
    remaining: number;
    retryAfterMs: number;
};
export declare class ComputeBudget {
    #private;
    constructor(options: {
        perWindow: number;
        windowMs: number;
    });
    /** Charge `cost` to a user. Rejected charges cost nothing, so a user who is
     *  over budget is not pushed further over by retrying. */
    charge(userId: string, cost: number, now?: number): BudgetDecision;
    /** Hand budget back when work was refused before it ran. */
    refund(userId: string, cost: number): void;
    /** Drop windows that have expired. Called on a timer so an idle service does
     *  not hold a map entry per user who ever visited. */
    sweep(now?: number): void;
    get size(): number;
}
export declare class ConcurrencyLimit {
    #private;
    constructor(max: number);
    tryAcquire(userId: string): boolean;
    release(userId: string): void;
    heldBy(userId: string): number;
}
