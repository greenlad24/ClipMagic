/**
 * The bar-Jake voice, for captions.
 *
 * The Bulk Scheduler's caption writer used to have NO voice guidance at all —
 * the only style instruction in the whole prompt was "make each platform's
 * caption different". With nothing else to go on the model wrote generic
 * marketing copy: measured across 908 real captions, 89% carried an em-dash and
 * a third opened on "here's why…". That reads as machine-written, which is a
 * CONTENT-quality problem (platforms score it) rather than an automation one.
 *
 * Jake's voice is already written down — the Script Generator runs on it. This
 * module reads THOSE SAME FILES rather than restating them, so editing SOUL.md
 * or the rule amendments steers scripts and captions together and they can never
 * drift apart:
 *   - scriptgen/reference/SOUL.md          → the bar-Jake persona + hard rules
 *   - scriptgen/prompts/rule-amendments.md → §8 banned words / talk like a person
 *
 * Both are copied into dist by `copy:assets` (tsc does not copy .md), which is
 * why they can be read at runtime here.
 *
 * Prompting alone is not enough — the model reintroduces banned phrasing the way
 * it reintroduced like-bait (2026-08-24). So the tells are ALSO stripped
 * deterministically in assemblePlatformCaption, same as URLs and like-bait.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Read a reference doc; a missing file degrades to "" (never throws). */
