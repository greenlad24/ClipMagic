/**
 * Unit tests for the pure helpers behind the brief-coverage pass and the
 * step-scaffold markers. Run against the COMPILED dist (see clipmagic-lab-testing):
 *
 *   docker run --rm -v "$PWD/scriptgen-coverage.test.ts":/t.ts <image> \
 *     node --experimental-strip-types /t.ts
 */
import {
  AI_SLOP_PHRASES,
  findSlopPhrases,
  CANONICAL_OUTRO,
  ensureCanonicalOutro,
  findBannedWords,
  parseCoveragePass,
  parseOutlineSections,
  allocateSectionWords,
  toCleanProse,
  stripVerifyMarkers,
  dateWindows,
  MIN_SECTION_WORDS,
  findSourceNames,
  applyBriefEdits,
  demoDensity,
  checkSectionDemo,
  exemplarEchoes,
  outlineSectionsMissingOnScreen,
  insertOnScreenLines,
  scriptQuality,
} from "../scriptgen/edits.js";
import {
  auditSources,
  classifySource,
  firstPartyBlock,
  hostOf,
  toolName,
  vendorHosts,
} from "../scriptgen/sources.js";
import {
  claimFixList,
  claimFixPrompt,
  openLoopsPrompt,
  parseOpenLoops,
  openLoopsBlock,
  loopCloseBlock,
  loopClosed,
  splitHooks,
  seoKeywords,
  seoScore,
  hookRankPrompt,
  parseHookRanking,
  openHookPrompt,
  OPEN_HOOK_HEADING,
} from "../scriptgen/run.js";
import { extractPrompts } from "../scriptgen/edits.js";
import {
  formatTranscript,
  parseCaptionBody,
  mentionsTopic,
  parseIsoDuration,
  pickSubtitleTracks,
  searchTopic,
  stamp,
  QUERY_COUNT,
  queriesPrompt,
  parseQueries,
  candidateBlock,
  selectionPrompt,
  parseSelection,
  pickReasons,
  mechanicalRank,
  wantsDeveloperWorkflow,
  audienceRule,
  type Candidate,
} from "../scriptgen/videoResearch.js";

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── parseCoveragePass ─────────────────────────────────────────────────────────

const GOOD = `===COVERAGE===
SCORE: 62
VERDICT: The outline dropped the onboarding moment; I gave it its own section and took the words from the roadmap.
covered | one-link share | PHASE 4 — Share it with one link
added | the onboarding wow moment: name + website in, profile out | new PHASE 2.5, before the packaging phase
gap | the $40/mo example | the brief flags pricing as unconfirmed until it's in writing
===OUTLINE===
# VIDEO OUTLINE

## HOOK (0:00-0:35)
Open on the pain.`;

const cov = parseCoveragePass(GOOD);
check("parseCoveragePass reads the score", cov?.score === 62);
check("parseCoveragePass reads the verdict", (cov?.verdict ?? "").startsWith("The outline dropped"));
check("parseCoveragePass reads every item row", cov?.items.length === 3);
check(
  "parseCoveragePass splits status | item | where",
  eq(cov?.items[1], {
    status: "added",
    item: "the onboarding wow moment: name + website in, profile out",
    where: "new PHASE 2.5, before the packaging phase",
  }),
);
check("parseCoveragePass returns the outline block whole", (cov?.outline ?? "").startsWith("# VIDEO OUTLINE"));
check("parseCoveragePass keeps outline headers intact", (cov?.outline ?? "").includes("## HOOK (0:00-0:35)"));

check("parseCoveragePass returns null with no delimiters", parseCoveragePass("just some prose") === null);
check(
  "parseCoveragePass returns null when the outline block is empty",
  parseCoveragePass("===COVERAGE===\nSCORE: 90\n===OUTLINE===\n   \n") === null,
);
check(
  "parseCoveragePass survives a missing score/verdict",
  (() => {
    const c = parseCoveragePass("===COVERAGE===\ncovered | a | b\n===OUTLINE===\nreal outline text");
    return c !== null && c.score === 0 && c.items.length === 1;
  })(),
);
check(
  "parseCoveragePass clamps a nonsense score",
  parseCoveragePass("===COVERAGE===\nSCORE: 900\n===OUTLINE===\nx")?.score === 100,
);
check(
  "parseCoveragePass ignores prose lines that aren't item rows",
  (() => {
    const c = parseCoveragePass(
      "===COVERAGE===\nHere are my thoughts, they contain | a pipe.\ncovered | a | b\n===OUTLINE===\nx",
    );
    return c?.items.length === 1;
  })(),
);

// ── allocateSectionWords ──────────────────────────────────────────────────────
// The regression: an even split pinned all ten Expertise sections to the floor.

const EXPERTISE = [
  { targetWords: 100 }, // bridge
  { targetWords: 300 }, // phase 1
  { targetWords: 250 }, // phase 2
  { targetWords: 350 }, // phase 3 — the walkthrough
  { targetWords: 300 }, // phase 4
  { targetWords: 180 }, // honest thoughts
];
const alloc = allocateSectionWords(EXPERTISE, 1800);
check("allocateSectionWords honours the outline's ratio", alloc[3] > alloc[0] * 2);
check("the walkthrough is no longer at the floor", alloc[3] > MIN_SECTION_WORDS);
check(
  "the total lands near the section share of the budget",
  (() => {
    const sum = alloc.reduce((a, b) => a + b, 0);
    return sum > 1800 * 0.85 * 0.9 && sum < 1800 * 0.85 * 1.1;
  })(),
);
check(
  // Jake's ruling: the runtime is a MINIMUM, not a maximum — "nothing would stop
  // the AI from writing everything that needs to be written". An outline that
  // sizes itself past the runtime is the material asking for room, and it keeps it.
  "an outline that over-allocates is honoured, not squeezed to fit the runtime",
  (() => {
    const big = allocateSectionWords([{ targetWords: 5000 }, { targetWords: 5000 }], 1800);
    return big[0] === 5000 && big[1] === 5000;
  })(),
);
check(
  "a short outline is still scaled UP to fill the runtime",
  (() => {
    const small = allocateSectionWords([{ targetWords: 100 }, { targetWords: 100 }], 4000);
    return small.reduce((a, b) => a + b, 0) > 200;
  })(),
);
check(
  "scaling up keeps the outline's own ratio between sections",
  (() => {
    const r = allocateSectionWords([{ targetWords: 100 }, { targetWords: 300 }], 4000);
    return Math.abs(r[1] / r[0] - 3) < 0.1;
  })(),
);
check(
  "sections with no stated target get an ordinary share, not nothing",
  (() => {
    const mixed = allocateSectionWords([{ targetWords: 300 }, { targetWords: null }, { targetWords: 300 }], 1800);
    return mixed[1] >= MIN_SECTION_WORDS && Math.abs(mixed[1] - mixed[0]) < 60;
  })(),
);
check(
  "no targets at all falls back to an even split",
  (() => {
    const even = allocateSectionWords([{ targetWords: null }, { targetWords: null }], 1800);
    return even[0] === even[1] && even[0] > MIN_SECTION_WORDS;
  })(),
);
check("nothing is ever asked for less than the floor", allocateSectionWords(Array(40).fill({ targetWords: 10 }), 1800).every((w) => w >= MIN_SECTION_WORDS));
check("empty section list is empty allocation", eq(allocateSectionWords([], 1800), []));

// ── parseOutlineSections ──────────────────────────────────────────────────────
// The header shapes are lifted verbatim from the Expertise run's real outline,
// which produced ten "sections" — every one of them pinned to the 150-word floor,
// two of them writer apparatus read out to camera, one a table of contents.

