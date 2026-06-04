/**
 * Emphasis-sticker render + composite stage for the Meme/Sticker editor.
 *
 * Mirrors the motion-graphics stage (motion/stage.ts) but for the meme editor's
 * one and only overlay type — the funny image that slaps on BELOW the captions.
 * It REUSES the motion render service's Remotion bundle + Chromium availability
 * probe (motion/render.ts exports getBundle / motionAvailable / importRenderer)
 * so there's one bundle per process and one place that knows whether Remotion is
 * usable. The composite is the same isolated, best-effort ffmpeg overlay pass
 * the motion stage uses, so a sticker failure can never regress the base render.
 *
 * Every stage is graceful: no Chromium / no generated image / any error → the
 * base captions-only render is returned untouched.
 */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import { motionAvailable, getBundle, importRenderer } from "../motion/render.js";
import type { EmphasisStickerClip } from "./sticker.js";

/**
 * Resolve a sticker's image to an ABSOLUTE http URL the headless Chromium can
 * fetch. Remotion's <Img> cannot load file:// (the sandbox blocks it) — verified
 * on this box — so we point it at the lab server's own /api/outputs origin. A
 * relative `/api/outputs/...` URL has no origin inside the bundle, so we prefix
 * the loopback base. PUBLIC_BASE_URL wins if set; otherwise 127.0.0.1:<port>.
 */
function stickerHttpUrl(imageUrl: string): string {
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  const base =
    (config.publicBaseUrl && config.publicBaseUrl.replace(/\/$/, "")) ||
    `http://127.0.0.1:${config.port}`;
  return `${base}${imageUrl.startsWith("/") ? "" : "/"}${imageUrl}`;
}

const FPS = 30;

export interface StickerStageResult {
  /** File that should become the final output (may equal baseVideo). */
  replacedFile: string;
  /** Extra ffmpeg spawns used (for the optimization report). */
  ffmpegSpawns: number;
  /** How many stickers actually rendered + composited. */
  applied: number;
}

interface RenderedSticker {
  clip: EmphasisStickerClip;
  /** Local path to the rendered alpha WebM, or null on failure. */
  file: string | null;
}

function codecConfig(): { codec: string; pixelFormat: string; ext: string } {
  const codec = process.env.MOTION_CODEC || "vp8";
  if (codec === "prores") return { codec: "prores", pixelFormat: "yuva444p10le", ext: "mov" };
  return { codec, pixelFormat: "yuva420p", ext: "webm" };
}

