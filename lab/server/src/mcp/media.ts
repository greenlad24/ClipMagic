/**
 * A PUBLIC MCP server built on yt-dlp (Jake 2026-10-14: "another mcp for
 * ChatGPT" — the @kevinwatt/yt-dlp-mcp idea; then, same day: "what the mcp
 * needs to do is not download the video — download the THUMBNAIL of the video
 * and send it to ChatGPT as a file"). Tools: info, transcript (plain text /
 * SRT) and the THUMBNAIL — downloaded here and handed to ChatGPT as the image
 * itself in the tool result (Jake: "not a download link"). (Video/audio downloads were built first and
 * taken out at Jake's word — `runDownload` below is kept, unused, if he wants
 * them back.) Mounted outside the Lab's sign-in gate at:
 *
 *   POST https://<lab>/mcp/media/<token>                  MCP (streamable HTTP, JSON)
 *   GET  https://<lab>/mcp/media/<token>/files/<job>/<f>  a saved thumbnail (24 h)
 *
 * Why not run @kevinwatt/yt-dlp-mcp itself: it is a local stdio server that
 * saves into the machine's Downloads folder — ChatGPT can't reach that. This
 * runs the same yt-dlp here and hands back links.
 *
 * ⚠️ YOUTUBE BLOCKS THIS SERVER'S IP for video downloads ("Sign in to confirm
 * you're not a bot", tested 2026-10-14) while subtitles and TikTok work. So
 * for YouTube: video/audio fall back to the Lab's Apify downloader
 * (news/deepDiveMedia ensureVideoFile) and transcripts to the Lab's captions →
 * paid transcript chain (skool/videoLessons transcriptForVideo).
 *
 * Guards: the secret path token (DATA_DIR/mcp/media-token or MEDIA_MCP_TOKEN);
 * public http(s) URLs only (no private/loopback hosts) and yt-dlp's "generic"
 * extractor off, so it can't be pointed inside the network; 30 requests/min
 * per IP; 2 downloads at a time; 2 GB / 3 h per file; files deleted after 24 h
 * and the oldest first above 15 GB.
 */
import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { ensureVideoFile } from "../news/deepDiveMedia.js";
import { transcriptForVideo } from "../skool/videoLessons.js";
import { fetchTranscript } from "../scriptgen/videoResearch.js";

const PROTOCOL = "2025-06-18";
const ROOT = () => path.join(config.dataDir, "mcp-media");
const TTL_MS = 24 * 3600_000;
const MAX_TOTAL = 15 * 1024 ** 3;
const MAX_PARALLEL = 2;
const WAIT_MS = 45_000;
const PER_MINUTE = 30;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "https://lab.jakedaw.com").replace(/\/$/, "");

/* ── token, rate ──────────────────────────────────────────────────────────── */

const tokenFile = () => path.join(config.dataDir, "mcp", "media-token");
export function mcpMediaToken(): string {
  const env = (process.env.MEDIA_MCP_TOKEN || "").trim();
  if (env.length >= 24) return env;
  try { const t = fs.readFileSync(tokenFile(), "utf8").trim(); if (t.length >= 24) return t; } catch { /* make one */ }
  const t = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), t, { mode: 0o600 });
  return t;
}
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hits = new Map<string, number[]>();
function rateOk(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length <= PER_MINUTE;
}

/* ── URL safety ───────────────────────────────────────────────────────────── */

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateIp(v.slice(7));
}
async function safeUrl(raw: unknown): Promise<string> {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { throw new Error("Give a full link (https://…)."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Can't find ${host}.`);
  if (addrs.some(privateIp)) throw new Error("That address isn't on the public internet.");
  return u.toString();
}
const youtubeId = (url: string): string | null => /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url)?.[1] ?? null;

/* ── yt-dlp ───────────────────────────────────────────────────────────────── */

const BASE_ARGS = ["--no-playlist", "--no-warnings", "--use-extractors", "default,-generic", "--socket-timeout", "30", "--retries", "2"];

function ytdlp(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("yt-dlp", [...BASE_ARGS, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { if (out.length < 8_000_000) out += d; });
    p.stderr.on("data", (d) => { if (err.length < 200_000) err += d; });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, err }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: 1, out, err: String(e) }); });
  });
}
const botBlocked = (err: string) => /not a bot|Sign in to confirm|HTTP Error 429|This video is unavailable in your country/i.test(err);
const lastError = (err: string) => (err.split("\n").filter((l) => /ERROR/.test(l)).pop() ?? err.trim().split("\n").pop() ?? "failed").replace(/^ERROR:\s*/, "").slice(0, 300);