const REAL_OUTLINE = `# VIDEO OUTLINE

## "How to Turn Your Claude Skills Into a Product (Step by Step)"

## ⚠️ WRITER-CRITICAL FLAGS (read before writing a word)

These are hard gaps from research. Do not paper over them. Pricing is unconfirmed
and must not be invented; leave the bracket for Jake to fill from the sponsor.

## ⏱️ HOOK (0:00–0:35) — ~180 words

Open on the pain, not on Jake. One vivid line about the file being a giveaway.

## ⏱️ QUICK INTRO / BRIDGE (0:35–1:15) — ~100 words

One bridge line, one plain framing, then into Phase 1. Do not re-introduce Jake.

## ⏱️ THE ROADMAP (1:15–10:00) — ~1200 words

Four phases. Rank by value.

### PHASE 1 — Turn what you know into a skill (~300 words)

What you're building: the skill file itself. Pick the task people ask you for.
Beats: narrow beats broad, one job per skill, the rules section is the real work.

### PHASE 3 — Package it on Expertise (~350 words)

What you're building: the file becomes a live, installable skill. Walk the upload
flow on screen, narrate present tense, show the skill going live on the platform.

## ⏱️ HONEST THOUGHTS (10:00–11:15) — ~180 words

Jake's actual take, said once. Thirty seconds. Not a balanced weighing.

## ⏱️ CTA + WRAP (11:15–12:00) — ~100 words

The close. Stage 6 owns this.

## FACT SHEET (carry verbatim into the section-writer's sheet)

Skills are markdown files. MCP is the standard that lets them run cross-platform.
Approval precedes go-live. Pricing: UNCONFIRMED, do not claim.`;

const secs = parseOutlineSections(REAL_OUTLINE);
const names = secs.map((s) => s.name);
check("the hook is left to Stage 3", !names.some((n) => /hook/i.test(n)));
check("the trailing CTA/wrap is left to Stage 6", !names.some((n) => /cta|wrap/i.test(n)));
check("WRITER-CRITICAL FLAGS is not drafted as script", !names.some((n) => /flag/i.test(n)));
check("the FACT SHEET block is not drafted as script", !names.some((n) => /fact.?sheet/i.test(n)));
check("the ROADMAP container is not drafted over its own children", !names.some((n) => /roadmap/i.test(n)));
check("the outline title is not drafted", !names.some((n) => n.startsWith('"')));
check(
  "the real sections survive, and only those",
  eq(names, [
    // cleanSectionName only strips a TRAILING parenthetical, so a header that
    // puts its timestamp mid-line keeps it. Cosmetic — the name is a log label
    // and a continuity breadcrumb, not something the viewer ever hears.
    "QUICK INTRO / BRIDGE (0:35–1:15) — ~100 words",
    "PHASE 1 — Turn what you know into a skill",
    "PHASE 3 — Package it on Expertise",
    "HONEST THOUGHTS (10:00–11:15) — ~180 words",
  ]),
);
check(
  "each section carries the outline's own word allocation",
  eq(
    secs.map((s) => s.targetWords),
    [100, 300, 350, 180],
  ),
);
check(
  "the walkthrough gets more than double the floor it used to get",
  (() => {
    const a = allocateSectionWords(secs, 1800);
    return a[2] >= 350 && a[2] > MIN_SECTION_WORDS * 2;
  })(),
);
check(
  "a section with a real body and sub-headers is NOT treated as a container",
  (() => {
    const s = parseOutlineSections(
      "## BUILD IT\n" +
        "This section has a genuinely long body of its own that runs well past two hundred characters, " +
        "because it explains the whole build in prose before the sub-steps break it down further below. " +
        "It is a real section, not a table of contents, and it must survive the container filter.\n\n" +
        "### Step one\nDo the thing.",
    );
    return s.some((x) => /BUILD IT/i.test(x.name));
  })(),
);
check(
  "an outline with no headers is still one drafted section",
  (() => {
    const s = parseOutlineSections("just a wall of outline prose with no headers at all");
    return s.length === 1 && s[0].name === "Main content";
  })(),
);

// ── VERIFY markers ────────────────────────────────────────────────────────────

const WITH_MARKER =
  "Go to Settings, then Skills, and hit [VERIFY ON SCREEN: the button that starts a new skill] to begin.";

check(
  "toCleanProse keeps a VERIFY marker",
  toCleanProse(WITH_MARKER).includes("[VERIFY ON SCREEN: the button that starts a new skill]"),
);
check(
  "toCleanProse still strips an ordinary stage direction",
  !toCleanProse("Here it is. [B-roll: the dashboard] And that's it.").includes("B-roll"),
);
check(
  "toCleanProse keeps the marker while stripping a direction beside it",
  (() => {
    const out = toCleanProse("Click [VERIFY ON SCREEN: the tab name]. [Cut to screen] Done.");
    return out.includes("[VERIFY ON SCREEN: the tab name]") && !out.includes("Cut to screen");
  })(),
);
check(
  "toCleanProse does not eat real numbers near a marker",
  (() => {
    const out = toCleanProse("You get 50 images every 3 hours [VERIFY ON SCREEN: the plan name] on this plan.");
    return out.includes("50 images") && out.includes("3 hours") && out.includes("[VERIFY ON SCREEN: the plan name]");
  })(),
);
check(
  "toCleanProse restores several markers in order",
  (() => {
    const out = toCleanProse("A [VERIFY: one] then B [VERIFY: two] then C [VERIFY: three].");
    return out.indexOf("[VERIFY: one]") < out.indexOf("[VERIFY: two]") && out.includes("[VERIFY: three]");
  })(),
);
check("toCleanProse still strips markdown headers", !toCleanProse("## SECTION\nreal text").includes("##"));

check("stripVerifyMarkers removes the marker", !stripVerifyMarkers(WITH_MARKER).includes("VERIFY"));
check(
  "stripVerifyMarkers keeps the sentence readable",
  stripVerifyMarkers("Click the button [VERIFY ON SCREEN: its name] now.") === "Click the button now.",
);
check(
  "stripVerifyMarkers does not leave a space before punctuation",
  stripVerifyMarkers("Open Settings [VERIFY ON SCREEN: exact path].") === "Open Settings.",
);
check(
  "a marker's numbers never reach the claim audit",
  !stripVerifyMarkers("The trial runs [VERIFY ON SCREEN: is it 14 days?] for a while.").includes("14"),
);

// ── the recency ladder ───────────────────────────────────────────────────────
// "Prioritize the last 6 months" did nothing because a model has no clock. These
// windows are what make the instruction checkable, so the arithmetic has to hold
// at the edges of a month and a year.

check(
  "today is the full date",
  dateWindows(new Date(2026, 8, 3)).today === "September 3, 2026",
);
check(
  "thisMonth is what a search query gets anchored to",
  dateWindows(new Date(2026, 8, 3)).thisMonth === "September 2026",
);
check("recent is three months back", dateWindows(new Date(2026, 8, 3)).recent === "June 2026");
check("oneYear is twelve months back", dateWindows(new Date(2026, 8, 3)).oneYear === "September 2025");

check(
  "the three-month window crosses the year boundary",
  dateWindows(new Date(2026, 0, 15)).recent === "October 2025",
);
check(
  "the twelve-month anchor crosses the year boundary",
  dateWindows(new Date(2026, 0, 15)).oneYear === "January 2025",
);

// The bug this guards: `setMonth(-3)` on the 31st of a month lands in the month
// AFTER the one asked for (May 31 -> "February 31" -> March 3), which would
// shift the anchor by a month on 7 days out of every 31.
check(
  "a 31-day month does not overshoot the window",
  dateWindows(new Date(2026, 4, 31)).recent === "February 2026",
);
check(
  "a 31-day month does not overshoot the twelve-month anchor",
  dateWindows(new Date(2026, 4, 31)).oneYear === "May 2025",
);
check(
  "the last day of a leap February behaves",
  dateWindows(new Date(2028, 1, 29)).recent === "November 2027",
);

