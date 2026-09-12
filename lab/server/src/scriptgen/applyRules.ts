/**
 * Apply the approved rules to a script that was written before they existed.
 *
 * Jake, 2026-09-07: *"After approving the learning insights I want to have a
 * button to rewrite based on the new rules — it should fix the current script
 * (all of the rest of the script not my edits) with the new rules and apply it
 * for all of the next scripts as well."*
 *
 * The second half of that is already true the moment a rule is approved:
 * `approvedLessonBlock()` rides in `systemPreamble()`, so every stage of every
 * future run reads it. This module is the first half — the script already on the
 * screen, which was written by a pipeline that had never heard of the rule.
 *
 * ⚠️⚠️ IT NEVER TOUCHES A PARAGRAPH JAKE WROTE OR CHANGED. Those are the whole
 * evidence base the rules were learned from, and rewriting them would be the
 * machine correcting the man it is imitating — the one edit that could quietly
 * undo an afternoon of work and read fine doing it. The lock is computed, not
 * asked for: the deterministic diff says which paragraphs survived from the
 * generated script untouched, and only those are ever offered to the rewrite.
 *
 * ⚠️ AND IT IS A STYLE PASS, NOT A REWRITE. Every number, price, URL, quoted
 * prompt, tool name and claim in an offered paragraph has already been through
 * Stage 1 research, the fact sheet and the claim audit. This pass may change how
 * a sentence reads and nothing about what it asserts — a script that comes back
 * sounding more like Jake and quietly claiming a different price is a worse
 * outcome than not running it at all.
 */
import { opusScriptChat, extractJson, scriptgenUsageTotal } from "../ai/claude.js";
import { systemPreamble } from "./prompts.js";
import { diffScripts, splitByAuthor, spokenLines, replaceLines, type SpokenLine } from "./editDiff.js";
import { findBannedWords } from "./edits.js";
import { approvedLessons, listVersions } from "../db/scriptEdits.js";
import type { ScriptLesson } from "./types.js";

/** Paragraphs offered to one call. Small enough that a reply cannot truncate. */
const BATCH = 18;

/**
 * The most of a script this pass may delete, as a share of what it was offered.
 *
 * ⚠️ A CEILING, BECAUSE DELETION IS THE ONE ACTION THAT CANNOT BE JUDGED FROM
 * THE RESULT. A rewritten paragraph reads back wrong; a deleted one leaves
 * nothing behind to notice. Structural rules ("do not stack four teases before
 * the intro") genuinely need it, so it is allowed — bounded, counted, and
 * reported in the summary.
 */
const MAX_DELETE_SHARE = 0.15;

export interface RuleApplication {
  /** Paragraphs the pass was allowed to touch. */
  offered: number;
  /** …of those, how many it rewrote. */
  rewritten: number;
  /** …and deleted outright. */
  deleted: number;
  /** Paragraphs of Jake's own that were never offered. */
  locked: number;
  rulesApplied: number;
  costUsd: number;
  /** Anything the pass declined to do, in a sentence each. */
  notes: string[];
  /** The finished document. */
  text: string;
}

/* ────────────────────────── the prompt ────────────────────────── */

function rulesBlock(rules: ScriptLesson[]): string {
  return [
    "==========================================",
    "THE RULES TO APPLY — these are the only reason you are here",
    "==========================================",
    "",
    "Each of these was learned from a script Jake edited by hand, and approved by him:",
    "",
    ...rules.map((r, i) => `${i + 1}. ${r.rule}`),
  ].join("\n");
}

