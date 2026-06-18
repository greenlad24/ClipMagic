/**
 * The thumbnail recreation chain.
 *
 * Given ONE source thumbnail + a chosen character reference, we run a sequence of
 * Nano Banana edits, each fed the PREVIOUS step's result image. The character swap
 * is the LAST image operation, so the final face can't drift afterwards:
 *   1. ALWAYS — "change the character outfit to a t-shirt" — a PLAIN edit on the
 *               ORIGINAL person (no character ref, no face-lock: there is no Jake
 *               to hold yet, so forcing "be the reference" here would be incoherent).
 *   2. VISION ANALYSIS on the STEP-1 RESULT image (the ORIGINAL person now in a
 *      t-shirt — its text/logo/device decisions are identity-independent): the
 *      art-director decides which optional edits apply and fills their templates.
 *   3. (optional) device-screen / font / bold-text / text-rewrite / logo — all
 *               PLAIN edits on the original person.
 *   4. ALWAYS — give the background a MODERATE, tasteful pop (richer/more vibrant
 *               color + stronger contrast/separation behind the subject), keeping
 *               every other element (person, text, logos, positions) identical —
 *               a PLAIN edit.
 *   4b. VISION (pre-swap) — assess the CURRENT working image's BODY/framing
 *               (identity-independent) so the swap below can RESIZE an oversized
 *               original body to match the new face. Best-effort: on failure the
 *               swap falls back to the static FINAL_SWAP_PROMPT.
 *   5. ALWAYS, LAST — the STRONG FULL SWAP: inputs [current, characterRef],
 *               replace the on-camera person with the reference man (the SECOND
 *               image). Because this is the very last image operation, the face
 *               lands fresh and CANNOT drift — nothing re-renders it afterwards.
 *               Layout, outfit, background, text and logos are preserved.
 *
 * (Previously the swap ran TWICE — an early swap then a weak "fix drift" re-anchor.
 *  That was redundant; the most accurate face comes from a single, STRONG swap as
 *  the last step, so the early swap is removed and the final step is a full
 *  identity replacement, not a nudge.)
 *
 * Every step is resilient: if a step fails (safety block, network, no image), we
 * keep the last good image and continue — one bad step never aborts the
 * thumbnail. The whole chain is capped at MAX_STEPS.
 *
 * Finally: crop the result to a clean 16:9 (no bars) at its NATIVE resolution
 * (a 4K render stays 4K; capped at 4K, floored at 1080p; only small content is
 * upscaled) and deliver a high-quality JPG. Resilient: if probing/cropping fails
 * a thumbnail still finishes (it may just be the raw chain image).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { probe, runFfmpeg } from "../render/ffmpeg.js";
import {
  thumbnailsDir,
  WIDESCREEN_PREAMBLE,
  type EditImage,
  type EditResult,
} from "./nanoBanana.js";
import { editImageWith, DEFAULT_IMAGE_PROVIDER, type ImageProvider } from "./imageProviders.js";
import { buildCropScaleArgs, detectContentRect, outputDims, TARGET_W, TARGET_H } from "./crop.js";
import {
  artDirect as defaultArtDirect,
  analyzeForSwap as defaultAnalyzeForSwap,
  buildLooksOversized,
  type ArtDirectorStep,
  type SwapAssessment,
} from "./artDirector.js";
import { upscaleToThumbnail, realesrganEnabled, type UpscaleDeps } from "./upscale.js";
import type { Expression } from "./characters.js";
import type { VideoType } from "./videoType.js";
import { phasePercent, PHASE_LABEL } from "./jobs.js";

/**
 * Hard cap on chain length: 1 mandatory outfit edit + up to 5 optional
 * (device-screen, font, bold-text, text-rewrite, logo) + 1 background edit +
 * 1 final swap edit = 8, so the always-on final swap never gets capped.
 */
export const MAX_STEPS = 8;

/**
 * The STRONG FULL SWAP prompt, run LAST. Inputs are [current, characterRef]: it
 * replaces the on-camera person with the man in the SECOND image. This is the very
 * last image operation, so the swapped-in face lands fresh and cannot drift.
 * (Same verbatim text that used to drive the early swap — reused here as the final
 * identity replacement, NOT a "fix drift" nudge.) Exported so tests can assert it.
 */
