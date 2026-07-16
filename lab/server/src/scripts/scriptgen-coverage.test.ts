/**
 * Unit tests for the pure helpers behind the brief-coverage pass and the
 * step-scaffold markers. Run against the COMPILED dist (see clipmagic-lab-testing):
 *
 *   docker run --rm -v "$PWD/scriptgen-coverage.test.ts":/t.ts <image> \
 *     node --experimental-strip-types /t.ts
 */
import {
  parseCoveragePass,
  parseOutlineSections,
  allocateSectionWords,
  toCleanProse,
  stripVerifyMarkers,
  MIN_SECTION_WORDS,
} from "../scriptgen/edits.js";

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
  "an outline that over-allocates in absolute terms is scaled to fit",
  (() => {
    const big = allocateSectionWords([{ targetWords: 5000 }, { targetWords: 5000 }], 1800);
    const sum = big.reduce((a, b) => a + b, 0);
    return sum < 1800; // scaled down, not taken literally
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

console.log("");
if (fail.length) {
  console.log(`${passed} passed, ${fail.length} FAILED:`);
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
