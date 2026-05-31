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

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "DejaVu Sans Bold",
  fontSize: 40,
  position: "bottom-center",
  outlineColor: "#000000",
  outlineWidth: 6,
  lineColor: "#FFFFFF",
  wordColor: "#c084fc",
  allCaps: true,
  maxWordsPerLine: 4,
};
