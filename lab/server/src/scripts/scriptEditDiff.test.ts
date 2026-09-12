/**
 * The deterministic half of the script-generator's edit loop (scriptgen/editDiff).
 *
 * ⚠️⚠️ THIS IS THE HALF THAT MUST NOT BE WRONG. The conclusions pass reads
 * nothing but this module's output, so a mis-alignment here does not produce a
 * wrong number on a screen — it produces a confident rule about how Jake writes,
 * drawn from a change he never made, sitting in front of an Approve button.
 *
 * Pure module — no DB, no browser, no network. Run:
 *   cd lab && docker build -f Dockerfile --target server -t X . &&
 *   docker run --rm -w /build/server X node dist/scripts/scriptEditDiff.test.js
 */
import assert from "node:assert/strict";
import {
  diffScripts,
  inlineDiff,
  paragraphsOf,
  renderDiffForModel,
  replaceLines,
  similarity,
  spokenLines,
  spokenScript,
  splitByAuthor,
} from "../scriptgen/editDiff.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

/* ── the document the pipeline actually delivers ─────────────────── */

const GENERATED = [
  "# How to Create Ghibli-Style AI Videos in 2026 (Full Walkthrough)",
  "",
  "## HOOKS — pick one",
  "",
  "### FORMULA A — the compressed open",
  "**Beat 1 (0:00–0:08):** Cold open on the finished clip.",
  "**Recommendation for this one:** A-Compressed, because it is a search phrase.",
  "",
  "## SCRIPT",
  "",
  "Look at this. A kid hauling a bowl of hot soup through a flooded village, cat riding on his shoulder.",
  "",
  "Nobody drew any of that. No animator, no studio, no drawing tablet.",
  "",
  "Then there's the money. Google Flow hands you fifty credits a day for free, and a clip runs about ten.",
  "",
  "Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI.",
  "",
  "Look at my browser right now. Four tabs. Watch this. Close. Close. Close.",
  "",
  "Here's the job, start to finish. You write the story and all the prompts in a chat tool.",
  "",
  "Open a new chat in ChatGPT. Not one you've been using for something else — a fresh one.",
  "",
  "Now open settings. Under video model, pick your model and read what the dropdown says.",
  "",
  "Then nudge the sharpness up a touch. Small move, big payoff on the hand-drawn look.",
  "",
  "Now I'm curious. What's the first story you'd run through this?",
  "",
  "---",
  "",
  "## PROMPT SUMMARY (for the description / pinned comment)",
  "",
  '**Prompt 1:** "write me a short dialogue-based story about a boy and a cat"',
].join("\n");

/**
 * ⚠️ NO BLANK LINES BETWEEN PARAGRAPHS, ON PURPOSE. This is what a script looks
 * like after it has been through the browser textarea, and splitting on blank
 * lines reads the whole thing as ONE paragraph — which reported the entire
 * script as a single unrecognisable rewrite before `paragraphsOf` split per line.
 */
const EDITED = [
  "# How to Create Ghibli-Style AI Videos in 2026 (Full Walkthrough)",
  "",
  "Look at this. (What's shown: A kid running a bowl of soup across a flooded village.) Nobody drew a frame of it.",
  "By the end of this video, you'll know how to build a short film like this yourself, even if you've never animated anything.",
  "Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI.",
  "Here's my browser right now. Four tabs. Watch this. Close. Close. Close.",
  "Here's the job you want to give it. First, you write the story and all the prompts in ChatGPT or Claude.",
  "Now open settings. Under video model, pick your model and read what the dropdown says.",
  "Then nudge the sharpness up a touch. Small move, big payoff on the hand-drawn look.",
  "Now I'm curious. What's the first story you'd run through this?",
].join("\n");

/* ── extracting what is actually spoken ──────────────────────────── */

check("the hook menu and the prompt appendix are not part of the diff", () => {
  const spoken = spokenScript(GENERATED);
  assert.ok(!spoken.includes("FORMULA A"), "the alternate hooks are not spoken");
  assert.ok(!spoken.includes("Recommendation for this one"), "nor are the production notes");
  assert.ok(!spoken.includes("PROMPT SUMMARY"), "nor is the appendix, which is copied FROM the script");
  assert.ok(spoken.includes("Look at this."), "the script itself survives");
});

