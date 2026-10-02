/**
 * Connecting the sponsorship Gmail to the Deal Organizer.
 *
 *   GET /api/deals-oauth/gmail/start       → Google consent for gmail.modify
 *   GET /api/deals-oauth/gmail/callback    → store the refresh token + address
 *   GET /api/deals-oauth/gmail/disconnect
 *
 * Same client as the Lab sign-in (Jake's rule), but a SEPARATE grant: sign-in
 * keeps "openid email profile" and nothing more. Under /api so requireSession
 * applies (see audit/oauthRoutes.ts for why /auth/ would be public), and each
 * handler re-checks the session rather than trusting mount order.
 */
import { Router } from "express";
import crypto from "node:crypto";
import { config, authConfigured } from "../../config.js";
import { readCookie, verifySession, SESSION_COOKIE } from "../../auth/session.js";
import { getDealsGmailOAuth, setDealsGmailConnection, clearDealsGmailConnection } from "../../settings/postizSecrets.js";
import { GMAIL_SCOPE, DRIVE_SCOPE, assertGmailScope, GmailPolicyError, forgetGmailToken } from "./gmail.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "deals_gmail_state";
const BACK = "/deal-organizer/connections";

export function gmailRedirectUri(): string {
  const base = (config.publicBaseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/api/deals-oauth/gmail/callback` : "";
}

function signedIn(req: any): boolean {
  if (!authConfigured()) return true;
  return Boolean(verifySession(readCookie(req.header("cookie"), SESSION_COOKIE)));
}

export function dealsGmailOAuthRouter(): Router {
  const router = Router();

  router.get("/api/deals-oauth/gmail/start", (req, res) => {
    if (!signedIn(req)) return void res.status(401).send("Sign in first.");
    const creds = getDealsGmailOAuth();
    if (!creds) return void res.status(400).send("No Google OAuth client is configured.");
    if (!gmailRedirectUri()) return void res.status(500).send("PUBLIC_BASE_URL is not set, so the callback URL cannot be built.");
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: (config.publicBaseUrl || "").startsWith("https://"),
      maxAge: 10 * 60 * 1000,
    });
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: gmailRedirectUri(),
      response_type: "code",
      // Drive is READ-ONLY and optional (the Script Generator reads briefs shared over Drive).
      scope: `${GMAIL_SCOPE} ${DRIVE_SCOPE}`,
      state,
      access_type: "offline",
      prompt: "consent select_account", // consent → a refresh token every time; select_account → pick the SPONSOR inbox, not whoever is signed in
      include_granted_scopes: "false",
    });
    res.redirect(`${AUTH_ENDPOINT}?${params}`);
  });

  router.get("/api/deals-oauth/gmail/callback", async (req, res) => {
    if (!signedIn(req)) return void res.status(401).send("Sign in first.");
    const creds = getDealsGmailOAuth();
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const expected = readCookie(req.header("cookie"), STATE_COOKIE);
    res.clearCookie(STATE_COOKIE);
    if (req.query.error) return void res.redirect(`${BACK}?gmail=denied`);
    if (!creds || !code || !state || !expected || state !== expected) return void res.redirect(`${BACK}?gmail=failed`);

    try {
      const r = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: gmailRedirectUri(),
          grant_type: "authorization_code",
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j?.refresh_token) {
        console.warn("[deals/gmail] no refresh token returned:", j?.error || r.status);
        return void res.redirect(`${BACK}?gmail=norefresh`);
      }
      try {
        assertGmailScope(j.scope);
      } catch (err) {
        if (err instanceof GmailPolicyError) {
          console.error("[deals/gmail] REFUSED grant:", err.message);
          return void res.redirect(`${BACK}?gmail=scope`);
        }
        throw err;
      }
      // Which mailbox was connected — read with the fresh access token before storing anything.
      const p = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { authorization: `Bearer ${j.access_token}` },
      });
      const profile: any = await p.json().catch(() => ({}));
      const email = String(profile?.emailAddress || "");
      if (!p.ok || !email) return void res.redirect(`${BACK}?gmail=failed`);

      setDealsGmailConnection(j.refresh_token, email);
      forgetGmailToken();
      console.log(`[deals/gmail] connected ${email}`);
      res.redirect(`${BACK}?gmail=connected`);
    } catch (err: any) {
      console.warn("[deals/gmail] token exchange failed:", err?.message || err);
      res.redirect(`${BACK}?gmail=failed`);
    }
  });

  router.get("/api/deals-oauth/gmail/disconnect", (req, res) => {
    if (!signedIn(req)) return void res.status(401).send("Sign in first.");
    clearDealsGmailConnection();
    forgetGmailToken();
    res.redirect(`${BACK}?gmail=disconnected`);
  });

  return router;
}
