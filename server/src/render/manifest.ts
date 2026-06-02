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
 * The four approved viral subtitle styles. All render center-screen, 2–3 words
 * at a time, with the currently-spoken word highlighted (karaoke). Fonts are
 * bundled in server/assets/fonts and resolved by their internal family names.
 *
 *  1. yellow-mont   — Montserrat italic, #FEDA03; spoken word ExtraBold(800),
 *                     rest SemiBold(600); active word turns white; soft shadow.
 *  2. white-mont    — Montserrat ExtraBold upright, #FFFFFF; spoken word yellow;
 *                     soft shadow.
 *  3. yellow-box    — Alexandria Bold, #F9FC26 on a black rounded box; text 82%
 *                     of box height, equal padding; active word white.
 *  4. black-on-yellow — Montserrat Black (Gotham stand-in), #050000 ALL-CAPS on
 *                     a #F7BD05 rounded box; active word white.
 */
export type SubtitleTemplate =
  | "yellow-mont"
  | "white-mont"
  | "yellow-box"
  | "black-on-yellow";

/** The 4-style rotation pool — a video randomly picks one of these. */
export const SUBTITLE_TEMPLATE_POOL: SubtitleTemplate[] = [
  "yellow-mont",
  "white-mont",
  "yellow-box",
  "black-on-yellow",
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
  /** Extra horizontal padding inside the box, as a fraction of the font size
   *  (added to each side on top of the default symmetric padding). */
  boxPadX?: number;
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
    box: true, boxColor: "#000000", boxFill: 0.82, boxPadX: 0.32, boxRadius: 70,
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
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = SUBTITLE_TEMPLATES["yellow-mont"];
