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
//   {"cmd":"abort"}                                drop the take: close the file, delete its dir (NO events.json)
//   {"cmd":"state"}                                first-frame facts (account, h1, sidebar, draft, popups…) + a shot
//   {"cmd":"assert", ...}                          after a beat: url whitelist, texts present/absent, field text
//   {"cmd":"quit"}
// Actions: click|dblclick|hover|move {ref}; type {ref?,text,cps?,enter?}; key {key};
//   scroll {by}; read|highlight {ref,ms}; wait_for {text,timeout} (real time, clock frozen);
//   hold {s} (≤ 3 s while recording: no still > 3 s, RULEBOOK P1); goto {url}; drag {from,to};
//   draw {strokes, box?}; upload {files}; reveal {url, asset} (K2 time-skip dissolve to a result made
//   off camera). Any action may carry "at" (clip seconds); a click with "press": false moves the cursor
//   and logs the click without pressing (a send whose result is revealed from assets.json).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import puppeteer from "puppeteer-core";

const [workdir, profileDir] = process.argv.slice(2);
// UI magnification (SYSTEM.md §4): reference 2's recording is "already UI-magnified" — the app is
// laid out at a smaller CSS viewport and captured at 2560×1440, so every control reads ~1.25×
// larger than a plain 1920-wide desktop. AGENT_CSS_W=1920 restores the old 1:1 desktop.
const CSS_W = +(process.env.AGENT_CSS_W || 1536), CSS_H = Math.round(CSS_W * 9 / 16), SCALE = 2560 / CSS_W,
  FPS = 30000 / 1001, DT = 1000 / FPS;
