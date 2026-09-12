/**
 * The self-improvement loop: what Jake's edits teach the generator.
 *
 * Jake, 2026-09-07, after hand-editing the Ghibli walkthrough: *"I want the
 * script generator to improve based on my edits — doing diffs to each script …
 * show on the side its conclusions from my edits and have an approve button for
 * fixing it for the next generations … the conclusions should only happen after
 * I clicked the done button (not while autosaving)."*
 *
 * The loop, in four parts, three of which are deterministic:
 *
 *   1. `editDiff.ts` aligns the generated script against the finished one and
 *      produces a real change list. No model involved.
 *   2. THIS module asks one Opus call what that list has in common, and gets
 *      back rules — never edits, never rewrites, never anything that reaches a
 *      script directly.
 *   3. Every rule lands as `pending` and is shown beside the editor.
 *   4. An approved rule joins `systemPreamble()` and is read by every stage of
 *      every future run. A rejected one is never seen again.
 *
 * ⚠️⚠️ THE APPROVAL GATE IS THE FEATURE, NOT A FORMALITY. This is a model
 * inferring how Jake wants to be written for, from evidence it did not choose,
 * and then editing its own instructions. Left to run on its own it would drift
 * the voice one plausible generalisation at a time — and the drift would arrive
 * inside scripts that read fine, which is the version of this that nobody
 * catches. `approvedLessons()` is the only read that reaches a generation, and
 * nothing but a human click sets that state.
 *
 * ⚠️ AND IT LEARNS RULES, NOT FACTS. "Google Flow gives fifty credits a day" is
 * true of one video and wrong in a month; "never open a paragraph with a dated
 * product-history aside" is true of every video Jake will ever record. The
 * prompt below spends most of its length on that distinction, because a lesson
 * bank full of last month's prices is worse than no lesson bank at all.
 */
import { opusScriptChat, extractJson, scriptgenUsageTotal } from "../ai/claude.js";
import { diffScripts, renderDiffForModel, type EditDiff } from "./editDiff.js";
import {
  addVersion,
  approvedLessons,
  hasVersionOfSource,
  insertLesson,
  insertReview,
  latestReview,
  lessonsForReview,
} from "../db/scriptEdits.js";
import type { ScriptEditReview, ScriptLesson, ScriptLessonEvidence } from "./types.js";

/** How many rules one edit may propose. Small on purpose — see the prompt. */
const MAX_LESSONS = 6;
/** Below this much change there is nothing to generalise from. */
const MIN_CHANGES = 3;

/* ────────────────────────── the conclusions prompt ────────────────────────── */

