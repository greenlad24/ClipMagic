/**
 * Crop + scale a Nano Banana output to a clean 16:9 thumbnail with NO black bars,
 * at NATIVE resolution — robust to ANY output dimensions the model returns.
 *
 * Nano Banana sometimes returns a frame with uniform letterbox (top/bottom) or
 * pillarbox (left/right) bars around a smaller real image. Rather than hard-code
 * one known size, we:
 *   1. ffprobe the real dimensions,
 *   2. run ffmpeg `cropdetect` to find the bounding box of the actual content
 *      (this strips uniform bars of any thickness/color), and
 *   3. centre-crop THAT content box to a 16:9 rectangle, then scale to the
 *      NATIVE-AWARE output dims (see outputDims): we never needlessly downscale a
 *      4K render to 1080p — we keep its resolution, only capping at 4K and only
 *      upscaling content that is smaller than the 1920-wide floor.
 * We NEVER pad, so a bar is never (re)introduced.
 *
 * The argument builders are PURE, exported functions (no fs / no spawn) so the
 * crop math is unit-testable across square / 4:3 / already-16:9 / letterboxed
 * inputs. The runtime bar-detection (cropdetect parsing) lives in detectContentRect.
 */

/** Minimum / floor output dims: small content is UPSCALED up to at least this. */
export const TARGET_W = 1920;
export const TARGET_H = 1080;
/** Maximum / cap output dims: content larger than 4K is DOWNSCALED to this. */
export const MAX_W = 3840;
export const MAX_H = 2160;