const SHOT_F = CSS_W / 1280;          // the agent sees a 1280×720 screenshot: shot px × SHOT_F = CSS px
const W = Math.round(CSS_W * SCALE), H = Math.round(CSS_H * SCALE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// REAL CHROME ON A MAC (macchrome.mjs — Jake 2026-10-08): Google Chrome stable when the image has it,
// a Mac Chrome UA that matches the engine's real version, UA-CH "Google Chrome"/macOS, platform MacIntel,
// webdriver false, Asia/Bangkok, hidden scrollbars, Mac font aliases; AGENT_PROXY = egress via the main box.
import { execFileSync } from "node:child_process";
import { CHROME, launchArgs, identity, dress, wall as wallOf, accountName, HB_ON, HB_OFF } from "./macchrome.mjs";
// HARD RULES IN THE CLICK CODE (clickguard.mjs): a Scout profile is a logged-in session — never pricing,
// billing, checkout, delete, share, publish or log out. AGENT_SESSION=outside only for a fresh profile.
import { check as guardCheck, describeInPage } from "./clickguard.mjs";
const SESSION = process.env.AGENT_SESSION || (profileDir ? "logged_in" : "outside");
import { privacySampler, privateSelectors, privacyBoxes } from "./privacy_dom.mjs";   // RULEBOOK C7: private boxes every 0.25 s
// the Scout account this session belongs to (first name, noted on the first clean page; AGENT_ACCOUNT overrides)
let ACCOUNT = process.env.AGENT_ACCOUNT || null;
async function wall(pg) {
  const w = await wallOf(pg, ACCOUNT);
  if (!w && !ACCOUNT) ACCOUNT = await accountName(pg);
  return w;
}
const VER = (() => { try { return execFileSync(CHROME, ["--version"]).toString().match(/(\d+)\./)[1]; } catch { return "155"; } })();
const UA = process.env.BROWSER_UA ||
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VER}.0.0.0 Safari/537.36`;
process.env.BROWSER_UA = UA;
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profileDir || undefined,
  protocolTimeout: 600000,             // software WebGL: a heavy canvas frame can take minutes
  args: launchArgs([`--user-agent=${UA}`, "--autoplay-policy=no-user-gesture-required", "--font-render-hinting=none",
         "--renderer-process-limit=1", "--disable-site-isolation-trials",
         ...(process.env.AGENT_WEBGL === "1" ? [] : ["--disable-webgl", "--disable-3d-apis"])]),
});
const ID = await identity(browser);
let page = (await browser.pages())[0] ?? (await browser.newPage());
await dress(page, ID);
// Dark screencasts (Jake 2026-10-08: "I want the screencast to be on a dark theme ChatGPT"): every
// page reports prefers-color-scheme: dark, so apps on a "System" theme render dark.
const DARK = process.env.AGENT_DARK === "1";
const darken = (pg) => DARK ? pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]).catch(() => {}) : null;
await darken(page);
await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
let cdp = await page.createCDPSession();
// a link that opens a new tab: follow it in THIS tab (the recording is one tab)
browser.on("targetcreated", async (tg) => {
  if (tg.type() !== "page") return;
  try { const p = await tg.page(); const u = p.url(); if (u && u !== "about:blank") { await p.close(); await page.goto(u).catch(() => {}); } } catch {}
});

let rec = null;            // {ff, frame, events, cursor, dir}
const NET = [];
let cx = CSS_W * 0.62, cy = CSS_H * 0.58;
let obsN = 0;
// a single-beat retake (p7 recorder) records a PIECE that starts at its beat's window in segment time (t0)
const t = () => (rec ? (rec.t0 || 0) + rec.frame / FPS : 0);
const toCap = (b) => b && [b.x * SCALE, b.y * SCALE, b.width * SCALE, b.height * SCALE].map(Math.round);

// ⚠️ 2026-10-08 (pre-production, ChatGPT): policy "advance" FAST-FORWARDS the page clock whenever it is idle
// (Date.now ran ~155 days ahead) — uploads/XHRs then time out at once ("Upload failed"). Virtual time is
// therefore only switched on by the first recording; until then the page runs on the real clock.
let vtOn = false;
async function pause() { vtOn = true; await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" }).catch(() => {}); }
async function realtime() { if (!vtOn) return; await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" }).catch(() => {}); }
let crashed = false, lastUrl = null, stepTimer = null;
function watch(pg) {
  darken(pg);   // new tabs and recovered pages stay dark too
  // a JS dialog (alert/confirm/beforeunload) freezes every evaluate until it is closed:
  // a double-click on Linearity's canvas left the recorder waiting 15 min (2026-10-06)
  pg.on("dialog", async (d) => { try { await d.dismiss(); } catch {} });
  pg.on("error", (e) => { crashed = true; process.stderr.write(`PAGE ERROR EVENT: ${e?.message}\n`); });   // the renderer died
  pg.on("framenavigated", (f) => { if (f === pg.mainFrame()) lastUrl = f.url(); });
  // pre-production diagnostics: failed requests / HTTP errors (ring buffer, {"cmd":"net"})
  pg.on("requestfailed", (r) => { NET.push({ t: Date.now(), m: r.method(), url: r.url().slice(0, 200), err: r.failure()?.errorText }); if (NET.length > 80) NET.shift(); });
  pg.on("response", (r) => { if (r.status() >= 400) { NET.push({ t: Date.now(), m: r.request().method(), url: r.url().slice(0, 200), status: r.status() }); if (NET.length > 80) NET.shift(); } });
}
watch(page);
async function recover() {
  // a dead renderer never answers: open a fresh tab at the same address and carry on
  try { await page.close().catch(() => {}); } catch {}
  page = await browser.newPage();
  await dress(page, ID);
  await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
  cdp = await page.createCDPSession();
  hbScript = null;
  if (rec) await heartbeat(true);
  watch(page);
  crashed = false;
  if (lastUrl) await load(lastUrl, 3);
}
// ⚠️ Page.captureScreenshot's clip is in DOCUMENT coordinates: a clip at (0,0) on a scrolled
// page captures the top of the document, whose tiles are no longer painted = BLACK (2026-10-06:
// every "scrolled into a black section" of linearity.io/pricing was this, not the page). The
// clip starts at the current scroll offset.
async function vclip(scale) {
  let x = 0, y = 0;
  try { const m = await cdp.send("Page.getLayoutMetrics"); const v = m.cssVisualViewport || m.visualViewport || {}; x = v.pageX || 0; y = v.pageY || 0; } catch {}
  return { x, y, width: CSS_W, height: CSS_H, scale };
}
// ⚠️ 2026-10-08: under paused virtual time Chrome paints only when something changes — on a STATIC page the
// 2nd captureScreenshot never returned (the recorder hung for good: the old 30 s guard covered only the
// clock). macchrome.mjs's heartbeat keeps frames coming; this guard re-plants it if a page lost it, gives
// the clock one more frame, and as the last resort takes the shot from the view (fromSurface: false).
// heartbeat while recording (macchrome.mjs HB_ON): on in startSegment (+ every new document of the
// segment), off in endSegment
let hbScript = null;
async function heartbeat(on) {
  if (hbScript) { await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: hbScript }).catch(() => {}); hbScript = null; }
  if (on) hbScript = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HB_ON }).catch(() => ({}))).identifier || null;
  await cdp.send("Runtime.evaluate", { expression: on ? HB_ON : HB_OFF }).catch(() => {});
}
function withTimeout(p, ms) {
  let tm; return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(tm));
}
async function frameShot() {
  const opts = async (extra = {}) => ({ format: "jpeg", quality: 92, clip: await vclip(SCALE), ...extra });
  try { return await withTimeout(cdp.send("Page.captureScreenshot", await opts()), 15000); } catch (e) {
    process.stderr.write(`frame capture stalled (${e?.message}) — heartbeat + one more frame\n`);
  }
  await cdp.send("Runtime.evaluate", { expression: HB_ON }).catch(() => {});
  await withTimeout(new Promise(async (res) => { cdp.once("Emulation.virtualTimeBudgetExpired", res);
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 1 }).catch(res); }), 10000).catch(() => {});
  try { return await withTimeout(cdp.send("Page.captureScreenshot", await opts()), 15000); } catch {}
  try { return await withTimeout(cdp.send("Page.captureScreenshot", await opts({ fromSurface: false })), 15000); } catch {}
  crashed = true;
  throw new Error("the page stopped painting — it was reopened; observe again");
}
let stalls = 0;
async function step(silent = false) {
  if (crashed) throw new Error("the page crashed — it was reopened; observe again");
  const ok = await Promise.race([
    new Promise(async (resolve) => {
      const done = () => { cdp.off("Emulation.virtualTimeBudgetExpired", done); resolve(true); };
      cdp.on("Emulation.virtualTimeBudgetExpired", done);
      vtOn = true;
      await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: DT })
        .catch((e) => { process.stderr.write(`VT REJECT: ${e?.message}\n`); resolve(false); });
    }),
    new Promise((res) => { stepTimer = setTimeout(() => res("slow"), 30000); }),
  ]).finally(() => clearTimeout(stepTimer));
  // ⚠️ 2026-10-07 (v12 seg-02, 3×): after a wheel scroll on Linearity's brand page the budget-expired
  // event never came; the old 600 s timeout then "crashed" a healthy page. A frame that does not
  // expire in 30 s is taken anyway (the page is alive — screenshots work)
  if (ok === "slow") {
    process.stderr.write("VT budget did not expire in 30 s — continuing\n");
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" }).catch(() => {});
    stalls += 1;
    if (stalls > 20) { crashed = true; throw new Error("the page stopped responding — it was reopened; observe again"); }
  } else if (!ok) { crashed = true; throw new Error("the page stopped responding — it was reopened; observe again"); }
  if (!rec || silent) return;          // silent: the page clock moves, nothing is recorded (inside a cut)
  const shot = await frameShot();
  const buf = Buffer.from(shot.data, "base64");
  if (!rec.ff.stdin.write(buf)) await new Promise((r) => rec.ff.stdin.once("drain", r));
  await (rec.priv ??= privacySampler({ scale: SCALE, extra: privateSelectors() })).tick(page, t());
  rec.cursor.push([t(), cx * SCALE, cy * SCALE]);
  rec.frame += 1;
}
// ── settle cuts (SYSTEM.md §4): reference 2 never shows a page loading — the edit jump-cuts
// from the click to the loaded result (7 in-span cuts / min). After a click (or Enter / goto)
// the page runs in REAL time, unrecorded, until the screen stops changing and is not blank;
// if it changed meanwhile, a "cut" event is logged (the camera resets there).
const SYS = (() => { try { return JSON.parse(fs.readFileSync(new URL("../motion/screencast_system.json", import.meta.url))).recorder || {}; } catch { return {}; } })();
const SETTLE = { on: SYS.settle_after_click !== false && process.env.AGENT_SETTLE !== "0", changed: SYS.settle_changed_px ?? 0.03,
  poll: SYS.settle_poll_ms ?? 500, stable: SYS.settle_stable_polls ?? 2, max: (SYS.settle_max_s ?? 25) * 1000 };
function pngGray(buf) {
  // minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what Chrome writes) → {w,h,g:Uint8Array}
  let o = 8, w = 0, h = 0, ct = 2; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0,
        c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (px[i * bpp] * 77 + px[i * bpp + 1] * 150 + px[i * bpp + 2] * 29) >> 8;
  return { w, h, g };
}
async function tiny() {
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: await vclip(0.05) });
  return pngGray(Buffer.from(s.data, "base64")).g;
}
// 64-bit dHash of the screen (p7: a beat's expected end-state fingerprint; = beatscript.dhash on the same grid)
async function fingerprint() {
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: await vclip(0.05) });
  const { w, h, g } = pngGray(Buffer.from(s.data, "base64"));
  let bits = 0n;
  for (let r = 0; r < 8; r++) {
    const y0 = Math.floor(r * h / 8), y1 = Math.max(y0 + 1, Math.floor((r + 1) * h / 8));
    const row = [];
    for (let c = 0; c < 9; c++) {
      const x0 = Math.floor(c * w / 9), x1 = Math.max(x0 + 1, Math.floor((c + 1) * w / 9));
      let sum = 0, n = 0;
      for (let y = y0; y < Math.min(y1, h); y++) for (let x = x0; x < Math.min(x1, w); x++) { sum += g[y * w + x]; n++; }
      row.push(sum / Math.max(1, n));
    }
    for (let c = 0; c < 8; c++) bits = (bits << 1n) | (row[c] < row[c + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, "0");
}
const changedShare = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) n++; return n / a.length; };
function blankish(g) {
  let s = 0, s2 = 0; for (const v of g) { s += v; s2 += v * v; }
  const m = s / g.length, sd = Math.sqrt(Math.max(0, s2 / g.length - m * m));
  let off = 0; for (const v of g) if (Math.abs(v - m) > 14) off++;
  return sd < 6 || off / g.length < 0.02;
}
async function settleCut(why, before = null) {
  if (!rec || !SETTLE.on) return false;
  const url0 = page.url();
  let shown = before;                                               // the frame the viewer saw last
  if (!shown) { try { shown = await tiny(); } catch { return false; } }
  await realtime();
  const t0 = Date.now();
  let prev = shown, calm = 0, moved = false, cur = shown;
  try {
    while (Date.now() - t0 < SETTLE.max) {
      await sleep(SETTLE.poll);
      try { cur = await tiny(); } catch { moved = true; calm = 0; continue; }   // mid-navigation
      if (changedShare(shown, cur) > SETTLE.changed) moved = true;
      calm = changedShare(prev, cur) < 0.005 && !blankish(cur) ? calm + 1 : 0;
      prev = cur;
      if (!moved && Date.now() - t0 >= 1500) break;                // nothing is coming: no cut
      if (moved && calm >= SETTLE.stable) break;
    }
  } catch {}
  const bigCut = moved && (page.url() !== url0 || changedShare(shown, cur) > 0.35);
  let fit = null;
  if (bigCut) fit = await autoFit("cut");                          // a canvas opened: designs big, inside the cut
  await pause();
  // a BIG change (> 35 % of the screen) is a new page/panel: the camera resets there; a small
  // one (a dropdown, a toolbar) is a plain jump past the animation/loading, camera unchanged
  if (moved) log("cut", { why, big: bigCut, waited: Math.round((Date.now() - t0) / 100) / 10, ...(fit ? { fit: fit.box } : {}) });
  return moved;
}

// ── fit_designs (SYSTEM.md §4, gap "tiny thumbnails"): a design canvas opens "fit all", so the
// finished designs are ~10 % of the frame. Deterministic, measured, off camera: map which
// screen cells are the app's <canvas> (elementFromPoint), find the designs on it (cells that
// differ from the canvas's flat colour), group them into clusters, keep the main group, then
// pan + ctrl-wheel zoom in closed loop until that group fills ~78 % of the canvas area.
const FIT_GX = 96, FIT_GY = 54;
let fittedUrl = null, fitTrace = [], lastFit = null, fitArea = null, panGain = null, lastNavT = null;          // the canvas page fitDesigns framed: the agent's own canvas-zoom keys are ignored there
const AUTO_FIT = process.env.AGENT_AUTOFIT !== "0";
async function autoFit(why) {
  if (!AUTO_FIT) return null;
  try {
    const r = await fitDesigns();
    lastFit = { ...r, reason: why };
    if (rec && (r.ok || r.error !== "no design canvas on screen")) rec.events.push({ t: t(), type: "fit", why, ok: r.ok, steps: r.steps, fill: r.fill, error: r.error });
    return r.ok ? r : null;
  } catch (e) { lastFit = { why, ok: false, error: String(e?.message ?? e) }; return null; }
}
async function canvasCells() {
  return page.evaluate((GX, GY) => {
    let best = null, area = 0;
    // a <canvas>, or an app element that draws one inside its shadow root (Linearity's
    // <curve-canvas>): elementFromPoint returns the host for anything drawn in there
    const cands = [...document.querySelectorAll("canvas")].concat([...document.querySelectorAll("body *")].filter((e) => e.shadowRoot && /canvas/i.test(e.tagName)));
    for (const c of cands) {
      const r = c.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (a > area) { area = a; best = c; }
    }
    // a DESIGN canvas: most of the screen, in an app that does not scroll as a document (a
    // marketing page's WebGL hero is a canvas too — wheel there would scroll the page)
    const se = document.scrollingElement || document.documentElement;
    if (!best || area < 0.5 * innerWidth * innerHeight || se.scrollHeight > innerHeight + 4) return null;
    const m = [];
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const el = document.elementFromPoint((i + 0.5) * innerWidth / GX, (j + 0.5) * innerHeight / GY);
      m.push(el === best ? 1 : 0);
    }
    return m;
  }, FIT_GX, FIT_GY).catch(() => null);
}
async function measureDesigns() {
  const r = await measureDesigns0();
  return r && r.empty && fitTrace.length ? null : r;
}
async function measureDesigns0() {
  const cells = await canvasCells();
  if (!cells) return null;
  const sc = (FIT_GX * 4) / CSS_W;                               // 4×4 px per cell
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: await vclip(sc) });
  const { w, h, g } = pngGray(Buffer.from(shot.data, "base64"));
  // the canvas's own colour = the most common grey on canvas cells
  const hist = new Uint32Array(64);
  const cw = w / FIT_GX, ch = h / FIT_GY;
  for (let j = 0; j < FIT_GY; j++) for (let i = 0; i < FIT_GX; i++) if (cells[j * FIT_GX + i])
    for (let y = Math.floor(j * ch); y < Math.floor((j + 1) * ch); y++) for (let x = Math.floor(i * cw); x < Math.floor((i + 1) * cw); x++) hist[g[y * w + x] >> 2]++;
  const bg = hist.indexOf(Math.max(...hist)) * 4 + 2;
  const content = new Uint8Array(FIT_GX * FIT_GY);
  // a cell next to app UI floating over the canvas (the prompt pill's soft shadow/halo, a toolbar's
  // drop shadow) is NOT a design: the halo joined the designs into one group touching the bottom
  // edge and fit_designs oscillated reveal up/down and gave up (loop round 1, 2026-10-07) → cells
  // within 2 of a non-canvas cell never count as content
  const nearUI = (i, j) => { for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const ni = i + di, nj = j + dj;
    if (ni >= 0 && nj >= 0 && ni < FIT_GX && nj < FIT_GY && !cells[nj * FIT_GX + ni]) return true; } return false; };
  for (let j = 0; j < FIT_GY; j++) for (let i = 0; i < FIT_GX; i++) {
    if (!cells[j * FIT_GX + i]) continue;
    if (nearUI(i, j)) continue;
    let n = 0, k = 0;
    for (let y = Math.floor(j * ch); y < Math.floor((j + 1) * ch); y++) for (let x = Math.floor(i * cw); x < Math.floor((i + 1) * cw); x++) { k++; if (Math.abs(g[y * w + x] - bg) > 14) n++; }
    content[j * FIT_GX + i] = n / Math.max(1, k) >= 0.15 ? 1 : 0;
  }
  // the usable canvas area: trim edge rows/cols that are mostly app UI (header, prompt bar)
  const rowShare = (j) => { let n = 0; for (let i = 0; i < FIT_GX; i++) n += cells[j * FIT_GX + i]; return n / FIT_GX; };
  const colShare = (i) => { let n = 0; for (let j = 0; j < FIT_GY; j++) n += cells[j * FIT_GX + i]; return n / FIT_GY; };
  let r0 = 0, r1 = FIT_GY - 1, c0 = 0, c1 = FIT_GX - 1;
  while (r0 < r1 && rowShare(r0) < 0.9) r0++;
  while (r1 > r0 && rowShare(r1) < 0.9) r1--;
  while (c0 < c1 && colShare(c0) < 0.9) c0++;
  while (c1 > c0 && colShare(c1) < 0.9) c1--;
  // clusters: content cells joined across gaps of ≤ 2 cells (a design's own white space)
  const lab = new Int32Array(FIT_GX * FIT_GY).fill(-1), comps = [];
  for (let s0 = 0; s0 < content.length; s0++) {
    if (!content[s0] || lab[s0] >= 0) continue;
    const q = [s0], c = { n: 0, i0: 1e9, i1: -1, j0: 1e9, j1: -1 };
    lab[s0] = comps.length;
    while (q.length) {
      const v = q.pop(), vi = v % FIT_GX, vj = (v / FIT_GX) | 0;
      c.n++; c.i0 = Math.min(c.i0, vi); c.i1 = Math.max(c.i1, vi); c.j0 = Math.min(c.j0, vj); c.j1 = Math.max(c.j1, vj);
      for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
        const ni = vi + di, nj = vj + dj;
        if (ni < 0 || nj < 0 || ni >= FIT_GX || nj >= FIT_GY) continue;
        const u = nj * FIT_GX + ni;
        if (content[u] && lab[u] < 0) { lab[u] = comps.length; q.push(u); }
      }
    }
    comps.push(c);
  }
  const big = comps.filter((c) => c.n >= 6).sort((a, b) => b.n - a.n);
  if (!big.length) return { empty: true };                          // a canvas, but nothing drawn on it (yet)
  // the main group: the biggest cluster, plus any other that keeps the framing dense (a far-off
  // design would only shrink the ones he talks about)
  let grp = { ...big[0] };
  for (const c of big.slice(1)) {
    const m = { n: grp.n + c.n, i0: Math.min(grp.i0, c.i0), i1: Math.max(grp.i1, c.i1), j0: Math.min(grp.j0, c.j0), j1: Math.max(grp.j1, c.j1) };
    if (m.n / ((m.i1 - m.i0 + 1) * (m.j1 - m.j0 + 1)) >= 0.3) grp = m;
  }
  const cx = CSS_W / FIT_GX, cy = CSS_H / FIT_GY;
  const U = { x: c0 * cx, y: r0 * cy, w: (c1 - c0 + 1) * cx, h: (r1 - r0 + 1) * cy };
  const T = { x: grp.i0 * cx, y: grp.j0 * cy, w: (grp.i1 - grp.i0 + 1) * cx, h: (grp.j1 - grp.j0 + 1) * cy };
  const clipped = { l: grp.i0 <= c0, r: grp.i1 >= c1, t: grp.j0 <= r0, b: grp.j1 >= r1 };
  const b0 = big[0];
  const main = { x: b0.i0 * cx, y: b0.j0 * cy, w: (b0.i1 - b0.i0 + 1) * cx, h: (b0.j1 - b0.j0 + 1) * cy,
    clipped: b0.i0 <= c0 || b0.i1 >= c1 || b0.j0 <= r0 || b0.j1 >= r1 };
  fitTrace.push([T.x, T.y, T.w, T.h].map((v) => Math.round(v / SHOT_F)).join(",") + (Object.values(clipped).some(Boolean) ? " clip" : "") + ` g${big.length}`);
  const others = big.slice(1, 12).map((c) => ({ x: c.i0 * cx, y: c.j0 * cy, w: (c.i1 - c.i0 + 1) * cx, h: (c.j1 - c.j0 + 1) * cy,
    clipped: c.i0 <= c0 || c.i1 >= c1 || c.j0 <= r0 || c.j1 >= r1 }));
  return { U, T, main, others, clipped, fill: Math.min(T.w / U.w, T.h / U.h) > 0 ? Math.max(T.w / U.w, T.h / U.h) : 0, groups: big.length };
}
async function zoomReadout() {
  // design tools show their zoom as "24%" somewhere in the chrome (Linearity, Figma, Canva)
  return page.evaluate(() => {
    for (const e of document.querySelectorAll("body *")) {
      if (e.children.length) continue;
      const t = (e.innerText || e.value || "").trim();
      if (/^\d{1,4}(\.\d+)?\s*%$/.test(t)) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return parseFloat(t); }
    }
    for (const e of document.querySelectorAll("input")) { const t = (e.value || "").trim(); if (/^\d{1,4}(\.\d+)?\s*%$/.test(t)) return parseFloat(t); }
    return null;
  }).catch(() => null);
}
async function fitDesigns(target = 0.78) {
  const steps = [];
  fitTrace = [];
  let m = await measureDesigns();
  // a document opened by a click: its canvas exists before the designs are drawn (2026-10-06
  // seg-02: the settle cut ended on an empty canvas and the fit gave up) — wait for them
  for (let k = 0; k < 6 && m && m.empty; k++) { await sleep(2500); m = await measureDesigns(); }
  if (m && m.empty) return { ok: false, error: "the canvas never showed any designs" };
  if (!m) {
    const why = await page.evaluate(() => {
      const cs = [...document.querySelectorAll("canvas")].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      const se = document.scrollingElement || document.documentElement;
      return { canvases: cs.slice(0, 5), centre: el ? `${el.tagName}.${String(el.className).slice(0, 40)}` : null, scrollH: se.scrollHeight, vh: innerHeight };
    }).catch(() => null);
    return { ok: false, error: "no design canvas on screen", why };
  }
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
  const clippedAny = (q) => q.clipped.l || q.clipped.r || q.clipped.t || q.clipped.b;
  let units = 86;                                                  // ctrl-wheel units per 2× (Linearity: 80 ≈ 2×)
  // 1. see the whole group. Clusters are measured in screen cells, so a ZOOM changes which
  //    designs join up (at 10 % the far-off Story merged into the group and the fit came out
  //    small, 2026-10-06): a group cut by ONE edge (the header over the top row) is PANNED into
  //    view at the same scale; only a group cut on opposite sides zooms out.
  const revealed = [];
  for (let k = 0; k < 4 && clippedAny(m); k++) {
    const c = m.clipped;
    // a reveal that undoes the previous one (top then bottom) = the group is taller/wider than the
    // area at this scale: zoom out instead of oscillating
    const flip = revealed.length && ((revealed.at(-1) === "t" && c.b) || (revealed.at(-1) === "b" && c.t) || (revealed.at(-1) === "l" && c.r) || (revealed.at(-1) === "r" && c.l));
    revealed.push(c.t ? "t" : c.b ? "b" : c.l ? "l" : "r");
    if ((c.l && c.r) || (c.t && c.b) || flip) {
      await wheelZoom(...centre(m.U), -0.8, units);
      steps.push("out");
    } else {
      // plain wheel: +deltaY moves the content UP (Linearity ≈ SCALE css px per unit)
      const dx = c.l ? -0.25 * m.U.w : c.r ? 0.25 * m.U.w : 0, dy = c.t ? -0.25 * m.U.h : c.b ? 0.25 * m.U.h : 0;
      await page.mouse.move(...centre(m.U));
      await page.mouse.wheel({ deltaX: dx / SCALE, deltaY: dy / SCALE });
      await sleep(900);
      steps.push(`reveal ${Math.round(dx)},${Math.round(dy)}`);
    }
    const m2 = await measureDesigns();
    if (!m2) break;
    m = m2;
  }
  if (clippedAny(m)) return { ok: false, error: "the designs never fit on screen", steps, trace: fitTrace };
  // 2. the group is fixed NOW (all of it on screen) and followed ANALYTICALLY from here: the
  //    clusters re-measured after a zoom split/merge with the scale (designs' gaps grow), so
  //    re-choosing the group each step made the pans oscillate (2026-10-06 probes)
  let G = { ...m.T };
  const U = m.U;
  const z = Math.max(0.5, Math.min(6, target * Math.min(U.w / G.w, U.h / G.h)));
  if (Math.abs(Math.log2(z)) >= 0.12) {
    // zoom about Q so the group's centre C lands on the area's centre M: X → Q + f(X − Q)
    const [cx0, cy0] = centre(G), [mx, my] = centre(U);
    let qx = Math.abs(z - 1) > 0.05 ? (mx - z * cx0) / (1 - z) : cx0, qy = Math.abs(z - 1) > 0.05 ? (my - z * cy0) / (1 - z) : cy0;
    qx = Math.max(U.x + 0.05 * U.w, Math.min(U.x + 0.95 * U.w, qx));
    qy = Math.max(U.y + 0.05 * U.h, Math.min(U.y + 0.95 * U.h, qy));
    for (let k = 0; k < 2; k++) {
      const want = k === 0 ? z : z / (G.w / m.T.w);
      if (k > 0 && Math.abs(Math.log2(want)) < 0.1) break;
      const z0 = await zoomReadout();
      await wheelZoom(qx, qy, Math.log2(want), units);
      const z1 = await zoomReadout();
      const f = z0 && z1 ? z1 / z0 : Math.pow(2, Math.log2(want));          // no readout: trust the calibration
      if (z0 && z1 && Math.abs(Math.log2(want)) > 0.3) units = Math.max(30, Math.min(300, units * Math.log2(want) / Math.log2(Math.max(f, 1.0001))));
      G = { x: qx + f * (G.x - qx), y: qy + f * (G.y - qy), w: G.w * f, h: G.h * f };
      steps.push(`zoom ${want.toFixed(2)}× → ${f.toFixed(2)}× (${z0}%→${z1}%)`);
      if (Math.abs(f - 1) < 0.03) break;                                     // this canvas does not zoom
      qx = centre(G)[0]; qy = centre(G)[1];
    }
  }
  // 3. centre it with plain wheel pans (same scale before/after = the clusters can be matched)
  let gain = 1 / SCALE;
  for (let k = 0; k < 3; k++) {
    const [gx, gy] = centre(G), [mx, my] = centre(U);
    const off = [gx - mx, gy - my];
    if (Math.abs(off[0]) < 0.03 * U.w && Math.abs(off[1]) < 0.03 * U.h) break;
    const a = await measureDesigns();
    await page.mouse.move(mx, my);
    await page.mouse.wheel({ deltaX: gain * off[0], deltaY: gain * off[1] });
    await sleep(900);
    const b = await measureDesigns();
    steps.push(`pan ${Math.round(gain * off[0])},${Math.round(gain * off[1])}`);
    // the content's real displacement: the same unclipped design cluster before and after
    let mv = null;
    if (a && b && !a.main.clipped) {
      const hit = [b.main, ...(b.others || [])].find((c) => Math.abs(c.w - a.main.w) < 0.1 * a.main.w && Math.abs(c.h - a.main.h) < 0.1 * a.main.h && !c.clipped);
      if (hit) mv = [hit.x - a.main.x, hit.y - a.main.y];
    }
    if (!mv) mv = [-off[0], -off[1]];                                       // assume it went where asked
    if (Math.abs(mv[0]) + Math.abs(mv[1]) < 2) { steps.push("the wheel does not pan here"); break; }
    G = { ...G, x: G.x + mv[0], y: G.y + mv[1] };
    const ax = Math.abs(off[0]) > Math.abs(off[1]) ? 0 : 1;
    if (Math.abs(mv[ax]) > 8) gain = Math.max(-3, Math.min(3, gain * -off[ax] / mv[ax]));
  }
  await page.mouse.move(cx, cy).catch(() => {});
  fittedUrl = page.url();
  fitArea = U; panGain = gain;
  const fill = Math.max(G.w / U.w, G.h / U.h);
  return { ok: true, steps, trace: fitTrace, fill: +fill.toFixed(2), box: [G.x, G.y, G.w, G.h].map((v) => Math.round(v / SHOT_F)) };
}
async function wheelZoom(x, y, log2z, unitsPer2x) {
  await page.mouse.move(x, y);
  let total = -log2z * unitsPer2x;                                // negative deltaY = in
  await page.keyboard.down("Control");
  while (Math.abs(total) > 1) { const d = Math.sign(total) * Math.min(80, Math.abs(total)); await page.mouse.wheel({ deltaY: d }); total -= d; await sleep(120); }
  await page.keyboard.up("Control");
  await sleep(900);
}
// round 3 (review N10): page-clock ticks that record NO frame — a re-pan inside a cut used recorded 0.1 s holds,
// so the cut landed mis-framed for 3 frames and jumped again when the correction glide finished
async function tick(n) { for (let j = 0; j < n; j++) await step(true); }
async function holdUntil(sec) { while (rec && t() < sec - 1e-6) await step(); }
async function hold(s) { const n = Math.round(s * FPS); for (let i = 0; i < n; i++) await step(); }
// the clip second of the WORD the agent tied this action to: the camera starts its zoom on it
// (Jake #11 — "zoom to the login button only when he says it")
let curAt = null, curMeta = {};
function log(type, extra = {}) {
  const e = { t: t(), type, ...extra };
  if (curAt != null && ["click", "dblclick", "read", "highlight", "hover", "move", "type", "drag", "draw", "upload", "key"].includes(type)) { e.at = curAt; Object.assign(e, curMeta); }
  if (rec) rec.events.push(e);
  return e;
}

async function load(url, settle = 2.5) {
  await realtime();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await sleep(settle * 1000);
  // a heavy app keeps drawing after domcontentloaded: wait (real time, unrecorded) until the
  // screen is stable and not blank, so the first recorded frame of the new page is the page
  try {
    let prev = await tiny(), calm = 0; const t0 = Date.now();
    while (Date.now() - t0 < SETTLE.max && calm < SETTLE.stable) {
      await sleep(SETTLE.poll);
      const cur = await tiny();
      calm = changedShare(prev, cur) < 0.005 && !blankish(cur) ? calm + 1 : 0;
      prev = cur;
    }
  } catch {}
  let fr = await autoFit("load");
  // a heavy editor draws its canvas only seconds after the page is "stable" (loop round 1: the
  // campaign document came back "no design canvas" once; v12 0:17 / 1:19 showed the whole canvas at
  // 17 % for the same reason) — a document address gets up to 4 more tries, still off camera
  for (let k = 0; k < 4 && !fr && /\/(file|design|doc|edit)\//.test(page.url()) && lastFit && /no design canvas|never showed/.test(lastFit.error || ""); k++) {
    await sleep(3000);
    fr = await autoFit("load-retry");
  }
  if (rec) await pause();         // off camera the page keeps real time (a WebGL editor needs it to load)
  else await noteAccount();       // off camera: read the account name before set-dressing hides it
}

async function moveTo(x, y) {
  const d = Math.hypot(x - cx, y - cy);
  if (d < 1) return;
  // round 2: a beat in a fast chain may ask for a quicker travel ("travel_ms") so its press stays on the word
  const dur = (travelMs ?? Math.min(1100, 280 + 160 * Math.log2(1 + d / 40))) / 1000;
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
    const sel = "p,a,button,[role=button],[role=menuitem],[role=option],[role=tab],[role=checkbox],[role=switch],input,textarea,select,[contenteditable=true],h1,h2,h3,h4,label,li,img,[draggable=true]";
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
    cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: await vclip(1 / SHOT_F) }),
    new Promise((_, rej) => { timer = setTimeout(() => { crashed = true; rej(new Error("screenshot timed out — the page was reopened; observe again")); }, 180000); }),
  ]).finally(() => clearTimeout(timer));
  fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
  // mean luminance 0-255 of the screen (pre-production readiness: dark theme check)
  let lum = null;
  try { const g = await tiny(); let sum = 0; for (const v of g) sum += v; lum = Math.round(sum / g.length * 10) / 10; } catch {}
  // GUARD: a bot check / login wall is never recorded — reported to agentrec.py, which drops the segment
  const w = await wall(page);
  if (w && rec) { rec.walls = rec.walls || []; rec.walls.push({ t: t(), ...w }); }
  return { t: t(), ...info, shot, lum, f: SHOT_F, cursor: [Math.round(cx / SHOT_F), Math.round(cy / SHOT_F)], wall: w };
}

async function boxOf(ref, tight = false) {
  return page.evaluate((ref, tight) => {
    const el = document.querySelector(`[data-agent-ref="${ref}"]`);
    if (!el) return null;
    let r = el.getBoundingClientRect();
    if (tight && el.innerText && el.innerText.trim()) {
      // a READ of text frames the words, not the block: a full-width <p> holding one short line
      // ("250 introductory credits … No credit card required") was a 2100-px box = no zoom (v10)
      const rg = document.createRange();
      rg.selectNodeContents(el);
      const t = rg.getBoundingClientRect();
      if (t.width > 4 && t.height > 4 && t.width * t.height < r.width * r.height * 0.8) r = t;
    }
    const a = el.closest("a");
    // a stable selector for the compiled beat script (G3: a rehearsal resolves every target once)
    const cl = el.closest("button,a,[role=button],[role=menuitem],[role=option],[role=tab],input,textarea,[contenteditable=true]") || el;
    const tid = cl.getAttribute("data-testid"), al = cl.getAttribute("aria-label");
    const hint = tid ? `[data-testid="${tid}"]` : al ? `${cl.tagName.toLowerCase()}[aria-label="${al.replace(/"/g, '\\"')}"]`
      : cl.isContentEditable ? '[contenteditable="true"]' : null;
    return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName.toLowerCase(),
             text: (el.innerText || "").trim().slice(0, 80), href: a ? a.href : null, blank: a ? a.target === "_blank" : false,
             hint, label: (al || el.innerText || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 80) };
  }, ref, tight);
}

