import { config } from "../config.js";
import type { RenderManifest, Scene, SubtitleEvent } from "./manifest.js";
import { DEFAULT_SUBTITLE_STYLE } from "./manifest.js";
import { resolveInput } from "./resolve.js";

/**
 * Build a concrete `ffmpeg` argv from a RenderManifest, resolving every input
 * reference to a local file path. This is the server-side, local-FFmpeg
 * equivalent of `src/utils/rendiAdapter.ts` — same composition (narration base,
 * timed overlays, music mix, word-by-word burned-in subtitles), but it spawns
 * the local binary instead of POSTing to Rendi.
 *
 * Returns argv (for child_process.spawn — no shell, so no quoting landmines)
 * plus the expected total duration used to compute progress.
 */

/** Escape a string for use inside an FFmpeg drawtext text='...' value. */
function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

/** Escape a font path for use inside a filtergraph option value. */
function escapeFontPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function isImage(url: string): boolean {
  const clean = url.split("?")[0].toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif|avif|bmp|svg)$/.test(clean);
}

export interface BuiltCommand {
  args: string[];
  totalDuration: number;
}

export async function buildArgsFromManifest(
  m: RenderManifest,
  outputPath: string
): Promise<BuiltCommand> {
  const W = m.width;
  const H = m.height;
  const fps = m.fps;
  const fontFile = escapeFontPath(config.fontFile);

  // ── Resolve inputs to local paths (download remote URLs once, cached) ──────
  const inputPaths: string[] = [];
  const narrationPath = await resolveInput(m.narration.videoUrl);
  inputPaths.push(narrationPath);

  const overlays: { idx: number; scene: Scene; isImg: boolean }[] = [];
  for (const scene of m.scenes) {
    if (scene.overlay && scene.overlay.clipUrl) {
      const p = await resolveInput(scene.overlay.clipUrl);
      const idx = inputPaths.push(p) - 1;
      overlays.push({ idx, scene, isImg: isImage(scene.overlay.clipUrl) });
    }
  }

  let musicIdx = -1;
  if (m.music && m.music.audioUrl) {
    const p = await resolveInput(m.music.audioUrl);
    musicIdx = inputPaths.push(p) - 1;
  }

  // ── filter_complex ─────────────────────────────────────────────────────────
  const filters: string[] = [];

  // Base: narration scaled to fill WxH (center-crop), normalized fps.
  filters.push(
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},setsar=1,fps=${fps}[base]`
  );

  let lastVideo = "base";
  overlays.forEach((ov, i) => {
    const s = ov.scene;
    const start = s.startTime + (s.overlay?.overlayDelaySeconds ?? 0);
    const end = s.endTime;
    const vlabel = `ov${i}`;
    const outLabel = `v${i}`;

    if (ov.isImg) {
      filters.push(
        `[${ov.idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},setsar=1[${vlabel}]`
      );
    } else {
      filters.push(
        `[${ov.idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},setsar=1,fps=${fps}[${vlabel}]`
      );
    }
    filters.push(
      `[${lastVideo}][${vlabel}]overlay=enable='between(t,${start},${end})'[${outLabel}]`
    );
    lastVideo = outLabel;
  });

  // Burned-in word-by-word subtitles.
  const sub = buildSubtitleDrawtext(m.subtitles, m, lastVideo, fontFile);
  filters.push(...sub.filters);
  lastVideo = sub.finalLabel;

  // ── Audio: narration + optional music ─────────────────────────────────────
  let audioLabel = "0:a";
  if (musicIdx >= 0) {
    const volume = typeof m.music!.volume === "number" ? m.music!.volume : 0.18;
    filters.push(`[${musicIdx}:a]volume=${volume}[music]`);
    filters.push(
      `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    );
    audioLabel = "aout";
  }

  // ── argv ───────────────────────────────────────────────────────────────────
  const args: string[] = ["-y", "-hide_banner"];
  for (const p of inputPaths) args.push("-i", p);
  args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${lastVideo}]`);
  args.push("-map", `[${audioLabel}]`);
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-r", String(fps),
    "-movflags", "+faststart"
  );
  // Cap output to the manifest duration so a long music bed can't extend it.
  if (m.durationSeconds > 0) args.push("-t", m.durationSeconds.toFixed(3));
  args.push("-progress", "pipe:1", "-nostats", outputPath);

  return { args, totalDuration: m.durationSeconds };
}

function buildSubtitleDrawtext(
  subtitles: SubtitleEvent[],
  m: RenderManifest,
  inputLabel: string,
  fontFile: string
): { filters: string[]; finalLabel: string } {
  const style = m.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
  const filters: string[] = [];

  if (!subtitles || subtitles.length === 0) {
    return { filters: [`[${inputLabel}]null[subbed]`], finalLabel: "subbed" };
  }

  const fontSize = style.fontSize;
  const yExpr =
    style.position === "bottom-center"
      ? `h-${Math.round(m.height * 0.18)}`
      : style.position === "top-center"
      ? `${Math.round(m.height * 0.12)}`
      : `(h-text_h)/2`;

  let currentLabel = inputLabel;
  let drawIndex = 0;
  for (const event of subtitles) {
    for (const word of event.words) {
      const txt = escapeDrawText(style.allCaps ? word.text.toUpperCase() : word.text);
      const color = word.emphasis && style.wordColor ? style.wordColor : style.lineColor;
      const outLabel = `sub${drawIndex}`;
      filters.push(
        `[${currentLabel}]drawtext=fontfile='${fontFile}':text='${txt}':` +
          `fontcolor=${color}:fontsize=${fontSize}:` +
          `x=(w-text_w)/2:y=${yExpr}:` +
          `box=1:boxcolor=black@0.5:boxborderw=8:` +
          `enable='between(t,${word.start},${word.end})'[${outLabel}]`
      );
      currentLabel = outLabel;
      drawIndex++;
    }
  }
  return { filters, finalLabel: currentLabel };
}
