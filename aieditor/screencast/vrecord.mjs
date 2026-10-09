// VIRTUAL-TIME screencast recorder — frame-exact on any machine.
//
//   node vrecord.mjs <script.json> <outdir>
//
// Real-time capture (record.mjs + x11grab) fails on a weak CPU: a WebGL page rendered in
// software ran ~10× slow and the narration-timed actions landed tens of seconds late
// (linearity.io, 2026-10-05). Here Chrome's clock is PAUSED and advanced exactly one
// frame at a time (CDP Emulation.setVirtualTimePolicy); after each step the frame is
// screenshotted and piped to ffmpeg. Animations, smooth-scroll libraries, video and
// timers all see perfect 30 fps time; slowness only costs wall-clock. Every action is
// scheduled ON A FRAME, so `at` is exact. Same script format and events.json as
// record.mjs (t = seconds from frame 0, which IS begin — no sync marker needed).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const [scriptPath, outDir] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const CSS_W = script.viewport?.w ?? 1920, CSS_H = script.viewport?.h ?? 1080;
const SCALE = script.scale ?? 4 / 3;
const W = Math.round(CSS_W * SCALE), H = Math.round(CSS_H * SCALE);
const FPS = script.fps ?? 30000 / 1001;
const DT = 1000 / FPS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// real Chrome on a Mac (macchrome.mjs): identity, fonts, hidden scrollbars, factory egress proxy
import { CHROME, launchArgs, identity, dress, HB_ON } from "./macchrome.mjs";
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: script.profileDir || undefined,
  args: launchArgs(["--autoplay-policy=no-user-gesture-required", "--font-render-hinting=none",
         // no GPU on the render box: software WebGL costs seconds per frame (linearity.io
         // ~5 s/f). Off by default — pages fall back to their static look; a script can
         // opt back in with "webgl": true
         ...(script.webgl ? [] : ["--disable-webgl", "--disable-3d-apis"])]),
});
const page = await browser.newPage();
await dress(page, await identity(browser));
await page.evaluateOnNewDocument(HB_ON);   // static pages keep painting under virtual time (macchrome.mjs)
await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
const cdp = await page.createCDPSession();

const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", String(script.crf ?? 14), "-pix_fmt", "yuv420p",
  "-r", String(FPS), path.join(outDir, "raw.mp4")], { stdio: ["pipe", "ignore", "inherit"] });

let frame = 0, written = 0, preFrames = 0;
const events = [], cursor = [];
let cx = CSS_W / 2, cy = CSS_H / 2;
const t = () => frame / FPS;
const log = (type, extra = {}) => { const e = { t: t(), type, ...extra }; events.push(e); return e; };
const toCap = (b) => b && [b.x * SCALE, b.y * SCALE, b.width * SCALE, b.height * SCALE].map(Math.round);

let _dpr = null;
async function dpr() { if (_dpr == null) _dpr = await page.evaluate(() => devicePixelRatio); return _dpr; }
// one frame: advance the page's clock by DT, then capture it
// the clip is in DOCUMENT coordinates: on a scrolled page (0,0) is the unpainted top = black
async function vclip() {
  let x = 0, y = 0;
  try { const m = await cdp.send("Page.getLayoutMetrics"); const v = m.cssVisualViewport || {}; x = v.pageX || 0; y = v.pageY || 0; } catch {}
  return { x, y, width: CSS_W, height: CSS_H, scale: SCALE };
}
async function step() {
  await new Promise(async (resolve) => {
    const done = () => { cdp.off("Emulation.virtualTimeBudgetExpired", done); resolve(); };
    cdp.on("Emulation.virtualTimeBudgetExpired", done);
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: DT });
  });
  // clip.scale re-rasterises at capture resolution (a plain capture came back 1920×1080
  // even with a 4/3 device scale factor)
  const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, captureBeyondViewport: false,
    clip: await vclip() });   // CDP ignores the dpr: scale = SCALE (probed)
  const buf = Buffer.from(shot.data, "base64");
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  cursor.push([t(), cx * SCALE, cy * SCALE]);
  if (process.env.VR_TIMING && frame % 30 === 0) console.error(`frame ${written} at ${(performance.now() / 1000).toFixed(1)} s`);
  frame += 1;
  written += 1;
}
async function hold(seconds) { const n = Math.round(seconds * FPS); for (let i = 0; i < n; i++) await step(); }
async function holdUntil(sec) { while (t() < sec - 1e-6) await step(); }

