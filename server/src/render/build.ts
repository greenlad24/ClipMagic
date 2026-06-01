import { config } from "../config.js";
import type { RenderManifest, Scene, SubtitleEvent } from "./manifest.js";
import { DEFAULT_SUBTITLE_STYLE } from "./manifest.js";
import { resolveInput } from "./resolve.js";
import { probe } from "./ffmpeg.js";

const AUDIO_SR = 44100;

/**
 * Build a concrete `ffmpeg` argv from a RenderManifest, resolving every input
 * reference to a local file path. This is the server-side, local-FFmpeg
 * equivalent of `src/utils/rendiAdapter.ts` — same composition (narration base,
 * timed overlays, music mix, word-by-word burned-in subtitles), but it spawns
 * the local binary instead of POSTing to Rendi.
 *
 * Supports per-video editing used by the bulk editor: the narration can be
 * trimmed (`narration.trimStart` / `narration.trimEnd`), and overlay/subtitle
 * timings are shifted to stay in sync with the trimmed base.
 *
 * Returns argv (for child_process.spawn — no shell, so no quoting landmines)
 * plus the expected total duration used to compute progress.
 */

/**
 * Escape a string for use as an UNQUOTED drawtext text= value.
 *
 * We deliberately do NOT wrap the value in single quotes: when the text itself
 * contains an escaped quote (e.g. "HERE'S"), a surrounding single-quoted value
 * confuses FFmpeg's filter parser. Instead we backslash-escape every character
 * special to the filtergraph splitter (`:`, `\`, `,`) so the value stands alone
 * as a single bare token.
 *
 * The drawtext call uses `expansion=none`, which disables drawtext's own macro
 * processing — so `%`, `{`, `}` are taken LITERALLY and do NOT need escaping.
 * This is what fixes captions with numbers/percentages (e.g. "50% OFF") which
 * previously triggered a "Stray %" error and rendered a blank line.
 */
function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, "") // drop stray backslashes (not meaningful in caption text)
    .replace(/'/g, "’") // curly apostrophe: looks identical, avoids quote parsing
    .replace(/:/g, "\\:") // filtergraph option separator
    .replace(/,/g, "\\,") // filtergraph filter separator (unquoted value)
    .replace(/\r?\n/g, " ");
}

/** FFmpeg drawtext wants 0xRRGGBB-style names; pass hex through as-is. */
function ffColor(hex: string | null | undefined, fallback: string): string {
  const v = (hex ?? "").trim();
  return /^#?[0-9a-fA-F]{6}$/.test(v) ? (v.startsWith("#") ? "0x" + v.slice(1) : "0x" + v) : fallback;
}

/** Escape a font path for use inside a filtergraph option value. */
function escapeFontPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function isImage(url: string): boolean {
  const clean = url.split("?")[0].toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif|avif|bmp|svg)$/.test(clean);
}

interface InputSpec {
  /** Options that must precede this `-i` (e.g. input seek `-ss`). */
  opts: string[];
  path: string;
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

  // ── Narration trim (per-video editing) ─────────────────────────────────────
  const narration = m.narration as RenderManifest["narration"] & {
    trimStart?: number;
    trimEnd?: number;
  };
  const trimStart = Math.max(0, narration.trimStart ?? 0);
  const trimEnd = narration.trimEnd && narration.trimEnd > trimStart ? narration.trimEnd : 0;
  // Effective output duration: an explicit trim window wins, otherwise the
  // manifest duration minus any head trim.
  const effectiveDuration =
    trimEnd > 0
      ? trimEnd - trimStart
      : Math.max(0.1, (m.durationSeconds || 0) - trimStart);

  // ── Resolve inputs to local paths (download remote URLs once, cached) ──────
  const inputs: InputSpec[] = [];

  const narrationPath = await resolveInput(narration.videoUrl);
  const narrationOpts: string[] = [];
  if (trimStart > 0) narrationOpts.push("-ss", trimStart.toFixed(3));
  if (trimEnd > 0) narrationOpts.push("-t", (trimEnd - trimStart).toFixed(3));
  inputs.push({ opts: narrationOpts, path: narrationPath });

  // Narration may or may not carry an audio stream; probe so we can either use
  // it or synthesize silence (a missing 0:a would otherwise break the mapping).
  const narrationInfo = await probe(narrationPath);
  const narrationHasAudio = narrationInfo.hasAudio;

