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
 *      (default -39 dBFS). Breaths and quiet speech sit above it and are NEVER
 *      treated as a break.
 *   2. Only silences LONGER than `minSilence` (default 0.35s) are cut. A pause
 *      ≤ 0.35s is natural in-take spacing and is kept untouched.
 *   3. A silence > 0.35s is collapsed to EXACTLY a `gap` (default 0.35s) of dead
 *      air between takes — never more. The full detected silence is removed and
 *      the fixed gap is re-inserted by both preview and render.
 *   4. Leading silence (before the first take) and trailing silence (after the
 *      last take) are removed ENTIRELY — the gap is only ever BETWEEN takes.
 *   5. A take spans a WHOLE SENTENCE. Where there is a transcript, takes follow
 *      the SENTENCES (split on . ? ! and on long true-silence gaps BETWEEN
 *      sentences). A take runs continuously from its sentence's first word to its
 *      last word — it is NEVER split inside the sentence, even across a quiet dip
 *      or a sub-`minSilence` pause. Only the true-silence > `minSilence` BETWEEN
 *      sentences is cut. Where there is NO transcript (e.g. an untranscribed
 *      tail), takes fall back to the AUDIO-ENERGY islands so nothing is dropped.
 *   6. Only big chunks are takes. A loud island shorter than `minTake`
 *      (default 0.4s) is a stray blip — it is dropped along with the silence
 *      around it, never kept as its own take.
 *   7. Duplicate takes (the speaker repeating a line / re-takes) are detected
 *      from the TRANSCRIPT TEXT: near-duplicate sentences are grouped and only
 *      the LATEST take is kept; the earlier ones are auto-removed BY DEFAULT with
 *      a clear reason. This is deterministic and text-only (no AI), so preview
 *      and render agree, and the user can restore any of them in the timeline.
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
   * or low-energy speech. Default -39 (the user's tested sweet spot).
   */
  silenceDb: number;
  /**
   * Minimum length (s) of continuous complete-silence to cut. Silences at or
   * below this stay untouched (natural in-take spacing). Also the minimum
   * BETWEEN-word silence that can end a sentence. Default 0.35.
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
  silenceDb: -39,
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
  /**
   * If this take was auto-removed as a duplicate of a LATER take, the human
   * reason ("duplicate — earlier take of: …"). Undefined for kept takes. The UI
   * dims these and lets the user restore them; render also drops them by default.
   */
  duplicateOf?: string;
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

interface Word {
  word: string;
  start: number;
  end: number;
}

/** A sentence built from word timings: its words + span [start,end]. */
interface Sentence {
  words: Word[];
  start: number;
  end: number;
  text: string;
}

/** True if a word's text ends a sentence (terminal . ? ! — not a decimal/abbrev comma). */
function endsSentence(word: string): boolean {
  // Trailing terminal punctuation, allowing closing quotes/brackets after it.
  return /[.?!]["')\]]*\s*$/.test(word.trim());
}

/**
 * Group word timings into SENTENCES (RULE 5). A sentence boundary is either:
 *   - terminal punctuation (. ? !) on a word, OR
 *   - a CLEARLY long TRUE-silence gap between consecutive words: the gap to the
 *     next word must (a) be longer than `minSilence` AND (b) actually contain a
 *     measured complete-silence region (`silences`, derived from the audio
 *     envelope) — so a comma, a brief pause, or merely loose Whisper word
 *     timings do NOT end a sentence; only real inter-sentence dead air does.
 * The resulting take spans the whole sentence continuously — quiet dips and
 * short pauses INSIDE it never split it. Pure function of (words, silences, s).
 */
export function sentencesFromWords(words: Word[], silences: Seg[], s: CutSettings): Sentence[] {
  const clean = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.word.trim())
    .sort((a, b) => a.start - b.start);
  // A word-gap is a real sentence break only if a measured silence sits inside
  // it (the envelope, not the loose word timings, decides where dead air is).
  const silenceInGap = (from: number, to: number) =>
    silences.some((sil) => Math.min(sil.end, to) - Math.max(sil.start, from) > 0.01);
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const start = cur[0].start;
    const end = cur[cur.length - 1].end;
    const text = cur.map((w) => w.word.trim()).join(" ").replace(/\s+/g, " ").trim();
    out.push({ words: cur, start, end, text });
    cur = [];
  };
  for (let i = 0; i < clean.length; i++) {
    const w = clean[i];
    cur.push(w);
    const next = clean[i + 1];
    // End on terminal punctuation, OR on a long word-gap that holds real silence.
    const gapToNext = next ? next.start - w.end : Infinity;
    const longTrueSilence = next != null && gapToNext > s.minSilence && silenceInGap(w.end, next.start);
    if (endsSentence(w.word) || longTrueSilence) flush();
  }
  flush();
  return out;
}

