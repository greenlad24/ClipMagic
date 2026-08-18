/**
 * Sticker image generation for the Meme/Sticker editor.
 *
 * One STATIC, funny, meme-style image per emphasis moment, for the moments the
 * free Giphy/Tenor libraries couldn't fill. Two providers, tried in order:
 *
 *   1. SEGMIND — GPT Image 2 (`POST /v1/gpt-image-2`, `x-api-key`). THE DEFAULT,
 *      and the reason this module was rewritten: at `quality:"low"` a 1024×1024
 *      sticker bills ~$0.006 (measured from Segmind's own `x-cost` response
 *      header on a live call) against $0.04 for the OpenAI gpt-image-1 path —
 *      roughly a 6× cut, for art that is more than good enough at the ~500px the
 *      sticker actually renders at. It answers SYNCHRONOUSLY with raw PNG bytes.
 *   2. OPENAI — the previous gpt-image-1 path, kept as an automatic fallback so
 *      a Segmind outage or an exhausted credit balance still yields a sticker.
 *
 * TWO SEGMIND QUIRKS ARE LOAD-BEARING (both verified against the live API — each
 * is a hard 400, not a soft degrade, if you get it wrong):
 *   • `background:"transparent"` is REJECTED for this model. We get our die-cut
 *     alpha by asking for a chroma-green field and keying it locally — see
 *     meme/cutout.ts, which also guards against keying an image that isn't
 *     actually a green screen.
 *   • PNG output requires `output_compression: 100`. Segmind's default
 *     compression is < 100 and errors out with `invalid_png_output_compression`.
 *
 * Design, unchanged from the original module's "optional and safe" stance:
 *  • Graceful fallback: NO key / NO credit / any API error → returns null for
 *    that moment. The pipeline then renders captions-only and never crashes.
 *  • Bounded concurrency (a tiny semaphore) so a burst of moments can't hammer
 *    the API or the box.
 *  • Cache by prompt (AND provider/model/quality, so a settings change can't
 *    serve a stale image): identical prompts reuse the same PNG on disk and are
 *    only ever billed once.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "../config.js";
import { recordImageGeneration } from "../ai/runAccounting.js";
import { getSegmindApiKey } from "../settings/postizSecrets.js";
import { cutOutGreenScreen, GREEN_SCREEN_PROMPT } from "./cutout.js";

/** Which paid generator produced (or would produce) an image. */
export type ImageProvider = "segmind" | "openai";

// ── Segmind (GPT Image 2) — the default, ~6× cheaper ─────────────────────────
const SEGMIND_BASE = process.env.SEGMIND_BASE_URL || "https://api.segmind.com";
const SEGMIND_IMAGE_MODEL = process.env.MEME_SEGMIND_IMAGE_MODEL || "gpt-image-2";
/**
 * Segmind bills almost entirely on OUTPUT tokens, so quality is THE cost lever:
 * 1024×1024 runs ~$0.01 low / ~$0.06 medium / ~$0.22 high. Low is the default
 * deliberately — a sticker renders at ~500px inside a 1080-wide frame, where
 * "low" is indistinguishable, and "medium" would actually cost MORE than the
 * OpenAI path this replaces. Raise it only with that trade in mind.
 */
const SEGMIND_QUALITY = (process.env.MEME_IMAGE_QUALITY || "low").toLowerCase();

// ── OpenAI (gpt-image-1) — the fallback ──────────────────────────────────────
const OPENAI_IMAGE_MODEL = process.env.MEME_IMAGE_MODEL || "gpt-image-1";
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const IMAGE_SIZE = process.env.MEME_IMAGE_SIZE || "1024x1024";

