/**
 * Signed, short-lived, audience-bound access tokens for the OAuth facade, plus
 * signed authorization codes.
 *
 * Replaces the previous design where /oauth/token returned the raw master
 * API_KEY as the access_token — a permanent, full-access credential that, once
 * leaked (logs, referrers, a compromised client), gave indefinite SSH access to
 * every registered server. Tokens here are HMAC-SHA256 signed, carry an audience
 * + expiry, and are revocable: rotating the signing secret (ACCESS_TOKEN_SECRET,
 * or the fallback CLIENT_SECRET / API_KEY) invalidates every issued token at once.
 *
 * Format: `<base64url(payload)>.<base64url(hmac-sha256(payload))>`
 * Signing key: ACCESS_TOKEN_SECRET, falling back to CLIENT_SECRET, then API_KEY.
 */

import { createHmac, timingSafeEqual } from "crypto";

function signingSecret(): string {
  const secret =
    process.env.ACCESS_TOKEN_SECRET ?? process.env.CLIENT_SECRET ?? process.env.API_KEY;
  if (!secret) {
    throw new Error(
      "Cannot sign access tokens: set ACCESS_TOKEN_SECRET, CLIENT_SECRET, or API_KEY."
    );
  }
  return secret;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", signingSecret()).update(payloadB64).digest("base64url");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function pack(claims: object): string {
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

function unpack(token: string): Record<string, unknown> | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(payloadB64);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

interface AccessClaims {
  t: "at";
  aud: string;
  iss: string;
  cid: string;
  iat: number;
  exp: number;
}

export function signAccessToken(opts: {
  audience: string;
  issuer: string;
  clientId: string;
  expiresInSec: number;
}): { token: string; expiresIn: number } {
  const claims: AccessClaims = {
    t: "at",
    aud: opts.audience,
    iss: opts.issuer,
    cid: opts.clientId,
    iat: nowSec(),
    exp: nowSec() + opts.expiresInSec,
  };
  return { token: pack(claims), expiresIn: opts.expiresInSec };
}

/** True only if signature matches, type is access-token, audience matches, and not expired. */
export function verifyAccessToken(token: string, expected: { audience: string }): boolean {
  const c = unpack(token) as AccessClaims | null;
  if (!c || c.t !== "at") return false;
  if (c.aud !== expected.audience) return false;
  if (typeof c.exp !== "number" || c.exp < nowSec()) return false;
  return true;
}

interface CodeClaims {
  t: "ac";
  cc: string; // PKCE code_challenge
  cm: string; // PKCE code_challenge_method
  exp: number;
}

/**
 * Signed, short-lived authorization code carrying only the PKCE challenge — no
 * secret — so it is safe to appear in a redirect URL. The token endpoint verifies
 * the signature (proving we issued it) + expiry + PKCE.
 */
export function signAuthCode(opts: {
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresInSec: number;
}): string {
  const claims: CodeClaims = {
    t: "ac",
    cc: opts.codeChallenge,
    cm: opts.codeChallengeMethod,
    exp: nowSec() + opts.expiresInSec,
  };
  return pack(claims);
}

export function verifyAuthCode(code: string): { cc: string; cm: string } | null {
  const c = unpack(code) as CodeClaims | null;
  if (!c || c.t !== "ac") return null;
  if (typeof c.exp !== "number" || c.exp < nowSec()) return null;
  return { cc: c.cc ?? "", cm: c.cm ?? "" };
}
