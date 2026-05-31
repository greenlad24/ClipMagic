import { spawn } from "node:child_process";
import { config } from "../config.js";

export type ProgressFn = (fraction: number) => void;

export interface RunResult {
  durationSec: number;
}

/**
 * Spawn the local ffmpeg binary with the given argv and resolve when it exits 0.
 * Progress 0..1 is reported by parsing ffmpeg's `-progress pipe:1` stream and
 * dividing the current output time by the known total duration.
 */
export function runFfmpeg(
  args: string[],
  totalDuration: number,
  onProgress?: ProgressFn
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrTail = "";
    let progressBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      progressBuf += chunk.toString();
      const lines = progressBuf.split("\n");
      progressBuf = lines.pop() ?? "";
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === "out_time_us" || key === "out_time_ms") {
          // ffmpeg reports microseconds under both keys (historical quirk).
          const us = Number.parseInt(value, 10);
          if (Number.isFinite(us) && totalDuration > 0) {
            onProgress?.(Math.min(0.99, us / 1_000_000 / totalDuration));
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-6000);
    });

    child.on("error", (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));

    child.on("close", (code) => {
      if (code === 0) {
        onProgress?.(1);
        resolve({ durationSec: totalDuration });
      } else {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderrTail}`));
      }
    });
  });
}

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

/** Run ffprobe; never throws — returns nulls on any failure. */
export function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json",
      filePath,
    ];
    const child = spawn(config.ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({ duration: null, width: null, height: null, hasAudio: false }));
    child.on("close", () => {
      try {
        const json = JSON.parse(out);
        const streams: Array<{ codec_type?: string; width?: number; height?: number }> =
          json.streams || [];
        const video = streams.find((s) => s.codec_type === "video");
        const hasAudio = streams.some((s) => s.codec_type === "audio");
        const d = json.format?.duration ? Number.parseFloat(json.format.duration) : null;
        resolve({
          duration: Number.isFinite(d as number) ? d : null,
          width: video?.width ?? null,
          height: video?.height ?? null,
          hasAudio,
        });
      } catch {
        resolve({ duration: null, width: null, height: null, hasAudio: false });
      }
    });
  });
}
