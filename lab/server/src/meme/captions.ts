/**
 * Server-side caption builder for the Meme/Sticker editor.
 *
 * Turns Groq's word-level timestamps into the viral 2–3-word SubtitleEvent
 * chunks the render path (render/ass.ts) already burns in.
 *
 * IMPORTANT: this is byte-for-byte equivalent in STRUCTURE to the short-form
 * editor's captions (src/api/runPipeline.ts). Rather than re-implement a parallel
 * (and slightly different) heuristic, it delegates to the SHARED chunker in
 * render/captionChunks.ts — the single source of truth both editors use — so a
 * meme short's captions read identically to a normal short:
 *   • same 2–3-word chunking with the long-word cap and pause/punctuation breaks;
 *   • same per-word { text, start, end, emphasis } shape, so render/ass.ts gives
 *     the SAME per-word "karaoke" active-word highlight (driven by the per-word
 *     start/end timings) for the same chosen template;
 *   • casing is NOT forced here — each template's `allCaps` field is honored at
 *     render time in render/ass.ts (so an all-caps template looks all-caps, a
 *     mixed-case template stays mixed-case), exactly like the short-form editor.
 *
 * Optionally accepts director-chosen emphasis word indices (the same contract as
 * the short-form editor's `emphasisWords`); when omitted every word is
 * `emphasis: false`. The active-word karaoke pop is independent of this flag.
 */
import type { SubtitleEvent } from "../render/manifest.js";
import type { TranscriptWord } from "../ai/transcribe.js";
import { buildSubtitleEvents } from "../render/captionChunks.js";

/**
 * Build the meme editor's caption events from transcript words.
 *
 * @param words           Groq word-level timestamps.
 * @param emphasisIndices optional 0-based transcript-word indices to mark as
 *                        emphasis (same shape the short-form director returns).
 */
export function buildCaptionEvents(
  words: TranscriptWord[],
  emphasisIndices?: Set<number>,
): SubtitleEvent[] {
  return buildSubtitleEvents(words, emphasisIndices);
}
