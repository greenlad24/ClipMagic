/**
 * The 6-step thumbnail recreation chain.
 *
 * Given ONE source thumbnail + a chosen character reference, we run a sequence
 * of Nano Banana edits, each fed the previous step's result image:
 *   1. ALWAYS  — replace the character with the one in the second image.
 *   2. ALWAYS  — change the outfit to one derived from the topic/type.
 *   3..6 COND. — font swap, bold text, logo swap, device-screen content. These
 *                are driven by an AI "art-director" pass (Claude vision) that
 *                LOOKS at the source thumbnail and decides which apply + writes
 *                the exact instruction string for each. Only the chosen steps run.
 *
 * Every step is resilient: if a step fails (safety block, network, no image),
 * we keep the last good image and continue — one bad step never aborts the
 * thumbnail. The whole chain is capped at MAX_STEPS.
 *
 * Finally we crop + upscale the result to a clean 16:9 1920×1080 (no black bars)
 * via ffmpeg (crop.ts builds the pure arg string).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { runFfmpeg, probe } from "../render/ffmpeg.js";
import { editImage as defaultEditImage, thumbnailsDir, type EditImage, type EditResult } from "./nanoBanana.js";
import { buildCropScaleArgs, TARGET_W, TARGET_H } from "./crop.js";
import { artDirect as defaultArtDirect, type ArtDirectorStep } from "./artDirector.js";
import type { Expression } from "./characters.js";
import type { VideoType } from "./videoType.js";
import { phasePercent, PHASE_LABEL } from "./jobs.js";

/** Hard cap on chain length (2 mandatory + up to 4 optional). */
export const MAX_STEPS = 6;

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
  sourceBytes: Buffer;
  sourceMime: string;
  keyword: string;
  videoType: VideoType;
}) => Promise<ArtDirectorStep[]>;

/** One recorded step in the chain (for the UI's per-variant breakdown). */
export interface ChainStep {
  /** Short id: "replace-character" | "outfit" | "font" | "bold-text" | "logo" | "device-screen". */
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
  /** Bytes of the downloaded source thumbnail. */
  sourceBytes: Buffer;
  sourceMime: string;
  /** Bytes of the chosen character reference (an expression PNG). */
  characterBytes: Buffer;
  /** The keyword / topic the video is about (drives the outfit + art-director). */
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
  /** Crop+upscale finalizer. Defaults to the real ffmpeg pass. */
  finalize?: (current: EditImage, steps: ChainStep[]) => Promise<RecreateResult>;
}

export interface RecreateResult {
  /** Final 1920×1080 thumbnail. */
  outputUrl: string;
  file: string;
  steps: ChainStep[];
}

