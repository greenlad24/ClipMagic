/**
 * Shared brand tokens + craft helpers for every motion graphic.
 *
 * The whole point of this file is that the graphics read as HUMAN-MADE, not
 * auto-generated. The craft lives here:
 *
 *  • Type & color come from the SAME palette the burned-in captions already use
 *    (Montserrat ExtraBold, the yellow/white/green accents) so a graphic never
 *    looks like a foreign template dropped onto the video.
 *  • 9:16 SAFE MARGINS are real: TikTok/Reels/Shorts UI (profile, caption, CTA
 *    rail) eats the outer ~7% sides and a tall strip at the bottom. Nothing
 *    important is allowed outside SAFE.
 *  • One easing vocabulary. Entrances use a gentle spring/cubic-out (motivated,
 *    settles — never a linear slide). Exits are FASTER than entrances (a real
 *    editor lets things leave quickly so they don't overstay). We never use
 *    bounce/elastic — that's the cheesy tell.
 */
import { interpolate, spring, Easing } from "remotion";

/** 9:16 master canvas. */
export const CANVAS = { width: 1080, height: 1920 } as const;

/**
 * Title-safe margins for vertical short-form. Sides clear the engagement rail;
 * bottom clears the caption/CTA stack; top clears the handle/sound row.
 */
export const SAFE = {
  left: Math.round(CANVAS.width * 0.07), // ~76px
  right: Math.round(CANVAS.width * 0.07),
  top: Math.round(CANVAS.height * 0.11), // ~211px
  bottom: Math.round(CANVAS.height * 0.18), // ~346px — platform UI is heaviest here
} as const;
export const SAFE_WIDTH = CANVAS.width - SAFE.left - SAFE.right;

/** Brand palette — mirrors the caption templates in render/manifest.ts. */
export const COLORS = {
  ink: "#0A0A0A",
  white: "#FFFFFF",
  yellow: "#FEDA03",
  green: "#19E07A",
  card: "#0E0E10",
  muted: "rgba(255,255,255,0.62)",
  hairline: "rgba(255,255,255,0.14)",
} as const;

/** Font stack — Montserrat is loaded via @remotion/google-fonts-free fallback. */
export const FONT_FAMILY =
  '"Montserrat", "Helvetica Neue", Arial, system-ui, sans-serif';

/**
 * A motivated entrance value 0→1. Spring with a firm-but-not-bouncy feel:
 * damping high enough that it settles cleanly (no wobble), stiffness tuned so a
 * graphic is fully in within ~0.45s — the "snappy but smooth" window pro editors
 * live in. `delay` staggers elements (title before subtitle, etc.).
 */
export function enterProgress(
  frame: number,
  fps: number,
  delaySeconds = 0,
): number {
  return spring({
    frame: frame - Math.round(delaySeconds * fps),
    fps,
    config: { damping: 200, stiffness: 140, mass: 0.7 },
    durationInFrames: Math.round(0.5 * fps),
  });
}

/**
 * Exit value 1→0 over the final `exitSeconds`. Faster than the entrance and on a
 * cubic-IN curve so the graphic accelerates away — the human "let it leave"
 * instinct. Returns 1 until the exit window begins.
 */
export function exitProgress(
  frame: number,
  durationInFrames: number,
  fps: number,
  exitSeconds = 0.32,
): number {
  const exitFrames = Math.round(exitSeconds * fps);
  const exitStart = durationInFrames - exitFrames;
  if (frame < exitStart) return 1;
  return interpolate(frame, [exitStart, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
}

/**
 * Combined enter×exit opacity/“present” factor for a whole graphic, so every
 * composition fades/scales in and out consistently.
 */
export function presence(
  frame: number,
  durationInFrames: number,
  fps: number,
  delaySeconds = 0,
): number {
  return enterProgress(frame, fps, delaySeconds) *
    exitProgress(frame, durationInFrames, fps);
}

/**
 * Eased count-up from `to*0` to `to` for stat callouts. Cubic-out so the number
 * decelerates into its final value (a real "lands on the figure" motion), and
 * it finishes well before the exit so the viewer reads the final number.
 */
export function countUp(
  frame: number,
  fps: number,
  to: number,
  opts: { delaySeconds?: number; durationSeconds?: number } = {},
): number {
  const delay = Math.round((opts.delaySeconds ?? 0.12) * fps);
  const dur = Math.round((opts.durationSeconds ?? 0.9) * fps);
  const p = interpolate(frame - delay, [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return to * p;
}
