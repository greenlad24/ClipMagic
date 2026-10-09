// Screencast recorder (Auto Editor phase 3).
//
//   node record.mjs <script.json> <outdir>
//
// A real, headful Chromium on Xvfb, captured by ffmpeg x11grab — not Playwright's
// recordVideo (~1 Mbps VP8, unusable for 4K zooms). The OS cursor is NOT captured:
// the recorder moves the mouse along human-like curves and logs every position, and
// the renderer draws a clean cursor later (so it can be smoothed, scaled with the
// zoom, or hidden). Every step is logged with the target element's box, which is
// what the camera (render.py) zooms to.
//
// Output: <outdir>/raw.mp4 (capture px), <outdir>/events.json
//   { capture: {w,h,fps,scale}, offset_s, cursor: [[t,x,y]...], events: [{t, end, type, box, text}] }
//   all coordinates in CAPTURE pixels, all times in seconds on the video's own clock.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
// HARD RULES IN THE CLICK CODE (clickguard.mjs): goto / click / type / Enter are checked before they happen
import { check as guardCheck, describeInPage } from "./clickguard.mjs";

const [scriptPath, outDir] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

const CSS_W = script.viewport?.w ?? 1920;
const CSS_H = script.viewport?.h ?? 1080;
const SCALE = script.scale ?? 4 / 3;                       // 1920×1080 CSS → 2560×1440 capture
const W = Math.round(CSS_W * SCALE), H = Math.round(CSS_H * SCALE);
const FPS = script.fps ?? 30;
const DISPLAY = ":99";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now() / 1000;

// ── display + capture ──────────────────────────────────────────────────────────
const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
await sleep(800);
process.env.DISPLAY = DISPLAY;

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: false,
  defaultViewport: null,
  userDataDir: script.profileDir || undefined,
  ignoreDefaultArgs: ["--enable-automation"],
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--kiosk", "--no-first-run", "--disable-infobars",
    `--window-size=${W},${H}`, "--window-position=0,0", `--force-device-scale-factor=${SCALE}`,
    "--hide-scrollbars", "--disable-features=Translate", "--autoplay-policy=no-user-gesture-required",
    `--lang=${script.lang ?? "en-US"}`,
  ],
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
// --force-device-scale-factor alone left the layout 2560 CSS px wide (measured):
// emulate the 1920×1080 desktop at SCALE dpr so it fills the W×H window exactly.
await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });

// The sync marker: a white page, then black — the frame where it turns black is
// logged time `markT`, so offset = frame time − markT (renderer reads it from the video).
await page.setContent("<body style='margin:0;background:#fff;height:100vh'></body>");
await sleep(500);

const ff = spawn("ffmpeg", [
  "-v", "error", "-y", "-f", "x11grab", "-framerate", String(FPS), "-video_size", `${W}x${H}`,
  "-draw_mouse", "0", "-i", DISPLAY,
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", String(script.crf ?? 14), "-pix_fmt", "yuv420p",
  path.join(outDir, "raw.mp4"),
], { stdio: ["pipe", "ignore", "inherit"] });
await sleep(1200);
await page.evaluate(() => { document.body.style.background = "#000"; });
const markT = now();
await sleep(600);

// ── logging ────────────────────────────────────────────────────────────────────
const events = [];
const cursor = [];
let cx = CSS_W / 2, cy = CSS_H / 2;
const t = () => now() - markT;                       // seconds after the marker
const log = (type, extra = {}) => { const e = { t: t(), type, ...extra }; events.push(e); return e; };
const toCap = (b) => b && [b.x * SCALE, b.y * SCALE, b.width * SCALE, b.height * SCALE].map((v) => Math.round(v));

async function find(target, optional = false) {
  // live pages change (a rotating headline), so a long text that is not on the page falls
  // back to its sentence fragments, longest first
  if (target.text && !target.exact) {
    const frags = [target.text, ...target.text.split(/(?<=[.!?])\s+/).filter((f) => f.split(" ").length >= 2)
      .sort((a, b) => b.length - a.length)].filter((v, i, a) => a.indexOf(v) === i);
    let last;
    for (const [n, f] of frags.entries()) {
      try { return await findOne({ ...target, text: f, timeout: target.timeout ?? (n === 0 ? (optional ? 4000 : 15000) : 1500) }); }
      catch (e) { last = e; }
    }
    throw last;
  }
  return findOne({ ...target, timeout: target.timeout ?? (optional ? 4000 : 15000) });
}

