/**
 * Image-provider router for the Thumbnail Designer's recreation chain.
 *
 * The chain (recreate.ts) edits ONE image at a time: an instruction + a small set
 * of input images (source/current + the character reference) → an edited image.
 * This module exposes a SINGLE primitive — `editImageWith(provider, opts)` — that
 * routes that edit to one of two Gemini back-ends while returning the SAME
 * `EditResult` regardless of provider, so the chain (and its identity-anchoring)
 * is unchanged:
 *
 *   • "gemini-pro"   — Nano Banana Pro (Gemini 3 Pro Image), the DEFAULT and the
 *                      sharpest option: the SAME generateContent request shape as
 *                      the flash client, but on the pro model and asking for 4K
 *                      @ 16:9.
 *   • "gemini-flash" — the current Gemini 2.5 Flash Image (the cheap option).
 *
 * Both paths reuse nanoBanana.ts's pure request builder + image extractor + disk-
 * save helper (we delegate to a shared internal runner so the flash client and
 * this router can't drift).
 *
 * Design (mirrors nanoBanana.ts): the HTTP layer is INJECTABLE so unit tests run
 * with NO network; model ids / endpoints / resolution knobs are isolated behind
 * single constants (env-overridable) so a future rename is a one-line change; the
 * key is read via the server-only getter and NEVER logged.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getGeminiApiKey } from "../settings/postizSecrets.js";
import {
  buildEditRequestBody,
  extractInlineImage,
  thumbnailsDir,
  NANO_BANANA_MODEL,
  NANO_BANANA_ASPECT_RATIO,
  type EditImage,
  type EditResult,
} from "./nanoBanana.js";

/** The selectable image-edit providers (Nano Banana / Gemini back-ends). */
export type ImageProvider = "gemini-pro" | "gemini-flash" | "gemini-flash-31";

/** Default provider when none is chosen: the sharpest / best-likeness option. */
export const DEFAULT_IMAGE_PROVIDER: ImageProvider = "gemini-pro";

/**
 * Coerce arbitrary input to a SELECTABLE provider. Only Nano Banana Pro and
 * Nano Banana 3.1 Flash are offered — the old Gemini 2.5 Flash ("gemini-flash")
 * is never generated from (it maps to the Pro default). Unknown/missing → default.
 */
export function coerceProvider(x: unknown): ImageProvider {
  return x === "gemini-pro" || x === "gemini-flash-31" ? x : DEFAULT_IMAGE_PROVIDER;
}

/**
 * Generation mode. A normal run uses a SINGLE provider: the DEFAULT is
 * "gemini-pro" — Nano Banana Pro at 4K (the sharpest, best-likeness option).
 * "gemini-flash" is the cheaper alternative. The modes equal the ImageProvider
 * ids (there's no longer a dual-generate "compare" mode).
 */
export type GenerationMode = ImageProvider;

/** Default mode: a single Nano Banana Pro run (at 4K). */
export const DEFAULT_GENERATION_MODE: GenerationMode = "gemini-pro";

/** Coerce arbitrary input to a SELECTABLE mode (2.5 flash is never used → default). */
export function coerceMode(x: unknown): GenerationMode {
  return x === "gemini-pro" || x === "gemini-flash-31" ? x : DEFAULT_GENERATION_MODE;
}

// ── Gemini Pro (Nano Banana Pro) constants ───────────────────────────────────
/**
 * Nano Banana Pro image model id. The GA model is `gemini-3-pro-image` (Gemini 3
 * Pro Image). We point at the GA id rather than the old `gemini-3-pro-image-preview`
 * — the preview endpoint degraded (it started returning near-black/blurry frames),
 * while the GA model is the stable, accurate one. Isolated behind a single constant.
 * TODO: if Google renames the pro image model, override via NANO_BANANA_PRO_MODEL
 * (no rebuild) or update this constant.
 */
