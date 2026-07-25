/**
 * Engagement Manager — headless browser runtime (Phase 3).
 *
 * Instagram, Facebook and TikTok have no comment-WRITE API we can use: Meta
 * gates comment/DM writes behind App Review, and TikTok has no public comment
 * API at all. So replies are typed into the real web UI by a headless Chromium
 * driven over CDP, logged in as Jake once and kept logged in.
 *
 * Deliberately built on what the image ALREADY ships — no Playwright, no browser
 * download, no new dependency, same discipline as the auth gate:
 *   - `puppeteer-core`, already an OPTIONAL dependency here for Auto-Screencast.
 *     Imported lazily (like capture/screencast.ts does) so an absent module
 *     degrades to "browser unavailable" rather than breaking server boot.
 *   - The pre-baked Chromium, resolved through capture/chromium.ts's existing
 *     candidate list rather than a second hard-coded path.
 *
 * It does NOT reuse capture/chromium.ts's CHROMIUM_ARGS: those are tuned for
 * throwaway screenshots and include --ignore-certificate-errors, which is fine
 * for a page we only photograph and wrong for a browser that holds Jake's live
 * logged-in session and types his password into a form.
 *
 * Login state lives in a PERSISTENT per-platform profile directory on /data
 * (config.engageBrowserDir/<platform>), so cookies, localStorage and the
 * device fingerprint survive restarts and redeploys. That's what makes a
 * once-only interactive login (engage/browserSession.ts) worth doing.
 *
 * Everything here is best-effort and NEVER throws: a broken browser must
 * degrade the reply path, not take down the monitor loop or the server.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { chromiumAvailable, chromiumCandidates } from "../capture/chromium.js";
import type { Platform } from "./types.js";
import type { EngageCookie } from "./cookies.js";

/** Platforms we drive a browser for. YouTube is monitor-only (make.com replies). */
export type BrowserPlatform = Exclude<Platform, "youtube">;

export const BROWSER_PLATFORMS: readonly BrowserPlatform[] = ["instagram", "facebook", "tiktok"];

/** Is this a platform we can drive a browser for? */
export function isBrowserPlatform(p: Platform): p is BrowserPlatform {
  return (BROWSER_PLATFORMS as readonly string[]).includes(p);
}

// puppeteer-core is typed loosely here: it is not a declared @types dependency
// and we only touch a small, stable surface (launch/newPage/goto/click/type).
type AnyBrowser = any;
type AnyPage = any;

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
 * signed in (observed, not theorised). Paired with the DOM probe below.
 */
const LOGIN_URL_MARKERS: Record<BrowserPlatform, string[]> = {
  instagram: ["/accounts/login", "/accounts/emailsignup"],
  facebook: ["/login", "/checkpoint", "recover/initiate"],
  tiktok: ["/login", "/signup"],
};

/**
 * The decisive signal: a visible password field means we're being asked to log
 * in. It holds across all three platforms and survives their DOM churn far
 * better than hunting for a logged-in-only avatar element.
 */
const LOGIN_FORM_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="pass"]',
];

/**
 * Extra per-platform "you are logged out" markers, for platforms that don't put
 * a password field on the page. TikTok is the case that forced this: its
 * logged-out home renders a normal feed with a "Log in" button in the header and
 * only opens the password form in a modal, so the shared probe above sees
 * nothing and reports a signed-out profile as signed in (observed).
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

/**
 * Chromium executables to try, in order. Reuses the resolver Auto-Screencast
 * already relies on (env override → Remotion's cached download → system paths),
 * with an engage-specific override in front of it.
 */
function executableCandidates(): string[] {
  const explicit = process.env.ENGAGE_BROWSER_EXECUTABLE;
  const shared = chromiumCandidates();
  return explicit ? [explicit, ...shared.filter((p) => p !== explicit)] : shared;
}

/**
 * Headless unless explicitly disabled. There is no display on the droplet, so
 * headful only makes sense when someone is debugging over an X forward.
 */
function headless(): boolean {
  return (process.env.ENGAGE_BROWSER_HEADLESS || "").toLowerCase() !== "false";
}

/** Per-platform persistent Chromium profile (cookies + localStorage + fingerprint). */
export function profileDir(platform: BrowserPlatform): string {
  return path.join(config.engageBrowserDir, platform);
}

