/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SHARED HEADLESS-BROWSER RUNTIME
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A persistent, logged-in Chromium profile, driven over CDP. Originally written
 * inside the Engagement Manager for Instagram/Facebook/TikTok, and lifted here
 * unchanged in behaviour the moment a second tool needed the same thing (Skool,
 * which has no public API at all).
 *
 * It is worth sharing rather than copying because almost none of this is
 * obvious, and every awkward part of it was found by something breaking:
 *
 *   • Chromium strands SingletonLock/Socket/Cookie symlinks naming a dead pid
 *     when a container restarts, and then EVERY later launch fails with a bare
 *     "Failed to launch the browser process!".
 *   • Headless Chromium's default user-agent says "HeadlessChrome", which some
 *     sites treat as a bot signal.
 *   • A logged-out check cannot be a URL check: Instagram serves its login form
 *     at the bare domain with no redirect, and TikTok renders a normal feed with
 *     the password form behind a modal. It has to poll the DOM.
 *
 * A copy of that in a second tool would drift from the original the first time
 * one of them was fixed.
 *
 * WHAT IS DELIBERATELY NOT HERE: anything site-specific. A caller supplies a
 * BrowserProfile — where the session is anchored, and how to tell it is signed
 * out — and keeps its own selectors. This module knows how to hold a login, not
 * what to do with one.
 *
 * Everything is best-effort and NEVER throws. A broken browser must degrade the
 * feature that wanted it, not take down the server.
 */
import fs from "node:fs";
import path from "node:path";
import { chromiumAvailable, chromiumCandidates } from "../capture/chromium.js";

// puppeteer-core is typed loosely: it is not a declared @types dependency and
// we only touch a small, stable surface (launch/newPage/goto/click/type).
type AnyBrowser = any;
type AnyPage = any;
export type { AnyPage };

/**
 * One browsing identity: a directory that holds its cookies, and enough
 * knowledge to tell whether that identity is still signed in.
 */
export interface BrowserProfile {
  /** Stable key — used as the session map key and the log tag. */
  id: string;
  /** Absolute path to the persistent Chromium profile directory. */
  dir: string;
  /** Where a session check navigates to. */
  home: string;
  /** URL fragments that mean "you are logged out" (login/checkpoint routes). */
  loginUrlMarkers?: string[];
  /**
   * Extra "logged out" selectors, for sites that show no password field on the
   * page. TikTok forced this to exist; Skool may well need it too.
   */
  loggedOutSelectors?: string[];
}

/** A cookie in the shape puppeteer's `page.setCookie` accepts. */
export interface RuntimeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

/**
 * The decisive shared signal: a visible password field means we are being asked
 * to log in. It survives DOM churn far better than hunting for a logged-in-only
 * avatar element.
 */
const LOGIN_FORM_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="pass"]',
];

/** Console viewport. Exported so click coordinates can be scaled against it. */
export const VIEWPORT = { width: 1280, height: 900 };

/**
 * A stable, ordinary desktop user-agent. Env names keep the ENGAGE_ spellings
 * working as a fallback — they may already be set in this deployment's .env,
 * and a rename that silently changed browser behaviour would be a poor trade.
 */
const USER_AGENT =
  process.env.BROWSER_UA ||
  process.env.ENGAGE_BROWSER_UA ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function executableCandidates(): string[] {
  const explicit = process.env.BROWSER_EXECUTABLE || process.env.ENGAGE_BROWSER_EXECUTABLE;
  const shared = chromiumCandidates();
  return explicit ? [explicit, ...shared.filter((p) => p !== explicit)] : shared;
}

/** Headless unless explicitly disabled — there is no display on the droplet. */
function headless(): boolean {
  const raw = process.env.BROWSER_HEADLESS ?? process.env.ENGAGE_BROWSER_HEADLESS ?? "";
  return raw.toLowerCase() !== "false";
}

/** Close an idle browser after this long. Keeps RAM free between actions. */
function idleMs(): number {
  const raw = process.env.BROWSER_IDLE_MS || process.env.ENGAGE_BROWSER_IDLE_MS || "";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 10_000 ? n : 5 * 60_000;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chromium refuses to start when SingletonLock/Socket/Cookie are present. They
 * are symlinks naming the host + pid holding the profile, so a container
 * restart strands them pointing at a process that no longer exists.
 *
 * Only ever called when this process holds no live session for the profile, so
 * a lock found here is by definition not ours.
 */
function clearStaleLocks(dir: string, tag: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      // lstat, not existsSync: these are symlinks to a dead target, so
      // existsSync follows the link and reports false.
      fs.lstatSync(path.join(dir, name));
      fs.unlinkSync(path.join(dir, name));
      console.log(`[browser] cleared stale ${name} in ${dir} (${tag})`);
    } catch {
      /* absent — nothing to clear */
    }
  }
}