function readRef(relative: string): string {
  try {
    return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}

/**
 * Extract one `## Heading` section (up to the next `## ` or `---` rule).
 * Returns "" when the heading isn't found, so a renamed section degrades to
 * "less guidance" rather than to a crash.
 */
export function markdownSection(doc: string, heading: RegExp): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
  if (start < 0) return "";
  const body: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/**
 * Bump when the voice CHANGES MEANINGFULLY. Every caption is stamped with the
 * version that wrote it, so the review step can tell "written before the voice
 * existed" from "written badly" — the difference is invisible in the text once
 * the deterministic strip has cleaned the em-dashes off an old caption.
 *
 * 1 = the first bar-Jake voice (2026-08-24).
 * 2 = full sentences (2026-08-24). v1 said "short sentences" and the model read
 *     that as licence to drop the subject — "Met a competitor…" for "I met a
 *     competitor…" — which is the clipped-fragment shape rule 8 forbids. Any
 *     caption written under v1 is re-flagged for rewrite.
 */
export const CAPTION_VOICE_VERSION = 2;

let cached: string | null = null;

/**
 * The voice block injected into the caption system prompt. Built once per
 * process — the reference files don't change under a running server.
 */
export function captionVoiceBlock(): string {
  if (cached !== null) return cached;
  const soul = readRef("../scriptgen/reference/SOUL.md");
  const amendments = readRef("../scriptgen/prompts/rule-amendments.md");

  const persona = markdownSection(soul, /BRAND PERSONA/i);
  const hardRules = markdownSection(soul, /HARD CONTENT RULES/i);
  const talkLikeAPerson = markdownSection(amendments, /Banned words/i);

  const parts = [
    "VOICE — you are writing AS Jake Dawson. This matters more than any copywriting instinct you have.",
    persona,
    hardRules,
    talkLikeAPerson,
    // Caption-specific, because the source docs are written for spoken scripts.
    [
      "## Writing captions in this voice",
      "",
      "- NEVER use an em-dash (—). Split the sentence in two instead. This is the single loudest tell that a caption was machine-written.",
      // "Short sentences" alone steered the model into TELEGRAPHIC copy — it
      // started dropping the subject ("Met a competitor…" for "I met a
      // competitor…"), which is the clipped-fragment shape rule 8 above
      // explicitly forbids. Short has to mean "one idea", not "fewer words".
      "- One idea per sentence. Short because each sentence says one thing, NOT because words were cut out of it.",
      "- Write FULL sentences. NEVER drop the leading subject or the small connecting words to save space: write \"I met a competitor who does exactly what I do\", never \"Met a competitor who does exactly what I do\". A clipped fragment reads as ad copy, which is the opposite of this voice.",
      "- Keep the words a person actually says out loud: I, and, so, but, then, actually, still. Trimming them is what makes writing sound like a machine compressed it.",
      "- No copywriter openers: not \"Here's why\", not \"Here's the thing\", not \"Stop doing X\", not \"The reason?\", not \"Let that sink in\".",
      "- Do not stack a three-item rhythm just because it sounds good. Say the thing once.",
      "- Dry humour that feels accidental, not performed. Never at the viewer.",
      "- The bar test applies to every line: would Jake say this to a stranger he just met and likes? If no, cut it.",
      "- Write like one person talking to one person. If a line would work as a landing-page headline, rewrite it.",
    ].join("\n"),
  ].filter(Boolean);
  cached = parts.join("\n\n");
  return cached;
}

/** Test seam: forget the cached voice block (the reference files are read once). */
export function resetCaptionVoiceCache(): void {
  cached = null;
}

// ── Deterministic de-tell ─────────────────────────────────────────────────────
/**
 * Word swaps from rule-amendments §8. Each is a word Jake does not write; the
 * replacement is the one the rule doc names. Applied case-insensitively with the
 * original capitalization preserved on the first letter.
 */
const WORD_SWAPS: Array<[RegExp, string]> = [
  [/\bcaveat\b/gi, "catch"],
  [/\bgenuinely\s+/gi, ""],
  [/\bwhether\b/gi, "if"],
  [/\bthe real deal\b/gi, "the real thing"],
];

/** Copywriter openers that read as generated. Cut the lead-in, keep the sentence. */
const OPENER_CUTS: Array<[RegExp, string]> = [
  [/(^|\n)here'?s (?:why|what|how|the thing|the kicker|the fix)[:,]?\s*/gi, "$1"],
  [/(^|\n)the (?:reason|kicker|pattern|breakthrough|fix)\??[:—]\s*/gi, "$1"],
  [/\blet that sink in\.?\s*/gi, ""],
];

/**
 * Replace em-dashes the way rule §8 says to: split into two short sentences.
 *
 * A period is used when what follows is a real clause, a comma when it is a
 * short fragment — turning "options—you're converting at 9%" into two sentences
 * reads like Jake, but doing it to a two-word tail would leave a fragment.
 */
export function splitEmDashes(text: string): string {
  return text.replace(/\s*—\s*/g, (_m, offset: number, whole: string) => {
    const after = whole.slice(offset).replace(/^\s*—\s*/, "");
    const tail = after.split(/(?<=[.!?])\s|\n/)[0] ?? "";
    const words = tail.trim().split(/\s+/).filter(Boolean).length;
    return words >= 4 ? ". " : ", ";
  });
}

/**
 * Capitalize after a sentence break we introduced — and at the start of the
 * caption or any line, because cutting a leading opener ("Here's why: buyers
 * freeze.") otherwise leaves the HOOK starting in lowercase.
 */
function recapitalize(text: string): string {
  return text
    .replace(/([.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    .replace(/(^|\n)(\s*)([a-z])/g, (_m, br, sp, c) => br + sp + c.toUpperCase());
}

/**
 * Strip the tells that make a caption read as generated. Runs alongside the
 * existing URL and like-bait strips in assemblePlatformCaption, for the same
 * reason: the prompt asks, this guarantees.
 */
export function stripAiTells(caption: string): string {
  let out = caption;
  for (const [re, to] of OPENER_CUTS) out = out.replace(re, to);
  out = splitEmDashes(out);
  for (const [re, to] of WORD_SWAPS) out = out.replace(re, to);
  out = recapitalize(out);
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
}

// ── How often a campaign is allowed to ask ────────────────────────────────────
/**
 * One post out of every N carries the CTA once the quiet period ends.
 *
 * Not every post: an identical ask on 95% of a feed is a template fingerprint
 * louder than any single caption, and a new account that wants something every
 * time reads as a funnel. Env-overridable alongside the keyword itself.
 */
export const CTA_EVERY_NTH_POST = Math.max(
  1,
  Number.parseInt(process.env.BULK_CTA_EVERY_NTH || "3", 10) || 3,
);

/** A scheduled drop, as far as CTA policy is concerned. */
export interface CtaDrop {
  fileId: string;
  /** Whole days from the schedule's start day. */
  dayOffset: number;
  /** Position within that day. */
  slot: number;
}

/**
 * Decide which drops ship WITHOUT the comment CTA. Returns the fileIds to strip.
 *
 * Two rules, in order:
 *   1. QUIET PERIOD — nothing before `quietUntilDayOffset` asks for anything.
 *   2. Afterwards, one drop in every `everyNth` carries the ask; the rest don't.
 *      Counting restarts after the quiet period, so the first ask lands on the
 *      Nth post of the campaign proper, not at some offset inherited from it.
 *
 * The decision is per DROP, not per post: one video says the same thing on every
 * account, so a follower on any single platform sees an ask every Nth post —
 * which is what "one every three posts" means from where they are sitting.
 *
 * Deterministic: drops are ordered by (day, slot), so the same plan always
 * chooses the same posts and a rebuild doesn't reshuffle who asks.
 */
export function ctaSuppressedFileIds(
  drops: readonly CtaDrop[],
  opts: { quietUntilDayOffset: number; everyNth?: number },
): Set<string> {
  const everyNth = Math.max(1, Math.floor(opts.everyNth ?? CTA_EVERY_NTH_POST));
  const ordered = [...drops].sort((a, b) => a.dayOffset - b.dayOffset || a.slot - b.slot || (a.fileId < b.fileId ? -1 : 1));
  const out = new Set<string>();
  let sinceQuiet = 0;
  for (const d of ordered) {
    if (d.dayOffset < opts.quietUntilDayOffset) {
      out.add(d.fileId);
      continue;
    }
    // The Nth drop after the quiet period asks; 1 and 2 of every 3 do not.
    const asks = (sinceQuiet + 1) % everyNth === 0;
    if (!asks) out.add(d.fileId);
    sinceQuiet++;
  }
  return out;
}

// ── Warm-up: no ask at all ────────────────────────────────────────────────────
/**
 * Remove the growth CTA from a caption.
 *
 * The whole 8-week ramp-up ships NO call to action (Jake's call), and after it
 * only one drop in three asks. A new account whose every post wants something
 * reads as a funnel, and 95% of posts carrying a byte-identical CTA line is a
 * template fingerprint far louder than any single caption.
 *
 * It is removed HERE rather than never generated, because captions are cached
 * per (file, platform) while the CTA depends on WHEN the post lands. Generating
 * two variants would double the AI bill and split the cache; stripping at
 * assembly keeps one cached caption usable in either phase.
 *
 * The closing question is deliberately kept — that is engagement, not an offer,
 * and the growth scorer requires the caption to end on one.
 */
export function stripGrowthCta(caption: string, keyword: string): string {
  const kw = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // CASE-SENSITIVE on purpose. The CTA keyword ships in capitals ("Comment
  // PROMPTS"), and matching loosely strips the ordinary English word out of
  // legitimate lines — "staying focused on prompts?" lost 9 of 908 real captions
  // their closing question before this was tightened.
  const hits = () => new RegExp(`\\b${kw}\\b`);
  // Sentence-level ONLY. Dropping a whole PARAGRAPH that mentions the keyword
  // also throws away the closing question when the model put both in one block —
  // that cost 22 of 908 real captions their required question, and emptied 6
  // outright. A paragraph left with nothing is dropped; one with value survives.
  const out = caption
    .split(/\n{2,}/)
    .map((para) => {
      if (!hits().test(para)) return para;
      return para
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !hits().test(sentence))
        .join(" ")
        .trim();
    })
    .filter((para) => para.trim().length > 0)
    .join("\n\n");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