/**
 * Chromium writes SingletonLock/Socket/Cookie into the profile and refuses to
 * start if they're already there. They're symlinks naming the host + pid that
 * holds the profile — so a container restart (or a killed browser) strands them
 * pointing at a process that no longer exists, and EVERY later launch fails with
 * a bare "Failed to launch the browser process!". Observed on the first redeploy
 * after a profile had been opened.
 *
 * Only ever called when this process holds no live session for the platform, so
 * a lock we find here is by definition not ours.
 */
function clearStaleLocks(dir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      // lstat, not existsSync: these are symlinks to a dead target, so
      // existsSync follows the link and reports false.
      fs.lstatSync(path.join(dir, name));
      fs.unlinkSync(path.join(dir, name));
      console.log(`[engage/browser] cleared stale ${name} in ${dir}`);
    } catch {
      /* absent — nothing to clear */
    }
  }
}

/**
 * A stable, ordinary desktop user-agent. Headless Chromium's default UA
 * contains "HeadlessChrome", which several of these sites treat as a bot
 * signal — overriding it is the single highest-value evasion-of-nothing tweak
 * (we're logging into Jake's own accounts, not hiding from anyone).
 */
const USER_AGENT =
  process.env.ENGAGE_BROWSER_UA ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** Console viewport. Exported so click coordinates can be scaled against it. */
export const VIEWPORT = { width: 1280, height: 900 };

interface Session {
  platform: BrowserPlatform;
  browser: AnyBrowser;
  page: AnyPage;
  /** Set while a caller holds the session, so the idle reaper can't close it. */
  busy: boolean;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
}

const sessions = new Map<BrowserPlatform, Session>();

/** Close an idle browser after this long. Keeps RAM free between replies. */
function idleMs(): number {
  const n = Number.parseInt(process.env.ENGAGE_BROWSER_IDLE_MS || "", 10);
  return Number.isFinite(n) && n > 10_000 ? n : 5 * 60_000;
}

/** Lazily load puppeteer-core. Returns null (never throws) when unavailable. */
async function loadPuppeteer(): Promise<any | null> {
  try {
    const mod: any = await import("puppeteer-core");
    return mod?.default ?? mod;
  } catch (e) {
    console.warn(`[engage/browser] puppeteer-core unavailable: ${errMsg(e)}`);
    return null;
  }
}

/** True when a browser can be launched at all (module + binary both present). */
export async function browserAvailable(): Promise<boolean> {
  if (!(await loadPuppeteer())) return false;
  return chromiumAvailable();
}

/**
 * Launch (or reuse) the browser for a platform. Returns null if the runtime
 * isn't available — callers treat that as "reply path is inert".
 */
async function ensureSession(platform: BrowserPlatform): Promise<Session | null> {
  const existing = sessions.get(platform);
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
    await hardClose(platform);
  }

  const puppeteer = await loadPuppeteer();
  if (!puppeteer) return null;

  const dir = profileDir(platform);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`[engage/browser] cannot create profile dir ${dir}: ${errMsg(e)}`);
    return null;
  }
  // We hold no session for this platform (checked above), so any lock in the
  // profile is left over from a dead process — clear it or Chromium won't start.
  clearStaleLocks(dir);

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
    // carries a live login and types a password; TLS must be enforced.
  ];

  const candidates = executableCandidates();
  if (candidates.length === 0) {
    console.warn("[engage/browser] no Chromium executable found");
    return null;
  }

  let browser: AnyBrowser = null;
  let lastErr = "";
  for (const exe of candidates) {
    try {
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: headless(),
        userDataDir: dir,
        defaultViewport: VIEWPORT,
        args,
      });
      break;
    } catch (e) {
      lastErr = errMsg(e);
    }
  }
  if (!browser) {
    console.warn(`[engage/browser] Chromium failed to launch for ${platform} (tried ${candidates.length}): ${lastErr}`);
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

    const session: Session = {
      platform,
      browser,
      page,
      busy: false,
      lastUsedAt: Date.now(),
      idleTimer: null,
    };
    sessions.set(platform, session);
    scheduleIdleClose(session);
    console.log(`[engage/browser] launched ${platform} (profile ${dir})`);
    return session;
  } catch (e) {
    // The browser launched but the page setup didn't — close it, or we leak a
    // Chromium process (and its lock on the profile dir) on every retry.
    console.warn(`[engage/browser] page setup failed for ${platform}: ${errMsg(e)}`);
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
    if (session.busy) {
      scheduleIdleClose(session);
      return;
    }
    if (Date.now() - session.lastUsedAt < idleMs()) {
      scheduleIdleClose(session);
      return;
    }
    void hardClose(session.platform);
  }, idleMs());
  if (typeof session.idleTimer.unref === "function") session.idleTimer.unref();
}

