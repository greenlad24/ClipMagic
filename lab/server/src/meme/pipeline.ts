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
import {
  searchStickerCandidates,
  downloadSticker,
  stickerSearchConfigured,
  giphyConfigured,
  tenorConfigured,
} from "./stickerSearch.js";
import { reviewStickerFit } from "./stickerReview.js";
import type { EmphasisStickerClip } from "./sticker.js";

const W = 1080;
const H = 1920;
const FPS = 30;

/**
 * Which sticker source to use, configurable via MEME_STICKER_SOURCE without a
 * rebuild. Default = "giphy+tenor" (free reaction stickers + AI fit-review);
 * "openai" forces the legacy image-gen source. Either way the pipeline falls
 * back gracefully when the chosen source has no keys/results.
 */
export function resolveStickerSource(): "giphy+tenor" | "openai" {
  const v = (process.env.MEME_STICKER_SOURCE || "giphy+tenor").toLowerCase();
  return v === "openai" ? "openai" : "giphy+tenor";
}

/**
 * The whole-run skip reason when NO sticker was applied to any moment. Pure +
 * deterministic so the source-selection / fallback ordering is unit-testable:
 * giphy+tenor → openai → captions-only.
 */
export function computeSkipReason(opts: {
  momentsPlanned: number;
  stickersApplied: number;
  searchAvailable: boolean;
  openaiAvailable: boolean;
}): string | null {
  if (opts.stickersApplied > 0) return null;
  if (opts.momentsPlanned === 0) {
    return "no emphasis moments were found (or the director is unconfigured) — captions only";
  }
  if (!opts.searchAvailable && !opts.openaiAvailable) {
    return "no sticker source available — set GIPHY_API_KEY / TENOR_API_KEY (or an OpenAI key) — captions only";
  }
  return "no sticker fit (search/review/generation found nothing usable) — captions only";
}

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

/** Which sticker source produced a given moment's image. */
export type StickerSource = "giphy+tenor" | "openai" | "none";

/** Per-moment trace of the find → review → apply pipeline (for the UI/diagnostics). */
export interface MomentDiagnostic {
  phrase?: string;
  /** The director's reaction-sticker search query. */
  searchQuery: string;
  /** Candidate counts per provider from the search step. */
  candidates: { giphy: number; tenor: number };
  /** The fit-review decision: which candidate was chosen/dropped and why. */
  review: { reviewed: boolean; chosen: boolean; reason: string };
  /** Which source the FINAL applied image came from (or "none"). */
  appliedSource: StickerSource;
  /** True if a sticker image was ultimately applied for this moment. */
  ok: boolean;
}

/** Why a sticker step was skipped, if it was — surfaced to the user. */
export interface MemeDiagnostics {
  /** The sticker source chosen for this run (default = giphy+tenor). */
  source: StickerSource;
  /** Sticker moments the director picked (post-sanitize). */
  momentsPlanned: number;
  /** Moments that got a usable image (the rest fall back to captions-only). */
  imagesGenerated: number;
  /** Per-moment trace: query, candidate counts, review decision, final source. */
  moments: MomentDiagnostic[];
  /**
   * Per-moment image outcome (kept for backward compatibility with the existing
   * UI/persistence shape: phrase + ok + reason).
   */
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

  // ── 4. Sticker source: find → AI fit-review → apply (with fallbacks) ────────
  // Source order (configurable; default = Giphy+Tenor reaction stickers):
  //   1. Giphy + Tenor STATIC transparent stickers, gated by an AI fit-review.
  //   2. OpenAI image-gen fallback — only if the libraries returned nothing (or
  //      have no keys) AND an OpenAI key is present.
  //   3. Nothing available → captions-only with a visible reason.
  onStage?.("Generating");
  const source = resolveStickerSource();
  const searchAvailable = source === "giphy+tenor" && stickerSearchConfigured();
  const openaiAvailable = imageGenConfigured();
  console.log(
    `[meme] director picked ${moments.length} moment(s); source=${source} ` +
      `(giphy=${giphyConfigured()} tenor=${tenorConfigured()} openai=${openaiAvailable})`,
  );

  const stickers: EmphasisStickerClip[] = [];
  const momentDiags: MomentDiagnostic[] = [];

  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const diag: MomentDiagnostic = {
      phrase: m.phrase,
      searchQuery: m.searchQuery,
      candidates: { giphy: 0, tenor: 0 },
      review: { reviewed: false, chosen: false, reason: "" },
      appliedSource: "none",
      ok: false,
    };

    let appliedUrl: string | null = null;

    // 1) Giphy + Tenor reaction stickers → AI fit-review → download.
    if (searchAvailable) {
      const candidates = await searchStickerCandidates(m.searchQuery);
      diag.candidates.giphy = candidates.filter((c) => c.provider === "giphy").length;
      diag.candidates.tenor = candidates.filter((c) => c.provider === "tenor").length;

      if (candidates.length > 0) {
        const verdict = await reviewStickerFit(m.phrase || m.searchQuery, candidates);
        diag.review = {
          reviewed: verdict.reviewed,
          chosen: !!verdict.chosen,
          reason: verdict.reason,
        };
        if (verdict.chosen) {
          const dl = await downloadSticker(verdict.chosen);
          if (dl) {
            appliedUrl = dl.url;
            diag.appliedSource = "giphy+tenor";
          } else {
            diag.review.reason += " · download failed";
          }
        }
      } else {
        diag.review.reason = "no candidates found for query";
      }
    }

    // 2) OpenAI fallback — only when the libraries produced nothing for this
    //    moment and an OpenAI key exists.
    if (!appliedUrl && openaiAvailable && (source === "openai" || searchAvailable)) {
      const img = await generateStickerImage(m.imagePrompt);
      if (img) {
        appliedUrl = img.url;
        diag.appliedSource = "openai";
        if (!diag.review.reason) diag.review.reason = "no library sticker — used OpenAI fallback";
      }
    }

    if (appliedUrl) {
      diag.ok = true;
      stickers.push({
        startTime: m.startTime,
        endTime: m.endTime,
        imageUrl: appliedUrl,
        // Alternate the resting tilt so adjacent stickers don't all lean the
        // same way (the hand-placed feel).
        restTiltDeg: i % 2 === 0 ? -4 : 4,
        phrase: m.phrase,
      });
      console.log(
        `[meme]   moment @${m.startTime}s "${m.phrase ?? m.searchQuery}" — sticker ok ` +
          `(${diag.appliedSource}; giphy ${diag.candidates.giphy}/tenor ${diag.candidates.tenor}; ${diag.review.reason})`,
      );
    } else {
      console.warn(
        `[meme]   moment @${m.startTime}s "${m.phrase ?? m.searchQuery}" — no sticker ` +
          `(${diag.review.reason || "nothing applied"})`,
      );
    }
    momentDiags.push(diag);
  }

  // Backward-compatible flat per-moment results for the existing UI/persistence.
  const imageResults: MemeDiagnostics["imageResults"] = momentDiags.map((d) => ({
    phrase: d.phrase,
    ok: d.ok,
    reason: d.ok ? undefined : d.review.reason || "no sticker applied",
  }));

  // Compute a single user-visible reason when this render will be captions-only.
  const skipReason = computeSkipReason({
    momentsPlanned: moments.length,
    stickersApplied: stickers.length,
    searchAvailable,
    openaiAvailable,
  });
  const diagnostics: MemeDiagnostics = {
    source,
    momentsPlanned: moments.length,
    imagesGenerated: stickers.length,
    moments: momentDiags,
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