check("an edited document with no SCRIPT heading loses only its title", () => {
  const spoken = spokenScript(EDITED);
  assert.ok(!spoken.includes("# How to Create"), "the H1 is not a spoken line");
  assert.ok(spoken.startsWith("Look at this."));
});

check("horizontal rules and headings are not spoken paragraphs", () => {
  // They ride in the assembled document and not in a pasted-back edit, so
  // counting them reports a cut Jake never made.
  assert.deepEqual(paragraphsOf("## OUTRO\n\n---\n\nNow I'm curious."), ["Now I'm curious."]);
});

check("paragraphs split per line, so a textarea round-trip is still comparable", () => {
  // ⚠️ THE REGRESSION THIS EXISTS FOR: eight paragraphs, no blank lines.
  assert.equal(paragraphsOf(spokenScript(EDITED)).length, 8);
});

/* ── similarity ─────────────────────────────────────────────────── */

check("similarity separates a reword from a different paragraph", () => {
  const a = "Here's the job, start to finish. You write the story and all the prompts in a chat tool.";
  const b = "Here's the job you want to give it. First, you write the story and all the prompts in ChatGPT or Claude.";
  const unrelated = "Then nudge the sharpness up a touch, because generation softens the line work.";
  assert.ok(similarity(a, b) > 0.6, `a reword should score high, got ${similarity(a, b)}`);
  assert.ok(similarity(a, unrelated) < 0.45, `an unrelated paragraph should score low, got ${similarity(a, unrelated)}`);
  assert.equal(similarity(a, a), 1);
});

check("two unrelated paragraphs of English prose do not look alike", () => {
  // ⚠️ THE REAL PAIR THAT BROKE THE FIRST IMPLEMENTATION. Under a character-
  // bigram score these two came out above the rewrite threshold, the walk paired
  // them, and the whole rest of the Ghibli diff desynchronised: 83 identical
  // paragraphs were reported as cut. Word LCS puts them where they belong.
  const a = "Nobody drew any of that. No animator, no studio, no drawing tablet. That whole short came out of a chat window and a free Google tool, and I'm going to build it again in front of you.";
  const b = "What you need in front of you. A Gmail account for Flow — that's your only login, and there's nothing to install. And a normal video editor for the very end. I'm using CapCut.";
  assert.ok(similarity(a, b) < 0.45, `unrelated prose must not pair, got ${similarity(a, b)}`);
});

check("punctuation and casing alone are not an edit", () => {
  assert.ok(similarity("Alright. Step one.", "alright, step one") > 0.985);
});

/* ── the alignment ──────────────────────────────────────────────── */

check("the diff names what happened to every paragraph", () => {
  const { stats, changes } = diffScripts(GENERATED, EDITED);
  assert.equal(stats.generatedParagraphs, 10);
  assert.equal(stats.editedParagraphs, 8);
  // The three that end the script are untouched.
  assert.ok(stats.kept >= 3, `expected the closing paragraphs to survive, kept ${stats.kept}`);
  assert.ok(stats.cut >= 1, "the credits-math paragraph was cut");
  assert.ok(stats.added >= 1, "Jake's own promise paragraph is an addition");
  assert.ok(stats.rewritten >= 2, "the browser line and the job line were reworded");
  assert.equal(stats.kept + stats.rewritten + stats.cut, stats.generatedParagraphs);
  assert.ok(changes.every((c) => (c.kind === "added" ? c.before === "" : c.before.length > 0)));
});

