/**
 * THE SCRIPT GENERATOR'S WRITING RULES, for every other spoken script the Lab writes — the AI News Stream's
 * story scripts and the Deep Dive (classic, demo-first and the demo voiceover).
 *
 * Jake 2026-10-12: "I want to make the scripts of the deepdive and the ai news with more simple English — less
 * numbers and less technical terms. It needs to follow the exact rules of the script generator."
 *
 * ⚠️ BUILT FROM THE GENERATOR'S OWN FILES AND CHECKS, NEVER COPIED. The prompt block is sliced out of
 * prompts/rule-amendments.md (§7 plain English + jargon, §8 banned words, §10 no announcing) and
 * prompts/stage5-section.md (SENTENCE STRUCTURE, WORD SWAPS, NUMBERS); the lint runs edits.ts's own finders
 * (findBannedWords, findSlopPhrases, findUnexplainedJargon, findTaglineEndings, GENERIC_APPROVAL_RE). A rule changed
 * for the YouTube scripts changes here the next time the Lab starts. What is added on top is only what the spoken
 * news format needs: FEWER NUMBERS (the slides carry the figures) and the news show's insider-word list.
 *
 * The fix pass is the generator's own "check → one patch pass" (run.ts Stage 7.5): find/replace edits applied by
 * applyBriefEdits — so section and [next] markers survive — then checked again; never fatal.
 */
import { loadPrompt } from "./prompts.js";
import {
  AI_SLOP_PHRASES,
  applyBriefEdits,
  BANNED_WORDS,
  findBannedWords,
  findSlopPhrases,
  findTaglineEndings,
  findUnexplainedJargon,
  GENERIC_APPROVAL_RE,
} from "./edits.js";

