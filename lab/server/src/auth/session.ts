import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Stateless signed-cookie sessions — no session store, no new npm deps.
 *
 * A session is `base64url(JSON payload).base64url(HMAC-SHA256(secret, part1))`.
 * The payload carries the authenticated email + an expiry; the HMAC (keyed on
 * SESSION_SECRET) makes it tamper-proof. Verification is constant-time and
 * rejects anything past its `exp`. This is the ONLY thing that proves a request
 * came from a signed-in, whitelisted operator.
 */
export interface SessionPayload {
  /** Verified Google email (lower-cased), already checked against the allow-list. */
  email: string;
  /** Display name, best-effort (for the UI identity chip). */
  name?: string;
  /** Issued-at (epoch ms). */
  iat: number;
  /** Expiry (epoch ms). */
  exp: number;
}

export const SESSION_COOKIE = "cm_session";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(part: string): string {
  return b64url(crypto.createHmac("sha256", config.sessionSecret).update(part).digest());
}

/** Mint a signed session token for an already-verified, already-whitelisted email. */
export function signSession(email: string, name?: string): string {
  const now = Date.now();
  const payload: SessionPayload = {
    email,
    name,
    iat: now,
    exp: now + config.sessionTtlDays * 24 * 60 * 60 * 1000,
  };
  const part1 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${part1}.${hmac(part1)}`;
}

/** Verify + decode a session token. Returns null on any tamper / malformed / expired token. */
export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token || !config.sessionSecret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const part1 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(part1);
  // Constant-time compare; guard against length-mismatch throwing.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(part1, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.email !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

/** Build the Set-Cookie value for a session (httpOnly, SameSite=Lax, Secure). */
export function sessionCookie(token: string): string {
  const maxAge = config.sessionTtlDays * 24 * 60 * 60;
  // Secure is safe because the app is served over HTTPS (Caddy) in the only
  // deployment where auth is enabled; on localhost dev over http the cookie
  // still works because SameSite=Lax + Secure is honored for localhost by
  // modern browsers. Path=/ so it covers the whole app + API.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

/** Build a Set-Cookie value that clears the session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

/** Parse a single cookie value out of a Cookie header without a parser dep. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}