// Jake #1 (subject centre-middle): a design he names on a FITTED canvas is glided to the middle
// of the canvas area by a visible wheel pan (~0.9 s, eased) — the camera then frames it centred
// instead of clamping at the canvas edge. Returns the target's box after the pan.
let lastMoved = null, travelMs = null;
async function centreOnCanvas(b, late = false, force = false) {
  if (!b || !fitArea || !panGain || page.url() !== fittedUrl || !["region", "point"].includes(b.tag)) return b;
  if (!force && (b.width > fitArea.w * 0.9 || b.height > fitArea.h * 0.9)) return b;
  // force (a centre cut): the middle of the CAPTURE — the frame centre the camera lands on — not the
  // canvas area's middle (header / tool rail made it 0.05–0.08 off, round 2 QA)
  const mx = force ? CSS_W / 2 : fitArea.x + fitArea.w / 2, my = force ? CSS_H / 2 : fitArea.y + fitArea.h / 2;
  const off = [b.x + b.width / 2 - mx, b.y + b.height / 2 - my];
  if (Math.abs(off[0]) < 0.06 * CSS_W && Math.abs(off[1]) < 0.06 * CSS_H) return b;
  const e = log("pan", { by: off.map((v) => Math.round(v * SCALE)) });
  await page.mouse.move(mx, my).catch(() => {});            // the wheel acts at the pointer; the drawn cursor stays
  // the wheel's gain differs per axis and per zoom (v12a: x overshot ~30 %, y barely moved), so the
  // REAL displacement is measured on screen (grey thumbnails, best shift) and the box follows it;
  // one smaller correction glide fixes what is left (per-axis gain re-estimated)
  const glide = async (dx, dy, secs, gx, gy) => {
    const n = Math.max(6, Math.round(secs * FPS));
    let prev = 0;
    for (let i = 1; i <= n; i++) {
      const u = i / n, ez = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2, d = ez - prev;
      prev = ez;
      await page.mouse.wheel({ deltaX: gx * dx * d, deltaY: gy * dy * d }).catch(() => {});
      if (rec) await step(late); else await sleep(30);
    }
  };
  let gx = panGain, gy = panGain, moved = [0, 0];
  // a beat that can no longer land on its word with a visible glide CUTS to it (review v12 #2:
  // "if a beat cannot land within ~0.3 s of its word, cut to it"; TECHNIQUES CUT06 lands framed)
  if (late) { e.late = true; log("cut", { why: "late beat", big: true }); }
  let before = await grey10();
  await glide(off[0], off[1], 0.9, gx, gy);
  if (rec) await (late ? tick(3) : hold(0.1)); else await sleep(300);
  let after = await grey10();
  let sh = before && after ? bestShift(before, after, [-off[0] / 10, -off[1] / 10]) : null;
  if (sh) {
    moved = [sh[0] * 10, sh[1] * 10];                         // content displacement, css px
    const left = [off[0] + moved[0], off[1] + moved[1]];      // still to go (content must move by −off)
    if (Math.abs(left[0]) > 0.05 * CSS_W || Math.abs(left[1]) > 0.05 * CSS_H) {
      if (Math.abs(moved[0]) > 8) gx = Math.max(-4, Math.min(4, gx * -off[0] / moved[0]));
      if (Math.abs(moved[1]) > 8) gy = Math.max(-4, Math.min(4, gy * -off[1] / moved[1]));
      before = after;
      await glide(left[0], left[1], 0.6, gx, gy);
      if (rec) await (late ? tick(3) : hold(0.1)); else await sleep(300);
      after = await grey10();
      const sh2 = before && after ? bestShift(before, after, [-left[0] / 10, -left[1] / 10]) : null;
      if (sh2) moved = [moved[0] + sh2[0] * 10, moved[1] + sh2[1] * 10];
    }
  } else moved = [-off[0], -off[1]];
  if (rec) await (late ? tick(3) : hold(0.1)); else await sleep(200);
  await page.mouse.move(cx, cy).catch(() => {});
  e.end = t();
  e.moved = moved.map((v) => Math.round(v * SCALE));
  lastMoved = moved;
  if (late && fitArea) await page.mouse.move(fitArea.x + 6, fitArea.y + fitArea.h - 6).catch(() => {});   // no hover ring on a design
  return { ...b, x: b.x + moved[0], y: b.y + moved[1], at: b.at ? [b.at[0] + moved[0], b.at[1] + moved[1]] : b.at };
}
async function grey10() {
  try {
    const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: await vclip(0.1) });
    return pngGray(Buffer.from(s.data, "base64"));
  } catch { return null; }
}
function bestShift(A, B, expect = [0, 0]) {
  // the (dx, dy) in thumbnail px that best maps A onto B (B(x+dx, y+dy) ≈ A(x, y)), central region,
  // searched AROUND the expected shift (an unconstrained search matched the dot grid: v12 probe)
  const w = Math.min(A.w, B.w), h = Math.min(A.h, B.h);
  const ex = Math.round(expect[0]), ey = Math.round(expect[1]);
  const RX = Math.max(6, Math.round(Math.abs(ex) * 0.7)), RY = Math.max(6, Math.round(Math.abs(ey) * 0.7) + 4);
  let best = null, bs = Infinity;
  const x0 = Math.round(w * 0.1), x1 = Math.round(w * 0.9), y0 = Math.round(h * 0.15), y1 = Math.round(h * 0.85);
  for (let dy = ey - RY; dy <= ey + RY; dy++) for (let dx = ex - RX; dx <= ex + RX; dx++) {
    let sad = 0, n = 0;
    for (let y = y0; y < y1; y += 2) {
      const yb = y + dy; if (yb < 0 || yb >= h) continue;
      for (let x = x0; x < x1; x += 2) {
        const xb = x + dx; if (xb < 0 || xb >= w) continue;
        sad += Math.abs(A.g[y * A.w + x] - B.g[yb * B.w + xb]); n++;
      }
    }
    if (n > 200 && sad / n < bs) { bs = sad / n; best = [dx, dy]; }
  }
  return best;
}

