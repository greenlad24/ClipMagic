/**
 * Deep Dive v2 — the MEDIA PIPELINE (Jake, 2026-10-02: "these resources, the
 * cutting and all of these sources should be part of the process of a deep
 * dive presentation creation").
 *
 *   ensureVideoFile  the official launch video, downloaded once via Apify
 *                    (yt-dlp is bot-walled on this server) into a shared cache
 *   analyzeVideo     scene detection → 3–12s windows → Sonnet vision labels
 *                    each window (UI / product / people / logo) and scores it
 *                    as a MUTED demo clip
 *   cutClip          one window → a muted H.264 mp4 + full-res poster in the
 *                    dive's asset dir (served by /api/news/dd-asset/…)
 *   capturePage      the release post as a sharp 2× full-page showcase: JPEG
 *                    tiles + the bounding boxes of its text/media blocks
 *   locateRegions    "where is the Send button?" → a box in natural pixels,
 *                    for the zoom-and-spotlight demo player
 *
 * ⚠️ openai.com serves "This page couldn't load" to plain headless Chromium.
 * The stealth setup in capturePage (AutomationControlled off, webdriver=false,
 * languages, window.chrome, real UA + accept-language) is what loads it.
 * ⚠️ A lab deploy wipes the container's /tmp — everything here lives on /data.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { config } from "../config.js";
import { claudeVisionLabeledJSON } from "../ai/claude.js";
import { getApifyToken } from "../settings/postizSecrets.js";
import { youtubeInfo } from "./video.js";
import { assetDir } from "./deepDiveVisuals.js";

const run = promisify(execFile);

/* ── types ────────────────────────────────────────────────────────────────── */

export type ClipKind = "ui" | "product" | "people" | "logo" | "other";

export interface ClipCandidate {
  start: number;
  end: number;
  kind: ClipKind;
  description: string;
  /** 0–1: how good this window is as a MUTED demo clip. */
  score: number;
  /** Absolute path of the window's middle keyframe (jpg). */
  frame: string;
}

export interface ClipAsset {
  id: string;
  /** File names in the dive's asset dir (/api/news/dd-asset/<dive>/<file>). */
  file: string;
  poster: string;
  width: number;
  height: number;
  start: number;
  end: number;
  videoId: string;
  description?: string;
}

export interface PageAsset {
  id: string;
  url: string;
  title: string;
  site: string;
  /** CSS px (the viewport width, 1280). */
  width: number;
  /** CSS px (capped at MAX_PAGE_CSS_H). */
  height: number;
  scale: 2;
  /** Tile files in the dive's asset dir; y/h in CSS px. Pixel size = css × scale. */
  tiles: { file: string; y: number; h: number }[];
  /** CSS px, page coordinates. */
  blocks: { i: number; tag: string; text: string; x: number; y: number; w: number; h: number }[];
}

/** File names this module writes into a dive's asset dir (routes.ts serves them). */
export const MEDIA_FILE_RE = /^[a-f0-9]{16}(-t\d{1,2})?\.(jpg|mp4)$/;

/* ── shared helpers ───────────────────────────────────────────────────────── */

const ANALYZE_ALGO = "v1";
const MAX_VIDEO_SECONDS = 20 * 60;
const APIFY_USD_PER_MB = 0.006;
const PAGE_W = 1280;
const PAGE_VIEW_H = 900;
const MAX_PAGE_CSS_H = 30000;
const TILE_CSS_H = 2400;
export const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const videoCacheDir = (): string => path.join(config.dataDir, "news-deepdive", "_videos");
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DIVE_RE = /^[0-9a-f-]{36}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** One promise per key: a second caller waits for the first one's work. */
function once<T>(map: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const cur = map.get(key);
  if (cur) return cur;
  const p = work().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

async function probe(file: string): Promise<{ width: number; height: number; duration: number } | null> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { timeout: 30000 });
    const j = JSON.parse(stdout);
    const width = Number(j.streams?.[0]?.width ?? 0);
    const height = Number(j.streams?.[0]?.height ?? 0);
    const duration = Number(j.format?.duration ?? 0);
    return width > 0 && height > 0 && duration > 0 ? { width, height, duration } : null;
  } catch { return null; }
}

