/**
 * Skool session — a persistent logged-in browser profile for one community.
 *
 * Skool has no public API. Not a limited one, not a gated one: there is no
 * documented way to read or write a classroom programmatically at all. So this
 * tool does what the Engagement Manager does for TikTok — it drives the real
 * web UI in a headless Chromium that stays logged in.
 *
 * SIGN-IN IS BY COOKIE IMPORT, and that is a considered default rather than a
 * shortcut. An interactive login from this droplet has to survive a datacenter
 * IP, a headless fingerprint, and — for a Google-linked Skool account — Google's
 * own risk checks, which are the strictest of the three. TikTok refused every
 * interactive attempt over two days and accepted an imported session
 * immediately. Carrying over a session minted on Jake's own machine sidesteps
 * all of it. The remote login console stays available as the fallback.
 *
 * The profile lives in its own directory (config.skoolBrowserDir), separate
 * from the engagement profiles, so signing out of one tool can never sign out
 * the other.
 *
 * Everything here is best-effort and never throws — the shared runtime's
 * contract. A dead browser degrades this tool, it does not take down the server.
 */
import { config } from "../config.js";
import {
  type BrowserProfile,
  type RuntimeCookie,
  type RuntimeLoginState,
  browserAvailable,
  checkLogin as runtimeCheckLogin,
  hardClose as runtimeHardClose,
  importCookies as runtimeImportCookies,
  isOpen as runtimeIsOpen,
  withPage as runtimeWithPage,
} from "../browser/runtime.js";
import { parseCookiesFor, type CookieParseResult } from "../engage/cookies.js";

export { browserAvailable };

/** The single session key — one Skool identity, however many communities. */
export const SKOOL_PROFILE_ID = "skool";

export const SKOOL_HOME = "https://www.skool.com/";

/**
 * Cookies we accept on import. Skool's own domain only.
 *
 * NOT google.com, deliberately, even though Jake signs in with Google: once a
 * Skool session cookie exists the Google ones are not needed to stay signed in,
 * and a Google auth cookie sitting in a long-lived server-side browser profile
 * is a far bigger thing to hold than a Skool one. If a Google-linked import ever
 * fails for want of them, that is a decision to take deliberately, not a default
 * to drift into.
 */
const SKOOL_COOKIE_TARGET = {
  domains: ["skool.com"],
  defaultDomain: ".skool.com",
};

/**
 * Skool serves its marketing site and its login form on the same host, so a URL
 * check alone is not decisive — the same lesson Instagram taught the engagement
 * tool. The runtime pairs these with a visible-password-field probe.
 */
const LOGIN_URL_MARKERS = ["/login", "/signup", "/auth"];

/**
 * Extra "logged out" markers for the case where Skool renders its logged-out
 * home with no password field on the page (a "Log In" link into a modal).
 *
 * PROVISIONAL — written from the shape of the problem, not from a logged-in
 * session, because there is no session to check against until an operator
 * imports one. Verify against the real DOM before trusting a "logged in" here;
 * the equivalent guess was wrong for TikTok in a way that reported a signed-out
 * profile as signed in.
 */
const LOGGED_OUT_SELECTORS = [
  'a[href*="/login"]',
  'button[data-testid*="login" i]',
];

function profile(): BrowserProfile {
  return {
    id: SKOOL_PROFILE_ID,
    dir: config.skoolBrowserDir,
    home: SKOOL_HOME,
    loginUrlMarkers: LOGIN_URL_MARKERS,
    loggedOutSelectors: LOGGED_OUT_SELECTORS,
  };
}

export interface SkoolLoginState extends RuntimeLoginState {
  /** Which Skool account the live session belongs to, when it can be read. */
  account: string | null;
}

/** Parse whatever the operator pasted into Skool-only cookies. */
export function parseSkoolCookies(raw: string): CookieParseResult {
  return parseCookiesFor(raw, SKOOL_COOKIE_TARGET);
}

/** Run `fn` against the Skool page, holding the session. Null when unavailable. */
export function withSkoolPage<T>(fn: (page: any) => Promise<T>): Promise<T | null> {
  return runtimeWithPage(profile(), fn);
}

export function isSkoolOpen(): boolean {
  return runtimeIsOpen(SKOOL_PROFILE_ID);
}

export function closeSkool(): Promise<void> {
  return runtimeHardClose(SKOOL_PROFILE_ID);
}

/**
 * Who is signed in, read off the page.
 *
 * Best-effort and allowed to come back null: the tool must not claim a session
 * belongs to an account it could not actually read. A null here means "signed
 * in, identity unknown", which is honest; a guessed handle would not be.
 */
async function readAccount(): Promise<string | null> {
  return withSkoolPage(async (page) => {
    try {
      return await page.evaluate(() => {
        const doc: any = (globalThis as any).document;
        if (!doc) return null;
        // Skool ships its page state as a Next.js payload. When it is there it
        // is far more reliable than scraping a rendered avatar, which is behind
        // obfuscated class names that change without notice.
        const el = doc.getElementById("__NEXT_DATA__");
        if (el?.textContent) {
          try {
            // Verified against the real payload: the signed-in user is
            // pageProps.self, with firstName/lastName alongside a slug `name`.
            // The first guess here was `currentUser`, which does not exist and
            // reported every live session as "identity unknown".
            const self = JSON.parse(el.textContent)?.props?.pageProps?.self;
            const full = [self?.firstName, self?.lastName].filter(Boolean).join(" ").trim();
            const name = full || self?.name || self?.email;
            if (typeof name === "string" && name.trim()) return name.trim();
          } catch {
            /* payload shape changed — fall through */
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  });
}

/** Navigate to Skool and report whether the profile still holds a session. */
export async function checkSkoolLogin(): Promise<SkoolLoginState> {
  const state = await runtimeCheckLogin(profile());
  if (!state.loggedIn) return { ...state, account: null };
  return { ...state, account: await readAccount() };
}

/**
 * Import an exported Skool session and verify it landed.
 *
 * The count of cookies kept is reported back so the onboarding can tell the
 * difference between "you pasted the wrong site's export" (0 kept) and "the
 * session itself is stale" (kept > 0, still logged out) — two failures that
 * look identical from a bare "not signed in".
 */
export async function importSkoolCookies(raw: string): Promise<SkoolLoginState & { kept: number; total: number }> {
  const parsed = parseSkoolCookies(raw);
  if (parsed.cookies.length === 0) {
    return {
      loggedIn: false,
      url: null,
      error:
        parsed.total > 0
          ? `Found ${parsed.total} cookies but none were for skool.com — export them from a Skool tab, not another site.`
          : "No cookies found in that paste.",
      account: null,
      kept: 0,
      total: parsed.total,
    };
  }
  const state = await runtimeImportCookies(profile(), parsed.cookies as RuntimeCookie[]);
  const account = state.loggedIn ? await readAccount() : null;
  return { ...state, account, kept: parsed.cookies.length, total: parsed.total };
}