/** A rectangle within a source image (the detected content region). */
export interface Rect {
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * Largest 16:9 (width:height) rectangle that fits inside w×h, centred. Even dims.
 */
export function centerCrop16x9(width: number, height: number): Rect {
  // If the source is WIDER than 16:9, height is the limiter; otherwise width is.
  let cropW = width;
  let cropH = Math.round((width * 9) / 16);
  if (cropH > height) {
    cropH = height;
    cropW = Math.round((height * 16) / 9);
  }
  // Keep dimensions even (h.264-friendly) and within bounds.
  cropW = Math.min(width, cropW - (cropW % 2));
  cropH = Math.min(height, cropH - (cropH % 2));
  const x = Math.max(0, Math.floor((width - cropW) / 2));
  const y = Math.max(0, Math.floor((height - cropH) / 2));
  return { w: cropW, h: cropH, x, y };
}

/**
 * Centre-crop a 16:9 rectangle inside an ALREADY-known content region `content`
 * (the post-bar-strip box) that sits within the full w×h frame. Returns the crop
 * in FULL-FRAME coordinates so ffmpeg can apply it directly. Pure.
 *
 * When no content rect is given, the whole frame is the content (the common
 * no-bars case), so this reduces to centerCrop16x9 over the full frame.
 */
export function crop16x9WithinContent(width: number, height: number, content?: Rect): Rect {
  const box: Rect = content ?? { w: width, h: height, x: 0, y: 0 };
  // Clamp the content box to the frame defensively.
  const cw = Math.max(2, Math.min(box.w, width));
  const ch = Math.max(2, Math.min(box.h, height));
  const inner = centerCrop16x9(cw, ch);
  return {
    w: inner.w,
    h: inner.h,
    x: Math.max(0, Math.min(width - inner.w, box.x + inner.x)),
    y: Math.max(0, Math.min(height - inner.h, box.y + inner.y)),
  };
}

/**
 * Native-aware output dimensions for a 16:9 crop of `cropW`×`cropH`. The crop is
 * already 16:9, so the result stays 16:9. Policy (preserve the render's native
 * resolution — never needlessly downscale a 4K render to 1080p):
 *   - cropW ≥ 3840 (MAX_W) → 3840×2160 — cap at 4K; only DOWNSCALE when larger.
 *   - cropW ≥ 1920 (TARGET_W) → cropW×cropH — keep NATIVE, no scaling at all.
 *   - cropW < 1920 → 1920×1080 — only UPSCALE content below the floor.
 * Pure + exported for unit testing.
 */
export function outputDims(cropW: number, cropH: number): { w: number; h: number } {
  if (cropW >= MAX_W) return { w: MAX_W, h: MAX_H };
  if (cropW >= TARGET_W) return { w: cropW, h: cropH };
  return { w: TARGET_W, h: TARGET_H };
}

/**
 * Build the ffmpeg `-vf` filter string that turns a source w×h (with an optional
 * pre-detected content rect) into a clean, NATIVE-AWARE 16:9 image with no
 * padding: centre-crop the 16:9 region of the content box, then scale to
 * outputDims(...). When the output dims equal the crop dims (the ≥1920 native
 * case), we emit ONLY the crop — never an upscale or a needless re-scale. Pure.
 */
export function buildCropScaleFilter(width: number, height: number, content?: Rect): string {
  const c = crop16x9WithinContent(width, height, content);
  const out = outputDims(c.w, c.h);
  const cropF = `crop=${c.w}:${c.h}:${c.x}:${c.y}`;
  // Native pass-through: the crop already IS the output size → no scale at all.
  if (out.w === c.w && out.h === c.h) return cropF;
  return `${cropF},scale=${out.w}:${out.h}:flags=lanczos`;
}

/**
 * Full ffmpeg argv to convert `input` into a NATIVE-AWARE 16:9 high-quality JPG
 * `output` (a 4K PNG can exceed YouTube's 2 MB thumbnail cap, so we deliver JPG;
 * `-q:v 3` lands ~1–2 MB at 4K). Pure + exported so the exact command is
 * testable; the caller runs it via runFfmpeg.
 *
 * TODO(size-guard): if a 4K q:v 3 frame ever exceeds ~2 MB, we could re-encode at
 * a higher q:v value (4–5) and pick the largest result that stays under the cap.
 */
export function buildCropScaleArgs(
  input: string,
  output: string,
  width: number,
  height: number,
  content?: Rect,
): string[] {
  return [
    "-y",
    "-i", input,
    "-vf", buildCropScaleFilter(width, height, content),
    "-frames:v", "1",
    "-q:v", "3",
    output,
  ];
}

/**
 * Parse the bounding box ffmpeg's `cropdetect` filter prints (one or more
 * `crop=W:H:X:Y` tokens on stderr). Returns the LAST detected box (cropdetect
 * stabilises over frames; for a single image the last line is the final answer)
 * or null when nothing parseable / the box equals the full frame. Pure +
 * exported for unit testing against captured cropdetect output.
 */
export function parseCropdetect(stderr: string, fullW: number, fullH: number): Rect | null {
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const w = Number(last[1]);
  const h = Number(last[2]);
  const x = Number(last[3]);
  const y = Number(last[4]);
  if (![w, h, x, y].every(Number.isFinite) || w < 2 || h < 2) return null;
  // No meaningful bars detected (box ~= full frame) → treat as "no content rect".
  if (x === 0 && y === 0 && w >= fullW && h >= fullH) return null;
  return { w, h, x, y };
}

/**
 * Run ffmpeg `cropdetect` on a single image to find the content bounding box
 * (strips uniform letterbox/pillarbox bars of any color/thickness). Returns the
 * detected Rect, or null when no bars are found or ffmpeg is unavailable. Never
 * throws — bar-stripping is an optional refinement; the centre-crop still yields
 * 16:9 without it.
 */
export async function detectContentRect(input: string, fullW: number, fullH: number): Promise<Rect | null> {
  // Imported lazily to keep this module's pure exports free of node:child_process.
  const { spawn } = await import("node:child_process");
  const { config } = await import("../config.js");
  return new Promise<Rect | null>((resolve) => {
    // cropdetect with a generous limit catches near-black bars; round=2 keeps even
    // dims. -f null - discards output; we only want the printed crop= boxes.
    const args = ["-i", input, "-vf", "cropdetect=limit=24:round=2:reset=0", "-frames:v", "3", "-f", "null", "-"];
    let stderr = "";
    let done = false;
    const finish = (r: Rect | null) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      return finish(null);
    }
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        finish(parseCropdetect(stderr, fullW, fullH));
      } catch {
        finish(null);
      }
    });
  });
}