function parseJson(raw: string): any {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in reply");
  const body = raw.slice(a, b + 1).replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(body); } catch { /* repair below */ }
  // Sonnet sometimes writes `"box">[…]` / `"box"=[…]` (seen 2 in 6 replies).
  const fixed = body.replace(/"([A-Za-z_]\w*)"\s*[>=]\s*(?=[[{"0-9tfn-])/g, '"$1":');
  try { return JSON.parse(fixed); } catch (err) { throw new Error(`${(err as Error).message} in reply: ${body.slice(0, 400)}`); }
}

/* ── 1. the source video ──────────────────────────────────────────────────── */

const videoInflight = new Map<string, Promise<{ file: string; width: number; height: number; duration: number } | null>>();

/**
 * The YouTube video as a local mp4 (≤1080p), downloaded once and shared by
 * every dive. Null when it can't be had (no token, too long, actor failed).
 */
export function ensureVideoFile(videoId: string): Promise<{ file: string; width: number; height: number; duration: number } | null> {
  if (!YT_ID_RE.test(videoId)) return Promise.resolve(null);
  return once(videoInflight, videoId, async () => {
    const dir = videoCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${videoId}.mp4`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      const p = await probe(file);
      if (p) return { file, ...p };
      fs.rmSync(file, { force: true }); // a broken cache entry: fetch again
    }

    const info = await youtubeInfo(videoId).catch(() => null);
    if (info && info.seconds > MAX_VIDEO_SECONDS) {
      console.warn(`[deepdive-media] ${videoId} is ${Math.round(info.seconds / 60)} min — over the 20-min cap, not downloading.`);
      return null;
    }
    const token = getApifyToken();
    if (!token) { console.warn("[deepdive-media] no Apify token — cannot download videos."); return null; }

    const t0 = Date.now();
    let item: any;
    try {
      const res = await fetch(`https://api.apify.com/v2/acts/streamers~youtube-video-downloader/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=300`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: [{ url: `https://www.youtube.com/watch?v=${videoId}` }], storeInKVStore: true, preferredQuality: "1080p", preferredFormat: "mp4" }),
        signal: AbortSignal.timeout(330_000),
      });
      if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const items = await res.json();
      item = Array.isArray(items) ? items.find((x: any) => x?.downloadedFileUrl) : null;
    } catch (err) {
      console.warn(`[deepdive-media] Apify download of ${videoId} failed:`, err);
      return null;
    }
    if (!item?.downloadedFileUrl) { console.warn(`[deepdive-media] Apify returned no file for ${videoId}.`); return null; }
    if (Number(item.durationSeconds) > MAX_VIDEO_SECONDS) {
      console.warn(`[deepdive-media] ${videoId} is ${item.durationSeconds}s — over the cap, not fetching the file.`);
      return null;
    }

    const part = path.join(dir, `.${videoId}.part`);
    try {
      const res = await fetch(String(item.downloadedFileUrl), { signal: AbortSignal.timeout(600_000) });
      if (!res.ok || !res.body) throw new Error(`file HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(part));
      const p = await probe(part);
      if (!p) throw new Error("downloaded file is not a playable video");
      if (p.duration > MAX_VIDEO_SECONDS) throw new Error(`video is ${Math.round(p.duration)}s — over the cap`);
      fs.renameSync(part, file);
      const mb = fs.statSync(file).size / 1024 / 1024;
      console.log(`[deepdive-media] downloaded ${videoId}: ${p.width}×${p.height}, ${p.duration.toFixed(0)}s, ${mb.toFixed(1)} MB ≈ $${(mb * APIFY_USD_PER_MB).toFixed(3)} Apify, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return { file, ...p };
    } catch (err) {
      fs.rmSync(part, { force: true });
      console.warn(`[deepdive-media] fetching the file for ${videoId} failed:`, err);
      return null;
    }
  });
}

/* ── 2. analysing it into clip candidates ─────────────────────────────────── */

/** Scene cut times (s) — ffmpeg's scene score on a 5 fps, 320px proxy. */
async function sceneCuts(file: string): Promise<number[]> {
  const { stdout } = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-v", "error", "-i", file, "-an", "-sn",
    "-vf", "fps=5,scale=320:-2,select=gt(scene\\,0.3),metadata=print:file=-",
    "-f", "null", "-",
  ], { timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  const cuts: number[] = [];
  for (const m of stdout.matchAll(/pts_time:([0-9.]+)/g)) cuts.push(Number(m[1]));
  return cuts.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

/**
 * Shots → windows of MIN–MAX seconds. Tiny shots are merged into the window
 * being built; a window still short at the end joins its predecessor; long
 * static shots are split into equal parts. Pure: exported for the unit test.
 */
export function buildWindows(cuts: number[], duration: number, min = 3, max = 12): { start: number; end: number }[] {
  const bounds = [0, ...cuts.filter((t) => t > 0.2 && t < duration - 0.2), duration];
  const shots: { start: number; end: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1] - bounds[i] > 0.05) shots.push({ start: bounds[i], end: bounds[i + 1] });

  const merged: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (const s of shots) {
    if (!cur) { cur = { ...s }; continue; }
    const curLen = cur.end - cur.start;
    const sLen = s.end - s.start;
    // Keep growing a window that is still too short — or swallow a tiny shot —
    // as long as the result does not overshoot the max.
    if ((curLen < min || sLen < min * 0.5) && s.end - cur.start <= max) cur.end = s.end;
    else { merged.push(cur); cur = { ...s }; }
  }
  if (cur) merged.push(cur);
  // A short window: join a neighbour if that fits, else keep it if it is usable.
  const fixed: { start: number; end: number }[] = [];
  for (const w of merged) {
    const prev = fixed[fixed.length - 1];
    if (w.end - w.start < min && prev && w.end - prev.start <= max) prev.end = w.end;
    else fixed.push({ ...w });
  }
  if (fixed.length > 1 && fixed[0].end - fixed[0].start < min && fixed[1].end - fixed[0].start <= max) {
    fixed[1].start = fixed[0].start;
    fixed.shift();
  }
  const out: { start: number; end: number }[] = [];
  for (const w of fixed) {
    const len = w.end - w.start;
    if (len < 1.5) continue;
    if (len <= max) { out.push(w); continue; }
    const n = Math.ceil(len / (max * 0.75)); // ~9s pieces from a long static shot
    const step = len / n;
    for (let k = 0; k < n; k++) out.push({ start: w.start + k * step, end: k === n - 1 ? w.end : w.start + (k + 1) * step });
  }
  return out.map((w) => ({ start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 }));
}

const KINDS: ClipKind[] = ["ui", "product", "people", "logo", "other"];
const analyzeInflight = new Map<string, Promise<ClipCandidate[]>>();

/**
 * The video's windows, labelled and scored as muted demo clips, in time order.
 * Cached at _videos/<id>.clips.json (keyed by ANALYZE_ALGO); not cached when a
 * vision batch failed, so a retry fills the gap.
 */
export function analyzeVideo(videoId: string, meta: { title: string; channel: string }): Promise<ClipCandidate[]> {
  if (!YT_ID_RE.test(videoId)) return Promise.resolve([]);
  return once(analyzeInflight, videoId, async () => {
    const dir = videoCacheDir();
    const cacheFile = path.join(dir, `${videoId}.clips.json`);
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (c?.algo === ANALYZE_ALGO && Array.isArray(c.clips) && c.clips.every((x: ClipCandidate) => fs.existsSync(x.frame))) return c.clips as ClipCandidate[];
    } catch { /* no cache */ }

    const v = await ensureVideoFile(videoId);
    if (!v) return [];
    const t0 = Date.now();
    const cuts = await sceneCuts(v.file);
    const windows = buildWindows(cuts, v.duration);

    const framesDir = path.join(dir, `${videoId}.frames`);
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    const frames: string[] = windows.map((_, i) => path.join(framesDir, `w${String(i).padStart(3, "0")}.jpg`));
    for (let i = 0; i < windows.length; i += 4) {
      await Promise.all(windows.slice(i, i + 4).map((w, k) => run("ffmpeg", [
        "-hide_banner", "-v", "error", "-y", "-ss", ((w.start + w.end) / 2).toFixed(2), "-i", v.file,
        "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", frames[i + k],
      ], { timeout: 60_000 })));
    }

    const labels: ({ kind: ClipKind; description: string; score: number } | null)[] = Array(windows.length).fill(null);
    let failed = false;
    const BATCH = 12;
    for (let i = 0; i < windows.length; i += BATCH) {
      const batch = windows.slice(i, i + BATCH);
      try {
        const images = await Promise.all(batch.map(async (w, k) => ({
          label: `Window ${k + 1} (${fmt(w.start)}–${fmt(w.end)}, ${(w.end - w.start).toFixed(1)}s, middle frame):`,
          mediaType: "image/jpeg" as const,
          data: (await sharp(frames[i + k]).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer()).toString("base64"),
        })));
        const raw = await claudeVisionLabeledJSON({
          purpose: "news-deepdive-research",
          system: "You cut official launch videos into short MUTED demo clips for a live AI-news presentation. Answer in JSON only.",
          userText: `VIDEO: "${meta.title}" by ${meta.channel}

Each image is the middle frame of one window of this video. The clip will play MUTED behind a presenter who explains it, so the picture alone must show something.

For each window give:
- "kind": "ui" (software on a screen being used: an app, chat, browser, slides on a monitor, a phone screen), "product" (the hardware/device/product itself, or a product shot), "people" (a person talking to camera or people with no product visible), "logo" (title card, wordmark, logo, end card, mostly text on a plain background), "other".
- "what": one concrete sentence naming what is on screen (e.g. "ChatGPT sidebar with three agent dots, one opening a browser window"). Never guess beyond what is visible.
- "score": 0–1, how good this window is as a muted demo clip. High (0.7–1) = the product or UI visibly doing something, readable without narration. Medium (0.4–0.6) = a product shot or a screen that is only partly readable. Low (0–0.3) = talking heads, logos/title cards, b-roll that means nothing muted.

Reply ONLY with: {"items":[{"n":1,"kind":"ui","what":"...","score":0.8}]}`,
          images,
        });
        const j = parseJson(raw);
        for (const it of Array.isArray(j.items) ? j.items : []) {
          const k = Number(it?.n) - 1;
          if (k < 0 || k >= batch.length) continue;
          const kind = KINDS.includes(it.kind) ? (it.kind as ClipKind) : "other";
          const score = Math.max(0, Math.min(1, Number(it.score) || 0));
          labels[i + k] = { kind, description: String(it.what || "").slice(0, 240), score };
        }
        if (batch.some((_, k) => !labels[i + k])) failed = true;
      } catch (err) {
        failed = true;
        console.warn(`[deepdive-media] vision labelling failed for windows ${i + 1}–${i + batch.length} of ${videoId}:`, err);
      }
    }

    const clips: ClipCandidate[] = windows.map((w, i) => ({
      start: w.start,
      end: w.end,
      kind: labels[i]?.kind ?? "other",
      description: labels[i]?.description ?? "",
      score: labels[i]?.score ?? 0,
      frame: frames[i],
    }));
    if (!failed) fs.writeFileSync(cacheFile, JSON.stringify({ algo: ANALYZE_ALGO, videoId, at: new Date().toISOString(), cuts, clips }, null, 1));
    console.log(`[deepdive-media] analysed ${videoId}: ${cuts.length} cuts → ${clips.length} windows, ${clips.filter((c) => c.score >= 0.6).length} good demo windows, ${((Date.now() - t0) / 1000).toFixed(0)}s${failed ? " (a vision batch failed — not cached)" : ""}`);
    return clips;
  });
}

/* ── 3. cutting a clip ────────────────────────────────────────────────────── */

const cutInflight = new Map<string, Promise<ClipAsset>>();

/**
 * [start, end] of the video as a muted H.264 mp4 + a full-res poster jpg in
 * the dive's asset dir. Idempotent: the name is a hash of videoId+start+end.
 */
export function cutClip(diveId: string, videoId: string, start: number, end: number, description?: string): Promise<ClipAsset> {
  if (!DIVE_RE.test(diveId)) return Promise.reject(new Error("bad dive id"));
  if (!YT_ID_RE.test(videoId)) return Promise.reject(new Error("bad video id"));
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0)) return Promise.reject(new Error("bad clip range"));
  const s = Math.round(start * 100) / 100;
  const e = Math.round(end * 100) / 100;
  const id = hash(`${videoId}:${s.toFixed(2)}:${e.toFixed(2)}`);
  return once(cutInflight, `${diveId}:${id}`, async () => {
    const dir = assetDir(diveId);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${id}.mp4`;
    const poster = `${id}.jpg`;
    const full = path.join(dir, file);
    const posterFull = path.join(dir, poster);
    const done = async (): Promise<ClipAsset | null> => {
      if (!fs.existsSync(full) || !fs.existsSync(posterFull)) return null;
      const p = await probe(full);
      return p ? { id, file, poster, width: p.width, height: p.height, start: s, end: e, videoId, ...(description ? { description } : {}) } : null;
    };
    const cached = await done();
    if (cached) return cached;

    const v = await ensureVideoFile(videoId);
    if (!v) throw new Error(`source video ${videoId} is not available`);
    const endC = Math.min(e, v.duration);
    if (endC - s < 0.5) throw new Error("clip range is outside the video");

    // Two-stage seek: a fast input seek to ~3s before, then a frame-accurate
    // output seek for the rest (decoding only those 3s).
    const pre = Math.max(0, s - 3);
    const tmp = path.join(dir, `.${id}.part.mp4`);
    try {
      await run("ffmpeg", [
        "-hide_banner", "-v", "error", "-y",
        "-ss", pre.toFixed(3), "-i", v.file,
        "-ss", (s - pre).toFixed(3), "-t", (endC - s).toFixed(3),
        "-map", "0:v:0", "-an", "-sn", "-dn",
        "-vf", "scale='min(1920,iw)':-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        tmp,
      ], { timeout: 10 * 60_000 });
      fs.renameSync(tmp, full);
      await run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", full, "-frames:v", "1", "-q:v", "2", posterFull], { timeout: 60_000 });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const out = await done();
    if (!out) throw new Error("clip cut produced no playable file");
    return out;
  });
}

/* ── 4. capturing a release page ──────────────────────────────────────────── */

export async function loadPuppeteer(): Promise<any> {
  const mod: any = await import("puppeteer-core");
  return mod?.default ?? mod;
}

export const FAILED_PAGE_RE = /couldn['’]t load|could not be loaded|access denied|just a moment|attention required|verify you are human|are you a robot|enable javascript and cookies|request blocked|403 forbidden|404 not found|page not found/i;

// Page-side scripts are strings: the server's tsconfig has no DOM lib.
export const STEALTH_SCRIPT = `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; else if (!window.chrome.runtime) window.chrome.runtime = {}; } catch (e) {}
})();`;

export const DISMISS_COOKIES = `(() => {
  const re = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|reject( all)?|decline|only necessary|necessary only|continue|close)$/i;
  let n = 0;
  for (const el of document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"]')) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    if (t && t.length < 40 && re.test(t)) {
      const box = el.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[role="dialog"],[aria-modal="true"]');
      if (box || /accept|cookie|reject|necessary/i.test(t)) { try { el.click(); n++; } catch (e) {} }
    }
    if (n >= 2) break;
  }
  for (const el of document.querySelectorAll('[id*="cookie" i],[class*="cookie-banner" i],[id*="consent" i],[class*="consent" i],#onetrust-banner-sdk,#onetrust-consent-sdk,.cc-window')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') el.style.setProperty('display', 'none', 'important');
  }
  return n;
})()`;

const PREPARE_PAGE = `(() => {
  for (const v of document.querySelectorAll('video')) { try { v.pause(); v.autoplay = false; } catch (e) {} }
  const vh = innerHeight, vw = innerWidth;
  let hidden = 0, unstuck = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'sticky') { el.style.setProperty('position', 'static', 'important'); unstuck++; }
    else if (cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      // A fixed full-screen wrapper can hold the whole article: never blank it.
      if (r.width * r.height > vw * vh * 0.6) el.style.setProperty('position', 'absolute', 'important');
      else { el.style.setProperty('visibility', 'hidden', 'important'); hidden++; }
    }
  }
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  return { hidden, unstuck };
})()`;

const READ_PAGE = `((maxH) => {
  const meta = (p) => (document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"]') || {}).content || '';
  const sy = scrollY, sx = scrollX;
  const blocks = [];
  for (const el of document.querySelectorAll('h1,h2,h3,p,li,blockquote,figure,img,video')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const y = r.top + sy;
    if (y >= maxH) continue;
    const tag = el.tagName.toLowerCase();
    let text = '';
    if (tag === 'img') text = el.alt || '';
    else if (tag === 'video') text = el.getAttribute('aria-label') || el.title || '';
    else if (tag === 'figure') text = ((el.querySelector('figcaption') || {}).innerText || (el.querySelector('img') || {}).alt || '');
    else text = el.innerText || '';
    text = text.replace(/\\s+/g, ' ').trim().slice(0, 400);
    if (!text && !['img', 'video', 'figure'].includes(tag)) continue;
    if (tag === 'img' && (r.width < 80 || r.height < 60)) continue;
    blocks.push({ tag, text, x: Math.round(r.left + sx), y: Math.round(y), w: Math.round(r.width), h: Math.round(Math.min(r.height, maxH - y)) });
    if (blocks.length >= 800) break;
  }
  return {
    title: (meta('og:title') || document.title || '').trim(),
    docTitle: document.title || '',
    site: (meta('og:site_name') || location.hostname.replace(/^www\\./, '')).trim(),
    text: (document.body && document.body.innerText || '').slice(0, 20000),
    height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    blocks,
  };
})`;

const pageInflight = new Map<string, Promise<PageAsset | null>>();
let browserQueue: Promise<unknown> = Promise.resolve();

/** One Chromium at a time: a 2× 30k-px page is heavy. */
export function serialBrowser<T>(work: () => Promise<T>): Promise<T> {
  const p = browserQueue.then(work, work);
  browserQueue = p.catch(() => undefined);
  return p;
}

/**
 * The page as a 2× full-page showcase: JPEG tiles (≤2400 CSS px each) and the
 * boxes of its headings, paragraphs, list items, quotes and media. Null when
 * the page is a block/challenge page or has almost no text. Cached per dive+url.
 */
export function capturePage(diveId: string, url: string): Promise<PageAsset | null> {
  if (!DIVE_RE.test(diveId)) return Promise.resolve(null);
  try { if (!/^https?:$/.test(new URL(url).protocol)) return Promise.resolve(null); } catch { return Promise.resolve(null); }
  const id = hash(url);
  return once(pageInflight, `${diveId}:${id}`, async () => {
    const dir = assetDir(diveId);
    fs.mkdirSync(dir, { recursive: true });
    const cacheFile = path.join(dir, `${id}.page.json`);
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as PageAsset;
      if (c?.url === url && c.tiles?.length && c.tiles.every((t) => fs.existsSync(path.join(dir, t.file)))) return c;
    } catch { /* no cache */ }
    return serialBrowser(() => capture(dir, id, url, cacheFile));
  });
}

async function capture(dir: string, id: string, url: string, cacheFile: string): Promise<PageAsset | null> {
  const t0 = Date.now();
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: process.env.DEEPDIVE_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
    defaultViewport: null,
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(STEALTH_SCRIPT);
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.setViewport({ width: PAGE_W, height: PAGE_VIEW_H, deviceScaleFactor: 2 });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => undefined);
    await sleep(1500);
    if (resp && resp.status() >= 400) { console.warn(`[deepdive-media] capture ${url}: HTTP ${resp.status()}`); return null; }

    await page.evaluate(DISMISS_COOKIES).catch(() => 0);
    await sleep(600);

    // Walk the page so lazy images and reveal-on-scroll blocks load.
    let height = Math.min(MAX_PAGE_CSS_H, Number(await page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) || 0);
    for (let y = 0; y < height; y += 700) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await sleep(220);
      if (y % 4200 === 0) height = Math.min(MAX_PAGE_CSS_H, Number(await page.evaluate("document.documentElement.scrollHeight")) || height);
    }
    await page.evaluate(`window.scrollTo(0, ${height})`);
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 10_000 }).catch(() => undefined);
    await page.evaluate("window.scrollTo(0, 0)");
    await sleep(500);
    await page.evaluate(PREPARE_PAGE).catch(() => undefined);
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => undefined);
    await sleep(800);

    const info: any = await page.evaluate(`${READ_PAGE}(${MAX_PAGE_CSS_H})`);
    const text = String(info.text || "");
    if (FAILED_PAGE_RE.test(String(info.docTitle || "")) || FAILED_PAGE_RE.test(text.slice(0, 600)) || text.replace(/\s+/g, " ").trim().length < 600) {
      console.warn(`[deepdive-media] capture ${url}: looks like a block/error page ("${String(info.docTitle).slice(0, 60)}", ${text.length} chars) — skipped.`);
      return null;
    }
    height = Math.max(PAGE_VIEW_H, Math.min(MAX_PAGE_CSS_H, Math.ceil(Number(info.height) || height)));

    // One full-page shot, then tiles. Clipped to the cap so a 100k-px feed
    // page can't run the box out of memory.
    const png: Buffer = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: PAGE_W, height }, captureBeyondViewport: true }));
    const meta = await sharp(png, { limitInputPixels: false }).metadata();
    const pxW = meta.width ?? PAGE_W * 2;
    const pxH = meta.height ?? height * 2;
    const scale = pxW / PAGE_W; // 2 unless Chromium refused the dpr
    const tiles: PageAsset["tiles"] = [];
    for (let y = 0, n = 0; y < height; y += TILE_CSS_H, n++) {
      const h = Math.min(TILE_CSS_H, height - y);
      const top = Math.round(y * scale);
      const ph = Math.min(Math.round(h * scale), pxH - top);
      if (ph <= 0) break;
      const file = `${id}-t${n}.jpg`;
      await sharp(png, { limitInputPixels: false })
        .extract({ left: 0, top, width: pxW, height: ph })
        .jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true })
        .toFile(path.join(dir, file));
      tiles.push({ file, y, h });
    }

    const asset: PageAsset = {
      id,
      url,
      title: String(info.title || "").slice(0, 200),
      site: String(info.site || "").slice(0, 80),
      width: PAGE_W,
      height,
      scale: 2,
      tiles,
      blocks: (info.blocks as any[]).filter((b) => b.y < height).map((b, i) => ({ i, tag: b.tag, text: b.text, x: b.x, y: b.y, w: b.w, h: b.h })),
    };
    fs.writeFileSync(cacheFile, JSON.stringify(asset));
    console.log(`[deepdive-media] captured ${url}: ${pxW}×${pxH}px (${PAGE_W}×${height} css), ${tiles.length} tiles, ${asset.blocks.length} blocks, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return asset;
  } catch (err) {
    console.warn(`[deepdive-media] capture ${url} failed:`, err);
    return null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/* ── 5. pointing at things in a screenshot ────────────────────────────────── */

/** Long edge of the copy the model sees. Measured 2026-10-02 on a 1920×1080
 *  ChatGPT+Gmail shot: PIXEL coords on a 1280px copy landed within ~10px of
 *  the truth; 0–1000 normalised coords were off by ~35% in x (Sonnet does not
 *  do normalised grids), and a 1568px copy came back ~7% shrunk. */
const LOCATE_EDGE = 1280;
/** A made-up ask ("the Slack logo" on a shot with no Slack) came back found
 *  at 0.70–0.95 confidence; real elements came back at ≥0.97. The "seen"
 *  self-check pulls the fakes down to ≤0.75, and this cuts them. */
const LOCATE_MIN_CONFIDENCE = 0.8;

/**
 * [x0,y0,x1,y1] in the SENT image's pixels → [x,y,w,h] in natural pixels,
 * padded by 4% of the box's own size per side (min 4px), clamped. Pure.
 */
export function toNaturalBox(b: number[], sentW: number, sentH: number, W: number, H: number, pad = 0.04): [number, number, number, number] | null {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => Number.isFinite(Number(n)))) return null;
  let [x0, y0, x1, y1] = b.map(Number);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const kx = W / sentW;
  const ky = H / sentH;
  x0 = Math.max(0, Math.min(sentW, x0)) * kx;
  x1 = Math.max(0, Math.min(sentW, x1)) * kx;
  y0 = Math.max(0, Math.min(sentH, y0)) * ky;
  y1 = Math.max(0, Math.min(sentH, y1)) * ky;
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const px = Math.max(4, (x1 - x0) * pad);
  const py = Math.max(4, (y1 - y0) * pad);
  const L = Math.max(0, Math.floor(x0 - px));
  const T = Math.max(0, Math.floor(y0 - py));
  const R = Math.min(W, Math.ceil(x1 + px));
  const B = Math.min(H, Math.ceil(y1 + py));
  return [L, T, R - L, B - T];
}

