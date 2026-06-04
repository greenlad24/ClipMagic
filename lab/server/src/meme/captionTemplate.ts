/**
 * Caption-template selection for the Meme/Sticker editor.
 *
 * Kept in its own tiny module (no heavy deps) so it can be unit-tested without
 * importing the full pipeline/render chain. It draws from the SAME full rotation
 * pool the short-form editor uses (SUBTITLE_TEMPLATE_POOL in render/manifest.ts)
 * and picks at RANDOM per render — identical behaviour to the short-form editor's
 * subtitle-template rotation (submitRendiJob in zite/endpoints.ts).
 */
import { SUBTITLE_TEMPLATE_POOL, type SubtitleTemplate } from "../render/manifest.js";

/** Pick a caption template at random from the full short-form pool. */
export function pickRandomCaptionTemplate(): SubtitleTemplate {
  return SUBTITLE_TEMPLATE_POOL[Math.floor(Math.random() * SUBTITLE_TEMPLATE_POOL.length)];
}
