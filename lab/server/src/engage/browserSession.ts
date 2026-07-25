/**
 * Engagement Manager — interactive browser login console (Phase 3).
 *
 * The reply path needs a logged-in Instagram / Facebook / TikTok session, but
 * the box is a headless droplet: there is no screen for Jake to log in on, and
 * pasting a password into a config file is both unpleasant and useless against
 * 2FA, device checkpoints and "was this you?" interstitials.
 *
 * So this exposes the headless browser AS a remote screen: the page is streamed
 * to the Engagement Manager UI as periodic JPEG screenshots, and clicks,
 * keystrokes and scrolls are forwarded back into Chromium over CDP. Jake logs
 * in exactly once, by hand, through whatever checkpoint flow the platform
 * throws at him. The resulting cookies land in the persistent profile
 * (engage/browser.ts) and every later reply reuses them.
 *
 * The password is typed into the real platform login form inside the browser —
 * it is never sent to, stored by, or logged by this server.
 *
 * NAVIGATION IS ALLOW-LISTED. The whole console sits behind the Google
 * Sign-In gate, but a browser that will fetch any URL on command is also a
 * proxy into the Docker network (postiz:5000, 127.0.0.1:9090) for anyone who
 * ever gets a session cookie. Only the platforms' own domains are reachable,
 * and private/loopback addresses are refused outright.
 */
import {
  BROWSER_PLATFORMS,
  PLATFORM_HOME,
  browserAvailable,
  checkLogin,
  errMsg,
  hardClose,
  importCookies as browserImportCookies,
  isOpen,
  screenshotBase64,
  sleep,
  typeHuman,
  withPage,
  type BrowserPlatform,
} from "./browser.js";
import type { EngageCookie } from "./cookies.js";

/** Per-platform live console state for the UI. */
export interface BrowserSessionStatus {
  platform: BrowserPlatform;
  /** Can a browser be launched at all (puppeteer + chromium present)? */
  available: boolean;
  /** Is a browser currently running for this platform? */
  open: boolean;
  /** Last known login verdict; null until checked. */
  loggedIn: boolean | null;
  /** Current page URL, when open. */
  url: string | null;
  /** Last error surfaced to the UI. */
  error: string | null;
  /** When the login state was last verified (epoch-ms). */
  checkedAt: number | null;
}

interface Cached {
  loggedIn: boolean | null;
  url: string | null;
  error: string | null;
  checkedAt: number | null;
}

const cache = new Map<BrowserPlatform, Cached>();

function cached(platform: BrowserPlatform): Cached {
  let c = cache.get(platform);
  if (!c) {
    c = { loggedIn: null, url: null, error: null, checkedAt: null };
    cache.set(platform, c);
  }
  return c;
}

/**
 * Hosts each platform's login flow legitimately visits. Instagram's login is
 * partly served from facebook.com (Meta account linking), which is why the two
 * share a list.
 */
