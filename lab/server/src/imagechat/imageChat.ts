/**
 * AI Image Generator (chat) — server side.
 *
 * Powers the "AI image generator" LAB tool: a nano-banana-style chatbot where
 * the user types a prompt in their OWN words, we OPTIMIZE it into a strong
 * image-generation instruction, send it to Nano Banana (Google Gemini image
 * models) and hand back the rendered image.
 *
 * Two Gemini modes, both via the SAME generateContent REST call:
 *   • text → image  (no input images): a fresh generation from the prompt.
 *   • image edit    (≥1 input image):  edit / combine / restyle the supplied
 *     images per the prompt — this is how "edit an image" and "upload my own
 *     images and refer to them" work.
 *
 * EPHEMERAL BY DESIGN — "no memory of past chats should be saved":
 *   • Nothing is written to disk or the DB. Input images arrive as base64 in the
 *     request; the generated image is returned as base64 in the response and
 *     rendered from a data URL in the browser. The whole conversation lives in
 *     React state and evaporates on reload.
 *   • The Gemini key is read via the server-only getter and NEVER logged.
 *
 * Mirrors nanoBanana.ts's stance (isolated model ids, injectable fetch, never
 * log the key) and reuses its pure image extractor so the two paths can't drift.
 */
import { getGeminiApiKey } from "../settings/postizSecrets.js";
import { claudeChat, anthropicConfigured } from "../ai/claude.js";
import {
  extractInlineImage,
  NANO_BANANA_MODEL,
  type EditImage,
} from "../thumbnails/nanoBanana.js";
import {
  NANO_BANANA_PRO_MODEL,
  NANO_BANANA_FLASH_31_MODEL,
} from "../thumbnails/imageProviders.js";

const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";

/** True once the Gemini key is set (same key as the Thumbnail Designer). */
export function imageChatConfigured(): boolean {
  return !!getGeminiApiKey();
}

/**
 * The selectable image models for the chat. "flash" is the original Nano Banana
 * (Gemini 2.5 Flash Image) — fast + cheap, the default for a snappy chat. "pro"
 * is Nano Banana Pro (Gemini 3 Pro Image) — sharper, slower. "flash-31" is the
 * newer 3.1 Flash. Isolated behind one map so a rename is a one-line change.
 */
export type ChatImageModel = "flash" | "pro" | "flash-31";

const MODEL_IDS: Record<ChatImageModel, string> = {
  flash: NANO_BANANA_MODEL,
  pro: NANO_BANANA_PRO_MODEL,
  "flash-31": NANO_BANANA_FLASH_31_MODEL,
};

const MODEL_LABELS: Record<ChatImageModel, string> = {
  flash: "Nano Banana",
  pro: "Nano Banana Pro",
  "flash-31": "Nano Banana 3.1",
};

/** Coerce arbitrary input to a supported model id (default: flash / Nano Banana). */
export function coerceChatModel(x: unknown): ChatImageModel {
  return x === "pro" || x === "flash-31" ? x : "flash";
}

export function chatModelLabel(m: ChatImageModel): string {
  return MODEL_LABELS[m];
}

/**
 * Aspect ratios the UI can request. "auto" sends no hint — the model keeps the
 * input image's shape on an edit, or picks a sensible default on a generation.
 */
export type ChatAspect = "auto" | "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
const ASPECTS: ChatAspect[] = ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"];
export function coerceAspect(x: unknown): ChatAspect {
  return typeof x === "string" && (ASPECTS as string[]).includes(x) ? (x as ChatAspect) : "auto";
}

/** Injectable fetch (kept narrow so tests can supply a mock — no network). */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/**
 * Turn the user's casual words into a strong, literal image-generation prompt.
 *
 * Best-effort: when Anthropic isn't configured (or the call fails) we return the
 * user's text unchanged, so the generator still works without a prompt optimizer.
 * When editing supplied images, the optimizer is told to write an EDIT
 * instruction (what to change) rather than describe a scene from scratch.
 */
