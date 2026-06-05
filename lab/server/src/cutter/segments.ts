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
 *   5. A take is a BIG, CONTIGUOUS BLOCK OF SPEECH (an obvious big waveform
 *      chunk), NOT a sentence and NOT scattered words. Takes are detected from
 *      the dBFS ENERGY ENVELOPE (Stage 1): above-floor audio runs are MERGED
 *      across short internal pauses (≤ `minSilence`) into one block, so a whole
 *      recorded line — multiple sentences, mid-line breaths and micro-pauses —
 *      is ONE take, never split inside the block. The transcript is then MAPPED
 *      INTO each block (Stage 2): each take carries the words spoken inside its
 *      [start,end]. Transcript is a LABEL, not the segmenter, so untranscribed
 *      blocks are still real takes.
 *   6. EVERY real big block is shown — none is silently dropped — but scattered,
 *      faint bits BETWEEN the big blocks are NOT takes. A block is enabled by
 *      default only when it is BOTH long enough (≥ `minTake`, default 3.0s) AND
 *      at real speaking volume (its sustained level clears the speaking gate
 *      above the floor). A block that is real speaking volume but too short is
 *      DISABLED with reason "short"; a block that is long enough but faint /
 *      low-level scattered words is DISABLED with reason "low/scattered". Both
 *      stay visible and re-enableable; lowering the min-take slider re-enables
 *      the short ones the user hasn't overridden. Only ENABLED takes contribute
 *      to the keep-segments (preview + render).
 *   7. Re-takes (the narrator re-recording a line) produce several big blocks
 *      with the SAME / very-similar text. They are grouped by normalized-text
 *      similarity and only the LAST occurrence is enabled by default; the
 *      EARLIER ones are DISABLED with the reason "earlier take — final kept". A
 *      block said only ONCE is ALWAYS kept (never grouped, never dropped). The
 *      grouping is the server-computed DEFAULT (an AI pass during analyze, or a
 *      deterministic text heuristic as fallback) passed in as `defaults` here,
 *      with the keep-LAST + don't-drop-uniques + order guarantees enforced in
 *      CODE regardless of the AI. The user can re-enable any disabled take and
 *      disable any enabled one — manual toggles always win.
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
   * Minimum take length (s). A real-volume block SHORTER than this is disabled by
   * default (reason "short") but still shown + re-enableable; it never gets
   * silently dropped. Default 3.0.
   */
  minTake: number;
  /**
   * SPEAKING-VOLUME margin (dB) above the silence floor. A big block counts as
   * real speech only when its SUSTAINED level (a high percentile of the block's
   * dBFS) clears `silenceDb + speakingMargin`. Blocks that are above the floor
   * but never reach this — faint, low-level scattered words between the big
   * takes — are disabled by default with the reason "low/scattered". Default 12.
   */
  speakingMargin: number;
}

export const DEFAULT_SETTINGS: CutSettings = {
  silenceDb: -39,
  minSilence: 0.35,
  keepPad: 0.05,
  gap: 0.35,
  minTake: 3.0,
  speakingMargin: 12,
};

/**
 * A detected take — one BIG contiguous block of speech (Stage 1) — with a stable
 * id and the transcript spoken inside it (Stage 2). EVERY detected block is
 * returned, none dropped. `enabled` reflects whether it currently contributes to
 * the keep-segments after defaults + user toggles; `reason` explains a disabled
 * take ("short" / "low/scattered" / "earlier take — final kept"); `scriptPart`
 * is the group key this take belongs to (for grouping re-takes), when known.
 */
export interface Take {
  /** Stable id derived from the take's rounded source start (survives re-threshold). */
  id: string;
  start: number;
  end: number;
  /** Transcript snippet (the words spoken inside this block) shown on the block. */
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
 * the output of the analyze job's keep-LAST dedup (AI grouping or heuristic
 * fallback): the EARLIER re-takes of each repeated line are listed here so the
 * client's deterministic recompute and the render agree on the same default
 * enabled-set. The Stage-1 short/low-scattered disabling is computed live in the
 * core (so the min-take slider re-enables short takes), NOT carried here.
 */
