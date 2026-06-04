/**
 * Narration Cutter — SHARED keep-segment math (preview ↔ render parity core).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for "given the edit settings, which
 * spans of the source do we keep?". It is intentionally dependency-free (no Node,
 * no ffmpeg, no DOM) so the EXACT same function can run:
 *   - in the browser, live, as the user drags the dB threshold / gap sliders and
 *     deletes takes (the interactive timeline editor), and
 *   - on the server, to render precisely what was previewed.
 *
 * An identical copy lives at `lab/src/lib/cutSegments.ts` for the frontend
 * bundle (the web app cannot import from the server tree). A parity test
 * (`scripts/cutter-parity.test.ts`) asserts the two stay byte-for-byte in sync
 * AND that this math agrees with the legacy `planCuts` for silence removal, so
 * "what you preview is what renders" is a tested guarantee, not a hope.
 *
 * The model is deliberately simpler and more PREDICTABLE than `planCuts`: the
 * user is now in direct control, so we derive keep-spans from a transparent,
 * explainable rule set they can see recompute live:
 *   1. Threshold the energy envelope at `silenceDb` to find low-energy frames.
 *   2. A run of low-energy frames ≥ `minSilence` long is a removable silence;
 *      we shrink it by `keepPad` on each side so word onsets/tails survive.
 *   3. The complement (over [0,duration]) is the kept "takes".
 *   4. Drop any take the user manually deleted (`deletedTakeIds`).
 *   5. The kept takes are spaced by a fixed `gap` (default 0.35s) at render — the
 *      gap is metadata on the plan, honored identically by preview and render.
 */

export interface Seg {
  start: number;
  end: number;
}

/** One frame of the dBFS energy envelope: dBFS value sampled every `hop` seconds. */
export interface Envelope {
  /** dBFS per frame (e.g. -60..0). -Infinity-safe: floored at `floorDb`. */
  db: number[];
  /** Seconds between frames (and the frame width). */
  hop: number;
  /** Total source duration in seconds. */
  duration: number;
}

export interface CutSettings {
  /** Silence floor in dBFS. Frames quieter than this are candidate silence. Default -32. */
  silenceDb: number;
  /** Minimum length (s) of continuous sub-threshold audio to remove. Default 0.5. */
  minSilence: number;
  /** Breathing room (s) kept on each side of speech (shrinks each silence). Default 0.12. */
  keepPad: number;
  /** Fixed spacing (s) inserted between kept takes at render. Default 0.35. */
  gap: number;
}

export const DEFAULT_SETTINGS: CutSettings = {
  silenceDb: -32,
  minSilence: 0.5,
  keepPad: 0.12,
  gap: 0.35,
};