async function findOne(target) {
  // a target is {selector} | {text} (visible element whose own text contains it) | {xy:[x,y]} CSS px
  if (target.xy) return { x: target.xy[0] - 1, y: target.xy[1] - 1, width: 2, height: 2 };
  let handle;
  if (target.selector) handle = await page.waitForSelector(target.selector, { visible: true, timeout: target.timeout ?? 15000 });
  else if (target.text) {
    handle = await page.waitForFunction((txt, exact) => {
      const want = txt.toLowerCase();
      const all = [...document.querySelectorAll("a,button,[role=button],input,textarea,label,span,div,p,h1,h2,h3,h4,li,td")];
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.top < innerHeight; };
      // innermost visible element carrying the text
      const hits = all.filter((el) => vis(el) && (exact ? el.textContent.trim().toLowerCase() === want
        : el.textContent.toLowerCase().includes(want)));
      return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) || null;
    }, { timeout: target.timeout ?? 15000 }, target.text, !!target.exact);
  }
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no box for ${JSON.stringify(target)}`);
  return box;
}

// Human-ish path: eased cubic Bézier with a slight arc, duration from Fitts-like distance.
async function moveTo(x, y, opts = {}) {
  const d = Math.hypot(x - cx, y - cy);
  if (d < 1) return;
  const dur = opts.ms ?? Math.min(1100, 280 + 160 * Math.log2(1 + d / 40));
  const steps = Math.max(8, Math.round(dur / 16));
  const nx = -(y - cy) / d, ny = (x - cx) / d, bow = Math.min(60, d * 0.12) * (Math.random() < 0.5 ? -1 : 1);
  const p1 = [cx + (x - cx) * 0.3 + nx * bow, cy + (y - cy) * 0.3 + ny * bow];
  const p2 = [cx + (x - cx) * 0.8 + nx * bow * 0.3, cy + (y - cy) * 0.8 + ny * bow * 0.3];
  const x0 = cx, y0 = cy, t0 = now();
  for (let i = 1; i <= steps; i++) {
    const u = i / steps, e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;   // easeInOutCubic
    const m = 1 - e;
    const px = m * m * m * x0 + 3 * m * m * e * p1[0] + 3 * m * e * e * p2[0] + e * e * e * x;
    const py = m * m * m * y0 + 3 * m * m * e * p1[1] + 3 * m * e * e * p2[1] + e * e * e * y;
    await page.mouse.move(px, py);
    cursor.push([t(), px * SCALE, py * SCALE]);
    const wait = t0 + (dur / 1000) * u - now();
    if (wait > 0) await sleep(wait * 1000);
  }
  cx = x; cy = y;
}
const SESSION = (script.session || process.env.AGENT_SESSION) === "outside" ? "outside" : "logged_in";
class Refused extends Error {}
async function guard(action, q, extra = {}) {
  const target = q ? { ...extra, ...((await page.evaluate(describeInPage, q).catch(() => null)) || {}) } : (Object.keys(extra).length ? extra : null);
  const g = guardCheck(action, target, SESSION);
  if (!g.ok) { events.push({ t: t(), type: "refused", rule: g.refused, why: g.why }); throw new Refused(`refused by the click guard: ${g.refused} — ${g.why}`); }
}
const centre = (b, at) => at ? [b.x + b.width * at[0], b.y + b.height * at[1]] : [b.x + b.width / 2, b.y + b.height / 2];

// Keep logging the resting cursor so the renderer has a sample every ~100 ms.
const idle = setInterval(() => cursor.push([t(), cx * SCALE, cy * SCALE]), 100);

// ── steps ──────────────────────────────────────────────────────────────────────
let failed = null;
let beginT = null;       // {begin:true} marks the segment's t=0 (after loading); steps with
                         // `at` (s after begin) wait so their ACTION lands on the spoken word
const ACTION_LEAD = { click: 0.75, move: 0.6, hover: 0.6, type: 0.3, scroll: 0.1, read: 0, highlight: 0 };
for (const [i, s] of script.steps.entries()) {
 try {
  if (s.at != null && beginT != null) {
    const kind = Object.keys(ACTION_LEAD).find((k) => s[k]) ?? "read";
    const wait = beginT + s.at - ACTION_LEAD[kind] - t();
    if (wait > 0) await sleep(wait * 1000);
  }
  if (s.begin) {
    beginT = t();
    log("begin");
  } else if (s.goto) {
    await guard({ type: "goto", url: s.goto }, null);
    const e = log("nav", { url: s.goto });
    // NOT networkidle: pages with analytics/WebGL never go idle (linearity.io sat 55 s
    // at the 60 s timeout). DOM ready, then a settle for fonts/intro animations.
    await page.goto(s.goto, { waitUntil: s.waitUntil ?? "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(s.settle ?? 2500);
    if (s.css) await page.addStyleTag({ content: s.css });           // e.g. hide cookie banners
    e.viewport = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    e.end = t();
  } else if (s.eval) {
    await page.evaluate(s.eval);
  } else if (s.wait) {
    await sleep(s.wait);
  } else if (s.move || s.hover) {
    const b = await find(s.move || s.hover, !!s.optional);
    const e = log(s.hover ? "hover" : "move", { box: toCap(b), text: (s.move || s.hover).text });
    await moveTo(...centre(b, s.at), s);
    e.end = t();
  } else if (s.click) {
    const b = await find(s.click, !!s.optional);
    await guard({ type: "click", click: s.click }, { x: centre(b)[0], y: centre(b)[1] });
    const e = log("click", { box: toCap(b), text: s.click.text });
    await moveTo(...centre(b, s.at), s);
    await sleep(120);
    await page.mouse.down(); await sleep(70); await page.mouse.up();
    e.press = t();
    if (s.navigates) { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}); await sleep(s.settle ?? 2000); }
    e.end = t();
  } else if (s.type) {
    const b = s.type.target ? await find(s.type.target, !!s.optional) : null;
    await guard({ type: "type", text: s.type.text }, b ? { x: centre(b)[0], y: centre(b)[1] } : { focused: true });
    if (b) { await moveTo(...centre(b)); await page.mouse.click(cx, cy); }
    const e = log("type", { box: toCap(b), text: s.type.text });
    for (const ch of s.type.text) {
      await page.keyboard.type(ch);
      await sleep((s.type.cps ? 1000 / s.type.cps : 55) * (0.6 + Math.random() * 0.8));
    }
    e.end = t();
    if (s.type.enter) { await guard({ type: "key", key: "Enter" }, { focused: true }); await sleep(250); await page.keyboard.press("Enter"); log("key", { key: "Enter" }); }
  } else if (s.scroll) {
    // smooth scroll in small wheel steps so the capture shows motion, not jumps
    const e = log("scroll", { by: s.scroll.by });
    const n = Math.max(6, Math.round(Math.abs(s.scroll.by) / 40));
    for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: s.scroll.by / n }); await sleep(s.scroll.ms ? s.scroll.ms / n : 22); }
    await sleep(300);
    e.end = t();
  } else if (s.read) {
    // a "look here" beat: no action, but the camera should frame this region
    const b = await find(s.read, !!s.optional);
    const e = log("read", { box: toCap(b), text: s.read.text });
    await sleep(s.ms ?? 2000);
    e.end = t();
  } else if (s.highlight) {
    // a marker highlight to draw over this text in post (reference 2's yellow boxes)
    const b = await find(s.highlight, !!s.optional);
    const e = log("highlight", { box: toCap(b), text: s.highlight.text });
    await sleep(s.ms ?? 1500);
    e.end = t();
  }
  if (s.pause) await sleep(s.pause);
 } catch (err) {
  // a missing element must not leave a half-written capture: screenshot, then stop
  // (or carry on when the step says it is optional)
  await page.screenshot({ path: path.join(outDir, `error-step${i}.png`) }).catch(() => {});
  log("error", { step: i, message: String(err?.message ?? err).slice(0, 300) });
  if (!s.optional || err instanceof Refused) { failed = `step ${i}: ${String(err?.message ?? err).slice(0, 200)}`; break; }
 }
}
await sleep(script.tail ?? 800);
clearInterval(idle);
const endT = t();

// ── stop ───────────────────────────────────────────────────────────────────────
ff.stdin.write("q");
await new Promise((r) => ff.on("close", r));
await browser.close();
xvfb.kill();
fs.writeFileSync(path.join(outDir, "events.json"), JSON.stringify({
  capture: { w: W, h: H, fps: FPS, scale: SCALE, css: [CSS_W, CSS_H] },
  marker: "the first frame after the white→black switch is t=0",
  end: endT, failed, cursor, events,
}, null, 1));
console.log(JSON.stringify({ ok: !failed, failed, events: events.length, cursor: cursor.length, seconds: endT }));