export const NANO_BANANA_PRO_MODEL = process.env.NANO_BANANA_PRO_MODEL || "gemini-3-pro-image";

/**
 * Newer flash image model (Gemini 3.1 Flash Image) — a selectable alternative.
 * Routed like the 2.5 flash (no imageConfig hint), so it's not exposed to the
 * 4K reference-edit issue. Env-overridable via NANO_BANANA_FLASH_31_MODEL.
 */
export const NANO_BANANA_FLASH_31_MODEL = process.env.NANO_BANANA_FLASH_31_MODEL || "gemini-3.1-flash-image";

/**
 * Requested output resolution for the pro model. DEFAULT IS EMPTY (no imageSize
 * sent): the Gemini 3 Pro Image model mishandled imageConfig.imageSize on
 * reference-edits and returned hazy/draft frames, while the otherwise-identical
 * 3.1 Flash request (no imageSize) rendered correctly. So we omit it and let the
 * model render at its default resolution; crop.ts still outputs a crisp 1920×1080.
 * Env-overridable: set NANO_BANANA_PRO_IMAGE_SIZE=2K (or 1K/4K) to try requesting
 * a size once Google fixes that path.
 */
export const NANO_BANANA_PRO_IMAGE_SIZE = process.env.NANO_BANANA_PRO_IMAGE_SIZE || "";

const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";

// ── Shared helpers ────────────────────────────────────────────────────────────
/** Map a returned mime type to a file extension for the saved file. */
function extForMime(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  return "png";
}

/** Persist edited image bytes under thumbnailsDir and shape the EditResult. */
function saveEdited(data: Buffer, mimeType: string): EditResult {
  const ext = extForMime(mimeType);
  const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const file = path.join(thumbnailsDir(), name);
  fs.writeFileSync(file, data);
  return { file, outputUrl: `/api/outputs/thumbnails/${name}`, bytes: data, mimeType };
}

// ── Gemini (flash + pro) path ─────────────────────────────────────────────────
/** Injectable fetch for the Gemini generateContent JSON call (matches nanoBanana's). */
export type GeminiFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/**
 * Build the Gemini generateContent request body for a PRO edit: the same shape as
 * the flash client (instruction first, then inline_data parts), with the pro
 * model's resolution hint added to `generationConfig.imageConfig`. The resolution
 * defaults to NANO_BANANA_PRO_IMAGE_SIZE (4K) but is overridable per call. Pure +
 * exported so the request shape is unit-testable.
 */
export function buildProEditRequestBody(
  instruction: string,
  images: EditImage[],
  imageSize: string = NANO_BANANA_PRO_IMAGE_SIZE,
): {
  contents: Array<{ parts: Array<Record<string, unknown>> }>;
  generationConfig: { responseModalities: string[]; imageConfig: { aspectRatio: string; imageSize?: string } };
} {
  const base = buildEditRequestBody(instruction, images);
  // ONLY send imageSize when explicitly requested (env). The Gemini 3 Pro Image
  // model mishandles imageConfig.imageSize for reference-edits (it returned hazy/
  // draft frames), while the 3.1 Flash request — identical but WITHOUT imageSize —
  // renders correctly. So by default we omit it; the model renders at its default
  // resolution and crop.ts outputs a crisp 1920×1080.
  const imageConfig: { aspectRatio: string; imageSize?: string } = { aspectRatio: NANO_BANANA_ASPECT_RATIO };
  if (imageSize) imageConfig.imageSize = imageSize;
  return {
    contents: base.contents,
    generationConfig: { responseModalities: ["IMAGE"], imageConfig },
  };
}

/**
 * Run one Gemini edit on the given model. `pro` swaps in the imageConfig; for the
 * pro path `imageSize` overrides the requested long-edge (defaults to 4K).
 */
