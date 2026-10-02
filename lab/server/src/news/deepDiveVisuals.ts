/**
 * Deep Dive — the VISUALS research step (Jake, 2026-10-01: "the presentation
 * should always include screenshots or gifs or video parts of the
 * demonstrations you're talking about — that should be part of the research").
 *
 * Gathers a pool of real visuals for the topic, then the outline assigns one to
 * each section by what it shows:
 *   - images + GIFs from the official announcement and the top tech articles
 *     (og:image, <img>, <picture>/srcset), downloaded and stored locally
 *   - short video files the official pages embed (<video>, og:video, JSON-LD)
 *   - CLIPS of the company's own YouTube video: its chapters, and the frames
 *     YouTube publishes at ~25/50/75% (i.ytimg.com/vi/<id>/maxres1-3.jpg)
 * Every candidate is LOOKED AT by Claude vision before it is kept: logos,
 * author headshots, stock photos, ads and unrelated art are dropped, and each
 * kept one gets a one-line description of what it actually shows — that line
 * is what the outline matches sections against.
 *
 * ⚠️ FILES ARE STORED, NOT HOTLINKED. A news CDN that refuses the Lab as a
 * referer — or deletes the image next week — must not blank a section on air.
 * They live in <dataDir>/news-deepdive/<dive id>/ and are served by the
 * signed-in route /api/news/dd-asset/<dive>/<file>. /data is ~82% full, so
 * images are re-encoded to ≤1920px JPEG and video files are capped.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { config } from "../config.js";
import { claudeVisionLabeledJSON } from "../ai/claude.js";
import { scanPage, youtubeInfo } from "./video.js";

const run = promisify(execFile);

export type VisualKind = "image" | "gif" | "video" | "clip";

export interface Visual {
  id: string;
  kind: VisualKind;
  /** Stored file name (image/gif/video), served at /api/news/dd-asset/<dive>/<file>. */
  file?: string;
  /** YouTube id + start second (clip). */
  videoId?: string;
  start?: number;
  width?: number;
  height?: number;
  /** What it shows, in one plain sentence (from the vision check). */
  description: string;
  /** Who published it (outlet / company / channel). */
  credit: string;
  sourceUrl: string;
}

export const assetDir = (diveId: string): string => path.join(config.dataDir, "news-deepdive", diveId);
export const ASSET_FILE_RE = /^[a-f0-9]{16}\.(jpg|gif|mp4|webm)$/;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_POOL = 22;

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    return res.ok ? (await res.text()).slice(0, 3_000_000) : "";
  } catch { return ""; }
}

async function fetchBytes(url: string, referer: string, max: number): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: referer, Accept: "image/*,video/*,*/*" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!res.ok || !res.body) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len > max) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > max ? null : { buf, type: res.headers.get("content-type") || "" };
  } catch { return null; }
}

/* ── candidates from pages ────────────────────────────────────────────────── */

/** URLs that are never the thing itself. */
const JUNK = /(logo|icon|favicon|avatar|author|headshot|byline|profile|badge|emoji|sprite|pixel|tracking|spacer|blank|placeholder|\/ads?\/|advert|banner-ad|newsletter|subscribe|social|share|twitter-card-default|default-og|apple-touch)/i;

interface ImgCand { url: string; alt: string; page: string; credit: string; og: boolean }

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "").trim() : "";
}

/** The largest candidate in a srcset. */
function bestFromSrcset(srcset: string): string {
  let best = "";
  let bestW = 0;
  for (const part of srcset.split(",")) {
    const [u, w] = part.trim().split(/\s+/);
    const n = parseInt(w || "0", 10) || 1;
    if (u && n >= bestW) { best = u; bestW = n; }
  }
  return best;
}

