/**
 * Server-side copy of the renderer-agnostic RenderManifest contract.
 *
 * This mirrors `src/utils/renderManifest.ts` in the frontend. The frontend
 * builds a manifest from project + shots + subtitles; the server consumes it
 * and renders with local FFmpeg. Keeping a typed copy here (rather than
 * importing across the app/server boundary) matches how the original Zite
 * endpoints inlined the adapter.
 */

export type SceneType = "talking-head" | "screencast" | "broll";

export interface NarrationTrack {
  videoUrl: string;
  chunkUrls?: string[];
}

export interface MusicTrack {
  audioUrl: string;
  volume: number;
  trackName?: string;
  bpm?: number;
}

export interface OverlayClip {
  mediaType: "video" | "image";
  clipUrl: string;
  clipStartOffset: number;
  clipEndOffset: number;
  overlayDelaySeconds: number;
  showNarratorFirst: boolean;
  returnToNarrator: boolean;
  narratorReturnLeadSeconds: number;
  fadeInSeconds: number;
  isTacticalBroll: boolean;
}

export interface Scene {
  shotId: string;
  type: SceneType;
  caption?: string;
  beat?: string;
  startTime: number;
  endTime: number;
  overlay: OverlayClip | null;
  transitionIn?: string | null;
  sfxIn?: string | null;
}

/**
 * A single Remotion-rendered motion-graphic overlay, composited (alpha) over the
 * finished video at director-chosen times. The shapes mirror the props each
 * Remotion composition (lab/remotion/src/compositions) accepts; `id` selects the
 * composition and `data` is passed straight through as inputProps.
 *
 * These are deliberately SPARSE — a skilled editor uses 2–4 graphics in a 60s
 * short, motivated by the content (a name intro, a key stat, a section turn),
 * never as constant decoration. The director enforces that restraint upstream.
 */
export type MotionGraphicKind = "lower-third" | "stat-callout" | "section-card";

export interface MotionGraphicClip {
  /** Which Remotion composition renders this graphic. */
  kind: MotionGraphicKind;
  /** Output-timeline start, in seconds (when the graphic enters). */
  startTime: number;
  /** Output-timeline end, in seconds (when the graphic has fully exited). */
  endTime: number;
  /**
   * Composition props (passed verbatim to Remotion as inputProps). Shape depends
   * on `kind`; see the per-composition prop types in the Remotion project.
   */
  data: Record<string, unknown>;
  /** Short human rationale from the director (why this graphic, here). Logged. */
  reason?: string;
}

export interface SubtitleWord {
  text: string;
  start: number;
  end: number;
  emphasis: boolean;
}

export interface SubtitleEvent {
  start: number;
  end: number;
  words: SubtitleWord[];
}

/**
 * The viral subtitle styles. All render center-screen, 2–3 words at a time, with
 * the currently-spoken word highlighted (karaoke). Fonts are bundled in
 * server/assets/fonts and resolved by their internal family names.
 *
 *  1. yellow-mont   — Montserrat italic, #FEDA03; spoken word ExtraBold(800),
 *                     rest SemiBold(600); active word turns white; soft shadow.
 *  2. white-mont    — Montserrat ExtraBold upright, #FFFFFF; spoken word yellow;
 *                     soft shadow.
 *  3. yellow-box    — Alexandria Bold, #F9FC26 on a black rounded box; text 82%
 *                     of box height, equal padding; active word white.
 *  4. black-on-yellow — Montserrat Black (Gotham stand-in), #050000 ALL-CAPS on
 *                     a #F7BD05 rounded box; active word white.
 *  5. green-pop     — Hormozi green-highlight: white Montserrat ExtraBold, the
 *                     active word turns #19E07A green. (2025 high-retention combo.)
 *  6. pop-scale     — true active-word "pop": the spoken word turns yellow AND
 *                     scales up ~18% (a real size bump, not just a recolor),
 *                     mimicking the kinetic Hormozi/CapCut karaoke look.
 *  7. white-bold-bottom — clean white Montserrat ExtraBold, no karaoke recolor,
 *                     soft shadow; the calm, premium baseline.
 */
export type SubtitleTemplate =
  | "yellow-mont"
  | "white-mont"
  | "yellow-box"
  | "black-on-yellow"
  | "green-pop"
  | "pop-scale"
  | "white-bold-bottom";

/** The style rotation pool — a video randomly picks one of these. */
export const SUBTITLE_TEMPLATE_POOL: SubtitleTemplate[] = [
  "yellow-mont",
  "white-mont",
  "yellow-box",
  "black-on-yellow",
  "green-pop",
  "pop-scale",
  "white-bold-bottom",
];

