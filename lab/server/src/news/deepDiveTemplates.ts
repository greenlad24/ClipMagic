/**
 * DEEP DIVE TEMPLATES — each one is its OWN STORYLINE (Jake 2026-10-12: "each template should have a different
 * storyline structure — I feel like they are all the same storyline with a different color. Each template should be
 * completely unique in all aspects. Animations, storyline — but in the same animation family and look/design
 * family." → "you have a go for the template plan").
 *
 * The design (colours, type) and the motion set live on the web (src/news/deepdive/templates.ts + motion.css, keyed
 * by the same id). HERE: the storyline the outline and the script follow — ordered steps, the chapter kinds each
 * step suits in both formats (classic v1 / demo-first v2), the one-line arc the script's bridges follow, and the
 * storyline's own rules. "jake" is the original payoff-first structure, verbatim (the callers pass it in), and a
 * dive without a template keeps it — nothing already made changes.
 */
export type DiveFormat = "v1" | "v2";

interface Step {
  role: string;
  what: string;
  v1: string[];
  v2: string[];
}

export interface Storyline {
  id: string;
  name: string;
  /** what the picker shows next to the design ("Countdown: #5 → #1") */
  label: string;
  /** the arc in one line — the script's bridges follow it */
  arc: string;
  steps: Step[];
  rules: string[];
  /** the original structure (deepDive.ts STRUCTURE / deepDiveV2.ts STRUCTURE_V2), kept verbatim */
  legacy?: boolean;
  /** v1: the company video is forced into section 2 (the payoff) */
  payoffSecond?: boolean;
}

const S = (role: string, what: string, v1: string[], v2: string[]): Step => ({ role, what, v1, v2 });

