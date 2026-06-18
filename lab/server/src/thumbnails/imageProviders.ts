/**
 * Image-provider router for the Thumbnail Designer's recreation chain.
 *
 * The chain (recreate.ts) edits ONE image at a time: an instruction + a small set
 * of input images (source/current + the character reference) → an edited image.
 * This module exposes a SINGLE primitive — `editImageWith(provider, opts)` — that
 * routes that edit to one of three back-ends while returning the SAME `EditResult`
 * regardless of provider, so the chain (and its identity-anchoring) is unchanged:
 *
 *   • "gemini-pro"   — Nano Banana Pro (Gemini 3 Pro Image), the sharpest option:
 *                      the SAME generateContent request shape as the flash client,
 *                      but on the pro model and asking for 2K @ 16:9.
 *   • "gemini-flash" — the current Gemini 2.5 Flash Image (the cheap option).
 *   • "openai"       — OpenAI gpt-image-1 image EDITS (multipart /v1/images/edits),
 *                      input_fidelity=high to preserve the swapped-in person.
 *
 * Both Gemini paths reuse nanoBanana.ts's pure request builder + image extractor
 * + disk-save helper (we delegate to a shared internal runner so the flash client
 * and this router can't drift). The OpenAI path has its own multipart contract.
 *
 * Design (mirrors nanoBanana.ts): the HTTP layer is INJECTABLE so unit tests run
 * with NO network; model ids / endpoints / resolution + fidelity knobs are
 * isolated behind single constants (env-overridable) so a future rename is a
 * one-line change; the keys are read via the server-only getters and NEVER logged.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getGeminiApiKey, getOpenAiApiKey } from "../settings/postizSecrets.js";
import {
  buildEditRequestBody,
  extractInlineImage,
  thumbnailsDir,
  NANO_BANANA_MODEL,
  NANO_BANANA_ASPECT_RATIO,
  type EditImage,
  type EditResult,
} from "./nanoBanana.js";

/** The three selectable image-edit providers. */
export type ImageProvider = "gemini-pro" | "gemini-flash" | "openai";

/** Default provider when none is chosen: the sharpest / best-likeness option. */
export const DEFAULT_IMAGE_PROVIDER: ImageProvider = "gemini-pro";

/** Coerce arbitrary input to a known provider (defaults when unknown/missing). */
export function coerceProvider(x: unknown): ImageProvider {
  return x === "gemini-pro" || x === "gemini-flash" || x === "openai" ? x : DEFAULT_IMAGE_PROVIDER;
}

/**
 * Generation mode. The DEFAULT is "compare": every pick is generated through BOTH
 * top providers (Nano Banana Pro @ 4K + OpenAI @ its max) and shown side by side
 * so the user picks the better one. The single-provider modes equal the three
 * ImageProvider ids — for when the user doesn't want the comparison/cost.
 */
export type GenerationMode = "compare" | ImageProvider;

/** Default mode: dual-generate (Pro 4K + OpenAI) side by side. */
export const DEFAULT_GENERATION_MODE: GenerationMode = "compare";

/** Coerce arbitrary input to a known mode (defaults to "compare"). */
export function coerceMode(x: unknown): GenerationMode {
  return x === "compare" || x === "gemini-pro" || x === "gemini-flash" || x === "openai"
    ? x
    : DEFAULT_GENERATION_MODE;
}

// ── Gemini Pro (Nano Banana Pro) constants ───────────────────────────────────
/**
 * Nano Banana Pro image model id. Google's preview id for Gemini 3 Pro Image is
 * `gemini-3-pro-image-preview` (verified against ai.google.dev/gemini-api/docs/
 * gemini-3 + the model card, Nov 2025 preview). Isolated behind a single constant.
 * TODO: if Google promotes/renames the pro image model, override via
 * NANO_BANANA_PRO_MODEL (no rebuild) or update this constant.
 */
export const NANO_BANANA_PRO_MODEL = process.env.NANO_BANANA_PRO_MODEL || "gemini-3-pro-image-preview";