/** Where generated/cached sticker PNGs live (served via /api/outputs). */
function stickersDir(): string {
  const dir = path.join(config.outputsDir, "stickers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function segmindConfigured(): boolean {
  return !!getSegmindApiKey();
}
export function openaiImageConfigured(): boolean {
  return !!process.env.ZITE_OPENAI_ACCESS_TOKEN;
}

/** True when ANY paid generator can run (the pipeline's "fallback available"). */
export function imageGenConfigured(): boolean {
  return segmindConfigured() || openaiImageConfigured();
}

/**
 * The provider order for this run. Pure + deterministic so the "cheap first,
 * OpenAI only as a rescue" policy is unit-testable. `MEME_IMAGE_PROVIDER`
 * pins a preference ("segmind" | "openai"); either way an unconfigured provider
 * is dropped from the chain rather than attempted and failed.
 */
export function providerChain(
  available: { segmind: boolean; openai: boolean } = {
    segmind: segmindConfigured(),
    openai: openaiImageConfigured(),
  },
  preferred = (process.env.MEME_IMAGE_PROVIDER || "segmind").toLowerCase(),
): ImageProvider[] {
  const order: ImageProvider[] = preferred === "openai" ? ["openai", "segmind"] : ["segmind", "openai"];
  return order.filter((p) => available[p]);
}

/**
 * Hard content-safety constraint prepended to EVERY generation prompt. An
 * offensive sticker is never acceptable, so we explicitly forbid the categories
 * that would make one — no matter what the director's imagePrompt asked for.
 * The provider's own safety filters also apply; this is belt-and-suspenders so
 * the instruction is in the prompt itself.
 */
export const SAFETY_PROMPT =
  "Clean, brand-safe, all-ages content ONLY. Absolutely NO nudity or sexual " +
  "content, NO gore/violence/blood, NO slurs/hate symbols/hateful imagery, NO " +
  "drugs, and NO shocking, disturbing, or offensive imagery of any kind. Keep it " +
  "a friendly, funny, family-safe reaction sticker.";

/**
 * Wrap a raw image-gen prompt with the hard safety constraint. Pure (no I/O) so
 * the guarantee — that the constraint is always present — is unit-testable.
 */
export function withSafetyConstraint(prompt: string): string {
  return `${prompt}\n\n${SAFETY_PROMPT}`;
}

/**
 * The final prompt for a provider. Segmind's GPT Image 2 cannot return alpha, so
 * its prompt also carries the green-screen instruction that makes a local key
 * possible; OpenAI asks the API for real transparency and must NOT be told to
 * paint a green field (it would key nothing and keep the green).
 */
export function promptFor(rawPrompt: string, provider: ImageProvider): string {
  const safe = withSafetyConstraint(rawPrompt);
  return provider === "segmind" ? `${safe}\n\n${GREEN_SCREEN_PROMPT}` : safe;
}

// ── Tiny semaphore (bounded concurrency) ──────────────────────────────────────
const MAX_CONCURRENCY = Math.max(1, Number.parseInt(process.env.MEME_IMAGE_CONCURRENCY || "3", 10));
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  return () => {
    active--;
    waiters.shift()?.();
  };
}

/**
 * Cache identity. Includes the provider, model and quality as well as the
 * prompt, so flipping any of them regenerates rather than serving the image the
 * OTHER setting produced.
 */
export function cacheKey(prompt: string, provider: ImageProvider): string {
  const model = provider === "segmind" ? SEGMIND_IMAGE_MODEL : OPENAI_IMAGE_MODEL;
  const quality = provider === "segmind" ? SEGMIND_QUALITY : "default";
  return crypto
    .createHash("sha1")
    .update(`${provider}|${model}|${quality}|${IMAGE_SIZE}|${prompt}`)
    .digest("hex")
    .slice(0, 24);
}

export interface GeneratedImage {
  /** Local absolute path to the PNG. */
  file: string;
  /** Public URL the manifest/Remotion can load (/api/outputs/...). */
  url: string;
  /** True if served from the on-disk prompt cache (no new API charge). */
  cached: boolean;
  /** Which generator produced it (diagnostics / accounting). */
  provider: ImageProvider;
}

/** One provider's raw result: the PNG bytes and, when reported, the real cost. */
interface RawImage {
  png: Buffer;
  /** Provider-reported USD cost for this image, when it tells us (Segmind does). */
  costUsd?: number;
}

