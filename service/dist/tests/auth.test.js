import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier, UnauthenticatedError } from "../src/auth.js";
const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
let server;
let supabaseUrl;
let issuer;
let signingKeys;
let requestedPaths;
async function makeSigningKey(kid) {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    return {
        kid,
        privateKey,
        publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" },
    };
}
beforeAll(async () => {
    signingKeys = await Promise.all([makeSigningKey("current-key"), makeSigningKey("rotated-key")]);
    requestedPaths = [];
    server = createServer((request, response) => {
        requestedPaths.push(request.url ?? "");
        if (request.url !== "/auth/v1/.well-known/jwks.json") {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ keys: signingKeys.map((key) => key.publicJwk) }));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Test JWKS server did not start.");
    supabaseUrl = `http://127.0.0.1:${address.port}`;
    issuer = `${supabaseUrl}/auth/v1`;
});
afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
async function token(options = {}) {
    const key = options.key ?? signingKeys[0];
    const jwt = new SignJWT(options.role === null ? {} : { role: options.role ?? "authenticated" })
        .setProtectedHeader({ alg: "ES256", ...(options.kid === null ? {} : { kid: options.kid ?? key.kid }) })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? "authenticated")
        .setIssuedAt();
    if (options.subject !== null)
        jwt.setSubject(options.subject ?? USER_ID);
    if (options.expiration !== null)
        jwt.setExpirationTime(options.expiration ?? Math.floor(Date.now() / 1000) + 300);
    return jwt.sign(key.privateKey);
}
describe("Supabase access-token verification", () => {
    it("derives the project JWKS URL and accepts current and rotated signing kids", async () => {
        requestedPaths.length = 0;
        const verify = createTokenVerifier(`${supabaseUrl}/`);
        const current = await verify(await token({ key: signingKeys[0] }));
        const rotated = await verify(await token({ key: signingKeys[1] }));
        expect(current.userId).toBe(USER_ID);
        expect(rotated.userId).toBe(USER_ID);
        expect(current.expiresAt).toBeGreaterThan(Date.now());
        expect(requestedPaths).toEqual(["/auth/v1/.well-known/jwks.json"]);
    });
    it("rejects a token signed by a key outside the project JWKS", async () => {
        const foreignKey = await makeSigningKey("foreign-key");
        await expect(createTokenVerifier(supabaseUrl)(await token({ key: foreignKey }))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it("rejects a legacy shared-secret signature", async () => {
        const legacyToken = await new SignJWT({ role: "authenticated" })
            .setProtectedHeader({ alg: "HS256", kid: "legacy-secret" })
            .setIssuer(issuer)
            .setAudience("authenticated")
            .setSubject(USER_ID)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(new TextEncoder().encode("legacy-shared-secret"));
        await expect(createTokenVerifier(supabaseUrl)(legacyToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it("rejects an expired token", async () => {
        await expect(createTokenVerifier(supabaseUrl)(await token({ expiration: Math.floor(Date.now() / 1000) - 1 }))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it("rejects a token issued by another project", async () => {
        await expect(createTokenVerifier(supabaseUrl)(await token({ issuer: "https://other.supabase.co/auth/v1" }))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it("rejects a token for the wrong audience", async () => {
        await expect(createTokenVerifier(supabaseUrl)(await token({ audience: "anon" }))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it.each([
        ["expiration", { expiration: null }],
        ["subject", { subject: null }],
        ["authenticated role", { role: null }],
        ["signing key id", { kid: null }],
    ])("rejects a token without the required %s claim", async (_name, options) => {
        await expect(createTokenVerifier(supabaseUrl)(await token(options))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it("rejects a non-user subject", async () => {
        await expect(createTokenVerifier(supabaseUrl)(await token({ subject: "not-a-user-uuid" }))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
    it("rejects a non-authenticated Postgres role", async () => {
        await expect(createTokenVerifier(supabaseUrl)(await token({ role: "service_role" }))).rejects.toBeInstanceOf(UnauthenticatedError);
    });
});
//# sourceMappingURL=auth.test.js.map