function imagesOn(html: string, pageUrl: string, credit: string): ImgCand[] {
  const abs = (u: string) => { try { return new URL(u.replace(/&amp;/g, "&"), pageUrl).toString(); } catch { return ""; } };
  const out: ImgCand[] = [];
  const seen = new Set<string>();
  const add = (u: string, alt: string, og = false) => {
    const url = abs(u);
    if (!/^https?:\/\//.test(url) || /^data:/.test(u) || /\.svg(\?|$)/i.test(url) || JUNK.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, alt: alt.slice(0, 200), page: pageUrl, credit, og });
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*>/gi)) add(attr(m[0], "content"), "", true);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const w = parseInt(attr(tag, "width") || "0", 10);
    if (w && w < 400) continue; // declared small: an icon or a thumbnail
    const src = bestFromSrcset(attr(tag, "srcset") || attr(tag, "data-srcset")) || attr(tag, "data-src") || attr(tag, "data-lazy-src") || attr(tag, "src");
    if (src) add(src, attr(tag, "alt") || attr(tag, "title"));
  }
  for (const m of html.matchAll(/<source\b[^>]*srcset=[^>]*>/gi)) {
    const src = bestFromSrcset(attr(m[0], "srcset"));
    if (src && !/\.(mp4|webm)/i.test(src)) add(src, "");
  }
  return out.slice(0, 14);
}

/* ── storing ──────────────────────────────────────────────────────────────── */

interface Stored { visual: Omit<Visual, "id" | "description">; preview: Buffer }

async function storeImage(c: ImgCand, dir: string): Promise<Stored | null> {
  const got = await fetchBytes(c.url, c.page, MAX_IMAGE_BYTES);
  if (!got) return null;
  let meta: sharp.Metadata;
  try { meta = await sharp(got.buf, { animated: true }).metadata(); } catch { return null; }
  const w = meta.width ?? 0;
  const h = meta.pageHeight ?? meta.height ?? 0;
  if (w < 600 || h < 300) return null;           // too small to fill a section
  if (w / h > 3.2 || h / w > 1.6) return null;   // banners and tall phone shots read badly at 16:9
  const animated = (meta.pages ?? 1) > 1 && meta.format === "gif";
  const preview = await sharp(got.buf).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer().catch(() => null);
  if (!preview) return null;
  if (animated) {
    if (got.buf.length > 10 * 1024 * 1024) return null;
    const file = `${hash(c.url)}.gif`;
    fs.writeFileSync(path.join(dir, file), got.buf);
    return { visual: { kind: "gif", file, width: w, height: h, credit: c.credit, sourceUrl: c.page }, preview };
  }
  const file = `${hash(c.url)}.jpg`;
  await sharp(got.buf).resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(dir, file));
  return { visual: { kind: "image", file, width: w, height: h, credit: c.credit, sourceUrl: c.page }, preview };
}

async function storeVideoFile(url: string, page: string, credit: string, dir: string): Promise<Stored | null> {
  const got = await fetchBytes(url, page, MAX_VIDEO_BYTES);
  if (!got) return null;
  const ext = /webm/i.test(got.type) || /\.webm(\?|$)/i.test(url) ? "webm" : "mp4";
  const file = `${hash(url)}.${ext}`;
  const full = path.join(dir, file);
  fs.writeFileSync(full, got.buf);
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", full], { timeout: 20000 });
    const j = JSON.parse(stdout);
    const w = Number(j.streams?.[0]?.width ?? 0);
    const h = Number(j.streams?.[0]?.height ?? 0);
    const secs = Number(j.format?.duration ?? 0);
    if (w < 480 || h > w || secs < 2) { fs.rmSync(full, { force: true }); return null; }
    const frame = path.join(dir, `${hash(url)}-frame.jpg`);
    await run("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.min(secs * 0.3, 20)), "-i", full, "-frames:v", "1", "-vf", "scale=1024:-2", frame], { timeout: 30000 });
    const preview = fs.readFileSync(frame);
    fs.rmSync(frame, { force: true });
    return { visual: { kind: "video", file, width: w, height: h, credit, sourceUrl: page }, preview };
  } catch {
    fs.rmSync(full, { force: true });
    return null;
  }
}

/** "0:00 Intro / 1:23 Live demo" lines in a description → [seconds, label]. */
function chapters(description: string): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  for (const line of description.split("\n")) {
    const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—:]?\s*(.{3,80})$/.exec(line);
    if (m) out.push({ at: Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), label: m[4].trim() });
  }
  return out.length >= 2 ? out : [];
}

