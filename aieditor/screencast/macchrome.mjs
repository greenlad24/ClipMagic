// "REAL CHROME ON A MAC" — the identity + look every screencast browser uses (Jake 2026-10-08: "there are
// problems with the screenshots - it should be acting like a real chrome on Mac not chromium"; his factory
// job recorded Cloudflare's "Verify you are human" page in DejaVu fonts).
//
//   · binary: Google Chrome stable when the image has it (aieditor-screencast:0.2), else Chromium
//   · identity: Mac Chrome UA built from the REAL browser version (a UA that disagrees with the engine is
//     a bot signal), UA Client Hints = "Google Chrome" on macOS, navigator.platform "MacIntel",
//     navigator.webdriver false (--disable-blink-features=AutomationControlled), en-US languages,
//     timezone Asia/Bangkok (Jake's), a plausible Apple GPU behind WebGL's debug renderer info
//   · look: overlay scrollbars hidden (macOS hides them until you scroll), Mac font names aliased by
//     image/fonts-mac.conf (SF → Inter, Helvetica/Arial → Liberation Sans, SF Mono/Menlo → JetBrains Mono,
//     emoji → Noto Color Emoji — Apple's fonts are licensed for Apple platforms only)
//   · egress: AGENT_PROXY (set on a factory server by cloud.run_remote) sends the browser out through the
//     main box, the IP the Scout logins were made from — Cloudflare ties a session to it
import fs from "node:fs";

export const CHROME = process.env.AGENT_CHROME || ["/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].find((p) => fs.existsSync(p)) || "/usr/bin/chromium";
export const TZ = process.env.AGENT_TZ || "Asia/Bangkok";
const PROXY = process.env.AGENT_PROXY || "";

export function launchArgs(extra = []) {
  return ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--password-store=basic",
          "--disable-blink-features=AutomationControlled", "--lang=en-US", "--accept-lang=en-US,en",
          "--disable-features=Translate", "--no-default-browser-check", "--no-first-run",
          ...(PROXY ? [`--proxy-server=${PROXY}`, "--proxy-bypass-list=<-loopback>"] : []), ...extra];
}