/**
 * Segment the narration into takes (RULES 5 + 6). A take is a WHOLE SENTENCE.
 *
 * Where there are transcript words we segment into sentences (split on . ? ! and
 * on long true-silence gaps BETWEEN sentences) and make each sentence ONE
 * continuous take from its first word to its last word (± `keepPad`) — never
 * split inside the sentence, even across a quiet dip or a short pause. The only
 * thing removed is the true-silence > `minSilence` BETWEEN sentences, which the
 * fixed inter-take `gap` then re-inserts (RULES 2–4).
 *
 * Where there are NO words (e.g. an untranscribed tail) we fall back to the
 * AUDIO-ENERGY islands so nothing is dropped (RULE 5 fallback) — those islands
 * are the loud spans of the envelope minus complete-silence. Audio islands that
 * are already covered by a sentence are NOT re-added (the sentence owns them).
 *
 * Finally we DROP any take shorter than `minTake`: a too-short loud island /
 * single-word blip is not a real take (RULE 6). Each take gets a STABLE id keyed
 * to its start so manual deletes survive a settings change.
 */
export function segmentTakes(
  env: Envelope,
  words: Word[],
  s: CutSettings,
): Take[] {
  const minTake = Math.max(0.05, s.minTake);
  const dur = env.duration;

  // The measured complete-silence regions: both the sentence splitter (to find
  // real inter-sentence dead air) and the audio fallback below use these.
  const silences = silencesFromEnvelope(env, s);

  // 1 ─ Sentence takes from the transcript. Each is one continuous span; a
  //     sentence only ends at punctuation or a real inter-sentence silence.
  const sentences = sentencesFromWords(words, silences, s);
  const raw: Seg[] = sentences.map((sn) => ({
    start: Math.max(0, sn.start - s.keepPad),
    end: Math.min(dur, sn.end + s.keepPad),
  }));

  // 2 ─ Audio-energy islands for the FALLBACK in untranscribed regions only.
  //     (RULE 5: the untranscribed tail still becomes a take.)
  const islands = invert(silences, dur);
  const covered = (seg: Seg) => raw.some((r) => Math.min(r.end, seg.end) - Math.max(r.start, seg.start) > 0.05);
  for (const isl of islands) {
    if (!covered(isl)) raw.push({ start: isl.start, end: isl.end });
  }

  // 3 ─ Order, merge any accidental overlaps (a sentence pad can touch an
  //     island), drop blips, then label from the words.
  raw.sort((a, b) => a.start - b.start);
  const merged: Seg[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }

  return merged
    .filter((k) => k.end - k.start >= minTake)
    .map((k) => {
      const inside = words
        .filter((w) => w.end > k.start + 0.01 && w.start < k.end - 0.01)
        .map((w) => w.word.trim())
        .filter(Boolean);
      return {
        id: takeId(round3(k.start)),
        start: round3(k.start),
        end: round3(k.end),
        text: inside.join(" ").replace(/\s+/g, " ").trim(),
      };
    });
}