export interface TakeDefault {
  /** The take id (see `takeId`) this default applies to. */
  id: string;
  /** Why it is disabled by default (e.g. "earlier take — final kept"). */
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
 * STAGE 1 — detect the BIG audio chunks (the visually obvious big-waveform
 * blocks). A raw "block" is a maximal run of above-floor frames; consecutive
 * blocks separated by a pause SHORTER than `minSilence` are the SAME take
 * (natural in-take spacing / a breath), so they MERGE into one contiguous block.
 * Only a true-silence gap LONGER than `minSilence` breaks one block from the
 * next. Each block is returned with its span and a SUSTAINED loudness measure
 * (the 80th-percentile dBFS over its frames) so Stage-1's volume gate can tell a
 * real speaking block from faint scattered blips. Pure function of the envelope
 * + settings — the same thing the client recomputes live as the sliders move.
 */
function bigBlocks(env: Envelope, s: CutSettings): { start: number; end: number; sustainedDb: number }[] {
  const { db, hop, duration } = env;
  if (db.length === 0 || hop <= 0 || duration <= 0) return [];
  const floor = s.silenceDb;
  // The largest inter-block gap (in frames) that still counts as the SAME block:
  // a pause ≤ minSilence is natural in-take spacing and must NOT split a take.
  const mergeFrames = Math.max(1, Math.round(s.minSilence / hop));

  // 1 ─ Above-floor frame runs.
  const runs: { from: number; to: number }[] = []; // inclusive frame indices
  let runStart = -1;
  for (let i = 0; i < db.length; i++) {
    const loud = db[i] > floor;
    if (loud && runStart < 0) runStart = i;
    if ((!loud || i === db.length - 1) && runStart >= 0) {
      runs.push({ from: runStart, to: loud ? i : i - 1 });
      runStart = -1;
    }
  }
  if (runs.length === 0) return [];

  // 2 ─ Merge runs whose silent gap between them is ≤ minSilence (same block).
  const merged: { from: number; to: number }[] = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const last = merged[merged.length - 1];
    const gapFrames = runs[i].from - last.to - 1; // silent frames between
    if (gapFrames <= mergeFrames) last.to = runs[i].to;
    else merged.push(runs[i]);
  }

  // 3 ─ Span + sustained loudness (80th-percentile of the block's frame dBFS, so
  //     a brief dip inside a real take doesn't drag the measure down, while a
  //     block of only faint blips still reads quiet).
  return merged.map((m) => {
    const frames = db.slice(m.from, m.to + 1).sort((a, b) => a - b);
    const idx = Math.min(frames.length - 1, Math.floor(frames.length * 0.8));
    return {
      start: m.from * hop,
      end: Math.min(duration, (m.to + 1) * hop),
      sustainedDb: frames[idx],
    };
  });
}

/**
 * Segment the narration into takes — STAGE 1 (big-chunk detection) + STAGE 2
 * (map the transcript into each chunk). A take is ONE BIG CONTIGUOUS BLOCK of
 * speech, detected from the audio ENERGY (RULE 5): above-floor runs merged across
 * short internal pauses, never split inside the block. The transcript is a label
 * only — each block carries the words spoken inside its span (RULE 5/Stage 2) —
 * so untranscribed blocks are still real takes and a long sentence never gets
 * split across a comma or quiet dip.
 *
 * EVERY real big block is returned (RULE 6) — none is dropped. A block is enabled
 * by default only when it is BOTH long enough (≥ `minTake`) AND at real speaking
 * volume (its sustained level clears `silenceDb + speakingMargin`):
 *   - too short  → disabled, reason "short"      (re-enabled as the slider lowers),
 *   - faint/low  → disabled, reason "low/scattered" (faint scattered words between
 *                  the big blocks are excluded from the script, never enabled).
 * Scattered, ULTRA-short faint blips (below the noise floor AND with no
 * transcript) are edge artifacts and are not shown at all. Each take gets a
 * STABLE id keyed to its start so toggles survive a settings change.
 */
