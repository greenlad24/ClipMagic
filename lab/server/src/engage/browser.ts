/**
 * Engagement Manager — headless browser runtime (Phase 3).
 *
 * Instagram, Facebook and TikTok have no comment-WRITE API we can use: Meta
 * gates comment/DM writes behind App Review, and TikTok has no public comment
 * API at all. So replies are typed into the real web UI by a headless Chromium
 * driven over CDP, logged in as Jake once and kept logged in.
 *
 * THE MACHINERY NOW LIVES IN ../browser/runtime.ts. It moved there the moment a
 * second tool needed a persistent logged-in profile — the Skool manager, another
 * site with no API — because every awkward part of it (the stranded
 * SingletonLock after a container restart, the HeadlessChrome user-agent, the
 * fact that a logged-out check cannot be a URL check) was found by something
 * breaking, and a second copy would drift from this one the first time either
 * was fixed.
 *
 * What stays here is what is genuinely about THESE three platforms: where each
 * session is anchored, and how each one signals that it is signed out. The
 * public surface of this module is unchanged, so senders.ts, browserSession.ts
 * and replyWorker.ts are untouched.
 *
 * PROFILE DIRECTORIES ARE UNCHANGED — still config.engageBrowserDir/<platform>.
 * Jake's live Instagram, Facebook and TikTok logins sit in those directories on
 * /data; moving them would have signed him out of all three, including the
 * TikTok session that took cookie import and two days of failed logins to get.
 */
import path from "node:path";
import { config } from "../config.js";
import {
  type BrowserProfile,
  type RuntimeCookie,
  VIEWPORT,
  browserAvailable,
  checkLogin as runtimeCheckLogin,
  closeAll,
  errMsg,
  hardClose as runtimeHardClose,
  importCookies as runtimeImportCookies,
  isOpen as runtimeIsOpen,
  randInt,
  screenshotBase64,
  sleep,
  typeHuman,
  waitForAny,
  withPage as runtimeWithPage,
} from "../browser/runtime.js";
import type { Platform } from "./types.js";
import type { EngageCookie } from "./cookies.js";

// Re-exported unchanged so every existing importer keeps working.
export {
  VIEWPORT,
  browserAvailable,
  closeAll,
  errMsg,
  randInt,
  screenshotBase64,
  sleep,
  typeHuman,
  waitForAny,
};

/** Platforms we drive a browser for. YouTube is monitor-only (make.com replies). */
export type BrowserPlatform = Exclude<Platform, "youtube">;

export const BROWSER_PLATFORMS: readonly BrowserPlatform[] = ["instagram", "facebook", "tiktok"];

/** Is this a platform we can drive a browser for? */
export function isBrowserPlatform(p: Platform): p is BrowserPlatform {
  return (BROWSER_PLATFORMS as readonly string[]).includes(p);
}

/** The home URL each platform's session is anchored to. */
export const PLATFORM_HOME: Record<BrowserPlatform, string> = {
  instagram: "https://www.instagram.com/",
  facebook: "https://www.facebook.com/",
  tiktok: "https://www.tiktok.com/",
};

/**
 * A logged-out session sometimes redirects to one of these. NOT sufficient on
 * its own: Instagram serves its login form at the bare https://www.instagram.com/
 * with no redirect at all, so a URL check alone reports a logged-out profile as
 * signed in (observed, not theorised). The runtime pairs it with a DOM probe.
 */
const LOGIN_URL_MARKERS: Record<BrowserPlatform, string[]> = {
  instagram: ["/accounts/login", "/accounts/emailsignup"],
  facebook: ["/login", "/checkpoint", "recover/initiate"],
  tiktok: ["/login", "/signup"],
};

/**
 * Extra per-platform "you are logged out" markers, for platforms that don't put
 * a password field on the page. TikTok is the case that forced this: its
 * logged-out home renders a normal feed with a "Log in" button in the header and
 * only opens the password form in a modal, so the shared password-field probe
 * sees nothing and reports a signed-out profile as signed in (observed).
 */
const LOGGED_OUT_SELECTORS: Record<BrowserPlatform, string[]> = {
  instagram: [],
  facebook: [],
  // TikTok renders TWO "Log in" buttons sharing id="header-login-button": a
  // hidden 0x0 one that carries data-e2e="top-login-button", and the VISIBLE
  // sidebar one that carries no data-e2e at all. Matching on data-e2e therefore
  // only ever finds the invisible one and fails the visibility check (observed).
  // Match the id instead — it hits both, and the visible one passes.
  tiktok: ["#header-login-button", "#top-right-login-button", "#top-right-action-bar-login-button"],
};

/** Per-platform persistent Chromium profile (cookies + localStorage + fingerprint). */
export function profileDir(platform: BrowserPlatform): string {
  return path.join(config.engageBrowserDir, platform);
}

/**
 * Session keys are namespaced so another tool's profile can never collide with
 * a platform name in the shared runtime's session map. The DIRECTORY is
 * deliberately NOT namespaced — see the header note about the live logins.
 */
function profileOf(platform: BrowserPlatform): BrowserProfile {
  return {
    id: `engage:${platform}`,
    dir: profileDir(platform),
    home: PLATFORM_HOME[platform],
    loginUrlMarkers: LOGIN_URL_MARKERS[platform],
    loggedOutSelectors: LOGGED_OUT_SELECTORS[platform],
  };
}

/** Close a platform's browser and forget it. Never throws. */
export function hardClose(platform: BrowserPlatform): Promise<void> {
  return runtimeHardClose(`engage:${platform}`);
}

/** Is a browser currently open for this platform? (No launch side-effect.) */
export function isOpen(platform: BrowserPlatform): boolean {
  return runtimeIsOpen(`engage:${platform}`);
}

/**
 * Run `fn` against the platform's page, holding the session so the idle reaper
 * and any concurrent caller can't pull it out from under you. Returns null when
 * the browser can't be launched — callers treat that as "reply path is inert".
 */
export function withPage<T>(platform: BrowserPlatform, fn: (page: any) => Promise<T>): Promise<T | null> {
  return runtimeWithPage(profileOf(platform), fn);
}

// ── login state ───────────────────────────────────────────────────────────────

export interface LoginState {
  platform: BrowserPlatform;
  /** True when the profile still holds a valid session. */
  loggedIn: boolean;
  /** Where the check landed (useful when it's a checkpoint/2FA page). */
  url: string | null;
  /** Populated when the browser itself couldn't be reached. */
  error: string | null;
}

/** Navigate to the platform home and decide whether we're still signed in. */
export async function checkLogin(platform: BrowserPlatform): Promise<LoginState> {
  const state = await runtimeCheckLogin(profileOf(platform));
  return { platform, ...state };
}

/**
 * Load exported session cookies into the persistent profile, then re-check the
 * login state. This is TikTok's fallback (see engage/cookies.ts): the session
 * was minted on Jake's own trusted device and we carry it over, rather than
 * trying to pass a fresh login from the datacenter IP that TikTok rejects.
 */
export async function importCookies(
  platform: BrowserPlatform,
  cookies: EngageCookie[],
): Promise<LoginState> {
  const state = await runtimeImportCookies(profileOf(platform), cookies as RuntimeCookie[]);
  return { platform, ...state };
}
