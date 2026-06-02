/**
 * Renderer-Agnostic Render Manifest — v1
 *
 * Canonical internal representation of a video composition.
 * Built from project + shots + subtitles data. Consumed by any renderer
 * (browser captureStream, JSON2Video, Remotion, FFmpeg, etc.).
 *
 * Design principles:
 * - Self-contained: every URL, offset, and timing is resolved at build time
 * - Renderer-independent: no JSON2Video / Remotion / FFmpeg specifics
 * - Lossless: captures ALL pacing metadata (narrator-first, return-to-narrator, clip offsets)
 * - Ordered: scenes are sorted by startTime, non-overlapping within each layer
 */

// ─── Manifest Root ───────────────────────────────────────────────────────────

export interface RenderManifest {
  /** Schema version — increment on breaking changes */
  version: 1;

  /** Source project ID */
  projectId: string;

  /** Output canvas dimensions */
  width: number;
  height: number;

  /** Target frames per second */
  fps: number;

  /** Total composition duration in seconds */
  durationSeconds: number;

  /** Narration (talking-head) video — the base layer */
  narration: NarrationTrack;

  /** Background music track (optional) */
  music: MusicTrack | null;

  /** Ordered list of scenes — each scene owns a time range */
  scenes: Scene[];

  /** Word-level subtitle events */
  subtitles: SubtitleEvent[];

  /** Subtitle styling — renderer adapters map this to their own API */
  subtitleStyle: SubtitleStyle;

  /** Opaque client metadata — pass-through for downstream consumers */
  meta: ManifestMeta;
}

// ─── Narration ───────────────────────────────────────────────────────────────

export interface NarrationTrack {
  /** Primary narration video URL */
  videoUrl: string;

  /**
   * If the narration was uploaded in chunks, these are the ordered chunk URLs.
   * A renderer that supports chunked assembly should concatenate them;
   * otherwise fall back to `videoUrl`.
   */
  chunkUrls: string[];
}

// ─── Music ───────────────────────────────────────────────────────────────────

export interface MusicTrack {
  /** Audio file URL */
  audioUrl: string;

  /** 0–1 volume level (relative to narration at 1.0) */
  volume: number;

  /** Track name for diagnostics */
  trackName?: string;

  /** BPM if known */
  bpm?: number;
}

// ─── Scenes ──────────────────────────────────────────────────────────────────

export type SceneType = 'talking-head' | 'screencast' | 'broll';

export interface Scene {
  /** Unique shot ID (matches database record) */
  shotId: string;

  /** Discriminator for the visual content type */
  type: SceneType;

  /** Human-readable caption / beat description */
  caption: string;

  /** Beat label from the script structure (e.g. "Hook", "CTA") */
  beat: string;

  /** Timeline position — absolute seconds from video start */
  startTime: number;
  endTime: number;

  /** Camera motion on the narration layer during this scene */
  camera: CameraMotion;

  /**
   * Overlay clip — present for screencast and broll scenes.
   * null for talking-head scenes (narration video is the only visual).
   */
  overlay: OverlayClip | null;

  /** Transition effect entering this scene */
  transitionIn: string | null;

  /** Sound effect on scene entry */
  sfxIn: string | null;
}

// ─── Camera Motion ───────────────────────────────────────────────────────────

export interface CameraKeyframe {
  /** Normalised time within the scene (0–1) */
  t: number;
  /** Zoom factor (1.0 = no zoom) */
  zoom: number;
  /** Horizontal pan (-0.2 to 0.2, fraction of canvas width) */
  panX: number;
  /** Vertical pan (-0.2 to 0.2, fraction of canvas height) */
  panY: number;
}

export interface CameraMotion {
  /** Ordered keyframes. Empty array = static camera (zoom 1, pan 0,0) */
  keyframes: CameraKeyframe[];
}

// ─── Overlay Clip ────────────────────────────────────────────────────────────

export interface OverlayClip {
  /** Media type */
  mediaType: 'video' | 'image';

  /** Fully-qualified clip URL */
  clipUrl: string;

  /**
   * Where in the source clip to start playback (seconds).
   * 0 = from the beginning.
   */
  clipStartOffset: number;

  /**
   * Where in the source clip to stop playback (seconds).
   * 0 = play until natural end or scene end, whichever comes first.
   */
  clipEndOffset: number;

  /**
   * Narrator-first pacing: seconds to wait showing the narrator
   * before the overlay fades in. 0 = overlay enters immediately.
   */
  overlayDelaySeconds: number;

  /** Whether the narrator is shown first before the overlay */
  showNarratorFirst: boolean;

  /**
   * Return-to-narrator pacing: if true, cut back to narrator
   * `narratorReturnLeadSeconds` before the scene ends.
   */
  returnToNarrator: boolean;

