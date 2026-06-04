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
import {
  SUBTITLE_TEMPLATES,
  type RenderManifest,
  type SubtitleTemplate,
} from "../render/manifest.js";
import { pickRandomCaptionTemplate } from "./captionTemplate.js";
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
  /** The randomly-chosen subtitle template for this render (logged/persisted). */
  subtitleTemplate: SubtitleTemplate;
  /**
   * Per-step diagnostics for this run, surfaced to the user when stickers are
   * skipped (e.g. "no image key", "Chromium unavailable"). Persisted on the meme
   * record so the page can show WHY a render was captions-only instead of
   * silently producing none.
   */
  diagnostics: MemeDiagnostics;
}

/** Why a sticker step was skipped, if it was — surfaced to the user. */
export interface MemeDiagnostics {
  /** Sticker moments the director picked (post-sanitize). */
  momentsPlanned: number;
  /** Moments that got a generated image (the rest fall back to captions-only). */
  imagesGenerated: number;
  /** Per-moment image-gen outcome (success or the failure reason). */
  imageResults: Array<{ phrase?: string; ok: boolean; reason?: string }>;
  /** Human-readable reason stickers will be skipped this run, or null if not. */
  skipReason: string | null;
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
  const imageResults: MemeDiagnostics["imageResults"] = [];
  console.log(
    `[meme] director picked ${moments.length} moment(s); image gen ${
      canGenerate ? "configured" : "NOT configured (no ZITE_OPENAI_ACCESS_TOKEN)"
    }`,
  );
  if (moments.length > 0) {
    // Generate in parallel — generateStickerImage bounds its own concurrency.
    // When the image key is absent generateStickerImage returns null per moment
    // (graceful captions-only), which we record as a per-moment skip reason.
    const images = await Promise.all(
      moments.map((m) => (canGenerate ? generateStickerImage(m.imagePrompt) : Promise.resolve(null))),
    );
    moments.forEach((m, i) => {
      const img = images[i];
      if (!img) {
        // No image for this moment → captions-only here. Record WHY so the user
        // sees a reason instead of a silently-missing sticker.
        const reason = canGenerate ? "image generation failed" : "no image key";
        imageResults.push({ phrase: m.phrase, ok: false, reason });
        console.warn(`[meme]   moment @${m.startTime}s "${m.phrase ?? ""}" — no sticker (${reason})`);
        return;
      }
      imageResults.push({ phrase: m.phrase, ok: true });
      console.log(`[meme]   moment @${m.startTime}s "${m.phrase ?? ""}" — image ok${img.cached ? " (cached)" : ""}`);
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

  // Compute a single user-visible reason when this render will be captions-only.
  let skipReason: string | null = null;
  if (stickers.length === 0) {
    if (moments.length === 0) {
      skipReason = "no emphasis moments were found (or the director is unconfigured) — captions only";
    } else if (!canGenerate) {
      skipReason = "no image key configured (ZITE_OPENAI_ACCESS_TOKEN) — captions only";
    } else {
      skipReason = "image generation failed for every moment — captions only";
    }
  }
  const diagnostics: MemeDiagnostics = {
    momentsPlanned: moments.length,
    imagesGenerated: stickers.length,
    imageResults,
    skipReason,
  };

  // ── 5. Build the manifest + enqueue the render ─────────────────────────────
  onStage?.("Rendering");
  // Randomize the caption template across the full short-form pool (same rotation
  // behaviour as the short-form editor) and flow the CHOSEN style into the ASS
  // caption render via the manifest.
  const subtitleTemplate = pickRandomCaptionTemplate();
  console.log(`[meme] caption template (random from pool): ${subtitleTemplate}`);
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
    subtitleStyle: SUBTITLE_TEMPLATES[subtitleTemplate],
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
    captionsOnly: stickers.length === 0,
    subtitleTemplate,
    diagnostics,
  };
}
