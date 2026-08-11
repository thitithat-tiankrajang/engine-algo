// ── Who is calling ───────────────────────────────────────────────────────────
//
// Two independent checks, in this order:
//
//   1. HERE: the caller's Supabase access token is verified cryptographically,
//      so an unauthenticated request is refused before it can queue work or
//      consume a rate-limit slot. This step establishes an identity to charge.
//   2. In `roomContext.ts`: that same token is used to call Postgres, where RLS
//      decides what the identity may actually see and do.
//
// Step 1 never grants access to anything. It exists so the expensive parts of
// the service are reachable only by someone the project has signed in, and so
// there is a stable user id to meter against.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyResult } from "jose";

export type Caller = {
  userId: string;
  /** The raw token, forwarded to Postgres so RLS sees the real `auth.uid()`. */
  token: string;
  expiresAt: number;
};

export class UnauthenticatedError extends Error {
  override readonly name = "UnauthenticatedError";
}

export function bearerFrom(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authIssuerFor(supabaseUrl: string): string {
  const projectUrl = new URL(supabaseUrl);
  projectUrl.pathname = `${projectUrl.pathname.replace(/\/+$/, "")}/`;
  projectUrl.search = "";
  projectUrl.hash = "";
  return new URL("auth/v1", projectUrl).href.replace(/\/$/, "");
}

export function createTokenVerifier(supabaseUrl: string) {
  const issuer = authIssuerFor(supabaseUrl);
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async function verify(token: string): Promise<Caller> {
    if (!token || token.length > 8 * 1024) {
      throw new UnauthenticatedError("No usable access token was presented.");
    }
    let verified: JWTVerifyResult;
    try {
      verified = await jwtVerify(token, jwks, {
        algorithms: ["ES256", "RS256"],
        issuer,
        audience: "authenticated",
        requiredClaims: ["exp", "sub", "role"],
      });
    } catch {
      throw new UnauthenticatedError("The access token is not valid for this project.");
    }

    const { payload, protectedHeader } = verified;
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const role = typeof payload.role === "string" ? payload.role : "";
    if (!protectedHeader.kid) {
      throw new UnauthenticatedError("The access token names no signing key.");
    }
    if (!USER_ID_PATTERN.test(subject)) {
      throw new UnauthenticatedError("The access token names no user.");
    }
    if (role !== "authenticated") {
      // A token with `role: "anon"` identifies no signed-in user, so it can
      // neither be metered nor authorized.
      throw new UnauthenticatedError("A signed-in user is required.");
    }
    // `exp` is required above and jwtVerify rejects it once it is in the past.
    const expiresAt = (payload.exp as number) * 1000;

    return { userId: subject, token, expiresAt };
  };
}