/**
 * One box per ask, in the image's NATURAL pixels as [x, y, w, h]; null where
 * the model can't find it or isn't confident.
 */
export async function locateRegions(absImagePath: string, asks: string[]): Promise<({ box: [number, number, number, number] } | null)[]> {
  if (!asks.length) return [];
  const meta = await sharp(absImagePath).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return asks.map(() => null);
  const { data, info } = await sharp(absImagePath)
    .resize({ width: LOCATE_EDGE, height: LOCATE_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  const sw = info.width;
  const sh = info.height;
  const list = asks.map((a, i) => `${i + 1}. ${a}`).join("\n");
  try {
    const raw = await claudeVisionLabeledJSON({
      purpose: "news-deepdive-research",
      system: "You locate UI elements in screenshots precisely. Answer in JSON only.",
      userText: `The screenshot above is ${sw}×${sh} pixels. Locate each item below.

${list}

For each item, first write "seen": a few words naming what is actually at that spot in the image (read its text/icon). Then decide: does it really match the item as described? Only then "found": true with a tight bounding box around exactly that element — the whole element and little else — in PIXEL coordinates of this ${sw}×${sh} image (0,0 = top-left), as [x0, y0, x1, y1]. If the item is not in the image, or only something similar is, "found": false — a wrong box is worse than none.
"confidence" 0–1.

Reply ONLY with: {"items":[{"n":1,"seen":"...","found":true,"confidence":0.9,"box":[x0,y0,x1,y1]}]}`,
      images: [{ label: "Screenshot:", mediaType: "image/jpeg", data: data.toString("base64") }],
    });
    const j = parseJson(raw);
    const out: ({ box: [number, number, number, number] } | null)[] = asks.map(() => null);
    for (const it of Array.isArray(j.items) ? j.items : []) {
      const k = Number(it?.n) - 1;
      if (k < 0 || k >= asks.length || it.found !== true || Number(it.confidence ?? 0) < LOCATE_MIN_CONFIDENCE) continue;
      const box = toNaturalBox(it.box, sw, sh, W, H);
      if (box) out[k] = { box };
    }
    return out;
  } catch (err) {
    console.warn("[deepdive-media] locateRegions failed:", err);
    return asks.map(() => null);
  }
}
