/**
 * Transcription bridge for the Bulk Scheduler — turn a selected video into the
 * words actually spoken in it, so the caption engine can ground each platform's
 * copy in the REAL content instead of a typed brief.
 *
 * Flow (all graceful — NEVER throws; returns null on any miss so plan generation
 * keeps working):
 *   1. Resolve a LOCAL file for the source.
 *        - render / upload  → resolveLocalPath() (already on this server's disk).
 *        - cloud            → download the DIRECT url to a temp file (size-capped),
 *                             cleaned up in a finally.
 *   2. Extract a small mono 16kHz mp3 with ffmpeg (reuses the meme pipeline's
 *      extractAudioForTranscription helper — the same approach the existing
 *      transcription path uses) so Whisper stays under its size limit.
 *   3. Transcribe with Groq Whisper (no GROQ_API_KEY → null; empty text → null).
 *
 * The ffmpeg + transcribe + download calls are INJECTABLE so unit tests run with
 * NO ffmpeg binary and NO network.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { aiConfig } from "../ai/config.js";
import { extractAudioForTranscription } from "../render/cut.js";
import { transcribeWithGroq } from "../ai/transcribe.js";
import { resolveLocalPath, resolveSourceUrl, type FileSourceRef } from "./fileSources.js";

/** Cap on a cloud download we'll pull just to transcribe (bytes). ~200 MB. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** Default per-file transcription budget before we fall back to the brief (ms). */
const DEFAULT_TIMEOUT_MS = 90_000;

export interface TranscribeSourceResult {
  text: string;
  durationSec?: number;
}

/** Injectable seams so tests need no real ffmpeg / network / Groq key. */
export interface TranscribeSourceDeps {
  /** Resolve a render/upload source to a local absolute path (null = no file). */
  resolveLocal?: (src: FileSourceRef) => Promise<string | null>;
  /** Extract a small audio buffer from a local video for transcription. */
  extractAudio?: (
    srcPath: string,
  ) => Promise<{ buffer: Buffer; name: string; type: string }>;
  /** Transcribe an audio buffer → { text, duration }. */
  transcribe?: (opts: {
    data: Buffer;
    name: string;
    type: string;
    wantWords: boolean;
  }) => Promise<{ text: string; duration: number }>;
  /** Download a cloud direct-URL to a local temp file (returns its path or null). */
  downloadToTemp?: (url: string) => Promise<string | null>;
  /** True when transcription is even possible (Groq key present). */
  hasGroqKey?: () => boolean;
  /** Per-file timeout before falling back to the brief. */
  timeoutMs?: number;
}

/** Download a remote URL to a temp file, capped at MAX_DOWNLOAD_BYTES. */
async function defaultDownloadToTemp(url: string): Promise<string | null> {
  let dest: string | null = null;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) return null;
    const len = Number(res.headers.get("content-length") || "0");
    if (len && len > MAX_DOWNLOAD_BYTES) return null;

    fs.mkdirSync(config.tmpDir, { recursive: true });
    dest = path.join(config.tmpDir, `bulkdl_${randomUUID()}`);
    const out = fs.createWriteStream(dest);
    let written = 0;
    try {
      // Node 18+ fetch body is an async iterable of Uint8Array chunks.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.length;
        if (written > MAX_DOWNLOAD_BYTES) {
          out.destroy();
          fs.rmSync(dest, { force: true });
          return null;
        }
        out.write(chunk);
      }
    } finally {
      out.end();
    }
    return dest;
  } catch {
    if (dest) try { fs.rmSync(dest, { force: true }); } catch { /* */ }
    return null;
  }
}

/** Wrap a promise so it resolves to null after `ms` rather than hanging. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

/**
 * Transcribe a single source. Returns the trimmed transcript text + duration, or
 * null when transcription isn't possible/useful (missing key, no local file,
 * download/ffmpeg/transcription failure, no speech, or timeout). NEVER throws.
 */
export async function transcribeSource(
  source: FileSourceRef,
  deps: TranscribeSourceDeps = {},
): Promise<TranscribeSourceResult | null> {
  const {
    resolveLocal = resolveLocalPath,
    extractAudio = extractAudioForTranscription,
    transcribe = (o) => transcribeWithGroq({ ...o }),
    downloadToTemp = defaultDownloadToTemp,
    hasGroqKey = () => Boolean(aiConfig.groqApiKey),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  // No key → nothing to do; caller falls back to the brief.
  if (!hasGroqKey()) return null;

  return withTimeout(
    (async (): Promise<TranscribeSourceResult | null> => {
      let tempDownload: string | null = null;
      try {
        // 1) Get a local file path (download cloud links to a temp file).
        let localPath = await resolveLocal(source);
        if (!localPath && source.kind === "cloud") {
          const url = resolveSourceUrl(source);
          tempDownload = await downloadToTemp(url);
          localPath = tempDownload;
        }
        if (!localPath) return null;

        // 2) Extract a small audio track + 3) transcribe it.
        const audio = await extractAudio(localPath);
        const tr = await transcribe({
          data: audio.buffer,
          name: audio.name,
          type: audio.type,
          wantWords: false,
        });
        const text = (tr.text || "").trim();
        if (!text) return null; // no speech detected → fall back to the brief.
        return { text, durationSec: tr.duration || undefined };
      } catch {
        return null;
      } finally {
        if (tempDownload) try { fs.rmSync(tempDownload, { force: true }); } catch { /* */ }
      }
    })(),
    timeoutMs,
  );
}

/**
 * Cache transcriptions PER RESOLVED FILE within a single request so the same
 * video is never transcribed twice across multiple target platforms/channels.
 * Keyed by the source kind+ref. Construct one per preview() call.
 */
export function createTranscriptionCache(deps: TranscribeSourceDeps = {}) {
  const cache = new Map<string, Promise<TranscribeSourceResult | null>>();
  return {
    get(source: FileSourceRef): Promise<TranscribeSourceResult | null> {
      const key = `${source.kind}:${source.ref}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = transcribeSource(source, deps);
        cache.set(key, hit);
      }
      return hit;
    },
  };
}
