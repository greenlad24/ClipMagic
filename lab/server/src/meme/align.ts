/**
 * Word-level TIMELINE ALIGNMENT for the Meme/Sticker editor.
 *
 * THE BUG THIS FIXES: the emphasis director was handed `transcript.text` — a
 * plain wall of words with NO timings — and asked to return `startTime` in
 * seconds. It had nothing to compute those from, so it estimated them from
 * reading speed. The stickers therefore landed *near* the right line but rarely
 * ON the word being said, drifting further the longer the video ran. That is the
 * "not fully synced with what's being said" the user sees.
 *
 * THE FIX, in two halves — a better input and a guarantee in code:
 *
 *  1. GIVE THE DIRECTOR REAL CLOCK TIMES. `formatTimedTranscript` renders the
 *     transcript as short timestamped lines ("[12.4s] ten times faster than"),
 *     so its picks start out anchored to the actual audio instead of guessed.
 *
 *  2. SNAP THE ANSWER TO THE WORDS ANYWAY. `alignMoments` ignores the model's
 *     arithmetic and re-derives each start from the transcript itself: it finds
 *     the moment's own `phrase` in the word-level timestamps and pins the
 *     sticker to that word's onset. This is the same "restraint is GUARANTEED IN
 *     CODE" stance as director.sanitize() — sync no longer depends on the model
 *     getting mental arithmetic right, only on it quoting a phrase from the
 *     script, which it must do anyway.
 *
 * Everything here is PURE (no I/O, no clock) so the matching, the tolerances and
 * the fallbacks are all unit-testable against fixed word lists.
 */
import type { TranscriptWord } from "../ai/transcribe.js";

/**
 * How far BEFORE the spoken word the sticker starts. The Remotion pop takes
 * ~0.2s to reach full size, so a small lead means the sticker is fully on screen
 * as the word lands, rather than starting to appear after it has passed.
 */
export const LEAD_SECONDS = 0.12;

/**
 * How long the sticker stays after the phrase finishes. The director's own hold
 * clamp (1.5–2.5s in sanitize) still applies on top; this just makes the window
 * start from the phrase rather than from a guess.
 */
export const HOLD_AFTER_SECONDS = 1.0;

/**
 * Fraction of the phrase's words that must match for an alignment to count.
 * 0.6 tolerates the usual ASR drift ("ten times" vs "10 times", a dropped
 * article) while refusing a window that merely shares a common word.
 */
export const MATCH_THRESHOLD = 0.6;

/**
 * When the phrase can't be found at all, we still nudge the model's guessed time
 * onto the nearest word ONSET, but only within this window — beyond it the guess
 * is too far gone to trust and is left exactly as the director wrote it.
 */
export const MAX_SNAP_DRIFT_SECONDS = 1.25;

/** Lowercase, strip punctuation/possessives — the comparison form of a word. */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Split a phrase into its comparable tokens (empties dropped). */
export function phraseTokens(phrase: string): string[] {
  return phrase.split(/\s+/).map(normalizeToken).filter((t) => t.length > 0);
}

/**
 * Do two tokens refer to the same word? Exact match, or a prefix match once both
 * are long enough — that absorbs the plural/tense drift between what the speaker
 * said and how the director quoted it ("number" vs "numbers") without letting
 * short words match each other loosely.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  return min >= 4 && (a.startsWith(b) || b.startsWith(a));
}

export interface PhraseWindow {
  /** Start of the first matched word, seconds. */
  start: number;
  /** End of the last matched word, seconds. */
  end: number;
  /** Fraction of the phrase's tokens that matched (0..1). */
  score: number;
  /** Index of the first matched word in the transcript (debug). */
  index: number;
}

/**
 * Locate a phrase in the word-level transcript and return its real time window.
 *
 * Slides a window the length of the phrase across the words and scores each
 * position by how many tokens line up. When a phrase genuinely repeats in the
 * script (common — a hook line echoed in the CTA), `hintSeconds` breaks the tie
 * toward the occurrence the director meant: equal-scoring windows are ranked by
 * distance from its guess. Returns null when nothing clears MATCH_THRESHOLD.
 */