export function segmentTakes(
  env: Envelope,
  words: Word[],
  s: CutSettings,
): Take[] {
  const minTake = Math.max(0.05, s.minTake);
  // The speaking-volume gate: a block is "real speech" only when its sustained
  // level clears this. Faint scattered words sit between the floor and this gate.
  const speakingGate = s.silenceDb + Math.max(0, s.speakingMargin);

  // STAGE 1 — the big contiguous blocks (merge across short internal pauses).
  const blocks = bigBlocks(env, s);

  // NOISE FLOOR: an ultra-short span (< 0.2s) with no transcript is a frame-edge
  // artifact, not a take the narrator recorded — it is never shown. Anything
  // longer, or anything carrying words, is shown (disabled with a reason if it
  // doesn't pass the big-block gates).
  const NOISE = 0.2;

  return blocks
    .map((b) => {
      const start = Math.max(0, b.start - s.keepPad);
      const end = Math.min(env.duration, b.end + s.keepPad);
      // STAGE 2 — map the transcript INTO this chunk: the words whose midpoint
      // falls inside the block's span are this take's text.
      const inside = words
        .filter((w) => {
          const mid = (w.start + w.end) / 2;
          return mid > start && mid < end;
        })
        .map((w) => w.word.trim())
        .filter(Boolean);
      const text = inside.join(" ").replace(/\s+/g, " ").trim();
      const span = end - start;
      // Stage-1 gates: a real take is BIG enough AND at real speaking volume.
      const tooShort = span < minTake;
      const tooFaint = b.sustainedDb < speakingGate;
      // Faint wins the reason: a faint block is "not a take" regardless of length;
      // a real-volume block that's merely short is a "short" take.
      const reason = tooFaint ? "low/scattered" : tooShort ? "short" : undefined;
      return {
        id: takeId(round3(start)),
        start: round3(start),
        end: round3(end),
        text,
        enabled: !reason,
        reason,
        _noise: span < NOISE && text === "",
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

/**
 * Similarity threshold above which two blocks are considered the SAME line.
 * CONSERVATIVE on purpose (high): two big blocks are grouped only when their text
 * genuinely matches, so distinct lines are NEVER merged → a unique part can never
 * be dropped. (RULE 7: be conservative; don't group on a few shared words.)
 */
const DUP_THRESHOLD = 0.72;

/** The disabled-reason for an earlier re-take whose final take is kept. */
export const EARLIER_TAKE_REASON = "earlier take — final kept";

// ── "Find the short" reasons (Stage 4 — the coherent-short selector) ──────────
// When the AI "Auto-cut / Find the short" pass runs, it disables every take that
// is NOT part of the single coherent short and tags WHY, so the timeline can
// explain each excluded take and the user can override any of it. These are the
// only reasons that selector emits; they live in the shared core so the client
// renders the same labels the server computed.

/** A take the short-finder excluded as an earlier/repeated attempt of a kept line. */
export const SHORT_EARLIER_REASON = "earlier take — not in the short";
/** A take the short-finder excluded as off-topic chatter (not the script). */
export const SHORT_CHATTER_REASON = "off-topic chatter";
/** A take the short-finder excluded as an incomplete false start / flub. */
export const SHORT_FALSE_START_REASON = "false start";
/** A take the short-finder excluded for any other reason (catch-all). */
export const SHORT_EXCLUDED_REASON = "not part of the short";

/** True when a disabled reason came from the "Find the short" selector. */
export function isShortReason(reason: string | undefined): boolean {
  return (
    reason === SHORT_EARLIER_REASON ||
    reason === SHORT_CHATTER_REASON ||
    reason === SHORT_FALSE_START_REASON ||
    reason === SHORT_EXCLUDED_REASON
  );
}

/**
 * STAGE 3 (heuristic / no-AI FALLBACK) — full-transcript keep-LAST dedup. Groups
 * the BIG blocks (the takes that passed Stage 1) by conservative normalized-text
 * similarity and, for each group of re-takes, KEEPS THE LAST occurrence (by time)
 * and DISABLES the earlier ones with the reason "earlier take — final kept". A
 * block said only ONCE is ALWAYS kept (never grouped). Returns the DEFAULT
 * disabled-set (`TakeDefault[]`) the core consumes; deterministic, so it matches
 * between server and any client recompute.
 *
 * The keep-LAST rule is UNCONDITIONAL: the latest take in a group is the keeper
 * regardless of length (the narrator's final delivery is what they want), so this
 * helper takes no length parameter for keeper choice. Only the takes that are
 * REAL big blocks at this setting (enabled coming in) are candidates — a take
 * already disabled by Stage 1 (short / low-scattered) is never the keeper and is
 * left with its Stage-1 reason. Blocks with too few content words to compare are
 * never grouped (a bare "—" or a lone filler can't be a confident duplicate), so
 * they survive as their own unique part.
 */
export function heuristicTakeDefaults(takes: Take[]): TakeDefault[] {
  // Only real big blocks (Stage-1-enabled) are dedup candidates, IN TIME ORDER.
  const idx = takes.map((_, i) => i).filter((i) => takes[i].enabled);
  const tokens = new Map<number, string[]>(idx.map((i) => [i, normTokens(takes[i].text)]));
  const assigned = new Set<number>();
  const defaults: TakeDefault[] = [];

  // Build duplicate clusters by single-link similarity over the candidates (which
  // are already in start order). A cluster's keeper is its LAST member — the
  // narrator's final re-record. Every earlier member is disabled.
  for (const i of idx) {
    if (assigned.has(i) || (tokens.get(i)!.length) < 2) continue;
    const cluster = [i];
    assigned.add(i);
    for (const j of idx) {
      if (j <= i || assigned.has(j) || (tokens.get(j)!.length) < 2) continue;
      // Match against any current cluster member (single-link) so a chain of
      // re-takes with minor wording drift still groups.
      if (cluster.some((k) => tokenOverlap(tokens.get(k)!, tokens.get(j)!) >= DUP_THRESHOLD)) {
        cluster.push(j);
        assigned.add(j);
      }
    }
    if (cluster.length < 2) continue; // said only once → ALWAYS kept, nothing to disable

    // KEEP THE LAST occurrence in time (cluster is in start order → last entry).
    const keeper = cluster[cluster.length - 1];
    const keeperSnippet = takes[keeper].text.length > 48
      ? takes[keeper].text.slice(0, 47).trimEnd() + "…"
      : takes[keeper].text;
    for (const k of cluster) {
      if (k === keeper) continue;
      defaults.push({ id: takes[k].id, reason: EARLIER_TAKE_REASON, scriptPart: keeperSnippet });
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
 *   - server `defaults` (an EARLIER re-take whose final take is kept) → disabled,
 *   - Stage-1 gate (short / low-scattered; the short gate is computed live so the
 *     min-take slider re-enables short blocks) → disabled.
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
    // Build the DEFAULT (pre-toggle) enabled/reason. An earlier-re-take loss
    // (server default) takes precedence over the Stage-1 reason; if neither
    // applies the take is enabled by default. `t.reason`/`t.enabled` already
    // carry the Stage-1 short/low-scattered decision from segmentTakes (the short
    // gate is live with the slider).
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
 * fails a Stage-1 gate (too short — computed live, so lowering the min-take
 * slider re-enables it — or too faint / low-scattered) or when the server's
 * keep-LAST dedup marked it an earlier re-take. The user's toggles always win
 * over the defaults.
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
