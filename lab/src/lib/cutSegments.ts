/**
 * Narration Cutter — SHARED keep-segment math (preview ↔ render parity core).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for "given the edit settings, which
 * spans of the source do we keep?". It is intentionally dependency-free (no Node,
 * no ffmpeg, no DOM) so the EXACT same function can run:
 *   - in the browser, live, as the user drags the silence floor / gap / min-take
 *     controls and toggles takes (the interactive timeline editor), and
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
 *      (default -39 dBFS, dial-able all the way to 0). Breaths and quiet speech
 *      sit above it and are NEVER treated as a break.
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
 *   6. EVERY detected take is shown — none is silently dropped. A take shorter
 *      than `minTake` (default 3.0s) is a likely stray blip, so it is DISABLED by
 *      default with the reason "under {minTake}s", but it stays visible and the
 *      user can re-enable it. Lowering the min-take slider re-enables the short
 *      ones the user hasn't manually overridden. Only ENABLED takes contribute to
 *      the keep-segments (preview + render).
 *   7. Re-takes (the speaker repeating a line) are grouped per script PART and
 *      only the BEST take per part is enabled by default; the other repeats are
 *      DISABLED by default with the reason "duplicate — better take kept". This
 *      grouping is the server-computed DEFAULT (an AI pass during analyze, or a
 *      deterministic text heuristic as fallback) passed in as `defaults` here, so
 *      the live client recompute and the render agree. The user can re-enable any
 *      disabled take and disable any enabled one — manual toggles always win.
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
   * the audio is quieter than this. Default -39; the slider spans the full
   * 0…-60 range so the user can treat everything below a chosen loudness as a
   * break (up to 0 dB) or only true digital silence (down to -60).
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
   * Minimum take length (s). A take SHORTER than this is disabled by default
   * (reason "under {minTake}s") but still shown + re-enableable; it never gets
   * silently dropped. Default 3.0.
   */
  minTake: number;
}

export const DEFAULT_SETTINGS: CutSettings = {
  silenceDb: -39,
  minSilence: 0.35,
  keepPad: 0.05,
  gap: 0.35,
  minTake: 3.0,
};

/**
 * A detected take ("take"), with a stable id and optional transcript. EVERY
 * detected take is returned — none is dropped. `enabled` reflects whether it
 * currently contributes to the keep-segments after defaults + user toggles;
 * `reason` explains a disabled take ("under 3s" / "duplicate — better take
 * kept"); `scriptPart` is the AI-assigned script part this take belongs to (for
 * grouping re-takes), when known.
 */
export interface Take {
  /** Stable id derived from the take's rounded source start (survives re-threshold). */
  id: string;
  start: number;
  end: number;
  /** Transcript snippet (filled from word timings) shown on the block. */
  text: string;
  /** Whether this take is currently enabled (kept). */
  enabled: boolean;
  /** Human reason a take is DISABLED (undefined when enabled). */
  reason?: string;
  /** The script part (group key) this take covers, when known (re-take grouping). */
  scriptPart?: string;
}

/**
 * The server-computed DEFAULT for which takes start DISABLED and why. This is
 * the output of the analyze job's best-take selection (AI pass or heuristic
 * fallback): re-takes that lost to a better take are listed here so the client's
 * deterministic recompute and the render agree on the same default enabled-set.
 * The under-minTake disabling is computed live in the core (so the slider
 * re-enables short takes), NOT carried here.
 */
export interface TakeDefault {
  /** The take id (see `takeId`) this default applies to. */
  id: string;
  /** Why it is disabled by default (e.g. "duplicate — better take kept"). */
  reason: string;
  /** The script part this take covers (so the UI can show the grouping). */
  scriptPart?: string;
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
 * EVERY detected take is returned (RULE 6) — none is dropped. Each take is
 * `enabled` by default; a take shorter than `minTake` is DISABLED by default
 * with the reason "under {minTake}s" but still returned so the timeline can show
 * it and the user can re-enable it (and lowering the slider re-enables it). Each
 * take gets a STABLE id keyed to its start so toggles survive a settings change.
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
  //     island), then label from the words. Tiny sub-minTake takes are NOT
  //     dropped — they are disabled by default with a reason (RULE 6).
  raw.sort((a, b) => a.start - b.start);
  const merged: Seg[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }

  // NOISE FLOOR (distinct from the user-facing minTake): a span shorter than
  // this AND carrying no transcript is a keepPad/edge artifact, not a take the
  // user recorded — it is never shown. Anything longer, or anything with words,
  // is a real take and is always shown (disabled if under minTake).
  const NOISE = 0.2;

  return merged
    .map((k) => {
      const inside = words
        .filter((w) => w.end > k.start + 0.01 && w.start < k.end - 0.01)
        .map((w) => w.word.trim())
        .filter(Boolean);
      const text = inside.join(" ").replace(/\s+/g, " ").trim();
      const dur = k.end - k.start;
      const short = dur < minTake;
      return {
        id: takeId(round3(k.start)),
        start: round3(k.start),
        end: round3(k.end),
        text,
        enabled: !short,
        reason: short ? `under ${minTake}s` : undefined,
        _noise: dur < NOISE && text === "",
      };
    })
    .filter((t) => !t._noise)
    .map(({ _noise, ...t }) => t);
}

