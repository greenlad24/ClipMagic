/**
 * What Jake changed, paragraph by paragraph, between the script the pipeline
 * wrote and the one he finished editing.
 *
 * ⚠️⚠️ THE DIFF IS DETERMINISTIC AND THE CONCLUSIONS ARE NOT. This module does
 * the whole comparison in code — alignment, classification, word-level change —
 * and hands a model nothing but the resulting list. That split is deliberate:
 * asked to "compare these two scripts" a model summarises its impression of
 * them, and the impression is where invented differences come from. Here it is
 * only ever asked what a list of REAL changes has in common.
 *
 * ⚠️ IT COMPARES THE SPOKEN SCRIPT, NOT THE DOCUMENT. The deliverable opens with
 * four alternate hooks, their production notes and a prompt appendix — none of
 * which is spoken, and all of which Jake deletes as a matter of course when he
 * picks a hook. Diffing the documents whole would report "cut 90 lines" and call
 * choosing a hook the biggest edit of the session.
 *
 * Measured against the run this was built from (the Ghibli walkthrough,
 * 2026-09-07): 118 generated paragraphs → 83 kept word-for-word, 26 reworded,
 * 9 cut, 4 written from scratch, and every one of the changes inside the first
 * third of the script.
 */

/** One aligned paragraph: what it was, what it became. */
export interface EditChange {
  kind: "rewritten" | "cut" | "added";
  /** The generated paragraph. Empty for `added`. */
  before: string;
  /** Jake's paragraph. Empty for `cut`. */
  after: string;
  /**
   * Word-level rendering of a rewrite: `[-generated-]{+Jake's+}`.
   *
   * The single most useful thing to put in front of the conclusions pass — a
   * before/after pair of long paragraphs buries a three-word swap, and it is the
   * three-word swaps that turn out to be the rule.
   */
  inline: string;
  /** How far into the script it sits, 0–1. A cluster at 0.05 is a finding. */
  position: number;
}

export interface EditDiffStats {
  generatedParagraphs: number;
  editedParagraphs: number;
  kept: number;
  rewritten: number;
  cut: number;
  added: number;
  generatedWords: number;
  editedWords: number;
  /** 0–1: how much of the generated script survived word for word. */
  keptRatio: number;
  /**
   * Where the edits actually are, as a share of changes landing in each third.
   * The Ghibli run was [1, 0, 0] — every edit in the opening third — which says
   * something no per-paragraph finding does.
   */
  thirds: [number, number, number];
}

export interface EditDiff {
  stats: EditDiffStats;
  changes: EditChange[];
}

/* ────────────────────────── extracting the spoken script ────────────────────────── */

const SCRIPT_HEADING = "## SCRIPT";

/**
 * The spoken half of a deliverable.
 *
 * The generated document is `# title` → `## HOOKS — pick one` (four formulas and
 * their notes) → `## SCRIPT` → optionally a `## PROMPT SUMMARY` appendix. Jake's
 * edited version is usually just the title and the script, because he deletes
 * the hooks he did not pick. Taking the script section of each is what makes the
 * two comparable.
 */