  const overlays: { idx: number; scene: Scene; isImg: boolean; clipStart: number }[] = [];
  for (const scene of m.scenes) {
    if (scene.overlay && scene.overlay.clipUrl) {
      const p = await resolveInput(scene.overlay.clipUrl);
      // Trust the manifest's mediaType (stock/promo/generated clips are video);
      // only sniff the URL when it's somehow unset.
      const isImg =
        scene.overlay.mediaType === "image"
          ? true
          : scene.overlay.mediaType === "video"
          ? false
          : isImage(scene.overlay.clipUrl);
      // Seek into the matched segment for video overlays so we start at the
      // right moment of the promo clip (and so a short clip isn't already past
      // EOF — which is what made the overlay freeze on a single frame).
      const clipStart = Math.max(0, scene.overlay.clipStartOffset || 0);
      const opts: string[] = !isImg && clipStart > 0 ? ["-ss", clipStart.toFixed(3)] : [];
      const idx = inputs.push({ opts, path: p }) - 1;
      overlays.push({ idx, scene, isImg, clipStart });
    }
  }

  let musicIdx = -1;
  if (m.music && m.music.audioUrl) {
    const p = await resolveInput(m.music.audioUrl);
    musicIdx = inputs.push({ opts: [], path: p }) - 1;
  }

  // Shift a timeline value so it's relative to the trimmed narration, clamped
  // to the visible window.
  const shift = (t: number): number =>
    Math.max(0, Math.min(effectiveDuration, t - trimStart));

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
    const start = shift(s.startTime + (s.overlay?.overlayDelaySeconds ?? 0));
    const end = shift(s.endTime);
    const vlabel = `ov${i}`;
    const outLabel = `v${i}`;

    if (ov.isImg) {
      // A still image is one frame; the overlay filter repeats it for the
      // whole enabled window, so no PTS handling is needed.
      filters.push(
        `[${ov.idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},setsar=1[${vlabel}]`
      );
    } else {
      // Reset the clip's timestamps to 0 (we may have seeked with -ss), then
      // shift them so the clip's first frame lands at `start` on the output
      // timeline. Without this the clip plays from filtergraph t=0 and is
      // already at/past EOF by the time its window arrives — which froze the
      // overlay on a single (last) frame for the entire window.
      filters.push(
        `[${ov.idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
          `crop=${W}:${H},setsar=1,fps=${fps},` +
          `setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[${vlabel}]`
      );
    }
    filters.push(
      `[${lastVideo}][${vlabel}]overlay=enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`
    );
    lastVideo = outLabel;
  });

  // Burned-in word-by-word subtitles (timings shifted for any narration trim).
  const sub = buildSubtitleDrawtext(m.subtitles, m, lastVideo, fontFile, shift);
  filters.push(...sub.filters);
  lastVideo = sub.finalLabel;

  // ── Audio: narration (or generated silence) + optional music ───────────────
  // Always normalize to a single labeled output [aout] so the -map is uniform
  // regardless of whether narration has audio or music is present. Mapping a
  // bare stream specifier as a filter label (e.g. "[0:a]") is what previously
  // broke renders that had no music.
  if (narrationHasAudio) {
    filters.push(
      `[0:a]aresample=${AUDIO_SR},aformat=sample_fmts=fltp:channel_layouts=stereo[narr_a]`
    );
  } else {
    // Synthesize silence for the full duration so the output always has audio.
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SR},` +
        `atrim=0:${effectiveDuration.toFixed(3)},asetpts=N/SR/TB[narr_a]`
    );
  }

