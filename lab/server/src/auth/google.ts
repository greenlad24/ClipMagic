import { config, oauthRedirectUri } from "../config.js";

/**
 * Google OAuth 2.0 Authorization-Code flow, done with native fetch — no
 * `google-auth-library` dependency. We only need sign-in identity (email), so we
 * request just the `openid email profile` scopes (NO YouTube/Drive scopes — this
 * client can only tell us who someone is, nothing more).
 *
 * Trust model: the id_token is fetched by US directly from Google's token
 * endpoint over TLS in exchange for a one-time code, so it cannot have been
 * substituted by a third party. We still validate `aud`/`iss`/`exp`/
 * `email_verified` defensively before trusting the email.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const VALID_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/** The Google consent URL to redirect the browser to. `state` is CSRF protection. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: oauthRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    // Force the account chooser so switching between the two authorized
    // operators is easy; we don't need offline access (no refresh token).
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Decode a JWT payload segment without verifying the signature (see trust model). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Exchange the auth code for tokens and return the validated Google identity.
 * Throws on any exchange failure or claim-validation failure.
 */
export async function exchangeCodeForIdentity(code: string): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: oauthRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Google token response had no id_token");

  const claims = decodeJwtPayload(json.id_token);
  if (!claims) throw new Error("Could not decode Google id_token");

  // Defensive claim validation.
  if (claims.aud !== config.googleClientId) throw new Error("id_token aud mismatch");
  if (typeof claims.iss !== "string" || !VALID_ISS.has(claims.iss)) throw new Error("id_token iss invalid");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("id_token expired");

  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) throw new Error("id_token had no email");

  return {
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}

/** True when the email is on the operator allow-list. Comparison is lower-cased. */
export function isAllowedEmail(email: string): boolean {
  return config.authAllowedEmails.includes(email.trim().toLowerCase());
}