const SYSTEM = [
  "You are improving the prompt set of a YouTube script generator that writes in Jake Dawson's voice.",
  "",
  "Jake generated a script with it, then edited the script by hand until he was happy to record it. You are",
  "being shown a mechanical diff of those two versions — computed in code, not by a model, so every change",
  "listed is a change he actually made.",
  "",
  "Your job: say what the generator should DO DIFFERENTLY NEXT TIME so he has to make fewer of these edits.",
  "",
  "==========================================",
  "WHAT A GOOD RULE IS",
  "==========================================",
  "",
  "A rule is an instruction the script writer can follow on a COMPLETELY DIFFERENT video — a different tool,",
  "a different topic, a different week — and be more right for having followed it.",
  "",
  "- GOOD: \"Open with one line of what's on screen, then the promise of what the viewer will be able to do,",
  "  then the channel intro. Do not stack three or four teases before the intro.\"",
  "- GOOD: \"Never write a dated product-history aside ('back on February 25th, Google rebuilt X') — say what",
  "  the tool does now.\"",
  "- GOOD: \"Name the actual tools rather than writing 'a chat tool'.\"",
  "- BAD: \"Google Flow gives fifty credits a day.\" That is a fact about one video, and it will be wrong soon.",
  "- BAD: \"Change 'hauling' to 'running'.\" That is one word in one sentence, not a rule.",
  "- BAD: \"Write more like Jake.\" Unfollowable.",
  "- BAD: anything about THIS video's subject, characters, or numbers.",
  "",
  "==========================================",
  "HOW TO READ THE DIFF",
  "==========================================",
  "",
  "- A paragraph he CUT ENTIRELY is the strongest signal in here. Ask what it was doing that he did not want",
  "  done at all.",
  "- A paragraph he WROTE HIMSELF is the second strongest: the generator never said that thing, and he needed",
  "  it said.",
  "- A REWORDING matters when the same KIND of change happens three or four times. One swapped word is noise.",
  "- WHERE the changes are is itself a finding. If they all sit in the opening third and the rest survived",
  "  untouched, the rule is about openings, and you should say so.",
  "- Something he changed in EVERY instance (a label he adds before each prompt, a formatting convention) is a",
  "  format rule, and those are the cheapest of all to follow.",
  "",
  "==========================================",
  "WHAT NOT TO DO",
  "==========================================",
  "",
  `- Do not propose more than ${MAX_LESSONS} rules. Three excellent rules beat six thin ones, and every rule you`,
  "  propose has to be read and approved by a person. Propose only what the evidence genuinely supports.",
  "- Do not repeat, restate or slightly reword a rule that is already active (they are listed below). If the",
  "  edits show an active rule was IGNORED rather than missing, say nothing — that is a compliance problem,",
  "  not a new rule.",
  "- Do not invent a change that is not in the diff.",
  "- Do not propose a rule from a single instance unless it is a formatting convention applied consistently.",
  "- Never propose anything that would make the writer LESS specific, less concrete, or less grounded in",
  "  research. Vaguer is not shorter.",
  "",
  "==========================================",
  "OUTPUT",
  "==========================================",
  "",
  "STRICT JSON only. No markdown, no commentary, no code fence:",
  "",
  '{"lessons": [{"rule": "...", "rationale": "...", "scope": "voice|structure|format|facts",',
  '  "evidence": [{"before": "...", "after": "..."}]}]}',
  "",
  "- `rule`: written as an instruction TO the script writer, in the imperative, 1-3 sentences. This text is",
  "  pasted verbatim into the prompt set, so write it to be followed, not to be read as analysis.",
  "- `rationale`: one sentence to the human approving it, saying what in the diff you are relying on.",
  "- `scope`: `structure` for what goes where, `voice` for how it sounds, `format` for a written convention",
  "  (labels, screen directions), `facts` for what may be claimed.",
  "- `evidence`: one to three before/after pairs, QUOTED FROM THE DIFF, shortened to the relevant clause. For",
  "  a cut paragraph put it in `before` and leave `after` empty; for one he wrote, the reverse.",
  "- An edit that teaches nothing generalisable is a correct and expected answer: return `{\"lessons\": []}`.",
].join("\n");

/** The rules already in force, so the pass cannot propose them again. */
function activeRulesBlock(active: ScriptLesson[]): string {
  if (!active.length) {
    return "## RULES ALREADY ACTIVE\n\nNone yet — this is the first edit being learned from.";
  }
  return [
    "## RULES ALREADY ACTIVE — do not propose these again, in any wording",
    "",
    ...active.map((l, i) => `${i + 1}. ${l.rule}`),
  ].join("\n");
}

/* ────────────────────────── the pass ────────────────────────── */

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const SCOPES = new Set(["voice", "structure", "format", "facts"]);

function parseLessons(raw: string): Array<{
  rule: string;
  rationale: string;
  scope: ScriptLesson["scope"];
  evidence: ScriptLessonEvidence[];
}> {
  let parsed: { lessons?: unknown };
  try {
    parsed = JSON.parse(extractJson(raw)) as { lessons?: unknown };
  } catch {
    return [];
  }
  const list = Array.isArray(parsed.lessons) ? parsed.lessons : [];
  const out: Array<{ rule: string; rationale: string; scope: ScriptLesson["scope"]; evidence: ScriptLessonEvidence[] }> =
    [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const rule = asText(o.rule);
    // A rule that is a fragment cannot be followed and cannot be judged; a
    // silently dropped one is better than a line of noise in the prompt set.
    if (rule.length < 20) continue;
    const scopeRaw = asText(o.scope).toLowerCase();
    const evidence = (Array.isArray(o.evidence) ? o.evidence : [])
      .map((e) => {
        const r = (e ?? {}) as Record<string, unknown>;
        return { before: asText(r.before).slice(0, 600), after: asText(r.after).slice(0, 600) };
      })
      .filter((e) => e.before || e.after)
      .slice(0, 3);
    out.push({
      rule: rule.slice(0, 800),
      rationale: asText(o.rationale).slice(0, 600),
      scope: (SCOPES.has(scopeRaw) ? scopeRaw : "voice") as ScriptLesson["scope"],
      evidence,
    });
    if (out.length >= MAX_LESSONS) break;
  }
  return out;
}

/**
 * Diff one finished edit and propose what to learn from it.
 *
 * Returns the stored review with its pending lessons. Never throws for a model
 * failure: a review that could not be analysed is recorded as `failed` with the
 * reason on it, because the versions and the diff counts are still worth having
 * and Jake has already clicked Done.
 */
