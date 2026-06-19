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
  buildTextRewriteInstruction,
  type ArtDirectorStep,
  type SwapAssessment,
  type TextRewrite,
} from "./artDirector.js";
import { upscaleToThumbnail, realesrganEnabled, type UpscaleDeps } from "./upscale.js";
import { compositeContrarian, probeCompositeAvailable, type Placement } from "./composite.js";
import type { Expression } from "./characters.js";
import type { VideoType } from "./videoType.js";
import type { ContrarianTemplate } from "./textOverlay.js";
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
/**
 * Background SWAP prompt (used INSTEAD of STEP8 when the art-director chose an
 * uploaded background). Inputs [current, backgroundImage]: replace the backdrop
 * with the SECOND image, keeping every foreground element exactly in place.
 */
export const BG_REPLACE_PROMPT =
  "Replace the entire BACKGROUND behind the subject with the background shown in the SECOND image — use it as the new backdrop, scaled to fill the whole frame. Keep the subject (the person), ALL text, logos, badges and every foreground element in their EXACT same positions and sizes; ONLY the backdrop changes. Blend it naturally and make sure the subject still pops cleanly off the new background.";

export const STEP8_PROMPT =
  "give the existing background a BOLD, clearly visible POP so the thumbnail obviously stands out MORE than the original: make its colors noticeably richer and more vibrant/saturated, and strongly boost the contrast and separation behind the subject so the subject reads as crisply popped off the background. The change must be easy to see at a glance. Keep it the SAME general style and scene as the original — this is a strong enhancement, NOT a redesign: do NOT add dramatic light rays, neon, new patterns, or wildly different colors. Keep the character, all text, logos, and the exact position of every element exactly the same";

/**
 * Build the ONE-SHOT recreation instruction. Used for ELEMENT-HEAVY (busy)
 * thumbnails AND for fully-REVIEWED plans, because a single coherent edit
 * preserves layout far better than many sequential re-renders (each re-render
 * drifts). It can: swap the character (same identity + body clause as the strong
 * swap) OR skip the swap entirely when the source has no person to replace
 * (`swap:false` — e.g. an icon/text thumbnail), change the outfit, apply the text
 * changes, apply explicit element changes, and pop/replace the background — all
 * while keeping every original element in place. Pure + exported.
 */