check(
  "recent is always newer than oneYear",
  (() => {
    for (let m = 0; m < 12; m++) {
      const w = dateWindows(new Date(2026, m, 28));
      if (new Date(w.recent) <= new Date(w.oneYear)) return false;
    }
    return true;
  })(),
);

// ── banned words ─────────────────────────────────────────────────────────────
// Jake: the word "caveat" must never reach the script. The plural was escaping
// the check entirely, because \b after "caveat" fails against the trailing "s".

check("singular caveat is caught", findBannedWords("There is one caveat here.").length === 1);
check("PLURAL caveats is caught", findBannedWords("A few caveats before we start.").length === 1);
check("caveat is caught mid-sentence regardless of case", findBannedWords("Honest Caveats apply.").length === 1);
check("the other banned words still fire", findBannedWords("That is genuinely clever.").length === 2);
check("neat is banned too", findBannedWords("That is a neat trick.").length === 1);
check("a word merely starting with a banned one is safe", findBannedWords("He worked neatly and cleverly.").length === 0);
check("a word merely containing one is not flagged", findBannedWords("She caveated nothing; whichever works.").length === 0);

// ── the fixed closing ────────────────────────────────────────────────────────
// It now carries the socials and the bell, so the risk is the video asking twice.

check("the closing block is appended when the script has no sign-off",
  ensureCanonicalOutro("So that is the whole workflow.").endsWith(CANONICAL_OUTRO));
check("the model's own sign-off is replaced, not duplicated",
  (() => {
    const out = ensureCanonicalOutro("That is the workflow. Thanks for watching — catch you in the next one.");
    return out.endsWith(CANONICAL_OUTRO) && !out.includes("catch you in the next one");
  })());
check("a socials block the model wrote itself is cut, so it is not said twice",
  (() => {
    const out = ensureCanonicalOutro("That is the workflow. Oh and by the way, follow me on TikTok and Instagram, links below. See you!");
    return out.split("follow me on TikTok").length === 2;
  })());
check("the comment prompt before the sign-off survives",
  ensureCanonicalOutro("Which one would you build first? I read every one. Thanks for watching, see you next time.")
    .includes("I read every one."));
check("a 'see you' early in the body is not mistaken for the sign-off",
  (() => {
    const body = "See you in the dashboard, right there. " + "Then the workflow runs. ".repeat(60) + "That is it.";
    return ensureCanonicalOutro(body).includes("See you in the dashboard");
  })());

// ── video research ───────────────────────────────────────────────────────────
// The parsers are the risky part: a transcript that silently comes back empty
// costs the run its click paths, and the RapidAPI shapes cannot be exercised
// live until a key exists.

check("ISO duration with hours", parseIsoDuration("PT1H2M3S") === 3723);
check("ISO duration minutes and seconds", parseIsoDuration("PT15M13S") === 913);
check("ISO duration seconds only", parseIsoDuration("PT47S") === 47);
check("a Short is under the four-minute floor", parseIsoDuration("PT2M56S") < 240);
check("garbage duration is 0, not NaN", parseIsoDuration("banana") === 0);
check("stamp pads the seconds", stamp(61) === "1:01" && stamp(3599) === "59:59");

check(
  "transcript gets a timestamp about every 30s, not every line",
  (() => {
    const segs = Array.from({ length: 20 }, (_, i) => ({ start: i * 5, text: `line ${i}` }));
    const out = formatTranscript(segs);
    const stamps = out.match(/\[\d+:\d\d\]/g) ?? [];
    return stamps.length >= 3 && stamps.length <= 5 && out.includes("line 19");
  })(),
);
check("empty segments are dropped", !formatTranscript([{ start: 0, text: "  " }, { start: 1, text: "real" }]).includes("  ]"));

check(
  "subtitle tracks are found under .subtitles",
  pickSubtitleTracks({ subtitles: [{ languageCode: "en", url: "u" }] }).length === 1,
);
check(
  "subtitle tracks are found nested under .subtitles.subtitles",
  pickSubtitleTracks({ subtitles: { subtitles: [{ languageCode: "en", url: "u" }] } }).length === 1,
);
check("no tracks gives an empty list, never a throw", pickSubtitleTracks({ foo: 1 }).length === 0);

check(
  "json3 captions parse",
  (() => {
    const body = JSON.stringify({ events: [{ tStartMs: 1500, segs: [{ utf8: "click " }, { utf8: "Settings" }] }] });
    const segs = parseCaptionBody(body);
    return segs.length === 1 && segs[0].text === "click Settings" && segs[0].start === 1.5;
  })(),
);
check(
  "XML timedtext captions parse and decode entities",
  (() => {
    const segs = parseCaptionBody('<?xml version="1.0"?><transcript><text start="4.2" dur="2">Tools &amp; Settings</text></transcript>');
    return segs.length === 1 && segs[0].text === "Tools & Settings" && segs[0].start === 4.2;
  })(),
);
check(
  "VTT captions parse",
  (() => {
    const segs = parseCaptionBody("WEBVTT\n\n00:00:07.000 --> 00:00:09.000\nopen the Skills tab");
    return segs.length === 1 && segs[0].text === "open the Skills tab" && segs[0].start === 7;
  })(),
);
check("an unknown caption format gives [], not a throw", parseCaptionBody("just some text") .length === 0);
check("malformed json gives [], not a throw", parseCaptionBody("{not json") .length === 0);

// Relevance: order=viewCount returned videos that were popular NEAR the topic
// rather than about it ("Blotato" -> "Claude Design OS"), so relevance comes
// from YouTube and the view ranking is applied over on-topic results only.
check("a one-word topic must be named outright", mentionsTopic("Blotato Beginner Tutorial", "Blotato"));
check("a one-word topic missing entirely is rejected", !mentionsTopic("Claude Design OS Changes Everything", "Blotato"));
check("matching is case-insensitive", mentionsTopic("automate social media with BLOTATO", "Blotato"));
check("a two-word topic may drop one word", mentionsTopic("The Ultimate Beginner Guide to Claude AI", "Claude Code"));
check("a two-word topic missing both words is rejected", !mentionsTopic("I Built a Trading System", "Claude Code"));
check("filler words in the topic do not count against it", mentionsTopic("Notion tips", "How to use the Notion app"));

// Stage 0 writes coreTopic for the researcher, so it arrives as a sentence. The
// live "Claude Cowork (…) — what it is, how it works, setup, and core use cases"
// run searched on the whole thing, found nothing, and produced a script with no
// click paths. Only the NAME goes to YouTube.
const LIVE_BRIEF =
  "Claude Cowork (Anthropic's collaborative/agentic workspace feature) — what it is, how it works, setup, and core use cases";
check("the live brief reduces to the product name", searchTopic(LIVE_BRIEF) === "Claude Cowork");
check("the live brief no longer rejects a real tutorial title", mentionsTopic("Claude Cowork Tutorial for Beginners", searchTopic(LIVE_BRIEF)));
check("a parenthetical aside is dropped", searchTopic("Blotato (the social posting tool)") === "Blotato");
check("an explanatory tail after a colon is cut", searchTopic("AI repurposing: turn one video into ten") === "AI repurposing");
check("a hyphen tail is cut", searchTopic("n8n - the automation tool everyone uses") === "n8n");
check("a short topic passes through untouched", searchTopic("Claude Code") === "Claude Code");
check("a one-word topic passes through untouched", searchTopic("Blotato") === "Blotato");
check("a long unpunctuated brief is capped at six words", searchTopic("how to build an automated content system with ai agents today").split(" ").length === 6);
check("an empty topic yields an empty query", searchTopic("") === "");
check("trailing punctuation is trimmed", searchTopic("Notion AI,") === "Notion AI");

// ── Stage 1.6 search: several angles, then a real relevance judgement ────────
// The run that prompted this searched one broad phrase and came back with three
// videos about the same product doing something else.