  /** Seconds before scene end to cut back to narrator */
  narratorReturnLeadSeconds: number;

  /** Overlay fade-in duration in seconds */
  fadeInSeconds: number;

  /** Whether this is a required tactical B-Roll slot */
  isTacticalBroll: boolean;
}

// ─── Subtitles ───────────────────────────────────────────────────────────────

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
 * Subtitle styling configuration.
 * Renderer-agnostic — each adapter maps these to its own subtitle API.
 */
export interface SubtitleStyle {
  /** Font family name, e.g. "Montserrat Bold", "Arial". */
  fontFamily: string;
  /** Font size in pixels (at the manifest's `width` resolution). */
  fontSize: number;
  /** Vertical position: bottom-center, top-center, center. */
  position: 'bottom-center' | 'top-center' | 'center';
  /** Outline (stroke) color around each glyph, hex string. */
  outlineColor: string;
  /** Outline width in pixels. */
  outlineWidth: number;
  /** Default line (non-active) text color, hex string. */
  lineColor: string;
  /** Active / highlight word color, hex string. null = same as lineColor. */
  wordColor: string | null;
  /** Whether to render text in ALL CAPS. */
  allCaps: boolean;
  /** Max words per visible subtitle line. */
  maxWordsPerLine: number;
}

// ─── Client Metadata ─────────────────────────────────────────────────────────

export interface ManifestMeta {
  /** Project title */
  title: string;

  /** ISO 8601 timestamp when the manifest was built */
  builtAt: string;

  /** Generator identifier */
  generator: string;

  /** Total number of scenes by type */
  sceneCounts: {
    talkingHead: number;
    screencast: number;
    broll: number;
  };

  /** Animation map from the project (second → intensity) */
  animationMap: Array<{ second: number; intensity: string }>;
}

// ─── Manifest Builder ────────────────────────────────────────────────────────

import type {
  TimelineShot,
  SubtitleEvent as EditorSubtitleEvent,
} from '@/components/timeline/types';

const OVERLAY_FADE_IN = 0.15;

function isImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  const clean = url.split('?')[0].toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif|avif|bmp|svg)$/.test(clean);
}

function parseShotMeta(uiLabelsJson: string | undefined) {
  if (!uiLabelsJson) return {};
  try { return JSON.parse(uiLabelsJson); } catch { return {}; }
}

function resolveSceneType(shotType: string | undefined): SceneType {
  if (!shotType) return 'broll';
  const st = shotType.toLowerCase().replace(/[\s_-]/g, '');
  if (st === 'talkinghead') return 'talking-head';
  if (st === 'screencast') return 'screencast';
  return 'broll';
}

