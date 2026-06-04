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
 *
 * AUDIO-ENERGY AWARENESS. Whisper word timestamps are loose, so transcript-only
 * boundaries used to drift INTO real speech (clipping word onsets/tails) and
 * miss dead air the transcript smeared over. When the caller supplies measured
 * silent regions (from `detectSilences`, a single whole-file ffmpeg
 * `silencedetect` pass), the planner:
 *   1. SNAPS every keep boundary OUTWARD to the nearest true-silence region, so
 *      an edge can never land inside audible speech (fixes "words cut off").
 *   2. REMOVES genuine silent regions even where Whisper put words loosely
 *      around them (fixes "unnecessary talk kept").
 * It stays conservative-by-default and exposes an `aggressiveness` knob, and it
 * emits a per-region diagnostics breakdown for debugging on the server.
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

/** A measured low-energy region of the source audio (from silencedetect). */
export interface SilenceRegion {
  start: number;
  end: number;
  thresholdDb: number;
}

/** How much non-speech to cut. Affects silence thresholds + min-keep gaps. */
export type Aggressiveness = "gentle" | "balanced" | "aggressive";

/** A single kept/removed region in the final plan, with why + measured energy. */
export interface CutDiagnostic {
  start: number;
  end: number;
  kind: "keep" | "silence" | "filler" | "stutter" | "take";
  reason: string;
  /** Measured silencedetect threshold (dBFS) when the region was audio-confirmed. */
  measuredDb?: number;
  /** True when a boundary was snapped to a real silent region (not the transcript). */
  audioConfirmed?: boolean;
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
  /**
   * Measured low-energy regions from a whole-file `silencedetect` pass. When
   * present, keep boundaries are snapped to real silence and dead air the
   * transcript missed is removed. When absent, the planner falls back to the
   * (transcript-only) behaviour unchanged.
   */
  silences?: SilenceRegion[];
  /**
   * How much non-speech to cut. Presets tune the silence trigger, the minimum
   * removable span, and the keep-pad. Default "balanced".
   */
  aggressiveness?: Aggressiveness;
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
  /**
   * Per-region breakdown (kept + removed) with reason and measured energy.
   * Persisted on the cut record + logged so a misfiring region can be pinpointed.
   */
  diagnostics: CutDiagnostic[];
  /** How many keep boundaries were snapped outward to real silence. */
  boundariesSnapped: number;
}

/**
 * Aggressiveness presets. More aggressive = quieter pieces removed (a higher,
 * i.e. less-negative, noise floor catches low-energy mumble), a shorter trigger
 * and min-removable span, and a tighter keep-pad. Gentle is the safe default's
 * conservative cousin: only obvious dead air goes.
 */
interface AggressionPreset {
  silenceThreshold: number;
  minSilence: number;
  pauseStub: number;
  keepPad: number;
  /** Noise floor (dBFS) for the silencedetect pass this run should use. */
  noiseFloorDb: number;
}

export const AGGRESSION_PRESETS: Record<Aggressiveness, AggressionPreset> = {
  gentle:     { silenceThreshold: 0.60, minSilence: 0.45, pauseStub: 0.22, keepPad: 0.15, noiseFloorDb: -38 },
  balanced:   { silenceThreshold: 0.45, minSilence: 0.30, pauseStub: 0.18, keepPad: 0.12, noiseFloorDb: -32 },
  aggressive: { silenceThreshold: 0.30, minSilence: 0.18, pauseStub: 0.12, keepPad: 0.09, noiseFloorDb: -28 },
};

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

