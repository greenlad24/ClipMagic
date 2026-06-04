/**
 * Motion-graphics render+composite stage, called by the render worker after the
 * main video render. Pure orchestration: render the alpha clips, composite them,
 * clean up temp files. Always best-effort — returns the original render path if
 * anything goes wrong, so a normal render is never blocked.
 */
import fs from "node:fs";
import { renderMotionGraphics } from "./render.js";
import { compositeMotionGraphics } from "./composite.js";
import { stageFraction } from "../render/progress.js";
import type { MotionGraphicClip } from "../render/manifest.js";

/**
 * Progress callback for the post-render motion stage. `fraction` is 0..1 over
 * the WHOLE stage (every graphic render + the final composite re-encode);
 * `label` is a human sentence. The render worker maps the fraction into the
 * reserved tail of the job bar. Best-effort — never blocks the render.
 */
export type StageProgressFn = (fraction: number, label: string) => void;

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
  onProgress?: StageProgressFn,
): Promise<MotionStageResult> {
  const t0 = Date.now();
  const total = clips.length;
  onProgress?.(stageFraction({ rendered: 0, total, composite: 0 }), `Rendering graphics 0/${total}`);
  const rendered = await renderMotionGraphics(clips, (done) =>
    onProgress?.(
      stageFraction({ rendered: done, total, composite: 0 }),
      `Rendering graphics ${done}/${total}`,
    ),
  );
  if (rendered.length === 0) {
    return { replacedFile: baseVideo, ffmpegSpawns: 0, applied: 0 };
  }

  onProgress?.(stageFraction({ rendered: total, total, composite: 0 }), "Compositing video…");
  const result = await compositeMotionGraphics(baseVideo, rendered, totalDuration, (cf) =>
    onProgress?.(stageFraction({ rendered: total, total, composite: cf }), "Compositing video…"),
  );

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
