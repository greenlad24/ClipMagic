import type { Request, Response, NextFunction } from "express";
import { authConfigured } from "../config.js";
import { SESSION_COOKIE, readCookie, verifySession, type SessionPayload } from "./session.js";
import { isAllowedEmail } from "./google.js";

/**
 * The whole-app Google Sign-In gate. ONE middleware, mounted globally, that
 * covers every route mounted after it (API, /v1, static SPA, the `*` fallback).
 *
 * - When auth is not configured (no Google creds/session secret) it is a
 *   PASS-THROUGH so the existing open deployment keeps working — the boot log
 *   warns loudly. It activates the moment creds are present.
 * - Paths that MUST stay open even when auth is on: the sign-in dance itself and
 *   the health probe. Everything else requires a valid session cookie whose
 *   email is on the allow-list.
 * - No session on a document request → 302 to sign-in (so a browser lands on the
 *   Google login). No session on an XHR (/api, /v1) → 401 JSON (so `callFn` can
 *   redirect). A valid-but-not-whitelisted email is impossible here (the callback
 *   never mints a cookie for one), but a stale allow-list change is enforced too.
 */

// Prefixes that bypass the gate entirely. Kept minimal — ONLY the OAuth dance.
// `/health` is intentionally NOT a prefix (a prefix would let `/healthfoo` fall
// through to the SPA shell unauthenticated); it's an exact-match open path below.
const OPEN_PREFIXES = ["/auth/"];
const OPEN_EXACT = new Set(["/auth", "/health", "/api/auth/me"]);

// Media asset routes the in-container render process (Remotion headless Chromium)
// must fetch over LOOPBACK with no session cookie (e.g. sticker PNGs for a meme
// render). These are exempted from the gate ONLY when the request's real TCP peer
// is loopback — see isLoopbackMediaFetch. Every external/browser/Caddy request
// arrives from a non-loopback peer and stays fully gated.
const LOOPBACK_MEDIA_PREFIXES = [
  "/api/outputs",
  "/api/uploads",
  "/api/thumbnail-characters",
  "/api/thumbnail-backgrounds",
];

/**
 * True only for a genuine in-container loopback request to a media asset route.
 * Uses the raw socket peer (`req.socket.remoteAddress`), NOT `req.ip`/XFF, so a
 * forged `X-Forwarded-For` header can never fake loopback. Host port-publishing
 * and Caddy both present the Docker gateway/proxy IP (not loopback), so only a
 * process INSIDE this container can trip this.
 */
function isLoopbackMediaFetch(req: Request): boolean {
  const ip = req.socket?.remoteAddress || "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!loopback) return false;
  return LOOPBACK_MEDIA_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"));
}

function isOpenPath(p: string): boolean {
  if (OPEN_EXACT.has(p)) return true;
  return OPEN_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

function wantsJson(req: Request): boolean {
  return (
    req.path.startsWith("/api") ||
    req.path.startsWith("/v1") ||
    (req.get("accept") || "").includes("application/json")
  );
}

/** Attach the verified session (if any) to the request for downstream handlers. */
export interface AuthedRequest extends Request {
  authSession?: SessionPayload;
}

export function requireSession(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!authConfigured()) {
    next();
    return;
  }
  if (isOpenPath(req.path)) {
    next();
    return;
  }
  // In-container render fetches (loopback → media routes) bypass the cookie check.
  if (isLoopbackMediaFetch(req)) {
    next();
    return;
  }
  const token = readCookie(req.header("cookie"), SESSION_COOKIE);
  const session = verifySession(token);
  if (session && isAllowedEmail(session.email)) {
    req.authSession = session;
    next();
    return;
  }
  if (wantsJson(req)) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign-in required." } });
    return;
  }
  res.redirect("/auth/google");
}
