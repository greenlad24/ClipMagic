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
  planTextRewrites,
  planCustomEdits,
  artDirect as defaultArtDirect,
  type SourceAssessment,
  type AvailableExpression,
  type BackgroundCandidate,
  type TextRewrite,
} from "./artDirector.js";
import { recreateThumbnail, composeContrarianThumbnail, type ChainStep, type RecreateDeps } from "./recreate.js";
import {
  generateContrarianVariations,
  chooseContrarianBackgrounds,
  resolveTemplateBackground,
  buildContrarianComposePrompt,
  padContrarianVariations,
  type ContrarianVariation,
  type ContrarianContext,
} from "./contrarian.js";
import { templateForIndex, CONTRARIAN_TEMPLATES, type ContrarianTemplate } from "./textOverlay.js";
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
  attachResultOverlay,
  attachResultRecompose,
  completeJob,
  jobCancelled,
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
  backgroundId?: string | null;
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
  let backgroundId: string | null = null;
  let backgroundBytes: Buffer | undefined;
  if (opts.bgCandidates.length > 0) {
    const chosenId = await opts.analyzeBg({
      sourceBytes: opts.src.bytes,
      sourceMime: opts.src.mime,
      candidates: opts.bgCandidates,
      videoType: opts.videoType,
      keyword: opts.keyword,
    });
    if (chosenId) {
      backgroundId = chosenId;
      backgroundBytes = opts.bgCandidates.find((c) => c.id === chosenId)?.bytes;
    }
  }
  return { expression, busy, backgroundId, backgroundBytes, backgroundMime: backgroundBytes ? "image/png" : undefined, placement };
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

/**
 * Sentinel expression id meaning "this source has NO person — don't swap a
 * character in" (e.g. an icon/text thumbnail). The recreation then keeps the
 * layout and applies only the reviewed edits + background.
 */
export const NO_CHARACTER = "__none__";

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
  /**
   * Pro render resolution chosen in the UI: "1K" | "2K" | "4K", or "" for the
   * model default (no imageSize). Omit to use the server default. Threads to the
   * Nano Banana Pro request's imageConfig.imageSize.
   */
  imageSize?: string;
  /**
   * Optional REVIEWED per-pick plans (from the review step). When a plan matches a
   * pick (by videoId), its choices are used VERBATIM and the per-source vision
   * analysis is skipped: the chosen character expression, the busy flag, the
   * chosen background, and the approved text rewrites all come from the plan.
   */
  plans?: RecreationPlan[];
}

/**
 * One reviewed/editable recreation plan: every decision the system made for a
 * single source thumbnail, surfaced so the user can edit it before generation.
 */
export interface RecreationPlan {
  videoId: string;
  /** The resolved source thumbnail URL (maxres when it existed). */
  sourceThumbnailUrl: string;
  /** Chosen character/expression id (editable → any uploaded expression). */
  expression: Expression;
  /** Human label for the chosen expression. */
  expressionLabel: string;
  /** Recreate element-heavy thumbnails in one pass (computed; carried for consistency). */
  busy: boolean;
  /** Chosen uploaded background id, or null to keep/enhance the original. */
  backgroundId: string | null;
  /** The proposed text changes (editable old→new pairs). */
  rewrites: TextRewrite[];
  /** Every OTHER element the AI will change (device/font/logo + custom), editable. */
  elements: PlanElement[];
}

/** One non-text element edit in the review: toggle + an editable instruction. */
export interface PlanElement {
  /** "device-screen" | "font" | "bold-text" | "logo" | "custom". */
  id: string;
  label: string;
  apply: boolean;
  instruction: string;
}

/** Injectable text-planner (so plan tests run offline). */
export type PlanTextFn = (opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  keyword: string;
  videoType: VideoType;
  titles?: string[];
}) => Promise<TextRewrite[]>;

/** Injectable element-planner: the AI's non-text edits (device/font/logo). */
export type PlanElementsFn = (opts: {
  imageBytes: Buffer;
  imageMime: string;
  keyword: string;
  videoType: VideoType;
}) => Promise<PlanElement[]>;

