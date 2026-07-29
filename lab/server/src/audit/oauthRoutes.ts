/**
 * Connecting a YouTube channel so the audit can see paid versus organic views.
 *
 *   GET /api/yt-oauth/start      → consent screen for yt-analytics.readonly
 *   GET /api/yt-oauth/callback   → store the refresh token
 *   GET /api/yt-oauth/disconnect
 *
 * A SEPARATE OAuth client from the lab's sign-in. The sign-in client requests
 * "openid email profile" and the comment in auth/google.ts is explicit that it
 * holds no YouTube scopes — signing in proves who you are and nothing more.
 * Widening it so the audit could read analytics would mean every sign-in
 * carried that power. This grant is asked for separately, is read-only, and is
 * revocable at myaccount.google.com/permissions without touching sign-in.
 *
 * NOT UNDER /auth/. These first lived at /auth/youtube — and everything under
 * that prefix is deliberately PUBLIC so the sign-in flow itself can work, which
 * left all three open to anyone on the internet: `disconnect` would delete the
 * token, and completing `start` with a different Google account would overwrite
 * the stored refresh token so the audit read a stranger's analytics. Under /api
 * requireSession applies, and each handler re-checks the session anyway rather
 * than trusting mount order.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { config } from "../config.js";
import {
  getYtAnalyticsOAuth,
  setYtAnalyticsRefreshToken,
  clearYtAnalyticsRefreshToken,
} from "../settings/postizSecrets.js";
import { YT_ANALYTICS_SCOPE } from "./analytics.js";
import { readCookie, verifySession, SESSION_COOKIE } from "../auth/session.js";
import { authConfigured } from "../config.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "yt_oauth_state";

function redirectUri(): string {
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/api/yt-oauth/callback` : "";
}

/**
 * Belt and braces: the router is mounted behind requireSession, but a future
 * re-mount must not silently expose a flow that writes a credential to disk.
 */
function signedIn(req: any): boolean {
  if (!authConfigured()) return true; // single-user install with no gate
  return Boolean(verifySession(readCookie(req.header("cookie"), SESSION_COOKIE)));
}

export function youtubeOAuthRouter(): Router {
  const router = Router();

  router.get("/api/yt-oauth/start", (req, res) => {
    if (!signedIn(req)) {
      res.status(401).send("Sign in first.");
      return;
    }
    const creds = getYtAnalyticsOAuth();
    if (!creds) {
      res
        .status(400)
        .send("The YouTube Analytics OAuth client is not configured. Add the client ID and secret in Settings first.");
      return;
    }
    if (!redirectUri()) {
      res.status(500).send("PUBLIC_BASE_URL is not set, so the OAuth callback URL cannot be built.");
      return;
    }

    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: (config.publicBaseUrl || "").startsWith("https://"),
      maxAge: 10 * 60 * 1000,
    });

    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: YT_ANALYTICS_SCOPE,
      state,
      // offline + consent is what actually yields a refresh token. Without
      // prompt=consent Google returns none on a repeat authorisation, and the
      // connection then silently dies at the first access-token expiry.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
    res.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
  });

  router.get("/api/yt-oauth/callback", async (req, res) => {
    if (!signedIn(req)) {
      res.status(401).send("Sign in first.");
      return;
    }
    const creds = getYtAnalyticsOAuth();
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const expected = readCookie(req.header("cookie"), STATE_COOKIE);
    res.clearCookie(STATE_COOKIE);

    if (req.query.error) {
      res.redirect(`/channel-audit?ytauth=denied`);
      return;
    }
    if (!creds || !code || !state || !expected || state !== expected) {
      // A mismatched state is the CSRF case; say nothing useful to an attacker.
      res.redirect(`/channel-audit?ytauth=failed`);
      return;
    }

    try {
      const r = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri(),
          grant_type: "authorization_code",
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j?.refresh_token) {
        console.warn("[audit/oauth] no refresh token returned:", j?.error || r.status);
        res.redirect(`/channel-audit?ytauth=norefresh`);
        return;
      }
      setYtAnalyticsRefreshToken(j.refresh_token);
      console.log("[audit/oauth] YouTube Analytics connected");
      res.redirect(`/channel-audit?ytauth=connected`);
    } catch (err: any) {
      console.warn("[audit/oauth] token exchange failed:", err?.message || err);
      res.redirect(`/channel-audit?ytauth=failed`);
    }
  });

  router.get("/api/yt-oauth/disconnect", (req, res) => {
    if (!signedIn(req)) {
      res.status(401).send("Sign in first.");
      return;
    }
    clearYtAnalyticsRefreshToken();
    res.redirect(`/channel-audit?ytauth=disconnected`);
  });

  return router;
}
