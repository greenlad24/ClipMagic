import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { Segment } from "../cutter/plan.js";

/**
 * Narration-cut render: trim a source clip to a set of keep-segments and
 * concatenate them back into one tightened MP4 (video + audio in sync). Used by
 * the "cut" job kind in the worker pool.
 */
export interface CutSpec {
  /** Absolute local path to the source video (already resolved). */
  source: string;
  /** Keep-segments in source time, in order. */
  segments: Segment[];
  /** Whether the source has an audio stream. */
  hasAudio: boolean;
  /**
   * Fixed pause (s) inserted BETWEEN consecutive kept segments so takes don't
   * butt-splice. The interactive editor sets this (default 0.35s); it is honored
   * identically in the browser preview and here at render so "what you preview
   * is what you get". 0 = legacy butt-splice behaviour (auto bulk path).
   */
  gap?: number;
}

/**
 * Build the ffmpeg argv (and total output duration) for a cut job. The
 * filter graph is written to a sidecar script file referenced via
 * `-filter_complex_script` so we never blow the command-line length limit even
 * with hundreds of segments.
 */
export function buildCutArgs(spec: CutSpec, outputPath: string): { args: string[]; totalDuration: number } {
  const segs = spec.segments.filter((s) => s.end > s.start);
  if (segs.length === 0) throw new Error("Cut job has no keep-segments");

  // Fixed inter-take gap (s) inserted between consecutive segments. Held as a
  // freeze of the previous segment's last frame + silent audio, so the gap is a
  // natural pause (not a black flash). Must match the browser preview's spacing.
  const GAP = Math.max(0, spec.gap ?? 0);
  const gapTotal = GAP * Math.max(0, segs.length - 1);
  const totalDuration = segs.reduce((s, seg) => s + (seg.end - seg.start), 0) + gapTotal;

  // Every splice between two non-adjacent source regions lands at an arbitrary
  // waveform sample, almost never a zero crossing — so a raw concat produces an
  // audible click/pop at each junction. Professional editors apply a tiny fade
  // (even ~1ms) at every audio edit to kill those clicks. We apply a short
  // micro-fade to the head and tail of every kept audio segment: long enough to
  // remove the discontinuity, short enough to be inaudible as a "fade". It's
  // clamped to never exceed a third of a (very short) segment.
  const FADE = 0.008; // 8ms

  const parts: string[] = [];
  const concatInputs: string[] = [];
  segs.forEach((seg, i) => {
    const s = seg.start.toFixed(3);
    const e = seg.end.toFixed(3);
    // Append the inter-take gap to every segment except the last: hold the last
    // video frame (tpad clone) + pad the audio with silence for `GAP` seconds.
    const addGap = GAP > 0 && i < segs.length - 1;
    const vGap = addGap ? `,tpad=stop_mode=clone:stop_duration=${GAP.toFixed(3)}` : "";
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS${vGap}[v${i}]`);
    if (spec.hasAudio) {
      const segDur = seg.end - seg.start;
      const fade = Math.max(0.001, Math.min(FADE, segDur / 3));
      const fadeOutStart = Math.max(0, segDur - fade).toFixed(4);
      const aGap = addGap ? `,apad=pad_dur=${GAP.toFixed(3)}` : "";
      parts.push(
        `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=${fade.toFixed(4)},` +
          `afade=t=out:st=${fadeOutStart}:d=${fade.toFixed(4)}${aGap}[a${i}]`,
      );
      concatInputs.push(`[v${i}][a${i}]`);
    } else {
      concatInputs.push(`[v${i}]`);
    }
  });
  const concat = spec.hasAudio
    ? `${concatInputs.join("")}concat=n=${segs.length}:v=1:a=1[v][a]`
    : `${concatInputs.join("")}concat=n=${segs.length}:v=1:a=0[v]`;
  const graph = [...parts, concat].join(";\n");

  const scriptPath = `${outputPath}.filter.txt`;
  fs.writeFileSync(scriptPath, graph, "utf8");

  const args = [
    "-y",
    "-i", spec.source,
    "-filter_complex_script", scriptPath,
    "-map", "[v]",
    ...(spec.hasAudio ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(spec.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    outputPath,
  ];

  return { args, totalDuration };
}

/**
 * Extract a small mono 16kHz MP3 of the source's audio for transcription.
 * Returns the bytes + a filename/type suitable for the Groq form upload.
 * Throws if the source has no decodable audio.
 */
export function extractAudioForTranscription(
  srcPath: string,
): Promise<{ buffer: Buffer; name: string; type: string }> {
  const out = path.join(config.tmpDir, `cutaudio_${randomUUID()}.mp3`);
  const args = [
    "-y", "-i", srcPath,
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "libmp3lame", "-q:a", "5",
    out,
    "-loglevel", "error",
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`ffmpeg audio extract failed to start: ${e.message}`)));
    p.on("close", (code) => {
      if (code !== 0) {
        try { fs.rmSync(out, { force: true }); } catch { /* */ }
        return reject(new Error(`ffmpeg audio extract exited ${code}: ${err.slice(-400)}`));
      }
      try {
        const buffer = fs.readFileSync(out);
        resolve({ buffer, name: "narration.mp3", type: "audio/mpeg" });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        try { fs.rmSync(out, { force: true }); } catch { /* */ }
      }
    });
  });
}
