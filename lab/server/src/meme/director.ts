/**
 * Emphasis director for the Meme/Sticker editor.
 *
 * A focused, prompt-cached Claude call that reads the transcript + duration and
 * picks the EMPHASIS MOMENTS where a funny reaction sticker should slap on below
 * the captions to land a point — and, for each, writes a short STICKER SEARCH
 * QUERY (e.g. "mind blown", "money rain", "shocked") tuned for the Giphy/Tenor
 * reaction-sticker libraries, NOT an image-gen prompt. The fetch layer then
 * pulls real transparent reaction stickers for that query; an AI fit-review
 * picks the best-fitting candidate (or drops it).
 *
 * It ALSO writes a one-line `imagePrompt` per moment as a FALLBACK only — used
 * solely by the optional OpenAI image-gen source when no sticker library/key is
 * available. The default source never reads it.
 *
 * Target density is ~one moment per 4s, but content-driven: it leans into
 * genuine punchlines/claims and is sparing on the hook and CTA. As with the
 * motion-graphics director, RESTRAINT and timing are GUARANTEED IN CODE by
 * sanitize() — spacing, head/tail buffers, hold length, and the ~4s cap are
 * enforced regardless of what the model returns, so it stays tasteful.
 *
 * Reuses claudeJSONForPurpose (same auth, retries, prompt-cache, per-run
 * accounting). If Claude isn't configured or returns nothing usable, returns []
 * and the editor renders captions-only.
 */
import { claudeJSONForPurpose, anthropicConfigured } from "../ai/claude.js";
import type { TranscriptWord } from "../ai/transcribe.js";
import { alignMoments, formatTimedTranscript, type AlignmentKind, type AlignmentSummary } from "./align.js";

export interface EmphasisMoment {
  /** Output-timeline start, seconds (when the sticker slaps on). */
  startTime: number;
  /** Output-timeline end, seconds (when it has fully popped out). */
  endTime: number;
  /**
   * Short reaction-sticker SEARCH QUERY for Giphy/Tenor (e.g. "mind blown",
   * "money rain"). This is the primary field the default source uses.
   */
  searchQuery: string;
  /**
   * One-line image-gen prompt — FALLBACK ONLY (used by the optional OpenAI
   * source when no sticker library is available). The default source ignores it.
   */
  imagePrompt: string;
  /** The transcript words/phrase this moment emphasizes (logged). */
  phrase?: string;
  /**
   * How this moment's timing was pinned to the audio (see meme/align.ts):
   * "phrase" = snapped to the spoken words it quotes (the synced case),
   * "snapped" = moved onto the nearest word onset, "kept" = the director's own
   * estimate stood. Diagnostic only — it never affects placement.
   */
  alignedTo?: AlignmentKind;
}

export interface EmphasisContext {
  transcript: string;
  durationSeconds: number;
  /**
   * Word-level timestamps from the transcription. Load-bearing for SYNC: they
   * both give the director real clock times to read off AND let us re-derive
   * every start from the audio afterwards (alignMoments). Omitted → the director
   * falls back to estimating times from the plain text, as it used to.
   */
  words?: TranscriptWord[];
}

