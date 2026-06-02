/**
 * Motion-graphics render+composite stage, called by the render worker after the
 * main video render. Pure orchestration: render the alpha clips, composite them,
 * clean up temp files. Always best-effort — returns the original render path if
 * anything goes wrong, so a normal render is never blocked.
 */
import fs from "node:fs";
import { renderMotionGraphics } from "./render.js";
import { compositeMotionGraphics } from "./composite.js";
import type { MotionGraphicClip } from "../render/manifest.js";

export interface MotionStageResult {
  /** Path to the file that should become the final output (may equal baseVideo). */
  replacedFile: string;
  /** Extra ffmpeg spawns used (for the optimization report). */
  ffmpegSpawns: number;
  /** How many graphics actually rendered + composited. */
  applied: number;
}

export async function applyMotionGraphics(
  baseVideo: string,
  clips: MotionGraphicClip[],
  totalDuration: number,
): Promise<MotionStageResult> {
  const t0 = Date.now();
  const rendered = await renderMotionGraphics(clips);
  if (rendered.length === 0) {
    return { replacedFile: baseVideo, ffmpegSpawns: 0, applied: 0 };
  }

  const result = await compositeMotionGraphics(baseVideo, rendered, totalDuration);

  // Clean up the per-graphic alpha temp clips regardless of outcome.
  for (const g of rendered) {
    if (g.file) fs.rm(g.file, { force: true }, () => {});
  }

  const applied = result.composited ? rendered.length : 0;
  console.log(
    `[motion] applied ${applied}/${clips.length} graphic(s) in ${Date.now() - t0}ms` +
      (result.composited ? "" : " (composite skipped — kept base render)"),
  );

  return {
    replacedFile: result.file,
    ffmpegSpawns: result.ffmpegSpawns,
    applied,
  };
}
