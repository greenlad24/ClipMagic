/**
 * Narration analysis — the beat map.
 *
 * The planner cannot place a cut well from sentence text alone. Jake's own rule
 * is that a screencast ends where "the finish of the sentence feels like here
 * it has to stop" — that feel is in the delivery, so we measure it:
 *
 *   PAUSES     from ffmpeg `silencedetect` on the waveform. Ground truth.
 *              NOT from word-timing gaps: aligners routinely set
 *              word.end === next.start straight through a real silence, which
 *              collapses a whole opening minute into one bogus "beat".
 *   EMPHASIS   per-word peak loudness vs the LOCAL median — absolute level
 *              drifts across a 14-minute take, so the comparison must be local.
 *   BEATS      speech runs bounded by real pauses; the natural cut units.
 */
import { spawnSync } from "node:child_process";
import type { Beat } from "./types.js";

export interface NarrationWord {
  w: string;
  start: number;
  end: number;
}

export interface BeatMap {
  beats: Beat[];
  pauseCount: number;
  /** Gap length at the 90th percentile — the "strong cut point" bar. */
  strongGap: number;
  /** Median gap, used as the bar for showing a pause at all. */
  medGap: number;
}

const SILENCE_DB = 30;
const MIN_SILENCE = 0.22;

/**
 * Detect real silences.
 *
 * `silencedetect` logs at INFO level, so `-v error` silently discards every
 * result and you get zero silences at any threshold. Keep the log level.
 */
export function detectSilences(audioPath: string): { start: number; end: number; dur: number }[] {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      audioPath,
      "-af",
      `silencedetect=n=-${SILENCE_DB}dB:d=${MIN_SILENCE}`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 }
  );
  const log = (r.stderr || "") + (r.stdout || "");
  const out: { start: number; end: number; dur: number }[] = [];
  let start: number | null = null;
  for (const line of log.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) {
      start = Number(s[1]);
      continue;
    }
    const e = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (e && start !== null) {
      out.push({ start: Math.max(0, start), end: Number(e[1]), dur: Number(e[2]) });
      start = null;
    }
  }
  return out;
}

/** Per-word peak loudness from a coarse amplitude envelope. */
function loudnessEnvelope(audioPath: string, hz = 50): number[] {
  const r = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      audioPath,
      "-af",
      `aresample=8000,asetnsamples=${8000 / hz}`,
      "-f",
      "u8",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-",
    ],
    { maxBuffer: 1 << 29 }
  );
  const pcm: Buffer = r.stdout || Buffer.alloc(0);
  const step = 8000 / hz;
  const env: number[] = [];
  for (let i = 0; i + step <= pcm.length; i += step) {
    let peak = 0;
    for (let k = 0; k < step; k++) peak = Math.max(peak, Math.abs(pcm[i + k] - 128));
    env.push(peak);
  }
  return env;
}

export function buildBeatMap(audioPath: string, words: NarrationWord[]): BeatMap {
  const sil = detectSilences(audioPath);
  if (!sil.length) {
    // Better to fall back than to emit one enormous beat covering the video.
    throw new Error(
      "No silences detected in the narration audio. Check the audio track and the silencedetect threshold."
    );
  }

  const hz = 50;
  const env = loudnessEnvelope(audioPath, hz);
  const loudAt = (a: number, b: number) => {
    let peak = 0;
    for (let i = Math.max(0, Math.floor(a * hz)); i < Math.min(env.length, Math.ceil(b * hz)); i++) {
      peak = Math.max(peak, env[i]);
    }
    return peak;
  };

  const enriched = words.map((w) => ({ ...w, loud: loudAt(w.start, w.end), rel: 1 }));
  const WIN = 20;
  for (let i = 0; i < enriched.length; i++) {
    const local = enriched
      .slice(Math.max(0, i - WIN), Math.min(enriched.length, i + WIN))
      .map((x) => x.loud)
      .sort((a, b) => a - b);
    enriched[i].rel = +(enriched[i].loud / (local[Math.floor(local.length / 2)] || 1)).toFixed(2);
  }

  const splitAt = sil.map((s) => (s.start + s.end) / 2).sort((a, b) => a - b);
  const groups: (typeof enriched)[] = [];
  let cur: typeof enriched = [];
  let si = 0;
  for (const w of enriched) {
    while (si < splitAt.length && splitAt[si] < w.start) {
      if (cur.length) {
        groups.push(cur);
        cur = [];
      }
      si++;
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const gapAfter = (end: number, nextStart: number) => {
    const hit = sil.find((s) => s.start >= end - 0.15 && s.start <= nextStart + 0.15);
    return hit ? +hit.dur.toFixed(2) : +(nextStart - end).toFixed(2);
  };

  const beats: Beat[] = groups.map((g, i) => {
    const start = g[0].start;
    const end = g[g.length - 1].end;
    const next = groups[i + 1];
    return {
      i: i + 1,
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      dur: +(end - start).toFixed(2),
      gapAfter: next ? gapAfter(end, next[0].start) : 0,
      text: g.map((w) => w.w).join(" "),
      emphasis: [...new Set(g.filter((w) => w.rel >= 1.45 && w.w.length > 2).map((w) => w.w))].slice(0, 6),
    };
  });

  // "Strong" has to be relative. Edited narration has had its pauses tightened,
  // so nearly every gap lands near 0.4s and a fixed 0.6s bar finds nothing.
  const sortedGaps = beats.map((b) => b.gapAfter).filter((g) => g > 0).sort((a, b) => a - b);
  const strongGap = sortedGaps[Math.floor(sortedGaps.length * 0.9)] ?? 0.6;
  const medGap = sortedGaps[Math.floor(sortedGaps.length * 0.5)] ?? 0.3;

  return { beats, pauseCount: sil.length, strongGap, medGap };
}