export interface BuildManifestInput {
  projectId: string;
  title: string;
  narrationUrl: string;
  videoChunksJson?: string;
  durationSeconds: number;
  shots: TimelineShot[];
  subtitles: EditorSubtitleEvent[];
  musicUrl?: string;
  musicVolume?: number;
  musicTrackName?: string;
  musicBpm?: number;
  animationMapJson?: string;
  subtitleStyle?: Partial<SubtitleStyle>;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * Build a renderer-agnostic manifest from project data.
 *
 * Pure function — no side-effects, no network calls.
 * Returns a fully self-contained manifest ready for any renderer.
 */
export function buildRenderManifest(input: BuildManifestInput): RenderManifest {
  const {
    projectId, title, narrationUrl, videoChunksJson, durationSeconds,
    shots, subtitles, musicUrl, musicVolume = 0.18,
    musicTrackName, musicBpm, animationMapJson, subtitleStyle: stylePart,
    width = 720, height = 1280, fps = 30,
  } = input;

  // Merge user overrides with sensible defaults
  const resolvedSubtitleStyle: SubtitleStyle = {
    fontFamily: 'Montserrat Bold',
    fontSize: Math.round(width * 0.055),
    position: 'bottom-center',
    outlineColor: '#000000',
    outlineWidth: 6,
    lineColor: '#FFFFFF',
    wordColor: '#c084fc',
    allCaps: true,
    maxWordsPerLine: 4,
    ...stylePart,
  };

  // ── Parse chunk URLs ─────────────────────────────────────────────────────
  let chunkUrls: string[] = [];
  try { if (videoChunksJson) chunkUrls = JSON.parse(videoChunksJson); } catch { /* */ }

  // ── Build scenes from shots ──────────────────────────────────────────────
  const scenes: Scene[] = shots
    .filter(s => s.startTime !== undefined && s.endTime !== undefined)
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
    .map((shot): Scene => {
      const type = resolveSceneType(shot.shotType);
      const meta = parseShotMeta(shot.uiLabelsJson);
      const cameraKeyframes: CameraKeyframe[] = (meta.cameraKeyframes ?? []).map(
        (kf: { t: number; zoom: number; panX: number; panY: number }) => ({
          t: kf.t, zoom: kf.zoom, panX: kf.panX, panY: kf.panY,
        })
      );

      let overlay: OverlayClip | null = null;
      if (type !== 'talking-head' && shot.clipUrl) {
        overlay = {
          mediaType: isImageUrl(shot.clipUrl) ? 'image' : 'video',
          clipUrl: shot.clipUrl,
          clipStartOffset: typeof meta.clipStartOffset === 'number' ? meta.clipStartOffset : 0,
          clipEndOffset: typeof meta.clipEndOffset === 'number' ? meta.clipEndOffset : 0,
          overlayDelaySeconds:
            meta.showNarratorFirst && typeof meta.overlayDelaySeconds === 'number'
              ? meta.overlayDelaySeconds : 0,
          showNarratorFirst: meta.showNarratorFirst === true,
          returnToNarrator: meta.returnToNarratorBeforeEnd === true,
          narratorReturnLeadSeconds:
            typeof meta.narratorReturnLeadSeconds === 'number'
              ? meta.narratorReturnLeadSeconds : 0,
          fadeInSeconds: OVERLAY_FADE_IN,
          isTacticalBroll:
            meta.isRequiredTacticalBroll === true || meta.isRequiredTacticalSlot === true,
        };
      }

      return {
        shotId: shot.id,
        type,
        caption: shot.caption ?? '',
        beat: shot.beat ?? '',
        startTime: shot.startTime!,
        endTime: shot.endTime!,
        camera: { keyframes: cameraKeyframes },
        overlay,
        transitionIn: shot.transitionIn ?? null,
        sfxIn: shot.sfxIn ?? null,
      };
    });

  // ── Scene counts ─────────────────────────────────────────────────────────
  const sceneCounts = {
    talkingHead: scenes.filter(s => s.type === 'talking-head').length,
    screencast: scenes.filter(s => s.type === 'screencast').length,
    broll: scenes.filter(s => s.type === 'broll').length,
  };

  // ── Animation map ────────────────────────────────────────────────────────
  let animationMap: Array<{ second: number; intensity: string }> = [];
  try { if (animationMapJson) animationMap = JSON.parse(animationMapJson); } catch { /* */ }

  // ── Subtitles ────────────────────────────────────────────────────────────
  const manifestSubtitles: SubtitleEvent[] = subtitles.map(s => ({
    start: s.start,
    end: s.end,
    words: s.words.map(w => ({
      text: w.text, start: w.start, end: w.end, emphasis: w.emphasis,
    })),
  }));

  // ── Assemble ─────────────────────────────────────────────────────────────
  return {
    version: 1,
    projectId,
    width,
    height,
    fps,
    durationSeconds,
    narration: {
      videoUrl: narrationUrl,
      chunkUrls,
    },
    music: musicUrl ? {
      audioUrl: musicUrl,
      volume: musicVolume,
      trackName: musicTrackName,
      bpm: musicBpm,
    } : null,
    scenes,
    subtitles: manifestSubtitles,
    subtitleStyle: resolvedSubtitleStyle,
    meta: {
      title,
      builtAt: new Date().toISOString(),
      generator: 'short-stack/render-manifest@1',
      sceneCounts,
      animationMap,
    },
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a manifest for completeness before sending to a renderer.
 * Pure structural checks — no network calls.
 */
export function validateManifest(m: RenderManifest): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!m.narration.videoUrl) {
    errors.push('Missing narration video URL.');
  }
  if (m.durationSeconds <= 0) {
    errors.push('Duration must be > 0.');
  }
  if (m.scenes.length === 0) {
    errors.push('No scenes in manifest.');
  }

  for (const scene of m.scenes) {
    if (scene.startTime >= scene.endTime) {
      errors.push(`Scene ${scene.shotId}: startTime (${scene.startTime}) >= endTime (${scene.endTime}).`);
    }
    if (scene.type !== 'talking-head' && scene.overlay === null) {
      warnings.push(`Scene ${scene.shotId} (${scene.type}): no overlay clip — narrator will show.`);
    }
    if (scene.overlay && !scene.overlay.clipUrl) {
      errors.push(`Scene ${scene.shotId} (${scene.type}): overlay present but clipUrl is empty.`);
    }
    if (scene.overlay && scene.overlay.clipEndOffset > 0 &&
        scene.overlay.clipStartOffset >= scene.overlay.clipEndOffset) {
      warnings.push(
        `Scene ${scene.shotId}: clipStartOffset (${scene.overlay.clipStartOffset}) >= ` +
        `clipEndOffset (${scene.overlay.clipEndOffset}).`
      );
    }
  }

  if (m.subtitles.length === 0 && m.durationSeconds > 3) {
    warnings.push('No subtitles — output will have no captions.');
  }

  return { ok: errors.length === 0, errors, warnings };
}
