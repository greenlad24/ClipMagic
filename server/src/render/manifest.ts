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

/** Built-in viral subtitle looks. All render center-screen. */
export type SubtitleTemplate =
  | "bold-center"   // big white, heavy black box — classic punchy captions
  | "hormozi"       // all-caps, key words in bright yellow, thick outline
  | "karaoke-pop"   // emphasized words pop in accent color, no box
  | "tiktok-clean"  // clean white, soft shadow, rounded feel
  | "neon"          // bright accent text with strong glow/outline
  | "minimal";      // understated lower-third-style, smaller

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  position: "bottom-center" | "top-center" | "center";
  outlineColor: string;
  outlineWidth: number;
  lineColor: string;
  wordColor: string | null;
  allCaps: boolean;
  maxWordsPerLine: number;
  /** Named template (drives look). Center is enforced regardless of position. */
  template?: SubtitleTemplate;
  /** Draw the dark box behind text. */
  box?: boolean;
  boxColor?: string;
  boxOpacity?: number;
  boxBorderWidth?: number;
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

/**
 * Subtitle templates — all CENTER-screen, designed to look modern/viral.
 * Colors are hex; the renderer maps them to FFmpeg drawtext options.
 */
export const SUBTITLE_TEMPLATES: Record<SubtitleTemplate, SubtitleStyle> = {
  "bold-center": {
    fontFamily: "DejaVu Sans Bold", fontSize: 52, position: "center",
    outlineColor: "#000000", outlineWidth: 8, lineColor: "#FFFFFF", wordColor: "#FFE600",
    allCaps: true, maxWordsPerLine: 4, template: "bold-center",
    box: true, boxColor: "#000000", boxOpacity: 0.55, boxBorderWidth: 14,
  },
  hormozi: {
    fontFamily: "DejaVu Sans Bold", fontSize: 58, position: "center",
    outlineColor: "#000000", outlineWidth: 10, lineColor: "#FFFFFF", wordColor: "#FFD400",
    allCaps: true, maxWordsPerLine: 3, template: "hormozi",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  "karaoke-pop": {
    fontFamily: "DejaVu Sans Bold", fontSize: 50, position: "center",
    outlineColor: "#000000", outlineWidth: 7, lineColor: "#FFFFFF", wordColor: "#22D3EE",
    allCaps: true, maxWordsPerLine: 4, template: "karaoke-pop",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  "tiktok-clean": {
    fontFamily: "DejaVu Sans Bold", fontSize: 46, position: "center",
    outlineColor: "#000000", outlineWidth: 5, lineColor: "#FFFFFF", wordColor: "#FFFFFF",
    allCaps: false, maxWordsPerLine: 5, template: "tiktok-clean",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  neon: {
    fontFamily: "DejaVu Sans Bold", fontSize: 52, position: "center",
    outlineColor: "#0A0A2A", outlineWidth: 10, lineColor: "#39FF14", wordColor: "#FF00E5",
    allCaps: true, maxWordsPerLine: 4, template: "neon",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  minimal: {
    fontFamily: "DejaVu Sans Bold", fontSize: 38, position: "center",
    outlineColor: "#000000", outlineWidth: 4, lineColor: "#FFFFFF", wordColor: "#FFE600",
    allCaps: false, maxWordsPerLine: 5, template: "minimal",
    box: true, boxColor: "#000000", boxOpacity: 0.35, boxBorderWidth: 10,
  },
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = SUBTITLE_TEMPLATES["bold-center"];
