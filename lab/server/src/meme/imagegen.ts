/**
 * Sticker image generation for the Meme/Sticker editor.
 *
 * One STATIC, funny, meme-style image per emphasis moment, generated via the
 * app's existing OpenAI access (ZITE_OPENAI_ACCESS_TOKEN — the same token the
 * main pipeline uses for capture/vision). We call the OpenAI Images API directly
 * (NOT the chat shim, which routes chat→Claude) so we get a real image back.
 *
 * Design, mirroring the motion-render service's "optional and safe" stance:
 *  • Graceful fallback: NO token / NO credit / any API error → returns null for
 *    that moment. The pipeline then renders captions-only and never crashes.
 *  • Transparent background when the model supports it (gpt-image-1 →
 *    background:"transparent"), so the still reads as a die-cut sticker.
 *  • Bounded concurrency (a tiny semaphore) so a burst of moments can't hammer
 *    the API or the box.
 *  • Cache by prompt: identical prompts reuse the same PNG on disk (and the same
 *    cost is only billed once), persisted under the project's data dir.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "../config.js";
import { recordImageGeneration } from "../ai/runAccounting.js";

/** Default image model + size. Overridable via env without a rebuild. */
const IMAGE_MODEL = process.env.MEME_IMAGE_MODEL || "gpt-image-1";
const IMAGE_SIZE = process.env.MEME_IMAGE_SIZE || "1024x1024";
const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

/** Where generated/cached sticker PNGs live (served via /api/outputs). */
function stickersDir(): string {
  const dir = path.join(config.outputsDir, "stickers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function imageGenConfigured(): boolean {
  return !!process.env.ZITE_OPENAI_ACCESS_TOKEN;
}

/**
 * Hard content-safety constraint prepended to EVERY generation prompt. An
 * offensive sticker is never acceptable, so we explicitly forbid the categories
 * that would make one — no matter what the director's imagePrompt asked for.
 * OpenAI's own safety filters also apply; this is belt-and-suspenders so the
 * instruction is in the prompt itself.
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

function cacheKey(prompt: string): string {
  return crypto.createHash("sha1").update(`${IMAGE_MODEL}|${IMAGE_SIZE}|${prompt}`).digest("hex").slice(0, 24);
}

export interface GeneratedImage {
  /** Local absolute path to the PNG. */
  file: string;
  /** Public URL the manifest/Remotion can load (/api/outputs/...). */
  url: string;
  /** True if served from the on-disk prompt cache (no new API charge). */
  cached: boolean;
}

/**
 * Generate (or reuse) one sticker image for a prompt. Returns null on any
 * failure or when no token is configured — caller falls back to captions-only.
 */
export async function generateStickerImage(rawPrompt: string): Promise<GeneratedImage | null> {
  // Hard-constrain EVERY generation to clean, brand-safe content before it ever
  // reaches the model — an offensive sticker is never acceptable. The cache key
  // is derived from the SAFE prompt so the constraint can't be bypassed via cache.
  const prompt = withSafetyConstraint(rawPrompt);
  const key = cacheKey(prompt);
  const file = path.join(stickersDir(), `${key}.png`);
  const url = `/api/outputs/stickers/${key}.png`;

  // Prompt cache: identical prompt already on disk → reuse, bill nothing.
  if (fs.existsSync(file)) {
    return { file, url, cached: true };
  }

  if (!imageGenConfigured()) return null;

  const release = await acquire();
  const t0 = Date.now();
  try {
    const body: Record<string, unknown> = {
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size: IMAGE_SIZE,
    };
    // gpt-image-1 supports a transparent background (the cut-out sticker look).
    if (IMAGE_MODEL === "gpt-image-1") {
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
    if (!res.ok) {
      throw new Error(json?.error?.message || `images API ${res.status}`);
    }

    const datum = json?.data?.[0];
    let png: Buffer | null = null;
    if (datum?.b64_json) {
      png = Buffer.from(datum.b64_json, "base64");
    } else if (datum?.url) {
      // dall-e-3 returns a URL; fetch the bytes once and persist locally.
      const imgRes = await fetch(datum.url);
      if (!imgRes.ok) throw new Error(`fetch generated image ${imgRes.status}`);
      png = Buffer.from(await imgRes.arrayBuffer());
    }
    if (!png || png.length === 0) throw new Error("images API returned no image data");

    fs.writeFileSync(file, png);
    recordImageGeneration({ model: IMAGE_MODEL, images: 1, ms: Date.now() - t0 });
    return { file, url, cached: false };
  } catch (e) {
    console.warn(
      `[meme] sticker image gen failed — captions-only for this moment: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  } finally {
    release();
  }
}

export const imageModel = IMAGE_MODEL;