export interface SubtitleStyle {
  /** Internal font family name (must match a file in assets/fonts). */
  fontFamily: string;
  /** Heavier family used for the active/emphasis word (optional). */
  emphasisFontFamily?: string;
  fontSize: number;
  position: "bottom-center" | "top-center" | "center";
  outlineColor: string;
  outlineWidth: number;
  lineColor: string;
  /** Color of the active (currently-spoken) word. */
  wordColor: string | null;
  /** Recolor the active word (karaoke). Styles 1 & 2 only. */
  highlightWord?: boolean;
  /**
   * Scale the active word up as it's spoken (a real per-word size "pop", not
   * just a recolor). Requires highlightWord. Fraction above 1, e.g. 1.18 = +18%.
   */
  popScale?: number;
  /**
   * Mask profanity in the burned-in caption text (audio untouched). Defaults to
   * true for brand-safe captions; set false to show verbatim words.
   */
  maskProfanity?: boolean;
  allCaps: boolean;
  maxWordsPerLine: number;
  template?: SubtitleTemplate;
  italic?: boolean;
  /** Letter spacing in ASS units (negative = tighter). */
  letterSpacing?: number;
  /** Soft drop shadow (separate blurred layer). */
  shadow?: boolean;
  /** Rounded background box (auto-sized to the text). */
  box?: boolean;
  boxColor?: string;
  /** Fraction of the box height the text should fill (e.g. 0.82). */
  boxFill?: number;
  /** Corner radius hint (scaled to the box). */
  boxRadius?: number;
}

export interface RenderManifest {
  version: number;
  projectId: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  narration: NarrationTrack;
  music: MusicTrack | null;
  scenes: Scene[];
  subtitles: SubtitleEvent[];
  subtitleStyle: SubtitleStyle;
  /**
   * Optional Remotion motion-graphic overlays, chosen by the director and
   * composited onto the final render. Absent/empty on every path where the
   * MOTION_GRAPHICS flag is off or no graphic was motivated — the render is
   * byte-for-byte unchanged in that case.
   */
  motionGraphics?: MotionGraphicClip[];
  /**
   * Optional emphasis stickers for the Meme/Sticker editor — funny generated
   * stills that slap on BELOW the captions, rendered via the Remotion
   * `emphasis-sticker` composition and composited in a separate best-effort
   * stage (server/src/meme). Absent on every other render path, so the standard
   * pipeline is byte-for-byte unchanged. Typed loosely here (the concrete shape
   * is EmphasisStickerClip in server/src/meme/sticker.ts) to avoid a cross-module
   * import in this renderer-contract file.
   */
  emphasisStickers?: Array<{
    startTime: number;
    endTime: number;
    imageUrl: string;
    restTiltDeg: number;
    /** Chosen placement box (any fitting zone, never over the captions). */
    boxLeft?: number;
    boxTop?: number;
    boxSize?: number;
    phrase?: string;
  }>;
  meta?: unknown;
}

export const SUBTITLE_TEMPLATES: Record<SubtitleTemplate, SubtitleStyle> = {
  "yellow-mont": {
    fontFamily: "Montserrat SemiBold",
    emphasisFontFamily: "Montserrat ExtraBold",
    fontSize: 96, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#FEDA03", wordColor: "#FFFFFF", highlightWord: true,
    allCaps: false, maxWordsPerLine: 3, template: "yellow-mont",
    italic: true, letterSpacing: -2, shadow: true, box: false,
  },
  "white-mont": {
    fontFamily: "Montserrat ExtraBold",
    fontSize: 96, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#FFFFFF", wordColor: "#FEDA03", highlightWord: true,
    allCaps: false, maxWordsPerLine: 3, template: "white-mont",
    italic: false, letterSpacing: -2, shadow: true, box: false,
  },
  "yellow-box": {
    fontFamily: "Alexandria",
    fontSize: 108, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#F9FC26", wordColor: "#FFFFFF",
    allCaps: false, maxWordsPerLine: 3, template: "yellow-box",
    italic: false, letterSpacing: -4, shadow: false,
    box: true, boxColor: "#000000", boxFill: 0.62, boxRadius: 70,
  },
  "black-on-yellow": {
    fontFamily: "Montserrat Black",
    fontSize: 88, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#050000", wordColor: "#FFFFFF",
    allCaps: true, maxWordsPerLine: 3, template: "black-on-yellow",
    italic: false, letterSpacing: -4, shadow: false,
    box: true, boxColor: "#F7BD05", boxFill: 0.62, boxRadius: 70,
  },
  // Hormozi green-highlight: white base, active word turns green. One of the
  // highest-retention color combos in 2025 short-form captioning.
  "green-pop": {
    fontFamily: "Montserrat ExtraBold",
    fontSize: 96, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#FFFFFF", wordColor: "#19E07A", highlightWord: true,
    allCaps: false, maxWordsPerLine: 3, template: "green-pop",
    italic: false, letterSpacing: -2, shadow: true, box: false,
  },
  // True active-word "pop": the spoken word recolors AND scales up (+18%),
  // mimicking the kinetic CapCut/Hormozi karaoke bounce.
  "pop-scale": {
    fontFamily: "Montserrat ExtraBold",
    fontSize: 92, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#FFFFFF", wordColor: "#FEDA03", highlightWord: true, popScale: 1.18,
    allCaps: true, maxWordsPerLine: 3, template: "pop-scale",
    italic: false, letterSpacing: -2, shadow: true, box: false,
  },
  // Clean premium baseline: white bold, no karaoke recolor, soft shadow.
  "white-bold-bottom": {
    fontFamily: "Montserrat ExtraBold",
    fontSize: 90, position: "center",
    outlineColor: "#000000", outlineWidth: 0,
    lineColor: "#FFFFFF", wordColor: null,
    allCaps: false, maxWordsPerLine: 3, template: "white-bold-bottom",
    italic: false, letterSpacing: -2, shadow: true, box: false,
  },
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = SUBTITLE_TEMPLATES["yellow-mont"];
