/**
 * Sticker placement geometry + manifest type for the Meme/Sticker editor.
 *
 * THE PRODUCT RULE (the hard rule): EVERY sticker slaps on BELOW the captions —
 * the lower third — and NEVER above or overlapping the centered caption band. A
 * sticker box must (a) sit entirely below the reserved caption zone, (b) stay
 * inside the 9:16 safe margins, and (c) not run off-frame given its own size.
 * Placement does NOT vary by moment — the below-captions slot is the single,
 * consistent home for every reaction sticker.
 *
 * This file is the single source of truth for that geometry (the Remotion
 * EmphasisSticker composition consumes the box as props). `placeSticker` always
 * returns the below-captions box, and `assertFits` / `assertBelowCaptions` are
 * exercised in the tests so a regression that lets a sticker drift up into (or
 * above) the caption zone — or off-frame — fails the build, not a viewer.
 */

/** 9:16 master canvas — mirrors remotion/src/theme CANVAS. */
export const CANVAS = { width: 1080, height: 1920 } as const;

/** Side safe margins — mirror remotion/src/theme SAFE.left / .right (~7%). */
export const SAFE_LEFT = Math.round(CANVAS.width * 0.07);
export const SAFE_RIGHT = Math.round(CANVAS.width * 0.07);
/** Top safe margin — mirrors remotion/src/theme SAFE.top (handle/sound row). */
export const SAFE_TOP = Math.round(CANVAS.height * 0.11);
/** Bottom platform-UI safe margin — mirrors remotion/src/theme SAFE.bottom. */
export const SAFE_BOTTOM = Math.round(CANVAS.height * 0.18);

/**
 * The burned-in caption band. Captions render vertically CENTERED (see
 * render/build.ts / ass.ts), 2–3 words, up to two lines at the largest meme font.
 * Even a tall caption spans well under ~18% of the 1920px frame about center, so
 * we reserve a conservative band from 0.42→0.58 of the height as OFF-LIMITS. Any
 * sticker box must sit entirely above 0.42 or below 0.58.
 */
export const CAPTION_ZONE_TOP_FRACTION = 0.42;
export const CAPTION_ZONE_BOTTOM_FRACTION = 0.58;

/**
 * Legacy below-captions box top, kept as one of the candidate zones (the lower
 * third). 0.60 starts just below the reserved caption band.
 */
export const STICKER_TOP_FRACTION = 0.6;

export interface StickerBox {
  /** Left edge X in canvas pixels. */
  left: number;
  /** Top edge Y in canvas pixels (where the sticker box begins). */
  top: number;
  /** Rendered sticker side length in pixels (square, contained in the box). */
  size: number;
  /** Bottom edge Y in canvas pixels (top + size). */
  bottom: number;
  /** Which named zone this box came from (logged / debug). */
  zone?: string;
}

/** The default square sticker side — a tasteful, not edge-to-edge, cut-out. */
export function defaultStickerSize(): number {
  // Capped so even a big sticker leaves the side safe rails clear.
  return Math.min(Math.round(CANVAS.width * 0.46), CAPTION_TOP() - SAFE_TOP);
}

function CAPTION_TOP(): number {
  return Math.round(CANVAS.height * CAPTION_ZONE_TOP_FRACTION);
}
function CAPTION_BOTTOM(): number {
  return Math.round(CANVAS.height * CAPTION_ZONE_BOTTOM_FRACTION);
}

/** Smallest sticker we'll ever place — below this it reads as a speck. */
const MIN_STICKER_SIZE = 220;
/** Max horizontal room any zone can use (clears both side safe rails). */
function maxWidthRoom(): number {
  return CANVAS.width - SAFE_LEFT - SAFE_RIGHT;
}

/**
 * Place a sticker in the BELOW-CAPTIONS slot — the single, consistent home for
 * EVERY reaction sticker (the hard product rule). The box is centered in the
 * lower third, its size CLAMPED to the band between STICKER_TOP_FRACTION and the
 * bottom safe margin (and the side safe rails), so it always sits below the
 * caption zone, inside the safe area, and never off-frame.
 *
 * The signature keeps the (unused) `index` parameter for call-site compatibility,
 * but placement no longer varies — every sticker lands below the captions. The
 * requested `size` is the ceiling; it shrinks to whatever the band can hold.
 */
