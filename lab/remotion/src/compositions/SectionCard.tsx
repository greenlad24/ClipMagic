import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import {
  SAFE_WIDTH,
  COLORS,
  FONT_FAMILY,
  enterProgress,
  exitProgress,
} from "../theme";

/**
 * Clean section / title card — the "chapter turn" a human editor drops at a
 * genuine topic shift (e.g. "STEP 2", "THE CATCH"). Short and punchy.
 *
 * Human craft choices:
 *  • A small eyebrow (kicker) animates in FIRST, then a hairline draws across,
 *    then the title rises in beneath it — three staggered steps that feel
 *    choreographed rather than everything-at-once. This stagger is the single
 *    biggest "human" tell.
 *  • The title MASK-REVEALS upward (clipped, sliding from below its own
 *    baseline) instead of a plain fade — an editorial reveal, not a default.
 *  • Lives slightly above center so it never sits exactly where captions do.
 *  • Exit: everything fades together quickly (cards earn their keep by leaving
 *    promptly).
 */
export interface SectionCardProps {
  /** Small kicker above the title, e.g. "STEP 02" or "THE TWIST". */
  kicker?: string;
  /** The section title. Keep it to ~1–4 words for punch. */
  title: string;
  accent?: string;
}

export const sectionCardDefaults: SectionCardProps = {
  kicker: "Step 02",
  title: "The Catch",
  accent: COLORS.yellow,
};

export const SectionCard: React.FC<SectionCardProps> = ({
  kicker,
  title,
  accent = COLORS.yellow,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const kickerIn = enterProgress(frame, fps, 0);
  const lineIn = enterProgress(frame, fps, 0.1);
  const titleIn = enterProgress(frame, fps, 0.2);
  const out = exitProgress(frame, durationInFrames, fps, 0.28);

  const titleRise = interpolate(titleIn, [0, 1], [110, 0], {
    easing: Easing.out(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: SAFE_WIDTH,
          // Sit a touch above true center.
          transform: "translateY(-8%)",
          fontFamily: FONT_FAMILY,
          textAlign: "center",
          opacity: out,
        }}
      >
        {kicker ? (
          <div
            style={{
              color: accent,
              fontSize: 34,
              fontWeight: 800,
              letterSpacing: "0.26em",
              textTransform: "uppercase",
              opacity: kickerIn,
              transform: `translateY(${interpolate(kickerIn, [0, 1], [10, 0])}px)`,
              textShadow: "0 2px 18px rgba(0,0,0,0.5)",
            }}
          >
            {kicker}
          </div>
        ) : null}

        {/* Hairline that draws out from the center. */}
        <div
          style={{
            margin: "20px auto",
            width: Math.min(SAFE_WIDTH * 0.5, 360),
            height: 3,
            background: COLORS.hairline,
            transform: `scaleX(${lineIn})`,
          }}
        />

        {/* Title mask-reveal: clip the box, slide the text up from below. */}
        <div style={{ overflow: "hidden", paddingBottom: 8 }}>
          <div
            style={{
              color: COLORS.white,
              fontSize: 96,
              fontWeight: 800,
              lineHeight: 1.0,
              letterSpacing: "-0.02em",
              transform: `translateY(${titleRise}px)`,
              textShadow: "0 6px 30px rgba(0,0,0,0.5)",
            }}
          >
            {title}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