export function spokenScript(doc: string): string {
  const text = (doc ?? "").replace(/\r\n/g, "\n");
  const at = text.indexOf(SCRIPT_HEADING);
  let body = at === -1 ? stripTitle(text) : text.slice(at + SCRIPT_HEADING.length);
  // The appendix is generated FROM the script; diffing it would count every
  // prompt twice and report the copy as a change of its own.
  const appendix = body.indexOf("## PROMPT SUMMARY");
  if (appendix !== -1) body = body.slice(0, appendix);
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

/** Drop a leading `# Title` line when there is no `## SCRIPT` to cut at. */
function stripTitle(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^#\s+/.test(lines[i])) i++;
  return lines.slice(i).join("\n");
}

/**
 * Paragraphs, one per non-empty line.
 *
 * ⚠️ PER LINE, NOT PER BLANK-LINE BLOCK, AND THE ASYMMETRY IS THE REASON. The
 * generated document separates paragraphs with blank lines; a document that has
 * been through a browser textarea often does not. Splitting on blank lines reads
 * Jake's whole opening as ONE paragraph and reports it as a single unrecognisable
 * rewrite of the script.
 */
export function paragraphsOf(script: string): string[] {
  return script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // ⚠️ STRUCTURAL MARKERS ARE NOT SPOKEN, AND THEY BECOME FALSE FINDINGS.
    // The assembled document carries `---` rules and `## OUTRO` headings; Jake's
    // pasted-back version usually does not. Counted as paragraphs they arrive at
    // the conclusions pass as "CUT ENTIRELY" — a change he never made, in the
    // one input the pass is told it can trust.
    .filter((l) => !/^(?:-{3,}|\*{3,}|_{3,})$/.test(l))
    .filter((l) => !/^#{1,6}\s/.test(l));
}

/** A spoken paragraph, and the line of the ORIGINAL document it came from. */
export interface SpokenLine {
  /** Index into `doc.split("\n")`. */
  line: number;
  text: string;
}

/**
 * The spoken paragraphs, each still pointing at the line it lives on.
 *
 * ⚠️⚠️ THE REWRITE PASS EDITS THE DOCUMENT BY LINE NUMBER, AND THIS IS WHY. A
 * rewrite that rebuilt the document from `paragraphsOf` would silently drop
 * everything the diff deliberately ignores — the alternate hooks Jake has not
 * chosen yet, the production notes, the prompt appendix, the blank lines that
 * make it readable. Replacing individual lines in the real document changes the
 * sentences that were rewritten and NOTHING else.
 *
 * Same filters as `spokenScript` + `paragraphsOf`, applied to the raw lines:
 * only inside the script section, no headings, no horizontal rules.
 */
export function spokenLines(doc: string): SpokenLine[] {
  const lines = (doc ?? "").replace(/\r\n/g, "\n").split("\n");
  const headingAt = lines.findIndex((l) => l.trim().startsWith(SCRIPT_HEADING));
  const appendixAt = lines.findIndex((l) => l.trim().startsWith("## PROMPT SUMMARY"));
  const from = headingAt === -1 ? 0 : headingAt + 1;
  const to = appendixAt === -1 ? lines.length : appendixAt;
  const out: SpokenLine[] = [];
  for (let i = from; i < to; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) continue;
    if (/^#{1,6}\s/.test(text)) continue;
    out.push({ line: i, text });
  }
  return out;
}

/**
 * Put rewritten paragraphs back into the document, addressed by line.
 *
 * A replacement of `""` deletes the line. Everything not named is returned
 * byte-identical.
 */
export function replaceLines(doc: string, edits: Map<number, string>): string {
  const lines = (doc ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!edits.has(i)) {
      out.push(line);
      return;
    }
    const next = (edits.get(i) ?? "").trim();
    // A deleted paragraph takes its own line with it; the blank line that
    // followed it is left, and the \n{3,} collapse below tidies the gap.
    if (next) out.push(next);
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/* ────────────────────────── similarity ────────────────────────── */

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * How much of one paragraph is still in the other: `2 × LCS / (len a + len b)`
 * over normalised WORDS. 1.0 identical, ~0.2 for two unrelated paragraphs.
 *
 * ⚠️⚠️ THIS WAS A CHARACTER-BIGRAM DICE COEFFICIENT AND IT DESTROYED THE
 * ALIGNMENT ON REAL SCRIPTS. Measured on the Ghibli run: 83 paragraphs that are
 * byte-identical came back as 1 kept and 81 cut, because English prose shares
 * so many character bigrams ("th", "he", "in", " a") that two paragraphs about
 * completely different things score above 0.45. The first mis-pair consumed a
 * paragraph the walk needed, the cursor desynchronised, and every comparison
 * after it was against the wrong candidate — a diff that would have taught the
 * generator rules from changes Jake never made.
 *
 * Word LCS cannot do that: it is order-aware, and two paragraphs only score
 * high when they say the same things in the same sequence.
 */
export function similarity(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const l = lcsLength(x, y);
  return (2 * l) / (x.length + y.length);
}

/** Normalised words, capped so a pathological paste stays O(1) in practice. */
function wordsOf(text: string): string[] {
  return normalise(text).split(" ").filter(Boolean).slice(0, MAX_COMPARE_WORDS);
}

/** Beyond this a paragraph is compared on its opening only. */
const MAX_COMPARE_WORDS = 400;

/** Length of the longest common subsequence, in a rolling row. */
function lcsLength(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/* ────────────────────────── word-level diff ────────────────────────── */

/** Longest common subsequence over words, for the `[-was-]{+is+}` rendering. */
export function inlineDiff(before: string, after: string): string {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const an = a.map(normalise);
  const bn = b.map(normalise);
  // Paragraphs are a few dozen words; the quadratic table is nothing, and the
  // guard is only for a pathological paste.
  if (a.length > 400 || b.length > 400) return `[-${before}-]{+${after}+}`;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = an[i] === bn[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = (): void => {
    if (dels.length) out.push(`[-${dels.join(" ")}-]`);
    if (adds.length) out.push(`{+${adds.join(" ")}+}`);
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (an[i] === bn[j]) {
      flush();
      out.push(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels.push(a[i++]);
    } else {
      adds.push(b[j++]);
    }
  }
  while (i < a.length) dels.push(a[i++]);
  while (j < b.length) adds.push(b[j++]);
  flush();
  return out.join(" ");
}

/* ────────────────────────── the alignment ────────────────────────── */

/** Above this a paragraph counts as untouched — punctuation and casing only. */
const KEPT_AT = 0.985;
/** Below this the two paragraphs are not the same paragraph at all. */
const REWRITE_AT = 0.45;
/** How far ahead of the current position a match may be found. */
const LOOKAHEAD = 8;
/** …and how far back, for a paragraph Jake moved earlier. */
const LOOKBEHIND = 3;

/**
 * Align the two scripts and say what happened to every paragraph.
 *
 * ⚠️ A WINDOWED GREEDY WALK, NOT A GLOBAL BEST MATCH. Scripts repeat themselves
 * by design — "Alright." and "Hit enter." occur half a dozen times — and a
 * global matcher happily pairs the first with the last, producing a diff that
 * says Jake moved eleven paragraphs when he moved none. Restricting each match
 * to a window around where the walk already is keeps the order honest.
 */
export function diffScripts(generated: string, edited: string): EditDiff {
  const A = paragraphsOf(spokenScript(generated));
  const B = paragraphsOf(spokenScript(edited));
  const used = new Set<number>();
  const changes: EditChange[] = [];
  let kept = 0;
  let cursor = 0;

  A.forEach((a, i) => {
    let bestScore = 0;
    let bestAt = -1;
    for (let k = Math.max(0, cursor - LOOKBEHIND); k < Math.min(B.length, cursor + LOOKAHEAD); k++) {
      if (used.has(k)) continue;
      const s = similarity(a, B[k]);
      if (s > bestScore) {
        bestScore = s;
        bestAt = k;
      }
    }
    const position = A.length > 1 ? i / (A.length - 1) : 0;
    if (bestScore >= KEPT_AT && bestAt >= 0) {
      used.add(bestAt);
      cursor = bestAt + 1;
      kept++;
    } else if (bestScore >= REWRITE_AT && bestAt >= 0) {
      used.add(bestAt);
      cursor = bestAt + 1;
      changes.push({ kind: "rewritten", before: a, after: B[bestAt], inline: inlineDiff(a, B[bestAt]), position });
    } else {
      changes.push({ kind: "cut", before: a, after: "", inline: `[-${a}-]`, position });
    }
  });

  // Anything of Jake's that never got claimed is his own writing, and it is the
  // most informative kind of change there is: the generator did not merely say
  // it badly, it never said it.
  B.forEach((b, k) => {
    if (used.has(k)) return;
    changes.push({
      kind: "added",
      before: "",
      after: b,
      inline: `{+${b}+}`,
      position: B.length > 1 ? k / (B.length - 1) : 0,
    });
  });
  changes.sort((x, y) => x.position - y.position);

  const words = (list: string[]): number => list.join(" ").split(/\s+/).filter(Boolean).length;
  const thirds: [number, number, number] = [0, 0, 0];
  for (const c of changes) {
    const bucket = c.position < 1 / 3 ? 0 : c.position < 2 / 3 ? 1 : 2;
    thirds[bucket]++;
  }
  const total = changes.length || 1;

  return {
    stats: {
      generatedParagraphs: A.length,
      editedParagraphs: B.length,
      kept,
      rewritten: changes.filter((c) => c.kind === "rewritten").length,
      cut: changes.filter((c) => c.kind === "cut").length,
      added: changes.filter((c) => c.kind === "added").length,
      generatedWords: words(A),
      editedWords: words(B),
      keptRatio: A.length ? kept / A.length : 0,
      thirds: [thirds[0] / total, thirds[1] / total, thirds[2] / total],
    },
    changes,
  };
}

/* ────────────────────────── whose paragraph is whose ────────────────────────── */

/**
 * Split the current script into the paragraphs Jake wrote and the ones the
 * generator wrote and he left alone.
 *
 * ⚠️⚠️ THIS IS THE LOCK THE REWRITE PASS OBEYS, so it errs towards LOCKED. Every
 * paragraph the diff calls `rewritten` or `added` carries `after` text taken
 * verbatim out of the current document, so the match here is exact rather than
 * fuzzy — and anything the diff cannot account for stays with the machine only
 * because it is byte-identical to what the machine wrote.
 *
 * A multiset, not a set: scripts repeat short lines ("Alright.", "Hit enter."),
 * and locking every occurrence because he changed one of them would freeze
 * paragraphs he never touched.
 */
export function splitByAuthor(
  generated: string,
  current: string,
  /**
   * Paragraphs an earlier rules pass wrote, as a multiset.
   *
   * ⚠️⚠️ WITHOUT THIS THE PASS LOCKS ITS OWN OUTPUT AND CAN NEVER REVISIT IT.
   * Measured on the second press of the button (2026-09-07): the first pass had
   * rewritten 9 paragraphs, so those 9 no longer matched the generated script,
   * so the diff called them Jake's and the locked count went 30 → 39. Every
   * paragraph the machine improves would fall out of reach of the next rule
   * approved — the set of text the rules can reach shrinking every time they
   * are used.
   */
  machineWritten?: Map<string, number>,
): { open: SpokenLine[]; locked: SpokenLine[] } {
  const all = spokenLines(current);
  const mine = new Map<string, number>();
  if (generated.trim() !== current.trim()) {
    for (const c of diffScripts(generated, current).changes) {
      if (c.kind === "cut" || !c.after) continue;
      mine.set(c.after, (mine.get(c.after) ?? 0) + 1);
    }
  }
  // Hand back what the machine wrote. Counted rather than deleted, so a
  // paragraph Jake happens to have written identically to one the pass produced
  // still keeps a claim on itself.
  for (const [text, n] of machineWritten ?? []) {
    const held = mine.get(text) ?? 0;
    if (held > 0) mine.set(text, Math.max(0, held - n));
  }
  const open: SpokenLine[] = [];
  const locked: SpokenLine[] = [];
  for (const p of all) {
    const left = mine.get(p.text) ?? 0;
    if (left > 0) {
      mine.set(p.text, left - 1);
      locked.push(p);
    } else {
      open.push(p);
    }
  }
  return { open, locked };
}

/* ────────────────────────── what the model is shown ────────────────────────── */

/** Ceiling on the change list handed to the conclusions pass. */
const MAX_CHANGES = 70;
/** …and on any single change, so one pasted essay cannot eat the whole budget. */
const MAX_CHANGE_CHARS = 1200;

const where = (p: number): string => (p < 1 / 3 ? "opening third" : p < 2 / 3 ? "middle" : "closing third");

/**
 * The diff, written out for the conclusions pass.
 *
 * ⚠️ THE COUNTS COME FIRST AND THEY ARE NOT DECORATION. "83 of 118 paragraphs
 * survived word for word, and every change is in the opening third" is itself
 * the most useful conclusion available from the Ghibli run, and a model reading
 * only a list of changes cannot see it — the list looks like wholesale rewriting
 * from the inside.
 */
export function renderDiffForModel(diff: EditDiff): string {
  const s = diff.stats;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const lines: string[] = [
    "## THE SHAPE OF THE EDIT",
    "",
    `- The generated script was ${s.generatedParagraphs} paragraphs / ${s.generatedWords} words. Jake's finished version is ${s.editedParagraphs} paragraphs / ${s.editedWords} words.`,
    `- ${s.kept} paragraphs (${pct(s.keptRatio)}) survived WORD FOR WORD. ${s.rewritten} were reworded, ${s.cut} were cut outright, and he wrote ${s.added} new ones.`,
    `- Where the changes are: ${pct(s.thirds[0])} in the opening third, ${pct(s.thirds[1])} in the middle, ${pct(s.thirds[2])} in the closing third.`,
    "",
    "## EVERY CHANGE, IN ORDER",
    "",
    "`[-...-]` is text Jake deleted. `{+...+}` is text Jake wrote.",
    "",
  ];
  const shown = diff.changes.slice(0, MAX_CHANGES);
  shown.forEach((c, i) => {
    const label = c.kind === "rewritten" ? "REWORDED" : c.kind === "cut" ? "CUT ENTIRELY" : "WRITTEN BY JAKE";
    const body = c.inline.length > MAX_CHANGE_CHARS ? `${c.inline.slice(0, MAX_CHANGE_CHARS)}…` : c.inline;
    lines.push(`${i + 1}. [${label} — ${where(c.position)}] ${body}`, "");
  });
  if (diff.changes.length > shown.length) {
    lines.push(`(${diff.changes.length - shown.length} further changes not listed.)`);
  }
  return lines.join("\n");
}