// QA (loop round 1, review v12 root cause 6: "QA scores geometry, never whether the thing he names is
// on screen"): every acted-on beat records what the viewer can READ there — the page title + url and
// the DOM text inside the framed box — so qa_content.py can check brand / named subject / garbled text
async function seen(b) {
  try {
    const r = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    const txt = await page.evaluate((r) => {
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.children.length && !["P", "H1", "H2", "H3", "BUTTON", "A", "LABEL", "LI", "SPAN"].includes(el.tagName)) continue;
        const q = el.getBoundingClientRect();
        if (q.width < 2 || q.height < 2 || q.bottom < 0 || q.top > innerHeight) continue;
        const cx = q.x + q.width / 2, cy = q.y + q.height / 2;
        if (r && (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h)) continue;
        const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.alt || "").trim().replace(/\s+/g, " ");
        if (t && !out.includes(t)) out.push(t.slice(0, 80));
        if (out.length > 40) break;
      }
      return out.join(" | ").slice(0, 600);
    }, r);
    return { title: await page.title(), url: page.url(), vis: txt };
  } catch { return {}; }
}
// round 2 (review D18): a long cursor travel (up to 1.1 s + 0.12 s settle) made presses 0.35 s late with a
// 0.75 s lead — the press itself still waits for its word (holdUntil(at) before mouse.click)
const LEAD = { click: 1.25, dblclick: 0.8, move: 0.6, hover: 0.6, type: 0.3, drag: 0.9, draw: 0.9 };
// LOOP ROUND 1 (review v12 #2/#5/#16/#27: beats 1–3 s late, some dropped): a READ used to hold its
// whole "ms" before returning, so every later beat started after it — chained lateness. A read now
// returns at once and its hold is DEFERRED: the next action with an "at" simply waits for its own
// word (cutting the read short), one without "at" first finishes the read's hold.
let openRead = null;
// the element an action would hit, for the guard (shot px × SHOT_F = CSS px for a canvas spot)
async function guard(a) {
  const ty = String(a.type || "");
  let q = null;
  if (["click", "dblclick"].includes(ty)) q = a.ref ? { ref: a.ref } : a.x != null ? { x: a.x * SHOT_F, y: a.y * SHOT_F }
    : a.selector ? { selector: a.selector, ...(a.nth != null ? { nth: a.nth } : {}) } : null;
  else if (ty === "drag") { const p0 = Array.isArray(a.drag_from) ? a.drag_from : a.from; if (Array.isArray(p0)) q = { x: p0[0] * SHOT_F, y: p0[1] * SHOT_F }; }
  else if (ty === "key") q = { focused: true };
  else if (ty === "type") q = a.ref ? { ref: a.ref } : a.selector ? { selector: a.selector } : { focused: true };
  const target = q ? await page.evaluate(describeInPage, q).catch(() => null) : null;
  // p7: a drag is a press where it starts; a K2 reveal is a navigation to the asset's page; an upload / draw
  // presses nothing a deny rule names (their files / strokes come from assets.json)
  const ga = ty === "drag" ? { ...a, type: "click" } : ty === "reveal" ? { type: "goto", url: a.url } : a;
  const g = guardCheck(ga, target, SESSION);
  if (!g.ok) {
    process.stderr.write(`clickguard: refused ${JSON.stringify(a).slice(0, 200)} — ${g.why}\n`);
    if (rec) rec.events.push({ t: t(), type: "refused", rule: g.refused, why: g.why });
  }
  return g;
}
const MAX_STILL = 3.0;          // seconds: no recorded still longer (G3 spec 2; BASELINE no still > 3 s)
async function act(a) {
  const g = await guard(a);
  // a refusal is a BEAT FAILURE — the caller must not retry the same action
  if (!g.ok) return { ok: false, refused: g.refused, error: `refused by the click guard: ${g.why}` };
  if (openRead) {
    if (a.at == null && rec) await holdUntil(openRead.until);
    openRead.e.end = Math.max(openRead.e.t + 0.1, Math.min(t(), openRead.until, a.at != null ? Math.max(t(), a.at - 0.05) : 1e9));
    if (a.at != null && rec && a.at - 0.05 > t()) openRead.e.end = Math.min(openRead.until, a.at - 0.05);
    openRead = null;
  }
  // beat metadata the camera reads (a scripted beat list): explicit zoom, the sentence start the
  // move may not begin before ("from"), "beat" = a word-timed beat that must not be dropped
  curMeta = {};
  for (const k of ["zoom", "from", "beat", "land", "deep", "solo", "punch", "frames", "ledger", "word_t", "live", "beat_id", "word", "cursor_at"]) if (a[k] != null) curMeta[k] = a[k];
  // a page scroll ENDS on its word (0.4 s per ~200 px chunk): the thing he names is on screen as
  // he names it — v10 pricing: a scroll that STARTED on "free" showed the Free card 1.6 s late
  const scrollLead = a.type === "scroll" && !a.zoom ? 0.4 * Math.max(1, Math.round(Math.abs(a.by || 0) / 200)) : 0;
  const startAt = a.at != null ? a.at - (a.travel_ms != null && LEAD[a.type] != null ? a.travel_ms / 1000 + (a.settle_s ?? 0.12) : (LEAD[a.type] ?? scrollLead)) : null;
  // non-pointer actions wait here; pointer actions wait after their target is found (an off-screen
  // target is scrolled to first, and that scroll must END by the word, not start on it)
  const pointer = ["click", "dblclick", "hover", "move", "read", "highlight"].includes(a.type) && a.ref;
  if (startAt != null && rec && !pointer) await holdUntil(Math.max(t(), startAt));
  // tolerant targets: a ref, else the visible element whose text contains `text`/`target`,
  // else coordinates (x,y | to:[x,y] | xy:[x,y]) — the agent uses all three
  const need = ["click", "dblclick", "hover", "move", "read", "highlight"].includes(a.type) || (a.type === "type" && (a.ref || a.target));
  if (a.type === "key" && !a.key) a.key = a.text;
  let b = null;
  if (need) {
    if (a.ref) b = await boxOf(a.ref, a.type === "read" || a.type === "highlight");
    // a target off screen is SCROLLED to (visibly, wheel flicks, logged) so it sits mid-screen —
    // a silent scrollIntoView jumped the page and left the Free plan line on the bottom edge (v10)
    // right after a goto/cut (Jake #7: landing → CUT to the zoomed Free card) the page is put in
    // place INSIDE the cut — no visible scroll; the camera lands framed on the target
    if (b && (b.y < 0 || b.y + b.height > CSS_H) && rec && lastNavT != null && t() - lastNavT < 0.8) {
      await page.evaluate((ref) => document.querySelector(`[data-agent-ref="${ref}"]`)?.scrollIntoView({ block: "center" }), a.ref).catch(() => {});
      await sleep(400);
      b = await boxOf(a.ref, a.type === "read" || a.type === "highlight");
    }
    // Jake #9 (v11 1:13, v12b): a block that is already mostly on screen is READ where it is — no
    // scroll; the camera frames its visible part
    if (b && (b.y < 0 || b.y + b.height > CSS_H)) {
      const vis = Math.min(CSS_H, b.y + b.height) - Math.max(0, b.y);
      if (vis >= Math.min(b.height * 0.5, CSS_H * 0.3) && b.y < CSS_H * 0.85) {
        const y0 = Math.max(0, b.y), y1 = Math.min(CSS_H, b.y + b.height);
        b = { ...b, y: y0, height: y1 - y0 };
      }
    }
    if (b && (b.y < 0 || b.y + b.height > CSS_H)) {
      const want = Math.round(b.y + b.height / 2 - CSS_H * 0.45);
      const before = await page.evaluate(() => [scrollX, scrollY]).catch(() => [0, 0]);
      const e = log("scroll", { by: want });
      const n = Math.max(1, Math.round(Math.abs(want) / 200));
      if (startAt != null && rec) await holdUntil(Math.max(t(), startAt - 0.4 * n));
      e.t = t();
      await page.mouse.move(cx, cy).catch(() => {});
      for (let k = 0; k < n; k++) { await page.mouse.wheel({ deltaY: want / n }); if (rec) await hold(0.4); else await sleep(150); }
      const after = await page.evaluate(() => [scrollX, scrollY]).catch(() => [0, 0]);
      if (after[1] === before[1]) await page.evaluate((ref) => document.querySelector(`[data-agent-ref="${ref}"]`)?.scrollIntoView({ block: "center" }), a.ref).catch(() => {});
      e.end = t();
      b = await boxOf(a.ref, a.type === "read" || a.type === "highlight");
    }
    const fromLabelOrSelector = async () => {
      const label = a.target || (a.type !== "type" ? a.text : null);
      let b = null;
      if (label) b = await page.evaluate((txt, only) => {
        const want = String(txt).toLowerCase().replace(/\s+/g, " ").trim();
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight; };
        // whitespace folded: ChatGPT's Resize menu item reads "Square\n1:1" (the playbook says "Square 1:1")
        const lab = (e) => (e.innerText || e.getAttribute("aria-label") || "").toLowerCase().replace(/\s+/g, " ").trim();
        const hits = [...document.querySelectorAll("body *")].filter((e) => vis(e) && lab(e).includes(want));
        // an EXACT label beats a containing one: "Chat" is the Chat/Work switch, not the "ChatGPT" logo
        // (playbook proving run 2026-10-09: chat_mode clicked the logo and Work mode stayed on)
        const exact = hits.filter((e) => lab(e) === want);
        // "exact": the WHOLE label or nothing — on a chat page there is no Chat/Work switch, and a containing
        // match for "Chat" was "New chat" (it navigated away from the chat)
        const pool = exact.length ? exact : only ? [] : hits;
        const el = pool.find((e) => !pool.some((o) => o !== e && e.contains(o)));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 80), href: null, blank: false };
      }, label, !!a.exact).catch(() => null);
      // pre-production / set dressing: a CSS selector (an icon button without text, e.g. "Remove <file>")
      // ("nth": the n-th match in DOCUMENT order, scrolled into view first — e.g. the 1st generated image of a chat)
      if (!b && a.selector) {
        const els = await page.$$(a.selector).catch(() => []);
        // without "nth" the first VISIBLE match: ChatGPT keeps a second, hidden button[aria-label="Hide sidebar"]
        // FIRST in the document — its box was clicked, nothing happened, and the sidebar with the old chats stayed
        // (playbook proving run 2026-10-09)
        let el = a.nth != null ? els[a.nth] : null;
        if (a.nth == null) {
          for (const e of els) {
            if (await e.evaluate((x) => { const r = x.getBoundingClientRect(), s = getComputedStyle(x);
              return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
                && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05; }).catch(() => false)) { el = e; break; }
          }
          el ??= els[0];
        }
        if (el) {
          if (a.nth != null) { await el.evaluate((e) => e.scrollIntoView({ block: "center" })).catch(() => {}); await sleep(400); }
          b = await el.evaluate((e) => { const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, tag: e.tagName.toLowerCase(), text: "", href: null, blank: false }; }).catch(() => null);
        }
      }
      return b;
    };
    if (!b && (a.target || a.text || a.selector)) {
      b = await fromLabelOrSelector();
      // a target that is still MOVING (the image viewer's toolbar slides in) is measured again until it holds
      // still: a press on the first box hit the empty place it was leaving (proving run 2026-10-09, Markup 1/3)
      for (let k = 0; b && k < 12; k++) {
        await sleep(120);
        const b2 = await fromLabelOrSelector();
        if (!b2) break;
        const still = Math.abs(b2.x - b.x) < 1 && Math.abs(b2.y - b.y) < 1 && Math.abs(b2.width - b.width) < 1 && Math.abs(b2.height - b.height) < 1;
        b = b2;
        if (still) break;
      }
    }
    // coordinates come in SCREENSHOT pixels (the agent sees a 1280×720 shot of the 1920×1080 page)
    const raw = a.to || a.xy || (a.x != null && a.y != null ? [a.x, a.y] : null);
    const xy = raw ? [raw[0] * SHOT_F, raw[1] * SHOT_F] : null;
    // a spot on a canvas may carry "box" (screenshot px) = the whole design it belongs to:
    // the camera frames that, the cursor still goes to the spot
    const ab = Array.isArray(a.box) && a.box.length === 4 && a.box.every((v) => Number.isFinite(v)) ? a.box.map((v) => v * SHOT_F) : null;
    if (!b && ab && ab[2] > 4 && ab[3] > 4) b = { x: ab[0], y: ab[1], width: ab[2], height: ab[3], tag: "region", text: "", href: null, blank: false, at: xy };
    if (!b && xy) b = { x: xy[0] - 1, y: xy[1] - 1, width: 2, height: 2, tag: "point", text: "", href: null, blank: false };
  }
  curAt = a.at != null ? +a.at : null;
  // "frame" (screenshot px): what the CAMERA frames for this action when it is not the element itself
  // (the button + the menu it opens, the post + its toolbar) — the cursor still acts on the element
  let fb = Array.isArray(a.frame) && a.frame.length === 4 ? { x: a.frame[0] * SHOT_F, y: a.frame[1] * SHOT_F, width: a.frame[2] * SHOT_F, height: a.frame[3] * SHOT_F } : null;
  lastMoved = null;
  travelMs = a.travel_ms ?? null;
  if (rec && Array.isArray(a.pre_keys) && a.pre_keys.length) {
    // round 3 (review N10): menus/edit modes are closed INSIDE the cut of this beat (silent keys, no frames) —
    // a recorded Escape showed the parent Resize menu for 2 f and bare canvas for 4 f before the cut
    const clicky0 = a.type === "click" || a.type === "dblclick";
    // (with a quick travel the keys go just before IT — a LEAD-based time closed the font list / picker the
    // moment they opened, round 3 frames 88.4 / 89.2)
    const lead0 = clicky0 ? (a.travel_ms != null ? a.travel_ms / 1000 + 0.15 : (LEAD[a.type] ?? 0) + 0.2) : 0.1;
    if (a.at != null) await holdUntil(Math.max(t(), a.at - lead0));
    for (const k of a.pre_keys) { await pressCombo(k); await tick(4); }
    if (Array.isArray(a.pre_poke)) {
      // round 3 (review N03e): a silent click on blank canvas deselects (Escape alone leaves the headline
      // selected, so the logo click never selected the logo) — the real pointer only, the drawn cursor stays
      await page.mouse.click(a.pre_poke[0] * SHOT_F, a.pre_poke[1] * SHOT_F).catch(() => {}); await tick(6);
      await page.mouse.move(cx, cy).catch(() => {});
    }
    if (!a.center) log("cut", { why: "keys", big: !!a.pre_keys_big });
  }
  if (rec && a.center === "cut" && b) {
    // ROUND 2 (review round 1 D1/D3/D4): a canvas target is brought to the MIDDLE of the capture by a
    // canvas pan done INSIDE a cut (silent frames) — the camera then lands framed and centred on it
    // (TECHNIQUES CUT06 "cut that lands already framed"; CUT03 cut chain for items 0.7–1.5 s apart).
    // The artboards sat at the capture's left edge, so every ×1.4 framing clamped at x ≈ 27 %.
    const clicky = a.type === "click" || a.type === "dblclick";
    if (a.at != null) await holdUntil(Math.max(t(), a.at - (clicky ? (a.travel_ms != null ? a.travel_ms / 1000 + 0.15 : (LEAD[a.type] ?? 0) + 0.15) : 0.05)));
    const b0 = b;
    b = await centreOnCanvas(b, true, true);
    if (fb && lastMoved) fb = { ...fb, x: fb.x + lastMoved[0], y: fb.y + lastMoved[1] };
    if (b === b0) lastMoved = null;
  }
  if (rec && ["read", "highlight", "hover", "move", "click", "dblclick"].includes(a.type)) {
    // the glide happens ON the word (the pan, then the read holds the centred design); for a click
    // it comes just before, so the click itself still lands on its word (Jake: 1:23 = the action centred)
    const clicky = a.type === "click" || a.type === "dblclick";
    // the glide (~1 s) now ENDS on the word for a read too (it started ON the word: +1 s late, v12 #2)
    if (a.at != null && a.glide !== false) await holdUntil(Math.max(t(), clicky ? a.at - 0.95 - (LEAD[a.type] ?? 0) : a.at - 1.0));
    if (a.glide !== false && a.center !== "cut") b = await centreOnCanvas(b, a.at != null && rec && t() > a.at + 0.3 - (clicky ? 0.95 + (LEAD[a.type] ?? 0) : 1.0));
  }
  if (pointer && startAt != null && rec) await holdUntil(Math.max(t(), startAt));
  if (need && !b) return { ok: false, error: `no element for ${JSON.stringify({ ref: a.ref, text: a.text, target: a.target })} — observe again and use a ref from the list` };
  const c = b ? (b.at || [b.x + b.width / 2, b.y + b.height / 2]) : null;
  const zoomKey = a.type === "key" && /^(shift\+[0-2]|(control|ctrl|meta|cmd)\+[-=+0])$/i.test(String(a.key || ""));
  if ((zoomKey || (a.type === "scroll" && a.zoom)) && fittedUrl && page.url() === fittedUrl)
    return { ok: true, t: t(), note: "ignored: the recorder already framed this canvas (designs fill the screen) — do not zoom the canvas" };
  switch (a.type) {
    case "fit_designs": case "fit": { const r = await fitDesigns(a.fill ?? 0.78); if (rec) log("cut", { why: "fit designs", big: true }); return { ...r, t: t() }; }
    case "move": case "hover": { const e = log(a.type, { box: toCap(fb || b), abox: toCap(b), text: b.text }); Object.assign(e, await seen(fb || b)); await moveTo(...c); e.end = t(); break; }
    case "click": case "dblclick": {
      const e = log("click", { box: toCap(fb || b), abox: toCap(b), text: b.text });
      Object.assign(e, await seen(fb || b));
      await moveTo(...c);
      if (rec) await hold(a.settle_s ?? 0.12);
      // the PRESS lands on its word (Jake #11 "the click lands on 'click'"): LEAD is only the cursor's
      // travel budget — with the cursor already there (dblclick after a click) it pressed 0.64 s early
      // (loop round 1, seg 0 30.26 for "designed" at 30.90)
      if (rec && a.at != null) await holdUntil(Math.max(t(), a.at));
      let pre = null;
      try { if (rec) pre = await tiny(); } catch {}
      // "press": false (G3 generations off camera): the viewer sees the cursor click send / Remove BG on the
      // word, the page is NOT pressed — the result made off camera follows as a K2 reveal (assets.json)
      if (a.press !== false) await page.mouse.click(cx, cy, { clickCount: a.type === "dblclick" ? 2 : 1 }).catch(() => {});
      else e.dry = true;
      e.press = t();
      if (rec && a.then_type) {
        // round 3 (review N15): the brand menu opens ALREADY FILTERED — its search is typed on silent ticks
        // inside the opening (no frames), so the Scout's test brand never shows
        for (const ch of a.then_type) { await page.keyboard.type(ch); await step(true); }
        await tick(4);
      }
      // let the page react on the frozen clock: a handful of frames
      if (a.goto) {
        // the click's destination is forced (loop round 1, seg 5): Linearity's sidebar "Brands" always
        // opens the NEWEST brand (the Blue Bottle test brand), never the account owner's — the page the
        // narration names ("your brand name") is loaded inside the cut instead (CUT02: cut on click)
        lastNavT = t(); log("nav", { url: a.goto, cut: true, why: "click" }); await load(a.goto, a.settle ?? 2.5);
      } else if (b.href && b.blank) { log("nav", { url: b.href, cut: true, why: "click" }); await load(b.href, a.settle ?? 2.5); }   // a click = CUT02 hard cut, not a dissolve
      else if (rec && a.cut !== false && a.press !== false) await settleCut("click", pre);
      if (rec) await hold(Math.min(a.after ?? 0.3, MAX_STILL)); else await sleep(300);
      e.end = t();
      break;
    }
    case "type": {
      if (b) { await moveTo(...c); await page.mouse.click(cx, cy).catch(() => {}); }
      // pre-production / set dressing: focus a field by CSS selector (a rich-text composer has no ref/text)
      else if (a.selector) {
        const el = await page.$(a.selector).catch(() => null);
        if (!el) return { ok: false, error: `no element for selector ${a.selector}` };
        await el.click().catch(() => {}); await el.focus().catch(() => {});
      }
      const popups = () => page.evaluate(() => [...document.querySelectorAll('[role=listbox],[role=option],[class*="suggest" i],[class*="autocomplete" i]')]
        .filter((el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 40 && r.height > 12 && st.visibility !== "hidden" && st.display !== "none" && +st.opacity > 0.2; }).length).catch(() => 0);
      const nPop = await popups();
      // RULEBOOK C3: the field is EMPTY when the typing beat starts. Any leftover draft is cleared (not only
      // when the agent asks: "Colorize this black and white photTurn this into…" reached an edit,
      // 2026-10-09). ⚠️ The browser now says it is a Mac, so apps map select-all to ⌘A and ignore Ctrl+A:
      // the editing commands are used first (work in inputs and rich-text composers alike), keys as backup.
      // Acknowledged by SILENT ticks (no frames, nothing shown)
      const fieldText = () => page.evaluate(() => { const x = document.activeElement; return x ? String(x.value ?? x.innerText ?? "").trim() : ""; }).catch(() => "");
      if (a.clear !== false && (a.clear || (await fieldText()))) {
        await page.evaluate(() => { try { document.execCommand("selectAll"); document.execCommand("delete"); } catch {} }).catch(() => {});
        if (rec) await step(true);
        if (await fieldText()) {
          for (const combo of ["Meta+a", "Control+a"]) {
            await pressCombo(combo); if (rec) await step(true);
            await page.keyboard.press("Backspace"); if (rec) { for (let j = 0; j < 3; j++) await step(true); }
            if (!(await fieldText())) break;
          }
        }
      }
      // a compiled beat (G3): the field is focused and cleared BEFORE the word; the paste itself lands on it.
      // A field that is still not empty here aborts the take (RULEBOOK C3 — never append to a stale draft)
      if (a.beat && a.clear !== false && (await fieldText())) return { ok: false, error: `field not empty before typing: "${(await fieldText()).slice(0, 60)}"` };
      if (rec && a.beat && a.at != null) await holdUntil(Math.max(t(), a.at));
      const e = log("type", { box: toCap(fb || b), abox: toCap(b), text: a.text, paste: !!a.paste });
      e.press = t();
      if (a.paste) {
        // Jake #8: an address / a name goes in WHOLE, at once (a paste), never letter by letter
        // set the focused field's value in one go (React-safe native setter + input event). Key
        // events need a frame to be acknowledged: insertText / keys without a step() between them
        // hung on the paused virtual clock (2026-10-07 v12 seg-02, twice)
        // real key events (the JS value setter did not render in Linearity's field, v12c 1:02), each
        // acknowledged by a SILENT clock tick: the page sees typing, the recording sees it all at once
        for (const ch of a.text) { await page.keyboard.type(ch); if (rec) await step(true); }
        if (rec) { for (let j = 0; j < 3; j++) await step(true); await hold(a.after ?? 0.4); }   // "after": how long the pasted state shows
      } else {
        const perChar = FPS / (a.cps ?? 16);
        let acc = 0;
        for (const ch of a.text) {
          await page.keyboard.type(ch);
          acc += perChar;
          while (rec && acc >= 1) { await step(); acc -= 1; }
        }
      }
      e.end = t();
      // what the field holds now (QA: a stale draft + the new text = a garbled prompt, review v12 #18)
      e.value = await page.evaluate(() => { const x = document.activeElement; return x ? (x.value ?? x.innerText ?? "") : ""; }).catch(() => null);
      Object.assign(e, await seen(b));
      // Jake #8 clean screens: an autocomplete / search-suggestion list that opened under the
      // field is closed (Escape) unless the next step submits with Enter
      if (!a.enter && a.dismiss !== false) {
        // only a list that APPEARED with the typing (never Escape a dialog the field sits in)
        if (await popups() > nPop) { await page.keyboard.press("Escape").catch(() => {}); log("key", { key: "Escape", why: "dismiss popup" }); if (rec) await hold(0.15); }
      }
      if (a.enter) { if (rec) await hold(0.25); await page.keyboard.press("Enter"); log("key", { key: "Enter" }); if (rec) { await hold(0.3); await settleCut("enter"); } }
      break;
    }
    case "key": await pressCombo(a.key); log("key", { key: a.key }); if (rec) { await hold(0.2); if (a.key === "Enter") await settleCut("enter"); } break;
    case "scroll": {
      if (!a.zoom && rec && lastNavT != null && t() - lastNavT < 0.8) {
        // a scroll right after a goto happens INSIDE the cut (Jake #7/#9: the landing → CUT to the
        // Free card zoomed; no visible scroll) — the page is placed off camera, nothing is logged
        // the wheel, but with NO recorded frames between the flicks (the clock stays frozen, so the
        // first frame after it already shows the scrolled page). ⚠️ realtime()/pause() here stalled
        // the next step() for 10 min (v12 seg-01)
        await page.mouse.move(cx, cy).catch(() => {});
        const n = Math.max(1, Math.round(Math.abs(a.by || 0) / 200));
        // input needs frames to be acknowledged: tick the page clock WITHOUT recording frames
        for (let k = 0; k < n; k++) { await page.mouse.wheel({ deltaY: (a.by || 0) / n }).catch(() => {}); for (let j = 0; j < 6; j++) await step(true); }
        // round 2: the page SMOOTH-scrolls over the next ~0.5 s — let it finish inside the cut, or an
        // observe right after reads the old positions (the Free card / kit boxes framed 150 px off)
        for (let j = 0; j < 24; j++) await step(true);
        return { ok: true, t: t(), note: "scrolled inside the cut (right after the goto) — nothing of it is shown" };
      }
      if (a.zoom) {
        // zoom an app canvas at a point (ctrl+wheel): result first, big — not a page scroll
        const raw = a.to || (a.x != null ? [a.x, a.y] : [640, 360]);
        await moveTo(raw[0] * SHOT_F, raw[1] * SHOT_F);
        // "zoom": "in" | "out" with "steps" (1 step = 80 wheel units ≈ 2× on Linearity's canvas);
        // a numeric "by" still works (negative = in)
        const dir = a.zoom === "out" ? 1 : a.zoom === "in" ? -1 : Math.sign(a.by || -1);
        const total = typeof a.zoom === "string" ? 80 * Math.max(1, Math.min(3, a.steps || 1)) : Math.abs(a.by || 80);
        const n = Math.max(1, Math.round(total / 80));
        await page.keyboard.down("Control");
        for (let k = 0; k < n; k++) { await page.mouse.wheel({ deltaY: dir * total / n }); if (rec) await hold(0.1); else await sleep(250); }
        await page.keyboard.up("Control");
        log("cut", { why: "canvas zoom", big: true });
        break;
      }
      const e = log("scroll", { by: a.by });
      const n = Math.max(1, Math.round(Math.abs(a.by) / 200));
      for (let k = 0; k < n; k++) { await page.mouse.wheel({ deltaY: a.by / n }); if (rec) await hold(0.4); }
      e.end = t();
      break;
    }
    case "read": case "highlight": {
      const markable = a.type === "highlight" && !["input", "textarea", "select", "img", "video", "canvas"].includes(b.tag) && b.text;
      // a compiled camera beat (the plan's camera.zoom) names what to frame: camera.py moves only to a
      // target_box (G5 step 4: a plain read never moves the camera); filler holds stay unframed
      const tb = a.camera_only && a.beat && !a.filler ? { target_box: toCap(b) } : {};
      const e = log(markable ? "highlight" : "read", { box: toCap(b), text: b.text, ...tb, ...(a.deep ? { deep: true } : {}) });
      Object.assign(e, await seen(b));
      // a beat is a calm screen (SYSTEM.md §2): never shorter than ~1.8 s — but DEFERRED (see openRead)
      const ms = Math.min(MAX_STILL, Math.max(a.ms ?? 2500, (SYS.min_beat_s ?? 2.5) * 720) / 1000);
      if (rec && a.at != null) { e.end = t() + ms; openRead = { e, until: t() + ms }; }
      else { if (rec) await hold(ms); e.end = t(); }
      break;
    }
    case "wait_for": {
      // long work (an AI generation): wait in REAL time with the clock frozen — the viewer
      // sees the result arrive, not the wait. `show` seconds of the waiting state first.
      // G3 live counter beat: the in-progress card stays on camera until its payoff word ("until", clip s) —
      // the finished result never lands before it (gap #22); then a K2 time-skip dissolve (fade) to the result
      if (a.until != null && rec) await holdUntil(Math.max(t(), a.until));
      else if (a.show && rec) await hold(a.show);
      await realtime();
      const until = Date.now() + (a.timeout ?? 180) * 1000;
      let found = false;
      while (Date.now() < until) {
        found = await page.evaluate((txt, gone, sel, min) => {
          // a finished generation by selector (G3 live counter beat): more matches than "min", none still loading
          const has = sel ? document.querySelectorAll(sel).length > (min || 0) && !document.querySelector('[aria-busy="true"]')
            : document.body.innerText.toLowerCase().includes(String(txt).toLowerCase());
          return gone ? !has : has;
        }, a.text, !!a.gone, a.selector || null, a.min ?? 0).catch(() => false);
        if (found) break;
        await sleep(1500);
      }
      await sleep((a.settle ?? 1.5) * 1000);
      if (rec) await pause();
      log("wait", { text: a.text, found, ...(a.k2 ? { fade: true, k2: { frames: Math.max(3, Math.min(8, a.k2.frames ?? 6)) }, until: a.until ?? null } : {}),
                    ...(a.ledger != null ? { ledger: a.ledger } : {}), ...(a.word_t != null ? { word_t: a.word_t } : {}),
                    ...(a.beat_id != null ? { beat_id: a.beat_id } : {}), ...(a.live ? { live: true } : {}) });
      if (!found) return { ok: false, t: t(), error: `"${a.text}" did not ${a.gone ? "go away" : "appear"} in ${a.timeout ?? 180} s` };
      break;
    }
    case "drag": {
      // drag from → to (SCREENSHOT px): a markup box over the label, a file onto the chat, an artboard.
      // On camera too (G3 #31): the press lands on its word, the drag runs at human pace (~0.6 s, eased)
      // a compiled beat carries drag_from/drag_to ("from" is then its clause start for the camera)
      const p0 = Array.isArray(a.drag_from) ? a.drag_from : a.from, p1 = Array.isArray(a.drag_to) ? a.drag_to : a.to;
      if (!Array.isArray(p0) || !Array.isArray(p1)) return { ok: false, error: "drag needs from/to [x, y]" };
      const f = p0.map((v) => v * SHOT_F), g = p1.map((v) => v * SHOT_F);
      const e = log("drag", { from: p0, to: p1, box: toCap({ x: Math.min(f[0], g[0]), y: Math.min(f[1], g[1]), width: Math.abs(g[0] - f[0]) || 2, height: Math.abs(g[1] - f[1]) || 2 }) });
      await moveTo(...f);
      if (rec && a.at != null) await holdUntil(Math.max(t(), a.at));
      await page.mouse.down(); e.press = t();
      const n = rec ? Math.max(8, Math.round((a.ms ?? 600) / 1000 * FPS)) : 12;
      for (let i = 1; i <= n; i++) { const u = i / n, ez = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
        cx = f[0] + (g[0] - f[0]) * ez; cy = f[1] + (g[1] - f[1]) * ez; await page.mouse.move(cx, cy); if (rec) await step(); else await sleep(40); }
      await page.mouse.up(); e.end = t();
      if (rec) await hold(0.3); else await sleep(500);
      break;
    }
    case "draw": {
      // draw strokes with the mouse (G3 #23: the Sketch canvas gets the drawing the narration describes).
      // strokes = [[[x, y], ...], ...] in "space" units (preprod.doodle_svg's 1024 canvas by default) mapped
      // into "box" (SCREENSHOT px, the canvas on screen); without a box they are screenshot px
      const strokes = Array.isArray(a.strokes) ? a.strokes.filter((st) => Array.isArray(st) && st.length >= 2) : [];
      if (!strokes.length) return { ok: false, error: "draw needs strokes [[[x,y],...],...]" };
      let bx = Array.isArray(a.box) && a.box.length === 4 ? a.box : null;
      if (!bx && a.selector) {
        // the drawing surface by selector (the Sketch canvas): its on-screen box, in SCREENSHOT px
        const r = await page.evaluate((sel) => { const els = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect())
          .filter((q) => q.width > 60 && q.height > 60).sort((p, q) => q.width * q.height - p.width * p.height); return els[0] ? [els[0].x, els[0].y, els[0].width, els[0].height] : null; }, a.selector).catch(() => null);
        if (!r) return { ok: false, error: `no drawing surface ${a.selector}` };
        const side = Math.min(r[2], r[3]);                        // a square drawing space centred in the surface
        bx = [(r[0] + (r[2] - side) / 2) / SHOT_F, (r[1] + (r[3] - side) / 2) / SHOT_F, side / SHOT_F, side / SHOT_F];
      }
      const sp = a.space ?? 1024;
      const map = ([x, y]) => bx ? [(bx[0] + x / sp * bx[2]) * SHOT_F, (bx[1] + y / sp * bx[3]) * SHOT_F] : [x * SHOT_F, y * SHOT_F];
      const e = log("draw", { strokes: strokes.length, ...(bx ? { box: toCap({ x: bx[0] * SHOT_F, y: bx[1] * SHOT_F, width: bx[2] * SHOT_F, height: bx[3] * SHOT_F }) } : {}) });
      // human pace: ~900 css px per second of pen travel, a short lift between strokes
      for (const [k, st] of strokes.entries()) {
        const pts = st.map(map);
        await moveTo(...pts[0]);
        if (k === 0 && rec && a.at != null) await holdUntil(Math.max(t(), a.at));
        if (k === 0) e.press = t();
        await page.mouse.down();
        for (let j = 1; j < pts.length; j++) {
          const d = Math.hypot(pts[j][0] - cx, pts[j][1] - cy), n = rec ? Math.max(1, Math.round(d / 900 * FPS)) : 1;
          const x0 = cx, y0 = cy;
          for (let i = 1; i <= n; i++) { cx = x0 + (pts[j][0] - x0) * i / n; cy = y0 + (pts[j][1] - y0) * i / n; await page.mouse.move(cx, cy); if (rec) await step(); }
          if (!rec) await sleep(8);
        }
        await page.mouse.up();
        if (rec) await hold(0.08);
      }
      e.end = t();
      break;
    }
    case "reveal": {
      // K2 TIME-SKIP DISSOLVE (BASELINE §2c; sync/G1 r3 5:14.05 +0.59 s): the finished result was made OFF
      // CAMERA (assets.json, its chat URL); the page is swapped inside a 3–8 f dissolve, nothing loads on camera
      if (rec && a.at != null) await holdUntil(Math.max(t(), a.at));
      lastNavT = t();
      const e = log("nav", { url: a.url, fade: true, k2: { frames: Math.max(3, Math.min(8, a.frames ?? 6)), asset: a.asset || null }, ...curMeta });
      lastFit = null;
      await load(a.url, a.settle ?? 3);
      if (a.selector) { const els = await page.$$(a.selector).catch(() => []); const el = els[a.nth ?? els.length - 1];
        if (el) { await el.evaluate((x) => x.scrollIntoView({ block: "center" })).catch(() => {}); for (let j = 0; j < 12; j++) await step(true); } }
      Object.assign(e, await seen(null));
      break;
    }
    case "upload": {
      // pre-production / set dressing (off camera): put files (paths under /w) into the page's file
      // input — the composer's attach input on ChatGPT. "accept" picks the input whose accept list
      // contains it (default image); the first visible-or-hidden match is used.
      const files = (a.files || []).filter((f) => fs.existsSync(f));
      if (!files.length) return { ok: false, error: `no such files: ${JSON.stringify(a.files)}` };
      const inputs = await page.$$("input[type=file]");
      let inp = null;
      for (const h of inputs) {
        const acc = await h.evaluate((e) => (e.accept || "") + "|" + (e.multiple ? "m" : "")).catch(() => "");
        if (!a.accept || acc.includes(a.accept)) { inp = h; if (acc.includes("image") || acc.startsWith("|")) break; }
      }
      if (!inp) return { ok: false, error: `no file input on the page (${inputs.length} inputs)` };
      // on camera (G3 #35 "Upload the photo"): the file lands in the composer ON its word
      if (rec && a.at != null) await holdUntil(Math.max(t(), a.at));
      const eu = log("upload", { files: files.map((f) => path.basename(f)) });
      eu.press = t();
      await inp.uploadFile(...files);
      if (rec) await hold(Math.min(MAX_STILL, a.s ?? 1)); else await sleep((a.s ?? 2) * 1000);
      break;
    }
    // no still longer than 3 s on camera (RULEBOOK P1/M5; G3: an agent "hold" of 9 s read a tooltip)
    case "hold": if (rec) await hold(Math.min(a.s ?? 1, MAX_STILL)); else await sleep(Math.min(a.s ?? 1, 30) * 1000); break;
    case "goto": { lastNavT = t(); const e = log("nav", { url: a.url, ...(a.fade ? { fade: true } : {}), ...(a.cut ? { cut: true } : {}) }); lastFit = null; await load(a.url, a.settle ?? 2.5); Object.assign(e, await seen(null)); } if (lastFit) return { ok: true, t: t(), fit: lastFit }; break;
    default: return { ok: false, error: `unknown action ${a.type}` };
  }
  return { ok: true, t: t(), ...(lastMoved ? { moved: lastMoved.map((v) => +(v / SHOT_F).toFixed(1)) } : {}),
           ...(b && b.tag !== "point" && b.tag !== "region" ? { resolved: { hint: b.hint || null, label: b.label || b.text || "", tag: b.tag } } : {}) };
}