async function pause() { await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" }); }
async function load(url, settleS) {
  // loading runs on REAL time (network); the viewer sees a hard cut to the loaded page
  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" }).catch(() => {});
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep((settleS ?? 3) * 1000);
  await pause();
}

async function find(target, optional) {
  const frags = target.text && !target.exact
    ? [target.text, ...target.text.split(/(?<=[.!?])\s+/).filter((f) => f.split(" ").length >= 2).sort((a, b) => b.length - a.length)]
    : [target.text];
  for (const txt of [...new Set(frags)]) {
    const box = await page.evaluate((tg, txt) => {
      let el = null;
      if (tg.selector) el = document.querySelector(tg.selector);
      else if (txt) {
        const want = txt.toLowerCase();
        const all = [...document.querySelectorAll("a,button,[role=button],input,textarea,label,span,div,p,h1,h2,h3,h4,li,td")];
        const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
          return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.top < innerHeight; };
        const hits = all.filter((e) => vis(e) && (tg.exact ? e.textContent.trim().toLowerCase() === want
          : (e.textContent || e.placeholder || e.getAttribute("aria-label") || "").toLowerCase().includes(want)));
        el = hits.find((e) => !hits.some((o) => o !== e && e.contains(o))) || null;
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const a = el.closest("a");
      return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName.toLowerCase(),
               text: (el.innerText || "").trim().slice(0, 80), href: a ? a.href : null, blank: a ? a.target === "_blank" : false };
    }, target, txt);
    if (box) return box;
  }
  if (target.xy) return { x: target.xy[0] - 1, y: target.xy[1] - 1, width: 2, height: 2 };
  if (optional) return null;
  throw new Error(`target not found: ${JSON.stringify(target)}`);
}

// cursor path: eased cubic Bézier with a slight bow, ONE POSITION PER FRAME
async function moveTo(x, y, ms) {
  const d = Math.hypot(x - cx, y - cy);
  if (d < 1) return;
  const dur = (ms ?? Math.min(1100, 280 + 160 * Math.log2(1 + d / 40))) / 1000;
  const n = Math.max(4, Math.round(dur * FPS));
  const nx = -(y - cy) / d, ny = (x - cx) / d, bow = Math.min(60, d * 0.12) * (frame % 2 ? -1 : 1);
  const x0 = cx, y0 = cy, p1 = [x0 + (x - x0) * 0.3 + nx * bow, y0 + (y - y0) * 0.3 + ny * bow],
    p2 = [x0 + (x - x0) * 0.8 + nx * bow * 0.3, y0 + (y - y0) * 0.8 + ny * bow * 0.3];
  for (let i = 1; i <= n; i++) {
    const u = i / n, e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2, m = 1 - e;
    cx = m ** 3 * x0 + 3 * m * m * e * p1[0] + 3 * m * e * e * p2[0] + e ** 3 * x;
    cy = m ** 3 * y0 + 3 * m * m * e * p1[1] + 3 * m * e * e * p2[1] + e ** 3 * y;
    await page.mouse.move(cx, cy);
    await step();
  }
}
const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
const LEAD = { click: 0.75, move: 0.6, hover: 0.6, type: 0.3, scroll: 0, read: 0, highlight: 0 };