/** A kept chunk of speech ("take"), with a stable id and optional transcript. */
export interface Take {
  /** Stable id derived from the take's rounded source start (survives re-threshold). */
  id: string;
  start: number;
  end: number;
  /** Transcript snippet (filled from word timings) shown on the block. */
  text: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A stable id for a take, keyed to where it begins in the source. */
export function takeId(start: number): string {
  return `t${Math.round(start * 100)}`;
}

/**
 * Find removable silence regions by thresholding the energy envelope. A maximal
 * run of frames at-or-below `silenceDb` whose duration ≥ `minSilence` becomes a
 * silence; we then pull `keepPad` off each end so we never clip the neighbouring
 * word's onset/tail. Pure function of (envelope, settings) — this is exactly
 * what the client recomputes live as the threshold slider moves.
 */
export function silencesFromEnvelope(env: Envelope, s: CutSettings): Seg[] {
  const { db, hop, duration } = env;
  if (db.length === 0 || hop <= 0 || duration <= 0) return [];
  const out: Seg[] = [];
  let runStart = -1;
  for (let i = 0; i < db.length; i++) {
    const quiet = db[i] <= s.silenceDb;
    if (quiet && runStart < 0) runStart = i;
    if ((!quiet || i === db.length - 1) && runStart >= 0) {
      // The run covers frames [runStart, lastQuiet]; convert to time. The last
      // frame is inclusive only if it is itself quiet.
      const lastQuiet = quiet ? i : i - 1;
      const start = runStart * hop;
      const end = Math.min(duration, (lastQuiet + 1) * hop);
      if (end - start >= s.minSilence) {
        // Shrink by keepPad each side, but only the removable interior remains.
        const cs = start + s.keepPad;
        const ce = end - s.keepPad;
        if (ce - cs > 0) out.push({ start: round3(cs), end: round3(ce) });
      }
      runStart = -1;
    }
  }
  return out;
}

/** Complement of removed spans over [0,duration] → ordered kept spans. */
export function invert(removed: Seg[], duration: number): Seg[] {
  const sorted = [...removed].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const keep: Seg[] = [];
  let cursor = 0;
  for (const r of sorted) {
    const start = Math.max(0, r.start);
    const end = Math.min(duration, r.end);
    if (start > cursor) keep.push({ start: round3(cursor), end: round3(start) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) keep.push({ start: round3(cursor), end: round3(duration) });
  return keep;
}

/**
 * Segment the narration into takes: the kept spans after thresholding silence,
 * each labelled with the transcript words that fall inside it. Tiny slivers
 * (<0.08s, far too short to hold a word) are dropped so the timeline stays clean.
 * Each take gets a STABLE id keyed to its start so manual deletes survive a
 * threshold change.
 */
export function segmentTakes(
  env: Envelope,
  words: { word: string; start: number; end: number }[],
  s: CutSettings,
): Take[] {
  const silences = silencesFromEnvelope(env, s);
  const kept = invert(silences, env.duration).filter((k) => k.end - k.start >= 0.08);
  return kept.map((k) => {
    const inside = words
      .filter((w) => w.end > k.start + 0.01 && w.start < k.end - 0.01)
      .map((w) => w.word.trim())
      .filter(Boolean);
    return { id: takeId(k.start), start: k.start, end: k.end, text: inside.join(" ").replace(/\s+/g, " ").trim() };
  });
}

/**
 * THE PARITY FUNCTION. Given the envelope, words, settings and the set of
 * manually-deleted take ids, produce the FINAL ordered keep-segment list that
 * preview plays and render trims to. Both sides call this; the render path
 * trims exactly these segments and inserts `gap` of silence between them. No
 * re-detection on the server → what you previewed is what you get.
 */
export function computeKeepSegments(
  env: Envelope,
  words: { word: string; start: number; end: number }[],
  s: CutSettings,
  deletedTakeIds: string[] = [],
): { takes: Take[]; keep: Seg[]; gap: number } {
  const deleted = new Set(deletedTakeIds);
  const takes = segmentTakes(env, words, s);
  const kept = takes.filter((t) => !deleted.has(t.id));
  const keep = kept.map((t) => ({ start: t.start, end: t.end }));
  return { takes, keep, gap: s.gap };
}

/** Total played/rendered duration: kept spans + a `gap` between each pair. */
export function previewDuration(keep: Seg[], gap: number): number {
  const body = keep.reduce((sum, k) => sum + (k.end - k.start), 0);
  const gaps = Math.max(0, keep.length - 1) * gap;
  return round3(body + gaps);
}

/**
 * Map a source time inside one of the kept segments to its position on the
 * EDITED timeline (kept spans concatenated with `gap` between them). Returns
 * null if the source time lies in a removed span. Used by the live preview to
 * keep the playhead and to know where to jump next during skip-playback.
 */
export function sourceToEdited(keep: Seg[], gap: number, src: number): number | null {
  let acc = 0;
  for (let i = 0; i < keep.length; i++) {
    const k = keep[i];
    if (src >= k.start && src <= k.end) return round3(acc + (src - k.start));
    acc += k.end - k.start + (i < keep.length - 1 ? gap : 0);
  }
  return null;
}
