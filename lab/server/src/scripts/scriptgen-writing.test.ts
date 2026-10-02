/**
 * Checks for the 2026-10-02 writing-study changes (P1–P25, as ruled by Jake):
 * the locked welcome line, notes to Jake moved out of the narration, the
 * opening-shape check, the jargon / exemplar-joke / tagline checks, the
 * short-in-script + full-after-script prompts, and the prompt files no longer
 * telling the writer to put [VERIFY ON SCREEN] in the narration.
 *
 * Run against the COMPILED dist (see clipmagic-lab-testing):
 *
 *   docker run --rm -v "$PWD/scriptgen-writing.test.ts":/build/server/dist/scripts/t.ts <image> \
 *     node --experimental-strip-types /build/server/dist/scripts/t.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_WELCOME,
  CANONICAL_OUTRO,
  ensureCanonicalWelcome,
  lockWelcomeInHooks,
  toCleanProse,
  extractProductionNotes,
  findProductionNotesInProse,
  productionNotesAppendix,
  PRODUCTION_NOTES_HEADING,
  extractFullPrompts,
  stripFullPromptBlocks,
  promptAppendices,
  PROMPT_SUMMARY_HEADING,
  FULL_PROMPTS_HEADING,
  splitScriptAppendices,
  parseStoredAppendices,
  extractPrompts,
  openingShapeIssues,
  findUnexplainedJargon,
  findExemplarJokes,
  findTaglineEndings,
  letsMetrics,
  findBannedWords,
  exemplarEchoes,
  arrangeOpenings,
  hookOptions,
  spokenHook,
  OPENING_HEADING,
  OTHER_OPENINGS_HEADING,
  APPENDIX_HEADING_RE,
} from "../scriptgen/edits.js";
import { parseOutlineSections } from "../scriptgen/edits.js";
import { spokenScript, spokenLines } from "../scriptgen/editDiff.js";
import { lockWelcomeInTop, openingIssuesOf } from "../scriptgen/run.js";
import { SHRAPNEL_IN_SCRIPTS, EXEMPLARS, EXEMPLAR_SCRIPTS } from "../scriptgen/prompts.js";

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

// ── P8 — the welcome line is locked in code ──────────────────────────────────

const W = CANONICAL_WELCOME;
check(
  "the canonical welcome is Jake's exact line",
  W ===
    "Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI without it turning into another full-time job. If that sounds like you, hit subscribe and smash that like button so more of these videos find you. Let's get into it.",
);

const quotedBeat =
  '> **Beat 3 (0:25–0:50):** *"By the end of this video, you\'ll know how to create images like a pro. Even if you\'ve never touched a design tool in your life. Hey everyone, I\'m Jake Dawson, and I help people like you get better with the newest AI tools without wasting time or money on expensive tools."*';
const qb = ensureCanonicalWelcome(quotedBeat);
check("a free-written welcome is replaced", qb.changed && qb.text.includes(W));
check("…the promise before it survives", qb.text.includes("Even if you've never touched a design tool in your life."));
check("…the old wording is gone", !qb.text.includes("people like you get better"));
check("…and the closing quote of the beat survives", qb.text.endsWith(`${W}"*`));
check("locking twice changes nothing", ensureCanonicalWelcome(qb.text).changed === false);

const withAsk =
  "Hey guys, if you're new here, I'm Jake Dawson and I help business owners use AI. Subscribe and like the video so more of this finds you. Alright — let's get into it. Today we're pushing ChatGPT way past the basics.";
const wa = ensureCanonicalWelcome(withAsk).text;
check("the welcome's own ask and hand-off are replaced with it", !/Subscribe and like the video/.test(wa) && !/Alright — let's get into it/.test(wa));
check("…but the content sentence after the welcome stays", wa.endsWith("Today we're pushing ChatGPT way past the basics."));
check("…and the canonical line appears exactly once", wa.split(W).length === 2);

const midSentence = ensureCanonicalWelcome("The prompts are on screen — hey everyone, welcome back to the channel. Let's go.").text;
check("a welcome that ran on from a sentence starts a new one", midSentence === `The prompts are on screen. ${W}`);

const noWelcome = "Look at this video. One sentence made it.\n\nBy the end of this video, you'll make one too.";
const nw = ensureCanonicalWelcome(noWelcome);
check("a hook with no welcome gets one appended", nw.changed && nw.text.trimEnd().endsWith(W));

const HOOKS = [
  "============================================================",
  "FORMULA A-LONG — 5-Beat Confession Reframe (90–110s)",
  "Best for: tutorials",
  "============================================================",
  "",
  "Beat 4 (1:10–1:35, ~70 words):",
  "Hey everyone, welcome back to the channel, I'm Jake Dawson, and let's dive right in.",
  "",
  "Beat 5 (1:35–2:00, ~40 words):",
  "I've got a free course in my Skool community. Let's go build it.",
  "",
  "============================================================",
  "FORMULA A-COMPRESSED — Show-Tell-Promise (45–60s)",
  "============================================================",
  "",
  "Beat 1 (0:00–0:08, ~25 words):",
  "Look at this poster. ChatGPT made it in under a minute.",
  "",
  "Beat 2 (0:08–0:25, ~30 words):",
  "By the end of this video, you'll make posters like this — even if you've never opened a design tool in your life.",
  "",
  "Beat 3 (0:25–0:50, ~55 words):",
  "I'll give you the exact prompts on screen, ready to copy. Hey everyone, I'm Jake Dawson.",
  "",
  "JAKE: pick the formula that matches the audience signal for this video.",
].join("\n");
const locked = lockWelcomeInHooks(HOOKS);
check("every hook option gets the canonical welcome", locked.changed === 2 && locked.text.split(W).length === 3);
check("the stale 'let's dive right in' welcome is gone", !locked.text.includes("let's dive right in"));
check("the JAKE: line stays last", locked.text.trimEnd().endsWith("JAKE: pick the formula that matches the audience signal for this video."));
check("the Skool beat after the welcome is untouched", locked.text.includes("I've got a free course in my Skool community. Let's go build it."));

const TOP = `# Title\n\n## HOOKS — pick one\n\n${HOOKS}\n\n## SPONSOR SEGMENT (mid-roll)\n\nQuick break — this segment is sponsored.\n\n`;
const lt = lockWelcomeInTop(TOP);
check("lockWelcomeInTop locks the hooks", lt.changed === 2);
check("…and leaves the sponsor segment alone", lt.text.endsWith("## SPONSOR SEGMENT (mid-roll)\n\nQuick break — this segment is sponsored.\n\n"));

check("the welcome carries no banned word", findBannedWords(W).length === 0);
check("the canonical outro no longer says 'clips' (P7)", !/\bclips?\b/i.test(CANONICAL_OUTRO) && findBannedWords(CANONICAL_OUTRO).length === 0);
check("the welcome is boilerplate, never a lifted line", exemplarEchoes(`Intro. ${W} Then the build.`, EXEMPLAR_SCRIPTS).length === 0);

// ── P1 — notes to Jake never stay in the narration ───────────────────────────

const RAW =
  "Open Settings, then hit [VERIFY ON SCREEN: the button that starts a new skill] to begin.\n\n" +
  "Now we wait. [SHOOT DAY: stopwatch the render] It takes a couple of minutes.\n\n" +
  "PRODUCTION NOTE: check the plan name on the pricing page\n\n" +
  "And there it is.";
check("before extraction the check sees the notes", findProductionNotesInProse(RAW).length >= 3);
// The real assembly order: toCleanProse first (which must not silently delete a
// flag), then extraction.
const cleaned = toCleanProse(RAW);
check("toCleanProse parks a SHOOT DAY marker instead of deleting it", cleaned.includes("[SHOOT DAY: stopwatch the render]"));
const ex = extractProductionNotes(cleaned);
check("no bracketed note is left in the narration", !/\[(?:VERIFY|SHOOT)/i.test(ex.body));
check("the post-extraction check comes back clean", findProductionNotesInProse(ex.body).length === 0);
check("all three notes are kept", ex.notes.length === 3);
check("a VERIFY note says what to check and where", ex.notes.some((n) => n.startsWith("VERIFY ON SCREEN: the button that starts a new skill") && n.includes("Open Settings")));
check("a SHOOT DAY note is kept", ex.notes.some((n) => n.startsWith("SHOOT DAY: stopwatch the render")));
check("a PRODUCTION NOTE line is lifted out whole", ex.notes.includes("check the plan name on the pricing page") && !ex.body.includes("PRODUCTION NOTE"));
check(
  "a marker that describes the control leaves the description in the step",
  ex.body.startsWith("Open Settings, then hit the button that starts a new skill to begin."),
);
check(
  "a marker that is a question comes out whole, number and all",
  extractProductionNotes("The trial runs [VERIFY ON SCREEN: is it 14 days?] for a while.").body === "The trial runs for a while.",
);
check(
  "a marker asking for an exact name never leaves a guess behind",
  extractProductionNotes("Click [VERIFY ON SCREEN: exact name of the download control] now.").body === "Click now.",
);
check("the narration around the notes survives", ex.body.includes("Now we wait. It takes a couple of minutes.") && ex.body.endsWith("And there it is."));
const appx = productionNotesAppendix(ex.notes);
check("the notes become an appendix after the script", appx.includes(PRODUCTION_NOTES_HEADING) && appx.includes("- check the plan name on the pricing page"));
check("no notes, no appendix", productionNotesAppendix([]) === "");
check("duplicate notes are listed once", extractProductionNotes("A [VERIFY: x] b.\nPRODUCTION NOTE: y\nPRODUCTION NOTE: y").notes.length === 2);

// ── P3 — the opening shape ───────────────────────────────────────────────────

const GOOD_HOOK = [
  "Beat 1 (0:00–0:08, ~25 words):",
  "Look at this poster. ChatGPT made it in under a minute.",
  "",
  "Beat 2 (0:08–0:25, ~30 words):",
  "By the end of this video, you'll make posters like this — even if you've never opened a design tool in your life.",
  "",
  "Beat 3 (0:25–0:50, ~55 words):",
  `I'll give you the exact prompts on screen, ready to copy — the poster, the product shot and the logo. ${W}`,
].join("\n");
check("Jake's opening shape passes", openingShapeIssues(GOOD_HOOK).length === 0);
const BAD_HOOK = [
  "Every week you lose hours to posters.",
  "",
  "Designers are expensive. Templates look cheap.",
  "",
  "So what if one tool fixed it? And what would it cost? And could you trust it?",
  "",
  "Here's what we're using today: ChatGPT, a brand kit, and a folder.",
  "",
  "Here's the roadmap: setup, three posters, and the export settings that matter most for print.",
  "",
  W,
].join("\n");
const badIssues = openingShapeIssues(BAD_HOOK);
check("too many paragraphs before the welcome is flagged", badIssues.some((i) => /paragraphs before the welcome/.test(i)));
check("a missing 'By the end of this video' promise is flagged", badIssues.some((i) => /By the end of this video/.test(i)));
check("a list of questions is flagged", badIssues.some((i) => /questions before the welcome/.test(i)));
check("a hook with no welcome is flagged", openingShapeIssues("Look at this. By the end of this video, you'll know.").includes("no welcome line"));
check(
  "a promise without the reassurance is flagged",
  openingShapeIssues(`Look at this. By the end of this video, you'll make one. ${W}`).some((i) => /even if you've never/.test(i)),
);
const twoHooks = `FORMULA A-LONG — x\n\nI used to think this was hard.\n\nFORMULA A-COMPRESSED — y\n\n${BAD_HOOK}`;
const oi = openingIssuesOf(twoHooks, "Tutorial");
check("openingIssuesOf checks A-Compressed and labels it", oi.length > 0 && oi.every((i) => i.startsWith("FORMULA A-COMPRESSED")));
check("openingIssuesOf leaves A-Long alone", !oi.some((i) => /A-LONG/.test(i)));

// ── P19 — the jargon first mention ───────────────────────────────────────────

check(
  "a raw jargon term with no plain line is flagged",
  findUnexplainedJargon("Paste the Remote MCP server URL into the box. Click save.").some((j) => j.startsWith("MCP")),
);
check(
  "the 'that sounds scary — it's just' move passes",
  findUnexplainedJargon(
    "The way we connect them is called an MCP. Now, that sounds scary. It's not. It's just the plug that lets Claude use another app for you.",
  ).length === 0,
);
check("an API key explained once covers the word API", findUnexplainedJargon("Copy your API key. An API key is just a password for apps. Then the API does the rest.").length === 0);
check("a script with no jargon is clean", findUnexplainedJargon("Click the big blue button and wait.").length === 0);

// ── P24 — exemplar jokes, even short ones ────────────────────────────────────

check(
  "a reused short exemplar joke is caught",
  eqList(findExemplarJokes("I'm logging in with Google, because life's too short for another password."), ["too short for another password"]),
);
check("the 8-word shingle check alone would miss it", exemplarEchoes("Your credits will thank you.", EXEMPLAR_SCRIPTS).length === 0 && findExemplarJokes("Your credits will thank you.").length === 1);
check("original jokes are not flagged", findExemplarJokes("Connecting the wrong Google account is a fun ten minutes nobody needs.").length === 0);
function eqList(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── P11 — restatement tails ──────────────────────────────────────────────────

check("a 'That's the whole trick.' tail is flagged", findTaglineEndings("You paste the link and it builds the page. That's the whole trick.").length === 1);
check("a 'Done.' tail is flagged", findTaglineEndings("Hit publish and it goes out on every app. Done.").length === 1);
check("an 'X, not Y' tagline is flagged", findTaglineEndings("You point at the screen and it follows you. Pointing, not clicking.").length === 1);
check("a paragraph ending on the instruction is clean", findTaglineEndings("Click Generate. It takes about a minute, and the video lands in your library.").length === 0);

// ── P12 — the soft "let's" metric ────────────────────────────────────────────

const lm = letsMetrics("Now let's open the editor. Let's paste it in. Click Save. Paste it. Send. Then we wait for the render to finish.");
check("let's per 1,000 words is measured", lm.letsPer1000 > 0);
check("bare command lines are counted", lm.bareImperatives.length === 3);
check("the canonical outro is not counted", letsMetrics(`Let's go. ${CANONICAL_OUTRO}`).letsPer1000 > 100);

// ── P20 + Jake's ruling — short prompt in the script, full version after it ──

check(
  "extractPrompts finds a conversational two-sentence prompt",
  extractPrompts('Type this: "Here\'s my product. Make five short videos for it, each one under thirty seconds." And hit send.').length === 1,
);

const SECTION = [
  'Now let\'s type the first prompt: "Here\'s my product page. Make five short videos for it, one for each app I post on." And hit enter.',
  "<<<FULL PROMPT>>>",
  "You are a short-form video producer. Using the product page I paste below:",
  "",
  "1. Write five scripts, one each for TikTok, Instagram, YouTube Shorts, LinkedIn and Facebook.",
  "2. Keep each under thirty seconds. Do not invent features or prices.",
  "<<<END FULL PROMPT>>>",
  "",
  "And there it is — five videos in the library.",
  "",
  'Then the weekly one: "Look at last week\'s posts and tell me the three that did best, with the reason for each one."',
  "<<<FULL PROMPT: Weekly report>>>",
  "Act as my social media analyst. Pull every post from the last seven days and rank them.",
].join("\n");
const fp = extractFullPrompts(SECTION);
check("both full-prompt blocks are lifted out (one unterminated)", fp.blocks.length === 2);
check("no fence is left in the narration", !/<<<|>>>/.test(fp.body) && findProductionNotesInProse(fp.body).length === 0);
check("the full text keeps its structure, blank line included", fp.blocks[0].text.includes("\n\n1. Write five scripts"));
check("each block knows its short prompt", fp.blocks[0].short.startsWith("Here's my product page.") && fp.blocks[1].short.startsWith("Look at last week"));
check("a label on the fence is kept", fp.blocks[1].label === "Weekly report");
check("stripFullPromptBlocks leaves only narration", !stripFullPromptBlocks(SECTION).includes("short-form video producer"));

const appendix = promptAppendices(fp.body, fp.blocks);
check("both short prompts are numbered in the summary", appendix.shortCount === 2 && appendix.text.includes(PROMPT_SUMMARY_HEADING) && /\*\*1\. .*:\*\* "Here's my product page/.test(appendix.text) && /\*\*2\. /.test(appendix.text));
check("both full versions follow, after the summary", appendix.fullCount === 2 && appendix.text.indexOf(FULL_PROMPTS_HEADING) > appendix.text.indexOf(PROMPT_SUMMARY_HEADING));
check("full version 1 is numbered like its short version", /\*\*1\. [^\n]* — full version\*\*\n\nYou are a short-form video producer/.test(appendix.text));
check("full version 2 is numbered like its short version", /\*\*2\. [^\n]* — full version\*\*\n\nAct as my social media analyst/.test(appendix.text));
const orphan = promptAppendices("Now type Plan my week from these five notes and send it.", [{ short: "Plan my week from these five notes", label: "", text: "Long version." }]);
check("a full prompt whose short version was not quoted still gets a summary line", orphan.shortCount === 1 && orphan.text.includes('"Plan my week from these five notes"') && orphan.fullCount === 1);
check("no prompts, no appendix", promptAppendices("Just narration.", []).text === "");

// The assembled section, as finalReviewAndAssemble writes it, split back up.
const spoken = `${fp.body}\n\n${CANONICAL_OUTRO}`;
const section = `${spoken}${appendix.text}${productionNotesAppendix(["check the export button"])}`;
const split = splitScriptAppendices(section);
check("splitScriptAppendices returns the spoken body alone", split.body === spoken);
check("…and every appendix after it", split.appendix.includes(FULL_PROMPTS_HEADING) && split.appendix.includes(PRODUCTION_NOTES_HEADING));
const stored = parseStoredAppendices(split.appendix);
check("a review re-run reads the full prompts back", stored.blocks.length === 2 && stored.blocks[0].text.startsWith("You are a short-form video producer"));
check("…paired to their short prompts again", promptAppendices(fp.body, stored.blocks).fullCount === 2 && /\*\*2\. [^\n]* — full version\*\*\n\nAct as/.test(promptAppendices(fp.body, stored.blocks).text));
check("…and the production notes", stored.notes.length === 1 && stored.notes[0] === "check the export button");

const doc = `# T\n\n## HOOKS — pick one\n\nhooks\n\n## SCRIPT\n\n${section}`;
check("the edit diff never reads the full prompts as spoken", !spokenScript(doc).includes("short-form video producer"));
check("…nor the production notes", !spokenScript(doc).includes("check the export button"));
check("the rules pass never sees them either", spokenLines(doc).every((l) => !/short-form video producer|check the export button|FULL PROMPTS/.test(l.text)));

// ── P6 / P25 / P1 — what the prompts say ─────────────────────────────────────

check("the story-shrapnel bank is switched off", SHRAPNEL_IN_SCRIPTS === false);
check("the exemplar frame says the learned rules win after the demo", /On what comes after the demo, the LEARNED FROM JAKE'S OWN EDITS rules win/.test(EXEMPLARS));

const promptDir = fileURLToPath(new URL("../scriptgen/prompts/", import.meta.url));
const files = readdirSync(promptDir).filter((f) => f.endsWith(".md"));
const instructsMarker: string[] = [];
for (const f of files) {
  for (const line of readFileSync(promptDir + f, "utf8").split("\n")) {
    if (!/VERIFY ON SCREEN|SHOOT DAY|\[VERIFY/i.test(line)) continue;
    // Every surviving mention must be a prohibition.
    if (!/\b(?:no|never|not|nothing|don't)\b/i.test(line)) instructsMarker.push(`${f}: ${line.trim().slice(0, 90)}`);
  }
}
check(`no stage prompt tells the writer to put a marker in the narration${instructsMarker.length ? ` — ${instructsMarker.join(" | ")}` : ""}`, instructsMarker.length === 0);

// The inline blocks in run.ts ride the user turn, closer to the task than any
// lesson — the reason the approved rule kept losing. Check their string lines.
const runJs = readFileSync(fileURLToPath(new URL("../scriptgen/run.js", import.meta.url)), "utf8");
const runMarkers = runJs
  .split("\n")
  .filter((l) => /^\s*["'`]/.test(l) && /VERIFY ON SCREEN|SHOOT DAY/.test(l))
  .filter((l) => !/\b(?:no|never|not|nothing|don't)\b/i.test(l));
check("no run.ts prompt block tells the writer to write a marker", runMarkers.length === 0);
check("run.ts no longer tells Stage 7 to protect the markers", !/Leave every `\[VERIFY ON SCREEN/.test(runJs));
check("run.ts no longer allows a credential 'even in the hook'", !/even in the hook/.test(runJs));

const s5 = readFileSync(promptDir + "stage5-section.md", "utf8");
check("stage 5 no longer teaches a credential leak", !/This is where credentials leak in/.test(s5) && !/I ran a SaaS a few years ago/.test(s5));
check("stage 5 no longer teaches the banned phrases", !/keep coming back to/i.test(s5) && !/Anyway — moving on/.test(s5) && !/caveat\| the thing/.test(s5));
check("stage 5 Slot 12 has no React / payoff beat", !/\*\*React\*\*/.test(s5) && !/Credit or curiosity payoff/.test(s5));
check("stage 5 describes the FULL PROMPT fence the code lifts", s5.includes("<<<FULL PROMPT>>>") && s5.includes("<<<END FULL PROMPT>>>"));
const s7 = readFileSync(promptDir + "stage7-review.md", "utf8");
check("stage 7 checks the real welcome line", s7.includes(W) && !/let's dive right in/.test(s7));
check("stage 7 no longer asks 'Honest thoughts included?'", !/Honest thoughts included\?/.test(s7));
const s3 = readFileSync(promptDir + "stage3-hooks.md", "utf8");
check("stage 3's worked example carries no credential", !/I've spent the last few weeks testing every trick/.test(s3.split("HARD RULES")[0]));
check("stage 3 shows only the canonical welcome", !/Hey everyone, I'm Jake Dawson, and I help people like you/.test(s3) && !/Hey guys, if you're new here/.test(s3));
const cta = readFileSync(promptDir + "stage5.5-cta.md", "utf8");
check("the free-course example drops 'it costs nothing' and 'Anyway —'", !/it costs nothing\. Anyway/.test(cta));
const s2 = readFileSync(promptDir + "stage2-outline.md", "utf8");
check("the outline templates drop the verdict / recap scaffolding", !/FINAL VERDICT|REAL-WORLD RESULTS|Quick Recap|My Rating|How it compares to alternatives/.test(s2));
check("the length floor is untouched (P10 rejected)", /TARGET LENGTH: 10–12 minutes minimum/.test(s2));
check("the tutorial template has the setup-from-zero walk and the first win", /SETUP FROM ZERO/.test(s2) && /FIRST WIN/.test(s2));

// ── One opening in the script, the alternatives after it (2026-10-02) ──
{
  const sep = "============================================================";
  const top = [
    "# My Video", "", "## HOOKS — pick one", "",
    sep, "FORMULA A-LONG — 5-Beat Confession Reframe (90–110s)", "Best for: tutorials with algorithmic-discovery", sep, "",
    "**Beat 1 (0:00–0:10)**", "", "Long hook text here.", "",
    sep, "FORMULA A-COMPRESSED — Show-Tell-Promise (45–60s)", "Best for: tutorials with search-driven traffic", "Sub-conversion: LOW | Retention: HIGH", sep, "",
    "**Beat 1 (0:00–0:08)**", "", "Look at this. A finished video.", "", "**Beat 3 (0:25–0:50)**", "", "By the end of this video, you'll make one. " + CANONICAL_WELCOME, "",
    sep, "FORMULA B — Compressed Numbered Reveal (45–60s)", "Best for: listicles", sep, "", "Numbered hook.", "",
    sep, "", "JAKE: pick the formula that matches the audience signal for this video.", "",
    "### OPEN HOOK — no template, written for this video", "", "Open hook text.", "",
  ].join("\n");
  check("hookOptions finds all four options", hookOptions(top.split("## HOOKS — pick one")[1]).length === 4);
  const ranked = arrangeOpenings(top, [{ hook: 3, label: "FORMULA B — Compressed Numbered Reveal" }]);
  check("the top-ranked hook becomes the one opening", ranked.chosen?.startsWith("FORMULA B") === true && ranked.top.includes(`${OPENING_HEADING}\n\nNumbered hook.`));
  check("no HOOKS block and no other option is left in the top part", !/## HOOKS/.test(ranked.top) && !ranked.top.includes("Long hook text") && !ranked.top.includes("Open hook text"));
  check("the other three openings go after the script", ranked.otherAppendix.includes(OTHER_OPENINGS_HEADING) && ["Long hook text", "Look at this. A finished video.", "Open hook text"].every((t) => ranked.otherAppendix.includes(t)) && !ranked.otherAppendix.includes("Numbered hook."));
  const fallback = arrangeOpenings(top, null);
  check("with no ranking, A-Compressed (Jake's opening shape) is used", fallback.chosen?.includes("A-COMPRESSED") === true);
  check("the spoken opening drops the formula apparatus", !/Best for|Sub-conversion|Beat 1|====|JAKE:/.test(fallback.top) && fallback.top.includes("Look at this. A finished video.") && fallback.top.includes(CANONICAL_WELCOME));
  check("spokenHook keeps screen directions", spokenHook("**Beat 1 (0:00–0:08)**\n\n*(What's shown: the result.)*\n\nLook at this.").includes("What's shown"));
  check("a sponsor segment after the hooks is kept", arrangeOpenings(top + "\n## SPONSOR SEGMENT (mid-roll)\n\nSponsor words.\n", null).top.includes("## SPONSOR SEGMENT (mid-roll)\n\nSponsor words."));
  check("a document already in the new format is left alone, and its alternatives are carried", (() => {
    const r = arrangeOpenings(`# T\n\n${OPENING_HEADING}\n\nHi.\n\n`, null, "### FORMULA B\n\nOld alt.");
    return r.top === `# T\n\n${OPENING_HEADING}\n\nHi.\n\n` && r.otherAppendix.includes("Old alt.");
  })());
  check("OTHER OPENINGS counts as an appendix (not spoken)", APPENDIX_HEADING_RE.test(OTHER_OPENINGS_HEADING));
  const doc = `# T\n\n${OPENING_HEADING}\n\nOpening.\n\n## SCRIPT\n\nThe spoken body.${ranked.otherAppendix}`;
  check("the edit diff stops before the other openings", spokenScript(doc) === "The spoken body.");
  check("a stored document gives its other openings back for a review re-run", parseStoredAppendices(splitScriptAppendices(doc.split("## SCRIPT")[1]).appendix).otherOpenings.includes("Numbered hook.") === false
    && parseStoredAppendices(splitScriptAppendices(doc.split("## SCRIPT")[1]).appendix).otherOpenings.includes("Open hook text"));
}

// ── Writer briefings are not sections (they became a second cold open) ──
{
  const outline = [
    "#### 🔒 READ BEFORE WRITING A SINGLE LINE", "Never say the price twice. Use the plain words. ".repeat(3),
    "#### ⚠ WRITER GUARDRAILS — read before writing a single line", "Rules for the writer go here at some length. ".repeat(3),
    "#### ⚠ NOTES TO JAKE BEFORE RECORDING — read these first", "Check the account is logged in before recording. ".repeat(3),
    "#### THE CAST — what we're building the video around", "A coffee roaster called Bean There. ".repeat(3),
    "#### VOCABULARY — use these words, not the old ones", "Say video, not clip. ".repeat(5),
    "#### ⏱️ HOOK (0:00-0:30)", "Hook goes here and is written by stage three. ".repeat(3),
    "#### SECTION 1 — SIGN UP AND THE ONE SCREEN THAT MATTERS (~300 words)", "Create the account, answer the questions, see the dashboard. ".repeat(3),
    "#### SECTION 2 — MAKE THE FIRST POST (~300 words)", "Type one sentence and generate the post. ".repeat(3),
  ].join("\n");
  const names = parseOutlineSections(outline).map((x) => x.name);
  check("briefing blocks and the HOOK are not drafted as sections", names.length === 2 && names[0].startsWith("SECTION 1") && names[1].startsWith("SECTION 2"));
}

console.log("");
if (fail.length) {
  console.log(`${passed} passed, ${fail.length} FAILED:`);
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
