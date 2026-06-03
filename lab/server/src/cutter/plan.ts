/**
 * Narration-cut planner (Phase 1, deterministic).
 *
 * Given word-level transcript timestamps, decide which parts of the clip to
 * KEEP. Removals are conservative-by-default — we never aggressively delete
 * real speech. Four kinds:
 *   1. Silence / dead air: a gap between spoken words is trimmed only when it
 *      is both long enough to trigger (`silenceThreshold`) AND the dead span is
 *      at least `minSilence` long, so natural mid-sentence micro-pauses survive.
 *      A short, natural pause stub is left in place of a long pause (we don't
 *      butt-join words — that sounds robotic), and a generous keep-pad protects
 *      word onsets/tails and breaths from being clipped.
 *   2. Filler words: hesitation tokens ("um", "uh" and close variants) are cut
 *      out entirely. We deliberately do NOT touch "so", "like" or "you know" —
 *      those are usually real sentence words.
 *   3. Stutters / false starts: an immediately-repeated word ("the the cat",
 *      "I-I-I think") is collapsed to its final, clean utterance — only when the
 *      repeats are tightly adjacent, so genuine rhetorical repetition survives.
 *   4. Caller-supplied forced cuts (e.g. losing duplicate takes).
 *
 * The output is a list of keep-segments (in source time) whose concatenation is
 * the tightened clip. Pure + side-effect free so it can be unit-tested.
 */

export interface PlanWord {
  word: string;
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
}

export interface PlanOptions {
  /** Gap (s) between words above which a silence is *eligible* to be trimmed. Default 0.45. */
  silenceThreshold?: number;
  /**
   * Minimum length (s) of dead air to actually remove. A gap can exceed the
   * threshold but still be left if the removable span (gap minus the pauseStub
   * and pads) is below this — avoids choppy micro-cuts. Default 0.30.
   */
  minSilence?: number;
  /**
   * Natural pause (s) preserved in place of a trimmed silence so words don't
   * butt-join. Leading/trailing dead air is removed fully (no stub). Default 0.18.
   */
  pauseStub?: number;
  /** Breathing room (s) kept on each side of retained speech. Default 0.12. */
  keepPad?: number;
  /** Remove um/uh fillers. Default true. */
  removeFillers?: boolean;
  /** Collapse immediate stutters / false-start word repeats. Default true. */
  removeStutters?: boolean;
  /** Extra forced-cut ranges (e.g. losing duplicate takes) to also remove. */
  extraCuts?: Segment[];
}

export interface CutPlan {
  keep: Segment[];
  /** Stats for reporting in the UI. */
  originalDuration: number;
  keptDuration: number;
  removedDuration: number;
  silenceCuts: number;
  fillerCuts: number;
  stutterCuts: number;
}

// Hesitation fillers only — "um", "uh" and their close spelling variants. These
// are matched against the punctuation-stripped, lower-cased token, so "Um,"
// and "uh..." both match. We intentionally exclude so/like/you-know.
const FILLERS = new Set([
  "um", "umm", "ummm", "uhm", "uhmm",
  "uh", "uhh", "uhhh", "er", "err", "erm", "ehm",
  // Non-lexical hesitations. "mm"/"mhm"/"hmm" are pure thinking-sounds in raw
  // narration (never real words), so they're safe to trim alongside um/uh.
  "mm", "mmm", "mhm", "hmm", "hmmm", "huh",
]);

function normalizeToken(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function isFiller(word: string): boolean {
  return FILLERS.has(normalizeToken(word));
}

// Words that are commonly, legitimately repeated for emphasis or as part of a
// phrase ("very very", "no no no", "so so"). Excluded from stutter collapsing so
// intentional rhetorical repetition is preserved.
const EMPHATIC_REPEATS = new Set(["very", "no", "so", "really", "yes", "way", "way,"]);

/**
 * Find immediate stutter / false-start repeats to remove. A run of the SAME
 * normalized token where each repeat starts within `maxGap` of the previous
 * one's end is treated as a stutter; we keep the LAST occurrence (the clean
 * one the speaker settled on) and cut the earlier fragments. Conservative:
 * only tight, adjacent repeats — never words separated by other words, and
 * never emphatic repeats.
 */
function findStutterCuts(words: PlanWord[], pad: number, maxGap = 0.5): Segment[] {
  const cuts: Segment[] = [];
  let i = 0;
  while (i < words.length - 1) {
    const tok = normalizeToken(words[i].word);
    if (!tok || EMPHATIC_REPEATS.has(tok)) { i++; continue; }
    // Extend a run of the same token while each is tightly adjacent.
    let j = i;
    while (
      j + 1 < words.length &&
      normalizeToken(words[j + 1].word) === tok &&
      words[j + 1].start - words[j].end <= maxGap
    ) {
      j++;
    }
    if (j > i) {
      // Repeats words[i..j-1] are dropped; words[j] (the last) is kept.
      const start = Math.max(0, words[i].start - pad);
      const end = words[j].start - pad; // cut up to just before the kept word
      if (end > start) cuts.push({ start, end });
      i = j + 1;
    } else {
      i++;
    }
  }
  return cuts;
}

/** Merge overlapping/touching segments (sorted by start). */
function mergeSegments(segs: Segment[], bridge = 0): Segment[] {
  if (segs.length === 0) return [];
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: Segment[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i].start <= last.end + bridge) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      out.push({ ...sorted[i] });
    }
  }
  return out;
}