function cand(over: Partial<Candidate> & { title: string }): Candidate {
  return {
    videoId: over.videoId ?? over.title.slice(0, 11),
    title: over.title,
    channel: over.channel ?? "Some Channel",
    publishedAt: over.publishedAt ?? "2026-08-01",
    views: over.views ?? 1000,
    seconds: over.seconds ?? 600,
    url: over.url ?? "https://youtu.be/x",
    haystack: over.haystack ?? over.title,
    foundBy: over.foundBy ?? "claude note taking",
  };
}

const QP = queriesPrompt("Claude as a note-taking app", "Projects and memory");
check("the query prompt carries the topic", QP.includes("Claude as a note-taking app"));
check("the query prompt carries the specific focus", QP.includes("Projects and memory"));
check("the query prompt forbids the word the search appends", /Do NOT include the words tutorial/.test(QP));
check("the query prompt asks for more than one angle", /different ANGLES/.test(QP));

check(
  "queries are read out of the model's JSON",
  JSON.stringify(parseQueries('{"queries":["claude note taking","claude as a notes app"]}', "Claude")) ===
    JSON.stringify(["claude note taking", "claude as a notes app"]),
);
check(
  "the appended word is stripped so it can never appear twice",
  parseQueries('{"queries":["claude note taking tutorial"]}', "Claude")[0] === "claude note taking",
);
check(
  "a preamble around the JSON does not break parsing",
  parseQueries('Sure!\n```json\n{"queries":["claude notes"]}\n```', "Claude")[0] === "claude notes",
);
check(
  "duplicate angles are collapsed",
  parseQueries('{"queries":["Claude Notes","claude notes","claude memory"]}', "Claude").length === 2,
);
check(
  "more angles than allowed are capped",
  parseQueries('{"queries":["a one","b two","c three","d four","e five"]}', "Claude").length === QUERY_COUNT,
);
check(
  "an unparseable answer falls back to the mechanical query",
  JSON.stringify(parseQueries("I could not help with that", "Claude Cowork")) === JSON.stringify(["Claude Cowork"]),
);
check(
  "an empty query list falls back rather than searching for nothing",
  parseQueries('{"queries":[]}', "Claude Cowork")[0] === "Claude Cowork",
);
check(
  "a sentence-length query is rejected as a query",
  parseQueries('{"queries":["how do i use claude to replace my note taking app in 2026"]}', "Blotato")[0] ===
    "Blotato",
);

const CANDS = [
  cand({ title: "Claude for Note-Taking: My Full Setup", views: 5000, videoId: "aaaaaaaaaaa" }),
  cand({ title: "FULL Claude Code Tutorial For Beginners", views: 117452, videoId: "bbbbbbbbbbb" }),
  cand({ title: "I Replaced Notion With Claude Projects", views: 900, videoId: "ccccccccccc" }),
];
const CB = candidateBlock(CANDS);
check("candidates are numbered from one", CB.startsWith("[1] Claude for Note-Taking"));
check("every candidate reaches the selector", CB.includes("[2]") && CB.includes("[3]"));
check("view counts are readable in the list", CB.includes("117,452 views"));
check(
  "a long description is cut before it fills the window",
  candidateBlock([cand({ title: "T", haystack: "T " + "x".repeat(900) })]).length < 400,
);

const SP = selectionPrompt("Claude as a note-taking app", CANDS, 4, "Projects and memory");
check("the selection prompt carries the topic", SP.includes("Claude as a note-taking app"));
check("the selection prompt lists the candidates", SP.includes("[3] I Replaced Notion"));
check("the selection prompt allows an honest short answer", /Returning fewer than 4 is correct/.test(SP));
check("the selection prompt ranks relevance over popularity", /They do not outrank relevance/.test(SP));

const PICK = '{"picks":[{"n":3,"why":"replaces a notes app"},{"n":1,"why":"direct setup"}]}';
check(
  "picks come back in the model's own order, not the list's",
  JSON.stringify(parseSelection(PICK, CANDS, 4).map((c) => c.videoId)) ===
    JSON.stringify(["ccccccccccc", "aaaaaaaaaaa"]),
);
check("an out-of-range pick is ignored", parseSelection('{"picks":[{"n":9}]}', CANDS, 4).length === 0);
check("a repeated pick is counted once", parseSelection('{"picks":[{"n":1},{"n":1}]}', CANDS, 4).length === 1);
check(
  "more picks than asked for are trimmed",
  parseSelection('{"picks":[{"n":1},{"n":2},{"n":3}]}', CANDS, 2).length === 2,
);
check("an unparseable selection selects nothing, so the caller falls back", parseSelection("no", CANDS, 4).length === 0);

// The fallback ranking still has to work: it is what runs when there is no model
// client, when the call fails, and when the answer cannot be read.
const RANKED = mechanicalRank(
  [
    cand({ title: "Claude Note Taking Deep Dive", views: 100, foundBy: "claude note taking" }),
    cand({
      title: "My Productivity Stack 2026",
      haystack: "My Productivity Stack 2026 — includes claude note taking",
      views: 90000,
      foundBy: "claude note taking",
    }),
  ],
  4,
);
check("a title match outranks a much bigger description match", RANKED[0].title === "Claude Note Taking Deep Dive");
check("a description match still fills a spare slot", RANKED.length === 2);
check(
  "relevance is judged against the query that found the video",
  mechanicalRank([cand({ title: "Kling AI Guide", foundBy: "claude note taking" })], 4).length === 0,
);

// ── The audience gate ────────────────────────────────────────────────────────
// Jake's audience is solopreneurs and small business owners who need guidance
// "without tech jargon" (stage2-outline's AUDIENCE PROFILE). The most-watched
// tutorial for an AI topic is very often aimed at developers, and a real run
// inherited a CLI install, a Git URL and a trusted workspace into a note-taking
// script because of it.

check("a note-taking topic does not ask for a developer workflow", !wantsDeveloperWorkflow("Claude as a note-taking app"));
check("a developer tool as the topic lifts the gate", wantsDeveloperWorkflow("Claude Code for beginners"));
check("the terminal named in the topic lifts the gate", wantsDeveloperWorkflow("running Claude from the terminal"));
check("asking for it in the BRIEF lifts the gate", wantsDeveloperWorkflow("Claude for notes", undefined, "show the CLI setup too"));
check("the focus can lift it as well", wantsDeveloperWorkflow("Claude for notes", "connecting the API", undefined));
check("an absent topic and brief do not lift it", !wantsDeveloperWorkflow(undefined, undefined, null));
check("a near-miss word does not lift it", !wantsDeveloperWorkflow("Claude for apiary businesses"));

check("the gate names the audience it protects", /solopreneurs and small business owners/.test(audienceRule(false)));
check("the gate names the developer paths it rejects", /command-line|Git URL|IDE/.test(audienceRule(false)));
check("the gate allows a developer video when nothing else covers the topic", /Only prefer a developer walkthrough when nothing else/.test(audienceRule(false)));
check("an asked-for developer workflow removes the rule entirely", audienceRule(true) === "");

check(
  "the gate reaches the search queries",
  queriesPrompt("Claude for notes", undefined, false).includes("AUDIENCE GATE"),
);
check(
  "a developer topic searches without the gate",
  !queriesPrompt("Claude Code", undefined, true).includes("AUDIENCE GATE"),
);
check(
  "the gate reaches the selection pass",
  selectionPrompt("Claude for notes", CANDS, 4, undefined, false).includes("AUDIENCE GATE"),
);
check(
  "a developer topic selects without the gate",
  !selectionPrompt("Claude Code", CANDS, 4, undefined, true).includes("AUDIENCE GATE"),
);

// ── Acting on the claim audit ────────────────────────────────────────────────
// The audit ran last and only printed. A script shipped opening on "most people
// use maybe 10% of what Claude can do — the other 90% is where the real magic
// lives": an invented statistic, flagged correctly, as the FIRST LINE.

