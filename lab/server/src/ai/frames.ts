/**
 * Promo-video frame extraction for vision indexing.
 *
 * Given a promo video reference (a /api/uploads/<id> URL, a bare file id, a
 * remote URL, or a local path), download/locate it, then use ffmpeg to extract
 * one JPEG frame per second (downscaled for cheap vision tokens). Returns the
 * frames as base64 strings in chronological order, plus the probed duration.
 *
 * This runs ONCE per promo video at index time — never during a render.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { resolveInput } from "../render/resolve.js";
import { probe } from "../render/ffmpeg.js";

export interface ExtractedFrames {
  frames: string[]; // base64 JPEG, index === second
  duration: number;
  width: number | null;
  height: number | null;
}

/** Hard cap so a very long promo can't blow up token cost / memory. */
const MAX_FRAMES = 90;

export async function extractFramesPerSecond(
  videoRef: string,
  opts: { fps?: number; maxFrames?: number; longEdge?: number } = {}
): Promise<ExtractedFrames> {
  const fps = opts.fps ?? 1; // 1 frame / second
  const maxFrames = opts.maxFrames ?? MAX_FRAMES;
  const longEdge = opts.longEdge ?? 512; // downscale for cheap vision

  const srcPath = await resolveInput(videoRef);
  const info = await probe(srcPath);
  const duration = info.duration ?? 0;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-frames-"));
  try {
    // Scale so the long edge is `longEdge`, keep aspect; 1 fps; cap count.
    const scale = `scale='if(gt(iw,ih),${longEdge},-2)':'if(gt(iw,ih),-2,${longEdge})'`;
    const pattern = path.join(tmpDir, "f-%04d.jpg");
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-i", srcPath,
      "-vf", `fps=${fps},${scale}`,
      "-frames:v", String(maxFrames),
      "-q:v", "4",
      pattern,
    ]);

    const files = fs
      .readdirSync(tmpDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    const frames = files.map((f) => fs.readFileSync(path.join(tmpDir, f)).toString("base64"));
    return { frames, duration, width: info.width, height: info.height };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    child.on("error", (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg frame extraction exited ${code}\n${err}`))
    );
  });
}
