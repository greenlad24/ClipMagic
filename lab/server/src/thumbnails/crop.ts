/**
 * Crop + upscale a Nano Banana output to a clean 16:9 1920×1080 thumbnail with
 * NO black bars.
 *
 * Nano Banana frequently returns a ~1195×896 image that is really a 16:9 frame
 * letterboxed inside a 4:3-ish canvas (≈113px black bars top & bottom). For that
 * known pattern we crop the centre 16:9 region (1195×670 at y=113) then scale to
 * 1920×1080. For anything else we centre-crop to 16:9 (the largest 16:9 rect that
 * fits) then scale to 1920×1080. We NEVER pad, so a bar is never introduced.
 *
 * The argument builder is a PURE, exported function (no fs / no spawn) so the
 * crop math is unit-testable for both the letterboxed and the generic case.
 */

export const TARGET_W = 1920;
export const TARGET_H = 1080;

/** The letterboxed pattern Nano Banana commonly emits (≈1195×896, 16:9 inside). */
const LETTERBOX_W = 1195;
const LETTERBOX_H = 896;
/** Visible 16:9 height inside the letterbox, and its top offset (black bar height). */
const LETTERBOX_CROP_H = 670;
const LETTERBOX_CROP_Y = 113;

/**
 * True when (w,h) matches the known Nano Banana letterbox pattern closely enough
 * that the fixed centre-crop applies. We allow a small tolerance because the
 * model isn't pixel-exact run to run.
 */
export function isLetterboxed(width: number, height: number): boolean {
  return Math.abs(width - LETTERBOX_W) <= 8 && Math.abs(height - LETTERBOX_H) <= 8;
}

/** Largest 16:9 (width:height) rectangle that fits inside w×h, centred. Even dims. */
export function centerCrop16x9(width: number, height: number): { w: number; h: number; x: number; y: number } {
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
 * Build the ffmpeg `-vf` filter string that turns a source w×h into a clean
 * 1920×1080 16:9 image with no padding.
 *   - Letterboxed pattern → fixed crop of the visible 16:9 region, then scale.
 *   - Otherwise           → centre-crop to 16:9, then scale.
 * Pure: depends only on the input dimensions.
 */
export function buildCropScaleFilter(width: number, height: number): string {
  if (isLetterboxed(width, height)) {
    return `crop=${LETTERBOX_W}:${LETTERBOX_CROP_H}:0:${LETTERBOX_CROP_Y},scale=${TARGET_W}:${TARGET_H}`;
  }
  const c = centerCrop16x9(width, height);
  return `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${TARGET_W}:${TARGET_H}`;
}

/**
 * Full ffmpeg argv to convert `input` into a 1920×1080 PNG/JPG `output`. Pure +
 * exported so the exact command is testable; the caller runs it via runFfmpeg.
 */
export function buildCropScaleArgs(input: string, output: string, width: number, height: number): string[] {
  return [
    "-y",
    "-i", input,
    "-vf", buildCropScaleFilter(width, height),
    "-frames:v", "1",
    output,
  ];
}