const defaultPlanElements: PlanElementsFn = async (opts) => {
  const steps = await defaultArtDirect({
    imageBytes: opts.imageBytes,
    imageMime: opts.imageMime,
    keyword: opts.keyword,
    videoType: opts.videoType,
  });
  // Surface the NON-text changes the director wants to make (text is handled as
  // editable old→new pairs separately). Only applied steps carry an instruction.
  return steps
    .filter((s) => s.id !== "text-rewrite" && s.apply && s.instruction)
    .map((s) => ({ id: s.id, label: s.label, apply: true, instruction: s.instruction }));
};

/**
 * PLAN (don't render) every per-thumbnail decision for the chosen picks so the
 * user can review + edit them: the cast expression, the busy flag, the chosen
 * background, the text rewrites (grounded in the titles), AND every other element
 * the AI will change (device-screen / font / logo …). Per-pick try/catch — one
 * bad source yields a minimal editable row instead of aborting. The vision passes
 * run concurrently (per pick AND across picks) so the review stays snappy.
 */
export async function planRecreations(
  input: { picks: string[]; keyword: string; videoType: VideoType; titles?: string[] },
  download: DownloadFn = defaultDownload,
  analyze: AnalyzeSourceFn = defaultAnalyzeSource,
  analyzeBg: AnalyzeBackgroundFn = defaultAnalyzeBackground,
  planText: PlanTextFn = planTextRewrites,
  planElements: PlanElementsFn = defaultPlanElements,
): Promise<RecreationPlan[]> {
  const available = availableExpressionOptions();
  const bgCandidates = loadBackgroundCandidates();
  const labelFor = (id: string) => available.find((e) => e.id === id)?.label ?? id;
  const fallback = available.length ? fallbackExpression(input.videoType, available) : (("smile" as unknown) as Expression);
  const planOne = async (videoId: string): Promise<RecreationPlan> => {
    try {
      const src = await downloadSourceThumbnail(videoId, download);
      // All the per-source vision passes are independent → run them concurrently.
      const [a, rewrites, elements] = await Promise.all([
        analyzeForSource({
          src,
          available,
          bgCandidates,
          videoType: input.videoType,
          keyword: input.keyword,
          fallback,
          analyze,
          analyzeBg,
        }),
        planText({ sourceBytes: src.bytes, sourceMime: src.mime, keyword: input.keyword, videoType: input.videoType, titles: input.titles }),
        planElements({ imageBytes: src.bytes, imageMime: src.mime, keyword: input.keyword, videoType: input.videoType }).catch(() => []),
      ]);
      return {
        videoId,
        sourceThumbnailUrl: src.url,
        expression: a.expression,
        expressionLabel: labelFor(a.expression),
        busy: a.busy,
        backgroundId: a.backgroundId ?? null,
        rewrites,
        elements,
      };
    } catch {
      // Minimal editable row so the UI still shows the pick.
      return {
        videoId,
        sourceThumbnailUrl: hqThumbnailUrl(videoId),
        expression: fallback,
        expressionLabel: labelFor(fallback),
        busy: false,
        backgroundId: null,
        rewrites: [],
        elements: [],
      };
    }
  };
  return Promise.all(input.picks.map(planOne));
}

/**
 * Turn the creator's free-text request into precise edit element(s) for ONE pick
 * (downloads the source, runs the custom-edit vision pass). Returned as
 * PlanElements the UI appends to that pick's editable element list. Best-effort.
 */
export async function planCustomEdit(
  input: { videoId: string; keyword: string; request: string },
  download: DownloadFn = defaultDownload,
  plan: typeof planCustomEdits = planCustomEdits,
): Promise<PlanElement[]> {
  if (!input.request.trim()) return [];
  try {
    const src = await downloadSourceThumbnail(input.videoId, download);
    const edits = await plan({ sourceBytes: src.bytes, sourceMime: src.mime, keyword: input.keyword, request: input.request });
    return edits.map((e) => ({ id: "custom", label: e.label, apply: true, instruction: e.instruction }));
  } catch {
    return [];
  }
}