/** Close a platform's browser and forget it. Never throws. */
export async function hardClose(platform: BrowserPlatform): Promise<void> {
  const session = sessions.get(platform);
  if (!session) return;
  sessions.delete(platform);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    await session.browser.close();
  } catch {
    /* best-effort */
  }
  console.log(`[engage/browser] closed ${platform}`);
}

/** Close every open browser (used on shutdown / kill-switch arming). */
export async function closeAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((p) => hardClose(p)));
}

/** Is a browser currently open for this platform? (No launch side-effect.) */
export function isOpen(platform: BrowserPlatform): boolean {
  return sessions.has(platform);
}

/**
 * Run `fn` against the platform's page, holding the session so the idle reaper
 * and any concurrent caller can't pull it out from under you. Returns null when
 * the browser can't be launched; propagates nothing — errors become null and a
 * warning, because every caller here is best-effort.
 */
export async function withPage<T>(
  platform: BrowserPlatform,
  fn: (page: AnyPage) => Promise<T>,
): Promise<T | null> {
  const session = await ensureSession(platform);
  if (!session) return null;
  // Serialize access: two replies typing into the same page would interleave.
  while (session.busy) await sleep(250);
  session.busy = true;
  try {
    const out = await fn(session.page);
    return out;
  } catch (e) {
    console.warn(`[engage/browser] ${platform} page action failed: ${errMsg(e)}`);
    return null;
  } finally {
    session.busy = false;
    session.lastUsedAt = Date.now();
    scheduleIdleClose(session);
  }
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

/**
 * Navigate to the platform home and decide whether we're still signed in.
 * Logged out = the URL is a login/checkpoint route OR the page is showing a
 * password field. Both checks are needed; see LOGIN_FORM_SELECTORS.
 */
export async function checkLogin(platform: BrowserPlatform): Promise<LoginState> {
  const result = await withPage(platform, async (page) => {
    await page.goto(PLATFORM_HOME[platform], { waitUntil: "domcontentloaded", timeout: 45_000 });

    const markers = [...LOGIN_FORM_SELECTORS, ...LOGGED_OUT_SELECTORS[platform]];
    // POLL rather than probe once after a fixed delay. These are heavy SPAs and
    // they hydrate at wildly different speeds — TikTok renders its "Log in"
    // button well after DOMContentLoaded, and a single 3s probe reported a
    // signed-out profile as signed in (observed).
    const deadline = Date.now() + 12_000;
    let loggedOut = false;
    let url: string = page.url();
    while (Date.now() < deadline) {
      await sleep(750);
      url = page.url();
      if (LOGIN_URL_MARKERS[platform].some((m) => url.includes(m))) {
        loggedOut = true;
        break;
      }
      try {
        // NOTE: this callback is serialized and runs INSIDE the page, so it
        // can't use DOM types (the server's tsconfig has no "dom" lib) — reach
        // for the document through globalThis and keep everything untyped.
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

  if (!result) {
    return { platform, loggedIn: false, url: null, error: "Browser unavailable" };
  }
  return { platform, loggedIn: result.loggedIn, url: result.url, error: null };
}

/**
 * Load exported session cookies into the persistent profile, then re-check the
 * login state. This is TikTok's fallback (see engage/cookies.ts): the session
 * was minted on Jake's own trusted device and we carry it over, rather than
 * trying to pass a fresh login from the datacenter IP that TikTok rejects.
 *
 * Cookies are set BEFORE the verify navigation, so the first authenticated load
 * happens with them in place; and because the profile is persistent, Chromium
 * writes them to disk and every later reply reuses them — no re-import per run.
 */
export async function importCookies(
  platform: BrowserPlatform,
  cookies: EngageCookie[],
): Promise<LoginState> {
  if (cookies.length === 0) {
    return { platform, loggedIn: false, url: null, error: "No cookies to import." };
  }
  const set = await withPage(platform, async (page) => {
    // page.setCookie writes via CDP Network.setCookie, which honours each
    // cookie's own domain/path regardless of the page's current URL — so we can
    // seed them without first navigating to the platform.
    await page.setCookie(...cookies);
    return true;
  });
  if (!set) return { platform, loggedIn: false, url: null, error: "Browser unavailable" };
  return checkLogin(platform);
}

// ── human-ish interaction helpers ─────────────────────────────────────────────

/** Uniform random integer in [min, max]. */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * sender passes a LIST of candidate selectors rather than one brittle path.
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

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
