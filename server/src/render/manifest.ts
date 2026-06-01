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
  | "hormozi"       // all-caps, active word pops bright yellow, thick outline
  | "yellow-italic" // bold yellow italic, active word white — the 2nd ref style
  | "bold-center"   // big white, heavy black box — classic punchy captions
  | "karaoke-pop"   // active word pops in cyan, no box
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
  /** Italic text (e.g. the yellow-italic style). */
  italic?: boolean;
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
    fontFamily: "DejaVu Sans Bold", fontSize: 78, position: "center",
    outlineColor: "#000000", outlineWidth: 12, lineColor: "#FFFFFF", wordColor: "#FFE600",
    allCaps: true, maxWordsPerLine: 3, template: "bold-center",
    box: true, boxColor: "#000000", boxOpacity: 0.55, boxBorderWidth: 18,
  },
  hormozi: {
    // Big, punchy, all-caps — the signature look. 2–3 word captions only, so
    // we can afford a large font for maximum pop.
    fontFamily: "DejaVu Sans Bold", fontSize: 92, position: "center",
    outlineColor: "#000000", outlineWidth: 16, lineColor: "#FFFFFF", wordColor: "#FFD400",
    allCaps: true, maxWordsPerLine: 3, template: "hormozi",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  "yellow-italic": {
    // Bold YELLOW ITALIC with a soft shadow and only a thin edge — NO thick
    // black border (matches the reference clip). The active word turns white.
    fontFamily: "DejaVu Sans Bold", fontSize: 88, position: "center",
    outlineColor: "#000000", outlineWidth: 3, lineColor: "#FFE100", wordColor: "#FFFFFF",
    allCaps: false, maxWordsPerLine: 3, template: "yellow-italic", italic: true,
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  "karaoke-pop": {
    fontFamily: "DejaVu Sans Bold", fontSize: 84, position: "center",
    outlineColor: "#000000", outlineWidth: 14, lineColor: "#FFFFFF", wordColor: "#22D3EE",
    allCaps: true, maxWordsPerLine: 3, template: "karaoke-pop",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  "tiktok-clean": {
    fontFamily: "DejaVu Sans Bold", fontSize: 46, position: "center",
    outlineColor: "#000000", outlineWidth: 5, lineColor: "#FFFFFF", wordColor: "#FFFFFF",
    allCaps: false, maxWordsPerLine: 5, template: "tiktok-clean",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  neon: {
    fontFamily: "DejaVu Sans Bold", fontSize: 84, position: "center",
    outlineColor: "#0A0A2A", outlineWidth: 14, lineColor: "#39FF14", wordColor: "#FF00E5",
    allCaps: true, maxWordsPerLine: 3, template: "neon",
    box: false, boxColor: "#000000", boxOpacity: 0, boxBorderWidth: 0,
  },
  minimal: {
    fontFamily: "DejaVu Sans Bold", fontSize: 38, position: "center",
    outlineColor: "#000000", outlineWidth: 4, lineColor: "#FFFFFF", wordColor: "#FFE600",
    allCaps: false, maxWordsPerLine: 5, template: "minimal",
    box: true, boxColor: "#000000", boxOpacity: 0.35, boxBorderWidth: 10,
  },
};

// Hormozi is the default look — big, popping, 2–3 word captions.
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = SUBTITLE_TEMPLATES["hormozi"];