async function ytFrame(id: string, n: 1 | 2 | 3): Promise<Buffer | null> {
  for (const name of [`maxres${n}`, `hq${n}`]) {
    const got = await fetchBytes(`https://i.ytimg.com/vi/${id}/${name}.jpg`, "https://www.youtube.com/", 2 * 1024 * 1024);
    if (got && got.buf.length > 3000) return got.buf;
  }
  return null;
}

/** Clips of one YouTube video: its chapters (labelled) + the 25/50/75% frames (looked at). */
async function youtubeClips(videoId: string, credit: string): Promise<(Stored & { label?: string })[]> {
  const info = await youtubeInfo(videoId).catch(() => null);
  if (!info || info.seconds < 10) return [];
  const out: (Stored & { label?: string })[] = [];
  const quarter: [1 | 2 | 3, number][] = [[1, 0.25], [2, 0.5], [3, 0.75]];
  for (const [n, f] of quarter) {
    const buf = await ytFrame(videoId, n);
    if (!buf) continue;
    const preview = await sharp(buf).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer().catch(() => null);
    if (preview) out.push({ visual: { kind: "clip", videoId, start: Math.max(0, Math.round(info.seconds * f) - 2), credit: credit || info.channelTitle, sourceUrl: `https://www.youtube.com/watch?v=${videoId}` }, preview });
  }
  // Chapters have no frame we can fetch (the storyboard is blocked from this
  // server), so they ride on the nearest looked-at frame's verdict below.
  for (const c of chapters(info.description).slice(0, 8)) {
    out.push({ visual: { kind: "clip", videoId, start: c.at, credit: credit || info.channelTitle, sourceUrl: `https://www.youtube.com/watch?v=${videoId}&t=${c.at}` }, preview: Buffer.alloc(0), label: c.label });
  }
  return out;
}

/* ── the vision check ─────────────────────────────────────────────────────── */

async function judge(topic: string, items: Stored[]): Promise<({ keep: boolean; what: string } | null)[]> {
  const verdicts: ({ keep: boolean; what: string } | null)[] = Array(items.length).fill(null);
  const BATCH = 8;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      const raw = await claudeVisionLabeledJSON({
        purpose: "news-deepdive-research",
        system: "You pick visuals for a live AI-news presentation. Answer in JSON only.",
        userText: `TOPIC: ${topic}

Each image below is a candidate visual (a screenshot, photo, GIF frame or a frame from a video). For each, decide if it belongs on screen while the presenter talks about this topic.

KEEP (keep=true): the actual product, feature, app or device in use — UI screenshots, demo frames, the thing doing something, a real photo of the hardware/robot/people involved in the news, a chart or diagram from the source that explains it.
DROP (keep=false): logos and wordmarks on a plain background, author/reporter headshots, generic stock photos, ads, newsletter/promo art, unrelated images, blurry or mostly-text images that can't be read at a glance.

"what" = one concrete sentence of what it shows (e.g. "ChatGPT sidebar listing three dots, one opening its own browser window"). Never guess beyond what is visible.

Reply ONLY with: {"items":[{"n":1,"keep":true,"what":"..."}]}`,
        images: batch.map((b, j) => ({ label: `Image ${j + 1}:`, mediaType: "image/jpeg", data: b.preview.toString("base64") })),
      });
      const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      for (const it of Array.isArray(j.items) ? j.items : []) {
        const k = Number(it?.n) - 1;
        if (k >= 0 && k < batch.length) verdicts[i + k] = { keep: it.keep === true, what: String(it.what || "").slice(0, 200) };
      }
    } catch (err) {
      console.warn("[news-deepdive] visual check failed for a batch:", err);
    }
  }
  return verdicts;
}

/* ── the step ─────────────────────────────────────────────────────────────── */