async function editWithGemini(
  model: string,
  pro: boolean,
  opts: { instruction: string; images: EditImage[]; imageSize?: string },
  fetchImpl?: GeminiFetchFn,
): Promise<EditResult> {
  const key = getGeminiApiKey();
  if (!key) {
    throw new Error("Gemini API key not configured — add GEMINI_API_KEY in Settings → Thumbnail Designer.");
  }
  if (!opts.images.length) throw new Error("Image edit needs at least one input image.");

  const url = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify(
    pro
      ? buildProEditRequestBody(opts.instruction, opts.images, opts.imageSize ?? NANO_BANANA_PRO_IMAGE_SIZE)
      : buildEditRequestBody(opts.instruction, opts.images),
  );

  const doFetch: GeminiFetchFn =
    fetchImpl ??
    (async (u, init) => {
      const r = await fetch(u, init);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    });

  const res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = json?.error?.message || `Gemini API HTTP ${res.status}`;
    // Never include the key (it's only in the URL query, which we don't echo).
    throw new Error(`${pro ? "Nano Banana Pro" : "Nano Banana"} edit failed: ${msg}`);
  }

  const blockReason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
  const image = extractInlineImage(json);
  if (!image) {
    throw new Error(
      `${pro ? "Nano Banana Pro" : "Nano Banana"} returned no image${blockReason ? ` (reason: ${blockReason})` : ""}. The edit was likely blocked or refused.`,
    );
  }
  return saveEdited(image.data, image.mimeType);
}

// ── Router ────────────────────────────────────────────────────────────────────
/** Injectable HTTP for the Gemini back-end (tests supply a mock; no network). */
export interface EditImageDeps {
  geminiFetch?: GeminiFetchFn;
}

/**
 * Route ONE edit to the chosen provider, returning the SAME EditResult shape for
 * both. HTTP is injectable so tests run with no network/keys.
 *
 * The optional `imageSize` is a resolution hint the recreation chain can thread
 * through to the pro model (generationConfig.imageConfig.imageSize, "1K"|"2K"|"4K").
 * Omitting it keeps the pro default (4K); gemini-flash exposes no resolution knob
 * and ignores it.
 */
export function editImageWith(
  provider: ImageProvider,
  opts: { instruction: string; images: EditImage[]; imageSize?: string },
  deps: EditImageDeps = {},
): Promise<EditResult> {
  switch (provider) {
    case "gemini-pro":
      return editWithGemini(NANO_BANANA_PRO_MODEL, true, opts, deps.geminiFetch);
    case "gemini-flash-31":
      return editWithGemini(NANO_BANANA_FLASH_31_MODEL, false, opts, deps.geminiFetch);
    case "gemini-flash":
    default:
      return editWithGemini(NANO_BANANA_MODEL, false, opts, deps.geminiFetch);
  }
}

/** One provider sub-run's config: which provider, at what size, with what label. */
export interface ProviderRun {
  provider: ImageProvider;
  /** Resolution hint threaded to editImageWith (undefined = the provider default). */
  imageSize?: string;
  /** UI column label ("Nano Banana Pro · 4K", "Nano Banana (Flash)"). */
  label: string;
}

/** Human-friendly column label for a provider at a given size. */
function providerLabel(provider: ImageProvider, size?: string): string {
  switch (provider) {
    case "gemini-pro": {
      const s = size ?? NANO_BANANA_PRO_IMAGE_SIZE;
      return s ? `Nano Banana Pro · ${s}` : "Nano Banana Pro";
    }
    case "gemini-flash-31":
      return "Nano Banana 3.1 Flash";
    case "gemini-flash":
      return "Nano Banana (Flash)";
  }
}

/**
 * The provider sub-runs a mode expands to. Each mode is a SINGLE provider, so this
 * is always exactly one sub-run at that provider's DEFAULT size (gemini-pro 4K).
 * Kept as an array — and the runner still loops over it — so the job shape (the
 * per-variant `results` list) is unchanged; it's just always length 1 now.
 */
export function providersForMode(mode: GenerationMode): ProviderRun[] {
  return [{ provider: mode, label: providerLabel(mode) }];
}
