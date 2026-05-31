/**
 * Rendi FFmpeg Adapter — converts a RenderManifest into a Rendi API payload.
 *
 * Builds a single FFmpeg command with filter_complex that:
 * 1. Scales narration to 1080×1920
 * 2. Overlays promo/broll clips at exact trim points
 * 3. Mixes background music at 8% volume
 * 4. Burns SRT subtitles
 * 5. Encodes H.264/AAC, yuv420p, faststart
 *
 * Pure function — no side-effects, no network calls.
 */

import type { RenderManifest, Scene, SubtitleEvent } from './renderManifest';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RendiPayload {
  input_files: Record<string, string>;
  output_files: Record<string, string>;
  ffmpeg_command: string;
  max_command_run_seconds: number;
  metadata: Record<string, string | number | boolean>;
}

export interface AdaptResult {
  payload: RendiPayload;
  /** The SRT content that must be uploaded to a public URL before submission */
  srtContent: string | null;
  /** Key for the SRT in input_files (null if no subtitles) */
  srtInputKey: string | null;
  diagnostics: RendiDiagnostics;
}

export interface RendiDiagnostics {
  totalScenes: number;
  overlayCount: number;
  hasSubtitles: boolean;
  hasMusic: boolean;
  srtLineCount: number;
  inputFileCount: number;
  estimatedCommandLength: number;
}

// ─── SRT Generator ───────────────────────────────────────────────────────────

function pad2(n: number): string { return n.toString().padStart(2, '0'); }

function srtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${ms.toString().padStart(3, '0')}`;
}

function subtitlesToSrt(events: SubtitleEvent[]): string {
  return events.map((ev, i) => {
    const text = ev.words.map(w => w.text).join(' ');
    return `${i + 1}\n${srtTimestamp(ev.start)} --> ${srtTimestamp(ev.end)}\n${text}`;
  }).join('\n\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function escapeFilterStr(s: string): string {
  // Escape characters that are special in FFmpeg filter strings
  return s.replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

interface OverlayInfo {
  inputIndex: number;
  sceneStartTime: number;
  sceneEndTime: number;
  clipStartOffset: number;
  clipEndOffset: number;
  overlayDelaySeconds: number;
  returnToNarrator: boolean;
  narratorReturnLeadSeconds: number;
  fadeInSeconds: number;
}

// ─── Main Adapter ────────────────────────────────────────────────────────────

export interface AdaptOptions {
  renderJobId: string;
  /** Output filename (with .mp4 extension) */
  outputFilename: string;
  /** Override music volume (0-1). Default: from manifest */
  musicVolumeOverride?: number;
}

/**
 * Convert a RenderManifest to a Rendi API payload.
 *
 * The returned `srtContent` must be uploaded to a public URL by the caller,
 * then set as the value for `payload.input_files[srtInputKey]`.
 */
export function manifestToRendi(
  manifest: RenderManifest,
  opts: AdaptOptions,
): AdaptResult {
  const { renderJobId, outputFilename, musicVolumeOverride } = opts;
  const inputFiles: Record<string, string> = {};
  let inputIdx = 0;

  // ── Narration (always input 0) ─────────────────────────────────────────
  const narrationKey = 'in_narration';
  inputFiles[narrationKey] = manifest.narration.videoUrl;
  const narrationIdx = inputIdx++;

  // ── Overlay clips ──────────────────────────────────────────────────────
  const overlays: OverlayInfo[] = [];
  for (const scene of manifest.scenes) {
    if (scene.overlay && scene.overlay.clipUrl && scene.overlay.mediaType === 'video') {
      const key = `in_ov_${overlays.length}`;
      inputFiles[key] = scene.overlay.clipUrl;
      overlays.push({
        inputIndex: inputIdx++,
        sceneStartTime: scene.startTime,
        sceneEndTime: scene.endTime,
        clipStartOffset: scene.overlay.clipStartOffset,
        clipEndOffset: scene.overlay.clipEndOffset,
        overlayDelaySeconds: scene.overlay.overlayDelaySeconds,
        returnToNarrator: scene.overlay.returnToNarrator,
        narratorReturnLeadSeconds: scene.overlay.narratorReturnLeadSeconds,
        fadeInSeconds: scene.overlay.fadeInSeconds,
      });
    }
  }

  // ── Music (optional) ───────────────────────────────────────────────────
  let musicIdx: number | null = null;
  if (manifest.music?.audioUrl) {
    const key = 'in_music';
    inputFiles[key] = manifest.music.audioUrl;
    musicIdx = inputIdx++;
  }

  // ── Subtitles — SRT content generated, placeholder key added ──────────
  let srtContent: string | null = null;
  let srtInputKey: string | null = null;
  if (manifest.subtitles.length > 0) {
    srtContent = subtitlesToSrt(manifest.subtitles);
    srtInputKey = 'in_srt';
    inputFiles[srtInputKey] = '__SRT_URL_PLACEHOLDER__';
  }

  // ── Build FFmpeg command ───────────────────────────────────────────────
  const W = 1080;
  const H = 1920;
  const totalDur = manifest.durationSeconds;
  const musicVol = musicVolumeOverride ?? manifest.music?.volume ?? 0.08;

  // Input flags
  const inputFlags: string[] = [];
  // Narration
  inputFlags.push(`-i {{${narrationKey}}}`);
  // Overlays
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i];
    const key = `in_ov_${i}`;
    if (ov.clipStartOffset > 0) {
      inputFlags.push(`-ss ${round3(ov.clipStartOffset)}`);
    }
    if (ov.clipEndOffset > 0 && ov.clipEndOffset > ov.clipStartOffset) {
      inputFlags.push(`-t ${round3(ov.clipEndOffset - ov.clipStartOffset)}`);
    }
    inputFlags.push(`-i {{${key}}}`);
  }
  // Music
  if (musicIdx !== null) {
    inputFlags.push('-stream_loop -1 -i {{in_music}}');
  }

  // ── filter_complex ─────────────────────────────────────────────────────
  const filters: string[] = [];
  let lastVideoLabel = 'base';

  // Scale narration to target
  filters.push(
    `[${narrationIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:-1:-1,setsar=1,fps=30[base]`
  );

  // Overlay each clip
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i];
    const ovStreamIdx = ov.inputIndex;
    const scaledLabel = `ov${i}s`;
    const outLabel = `v${i}`;

    // Scale overlay to target
    filters.push(
      `[${ovStreamIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:-1:-1,setsar=1[${scaledLabel}]`
    );

    // Calculate enable window
    let enableStart = round3(ov.sceneStartTime + ov.overlayDelaySeconds);
    let enableEnd = round3(ov.sceneEndTime);
    if (ov.returnToNarrator && ov.narratorReturnLeadSeconds > 0) {
      enableEnd = round3(enableEnd - ov.narratorReturnLeadSeconds);
    }
    enableEnd = Math.max(enableEnd, enableStart + 0.1);

    filters.push(
      `[${lastVideoLabel}][${scaledLabel}]overlay=0:0:` +
      `enable='between(t,${enableStart},${enableEnd})'[${outLabel}]`
    );
    lastVideoLabel = outLabel;
  }

  // Burn subtitles if available
  if (srtInputKey) {
    const subOutLabel = 'subbed';
    // Use the subtitles filter referencing the downloaded SRT file
    const ss = manifest.subtitleStyle;
    const forceStyle = [
      `FontName=${ss.fontFamily}`,
      `FontSize=${Math.round(ss.fontSize * (W / manifest.width))}`,
      `PrimaryColour=&HFFFFFF`,
      `OutlineColour=&H000000`,
      `Outline=${ss.outlineWidth}`,
      `BorderStyle=3`,
      `Alignment=2`,
      `MarginV=80`,
    ].join(',');

    filters.push(
      `[${lastVideoLabel}]subtitles={{${srtInputKey}}}:force_style='${forceStyle}'[${subOutLabel}]`
    );
    lastVideoLabel = subOutLabel;
  }

  // ── Audio mixing ───────────────────────────────────────────────────────
  let audioMapping: string;
  if (musicIdx !== null) {
    filters.push(`[${narrationIdx}:a]volume=1.0[narr_a]`);
    filters.push(
      `[${musicIdx}:a]volume=${round3(musicVol)},` +
      `atrim=duration=${round3(totalDur)},asetpts=PTS-STARTPTS[music_a]`
    );
    filters.push(
      `[narr_a][music_a]amix=inputs=2:duration=first:dropout_transition=2[mixed_a]`
    );
    audioMapping = '-map "[mixed_a]"';
  } else {
    audioMapping = `-map ${narrationIdx}:a`;
  }

  // ── Assemble full command ──────────────────────────────────────────────
  const filterComplex = filters.join(';');

  const parts = [
    ...inputFlags,
    `-filter_complex "${filterComplex}"`,
    `-map "[${lastVideoLabel}]"`,
    audioMapping,
    '-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p',
    '-c:a aac -b:a 192k',
    '-movflags +faststart',
    '-r 30',
    '-shortest',
    '{{out_1}}',
  ];

  const ffmpegCommand = parts.join(' ');

  // ── Output ─────────────────────────────────────────────────────────────
  const payload: RendiPayload = {
    input_files: inputFiles,
    output_files: { out_1: outputFilename },
    ffmpeg_command: ffmpegCommand,
    max_command_run_seconds: Math.max(600, Math.ceil(totalDur * 8)),
    metadata: {
      projectId: manifest.projectId,
      renderJobId,
      generator: manifest.meta.generator,
    },
  };

  return {
    payload,
    srtContent,
    srtInputKey,
    diagnostics: {
      totalScenes: manifest.scenes.length,
      overlayCount: overlays.length,
      hasSubtitles: srtContent !== null,
      hasMusic: musicIdx !== null,
      srtLineCount: srtContent ? srtContent.split('\n\n').length : 0,
      inputFileCount: Object.keys(inputFiles).length,
      estimatedCommandLength: ffmpegCommand.length,
    },
  };
}
