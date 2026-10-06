// AGENT RECORDER — one logged-in browser for a whole video, driven step by step by the
// director (aieditor/agentrec.py) over stdin/stdout JSON lines, recorded in VIRTUAL TIME.
//
//   node agent_rec.mjs <workdir> [profileDir]
//
// Why: inside a real app (Linearity, logged in through the UX Scout's session) the steps
// the narration describes are several screens deep and depend on what appears — a fixed
// script can't know them. Claude looks at each screen and picks the next action; the page's
// clock is FROZEN while it thinks and while long work loads (an AI generation), so neither
// shows in the video. Each action carries `at` (clip seconds = the spoken word) and lands
// exactly there. The browser stays open across segments, so what one screencast starts
// (a generation) the next one can show finished.
//
// Commands (one JSON per line in, one JSON per line out):
//   {"cmd":"open","url":U,"settle":2.5}            load a page (real time)
//   {"cmd":"segment","out":"seg-00/rec"}           start a recording: frame 0 = now
//   {"cmd":"observe"}                              → {t,url,title,items:[{ref,tag,text,box}],shot}
//   {"cmd":"act","action":{...}}                   → {ok,t,error?}
//   {"cmd":"end","until":S}                        hold to S, close the file, write events.json
//   {"cmd":"quit"}
// Actions: click|dblclick|hover|move {ref}; type {ref?,text,cps?,enter?}; key {key};
//   scroll {by}; read|highlight {ref,ms}; wait_for {text,timeout} (real time, clock frozen);
//   hold {s}; goto {url}. Any action may carry "at" (clip seconds).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const [workdir, profileDir] = process.argv.slice(2);
const CSS_W = 1920, CSS_H = 1080, SCALE = 4 / 3, FPS = 30000 / 1001, DT = 1000 / FPS;
const W = Math.round(CSS_W * SCALE), H = Math.round(CSS_H * SCALE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium", headless: true, userDataDir: profileDir || undefined,
  protocolTimeout: 600000,             // software WebGL: a heavy canvas frame can take minutes
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--disable-features=Translate",
         "--autoplay-policy=no-user-gesture-required", "--font-render-hinting=none", "--lang=en-US",
         "--renderer-process-limit=1", "--disable-site-isolation-trials",
         ...(process.env.AGENT_WEBGL === "1" ? [] : ["--disable-webgl", "--disable-3d-apis"])],
});
let page = (await browser.pages())[0] ?? (await browser.newPage());
await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
let cdp = await page.createCDPSession();
// a link that opens a new tab: follow it in THIS tab (the recording is one tab)
browser.on("targetcreated", async (tg) => {
  if (tg.type() !== "page") return;
  try { const p = await tg.page(); const u = p.url(); if (u && u !== "about:blank") { await p.close(); await page.goto(u).catch(() => {}); } } catch {}
});

let rec = null;            // {ff, frame, events, cursor, dir}
let cx = CSS_W * 0.62, cy = CSS_H * 0.58;
let obsN = 0;
const t = () => (rec ? rec.frame / FPS : 0);
const toCap = (b) => b && [b.x * SCALE, b.y * SCALE, b.width * SCALE, b.height * SCALE].map(Math.round);

async function pause() { await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" }).catch(() => {}); }
async function realtime() { await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" }).catch(() => {}); }
let crashed = false, lastUrl = null, stepTimer = null;
function watch(pg) {
  // a JS dialog (alert/confirm/beforeunload) freezes every evaluate until it is closed:
  // a double-click on Linearity's canvas left the recorder waiting 15 min (2026-10-06)
  pg.on("dialog", async (d) => { try { await d.dismiss(); } catch {} });
  pg.on("error", (e) => { crashed = true; process.stderr.write(`PAGE ERROR EVENT: ${e?.message}\n`); });   // the renderer died
  pg.on("framenavigated", (f) => { if (f === pg.mainFrame()) lastUrl = f.url(); });
}
watch(page);
async function recover() {
  // a dead renderer never answers: open a fresh tab at the same address and carry on
  try { await page.close().catch(() => {}); } catch {}
  page = await browser.newPage();
  await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
  cdp = await page.createCDPSession();
  watch(page);
  crashed = false;
  if (lastUrl) await load(lastUrl, 3);
}
async function step() {
  if (crashed) throw new Error("the page crashed — it was reopened; observe again");
  const ok = await Promise.race([
    new Promise(async (resolve) => {
      const done = () => { cdp.off("Emulation.virtualTimeBudgetExpired", done); resolve(true); };
      cdp.on("Emulation.virtualTimeBudgetExpired", done);
      await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: DT })
        .catch((e) => { process.stderr.write(`VT REJECT: ${e?.message}\n`); resolve(false); });
    }),
    new Promise((res) => { stepTimer = setTimeout(() => res(false), 600000); }),
  ]).finally(() => clearTimeout(stepTimer));
  if (!ok) { crashed = true; throw new Error("the page stopped responding — it was reopened; observe again"); }
  if (!rec) return;
  const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92,
    clip: { x: 0, y: 0, width: CSS_W, height: CSS_H, scale: SCALE } });
  const buf = Buffer.from(shot.data, "base64");
  if (!rec.ff.stdin.write(buf)) await new Promise((r) => rec.ff.stdin.once("drain", r));
  rec.cursor.push([t(), cx * SCALE, cy * SCALE]);
  rec.frame += 1;
}
async function holdUntil(sec) { while (rec && t() < sec - 1e-6) await step(); }
async function hold(s) { const n = Math.round(s * FPS); for (let i = 0; i < n; i++) await step(); }
function log(type, extra = {}) { const e = { t: t(), type, ...extra }; if (rec) rec.events.push(e); return e; }