export const STEP1_PROMPT =
  "Take the man shown in the SECOND image and place him into the FIRST image as the on-camera person, REPLACING whoever is currently there. The resulting person MUST have the exact face, head, hairstyle, hair colour and beard of the man in the SECOND image — it must clearly be THAT man, not the original person from the first image. Do NOT keep the original person's face or beard. His BODY must fit his head naturally: give him a medium build with a slightly fit, average physique that matches his face — a seamless neck join, matching skin tone, and realistic head-to-body proportions. The whole person must read as ONE real man (the man in the SECOND image), NOT a head pasted onto a mismatched or oversized body. Frame him as a LARGE close-up: scale and position him so his head and face fill AT LEAST 70% of the thumbnail's HEIGHT — a big, bold, dominant face, NOT a small or distant figure. Keep him on the same side of the frame as in the FIRST image, keep his pose and any held object, and keep all text and logos in their positions; keep the BACKGROUND exactly as it appears in the FIRST image, including its enhanced, vibrant colours and stronger contrast (do NOT flatten, dull, desaturate or recolour the background). Only the person changes — to the man from the second image.";
/**
 * Alias for STEP1_PROMPT, named for its NEW role: the final full identity swap.
 * Same string, exported under both names so call sites and tests read clearly.
 */
export const FINAL_SWAP_PROMPT = STEP1_PROMPT;
export const STEP2_PROMPT = "change the character outfit to a t-shirt";

/**
 * Build the FINAL SWAP instruction, optionally TAILORED by the swap-director's
 * body assessment of the current working image. Pure + exported for testing.
 *
 * The static {@link FINAL_SWAP_PROMPT} already asks for a medium / slightly-fit
 * average body, but when the original on-camera person has an oversized / bulky /
 * mascot-costume build the model tends to KEEP that body and just paste the new
 * face on it. So when the assessment reads as oversized (and a body is actually
 * visible), we swap in an EXPLICIT clause that names the current build and orders
 * the model to replace/resize it — the body must follow the new face, not the
 * reverse. Otherwise (no assessment, body not visible, or already an average
 * build) we return the static prompt unchanged.
 */
export function buildFinalSwapInstruction(assessment?: SwapAssessment | null): string {
  if (!assessment || !assessment.bodyVisible) return FINAL_SWAP_PROMPT;
  const build = assessment.currentBuild.trim();
  if (!build || !buildLooksOversized(build)) return FINAL_SWAP_PROMPT;
  // Identity opening (verbatim from the static prompt) + a tailored body clause +
  // the layout-preservation tail (verbatim). The tailored clause keeps the same
  // anchor phrases the static prompt uses ("medium build", "slightly fit, average
  // physique", "seamless neck", "matching skin tone", "one real man", "NOT a head
  // pasted") so both paths read consistently and assert the same body contract.
  return (
    "Take the man shown in the SECOND image and place him into the FIRST image as the on-camera person, " +
    "REPLACING whoever is currently there. The resulting person MUST have the exact face, head, hairstyle, " +
    "hair colour and beard of the man in the SECOND image — it must clearly be THAT man, not the original " +
    "person from the first image. Do NOT keep the original person's face or beard. " +
    `The current person's body is ${build}; do NOT keep it. Give the new man a natural, medium build with a ` +
    "slightly fit, average physique that matches HIS face — resize the torso and shoulders down to realistic " +
    "average human proportions, with a seamless neck join, matching skin tone, and realistic head-to-body " +
    "proportions, so the whole person reads as ONE real man (the man in the SECOND image), the body following " +
    "the face — NOT a head pasted onto a mismatched or oversized body. " +
    "Frame him as a LARGE close-up: scale and position him so his head and face fill AT LEAST 70% of the " +
    "thumbnail's HEIGHT — a big, bold, dominant face, NOT a small or distant figure. " +
    "Keep him on the same side of the frame as in the FIRST image, keep his pose and any held object, and keep all " +
    "text and logos in their positions; keep the BACKGROUND exactly as it appears in the FIRST image, including its " +
    "enhanced, vibrant colours and stronger contrast (do NOT flatten, dull, desaturate or recolour the background). " +
    "Only the person changes — to the man from the second image."
  );
}
export const STEP8_PROMPT =
  "give the existing background a BOLD, clearly visible POP so the thumbnail obviously stands out MORE than the original: make its colors noticeably richer and more vibrant/saturated, and strongly boost the contrast and separation behind the subject so the subject reads as crisply popped off the background. The change must be easy to see at a glance. Keep it the SAME general style and scene as the original — this is a strong enhancement, NOT a redesign: do NOT add dramatic light rays, neon, new patterns, or wildly different colors. Keep the character, all text, logos, and the exact position of every element exactly the same";