interface Session {
  id: string;
  browser: AnyBrowser;
  page: AnyPage;
  /** Set while a caller holds the session, so the idle reaper can't close it. */
  busy: boolean;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, Session>();

/** Lazily load puppeteer-core. Returns null (never throws) when unavailable. */
async function loadPuppeteer(): Promise<any | null> {
  try {
    const mod: any = await import("puppeteer-core");
    return mod?.default ?? mod;
  } catch (e) {
    console.warn(`[browser] puppeteer-core unavailable: ${errMsg(e)}`);
    return null;
  }
}

/** True when a browser can be launched at all (module + binary both present). */
export async function browserAvailable(): Promise<boolean> {
  if (!(await loadPuppeteer())) return false;
  return chromiumAvailable();
}

async function ensureSession(profile: BrowserProfile): Promise<Session | null> {
  const existing = sessions.get(profile.id);
  if (existing) {
    // A crashed browser leaves a stale entry behind; drop it and relaunch.
    try {
      if (existing.browser.connected !== false && !existing.page.isClosed?.()) {
        existing.lastUsedAt = Date.now();
        return existing;
      }
    } catch {
      /* fall through to relaunch */
    }
    await hardClose(profile.id);
  }

  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return null;

  try {
    fs.mkdirSync(profile.dir, { recursive: true });
  } catch (e) {
    console.warn(`[browser] cannot create profile dir ${profile.dir}: ${errMsg(e)}`);
    return null;
  }
  clearStaleLocks(profile.dir, profile.id);

  const args = [
    // Required: we run as root inside the container.
    "--no-sandbox",
    "--disable-setuid-sandbox",
    // /dev/shm is small in Docker; without this Chromium crashes on heavy pages.
    "--disable-dev-shm-usage",
    "--disable-gpu",
    // Keeps the automation flag out of navigator.webdriver.
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US,en",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    // NOTE: no --ignore-certificate-errors here, deliberately. This browser
    // carries a live login; TLS must be enforced.
  ];

  const candidates = executableCandidates();
  if (candidates.length === 0) {
    console.warn("[browser] no Chromium executable found");
    return null;
  }

  let browser: AnyBrowser = null;
  let lastErr = "";
  for (const exe of candidates) {
    try {
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: headless(),
        userDataDir: profile.dir,
        defaultViewport: VIEWPORT,
        args,
      });
      break;
    } catch (e) {
      lastErr = errMsg(e);
    }
  }
  if (!browser) {
    console.warn(`[browser] Chromium failed to launch for ${profile.id} (tried ${candidates.length}): ${lastErr}`);
    return null;
  }

  try {
    const pages = await browser.pages();
    const page: AnyPage = pages[0] ?? (await browser.newPage());
    await page.setUserAgent(USER_AGENT);
    await page.setViewport(VIEWPORT);
    try {
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    } catch {
      /* non-fatal */
    }

    const session: Session = { id: profile.id, browser, page, busy: false, lastUsedAt: Date.now(), idleTimer: null };
    sessions.set(profile.id, session);
    scheduleIdleClose(session);
    console.log(`[browser] launched ${profile.id} (profile ${profile.dir})`);
    return session;
  } catch (e) {
    // The browser launched but page setup didn't — close it, or we leak a
    // Chromium process (and its lock on the profile dir) on every retry.
    console.warn(`[browser] page setup failed for ${profile.id}: ${errMsg(e)}`);
    try {
      await browser.close();
    } catch {
      /* best-effort */
    }
    return null;
  }
}

function scheduleIdleClose(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.busy || Date.now() - session.lastUsedAt < idleMs()) {
      scheduleIdleClose(session);
      return;
    }
    void hardClose(session.id);
  }, idleMs());
  if (typeof session.idleTimer.unref === "function") session.idleTimer.unref();
}

/** Close a profile's browser and forget it. Never throws. */
export async function hardClose(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    await session.browser.close();
  } catch {
    /* best-effort */
  }
  console.log(`[browser] closed ${id}`);
}

/** Close every open browser (shutdown / kill-switch arming). */
export async function closeAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => hardClose(id)));
}

/** Is a browser currently open for this profile? (No launch side-effect.) */
export function isOpen(id: string): boolean {
  return sessions.has(id);
}

/**
 * Run `fn` against the profile's page, holding the session so the idle reaper
 * and any concurrent caller cannot pull it out from under you. Returns null when
 * the browser can't be launched; errors become null and a warning.
 */
export async function withPage<T>(
  profile: BrowserProfile,
  fn: (page: AnyPage) => Promise<T>,
): Promise<T | null> {
  const session = await ensureSession(profile);
  if (!session) return null;
  // Serialize access: two callers typing into the same page would interleave.
  while (session.busy) await sleep(250);
  session.busy = true;
  try {
    return await fn(session.page);
  } catch (e) {
    console.warn(`[browser] ${profile.id} page action failed: ${errMsg(e)}`);
    return null;
  } finally {
    session.busy = false;
    session.lastUsedAt = Date.now();
    scheduleIdleClose(session);
  }
}

