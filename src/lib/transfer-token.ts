/**
 * Short-lived, scoped tokens for the streaming file-transfer endpoints.
 *
 * A token authorizes ONE operation (upload | download) against ONE server +
 * path, and expires after a few minutes. It is minted server-side by the
 * `prepare_file_transfer` tool and handed to the model, which puts it in an
 * `Authorization: Bearer` header when it runs the returned curl command in its
 * local shell. This lets bytes stream local↔VPS without the master API_KEY ever
 * leaving the host or the SSH key ever leaving the vault.
 *
 * Format: `<base64url(payload)>.<base64url(hmac-sha256(payload))>`
 * Signing key: TRANSFER_SECRET, falling back to API_KEY.
 */

import { createHmac, timingSafeEqual } from "crypto";

export type TransferOp = "upload" | "download";

interface TransferClaims {
  s: string; // server name
  p: string; // remote absolute path
  o: TransferOp; // operation
  e: number; // expiry, unix seconds
}

function signingSecret(): string {
  const secret = process.env.TRANSFER_SECRET ?? process.env.API_KEY;
  if (!secret) {
    throw new Error(
      "Cannot sign transfer tokens: set TRANSFER_SECRET or API_KEY in the environment."
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

export function signTransferToken(opts: {
  server: string;
  path: string;
  op: TransferOp;
  expiresInSec: number;
}): { token: string; expiresAt: number } {
  const expiresAt = nowSec() + opts.expiresInSec;
  const claims: TransferClaims = { s: opts.server, p: opts.path, o: opts.op, e: expiresAt };
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${payloadB64}.${sign(payloadB64)}`, expiresAt };
}

/**
 * Returns true only if the token is well-formed, the signature matches, it has
 * not expired, and its claims exactly match the requested server/path/op.
 */
export function verifyTransferToken(
  token: string,
  expected: { server: string; path: string; op: TransferOp }
): boolean {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return false;

  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(payloadB64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  let claims: TransferClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  if (claims.o !== expected.op) return false;
  if (claims.s !== expected.server) return false;
  if (claims.p !== expected.path) return false;
  if (typeof claims.e !== "number" || claims.e < nowSec()) return false;

  return true;
}