export async function gatherVisuals(
  diveId: string,
  topic: string,
  sources: { url: string; outlet: string; title: string; official?: boolean }[],
  payoffVideoId: string | null,
  progress: (msg: string) => Promise<void>,
): Promise<Visual[]> {
  const dir = assetDir(diveId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Official pages first (that's where the real screenshots are), then tech press.
  const pages = [...sources.filter((x) => x.official), ...sources.filter((x) => !x.official)].slice(0, 8);
  await progress(`Collecting screenshots, GIFs and demo clips from ${pages.length} source page${pages.length === 1 ? "" : "s"}…`);

  const imgCands: ImgCand[] = [];
  const fileCands: { url: string; page: string; credit: string }[] = [];
  const ytIds = new Set<string>(payoffVideoId ? [payoffVideoId] : []);
  await Promise.all(pages.map(async (p) => {
    const html = await fetchText(p.url);
    if (!html) return;
    imgCands.push(...imagesOn(html, p.url, p.outlet));
    if (p.official) {
      const media = scanPage(html, p.url, true);
      for (const f of media.files.filter((f) => f.fromMarkup).slice(0, 3)) fileCands.push({ url: f.url, page: p.url, credit: p.outlet });
      for (const id of media.youtube.slice(0, 2)) ytIds.add(id);
    }
  }));

  // og:images first per page (the publisher's own pick), then the rest.
  const ordered = [...imgCands.filter((c) => c.og), ...imgCands.filter((c) => !c.og)].slice(0, 36);
  const stored: (Stored & { label?: string; alt?: string })[] = [];
  const seenFiles = new Set<string>();
  for (let i = 0; i < ordered.length; i += 6) {
    const got = await Promise.all(ordered.slice(i, i + 6).map((c) => storeImage(c, dir).then((s) => (s ? { ...s, alt: c.alt } : null)).catch(() => null)));
    for (const g of got) if (g && g.visual.file && !seenFiles.has(g.visual.file)) { seenFiles.add(g.visual.file); stored.push(g); }
  }
  for (const f of fileCands.slice(0, 4)) {
    const s = await storeVideoFile(f.url, f.page, f.credit, dir).catch(() => null);
    if (s) stored.push(s);
  }
  for (const id of [...ytIds].slice(0, 3)) stored.push(...await youtubeClips(id, ""));

  const looked = stored.filter((s) => s.preview.length > 0);
  await progress(`Looking at ${looked.length} candidate visuals to keep only real demos and screenshots…`);
  const verdicts = await judge(topic, looked);

  const pool: Visual[] = [];
  const keptFrames = new Map<string, number>(); // videoId → how many quarter frames were kept
  looked.forEach((s, i) => {
    const v = verdicts[i];
    if (!v?.keep) {
      if (s.visual.file) fs.rmSync(path.join(dir, s.visual.file), { force: true });
      return;
    }
    if (s.visual.kind === "clip" && s.visual.videoId) keptFrames.set(s.visual.videoId, (keptFrames.get(s.visual.videoId) ?? 0) + 1);
    pool.push({ ...s.visual, id: "", description: v.what || s.alt || "" });
  });
  // Chapters: kept when the same video's frames passed (so it is a visual
  // video, not a talking head) — described by their own label.
  for (const s of stored.filter((x) => x.preview.length === 0 && x.label)) {
    if ((keptFrames.get(s.visual.videoId ?? "") ?? 0) >= 2) pool.push({ ...s.visual, id: "", description: `Video chapter: ${s.label}` });
  }

  // Near-duplicates: outlets run the same wire photo in several crops, and the
  // first live pool held three "man on stage with bokeh dots" variants. Two
  // visuals whose descriptions open with the same seven words are one picture.
  const seenDesc = new Set<string>();
  const distinct = pool.filter((v) => {
    const k = v.description.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 7).join(" ");
    if (k && seenDesc.has(k)) { if (v.file) fs.rmSync(path.join(dir, v.file), { force: true }); return false; }
    seenDesc.add(k);
    return true;
  });
  const final = distinct.slice(0, MAX_POOL).map((v, i) => ({ ...v, id: `v${i + 1}` }));
  // Drop stored files that didn't make the pool.
  const used = new Set(final.map((v) => v.file).filter(Boolean));
  for (const f of fs.readdirSync(dir)) if (!used.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  await progress(`Visuals: ${final.length} kept (${final.filter((v) => v.kind === "image").length} screenshots/photos, ${final.filter((v) => v.kind === "gif").length} GIFs, ${final.filter((v) => v.kind === "video").length} video files, ${final.filter((v) => v.kind === "clip").length} video moments).`);
  return final;
}

export function removeAssets(diveId: string): void {
  fs.rmSync(assetDir(diveId), { recursive: true, force: true });
}