/**
 * Build the ONE-SHOT recreation instruction for ELEMENT-HEAVY (busy) thumbnails.
 * Instead of the multi-step chain (which re-renders a busy frame several times
 * and degrades the money/screens/props), this single edit — run on [source,
 * characterRef] — does everything at once: swap the character (same identity +
 * body clause as the strong swap), change the outfit to a t-shirt, apply the text
 * changes, and pop the background, all while keeping every original element in
 * place and realistic. `textChanges` are the art-director's verbatim text-rewrite
 * instructions (each "change the text X to Y, keeping…"). Pure + exported.
 */
export function buildConsolidatedInstruction(opts: { keyword: string; textChanges: string[] }): string {
  const textBlock = opts.textChanges.length
    ? ` (3) Apply these exact text changes: ${opts.textChanges.join("; ")}.`
    : "";
  return (
    "Recreate this thumbnail in a SINGLE edit, keeping ALL of the FIRST image's elements and exact layout " +
    "faithfully — every prop (stacks of money/cash, devices, laptops, phones), every UI panel, badge, logo and " +
    "graphic must stay in the same place and size and look REALISTIC and sharp. Do NOT distort, warp, melt, smear " +
    "or candy-ify the money, screens, text or any object, and do NOT move or resize anything. In this ONE pass make " +
    "exactly these changes: " +
    "(1) Replace the on-camera person with the man in the SECOND image — the result MUST have the exact face, head, " +
    "hairstyle, hair colour and beard of the man in the SECOND image (clearly THAT man, not the original person); " +
    "give him a medium build with a slightly fit, average physique that matches his face, a seamless neck join, " +
    "matching skin tone and realistic head-to-body proportions, reading as ONE real man, NOT a head pasted onto a " +
    "mismatched or oversized body; frame him as a LARGE close-up so his head and face fill AT LEAST 70% of the " +
    "thumbnail's HEIGHT (a big, bold, dominant face), keeping him on the same side of the frame as in the FIRST image. " +
    "(2) Change that person's outfit to a plain t-shirt." +
    textBlock +
    " (4) Give the background a bold, clearly visible POP — make its colours richer and more vibrant/saturated and " +
    "boost the contrast behind the subject so it stands out more than the original — WITHOUT changing the scene, " +
    "layout or any element's position (an enhancement, NOT a redesign: no new light rays, neon or patterns). " +
    "Everything else stays exactly as in the FIRST image."
  );
}

/**
 * Append the 16:9 widescreen preamble so edits don't reintroduce letterbox bars.
 * Exported so tests can build the EXACT expected instruction string.
 */
export function withWidescreen(instruction: string): string {
  return `${instruction} (${WIDESCREEN_PREAMBLE})`;
}

/**
 * Live progress callback. The orchestrator passes one in so the chain narrates
 * each meaningful step (a phase label + the phase-weighted 0..100 percent) onto
 * the polled job. Best-effort: it must never throw upward or block the chain.
 */
export type ProgressFn = (update: { stepLabel: string; percent: number }) => void;

/** The edit primitive, narrowed so tests can inject a fake (no network). */
export type EditFn = (opts: { instruction: string; images: EditImage[] }) => Promise<EditResult>;
/** The art-director primitive, narrowed so tests can inject a fake (no AI). */
export type ArtDirectFn = (opts: {
  imageBytes: Buffer;
  imageMime: string;
  keyword: string;
  videoType: VideoType;
}) => Promise<ArtDirectorStep[]>;
/** The pre-swap body-assessment primitive, narrowed so tests can inject a fake (no AI). */
export type AnalyzeForSwapFn = (opts: { imageBytes: Buffer; imageMime: string }) => Promise<SwapAssessment>;

