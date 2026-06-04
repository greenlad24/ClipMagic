/**
 * Sticker placement geometry + manifest type for the Meme/Sticker editor.
 *
 * THE PRODUCT RULE (relaxed): a sticker may slap on ANYWHERE it fits — top band,
 * upper-left/right, center-upper, or below the captions — as long as it (a) NEVER
 * overlaps the burned-in caption zone, (b) stays inside the 9:16 safe margins,
 * and (c) doesn't run off-frame given its own size. Placement VARIES across
 * stickers (deterministic per moment index) for visual interest, the way a real
 * editor scatters reaction cut-outs around the frame instead of stacking them all
 * in the same lower-third slot.
 *
 * This file is the single source of truth for that geometry (the Remotion
 * EmphasisSticker composition consumes the chosen box as props). `placeSticker`
 * picks a fitting zone per sticker and `assertFits` is exercised in the tests so
 * a regression that lets a sticker drift into the caption zone — or off-frame —
 * fails the build, not a viewer.
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
 * Candidate placement zones, in deterministic rotation order. Each computes its
 * top-left for a size CLAMPED to that zone's own room (vertical band + side
 * rails), then validates the result fits + clears the captions. A zone returns
 * null only when it genuinely can't hold even the minimum sticker, so every zone
 * with room is reachable (placement truly varies) while NONE can overlap the
 * captions or run off-frame.
 */
type ZoneFn = (size: number) => StickerBox | null;

/** Build a box and validate it fits + clears captions; null if it doesn't. */
function boxIfFits(zone: string, left: number, top: number, size: number): StickerBox | null {
  if (size < MIN_STICKER_SIZE) return null;
  const box: StickerBox = { left, top, size, bottom: top + size, zone };
  try {
    assertFits(box);
    return box;
  } catch {
    return null;
  }
}

const ZONES: Array<{ name: string; fn: ZoneFn }> = [
  // 1. Below the captions, centered (the classic lower-third slot).
  {
    name: "below-captions",
    fn: (size) => {
      const top = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
      const room = Math.min(size, CANVAS.height - SAFE_BOTTOM - top, maxWidthRoom());
      const left = Math.round((CANVAS.width - room) / 2);
      return boxIfFits("below-captions", left, top, room);
    },
  },
  // 2. Top band, centered under the platform handle/sound row.
  {
    name: "top-center",
    fn: (size) => {
      const top = SAFE_TOP + Math.round(CANVAS.height * 0.01);
      const room = Math.min(size, CAPTION_TOP() - top, maxWidthRoom());
      const left = Math.round((CANVAS.width - room) / 2);
      return boxIfFits("top-center", left, top, room);
    },
  },
  // 3. Upper-left, hugging the left safe rail.
  {
    name: "upper-left",
    fn: (size) => {
      const top = SAFE_TOP + Math.round(CANVAS.height * 0.02);
      const room = Math.min(size, CAPTION_TOP() - top, maxWidthRoom());
      return boxIfFits("upper-left", SAFE_LEFT, top, room);
    },
  },
  // 4. Upper-right, hugging the right safe rail.
  {
    name: "upper-right",
    fn: (size) => {
      const top = SAFE_TOP + Math.round(CANVAS.height * 0.02);
      const room = Math.min(size, CAPTION_TOP() - top, maxWidthRoom());
      const left = CANVAS.width - SAFE_RIGHT - room;
      return boxIfFits("upper-right", left, top, room);
    },
  },
  // 5. Center-upper: sitting just above the caption band, centered.
  {
    name: "center-upper",
    fn: (size) => {
      const room = Math.min(size, CAPTION_TOP() - SAFE_TOP, maxWidthRoom());
      const top = CAPTION_TOP() - room - Math.round(CANVAS.height * 0.01);
      const left = Math.round((CANVAS.width - room) / 2);
      return boxIfFits("center-upper", left, top, room);
    },
  },
];

/**
 * Pick a fitting zone for the sticker at `index`. Deterministic: the index
 * selects a STARTING zone (so adjacent stickers land in different places), then
 * we scan the rotation for the first zone that can hold the sticker (each zone
 * clamps the size to its own room). If somehow nothing fits we fall back to the
 * always-valid below-captions slot.
 */
export function placeSticker(index: number, size: number = defaultStickerSize()): StickerBox {
  for (let trySize = size; trySize >= MIN_STICKER_SIZE; trySize = Math.round(trySize * 0.85)) {
    for (let k = 0; k < ZONES.length; k++) {
      const zone = ZONES[(index + k) % ZONES.length];
      const box = zone.fn(trySize);
      if (box) return box;
    }
  }
  // Guaranteed-valid fallback: the below-captions slot sized to its own band.
  const top = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
  const maxSize = Math.min(
    CANVAS.height - SAFE_BOTTOM - top,
    CANVAS.width - SAFE_LEFT - SAFE_RIGHT,
  );
  const fallbackSize = Math.max(120, maxSize);
  const left = Math.round((CANVAS.width - fallbackSize) / 2);
  return { left, top, size: fallbackSize, bottom: top + fallbackSize, zone: "below-captions" };
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
 * reserved caption band. The relaxed rule: "fits inside the safe area AND never
 * overlaps the captions" — for ANY zone, not just below-captions. Called by tests
 * and cheap enough to also call at runtime.
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