export async function identity(browser) {
  const full = ((await browser.version()) || "").replace(/^[^/]*\//, "") || "155.0.0.0";
  const major = full.split(".")[0];
  const ua = process.env.BROWSER_UA ||
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const brands = [{ brand: "Google Chrome", version: major }, { brand: "Chromium", version: major }, { brand: "Not_A Brand", version: "24" }];
  return {
    ua, major, full,
    meta: { brands, fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Not_A Brand" ? "24.0.0.0" : full })),
            fullVersion: full, platform: "macOS", platformVersion: "15.5.0", architecture: "arm", model: "",
            mobile: false, bitness: "64", wow64: false },
  };
}

const INIT = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true });
    Object.defineProperty(Navigator.prototype, "languages", { get: () => ["en-US", "en"], configurable: true });
    const V = "Google Inc. (Apple)", R = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)";
    for (const C of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
      if (!C) continue;
      const gp = C.prototype.getParameter;
      C.prototype.getParameter = function (p) { if (p === 37445) return V; if (p === 37446) return R; return gp.call(this, p); };
    }
    // macOS overlay scrollbars: hidden until you scroll
    const css = document.createElement("style");
    css.textContent = "::-webkit-scrollbar{width:0!important;height:0!important;background:transparent!important}";
    const add = () => (document.head || document.documentElement).appendChild(css);
    if (document.documentElement) add(); else document.addEventListener("DOMContentLoaded", add);
  } catch (e) {}
})();`;

// HEARTBEAT (recording only): a 1 px, 1 %-opacity square with an endless compositor animation. Under paused
// virtual time Chrome paints only when something changes — on a STATIC page (example.com, Wikipedia,
// ChatGPT's idle home, 2026-10-08) the 2nd Page.captureScreenshot never returned and the recorder hung.
// ON only while frames are being captured: outside a recording the page clock FAST-FORWARDS when idle
// (virtual time "advance") and an endless animation there kept Chrome busy at ~270 % CPU (a factory
// click took 9.7 min). HB_OFF removes it.
export const HB_ON = `(() => { const go = () => { if (!document.documentElement || document.getElementById("__amhb")) return;
  const d = document.createElement("div"); d.id = "__amhb"; d.setAttribute("aria-hidden", "true");
  d.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;background:#000;opacity:.011";
  document.documentElement.appendChild(d);
  d.animate([{ opacity: 0.011 }, { opacity: 0.012 }], { duration: 1000, iterations: Infinity, direction: "alternate" }); };
  go(); document.addEventListener("DOMContentLoaded", go); })()`;
export const HB_OFF = `(() => { const d = document.getElementById("__amhb"); if (d) d.remove(); })()`;

// apply to one page (and again to every page the recorder opens)
export async function dress(page, id) {
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: id.ua, acceptLanguage: "en-US,en;q=0.9",
                                                     platform: "MacIntel", userAgentMetadata: id.meta }).catch(() => {});
  await cdp.send("Network.setUserAgentOverride", { userAgent: id.ua, acceptLanguage: "en-US,en;q=0.9",
                                                   platform: "MacIntel", userAgentMetadata: id.meta }).catch(() => {});
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: TZ }).catch(() => {});
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => {});
  await page.evaluateOnNewDocument(INIT).catch(() => {});
  return cdp;
}

// CHALLENGE / WALL GUARD — a page we must never record: a bot check (Cloudflare "Just a moment" /
// "Verify you are human" / turnstile, captchas) or, when the session should be logged in, a login wall.
// ACCOUNT: the signed-in person's first name as the app shows it (ChatGPT's sidebar profile button, else its
// greeting "Hey, Jake." / "How can I help, Jake?"). A Scout profile can hold TWO accounts (2026-10-09: a
// recording opened on "Hey, Keith") — the recorder notes the first name it sees and wall() flags any other.
export async function accountName(page) {
  try {
    return await page.evaluate(() => {
      // the sidebar account block: "Jake Dawson\nPlus" (name line + plan line)
      const PLAN = /^\s*(?:[A-Z]{1,3}\s*\n)?([A-Z][\w'-]+)(?: [A-Z][\w'.-]+){0,3}\s*\n\s*(?:Free|Plus|Pro|Go|Team|Business|Enterprise|Edu)\s*$/;
      for (const el of document.querySelectorAll('[data-testid="accounts-profile-button"], [aria-label="Open profile menu"], nav div, aside div')) {
        const t = el.innerText || "";
        if (t.length > 60) continue;
        const m = t.match(PLAN);
        if (m) return m[1];
      }
      const g = (document.body?.innerText || "").slice(0, 3000)
        .match(/\b(?:Hey|Hi|Hello|Welcome back|Good (?:morning|afternoon|evening)|How can I help|What's on your mind(?: today)?|Ready when you are|Where should we begin)[,!]?\s+([A-Z][a-z'-]+)\b/);
      return g ? g[1] : null;
    });
  } catch { return null; }
}

export async function wall(page, account = null) {
  try {
    const w = await page.evaluate(() => {
      const url = location.href, title = document.title || "";
      const body = document.body?.innerText || "";
      const txt = body.slice(0, 4000), tail = body.slice(-20000);   // tail: the latest messages of a chat
      // only a VISIBLE challenge widget counts (an invisible reCAPTCHA v3 badge sits on many normal pages)
      const shown = [...document.querySelectorAll("iframe")].filter((f) => {
        const r = f.getBoundingClientRect();
        return r.width >= 120 && r.height >= 50 && !/size=invisible/.test(f.src || "")
          && /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\/api2\/(anchor|bframe)/i.test(f.src || "");
      });
      if (/just a moment|attention required|verify you are human|are you a robot|performing security verification/i.test(title + " " + txt.slice(0, 600))
          || shown.length || /cf-chl|__cf_chl|\/cdn-cgi\/challenge-platform/i.test(url)
          || document.querySelector("#challenge-form, #cf-challenge-running, .cf-turnstile"))
        return { kind: "challenge", why: (title || txt.slice(0, 80)).slice(0, 120), url };
      if (/\b(complete|solve) the captcha\b|captcha required/i.test(txt.slice(0, 1500))) return { kind: "challenge", why: "captcha", url };
      // the app refuses to work for this browser ("Unusual activity has been detected from your device")
      const m = tail.match(/unusual activity has been detected[^.\n]*|too many requests[^.\n]*/i);
      if (m) return { kind: "challenge", why: m[0].slice(0, 120), url };
      // an error banner the viewer would read (a failed send / generation)
      // (a whole short line: a chat that merely QUOTES the words is not an error)
      const er = tail.match(/^[ \t]*(?:message delivery timed out|something went wrong|network error)[^\n]{0,80}$/im);
      if (er) return { kind: "error", why: er[0].trim().slice(0, 120), url };
      const pw = document.querySelector("input[type=password]");
      const loginUrl = /\/\/(auth|login|accounts|signin)\.|\/(log-?in|sign-?in|auth)(\/|\?|$)/i.test(url);
      const buttons = [...document.querySelectorAll("button,a")].map((b) => (b.innerText || "").trim().toLowerCase());
      const wallBtns = buttons.includes("log in") && (buttons.includes("sign up for free") || buttons.includes("sign up"));
      if (pw || loginUrl || (wallBtns && /chatgpt\.com/.test(url)))
        return { kind: "login", why: pw ? "password field" : loginUrl ? "login address" : "log in / sign up buttons", url };
      return null;
    });
    if (w || !account) return w;
    const who = await accountName(page);
    return who && who.toLowerCase() !== String(account).toLowerCase()
      ? { kind: "account", why: `${who}, not ${account}`, url: page.url() } : null;
  } catch { return null; }
}
