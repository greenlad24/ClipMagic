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
 * Applied to GENERATED text only. An editor save (Jake typing) is never cut.
 */

export interface Limit { w: number; c: number }

export const L = {
  /** a chapter / scene heading (v2, AI News) */
  heading: { w: 6, c: 44 },
  /** a classic slide's heading */
  headingV1: { w: 8, c: 56 },
  /** the AI News story cover headline */
  coverHeading: { w: 8, c: 56 },
  /** the AI News cover's one-line "why you care" */
  coverLede: { w: 16, c: 110 },
  /** the Deep Dive title chapter's lede / classic title subtitle */
  titleLede: { w: 18, c: 120 },
  agendaItem: { w: 4, c: 26 },
  eyebrow: { w: 4, c: 28 },
  island: { w: 3, c: 20 },
  flowLabel: { w: 2, c: 16 },
  flowText: { w: 6, c: 40 },
  cardName: { w: 3, c: 22 },
  cardTag: { w: 2, c: 14 },
  /** a card's big text when it's words, not a number */
  cardBig: { w: 3, c: 18 },
  cardSmall: { w: 7, c: 46 },
  cardNote: { w: 6, c: 40 },
  gate: { w: 3, c: 22 },
  statLabel: { w: 6, c: 40 },
  statDisplay: { w: 2, c: 10 },
  vsName: { w: 3, c: 22 },
  vsLine: { w: 9, c: 60 },
  vsPoint: { w: 5, c: 34 },
  tlDate: { w: 3, c: 12 },
  tlLabel: { w: 4, c: 28 },
  tlDetail: { w: 6, c: 42 },
  listItem: { w: 7, c: 48 },
  quote: { w: 24, c: 150 },
  who: { w: 4, c: 32 },
  role: { w: 6, c: 44 },
  takeaway: { w: 8, c: 56 },
  /** demo step / clip / article highlight caption */
  caption: { w: 7, c: 48 },
  /** classic: statement sentence, bullet, compare cell, bar label, media caption */
  statement: { w: 16, c: 100 },
  bullet: { w: 8, c: 56 },
  cmpCell: { w: 5, c: 32 },
  barLabel: { w: 3, c: 22 },
  mediaCaption: { w: 10, c: 64 },
} satisfies Record<string, Limit>;

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
