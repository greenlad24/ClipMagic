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
}

export interface EmphasisContext {
  transcript: string;
  durationSeconds: number;
}

const SYSTEM = `You are a senior short-form COMMENTARY/MEME editor. Over a clean narration with popping captions, you drop a funny REACTION STICKER that "slaps on" to LAND a point, then pops out. The stickers come from the Giphy + Tenor reaction-sticker libraries, so for each moment you write a SHORT SEARCH QUERY that will surface a fitting, funny, recognizable reaction sticker. Your taste: the sticker shows up on a GENUINE emphasis beat — a punchline, a bold claim, a vivid noun, a relatable reaction — never on a rigid timer, never as constant decoration.

RULES (what makes it feel hand-made):
- Aim for roughly ONE sticker every ~4 seconds of video on average, but it is content-driven: skip a beat if nothing is genuinely funny or emphatic there. Fewer-but-better beats blanket coverage.
- Each moment lasts ~1.5–2.5s (the sticker holds, then pops out). Never overlap two stickers.
- Be sparing on the hook (first ~1.5s) and the CTA / final ~1.5s — let those breathe.
- Tie every moment to something literally in the transcript (its punchline / key word).

SEARCH QUERY rules (one per moment) — this is the IMPORTANT field:
- 1–3 words, lowercase, the kind of thing you'd type into a meme/sticker search to get a funny REACTION sticker: e.g. "mind blown", "money rain", "shocked", "facepalm", "mic drop", "no way", "celebration", "thinking", "crying laughing".
- Prefer common, well-stocked reaction/emotion concepts over niche literal nouns — the libraries have tons of "shocked" but few "third-quarter EBITDA".
- Make it RELEVANT to that line so the sticker actually emphasizes the point.

ALSO write a one-sentence "imagePrompt" describing a clean, funny, meme-style sticker subject on a plain/transparent background — this is a FALLBACK only (used if no sticker library is available), so keep it short.

Return ONLY JSON of this exact shape:
{ "moments": [ { "startTime": 6.2, "endTime": 8.4, "phrase": "ten times faster", "searchQuery": "mind blown", "imagePrompt": "a cartoon head with an exploding brain, flat bold colors, sticker style, plain background" } ] }
If nothing is genuinely motivated, return { "moments": [] }.`;

/** Target density: ~1 sticker / 4s, with sane floor/ceiling. */
export function maxMomentsFor(durationSeconds: number): number {
  return Math.max(1, Math.min(20, Math.round(durationSeconds / 4)));
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
export async function planEmphasisMoments(ctx: EmphasisContext): Promise<EmphasisMoment[]> {
  if (!anthropicConfigured()) return [];
  const transcript = (ctx.transcript || "").trim();
  if (transcript.length < 40 || ctx.durationSeconds < 6) return [];

  const user =
    `Video duration: ${ctx.durationSeconds.toFixed(1)}s. ` +
    `Place about ${maxMomentsFor(ctx.durationSeconds)} sticker moment(s) at most (~one every 4s), and fewer if fewer are genuinely funny/emphatic.\n\n` +
    `TRANSCRIPT:\n${transcript}\n\nReturn the moments JSON now.`;

  try {
    const rawJson = await claudeJSONForPurpose({
      // Opus directs the comedic timing + sticker queries (the creative call).
      tier: "director",
      purpose: "emphasis-director",
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const parsed = JSON.parse(rawJson);
    const moments = sanitize(parsed, ctx.durationSeconds);
    console.log(
      `[meme] director planned ${moments.length} sticker moment(s)` +
        moments.map((m) => ` @${m.startTime}s "${m.searchQuery}"`).join(""),
    );
    return moments;
  } catch (e) {
    console.warn(
      `[meme] emphasis director failed — captions-only this run: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}