check("the changes cluster where they actually happened", () => {
  const { stats } = diffScripts(GENERATED, EDITED);
  // ⚠️ THE FINDING THE WHOLE FEATURE TURNS ON: on the real Ghibli run every
  // single change was in the opening third and 79 later paragraphs were
  // untouched. If this collapses to an even spread the conclusions pass stops
  // being able to say "your edits are all about openings".
  assert.ok(stats.thirds[0] > stats.thirds[2], `changes should lean to the opening, got ${JSON.stringify(stats.thirds)}`);
  assert.ok(Math.abs(stats.thirds[0] + stats.thirds[1] + stats.thirds[2] - 1) < 0.001);
});

check("an untouched script is all kept and proposes nothing", () => {
  const { stats, changes } = diffScripts(GENERATED, GENERATED);
  assert.equal(changes.length, 0);
  assert.equal(stats.kept, stats.generatedParagraphs);
  assert.equal(stats.keptRatio, 1);
});

check("a repeated line is matched in place, not to its twin ten paragraphs away", () => {
  // ⚠️ WHY THE MATCH WINDOW EXISTS. "Alright." appears three times; a global
  // best-match pairs the first with the last and reports moves nobody made.
  const gen = ["## SCRIPT", "", "Alright.", "", "First you open the app.", "", "Alright.", "", "Then you press go.", "", "Alright."].join("\n");
  const edit = ["Alright.", "First you open the app in your browser.", "Alright.", "Then you press go.", "Alright."].join("\n");
  const { stats } = diffScripts(gen, edit);
  assert.equal(stats.kept, 4, "the three 'Alright.'s and the unchanged line stay put");
  assert.equal(stats.rewritten, 1);
  assert.equal(stats.cut, 0);
  assert.equal(stats.added, 0);
});

/* ── the word-level rendering ───────────────────────────────────── */

check("the inline diff marks deletions and insertions", () => {
  const out = inlineDiff("You write the prompts in a chat tool.", "You write the prompts in ChatGPT or Claude.");
  assert.match(out, /^You write the prompts in /);
  assert.match(out, /\[-a chat tool\.-\]/);
  assert.match(out, /\{\+ChatGPT or Claude\.\+\}/);
});

check("an unchanged paragraph renders with no markers at all", () => {
  const line = "Then you press go.";
  assert.equal(inlineDiff(line, line), line);
});

/* ── what the model is shown ────────────────────────────────────── */

check("the model is handed the counts before the changes", () => {
  const rendered = renderDiffForModel(diffScripts(GENERATED, EDITED));
  assert.ok(rendered.indexOf("THE SHAPE OF THE EDIT") < rendered.indexOf("EVERY CHANGE, IN ORDER"));
  assert.match(rendered, /survived WORD FOR WORD/);
  assert.match(rendered, /opening third/);
  assert.match(rendered, /CUT ENTIRELY|WRITTEN BY JAKE|REWORDED/);
});

check("the render is bounded, so one pasted essay cannot become the whole prompt", () => {
  const essay = "x".repeat(9000);
  const gen = `## SCRIPT\n\n${essay}\n\nSecond paragraph here, unchanged.`;
  const edit = `${essay.slice(0, 4000)}\n\nSecond paragraph here, unchanged.`;
  const rendered = renderDiffForModel(diffScripts(gen, edit));
  assert.ok(rendered.length < 6000, `expected a truncated render, got ${rendered.length} chars`);
});

/* ── whose paragraph is whose, for the rewrite pass ─────────────── */

check("the spoken lines still point at the document they came from", () => {
  const lines = spokenLines(GENERATED);
  const raw = GENERATED.split("\n");
  assert.ok(lines.length > 0);
  for (const l of lines) assert.equal(raw[l.line].trim(), l.text, "every line index must address its own text");
  assert.ok(!lines.some((l) => l.text.includes("FORMULA A")), "the hook menu is outside the script section");
  assert.ok(!lines.some((l) => l.text.startsWith("**Prompt 1:**")), "and so is the appendix");
});