async function load(url, settle = 2.5) {
  await realtime();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(settle * 1000);
  if (rec) await pause();         // off camera the page keeps real time (a WebGL editor needs it to load)
}

async function moveTo(x, y) {
  const d = Math.hypot(x - cx, y - cy);
  if (d < 1) return;
  const dur = Math.min(1100, 280 + 160 * Math.log2(1 + d / 40)) / 1000;
  const n = Math.max(4, Math.round(dur * FPS));
  const nx = -(y - cy) / d, ny = (x - cx) / d, bow = Math.min(60, d * 0.12) * (obsN % 2 ? -1 : 1);
  const x0 = cx, y0 = cy, p1 = [x0 + (x - x0) * 0.3 + nx * bow, y0 + (y - y0) * 0.3 + ny * bow],
    p2 = [x0 + (x - x0) * 0.8 + nx * bow * 0.3, y0 + (y - y0) * 0.8 + ny * bow * 0.3];
  for (let i = 1; i <= n; i++) {
    const u = i / n, e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2, m = 1 - e;
    cx = m ** 3 * x0 + 3 * m * m * e * p1[0] + 3 * m * e * e * p2[0] + e ** 3 * x;
    cy = m ** 3 * y0 + 3 * m * m * e * p1[1] + 3 * m * e * e * p2[1] + e ** 3 * y;
    await page.mouse.move(cx, cy).catch(() => {});
    if (rec) await step();
  }
}

async function observe() {
  let otimer;
  const info = await Promise.race([page.evaluate(() => {
    document.querySelectorAll("[data-agent-ref]").forEach((e) => e.removeAttribute("data-agent-ref"));
    const sel = "a,button,[role=button],[role=menuitem],[role=option],[role=tab],[role=checkbox],[role=switch],input,textarea,select,[contenteditable=true],h1,h2,h3,h4,label,li,img,[draggable=true]";
    const items = [];
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (st.visibility === "hidden" || st.display === "none" || +st.opacity < 0.15) continue;
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.getAttribute("alt") || el.title || "")
        .trim().replace(/\s+/g, " ").slice(0, 90);
      if (!text && !["input", "textarea", "img"].includes(el.tagName.toLowerCase())) continue;
      const ref = `r${++n}`;
      el.setAttribute("data-agent-ref", ref);
      items.push({ ref, tag: el.tagName.toLowerCase(), text, box: [r.x, r.y, r.width, r.height].map(Math.round) });
      if (n >= 220) break;
    }
    return { url: location.href, title: document.title, items };
  }), new Promise((_, rej) => { otimer = setTimeout(() => { crashed = true; rej(new Error("the page did not answer — it was reopened; observe again")); }, 90000); })])
    .finally(() => clearTimeout(otimer));
  const shot = path.join(workdir, `obs-${String(++obsN).padStart(4, "0")}.jpg`);
  // ⚠️ the timeout must be CLEARED when the shot returns: a bare sleep().then() fired 30 s
  // after every observation and marked a healthy page as crashed (2026-10-06)
  let timer;
  const s = await Promise.race([
    cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: CSS_W, height: CSS_H, scale: 2 / 3 } }),
    new Promise((_, rej) => { timer = setTimeout(() => { crashed = true; rej(new Error("screenshot timed out — the page was reopened; observe again")); }, 180000); }),
  ]).finally(() => clearTimeout(timer));
  fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
  return { t: t(), ...info, shot, cursor: [Math.round(cx), Math.round(cy)] };
}