const SYSTEM = `You are a senior short-form COMMENTARY/MEME editor. Over a clean narration with popping captions, you drop funny REACTION STICKERS that "slap on" to LAND a point, then pop out. Each sticker is either found in the Giphy + Tenor reaction-sticker libraries (a SEARCH QUERY) or generated from an IMAGE PROMPT.

YOUR JOB: read the WHOLE script first, then choose the UP TO 6 MAIN emphasis points — the strongest, most sticker-worthy beats of the entire video (a punchline, a bold claim, a striking number, a vivid noun, a relatable reaction). Not a sticker on a timer — THE handful that matter most. Fewer than 6 is fine (and better) if the script doesn't warrant 6; never pad with weak ones.

For EACH chosen point, decide the single most fitting sticker by judging the LOCAL line IN THE CONTEXT OF THE WHOLE SCRIPT, so the set is coherent and EVERY sticker is clearly relevant to what the video is about. An off-topic or generic sticker is worse than none.

TIMING (per point):
- The transcript is given to you as TIMESTAMPED lines: "[12.4s] ten times faster than". Read "startTime" straight off the stamp of the line the point lands on — do NOT estimate it from reading speed. A sticker that lands off the words it is reacting to is a broken edit.
- Each sticker holds ~1.5–2.5s, then pops out. Never overlap two; space them out across the video.
- Be sparing on the hook (first ~1.5s) and the CTA / final ~1.5s — let those breathe.
- "phrase" MUST be copied VERBATIM from the transcript — the exact 2–6 words the sticker reacts to, spelled as they appear there. This is what pins the sticker to the audio, so an approximate or paraphrased quote de-syncs it. Never invent or reword it.

For each point write BOTH:
- "searchQuery": 1–3 words, lowercase, to find a fitting reaction sticker in the libraries. It MUST relate to what the line is about (its concrete subject/idea or the specific reaction it warrants), read in the context of the whole script. Favor concepts the libraries actually stock (e.g. "robot", "money", "clock ticking", "mind blown", "facepalm").
- "imagePrompt": one sentence describing a clean, funny, meme-style sticker subject on a plain/transparent background — SPECIFIC to this point and consistent with the script. This is used to GENERATE the sticker when the libraries have no relevant match, so make it precise and brand-safe.

Return ONLY JSON of this exact shape:
{ "moments": [ { "startTime": 6.2, "endTime": 8.4, "phrase": "ten times faster", "searchQuery": "mind blown", "imagePrompt": "a cartoon head with an exploding brain, flat bold colors, sticker style, plain background" } ] }
If nothing is genuinely motivated, return { "moments": [] }.`;

/** The up-to-6 MAIN emphasis points (fewer for short scripts). */
export function maxMomentsFor(durationSeconds: number): number {
  return Math.max(1, Math.min(6, Math.round(durationSeconds / 4)));
}

const HEAD = 1.5; // let the hook breathe
const TAIL = 1.5; // keep the CTA clean
const MIN_HOLD = 1.5;
const MAX_HOLD = 2.5;
const MIN_GAP = 0.4; // clean gap between two stickers
/** Minimum spacing between sticker STARTS, so density never exceeds ~1/this. */
const MIN_SPACING = 3.0;

/**
 * Validate, clamp, space, and cap the model's picks. This is where the ~4s
 * average density and all timing restraint are GUARANTEED in code regardless of
 * the model's output (the meme analogue of the motion director's sanitize()).
 *
 * A moment is only kept if it has a usable SEARCH QUERY (the primary field). The
 * imagePrompt is optional fallback metadata and never gates acceptance.
 */
export function sanitize(raw: unknown, durationSeconds: number): EmphasisMoment[] {
  const arr = Array.isArray((raw as { moments?: unknown })?.moments)
    ? ((raw as { moments: unknown[] }).moments)
    : [];
  const out: EmphasisMoment[] = [];

  for (const item of arr) {
    const m = item as Partial<EmphasisMoment>;
    if (!m) continue;
    const searchQuery = typeof m.searchQuery === "string" ? m.searchQuery.trim() : "";
    if (searchQuery.length < 2) continue; // the query is what drives the fetch

    let start = Number(m.startTime);
    let end = Number(m.endTime);
    if (!Number.isFinite(start)) continue;

    start = Math.max(HEAD, start);
    if (!Number.isFinite(end) || end <= start) end = start + 1.8;
    // Clamp the hold to a tasteful 1.5–2.5s window.
    if (end - start < MIN_HOLD) end = start + MIN_HOLD;
    if (end - start > MAX_HOLD) end = start + MAX_HOLD;
    if (end > durationSeconds - TAIL) continue; // would crowd the CTA

    out.push({
      startTime: Number(start.toFixed(3)),
      endTime: Number(end.toFixed(3)),
      searchQuery: searchQuery.slice(0, 60),
      imagePrompt:
        typeof m.imagePrompt === "string" && m.imagePrompt.trim().length >= 4
          ? m.imagePrompt.trim().slice(0, 400)
          : searchQuery, // fall back to the query so OpenAI gen still has a prompt
      phrase: typeof m.phrase === "string" ? m.phrase.slice(0, 120) : undefined,
      // Set by alignMoments() upstream when the times were re-derived from the
      // word timings; absent when sanitize() is called on a raw payload.
      alignedTo:
        m.alignedTo === "phrase" || m.alignedTo === "snapped" || m.alignedTo === "kept"
          ? (m.alignedTo as AlignmentKind)
          : undefined,
    });
  }

  // Sort by time; drop overlaps AND anything tighter than MIN_SPACING from the
  // previous kept moment (this is what holds the ~4s average density).
  out.sort((a, b) => a.startTime - b.startTime);
  const spaced: EmphasisMoment[] = [];
  for (const m of out) {
    const prev = spaced[spaced.length - 1];
    if (prev) {
      if (m.startTime < prev.endTime + MIN_GAP) continue;
      if (m.startTime - prev.startTime < MIN_SPACING) continue;
    }
    spaced.push(m);
  }

  return spaced.slice(0, maxMomentsFor(durationSeconds));
}