/** Call Segmind's GPT Image 2. Returns raw PNG bytes; throws on any failure. */
async function generateViaSegmind(prompt: string): Promise<RawImage> {
  const key = getSegmindApiKey();
  if (!key) throw new Error("Segmind API key not configured");

  const res = await fetch(`${SEGMIND_BASE}/v1/${SEGMIND_IMAGE_MODEL}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      size: IMAGE_SIZE,
      output_format: "png",
      // REQUIRED for PNG — anything below 100 is a hard 400 on this model.
      output_compression: 100,
      quality: SEGMIND_QUALITY,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`segmind ${res.status} ${body.slice(0, 300)}`);
  }

  // Segmind reports the exact charge per call — use the REAL number in the run
  // report rather than a table estimate that drifts from the published price.
  const costHeader = Number.parseFloat(res.headers.get("x-cost") || "");
  const costUsd = Number.isFinite(costHeader) ? costHeader : undefined;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    // Documented alternative shape: JSON carrying a hosted output URL.
    const json = (await res.json()) as Record<string, unknown>;
    const url =
      (typeof json.output === "string" && json.output) ||
      (typeof json.image_url === "string" && json.image_url) ||
      "";
    if (!url) throw new Error(`segmind returned no image: ${JSON.stringify(json).slice(0, 200)}`);
    const img = await fetch(url);
    if (!img.ok) throw new Error(`segmind image fetch ${img.status}`);
    return { png: Buffer.from(await img.arrayBuffer()), costUsd };
  }

  // Sync shape (what the API actually does today): the body IS the PNG.
  return { png: Buffer.from(await res.arrayBuffer()), costUsd };
}

/** Call the OpenAI Images API (the fallback). Returns raw PNG bytes; throws. */
async function generateViaOpenAI(prompt: string): Promise<RawImage> {
  const body: Record<string, unknown> = {
    model: OPENAI_IMAGE_MODEL,
    prompt,
    n: 1,
    size: IMAGE_SIZE,
  };
  // gpt-image-1 supports a transparent background (the cut-out sticker look).
  if (OPENAI_IMAGE_MODEL === "gpt-image-1") {
    body.background = "transparent";
    body.output_format = "png";
  }

  const res = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ZITE_OPENAI_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(json?.error?.message || `images API ${res.status}`);

  const datum = json?.data?.[0];
  if (datum?.b64_json) return { png: Buffer.from(datum.b64_json, "base64") };
  if (datum?.url) {
    // dall-e-3 returns a URL; fetch the bytes once and persist locally.
    const imgRes = await fetch(datum.url);
    if (!imgRes.ok) throw new Error(`fetch generated image ${imgRes.status}`);
    return { png: Buffer.from(await imgRes.arrayBuffer()) };
  }
  throw new Error("images API returned no image data");
}

/**
 * Generate (or reuse) one sticker image for a prompt, cheapest provider first.
 * Returns null when every configured provider failed (or none is configured) —
 * the caller falls back to captions-only for that moment.
 */
export async function generateStickerImage(rawPrompt: string): Promise<GeneratedImage | null> {
  const chain = providerChain();
  if (chain.length === 0) return null;

  // Cache probe FIRST, across every provider in the chain: if ANY of them has
  // already produced this exact prompt, reuse that PNG and bill nothing.
  for (const provider of chain) {
    const key = cacheKey(promptFor(rawPrompt, provider), provider);
    const file = path.join(stickersDir(), `${key}.png`);
    if (fs.existsSync(file)) {
      return { file, url: `/api/outputs/stickers/${key}.png`, cached: true, provider };
    }
  }

  const release = await acquire();
  try {
    for (const provider of chain) {
      const prompt = promptFor(rawPrompt, provider);
      const key = cacheKey(prompt, provider);
      const finalFile = path.join(stickersDir(), `${key}.png`);
      const rawFile = path.join(stickersDir(), `${key}_raw.png`);
      const model = provider === "segmind" ? SEGMIND_IMAGE_MODEL : OPENAI_IMAGE_MODEL;
      const t0 = Date.now();
      try {
        const { png, costUsd } =
          provider === "segmind" ? await generateViaSegmind(prompt) : await generateViaOpenAI(prompt);
        if (png.length === 0) throw new Error("provider returned no image data");
        fs.writeFileSync(rawFile, png);

        // Segmind can't hand back alpha, so key its green field out locally. The
        // cut-out is best-effort and self-guarding: it returns the untouched
        // image whenever keying would be unsafe (see meme/cutout.ts).
        let produced = rawFile;
        if (provider === "segmind") {
          const cut = await cutOutGreenScreen(rawFile);
          produced = cut.file;
          console.log(`[meme] sticker cut-out: ${cut.reason}`);
        }
        fs.renameSync(produced, finalFile);
        if (produced !== rawFile) fs.rm(rawFile, { force: true }, () => {});

        recordImageGeneration({
          model,
          images: 1,
          ms: Date.now() - t0,
          provider,
          quality: provider === "segmind" ? SEGMIND_QUALITY : undefined,
          costUsd,
        });
        console.log(
          `[meme] sticker generated via ${provider}/${model}` +
            (costUsd !== undefined ? ` ($${costUsd.toFixed(4)})` : "") +
            ` in ${Date.now() - t0}ms`,
        );
        return { file: finalFile, url: `/api/outputs/stickers/${key}.png`, cached: false, provider };
      } catch (e) {
        fs.rm(rawFile, { force: true }, () => {});
        console.warn(
          `[meme] sticker image gen via ${provider} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        // Fall through to the next provider in the chain (if any).
      }
    }
  } finally {
    release();
  }

  console.warn("[meme] every image provider failed — captions-only for this moment");
  return null;
}

/** The model the DEFAULT (cheapest configured) provider would use — logged. */
export const imageModel = segmindConfigured() ? SEGMIND_IMAGE_MODEL : OPENAI_IMAGE_MODEL;