/**
 * RE-COMPOSITE a contrarian thumbnail from scratch (no image model) for the live
 * character controls: load the saved background + character, place the character
 * with the user's x/y/zoom, draw the headline at the given size/position. Returns
 * the new output URL + the new pre-text base URL (so later text-only tweaks can
 * re-render cheaply). Best-effort: throws on missing assets.
 */
export async function recompositeContrarian(input: {
  backgroundId: string;
  expressionId: string;
  templateId: string;
  placement?: "left" | "center" | "right";
  charOffsetX?: number;
  charOffsetY?: number;
  charZoom?: number;
  text: string;
  emphasis: string;
  textScale?: number;
  textOffsetY?: number;
}): Promise<{ outputUrl: string; baseUrl: string }> {
  const bg = readBackgroundImage(input.backgroundId);
  if (!bg) throw new Error("background not found");
  const characterBytes = readCharacterImage(input.expressionId);
  if (!characterBytes) throw new Error("character not found");
  const template = CONTRARIAN_TEMPLATES.find((t) => t.id === input.templateId) ?? CONTRARIAN_TEMPLATES[0];
  const placement = input.placement ?? template.charPlacement;
  const result = await composeContrarianThumbnail({
    backgroundBytes: bg,
    backgroundMime: "image/png",
    characterBytes,
    instruction: "",
    placement,
    headTopFrac: template.id === "top-strike" ? 0.2 : 0.05,
    charOffsetX: input.charOffsetX,
    charOffsetY: input.charOffsetY,
    charZoom: input.charZoom,
    frameW: 1920,
    frameH: 1080,
    overlay: { template, text: input.text, emphasis: input.emphasis, sizeScale: input.textScale, offsetY: input.textOffsetY },
  });
  return { outputUrl: result.outputUrl, baseUrl: result.overlay?.baseUrl ?? result.outputUrl };
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
      if (jobCancelled(job)) break; // stop starting new picks once cancelled
      const videoId = input.picks[i];
      // The video-type default; upgraded below by the per-source analysis.
      let expression = expressions[i];
      let busy = false;
      let backgroundBytes: Buffer | undefined;
      let backgroundMime: string | undefined;
      let placement: "left" | "right" | null | undefined;
      let textRewrites: TextRewrite[] | undefined;
      let plannedElements: { id: string; label: string; instruction: string }[] | undefined;
      let swapCharacter = true;
      // A reviewed/edited plan for THIS pick (matched by videoId) overrides the
      // automatic vision analysis entirely.
      const plan = input.plans?.find((p) => p.videoId === videoId);
      // Shared fetch phase: move every sub-run column into "running" together.
      updateVariant(job, i, { status: "running", stepLabel: PHASE_LABEL.fetch, percent: phasePercent("fetch", 0) });
      try {
        if (!expression) throw new Error("No character expression available — upload at least one in the library.");

        const src = await downloadSourceThumbnail(videoId, download);
        if (plan) {
          // Use the reviewed choices verbatim; skip the per-source vision analysis.
          // "None" → no person to swap: skip the swap/outfit, keep the layout.
          swapCharacter = plan.expression !== NO_CHARACTER;
          expression = swapCharacter && availOptions.some((e) => e.id === plan.expression) ? plan.expression : (swapCharacter ? expression : "none");
          busy = plan.busy;
          const label = availOptions.find((e) => e.id === expression)?.label ?? "";
          placement = placementFromLabel(label);
          if (plan.backgroundId) {
            backgroundBytes = bgCandidates.find((c) => c.id === plan.backgroundId)?.bytes;
            backgroundMime = backgroundBytes ? "image/png" : undefined;
          }
          textRewrites = plan.rewrites;
          // The reviewed non-text edits (device/font/logo/custom) — applied ones only.
          plannedElements = (plan.elements ?? [])
            .filter((e) => e.apply && e.instruction)
            .map((e) => ({ id: e.id, label: e.label, instruction: e.instruction }));
        } else {
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
        }
        job.variants[i].expression = expression;
        // No swap → no character image needed (we keep the original layout).
        const loaded = swapCharacter ? readCharacterImage(expression) : Buffer.alloc(0);
        if (swapCharacter && !loaded) throw new Error(`Character image for "${expression}" is missing.`);
        const characterBytes: Buffer = loaded ?? Buffer.alloc(0);

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
                textRewrites,
                plannedElements,
                swapCharacter,
                // Use the EXACT character pixels: AI removes the original person,
                // we composite the real character on top (no face redraw).
                compositeCharacter: true,
                provider: run.provider,
                imageSize: input.imageSize ?? run.imageSize,
                onProgress: ({ stepLabel, percent }) =>
                  updateResult(job, i, run.provider, { status: "running", stepLabel, percent }),
              },
              recreateDeps,
            );
            // Surface this column's output the MOMENT its sub-run finishes.
            finishResult(job, i, run.provider, { outputUrl: result.outputUrl });
            // Composite mode: carry the scene + character so the UI can live-
            // reposition the character (x/y/zoom handles) without the image model.
            if (result.recompose) attachResultRecompose(job, i, run.provider, result.recompose);
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
  ground: ContrarianContext,
) => Promise<ContrarianVariation[]>;

