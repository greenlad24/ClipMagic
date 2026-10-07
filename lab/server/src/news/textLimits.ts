/**
 * ON-SCREEN TEXT LIMITS for the AI News story scenes (stage.ts) and both Deep
 * Dive formats (deepDive.ts classic, deepDiveV2.ts demo) — Jake, 2026-10-06:
 * "too much text in the AI news presentation … make sure there's not so much
 * text in each box".
 *
 * One table, used twice: the generation prompts quote these numbers
 * (`spec(L.x)` → "max 6 words / 40 characters"), and the normalisers trim
 * whatever the model sends anyway (`clip`), at a word boundary — with SLACK
 * (1.5× the words, 1.4× the characters): a field a word or two over the
 * asked-for limit still reads as a whole thought and the screen fits it,
 * while a runaway sentence is cut. (Trimming to the exact limit turned
 * "Type a request to make an image" into "Type a request to make".) The screens
 * also fit any text to its box (web deepdive/fitText.ts) — these limits are
 * what keeps that from having to shrink it.
 *
 * Tightened 2026-10-06 (second pass) so generated text fits at FULL size —
 * the screens only nudge text down a little (floors 0.85–0.9, fitText.ts).
 *
 * Applied to GENERATED text only. An editor save (Jake typing) is never cut.
 */

export interface Limit { w: number; c: number }

export const L = {
  /** a chapter / scene heading (v2, AI News) */
  heading: { w: 6, c: 40 },
  /** a classic slide's heading */
  headingV1: { w: 8, c: 56 },
  /** the AI News story cover headline */
  coverHeading: { w: 7, c: 44 },
  /** the AI News cover's one-line "why you care" */
  coverLede: { w: 14, c: 96 },
  /** the Deep Dive title chapter's lede / classic title subtitle */
  titleLede: { w: 18, c: 120 },
  agendaItem: { w: 4, c: 26 },
  eyebrow: { w: 4, c: 28 },
  /** an AI News slide's BEAT TITLE on the teleprompter marker ("▶ BEAT 1 · TITLE") — Jake: 3–4 words max. Never slack-clipped: tidyBeatTitle (stage.ts) holds it to 4 words. */
  beatTitle: { w: 4, c: 28 },
  island: { w: 3, c: 20 },
  flowLabel: { w: 2, c: 16 },
  flowText: { w: 5, c: 32 },
  cardName: { w: 3, c: 22 },
  cardTag: { w: 2, c: 14 },
  /** a card's big text when it's words, not a number */
  cardBig: { w: 3, c: 18 },
  cardSmall: { w: 6, c: 40 },
  cardNote: { w: 5, c: 34 },
  gate: { w: 3, c: 22 },
  statLabel: { w: 5, c: 34 },
  statDisplay: { w: 2, c: 10 },
  vsName: { w: 3, c: 22 },
  vsLine: { w: 8, c: 50 },
  vsPoint: { w: 4, c: 28 },
  tlDate: { w: 3, c: 12 },
  tlLabel: { w: 4, c: 28 },
  tlDetail: { w: 5, c: 36 },
  listItem: { w: 6, c: 42 },
  quote: { w: 20, c: 120 },
  who: { w: 4, c: 32 },
  role: { w: 6, c: 44 },
  takeaway: { w: 7, c: 48 },
  /* ── AI News story slides v3 (2026-10-07: 2–3 one-idea slides per story) ── */
  /** "big number" slide: what the number is */
  numLabel: { w: 8, c: 52 },
  /** "big number" slide: one line of context under it */
  numContext: { w: 10, c: 64 },
  /** "what it means" slide: the statement */
  meaning: { w: 9, c: 58 },
  /** "what it means" slide: the line under it ("for you: …") */
  meaningText: { w: 12, c: 80 },
  /** comparison slide: a side's big value ("Free", "$20/mo", "2×") */
  cmpBig: { w: 3, c: 14 },
  /** comparison slide: a side's one line */
  cmpLine: { w: 7, c: 44 },
  /** "key facts" slide: one fact */
  fact: { w: 7, c: 46 },
  /** picture slide: the caption beside the image */
  picCaption: { w: 12, c: 80 },
  /** demo step / clip / article highlight caption */
  caption: { w: 6, c: 42 },
  /** classic: statement sentence, bullet, compare cell, bar label, media caption */
  statement: { w: 14, c: 90 },
  bullet: { w: 7, c: 48 },
  cmpCell: { w: 5, c: 32 },
  barLabel: { w: 3, c: 22 },
  mediaCaption: { w: 10, c: 64 },
} satisfies Record<string, Limit>;

/**
 * Said once in every prompt: the screens set text BIG (Jake, 2026-10-06: "I
 * want the text to be readable and big, but not overlap"), so a long word in a
 * narrow card can't fit at full size.
 */
export const SHORT_WORDS = "Use short everyday words on screen — no word longer than 12 letters in card, step or list text (a long word can't fit a card at full size).";

/** "max 6 words / 40 characters" — what the prompts say. */
export const spec = (l: Limit): string => `max ${l.w} words / ${l.c} characters`;

const DANGLING = /\s+(and|or|but|the|a|an|of|to|for|with|in|on|at|by|from|as|is|that|its|your|their)$/i;

/**
 * Trim text to a limit at a WORD boundary (never mid-word unless one word is
 * longer than the whole limit), drop a dangling "and/the/of…" and trailing
 * punctuation, keep *accent* asterisks balanced. `ellipsis` marks a cut
 * (quotes: a shortened quote must say so).
 */
export function clip(v: unknown, limit: Limit, ellipsis = false): string {
  const t = (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const l = { w: Math.ceil(limit.w * 1.5), c: Math.round(limit.c * 1.4) };
  const words = t.split(" ");
  if (words.length <= l.w && t.length <= l.c) return t;
  let out = "";
  for (const w of words.slice(0, l.w)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > l.c) break;
    out = next;
  }
  if (!out) out = words[0].slice(0, l.c);
  let prev = "";
  while (prev !== out) { prev = out; out = out.replace(/[\s,;:–—\-(/]+$/, "").replace(DANGLING, ""); }
  if (!out) out = words[0].slice(0, l.c);
  if ((out.match(/\*/g) ?? []).length % 2) out = out.replace(/\*(?!.*\*)/, "");
  return ellipsis ? `${out.replace(/[.!?…]+$/, "")}…` : out;
}

/** Map a list through `clip`, dropping empties, keeping at most `max`. */
export const clipList = (v: unknown, l: Limit, max: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => clip(x, l)).filter(Boolean).slice(0, max);