async function pressCombo(k) {
  // "Shift+1", "Control+0", "Meta+a" → modifiers held around the key
  const parts = String(k).split("+").filter(Boolean);
  if (parts.length < 2) return page.keyboard.press(k);
  const mods = parts.slice(0, -1).map((m) => ({ ctrl: "Control", cmd: "Meta", alt: "Alt", shift: "Shift" }[m.toLowerCase()] || m));
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(parts[parts.length - 1]);
  for (const m of mods.reverse()) await page.keyboard.up(m);
}
async function startSegment(dir, t0 = 0) {
  const full = path.join(workdir, dir);
  fs.mkdirSync(full, { recursive: true });
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-x264-params", "rc-lookahead=0:sync-lookahead=0", "-threads", "2",
    "-pix_fmt", "yuv420p", "-r", String(FPS), path.join(full, "raw.mp4")],   // ~100 MB, not ~470 (the box swaps)
    { stdio: ["pipe", "ignore", "inherit"] });
  await heartbeat(true);          // static pages keep painting under paused virtual time
  await pause();                  // the recorded clock only moves frame by frame
  rec = { ff, frame: 0, t0: +t0 || 0, events: [], cursor: [], dir: full, url: page.url() };
  log("begin");
}
async function endSegment(until) {
  if (!rec) return;
  if (openRead) { openRead.e.end = Math.min(openRead.until, until ?? openRead.until); openRead = null; }
  if (until) await holdUntil(until);
  const r = rec;
  rec.ff.stdin.end();
  await new Promise((res) => r.ff.on("close", res));
  r.priv?.flush(path.join(r.dir, "privacy.json"));
  fs.writeFileSync(path.join(r.dir, "events.json"), JSON.stringify({
    capture: { w: W, h: H, fps: FPS, scale: SCALE, css: [CSS_W, CSS_H] }, virtual_time: true, pre_frames: 0, url: r.url,
    t0: r.t0 || 0, end: (r.t0 || 0) + r.frame / FPS, failed: null, cursor: r.cursor, events: r.events, walls: r.walls || [],
    browser: { exe: CHROME, ua: UA, version: ID.full }, account: ACCOUNT }, null, 1));
  rec = null;
  await heartbeat(false);
  await realClock();
}
// Between recordings the page must run on the REAL clock: virtual time cannot be switched off once on,
// and its "advance" policy fast-forwards an idle page — ChatGPT then burned ~280 % CPU and, 37 min into a
// factory job, one off-camera click took 9.7 min (2026-10-09). A fresh tab at the same address (same
// profile, cookies and identity) has no virtual time; the old tab is closed.
async function realClock() {
  const url = page.url(), old = page;
  try {
    // close FIRST: the tabs share one renderer process (--renderer-process-limit=1) and a tab opened
    // next to the virtual-time one loaded half-way (spinner, a placeholder account) — 2026-10-09
    // per-tab state (sessionStorage — e.g. which of the profile's accounts is active) goes along
    let ss = "{}", origin = null;
    try { origin = new URL(url).origin; ss = await old.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage)))); } catch {}
    await old.close().catch(() => {});
    const p = await browser.newPage();
    await dress(p, ID);
    if (origin && ss !== "{}") await p.evaluateOnNewDocument((o, j) => {
      try { if (location.origin === o && !sessionStorage.getItem("__amss")) { for (const [k, v] of Object.entries(JSON.parse(j))) sessionStorage.setItem(k, v); sessionStorage.setItem("__amss", "1"); } } catch {}
    }, origin, ss).catch(() => {});
    await p.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
    const c = await p.createCDPSession();
    page = p; cdp = c; hbScript = null; vtOn = false;
    watch(page);
    if (url && /^https?:/.test(url)) await load(url, 3);
  } catch (e) {
    process.stderr.write(`fresh tab failed (${e?.message}) — reopening\n`);
    lastUrl = url; await recover();
  }
}

