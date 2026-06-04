/**
 * Meme/Sticker editor — lean pipeline for ONE project.
 *
 * A stripped-down sibling of the short-form creator that does exactly two things
 * on top of the narration: popping captions + funny AI stickers that slap on
 * BELOW the captions on emphasis beats. It deliberately does NOT touch
 * runPipeline or add b-roll / screencasts / stock / AI-video.
 *
 * Stages (all reuse existing building blocks):
 *   1. transcribe        → Groq Whisper (ai/transcribe), word timestamps
 *   2. caption plan      → buildCaptionEvents → the existing ASS render path
 *   3. emphasis director → Claude picks moments + writes image prompts (sanitized)
 *   4. image generation  → one static still per moment (OpenAI images, cached)
 *   5. manifest render   → a normal "manifest" job: narration video + popping
 *                          captions + emphasisStickers (composited below captions
 *                          by the meme stage in the render worker).
 *
 * Every AI/image step is graceful: no Groq key → throws a clear error (we can't
 * caption without a transcript); no Claude / no image token / no Chromium →
 * captions-only, never a crash. AI cost is accounted per run (beginRun/finishRun)
 * so it shows up honestly in the Optimization Report.
 */
import { resolveInput } from "../render/resolve.js";
import { probe } from "../render/ffmpeg.js";
import { extractAudioForTranscription } from "../render/cut.js";
import { transcribeWithGroq } from "../ai/transcribe.js";
import { SUBTITLE_TEMPLATES, type RenderManifest } from "../render/manifest.js";
import { createJob } from "../db/jobs.js";
import { pump } from "../render/worker.js";
import { buildReport, reportLogLine } from "../ai/runAccounting.js";
import { buildCaptionEvents } from "./captions.js";
import { planEmphasisMoments } from "./director.js";
import { generateStickerImage, imageGenConfigured } from "./imagegen.js";
import type { EmphasisStickerClip } from "./sticker.js";

const W = 1080;
const H = 1920;
const FPS = 30;

/** The caption template — a popping viral style (pop-scale: recolor + size pop). */
const MEME_CAPTION_TEMPLATE = SUBTITLE_TEMPLATES["pop-scale"];

export interface MemeResult {
  /** Render job id (poll via the job queue). */
  jobId: string;
  /** Total output duration in seconds. */
  durationSeconds: number;
  /** How many sticker moments the director picked (post-sanitize). */
  momentsPlanned: number;
  /** How many stickers actually got a generated image (pre-render). */
  stickersWithImages: number;
  /** True when no image token is configured (render will be captions-only). */
  captionsOnly: boolean;
}

export interface MemeStageReporter {
  (stage: "Transcribing" | "Planning" | "Generating" | "Rendering"): void;
}

/**
 * Run the meme pipeline for one uploaded narration and enqueue the render job.
 * The caller owns beginRun/finishRun (so AI cost is attributed to this project)
 * and persists the returned jobId / optimization report.
 */
export async function runMemePipeline(opts: {
  projectId: string;
  sourceUrl: string;
  onStage?: MemeStageReporter;
}): Promise<MemeResult> {
  const { projectId, sourceUrl, onStage } = opts;

  // ── 1. Resolve + transcribe ────────────────────────────────────────────────
  onStage?.("Transcribing");
  const srcPath = await resolveInput(sourceUrl);
  const meta = await probe(srcPath);
  const probedDuration = meta.duration ?? 0;
  const audio = await extractAudioForTranscription(srcPath);
  const tr = await transcribeWithGroq({
    data: audio.buffer,
    name: audio.name,
    type: audio.type,
    wantWords: true,
  });
  const duration = tr.duration || probedDuration;
  if (!duration) throw new Error("Could not determine the narration duration.");

  // ── 2. Caption plan (reuse the existing ASS render path) ───────────────────
  const subtitles = buildCaptionEvents(tr.words);

  // ── 3. Emphasis director (content-driven moments + image prompts) ──────────
  onStage?.("Planning");
  const moments = await planEmphasisMoments({ transcript: tr.text, durationSeconds: duration });

  // ── 4. Image generation (one static still per moment, cached) ──────────────
  onStage?.("Generating");
  const canGenerate = imageGenConfigured();
  const stickers: EmphasisStickerClip[] = [];
  if (canGenerate && moments.length > 0) {
    // Generate in parallel — generateStickerImage bounds its own concurrency.
    const images = await Promise.all(moments.map((m) => generateStickerImage(m.imagePrompt)));
    moments.forEach((m, i) => {
      const img = images[i];
      if (!img) return; // this moment falls back to captions-only
      stickers.push({
        startTime: m.startTime,
        endTime: m.endTime,
        imageUrl: img.url,
        // Alternate the resting tilt so adjacent stickers don't all lean the
        // same way (the hand-placed feel).
        restTiltDeg: i % 2 === 0 ? -4 : 4,
        phrase: m.phrase,
      });
    });
  }

  // ── 5. Build the manifest + enqueue the render ─────────────────────────────
  onStage?.("Rendering");
  const manifest: RenderManifest = {
    version: 1,
    projectId,
    width: W,
    height: H,
    fps: FPS,
    durationSeconds: duration,
    narration: { videoUrl: sourceUrl },
    music: null,
    scenes: [], // no overlays — clean narration only
    subtitles,
    subtitleStyle: MEME_CAPTION_TEMPLATE,
    emphasisStickers: stickers,
  };

  const jobId = createJob({
    kind: "manifest",
    manifest,
    outputName: "meme.mp4",
    projectId,
  });
  pump();

  // Snapshot the optimization report (transcription + director + N images) onto
  // the project before handing off to the render queue. Render-time speed/compute
  // numbers are merged in later by the worker (mergeRenderStats).
  try {
    const report = buildReport(projectId);
    if (report) console.log(reportLogLine(report));
  } catch {
    /* reporting is best-effort, never blocks the render */
  }

  return {
    jobId,
    durationSeconds: duration,
    momentsPlanned: moments.length,
    stickersWithImages: stickers.length,
    captionsOnly: !canGenerate || stickers.length === 0,
  };
}