const TASK = [
  "==========================================",
  "WHAT YOU ARE DOING",
  "==========================================",
  "",
  "You are given a finished script and a numbered list of paragraphs from it. Some of those paragraphs break",
  "the rules above, because they were written before the rules existed. Fix those, and only those.",
  "",
  "⚠️⚠️ THIS IS A STYLE PASS. You may change how a sentence READS. You may never change what it CLAIMS.",
  "- Never change a number, a price, a credit count, a percentage, a date, a duration or a model name.",
  "- Never change the text inside quotation marks. Those are prompts the viewer copies off the screen.",
  "- Never change a URL, and never add one.",
  "- Never add a fact, a claim, a result, an example or a step that is not already in that paragraph.",
  "- Never make a paragraph longer than it was. Shorter is usually the point.",
  "",
  "⚠️ ONLY WHERE A RULE ACTUALLY BITES. A paragraph that already follows every rule is left alone — do not",
  "return it. Rewriting good prose to prove you were working is the failure mode here: this runs over a",
  "script that Jake has already read, and every unnecessary change is one he has to check.",
  "",
  "⚠️ AND THE OPPOSITE FAILURE IS JUST AS REAL. This script was written before these rules existed, so a batch",
  "that comes back with an empty edit list and a paragraph of reasons is almost always wrong. Where a rule",
  "names a word, a label or a shape, applying it is not a judgement call — it is the job.",
  "",
  "⚠️⚠️ WHOSE PARAGRAPH IS WHOSE IS COMPUTED, NOT GUESSED, AND IT IS MARKED. Every paragraph tagged [JAKE] in",
  "the script is his own writing: it is the evidence these rules were learned from, it is never changed, and",
  "it is never returned. EVERY PARAGRAPH WITHOUT THAT TAG WAS WRITTEN BY THE GENERATOR, and every one of them",
  "is being fixed by this pass — the ones in your list now, the rest in another batch of the same run. A",
  "paragraph you were not asked about is not Jake's. It is somebody else's turn.",
  "",
  "⚠️ SO CONSISTENCY IS NEVER A REASON TO LEAVE A RULE BROKEN. Do not keep a banned word, a missing label or a",
  "forbidden section because other paragraphs of the script still have it — those are being fixed too, and a",
  "vocabulary that is only half-corrected is what you would be creating, not preventing. The only text worth",
  "matching is a [JAKE] paragraph, and even there the RULE wins over his older wording unless the rule says so",
  "itself.",
  "",
  "Read the whole script for context and flow, and change nothing outside the numbered list.",
  "",
  "DELETION: some rules are about what should not be there at all. If a paragraph exists only to do something",
  'a rule forbids, and the script reads correctly without it, return it with `"delete": true` and no text. Use',
  "this sparingly — a paragraph that merely needs trimming should be rewritten, not deleted, and a paragraph",
  "carrying a fact or a step is never deleted.",
  "",
  "==========================================",
  "OUTPUT",
  "==========================================",
  "",
  "STRICT JSON only. No markdown, no commentary, no code fence:",
  "",
  '{"edits": [{"n": <the paragraph number>, "text": "<the rewritten paragraph>"},',
  '           {"n": <number>, "delete": true}],',
  ' "notes": ["<anything you decided not to do, one sentence>"]}',
  "",
  "- `text` is the WHOLE replacement paragraph, plain prose, no numbering, no quotes around it.",
  "- Return only the paragraphs you actually changed. An empty `edits` array is a correct answer.",
  "- `notes` is for a rule you could not apply without inventing a fact, and for nothing else. It is NOT the",
  "  place to explain a change you decided against: a note saying you left a rule-breaking paragraph as it was",
  "  is a bug report against yourself, and the fix is to make the edit. Zero notes is the normal answer.",
].join("\n");

/* ────────────────────────── the words that are not a judgement call ────────────────────────── */

/**
 * Where the document is inside a quotation, character by character.
 *
 * ⚠️ THE QUOTED PROMPTS SPAN MANY PARAGRAPHS, so this cannot be done per line.
 * A master prompt opens with `THE PROMPT: "` and does not close for another
 * eighteen lines; every one of those lines looks unquoted on its own, and the
 * words inside them are text the viewer copies off the screen, not narration.
 *
 * An unterminated quote produces no range at all. A stray `"` is a typo, and
 * masking from it to the end of the document would quietly hide half the script
 * from the check.
 */
function quotedMask(doc: string): Uint8Array {
  const mask = new Uint8Array(doc.length);
  let open = -1;
  let closer = "";
  for (let i = 0; i < doc.length; i++) {
    const ch = doc[i];
    if (open === -1) {
      if (ch === '"') {
        open = i;
        closer = '"';
      } else if (ch === "\u201C") {
        open = i;
        closer = "\u201D";
      }
      continue;
    }
    if (ch === closer) {
      mask.fill(1, open, i + 1);
      open = -1;
    }
  }
  return mask;
}

/**
 * The banned words in one paragraph, ignoring anything inside quotation marks.
 *
 * ⚠️ THE POINT IS THAT THIS IS NOT THE MODEL'S OPINION. `BANNED_WORDS` is a
 * regex over words Jake has said he never wants — "clip" and "still" among them
 * since 2026-09-08 — and asking a model to notice them itself is what produced a
 * pass that argued its way out of the vocabulary rule in three batches out of
 * four. Named per paragraph and per word, they stop being a close call.
 */
function bannedWordsOutsideQuotes(raw: string, offset: number, mask: Uint8Array): string[] {
  let masked = "";
  for (let i = 0; i < raw.length; i++) masked += mask[offset + i] ? " " : raw[i];
  const words = findBannedWords(masked).map((h) => h.split(" \u2014")[0].trim());
  return [...new Set(words)];
}