const CONTRARIAN_COUNT = 3;
const defaultWriteVariations: WriteVariationsFn = (k, n, a, g) => generateContrarianVariations(k, n, a, g);

/**
 * Resolve the final cast + placement for a template: a CENTERED template never
 * uses a left/right-directed character (recast to a neutral one); a name
 * directive otherwise overrides the template side. Pure-ish (reads the library
 * via `available`). Shared by the plan + run paths so the preview matches output.
 */
function castForTemplate(
  v: ContrarianVariation,
  template: ContrarianTemplate,
  available: AvailableExpression[],
): { exprId: string; placement: "left" | "center" | "right" } {
  let exprId = available.some((e) => e.id === v.expressionId) ? v.expressionId : available[0].id;
  let directive = placementFromLabel(available.find((e) => e.id === exprId)?.label ?? "");
  if (template.charPlacement === "center" && directive) {
    const neutral = available.find((e) => placementFromLabel(e.label) === null);
    if (neutral) {
      exprId = neutral.id;
      directive = null;
    }
  }
  return { exprId, placement: directive ?? template.charPlacement };
}

/** One proposed contrarian variation for the REVIEW step (editable in the UI). */
export interface PlannedContrarian {
  templateId: string;
  templateLabel: string;
  text: string;
  emphasis: string;
  expressionId: string;
  expressionLabel: string;
  /** Headline size multiplier (UI slider; 1 = fit the box). */
  textScale: number;
  /** Headline vertical nudge (UI slider; fraction of frame height; 0 = centred). */
  textOffsetY: number;
}

/**
 * PLAN (don't render) the 3 contrarian variations so the user can review/edit the
 * copy before generating. Grounded in the titles + script context. Returns []
 * when no character expression is uploaded. Best-effort writer (injectable).
 */
export async function planContrarianVariations(
  input: { keyword: string; titles?: string[]; context?: string },
  write: WriteVariationsFn = defaultWriteVariations,
): Promise<PlannedContrarian[]> {
  const available = availableExpressionOptions();
  if (available.length === 0) return [];
  const variations = await write(input.keyword, CONTRARIAN_COUNT, available, {
    titles: input.titles,
    context: input.context,
  });
  return variations.map((v, i) => {
    const template = templateForIndex(i);
    const { exprId } = castForTemplate(v, template, available);
    return {
      templateId: template.id,
      templateLabel: template.label,
      text: v.text,
      emphasis: v.emphasis,
      expressionId: exprId,
      expressionLabel: available.find((e) => e.id === exprId)?.label ?? exprId,
      textScale: v.textScale ?? 1,
      textOffsetY: v.textOffsetY ?? 0,
    };
  });
}

