/**
 * Connecting Google Docs so a finished script can be exported into a Doc.
 *
 *   GET /api/gdocs-oauth/start      → consent screen for drive.file
 *   GET /api/gdocs-oauth/callback   → store the refresh token
 *   GET /api/gdocs-oauth/disconnect
 *
 * A THIRD, separate Google client — sign-in holds "openid email profile" and
 * the Channel Audit client holds read-only analytics. Neither is widened here,
 * because a scope added to a shared client is a power every existing use of it
 * silently gains. This grant is `drive.file`: it reaches only the documents
 * this app creates, so it can neither read nor destroy anything else in the
 * Drive, and it is revocable on its own at myaccount.google.com/permissions.
 *
 * NOT UNDER /auth/ — everything under that prefix is deliberately public so the
 * sign-in flow can work, which would leave `disconnect` open to anyone and let
 * a stranger overwrite the stored token by completing `start`. Under /api the
 * session gate applies, and each handler re-checks it rather than trusting
 * mount order.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { config, authConfigured } from "../config.js";
import {
  getGoogleDocsOAuth,
  setGoogleDocsRefreshToken,
  clearGoogleDocsRefreshToken,
} from "../settings/postizSecrets.js";
import { GDOCS_SCOPE, assertDriveFileScope, DocsScopeError } from "./googleDocs.js";
import { readCookie, verifySession, SESSION_COOKIE } from "../auth/session.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "gdocs_oauth_state";
const RETURN_TO = "/script-generator";

function redirectUri(): string {
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/api/gdocs-oauth/callback` : "";
}

function signedIn(req: { header(name: string): string | undefined }): boolean {
  if (!authConfigured()) return true; // single-user install with no gate
  return Boolean(verifySession(readCookie(req.header("cookie"), SESSION_COOKIE)));
}

export function googleDocsOAuthRouter(): Router {
  const router = Router();

  router.get("/api/gdocs-oauth/start", (req, res) => {
    if (!signedIn(req)) {
      res.status(401).send("Sign in first.");
      return;
    }
    const creds = getGoogleDocsOAuth();
    if (!creds) {
      res.status(400).send("The Google Docs OAuth client is not configured. Add the client ID and secret in Settings first.");
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
      scope: GDOCS_SCOPE,
      state,
      // offline + consent is what actually yields a refresh token. Without
      // prompt=consent Google returns none on a repeat authorisation, and the
      // connection then dies silently at the first access-token expiry.
      access_type: "offline",
      prompt: "consent",
      // Never inherit scopes granted to another client. This connection is
      // drive.file and nothing else, whatever else the account has approved.
      include_granted_scopes: "false",
    });
    res.redirect(`${AUTH_ENDPOINT}?${params.toString()}`);
  });

  router.get("/api/gdocs-oauth/callback", async (req, res) => {
    if (!signedIn(req)) {
      res.status(401).send("Sign in first.");
      return;
    }
    const creds = getGoogleDocsOAuth();
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const expected = readCookie(req.header("cookie"), STATE_COOKIE);
    res.clearCookie(STATE_COOKIE);

    if (req.query.error) {
      res.redirect(`${RETURN_TO}?gdocs=denied`);
      return;
    }
    if (!creds || !code || !state || !expected || state !== expected) {
      // A mismatched state is the CSRF case; say nothing useful to an attacker.
      res.redirect(`${RETURN_TO}?gdocs=failed`);
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
      const j = (await r.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string };
      if (!r.ok || !j.refresh_token) {
        console.warn("[scriptgen/gdocs] no refresh token returned:", j.error || r.status);
        res.redirect(`${RETURN_TO}?gdocs=norefresh`);
        return;
      }
      // Refuse anything wider than drive.file BEFORE the token touches disk. A
      // credential that could read the whole Drive must not be storable at all,
      // not merely left unused.
      try {
        assertDriveFileScope(j.scope);
      } catch (err) {
        if (err instanceof DocsScopeError) {
          console.error("[scriptgen/gdocs] REFUSED an over-broad grant:", err.message);
          res.redirect(`${RETURN_TO}?gdocs=scope`);
          return;
        }
        throw err;
      }

      setGoogleDocsRefreshToken(j.refresh_token);
      res.redirect(`${RETURN_TO}?gdocs=connected`);
    } catch (e) {
      console.error("[scriptgen/gdocs] callback failed:", e instanceof Error ? e.message : String(e));
      res.redirect(`${RETURN_TO}?gdocs=failed`);
    }
  });

  router.get("/api/gdocs-oauth/disconnect", (req, res) => {
    if (!signedIn(req)) {
      res.status(401).send("Sign in first.");
      return;
    }
    clearGoogleDocsRefreshToken();
    res.redirect(`${RETURN_TO}?gdocs=disconnected`);
  });

  return router;
}