/**
 * Requested output resolution for the pro model. Gemini 3 Pro Image accepts
 * `generationConfig.imageConfig.imageSize` of "1K" | "2K" | "4K" (long-edge),
 * verified against ai.google.dev/gemini-api/docs/gemini-3. We ask for 2K — the
 * highest PRACTICAL size for a thumbnail (4K is slow + costly and we downscale to
 * 1920×1080 anyway). Isolated behind a constant + env override.
 * TODO: as of the preview, some reports note imageSize can be ignored for
 * reference-image EDITS (discuss.ai.google.dev). It's a soft hint — the crop.ts
 * finalize still guarantees a crisp 1920×1080 — so a 1K return doesn't break us.
 */
export const NANO_BANANA_PRO_IMAGE_SIZE = process.env.NANO_BANANA_PRO_IMAGE_SIZE || "2K";

/**
 * Highest resolution we drive the pro model at — used by the "compare" default,
 * which generates each pick at the BEST quality each provider offers so the user
 * can choose the better one. Gemini 3 Pro Image accepts "1K" | "2K" | "4K"
 * (long-edge, per ai.google.dev/gemini-api/docs/gemini-3). The single-provider
 * gemini-pro path stays at NANO_BANANA_PRO_IMAGE_SIZE (2K, the env default) for
 * cost; compare upgrades to 4K. Per-call overridable (see editImageWith's
 * `imageSize` option); finalize still guarantees a crisp 1920×1080.
 */
export const NANO_BANANA_PRO_IMAGE_SIZE_MAX = process.env.NANO_BANANA_PRO_IMAGE_SIZE_MAX || "4K";

const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";

// ── OpenAI gpt-image-1 (image edits) constants ───────────────────────────────
/**
 * OpenAI image-edit model + endpoint. The edits endpoint is multipart, NOT JSON.
 * Verified against developers.openai.com/api/reference (Create image edit) +
 * the image-generation guide, 2025/2026.
 * TODO: override the model via OPENAI_IMAGE_MODEL if OpenAI renames it.
 */
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
export const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com";
export const OPENAI_EDITS_PATH = "/v1/images/edits";
/**
 * Closest LANDSCAPE size gpt-image-1 supports (1536×1024 ≈ 3:2). We crop to a
 * clean 16:9 in finalize, so this just gets us a wide, high-res base. Supported
 * sizes: 1024x1024 | 1536x1024 | 1024x1536 (+ "auto"). Isolated + env-overridable.
 */
export const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1536x1024";
/**
 * Highest-resolution LANDSCAPE size we ask gpt-image-1 for — used by the
 * "compare" default. For gpt-image-1 the largest landscape option IS 1536×1024:
 * the edits API only accepts 1024x1024 | 1536x1024 | 1024x1536 (+ "auto"),
 * verified against developers.openai.com/api/reference (Create image edit),
 * Jun 2026. So OPENAI_IMAGE_SIZE_MAX == OPENAI_IMAGE_SIZE today; it's isolated
 * behind its own constant so the compare path documents intent ("the highest
 * size this model supports") and a future model bump is a one-line change.
 * TODO: gpt-image-2 / a renamed gpt-image-1.5 supports arbitrary WIDTHxHEIGHT up
 * to 3840×2160 (≈16:9 natively) — when OPENAI_IMAGE_MODEL is bumped to it, set
 * OPENAI_IMAGE_SIZE_MAX to e.g. "1920x1080" (or higher) via the env override.
 */
export const OPENAI_IMAGE_SIZE_MAX = process.env.OPENAI_IMAGE_SIZE_MAX || "1536x1024";
/**
 * input_fidelity=high tells gpt-image-1 to PRESERVE the faces/details of the input
 * images closely — essential so the swapped-in person's likeness survives the
 * edit. Only supported on gpt-image-1 (and later); defaults to "low" otherwise.
 * Verified against the OpenAI images/edits reference.
 */
