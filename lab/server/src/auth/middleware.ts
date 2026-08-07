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
// Brand icons are open. A browser asks for these on the sign-in page too, and a
// gated favicon answers a 302 to Google's OAuth — so the tab sits blank through
// the whole sign-in. They are public brand assets and carry nothing private.
//
// EXACT MATCHES ONLY, never a prefix: `/favicon.svg` opens one file, where an
// `/icon` prefix would open anything a future route happens to hang under it.
const OPEN_ICONS = [
  "/favicon.svg",
  "/favicon.ico",
  "/favicon-16.png",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png", // older iOS asks for this name unprompted
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/site.webmanifest",
];
const OPEN_EXACT = new Set(["/auth", "/health", "/api/auth/me", ...OPEN_ICONS]);

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
 * Skool rebuild endpoints an OPERATOR-DRIVEN process inside this container may
 * call over loopback without a session cookie. Same peer test as the media
 * routes above — a forged header cannot reach it, and every browser/Caddy
 * request stays fully gated.
 *
 * ⚠️ NAMED ENDPOINTS, NOT THE WHOLE `/api/fn` ROUTE. Everything the lab does
 * hangs off that one dispatcher, including `updatePostizSettings`, which takes
 * write-only secrets in its body. Opening the route wholesale would hand those
 * to anything that can reach loopback inside the container — which includes a
 * headless Chromium that spends its day loading pages nobody here controls.
 * The rebuild needs three endpoints, so it gets three.
 *
 * These exist because the rebuild is 151 sequential browser operations against
 * a live community and there is no UI to drive them yet. When that UI lands,
 * this list should shrink back to nothing.
 */