let failed = null, begun = false;
for (const [i, s] of script.steps.entries()) {
  try {
    const kind = Object.keys(LEAD).find((k) => s[k]);
    if (s.at != null && begun) await holdUntil(s.at - (LEAD[kind] ?? 0));
    if (s.goto) {
      log("nav", { url: s.goto });
      await load(s.goto, (s.settle ?? 2500) / 1000);
      _dpr = null;
      if (s.css) await page.addStyleTag({ content: s.css });
      if (!begun) { cx = CSS_W * 0.62; cy = CSS_H * 0.58; }
    } else if (s.begin) {
      begun = true;
      preFrames = written;
      frame = 0;
      cursor.length = 0;
      events.length = 0;                // the clip starts here: t=0 = frame 0
      log("begin");
    } else if (s.wait) {
      await hold(s.wait / 1000);
    } else if (s.move || s.hover) {
      const b = await find(s.move || s.hover, s.optional);
      if (b) { const e = log(s.hover ? "hover" : "move", { box: toCap(b) }); await moveTo(...centre(b), s.ms); e.end = t(); }
    } else if (s.click) {
      const b = await find(s.click, s.optional);
      if (b) {
        const e = log("click", { box: toCap(b), text: s.click.text });
        await moveTo(...centre(b));
        await hold(0.12);
        await page.mouse.down(); await step(); await step(); await page.mouse.up();
        e.press = t();
        if (b.href && (b.blank || s.navigates)) {
          // a new-tab link (Linearity's "Log in") would leave the recorded tab where it was:
          // open its page HERE, a hard cut like any page change
          log("nav", { via: "click", url: b.href });
          await load(b.href, (s.settle ?? 2500) / 1000);
          _dpr = null;
        } else if (s.navigates) {
          await sleep(300);
          await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" }).catch(() => {});
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await sleep((s.settle ?? 2500));
          await pause();
          log("nav", { via: "click" });
        }
        e.end = t();
      }
    } else if (s.type) {
      const b = s.type.target ? await find(s.type.target, s.optional) : null;
      if (b) { await moveTo(...centre(b)); await page.mouse.click(cx, cy); }
      const e = log("type", { box: toCap(b), text: s.type.text });
      const perChar = FPS / (s.type.cps ?? 14);
      let acc = 0;
      for (const ch of s.type.text) { await page.keyboard.type(ch); acc += perChar; while (acc >= 1) { await step(); acc -= 1; } }
      e.end = t();
      if (s.type.enter) { await hold(0.25); await page.keyboard.press("Enter"); log("key", { key: "Enter" }); }
    } else if (s.scroll) {
      // native wheel flicks like the reference (~200 px per flick over 9–16 f)
      const e = log("scroll", { by: s.scroll.by });
      const n = Math.max(1, Math.round(Math.abs(s.scroll.by) / 200));
      for (let k = 0; k < n; k++) { await page.mouse.wheel({ deltaY: s.scroll.by / n }); await hold(0.4); }
      e.end = t();
    } else if (s.read || s.highlight) {
      const tg = s.read || s.highlight;
      const b = await find(tg, s.optional);
      // a marker belongs on TEXT: an input/textarea/empty element is only framed, not marked
      const markable = b && !["input", "textarea", "select", "img", "video", "canvas"].includes(b.tag) && b.text;
      if (b) { const e = log(s.highlight && markable ? "highlight" : "read", { box: toCap(b), text: tg.text }); await hold((s.ms ?? 2000) / 1000); e.end = t(); }
    }
    if (s.pause) await hold(s.pause / 1000);
  } catch (err) {
    log("error", { step: i, message: String(err?.message ?? err).slice(0, 300) });
    if (!s.optional) { failed = `step ${i}: ${String(err?.message ?? err).slice(0, 200)}`; break; }
  }
}
if (script.until) await holdUntil(script.until);
await hold((script.tail ?? 800) / 1000);
const endT = t();
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
fs.writeFileSync(path.join(outDir, "events.json"), JSON.stringify({
  capture: { w: W, h: H, fps: FPS, scale: SCALE, css: [CSS_W, CSS_H] }, virtual_time: true,
  marker: "none — video frame pre_frames is begin (t=0)", pre_frames: preFrames, end: endT, failed, cursor, events }, null, 1));
console.log(JSON.stringify({ ok: !failed, failed, frames: frame, seconds: endT, events: events.length }));
