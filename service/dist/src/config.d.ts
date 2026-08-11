export type ServiceConfig = {
    port: number;
    /** Path to the compiled `amath_cli`. */
    enginePath: string;
    supabaseUrl: string;
    /** Low-privilege API key. The caller's JWT, not this key, supplies identity. */
    supabasePublishableKey: string;
    /** Origins allowed to call this service. Never `*`: requests carry a bearer
     *  token, and a wildcard would let any page spend a signed-in user's budget. */
    allowedOrigins: string[];
    concurrency: number;
    maxWaiting: number;
    /** Largest request body accepted. The API takes identifiers, not positions,
     *  so this is generous by an order of magnitude already. */
    maxBodyBytes: number;
    /** Per-user compute budget: cost units per window. */
    budgetPerWindow: number;
    budgetWindowMs: number;
    /** Concurrent analysis jobs one user may hold. */
    maxAnalysisPerUser: number;
};
export declare function loadConfig(env?: NodeJS.ProcessEnv): ServiceConfig;
