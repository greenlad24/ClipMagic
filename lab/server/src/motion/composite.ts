/**
 * Composite rendered alpha motion-graphic clips onto a finished video.
 *
 * Design: this runs as a SEPARATE ffmpeg pass AFTER the main render, rather than
 * being woven into build.ts's filtergraph. That isolation is deliberate — the
 * primary render path is untouched, so a motion-graphics failure (or the flag
 * being off) can never regress a normal render. Worst case we keep the already-
 * finished base video.
 *
 * Each graphic is one overlay input enabled only for its [startTime, endTime]
 * window. The alpha clip already contains its own fade/scale in & out (authored
 * in Remotion), so ffmpeg just positions it full-frame with `overlay` and gates
 * visibility with `enable=between(t,...)`. We reset each overlay's PTS so its
 * first frame lands exactly at startTime on the output timeline (same technique
 * build.ts uses for promo overlays).
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import type { RenderedGraphic } from "./render.js";

export interface CompositeResult {
  /** Final file path (the composited output, or the original if skipped). */
  file: string;
  /** True if a composite pass actually ran. */
  composited: boolean;
  /** ffmpeg spawns used by this pass (0 when skipped). */
  ffmpegSpawns: number;
}

/**
 * Overlay `graphics` onto `baseVideo`, writing a new file alongside it. Never
 * throws: on any ffmpeg error it logs and returns the untouched base video so
 * the render still succeeds.
 */
export async function compositeMotionGraphics(
  baseVideo: string,
  graphics: RenderedGraphic[],
  totalDuration: number,
  /** Surfaces the composite re-encode's own 0..1 progress (best-effort). */
  onComposite?: (frac: number) => void,
): Promise<CompositeResult> {
  const usable = graphics.filter((g) => g.file);
  if (usable.length === 0) {
    return { file: baseVideo, composited: false, ffmpegSpawns: 0 };
  }

  const ext = path.extname(baseVideo) || ".mp4";
  const out = path.join(
    path.dirname(baseVideo),
    `${path.basename(baseVideo, ext)}_mg_${randomUUID().slice(0, 8)}${ext}`,
  );

  const args: string[] = ["-y", "-hide_banner", "-i", baseVideo];
  for (const g of usable) args.push("-i", g.file as string);

  const filters: string[] = [];
  let last = "0:v";
  usable.forEach((g, i) => {
    const inputIdx = i + 1;
    const start = Math.max(0, g.clip.startTime);
    const end = Math.min(totalDuration || g.clip.endTime, g.clip.endTime);
    const shifted = `g${i}`;
    const outLabel = `c${i}`;
    // Land the graphic's first frame at `start`; keep its own alpha intact.
    filters.push(
      `[${inputIdx}:v]setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[${shifted}]`,
    );
    filters.push(
      `[${last}][${shifted}]overlay=0:0:format=auto:` +
        `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`,
    );
    last = outLabel;
  });

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${last}]`);
  // Carry the original audio through untouched.
  args.push("-map", "0:a?");
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
  );
  if (totalDuration > 0) args.push("-t", totalDuration.toFixed(3));
  args.push("-progress", "pipe:1", "-nostats", out);

  try {
    await runFfmpeg(args, totalDuration, onComposite ? (f) => onComposite(f) : undefined);
    return { file: out, composited: true, ffmpegSpawns: 1 };
  } catch (e) {
    console.warn(
      `[motion] composite pass failed — keeping base render: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { file: baseVideo, composited: false, ffmpegSpawns: 0 };
  }
}