// ── Duplicate-take detection (RULE 7), transcript-text-based, deterministic ──

/** Normalize a take's text for comparison: lowercase, strip punctuation + fillers. */
function normTokens(text: string): string[] {
  const FILLER = new Set(["um", "uh", "er", "ah", "hmm", "like", "so", "well", "okay", "ok", "right", "you", "know"]);
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((t) => t && !FILLER.has(t));
}

/**
 * Jaccard token-overlap of two normalized phrases. Robust to minor word
 * differences between re-takes (a dropped/added word barely moves the score),
 * and 0 when either side is empty.
 */
function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Similarity threshold above which two takes are considered the same line. */
const DUP_THRESHOLD = 0.6;

/**
 * Detect duplicate takes from the transcript text and mark the EARLIER ones in
 * each duplicate group as removed (keep the LATEST). Deterministic and text-only
 * (no AI), so the client computes the exact same set the server renders.
 *
 * For each take (latest → earliest), if an EARLIER take's normalized text is a
 * near-duplicate (token overlap ≥ threshold), the earlier take is flagged with
 * `duplicateOf` = the latest take's snippet. Takes with too few content words to
 * compare are never flagged (a bare "—" or single filler can't be a duplicate).
 * Returns a NEW array; the take spans/ids are untouched.
 */
export function markDuplicateTakes(takes: Take[]): Take[] {
  const tokens = takes.map((t) => normTokens(t.text));
  const out = takes.map((t) => ({ ...t }));
  // Walk latest → earliest; the latest unflagged take in a group is the keeper.
  for (let later = out.length - 1; later >= 0; later--) {
    if (out[later].duplicateOf) continue; // already removed → not a keeper
    if (tokens[later].length < 2) continue; // too little text to match on
    for (let earlier = later - 1; earlier >= 0; earlier--) {
      if (out[earlier].duplicateOf) continue;
      if (tokens[earlier].length < 2) continue;
      if (tokenOverlap(tokens[later], tokens[earlier]) >= DUP_THRESHOLD) {
        const snippet = out[later].text.length > 48 ? out[later].text.slice(0, 47).trimEnd() + "…" : out[later].text;
        out[earlier].duplicateOf = `duplicate — earlier take of: ${snippet}`;
      }
    }
  }
  return out;
}

/**
 * THE PARITY FUNCTION. Given the envelope, words, settings and the set of
 * manually-toggled take ids, produce the FINAL ordered keep-segment list that
 * preview plays and render trims to. Both sides call this; the render path
 * trims exactly these segments and inserts `gap` of silence between them. No
 * re-detection on the server → what you previewed is what you get.
 *
 * Duplicate takes (RULE 7) are auto-removed BY DEFAULT here. `toggledTakeIds`
 * flips a take's default keep/drop: a kept take in the set is dropped (manual
 * delete), and an auto-removed duplicate in the set is restored. This keeps the
 * existing non-destructive delete/undo while letting the user bring back any
 * duplicate the text-matcher removed.
 *
 * Because the keep list is just the surviving takes and the spacing is a fixed
 * `gap` re-inserted only BETWEEN them, every cut silence (interior, leading, or
 * trailing) collapses correctly: interior → exactly one `gap`, leading/trailing
 * → nothing (RULES 3 & 4).
 */
export function computeKeepSegments(
  env: Envelope,
  words: Word[],
  s: CutSettings,
  toggledTakeIds: string[] = [],
): { takes: Take[]; keep: Seg[]; gap: number } {
  const toggled = new Set(toggledTakeIds);
  const takes = markDuplicateTakes(segmentTakes(env, words, s));
  const kept = takes.filter((t) => {
    const removedByDefault = Boolean(t.duplicateOf);
    // A toggle flips the default: drop a kept take, or restore a duplicate.
    return toggled.has(t.id) ? removedByDefault : !removedByDefault;
  });
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