/** Render one sticker (the emphasis-sticker composition) to an alpha clip. */
async function renderOne(serveUrl: string, clip: EmphasisStickerClip): Promise<RenderedSticker> {
  try {
    const { selectComposition, renderMedia } = await importRenderer();
    const { codec, pixelFormat, ext } = codecConfig();

    const lengthSec = Math.max(0.6, clip.endTime - clip.startTime);
    const durationInFrames = Math.max(1, Math.round(lengthSec * FPS));

    // Point Remotion's headless <Img> at an absolute http URL it can fetch (the
    // lab server serves /api/outputs). file:// is blocked in the sandbox.
    const imageUrl = stickerHttpUrl(clip.imageUrl);

    const inputProps = {
      imageUrl,
      restTiltDeg: clip.restTiltDeg,
      bordered: true,
      durationInFrames,
    };

    const composition = await selectComposition({
      serveUrl,
      id: "emphasis-sticker",
      inputProps,
    });

    const outFile = path.join(config.tmpDir, `sticker_${randomUUID()}.${ext}`);
    await renderMedia({
      serveUrl,
      // Merge inputProps into the composition's props — Remotion 4.0 does not
      // auto-inject inputProps into the component for SSR, so without this the
      // component receives the defaults (empty imageUrl). Verified on this box.
      composition: { ...composition, durationInFrames, props: { ...composition.props, ...inputProps } },
      codec: codec as never,
      pixelFormat: pixelFormat as never,
      imageFormat: "png" as never,
      outputLocation: outFile,
      inputProps,
      concurrency: config.motionChromiumConcurrency,
      ...(codec === "prores" ? { proResProfile: "4444" as never } : {}),
    });

    return { clip, file: outFile };
  } catch (e) {
    console.warn(
      `[meme] sticker @${clip.startTime}s render failed — skipping: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { clip, file: null };
  }
}

/**
 * Composite rendered alpha stickers onto the base video. Each sticker is one
 * full-frame overlay (it positions itself BELOW the captions internally), gated
 * to its [startTime,endTime] window — the same technique motion/composite.ts
 * uses. Never throws: on any ffmpeg error it returns the untouched base video.
 */
async function compositeStickers(
  baseVideo: string,
  stickers: RenderedSticker[],
  totalDuration: number,
): Promise<{ file: string; composited: boolean; ffmpegSpawns: number }> {
  const usable = stickers.filter((s) => s.file);
  if (usable.length === 0) return { file: baseVideo, composited: false, ffmpegSpawns: 0 };

  const ext = path.extname(baseVideo) || ".mp4";
  const out = path.join(
    path.dirname(baseVideo),
    `${path.basename(baseVideo, ext)}_stk_${randomUUID().slice(0, 8)}${ext}`,
  );

  const args: string[] = ["-y", "-hide_banner", "-i", baseVideo];
  for (const s of usable) args.push("-i", s.file as string);

  const filters: string[] = [];
  let last = "0:v";
  usable.forEach((s, i) => {
    const inputIdx = i + 1;
    const start = Math.max(0, s.clip.startTime);
    const end = Math.min(totalDuration || s.clip.endTime, s.clip.endTime);
    const shifted = `s${i}`;
    const outLabel = `c${i}`;
    filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[${shifted}]`);
    filters.push(
      `[${last}][${shifted}]overlay=0:0:format=auto:` +
        `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`,
    );
    last = outLabel;
  });

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${last}]`);
  args.push("-map", "0:a?");
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
  );
  if (totalDuration > 0) args.push("-t", totalDuration.toFixed(3));
  args.push("-progress", "pipe:1", "-nostats", out);

  try {
    await runFfmpeg(args, totalDuration);
    return { file: out, composited: true, ffmpegSpawns: 1 };
  } catch (e) {
    console.warn(
      `[meme] sticker composite failed — keeping base render: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { file: baseVideo, composited: false, ffmpegSpawns: 0 };
  }
}

/**
 * Render every sticker and composite them below the captions. Best-effort:
 * returns the base video unchanged if Remotion/Chromium is unavailable or
 * nothing composited.
 */
export async function applyEmphasisStickers(
  baseVideo: string,
  clips: EmphasisStickerClip[],
  totalDuration: number,
): Promise<StickerStageResult> {
  const withImages = clips.filter((c) => c.imageUrl);
  if (withImages.length === 0) return { replacedFile: baseVideo, ffmpegSpawns: 0, applied: 0 };
  if (!(await motionAvailable())) {
    console.warn("[meme] Remotion/Chromium unavailable — rendering captions-only.");
    return { replacedFile: baseVideo, ffmpegSpawns: 0, applied: 0 };
  }

  const t0 = Date.now();
  let serveUrl: string;
  try {
    serveUrl = await getBundle();
  } catch (e) {
    console.warn(
      `[meme] Remotion bundle failed — captions-only: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { replacedFile: baseVideo, ffmpegSpawns: 0, applied: 0 };
  }

  // Render one sticker at a time (each headless-Chromium render is heavy; this
  // shares the box with ffmpeg). Concurrency knob lives in config.motionConcurrency.
  const rendered: RenderedSticker[] = [];
  for (const clip of withImages) {
    rendered.push(await renderOne(serveUrl, clip));
  }
  const ok = rendered.filter((r) => r.file);
  if (ok.length === 0) return { replacedFile: baseVideo, ffmpegSpawns: 0, applied: 0 };

  const result = await compositeStickers(baseVideo, ok, totalDuration);
  for (const r of rendered) {
    if (r.file) fs.rm(r.file, { force: true }, () => {});
  }

  const applied = result.composited ? ok.length : 0;
  console.log(
    `[meme] applied ${applied}/${withImages.length} sticker(s) in ${Date.now() - t0}ms` +
      (result.composited ? "" : " (composite skipped — kept base render)"),
  );

  return { replacedFile: result.file, ffmpegSpawns: result.ffmpegSpawns, applied };
}