export const STORYLINES: Storyline[] = [
  {
    id: "jake", name: "Payoff First", label: "Payoff first: see it work → why → how → the catch",
    arc: "show it working first, then why you should care, then how to use it, then the catch and what's next",
    steps: [], rules: [], legacy: true, payoffSecond: true,
  },
  {
    id: "aurora", name: "The Mystery", label: "Mystery: an unexplained result → clues → the reveal",
    arc: "open on a result nobody can explain yet, hand the viewer one clue per chapter, and only reveal how it really works at the end",
    steps: [
      S("THE HOOK", "the unexplained result — WHAT happened, never how. The heading is the puzzle.", ["title"], ["title"]),
      S("THE PUZZLE", "show the surprising thing actually working, framed as a question: how is this even possible?", ["media", "statement"], ["clip", "demo"]),
      S("CLUE 1", "the first piece of the answer (who made it, what it is built on, what it can do) — end on the next open question", ["stats", "quote", "bullets"], ["article", "reveal", "stats"]),
      S("CLUE 2", "the second piece — closer to the answer, still one question left", ["compare", "bars", "statement"], ["flow", "versus", "stats"]),
      S("CLUE 3", "the last piece — the detail that makes it click for the viewer", ["timeline", "quote", "bullets"], ["demo", "timeline", "quote"]),
      S("THE TWIST", "the catch nobody expected: a limit, a price, a surprising condition", ["statement", "stats"], ["reveal", "list"]),
      S("THE REVEAL", "the answer in one plain sentence — everything the clues pointed at, put together", ["statement", "compare"], ["versus", "reveal"]),
      S("WHAT IT MEANS FOR YOU", "the takeaways", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "Never give away the answer before THE REVEAL. Every chapter before it ends on a question the next one answers.",
      "Eyebrows count the clues: \"Clue 1\", \"Clue 2\", \"Clue 3\", then \"The twist\", \"The reveal\".",
    ],
  },
  {
    id: "editorial", name: "The Feature Story", label: "Feature story: a real moment → the big idea → the evidence → the other side",
    arc: "read like a magazine feature: open on one real moment, widen to the big idea, prove it, give the other side, and close on an image",
    steps: [
      S("THE HEADLINE", "the story's headline and a one-line dek", ["title"], ["title"]),
      S("THE SCENE", "one concrete moment from the research — a person, a team, a launch day, a demo — told like the first paragraph of a feature", ["quote", "statement", "media"], ["quote", "clip", "article"]),
      S("THE BIG IDEA", "zoom out: what this is and why it is happening now, in two plain sentences", ["statement", "bullets"], ["reveal", "list"]),
      S("THE EVIDENCE", "the proof — it shown working, the result, the figure that matters", ["media", "stats", "bars"], ["demo", "clip", "stats"]),
      S("THE VOICES", "what the people behind it and the people using it say", ["quote", "bullets"], ["quote", "article"]),
      S("THE OTHER SIDE", "the honest criticism, the limits, who is not convinced", ["compare", "statement"], ["versus", "list"]),
      S("WHAT'S NEXT", "where the story goes from here", ["timeline", "statement"], ["timeline", "flow"]),
      S("THE CLOSING IMAGE", "the takeaways, ending on one memorable line that calls back to THE SCENE", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "Eyebrows read like a magazine's section labels (\"The scene\", \"The evidence\", \"The other side\").",
      "The last line calls back to the opening scene.",
    ],
  },
  {
    id: "midnight", name: "The Countdown", label: "Countdown: #5 → #1",
    arc: "count down the most important things about it, from #5 to #1, each one bigger than the last, then the catch",
    steps: [
      S("THE PROMISE", "the hook: \"the N things that actually matter about this\" — say what #1 is about without giving it away", ["title"], ["title"]),
      S("#5 … #2", "one chapter per item, rising in importance — each item is ONE thing it does or changes, shown, not listed", ["stats", "media", "compare", "quote", "bars", "statement"], ["demo", "clip", "stats", "reveal", "versus", "article"]),
      S("#1", "the biggest one — the best demonstration in the whole dive", ["media", "statement"], ["demo", "clip"]),
      S("THE CATCH", "what to know before you get excited", ["statement", "bullets"], ["reveal", "list"]),
      S("RECAP", "the takeaways: the countdown in one glance", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "4 or 5 countdown items. Their eyebrows are exactly \"#5\", \"#4\", \"#3\", \"#2\", \"#1\" (or from #4 down).",
      "Strictly rising: the item that would make a viewer stay to the end is #1.",
    ],
  },
  {
    id: "neon", name: "Myth vs Reality", label: "Myth vs reality, round after round",
    arc: "take what people assume about it, one assumption per round, and show what is actually true",
    steps: [
      S("THE HOOK", "\"everything you've heard about this is half right\" — the one belief this dive will flip", ["title"], ["title"]),
      S("MYTH 1 → REALITY", "what people assume vs what is true, side by side", ["compare", "statement"], ["versus", "reveal"]),
      S("MYTH 2 → REALITY", "the next assumption — this round SHOWS the reality working", ["media", "compare"], ["demo", "clip", "versus"]),
      S("MYTH 3 → REALITY", "the next assumption, proven with a figure or a quote", ["stats", "quote", "bars"], ["stats", "quote", "article"]),
      S("THE MYTH THAT'S TRUE", "the twist: one worry that turns out to be right", ["statement", "bullets"], ["reveal", "list"]),
      S("WHAT'S REAL", "the takeaways: what is actually true now", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "3 or 4 myth rounds. Each round's eyebrow is \"Myth 1\", \"Myth 2\"…; the heading states the REALITY, not the myth.",
      "A myth must be something regular people really believe (from the research's reactions, coverage or the company's own framing) — never a strawman.",
    ],
  },
  {
    id: "terminal", name: "The Build", label: "The build: from zero to a working result, step by step",
    arc: "show the finished result in one line, then build it from zero, one step per chapter, until it works on screen",
    steps: [
      S("THE RESULT FIRST", "the finished thing in one line: what you'll have at the end", ["title"], ["title"]),
      S("WHAT YOU NEED", "the short list of what you need before starting (where to get it, what it costs)", ["bullets", "stats"], ["list", "reveal"]),
      S("STEP 1 … STEP N", "one chapter per step, in order, each SHOWING that step being done", ["media", "timeline", "statement", "bullets"], ["demo", "flow", "clip"]),
      S("IT WORKS", "the result running — the payoff of the build", ["media", "statement"], ["demo", "clip"]),
      S("WHERE IT BREAKS", "the limits, the gotchas, what to watch out for", ["compare", "bullets"], ["versus", "list"]),
      S("YOUR NEXT STEP", "the takeaways: what to do first today", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "3 to 5 build steps. Eyebrows are \"Step 1\", \"Step 2\"… and each heading is the action (\"Paste the prompt\").",
      "Every step is something a viewer could actually do — no step that only explains.",
    ],
  },
  {
    id: "sunset", name: "Before & After", label: "Before & after: a normal day without it → the same day with it",
    arc: "walk through one ordinary day without it, then the same day with it, and land on what really changed",
    steps: [
      S("THE HOOK", "the difference in one line", ["title"], ["title"]),
      S("BEFORE", "a normal day without it — the concrete, relatable pain", ["statement", "bullets", "quote"], ["list", "reveal", "quote"]),
      S("THE SWITCH", "what it is, in one plain sentence, and where you get it", ["statement", "stats"], ["article", "reveal"]),
      S("AFTER", "the same day with it — shown working", ["media", "statement"], ["demo", "clip"]),
      S("SIDE BY SIDE", "what changed, before vs after", ["compare", "bars"], ["versus", "stats"]),
      S("WHAT IT COSTS YOU", "the catch: price, limits, what you give up", ["stats", "bullets"], ["reveal", "list"]),
      S("SHOULD YOU SWITCH", "the takeaways", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "The BEFORE and AFTER chapters describe the SAME everyday moment (one person, one task) so the change is obvious.",
      "Eyebrows: \"Before\", \"The switch\", \"After\", \"Side by side\".",
    ],
  },
  {
    id: "mint", name: "The Experiment", label: "Experiment: the claim → three tests → the scorecard",
    arc: "take the company's claim, put it through a few real tests, and score the results",
    steps: [
      S("THE QUESTION", "the question we are testing (\"does it really…?\")", ["title"], ["title"]),
      S("THE CLAIM", "what the company says it does — their words", ["quote", "statement"], ["article", "quote"]),
      S("TEST 1 … TEST 3", "one chapter per test: what was tried, shown, and what happened", ["media", "stats", "compare", "statement"], ["demo", "clip", "stats", "versus"]),
      S("THE SURPRISE", "the result nobody expected (good or bad)", ["statement", "bars"], ["reveal", "stats"]),
      S("THE SCORECARD", "the tests scored side by side", ["bars", "compare", "stats"], ["stats", "versus", "list"]),
      S("THE VERDICT", "the takeaways: does it live up to the claim", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "Tests come ONLY from what the research or the material shows (the company's demos, reviewers' results, the demo agent). Never invent a test result.",
      "Eyebrows: \"The claim\", \"Test 1\", \"Test 2\", \"Test 3\", \"Scorecard\".",
    ],
  },
  {
    id: "swiss", name: "The Explainer", label: "Explainer: one question, answered in layers",
    arc: "answer one question in layers — what it is, how it works, why it matters, how it compares — each layer simpler than you'd expect",
    steps: [
      S("THE QUESTION", "the one question this dive answers", ["title"], ["title"]),
      S("WHAT IT IS", "the answer in one plain sentence, with a picture of it", ["statement", "media"], ["reveal", "clip", "article"]),
      S("HOW IT WORKS", "the mechanism as 3-5 simple steps", ["timeline", "bullets"], ["flow", "demo"]),
      S("WHY IT MATTERS", "one everyday example of what it changes", ["statement", "stats", "media"], ["demo", "stats", "reveal"]),
      S("HOW IT COMPARES", "against the old way or the alternatives", ["compare", "bars"], ["versus", "stats"]),
      S("WHAT IT CAN'T DO", "the honest limits", ["bullets", "statement"], ["list", "reveal"]),
      S("THE ANSWER", "the takeaways: the question answered in three lines", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "Each layer builds on the last; nothing is explained twice.",
      "Eyebrows name the layer: \"What it is\", \"How it works\", \"Why it matters\", \"How it compares\".",
    ],
  },
  {
    id: "royal", name: "The Showdown", label: "Showdown: X vs Y, round by round → who wins for whom",
    arc: "put it head to head with its main rival (or the old way), round by round, and declare a winner for each kind of user",
    steps: [
      S("THE MATCHUP", "X vs Y — why this fight matters right now", ["title"], ["title"]),
      S("MEET THE CONTENDERS", "the two side by side: what each is", ["compare"], ["versus"]),
      S("ROUND 1 … ROUND 3", "one chapter per category (results, ease, price…) — show both where the material allows", ["compare", "bars", "media", "stats"], ["versus", "stats", "demo", "clip"]),
      S("THE UPSET", "the round the underdog wins", ["statement", "quote"], ["reveal", "quote"]),
      S("THE SCOREBOARD", "the rounds tallied", ["bars", "stats"], ["stats", "list"]),
      S("WHO SHOULD PICK WHICH", "the takeaways: the winner for each kind of user", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "The rival comes from the research (the company's own comparison, reviewers, the obvious alternative). With no rival in the research, the matchup is the new way vs the old way.",
      "Eyebrows: \"Round 1\", \"Round 2\", \"Round 3\", \"The upset\", \"Scoreboard\". Never mock either side.",
    ],
  },
  {
    id: "ocean", name: "How We Got Here", label: "How we got here: the turning points → today → what's next",
    arc: "start from where things are today, go back through the turning points that led here, and look ahead",
    steps: [
      S("TODAY", "the hook: where things are right now, the most impressive thing it does", ["title"], ["title"]),
      S("NOW, SHOWN", "it working today", ["media", "statement"], ["clip", "demo"]),
      S("THE TURNING POINTS", "3-5 moments that led here, in order", ["timeline"], ["timeline"]),
      S("THE BREAKTHROUGH", "what changed THIS time that didn't before", ["statement", "compare", "stats"], ["reveal", "versus", "stats"]),
      S("WHAT PEOPLE SAID", "the reaction then vs now", ["quote", "compare"], ["quote", "article"]),
      S("WHAT'S NEXT", "the next turning points coming", ["timeline", "bullets"], ["timeline", "flow"]),
      S("WHERE THIS LEAVES YOU", "the takeaways", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "Dates and events only from the research. The past never comes before the viewer has seen it work today.",
    ],
  },
  {
    id: "mono", name: "The Verdict", label: "Verdict: a bold claim → the case for → the case against → the call",
    arc: "make one bold claim up front, argue the case for and against like a trial, and deliver a clear verdict",
    steps: [
      S("THE CLAIM", "one bold, defensible claim about it, as the headline", ["title"], ["title"]),
      S("THE CASE FOR", "the strongest evidence for the claim — shown", ["media", "stats"], ["demo", "clip", "stats"]),
      S("MORE EVIDENCE", "the second-strongest point for it", ["quote", "bars", "statement"], ["article", "quote", "reveal"]),
      S("THE CASE AGAINST", "the strongest honest argument against it", ["statement", "bullets", "quote"], ["reveal", "list", "quote"]),
      S("THE DECIDING EVIDENCE", "the fact or comparison that settles it", ["compare", "stats", "bars"], ["versus", "stats"]),
      S("THE VERDICT", "the call, in one line, with who it is right for", ["statement"], ["reveal"]),
      S("CASE CLOSED", "the takeaways", ["takeaways"], ["takeaways"]),
    ],
    rules: [
      "The claim must be defensible from the research — bold, never invented. The verdict may disagree with the opening claim.",
      "Eyebrows: \"The claim\", \"For\", \"Against\", \"The evidence\", \"Verdict\".",
    ],
  },
];

const BY_ID = new Map(STORYLINES.map((s) => [s.id, s]));

/** The dive's storyline: its template's, or the original payoff-first one (no template / an unknown id). */
export function storylineFor(template: string | null | undefined): Storyline {
  return BY_ID.get(String(template ?? "")) ?? BY_ID.get("jake")!;
}

/**
 * The STRUCTURE block for the outline prompt. `legacy` = the caller's original structure text (used verbatim for
 * the payoff-first storyline); `shared` = the rules every storyline keeps (keep it interesting / less text).
 */
export function storylinePrompt(sl: Storyline, fmt: DiveFormat, legacy: string, shared: string): string {
  if (sl.legacy) return legacy;
  const steps = sl.steps
    .map((st, i) => `${i + 1}. ${st.role} — ${st.what}. Kinds that suit it: ${(fmt === "v1" ? st.v1 : st.v2).map((k) => `"${k}"`).join(" / ")}.`)
    .join("\n");
  return `STORYLINE — "${sl.name}" (this template's OWN structure — follow it in this order; merge or skip a step the research can't support, never invent one): ${sl.arc}.
${steps}
${sl.rules.map((r) => `- ${r}`).join("\n")}
The first chapter is always "title" and the last always "takeaways".

${shared}`;
}

/** One line for the script prompts: the bridges between chapters follow this arc. */
export function storylineScriptLine(sl: Storyline): string {
  return sl.legacy ? "" : `- THE STORYLINE IS "${sl.name}": ${sl.arc}. The opener hooks the way this storyline opens; every bridge moves the viewer to the next step of it; the closer lands where it ends. Never re-order or re-explain earlier steps.`;
}