/** Normalize + merge measured silence regions to clean, ordered intervals. */
function normalizeSilences(silences: SilenceRegion[] | undefined, duration: number): SilenceRegion[] {
  if (!silences || silences.length === 0) return [];
  const valid = silences
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end), thresholdDb: s.thresholdDb }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: SilenceRegion[] = [];
  for (const s of valid) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 0.001) {
      last.end = Math.max(last.end, s.end);
      last.thresholdDb = Math.max(last.thresholdDb, s.thresholdDb);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** The silence region containing time `t` (within `slop`), if any. */
function silenceAt(silences: SilenceRegion[], t: number, slop = 0.02): SilenceRegion | null {
  for (const s of silences) {
    if (t >= s.start - slop && t <= s.end + slop) return s;
  }
  return null;
}

/**
 * Snap a keep boundary OUTWARD to true silence so a kept edge never sits inside
 * audible speech. For a LEFT edge we pull the keep start earlier into the
 * silence that precedes the first word (toward its end, leaving a small pad);
 * for a RIGHT edge we push the keep end later into the silence that follows the
 * last word. If the transcript edge is already inside a silent region we trust
 * it; otherwise we expand to the nearest silence boundary within `reach`.
 * Returns the snapped time + whether it moved (audio-confirmed).
 */
function snapEdge(
  t: number,
  side: "left" | "right",
  silences: SilenceRegion[],
  pad: number,
  reach: number,
): { t: number; snapped: boolean; db?: number } {
  // Already inside a measured silence → the edge is safe; tuck a pad inside it.
  const here = silenceAt(silences, t);
  if (here) {
    if (side === "left") {
      const target = Math.min(t, here.end - pad);
      return { t: Math.max(here.start, target), snapped: false, db: here.thresholdDb };
    }
    const target = Math.max(t, here.start + pad);
    return { t: Math.min(here.end, target), snapped: false, db: here.thresholdDb };
  }
  // Edge is inside (apparent) speech → expand outward to the nearest silence.
  if (side === "left") {
    // Nearest silence that ENDS at or before t, within reach.
    let best: SilenceRegion | null = null;
    for (const s of silences) {
      if (s.end <= t + reach && s.end >= t - reach) {
        if (!best || s.end > best.end) best = s;
      }
    }
    if (best) return { t: Math.max(best.start, best.end - pad), snapped: true, db: best.thresholdDb };
  } else {
    // Nearest silence that STARTS at or after t, within reach.
    let best: SilenceRegion | null = null;
    for (const s of silences) {
      if (s.start >= t - reach && s.start <= t + reach) {
        if (!best || s.start < best.start) best = s;
      }
    }
    if (best) return { t: Math.min(best.end, best.start + pad), snapped: true, db: best.thresholdDb };
  }
  return { t, snapped: false };
}

export function planCuts(
  words: PlanWord[],
  duration: number,
  opts: PlanOptions = {},
): CutPlan {
  const preset = AGGRESSION_PRESETS[opts.aggressiveness ?? "balanced"];
  const SIL = opts.silenceThreshold ?? preset.silenceThreshold;
  const MIN_SIL = opts.minSilence ?? preset.minSilence;
  const STUB = opts.pauseStub ?? preset.pauseStub;
  const PAD = opts.keepPad ?? preset.keepPad;
  const removeFillers = opts.removeFillers ?? true;
  const removeStutters = opts.removeStutters ?? true;
  const silences = normalizeSilences(opts.silences, duration);

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
    diagnostics: [{ start: 0, end: duration, kind: "keep", reason: "whole clip (no usable transcript)" }],
    boundariesSnapped: 0,
  };
  // No usable transcript → keep the whole clip untouched.
  if (valid.length === 0 || duration <= 0) return fullClip;

  // Each cut carries its reason + measured energy so we can emit diagnostics.
  type Cut = Segment & { kind: CutDiagnostic["kind"]; reason: string; measuredDb?: number };
  const cuts: Cut[] = [];
  let silenceCuts = 0;
  let fillerCuts = 0;
  let stutterCuts = 0;

  // The deepest (most-negative) measured floor in a span, for diagnostics.
  const dbWithin = (a: number, b: number): number | undefined => {
    let db: number | undefined;
    for (const s of silences) {
      if (s.start < b && s.end > a) db = db == null ? s.thresholdDb : Math.min(db, s.thresholdDb);
    }
    return db;
  };

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
    const measuredDb = dbWithin(gapStart, gapEnd);
    if (keepStub) {
      // Remove the middle, leaving PAD+½stub of room next to each word.
      const cutStart = gapStart + PAD + STUB / 2;
      const cutEnd = gapEnd - PAD - STUB / 2;
      if (cutEnd > cutStart) { cuts.push({ start: cutStart, end: cutEnd, kind: "silence", reason: "inter-word pause", measuredDb }); return true; }
    } else {
      // Leading/trailing dead air: cut all but a PAD of room next to the word.
      const cutStart = gapStart;
      const cutEnd = gapEnd - PAD; // (trailing) or gapStart..word-PAD (leading)
      if (cutEnd > cutStart) { cuts.push({ start: cutStart, end: cutEnd, kind: "silence", reason: "edge dead air", measuredDb }); return true; }
    }
    return false;
  };

  // 1. Leading dead air before the first word — cut down to a PAD of room.
  if (valid[0].start > SIL) {
    const cutEnd = valid[0].start - PAD;
    if (cutEnd > MIN_SIL) { cuts.push({ start: 0, end: cutEnd, kind: "silence", reason: "leading dead air", measuredDb: dbWithin(0, valid[0].start) }); silenceCuts++; }
  }

  // 2. Gaps between consecutive words — keep a natural pause stub.
  for (let i = 0; i < valid.length - 1; i++) {
    if (trimGap(valid[i].end, valid[i + 1].start, true)) silenceCuts++;
  }

  // 3. Trailing dead air after the last word.
  const last = valid[valid.length - 1];
  if (duration - last.end > SIL) {
    const cutStart = last.end + PAD;
    if (duration - cutStart > MIN_SIL) { cuts.push({ start: cutStart, end: duration, kind: "silence", reason: "trailing dead air", measuredDb: dbWithin(last.end, duration) }); silenceCuts++; }
  }

  // 3b. AUDIO-DRIVEN dead air the transcript missed. Whisper sometimes smears a
  // word over a real pause, or transcribes low-energy non-speech (breaths,
  // mumbles) as words, so a transcript-only gap scan never sees it. Walk the
  // MEASURED silent regions and cut any long enough one that the transcript-gap
  // pass didn't already remove — minus a keep-pad each side so adjacent word
  // onsets/tails survive. This directly removes "unnecessary talk kept".
  for (const s of silences) {
    const removable = (s.end - s.start) - 2 * PAD;
    if (removable < MIN_SIL) continue;
    const cutStart = s.start + PAD;
    const cutEnd = s.end - PAD;
    // Only if not already substantially covered by a transcript-derived cut.
    const already = cuts.some((c) => c.kind === "silence" && c.start <= cutStart + 0.05 && c.end >= cutEnd - 0.05);
    if (!already && cutEnd > cutStart) {
      cuts.push({ start: cutStart, end: cutEnd, kind: "silence", reason: "audio-detected dead air", measuredDb: s.thresholdDb });
      silenceCuts++;
    }
  }

  // 4. Filler words — cut each one fully (tiny pad to swallow the breath/click).
  if (removeFillers) {
    for (const w of valid) {
      if (isFiller(w.word)) {
        cuts.push({ start: Math.max(0, w.start - 0.02), end: Math.min(duration, w.end + 0.06), kind: "filler", reason: `filler "${w.word.trim()}"`, measuredDb: dbWithin(w.start, w.end) });
        fillerCuts++;
      }
    }
  }

  // 5. Stutters / false-start word repeats — collapse to the clean final word.
  if (removeStutters) {
    const stut = findStutterCuts(valid, 0.02);
    for (const c of stut) {
      cuts.push({ start: Math.max(0, c.start), end: Math.min(duration, c.end), kind: "stutter", reason: "stutter / false start" });
      stutterCuts++;
    }
  }

  // 6. Caller-supplied forced cuts (losing duplicate takes).
  if (opts.extraCuts) {
    for (const c of opts.extraCuts) {
      if (Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start) {
        cuts.push({ start: Math.max(0, c.start), end: Math.min(duration, c.end), kind: "take", reason: "losing duplicate take" });
      }
    }
  }

  if (cuts.length === 0) return { ...fullClip, diagnostics: [{ start: 0, end: duration, kind: "keep", reason: "nothing to cut" }] };

  // Bridge cuts that are within a sliver of each other so we don't leave a
  // glitchy sub-0.12s scrap of dead air between, say, a trimmed pause and an
  // adjacent filler removal. Such a scrap is far too short to hold real speech.
  // We carry the reason/energy of the dominant (longest) merged piece forward.
  const SLIVER = 0.12;
  const mergedCuts = mergeCutsWithReason(cuts, SLIVER).filter((c) => c.end > c.start);
  // Keep = everything not cut. Drop ultra-short slivers that would just cause
  // glitchy micro-cuts, and merge keep-segments that end up touching.
  let keep = invert(mergedCuts, duration).filter((k) => k.end - k.start > 0.05);
  keep = mergeSegments(keep, 0.001);

  // 7. SNAP keep boundaries to true silence. Whisper word ends/starts are loose,
  // so a keep edge derived from them can sit INSIDE audible speech and clip a
  // word's onset/tail. When the audio disagrees we trust the audio: expand the
  // keep edge outward to the nearest measured silent region (within reach), so
  // an edge always lands in real low energy. This fixes "words cut off".
  let boundariesSnapped = 0;
  if (silences.length > 0) {
    const REACH = Math.max(0.25, SIL); // how far we'll hunt for a silent edge
    for (let i = 0; i < keep.length; i++) {
      const k = keep[i];
      // Don't snap an edge that is the very start/end of the clip.
      if (k.start > 0.001) {
        const r = snapEdge(k.start, "left", silences, Math.min(PAD, 0.05), REACH);
        if (r.snapped) { boundariesSnapped++; k.start = Math.min(k.start, r.t); }
      }
      if (k.end < duration - 0.001) {
        const r = snapEdge(k.end, "right", silences, Math.min(PAD, 0.05), REACH);
        if (r.snapped) { boundariesSnapped++; k.end = Math.max(k.end, r.t); }
      }
    }
    // Snapping can make neighbours overlap/touch; re-merge to stay clean.
    keep = mergeSegments(keep.filter((k) => k.end > k.start), 0.001);
  }

  // Safety: if planning somehow removed (almost) everything, keep the original.
  const keptDuration = keep.reduce((s, k) => s + (k.end - k.start), 0);
  if (keep.length === 0 || keptDuration < Math.min(1, duration * 0.2)) {
    return { ...fullClip, diagnostics: [{ start: 0, end: duration, kind: "keep", reason: "safety floor (plan removed too much)" }] };
  }

  return {
    keep,
    originalDuration: duration,
    keptDuration,
    removedDuration: Math.max(0, duration - keptDuration),
    silenceCuts,
    fillerCuts,
    stutterCuts,
    diagnostics: buildDiagnostics(keep, mergedCuts, duration, boundariesSnapped),
    boundariesSnapped,
  };
}