check("replacing lines changes those paragraphs and nothing else", () => {
  const lines = spokenLines(GENERATED);
  const target = lines[1];
  const out = replaceLines(GENERATED, new Map([[target.line, "Replaced."]]));
  assert.ok(out.includes("Replaced."));
  assert.ok(!out.includes(target.text));
  // ⚠️ THE POINT OF ADDRESSING BY LINE: everything the diff ignores survives.
  assert.ok(out.includes("## HOOKS — pick one"));
  assert.ok(out.includes("### FORMULA A — the compressed open"));
  assert.ok(out.includes("## PROMPT SUMMARY (for the description / pinned comment)"));
  assert.ok(out.includes("# How to Create Ghibli-Style AI Videos in 2026 (Full Walkthrough)"));
});

check("an empty replacement deletes the paragraph and leaves the rest intact", () => {
  const lines = spokenLines(GENERATED);
  const target = lines[2];
  const out = replaceLines(GENERATED, new Map([[target.line, ""]]));
  assert.ok(!out.includes(target.text));
  assert.ok(out.includes(lines[1].text) && out.includes(lines[3].text));
  assert.ok(!/\n{3,}/.test(out), "the gap it leaves is tidied");
});

check("the rewrite is never offered a paragraph Jake wrote or changed", () => {
  // ⚠️⚠️ THE TEST THIS FEATURE LIVES OR DIES BY. Anything in `open` is text the
  // rules pass may rewrite; his own writing appearing there is the machine
  // editing the man it is imitating.
  const { open, locked } = splitByAuthor(GENERATED, EDITED);
  const lockedText = locked.map((l) => l.text);
  const openText = open.map((l) => l.text);
  assert.ok(lockedText.some((t) => t.startsWith("By the end of this video")), "his own new paragraph is locked");
  assert.ok(lockedText.some((t) => t.startsWith("Here's my browser")), "so is one he reworded");
  assert.ok(lockedText.some((t) => t.startsWith("Here's the job you want")), "and the other");
  assert.ok(openText.some((t) => t.startsWith("Now open settings")), "untouched generator prose stays open");
  assert.equal(open.length + locked.length, spokenLines(EDITED).length, "every paragraph belongs to exactly one side");
});

check("a paragraph an earlier rules pass wrote stays reachable by the next rule", () => {
  // ⚠️ THE REGRESSION FROM THE SECOND PRESS OF THE BUTTON. The first pass had
  // rewritten 9 paragraphs; on the next press those no longer matched the
  // generated script, the diff called them Jake's, and the locked count went
  // 30 → 39. Left alone, the text the rules can reach shrinks every time they
  // are used.
  const rewritten = "Now open settings. Under video model, pick your model on the screen in front of you.";
  const afterPass = EDITED.replace("Now open settings. Under video model, pick your model and read what the dropdown says.", rewritten);
  const machine = new Map([[rewritten, 1]]);

  const blind = splitByAuthor(GENERATED, afterPass);
  assert.ok(blind.locked.some((l) => l.text === rewritten), "without the history it is mistaken for Jake's");

  const { open, locked } = splitByAuthor(GENERATED, afterPass, machine);
  assert.ok(open.some((l) => l.text === rewritten), "with it, the machine's own line is reachable again");
  assert.ok(locked.some((t) => t.text.startsWith("By the end of this video")), "and Jake's is still locked");
  assert.equal(blind.locked.length - locked.length, 1, "exactly one paragraph changed hands");
});

check("an unedited script is entirely open, so old runs can be brought in line", () => {
  const { open, locked } = splitByAuthor(GENERATED, GENERATED);
  assert.equal(locked.length, 0);
  assert.equal(open.length, spokenLines(GENERATED).length);
});

check("a repeated line he changed once does not lock its twins", () => {
  const gen = ["## SCRIPT", "", "Alright.", "", "First you open the app.", "", "Alright.", "", "Then you press go."].join("\n");
  const edit = ["Alright, here we go.", "First you open the app.", "Alright.", "Then you press go."].join("\n");
  const { open, locked } = splitByAuthor(gen, edit);
  assert.equal(locked.length, 1, "only the one he actually reworded");
  assert.ok(locked[0].text.startsWith("Alright, here we go"));
  assert.ok(open.some((l) => l.text === "Alright."), "the untouched twin stays open");
});

console.log(`\n${passed} checks passed`);
