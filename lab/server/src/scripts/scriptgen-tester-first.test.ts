/**
 * Checks for the 2026-10-02 "tester first" changes, after the first real run
 * with a UX Scout report (Linearity, run ufoMJvG6RgfR2H2IlWLS2):
 * - the script is built on the tester; tutorials only lend angles and insights,
 *   and only when they are about this exact product in today's version
 * - the vendor's domain comes from the Scout report, not a guess
 * - the outline's own "Opening" / "Welcome" sections are not drafted again
 * - a tutorial's opening is the best-ranked one in Jake's opening shape
 * - numbers the tool showed today, and numbers inside a typed prompt, are not
 *   "unsupported" (the claim fix cut "20% off" out of the prompt)
 * - the prompt summary quotes the prompt as the script says it
 * - production notes are deduped, and a merge answer that invents is refused
 *
 * Run like the other scriptgen tests (see clipmagic-lab-testing).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseOutlineSections,
  arrangeOpenings,
  OPENING_HEADING,
  CANONICAL_WELCOME,
  extractPrompts,
  promptAppendices,
  PROMPT_SUMMARY_HEADING,
  stripPromptText,
  auditClaims,
  dedupeNotes,
  parseNotesMerge,
  productionNotesAppendix,
  parseStoredAppendices,
} from "../scriptgen/edits.js";
import { scoutHosts, vendorHosts } from "../scriptgen/sources.js";
import { selectionPrompt } from "../scriptgen/videoResearch.js";

let passed = 0;
const fail: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    fail.push(name);
    console.log(`  FAIL ${name}`);
  }
}

// ── Tutorials: exact product, right version, angles only ──
{
  const p = selectionPrompt("Linearity AI", [], 3);
  check("selection demands the exact product (namesakes rejected)", /EXACT PRODUCT, 100%/.test(p) && /namesake/i.test(p));
  check("selection demands today's version", /THE RIGHT VERSION/.test(p));
  check("selection says none is the expected answer when unsure", /\{"picks": \[\]\}/.test(p));
  const vr = readFileSync(fileURLToPath(new URL("../scriptgen/videoResearch.ts", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
  check("no fallback to the word-match ranking once the selector has judged", /return picked\.map\(strip\)/.test(vr) && !/picked\.length > 0 \? picked : ranked/.test(vr));
  const s16 = readFileSync(fileURLToPath(new URL("../scriptgen/prompts/stage1.6-workflows.md", import.meta.url)), "utf8");
  check("the extractor checks product + version first", /PRODUCT MATCH/.test(s16) && /NO MATCHING TUTORIALS/.test(s16));
  check("the extractor takes angles and insights, not steps", /## ANGLES/.test(s16) && /## PRODUCT INSIGHTS/.test(s16) && !/## WORKFLOWS/.test(s16) && !/EXACT UI LABELS SEEN/.test(s16));
  const run = readFileSync(fileURLToPath(new URL("../scriptgen/run.ts", import.meta.url)), "utf8");
  check("the tutorial block is never a source for steps or prices", /never the source for a step, a click path, a button label, a setting, a timing, a price or a result/.test(run));
  check("the Scout report is what the script is built on", /The script is built on this report/.test(run));
  check("an unclear plan/price in the Scout report is not filled from research", /does not state it either, not even from the research or the fact sheet/.test(run));
  check("the research scope rides with a Scout report even without tutorials", /stages\.videoWorkflows \|\| stages\.uxReport \? \[researchScopeBlock/.test(run));
  const fs15 = readFileSync(fileURLToPath(new URL("../scriptgen/prompts/stage1.5-factsheet.md", import.meta.url)), "utf8");
  check("fact sheet: Scout first, research second, tutorials last", fs15.indexOf("THE UX SCOUT REPORT AND THE SCREENSHOT SHEET") < fs15.indexOf("**2. THE WRITTEN RESEARCH") && fs15.indexOf("**2. THE WRITTEN RESEARCH") < fs15.indexOf("**3. THE TUTORIAL SHEET"));
}

// ── Vendor domain from the Scout report ──
{
  const report =
    'Scouted 2026-10-02 on the web app (cloud.linearity.io), account "Jake Dawson".\n' +
    'Go to linearity.io and click "Log in". The job\'s link (auth.linearity.io/register) only shows the sign-up page.\n' +
    "Searching also shows Blue Host. Imported bluebottlecoffee.com. Google sign-in at accounts.google.com.";
  const hosts = scoutHosts(report, "Linearity AI (the new AI features in Linearity, formerly Vectornator)");
  check("the Scout's real domain is found (linearity.io)", hosts.length === 1 && hosts[0] === "linearity.io");
  check("the guess alone would have been wrong", !vendorHosts("Linearity AI").includes("linearity.io"));
  check("no report → no hosts", scoutHosts(null, "Linearity").length === 0);
}

// ── The outline's opening is not drafted a second time ──
{
  const body = "Real content for this part of the video goes here. ".repeat(3);
  const outline = [
    "## SECTION 0 — Opening (~150 words)", body,
    "## SECTION 1 — Welcome + the tool, named with its offer (~60 words)", body,
    "## SECTION 2 — Getting in (~80 words)", body,
    "## SECTION 3 — Opening the brand page (~200 words)", body,
    "## Cold open", body,
    "## SECTION 4 — Website → brand guide (first win) (~230 words)", body,
    "## AFTER THE SCRIPT — the long version of the prompt", body,
  ].join("\n");
  const names = parseOutlineSections(outline).map((s) => s.name);
  check("'Opening' and 'Welcome' sections are dropped", !names.some((n) => /— Opening \(|Welcome|Cold open/.test(n)));
  check("an 'AFTER THE SCRIPT — long version of the prompt' section is not drafted", !names.some((n) => /AFTER THE SCRIPT/.test(n)));
  check("'Opening the brand page' (a step) is kept", names.some((n) => /Opening the brand page/.test(n)));
  check("the real sections survive", names.length === 3);
}

// ── The opening Jake would keep ──
{
  const good =
    "Look at this. Four sale posts in my colours, made by one tool from one sentence.\n\n" +
    "By the end of this video, you'll turn your website into on-brand ads — even if you've never designed a thing in your life.\n\n" +
    "I'll put the exact prompts on screen, ready to copy.\n\n" + CANONICAL_WELCOME;
  const bad =
    "Your website already knows what your brand looks like. " + "It's all sitting right there and you rebuild it from memory every time. ".repeat(6) +
    "\n\nCan it really figure out a brand? And am I stuck if one word is wrong?\n\n" + CANONICAL_WELCOME;
  const top = `# Title\n\n## HOOKS — pick one\n\n### FORMULA A-COMPRESSED: Show-Tell-Promise\n\n${good}\n\n### OPEN HOOK — no template\n\n${bad}\n\n`;
  const ranking = [
    { hook: 2, label: "OPEN HOOK — no template" },
    { hook: 1, label: "FORMULA A-COMPRESSED: Show-Tell-Promise" },
  ];
  const tut = arrangeOpenings(top, ranking, "", true);
  check("tutorial: the shaped opening wins over a higher-ranked one that fails the shape", /A-COMPRESSED/.test(tut.chosen ?? "") && tut.top.includes(OPENING_HEADING) && tut.top.includes("Look at this"));
  const other = arrangeOpenings(top, ranking, "", false);
  check("other video types still take the top-ranked opening", /OPEN HOOK/.test(other.chosen ?? ""));
}

// ── Prompts: numbers in them are not claims; the summary quotes the script ──
{
  const spoken =
    "Here's the one I'm using.\n\nTHE PROMPT: \"A spring sale campaign for our coffee shop: 20% off all whole bean coffee this weekend.\"\n\n" +
    "And look at that, four posts that each say 20% off.";
  const found = extractPrompts(spoken);
  check("a THE PROMPT: line is found even without an instruction verb", found.length === 1 && /20% off/.test(found[0].text));
  check("a hand-off sentence is not used as the label", found[0]?.label === "Prompt 1");
  check("the prompt text is not audited as a claim", !/20% off all whole bean/.test(stripPromptText(spoken)));
  const audit = auditClaims(spoken, "## PRICES\n- Pro $10\n", "", "", "", [], "", 'The headline says "20% OFF" (shot 0247).');
  check("a number the tool showed today (Scout report) is supported", audit.unsupportedNumbers.length === 0);
  const noEvidence = auditClaims(spoken, "## PRICES\n- Pro $10\n");
  check("…and without that evidence it is still flagged in the prose", noEvidence.unsupportedNumbers.includes("20"));

  // The section wrote "20% off…"; a later pass changed the spoken prompt. The
  // summary must quote what the script says now.
  const edited = 'Here\'s the one I\'m using.\n\nTHE PROMPT: "A spring sale campaign for our coffee shop: a weekend sale on all whole bean coffee."';
  const app = promptAppendices(edited, [{ short: "A spring sale campaign for our coffee shop: 20% off all whole bean coffee this weekend.", label: "", text: "Long version." }]);
  check("the summary quotes the spoken prompt, not the stale draft", app.text.includes('"A spring sale campaign for our coffee shop: a weekend sale on all whole bean coffee."') && !app.text.includes("20% off all"));
  check("the summary heading is there", app.text.includes(PROMPT_SUMMARY_HEADING));
  const orphan = promptAppendices(edited, [{ short: "", label: "", text: "A long version for a prompt the review cut." }]);
  check("a long version with no prompt left in the script is dropped", !orphan.text.includes("A long version for a prompt the review cut."));
}

// ── Production notes ──
{
  const raw = [
    "The personal YouTube tracking link has not been supplied. Get it before upload.",
    "the personal YouTube tracking link has not been supplied. Get it from Linearity before upload and put it in the description.",
    "blur or keep off-screen the account email on any Profile page.",
    "Edit the two-to-three-minute wait down.",
  ];
  const d = dedupeNotes(raw);
  check("near-duplicate notes are merged (keeping the fuller one)", d.length === 3 && d.some((n) => /put it in the description/.test(n)));
  check("every note starts with a capital letter", d.every((n) => /^[A-Z]/.test(n)));
  const ok = parseNotesMerge(
    JSON.stringify({ groups: [
      { heading: "Before the shoot", notes: ["Blur or keep off-screen the account email on any Profile page."] },
      { heading: "At upload", notes: ["Get the personal YouTube tracking link from Linearity before upload and put it in the description."] },
      { heading: "On the shoot", notes: ["Edit the two-to-three-minute wait down."] },
    ] }),
    d,
  );
  check("a faithful merge is accepted and put in shoot order", !!ok && ok.map((g) => g.heading).join("|") === "Before the shoot|On the shoot|At upload");
  check("a merge that invents an item is refused", parseNotesMerge(JSON.stringify({ groups: [{ heading: "At upload", notes: ["Book a voice-over artist for the German version of the ad."] }] }), d) === null);
  check("a merge with more notes than went in is refused", parseNotesMerge(JSON.stringify({ groups: [{ heading: "At upload", notes: [...d, d[0]] }] }), d) === null);
  check("an unknown heading is refused", parseNotesMerge(JSON.stringify({ groups: [{ heading: "Whenever", notes: [d[0]] }] }), d) === null);
  const app = productionNotesAppendix(ok!.flatMap((g) => g.notes), ok);
  check("grouped notes render under ### headings", /### Before the shoot\n\n- /.test(app) && /### At upload/.test(app));
  check("a review re-run still reads grouped notes back", parseStoredAppendices(app).notes.length === 3);
}

console.log("");
if (fail.length) {
  console.log(`${passed} passed, ${fail.length} FAILED:`);
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
