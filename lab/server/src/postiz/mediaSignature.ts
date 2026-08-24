/**
 * Signed, expiring URLs for ONE media file.
 *
 * PostPeer is an external SaaS: it must FETCH the video itself, and the lab is
 * behind a Google Sign-In gate, so `https://lab.jakedaw.com/api/outputs/<file>`
 * answered it with a 401 and the post failed ("Failed to fetch remote URL
 * (401)" — 97 of Jake's TikTok posts, 2026-08-24).
 *
 * Opening `/api/outputs` to the world would fix the fetch and expose every
 * render the lab has ever made. Instead each URL carries an HMAC over THAT
 * filename and an expiry: it grants one file for a limited time, cannot be
 * altered to name another file, and cannot be used to enumerate the directory.
 *
 * The key is SESSION_SECRET — already required for the auth gate and already
 * secret — so there is no new secret to manage or leak.
 */
import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * How long a signed media URL stays valid.
 *
 * MUST outlive the scheduling horizon. PostPeer fetches the video when the post
 * PUBLISHES, not when it is scheduled — a probe scheduled for the future was
 * accepted without any fetch at all — so a URL that expires before the post
 * goes out fails silently months later, when nobody is watching. A bulk drop
 * routinely schedules two to three months ahead, so the default is deliberately
 * generous; shorten it with MEDIA_URL_TTL_MS if you never schedule far out.
 */
export const MEDIA_URL_TTL_MS = Number.parseInt(
  process.env.MEDIA_URL_TTL_MS || String(240 * 24 * 60 * 60 * 1000),
  10,
);

function sign(pathname: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", config.sessionSecret)
    .update(`${pathname}\n${expiresAt}`)
    .digest("base64url");
}

/** Append `?e=<expiry>&s=<sig>` to a media path. No secret → unsigned URL. */
export function signMediaPath(pathname: string, now = Date.now()): string {
  if (!config.sessionSecret) return pathname;
  const expiresAt = now + MEDIA_URL_TTL_MS;
  return `${pathname}?e=${expiresAt}&s=${encodeURIComponent(sign(pathname, expiresAt))}`;
}

/**
 * Is this request carrying a valid, unexpired signature for its OWN path?
 * Constant-time compared; a missing secret means signatures are not accepted at
 * all, so the gate never weakens when the app is unconfigured.
 */
export function hasValidMediaSignature(pathname: string, query: Record<string, unknown>): boolean {
  if (!config.sessionSecret) return false;
  const expiresRaw = String(query.e ?? "");
  const provided = String(query.s ?? "");
  if (!expiresRaw || !provided) return false;
  const expiresAt = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = sign(pathname, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