const CHANNELS = ["Nate Herk | AI Automation", "ICOR with Tom", "Kevin Stratvert"];
const NATE_LINE = "That's the version Nate actually runs day to day. He stopped at the wiki level.";

check("a presenter named in the script is caught", findSourceNames(NATE_LINE, CHANNELS).includes("Nate"));
check("the channel's descriptor half is not a name", !findSourceNames("This is real automation for your ai business", CHANNELS).length);
check("a surname is caught too", findSourceNames("as Stratvert showed", CHANNELS).includes("Stratvert"));
check("a presenter who is never named is not invented", findSourceNames("A clean second brain in Claude.", CHANNELS).length === 0);
check(
  "a channel word that is part of the subject is protected",
  findSourceNames("Claude keeps your notes", ["Claude Tips"], "Claude as a note-taking app").length === 0,
);
check("matching is case-insensitive but anchored to whole words", findSourceNames("Renate wrote it", CHANNELS).length === 0);

const AUDIT = {
  unsupportedNumbers: ["90"],
  fencedTopicsMentioned: ["semantic search"],
  experienceClaims: ["I tested it for 30 days"],
  excessSponsorPlugs: ["third plug"],
  bannedWords: ['clipped question "Honestly?"'],
  slopPhrases: ['"let that sink in" — …Forty thousand. Let that sink in.…'],
  sourceNames: ["Nate"],
  numbersChecked: 12,
};
const FIXES = claimFixList(AUDIT);
check("an unsupported number becomes a fix instruction", FIXES.some((f) => f.includes("90")));
check("the fix forbids swapping in another number", FIXES.some((f) => /Do not substitute a different number/.test(f)));
check("a banned word becomes a fix instruction", FIXES.some((f) => f.includes("Honestly?")));
check("AI-register phrasing becomes a fix instruction", FIXES.some((f) => /AI-register phrasing/.test(f) && f.includes("let that sink in")));
check("the slop fix forbids a synonym swap", FIXES.some((f) => /cut the phrase rather than swapping/.test(f)));
check("an unbacked experience claim becomes a fix instruction", FIXES.some((f) => f.includes("30 days")));
check("a source name becomes a fix instruction", FIXES.some((f) => f.includes("Nate")));
check(
  "a fenced topic is reported but NOT auto-edited — it may be a deliberate rebuttal",
  !FIXES.some((f) => f.includes("semantic search")),
);
check(
  "an extra sponsor plug is reported but NOT auto-edited",
  !FIXES.some((f) => f.includes("third plug")),
);
check("a clean audit produces no pass at all", claimFixList({ ...AUDIT, unsupportedNumbers: [], bannedWords: [], slopPhrases: [], experienceClaims: [], sourceNames: [] }).length === 0);

const CFP = claimFixPrompt("Some script text here.", ["Fix the 90."]);
check("the fix prompt carries the script", CFP.includes("Some script text here."));
check("the fix prompt numbers the findings", CFP.includes("1. Fix the 90."));
check("the fix prompt demands verbatim anchors", /must appear in the script EXACTLY/.test(CFP));
check("the fix prompt asks for edits, never a script", /"edits"/.test(CFP) && !/revisedScript/.test(CFP));

// The applier is Stage 6.5's, so the fix pass inherits its guards.
const APPLIED = applyBriefEdits(
  "The other 90% is where the real magic lives.",
  [{ mode: "replace", find: "The other 90% is", text: "The rest of it is", reason: "invented statistic" }],
  "claim audit",
);
check("an edit lands", APPLIED.script === "The rest of it is where the real magic lives.");
check("the applied note carries its reason", APPLIED.applied.some((a) => /invented statistic/.test(a)));
check(
  "an anchor that is not in the script is skipped, not forced",
  applyBriefEdits("abc", [{ mode: "replace", find: "not here", text: "x" }], "claim audit").skipped.length === 1,
);

// ── Open loops ───────────────────────────────────────────────────────────────
// Decided at outline time (the first artefact that knows what the video
// delivers), opened by the hooks, closed by the section that owns each one.

const SECTIONS = ["Capture", "Organize", "Summarize", "Retrieve", "The verdict"];
const LOOP_JSON = '{"loops":[{"question":"Which one of these actually replaces Notion?","payoff":"The retrieval setup, in section 4","closesInSection":4},{"question":"What does this cost once you rely on it?","payoff":"The pricing verdict","closesInSection":5}]}';

const LOOPS = parseOpenLoops(LOOP_JSON, SECTIONS.length);
check("loops are read out of the JSON", LOOPS.length === 2);
check("a loop keeps the section that owes it", LOOPS[0].closesInSection === 4);
check(
  "the real prompts from a live script are all collected now",
  ["Clean it up into a dated journal entry and save it as a new note in this folder.",
   "Check my emails and draft replies for anything that needs a human response today.",
   "Go through every note in this folder and group them into topics for me.",
   "Read this note and put a five-bullet summary at the very top under a heading."]
    .every((t) => extractPrompts(`Type this: "${t}"`).length === 1),
);
check(
  "a loop pointing past the last section is dropped — it could never be closed",
  parseOpenLoops('{"loops":[{"question":"q","payoff":"p","closesInSection":9}]}', SECTIONS.length).length === 0,
);
check(
  "a loop with no payoff is dropped — that is a promise the video never keeps",
  parseOpenLoops('{"loops":[{"question":"q","payoff":"","closesInSection":2}]}', SECTIONS.length).length === 0,
);
check("duplicate loops collapse", parseOpenLoops('{"loops":[{"question":"Q","payoff":"p","closesInSection":1},{"question":"q","payoff":"p2","closesInSection":2}]}', SECTIONS.length).length === 1);
check("never more than three", parseOpenLoops('{"loops":[' + [1,2,3,4,5].map((n)=>`{"question":"q${n}","payoff":"p","closesInSection":2}`).join(",") + ']}', SECTIONS.length).length === 3);
check("an unparseable answer plants no loops rather than throwing", parseOpenLoops("sorry", SECTIONS.length).length === 0);

const OLP = openLoopsPrompt("7 Ways Claude Replaces Your Notes", "…outline…", SECTIONS);
check("the loop prompt lists the sections it may point at", OLP.includes("4. Retrieve"));
check("the loop prompt refuses a promise the outline cannot keep", /it is not a loop, it is a lie/.test(OLP));
check("the loop prompt spreads them off the final section", /Do not close every loop in the final section/.test(OLP));

const BLOCK = openLoopsBlock(LOOPS, SECTIONS);
check("the block names the section that closes each loop", BLOCK.includes("closed in section 4 (Retrieve)"));
check("the block forbids answering a loop early", /Never answer a loop before the section that owns it/.test(BLOCK));
check("no loops means no block at all", openLoopsBlock([], SECTIONS) === "");

check("the owning section is told to close its loop", loopCloseBlock(LOOPS, 3).includes("THIS SECTION CLOSES AN OPEN LOOP"));
check("the owning section is identified by index, not by order asked", loopCloseBlock(LOOPS, 3).includes("Which one of these actually replaces Notion?"));
check("a section that owns nothing gets nothing", loopCloseBlock(LOOPS, 0) === "");
check("the second loop lands in its own section", loopCloseBlock(LOOPS, 4).includes("What does this cost"));

check(
  "a section that pays the loop off counts as closed",
  loopClosed("So which one actually replaces Notion? This retrieval setup does, and here is the section where it happens.", LOOPS[0]),
);
check(
  "a section that never touches it is not closed",
  !loopClosed("Here is how to summarize a long call transcript quickly.", LOOPS[0]),
);
check(
  "a mention too thin to be a payoff does not count",
  !loopClosed("Notion is fine.", LOOPS[0]),
);

// ── Hook ranking ─────────────────────────────────────────────────────────────
// Stage 3 writes four hooks and says which traffic each is FOR; nothing said
// which is better. Virality is judged; search value is measured, because a model
// asked to score SEO produces a confident number from nothing.