export const OPENAI_INPUT_FIDELITY = process.env.OPENAI_INPUT_FIDELITY || "high";

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
 * defaults to NANO_BANANA_PRO_IMAGE_SIZE (2K) but is overridable per call (the
 * "compare" default requests NANO_BANANA_PRO_IMAGE_SIZE_MAX = 4K). Pure + exported
 * so the request shape is unit-testable.
 */
export function buildProEditRequestBody(
  instruction: string,
  images: EditImage[],
  imageSize: string = NANO_BANANA_PRO_IMAGE_SIZE,
): {
  contents: Array<{ parts: Array<Record<string, unknown>> }>;
  generationConfig: { imageConfig: { aspectRatio: string; imageSize: string } };
} {
  const base = buildEditRequestBody(instruction, images);
  return {
    contents: base.contents,
    generationConfig: {
      imageConfig: { aspectRatio: NANO_BANANA_ASPECT_RATIO, imageSize },
    },
  };
}

/**
 * Run one Gemini edit on the given model. `pro` swaps in the imageConfig; for the
 * pro path `imageSize` overrides the requested long-edge (defaults to 2K; the
 * compare default passes 4K).
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

// ── OpenAI gpt-image-1 path ───────────────────────────────────────────────────
/**
 * Injectable fetch for the OpenAI multipart edits call. Narrowed to what we use:
 * we pass a FormData body (Node 18+ global) + an Authorization header, and read
 * back JSON. Tests supply a mock that asserts the multipart fields.
 */
export type OpenAiFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/**
 * Build the multipart FormData for a gpt-image-1 edit. EXACT field contract:
 *   model=gpt-image-1, prompt=<instruction>, size=<size>, input_fidelity=high,
 *   n=1, and EACH input image appended under the `image[]` field (the array form
 *   gpt-image-1 accepts for multi-image edits). `size` defaults to OPENAI_IMAGE_SIZE
 *   but is overridable per call (the "compare" default passes OPENAI_IMAGE_SIZE_MAX).
 *   Pure-ish (builds a FormData) + exported so a test can assert the exact fields
 *   without a network call.
 */
export function buildOpenAiEditForm(
  instruction: string,
  images: EditImage[],
  size: string = OPENAI_IMAGE_SIZE,
): FormData {
  const form = new FormData();
  form.append("model", OPENAI_IMAGE_MODEL);
  form.append("prompt", instruction);
  form.append("size", size);
  form.append("input_fidelity", OPENAI_INPUT_FIDELITY);
  form.append("n", "1");
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = extForMime(img.mimeType);
    // A fresh Uint8Array view detaches from Buffer's shared pool so Blob copies the
    // right bytes; the filename only sets the part's content-type-ish hint.
    const blob = new Blob([new Uint8Array(img.data)], { type: img.mimeType || "image/png" });
    form.append("image[]", blob, `image-${i}.${ext}`);
  }
  return form;
}

/** Extract the first base64 image from a gpt-image-1 edits response (data[0].b64_json). */
export function extractOpenAiImage(json: any): { data: Buffer; mimeType: string } | null {
  const b64: unknown = json?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) return null;
  // gpt-image-1 returns PNG bytes by default.
  return { data: Buffer.from(b64, "base64"), mimeType: "image/png" };
}

async function editWithOpenAi(
  opts: { instruction: string; images: EditImage[]; size?: string },
  fetchImpl?: OpenAiFetchFn,
): Promise<EditResult> {
  const key = getOpenAiApiKey();
  if (!key) {
    throw new Error("OpenAI API key not configured — add OPENAI_API_KEY in Settings → Thumbnail Designer.");
  }
  if (!opts.images.length) throw new Error("Image edit needs at least one input image.");

  const url = `${OPENAI_BASE}${OPENAI_EDITS_PATH}`;
  const body = buildOpenAiEditForm(opts.instruction, opts.images, opts.size ?? OPENAI_IMAGE_SIZE);

  const doFetch: OpenAiFetchFn =
    fetchImpl ??
    (async (u, init) => {
      const r = await fetch(u, init);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    });

  // Bearer auth only — do NOT set Content-Type; fetch derives the multipart
  // boundary from the FormData body. The key is never logged.
  const res = await doFetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = json?.error?.message || `OpenAI API HTTP ${res.status}`;
    throw new Error(`gpt-image-1 edit failed: ${msg}`);
  }

  const image = extractOpenAiImage(json);
  if (!image) throw new Error("gpt-image-1 returned no image. The edit was likely refused.");
  return saveEdited(image.data, image.mimeType);
}