async function boxOf(ref) {
  return page.evaluate((ref) => {
    const el = document.querySelector(`[data-agent-ref="${ref}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const a = el.closest("a");
    return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName.toLowerCase(),
             text: (el.innerText || "").trim().slice(0, 80), href: a ? a.href : null, blank: a ? a.target === "_blank" : false };
  }, ref);
}

const LEAD = { click: 0.75, dblclick: 0.8, move: 0.6, hover: 0.6, type: 0.3 };
async function act(a) {
  if (a.at != null && rec) await holdUntil(a.at - (LEAD[a.type] ?? 0));
  // tolerant targets: a ref, else the visible element whose text contains `text`/`target`,
  // else coordinates (x,y | to:[x,y] | xy:[x,y]) — the agent uses all three
  const need = ["click", "dblclick", "hover", "move", "read", "highlight"].includes(a.type) || (a.type === "type" && (a.ref || a.target));
  if (a.type === "key" && !a.key) a.key = a.text;
  let b = null;
  if (need) {
    if (a.ref) b = await boxOf(a.ref);
    const label = a.target || (a.type !== "type" ? a.text : null);
    if (!b && label) b = await page.evaluate((txt) => {
      const want = String(txt).toLowerCase().trim();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight; };
      const hits = [...document.querySelectorAll("body *")].filter((e) => vis(e) && (e.innerText || e.getAttribute("aria-label") || "").toLowerCase().includes(want));
      const el = hits.find((e) => !hits.some((o) => o !== e && e.contains(o)));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 80), href: null, blank: false };
    }, label).catch(() => null);
    // coordinates come in SCREENSHOT pixels (the agent sees a 1280×720 shot of the 1920×1080 page)
    const raw = a.to || a.xy || (a.x != null && a.y != null ? [a.x, a.y] : null);
    const xy = raw ? [raw[0] * 1.5, raw[1] * 1.5] : null;
    // a spot on a canvas may carry "box" (screenshot px) = the whole design it belongs to:
    // the camera frames that, the cursor still goes to the spot
    const ab = Array.isArray(a.box) && a.box.length === 4 && a.box.every((v) => Number.isFinite(v)) ? a.box.map((v) => v * 1.5) : null;
    if (!b && ab && ab[2] > 4 && ab[3] > 4) b = { x: ab[0], y: ab[1], width: ab[2], height: ab[3], tag: "region", text: "", href: null, blank: false, at: xy };
    if (!b && xy) b = { x: xy[0] - 1, y: xy[1] - 1, width: 2, height: 2, tag: "point", text: "", href: null, blank: false };
  }
  if (need && !b) return { ok: false, error: `no element for ${JSON.stringify({ ref: a.ref, text: a.text, target: a.target })} — observe again and use a ref from the list` };
  const c = b ? (b.at || [b.x + b.width / 2, b.y + b.height / 2]) : null;
  switch (a.type) {
    case "move": case "hover": { const e = log(a.type, { box: toCap(b), text: b.text }); await moveTo(...c); e.end = t(); break; }
    case "click": case "dblclick": {
      const e = log("click", { box: toCap(b), text: b.text });
      await moveTo(...c);
      if (rec) await hold(0.12);
      await page.mouse.click(cx, cy, { clickCount: a.type === "dblclick" ? 2 : 1 }).catch(() => {});
      e.press = t();
      // let the page react on the frozen clock: a handful of frames
      if (rec) await hold(0.3); else await sleep(300);
      if (b.href && b.blank) { log("nav", { url: b.href }); await load(b.href, a.settle ?? 2.5); }
      e.end = t();
      break;
    }
    case "type": {
      if (b) { await moveTo(...c); await page.mouse.click(cx, cy).catch(() => {}); }
      const e = log("type", { box: toCap(b), text: a.text });
      const perChar = FPS / (a.cps ?? 16);
      let acc = 0;
      for (const ch of a.text) {
        await page.keyboard.type(ch);
        acc += perChar;
        while (rec && acc >= 1) { await step(); acc -= 1; }
      }
      e.end = t();
      if (a.enter) { if (rec) await hold(0.25); await page.keyboard.press("Enter"); log("key", { key: "Enter" }); }
      break;
    }
    case "key": await page.keyboard.press(a.key); log("key", { key: a.key }); if (rec) await hold(0.2); break;
    case "scroll": {
      const e = log("scroll", { by: a.by });
      const n = Math.max(1, Math.round(Math.abs(a.by) / 200));
      for (let k = 0; k < n; k++) { await page.mouse.wheel({ deltaY: a.by / n }); if (rec) await hold(0.4); }
      e.end = t();
      break;
    }
    case "read": case "highlight": {
      const markable = a.type === "highlight" && !["input", "textarea", "select", "img", "video", "canvas"].includes(b.tag) && b.text;
      const e = log(markable ? "highlight" : "read", { box: toCap(b), text: b.text });
      if (rec) await hold((a.ms ?? 2000) / 1000);
      e.end = t();
      break;
    }
    case "wait_for": {
      // long work (an AI generation): wait in REAL time with the clock frozen — the viewer
      // sees the result arrive, not the wait. `show` seconds of the waiting state first.
      if (a.show && rec) await hold(a.show);
      await realtime();
      const until = Date.now() + (a.timeout ?? 180) * 1000;
      let found = false;
      while (Date.now() < until) {
        found = await page.evaluate((txt, gone) => {
          const has = document.body.innerText.toLowerCase().includes(txt.toLowerCase());
          return gone ? !has : has;
        }, a.text, !!a.gone).catch(() => false);
        if (found) break;
        await sleep(1500);
      }
      await sleep((a.settle ?? 1.5) * 1000);
      if (rec) await pause();
      log("wait", { text: a.text, found });
      if (!found) return { ok: false, t: t(), error: `"${a.text}" did not ${a.gone ? "go away" : "appear"} in ${a.timeout ?? 180} s` };
      break;
    }
    case "hold": if (rec) await hold(a.s ?? 1); else await sleep(Math.min(a.s ?? 1, 30) * 1000); break;
    case "goto": log("nav", { url: a.url }); await load(a.url, a.settle ?? 2.5); break;
    default: return { ok: false, error: `unknown action ${a.type}` };
  }
  return { ok: true, t: t() };
}

async function startSegment(dir) {
  const full = path.join(workdir, dir);
  fs.mkdirSync(full, { recursive: true });
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-x264-params", "rc-lookahead=0:sync-lookahead=0", "-threads", "2",
    "-pix_fmt", "yuv420p", "-r", String(FPS), path.join(full, "raw.mp4")],   // ~100 MB, not ~470 (the box swaps)
    { stdio: ["pipe", "ignore", "inherit"] });
  await pause();                  // the recorded clock only moves frame by frame
  rec = { ff, frame: 0, events: [], cursor: [], dir: full };
  log("begin");
}
async function endSegment(until) {
  if (!rec) return;
  if (until) await holdUntil(until);
  const r = rec;
  rec.ff.stdin.end();
  await new Promise((res) => r.ff.on("close", res));
  fs.writeFileSync(path.join(r.dir, "events.json"), JSON.stringify({
    capture: { w: W, h: H, fps: FPS, scale: SCALE, css: [CSS_W, CSS_H] }, virtual_time: true, pre_frames: 0,
    end: r.frame / FPS, failed: null, cursor: r.cursor, events: r.events }, null, 1));
  rec = null;
  await realtime();
}

await realtime();
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  let m;
  try { m = JSON.parse(line); } catch { out({ ok: false, error: "bad json" }); continue; }
  try {
    if (m.cmd === "open") { await load(m.url, m.settle ?? 2.5); out({ ok: true, url: page.url() }); }
    else if (m.cmd === "segment") { await startSegment(m.out); out({ ok: true }); }
    else if (m.cmd === "observe") out({ ok: true, ...(await observe()) });
    else if (m.cmd === "act") out(await act(m.action || {}));
    else if (m.cmd === "end") { await endSegment(m.until); out({ ok: true }); }
    else if (m.cmd === "quit") {
      // a segment still open at quit is UNFINISHED (cancel/failure): drop it — writing its
      // events.json made a half-recorded segment look done and get skipped (2026-10-06)
      if (rec) { const r = rec; r.ff.stdin.end(); await new Promise((res) => r.ff.on("close", res)); rec = null;
        try { fs.renameSync(path.join(r.dir, "raw.mp4"), path.join(r.dir, "raw.unfinished.mp4")); } catch {} }
      out({ ok: true }); break;
    }
    else out({ ok: false, error: `unknown cmd ${m.cmd}` });
  } catch (err) {
    if (crashed) await recover().catch(() => {});
    out({ ok: false, error: String(err?.message ?? err).slice(0, 300), t: t() });
  }
}
await browser.close();
process.exit(0);