/** Derive a sensible, brand-safe outfit from the topic + video type. */
export function deriveOutfit(keyword: string, videoType: VideoType): string {
  const topic = keyword.toLowerCase();
  if (/(finance|money|invest|stock|crypto|business|startup)/.test(topic)) return "sharp business casual blazer";
  if (/(fitness|gym|workout|run|sport)/.test(topic)) return "clean athletic top";
  if (/(cook|recipe|food|kitchen|bak)/.test(topic)) return "casual apron over a plain shirt";
  if (/(game|gaming|stream|esports)/.test(topic)) return "modern hoodie with a subtle graphic";
  if (/(tech|ai|code|software|gadget|phone|computer)/.test(topic)) return "modern minimalist tech-creator hoodie";
  if (videoType === "Review") return "neat smart-casual shirt";
  if (videoType === "Tutorial") return "approachable casual shirt";
  return "stylish casual outfit";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the chain. Returns the final 1920×1080 image + a record of every step.
 *
 * Progress is reported through `input.onProgress` using the phase-weighted model
 * in jobs.ts (fetch is owned by the orchestrator; the chain owns replace
 * character → outfit → optional edits → finalize). The optional-edits band is
 * spread across however many edits the art-director actually returns, so the bar
 * stays smooth whether 0 or 4 optional steps run.
 *
 * `deps` lets tests inject the edit / art-director / finalize primitives so the
 * chain runs with NO network, AI, or ffmpeg.
 */
export async function recreateThumbnail(input: RecreateInput, deps: RecreateDeps = {}): Promise<RecreateResult> {
  const editImage = deps.editImage ?? defaultEditImage;
  const artDirect = deps.artDirect ?? defaultArtDirect;
  const finalizeFn = deps.finalize ?? finalize;
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

  // Helper that runs ONE edit resiliently: on any failure, keep `current`.
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
    try {
      const res = await editImage({ instruction, images });
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
  await runStep(
    "replace-character",
    "Replace character",
    "Replace the character with the character in the second image. Match the original pose, framing, lighting and composition exactly; keep everything else in the scene identical.",
    [current, character],
  );
  report(PHASE_LABEL.replaceCharacter, phasePercent("replaceCharacter", 1));

  // ── Step 2 (ALWAYS): outfit change ──────────────────────────────────────────
  report(PHASE_LABEL.outfit, phasePercent("outfit", 0));
  const outfit = deriveOutfit(input.keyword, input.videoType);
  await runStep(
    "outfit",
    "Change outfit",
    `Change the character outfit to a ${outfit}. Keep the face, pose, expression and background unchanged.`,
    [current],
  );
  report(PHASE_LABEL.outfit, phasePercent("outfit", 1));

  // ── Steps 3–6 (CONDITIONAL): the art-director decides which apply ───────────
  report(PHASE_LABEL.edits, phasePercent("edits", 0));
  let directorSteps: ArtDirectorStep[] = [];
  try {
    directorSteps = await artDirect({
      sourceBytes: input.sourceBytes,
      sourceMime: input.sourceMime || "image/jpeg",
      keyword: input.keyword,
      videoType: input.videoType,
    });
  } catch (e) {
    // The director is best-effort: if it fails, we simply skip the optional steps.
    steps.push({
      id: "art-director",
      label: "Art director",
      instruction: "(decide optional edits)",
      applied: false,
      note: `art-director skipped: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  // Spread the optional-edits band across the edits that will actually run, so
  // the bar fills smoothly regardless of how many (0..4) the director chose.
  const planned = directorSteps.filter((ds) => ds.apply && ds.instruction);
  let doneEdits = 0;
  for (const ds of planned) {
    await runStep(ds.id, ds.label, ds.instruction, [current]);
    doneEdits++;
    report(PHASE_LABEL.edits, phasePercent("edits", doneEdits / planned.length));
  }
  // No optional edits → consume the whole band so the bar doesn't stall at 65%.
  if (planned.length === 0) report(PHASE_LABEL.edits, phasePercent("edits", 1));

  // ── Crop + upscale to a clean 1920×1080 (no black bars) ─────────────────────
  report(PHASE_LABEL.finalize, phasePercent("finalize", 0));
  const result = await finalizeFn(current, steps);
  report(PHASE_LABEL.finalize, phasePercent("finalize", 1));
  return result;
}

/** Write `current` to disk, probe dims, crop+scale to 1920×1080 via ffmpeg. */
async function finalize(current: EditImage, steps: ChainStep[]): Promise<RecreateResult> {
  const dir = thumbnailsDir();
  const ext = /png/i.test(current.mimeType) ? "png" : /jpe?g/i.test(current.mimeType) ? "jpg" : "png";
  const stageFile = path.join(config.tmpDir, `tn-stage-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  fs.mkdirSync(config.tmpDir, { recursive: true });
  fs.writeFileSync(stageFile, current.data);

  const name = `${crypto.randomBytes(12).toString("hex")}-1080p.png`;
  const outFile = path.join(dir, name);

  try {
    const dims = await probe(stageFile);
    const w = dims.width ?? TARGET_W;
    const h = dims.height ?? TARGET_H;
    const args = buildCropScaleArgs(stageFile, outFile, w, h);
    // Single-frame transcode; total duration is irrelevant for progress here.
    await runFfmpeg(args, 1);
    steps.push({
      id: "crop-upscale",
      label: "Crop + upscale to 1920×1080",
      instruction: args.join(" "),
      applied: true,
    });
  } finally {
    try {
      fs.rmSync(stageFile, { force: true });
    } catch {
      /* best-effort */
    }
  }

  if (!fs.existsSync(outFile)) {
    // ffmpeg produced nothing — fall back to the raw chain image so the user
    // still gets a thumbnail (better than failing the whole item).
    fs.writeFileSync(outFile, current.data);
    steps.push({
      id: "crop-upscale",
      label: "Crop + upscale to 1920×1080",
      instruction: "(ffmpeg unavailable — raw chain image kept)",
      applied: false,
      note: "ffmpeg did not produce an output; kept the un-cropped chain image",
    });
  }

  return { outputUrl: `/api/outputs/thumbnails/${name}`, file: outFile, steps };
}
