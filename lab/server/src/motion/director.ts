/**
 * Motion-graphics director pass.
 *
 * A focused, prompt-cached Claude call that decides WHICH motion graphics appear
 * and WHEN — with the judgment of a senior short-form editor. The hard rule, in
 * the prompt and re-enforced in code, is RESTRAINT: a polished 60s short uses
 * ~2–4 graphics, each motivated by the content (a person introduced → lower
 * third; a concrete number stated → stat callout; a real topic turn → section
 * card). Never decoration, never one-per-sentence.
 *
 * It reuses the existing claudeChatJSON path (same auth, retries, prompt-cache,
 * and per-run accounting). If Claude isn't configured or returns nothing usable,
 * it returns [] and the render proceeds with no graphics — graceful by default.
 */
import { claudeChatJSON, anthropicConfigured } from "../ai/claude.js";
import { aiConfig } from "../ai/config.js";
import { config } from "../config.js";
import type { MotionGraphicClip, MotionGraphicKind } from "../render/manifest.js";

export interface DirectorContext {
  /** Full narration transcript (the primary signal). */
  transcript: string;
  /** Total video duration in seconds. */
  durationSeconds: number;
  /** Optional coarse beat windows (start/end/label) if the project has them. */
  beats?: Array<{ start: number; end: number; label?: string }>;
}

const SYSTEM = `You are a senior short-form video editor deciding where to place MOTION GRAPHICS over a finished vertical (9:16) video. You are known for taste and RESTRAINT — your edits look hand-crafted, never auto-generated.

You have exactly three graphic types:
1. "lower-third"  — a name + title tag. ONLY when a SPECIFIC PERSON is introduced/named on screen (a founder, guest, the speaker's name+role). props: { "name": string, "title"?: string }
2. "stat-callout" — a big eased count-up of ONE number. ONLY when the narration states a concrete, punchy figure worth emphasizing (a %, multiplier, count, price, time saved). props: { "value": number, "prefix"?: string, "suffix"?: string, "label"?: string, "decimals"?: number }
3. "section-card" — a short chapter/section title at a GENUINE topic turn (e.g. "Step 2", "The Catch", "Here's the fix"). props: { "kicker"?: string, "title": string }  (title 1–4 words)

IRON RULES (these are what make it look human):
- BE SPARING. A 60s video gets ~2–4 graphics TOTAL. A 30s video gets 1–2. When in doubt, leave it out. Zero graphics is a perfectly good answer if nothing is motivated.
- Each graphic MUST be motivated by something literally in the transcript. Never invent a name, a stat, or a section that wasn't said.
- Never stack two graphics at the same time. Space them out across the video.
- Hold each graphic 2.0–3.0s. They enter and exit on their own (you only choose start/end).
- A stat-callout's "value" must be a real number from the script. Put units in prefix/suffix ("$", "%", "x", "+"), not in the value.
- Don't place a graphic in the final ~1.5s (the CTA should land clean) or before ~1.0s (let the hook breathe).
- Prefer fewer, better graphics over covering every moment.

Return ONLY JSON of this exact shape:
{ "graphics": [ { "kind": "stat-callout", "startTime": 12.4, "endTime": 14.9, "data": { "value": 10, "suffix": "x", "label": "Faster" }, "reason": "Narrator says 'ten times faster' here." } ] }
If nothing is motivated, return { "graphics": [] }.`;

const KINDS: MotionGraphicKind[] = ["lower-third", "stat-callout", "section-card"];

/** Cap on graphics density: ~1 graphic per 18s of video, min 2 allowance. */
function maxGraphicsFor(durationSeconds: number): number {
  return Math.max(2, Math.min(5, Math.round(durationSeconds / 18)));
}

/**
 * Validate, clamp, and de-conflict the model's picks. This is where restraint is
 * GUARANTEED regardless of what the model returns: we drop overlaps, clamp
 * durations, enforce the head/tail buffers, and cap the count.
 */
