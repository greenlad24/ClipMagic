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
import type { StickerCandidate } from "./stickerSearch.js";
import { orchestrateStickers } from "./orchestrate.js";
import { memeSubtitleStyle } from "./config.js";
import { pickRandomMusicTrack } from "./music.js";

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
  /** How many of the applied stickers came from a (capped) OpenAI generation. */
  openaiGenerated: number;
  /** The per-video OpenAI generation cap in force this run (env MEME_OPENAI_MAX). */
  openaiCap: number;
  /** Per-moment trace: query, candidate counts, review decision, final source. */
  moments: MomentDiagnostic[];
  /**
   * Per-moment image outcome (kept for backward compatibility with the existing
   * UI/persistence shape: phrase + ok + reason).
   */
  imageResults: Array<{ phrase?: string; ok: boolean; reason?: string }>;
  /** Human-readable reason stickers will be skipped this run, or null if not. */
  skipReason: string | null;
  /** Why the emphasis director produced no moments (unconfigured/errored), or null. */
  directorReason: string | null;
}

/** The pipeline stages, in order, as a coarse status the record/UI tracks. */
export type MemeStage = "Transcribing" | "Planning" | "Generating" | "Rendering";

/**
 * A live progress tick from the pipeline. `stage` is the coarse phase; `label`
 * is a human sentence ("Finding & reviewing stickers 3/8"); `progress` is the
 * pipeline's own 0..1 PLANNING progress (transcribe→plan→source→handoff). The
 * render itself is tracked separately by the render job. `detail` carries
 * structured counters (current/total moments) the UI can render as a sub-bar.
 */
export interface MemeProgress {
  stage: MemeStage;
  label: string;
  progress: number;
  detail?: { current: number; total: number } | null;
}

export interface MemeStageReporter {
  (p: MemeProgress): void;
}

/** Progress floor (0..1) for each coarse stage so the bar only moves forward. */
export const MEME_STAGE_PROGRESS: Record<MemeStage, number> = {
  Transcribing: 0.05,
  Planning: 0.3,
  Generating: 0.45, // per-moment sourcing interpolates between here and Rendering
  Rendering: 0.95,
};

/**
 * Run the meme pipeline for one uploaded narration and enqueue the render job.
 * The caller owns beginRun/finishRun (so AI cost is attributed to this project)
 * and persists the returned jobId / optimization report.
 */
