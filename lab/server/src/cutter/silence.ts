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
