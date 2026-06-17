/**
 * Nano Banana (Gemini 2.5 Flash Image) image-editing client for the Thumbnail
 * Designer. Calls Google's Gemini generateContent REST API directly (no SDK) so
 * we can pass MULTIPLE input images + a text instruction and get an edited image
 * back — the building block of the 6-step recreation chain (recreate.ts).
 *
 * Request  (REST generateContent):
 *   POST {BASE}/v1beta/models/{MODEL}:generateContent?key={GEMINI_API_KEY}
 *   { contents: [{ parts: [ {text}, {inline_data:{mime_type,data}}, … ] }] }
 * Response:
 *   candidates[0].content.parts[] — the edited image is the part carrying
 *   inline_data / inlineData (base64). We decode it, save under outputsDir and
 *   return { file, outputUrl }.
 *
 * Design (mirrors meme/imagegen.ts's "isolated, injectable, never-log-the-key"
 * stance):
 *   • The HTTP layer (fetch) is INJECTABLE so tests can mock it — no network in
 *     unit tests.
 *   • The model id is isolated behind a single constant (env-overridable) so a
 *     future model rename is a one-line change.
 *   • The key is read via the server-only getter and NEVER logged.
 *   • Safety-block / no-image responses surface a clear, actionable error.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { getGeminiApiKey } from "../settings/postizSecrets.js";

/**
 * Nano Banana image model id. Google's GA id for Gemini 2.5 Flash Image is
 * `gemini-2.5-flash-image` (the preview alias is `gemini-2.5-flash-image-preview`).
 * Verified against Google's Gemini API image-generation docs
 * (ai.google.dev/gemini-api/docs/image-generation) and the model card
 * (ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image), Aug 2025 GA.
 * TODO: if Google renames the image model again, override via NANO_BANANA_MODEL
 * (no rebuild) or update this constant.
 */
export const NANO_BANANA_MODEL = process.env.NANO_BANANA_MODEL || "gemini-2.5-flash-image";
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";

export function nanoBananaConfigured(): boolean {
  return !!getGeminiApiKey();
}

/** Where edited thumbnails (and chain intermediates) land — served at /api/outputs/thumbnails/<name>. */
export function thumbnailsDir(): string {
  const dir = path.join(config.outputsDir, "thumbnails");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One input image for an edit: raw bytes + its mime type. */
export interface EditImage {
  data: Buffer;
  mimeType: string;
}

export interface EditResult {
  /** Absolute path to the saved edited image on disk. */
  file: string;
  /** Public URL the UI/chain can load (/api/outputs/thumbnails/...). */
  outputUrl: string;
  /** The edited image bytes (so the chain can feed it into the next step without re-reading disk). */
  bytes: Buffer;
  /** The MIME type the model returned (usually image/png). */
  mimeType: string;
}

/** Injectable fetch (kept narrow so tests can supply a mock). */
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

/**
 * Build the generateContent request body for an edit: the instruction text
 * first, then every input image as an inline_data part. Pure + exported so the
 * exact request shape is unit-testable without a network call.
 */
export function buildEditRequestBody(instruction: string, images: EditImage[]): {
  contents: Array<{ parts: Array<Record<string, unknown>> }>;
} {
  const parts: Array<Record<string, unknown>> = [{ text: instruction }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data.toString("base64") } });
  }
  return { contents: [{ parts }] };
}

/**
 * Extract the first inline image (base64) from a generateContent response.
 * Tolerates BOTH snake_case (inline_data/mime_type) and camelCase
 * (inlineData/mimeType) since the REST API and SDK differ. Returns null when no
 * image part is present (e.g. a safety block or a text-only response). Pure +
 * exported for unit testing.
 */
export function extractInlineImage(json: any): { data: Buffer; mimeType: string } | null {
  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p?.inline_data ?? p?.inlineData;
    if (inline?.data) {
      return {
        data: Buffer.from(inline.data, "base64"),
        mimeType: inline.mime_type ?? inline.mimeType ?? "image/png",
      };
    }
  }
  return null;
}

/** Map a returned mime type to a file extension for the saved file. */
function extForMime(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  return "png";
}

/**
 * Run ONE Nano Banana edit: send the instruction + input images, decode the
 * returned image and persist it. Throws a clear error on a safety block / quota
 * / no-image response so the caller (the resilient chain) can keep the previous
 * good image and continue. The Gemini key is never logged.
 */
export async function editImage(
  opts: { instruction: string; images: EditImage[] },
  fetchImpl?: FetchFn,
): Promise<EditResult> {
  const key = getGeminiApiKey();
  if (!key) {
    throw new Error("Gemini API key not configured — add GEMINI_API_KEY in Settings → Thumbnail Designer.");
  }
  if (!opts.images.length) throw new Error("Nano Banana edit needs at least one input image.");

  const url = `${GEMINI_BASE}/v1beta/models/${NANO_BANANA_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify(buildEditRequestBody(opts.instruction, opts.images));

  const doFetch: FetchFn =
    fetchImpl ??
    (async (u, init) => {
      const r = await fetch(u, init);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    });

  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = json?.error?.message || `Gemini API HTTP ${res.status}`;
    // Never include the key (it's only in the URL query, which we don't echo).
    throw new Error(`Nano Banana edit failed: ${msg}`);
  }

  // A safety block returns no image part but a finishReason / promptFeedback.
  const blockReason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
  const image = extractInlineImage(json);
  if (!image) {
    throw new Error(
      `Nano Banana returned no image${blockReason ? ` (reason: ${blockReason})` : ""}. The edit was likely blocked or refused.`,
    );
  }

  const ext = extForMime(image.mimeType);
  const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const file = path.join(thumbnailsDir(), name);
  fs.writeFileSync(file, image.data);
  return {
    file,
    outputUrl: `/api/outputs/thumbnails/${name}`,
    bytes: image.data,
    mimeType: image.mimeType,
  };
}