/** Merge overlapping/touching cuts, carrying the longest piece's reason/energy. */
function mergeCutsWithReason<T extends Segment & { kind: CutDiagnostic["kind"]; reason: string; measuredDb?: number }>(
  cuts: T[],
  bridge: number,
): T[] {
  if (cuts.length === 0) return [];
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out: T[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end + bridge) {
      // Adopt the longer piece's label so the diagnostic reads as the dominant reason.
      if ((cur.end - cur.start) > (last.end - last.start)) {
        last.kind = cur.kind; last.reason = cur.reason;
      }
      if (cur.measuredDb != null) last.measuredDb = last.measuredDb == null ? cur.measuredDb : Math.min(last.measuredDb, cur.measuredDb);
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** Interleave kept + removed regions into one ordered, human-readable timeline. */
function buildDiagnostics(
  keep: Segment[],
  cuts: Array<Segment & { kind: CutDiagnostic["kind"]; reason: string; measuredDb?: number }>,
  duration: number,
  boundariesSnapped: number,
): CutDiagnostic[] {
  const items: CutDiagnostic[] = [];
  for (const k of keep) items.push({ start: round3(k.start), end: round3(k.end), kind: "keep", reason: "kept speech" });
  for (const c of cuts) {
    items.push({
      start: round3(c.start),
      end: round3(c.end),
      kind: c.kind,
      reason: c.reason,
      ...(c.measuredDb != null ? { measuredDb: round1(c.measuredDb), audioConfirmed: true } : {}),
    });
  }
  items.sort((a, b) => a.start - b.start || (a.kind === "keep" ? -1 : 1));
  if (boundariesSnapped > 0 && items.length > 0) {
    items[0] = { ...items[0], reason: `${items[0].reason} (+${boundariesSnapped} boundaries snapped to silence)` };
  }
  return items;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;
