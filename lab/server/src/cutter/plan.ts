/**
 * Narration-cut planner (Phase 1, deterministic).
 *
 * Given word-level transcript timestamps, decide which parts of the clip to
 * KEEP. Two kinds of removals:
 *   1. Silence / dead air: any gap between spoken words longer than
 *      `silenceThreshold` (default 0.35s) is cut down to a short, natural pause
 *      (a small pad is kept on each side so words aren't clipped).
 *   2. Filler words: hesitation tokens ("um", "uh" and close variants) are cut
 *      out entirely, wherever they occur. We deliberately do NOT touch "so",
 *      "like" or "you know" — those are usually real sentence words.
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
  /** Gap (s) between words above which the silence is trimmed. Default 0.35. */
  silenceThreshold?: number;
  /** Breathing room (s) kept on each side of retained speech. Default 0.08. */
  keepPad?: number;
  /** Remove um/uh fillers. Default true. */
  removeFillers?: boolean;
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
}

// Hesitation fillers only — "um", "uh" and their close spelling variants. These
// are matched against the punctuation-stripped, lower-cased token, so "Um,"
// and "uh..." both match. We intentionally exclude so/like/you-know.
const FILLERS = new Set([
  "um", "umm", "ummm", "uhm", "uhmm",
  "uh", "uhh", "uhhh", "er", "err", "erm", "ehm",
]);

function normalizeToken(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function isFiller(word: string): boolean {
  return FILLERS.has(normalizeToken(word));
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
  const SIL = opts.silenceThreshold ?? 0.35;
  const PAD = opts.keepPad ?? 0.08;
  const removeFillers = opts.removeFillers ?? true;

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
  };
  // No usable transcript → keep the whole clip untouched.
  if (valid.length === 0 || duration <= 0) return fullClip;

  const cuts: Segment[] = [];
  let silenceCuts = 0;
  let fillerCuts = 0;

  // 1. Leading dead air before the first word.
  if (valid[0].start > SIL) {
    cuts.push({ start: 0, end: valid[0].start - PAD });
    silenceCuts++;
  }

  // 2. Gaps between consecutive words.
  for (let i = 0; i < valid.length - 1; i++) {
    const gap = valid[i + 1].start - valid[i].end;
    if (gap > SIL) {
      cuts.push({ start: valid[i].end + PAD, end: valid[i + 1].start - PAD });
      silenceCuts++;
    }
  }

  // 3. Trailing dead air after the last word.
  const last = valid[valid.length - 1];
  if (duration - last.end > SIL) {
    cuts.push({ start: last.end + PAD, end: duration });
    silenceCuts++;
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

  // 5. Caller-supplied forced cuts (losing duplicate takes).
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
  };
}
