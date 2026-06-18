/**
 * Orchestration for the Thumbnail Designer endpoints: download source
 * thumbnails, pick the best-fit expression PER variant by analysing each source
 * thumbnail (best-effort vision; falls back to the video-type's expression), run
 * the recreation chain per pick with PER-ITEM isolation (one failure never kills
 * the batch) and BOUNDED concurrency (slow API chains → sequential).
 */
import { hqThumbnailUrl, maxresThumbnailUrl, mqThumbnailUrl } from "./youtube.js";
import {
  readCharacterImage,
  uploadedExpressions,
  listCharacters,
  placementFromLabel,
  type Expression,
} from "./characters.js";
import {
  uploadedBackgrounds,
  readBackgroundImage,
  backgroundLabels,
} from "./backgrounds.js";
import { expressionsForVariants, type VideoType } from "./videoType.js";
import {
  analyzeSourceThumbnail,
  chooseBackground,
  fallbackExpression,
  type SourceAssessment,
  type AvailableExpression,
  type BackgroundCandidate,
} from "./artDirector.js";
import { recreateThumbnail, composeContrarianThumbnail, type ChainStep, type RecreateDeps } from "./recreate.js";
import {
  generateContrarianVariations,
  chooseContrarianBackgrounds,
  buildContrarianPrompt,
  type ContrarianVariation,
} from "./contrarian.js";
import {
  providersForMode,
  DEFAULT_GENERATION_MODE,
  DEFAULT_IMAGE_PROVIDER,
  type ImageProvider,
  type GenerationMode,
} from "./imageProviders.js";
import {
  createJob,
  updateVariant,
  updateResult,
  finishVariant,
  finishResult,
  completeJob,
  phasePercent,
  PHASE_LABEL,
  type ThumbnailJob,
} from "./jobs.js";

/** One generated variant returned to the UI. */
export interface ThumbnailVariant {
  videoId: string;
  /** The original YouTube thumbnail we recreated. */
  sourceThumbnailUrl: string;
  /** The generated 1920×1080 thumbnail (or null when this item failed). */
  outputUrl: string | null;
  expression: Expression;
  steps: ChainStep[];
  error?: string;
}

/** Fetch impl injectable for tests. Returns bytes + mime, or throws. */
export type DownloadFn = (url: string) => Promise<{ bytes: Buffer; mime: string }>;

/**
 * Per-variant source analysis: looks at the SOURCE thumbnail and returns the
 * best-fit expression (from the uploaded ones) AND whether it's element-heavy
 * (busy → recreate in one pass). Injectable for tests. The default is a
 * BEST-EFFORT wrapper around the vision pass: any failure (no creds, bad JSON,
 * network) falls back to the video-type's expression + busy:false so generation
 * never breaks and tests stay offline.
 */
export type AnalyzeSourceFn = (opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  available: AvailableExpression[];
  videoType: VideoType;
  keyword: string;
}) => Promise<SourceAssessment>;

const defaultAnalyzeSource: AnalyzeSourceFn = async (opts) => {
  try {
    return await analyzeSourceThumbnail(opts);
  } catch {
    return { expression: fallbackExpression(opts.videoType, opts.available), busy: false };
  }
};

/**
 * Pick an uploaded background for the source, or null. Injectable for tests; the
 * default is a BEST-EFFORT wrapper around the background-director (any failure →
 * null → keep + pop the original background).
 */
export type AnalyzeBackgroundFn = (opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  candidates: BackgroundCandidate[];
  videoType: VideoType;
  keyword: string;
}) => Promise<string | null>;

const defaultAnalyzeBackground: AnalyzeBackgroundFn = async (opts) => {
  try {
    return await chooseBackground(opts);
  } catch {
    return null;
  }
};

/** The uploaded expressions as {id,label} options for the source analysis. */
function availableExpressionOptions(): AvailableExpression[] {
  return listCharacters()
    .filter((c) => c.uploaded)
    .map((c) => ({ id: c.id, label: c.label }));
}

/** Load every uploaded background's bytes as candidates (once per batch). */
function loadBackgroundCandidates(): BackgroundCandidate[] {
  const labels = backgroundLabels();
  const out: BackgroundCandidate[] = [];
  for (const id of uploadedBackgrounds()) {
    const bytes = readBackgroundImage(id);
    if (bytes) out.push({ id, label: labels[id] || id, bytes, mime: "image/png" });
  }
  return out;
}