export async function analyseEdit(input: {
  runId: string;
  runTitle: string;
  generated: string;
  edited: string;
  versionId: string;
}): Promise<ScriptEditReview> {
  const diff: EditDiff = diffScripts(input.generated, input.edited);
  const changeCount = diff.changes.length;

  if (changeCount < MIN_CHANGES) {
    const id = insertReview({
      runId: input.runId,
      versionId: input.versionId,
      stats: diff.stats,
      changes: diff.changes,
      status: "ready",
    });
    return {
      id,
      runId: input.runId,
      versionId: input.versionId,
      stats: diff.stats,
      status: "ready",
      error: null,
      costUsd: 0,
      createdAt: Date.now(),
      lessons: [],
    };
  }

  const active = approvedLessons();
  const before = scriptgenUsageTotal().costUsd;
  let raw = "";
  let error: string | null = null;
  try {
    raw = await opusScriptChat({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `THE VIDEO: ${input.runTitle}`,
            "",
            activeRulesBlock(active),
            "",
            renderDiffForModel(diff),
          ].join("\n"),
        },
      ],
      // A short JSON answer. The ceiling is for the thinking, which is where the
      // judgement happens — the rules themselves are a few hundred words.
      maxTokens: 8000,
      effort: "high",
      label: "edit-lessons",
      purpose: "scriptgen",
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const costUsd = Number(Math.max(0, scriptgenUsageTotal().costUsd - before).toFixed(4));

  const proposals = error ? [] : parseLessons(raw);
  if (!error && raw.trim() && proposals.length === 0 && !/"lessons"\s*:\s*\[\s*\]/.test(raw)) {
    // Told apart deliberately: an empty array is a real answer ("nothing
    // generalisable here"), and an unparseable one is a failure that must not
    // masquerade as it.
    error = "The conclusions pass returned something that was not a usable list of rules.";
  }

  const reviewId = insertReview({
    runId: input.runId,
    versionId: input.versionId,
    stats: diff.stats,
    changes: diff.changes,
    status: error ? "failed" : "ready",
    error,
    costUsd,
  });
  for (const p of proposals) {
    insertLesson({ runId: input.runId, reviewId, rule: p.rule, rationale: p.rationale, evidence: p.evidence, scope: p.scope });
  }
  return {
    id: reviewId,
    runId: input.runId,
    versionId: input.versionId,
    stats: diff.stats,
    status: error ? "failed" : "ready",
    error,
    costUsd,
    createdAt: Date.now(),
    lessons: lessonsForReview(reviewId),
  };
}

/* ────────────────────────── what the writer sees ────────────────────────── */

/**
 * The approved rules, as a block for the system prompt.
 *
 * ⚠️ IT GOES AFTER `rule-amendments.md` AND SAYS WHY IT WINS. The amendments
 * file is the same idea done by hand — rules written from scripts Jake corrected
 * — so these belong in the same place and, being the most recent correction,
 * take precedence over it. Empty string when nothing is approved, so the prompt
 * is byte-identical to today's until the first rule is approved.
 */
export function approvedLessonBlock(): string {
  const rules = approvedLessons();
  if (!rules.length) return "";
  return [
    "",
    "---",
    "",
    "# LEARNED FROM JAKE'S OWN EDITS — the most recent corrections of all",
    "",
    "Each rule below was derived from a real diff between a script this generator wrote and the version Jake",
    "then edited by hand and recorded, and each one was read and approved by him. They are the newest",
    "corrections in this prompt set: where one of them disagrees with anything above, including the RULE",
    "AMENDMENTS, **these win**.",
    "",
    "They correct HOW the script is written. They never override a fact, a piece of research, or the brief.",
    "",
    ...rules.map((l, i) => `${i + 1}. ${l.rule}`),
    "",
  ].join("\n");
}

/** The panel's "reopen without paying twice" read. */
export function lastReviewFor(runId: string): ScriptEditReview | null {
  return latestReview(runId);
}

/**
 * Snapshot the generated script as version 1 the first time a run is edited.
 *
 * ⚠️ CHECKED AGAINST EVERY VERSION, NOT JUST THE LAST ONE. `addVersion` dedupes
 * only against the most recent snapshot — deliberately, so "Done" after a
 * restore is still a new point in time — and the generated text is never the
 * most recent by the time this runs a second time. Without this the baseline was
 * re-snapshotted on every Done and every rules pass: the real run had "v1 As
 * generated" and "v3 As generated", 35,293 identical characters apart.
 */
export function ensureGeneratedVersion(runId: string, generated: string): void {
  if (!generated.trim() || hasVersionOfSource(runId, "generated")) return;
  addVersion({ runId, source: "generated", text: generated, note: "As generated" });
}