export function buildConsolidatedInstruction(opts: {
  keyword: string;
  /** Replace the on-camera person with the character ref. Default true. */
  swap?: boolean;
  textChanges: string[];
  /** Explicit reviewed element edits (device/font/logo/custom instructions). */
  elementChanges?: string[];
  /** When true a background image is supplied as the LAST input image. */
  hasBackground?: boolean;
}): string {
  const swap = opts.swap !== false;
  // The character ref is the SECOND image only when we swap; the background image
  // is then the THIRD (with swap) or the SECOND (without).
  const bgOrdinal = swap ? "THIRD" : "SECOND";
  const parts: string[] = [];
  let n = 1;
  if (swap) {
    parts.push(
      `(${n++}) Replace the on-camera person with the man in the SECOND image — the result MUST have the exact face, ` +
        "head, hairstyle, hair colour and beard of the man in the SECOND image (clearly THAT man, not the original " +
        "person); give him a medium build with a slightly fit, average physique that matches his face, a seamless neck " +
        "join, matching skin tone and realistic head-to-body proportions, reading as ONE real man, NOT a head pasted " +
        "onto a mismatched or oversized body; frame him as a LARGE close-up so his head and face fill AT LEAST 70% of " +
        "the thumbnail's HEIGHT (a big, bold, dominant face), keeping him on the same side of the frame as in the FIRST image.",
    );
    parts.push(`(${n++}) Change that person's outfit to a plain t-shirt.`);
  }
  if (opts.textChanges.length) parts.push(`(${n++}) Apply these EXACT text changes: ${opts.textChanges.join("; ")}.`);
  if (opts.elementChanges?.length) parts.push(`(${n++}) Make these specific changes: ${opts.elementChanges.join("; ")}.`);
  parts.push(
    opts.hasBackground
      ? `(${n++}) Replace the background with the one shown in the ${bgOrdinal} image — use it as the new backdrop, scaled ` +
          "to fill the frame, keeping every foreground element (person, text, logos, props) in its exact place; make sure " +
          "the subject still pops cleanly off it."
      : `(${n++}) Give the background a bold, clearly visible POP — make its colours richer and more vibrant/saturated and ` +
          "boost the contrast behind the subject so it stands out more than the original — WITHOUT changing the scene, " +
          "layout or any element's position (an enhancement, NOT a redesign: no new light rays, neon or patterns).",
  );
  const subjectLine = swap
    ? "every prop (stacks of money/cash, devices, laptops, phones), every UI panel, badge, logo and graphic"
    : "EVERY element — the person/subject, every icon, logo, badge, device, panel and graphic";
  return (
    "Recreate this thumbnail in a SINGLE edit, keeping ALL of the FIRST image's elements and exact layout " +
    `faithfully — ${subjectLine} must stay in the same place and size and look REALISTIC and sharp. Do NOT distort, ` +
    "warp, melt, smear or candy-ify the money, screens, text or any object, and do NOT move or resize anything. " +
    (swap ? "" : "There is NO person to replace — keep the subject and layout exactly as they are. ") +
    "In this ONE pass make ONLY these changes: " +
    parts.join(" ") +
    " Everything else stays exactly as in the FIRST image."
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
 * A placement directive (parsed from the character's name) that forces the
 * subject to one side of the frame, overriding "keep the original framing". Empty
 * string when there's no directive. Pure + exported.
 */
export function placementClause(placement?: "left" | "right" | null): string {
  if (placement !== "left" && placement !== "right") return "";
  const side = placement.toUpperCase();
  const other = placement === "left" ? "RIGHT" : "LEFT";
  return (
    ` IMPORTANT placement: regardless of the original framing, position the man ALL THE WAY to the ${side} side of ` +
    `the frame so he occupies the ${side} portion, leaving the ${other} side open for the background and text.`
  );
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
  /**
   * Optional chosen background image (the art-director's background-director
   * picked it for THIS source). When present, the chain SWAPS the background to
   * this image instead of just popping the existing one; when absent the existing
   * background is enhanced in place (STEP8_PROMPT).
   */
  backgroundBytes?: Buffer;
  backgroundMime?: string;
  /**
   * Optional forced side for the swapped-in character, parsed from the chosen
   * expression's name (e.g. a name containing "place on the right"). When set,
   * the swap/one-shot prompt positions him all the way to that side.
   */
  characterPlacement?: "left" | "right" | null;
  /**
   * Optional REVIEWED text rewrites (from the plan/review step). When provided,
   * these REPLACE the art-director's own text-rewrite decisions: the director
   * still runs for the structured edits (device/font/logo), but its text-rewrites
   * are dropped in favour of this exact, user-approved list. An empty array means
   * "the user approved NO text changes" (the director's text-rewrites are still
   * dropped); omit the field entirely to keep the director's automatic behaviour.
   */
  textRewrites?: TextRewrite[];
  /**
   * Optional REVIEWED non-text edits (device-screen / font / logo / custom) from
   * the plan step — already template-filled instructions. When provided ALONGSIDE
   * textRewrites (i.e. a full reviewed plan), the in-chain art-director is SKIPPED
   * entirely and exactly these edits + textRewrites are applied. When provided
   * without textRewrites, they replace only the director's non-text steps.
   */
  plannedElements?: { id: string; label: string; instruction: string }[];
  /**
   * Whether to replace the on-camera person with the character ref. Default true.
   * Set false when the source has NO person to swap (e.g. an icon/text thumbnail):
   * the chain then skips the swap + outfit and applies only the reviewed edits +
   * background in a single coherent pass, preserving the original layout.
   */
  swapCharacter?: boolean;
  /** Optional live progress sink (phase label + phase-weighted percent). */
  onProgress?: ProgressFn;
}

/** Injectable dependencies — defaulted to the real ones; overridden in tests. */
export interface RecreateDeps {
  editImage?: EditFn;
  artDirect?: ArtDirectFn;
  /** Programmatic contrarian composite (so contrarian job tests can run offline). */
  composite?: typeof compositeContrarian;
  /**
   * Per-variant source analysis (expression + busy) and background choice. Both
   * are consumed by the ORCHESTRATOR (not the chain itself) — they live on this
   * shared deps bag so tests that already inject editImage/artDirect/finalize can
   * override them too. When omitted the orchestrator uses its best-effort vision
   * defaults.
   */
  analyzeSource?: (opts: {
    sourceBytes: Buffer;
    sourceMime: string;
    available: Array<{ id: Expression; label: string }>;
    videoType: VideoType;
    keyword: string;
  }) => Promise<{ expression: Expression; busy: boolean }>;
  /** Pick an uploaded background for the source, or null. */
  chooseBackground?: (opts: {
    sourceBytes: Buffer;
    sourceMime: string;
    candidates: Array<{ id: string; label: string; bytes: Buffer; mime: string }>;
    videoType: VideoType;
    keyword: string;
  }) => Promise<string | null>;
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
  /** Contrarian only: lets the UI re-render the headline at a new size/position live. */
  overlay?: { baseUrl: string; templateId: string; text: string; emphasis: string; textScale: number; textOffsetY: number };
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
  // The art-director-chosen background to swap in (when one fit), else null.
  const backgroundImg: EditImage | null = input.backgroundBytes
    ? { data: input.backgroundBytes, mimeType: input.backgroundMime || "image/png" }
    : null;

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

  // ── ONE-SHOT recreation (avoid multi-render degradation) ─────────────────────
  // We do everything in a SINGLE edit when either:
  //   • the source has NO person to swap (swapCharacter:false, e.g. an icon/text
  //     thumbnail) — re-rendering such a fragile layout several times destroys it, OR
  //   • the source is element-heavy (busy) AND there's no reviewed plan — many
  //     re-renders would melt it, so we collapse the auto recreation to one pass.
  // BUT a REVIEWED plan with a person uses the multi-step chain so EACH approved
  // edit (e.g. "replace the timeline screens") gets its OWN focused render and
  // actually lands — bundling them into one mega-prompt makes the model drop the
  // harder element edits.
  const swap = input.swapCharacter !== false;
  const fullPlan = input.plannedElements != null && input.textRewrites != null;
  if (!swap || (input.busy && !fullPlan)) {
    report(PHASE_LABEL.edits, phasePercent("edits", 0));
    let textChanges: string[] = [];
    let elementChanges: string[] = [];
    if (fullPlan) {
      textChanges = input.textRewrites!.map((r) => buildTextRewriteInstruction(r.old, r.new));
      elementChanges = input.plannedElements!.map((e) => e.instruction).filter(Boolean);
    } else if (input.textRewrites) {
      textChanges = input.textRewrites.map((r) => buildTextRewriteInstruction(r.old, r.new));
    } else {
      try {
        const ds = await artDirect({
          imageBytes: input.sourceBytes,
          imageMime: current.mimeType,
          keyword: input.keyword,
          videoType: input.videoType,
        });
        textChanges = ds.filter((s) => s.id === "text-rewrite" && s.apply && s.instruction).map((s) => s.instruction);
      } catch (e) {
        steps.push({
          id: "art-director",
          label: "Art director",
          instruction: "(decide text changes)",
          applied: false,
          note: `art-director skipped: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    report(PHASE_LABEL.swap, phasePercent("swap", 0));
    const consolidated =
      buildConsolidatedInstruction({
        keyword: input.keyword,
        swap,
        textChanges,
        elementChanges,
        hasBackground: !!backgroundImg,
      }) + (swap ? placementClause(input.characterPlacement) : "");
    // One render. With a swap the character ref is the SECOND image (+ background
    // THIRD); without a swap there's no character (background is SECOND).
    const oneShotImages = swap
      ? backgroundImg
        ? [current, character, backgroundImg]
        : [current, character]
      : backgroundImg
        ? [current, backgroundImg]
        : [current];
    await runStep("recreate-oneshot", swap ? "Recreate in one pass" : "Apply edits (no character)", consolidated, oneShotImages);
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

  // ── Step 2 (VISION or REVIEWED PLAN): decide the optional edits ──────────────
  // The director analyses `current` (the original person now in a t-shirt). Its
  // text/logo/device decisions are identity-independent, so it's fine that the
  // swap hasn't happened yet. BUT when a full reviewed plan was supplied (both the
  // non-text elements AND the text rewrites), we SKIP the art-director entirely and
  // use exactly what the user approved.
  report(PHASE_LABEL.edits, phasePercent("edits", 0));
  const elementsToStep = (els: { id: string; label: string; instruction: string }[]): ArtDirectorStep[] =>
    els
      .filter((e) => e.instruction)
      .map((e) => ({ id: e.id as ArtDirectorStep["id"], label: e.label, apply: true, instruction: e.instruction }));
  const textToSteps = (rewrites: TextRewrite[]): ArtDirectorStep[] =>
    rewrites.map((r) => ({
      id: "text-rewrite" as const,
      label: "Rewrite text",
      apply: true,
      instruction: buildTextRewriteInstruction(r.old, r.new),
    }));

  let directorSteps: ArtDirectorStep[] = [];
  if (fullPlan) {
    // Fully reviewed: exactly the approved non-text edits + text rewrites.
    directorSteps = [...elementsToStep(input.plannedElements!), ...textToSteps(input.textRewrites!)];
  } else {
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
    // Partial review: replace just the text-rewrites (keep the director's elements)…
    if (input.textRewrites) {
      directorSteps = [...directorSteps.filter((s) => s.id !== "text-rewrite"), ...textToSteps(input.textRewrites)];
    }
    // …or replace just the non-text elements (keep the director's text-rewrites).
    if (input.plannedElements) {
      directorSteps = [...directorSteps.filter((s) => s.id === "text-rewrite"), ...elementsToStep(input.plannedElements)];
    }
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
  // Background (ALWAYS): either SWAP in the chosen uploaded background (when the
  // background-director picked one) or POP the existing one. Both keep every
  // foreground element in place.
  if (backgroundImg) {
    await runStep("background", "Replace background", BG_REPLACE_PROMPT, [current, backgroundImg]);
  } else {
    await runStep("background", "Change background", STEP8_PROMPT, [current]);
  }
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
  let swapInstruction = FINAL_SWAP_PROMPT + placementClause(input.characterPlacement);
  try {
    const assessment = await analyzeForSwap({
      imageBytes: current.data,
      imageMime: current.mimeType || "image/png",
    });
    swapInstruction = buildFinalSwapInstruction(assessment) + placementClause(input.characterPlacement);
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
 * Compose a CONTRARIAN ORIGINAL thumbnail (the second workflow): a single render
 * from [background, character] using the supplied composition instruction, then
 * the same finalize/crop as the recreation chain. Element-light (background +
 * person + short text), so one pass is ideal — no multi-render degradation.
 * Resilient + injectable for tests.
 */
export async function composeContrarianThumbnail(
  input: {
    backgroundBytes: Buffer;
    backgroundMime: string;
    characterBytes: Buffer;
    /** The text-free compose instruction — only used by the AI FALLBACK path. */
    instruction: string;
    /** Which side the character sits on (drives the programmatic placement). */
    placement?: Placement;
    /** Head-top inset (frame-height fraction) so the headline strip stays clear. */
    headTopFrac?: number;
    /** User character nudges (UI sliders): fractions of frame W/H + zoom multiplier. */
    charOffsetX?: number;
    charOffsetY?: number;
    charZoom?: number;
    /** When set, the headline is drawn programmatically onto the finalized image. */
    overlay?: { template: ContrarianTemplate; text: string; emphasis: string; sizeScale?: number; offsetY?: number };
    provider?: ImageProvider;
    imageSize?: string;
    onProgress?: ProgressFn;
  },
  deps: {
    /** Injectable programmatic composite (defaults to the real canvas one). */
    composite?: typeof compositeContrarian;
    finalize?: (current: EditImage, steps: ChainStep[]) => Promise<RecreateResult>;
    upscale?: UpscaleDeps;
  } = {},
): Promise<RecreateResult> {
  const composite = deps.composite ?? compositeContrarian;
  const finalizeFn = deps.finalize ?? ((current, steps) => finalize(current, steps, deps.upscale));
  const report = (stepLabel: string, percent: number) => {
    try {
      input.onProgress?.({ stepLabel, percent });
    } catch {
      /* best-effort */
    }
  };

  const steps: ChainStep[] = [];
  // Carry the composed image forward (overwritten by the programmatic composite below).
  let current: EditImage = { data: input.backgroundBytes, mimeType: input.backgroundMime || "image/png" };

  report(PHASE_LABEL.swap, phasePercent("swap", 0));
  // Composite the EXACT character pixels (cut out, head ≥70% of height) onto the
  // background with code — NO image model ever touches a contrarian thumbnail, so
  // the character can't be warped, regenerated or cut. There is NO Nano Banana
  // fallback: if the programmatic composite can't run (canvas / background-removal
  // unavailable), we THROW with the precise reason rather than emit a warped AI
  // image — the caller surfaces it as a clear per-variant error.
  let composited: Buffer | null = null;
  try {
    composited = await composite({
      backgroundBytes: input.backgroundBytes,
      characterBytes: input.characterBytes,
      placement: input.placement ?? "center",
      headTopFrac: input.headTopFrac,
      charOffsetX: input.charOffsetX,
      charOffsetY: input.charOffsetY,
      charZoom: input.charZoom,
    });
  } catch (e) {
    throw new Error(`1:1 character composite failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!composited) {
    const probe = await probeCompositeAvailable();
    throw new Error(
      `The 1:1 character composite isn't available, so this thumbnail was NOT generated (no AI is used for the character). ${probe.reason || "canvas / background-removal could not load"}. Rebuild the image to enable it.`,
    );
  }
  current = { data: composited, mimeType: "image/png" };
  steps.push({
    id: "compose",
    label: "Compose original (1:1)",
    instruction: `programmatic composite — exact character, head ≥70% height, ${input.placement ?? "center"}`,
    applied: true,
  });
  report(PHASE_LABEL.swap, phasePercent("swap", 1));

  report(PHASE_LABEL.finalize, phasePercent("finalize", 0));
  const result = await finalizeFn(current, steps);

  // Programmatic headline overlay onto the finalized 16:9 image. BEST-EFFORT:
  // any failure (no canvas/font, unreadable file) leaves the image as-is. We also
  // SAVE the pre-text base so the UI can re-render the headline at a new size live.
  if (input.overlay) {
    try {
      const { renderContrarianText } = await import("./textOverlay.js");
      const baseBytes = fs.readFileSync(result.file);
      // Persist the base (no-text) image as a sibling file: <name>.jpg → <name>.base.jpg.
      const baseFile = result.file.replace(/\.jpg$/i, ".base.jpg");
      try {
        fs.copyFileSync(result.file, baseFile);
        const baseUrl = result.outputUrl.replace(/\.jpg$/i, ".base.jpg");
        result.overlay = {
          baseUrl,
          templateId: input.overlay.template.id,
          text: input.overlay.text,
          emphasis: input.overlay.emphasis,
          textScale: input.overlay.sizeScale ?? 1,
          textOffsetY: input.overlay.offsetY ?? 0,
        };
      } catch {
        /* base copy is best-effort — the live slider just won't be available */
      }
      const withText = await renderContrarianText(
        baseBytes,
        input.overlay.template,
        input.overlay.text,
        input.overlay.emphasis,
        input.overlay.sizeScale ?? 1,
        input.overlay.offsetY ?? 0,
      );
      if (withText && withText.length > 0 && withText !== baseBytes) {
        fs.writeFileSync(result.file, withText);
      }
      steps.push({
        id: "text-overlay",
        label: "Add headline",
        instruction: `${input.overlay.template.id}: "${input.overlay.text}"`,
        applied: true,
      });
    } catch (e) {
      steps.push({
        id: "text-overlay",
        label: "Add headline",
        instruction: `${input.overlay.template.id}: "${input.overlay.text}"`,
        applied: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  }

  report(PHASE_LABEL.finalize, phasePercent("finalize", 1));
  return result;
}

/**
 * RE-RENDER a contrarian headline onto its saved base image at a new size — the
 * UI's live "text size" slider. Reads the pre-text base (saved during compose),
 * draws the headline at `textScale`, and writes a NEW output (the base is reused,
 * so this is cheap: no model, no compositing). Returns the new served URL.
 */
export async function restyleContrarianText(input: {
  baseUrl: string;
  templateId: string;
  text: string;
  emphasis: string;
  textScale: number;
  textOffsetY?: number;
}): Promise<{ outputUrl: string }> {
  const dir = thumbnailsDir();
  const base = path.basename(input.baseUrl); // strip any path → a name within dir
  if (!/\.jpg$/i.test(base)) throw new Error("invalid base image");
  const bytes = fs.readFileSync(path.join(dir, base));
  const { renderContrarianText, CONTRARIAN_TEMPLATES } = await import("./textOverlay.js");
  const template = CONTRARIAN_TEMPLATES.find((t) => t.id === input.templateId) ?? CONTRARIAN_TEMPLATES[0];
  const scale = Math.min(2, Math.max(0.4, input.textScale || 1));
  const offsetY = Math.min(0.45, Math.max(-0.45, input.textOffsetY || 0));
  const withText = await renderContrarianText(bytes, template, input.text, input.emphasis, scale, offsetY);
  const name = `${crypto.randomBytes(12).toString("hex")}.jpg`;
  fs.writeFileSync(path.join(dir, name), withText);
  return { outputUrl: `/api/outputs/thumbnails/${name}` };
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
