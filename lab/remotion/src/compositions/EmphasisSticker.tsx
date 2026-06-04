import React from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";
import { CANVAS, SAFE } from "../theme";

/**
 * EMPHASIS STICKER — a funny AI-generated still image that "slaps on" below the
 * captions to land a point, then pops out. The meme/commentary editor's one
 * visual flourish.
 *
 * This is deliberately NOT a plain fade (that's the cheesy auto-generated tell).
 * The motion is a STICKER slap-on, the way an editor drops a cut-out PNG:
 *  • Enter: an overshoot pop — a spring scales it past 1.0 and settles, paired
 *    with a tiny rotation "wiggle" that decays to a small resting tilt. It reads
 *    as a physical sticker being smacked onto the frame.
 *  • Hold: it sits still and fully readable for the middle of its window.
 *  • Exit: a quick scale-down + fade (faster than the entrance — let it leave).
 *
 * STICKER LOOK: a clean white outline/border + soft drop shadow around the
 * image, so even a transparent-background cut-out reads as a die-cut sticker.
 *
 * POSITION — the product rule (relaxed): the sticker may slap on ANYWHERE it
 * fits — top band, upper-left/right, center-upper, or below the captions — as
 * long as it never overlaps the centered caption zone and stays inside the 9:16
 * safe margins. The SERVER chooses a fitting zone per sticker (see
 * `placeSticker()` in server/src/meme/sticker.ts, which also asserts it fits +
 * clears the captions) and passes the exact box (boxLeft / boxTop / boxSize) in
 * as props. When no box is given we fall back to the centered below-captions slot
 * so an older manifest still renders correctly.
 */

/**
 * Fallback top of the sticker box as a fraction of canvas height, used only when
 * the server didn't pass an explicit box. 0.60 = below the centered caption line.
 */
export const STICKER_TOP_FRACTION = 0.6;

export interface EmphasisStickerProps {
  /** URL/staticFile of the generated still image (PNG, ideally transparent). */
  imageUrl: string;
  /** A small resting tilt in degrees the sticker settles to (e.g. -4..4). */
  restTiltDeg?: number;
  /** Show the white die-cut border + shadow (the sticker look). Default true. */
  bordered?: boolean;
  /** Chosen box left edge X in canvas px (server-picked zone). */
  boxLeft?: number;
  /** Chosen box top edge Y in canvas px (server-picked zone). */
  boxTop?: number;
  /** Chosen box side length in px (server-picked zone). */
  boxSize?: number;
}

export const emphasisStickerDefaults: EmphasisStickerProps = {
  imageUrl: "",
  restTiltDeg: -4,
  bordered: true,
};

export const EmphasisSticker: React.FC<EmphasisStickerProps> = ({
  imageUrl,
  restTiltDeg = -4,
  bordered = true,
  boxLeft,
  boxTop,
  boxSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ── Enter: overshooting spring (the "slap"). Low damping → a real pop past
  //    1.0 that settles, not the gentle no-overshoot spring the lower-third uses.
  const pop = spring({
    frame,
    fps,
    config: { damping: 9, stiffness: 170, mass: 0.7 },
    durationInFrames: Math.round(0.6 * fps),
  });

  // ── Exit: quick scale-down + fade over the final ~0.32s (faster than enter).
  const exitFrames = Math.round(0.32 * fps);
  const exitStart = durationInFrames - exitFrames;
  const exit =
    frame < exitStart
      ? 1
      : interpolate(frame, [exitStart, durationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.in(Easing.cubic),
        });

  const scale = pop * interpolate(exit, [0, 1], [0.7, 1]);
  const opacity = interpolate(pop, [0, 0.25, 1], [0, 1, 1]) * exit;

  // ── Rotation wiggle: a damped sinusoid that decays to the resting tilt — the
  //    sticker "wobbles" on impact, then holds at a slight slapped-on angle.
  const wiggleT = frame / fps;
  const wiggle = Math.sin(wiggleT * 22) * 10 * Math.exp(-wiggleT * 7);
  const rotation = (restTiltDeg + wiggle) * pop * exit;

  // ── Box geometry — the SERVER-chosen zone (any fitting position), or a
  //    centered below-captions fallback for older manifests. ───────────────────
  const fallbackTop = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
  const fallbackSize = Math.min(
    CANVAS.height - SAFE.bottom - fallbackTop,
    Math.round(CANVAS.width * 0.52),
  );
  const size = typeof boxSize === "number" && boxSize > 0 ? boxSize : fallbackSize;
  const top = typeof boxTop === "number" ? boxTop : fallbackTop;
  const left =
    typeof boxLeft === "number" ? boxLeft : Math.round((CANVAS.width - size) / 2);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top,
          left,
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: size,
            height: size,
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
            opacity,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            // The die-cut sticker look: a clean white edge + soft drop shadow.
            filter: bordered
              ? "drop-shadow(0 0 6px #fff) drop-shadow(0 0 6px #fff) drop-shadow(0 14px 26px rgba(0,0,0,0.5))"
              : "drop-shadow(0 14px 26px rgba(0,0,0,0.5))",
          }}
        >
          {imageUrl ? (
            // Remotion's <Img> blocks the render until the image has loaded (via
            // delayRender), so the sticker never captures a half-painted frame.
            <Img
              src={imageUrl}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
