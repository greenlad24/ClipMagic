import React from "react";
import { Composition } from "remotion";
import { CANVAS } from "./theme";
import {
  LowerThird,
  lowerThirdDefaults,
} from "./compositions/LowerThird";
import {
  StatCallout,
  statCalloutDefaults,
} from "./compositions/StatCallout";
import {
  SectionCard,
  sectionCardDefaults,
} from "./compositions/SectionCard";
import { loadFonts } from "./loadFonts";

loadFonts();

/**
 * Composition IDs are the contract with the server motion service: the
 * MotionGraphicKind values ("lower-third" | "stat-callout" | "section-card")
 * map 1:1 to the `id`s registered here.
 *
 * Each graphic's on-screen LENGTH is data-driven: the server passes
 * `durationInFrames` (computed from the clip's start/end + fps) as a prop, and
 * calculateMetadata applies it. That keeps timing in the director's hands while
 * the composition only owns the *motion*, not the duration.
 */

const FPS = 30;
const DEFAULT_DURATION_FRAMES = Math.round(2.5 * FPS);

type WithDuration = { durationInFrames?: number };

function metaFromProps(defaultFrames: number) {
  return ({ props }: { props: WithDuration }) => ({
    durationInFrames:
      typeof props.durationInFrames === "number" && props.durationInFrames > 0
        ? Math.round(props.durationInFrames)
        : defaultFrames,
    fps: FPS,
    width: CANVAS.width,
    height: CANVAS.height,
  });
}

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="lower-third"
        component={LowerThird as React.FC<WithDuration>}
        durationInFrames={Math.round(3 * FPS)}
        fps={FPS}
        width={CANVAS.width}
        height={CANVAS.height}
        defaultProps={lowerThirdDefaults}
        calculateMetadata={metaFromProps(Math.round(3 * FPS))}
      />
      <Composition
        id="stat-callout"
        component={StatCallout as React.FC<WithDuration>}
        durationInFrames={Math.round(2.6 * FPS)}
        fps={FPS}
        width={CANVAS.width}
        height={CANVAS.height}
        defaultProps={statCalloutDefaults}
        calculateMetadata={metaFromProps(Math.round(2.6 * FPS))}
      />
      <Composition
        id="section-card"
        component={SectionCard as React.FC<WithDuration>}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={FPS}
        width={CANVAS.width}
        height={CANVAS.height}
        defaultProps={sectionCardDefaults}
        calculateMetadata={metaFromProps(DEFAULT_DURATION_FRAMES)}
      />
    </>
  );
};