export async function runMemePipeline(opts: {
  projectId: string;
  sourceUrl: string;
  /** Owner of the render — used to pick a random track from THEIR music library. */
  userId?: string;
  onStage?: MemeStageReporter;
}): Promise<MemeResult> {
  const { projectId, sourceUrl, userId, onStage } = opts;
  const t0 = Date.now();
  const lap = (label: string, since: number) =>
    console.log(`[meme] ${label} (${Date.now() - since}ms, +${Date.now() - t0}ms)`);
  const report = (p: MemeProgress) => { try { onStage?.(p); } catch { /* reporting never blocks */ } };

  // ── 1. Resolve + transcribe ────────────────────────────────────────────────
  report({ stage: "Transcribing", label: "Transcribing narration", progress: MEME_STAGE_PROGRESS.Transcribing });
  let ts = Date.now();
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
  lap(`transcribed ${tr.words.length} words`, ts);

  // ── 2. Caption plan (reuse the existing ASS render path) ───────────────────
  const subtitles = buildCaptionEvents(tr.words);
  console.log(`[meme] built ${subtitles.length} caption event(s)`);

  // ── 3. Emphasis director (content-driven moments + image prompts) ──────────
  report({ stage: "Planning", label: "Picking emphasis moments", progress: MEME_STAGE_PROGRESS.Planning });
  ts = Date.now();
  const { moments, unavailableReason: directorReason } = await planEmphasisMoments({
    transcript: tr.text, durationSeconds: duration,
  });
  lap(`director planned ${moments.length} moment(s)`, ts);

  // ── 4. Sticker source: find → AI fit-review → apply (with fallbacks) ────────
  // Source order (configurable; default = Giphy+Tenor reaction stickers):
  //   1. Giphy + Tenor STATIC transparent stickers, gated by an AI fit-review.
  //   2. OpenAI image-gen fallback — only if the libraries returned nothing (or
  //      have no keys) AND an OpenAI key is present.
  //   3. Nothing available → captions-only with a visible reason.
  const source = resolveStickerSource();
  const searchAvailable = source === "giphy+tenor" && stickerSearchConfigured();
  const openaiAvailable = imageGenConfigured();
  console.log(
    `[meme] director picked ${moments.length} moment(s); source=${source} ` +
      `(giphy=${giphyConfigured()} tenor=${tenorConfigured()} openai=${openaiAvailable})`,
  );
  report({
    stage: "Generating",
    label: moments.length > 0
      ? `Finding & reviewing stickers 0/${moments.length}`
      : "No emphasis moments — captions only",
    progress: MEME_STAGE_PROGRESS.Generating,
    detail: moments.length > 0 ? { current: 0, total: moments.length } : null,
  });
  ts = Date.now();

  // Two-pass sourcing — FREE (Giphy/Tenor + review) first for every moment, then
  // the (capped) OpenAI fallback fills only the moments left unmatched. Cap +
  // prioritization + diagnostics all live in the injectable orchestrator so the
  // ordering is unit-testable with mocks.
  // Interpolate the Generating→Rendering band as moments are processed so the
  // bar advances per moment (and the label shows "3/8").
  const GEN_LO = MEME_STAGE_PROGRESS.Generating;
  const GEN_HI = MEME_STAGE_PROGRESS.Rendering;
  const { stickers, diagnostics: momentDiags, openaiUsed, openaiCap } = await orchestrateStickers(
    moments,
    {
      searchAvailable,
      openaiAvailable,
      source,
      search: (q: string) => searchStickerCandidates(q),
      review: (line: string, cands: StickerCandidate[]) => reviewStickerFit(line, cands),
      download: (c: StickerCandidate) => downloadSticker(c),
      generate: (prompt: string) => generateStickerImage(prompt),
      onMomentProgress: (done, total, phase) => {
        const frac = total > 0 ? done / total : 1;
        report({
          stage: "Generating",
          label: `${phase === "generating" ? "Generating stickers" : "Finding & reviewing stickers"} ${done}/${total}`,
          progress: GEN_LO + (GEN_HI - GEN_LO) * frac,
          detail: { current: done, total },
        });
      },
    },
  );
  lap(`sourced ${stickers.length}/${moments.length} sticker(s)`, ts);

  // Per-moment log lines (counts, source, verdict) for the server-side trace.
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const d = momentDiags[i];
    if (d.ok) {
      console.log(
        `[meme]   moment @${m.startTime}s "${m.phrase ?? m.searchQuery}" — sticker ok ` +
          `(${d.appliedSource}; giphy ${d.candidates.giphy}/tenor ${d.candidates.tenor}; ${d.review.reason})`,
      );
    } else {
      console.warn(
        `[meme]   moment @${m.startTime}s "${m.phrase ?? m.searchQuery}" — no sticker ` +
          `(${d.review.reason || "nothing applied"})`,
      );
    }
  }
  console.log(`[meme] sticker sourcing: ${stickers.length}/${moments.length} applied; OpenAI gen ${openaiUsed}/${openaiCap}`);

  // Backward-compatible flat per-moment results for the existing UI/persistence.
  const imageResults: MemeDiagnostics["imageResults"] = momentDiags.map((d: MomentDiagnostic) => ({
    phrase: d.phrase,
    ok: d.ok,
    reason: d.ok ? undefined : d.review.reason || "no sticker applied",
  }));

  // Compute a single user-visible reason when this render will be captions-only.
  // When the director itself was the blocker (unconfigured / errored), prefer its
  // SPECIFIC reason over the generic "no emphasis moments" so the user sees WHY.
  const genericSkip = computeSkipReason({
    momentsPlanned: moments.length,
    stickersApplied: stickers.length,
    searchAvailable,
    openaiAvailable,
  });
  const skipReason =
    stickers.length === 0 && moments.length === 0 && directorReason
      ? `${directorReason} — captions only`
      : genericSkip;
  const diagnostics: MemeDiagnostics = {
    source,
    momentsPlanned: moments.length,
    imagesGenerated: stickers.length,
    openaiGenerated: openaiUsed,
    openaiCap,
    moments: momentDiags,
    imageResults,
    skipReason,
    directorReason: directorReason ?? null,
  };

  // ── 5. Build the manifest + enqueue the render ─────────────────────────────
  report({
    stage: "Rendering",
    label: stickers.length > 0
      ? `Rendering with ${stickers.length} sticker${stickers.length === 1 ? "" : "s"}`
      : "Rendering (captions only)",
    progress: MEME_STAGE_PROGRESS.Rendering,
  });
  // Randomize the caption template across the full short-form pool (same rotation
  // behaviour as the short-form editor) and flow the CHOSEN style into the ASS
  // caption render via the manifest.
  const subtitleTemplate = pickRandomCaptionTemplate();
  console.log(`[meme] caption template (random from pool): ${subtitleTemplate}`);
  // Bigger/bolder captions for the meme editor ONLY — scale the chosen template's
  // font size (the short-form editor keeps the base sizes). ass.ts still auto-fits
  // any line that would otherwise overflow the safe width.
  const subtitleStyle = memeSubtitleStyle(SUBTITLE_TEMPLATES[subtitleTemplate]);
  console.log(
    `[meme] caption font size: ${SUBTITLE_TEMPLATES[subtitleTemplate].fontSize}px → ${subtitleStyle.fontSize}px (meme bump)`,
  );

  // Random background music from the user's existing library (same library +
  // random selection the short-form editor's "auto" mode uses), mixed quietly.
  const music = userId ? await pickRandomMusicTrack(userId) : null;
  if (music) {
    console.log(`[meme] background music (random): "${music.trackName ?? "track"}" @ vol ${music.volume}`);
  } else {
    console.log(`[meme] no background music (empty library or no user) — narration only bed`);
  }

  const manifest: RenderManifest = {
    version: 1,
    projectId,
    width: W,
    height: H,
    fps: FPS,
    durationSeconds: duration,
    narration: { videoUrl: sourceUrl },
    music,
    scenes: [], // no overlays — clean narration only
    subtitles,
    subtitleStyle,
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