/* ────────────────────────── the pass ────────────────────────── */

interface Edit {
  n: number;
  text: string;
  del: boolean;
}

function parseEdits(raw: string, valid: Set<number>): { edits: Edit[]; notes: string[] } {
  let parsed: { edits?: unknown; notes?: unknown };
  try {
    parsed = JSON.parse(extractJson(raw)) as { edits?: unknown; notes?: unknown };
  } catch {
    return { edits: [], notes: ["One batch came back as something other than JSON and was skipped."] };
  }
  const list = Array.isArray(parsed.edits) ? parsed.edits : [];
  const seen = new Set<number>();
  const edits: Edit[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const n = Number(o.n);
    // ⚠️ A NUMBER THAT WAS NOT OFFERED IS DISCARDED, NOT CLAMPED. Out of range
    // means the model lost track of the numbering, and the paragraph it meant is
    // unknowable — one of them is Jake's.
    if (!Number.isInteger(n) || !valid.has(n) || seen.has(n)) continue;
    const del = o.delete === true;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!del && !text) continue;
    seen.add(n);
    edits.push({ n, text, del });
  }
  const notes = (Array.isArray(parsed.notes) ? parsed.notes : [])
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, 6);
  return { edits, notes };
}

/**
 * Every paragraph an earlier rules pass wrote, read back out of the version
 * history rather than stored anywhere.
 *
 * ⚠️ THE HISTORY IS ALREADY THE RECORD, so there is nothing to keep in sync. A
 * `rules` version against the version immediately before it IS the list of what
 * that pass changed; the union over every pass is everything the machine has
 * written into this script since it was generated.
 */
function machineWrittenTexts(runId: string): Map<string, number> {
  const versions = listVersions(runId);
  const counts = new Map<string, number>();
  versions.forEach((v, i) => {
    if (v.source !== "rules" || i === 0) return;
    for (const c of diffScripts(versions[i - 1].text, v.text).changes) {
      if (c.kind === "cut" || !c.after) continue;
      counts.set(c.after, (counts.get(c.after) ?? 0) + 1);
    }
  });
  return counts;
}

/**
 * Rewrite the parts of one script that Jake did not write, under the approved
 * rules. Returns the new document; the caller decides what to do with it.
 */
