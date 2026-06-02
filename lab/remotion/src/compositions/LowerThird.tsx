import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import {
  SAFE,
  SAFE_WIDTH,
  COLORS,
  FONT_FAMILY,
  enterProgress,
  exitProgress,
} from "../theme";

/**
 * Animated lower-third / name+title tag.
 *
 * Human craft choices:
 *  • It sits ABOVE the platform caption zone (anchored to the safe bottom), not
 *    in the screen-dead-center where burned-in captions live — a real editor
 *    keeps the two from fighting.
 *  • A thin accent bar WIPES out from the left first, then the text slides up a
 *    few pixels and fades in behind it (staggered, motivated — the bar
 *    "introduces" the text). The bar is the only decoration; no boxes-in-boxes.
 *  • Exit runs in reverse and faster: text fades, then the bar retracts.
 *  • Title is uppercase + tracked-out (editorial credit feel); name is mixed
 *    case ExtraBold. Hierarchy via size/weight/opacity, never via clutter.
 */
export interface LowerThirdProps {
  name: string;
  title?: string;
  /** Accent color for the bar; defaults to brand yellow. */
  accent?: string;
}

export const lowerThirdDefaults: LowerThirdProps = {
  name: "Jordan Rivera",
  title: "Founder, ClipMagic",
  accent: COLORS.yellow,
};

export const LowerThird: React.FC<LowerThirdProps> = ({
  name,
  title,
  accent = COLORS.yellow,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const barIn = enterProgress(frame, fps, 0);
  const textIn = enterProgress(frame, fps, 0.12);
  const out = exitProgress(frame, durationInFrames, fps, 0.3);

  // The bar wipes out from the left (scaleX), then retracts on exit.
  const barScaleX = barIn * out;
  // Text rises a few px into place and fades; exits by fading only.
  const textRise = interpolate(textIn, [0, 1], [14, 0], {
    easing: Easing.out(Easing.cubic),
  });
  const textOpacity = textIn * out;

  const barWidth = Math.min(SAFE_WIDTH, 560);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: SAFE.left,
          bottom: SAFE.bottom,
          width: SAFE_WIDTH,
          fontFamily: FONT_FAMILY,
        }}
      >
        {/* Accent bar — wipes from the left, transform-origin left. */}
        <div
          style={{
            width: barWidth,
            height: 8,
            borderRadius: 4,
            background: accent,
            transform: `scaleX(${barScaleX})`,
            transformOrigin: "left center",
            marginBottom: 18,
            boxShadow: `0 2px 14px ${accent}55`,
          }}
        />
        <div
          style={{
            transform: `translateY(${textRise}px)`,
            opacity: textOpacity,
          }}
        >
          <div
            style={{
              color: COLORS.white,
              fontSize: 64,
              fontWeight: 800,
              letterSpacing: "-0.01em",
              lineHeight: 1.02,
              textShadow: "0 3px 24px rgba(0,0,0,0.55)",
            }}
          >
            {name}
          </div>
          {title ? (
            <div
              style={{
                marginTop: 10,
                color: COLORS.muted,
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                textShadow: "0 2px 18px rgba(0,0,0,0.55)",
              }}
            >
              {title}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