// ACCOUNT ON THE ICON RAIL (playbook proving run 2026-10-09). A logged-in page shows its account name (sidebar
// block / greeting) a moment AFTER it looks loaded: it is read after every off-camera load (open, goto, the fresh
// real-clock tab), before set-dressing hides the sidebar, and accountName() keeps it for this document — the
// first-frame gate can then still prove the account with the sidebar hidden (1 open in 3 had no name yet).
// ChatGPT keeps a hidden sidebar hidden across reloads (a fresh tab after a recording, a set-up retry): the name is
// then nowhere on the page. Off camera only, the sidebar is shown for a moment, the name read, and hidden again.
async function pressVisible(sel) {
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((x) => { const r = x.getBoundingClientRect(), s = getComputedStyle(x);
      return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && s.visibility !== "hidden" && s.display !== "none"; });
    if (el) el.click();
    return !!el;
  }, sel).catch(() => false);
}
async function noteAccount() {
  if (SESSION !== "logged_in") return null;
  // (the name readers are ChatGPT's: another app gets one read, no 8 s wait on every load)
  let host = ""; try { host = new URL(page.url()).hostname; } catch {}
  const tries = /(^|\.)chatgpt\.com$/.test(host) ? 16 : 1;
  for (let k = 0; k < tries; k++) { const who = await accountName(page); if (who) return who; if (k < tries - 1) await sleep(500); }
  if (tries === 1) return null;
  if (rec || !(await pressVisible('button[aria-label="Show sidebar"]'))) return null;
  let who = null;
  for (let k = 0; k < 10 && !who; k++) { await sleep(300); who = await accountName(page); }
  await pressVisible('button[aria-label="Hide sidebar"]');
  await sleep(500);
  return who;
}