/** One recorded step in the chain (for the UI's per-variant breakdown). */
export interface ChainStep {
  /** Short id: "replace-character" | "outfit" | "device-screen" | "font" | "bold-text" | "text-rewrite" | "logo" | "background" | "refine-character" | "crop" | "upscale". */
  id: string;
  /** Human label for the UI. */
  label: string;
  /** The instruction sent to Nano Banana. */
  instruction: string;
  /** Did this step produce a new image? (false = skipped or failed → previous kept) */
  applied: boolean;
  /** Why it didn't apply, when relevant. */
  note?: string;
}

export interface RecreateInput {
  /** Bytes of the downloaded source thumbnail (a TRUE 16:9 image). */
  sourceBytes: Buffer;
  sourceMime: string;
  /** Bytes of the chosen character reference (an expression PNG). */
  characterBytes: Buffer;
  /** The keyword / topic the video is about (drives the art-director). */
  keyword: string;
  videoType: VideoType;
  expression: Expression;
  /**
   * Which image-edit provider drives every step of the chain. Defaults to the
   * sharpest option (Nano Banana Pro). The chain's `editImage` is defaulted to
   * `(opts) => editImageWith(provider, opts)` so ALL steps — including the final
   * full swap — run on the chosen provider.
   */
  provider?: ImageProvider;
  /**
   * Optional per-call resolution hint threaded to gemini-pro
   * (generationConfig.imageConfig.imageSize). Omit to use the provider's default
   * size (gemini-pro 4K). Ignored by gemini-flash.
   */
  imageSize?: string;
  /**
   * When true, the source is ELEMENT-HEAVY (money, devices, many text blocks).
   * Such thumbnails degrade when re-rendered many times, so we recreate them in a
   * SINGLE consolidated pass off the ORIGINAL (swap + outfit + text + background
   * pop all at once) instead of the multi-step chain. Set by the orchestrator's
   * source analysis; defaults to the normal multi-step chain when omitted.
   */
  busy?: boolean;
  /** Optional live progress sink (phase label + phase-weighted percent). */
  onProgress?: ProgressFn;
}

/** Injectable dependencies — defaulted to the real ones; overridden in tests. */
export interface RecreateDeps {
  editImage?: EditFn;
  artDirect?: ArtDirectFn;
  /**
   * Per-variant source analysis (expression + busy). Consumed by the
   * ORCHESTRATOR (not the chain itself) — it lives on this shared deps bag so
   * tests that already inject editImage/artDirect/finalize can override it too.
   * When omitted the orchestrator uses its own best-effort vision default.
   */
  analyzeSource?: (opts: {
    sourceBytes: Buffer;
    sourceMime: string;
    available: Expression[];
    videoType: VideoType;
    keyword: string;
  }) => Promise<{ expression: Expression; busy: boolean }>;
  /** Pre-swap body assessment of the working image. Defaults to the real Claude-vision pass. */
  analyzeForSwap?: AnalyzeForSwapFn;
  /** Crop+upscale finalizer. Defaults to the real ffmpeg + Real-ESRGAN pass. */
  finalize?: (current: EditImage, steps: ChainStep[]) => Promise<RecreateResult>;
  /** Upscaler seam (passed through to the default finalize). No real binary in tests. */
  upscale?: UpscaleDeps;
}

export interface RecreateResult {
  /** Final native-resolution 16:9 thumbnail (JPG; 4K stays 4K, floored at 1080p). */
  outputUrl: string;
  file: string;
  steps: ChainStep[];
}

/**
 * Run the chain. Returns the final native-resolution 16:9 image + a record of
 * every step.
 *
 * Progress is reported through `input.onProgress` using the phase-weighted model
 * in jobs.ts. The optional-edits band (which also carries the always-on
 * background edit) is spread across however many edits actually run, so the bar
 * stays smooth whether 1 or 5 edits run.
 *
 * `deps` lets tests inject the edit / art-director / finalize / upscale
 * primitives so the chain runs with NO network, AI, ffmpeg, or upscaler binary.
 */
