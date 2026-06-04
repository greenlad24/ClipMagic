/**
 * Narration Cutter — SHARED keep-segment math (preview ↔ render parity core).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for "given the edit settings, which
 * spans of the source do we keep?". It is intentionally dependency-free (no Node,
 * no ffmpeg, no DOM) so the EXACT same function can run:
 *   - in the browser, live, as the user drags the silence floor / gap / min-take
 *     controls and deletes takes (the interactive timeline editor), and
 *   - on the server, to render precisely what was previewed.
 *
 * An identical copy lives at `lab/src/lib/cutSegments.ts` for the frontend
 * bundle (the web app cannot import from the server tree). A parity test
 * (`scripts/cutter-parity.test.ts`) asserts the two stay byte-for-byte in sync
 * AND that this math agrees with the legacy `planCuts` for silence removal, so
 * "what you preview is what renders" is a tested guarantee, not a hope.
 *
 * THE EDITING RULES (exactly what the user asked for):
 *   1. Breaks = COMPLETE silence only. `silenceDb` is a true-silence floor
 *      (default -45 dBFS). Breaths and quiet speech sit above it and are NEVER
 *      treated as a break.
 *   2. Only silences LONGER than `minSilence` (default 0.35s) are cut. A pause
 *      ≤ 0.35s is natural in-take spacing and is kept untouched.
 *   3. A silence > 0.35s is collapsed to EXACTLY a `gap` (default 0.35s) of dead
 *      air between takes — never more. The full detected silence is removed and
 *      the fixed gap is re-inserted by both preview and render.
 *   4. Leading silence (before the first take) and trailing silence (after the
 *      last take) are removed ENTIRELY — the gap is only ever BETWEEN takes.
 *   5. Takes are AUDIO-DRIVEN: they are the loud (above-floor) spans of the
 *      energy envelope over the FULL file. The transcript only LABELS takes; an
 *      absence of words never drops or shortens a take (this is what lets the
 *      untranscribed tail still become a real take).
 *   6. Only big chunks are takes. A loud island shorter than `minTake`
 *      (default 0.4s) is a stray blip — it is dropped along with the silence
 *      around it, never kept as its own take.
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
  /**
   * COMPLETE-SILENCE floor in dBFS. A gap counts as a cuttable break only when
   * the audio is quieter than this — i.e. genuine digital silence, not breaths
   * or low-energy speech. Default -45 (well below speech/breath energy).
   */
  silenceDb: number;
  /**
   * Minimum length (s) of continuous complete-silence to cut. Silences at or
   * below this stay untouched (natural in-take spacing). Default 0.35.
   */
  minSilence: number;
  /**
   * Breathing room (s) kept on each side of speech (shrinks each removed
   * silence so word onsets/tails survive). Small by default so the collapsed
   * spacing stays close to `gap`. Default 0.05.
   */
  keepPad: number;
  /**
   * Fixed spacing (s) a cut silence collapses to — inserted between kept takes
   * at preview and render. Default 0.35.
   */
  gap: number;
  /**
   * Minimum take length (s). A loud island shorter than this is a stray blip
   * (not a real take) and is dropped with the surrounding silence. Default 0.4.
   */
  minTake: number;
}

export const DEFAULT_SETTINGS: CutSettings = {
  silenceDb: -45,
  minSilence: 0.35,
  keepPad: 0.05,
  gap: 0.35,
  minTake: 0.4,
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
 * Find removable silence regions by thresholding the energy envelope at the
 * COMPLETE-SILENCE floor. A maximal run of frames at-or-below `silenceDb` whose
 * duration > `minSilence` becomes a removable silence; we then pull `keepPad`
 * off each end so we never clip the neighbouring word's onset/tail. Pure
 * function of (envelope, settings) — exactly what the client recomputes live as
 * the silence-floor slider moves.
 *
 * Note the strict `>` test on `minSilence`: a pause of EXACTLY `minSilence`
 * (0.35s) is natural in-take spacing and is preserved, per the rules.
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
      // Only silences LONGER than minSilence are cut (≤ minSilence is kept).
      if (end - start > s.minSilence) {
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
 * Segment the narration into takes (RULE 5 + 6). The kept spans after removing
 * complete-silence are the takes — derived purely from AUDIO ENERGY over the
 * full file, so audio with no transcript (e.g. the untranscribed tail) still
 * becomes a real take. We then DROP any take shorter than `minTake`: a too-short
 * loud island flanked by silence is a stray blip, not a real take, so it is
 * removed along with its surrounding silence (RULE 6). The transcript only
 * LABELS the surviving takes; missing words never drop or shorten one — a take
 * with no words is shown with an em-dash placeholder. Each take gets a STABLE id
 * keyed to its start so manual deletes survive a settings change.
 */
export function segmentTakes(
  env: Envelope,
  words: { word: string; start: number; end: number }[],
  s: CutSettings,
): Take[] {
  const silences = silencesFromEnvelope(env, s);
  // A take must hold at least minTake of audio; tiny slivers/blips are dropped.
  const minTake = Math.max(0.05, s.minTake);
  const kept = invert(silences, env.duration).filter((k) => k.end - k.start >= minTake);
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
 *
 * Because the keep list is just the surviving takes and the spacing is a fixed
 * `gap` re-inserted only BETWEEN them, every cut silence (interior, leading, or
 * trailing) collapses correctly: interior → exactly one `gap`, leading/trailing
 * → nothing (RULES 3 & 4).
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
