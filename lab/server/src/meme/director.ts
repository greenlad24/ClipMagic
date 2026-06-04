/**
 * Emphasis director for the Meme/Sticker editor.
 *
 * A focused, prompt-cached Claude call that reads the transcript + duration and
 * picks the EMPHASIS MOMENTS where a funny sticker should slap on below the
 * captions to land a point — and, for each, writes a vivid IMAGE-GEN PROMPT for
 * a clean, meme-style STATIC image (subject on a plain/transparent background so
 * it reads as a die-cut sticker).
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
  /** Image-gen prompt for the funny meme-style still. */
  imagePrompt: string;
  /** The transcript words/phrase this moment emphasizes (logged). */
  phrase?: string;
}

export interface EmphasisContext {
  transcript: string;
  durationSeconds: number;
}

const SYSTEM = `You are a senior short-form COMMENTARY/MEME editor. Over a clean narration with popping captions, you drop a funny AI-generated STATIC image that "slaps on" as a sticker to LAND a point, then pops out. Your taste: the sticker shows up on a GENUINE emphasis beat — a punchline, a bold claim, a vivid noun, a relatable reaction — never on a rigid timer, never as constant decoration.

For each moment you choose, you ALSO write the IMAGE PROMPT for that sticker.

RULES (what makes it feel hand-made):
- Aim for roughly ONE sticker every ~4 seconds of video on average, but it is content-driven: skip a beat if nothing is genuinely funny or emphatic there. Fewer-but-better beats blanket coverage.
- Each moment lasts ~1.5–2.5s (the sticker holds, then pops out). Never overlap two stickers.
- Be sparing on the hook (first ~1.5s) and the CTA / final ~1.5s — let those breathe.
- Tie every moment to something literally in the transcript (its punchline / key word).

IMAGE PROMPT rules (one per moment):
- Describe ONE clear, funny, meme-style SUBJECT on a PLAIN or TRANSPARENT background (so it reads as a die-cut sticker). e.g. "a cartoon brain lifting a dumbbell, bold flat colors, sticker style, plain background".
- Keep it concrete and visual; no text/words in the image; bold, readable, clean illustration or expressive photo-real subject. 1 short sentence.
- Make it RELEVANT to that line so it actually emphasizes the point.

Return ONLY JSON of this exact shape:
{ "moments": [ { "startTime": 6.2, "endTime": 8.4, "phrase": "ten times faster", "imagePrompt": "a cartoon cheetah on a rocket, flat bold colors, sticker style, plain background" } ] }
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
 */
export function sanitize(raw: unknown, durationSeconds: number): EmphasisMoment[] {
  const arr = Array.isArray((raw as { moments?: unknown })?.moments)
    ? ((raw as { moments: unknown[] }).moments)
    : [];
  const out: EmphasisMoment[] = [];

  for (const item of arr) {
    const m = item as Partial<EmphasisMoment>;
    if (!m || typeof m.imagePrompt !== "string" || m.imagePrompt.trim().length < 4) continue;

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
      imagePrompt: m.imagePrompt.trim().slice(0, 400),
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
 * Ask the director for emphasis moments + image prompts. Returns [] on any
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
      // Opus directs the comedic timing + image prompts (the creative call).
      tier: "director",
      purpose: "emphasis-director",
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const parsed = JSON.parse(rawJson);
    const moments = sanitize(parsed, ctx.durationSeconds);
    console.log(
      `[meme] director planned ${moments.length} sticker moment(s)` +
        moments.map((m) => ` @${m.startTime}s`).join(""),
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