export function findPhraseWindow(
  words: TranscriptWord[],
  phrase: string,
  hintSeconds?: number,
): PhraseWindow | null {
  const tokens = phraseTokens(phrase || "");
  if (tokens.length === 0 || words.length === 0) return null;

  const wordTokens = words.map((w) => normalizeToken(w.word));
  const span = Math.min(tokens.length, words.length);
  let best: PhraseWindow | null = null;
  let bestDistance = Infinity;

  for (let i = 0; i + span <= words.length; i++) {
    let matched = 0;
    for (let j = 0; j < span; j++) {
      if (tokensMatch(wordTokens[i + j], tokens[j])) matched++;
    }
    const score = matched / tokens.length;
    if (score < MATCH_THRESHOLD) continue;

    const start = words[i].start;
    const distance = hintSeconds === undefined ? 0 : Math.abs(start - hintSeconds);
    // Prefer the better match; among equals prefer the one nearest the hint.
    const better =
      !best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && distance < bestDistance);
    if (better) {
      best = { start, end: words[i + span - 1].end, score, index: i };
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Move a time onto the nearest word ONSET, within MAX_SNAP_DRIFT_SECONDS.
 * The weak fallback for a moment whose phrase we couldn't find: even unmatched,
 * a sticker that pops on a word boundary reads as deliberate, where one that
 * pops mid-syllable reads as broken. Returns null when nothing is near enough.
 */
export function snapToWordStart(
  words: TranscriptWord[],
  t: number,
  maxDrift = MAX_SNAP_DRIFT_SECONDS,
): number | null {
  let best: number | null = null;
  let bestDrift = Infinity;
  for (const w of words) {
    const drift = Math.abs(w.start - t);
    if (drift < bestDrift) {
      bestDrift = drift;
      best = w.start;
    }
  }
  return best !== null && bestDrift <= maxDrift ? best : null;
}

/**
 * Render the transcript as timestamped lines for the director's prompt.
 *
 * Grouped into short runs of words (one clock stamp each) rather than one stamp
 * per word: a per-word list triples the prompt for no gain, while a line every
 * ~2s gives the model an anchor it can read off directly. It also breaks a line
 * on a long pause, so the stamps track the natural phrasing of the delivery.
 */
export function formatTimedTranscript(
  words: TranscriptWord[],
  opts: { wordsPerLine?: number; pauseBreakSeconds?: number } = {},
): string {
  const perLine = Math.max(2, opts.wordsPerLine ?? 8);
  const pauseBreak = opts.pauseBreakSeconds ?? 0.6;
  const lines: string[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    lines.push(`[${current[0].start.toFixed(1)}s] ${current.map((w) => w.word).join(" ").trim()}`);
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (prev && w.start - prev.end >= pauseBreak) flush();
    current.push(w);
    if (current.length >= perLine) flush();
  }
  flush();
  return lines.join("\n");
}

/** A moment's timing after alignment, plus HOW it was arrived at (for logs). */
export type AlignmentKind = "phrase" | "snapped" | "kept";

export interface AlignedTiming {
  startTime: number;
  endTime: number;
  kind: AlignmentKind;
  /** Match score when kind === "phrase" (0..1). */
  score?: number;
  /** Seconds the moment moved from where the director put it. */
  shift: number;
}

/**
 * Re-derive ONE moment's window from the transcript.
 *
 * Order of preference:
 *   • "phrase"  — the moment's quoted phrase was found: pin to that word's onset
 *                 (minus the pop lead) and run to the phrase's end plus a beat.
 *   • "snapped" — no phrase match, but the guessed time sits near a word onset:
 *                 keep the length, move the start onto that onset.
 *   • "kept"    — nothing to align to; the director's own timing stands.
 */
export function alignTiming(
  words: TranscriptWord[],
  moment: { startTime: number; endTime?: number; phrase?: string },
): AlignedTiming {
  const rawStart = moment.startTime;
  const rawEnd = Number.isFinite(moment.endTime as number) && (moment.endTime as number) > rawStart
    ? (moment.endTime as number)
    : rawStart + 1.8;
  const length = rawEnd - rawStart;

  const window = moment.phrase ? findPhraseWindow(words, moment.phrase, rawStart) : null;
  if (window) {
    const startTime = Math.max(0, window.start - LEAD_SECONDS);
    return {
      startTime,
      endTime: Math.max(startTime + 0.6, window.end + HOLD_AFTER_SECONDS),
      kind: "phrase",
      score: window.score,
      shift: Math.abs(startTime - rawStart),
    };
  }

  const snapped = snapToWordStart(words, rawStart);
  if (snapped !== null) {
    const startTime = Math.max(0, snapped - LEAD_SECONDS);
    return { startTime, endTime: startTime + length, kind: "snapped", shift: Math.abs(startTime - rawStart) };
  }

  return { startTime: rawStart, endTime: rawEnd, kind: "kept", shift: 0 };
}

/** Counts of how the run's moments were aligned — logged, and surfaced to the UI. */
export interface AlignmentSummary {
  phrase: number;
  snapped: number;
  kept: number;
  /** Largest correction applied, seconds (how far out the guess had drifted). */
  maxShift: number;
}

/**
 * Align a whole director payload against the word timings, IN PLACE of its
 * guessed times, returning the moments in the same raw shape `sanitize()`
 * consumes (so spacing, hold clamping and the head/tail buffers still run over
 * the corrected times, not the guessed ones).
 *
 * Never throws and never drops a moment: a moment that can't be aligned keeps
 * exactly the timing the director gave it.
 */
export function alignMoments(
  raw: unknown,
  words: TranscriptWord[],
): { moments: unknown[]; summary: AlignmentSummary } {
  const arr = Array.isArray((raw as { moments?: unknown })?.moments)
    ? (raw as { moments: unknown[] }).moments
    : [];
  const summary: AlignmentSummary = { phrase: 0, snapped: 0, kept: 0, maxShift: 0 };
  if (words.length === 0) {
    // Nothing to align against — hand the payload straight through untouched.
    summary.kept = arr.length;
    return { moments: arr, summary };
  }

  const moments = arr.map((item) => {
    const m = (item ?? {}) as Record<string, unknown>;
    const startTime = Number(m.startTime);
    if (!Number.isFinite(startTime)) return item; // sanitize() will drop it
    const timing = alignTiming(words, {
      startTime,
      endTime: Number(m.endTime),
      phrase: typeof m.phrase === "string" ? m.phrase : undefined,
    });
    summary[timing.kind]++;
    summary.maxShift = Math.max(summary.maxShift, timing.shift);
    return {
      ...m,
      startTime: Number(timing.startTime.toFixed(3)),
      endTime: Number(timing.endTime.toFixed(3)),
      alignedTo: timing.kind,
    };
  });

  return { moments, summary };
}