export async function applyRulesToScript(input: {
  generated: string;
  current: string;
  title: string;
  sponsored: boolean;
  /** The run, so earlier passes' own output is not mistaken for Jake's. */
  runId?: string;
}): Promise<RuleApplication> {
  const rules = approvedLessons();
  const doc = input.current;
  const all = spokenLines(doc);
  // Which paragraphs are his — see `splitByAuthor`. His are never offered.
  const { open, locked } = splitByAuthor(
    input.generated,
    doc,
    input.runId ? machineWrittenTexts(input.runId) : undefined,
  );
  const openLines = new Set(open.map((p) => p.line));

  const base: RuleApplication = {
    offered: open.length,
    rewritten: 0,
    deleted: 0,
    locked: locked.length,
    rulesApplied: rules.length,
    costUsd: 0,
    notes: [],
    text: doc,
  };
  if (!rules.length || !open.length) return base;

  // Numbered for the model, 1-based across the WHOLE script so the numbering it
  // sees matches the numbering in the context it is reading.
  const numbering = new Map<number, SpokenLine>();
  // ⚠️ JAKE'S PARAGRAPHS ARE TAGGED IN THE SCRIPT ITSELF, AND THE TAG IS THE
  // WHOLE FIX. Told only "consider these numbers", the pass inferred that every
  // number outside its batch was Jake's — so on a 75-paragraph script it spent
  // three of its four batches declining to fix banned words "because Jake's own
  // paragraphs use them", when those paragraphs were its own and were being
  // rewritten one batch later. It cannot infer authorship if it is told it.
  const numbered = all.map((p, i) => {
    const n = i + 1;
    if (openLines.has(p.line)) {
      numbering.set(n, p);
      return `${n}. ${p.text}`;
    }
    return `${n}. [JAKE] ${p.text}`;
  });

  const system = [
    systemPreamble(false, input.sponsored),
    rulesBlock(rules),
    TASK,
  ].join("\n\n---\n\n");

  // Line offsets and the quote mask, computed once over the same normalised text
  // `spokenLines` indexed, so a paragraph can be checked where it actually sits.
  const normDoc = doc.replace(/\r\n/g, "\n");
  const normLines = normDoc.split("\n");
  const lineOffsets: number[] = [];
  {
    let at = 0;
    for (const l of normLines) {
      lineOffsets.push(at);
      at += l.length + 1;
    }
  }
  const mask = quotedMask(normDoc);
  const bannedFor = (n: number): string[] => {
    const p = numbering.get(n);
    if (!p) return [];
    return bannedWordsOutsideQuotes(normLines[p.line] ?? "", lineOffsets[p.line] ?? 0, mask);
  };

  const costBefore = scriptgenUsageTotal().costUsd;
  const edits = new Map<number, string>();
  const notes: string[] = [];
  const openNumbers = [...numbering.keys()].sort((a, b) => a - b);

  for (let at = 0; at < openNumbers.length; at += BATCH) {
    const batch = openNumbers.slice(at, at + BATCH);
    const valid = new Set(batch);
    const flagged = batch.map((n) => ({ n, words: bannedFor(n) })).filter((f) => f.words.length);
    let raw = "";
    try {
      raw = await opusScriptChat({
        system,
        // ⚠️ THE SCRIPT RIDES IN THE CACHED SYSTEM BLOCKS, NOT THE MESSAGE. It is
        // byte-stable across every batch of this run, so it is written to the
        // cache once and read from it four or five times instead of being
        // re-billed as fresh input on each call.
        systemExtra: [
          [
            `THE FULL SCRIPT — "${input.title}". Read all of it; change only the paragraphs you are asked about.`,
            locked.length
              ? `${locked.length} of these paragraphs are tagged [JAKE] — his own writing, never changed. The other ${open.length} were written by the generator, and this pass is fixing all of them.`
              : `Jake has not edited a word of this script, so nothing in it is tagged [JAKE]. All ${open.length} paragraphs were written by the generator, and this pass is fixing all of them.`,
            "",
            ...numbered,
          ].join("\n"),
        ],
        messages: [
          {
            role: "user",
            content: [
              `Consider ONLY these paragraph numbers: ${batch.join(", ")}.`,
              "",
              ...(flagged.length
                ? [
                    "BANNED WORDS, FOUND IN CODE AND NOT BY JUDGEMENT. These paragraphs contain a word an approved rule",
                    "forbids. It is not a close call, a matter of taste or a consistency question: swap the word for the plain",
                    "one the rule names, keep the sentence saying exactly what it says now, and return the paragraph. Anything",
                    "inside quotation marks has already been excluded — those are prompts the viewer copies off the screen.",
                    ...flagged.map((f) => `- ${f.n}: ${f.words.map((w) => `\u201C${w}\u201D`).join(", ")}`),
                    "",
                  ]
                : []),
              // ⚠️ THIS SENTENCE USED TO SAY THE OTHER PARAGRAPHS WERE "ALREADY
              // HANDLED OR WRITTEN BY JAKE HIMSELF", WHICH WAS FALSE FOR EVERY
              // BATCH BUT THE LAST — and false in the direction that talks the
              // pass out of working.
              "Every untagged paragraph outside this list was also written by the generator and is being fixed in",
              "another batch of this same pass. It is not Jake's, and it is not a reason to leave anything as it is.",
              "Return JSON for the ones among those numbers that break a rule, and nothing for the rest.",
            ].join("\n"),
          },
        ],
        maxTokens: 12000,
        effort: "medium",
        label: "apply-rules",
        purpose: "scriptgen",
      });
    } catch (e) {
      notes.push(`One batch failed and was left untouched: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const parsed = parseEdits(raw, valid);
    notes.push(...parsed.notes);
    for (const e of parsed.edits) {
      const target = numbering.get(e.n);
      if (!target) continue;
      edits.set(target.line, e.del ? "" : e.text);
    }
  }

  // The deletion ceiling, applied after everything is collected so it bounds the
  // pass rather than whichever batch happened to run last.
  const deletions = [...edits.entries()].filter(([, v]) => !v.trim());
  const allowed = Math.max(1, Math.floor(open.length * MAX_DELETE_SHARE));
  if (deletions.length > allowed) {
    for (const [line] of deletions.slice(allowed)) edits.delete(line);
    notes.push(
      `It wanted to delete ${deletions.length} paragraphs; ${allowed} is the ceiling for a script this length, so the rest were left in place.`,
    );
  }

  const rewritten = [...edits.values()].filter((v) => v.trim()).length;
  const deleted = edits.size - rewritten;
  return {
    ...base,
    rewritten,
    deleted,
    costUsd: Number(Math.max(0, scriptgenUsageTotal().costUsd - costBefore).toFixed(4)),
    notes: notes.slice(0, 8),
    text: edits.size ? replaceLines(doc, edits) : doc,
  };
}