const ALLOWED_HOSTS: Record<BrowserPlatform, string[]> = {
  instagram: ["instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com", "m.facebook.com", "accountscenter.instagram.com", "accountscenter.facebook.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "accountscenter.facebook.com", "business.facebook.com"],
  tiktok: ["tiktok.com", "www.tiktok.com", "seller-us.tiktok.com"],
};

/**
 * Is this URL safe to navigate the console to? Must be https, must be on the
 * platform's own domain (or a subdomain of it), and must not resolve to an
 * obviously-internal name.
 */
export function navigationAllowed(platform: BrowserPlatform, rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  // Refuse anything that looks like the box itself or the Docker network.
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    /^\[?::1\]?$/.test(host)
  ) {
    return false;
  }
  return ALLOWED_HOSTS[platform].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Status for every browser-driven platform. Cheap: no launch side-effect. */
export async function listSessions(): Promise<BrowserSessionStatus[]> {
  const available = await browserAvailable();
  return BROWSER_PLATFORMS.map((platform) => {
    const c = cached(platform);
    return {
      platform,
      available,
      open: isOpen(platform),
      loggedIn: c.loggedIn,
      url: c.url,
      error: c.error,
      checkedAt: c.checkedAt,
    };
  });
}

/**
 * Launch the browser for a platform and land it on the home page (which
 * redirects to login when signed out). Idempotent — reopening an already-open
 * session just re-checks it.
 */
export async function openSession(platform: BrowserPlatform): Promise<BrowserSessionStatus> {
  const state = await checkLogin(platform);
  const c = cached(platform);
  c.loggedIn = state.error ? null : state.loggedIn;
  c.url = state.url;
  c.error = state.error;
  c.checkedAt = Date.now();
  const available = await browserAvailable();
  return {
    platform,
    available,
    open: isOpen(platform),
    loggedIn: c.loggedIn,
    url: c.url,
    error: c.error,
    checkedAt: c.checkedAt,
  };
}

/** Re-verify the login state (used after Jake finishes a login flow). */
export async function verifySession(platform: BrowserPlatform): Promise<BrowserSessionStatus> {
  return openSession(platform);
}

/**
 * Load pasted session cookies into the profile (TikTok's login fallback), then
 * refresh the cached login verdict exactly as a manual login would. The parsing
 * + domain-filtering happened in engage/cookies.ts; by here `cookies` is already
 * scoped to this platform's own domains.
 */
export async function importCookies(
  platform: BrowserPlatform,
  cookies: EngageCookie[],
): Promise<BrowserSessionStatus> {
  const state = await browserImportCookies(platform, cookies);
  const c = cached(platform);
  c.loggedIn = state.error ? null : state.loggedIn;
  c.url = state.url;
  c.error = state.error;
  c.checkedAt = Date.now();
  const available = await browserAvailable();
  return {
    platform,
    available,
    open: isOpen(platform),
    loggedIn: c.loggedIn,
    url: c.url,
    error: c.error,
    checkedAt: c.checkedAt,
  };
}

/** Close a platform's browser. The profile (and its cookies) survives. */
export async function closeSession(platform: BrowserPlatform): Promise<void> {
  await hardClose(platform);
  const c = cached(platform);
  c.url = null;
}

export interface FrameResult {
  /** base64 JPEG of the current viewport, null when unavailable. */
  image: string | null;
  url: string | null;
  error: string | null;
}

/** Grab the current frame. This is what the console polls. */
export async function frame(platform: BrowserPlatform): Promise<FrameResult> {
  const out = await withPage(platform, async (page) => {
    const image = await screenshotBase64(page);
    return { image, url: page.url() as string };
  });
  if (!out) return { image: null, url: null, error: "Browser unavailable" };
  const c = cached(platform);
  c.url = out.url;
  return { image: out.image, url: out.url, error: null };
}

/**
 * Click at viewport coordinates. The UI sends the click position as a fraction
 * of the rendered image, which the handler scales to the real viewport — so the
 * console works at any display size.
 */
export async function click(platform: BrowserPlatform, x: number, y: number): Promise<FrameResult> {
  await withPage(platform, async (page) => {
    await page.mouse.move(x, y, { steps: 8 });
    await sleep(60);
    await page.mouse.click(x, y, { delay: 40 });
    // Let the click's side-effects (focus, navigation, modal) settle.
    await sleep(700);
  });
  return frame(platform);
}

/** Type text into whatever is focused, with human-ish per-character delays. */
export async function type(platform: BrowserPlatform, text: string): Promise<FrameResult> {
  await withPage(platform, async (page) => {
    await typeHuman(page, text);
    await sleep(300);
  });
  return frame(platform);
}

/** Press a single named key (Enter, Tab, Backspace, ArrowDown…). */
export async function pressKey(platform: BrowserPlatform, key: string): Promise<FrameResult> {
  await withPage(platform, async (page) => {
    await page.keyboard.press(key);
    await sleep(900);
  });
  return frame(platform);
}

/**
 * Press, move, release — a real mouse drag. TikTok (and Instagram on a new
 * device) gates login behind a slider/puzzle captcha that CANNOT be solved with
 * clicks alone, so without this the console can get you to the login form and
 * no further.
 *
 * The movement is deliberately not a straight teleport: it steps across with a
 * slight arc and a pause before release, because these captchas score the
 * pointer path, and a single instantaneous jump reads as automation and fails.
 */
export async function drag(
  platform: BrowserPlatform,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<FrameResult> {
  await withPage(platform, async (page) => {
    await page.mouse.move(from.x, from.y, { steps: 6 });
    await sleep(180);
    await page.mouse.down();
    await sleep(140);

    const steps = 28;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      // Small vertical arc — a human hand doesn't track a perfect straight line.
      const arc = Math.sin(t * Math.PI) * 4;
      const y = from.y + (to.y - from.y) * t + arc;
      await page.mouse.move(x, y);
      await sleep(12 + Math.floor(Math.random() * 22));
    }

    // Settle on the target before releasing.
    await sleep(220);
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
    await sleep(1_200);
  });
  return frame(platform);
}

/** Scroll the page by a pixel delta. */
export async function scroll(platform: BrowserPlatform, dy: number): Promise<FrameResult> {
  await withPage(platform, async (page) => {
    await page.mouse.wheel({ deltaY: dy });
    await sleep(400);
  });
  return frame(platform);
}

/** Navigate the console to an allow-listed URL. */
export async function navigate(platform: BrowserPlatform, url: string): Promise<FrameResult> {
  const target = url || PLATFORM_HOME[platform];
  if (!navigationAllowed(platform, target)) {
    return { image: null, url: null, error: `Navigation to ${target} is not allowed for ${platform}.` };
  }
  const out = await withPage(platform, async (page) => {
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      // A navigation timeout still usually leaves a usable page — don't bail.
      console.warn(`[engage/browser] navigate ${target} slow/failed: ${errMsg(e)}`);
    }
    await sleep(1_500);
    return true;
  });
  if (!out) return { image: null, url: null, error: "Browser unavailable" };
  return frame(platform);
}
