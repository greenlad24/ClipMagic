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
 * POSITION — the hard product rule: the sticker sits BELOW the captions.
 * Captions burn in at screen CENTER, so the sticker's box is centered
 * horizontally and its TOP edge starts below center (STICKER_TOP_FRACTION of the
 * canvas height) and is sized to never cross into the bottom platform-UI safe
 * margin. It can never overlap the caption zone. See `stickerBox()` in
 * server/src/meme/sticker.ts for the matching server-side geometry/assert.
 */

/**
 * Top of the sticker box as a fraction of canvas height. 0.60 = the box begins
 * at 60% down the frame — comfortably below the centered caption line, in the
 * lower third. The server keeps this in sync (and asserts it lands below the
 * caption zone within the bottom safe margin).
 */
export const STICKER_TOP_FRACTION = 0.6;

export interface EmphasisStickerProps {
  /** URL/staticFile of the generated still image (PNG, ideally transparent). */
  imageUrl: string;
  /** A small resting tilt in degrees the sticker settles to (e.g. -4..4). */
  restTiltDeg?: number;
  /** Show the white die-cut border + shadow (the sticker look). Default true. */
  bordered?: boolean;
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

  // ── Box geometry — BELOW the captions, within the bottom safe margin. ───────
  const boxTop = Math.round(CANVAS.height * STICKER_TOP_FRACTION);
  // Leave the platform-UI safe strip clear at the bottom.
  const boxBottom = CANVAS.height - SAFE.bottom;
  const boxHeight = boxBottom - boxTop;
  // A tasteful square-ish sticker, capped by the available height and a sane
  // width so it never spans edge-to-edge.
  const size = Math.min(boxHeight, Math.round(CANVAS.width * 0.52));

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: boxTop,
          left: 0,
          width: CANVAS.width,
          height: boxHeight,
          display: "flex",
          alignItems: "flex-start",
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