/** `## N.` section(s) of a prompt file, by heading number, verbatim. */
function sections(md: string, nums: number[]): string {
  const parts = md.split(/\n(?=## \d+\.)/);
  return parts.filter((p) => nums.some((n) => p.startsWith(`## ${n}.`))).join("\n\n").trim();
}

/** A block of stage5-section.md from its label line up to the next "---" rule. */
function block(md: string, label: string): string {
  const at = md.indexOf(label);
  if (at < 0) return "";
  const end = md.indexOf("\n---", at);
  return md.slice(at, end < 0 ? undefined : end).trim();
}

/** Insider words the news show avoids unless the story is about the term itself (from the news style guide). */
export const NEWS_TECH_TERMS = [
  "benchmark", "tool call", "parameters", "tokens", "inference", "latency", "throughput", "compute", "flagship",
  "SOTA", "frontier model", "open weights", "open-weight", "multimodal", "context window", "fine-tuning", "fine-tuned",
  "endpoint", "agentic", "orchestration", "pipeline", "LLM", "GPU", "API",
];

export const FEWER_NUMBERS_RULE = `FEWER NUMBERS (spoken news and deep dives — the slides carry the figures):
- A number only when it IS the point of the sentence. Most sentences need none.
- At most one number in a paragraph, and never two in one sentence.
- Round it and say it the way people say it: "about a third", "twice as fast", "around a hundred dollars", "thirty percent".
- Prefer what it means for the viewer over the figure: "it answers before you finish your coffee", not "it answers in 1.8 seconds".
- Never read out a run of scores, versions, prices, dates or user counts. Pick the one that matters, or none.
- Model and version names: say the name a person would say ("the new Claude"), not every decimal of the version.`;

// Jake 2026-10-12: "the presentations should be less technical — it can demonstrate a little bit technical things on
// the screen (just a little bit) — but never in the script".
export const FEWER_TECH_TERMS_RULE = `NO TECHNICAL TERMS IN THE SCRIPT (this overrides rule 7's "every technical term gets one simple line" for this show):
- Never a technical term in what Jake says — not even explained. Say what the thing DOES in everyday words, or leave it out.
- Names are fine: a product, a model, a company, a law ("Claude", "Gemini", "the EU AI Act"). Technical CONCEPTS are not.
- If the screen shows something technical (a setting, a line of code, a chart label), the script says what it means for the viewer — never reads the technical part out.
- Words that never appear in the script: ${NEWS_TECH_TERMS.join(", ")}.`;

/** Text of a prompt file from the line starting with `from` through the line containing `to` (both kept). */
function between(md: string, from: string, to: string): string {
  const a = md.indexOf(from);
  if (a < 0) return "";
  const b = md.indexOf(to, a);
  return md.slice(a, b < 0 ? undefined : md.indexOf("\n", b) < 0 ? undefined : md.indexOf("\n", b)).trim();
}

/**
 * KEEP THEM WATCHING — Jake 2026-10-12: "The presentation and script should be engaging — the goal of those
 * presentations is to keep viewers hooked into watching more … the content inside of the presentation and script
 * should always be interesting". The generator's own casting rule (stage2-outline) and watchability checks
 * (stage7-review) verbatim, plus what a live news segment / deep dive needs on top.
 */
export const ENGAGEMENT_BLOCK: string = (() => {
  const outline = loadPrompt("stage2-outline");
  const review = loadPrompt("stage7-review");
  return [
    "KEEP THEM WATCHING — every presentation's job is to keep the viewer watching the next minute. Interesting beats complete.",
    "- Lead with the most interesting thing: the result, the surprise, the \"wait, really?\" detail — never background first.",
    "- Every paragraph reveals something NEW (a result, a twist, a comparison, a consequence for the viewer). A paragraph that only sets up or restates gets cut or merged.",
    "- Open a question the next part answers (\"and the price is where it gets weird — we'll get there\"), and pay it off. Save one good surprise for late so it never sags.",
    "- Make it about the viewer's life: what changes for them, in a concrete everyday moment.",
    "- If a story has nothing surprising in it, say the one thing that IS interesting and keep it short — never pad a dull story.",
    "THE SCRIPT GENERATOR'S CASTING RULE:",
    between(outline, "Given two examples that teach the same lesson", "re-order the sections until it lands last."),
    "THE SCRIPT GENERATOR'S WATCHABILITY CHECKS (for a news story: at least one dry, funny line; for a deep dive: three):",
    between(review, "**Watchability", "or cut it."),
  ].filter(Boolean).join("\n");
})();

const plainBanned = (): string[] => BANNED_WORDS.filter((w) => /^[a-z][a-z' -]*$/i.test(w));
/** Phrases written out (pattern entries stay in the code check, where they can be matched). */
const plainSlop = (): string[] => AI_SLOP_PHRASES.filter((w) => /^[a-z][a-z' ,.-]*$/i.test(w));

/** The plain banned words + the first AI-sounding phrases, comma-joined — for a prompt that only needs the list. */
export function spokenBannedList(): string {
  return [...plainBanned(), ...plainSlop().slice(0, 25)].join(", ");
}

/** The rule block every news / deep-dive script prompt carries (and every review / fix prompt). */
export const SPOKEN_RULES_BLOCK: string = (() => {
  const amend = loadPrompt("rule-amendments");
  const s5 = loadPrompt("stage5-section");
  return [
    "THE SCRIPT GENERATOR'S RULES — these override anything above that contradicts them:",
    ENGAGEMENT_BLOCK,
    sections(amend, [7, 8, 10]),
    block(s5, "SENTENCE STRUCTURE:"),
    block(s5, "WORD SWAPS"),
    block(s5, "NUMBERS — state clearly"),
    FEWER_NUMBERS_RULE,
    FEWER_TECH_TERMS_RULE,
    `NEVER WRITE these words: ${plainBanned().join(", ")} — and never ", which" / "whether" (split the sentence; say "if").`,
    `NEVER WRITE these phrases: ${plainSlop().join(" / ")}.`,
    'No generic approval lines ("that\'s a huge win", "you love to see it") — say what it does for the viewer instead.',
  ]
    .filter(Boolean)
    .join("\n\n");
})();

const MARKER_RE = /\[next\]|^###\s*SECTION\s*\d+.*$/gim;
const YEAR_RE = /^(19|20)\d\d$/;
const NUMBER_WORDS =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|percent)\b/gi;

/** The numbers spoken in one paragraph: digit groups (not years) + spelled-out numbers (a run like "two hundred
 * thousand" counts once; a lone "one", as in "one thing", is not a statistic). */
function numbersIn(p: string): string[] {
  const digits = (p.match(/\d[\d,.]*%?/g) ?? []).filter((d) => !YEAR_RE.test(d.replace(/[,.%]/g, "")));
  const noLoneOne = p.replace(/\bone\b(?![\s-]+(hundred|thousand|million|billion|trillion|percent)\b)/gi, " ");
  const runs = noLoneOne.replace(NUMBER_WORDS, "#N#").match(/#N#(?:[\s-]+(?:and[\s-]+)?#N#)*/g) ?? [];
  return [...digits, ...runs];
}

/** The FEWER NUMBERS check: paragraphs with more than one number, sentences with two. */
export function findNumberOverload(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{1,}/).map((x) => x.trim()).filter(Boolean)) {
    const n = numbersIn(para).length;
    if (n > 1) out.push(`Too many numbers (${n}) in one paragraph — keep the one that is the point, round it, say what it means: "${para.slice(0, 110)}…"`);
  }
  return out;
}

/** Insider terms the news show leaves out, with where they were found. */
export function findTechTerms(text: string): string[] {
  const out: string[] = [];
  for (const t of NEWS_TECH_TERMS) {
    const re = new RegExp(`\\b${t.replace(/[-]/g, "[- ]")}\\b`, t === t.toUpperCase() ? "g" : "gi");
    const m = re.exec(text);
    if (m) out.push(`Technical term "${t}" in the script — never in what Jake says: say what it does in everyday words, or leave it out: "…${text.slice(Math.max(0, m.index - 50), m.index + 60).replace(/\s+/g, " ")}…"`);
  }
  return out;
}

/** Every rule the generator checks in code, run on a spoken script (markers stripped). Reports only. */
export function lintSpokenScript(raw: string): string[] {
  const text = raw.replace(MARKER_RE, " ");
  const out = [
    ...findBannedWords(text).map((x) => `Banned word: ${x}`),
    ...findSlopPhrases(text).map((x) => `AI-sounding phrase: ${x}`),
    ...findUnexplainedJargon(text).map((x) => `Unexplained jargon: ${x}`),
    ...findTaglineEndings(text).map((x) => `Tagline ending: ${x}`),
    ...findTechTerms(text),
    ...findNumberOverload(text),
  ];
  const ga = new RegExp(GENERIC_APPROVAL_RE.source, GENERIC_APPROVAL_RE.flags.includes("g") ? GENERIC_APPROVAL_RE.flags : GENERIC_APPROVAL_RE.flags + "g");
  for (const m of text.matchAll(ga)) out.push(`Generic approval line: "${m[0]}" — say what it does for the viewer instead`);
  return [...new Set(out)];
}

/** The generator's patch prompt (run.ts claimFixPrompt's contract), for a spoken script. */
export function spokenFixPrompt(script: string, findings: string[]): string {
  return [
    "A Jake Dawson spoken script has failed the script generator's checks. Fix exactly what is listed and nothing else.",
    "",
    "WHAT FAILED:",
    ...findings.map((f, i) => `${i + 1}. ${f}`),
    "",
    "RULES:",
    "- Change as little as possible. One sentence per finding wherever one sentence will do.",
    "- Simpler English: everyday words, fewer numbers, no insider terms. Keep Jake's voice — the smart, curious friend at the bar.",
    "- Never introduce a new number, statistic, name or claim. Removing a number is safer than replacing it.",
    "- Never touch a line that is only a marker ([next] or ### SECTION n), and never remove or add one.",
    "- If a finding cannot be fixed without rewriting the paragraph around it, skip it and say why.",
    "",
    SPOKEN_RULES_BLOCK,
    "",
    "SCRIPT:",
    script,
    "",
    'Reply with JSON only: {"edits": [{"mode": "replace", "find": "the exact text to replace, copied verbatim", "text": "the replacement", "reason": "which finding this closes"}], "skipped": ["finding you could not fix, and why"]}',
    "",
    "`find` must appear in the script EXACTLY as written, once. Copy it, do not retype it.",
  ].join("\n");
}

function parseEdits(reply: string): unknown[] {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j?.edits) ? j.edits : [];
  } catch {
    return [];
  }
}

/**
 * Check a finished spoken script and, when something fails, run ONE patch pass (find/replace edits, max 8 per
 * call — a long script is patched chunk by chunk). Markers are protected: an edit touching one is dropped.
 * Never throws: any failure returns the script as it was. → {script, findings (before), remaining (after)}.
 */
export async function enforceSpokenRules(
  script: string,
  call: (prompt: string) => Promise<string>,
  log: (m: string) => void = () => undefined,
): Promise<{ script: string; findings: string[]; remaining: string[] }> {
  const findings = lintSpokenScript(script);
  if (!findings.length) return { script, findings, remaining: [] };
  let out = script;
  try {
    // chunks of whole sections (or paragraphs) so each patch call sees at most ~8 findings
    const units = script.split(/(?=^###\s*SECTION\s*\d+)/m);
    const fixed: string[] = [];
    for (const u of units) {
      const f = lintSpokenScript(u);
      if (!f.length) {
        fixed.push(u);
        continue;
      }
      const reply = await call(spokenFixPrompt(u, f.slice(0, 8)));
      const edits = parseEdits(reply).filter((e: any) => {
        const s = `${e?.find ?? ""} ${e?.text ?? ""}`;
        return !/\[next\]|###\s*SECTION/i.test(String(e?.find ?? "")) && (String(s).match(/\[next\]/g) ?? []).length === 0;
      });
      const r = applyBriefEdits(u, edits, "spoken rules");
      fixed.push(r.script);
      if (r.applied.length) log(`spoken rules: ${r.applied.length} fix(es) applied`);
    }
    out = fixed.join("");
  } catch (e) {
    log(`spoken rules: fix pass skipped (${e instanceof Error ? e.message : String(e)})`);
    out = script;
  }
  return { script: out, findings, remaining: lintSpokenScript(out) };
}
