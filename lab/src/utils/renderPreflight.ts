/**
 * Render Preflight Validation
 *
 * Deep validation of a RenderManifest before JSON2Video submission.
 * Pure function — no network calls, no side-effects.
 *
 * Checks:
 *  1. All referenced media URLs are well-formed and non-empty
 *  2. Screencast / broll overlay seek + start + duration combinations are sane
 *  3. Scene durations are positive and within bounds
 *  4. Subtitles presence when the video is > 3 s
 *  5. Music URL is valid and volume is in range
 *  6. Timeline continuity — no overlapping scenes, no gaps > threshold
 *  7. Subtitle timing doesn't exceed video duration
 */

import type { RenderManifest, Scene } from './renderManifest';

// ─── Result types ────────────────────────────────────────────────────────────

export interface PreflightIssue {
  /** 'error' blocks submission; 'warning' is informational */
  severity: 'error' | 'warning';
  /** Machine-readable code for the frontend to key on */
  code: string;
  /** Human-readable description */
  message: string;
  /** Which scene / shot triggered this, if applicable */
  shotId?: string;
}

export interface PreflightResult {
  ok: boolean;
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIN_SCENE_DURATION = 0.1; // seconds
const MAX_SCENE_DURATION = 300; // 5 minutes per scene
const GAP_WARNING_THRESHOLD = 0.5; // seconds

function isValidUrl(url: string): boolean {
  if (!url || !url.trim()) return false;
  // Accept http(s), data URIs, and blob URIs
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function round2(n: number): string {
  return n.toFixed(2);
}

// ─── Main validator ──────────────────────────────────────────────────────────

export function runPreflightValidation(m: RenderManifest): PreflightResult {
  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  const err = (code: string, message: string, shotId?: string) =>
    errors.push({ severity: 'error', code, message, shotId });
  const warn = (code: string, message: string, shotId?: string) =>
    warnings.push({ severity: 'warning', code, message, shotId });

  // ── 1. Narration URL ───────────────────────────────────────────────────
  if (!isValidUrl(m.narration.videoUrl)) {
    err('NARRATION_URL_MISSING', 'Narration video URL is missing or invalid.');
  } else if (/_part\d{2,}\./.test(m.narration.videoUrl)) {
    err(
      'NARRATION_IS_CHUNK',
      `Narration URL points to a chunk file (${m.narration.videoUrl.split('/').pop()}). ` +
      `This is an intermediate upload artifact, not a complete video. ` +
      `Re-upload the narration as a single file.`,
    );
  }

  // ── 1b. Multi-chunk without assembled URL ──────────────────────────────
  if (m.narration.chunkUrls.length > 1) {
    warn(
      'MULTI_CHUNK_NARRATION',
      `Narration was uploaded in ${m.narration.chunkUrls.length} chunks. ` +
      `JSON2Video requires a single valid video URL — ensure the narration URL ` +
      `points to the fully assembled file.`,
    );
  }

  // ── 2. Duration ────────────────────────────────────────────────────────
  if (m.durationSeconds <= 0) {
    err('DURATION_ZERO', 'Total video duration must be greater than 0.');
  }

  // ── 3. Scenes ──────────────────────────────────────────────────────────
  if (m.scenes.length === 0) {
    err('NO_SCENES', 'No scenes in the project — nothing to render.');
  }

  for (const scene of m.scenes) {
    validateScene(scene, m.durationSeconds, err, warn);
  }

  // ── 4. Timeline continuity ─────────────────────────────────────────────
  validateTimeline(m.scenes, m.durationSeconds, warn);

  // ── 5. Subtitles ───────────────────────────────────────────────────────
  if (m.subtitles.length === 0 && m.durationSeconds > 3) {
    warn(
      'NO_SUBTITLES',
      'No subtitles found. The exported video will have no captions.',
    );
  }

  for (let i = 0; i < m.subtitles.length; i++) {
    const sub = m.subtitles[i];
    if (sub.start >= sub.end) {
      err(
        'SUBTITLE_TIMING',
        `Subtitle #${i + 1}: start (${round2(sub.start)}) >= end (${round2(sub.end)}).`,
      );
    }
    if (sub.end > m.durationSeconds + 0.5) {
      warn(
        'SUBTITLE_EXCEEDS_DURATION',
        `Subtitle #${i + 1} ends at ${round2(sub.end)}s but video is only ${round2(m.durationSeconds)}s.`,
      );
    }
    if (sub.words.length === 0) {
      warn('SUBTITLE_EMPTY', `Subtitle #${i + 1} has no words.`);
    }
  }

  // ── 6. Music ───────────────────────────────────────────────────────────
  if (m.music) {
    if (!isValidUrl(m.music.audioUrl)) {
      err('MUSIC_URL_INVALID', 'Music track URL is missing or invalid.');
    }
    if (m.music.volume < 0 || m.music.volume > 1) {
      err(
        'MUSIC_VOLUME_RANGE',
        `Music volume (${m.music.volume}) is outside the 0–1 range.`,
      );
    }
    if (m.music.volume === 0) {
      warn('MUSIC_VOLUME_ZERO', 'Music volume is 0 — track will be silent.');
    }
  }

  // ── Build summary ──────────────────────────────────────────────────────
  const ok = errors.length === 0;
  const parts: string[] = [];
  if (errors.length > 0) {
    parts.push(`${errors.length} error${errors.length > 1 ? 's' : ''}`);
  }
  if (warnings.length > 0) {
    parts.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`);
  }
  const summary = ok
    ? warnings.length > 0
      ? `Preflight passed with ${parts.join(', ')}.`
      : 'Preflight passed — all checks OK.'
    : `Preflight failed: ${parts.join(', ')}.`;

  return { ok, errors, warnings, summary };
}

// ─── Per-scene validation ────────────────────────────────────────────────────

function validateScene(
  scene: Scene,
  videoDuration: number,
  err: (code: string, msg: string, shotId?: string) => void,
  warn: (code: string, msg: string, shotId?: string) => void,
) {
  const sid = scene.shotId;
  const dur = scene.endTime - scene.startTime;
  const label = `Scene "${scene.caption.slice(0, 40) || sid}"`;

  // Duration checks
  if (scene.startTime >= scene.endTime) {
    err('SCENE_DURATION_INVALID', `${label}: startTime (${round2(scene.startTime)}) >= endTime (${round2(scene.endTime)}).`, sid);
  } else if (dur < MIN_SCENE_DURATION) {
    err('SCENE_TOO_SHORT', `${label}: duration ${round2(dur)}s is below minimum ${MIN_SCENE_DURATION}s.`, sid);
  } else if (dur > MAX_SCENE_DURATION) {
    warn('SCENE_TOO_LONG', `${label}: duration ${round2(dur)}s exceeds ${MAX_SCENE_DURATION}s — may cause slow rendering.`, sid);
  }

  // Scene exceeds video
  if (scene.endTime > videoDuration + 0.5) {
    warn('SCENE_EXCEEDS_DURATION', `${label}: ends at ${round2(scene.endTime)}s but video is ${round2(videoDuration)}s.`, sid);
  }

  // Overlay checks
  if (scene.type !== 'talking-head' && !scene.overlay) {
    warn('OVERLAY_MISSING', `${label} (${scene.type}): no overlay clip — narrator will show instead.`, sid);
  }

  if (scene.overlay) {
    const ov = scene.overlay;

    // Overlay URL
    if (!isValidUrl(ov.clipUrl)) {
      err('OVERLAY_URL_INVALID', `${label}: overlay clip URL is missing or invalid.`, sid);
    }

    // Clip offset logic
    if (ov.clipEndOffset > 0 && ov.clipStartOffset >= ov.clipEndOffset) {
      err(
        'OVERLAY_OFFSET_INVALID',
        `${label}: clipStartOffset (${round2(ov.clipStartOffset)}) >= clipEndOffset (${round2(ov.clipEndOffset)}).`,
        sid,
      );
    }

    // Effective overlay duration after delay + return-to-narrator
    const availableForOverlay = dur - ov.overlayDelaySeconds -
      (ov.returnToNarrator ? ov.narratorReturnLeadSeconds : 0);

    if (availableForOverlay < MIN_SCENE_DURATION) {
      err(
        'OVERLAY_NO_TIME',
        `${label}: after overlay delay (${round2(ov.overlayDelaySeconds)}s) and narrator return ` +
        `(${round2(ov.narratorReturnLeadSeconds)}s), only ${round2(availableForOverlay)}s left for the overlay.`,
        sid,
      );
    }

    // Delay exceeds scene
    if (ov.overlayDelaySeconds >= dur) {
      err(
        'OVERLAY_DELAY_EXCEEDS',
        `${label}: overlay delay (${round2(ov.overlayDelaySeconds)}s) >= scene duration (${round2(dur)}s).`,
        sid,
      );
    }

    // Narrator return exceeds scene
    if (ov.returnToNarrator && ov.narratorReturnLeadSeconds >= dur) {
      err(
        'NARRATOR_RETURN_EXCEEDS',
        `${label}: narratorReturnLead (${round2(ov.narratorReturnLeadSeconds)}s) >= scene duration (${round2(dur)}s).`,
        sid,
      );
    }
  }
}

// ─── Timeline continuity ─────────────────────────────────────────────────────

function validateTimeline(
  scenes: Scene[],
  _videoDuration: number,
  warn: (code: string, msg: string, shotId?: string) => void,
) {
  if (scenes.length < 2) return;

  const sorted = [...scenes].sort((a, b) => a.startTime - b.startTime);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // Overlap
    if (curr.startTime < prev.endTime - 0.05) {
      warn(
        'TIMELINE_OVERLAP',
        `Scenes "${prev.caption.slice(0, 30)}" and "${curr.caption.slice(0, 30)}" overlap ` +
        `(${round2(prev.endTime - curr.startTime)}s).`,
        curr.shotId,
      );
    }

    // Gap
    const gap = curr.startTime - prev.endTime;
    if (gap > GAP_WARNING_THRESHOLD) {
      warn(
        'TIMELINE_GAP',
        `${round2(gap)}s gap between scenes "${prev.caption.slice(0, 30)}" and "${curr.caption.slice(0, 30)}".`,
      );
    }
  }
}