const LOOPBACK_FN_EXACT = new Set([
  "/api/fn/skoolPlanRebuild",
  "/api/fn/skoolRunRebuildOp",
  "/api/fn/skoolRunAction",
  // Read-only: where the browser is and whether it is signed in. Diagnosing a
  // failed write without it means guessing at the browser's state from the
  // outside, which is how a contention artifact got mistaken for dead cookies.
  "/api/fn/skoolStatus",
  // Read-only: re-reads the whole classroom into a snapshot. Takes no secrets
  // and writes nothing to Skool. Here because the reader had to be corrected —
  // a unit's body only ships when its own URL selects it, so the previous
  // snapshot recorded 60 modules full of prompts as empty — and re-reading is
  // now a routine consequence of touching `classroom.ts`, not a one-off.
  "/api/fn/skoolBuildInventory",
  // Read-only reconnaissance, and the same bargain as the entries above: the
  // engagement half of the Skool Manager has to be built against the FEED and
  // CHAT surfaces, and nothing here has ever read either one. Guessing their
  // shape is what this probe exists to avoid.
  //
  // It takes no secrets, cannot type and cannot submit, and refuses any URL
  // that is not on skool.com. The worry the block above raises — a headless
  // Chromium in this container loading pages nobody controls — does not reach
  // it: a cross-origin POST from such a page cannot read the response, so the
  // page content it returns is not exfiltratable, and the probe cannot write.
  // Remove this line together with the probe once the selectors settle.
  "/api/fn/skoolProbe",
  // Same bargain, same expiry: it opens nothing and submits nothing — it reads
  // one switch in an already-open composer and can set it. Needed because the
  // alternative way to verify the switch is to publish a post, which emails the
  // whole community every time you want to check.
  "/api/fn/skoolEmailNotify",
  // The engagement half, while it is being built and verified. Same bargain and
  // the same expiry as the rebuild entries: no UI exists yet, and these are how
  // the read layer and the drafting are exercised at all.
  //
  // ⚠️ `skoolDraftPost`/`skoolDraftReply` are the first entries here that SPEND
  // anything — they draw on the Max window, which is shared with Jake's own
  // Claude Code sessions. They take no secrets and write nothing to Skool, but
  // they are not free, so they come off this list as soon as the UI can drive
  // them. The read-only three can stay.
  "/api/fn/skoolReadFeed",
  "/api/fn/skoolReadPost",
  // Read-only, and the ONLY place a comment id exists — the rendered page
  // carries none, so a reply worker cannot be built or checked without it.
  "/api/fn/skoolReadComments",
  "/api/fn/skoolUnreadChats",
  "/api/fn/skoolKnowledge",
  // ⚠️ SPENDS APIFY CREDITS — the only paid thing in this feature. Here because
  // the backfill has to be runnable at all before a UI exists; it is guarded by
  // its own cache (a transcript is bought once) and by `dryRun`.
  "/api/fn/skoolBackfillTranscripts",
  "/api/fn/skoolDraftPost",
  "/api/fn/skoolDraftReply",
  // The scheduler, on the same terms and with the same expiry. Status and
  // subject are read-only and free — `skoolEngageSubject` exists precisely so
  // "what would it write about?" can be answered without spending the window.
  "/api/fn/skoolEngageStatus",
  "/api/fn/skoolEngageSubject",
  // Read/write, but nothing leaves the box: a pinned subject only decides what
  // the next scheduled post is ABOUT.
  "/api/fn/skoolEngagePin",
  "/api/fn/skoolEngageUnpin",
  "/api/fn/skoolEngageConfigure",
  // ⚠️ THESE TWO CAN WRITE TO THE LIVE COMMUNITY. `skoolEngageTick` publishes
  // only when the schedule is enabled AND dry run is off (both off by default);
  // `skoolEngagePublish` always does. They are here for the same reason
  // `skoolRunAction` is — the write path has to be exercisable before a UI
  // exists — and they come off this list with it.
  "/api/fn/skoolEngageTick",
  "/api/fn/skoolEngagePublish",
  // ⚠️ WRITES A PUBLIC REPLY, ATTRIBUTED TO JAKE, under a member's comment. Here
  // on the same terms and with the same expiry as the two above: the write path
  // has to be exercisable before a UI can drive it, and it takes `dryRun` so the
  // whole sequence can be proven without a member seeing anything.
  // ⚠️ PUBLISHES A POST TO THE LIVE COMMUNITY. Here for the first end-to-end
  // proof of the write path (Jake, 2026-08-06, having read the exact text), on
  // the same terms and with the same expiry as the two above.
  "/api/fn/skoolPublishPost",
  "/api/fn/skoolReplyToComment",
  // Read-only: the DM threads and one conversation. Here because the standing
  // note that DMs "cannot be verified" turned out to be wrong, and checking
  // that is exactly what these two are for.
  "/api/fn/skoolReadDms",
  "/api/fn/skoolReadDmThread",
  // ⚠️ SENDS A PRIVATE MESSAGE TO A REAL MEMBER, AS JAKE. The least recoverable
  // thing in this file: Skool's composer has no send button, so ENTER sends and
  // there is no second click to withhold. `dryRun` stops one keypress short.
  "/api/fn/skoolSendDm",
]);

/**
 * True only for a genuine in-container loopback request to a media asset route.
 * Uses the raw socket peer (`req.socket.remoteAddress`), NOT `req.ip`/XFF, so a
 * forged `X-Forwarded-For` header can never fake loopback. Host port-publishing
 * and Caddy both present the Docker gateway/proxy IP (not loopback), so only a
 * process INSIDE this container can trip this.
 */
function isLoopbackPeer(req: Request): boolean {
  const ip = req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function isLoopbackMediaFetch(req: Request): boolean {
  if (!isLoopbackPeer(req)) return false;
  return LOOPBACK_MEDIA_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"));
}

/** In-container loopback call to one of the named Skool rebuild endpoints. */
function isLoopbackRebuildCall(req: Request): boolean {
  return isLoopbackPeer(req) && LOOPBACK_FN_EXACT.has(req.path);
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
  // …as do operator-driven Skool rebuild calls, by the same peer test.
  if (isLoopbackRebuildCall(req)) {
    console.warn(`[auth] loopback rebuild call allowed without session: ${req.path}`);
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