export function startContrarianJob(
  input: {
    keyword: string;
    mode?: GenerationMode;
    provider?: ImageProvider;
    titles?: string[];
    context?: string;
    /** Approved/edited copy from the review step — when present the writer is skipped. */
    variations?: ContrarianVariation[];
  },
  recreateDeps?: RecreateDeps,
  writeVariations: WriteVariationsFn = defaultWriteVariations,
): ThumbnailJob {
  const available = availableExpressionOptions();
  const runs = providersForMode(input.mode ?? input.provider ?? DEFAULT_GENERATION_MODE);
  // Seed 3 queued variants (no source thumbnail — these are originals). The
  // per-variation expression is filled once the copy is resolved.
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
  input: {
    keyword: string;
    mode?: GenerationMode;
    provider?: ImageProvider;
    titles?: string[];
    context?: string;
    variations?: ContrarianVariation[];
  },
  available: AvailableExpression[],
  recreateDeps?: RecreateDeps,
  writeVariations: WriteVariationsFn = defaultWriteVariations,
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

    // Use the APPROVED copy from the review step when provided; else art-direct it.
    const approved = (input.variations ?? []).filter((v) => v && v.text);
    const variations =
      approved.length >= job.variants.length
        ? padContrarianVariations(approved, job.variants.length, available.map((e) => e.id))
        : await writeVariations(input.keyword, job.variants.length, available, {
            titles: input.titles,
            context: input.context,
          });
    const chosenBgIds = chooseContrarianBackgrounds(bgCandidates.map((c) => c.id), job.variants.length);

    for (let i = 0; i < job.variants.length; i++) {
      if (jobCancelled(job)) break; // stop once cancelled
      const v = variations[i];
      const template = templateForIndex(i);
      // Each template pins a NAMED background (e.g. "Black"); fall back to the
      // cycled choice when that name isn't in the uploaded library.
      const bgId = resolveTemplateBackground(template.backgroundName, bgCandidates, chosenBgIds[i]);
      const bg = bgCandidates.find((c) => c.id === bgId) ?? bgCandidates[0];
      const { exprId, placement } = castForTemplate(v, template, available);
      const characterBytes = readCharacterImage(exprId);
      job.variants[i].expression = exprId;
      updateVariant(job, i, { status: "running", stepLabel: "Composing original", percent: phasePercent("swap", 0) });
      try {
        if (!characterBytes) throw new Error(`Character image for "${exprId}" is missing.`);
        const result = await composeContrarianThumbnail(
          {
            backgroundBytes: bg.bytes,
            backgroundMime: bg.mime,
            characterBytes,
            instruction: buildContrarianComposePrompt(placement, template.textArea),
            // Programmatic composite: which side + leave the headline strip clear
            // (top-strike has text up top → drop the head lower).
            placement,
            headTopFrac: template.id === "top-strike" ? 0.2 : 0.05,
            frameW: 1920,
            frameH: 1080,
            overlay: { template, text: v.text, emphasis: v.emphasis, sizeScale: v.textScale, offsetY: v.textOffsetY },
            provider: run?.provider ?? DEFAULT_IMAGE_PROVIDER,
            imageSize: run?.imageSize,
            onProgress: ({ stepLabel, percent }) =>
              updateResult(job, i, run?.provider ?? DEFAULT_IMAGE_PROVIDER, { status: "running", stepLabel, percent }),
          },
          recreateDeps,
        );
        const prov = run?.provider ?? DEFAULT_IMAGE_PROVIDER;
        finishResult(job, i, prov, { outputUrl: result.outputUrl });
        // Carry the re-render info so the UI can live-adjust the headline AND the
        // character (move/zoom/replace) by re-compositing from the ids + placement.
        if (result.overlay)
          attachResultOverlay(job, i, prov, {
            ...result.overlay,
            backgroundId: bg.id,
            expressionId: exprId,
            placement,
            charOffsetX: 0,
            charOffsetY: 0,
            charZoom: 1,
          });
      } catch (e) {
        finishResult(job, i, run?.provider ?? DEFAULT_IMAGE_PROVIDER, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    completeJob(job);
  } catch (e) {
    completeJob(job, e instanceof Error ? e.message : String(e));
  }
}
