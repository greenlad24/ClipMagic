/**
 * Sticker placement geometry + manifest type for the Meme/Sticker editor.
 *
 * THE HARD PRODUCT RULE: the sticker sits BELOW the captions and never overlaps
 * them. The burned-in captions render at screen CENTER (see render/build.ts:
 * y = (h-text_h)/2), so the sticker's box begins below center — in the lower
 * third — and stays clear of the bottom platform-UI safe margin.
 *
 * This file is the single source of truth for that geometry (matched by the
 * Remotion EmphasisSticker composition's STICKER_TOP_FRACTION). `assertBelowCaptions`
 * is exercised in the tests so a regression that lets a sticker drift up into
 * the caption zone fails the build, not a viewer.
 */

/** 9:16 master canvas — mirrors remotion/src/theme CANVAS. */
export const CANVAS = { width: 1080, height: 1920 } as const;

/** Bottom platform-UI safe margin — mirrors remotion/src/theme SAFE.bottom. */
export const SAFE_BOTTOM = Math.round(CANVAS.height * 0.18);

/**
 * Top of the sticker box as a fraction of canvas height. MUST equal the
 * Remotion composition's STICKER_TOP_FRACTION. 0.60 = the box starts at 60% down
 * the frame — below the centered caption line.
 */
export const STICKER_TOP_FRACTION = 0.6;

/**
 * Worst-case bottom edge of the centered caption line, as a fraction of height.
 * Captions are vertically centered; even a tall 2-line caption at the largest
 * template font (~108px) spans well under ~15% of the 1920px frame, so its
 * bottom edge sits comfortably above ~0.58. We use a conservative 0.58 so the
 * sticker top (0.60) is provably below it with margin.
 */
export const CAPTION_ZONE_BOTTOM_FRACTION = 0.58;

export interface StickerBox {
  /** Top edge Y in canvas pixels (where the sticker box begins). */
  top: number;
  /** Bottom edge Y in canvas pixels (clear of the bottom safe margin). */
  bottom: number;
  /** Rendered sticker side length in pixels (square, contained in the box). */
  size: number;
}

/**
 * Compute the sticker box. Pure + deterministic so it can be asserted in tests
 * and matches the Remotion composition exactly.
 */
export function stickerBox(): StickerBox {
  const top = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
  const bottom = CANVAS.height - SAFE_BOTTOM;
  const boxHeight = bottom - top;
  const size = Math.min(boxHeight, Math.round(CANVAS.width * 0.52));
  return { top, bottom, size };
}

/**
 * Throw if the sticker box is NOT entirely below the caption zone or pokes into
 * the bottom safe margin. Called by tests; cheap enough to also call at runtime.
 */
export function assertBelowCaptions(box: StickerBox = stickerBox()): void {
  const captionBottom = Math.round(CANVAS.height * CAPTION_ZONE_BOTTOM_FRACTION);
  if (box.top < captionBottom) {
    throw new Error(
      `Sticker top (${box.top}px) overlaps the caption zone (bottom ${captionBottom}px).`,
    );
  }
  if (box.bottom > CANVAS.height - SAFE_BOTTOM) {
    throw new Error(
      `Sticker bottom (${box.bottom}px) crosses the bottom safe margin (${CANVAS.height - SAFE_BOTTOM}px).`,
    );
  }
  if (box.size <= 0) {
    throw new Error(`Sticker size must be positive (got ${box.size}px).`);
  }
}

/**
 * A single emphasis sticker on the manifest: a generated image, its on-screen
 * window, and a small resting tilt. The Remotion EmphasisSticker composition
 * takes `imageUrl` (+ tilt) as props and applies the slap-on animation; the
 * stage composites the rendered alpha BELOW the captions.
 */
export interface EmphasisStickerClip {
  /** Output-timeline start, seconds. */
  startTime: number;
  /** Output-timeline end, seconds. */
  endTime: number;
  /** Public URL of the generated PNG (/api/outputs/stickers/...). */
  imageUrl: string;
  /** Small resting tilt in degrees (alternated per sticker for variety). */
  restTiltDeg: number;
  /** The transcript phrase this sticker emphasizes (logged / debug). */
  phrase?: string;
}