// ── login state ───────────────────────────────────────────────────────────────

export interface RuntimeLoginState {
  loggedIn: boolean;
  /** Where the check landed — useful when it's a checkpoint/2FA page. */
  url: string | null;
  /** Populated when the browser itself couldn't be reached. */
  error: string | null;
}

/**
 * Navigate to the profile's home and decide whether we are still signed in.
 *
 * POLLS rather than probing once after a fixed delay. These are heavy SPAs that
 * hydrate at wildly different speeds — a single 3s probe reported a signed-out
 * profile as signed in (observed on TikTok, whose "Log in" button renders well
 * after DOMContentLoaded).
 */
export async function checkLogin(profile: BrowserProfile): Promise<RuntimeLoginState> {
  const markers = [...LOGIN_FORM_SELECTORS, ...(profile.loggedOutSelectors ?? [])];
  const urlMarkers = profile.loginUrlMarkers ?? [];

  const result = await withPage(profile, async (page) => {
    await page.goto(profile.home, { waitUntil: "domcontentloaded", timeout: 45_000 });

    const deadline = Date.now() + 12_000;
    let loggedOut = false;
    let url: string = page.url();
    while (Date.now() < deadline) {
      await sleep(750);
      url = page.url();
      if (urlMarkers.some((m) => url.includes(m))) {
        loggedOut = true;
        break;
      }
      try {
        // This callback is serialized and runs INSIDE the page, so it cannot use
        // DOM types (the server tsconfig has no "dom" lib) — reach for the
        // document through globalThis and keep everything untyped.
        const hit = await page.evaluate((selectors: string[]) => {
          const doc: any = (globalThis as any).document;
          if (!doc) return false;
          return selectors.some((sel) =>
            Array.from(doc.querySelectorAll(sel)).some((el: any) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }),
          );
        }, markers);
        if (hit) {
          loggedOut = true;
          break;
        }
      } catch {
        // Probe failed this tick (mid-navigation) — try again next tick.
      }
    }
    return { url, loggedIn: !loggedOut };
  });

  if (!result) return { loggedIn: false, url: null, error: "Browser unavailable" };
  return { loggedIn: result.loggedIn, url: result.url, error: null };
}

/**
 * Load exported session cookies into the persistent profile, then re-check.
 *
 * This is the path that works when a site rejects an interactive login from a
 * datacenter IP: the session was minted on the operator's own trusted device
 * and is carried over, rather than attempting a fresh login from the server.
 * TikTok refused every interactive attempt and accepted this immediately.
 *
 * Cookies are set BEFORE the verify navigation, so the first authenticated load
 * happens with them in place; the profile is persistent, so Chromium writes them
 * to disk and every later action reuses them — no re-import per run.
 */
export async function importCookies(
  profile: BrowserProfile,
  cookies: RuntimeCookie[],
): Promise<RuntimeLoginState> {
  if (cookies.length === 0) return { loggedIn: false, url: null, error: "No cookies to import." };
  const set = await withPage(profile, async (page) => {
    // page.setCookie writes via CDP Network.setCookie, which honours each
    // cookie's own domain/path regardless of the page's current URL — so they
    // can be seeded without first navigating to the site.
    await page.setCookie(...cookies);
    return true;
  });
  if (!set) return { loggedIn: false, url: null, error: "Browser unavailable" };
  return checkLogin(profile);
}

// ── interaction helpers ───────────────────────────────────────────────────────

/**
 * Type text with per-character jitter, the way a person does — a single
 * instantaneous paste of a 200-character reply is the most obvious bot tell
 * there is, and several of these editors don't fire their input handlers on a
 * programmatic value set anyway.
 */
export async function typeHuman(page: AnyPage, text: string): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 0 });
    // Slightly longer pauses after sentence punctuation and spaces.
    const base = /[.,!?]/.test(ch) ? randInt(120, 320) : /\s/.test(ch) ? randInt(50, 140) : randInt(25, 95);
    await sleep(base);
  }
}

/**
 * Wait for the first selector in `selectors` to appear and return it. These
 * sites ship obfuscated class names and change their DOM constantly, so every
 * caller passes a LIST of candidate selectors rather than one brittle path.
 * Returns null on timeout instead of throwing.
 */
export async function waitForAny(
  page: AnyPage,
  selectors: string[],
  timeoutMs = 15_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isIntersectingViewport?.().catch(() => true);
          if (visible !== false) return sel;
        }
      } catch {
        /* try the next candidate */
      }
    }
    await sleep(300);
  }
  return null;
}

/** JPEG screenshot of the current page as base64. Null on failure. */
export async function screenshotBase64(page: AnyPage, quality = 60): Promise<string | null> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality, encoding: "base64" });
    return typeof buf === "string" ? buf : Buffer.from(buf).toString("base64");
  } catch {
    return null;
  }
}