// ── Duplicate-take detection (heuristic fallback), transcript-text-based ──────

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
 * Heuristic, text-only best-take selection (the no-AI FALLBACK for the analyze
 * job). Groups near-duplicate takes and, considering ONLY takes longer than
 * `minTakeForBest`, keeps the LATEST qualifying take per group and disables the
 * earlier repeats with the "duplicate — better take kept" reason. Returns the
 * DEFAULT disabled-set (`TakeDefault[]`) the core consumes; deterministic so it
 * matches between server and any client recompute.
 *
 * Takes with too few content words to compare are never grouped (a bare "—" or
 * single filler can't be a duplicate). Short takes (≤ `minTakeForBest`) are
 * never chosen as the keeper of a group (RULE 7: best take is > 3s).
 */
export function heuristicTakeDefaults(takes: Take[], minTakeForBest = 3.0): TakeDefault[] {
  const tokens = takes.map((t) => normTokens(t.text));
  const len = (i: number) => takes[i].end - takes[i].start;
  const assigned = new Array<boolean>(takes.length).fill(false);
  const defaults: TakeDefault[] = [];

  // Build duplicate clusters by single-link similarity, then keep the BEST take
  // per cluster (the LATEST take longer than minTakeForBest; if none qualifies,
  // the longest). Every other member of the cluster is disabled — including a
  // SHORT false-start that comes AFTER the real take. Order-independent so a
  // re-take before OR after the keeper is handled.
  for (let i = 0; i < takes.length; i++) {
    if (assigned[i] || tokens[i].length < 2) continue;
    const cluster = [i];
    assigned[i] = true;
    for (let j = i + 1; j < takes.length; j++) {
      if (assigned[j] || tokens[j].length < 2) continue;
      // Match against any current cluster member (single-link), so a chain of
      // re-takes with minor drift still groups.
      if (cluster.some((k) => tokenOverlap(tokens[k], tokens[j]) >= DUP_THRESHOLD)) {
        cluster.push(j);
        assigned[j] = true;
      }
    }
    if (cluster.length < 2) continue; // one attempt → nothing to disable

    // Choose the keeper: latest take > minTakeForBest, else the longest.
    const qualifying = cluster.filter((k) => len(k) > minTakeForBest);
    const keeper = qualifying.length
      ? qualifying[qualifying.length - 1] // cluster is in start order → latest qualifying
      : cluster.reduce((best, k) => (len(k) > len(best) ? k : best), cluster[0]);
    const keeperSnippet = takes[keeper].text.length > 48
      ? takes[keeper].text.slice(0, 47).trimEnd() + "…"
      : takes[keeper].text;
    for (const k of cluster) {
      if (k === keeper) continue;
      defaults.push({
        id: takes[k].id,
        reason: `duplicate — better take kept (${keeperSnippet})`,
        scriptPart: keeperSnippet,
      });
    }
  }
  return defaults;
}

/**
 * Apply the server's DEFAULT disabled-set + the under-minTake rule + the user's
 * manual toggles to the raw segmented takes, producing the final take list with
 * `enabled`/`reason`/`scriptPart` resolved. Pure + deterministic, used by both
 * the live client recompute and (indirectly, via computeKeepSegments) the render.
 *
 * Default disabled set (in priority order, the FIRST that applies wins the
 * reason shown):
 *   - server `defaults` (re-take that lost the best-take selection) → disabled,
 *   - under-minTake (computed live so the slider re-enables short takes) → disabled.
 * A manual toggle in `toggledTakeIds` flips whatever the resulting default is.
 */
export function applyDefaults(
  takes: Take[],
  defaults: TakeDefault[],
  toggledTakeIds: string[],
): Take[] {
  const byId = new Map(defaults.map((d) => [d.id, d]));
  const toggled = new Set(toggledTakeIds);
  return takes.map((t) => {
    const dup = byId.get(t.id);
    // Build the DEFAULT (pre-toggle) enabled/reason. A re-take loss (server
    // default) takes precedence over the under-minTake reason; if neither
    // applies the take is enabled by default. `t.reason`/`t.enabled` already
    // carry the under-minTake decision from segmentTakes (live with the slider).
    let defaultEnabled: boolean;
    let reason: string | undefined;
    let scriptPart: string | undefined = dup?.scriptPart;
    if (dup) {
      defaultEnabled = false;
      reason = dup.reason;
    } else {
      defaultEnabled = t.enabled; // under-minTake decision from segmentTakes
      reason = t.enabled ? undefined : t.reason;
    }
    // Manual toggle flips the default.
    const enabled = toggled.has(t.id) ? !defaultEnabled : defaultEnabled;
    return {
      ...t,
      enabled,
      reason: enabled ? undefined : reason,
      scriptPart,
    };
  });
}

/**
 * THE PARITY FUNCTION. Given the envelope, words, settings, the server's default
 * disabled-set (best-take selection) and the set of manually-toggled take ids,
 * produce the resolved take list AND the FINAL ordered keep-segment list that
 * preview plays and render trims to. Both sides call this; the render path trims
 * exactly the returned `keep` and inserts `gap` of silence between them. No
 * re-detection on the server → what you previewed is what you get.
 *
 * Only ENABLED takes contribute to `keep`. A take is disabled by default when it
 * is under `minTake` (computed live, so lowering the slider re-enables it) or
 * when the server's best-take selection marked it a losing re-take. The user's
 * toggles always win over the defaults.
 *
 * Because the keep list is just the enabled takes and the spacing is a fixed
 * `gap` re-inserted only BETWEEN them, every cut silence (interior, leading, or
 * trailing) collapses correctly: interior → exactly one `gap`, leading/trailing
 * → nothing (RULES 3 & 4).
 */
export function computeKeepSegments(
  env: Envelope,
  words: Word[],
  s: CutSettings,
  defaults: TakeDefault[] = [],
  toggledTakeIds: string[] = [],
): { takes: Take[]; keep: Seg[]; gap: number } {
  const takes = applyDefaults(segmentTakes(env, words, s), defaults, toggledTakeIds);
  const keep = takes.filter((t) => t.enabled).map((t) => ({ start: t.start, end: t.end }));
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