  if (musicIdx >= 0) {
    const volume = typeof m.music!.volume === "number" ? m.music!.volume : 0.18;
    filters.push(
      `[${musicIdx}:a]aresample=${AUDIO_SR},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${volume}[music]`
    );
    filters.push(
      `[narr_a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    );
  } else {
    filters.push(`[narr_a]anull[aout]`);
  }
  const audioLabel = "aout";

  // ── argv ───────────────────────────────────────────────────────────────────
  const args: string[] = ["-y", "-hide_banner"];
  for (const spec of inputs) {
    args.push(...spec.opts, "-i", spec.path);
  }
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
  // Cap output to the (possibly trimmed) duration so a long music bed or
  // looping overlay can't extend it.
  if (effectiveDuration > 0) args.push("-t", effectiveDuration.toFixed(3));
  args.push("-progress", "pipe:1", "-nostats", outputPath);

  return { args, totalDuration: effectiveDuration };
}

function buildSubtitleDrawtext(
  subtitles: SubtitleEvent[],
  m: RenderManifest,
  inputLabel: string,
  fontFile: string,
  shift: (t: number) => number
): { filters: string[]; finalLabel: string } {
  const style = m.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE;
  const filters: string[] = [];

  if (!subtitles || subtitles.length === 0) {
    return { filters: [`[${inputLabel}]null[subbed]`], finalLabel: "subbed" };
  }

  const fontSize = style.fontSize;
  // Subtitles always sit in the MIDDLE of the screen (templates may set
  // position, but the product rule is center) — vertically and horizontally.
  const yExpr = `(h-text_h)/2`;
  const xExpr = `(w-text_w)/2`;

  // Template-driven look.
  const lineColor = ffColor(style.lineColor, "white");
  const emphColor = ffColor(style.wordColor, lineColor);
  const outlineColor = ffColor(style.outlineColor, "black");
  const outlineW = typeof style.outlineWidth === "number" ? style.outlineWidth : 6;
  const useBox = style.box === true;
  const boxColor = ffColor(style.boxColor, "black");
  const boxOpacity = typeof style.boxOpacity === "number" ? style.boxOpacity : 0.5;
  const boxBorderW = typeof style.boxBorderWidth === "number" ? style.boxBorderWidth : 12;

  let currentLabel = inputLabel;
  let drawIndex = 0;
  for (const event of subtitles) {
    // Render the WHOLE phrase for the event's window (not one word at a time):
    // a single readable caption line that appears and is replaced by the next
    // phrase, instead of single words flashing. This matches the in-app preview.
    const phraseWords = event.words.filter((w) => (w.text ?? "").trim().length > 0);
    if (phraseWords.length === 0) continue;
    const phrase = phraseWords.map((w) => w.text).join(" ");
    const txt = escapeDrawText(style.allCaps ? phrase.toUpperCase() : phrase);
    // Emphasize the whole phrase's color when it contains a key/emphasized word
    // (viral look: stressed lines pop in the accent color).
    const color = phraseWords.some((w) => w.emphasis) ? emphColor : lineColor;
    // The phrase is visible for the full span of its words.
    const start = shift(event.start ?? phraseWords[0].start);
    const end = shift(event.end ?? phraseWords[phraseWords.length - 1].end);
    if (end <= start) continue; // fully outside the trimmed window
    const outLabel = `sub${drawIndex}`;

    // Auto-fit: a big template font (e.g. Hormozi 92px) can overflow the frame
    // on a 3-word caption and get clipped at the edges. Estimate rendered width
    // (~0.60×fontSize per glyph for this bold sans, plus the outline) and shrink
    // the font so the line fits within ~92% of the frame width.
    const maxTextWidth = m.width * 0.88;
    const renderText = style.allCaps ? phrase.toUpperCase() : phrase;
    const estCharW = 0.64;
    const estWidth = renderText.length * fontSize * estCharW + outlineW * 2;
    const fitFontSize = estWidth > maxTextWidth
      ? Math.max(28, Math.floor(fontSize * (maxTextWidth / estWidth)))
      : fontSize;

    // expansion=none → literal text (so %, {, } render fine and numbers like
    // "50%" no longer blank the line). text/enable are UNQUOTED; escapeDrawText
    // backslash-escapes the filtergraph separators.
    const boxOpts = useBox
      ? `:box=1:boxcolor=${boxColor}@${boxOpacity}:boxborderw=${boxBorderW}`
      : "";
    filters.push(
      `[${currentLabel}]drawtext=fontfile=${fontFile}:expansion=none:text=${txt}:` +
        `fontcolor=${color}:fontsize=${fitFontSize}:` +
        `borderw=${outlineW}:bordercolor=${outlineColor}:` +
        `shadowx=2:shadowy=2:shadowcolor=black@0.6:` +
        `x=${xExpr}:y=${yExpr}${boxOpts}:` +
        `enable=between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})[${outLabel}]`
    );
    currentLabel = outLabel;
    drawIndex++;
  }
  // If every word fell outside the window, pass through unchanged.
  if (drawIndex === 0) {
    return { filters: [`[${inputLabel}]null[subbed]`], finalLabel: "subbed" };
  }
  return { filters, finalLabel: currentLabel };
}