await realtime();
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  let m;
  try { m = JSON.parse(line); } catch { out({ ok: false, error: "bad json" }); continue; }
  try {
    if (m.cmd === "open") { const g = await guard({ type: "open", url: m.url }); if (!g.ok) { out({ ok: false, refused: g.refused, error: g.why }); continue; } lastFit = null; await load(m.url, m.settle ?? 2.5); out({ ok: true, url: page.url(), fit: lastFit, wall: await wall(page) }); }
    else if (m.cmd === "guard") { const w = await wall(page); if (w && rec) { rec.walls = rec.walls || []; rec.walls.push({ t: t(), ...w }); } out({ ok: true, wall: w, url: page.url(), account: ACCOUNT }); }
    else if (m.cmd === "reload") { const g = await guard({ type: "reload", url: page.url() }); if (!g.ok) { out({ ok: false, refused: g.refused, error: g.why }); continue; } await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}); await sleep((m.settle ?? 6) * 1000); out({ ok: true, wall: await wall(page), url: page.url() }); }
    else if (m.cmd === "whoami") { out({ ok: true, ...(await page.evaluate(() => ({ ua: navigator.userAgent, platform: navigator.platform, webdriver: navigator.webdriver, languages: navigator.languages, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, text: (document.body?.innerText || "").slice(0, 20000), uaData: navigator.userAgentData ? navigator.userAgentData.toJSON() : null, gl: (() => { try { const g = document.createElement("canvas").getContext("webgl"); const x = g.getExtension("WEBGL_debug_renderer_info"); return [g.getParameter(x.UNMASKED_VENDOR_WEBGL), g.getParameter(x.UNMASKED_RENDERER_WEBGL)]; } catch (e) { return String(e); } })() })).catch((e) => ({ error: String(e) }))), exe: CHROME }); }
    else if (m.cmd === "segment") { await startSegment(m.out, m.t0 ?? 0); out({ ok: true, t0: m.t0 ?? 0 }); }
    else if (m.cmd === "observe") out({ ok: true, ...(await observe()) });
    else if (m.cmd === "shot") { const s = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80, clip: await vclip(1 / SHOT_F) }); const f = path.join(workdir, `obs-${String(++obsN).padStart(4, "0")}.jpg`); fs.writeFileSync(f, Buffer.from(s.data, "base64")); out({ ok: true, shot: f }); }
    else if (m.cmd === "count") { const n = await page.$$eval(m.selector, (els) => els.length).catch(() => -1); out({ ok: n >= 0, n }); }
    else if (m.cmd === "net") { out({ ok: true, net: NET.slice(-(m.n || 40)) }); }
    else if (m.cmd === "text") {
      // pre-production readiness: the page's visible text (+ url/title, h1s, the composer's draft)
      const r = await page.evaluate(() => ({ url: location.href, title: document.title,
        h1: [...document.querySelectorAll("h1")].map((e) => e.innerText.trim()).filter(Boolean),
        draft: (document.querySelector("[contenteditable=true]")?.innerText || "").trim(),
        text: document.body.innerText.slice(0, 20000) })).catch((e) => ({ error: String(e) }));
      out({ ok: !r.error, ...r });
    }
    else if (m.cmd === "find") {
      // pre-production readiness: where each label lives — visible elements whose own text / aria-label /
      // title contains it (case-insensitive), innermost first, with a selector hint and state attributes
      const r = await page.evaluate((texts, exact) => {
        const vis = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e);
          return b.width > 2 && b.height > 2 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth && s.visibility !== "hidden" && s.display !== "none"; };
        const lab = (e) => (e.getAttribute("aria-label") || e.innerText || e.getAttribute("title") || e.getAttribute("placeholder") || e.getAttribute("data-placeholder") || "").trim().replace(/\s+/g, " ");
        const hint = (e) => { const tid = e.getAttribute("data-testid"); const al = e.getAttribute("aria-label");
          return tid ? `[data-testid="${tid}"]` : al ? `${e.tagName.toLowerCase()}[aria-label="${al}"]` : `${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[role="${e.getAttribute("role")}"]` : ""}:has-text("${lab(e).slice(0, 40)}")`; };
        const res = {};
        for (const t of texts) {
          const want = t.toLowerCase();
          const hits = [...document.querySelectorAll("body *")].filter((e) => { const l = lab(e).toLowerCase(); return vis(e) && (exact ? l === want : l.includes(want)); });
          // innermost first; then labels that START with the text, then the smallest box
          const area = (e) => { const b = e.getBoundingClientRect(); return b.width * b.height; };
          const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)))
            .sort((a, b) => (lab(a).toLowerCase().startsWith(want) ? 0 : 1) - (lab(b).toLowerCase().startsWith(want) ? 0 : 1) || area(a) - area(b));
          res[t] = inner.slice(0, 4).map((e) => { const b = e.getBoundingClientRect();
            const cl = e.closest("button,a,[role=button],[role=menuitem],[role=option],[role=tab],[role=radio]") || e;
            return { tag: e.tagName.toLowerCase(), text: lab(e).slice(0, 80), selector: hint(cl), box: [b.x, b.y, b.width, b.height].map(Math.round),
              state: { pressed: cl.getAttribute("aria-pressed"), selected: cl.getAttribute("aria-selected"), checked: cl.getAttribute("aria-checked"),
                       dataState: cl.getAttribute("data-state"), disabled: cl.hasAttribute("disabled") || cl.getAttribute("aria-disabled") === "true" } }; });
        }
        return res;
      }, m.texts || [], !!m.exact).catch((e) => ({ __error: String(e) }));
      out({ ok: !r.__error, found: r });
    }
    else if (m.cmd === "grab") {
      // pre-production: save an on-page image (a generation) as a file → {ok, file, w, h, via}.
      // {"ref": "r12"} | {"largest": true} (the biggest visible <img>); "out" = path under /w.
      // The image's own bytes (natural size) when the page can fetch its src; else a screenshot of its box.
      const info = await page.evaluate((ref, sel, nth) => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < innerHeight; };
        let el = ref ? document.querySelector(`[data-agent-ref="${ref}"]`) : null;
        if (!el && sel) { const c = document.querySelectorAll(sel)[nth || 0]; if (c) { c.scrollIntoView({ block: "center" }); el = c.tagName === "IMG" ? c : c.querySelector("img") || c; } }
        if (!el) el = [...document.querySelectorAll("img")].filter(vis).sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { src: el.currentSrc || el.src || null, nw: el.naturalWidth, nh: el.naturalHeight, box: [r.x, r.y, r.width, r.height] };
      }, m.ref || null, m.selector || null, m.nth || 0).catch(() => null);
      if (!info) out({ ok: false, error: "no image found" });
      else {
        const file = m.out || path.join(workdir, `grab-${Date.now()}.png`);
        let via = "src", data = null;
        if (info.src) data = await page.evaluate(async (u) => {
          try { const r = await fetch(u, { credentials: "include" }); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer());
            let s = ""; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return [r.headers.get("content-type"), btoa(s)]; } catch { return null; }
        }, info.src).catch(() => null);
        if (data && data[1]) fs.writeFileSync(file, Buffer.from(data[1], "base64"));
        else {
          via = "screenshot";
          const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: info.box[0], y: info.box[1], width: info.box[2], height: info.box[3], scale: SCALE } });
          fs.writeFileSync(file, Buffer.from(s.data, "base64"));
        }
        out({ ok: true, file, via, type: data ? data[0] : "image/png", w: info.nw, h: info.nh, box: info.box });
      }
    }
    else if (m.cmd === "act") out(await act(m.action || {}));
    else if (m.cmd === "end") { await endSegment(m.until); out({ ok: true }); }
    else if (m.cmd === "abort") {
      // G3 retake: a failed take is DROPPED — the file is closed and its directory removed; no events.json,
      // so nothing downstream can mistake it for a finished recording
      if (openRead) openRead = null;
      if (rec) { const r = rec; r.ff.stdin.end(); await new Promise((res) => r.ff.on("close", res)); rec = null;
        try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch {}
        await heartbeat(false); await realClock(); }
      out({ ok: true, aborted: true });
    }
    else if (m.cmd === "state") {
      // FIRST-FRAME FACTS (G3; screencast/first_frame.py verdict): what frame 1 would show, read from the DOM
      const d = await page.evaluate(() => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
          return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
            && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.15; };
        const h1 = [...document.querySelectorAll("h1")].filter(vis).map((e) => e.innerText.trim()).filter(Boolean);
        // the history sidebar: a visible nav/aside wider than an icon rail that lists chats
        const side = [...document.querySelectorAll("nav, aside, #stage-slideover-sidebar, [data-testid*=sidebar i]")].filter(vis)
          .some((e) => { const r = e.getBoundingClientRect(); return r.width >= 180 && r.left < 40 && /recents|new chat|library/i.test(e.innerText || ""); });
        const comp = document.querySelector('[contenteditable="true"]#prompt-textarea, [contenteditable="true"]');
        const draft = comp ? (comp.innerText || "").trim() : "";
        const attachments = [...document.querySelectorAll('button[aria-label^="Remove "]')].filter(vis).length;
        const popups = [...document.querySelectorAll('[role=menu],[role=listbox],[role=dialog],[data-radix-popper-content-wrapper],[class*="suggest" i],[class*="autocomplete" i]')]
          .filter((e) => vis(e) && e.getBoundingClientRect().width > 60).length;
        const tooltips = [...document.querySelectorAll('[role=tooltip]')].filter(vis).length;
        const tg = [...document.querySelectorAll('button,[role=tab],[role=radio]')].filter((e) => vis(e) && /^(Chat|Work)$/.test((e.innerText || "").trim()));
        const on = tg.find((e) => e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-checked") === "true" || e.getAttribute("data-state") === "active" || e.getAttribute("aria-pressed") === "true");
        const mode = on ? on.innerText.trim().toLowerCase() : (h1.some((h) => /what should we work on/i.test(h)) ? "work" : null);
        const busy = !!document.querySelector('[aria-busy="true"], [data-testid="loading"], .animate-spin') && !h1.length;
        return { url: location.href, h1, sidebar: side, draft, attachments, popups, tooltips, mode, loading: busy,
                 text: (document.body?.innerText || "").slice(0, 3000) };
      }).catch((e) => ({ error: String(e) }));
      let lum = null, blank = null;
      try { const g = await tiny(); let sum = 0; for (const v of g) sum += v; lum = Math.round(sum / g.length * 10) / 10; blank = blankish(g); } catch {}
      const who = await accountName(page);
      const w = await wall(page);
      const shot = path.join(workdir, `ff-${String(++obsN).padStart(4, "0")}.jpg`);
      try { const s = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90, clip: await vclip(1 / SHOT_F) }); fs.writeFileSync(shot, Buffer.from(s.data, "base64")); } catch {}
      let fp = null; try { fp = await fingerprint(); } catch {}
      const priv = await privacyBoxes(page, privateSelectors(), 1);          // C7: private boxes in this frame (CSS px)
      out({ ok: !d.error, ...d, account: who, expected: ACCOUNT, lum, blank, dark: lum == null ? null : lum < 60, wall: w, shot, fp, private: priv });
    }
    else if (m.cmd === "fp") { let fp = null; try { fp = await fingerprint(); } catch {} out({ ok: fp != null, fp, url: page.url() }); }
    else if (m.cmd === "assert") {
      // AFTER EACH BEAT (G3 spec 2): url in the whitelist, texts present / absent, the focused / named field's text
      const r = await page.evaluate((m) => {
        const fail = [], url = location.href;
        if (Array.isArray(m.url_allow) && m.url_allow.length && !m.url_allow.some((u) => url.startsWith(u) || new RegExp(u).test(url))) fail.push(`url ${url} not in the whitelist`);
        const body = document.body?.innerText || "";
        for (const tx of m.present || []) if (!body.toLowerCase().includes(String(tx).toLowerCase()) && !document.querySelector(`[aria-label="${tx}"]`)) fail.push(`missing "${tx}"`);
        for (const tx of m.absent || []) if (body.toLowerCase().includes(String(tx).toLowerCase())) fail.push(`unexpected "${tx}"`);
        const fld = m.field ? document.querySelector(m.field) : document.activeElement;
        const val = fld ? String(fld.value ?? fld.innerText ?? "").replace(/\u00a0/g, " ").trim() : null;
        if (m.field_empty && val) fail.push(`field not empty: "${val.slice(0, 60)}"`);
        if (m.field_equals != null && val !== String(m.field_equals).trim()) fail.push(`field "${(val || "").slice(0, 80)}" != script "${String(m.field_equals).slice(0, 80)}"`);
        for (const sel of m.selector_present || []) if (!document.querySelector(sel)) fail.push(`no ${sel}`);
        return { fail, url, value: val };
      }, m).catch((e) => ({ fail: [String(e)] }));
      const w = await wall(page);
      if (w) r.fail.push(`${w.kind}: ${w.why}`);
      out({ ok: !r.fail.length, ...r, wall: w });
    }
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