function ffmpeg(args: string[], timeoutMs = 20 * 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (c) => { clearTimeout(t); resolve(c === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

/* ── info + transcript ────────────────────────────────────────────────────── */

async function info(url: string) {
  const tmp = fs.mkdtempSync(path.join(ROOT(), ".info-"));
  try {
    const r = await ytdlp(["-J", "--skip-download", url], tmp, 90_000);
    if (r.code !== 0) throw new Error(botBlocked(r.err) ? "The site blocked this server for that link (YouTube does this for videos). Use the YouTube Data connector for a YouTube video's details." : lastError(r.err));
    const j = JSON.parse(r.out);
    const heights = [...new Set((j.formats ?? []).map((f: any) => f.height).filter(Boolean))].sort((a: any, b: any) => b - a);
    return {
      title: j.title, url: j.webpage_url ?? url, site: j.extractor_key, uploader: j.uploader ?? j.channel, channelUrl: j.channel_url ?? j.uploader_url,
      durationSeconds: j.duration ?? null, views: j.view_count ?? null, likes: j.like_count ?? null, comments: j.comment_count ?? null,
      uploadDate: j.upload_date ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6, 8)}` : null,
      description: String(j.description ?? "").slice(0, 2000), tags: (j.tags ?? []).slice(0, 25),
      subtitles: Object.keys(j.subtitles ?? {}).slice(0, 40), autoCaptions: Object.keys(j.automatic_captions ?? {}).filter((k: string) => !k.includes("-")).slice(0, 40),
      availableHeights: heights.slice(0, 10), thumbnail: j.thumbnail ?? null,
    };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** SRT → plain text: no numbers, no times, auto-caption roll-up repeats removed. */
function srtToText(srt: string): string {
  const lines: string[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n\n+/)) {
    const text = block.split("\n").filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const prev = lines[lines.length - 1] ?? "";
    if (text === prev || prev.endsWith(text)) continue;
    if (prev && text.startsWith(prev)) { lines[lines.length - 1] = text; continue; }
    lines.push(text);
  }
  // join, then break into readable paragraphs of ~6 sentences
  const sentences = lines.join(" ").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += 6) paras.push(sentences.slice(i, i + 6).join(" "));
  return paras.join("\n\n").trim();
}

async function transcript(url: string, lang: string, format: "text" | "srt") {
  const tmp = fs.mkdtempSync(path.join(ROOT(), ".subs-"));
  try {
    const l = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : "en";
    // the exact language and its "-orig" auto track only — `en.*` also pulls machine translations and gets rate-limited
    const langs = l === "en" ? "en,en-orig,en-US,en-GB" : `${l},${l}-orig`;
    const r = await ytdlp(["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs, "--convert-subs", "srt", "-o", "sub.%(ext)s", url], tmp, 120_000);
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".srt"));
    // a creator's own subtitles beat auto-captions: yt-dlp writes both as sub.<lang>.srt; prefer the shortest lang tag
    const pick = files.sort((a, b) => a.length - b.length)[0];
    if (pick) {
      const srt = fs.readFileSync(path.join(tmp, pick), "utf8");
      const text = srtToText(srt);
      return { source: "subtitles", language: pick.replace(/^sub\.|\.srt$/g, ""), format, transcript: (format === "srt" ? srt : text).slice(0, 150_000), truncated: (format === "srt" ? srt : text).length > 150_000, words: text.split(/\s+/).filter(Boolean).length };
    }
    const yid = youtubeId(url);
    if (yid) {
      // the Lab's chains: free captions → paid (cached), then Apify → RapidAPI
      const text = (await transcriptForVideo(yid).catch(() => "")) || (await fetchTranscript({ videoId: yid, title: "", channel: "", publishedAt: "", views: 0, seconds: 0, url } as any).catch(() => null)) || "";
      if (text) {
        const clean = text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, "").trim();
        return { source: "transcript service", language: "en", format: "text", note: format === "srt" ? "No subtitle file was available, so this is plain text without timings." : undefined, transcript: clean.slice(0, 150_000), truncated: clean.length > 150_000, words: clean.split(/\s+/).filter(Boolean).length };
      }
    }
    throw new Error(r.code !== 0 ? lastError(r.err) : `No ${l} subtitles or captions for this video.`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ── thumbnail ─────────────────────────────────────────────────────────────── */

const MAX_IMAGE = 8 * 1024 * 1024;
async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    await safeUrl(url);
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok || !/^image\//.test(r.headers.get("content-type") ?? "")) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 1000 && b.length <= MAX_IMAGE ? b : null;
  } catch { return null; }
}

/**
 * The video's thumbnail, best quality available, as a JPEG. YouTube: straight
 * from i.ytimg.com (maxres → sd → hq; no yt-dlp, so the server's bot block
 * doesn't matter). Anything else: the thumbnail list yt-dlp reads, widest first.
 */
async function thumbnail(url: string): Promise<{ jpeg: Buffer; width: number | null; height: number | null; title: string | null; source: string }> {
  const yid = youtubeId(url);
  let candidates: Array<{ url: string; w: number | null; h: number | null }> = [];
  let title: string | null = null;
  if (yid) {
    candidates = [["maxresdefault", 1280, 720], ["sddefault", 640, 480], ["hqdefault", 480, 360]].map(([n, w, h]) => ({ url: `https://i.ytimg.com/vi/${yid}/${n}.jpg`, w: w as number, h: h as number }));
  } else {
    const tmp = fs.mkdtempSync(path.join(ROOT(), ".thumb-"));
    try {
      const r = await ytdlp(["-J", "--skip-download", url], tmp, 90_000);
      if (r.code !== 0) throw new Error(botBlocked(r.err) ? "The site blocked this server for that link." : lastError(r.err));
      const j = JSON.parse(r.out);
      title = j.title ?? null;
      candidates = [...(j.thumbnails ?? [])].filter((t: any) => t?.url).sort((a: any, b: any) => (b.width ?? b.preference ?? 0) - (a.width ?? a.preference ?? 0)).map((t: any) => ({ url: t.url, w: t.width ?? null, h: t.height ?? null }));
      if (j.thumbnail && !candidates.some((c) => c.url === j.thumbnail)) candidates.unshift({ url: j.thumbnail, w: null, h: null });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  for (const c of candidates.slice(0, 6)) {
    const img = await fetchImage(c.url);
    if (!img) continue;
    const isJpeg = img[0] === 0xff && img[1] === 0xd8;
    if (isJpeg) return { jpeg: img, width: c.w, height: c.h, title, source: c.url };
    // webp / png / avif → JPEG (what ChatGPT handles everywhere)
    const tmp = fs.mkdtempSync(path.join(ROOT(), ".conv-"));
    try {
      fs.writeFileSync(path.join(tmp, "in"), img);
      if (await ffmpeg(["-i", path.join(tmp, "in"), "-q:v", "2", path.join(tmp, "out.jpg")], 60_000)) return { jpeg: fs.readFileSync(path.join(tmp, "out.jpg")), width: c.w, height: c.h, title, source: c.url };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  throw new Error("Couldn't get a thumbnail for that video.");
}

/** Saved for 24 h next to the downloads so ChatGPT also gets a link it can hand over. */
function saveThumb(jpeg: Buffer, name: string): { id: string; file: string } {
  const id = crypto.randomBytes(9).toString("base64url");
  const file = `${name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "thumbnail"}.jpg`;
  fs.mkdirSync(path.join(ROOT(), id), { recursive: true });
  fs.writeFileSync(path.join(ROOT(), id, file), jpeg);
  return { id, file };
}

/* ── downloads (jobs) — not offered as tools any more (Jake 2026-10-14) ───── */

interface Job { id: string; kind: "video" | "audio"; url: string; status: "queued" | "downloading" | "done" | "failed"; file?: string; size?: number; error?: string; note?: string; createdAt: number; done: Promise<void> }
const jobs = new Map<string, Job>();
let active = 0;
const waiting: Array<() => void> = [];
const slot = () => new Promise<void>((r) => { if (active < MAX_PARALLEL) { active++; r(); } else waiting.push(() => { active++; r(); }); });
const release = () => { active--; waiting.shift()?.(); };

function linkFor(token: string, j: Job): string | null {
  return j.file ? `${PUBLIC_BASE}/mcp/media/${token}/files/${j.id}/${encodeURIComponent(j.file)}` : null;
}
function jobOut(token: string, j: Job) {
  return { jobId: j.id, kind: j.kind, status: j.status, downloadUrl: j.status === "done" ? linkFor(token, j) : null, file: j.file ?? null, sizeMB: j.size ? Math.round(j.size / 1048576 * 10) / 10 : null, expiresAt: new Date(j.createdAt + TTL_MS).toISOString(), note: j.note, error: j.error };
}

async function runDownload(j: Job, maxHeight: number, audioFormat: "mp3" | "m4a"): Promise<void> {
  await slot();
  const dir = path.join(ROOT(), j.id);
  fs.mkdirSync(dir, { recursive: true });
  j.status = "downloading";
  try {
    const out = "%(title).70B [%(id)s].%(ext)s";
    const args = j.kind === "video"
      ? ["-f", `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`, "--merge-output-format", "mp4", "--max-filesize", "2G", "--match-filter", "duration < 10800", "--restrict-filenames", "-o", out, j.url]
      : ["-f", "ba/b", "-x", "--audio-format", audioFormat, "--max-filesize", "2G", "--match-filter", "duration < 10800", "--restrict-filenames", "-o", out, j.url];
    const r = await ytdlp(args, dir, 40 * 60_000);
    let file = fs.readdirSync(dir).find((f) => !f.endsWith(".part") && !f.endsWith(".ytdl") && /\.(mp4|mkv|webm|mp3|m4a|opus)$/i.test(f));
    // YouTube blocks this server for downloads: the Lab's Apify downloader
    if (!file && botBlocked(r.err)) {
      const yid = youtubeId(j.url);
      if (!yid) throw new Error("The site blocked this server for that link.");
      j.note = "YouTube blocked a direct download, so it came through the Lab's backup downloader (its own resolution choice).";
      const v = await ensureVideoFile(yid);
      if (!v) throw new Error("YouTube blocked this server and the backup downloader couldn't get it either.");
      if (j.kind === "video") {
        file = `youtube_${yid}.mp4`;
        fs.copyFileSync(v.file, path.join(dir, file));
      } else {
        file = `youtube_${yid}.${audioFormat}`;
        const ok = await ffmpeg(["-i", v.file, "-vn", ...(audioFormat === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"] : ["-c:a", "aac", "-b:a", "192k"]), path.join(dir, file)]);
        if (!ok) throw new Error("Couldn't take the audio out of the backup download.");
      }
    }
    if (!file) throw new Error(/does not pass filter/.test(r.out + r.err) ? "Longer than 3 hours — too long for this connector." : /larger than max-filesize|File is larger/.test(r.out + r.err) ? "Bigger than 2 GB — pick a lower resolution." : lastError(r.err));
    j.file = file;
    j.size = fs.statSync(path.join(dir, file)).size;
    j.status = "done";
  } catch (e) {
    j.status = "failed";
    j.error = e instanceof Error ? e.message : String(e);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    release();
  }
}

function startDownload(kind: Job["kind"], url: string, maxHeight: number, audioFormat: "mp3" | "m4a"): Job {
  const id = crypto.randomBytes(9).toString("base64url");
  const j: Job = { id, kind, url, status: "queued", createdAt: Date.now(), done: Promise.resolve() };
  j.done = runDownload(j, maxHeight, audioFormat);
  jobs.set(id, j);
  return j;
}

/** Up to WAIT_MS for the download; else hand back the job to poll. */
async function settle(token: string, j: Job) {
  await Promise.race([j.done, new Promise((r) => setTimeout(r, WAIT_MS))]);
  const out = jobOut(token, j);
  if (j.status === "failed") throw new Error(j.error ?? "Download failed.");
  return j.status === "done" ? out : { ...out, message: "Still downloading — call media_download_status with this jobId in a minute." };
}

/* ── housekeeping: 24 h, 15 GB ────────────────────────────────────────────── */

function sweep(): void {
  try {
    fs.mkdirSync(ROOT(), { recursive: true });
    const dirs = fs.readdirSync(ROOT()).map((d) => { const p = path.join(ROOT(), d); const st = fs.statSync(p); return { d, p, t: st.mtimeMs, size: dirSize(p) }; });
    let total = dirs.reduce((a, x) => a + x.size, 0);
    for (const x of dirs.sort((a, b) => a.t - b.t)) {
      const running = jobs.get(x.d)?.status === "downloading";
      if (running) continue;
      if (Date.now() - x.t > TTL_MS || total > MAX_TOTAL || x.d.startsWith(".")) {
        fs.rmSync(x.p, { recursive: true, force: true });
        total -= x.size;
        jobs.delete(x.d);
      }
    }
  } catch (e) { console.warn("[mcp-media] sweep:", e); }
}
function dirSize(p: string): number {
  try { return fs.readdirSync(p).reduce((a, f) => { const s = fs.statSync(path.join(p, f)); return a + (s.isFile() ? s.size : 0); }, 0); } catch { return 0; }
}

/* ── tools ────────────────────────────────────────────────────────────────── */

interface Tool { name: string; title: string; description: string; inputSchema: any; run: (a: any, token: string) => Promise<unknown> }
const clamp = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d; };

const TOOLS: Tool[] = [
  {
    name: "media_info",
    title: "Video info",
    description: "Title, uploader, length, views, likes, upload date, description, tags and which subtitle languages exist — for a video on YouTube, TikTok, Instagram, Facebook, X, Vimeo and ~1,000 other sites. Nothing is downloaded.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The video's link" } }, required: ["url"] },
    run: async (a) => info(await safeUrl(a.url)),
  },
  {
    name: "media_transcript",
    title: "Transcript / subtitles",
    description: "A video's transcript: format \"text\" = a clean plain-text transcript (no timestamps, auto-caption repeats removed); \"srt\" = the subtitle file with timings. Uses the creator's subtitles, else auto-captions.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "The video's link" },
      language: { type: "string", description: "Language code, e.g. en, es, de", default: "en" },
      format: { type: "string", enum: ["text", "srt"], default: "text" },
    }, required: ["url"] },
    run: async (a) => transcript(await safeUrl(a.url), String(a.language ?? "en"), a.format === "srt" ? "srt" : "text"),
  },
  {
    name: "media_thumbnails",
    title: "Video thumbnails",
    description: "Give a JSON list of video links; get back every video's thumbnail as an image file (JPEG) in this result, each in the highest quality available (YouTube up to 1280×720). Up to 20 videos per call. Works for YouTube, TikTok, Instagram, Facebook, X, Vimeo and more. A video that fails is reported and the rest still come back.",
    inputSchema: { type: "object", properties: {
      videos: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "The videos' links, e.g. [\"https://www.youtube.com/watch?v=…\", \"https://www.tiktok.com/@…/video/…\"]" },
    }, required: ["videos"] },
    run: async (a) => {
      // Jake 2026-10-14: "a list of videos to scrape the image from using JSON and in return all of those images as files
      // (the highest quality of them)" — and "not a download link — actually downloading the image and handing it to chatgpt"
      let list: unknown = a.videos ?? a.urls ?? a.url;
      if (typeof list === "string") { try { list = JSON.parse(list); } catch { list = [list]; } }
      const urls = [...new Set((Array.isArray(list) ? list : [list]).map((x: any) => String(typeof x === "object" && x ? x.url ?? "" : x ?? "").trim()).filter(Boolean))];
      if (!urls.length) throw new Error("Give a list of video links.");
      if (urls.length > 20) throw new Error(`${urls.length} links — 20 per call at most; split the list.`);
      const results: Array<{ url: string; ok: boolean; title?: string | null; width?: number | null; height?: number | null; sizeKB?: number; error?: string; jpeg?: Buffer }> = new Array(urls.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
        for (let i = next++; i < urls.length; i = next++) {
          try {
            const t = await thumbnail(await safeUrl(urls[i]));
            results[i] = { url: urls[i], ok: true, title: t.title, width: t.width, height: t.height, sizeKB: Math.round(t.jpeg.length / 1024), jpeg: t.jpeg };
          } catch (e) {
            results[i] = { url: urls[i], ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
      }));
      const summary = { requested: urls.length, returned: results.filter((r) => r.ok).length, videos: results.map((r, i) => ({ n: i + 1, url: r.url, ok: r.ok, title: r.title ?? undefined, width: r.width ?? undefined, height: r.height ?? undefined, sizeKB: r.sizeKB, error: r.error })) };
      if (!summary.returned) throw new Error(`No thumbnails: ${results.map((r) => `${r.url} — ${r.error}`).join("; ")}`);
      // the images themselves ride in the result, in the list's order, each preceded by which video it is
      const content: any[] = [{ type: "text", text: JSON.stringify(summary) }];
      results.forEach((r, i) => {
        if (!r.ok || !r.jpeg) return;
        content.push({ type: "text", text: `Thumbnail ${i + 1}: ${r.url}${r.width ? ` (${r.width}×${r.height})` : ""}` });
        content.push({ type: "image", data: r.jpeg.toString("base64"), mimeType: "image/jpeg" });
      });
      return { __content: content, __structured: summary };
    },
  },
];

/* ── JSON-RPC + routes ────────────────────────────────────────────────────── */

async function handle(msg: any, token: string): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  if (id === undefined) return null;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "video-tools", title: "Video thumbnails & transcripts (yt-dlp)", version: "1.1.0" },
        instructions: "Video tools for YouTube, TikTok, Instagram, Facebook, X, Vimeo and many more: media_thumbnails takes a JSON list of video links and returns every thumbnail as an image file (highest quality), media_transcript a clean plain-text transcript or SRT subtitles, media_info the details. Nothing is downloaded but the thumbnail.",
      });
    case "ping": return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const out: any = await tool.run(msg.params?.arguments ?? {}, token);
        if (out && Array.isArray(out.__content)) return reply({ content: out.__content, structuredContent: out.__structured, isError: false });
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export function mediaMcpRouter() {
  fs.mkdirSync(ROOT(), { recursive: true });
  sweep();
  setInterval(sweep, 3600_000).unref();
  const r = express.Router();
  const ok = (req: Request) => {
    const t = mcpMediaToken();
    const p = String(req.params.token ?? "");
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    return (p && same(p, t)) || (bearer && same(bearer, t));
  };
  r.get("/:token/files/:job/:file", (req: Request, res: Response) => {
    if (!ok(req)) { res.status(404).end(); return; }
    const job = String(req.params.job).replace(/[^\w-]/g, "");
    const file = path.basename(String(req.params.file));
    const p = path.join(ROOT(), job, file);
    if (!job || !fs.existsSync(p)) { res.status(404).send("This download has expired or doesn't exist."); return; }
    res.download(p, file);
  });
  r.post("/:token", express.json({ limit: "256kb" }), async (req: Request, res: Response) => {
    if (!ok(req)) { res.status(404).end(); return; }
    if (!rateOk(req.ip ?? "?")) { res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests — wait a minute." } }); return; }
    const token = mcpMediaToken();
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, token)))).filter(Boolean);
      if (!out.length) { res.status(202).end(); return; }
      res.json(out);
      return;
    }
    const out = await handle(body, token);
    if (!out) { res.status(202).end(); return; }
    res.json(out);
  });
  r.all("/:token", (req: Request, res: Response) => { if (!ok(req)) { res.status(404).end(); return; } res.status(405).set("Allow", "POST").end(); });
  r.all("*", (_req, res) => { res.status(404).end(); });
  return r;
}