/**
 * Ask the director for emphasis moments + search queries. Returns [] on any
 * failure or when Claude isn't configured — the editor then renders captions
 * only (no stickers), never crashing.
 */
/** Director outcome: the moments plus WHY there are none (for the UI/diagnostics). */
export interface EmphasisPlan {
  moments: EmphasisMoment[];
  /** Null when moments were produced (or genuinely none were warranted); else the reason. */
  unavailableReason: string | null;
  /** How the run's timings were pinned to the audio (null when no words were given). */
  alignment: AlignmentSummary | null;
}

export async function planEmphasisMoments(ctx: EmphasisContext): Promise<EmphasisPlan> {
  if (!anthropicConfigured()) {
    return {
      moments: [],
      unavailableReason: "emphasis director unconfigured (no ANTHROPIC key)",
      alignment: null,
    };
  }
  const transcript = (ctx.transcript || "").trim();
  if (transcript.length < 40 || ctx.durationSeconds < 6) {
    return { moments: [], unavailableReason: "narration too short for emphasis moments", alignment: null };
  }

  // Prefer the TIMESTAMPED transcript — the director reads startTime off the
  // stamps instead of estimating it from reading speed (the old de-sync).
  const words = ctx.words ?? [];
  const body = words.length > 0 ? formatTimedTranscript(words) : transcript;
  const user =
    `Video duration: ${ctx.durationSeconds.toFixed(1)}s. ` +
    `Read the whole script, then choose the UP TO ${maxMomentsFor(ctx.durationSeconds)} MAIN emphasis points (fewer if fewer genuinely warrant a sticker). For each, give the fitting searchQuery AND a specific imagePrompt, both relevant to the script.\n\n` +
    (words.length > 0
      ? `TRANSCRIPT (each line is stamped with the second it is spoken — take startTime from the stamp, and copy "phrase" verbatim from these words):\n${body}`
      : `TRANSCRIPT:\n${body}`) +
    `\n\nReturn the moments JSON now.`;

  try {
    const rawJson = await claudeJSONForPurpose({
      // Opus directs the comedic timing + sticker queries (the creative call).
      tier: "director",
      purpose: "emphasis-director",
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const parsed = JSON.parse(rawJson);
    // SYNC GUARANTEE: re-derive every start from the word timings before the
    // spacing/hold rules run, so sanitize() operates on real times rather than
    // on the model's arithmetic.
    const { moments: alignedRaw, summary } = alignMoments(parsed, words);
    const moments = sanitize({ moments: alignedRaw }, ctx.durationSeconds);
    console.log(
      `[meme] director planned ${moments.length} sticker moment(s)` +
        moments.map((m) => ` @${m.startTime}s "${m.searchQuery}"`).join(""),
    );
    if (words.length > 0) {
      console.log(
        `[meme] timeline sync: ${summary.phrase} pinned to the spoken phrase, ` +
          `${summary.snapped} snapped to a word onset, ${summary.kept} left as planned ` +
          `(largest correction ${summary.maxShift.toFixed(2)}s)`,
      );
    }
    // No reason needed even at 0 moments here: the director ran fine and simply
    // judged none were warranted (computeSkipReason reports that case).
    return { moments, unavailableReason: null, alignment: words.length > 0 ? summary : null };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[meme] emphasis director failed — captions-only this run: ${reason}`);
    return { moments: [], unavailableReason: `emphasis director failed: ${reason}`, alignment: null };
  }
}
