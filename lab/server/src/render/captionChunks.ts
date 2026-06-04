/**
 * Shared "Hormozi-style" caption chunker — the SINGLE source of truth for how
 * word-level timestamps are grouped into viral 2–3-word SubtitleEvents.
 *
 * The short-form editor (src/api/runPipeline.ts) and the Meme/Sticker editor
 * (server/src/meme/captions.ts) MUST chunk identically so a meme short's captions
 * read exactly like a normal short. This module is that shared rule, extracted so
 * the two paths can never drift:
 *   • at most 3 words per chunk, and only 2 when the words are long (so a caption
 *     never runs off the frame): a "long two" is capped at 13 letters, or where a
 *     third word would push the chunk past ~16 letters;
 *   • break on a real pause (>0.35s gap), on sentence-ending punctuation, and on
 *     a clause break (,;:) once the chunk already has ≥2 words.
 *
 * Pure + deterministic (no I/O) so it is trivially unit-testable, and shapes its
 * output as the renderer-agnostic SubtitleEvent (server/src/render/manifest.ts):
 * per-word { text, start, end, emphasis }. The active-word KARAOKE highlight is
 * driven by those per-word start/end timings in render/ass.ts; the `emphasis`
 * flag drives the whole-phrase accent in the drawtext fallback (render/build.ts).
 */
import type { SubtitleEvent } from "./manifest.js";

/** A minimal word with timing — the shape both editors already produce. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

/** If adding a 3rd word would push the chunk past this letter count, cap at 2. */
export const CHARS_2WORD_LIMIT = 13;
/** Hard ceiling on a 2-word chunk's letters before forcing a break. */
export const CHARS_HARD_LIMIT = 16;
/** A gap longer than this between words forces a new chunk (a real pause). */
export const PAUSE_GAP_SECONDS = 0.35;

/** Letters/digits only (ignore punctuation/whitespace) — matches runPipeline's wlen. */
function letterCount(words: Array<{ word: string }>): number {
  return words.reduce((n, w) => n + w.word.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
}

/**
 * Group timed words into viral chunks using the SAME rules as the short-form
 * editor. Pure; no casing change (casing is applied at render time per the chosen
 * template's `allCaps`). Returns the chunks as arrays of the original words.
 */
export function chunkCaptionWords(words: TimedWord[]): TimedWord[][] {
  const clean = words
    .map((w) => ({ ...w, word: (w.word ?? "").trim() }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (clean.length === 0) return [];

  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];

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

  return groups;
}

/**
 * Build viral SubtitleEvents from timed words using the shared chunker, marking
 * per-word emphasis via a set of 0-based TRANSCRIPT word indices (same contract
 * as the short-form editor's director-chosen emphasis words). Words not in the
 * set are `emphasis: false`. The active-word karaoke highlight is independent of
 * this flag — it comes from the per-word start/end timings the renderer reads.
 *
 * @param words           the transcript words, in order, with timings
 * @param emphasisIndices 0-based indices into `words` to mark emphasis (optional)
 */
export function buildSubtitleEvents(
  words: TimedWord[],
  emphasisIndices?: Set<number>,
): SubtitleEvent[] {
  const groups = chunkCaptionWords(words);
  let globalWordIndex = 0;
  return groups.map((group) => ({
    start: group[0].start,
    end: group[group.length - 1].end,
    words: group.map((w) => {
      const emphasis = emphasisIndices ? emphasisIndices.has(globalWordIndex) : false;
      globalWordIndex++;
      return { text: w.word, start: w.start, end: w.end, emphasis };
    }),
  }));
}
