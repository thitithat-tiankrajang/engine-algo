export type Caller = {
    userId: string;
    /** The raw token, forwarded to Postgres so RLS sees the real `auth.uid()`. */
    token: string;
    expiresAt: number;
};
export declare class UnauthenticatedError extends Error {
    readonly name = "UnauthenticatedError";
}
export declare function bearerFrom(header: string | undefined | null): string | null;
export declare function createTokenVerifier(supabaseUrl: string): (token: string) => Promise<Caller>;
