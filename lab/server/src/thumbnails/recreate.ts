/**
 * The thumbnail recreation chain.
 *
 * Given ONE source thumbnail + a chosen character reference, we run a sequence of
 * Nano Banana edits, each fed the PREVIOUS step's result image:
 *   1. ALWAYS — inputs [sourceThumbnail, characterRef]:
 *               "replace the character with the character in the second image"
 *   2. ALWAYS — "change the character outfit to a t-shirt"
 *   3. VISION ANALYSIS on the STEP-2 RESULT image (the current working image, NOT
 *      the source): the art-director (Claude vision) decides which of steps 4–7
 *      apply and fills the bracketed slots of their EXACT templates.
 *   4. (optional) device-screen
 *   5. (optional) font
 *   6. (optional) bold-text
 *   7. (optional) logo
 *   8. ALWAYS — change the background color + pattern, keeping every other
 *               element (character, text, logos, positions) identical.
 *
 * Every step is resilient: if a step fails (safety block, network, no image), we
 * keep the last good image and continue — one bad step never aborts the
 * thumbnail. The whole chain is capped at MAX_STEPS.
 *
 * Finally: crop the result to a clean 16:9 (no bars) → Real-ESRGAN upscale →
 * EXACTLY 1920×1080 (with a clean ffmpeg fallback so a thumbnail always finishes).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { probe, runFfmpeg } from "../render/ffmpeg.js";
import {
  editImage as defaultEditImage,
  thumbnailsDir,
  WIDESCREEN_PREAMBLE,
  type EditImage,
  type EditResult,
} from "./nanoBanana.js";
import { buildCropScaleArgs, detectContentRect, TARGET_W, TARGET_H } from "./crop.js";
import { artDirect as defaultArtDirect, type ArtDirectorStep } from "./artDirector.js";
import { upscaleToThumbnail, type UpscaleDeps } from "./upscale.js";
import type { Expression } from "./characters.js";
import type { VideoType } from "./videoType.js";
import { phasePercent, PHASE_LABEL } from "./jobs.js";

/** Hard cap on chain length (2 mandatory + up to 4 optional + 1 final bg edit). */
export const MAX_STEPS = 7;

/**
 * EXACT verbatim prompts for the always-on edits. Steps 4–7's prompts are built
 * by the art-director from its templates; these three are fixed strings emitted
 * untouched (per the user's spec). Exported so tests can assert them verbatim.
 */
export const STEP1_PROMPT =
  "You are given two images. The FIRST image is a thumbnail scene. The SECOND image is a headshot of a specific person. Replace the person in the first image with the person from the SECOND image: their face, facial features, skin tone, hair colour and style, and beard must be IDENTICAL to the second image — it must be unmistakably the exact same person as the second image, not a similar-looking one. Keep the first image's composition, pose, body, framing, text and everything else exactly the same; change ONLY who the person is to match the second image.";
export const STEP2_PROMPT = "change the character outfit to a t-shirt";
export const STEP8_PROMPT =
  "change the background color and the background pattern to something different, but keep the character, all text, logos, and the exact position of every element the same";

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

/** One recorded step in the chain (for the UI's per-variant breakdown). */
export interface ChainStep {
  /** Short id: "replace-character" | "outfit" | "device-screen" | "font" | "bold-text" | "logo" | "background" | "crop" | "upscale". */
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
  /** Optional live progress sink (phase label + phase-weighted percent). */
  onProgress?: ProgressFn;
}

/** Injectable dependencies — defaulted to the real ones; overridden in tests. */
export interface RecreateDeps {
  editImage?: EditFn;
  artDirect?: ArtDirectFn;
  /** Crop+upscale finalizer. Defaults to the real ffmpeg + Real-ESRGAN pass. */
  finalize?: (current: EditImage, steps: ChainStep[]) => Promise<RecreateResult>;
  /** Upscaler seam (passed through to the default finalize). No real binary in tests. */
  upscale?: UpscaleDeps;
}

export interface RecreateResult {
  /** Final 1920×1080 thumbnail. */
  outputUrl: string;
  file: string;
  steps: ChainStep[];
}