export async function recreateThumbnail(input: RecreateInput, deps: RecreateDeps = {}): Promise<RecreateResult> {
  // Default the edit primitive to the chosen provider's router. Tests still inject
  // `deps.editImage` directly (no network); production routes every step through
  // editImageWith(provider, …) so the whole chain uses the picked provider.
  const provider = input.provider ?? DEFAULT_IMAGE_PROVIDER;
  const editImage =
    deps.editImage ??
    ((opts: { instruction: string; images: EditImage[] }) =>
      editImageWith(provider, { ...opts, imageSize: input.imageSize }));
  const artDirect = deps.artDirect ?? defaultArtDirect;
  const analyzeForSwap = deps.analyzeForSwap ?? defaultAnalyzeForSwap;
  const finalizeFn = deps.finalize ?? ((current, steps) => finalize(current, steps, deps.upscale));
  const report = (stepLabel: string, percent: number) => {
    try {
      input.onProgress?.({ stepLabel, percent });
    } catch {
      /* progress is best-effort, never blocks the chain */
    }
  };

  const steps: ChainStep[] = [];

  // The "current best" image we carry forward. Starts as the source thumbnail.
  let current: EditImage = { data: input.sourceBytes, mimeType: input.sourceMime || "image/jpeg" };
  const character: EditImage = { data: input.characterBytes, mimeType: "image/png" };

  // Helper that runs ONE edit resiliently: on any failure, keep `current`. The
  // 16:9 widescreen preamble is appended to every instruction. Every middle edit
  // (outfit, optional, background) is a PLAIN edit on the original person — no
  // character ref, no face-lock; the swap happens once, as the LAST step, so there
  // is nothing to "hold" earlier. The caller passes the exact `images` to send.
  const runStep = async (
    id: string,
    label: string,
    instruction: string,
    images: EditImage[],
  ): Promise<void> => {
    if (steps.filter((s) => s.applied).length + 1 > MAX_STEPS) {
      steps.push({ id, label, instruction, applied: false, note: "step cap reached" });
      return;
    }
    const sent = withWidescreen(instruction);
    try {
      const res = await editImage({ instruction: sent, images });
      current = { data: res.bytes, mimeType: res.mimeType };
      steps.push({ id, label, instruction: sent, applied: true });
    } catch (e) {
      steps.push({
        id,
        label,
        instruction: sent,
        applied: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── BUSY thumbnails: ONE-SHOT recreation (avoid multi-render degradation) ────
  // Element-heavy thumbnails (money, devices, lots of text) fall apart if we
  // re-render them several times. So we do EVERYTHING in a single edit off the
  // ORIGINAL: swap the character, change the outfit, change the text, and pop the
  // background — keeping every element in place. We still ask the art-director
  // (best-effort) for the text rewrites so the copy is freshened + the brand
  // keyword lands; only the text-rewrite instructions are used here.
  if (input.busy) {
    report(PHASE_LABEL.edits, phasePercent("edits", 0));
    let textChanges: string[] = [];
    try {
      const ds = await artDirect({
        imageBytes: input.sourceBytes,
        imageMime: current.mimeType,
        keyword: input.keyword,
        videoType: input.videoType,
      });
      textChanges = ds
        .filter((s) => s.id === "text-rewrite" && s.apply && s.instruction)
        .map((s) => s.instruction);
    } catch (e) {
      steps.push({
        id: "art-director",
        label: "Art director",
        instruction: "(decide text changes)",
        applied: false,
        note: `art-director skipped: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    report(PHASE_LABEL.swap, phasePercent("swap", 0));
    const consolidated = buildConsolidatedInstruction({ keyword: input.keyword, textChanges });
    // One render on [source, characterRef] — minimal degradation for busy frames.
    await runStep("recreate-oneshot", "Recreate in one pass", consolidated, [current, character]);
    report(PHASE_LABEL.swap, phasePercent("swap", 1));
    report(PHASE_LABEL.finalize, phasePercent("finalize", 0));
    const result = await finalizeFn(current, steps);
    report(PHASE_LABEL.finalize, phasePercent("finalize", 1));
    return result;
  }

  // ── Step 1 (ALWAYS): outfit → a t-shirt — a PLAIN edit on the ORIGINAL person ─
  // No swap has happened yet, so this is the original on-camera person; no ref,
  // no face-lock.
  report(PHASE_LABEL.outfit, phasePercent("outfit", 0));
  await runStep("outfit", "Change outfit", STEP2_PROMPT, [current]);
  report(PHASE_LABEL.outfit, phasePercent("outfit", 1));

  // ── Step 2 (VISION): the art-director looks at the OUTFIT RESULT image ───────
  // The director analyses `current` (the original person now in a t-shirt). Its
  // text/logo/device decisions are identity-independent, so it's fine that the
  // swap hasn't happened yet.
  report(PHASE_LABEL.edits, phasePercent("edits", 0));
  let directorSteps: ArtDirectorStep[] = [];
  try {
    directorSteps = await artDirect({
      imageBytes: current.data,
      imageMime: current.mimeType || "image/png",
      keyword: input.keyword,
      videoType: input.videoType,
    });
  } catch (e) {
    // The director is best-effort: if it fails, we skip the optional steps (the
    // always-on background edit below still runs).
    steps.push({
      id: "art-director",
      label: "Art director",
      instruction: "(decide optional edits)",
      applied: false,
      note: `art-director skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // ── Optional edits (CONDITIONAL) + background (ALWAYS) + final swap (ALWAYS) ──
  // The edits band covers the chosen optional edits PLUS the two guaranteed final
  // edits (background, then the full character swap), spread evenly so the bar
  // fills smoothly (always ≥1 optional-or-background edit, then the swap band).
  const planned = directorSteps.filter((ds) => ds.apply && ds.instruction);
  const totalEdits = planned.length + 1; // +1 background (the swap has its own band)
  let doneEdits = 0;
  for (const ds of planned) {
    await runStep(ds.id, ds.label, ds.instruction, [current]);
    doneEdits++;
    report(PHASE_LABEL.edits, phasePercent("edits", doneEdits / totalEdits));
  }
  // Background (ALWAYS): subtle background pop, everything else identical — PLAIN.
  await runStep("background", "Change background", STEP8_PROMPT, [current]);
  doneEdits++;
  report(PHASE_LABEL.edits, phasePercent("edits", doneEdits / totalEdits));

  // ── VISION (pre-swap): assess the CURRENT working image's BODY ───────────────
  // Run on `current` (the original person, post-edits/background) — its build and
  // framing are identity-independent. When the original has an oversized / bulky /
  // mascot-costume body, the swap below gets an EXPLICIT "replace + resize the
  // body" clause so the body follows the new face. Best-effort: any failure falls
  // back to the static FINAL_SWAP_PROMPT (which already carries a medium body
  // clause) — generation must never break.
  report(PHASE_LABEL.swap, phasePercent("swap", 0));
  let swapInstruction = FINAL_SWAP_PROMPT;
  try {
    const assessment = await analyzeForSwap({
      imageBytes: current.data,
      imageMime: current.mimeType || "image/png",
    });
    swapInstruction = buildFinalSwapInstruction(assessment);
  } catch (e) {
    steps.push({
      id: "swap-director",
      label: "Assess body for swap",
      instruction: "(assess body/framing before swap)",
      applied: false,
      note: `swap-director skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // ── FINAL step (ALWAYS, genuinely LAST): the STRONG FULL SWAP ────────────────
  // Inputs [current, character]: replace the on-camera person with the reference
  // man (the SECOND image). This is the very last image operation, so the face
  // lands fresh and cannot drift — nothing re-renders it afterwards.
  await runStep("swap-character", "Swap in character", swapInstruction, [current, character]);
  report(PHASE_LABEL.swap, phasePercent("swap", 1));

  // ── Crop to a clean, native-resolution 16:9 JPG (4K stays 4K) ───────────────
  report(PHASE_LABEL.finalize, phasePercent("finalize", 0));
  const result = await finalizeFn(current, steps);
  report(PHASE_LABEL.finalize, phasePercent("finalize", 1));
  return result;
}

/**
 * Finalize: write `current` to disk, probe dims, strip any letterbox/pillarbox
 * bars + centre-crop to a clean, NATIVE-AWARE 16:9 (see crop.outputDims — a 4K
 * render stays 4K, capped at 4K, floored at 1080p) and deliver a high-quality
 * JPG. The crop step IS the final stage in the default path: we do NOT resample a
 * ≥1920 image down to 1080p afterwards.
 *
 * The Real-ESRGAN upscaler stays OPT-IN (THUMBNAIL_UPSCALER=realesrgan) and is
 * only meaningful for the SMALL-source case (content below the 1920 floor that
 * the crop step had to upscale): there we hand the cropped frame to the upscaler
 * with the native target dims so it never downscales a ≥1920 image. Robust to ANY
 * Nano Banana output size — if probing/cropping fails, the raw chain image is
 * kept so a thumbnail always finishes.
 */
async function finalize(current: EditImage, steps: ChainStep[], upscaleDeps?: UpscaleDeps): Promise<RecreateResult> {
  const dir = thumbnailsDir();
  const ext = /png/i.test(current.mimeType) ? "png" : /jpe?g/i.test(current.mimeType) ? "jpg" : "png";
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const stageFile = path.join(config.tmpDir, `tn-stage-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  // Cropped output is the FINAL deliverable: a high-quality JPG at native dims.
  const croppedFile = path.join(config.tmpDir, `tn-crop-${crypto.randomBytes(8).toString("hex")}.jpg`);
  fs.writeFileSync(stageFile, current.data);

  // YouTube caps thumbnails at 2 MB, so a 4K PNG can be too big → deliver a JPG.
  const name = `${crypto.randomBytes(12).toString("hex")}.jpg`;
  const outFile = path.join(dir, name);

  try {
    const dims = await probe(stageFile);
    const w = dims.width ?? TARGET_W;
    const h = dims.height ?? TARGET_H;

    // 1. Detect + strip uniform bars (any size), centre-crop to 16:9, and scale to
    //    the native-aware output dims — this writes the FINAL JPG directly.
    const content = await detectContentRect(stageFile, w, h);
    const out = outputDims(content?.w ?? w, content?.h ?? h);
    const cropArgs = buildCropScaleArgs(stageFile, croppedFile, w, h, content ?? undefined);
    await runFfmpeg(cropArgs, 1);
    const cropOk = fs.existsSync(croppedFile);
    steps.push({
      id: "crop",
      label: "Crop to native 16:9",
      instruction: cropArgs.join(" "),
      applied: cropOk,
      note: [
        content ? `stripped bars: ${content.w}x${content.h}@${content.x},${content.y}` : undefined,
        `output ${out.w}x${out.h} JPG`,
      ]
        .filter(Boolean)
        .join("; "),
    });

    // 2. OPT-IN Real-ESRGAN — only worthwhile when the crop had to UPSCALE small
    //    content (below the 1920 floor). For a ≥1920 native/4K frame the crop is
    //    already the final image, so we skip the upscaler entirely (never resample
    //    a ≥1920 image back down). The target dims are passed so the upscaler's
    //    downsample step lands on the native dims, never the old 1080 force.
    const smallSource = w < TARGET_W;
    if (cropOk && realesrganEnabled() && smallSource) {
      const up = await upscaleToThumbnail(croppedFile, outFile, upscaleDeps, {
        sourceWidth: w,
        targetWidth: out.w,
        targetHeight: out.h,
      });
      steps.push({
        id: "upscale",
        label: "Upscale (small source)",
        instruction:
          up.method === "realesrgan" ? `Real-ESRGAN 4× → ${out.w}×${out.h}` : `ffmpeg lanczos → ${out.w}×${out.h}`,
        applied: fs.existsSync(outFile),
        note: up.note,
      });
    } else if (cropOk) {
      // Default path: the cropped native JPG IS the final file.
      fs.copyFileSync(croppedFile, outFile);
    }
  } finally {
    for (const f of [stageFile, croppedFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  if (!fs.existsSync(outFile)) {
    // Cropping produced nothing — fall back to the raw chain image so the user
    // still gets a thumbnail (better than failing the whole item).
    fs.writeFileSync(outFile, current.data);
    steps.push({
      id: "crop",
      label: "Crop to native 16:9",
      instruction: "(ffmpeg unavailable — raw chain image kept)",
      applied: false,
      note: "no output produced; kept the un-cropped chain image",
    });
  }

  return { outputUrl: `/api/outputs/thumbnails/${name}`, file: outFile, steps };
}
