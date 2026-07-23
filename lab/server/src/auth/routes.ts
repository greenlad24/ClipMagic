import { Router } from "express";
import crypto from "node:crypto";
import { config, authConfigured, oauthRedirectUri } from "../config.js";
import { asyncHandler } from "../middleware.js";
import { buildAuthUrl, exchangeCodeForIdentity, isAllowedEmail } from "./google.js";
import {
  SESSION_COOKIE,
  signSession,
  sessionCookie,
  clearSessionCookie,
  readCookie,
  verifySession,
} from "./session.js";
import type { AuthedRequest } from "./middleware.js";

/**
 * The sign-in dance. These routes are on the middleware's open-list so they work
 * for a not-yet-authenticated browser.
 *   GET /auth/google   → set a CSRF state cookie, redirect to Google consent
 *   GET /auth/callback → verify state, exchange code, whitelist-check, set session
 *   GET /auth/logout   → clear the session
 *   GET /api/auth/me   → { email, name } for the UI (null when signed out)
 */
const router = Router();
const STATE_COOKIE = "cm_oauth_state";

function stateCookie(state: string): string {
  // Short-lived, httpOnly. 10 minutes is plenty for a consent round-trip.
  return `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`;
}

router.get(
  "/auth/google",
  asyncHandler(async (_req, res) => {
    if (!authConfigured()) {
      res.status(503).send("Sign-in is not configured yet.");
      return;
    }
    if (!oauthRedirectUri()) {
      res.status(500).send("OAUTH_REDIRECT_URL / PUBLIC_BASE_URL is not set.");
      return;
    }
    const state = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", stateCookie(state));
    res.redirect(buildAuthUrl(state));
  })
);

router.get(
  "/auth/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expected = readCookie(req.header("cookie"), STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) {
      res.status(400).send("Invalid sign-in request (state mismatch). Please try again.");
      return;
    }
    let identity;
    try {
      identity = await exchangeCodeForIdentity(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[auth] callback failed: ${msg}`);
      res.status(400).send("Sign-in failed. Please try again.");
      return;
    }
    if (!identity.emailVerified) {
      res.status(403).send("Your Google email is not verified.");
      return;
    }
    if (!isAllowedEmail(identity.email)) {
      console.warn(`[auth] DENIED non-whitelisted login: ${identity.email}`);
      res
        .status(403)
        .send(
          `Access denied. ${identity.email} is not authorized to use this application.`
        );
      return;
    }
    const token = signSession(identity.email, identity.name);
    // Clear the state cookie, set the session cookie.
    res.setHeader("Set-Cookie", [
      `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
      sessionCookie(token),
    ]);
    console.log(`[auth] signed in: ${identity.email}`);
    res.redirect("/");
  })
);

router.get("/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie());
  res.redirect("/auth/google");
});

router.get("/api/auth/me", (req: AuthedRequest, res) => {
  // Open endpoint: returns identity when a valid session cookie is present,
  // else { email: null } so the SPA can show a signed-out state. When auth is
  // disabled entirely, report a synthetic local identity so the UI is unblocked.
  if (!authConfigured()) {
    res.json({ email: "local", name: "Local", authEnabled: false });
    return;
  }
  const session = verifySession(readCookie(req.header("cookie"), SESSION_COOKIE));
  if (session && isAllowedEmail(session.email)) {
    res.json({ email: session.email, name: session.name ?? null, authEnabled: true });
    return;
  }
  res.json({ email: null, authEnabled: true });
});

export default router;
