/**
 * Get an edited narration video into a workable state.
 *
 * Two sources:
 *   descript — a share.descript.com link. yt-dlp cannot read these (the page is
 *              a JS app with no <video> source), but the HTML embeds short-lived
 *              signed GCS URLs for `original.mp4` AND `transcript.json`. The
 *              Descript transcript is word-level and comes from the actual edit,
 *              so it is preferred over re-transcribing.
 *   upload   — a file already on disk.
 *
 * Produces: video.mp4, audio.m4a (16k mono), words, duration.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { transcribeWithGroq } from "../ai/transcribe.js";
import type { NarrationWord } from "./narration.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
export const PLANNER_DIR = path.join(DATA_DIR, "planner");

export interface Ingested {
  dir: string;
  videoPath: string;
  audioPath: string;
  durationSec: number;
  words: NarrationWord[];
  /** Where the word timings came from — Descript's alignment or Groq Whisper. */
  wordSource: "descript" | "whisper";
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/** Pull the signed URL for a named artifact out of a Descript share page. */
function pickSigned(html: string, filename: string): string | null {
  const re = new RegExp(`https://[^"'\\s<>]*?/${filename}\\?[^"'\\s<>]+`, "g");
  // Signed URLs appear both raw and HTML-escaped; the raw one is shortest.
  const hits = [...new Set((html.match(re) || []).map((u) => u.replace(/&amp;/g, "&")))];
  return hits.sort((a, b) => a.length - b.length)[0] || null;
}

async function downloadTo(url: string, dest: string, onPct?: (p: number) => void): Promise<number> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const total = Number(r.headers.get("content-length") || 0);
  let seen = 0;
  let last = -1;
  const src = Readable.fromWeb(r.body as any);
  src.on("data", (c: Buffer) => {
    seen += c.length;
    if (total && onPct) {
      const p = Math.floor((seen / total) * 100);
      if (p !== last && p % 5 === 0) {
        last = p;
        onPct(p);
      }
    }
  });
  await pipeline(src, fs.createWriteStream(dest));
  return seen;
}

function probeDuration(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  const d = Number((r.stdout || "").trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("could not read video duration");
  return d;
}

function extractAudio(video: string, out: string): void {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", out],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`audio extraction failed: ${(r.stderr || "").slice(0, 200)}`);
}

/** Descript's transcript is one entry per word, already aligned to the edit. */
function wordsFromDescript(jsonPath: string): NarrationWord[] {
  const d = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  return (d.segments || [])
    .filter((s: any) => typeof s.startTime === "number" && String(s.body || "").trim())
    .map((s: any) => ({ w: String(s.body).trim(), start: s.startTime, end: s.endTime }));
}

export async function ingestNarration(opts: {
  runId: string;
  source: string;
  sourceKind: "descript" | "upload";
  onStage?: (label: string, progress: number) => void;
}): Promise<Ingested> {
  const dir = path.join(PLANNER_DIR, opts.runId);
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, "video.mp4");
  const audioPath = path.join(dir, "audio.m4a");
  let descriptTranscript: string | null = null;

  if (opts.sourceKind === "descript") {
    opts.onStage?.("Reading the Descript share page", 0.02);
    const html = await (await fetch(opts.source, { headers: { "user-agent": UA } })).text();
    const videoUrl = pickSigned(html, "original\\.mp4");
    if (!videoUrl) {
      throw new Error(
        "Could not find a downloadable media URL on that Descript page. Check the link is a share link and that sharing is enabled."
      );
    }
    const trUrl = pickSigned(html, "transcript\\.json");
    if (trUrl) {
      const t = await fetch(trUrl);
      if (t.ok) {
        descriptTranscript = path.join(dir, "descript-transcript.json");
        fs.writeFileSync(descriptTranscript, Buffer.from(await t.arrayBuffer()));
      }
    }
    opts.onStage?.("Downloading the narration", 0.05);
    await downloadTo(videoUrl, videoPath, (p) => opts.onStage?.(`Downloading the narration — ${p}%`, 0.05 + (p / 100) * 0.25));
  } else {
    if (!fs.existsSync(opts.source)) throw new Error(`uploaded file not found: ${opts.source}`);
    if (path.resolve(opts.source) !== path.resolve(videoPath)) fs.copyFileSync(opts.source, videoPath);
  }

  opts.onStage?.("Reading the video", 0.32);
  const durationSec = probeDuration(videoPath);

  opts.onStage?.("Extracting audio", 0.35);
  extractAudio(videoPath, audioPath);

  let words: NarrationWord[];
  let wordSource: "descript" | "whisper";
  if (descriptTranscript && fs.existsSync(descriptTranscript)) {
    words = wordsFromDescript(descriptTranscript);
    wordSource = "descript";
  } else {
    opts.onStage?.("Transcribing", 0.4);
    const tr = await transcribeWithGroq({
      data: fs.readFileSync(audioPath),
      name: "audio.m4a",
      type: "audio/m4a",
      wantWords: true,
    });
    words = (tr.words || []).map((w) => ({ w: String(w.word).trim(), start: w.start, end: w.end }));
    wordSource = "whisper";
  }
  if (!words.length) throw new Error("no word-level timings — cannot build the beat map");

  return { dir, videoPath, audioPath, durationSec, words, wordSource };
}