export async function optimizeImagePrompt(userPrompt: string, hasReferenceImages: boolean): Promise<string> {
  const raw = (userPrompt ?? "").trim();
  if (!raw) return raw;
  if (!anthropicConfigured()) return raw;

  const system = hasReferenceImages
    ? [
        "You rewrite a user's casual request into ONE precise image-EDIT instruction for an AI image model that is given the user's reference image(s).",
        "Describe exactly what to change/add/remove and the desired style, lighting and detail — while preserving whatever the user did not ask to change.",
        "Refer to the supplied image(s) naturally (e.g. 'the provided photo').",
        "Output ONLY the final instruction — no preamble, no quotes, no markdown, no options. Keep it under 120 words.",
      ].join(" ")
    : [
        "You rewrite a user's casual request into ONE vivid, detailed prompt for a text-to-image model.",
        "Add concrete specifics the user implied but didn't spell out: subject, composition, setting, lighting, mood, color, lens/medium and level of detail.",
        "Stay faithful to the user's intent — never invent a different subject.",
        "Output ONLY the final prompt — no preamble, no quotes, no markdown, no options. Keep it under 120 words.",
      ].join(" ");

  try {
    const out = await claudeChat({
      // "gpt-4o-mini" routes to the fast/Haiku tier — cheap + quick, right for
      // a short prompt rewrite that must not slow the chat down.
      model: "gpt-4o-mini",
      system,
      messages: [{ role: "user", content: raw }],
    });
    const cleaned = (out ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    return cleaned || raw;
  } catch {
    // Never fail the generation because the optional optimizer hiccupped.
    return raw;
  }
}

export interface GeneratedImage {
  /** Base64 image bytes (no data: prefix). */
  base64: string;
  /** MIME type the model returned (usually image/png). */
  mimeType: string;
}

/**
 * Build the generateContent request body. The instruction goes first, then each
 * reference image as an inline_data part (edit mode). An explicit aspect ratio
 * is sent only when it isn't "auto". Pure + exported so the request shape is
 * unit-testable without a network call.
 */
export function buildChatRequestBody(instruction: string, images: EditImage[], aspect: ChatAspect) {
  const parts: Array<Record<string, unknown>> = [{ text: instruction }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data.toString("base64") } });
  }
  const generationConfig: {
    responseModalities: string[];
    imageConfig?: { aspectRatio: string };
  } = { responseModalities: ["IMAGE"] };
  if (aspect !== "auto") generationConfig.imageConfig = { aspectRatio: aspect };
  return { contents: [{ parts }], generationConfig };
}

/**
 * Generate (or edit) one image with Nano Banana and return it as base64 — never
 * touching disk. Throws a clear, actionable error on a missing key / safety
 * block / no-image response. The key is never logged.
 */
export async function generateChatImage(
  opts: { instruction: string; images?: EditImage[]; model?: ChatImageModel; aspect?: ChatAspect },
  fetchImpl?: FetchFn,
): Promise<GeneratedImage> {
  const key = getGeminiApiKey();
  if (!key) {
    throw new Error("Gemini API key not configured — add GEMINI_API_KEY in Settings → Thumbnail Designer.");
  }
  const instruction = (opts.instruction ?? "").trim();
  if (!instruction) throw new Error("A prompt is required to generate an image.");

  const model = MODEL_IDS[opts.model ?? "flash"];
  const images = opts.images ?? [];
  const aspect = opts.aspect ?? "auto";
  const url = `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify(buildChatRequestBody(instruction, images, aspect));

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
    throw new Error(`Image generation failed: ${msg}`);
  }

  const blockReason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
  const image = extractInlineImage(json);
  if (!image) {
    throw new Error(
      `Nano Banana returned no image${blockReason ? ` (reason: ${blockReason})` : ""}. The prompt was likely blocked or refused — try rewording it.`,
    );
  }
  return { base64: image.data.toString("base64"), mimeType: image.mimeType };
}
