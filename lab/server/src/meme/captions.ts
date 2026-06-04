/**
 * Server-side caption builder for the Meme/Sticker editor.
 *
 * Turns Groq's word-level timestamps into the viral 2–3-word SubtitleEvent
 * chunks the render path (render/ass.ts) already burns in.
 *
 * IMPORTANT: this uses the EXACT SAME chunking guidelines as the regular
 * short-form editor (src/api/runPipeline.ts, "Hormozi-style captions"). The
 * short-form creator builds these in the frontend; the meme editor runs fully
 * server-side from the raw transcription, so we re-implement the SAME rules here
 * (rather than a parallel, looser heuristic) so a meme short's captions read
 * identically to a normal short:
 *   • at most 3 words per chunk, and only 2 when the words are long (so a caption
 *     never runs off the frame): a "long two" is capped at 13 letters, or where a
 *     third word would push the chunk past ~16 letters;
 *   • break on a real pause (>0.35s gap), on sentence-ending punctuation, and on
 *     a clause break (,;:) once the chunk already has ≥2 words.
 * Plus the display-hygiene rules every short-form caption gets (profanity mask +
 * casing/spacing tidy) via render/subtitleText.ts, applied at render time in
 * render/ass.ts — same code path as the short-form editor.
 */
import type { SubtitleEvent } from "../render/manifest.js";
import type { TranscriptWord } from "../ai/transcribe.js";

/** If adding a 3rd word would push the chunk past this letter count, cap at 2. */
const CHARS_2WORD_LIMIT = 13;
/** Hard ceiling on a 2-word chunk's letters before forcing a break. */
const CHARS_HARD_LIMIT = 16;
/** A gap longer than this between words forces a new chunk (a real pause). */
const PAUSE_GAP_SECONDS = 0.35;

/** Letters only (ignore punctuation/whitespace) — matches runPipeline's wlen. */
function letterCount(words: Array<{ word: string }>): number {
  return words.reduce((n, w) => n + w.word.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
}

export function buildCaptionEvents(words: TranscriptWord[]): SubtitleEvent[] {
  const clean = words
    .map((w) => ({ ...w, word: (w.word ?? "").trim() }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (clean.length === 0) return [];

  // Group words into viral chunks using the SAME rules as the short-form editor.
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  for (let i = 0; i < clean.length; i++) {
    current.push(clean[i]);
    const next = clean[i + 1];
    const gap = next ? next.start - clean[i].end : Infinity;
    const endsSentence = /[.!?…]$/.test(clean[i].word);
    const endsClause = /[,;:]$/.test(clean[i].word);

    // Long-word cap: once we have 2 words and they're already wide, break
    // (don't add a 3rd). "Long" = the chunk's letters exceed the 2-word budget,
    // or the next word would push it over the hard limit.
    const curChars = letterCount(current);
    const nextChars = next ? next.word.replace(/[^\p{L}\p{N}]/gu, "").length : 0;
    const longTwo =
      current.length >= 2 && (curChars > CHARS_2WORD_LIMIT || curChars + nextChars > CHARS_HARD_LIMIT);

    if (
      current.length >= 3 ||
      longTwo ||
      gap > PAUSE_GAP_SECONDS ||
      endsSentence ||
      (endsClause && current.length >= 2)
    ) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => ({
    start: group[0].start,
    end: group[group.length - 1].end,
    words: group.map((w) => ({
      text: w.word,
      start: w.start,
      end: w.end,
      // The render highlights the active (currently-spoken) word per the chosen
      // template's karaoke rule — same as the short-form editor. We don't mark a
      // specific emphasis word here (the meme look leans on the sticker, and the
      // short-form's emphasis words come from its director, which this lean
      // pipeline doesn't run); the active-word highlight still pops per template.
      emphasis: false,
    })),
  }));
}
