/**
 * Narration Cutter — audio-energy (silence) detection.
 *
 * The cut planner used to decide keep/cut boundaries purely from Whisper word
 * timestamps, which are loose: cut edges drifted INTO real speech (clipping word
 * onsets/tails) and genuine dead air the transcript smeared over was left in.
 *
 * This module runs ONE cheap whole-file ffmpeg `silencedetect` pass over the
 * narration to get the TRUE low-energy regions (with measured dBFS), so the
 * planner can:
 *   - snap every keep boundary OUTWARD to a real silent region (never mid-word),
 *   - remove dead air the transcript missed.
 *
 * A single whole-file pass (not per-clip / per-segment) keeps it cheap. Pure
 * parsing is split out from the ffmpeg spawn so it can be unit-tested without
 * any binary.
 */
import { spawn } from "node:child_process";
import { config } from "../config.js";

/** A measured low-energy (silent) region of the narration, in source time. */
export interface SilenceRegion {
  start: number;
  end: number;
  /** The noise-floor threshold (dBFS) this region was detected at, for diagnostics. */
  thresholdDb: number;
}

export interface DetectSilenceOptions {
  /**
   * Noise floor in dBFS below which audio counts as silence. Quieter (more
   * negative) = stricter (only true dead air); louder (less negative) = catches
   * low-energy mumbles too. Default -32.
   */
  noiseFloorDb?: number;
  /** Minimum duration (s) of continuous quiet to report as a silence. Default 0.30. */
  minSilence?: number;
}

/**
 * Parse ffmpeg `silencedetect` stderr into silence regions. ffmpeg emits lines
 * like:
 *   [silencedetect @ 0x..] silence_start: 1.234
 *   [silencedetect @ 0x..] silence_end: 2.345 | silence_duration: 1.111
 * A trailing silence_start with no matching end (runs to EOF) is closed at
 * `duration` when known. Exported for unit tests (no ffmpeg needed).
 */
export function parseSilenceDetect(
  stderr: string,
  thresholdDb: number,
  duration?: number,
): SilenceRegion[] {
  const regions: SilenceRegion[] = [];
  let open: number | null = null;
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const kind = m[1];
    const t = Number.parseFloat(m[2]);
    if (!Number.isFinite(t)) continue;
    if (kind === "start") {
      open = t;
    } else if (open != null) {
      if (t > open) regions.push({ start: Math.max(0, open), end: t, thresholdDb });
      open = null;
    }
  }
  // A silence that runs to end-of-file has a start but no end.
  if (open != null && duration != null && duration > open) {
    regions.push({ start: Math.max(0, open), end: duration, thresholdDb });
  }
  return regions;
}

/** A per-frame dBFS energy envelope of the narration, for the timeline editor. */
export interface AudioEnvelope {
  /** dBFS per frame (floored at `floorDb`, never -Infinity), oldest → newest. */
  db: number[];
  /** Seconds per frame (== the hop between samples). */
  hop: number;
  /** Source duration in seconds. */
  duration: number;
  /** The floor used for digital-silent frames. */
  floorDb: number;
}

/**
 * Parse ffmpeg `astats` (metadata mode) stderr/stdout into a dBFS-per-frame
 * envelope. With `astats=metadata=1:reset=1` + `ametadata=print`, ffmpeg emits,
 * once per analysis window, a line like:
 *   lavfi.astats.Overall.RMS_level=-23.456789
 * Digital silence is reported as `-inf`; we clamp it to `floorDb` so the client
 * envelope is finite and renders. Split out from the spawn for unit testing.
 */
export function parseAstatsEnvelope(text: string, floorDb: number): number[] {
  const db: number[] = [];
  const re = /lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?|-?inf|nan)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].toLowerCase();
    let v = raw === "-inf" || raw === "inf" || raw === "nan" ? floorDb : Number.parseFloat(raw);
    if (!Number.isFinite(v) || v < floorDb) v = floorDb;
    if (v > 0) v = 0;
    db.push(Math.round(v * 100) / 100);
  }
  return db;
}

/**
 * Build a dBFS energy envelope for the timeline editor: ~`fps` samples/second of
 * RMS level across the whole narration. The client thresholds THIS envelope live
 * (in `silencesFromEnvelope`) to recompute cut regions without a server round
 * trip — and because the server renders the explicit keep-segments the client
 * derives from the very same envelope, preview and render agree by construction.
 * Best-effort: returns an empty envelope on any ffmpeg failure.
 */
export function computeEnvelope(
  srcPath: string,
  duration: number,
  fps = 50,
  floorDb = -60,
): Promise<AudioEnvelope> {
  const hop = 1 / fps;
  // astats over fixed-length windows = our frame size. metadata=1 prints stats;
  // reset=1 means each window is independent; ametadata=print emits them.
  const af =
    `aresample=16000,asetnsamples=n=${Math.max(1, Math.round(16000 * hop))}:p=0,` +
    `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  return new Promise((resolve) => {
    const p = spawn(config.ffmpegPath, [
      "-hide_banner", "-nostats",
      "-i", srcPath,
      "-vn", "-af", af,
      "-f", "null", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d.toString()));
    p.stderr.on("data", (d) => (buf += d.toString()));
    p.on("error", () => resolve({ db: [], hop, duration, floorDb }));
    p.on("close", () => {
      try {
        resolve({ db: parseAstatsEnvelope(buf, floorDb), hop, duration, floorDb });
      } catch {
        resolve({ db: [], hop, duration, floorDb });
      }
    });
  });
}

/**
 * Run a single whole-file `silencedetect` pass and return the true silent
 * regions. Best-effort: returns [] on any ffmpeg failure so the planner can fall
 * back to transcript-only behaviour (never harder than before).
 */
export function detectSilences(
  srcPath: string,
  duration: number,
  opts: DetectSilenceOptions = {},
): Promise<SilenceRegion[]> {
  const noiseFloorDb = opts.noiseFloorDb ?? -32;
  const minSilence = opts.minSilence ?? 0.3;
  return new Promise((resolve) => {
    const p = spawn(config.ffmpegPath, [
      "-hide_banner", "-nostats",
      "-i", srcPath,
      "-vn",
      "-af", `silencedetect=noise=${noiseFloorDb}dB:d=${minSilence.toFixed(3)}`,
      "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => resolve([]));
    p.on("close", () => {
      try {
        resolve(parseSilenceDetect(err, noiseFloorDb, duration));
      } catch {
        resolve([]);
      }
    });
  });
}
