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
  CANVAS,
  COLORS,
  FONT_FAMILY,
  enterProgress,
  exitProgress,
  countUp,
} from "../theme";

/**
 * Key stat / number callout with an EASED count-up.
 *
 * Human craft choices:
 *  • The number counts up on a cubic-OUT curve so it decelerates and "lands" on
 *    the final figure — then holds, fully readable, long before the exit. A
 *    count-up that's still moving when it leaves screen reads as broken; a real
 *    editor always lets the figure settle.
 *  • The value is the hero (huge, ExtraBold, accent color); prefix/suffix (%, x,
 *    $, +) and the label are subordinate — strict hierarchy, no competing sizes.
 *  • Enters with a small scale-from-0.92 + fade (a confident "pop-on", not a
 *    bounce). Sits in the upper third so it doesn't collide with center captions.
 *  • Numbers are locale-formatted (1,200 not 1200) — the kind of detail
 *    auto-generators skip.
 */
export interface StatCalloutProps {
  /** The final numeric value to count up to. */
  value: number;
  /** e.g. "$", shown before the number. */
  prefix?: string;
  /** e.g. "%", "x", "+", shown after the number. */
  suffix?: string;
  /** Supporting label under the number, e.g. "FASTER EDITS". */
  label?: string;
  accent?: string;
  /** Decimal places to keep on the animated value (default 0). */
  decimals?: number;
}

export const statCalloutDefaults: StatCalloutProps = {
  value: 10,
  suffix: "x",
  label: "Faster edits",
  accent: COLORS.green,
  decimals: 0,
};

export const StatCallout: React.FC<StatCalloutProps> = ({
  value,
  prefix = "",
  suffix = "",
  label,
  accent = COLORS.green,
  decimals = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const inP = enterProgress(frame, fps, 0);
  const out = exitProgress(frame, durationInFrames, fps, 0.3);
  const present = inP * out;

  const scale = interpolate(inP, [0, 1], [0.92, 1], {
    easing: Easing.out(Easing.cubic),
  });

  const current = countUp(frame, fps, value, {
    delaySeconds: 0.1,
    durationSeconds: 0.85,
  });
  const shown = current.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <AbsoluteFill
      style={{ alignItems: "center", justifyContent: "flex-start" }}
    >
      <div
        style={{
          marginTop: SAFE.top + Math.round(CANVAS.height * 0.06),
          fontFamily: FONT_FAMILY,
          textAlign: "center",
          transform: `scale(${scale})`,
          opacity: present,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "center",
            color: accent,
            lineHeight: 0.92,
            textShadow: "0 6px 34px rgba(0,0,0,0.5)",
          }}
        >
          {prefix ? (
            <span style={{ fontSize: 120, fontWeight: 800, marginRight: 6 }}>
              {prefix}
            </span>
          ) : null}
          <span style={{ fontSize: 240, fontWeight: 800, letterSpacing: "-0.03em" }}>
            {shown}
          </span>
          {suffix ? (
            <span style={{ fontSize: 132, fontWeight: 800, marginLeft: 6 }}>
              {suffix}
            </span>
          ) : null}
        </div>
        {label ? (
          <div
            style={{
              marginTop: 14,
              color: COLORS.white,
              fontSize: 42,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              textShadow: "0 3px 22px rgba(0,0,0,0.55)",
            }}
          >
            {label}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