export function placeSticker(_index = 0, size: number = defaultStickerSize()): StickerBox {
  const top = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
  // Room the lower-third band leaves below the captions and above the bottom
  // safe margin, and within the side safe rails. Clamp the request to it.
  const room = Math.max(
    MIN_STICKER_SIZE,
    Math.min(size, CANVAS.height - SAFE_BOTTOM - top, maxWidthRoom()),
  );
  const left = Math.round((CANVAS.width - room) / 2);
  const box: StickerBox = { left, top, size: room, bottom: top + room, zone: "below-captions" };
  // Validate the invariants in code so a geometry regression fails fast.
  assertFits(box);
  return box;
}

/** Back-compat: the centered below-captions box (used as a default/fallback). */
export function stickerBox(): StickerBox {
  const top = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
  const bottom = CANVAS.height - SAFE_BOTTOM;
  const boxHeight = bottom - top;
  const size = Math.min(boxHeight, Math.round(CANVAS.width * 0.52));
  const left = Math.round((CANVAS.width - size) / 2);
  return { left, top, size, bottom: top + size, zone: "below-captions" };
}

/**
 * Throw if the sticker box runs off-frame, pokes a safe margin, or overlaps the
 * reserved caption band: "fits inside the safe area AND never overlaps the
 * captions". Called by tests and cheap enough to also call at runtime.
 */
export function assertFits(box: StickerBox): void {
  if (box.size <= 0) {
    throw new Error(`Sticker size must be positive (got ${box.size}px).`);
  }
  // (a) inside the horizontal safe rails
  if (box.left < SAFE_LEFT) {
    throw new Error(`Sticker left (${box.left}px) is inside the left safe margin (${SAFE_LEFT}px).`);
  }
  if (box.left + box.size > CANVAS.width - SAFE_RIGHT) {
    throw new Error(
      `Sticker right (${box.left + box.size}px) crosses the right safe margin (${CANVAS.width - SAFE_RIGHT}px).`,
    );
  }
  // (b) inside the vertical safe margins (never off-frame top/bottom)
  if (box.top < SAFE_TOP) {
    throw new Error(`Sticker top (${box.top}px) is inside the top safe margin (${SAFE_TOP}px).`);
  }
  if (box.top + box.size > CANVAS.height - SAFE_BOTTOM) {
    throw new Error(
      `Sticker bottom (${box.top + box.size}px) crosses the bottom safe margin (${CANVAS.height - SAFE_BOTTOM}px).`,
    );
  }
  // (c) never overlaps the caption band (must be wholly above it or below it)
  const capTop = CAPTION_TOP();
  const capBottom = CAPTION_BOTTOM();
  const overlapsCaption = box.top < capBottom && box.top + box.size > capTop;
  if (overlapsCaption) {
    throw new Error(
      `Sticker box (${box.top}-${box.top + box.size}px) overlaps the caption zone ` +
        `(${capTop}-${capBottom}px).`,
    );
  }
}

/**
 * Throw unless the box sits ENTIRELY below the caption band (the hard product
 * rule): its top must be at or under the caption-zone bottom, and it must also
 * fit the safe area. Stricter than assertFits, which also permits an above-the-
 * captions box — here a sticker is ONLY ever allowed below the captions.
 */
export function assertBelowCaptions(box: StickerBox): void {
  assertFits(box);
  const capBottom = CAPTION_BOTTOM();
  if (box.top < capBottom) {
    throw new Error(
      `Sticker top (${box.top}px) must be at/under the caption-zone bottom (${capBottom}px) — ` +
        `every sticker sits BELOW the captions.`,
    );
  }
}

/**
 * A single emphasis sticker on the manifest: a generated image, its on-screen
 * window, a small resting tilt, AND its chosen placement box. The Remotion
 * EmphasisSticker composition takes the box (left/top/size) + tilt as props and
 * applies the slap-on animation; the stage composites the rendered alpha at that
 * position (anywhere that fits, never over the captions).
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
  /** Box left edge X in canvas pixels (chosen zone). Omitted → centered fallback. */
  boxLeft?: number;
  /** Box top edge Y in canvas pixels (chosen zone). Omitted → below-captions fallback. */
  boxTop?: number;
  /** Box side length in pixels. Omitted → default size. */
  boxSize?: number;
  /** The transcript phrase this sticker emphasizes (logged / debug). */
  phrase?: string;
}