/** Complement of `cuts` over [0, duration]. */
function invert(cuts: Segment[], duration: number): Segment[] {
  const keep: Segment[] = [];
  let cursor = 0;
  for (const c of cuts) {
    const start = Math.max(0, c.start);
    const end = Math.min(duration, c.end);
    if (start > cursor) keep.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });
  return keep;
}

export function planCuts(
  words: PlanWord[],
  duration: number,
  opts: PlanOptions = {},
): CutPlan {
  const SIL = opts.silenceThreshold ?? 0.45;
  const MIN_SIL = opts.minSilence ?? 0.30;
  const STUB = opts.pauseStub ?? 0.18;
  const PAD = opts.keepPad ?? 0.12;
  const removeFillers = opts.removeFillers ?? true;
  const removeStutters = opts.removeStutters ?? true;

  // Use only words with sane timestamps, in order.
  const valid = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const fullClip: CutPlan = {
    keep: [{ start: 0, end: duration }],
    originalDuration: duration,
    keptDuration: duration,
    removedDuration: 0,
    silenceCuts: 0,
    fillerCuts: 0,
    stutterCuts: 0,
  };
  // No usable transcript → keep the whole clip untouched.
  if (valid.length === 0 || duration <= 0) return fullClip;

  const cuts: Segment[] = [];
  let silenceCuts = 0;
  let fillerCuts = 0;
  let stutterCuts = 0;

  // Helper: trim an inter-word silence of `gapStart..gapEnd`, keeping a natural
  // pause stub centered in the original gap so words never butt-join. Returns
  // true if a cut was actually recorded.
  const trimGap = (gapStart: number, gapEnd: number, keepStub: boolean): boolean => {
    const gap = gapEnd - gapStart;
    if (gap <= SIL) return false;
    // The removable interior after reserving pads on each side (+ a stub if we
    // keep one mid-clip). If too little is removable, leave the pause natural.
    const reserved = (keepStub ? STUB : 0) + (keepStub ? 2 * PAD : PAD);
    const removable = gap - reserved;
    if (removable < MIN_SIL) return false;
    if (keepStub) {
      // Remove the middle, leaving PAD+½stub of room next to each word.
      const cutStart = gapStart + PAD + STUB / 2;
      const cutEnd = gapEnd - PAD - STUB / 2;
      if (cutEnd > cutStart) { cuts.push({ start: cutStart, end: cutEnd }); return true; }
    } else {
      // Leading/trailing dead air: cut all but a PAD of room next to the word.
      const cutStart = gapStart;
      const cutEnd = gapEnd - PAD; // (trailing) or gapStart..word-PAD (leading)
      if (cutEnd > cutStart) { cuts.push({ start: cutStart, end: cutEnd }); return true; }
    }
    return false;
  };

  // 1. Leading dead air before the first word — cut down to a PAD of room.
  if (valid[0].start > SIL) {
    const cutEnd = valid[0].start - PAD;
    if (cutEnd > MIN_SIL) { cuts.push({ start: 0, end: cutEnd }); silenceCuts++; }
  }

  // 2. Gaps between consecutive words — keep a natural pause stub.
  for (let i = 0; i < valid.length - 1; i++) {
    if (trimGap(valid[i].end, valid[i + 1].start, true)) silenceCuts++;
  }

  // 3. Trailing dead air after the last word.
  const last = valid[valid.length - 1];
  if (duration - last.end > SIL) {
    const cutStart = last.end + PAD;
    if (duration - cutStart > MIN_SIL) { cuts.push({ start: cutStart, end: duration }); silenceCuts++; }
  }

  // 4. Filler words — cut each one fully (tiny pad to swallow the breath/click).
  if (removeFillers) {
    for (const w of valid) {
      if (isFiller(w.word)) {
        cuts.push({ start: Math.max(0, w.start - 0.02), end: Math.min(duration, w.end + 0.06) });
        fillerCuts++;
      }
    }
  }

  // 5. Stutters / false-start word repeats — collapse to the clean final word.
  if (removeStutters) {
    const stut = findStutterCuts(valid, 0.02);
    for (const c of stut) {
      cuts.push({ start: Math.max(0, c.start), end: Math.min(duration, c.end) });
      stutterCuts++;
    }
  }

  // 6. Caller-supplied forced cuts (losing duplicate takes).
  if (opts.extraCuts) {
    for (const c of opts.extraCuts) {
      if (Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start) {
        cuts.push({ start: Math.max(0, c.start), end: Math.min(duration, c.end) });
      }
    }
  }

  if (cuts.length === 0) return fullClip;

  // Bridge cuts that are within a sliver of each other so we don't leave a
  // glitchy sub-0.12s scrap of dead air between, say, a trimmed pause and an
  // adjacent filler removal. Such a scrap is far too short to hold real speech.
  const SLIVER = 0.12;
  const mergedCuts = mergeSegments(cuts, SLIVER).filter((c) => c.end > c.start);
  // Keep = everything not cut. Drop ultra-short slivers that would just cause
  // glitchy micro-cuts, and merge keep-segments that end up touching.
  let keep = invert(mergedCuts, duration).filter((k) => k.end - k.start > 0.05);
  keep = mergeSegments(keep, 0.001);

  // Safety: if planning somehow removed (almost) everything, keep the original.
  const keptDuration = keep.reduce((s, k) => s + (k.end - k.start), 0);
  if (keep.length === 0 || keptDuration < Math.min(1, duration * 0.2)) return fullClip;

  return {
    keep,
    originalDuration: duration,
    keptDuration,
    removedDuration: Math.max(0, duration - keptDuration),
    silenceCuts,
    fillerCuts,
    stutterCuts,
  };
}