/**
 * Run the per-source analysis: best-fit expression + busy flag, and (when
 * backgrounds are uploaded) the chosen background's bytes. Best-effort; never
 * throws. Shared by the sync + job flows.
 */
async function analyzeForSource(opts: {
  src: { bytes: Buffer; mime: string };
  available: AvailableExpression[];
  bgCandidates: BackgroundCandidate[];
  videoType: VideoType;
  keyword: string;
  fallback: Expression;
  analyze: AnalyzeSourceFn;
  analyzeBg: AnalyzeBackgroundFn;
}): Promise<{
  expression: Expression;
  busy: boolean;
  backgroundBytes?: Buffer;
  backgroundMime?: string;
  placement?: "left" | "right" | null;
}> {
  let expression = opts.fallback;
  let busy = false;
  if (opts.available.length > 0) {
    const a = await opts.analyze({
      sourceBytes: opts.src.bytes,
      sourceMime: opts.src.mime,
      available: opts.available,
      videoType: opts.videoType,
      keyword: opts.keyword,
    });
    expression = a.expression;
    busy = a.busy;
  }
  // Forced side from the chosen expression's name (e.g. "…place on the right").
  const chosenLabel = opts.available.find((e) => e.id === expression)?.label ?? "";
  const placement = placementFromLabel(chosenLabel);
  let backgroundBytes: Buffer | undefined;
  if (opts.bgCandidates.length > 0) {
    const chosenId = await opts.analyzeBg({
      sourceBytes: opts.src.bytes,
      sourceMime: opts.src.mime,
      candidates: opts.bgCandidates,
      videoType: opts.videoType,
      keyword: opts.keyword,
    });
    if (chosenId) backgroundBytes = opts.bgCandidates.find((c) => c.id === chosenId)?.bytes;
  }
  return { expression, busy, backgroundBytes, backgroundMime: backgroundBytes ? "image/png" : undefined, placement };
}