function sanitize(
  raw: unknown,
  durationSeconds: number,
): MotionGraphicClip[] {
  const arr = Array.isArray((raw as { graphics?: unknown })?.graphics)
    ? ((raw as { graphics: unknown[] }).graphics)
    : [];
  const out: MotionGraphicClip[] = [];

  const HEAD = 1.0;
  const TAIL = 1.5;
  for (const item of arr) {
    const g = item as Partial<MotionGraphicClip>;
    if (!g || !KINDS.includes(g.kind as MotionGraphicKind)) continue;
    if (typeof g.data !== "object" || g.data === null) continue;

    let start = Number(g.startTime);
    let end = Number(g.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    // Clamp to a tasteful 2.0–3.0s hold inside the safe window.
    start = Math.max(HEAD, start);
    if (end <= start) end = start + 2.5;
    end = Math.min(end, start + 3.0);
    if (end - start < 2.0) end = start + 2.0;
    if (end > durationSeconds - TAIL) continue; // would crowd the CTA

    // stat-callout must carry a real numeric value.
    if (g.kind === "stat-callout") {
      const v = Number((g.data as { value?: unknown }).value);
      if (!Number.isFinite(v)) continue;
    }
    // lower-third / section-card need a name / title.
    if (g.kind === "lower-third" && !(g.data as { name?: string }).name) continue;
    if (g.kind === "section-card" && !(g.data as { title?: string }).title) continue;

    out.push({
      kind: g.kind as MotionGraphicKind,
      startTime: Number(start.toFixed(3)),
      endTime: Number(end.toFixed(3)),
      data: g.data as Record<string, unknown>,
      reason: typeof g.reason === "string" ? g.reason : undefined,
    });
  }

  // Sort by time, drop any that overlap a kept one (no two at once).
  out.sort((a, b) => a.startTime - b.startTime);
  const spaced: MotionGraphicClip[] = [];
  for (const g of out) {
    const prev = spaced[spaced.length - 1];
    if (prev && g.startTime < prev.endTime + 0.4) continue; // need a clean gap
    spaced.push(g);
  }

  return spaced.slice(0, maxGraphicsFor(durationSeconds));
}

/**
 * Ask the director for motion graphics. Returns [] on any failure or when the
 * flag is off / Claude isn't configured — the render then proceeds graphics-free.
 */
export async function planMotionGraphics(
  ctx: DirectorContext,
): Promise<MotionGraphicClip[]> {
  if (!config.motionGraphicsEnabled) return [];
  if (!anthropicConfigured()) return [];
  const transcript = (ctx.transcript || "").trim();
  if (transcript.length < 40 || ctx.durationSeconds < 8) return [];

  const beatsLine = ctx.beats?.length
    ? `\nCoarse beats (s): ${ctx.beats
        .map((b) => `${b.start.toFixed(1)}-${b.end.toFixed(1)}${b.label ? ` (${b.label})` : ""}`)
        .join(", ")}`
    : "";

  const user =
    `Video duration: ${ctx.durationSeconds.toFixed(1)}s. ` +
    `Place at most ${maxGraphicsFor(ctx.durationSeconds)} motion graphics, and fewer if fewer are motivated.${beatsLine}\n\n` +
    `TRANSCRIPT:\n${transcript}\n\nReturn the graphics JSON now.`;

  try {
    const rawJson = await claudeChatJSON({
      // research tier (Sonnet) is plenty for this scoped placement decision and
      // keeps it cheap; resolveTier maps "gpt-4o" + this prompt to research.
      model: "gpt-4o",
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const parsed = JSON.parse(rawJson);
    const graphics = sanitize(parsed, ctx.durationSeconds);
    console.log(
      `[motion] director planned ${graphics.length} graphic(s)` +
        graphics.map((g) => ` ${g.kind}@${g.startTime}s`).join(""),
    );
    return graphics;
  } catch (e) {
    console.warn(
      `[motion] director plan failed — no graphics this run: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}

// Re-export so a future caller can pick the director model explicitly.
export const directorModel = aiConfig.models.research;