// ── Router ────────────────────────────────────────────────────────────────────
/** Injectable HTTP for either back-end (tests pick the one the provider uses). */
export interface EditImageDeps {
  geminiFetch?: GeminiFetchFn;
  openaiFetch?: OpenAiFetchFn;
}

/**
 * Route ONE edit to the chosen provider, returning the SAME EditResult shape for
 * all three. HTTP is injectable per back-end so tests run with no network/keys.
 *
 * The optional `imageSize` is a uniform, provider-agnostic resolution hint the
 * recreation chain threads through so the "compare" default can drive each sub-run
 * at the BEST size that provider offers (gemini-pro 4K, openai 1536×1024):
 *   • gemini-pro → generationConfig.imageConfig.imageSize ("1K"|"2K"|"4K")
 *   • openai     → the multipart `size` field (1024x1024|1536x1024|1024x1536)
 *   • gemini-flash → ignored (flash exposes no resolution knob)
 * Omitting it keeps each provider's default (gemini-pro 2K, openai 1536×1024).
 */
export function editImageWith(
  provider: ImageProvider,
  opts: { instruction: string; images: EditImage[]; imageSize?: string },
  deps: EditImageDeps = {},
): Promise<EditResult> {
  switch (provider) {
    case "gemini-pro":
      return editWithGemini(NANO_BANANA_PRO_MODEL, true, opts, deps.geminiFetch);
    case "openai":
      return editWithOpenAi({ ...opts, size: opts.imageSize }, deps.openaiFetch);
    case "gemini-flash":
    default:
      return editWithGemini(NANO_BANANA_MODEL, false, opts, deps.geminiFetch);
  }
}

/** Whether the OpenAI provider is usable (key configured). For the UI gate. */
export function openAiConfigured(): boolean {
  return !!getOpenAiApiKey();
}

/** One provider sub-run's config: which provider, at what size, with what label. */
export interface ProviderRun {
  provider: ImageProvider;
  /** Resolution hint threaded to editImageWith (undefined = the provider default). */
  imageSize?: string;
  /** UI column label ("Nano Banana Pro · 4K", "OpenAI · 1536×1024"). */
  label: string;
}

/** Human-friendly column label for a provider at a given size. */
function providerLabel(provider: ImageProvider, size?: string): string {
  switch (provider) {
    case "gemini-pro":
      return `Nano Banana Pro · ${size ?? NANO_BANANA_PRO_IMAGE_SIZE}`;
    case "gemini-flash":
      return "Nano Banana (Flash)";
    case "openai":
      return `OpenAI · ${(size ?? OPENAI_IMAGE_SIZE).replace("x", "×")}`;
  }
}

/**
 * The provider sub-runs a mode expands to. "compare" → BOTH top providers at
 * their best size (Nano Banana Pro @ 4K, OpenAI @ its max); a single-provider
 * mode → exactly one sub-run at that provider's DEFAULT size (so single gemini-pro
 * stays the cheaper 2K). Drives both the seeded UI columns and the runner.
 */
export function providersForMode(mode: GenerationMode): ProviderRun[] {
  if (mode === "compare") {
    return [
      { provider: "gemini-pro", imageSize: NANO_BANANA_PRO_IMAGE_SIZE_MAX, label: providerLabel("gemini-pro", NANO_BANANA_PRO_IMAGE_SIZE_MAX) },
      { provider: "openai", imageSize: OPENAI_IMAGE_SIZE_MAX, label: providerLabel("openai", OPENAI_IMAGE_SIZE_MAX) },
    ];
  }
  // Single-provider mode: one sub-run at the provider's default size.
  return [{ provider: mode, label: providerLabel(mode) }];
}
