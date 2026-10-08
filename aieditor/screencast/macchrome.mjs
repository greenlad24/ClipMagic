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
    const css = document.createElement("style");
    // macOS overlay scrollbars: hidden until you scroll
    // + HEARTBEAT: a 1 px, 1 %-opacity square with an endless compositor animation. Under paused virtual
    //   time Chrome only produces a new frame when something on the page changes — on a STATIC page
    //   (example.com, Wikipedia, ChatGPT's idle home 2026-10-08) the 2nd Page.captureScreenshot then
    //   waits forever and the recorder hangs. The heartbeat keeps one frame coming per step; invisible.
    css.textContent = "::-webkit-scrollbar{width:0!important;height:0!important;background:transparent!important}"
      + "@keyframes __amhb{from{opacity:.011}to{opacity:.012}}"
      + "#__amhb{position:fixed!important;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;"
      + "background:#000;animation:__amhb 1s linear infinite alternate}";
    const hb = document.createElement("div");
    hb.id = "__amhb"; hb.setAttribute("aria-hidden", "true");
    const add = () => {
      const root = document.documentElement;
      if (!root) return;
      if (!css.isConnected) (document.head || root).appendChild(css);
      if (!hb.isConnected) root.appendChild(hb);
    };
    if (document.documentElement) add();
    document.addEventListener("DOMContentLoaded", add);
    setInterval(add, 1000);                 // an app that rebuilds <html>/<head> gets them back
  } catch (e) {}
})();`;

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
export async function wall(page) {
  try {
    return await page.evaluate(() => {
      const url = location.href, title = document.title || "";
      const txt = (document.body?.innerText || "").slice(0, 4000);
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
      const pw = document.querySelector("input[type=password]");
      const loginUrl = /\/\/(auth|login|accounts|signin)\.|\/(log-?in|sign-?in|auth)(\/|\?|$)/i.test(url);
      const buttons = [...document.querySelectorAll("button,a")].map((b) => (b.innerText || "").trim().toLowerCase());
      const wallBtns = buttons.includes("log in") && (buttons.includes("sign up for free") || buttons.includes("sign up"));
      if (pw || loginUrl || (wallBtns && /chatgpt\.com/.test(url)))
        return { kind: "login", why: pw ? "password field" : loginUrl ? "login address" : "log in / sign up buttons", url };
      return null;
    });
  } catch { return null; }
}
