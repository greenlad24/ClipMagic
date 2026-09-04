/**
 * Unit tests for the pure helpers behind the brief-coverage pass and the
 * step-scaffold markers. Run against the COMPILED dist (see clipmagic-lab-testing):
 *
 *   docker run --rm -v "$PWD/scriptgen-coverage.test.ts":/t.ts <image> \
 *     node --experimental-strip-types /t.ts
 */
import {
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
} from "../scriptgen/edits.js";
import { claimFixList, claimFixPrompt } from "../scriptgen/run.js";
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
  sourceNames: ["Nate"],
  numbersChecked: 12,
};
const FIXES = claimFixList(AUDIT);
check("an unsupported number becomes a fix instruction", FIXES.some((f) => f.includes("90")));
check("the fix forbids swapping in another number", FIXES.some((f) => /Do not substitute a different number/.test(f)));
check("a banned word becomes a fix instruction", FIXES.some((f) => f.includes("Honestly?")));
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
check("a clean audit produces no pass at all", claimFixList({ ...AUDIT, unsupportedNumbers: [], bannedWords: [], experienceClaims: [], sourceNames: [] }).length === 0);

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

console.log("");
if (fail.length) {
  console.log(`${passed} passed, ${fail.length} FAILED:`);
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