const HOOKS_BLOCK = [
  "## HOOKS — pick one",
  "",
  "### FORMULA A-LONG — 5-Beat Confession Reframe (90–110s)",
  "I ditched my note-taking app for Claude and here is what broke.",
  "",
  "### FORMULA A-COMPRESSED — Show-Tell-Promise (45–60s)",
  "Claude replaces your note app. Watch this note get sorted in four seconds.",
  "",
  "### FORMULA B — Compressed Numbered Reveal (45–60s)",
  "Seven ways to run your notes through Claude, starting with the messy one.",
  "",
].join("\n");

const SPLIT = splitHooks(HOOKS_BLOCK);
check("every hook in the block is found", SPLIT.length === 3);
check("the formula label is kept for the ranking row", SPLIT[0].label.startsWith("FORMULA A-LONG"));
check("the hook's own text is captured", SPLIT[1].text.includes("four seconds"));
check("the block's heading is not mistaken for a hook", !SPLIT.some((h) => /HOOKS — pick one/.test(h.label)));
check("an empty hooks block yields nothing rather than throwing", splitHooks("").length === 0);

const KW = seoKeywords("7 Ways Claude Replaces Your Note-Taking App", "Using Claude as a replacement for Notion and Obsidian");
check("keywords come from the title and topic", KW.includes("claude") && KW.includes("notion"));
check("filler is not a keyword", !KW.includes("ways") && !KW.includes("your") && !KW.includes("using"));

const EARLY = seoScore("Claude replaces Notion for your notes today.", KW);
const LATE = seoScore(("filler ".repeat(45)) + " claude notion notes", KW);
check("keywords in the opening score higher than the same words buried", EARLY > LATE);
check("a hook carrying none of the search language scores zero", seoScore("Here is a thing I tried.", KW) === 0);
check("no keywords at all cannot divide by zero", seoScore("anything", []) === 0);
check("the score is capped at 100", seoScore("claude notion obsidian replacement notes note-taking claude notion", KW) <= 100);

const HRP = hookRankPrompt("7 Ways Claude Replaces Your Notes", SPLIT, LOOPS);
check("the rank prompt shows every hook", HRP.includes("HOOK 3"));
check("the rank prompt carries the loops the hook should plant", HRP.includes("Which one of these actually replaces Notion?"));
check("the rank prompt penalises the generic opener", /most people only use 10%/.test(HRP));
check("the rank prompt refuses to judge SEO", /Do NOT score search value/.test(HRP));

const HOOK_RANKED = parseHookRanking('{"scores":[{"hook":1,"virality":40,"why":"a","bestFor":"browse"},{"hook":2,"virality":85,"why":"b","bestFor":"search"},{"hook":3,"virality":85,"why":"c","bestFor":"mobile"}]}', SPLIT, KW);
check("every hook gets a row", HOOK_RANKED.length === 3);
check("the most watchable hook leads", HOOK_RANKED[0].virality === 85);
check("search value breaks a virality tie", HOOK_RANKED[0].seo >= HOOK_RANKED[1].seo);
check("the row keeps its original hook number", HOOK_RANKED.every((r) => [1, 2, 3].includes(r.hook)));
check(
  "a hook the model skipped still gets a row rather than vanishing",
  parseHookRanking('{"scores":[{"hook":1,"virality":50}]}', SPLIT, KW).length === 3,
);
check(
  "an unparseable ranking still returns the measured search scores",
  parseHookRanking("no", SPLIT, KW).every((r) => r.virality === 0 && typeof r.seo === "number"),
);
check("an out-of-range score is clamped", parseHookRanking('{"scores":[{"hook":1,"virality":9000}]}', SPLIT, KW)[0].virality === 100);

// ── The fifth hook, with no template ─────────────────────────────────────────
// The four formulas are proven shapes, which also makes them the shapes every
// other channel uses. This one is freed from them and ranked against them.

const WITH_FREE = HOOKS_BLOCK + "\n" + OPEN_HOOK_HEADING + "\n\nYou already know your notes are a mess. Here is the version that fixed mine.\n";
const SPLIT5 = splitHooks(WITH_FREE);
check("the free hook is found alongside the formula hooks", SPLIT5.length === 4);
check("the free hook keeps its own label", SPLIT5[3].label.startsWith("OPEN HOOK"));
check("the free hook's text is captured", SPLIT5[3].text.includes("fixed mine"));
check("the free hook is ranked with the rest", parseHookRanking('{"scores":[]}', SPLIT5, KW).length === 4);

const OHP = openHookPrompt("7 Ways Claude Replaces Your Notes", "Claude for notes", "…outline…", LOOPS, KW);
check("the free hook prompt refuses every template", /No template, no formula, no beat structure/.test(OHP));
check("the free hook prompt carries the search language", /SEARCH LANGUAGE/.test(OHP) && OHP.includes("claude"));
check("the free hook prompt warns against keyword stuffing", /A hook that lists keywords is worse/.test(OHP));
check("the free hook prompt plants the loops", OHP.includes("Which one of these actually replaces Notion?"));
check("the free hook prompt bans the generic opener", /no generic percentage opener/.test(OHP));
check("the free hook prompt demands it be unreusable", /would work on any other video about this topic/.test(OHP));
check("the free hook prompt asks for the hook alone", /Write only the hook/.test(OHP));
// The first free hook shipped with no subscribe ask: Stage 5.5 attaches it to the
// welcome/identity beat and is told to skip any hook that has not got one.
check("the free hook must carry a welcome/identity beat", /WELCOME\/IDENTITY BEAT/.test(OHP));
check("and it is told why that beat is not optional", /ships with no subscribe ask at all/.test(OHP));

// ── The broad query is never left to chance ──────────────────────────────────
// Same topic, two runs: "claude second brain notes" found tutorials at 359k and
// 234k views; "claude personal knowledge base" found a 6.6k construction
// walkthrough. The selector can only pick from what the searches return.

check(
  "the model's angles are still capped at QUERY_COUNT",
  parseQueries('{"queries":["a one","b two","c three","d four"]}', "Claude").length === QUERY_COUNT,
);
check(
  "the broad query is not duplicated when the model already asked for it",
  parseQueries('{"queries":["Claude Cowork","claude cowork setup"]}', "Claude Cowork").filter(
    (q) => q.toLowerCase() === "claude cowork",
  ).length === 1,
);

// ── Research stays on the focus ──────────────────────────────────────────────
// A run drew "How to Build a Construction Project Knowledge Base (Drawings,
// Contracts & Specs)" for a solopreneur's note-taking video: the words matched,
// the audience did not, and nothing said why until the script was read.