const defaultDownload: DownloadFn = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`thumbnail download HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("thumbnail download returned no bytes");
  return { bytes, mime };
};

/**
 * Download a video's TRUE-16:9 source thumbnail for recreation: try maxresdefault
 * (1280×720, 16:9); if it isn't available, fall back to mqdefault (320×180, also
 * 16:9, always present). We NEVER feed hqdefault (4:3 letterboxed) into the chain
 * — that would bake black bars into every edit. Returns bytes + mime + URL used.
 */
export async function downloadSourceThumbnail(
  videoId: string,
  download: DownloadFn = defaultDownload,
): Promise<{ bytes: Buffer; mime: string; url: string }> {
  try {
    const maxUrl = maxresThumbnailUrl(videoId);
    const r = await download(maxUrl);
    return { ...r, url: maxUrl };
  } catch {
    const mqUrl = mqThumbnailUrl(videoId);
    const r = await download(mqUrl);
    return { ...r, url: mqUrl };
  }
}

export interface GenerateInput {
  keyword: string;
  videoType: VideoType;
  /** Picked video ids — any subset of the search results (no fixed cap). */
  picks: string[];
  /**
   * Generation mode = a single image provider. DEFAULT "gemini-pro" (Nano Banana
   * Pro @ 4K, the sharpest option); "gemini-flash" is the cheaper alternative.
   * Falls back to the legacy `provider` field, then to the default.
   */
  mode?: GenerationMode;
  /** @deprecated Back-compat single-provider selector; prefer `mode`. */
  provider?: ImageProvider;
}

/** Resolve the effective mode from the input (mode → provider → default). */
function effectiveMode(input: GenerateInput): GenerationMode {
  return input.mode ?? input.provider ?? DEFAULT_GENERATION_MODE;
}

/**
 * Generate one recreated thumbnail per pick. Each pick's expression is chosen by
 * analysing its OWN source thumbnail (best-effort; falls back to the video-type's
 * expression). Runs sequentially with per-item try/catch so a single failure
 * yields an error variant instead of aborting the run.
 */
export async function generateThumbnailVariants(
  input: GenerateInput,
  download: DownloadFn = defaultDownload,
  analyze: AnalyzeSourceFn = defaultAnalyzeSource,
  analyzeBg: AnalyzeBackgroundFn = defaultAnalyzeBackground,
): Promise<ThumbnailVariant[]> {
  const picks = input.picks;
  const available = uploadedExpressions();
  const availOptions = availableExpressionOptions();
  const bgCandidates = loadBackgroundCandidates();
  const expressions = expressionsForVariants(input.videoType, picks.length, available);

  const variants: ThumbnailVariant[] = [];
  for (let i = 0; i < picks.length; i++) {
    const videoId = picks[i];
    // The video-type default; upgraded below by the per-source analysis.
    let expression = expressions[i];
    try {
      if (!expression) throw new Error("No character expression available — upload at least one in the library.");

      const src = await downloadSourceThumbnail(videoId, download);
      // Analyse THIS source: best-fit expression + busy flag + chosen background.
      const a = await analyzeForSource({
        src,
        available: availOptions,
        bgCandidates,
        videoType: input.videoType,
        keyword: input.keyword,
        fallback: expression,
        analyze,
        analyzeBg,
      });
      expression = a.expression;
      const characterBytes = readCharacterImage(expression);
      if (!characterBytes) throw new Error(`Character image for "${expression}" is missing.`);
      // One outputUrl per pick: run the mode's single provider sub-run
      // (default → Nano Banana Pro @ 4K).
      const run = providersForMode(effectiveMode(input))[0];
      const result = await recreateThumbnail({
        sourceBytes: src.bytes,
        sourceMime: src.mime,
        characterBytes,
        keyword: input.keyword,
        videoType: input.videoType,
        expression,
        busy: a.busy,
        backgroundBytes: a.backgroundBytes,
        backgroundMime: a.backgroundMime,
        characterPlacement: a.placement,
        provider: run?.provider ?? DEFAULT_IMAGE_PROVIDER,
        imageSize: run?.imageSize,
      });
      variants.push({
        videoId,
        sourceThumbnailUrl: src.url,
        outputUrl: result.outputUrl,
        expression,
        steps: result.steps,
      });
    } catch (e) {
      variants.push({
        videoId,
        sourceThumbnailUrl: hqThumbnailUrl(videoId),
        outputUrl: null,
        expression: expression ?? (available[0] as Expression),
        steps: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return variants;
}

// ── Async, observable generation ──────────────────────────────────────────────
// The endpoint creates a job (one variant per pick), returns its id IMMEDIATELY,
// then runs THIS in the background. It mirrors `generateThumbnailVariants`'
// per-pick, per-item-isolated, sequential flow — but drives the progress store
// instead of returning an array, so the UI can poll live status and see each
// thumbnail land the moment it finishes. `recreateDeps` is injectable so tests
// run with no network / AI / ffmpeg.

/** Start a generation job: create it, kick the runner off, return the job. */
export function startThumbnailJob(
  input: GenerateInput,
  download: DownloadFn = defaultDownload,
  recreateDeps?: RecreateDeps,
): ThumbnailJob {
  const available = uploadedExpressions();
  const expressions = expressionsForVariants(input.videoType, input.picks.length, available);
  // The single provider sub-run each pick fans out to (always exactly one now).
  const runs = providersForMode(effectiveMode(input));
  // Seed one queued variant per pick, carrying its single provider result. The
  // source URL starts as the always-exists hqdefault so the UI shows the original
  // immediately; it's upgraded to the actual downloaded URL (maxres when
  // available) once the fetch phase runs.
  const job = createJob(
    input.picks.map((videoId, i) => ({
      videoId,
      sourceThumbnailUrl: hqThumbnailUrl(videoId),
      expression: expressions[i] ?? (available[0] as string) ?? "smile",
      providers: runs.map((r) => ({ provider: r.provider, label: r.label })),
    })),
  );
  // Fire-and-forget. runThumbnailJob never throws (it records onto the job).
  const analyze = recreateDeps?.analyzeSource ?? defaultAnalyzeSource;
  const analyzeBg = recreateDeps?.chooseBackground ?? defaultAnalyzeBackground;
  void runThumbnailJob(job, input, expressions, available, download, recreateDeps, analyze, analyzeBg);
  return job;
}

/**
 * Drive a generation job to completion. Sequential (one pick at a time) for clear,
 * coherent progress. Per-pick AND per-provider try/catch: one pick's pre-render
 * failure leaves an error variant and the rest still finish; the single provider
 * sub-run's failure leaves that variant's result errored. Never throws.
 */
export async function runThumbnailJob(
  job: ThumbnailJob,
  input: GenerateInput,
  expressions: Expression[],
  available: Expression[],
  download: DownloadFn = defaultDownload,
  recreateDeps?: RecreateDeps,
  analyze: AnalyzeSourceFn = defaultAnalyzeSource,
  analyzeBg: AnalyzeBackgroundFn = defaultAnalyzeBackground,
): Promise<void> {
  const runs = providersForMode(effectiveMode(input));
  const availOptions = availableExpressionOptions();
  const bgCandidates = loadBackgroundCandidates();
  try {
    for (let i = 0; i < input.picks.length; i++) {
      const videoId = input.picks[i];
      // The video-type default; upgraded below by the per-source analysis.
      let expression = expressions[i];
      let busy = false;
      let backgroundBytes: Buffer | undefined;
      let backgroundMime: string | undefined;
      let placement: "left" | "right" | null | undefined;
      // Shared fetch phase: move every sub-run column into "running" together.
      updateVariant(job, i, { status: "running", stepLabel: PHASE_LABEL.fetch, percent: phasePercent("fetch", 0) });
      try {
        if (!expression) throw new Error("No character expression available — upload at least one in the library.");

        const src = await downloadSourceThumbnail(videoId, download);
        // Analyse THIS source: best-fit expression + busy flag + chosen background
        // (best-effort); reflect the expression on the variant for the UI.
        const a = await analyzeForSource({
          src,
          available: availOptions,
          bgCandidates,
          videoType: input.videoType,
          keyword: input.keyword,
          fallback: expression,
          analyze,
          analyzeBg,
        });
        expression = a.expression;
        busy = a.busy;
        backgroundBytes = a.backgroundBytes;
        backgroundMime = a.backgroundMime;
        placement = a.placement;
        job.variants[i].expression = expression;
        const characterBytes = readCharacterImage(expression);
        if (!characterBytes) throw new Error(`Character image for "${expression}" is missing.`);

        // Upgrade to the real source URL (maxres when it existed) + close the fetch band.
        updateVariant(job, i, { stepLabel: PHASE_LABEL.outfit, percent: phasePercent("fetch", 1) });
        job.variants[i].sourceThumbnailUrl = src.url;

        // Run each provider sub-run, isolated. A throw here only fails THIS column.
        for (const run of runs) {
          try {
            const result = await recreateThumbnail(
              {
                sourceBytes: src.bytes,
                sourceMime: src.mime,
                characterBytes,
                keyword: input.keyword,
                videoType: input.videoType,
                expression,
                busy,
                backgroundBytes,
                backgroundMime,
                characterPlacement: placement,
                provider: run.provider,
                imageSize: run.imageSize,
                onProgress: ({ stepLabel, percent }) =>
                  updateResult(job, i, run.provider, { status: "running", stepLabel, percent }),
              },
              recreateDeps,
            );
            // Surface this column's output the MOMENT its sub-run finishes.
            finishResult(job, i, run.provider, { outputUrl: result.outputUrl });
          } catch (e) {
            // One provider failing leaves an error column; the sibling keeps going.
            finishResult(job, i, run.provider, { error: e instanceof Error ? e.message : String(e) });
          }
        }
      } catch (e) {
        // A pre-render failure (missing char / download) fails the whole variant.
        finishVariant(job, i, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    completeJob(job);
  } catch (e) {
    // Defensive: the loop is fully guarded, but never leave a job un-terminated.
    completeJob(job, e instanceof Error ? e.message : String(e));
  }
}

// ── Contrarian originals (the second, parallel workflow) ──────────────────────
// Builds 3 ORIGINAL thumbnails from scratch: an uploaded BACKGROUND + the
// CHARACTER + a short styled CONTRARIAN statement (no money claims). An
// art-director copywriter picks, PER variation, the statement + emphasis + the
// best-fit expression + the placement (varied). A placement directive in the
// chosen expression's name still overrides. Reuses the SAME job store so the UI
// polls it identically and it runs in parallel with a recreation job. Backgrounds
// are reused (cycled) to always reach 3.

/** Injectable variation writer (so the job can run offline in tests). */
export type WriteVariationsFn = (
  keyword: string,
  count: number,
  available: AvailableExpression[],
) => Promise<ContrarianVariation[]>;

const CONTRARIAN_COUNT = 3;

export function startContrarianJob(
  input: { keyword: string; mode?: GenerationMode; provider?: ImageProvider },
  recreateDeps?: RecreateDeps,
  writeVariations: WriteVariationsFn = (k, n, a) => generateContrarianVariations(k, n, a),
): ThumbnailJob {
  const available = availableExpressionOptions();
  const runs = providersForMode(input.mode ?? input.provider ?? DEFAULT_GENERATION_MODE);
  // Seed 3 queued variants (no source thumbnail — these are originals). The
  // per-variation expression is filled once the copywriter runs.
  const job = createJob(
    Array.from({ length: CONTRARIAN_COUNT }, (_, i) => ({
      videoId: `contrarian-${i + 1}`,
      sourceThumbnailUrl: "",
      expression: available[0]?.id ?? "—",
      providers: runs.map((r) => ({ provider: r.provider, label: r.label })),
    })),
  );
  void runContrarianJob(job, input, available, recreateDeps, writeVariations);
  return job;
}

async function runContrarianJob(
  job: ThumbnailJob,
  input: { keyword: string; mode?: GenerationMode; provider?: ImageProvider },
  available: AvailableExpression[],
  recreateDeps?: RecreateDeps,
  writeVariations: WriteVariationsFn = (k, n, a) => generateContrarianVariations(k, n, a),
): Promise<void> {
  const run = providersForMode(input.mode ?? input.provider ?? DEFAULT_GENERATION_MODE)[0];
  try {
    // Gate: need a character expression + at least one uploaded background.
    const bgCandidates = loadBackgroundCandidates();
    if (available.length === 0) {
      for (let i = 0; i < job.variants.length; i++) {
        finishVariant(job, i, { error: "Upload at least one character expression to make contrarian originals." });
      }
      completeJob(job);
      return;
    }
    if (bgCandidates.length === 0) {
      for (let i = 0; i < job.variants.length; i++) {
        finishVariant(job, i, { error: "Upload at least one background to make contrarian originals." });
      }
      completeJob(job);
      return;
    }

    // Art-direct the variations (copy + emphasis + cast + placement) + backgrounds.
    const variations = await writeVariations(input.keyword, job.variants.length, available);
    const chosenBgIds = chooseContrarianBackgrounds(bgCandidates.map((c) => c.id), job.variants.length);

    for (let i = 0; i < job.variants.length; i++) {
      const v = variations[i];
      const bg = bgCandidates.find((c) => c.id === chosenBgIds[i]) ?? bgCandidates[0];
      // The cast expression (validated to an available id by the writer's pad step).
      const exprId = available.some((e) => e.id === v.expressionId) ? v.expressionId : available[0].id;
      const characterBytes = readCharacterImage(exprId);
      // A placement directive in the chosen expression's NAME overrides the
      // copywriter's varied placement.
      const label = available.find((e) => e.id === exprId)?.label ?? "";
      const placement = placementFromLabel(label) ?? v.placement;
      job.variants[i].expression = exprId;
      updateVariant(job, i, { status: "running", stepLabel: "Composing original", percent: phasePercent("swap", 0) });
      try {
        if (!characterBytes) throw new Error(`Character image for "${exprId}" is missing.`);
        const result = await composeContrarianThumbnail(
          {
            backgroundBytes: bg.bytes,
            backgroundMime: bg.mime,
            characterBytes,
            instruction: buildContrarianPrompt(v, placement),
            provider: run?.provider ?? DEFAULT_IMAGE_PROVIDER,
            imageSize: run?.imageSize,
            onProgress: ({ stepLabel, percent }) =>
              updateResult(job, i, run?.provider ?? DEFAULT_IMAGE_PROVIDER, { status: "running", stepLabel, percent }),
          },
          recreateDeps,
        );
        finishResult(job, i, run?.provider ?? DEFAULT_IMAGE_PROVIDER, { outputUrl: result.outputUrl });
      } catch (e) {
        finishResult(job, i, run?.provider ?? DEFAULT_IMAGE_PROVIDER, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    completeJob(job);
  } catch (e) {
    completeJob(job, e instanceof Error ? e.message : String(e));
  }
}