/**
 * Run the chain. Returns the final 1920×1080 image + a record of every step.
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
  const editImage = deps.editImage ?? defaultEditImage;
  const artDirect = deps.artDirect ?? defaultArtDirect;
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
  // 16:9 widescreen preamble is appended to every instruction sent to the model.
  const runStep = async (id: string, label: string, instruction: string, images: EditImage[]): Promise<void> => {
    if (steps.filter((s) => s.applied).length + 1 > MAX_STEPS) {
      steps.push({ id, label, instruction, applied: false, note: "step cap reached" });
      return;
    }
    try {
      const res = await editImage({ instruction: withWidescreen(instruction), images });
      current = { data: res.bytes, mimeType: res.mimeType };
      steps.push({ id, label, instruction, applied: true });
    } catch (e) {
      steps.push({
        id,
        label,
        instruction,
        applied: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── Step 1 (ALWAYS): swap in the user's character ───────────────────────────
  report(PHASE_LABEL.replaceCharacter, phasePercent("replaceCharacter", 0));
  await runStep("replace-character", "Replace character", STEP1_PROMPT, [current, character]);
  report(PHASE_LABEL.replaceCharacter, phasePercent("replaceCharacter", 1));

  // ── Step 2 (ALWAYS): outfit → a t-shirt ─────────────────────────────────────
  report(PHASE_LABEL.outfit, phasePercent("outfit", 0));
  await runStep("outfit", "Change outfit", STEP2_PROMPT, [current]);
  report(PHASE_LABEL.outfit, phasePercent("outfit", 1));

  // ── Step 3 (VISION): the art-director looks at the STEP-2 RESULT image ──────
  // The director analyses `current` (the post-outfit working image), NOT the
  // source thumbnail, so its decisions match what the recreation actually is now.
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

  // ── Steps 4–7 (CONDITIONAL) + Step 8 (ALWAYS, background) ───────────────────
  // The edits band covers the chosen optional edits PLUS the guaranteed final
  // background edit, spread evenly so the bar fills smoothly (always ≥1 edit).
  const planned = directorSteps.filter((ds) => ds.apply && ds.instruction);
  const totalEdits = planned.length + 1; // +1 for the always-on background edit
  let doneEdits = 0;
  for (const ds of planned) {
    await runStep(ds.id, ds.label, ds.instruction, [current]);
    doneEdits++;
    report(PHASE_LABEL.edits, phasePercent("edits", doneEdits / totalEdits));
  }
  // Step 8 (ALWAYS): new background color + pattern, everything else identical.
  await runStep("background", "Change background", STEP8_PROMPT, [current]);
  doneEdits++;
  report(PHASE_LABEL.edits, phasePercent("edits", doneEdits / totalEdits));

  // ── Crop to 16:9 → Real-ESRGAN upscale → exactly 1920×1080 ──────────────────
  report(PHASE_LABEL.finalize, phasePercent("finalize", 0));
  const result = await finalizeFn(current, steps);
  report(PHASE_LABEL.finalize, phasePercent("finalize", 1));
  return result;
}

/**
 * Finalize: write `current` to disk, probe dims, strip any letterbox/pillarbox
 * bars + centre-crop to 16:9 (ffmpeg), then Real-ESRGAN upscale → exactly
 * 1920×1080 (ffmpeg lanczos fallback). Robust to ANY Nano Banana output size.
 */
async function finalize(current: EditImage, steps: ChainStep[], upscaleDeps?: UpscaleDeps): Promise<RecreateResult> {
  const dir = thumbnailsDir();
  const ext = /png/i.test(current.mimeType) ? "png" : /jpe?g/i.test(current.mimeType) ? "jpg" : "png";
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const stageFile = path.join(config.tmpDir, `tn-stage-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  const croppedFile = path.join(config.tmpDir, `tn-crop-${crypto.randomBytes(8).toString("hex")}.png`);
  fs.writeFileSync(stageFile, current.data);

  const name = `${crypto.randomBytes(12).toString("hex")}-1080p.png`;
  const outFile = path.join(dir, name);

  try {
    const dims = await probe(stageFile);
    const w = dims.width ?? TARGET_W;
    const h = dims.height ?? TARGET_H;

    // 1. Detect + strip uniform bars (any size), then centre-crop to 16:9.
    const content = await detectContentRect(stageFile, w, h);
    const cropArgs = buildCropScaleArgs(stageFile, croppedFile, w, h, content ?? undefined);
    await runFfmpeg(cropArgs, 1);
    steps.push({
      id: "crop",
      label: "Crop to 16:9",
      instruction: cropArgs.join(" "),
      applied: fs.existsSync(croppedFile),
      note: content ? `stripped bars: ${content.w}x${content.h}@${content.x},${content.y}` : undefined,
    });

    // 2. Upscale (Real-ESRGAN → exactly 1920×1080, ffmpeg fallback).
    const upscaleInput = fs.existsSync(croppedFile) ? croppedFile : stageFile;
    const up = await upscaleToThumbnail(upscaleInput, outFile, upscaleDeps);
    steps.push({
      id: "upscale",
      label: "Upscaling to 1080p",
      instruction: up.method === "realesrgan" ? "Real-ESRGAN 4× → 1920×1080" : "ffmpeg lanczos → 1920×1080",
      applied: fs.existsSync(outFile),
      note: up.note,
    });
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
    // Both crop + upscale produced nothing — fall back to the raw chain image so
    // the user still gets a thumbnail (better than failing the whole item).
    fs.writeFileSync(outFile, current.data);
    steps.push({
      id: "upscale",
      label: "Upscaling to 1080p",
      instruction: "(ffmpeg unavailable — raw chain image kept)",
      applied: false,
      note: "no output produced; kept the un-cropped chain image",
    });
  }

  return { outputUrl: `/api/outputs/thumbnails/${name}`, file: outFile, steps };
}