const FOCUSED = selectionPrompt("Claude for notes", CANDS, 4, "capturing and organizing meeting notes", false);
check("the focus is a selection rule, not just context", /It covers something in the SPECIFIC FOCUS above/.test(FOCUSED));
check("a different industry is called out as the wrong video", /construction firm's document system/.test(FOCUSED));
check("a thin on-focus set is preferred to a padded one", /A thin set of genuinely on-focus videos beats a full set/.test(FOCUSED));
check("each pick must name the focus it covers", /`covers` must name the part of the SPECIFIC FOCUS/.test(FOCUSED));
check("the JSON shape asks for covers when there is a focus", FOCUSED.includes('"covers"'));
check(
  "with no focus the prompt does not invent one",
  !selectionPrompt("Claude for notes", CANDS, 4, undefined, false).includes("SPECIFIC FOCUS"),
);

check(
  "the selector's reasoning is recoverable for the log",
  JSON.stringify(pickReasons('{"picks":[{"n":2,"covers":"meeting notes","why":"real walkthrough"}]}')) ===
    JSON.stringify(["#2 covers: meeting notes — real walkthrough"]),
);
check("a pick with no reasoning still reports its number", pickReasons('{"picks":[{"n":1}]}')[0] === "#1");
check("unparseable reasoning is not an error", pickReasons("nope").length === 0);

// ── What one hand-edit taught ────────────────────────────────────────────────
// Jake edited a finished script. The body survived almost untouched; every
// change clustered in the hook and the first 300 words, and each was a habit.

// A UI label read aloud is not a prompt anyone would copy.
check(
  "a settings toggle read aloud is not collected as a prompt",
  extractPrompts('flip on "generate memory from chat history."').length === 0,
);
check(
  "a real prompt still is",
  extractPrompts(
    'Type this: "Clean it up into a dated journal entry and save it as a new note in this folder."',
  ).length === 1,
);
check(
  "a connective is not used as the prompt's label",
  extractPrompts('you can do this: "Summarize the article I just saved into three real takeaways today."')[0]
    ?.label === "Prompt 1",
);
check(
  "a descriptive lead-in still becomes the label",
  extractPrompts(
    'Here is the morning brief prompt: "Check my emails and draft replies for anything that needs a human response."',
  )[0]?.label.includes("morning brief"),
);

// A loop closed in section 1 was cut by hand; sections 2 and 3 were kept.
check(
  "a loop cannot close in section 1 — the payoff is too close to the promise",
  parseOpenLoops('{"loops":[{"question":"q","payoff":"p","closesInSection":1}]}', SECTIONS.length).length === 0,
);
check(
  "section 2 is the earliest a loop may close",
  parseOpenLoops('{"loops":[{"question":"q","payoff":"p","closesInSection":2}]}', SECTIONS.length).length === 1,
);
check("and the prompt says so", /Nothing closes in section 1/.test(openLoopsPrompt("t", "o", SECTIONS)));

// The hook that planted three loops was cut back to one by hand.
const THREE = [
  { question: "Q one?", payoff: "p", closesInSection: 2 },
  { question: "Q two?", payoff: "p", closesInSection: 3 },
  { question: "Q three?", payoff: "p", closesInSection: 4 },
];
const OHP3 = openHookPrompt("T", "topic", "outline", THREE, KW);
check("the hook is asked to plant at most two loops", /AT MOST TWO/.test(OHP3));
check("and is only shown two of them", OHP3.includes("Q one?") && OHP3.includes("Q two?") && !OHP3.includes("Q three?"));
check("the hook may not describe what is on screen", /Never describe what is on screen/.test(OHP3));

check("\"folks\" is caught", findBannedWords("Alright folks, let's get into it.").length === 1);
check("the report says which word it was", /"folks"/.test(findBannedWords("Hey folks.")[0] ?? ""));
check("a word that merely contains it is not caught", findBannedWords("The folkses sang.").length === 0);
check(
  "\"keep coming back to\" is caught",
  findBannedWords("That's the bit I keep coming back to.").length === 1,
);
check("its tense variants are caught too", findBannedWords("The one he kept coming back to.").length === 1);
check(
  "a plain \"coming back to\" is left alone",
  findBannedWords("We're coming back to that in a minute.").length === 0,
);

// ── Demo density: is this a script read over a screen, or an essay? ──

const SHOWS = "And look at that box. That's the same bottle.";
const ESSAY = "The tool reaches into the page and builds a marketing clip for you.";

check("an on-screen moment is counted", demoDensity(SHOWS).demoAnchors === 1);
check("a paragraph that shows nothing counts none", demoDensity(ESSAY).demoAnchors === 0);
check(
  "instruction verbs alone are NOT anchors — the gap is always in showing the result",
  demoDensity("Click the folder drop-down. Then type your name and paste the URL.").demoAnchors === 0,
);
check(
  "a prompt read out loud is not silence — its interior is on screen to copy",
  demoDensity('He types this. "Turn this messy transcript into a dated note with five sections and nothing else."').demoAnchors === 0,
);
check(
  "a [VERIFY ON SCREEN] production note is not a spoken anchor",
  demoDensity("Open the panel. [VERIFY ON SCREEN: the exact label of the control]").demoAnchors === 0,
);
check("scriptQuality carries the demo numbers", scriptQuality(SHOWS).demoAnchors === 1);

check("a section that shows something passes", checkSectionDemo(SHOWS, "The bake-off").ok);
const LECTURE = Array.from({ length: 30 }, () => ESSAY).join("\n\n");
check("a demo section that never points at the screen fails", !checkSectionDemo(LECTURE, "The bake-off").ok);
check(
  "a trust beat is allowed to show nothing — that is what it is for",
  checkSectionDemo(LECTURE, "What it costs").ok,
);
check(
  "canned approval is caught even when the section shows something",
  checkSectionDemo(`${SHOWS} That's a huge win.`, "x").genericApproval.length === 1,
);
check(
  "a trust beat still may not close on canned approval",
  !checkSectionDemo(`${SHOWS} That's a huge win.`, "What it costs").ok,
);
check(
  "a canned-approval section does not pass",
  !checkSectionDemo(`${SHOWS} That's a huge win.`, "x").ok,
);
check("pricing is a trust beat — no joke quota", checkSectionDemo(SHOWS, "What it costs").trustBeat);
check("a demo section is not a trust beat", !checkSectionDemo(SHOWS, "The bake-off").trustBeat);

// ── ON SCREEN lines are cast at outline time ──

const OUTLINE_OK = `## The bake-off
ON SCREEN: three clips play side by side, visibly different light in each
Body text long enough to survive the outline parser's minimum-length filter, which drops near-empty headers.`;
const OUTLINE_BARE = `## The bake-off
Body text long enough to survive the outline parser's minimum-length filter, which drops near-empty headers.`;

check("a section with an on-screen line is not flagged", outlineSectionsMissingOnScreen(OUTLINE_OK).length === 0);
check("a section without one is flagged", outlineSectionsMissingOnScreen(OUTLINE_BARE).length === 1);
check(
  "the repair splices the line under the right header",
  outlineSectionsMissingOnScreen(
    insertOnScreenLines(OUTLINE_BARE, { "The bake-off": "three clips play side by side" }),
  ).length === 0,
);
check(
  "a section that already has one never gets a second",
  insertOnScreenLines(OUTLINE_OK, { "The bake-off": "something else" }).match(/ON SCREEN:/g)?.length === 1,
);
check(
  "a line for a section that doesn't exist is dropped, not appended",
  insertOnScreenLines(OUTLINE_BARE, { "No such section": "x" }) === OUTLINE_BARE,
);

// ── Jake's published lines must not come back in a new script ──

const EX = [
  "Now I'm logging in with Google, because life's too short for another password. And we're in.",
  "What used to be three hires is now three saved playbooks, and playbooks don't call in sick.",
  "Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI.",
];

check(
  "a joke lifted word for word is caught",
  exemplarEchoes("So you sign in. Now I'm logging in with Google, because life's too short for another password.", EX).length === 1,
);
check(
  "the same joke rewritten is not caught",
  exemplarEchoes("I'll sign in with Google here, because I'm not inventing another password today.", EX).length === 0,
);
check(
  "ordinary shared phrasing does not trip it",
  exemplarEchoes("So you can see what it does and then decide if you want it.", EX).length === 0,
);
check(
  "boilerplate that is MEANT to repeat is allowed",
  exemplarEchoes("Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI.", EX).length === 0,
);
check(
  "one lifted passage is reported once, not once per word",
  exemplarEchoes("What used to be three hires is now three saved playbooks, and playbooks don't call in sick.", EX).length === 1,
);
check("nothing to compare against finds nothing", exemplarEchoes("Any text at all here.", []).length === 0);

// ── AI-register phrasing (the human-speak borrow) ─────────────────────────────
//
// The whole point of this list is that it fires on the model and NEVER on Jake.
// Every entry was measured against his three exemplars plus two finished runs
// (16,516 words) and appeared zero times. These checks lock in the exclusions —
// the patterns that were deliberately NOT adopted because they are his voice.

check("catches a manufactured reveal", findSlopPhrases("And here's the kicker, it runs while you sleep.").length === 1);
check("catches reaction narration", findSlopPhrases("Forty thousand of them. Let that sink in.").length === 1);
check("catches essay filler in a spoken script", findSlopPhrases("It's worth noting that the free tier caps out.").length === 1);
check("catches inflation", findSlopPhrases("This is a total game-changer for solo founders.").length === 1);
check("catches unsourced consensus", findSlopPhrases("Experts agree this is where the market is going.").length === 1);
check("catches a recap ending", findSlopPhrases("In conclusion, that's the whole workflow.").length === 1);
check("matches inflected forms", findSlopPhrases("It utilizes the same index and streamlines the whole thing.").length === 2);
check(
  "curly apostrophes are normalised, not missed",
  findSlopPhrases("It\u2019s worth noting the price moved.").length === 1,
);
check("reports each hit with its context", /worth noting/.test(findSlopPhrases("It's worth noting the cap.")[0] ?? ""));
check("a clean sentence is clean", findSlopPhrases("I hit go, and it wrote the file.").length === 0);

// Exclusions — these MUST stay empty. Each one is a phrasing Jake actually uses
// more than the generator does; banning them would edit him out of his own show.
check("em dashes are not slop", findSlopPhrases("I opened it — and it just worked.").length === 0);
check(
  "just / actually / honestly / simply / literally are not slop",
  findSlopPhrases("Honestly, I just wanted it to actually work, and it literally simply did.").length === 0,
);
check("the canonical welcome closer is not slop", findSlopPhrases("I'm Jake Dawson, and let's dive right in.").length === 0);
check("\"unlock\" is not slop — it is in his own script", findSlopPhrases("That unlocks the whole workflow.").length === 0);
check("\"what if I told you\" is not slop — he wrote it", findSlopPhrases("What if I told you it was free?").length === 0);
check("\"in the world of\" is not slop — he wrote it", findSlopPhrases("In the world of AI video, that's rare.").length === 0);

check("the list is non-trivial and deduped", AI_SLOP_PHRASES.length >= 40 && new Set(AI_SLOP_PHRASES).size === AI_SLOP_PHRASES.length);
check(
  "every entry compiles as a regex",
  AI_SLOP_PHRASES.every((p) => {
    try { new RegExp(p); return true; } catch { return false; }
  }),
);

// ── Source provenance (scriptgen/sources.ts) ─────────────────────────────────
// The run that motivated all of this: 21 sources, 19 of them review sites, and
// the product's own pricing page never opened once. Every price in that script
// was therefore somebody's summary of a page rather than the page.

check("hostOf strips www and lowercases", hostOf("https://WWW.Predis.ai/pricing") === "predis.ai");
check("hostOf survives junk", hostOf("not a url") === "");

check("toolName keeps a bare product name", toolName("Predis.ai") === "Predis.ai");
check("toolName drops a parenthetical", toolName("Twin.so (browser agent)") === "Twin.so");
check("toolName cuts at a dash", toolName("Predis.ai — AI social media manager") === "Predis.ai");
check("toolName caps at three words", toolName("Claude Cowork Desktop Beta Edition") === "Claude Cowork Desktop");

check("a name that IS a domain is used as-is", vendorHosts("Predis.ai").join() === "predis.ai");
check("a two-letter TLD is a domain too", vendorHosts("Twin.so").join() === "twin.so");
check(
  "a bare name becomes candidate domains",
  vendorHosts("Notion").includes("notion.com") && vendorHosts("Notion").includes("notion.ai"),
);
check("no topic, no hosts", vendorHosts("").length === 0);

const PREDIS = vendorHosts("Predis.ai");
check("the vendor's own domain is first-party", classifySource("https://predis.ai/pricing", PREDIS) === "first-party");
check("a vendor subdomain is first-party", classifySource("https://help.predis.ai/en/article/x", PREDIS) === "first-party");
check(
  "a hosted changelog under the vendor's name is first-party",
  classifySource("https://predis.frill.co/announcements", PREDIS) === "first-party",
);
check(
  "somebody else's frill board is NOT first-party",
  classifySource("https://someoneelse.frill.co/announcements", PREDIS) !== "first-party",
);
check("a directory is an aggregator", classifySource("https://www.g2.com/products/x/reviews", PREDIS) === "aggregator");
check("capterra is an aggregator", classifySource("https://www.capterra.com/p/1/x/", PREDIS) === "aggregator");
check("reddit is community", classifySource("https://www.reddit.com/r/x/comments/y", PREDIS) === "community");
check("github is community", classifySource("https://github.com/ghffee/Predis", PREDIS) === "community");
// The long tail is NOT classified, on purpose: no list will ever enumerate
// maxaeo / aitoolbeat / coldiq / oreateai, and guessing would be worse than
// counting them honestly as unknown.
check("an SEO blog is counted as other, never guessed at", classifySource("https://maxaeo.ai/ai-tools/tool/predis-ai/", PREDIS) === "other");

// The real source list from run 4jeWHiyyuByZK3lNuauqE, in the order it was read.
const REAL_RUN = [
  "https://www.getapp.com/x", "https://www.capterra.com/x", "https://socialrails.com/x",
  "https://www.shuttergen.com/x", "https://aiproductivity.ai/x", "https://aiproductivity.ai/y",
  "https://fluxnote.io/x", "https://www.g2.com/x", "https://www.gethookd.ai/x",
  "https://help.predis.ai/en/article/all-about-pricing", "https://discovermybusiness.co/x",
  "https://github.com/ghffee/Predis", "https://predis.frill.co/announcements", "https://www.g2.com/y",
  "https://techbriefly.com/x", "https://coldiq.com/x", "https://www.aisystemscommerce.com/x",
  "https://aitoolbeat.com/x", "https://maxaeo.ai/x", "https://help.predis.ai/en/article/pricing-plans",
  "https://www.oreateai.com/x",
].map((url) => ({ url, title: url }));

const realAudit = auditSources(REAL_RUN, PREDIS);
check("the real run's 21 sources are all counted", realAudit.total === 21);
check("its three vendor pages are found", realAudit.firstParty === 3);
check("both vendor hosts are named", realAudit.firstPartyHosts.includes("help.predis.ai") && realAudit.firstPartyHosts.includes("predis.frill.co"));
check("its four directory pages are found (GetApp, Capterra, G2 twice)", realAudit.aggregator === 4);
check("its one github page is community", realAudit.community === 1);
check("the real run is NOT flagged — it did open vendor pages, stale ones", realAudit.noFirstParty === false);

// The flag fires on the case it is for: a whole run of third-party writing.
const noVendor = auditSources(
  ["https://maxaeo.ai/x", "https://www.g2.com/y", "https://coldiq.com/z"].map((url) => ({ url, title: url })),
  PREDIS,
);
check("a run with no vendor page is flagged", noVendor.noFirstParty === true);
check("...and says which domains it looked for", noVendor.vendorHosts.includes("predis.ai"));

// A topic with no vendor must never be flagged — "how to price a course" has no
// pricing page to miss, and crying wolf there makes the warning worthless.
const noTopic = auditSources([{ url: "https://example.com/x", title: "x" }], []);
check("a topic with no vendor is never flagged", noTopic.noFirstParty === false);
check("an empty source list counts to zero", auditSources([], PREDIS).total === 0);

const fpb = firstPartyBlock("Predis.ai", PREDIS);
check("the first-party block names the real domain", fpb.includes("site:predis.ai pricing"));
check("...and demands the changelog", /changelog/.test(fpb));
check("...and says a review-site price is hearsay", /hearsay/.test(fpb));
check("no vendor hosts means no block at all", firstPartyBlock("how to price a course", []) === "");

console.log("");
if (fail.length) {
  console.log(`${passed} passed, ${fail.length} FAILED:`);
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
