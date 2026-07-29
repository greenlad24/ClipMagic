/**
 * The audit's claim-making rules.
 *
 * These tests are mostly about REFUSING to make claims: the failure mode of an
 * audit tool is not a missing insight, it is a confident sentence that the data
 * does not support.
 *
 *   node --experimental-strip-types src/scripts/audit-analysis.test.ts
 */
import assert from "node:assert/strict";
import {
  titleFeatures,
  correlate,
  titlePatternPerformance,
  titleStructureCorrelations,
  thumbnailCorrelations,
  splitWinnersLosers,
  renamePriority,
  marketRanks,
  evidencePool,
  engagementAnomalies,
  MIN_SAMPLE,
} from "../audit/analysis.js";
import type { AuditVideo } from "../audit/types.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log("  ok ", name);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log("FAIL ", name);
    console.log("      " + String((err as Error).message).split("\n").join("\n      "));
  }
}

const NOW = Date.UTC(2026, 6, 29);
const DAY = 86_400_000;

function v(over: Partial<AuditVideo> = {}): AuditVideo {
  const base: AuditVideo = {
    videoId: Math.random().toString(36).slice(2, 10),
    title: "A plain title",
    publishedAt: NOW - 200 * DAY,
    views: 8000,
    durationSeconds: 600,
    channelId: "UCsubject",
    thumbnailUrl: "",
    eraMedian: 8000,
    eraMultiple: 1,
    flatMultiple: 1,
    viewsPerSub: 0.13,
    ageDays: 200,
    judged: true,
    format: "long",
  };
  return { ...base, ...over };
}

// ── refusing to conclude from too little ────────────────────────────────────

check("a pattern seen only a few times is not a finding", () => {
  const pool = [
    ...Array.from({ length: 4 }, () => v({ title: "How to do the thing", eraMultiple: 5 })),
    ...Array.from({ length: 30 }, () => v({ title: "Plain one", eraMultiple: 1 })),
  ].map((x) => ({ ...x, titleFeatures: titleFeatures(x.title) }));

  const rows = titlePatternPerformance(pool);
  assert.ok(
    !rows.some((r) => r.pattern === "How to"),
    `4 videos is below the floor of ${MIN_SAMPLE} and must not be reported, got ${JSON.stringify(rows.map((r) => r.pattern))}`,
  );
});

check("an attribute every video has is not evidence it works", () => {
  // 40 videos, all with a face, all doing well. Tempting to conclude faces win.
  // There is no comparison group, so there is nothing to conclude.
  const pool = Array.from({ length: 40 }, () =>
    v({ eraMultiple: 3, thumbnail: { face: "dominant", expression: "shock", textWordCount: 3, textContent: "X", colourEnergy: "vivid", clutter: "clean", subject: "person" } }),
  );
  assert.equal(correlate(pool, "Face in thumbnail", "any", (x) => (x.thumbnail?.face ?? "none") !== "none"), null);
});

check("a comparison needs both halves to be big enough", () => {
  const pool = [
    ...Array.from({ length: 40 }, () => v({ title: "Plain", eraMultiple: 1 })),
    ...Array.from({ length: MIN_SAMPLE - 1 }, () => v({ title: "5 things you missed", eraMultiple: 9 })),
  ];
  assert.equal(correlate(pool, "Contains a number", "yes", (x) => /\d/.test(x.title)), null);

  // One more on the small side and it becomes reportable.
  pool.push(v({ title: "6 things you missed", eraMultiple: 9 }));
  const c = correlate(pool, "Contains a number", "yes", (x) => /\d/.test(x.title));
  assert.ok(c, "at the floor it should report");
  assert.equal(c!.sampleSize, MIN_SAMPLE);
  assert.ok(c!.medianMultipleWith > c!.medianMultipleWithout);
});

check("only judged videos of one format become evidence", () => {
  const pool = [
    v({ judged: true, format: "long" }),
    v({ judged: false, format: "long" }),
    v({ judged: true, format: "short", durationSeconds: 40 }),
  ];
  assert.equal(evidencePool(pool, "long").length, 1);
  assert.equal(evidencePool(pool, "short").length, 1);
});

// ── medians, not means ──────────────────────────────────────────────────────

check("one freak hit does not make its pattern look like a winner", () => {
  // Nine ordinary "How to" videos and one 400x monster. A mean would report
  // this pattern at ~40x and send the channel off making more of them.
  const pool = [
    ...Array.from({ length: 9 }, () => v({ title: "How to do a thing", eraMultiple: 0.9 })),
    v({ title: "How to do the viral thing", eraMultiple: 400 }),
    ...Array.from({ length: 20 }, () => v({ title: "Plain statement here", eraMultiple: 1 })),
  ].map((x) => ({ ...x, titleFeatures: titleFeatures(x.title) }));

  const howto = titlePatternPerformance(pool).find((r) => r.pattern === "How to")!;
  assert.ok(howto, "pattern should be reported — it has the sample size");
  assert.ok(howto.medianMultiple < 1.5, `median must resist the outlier, got ${howto.medianMultiple}`);
  assert.ok(howto.examples[0].includes("viral"), "but the outlier is still surfaced as an example");
});

// ── what counts as winning ──────────────────────────────────────────────────

check("winners and losers are judged against par, not against each other", () => {
  const rows = [
    { pattern: "A", medianMultiple: 1.9 },
    { pattern: "B", medianMultiple: 1.0 },
    { pattern: "C", medianMultiple: 0.95 },
    { pattern: "D", medianMultiple: 0.4 },
  ];
  const { winning, losing } = splitWinnersLosers(rows);
  assert.deepEqual(winning.map((r) => r.pattern), ["A"]);
  assert.deepEqual(losing.map((r) => r.pattern), ["D"]);
  // B and C are unremarkable and must appear in neither — half of anything is
  // always "below average", which is arithmetic rather than advice.
});

// ── rename ranking ──────────────────────────────────────────────────────────

check("a recent near-miss outranks an ancient disaster", () => {
  // A retitle only pays off through impressions the video still gets, so a
  // long-dead flop is worth less attention than a recent one that nearly
  // worked — even though its raw shortfall is far larger.
  const recent = v({ eraMultiple: 0.8, publishedAt: NOW - 30 * DAY });
  const ancient = v({ eraMultiple: 0.3, publishedAt: NOW - 900 * DAY });
  assert.ok(
    renamePriority(recent, NOW) > renamePriority(ancient, NOW),
    "a video still in front of an audience has more to gain than one long buried",
  );
});

check("a bad recent video still outranks a mildly weak recent one", () => {
  // Recency must not swamp performance entirely — among videos of similar age,
  // the worse performer is still the better rename candidate.
  const bad = v({ eraMultiple: 0.2, publishedAt: NOW - 60 * DAY });
  const meh = v({ eraMultiple: 0.9, publishedAt: NOW - 45 * DAY });
  assert.ok(renamePriority(bad, NOW) > renamePriority(meh, NOW));
});

check("a video at or above par is not a rename candidate", () => {
  assert.equal(renamePriority(v({ eraMultiple: 1 }), NOW), 0);
  assert.equal(renamePriority(v({ eraMultiple: 3 }), NOW), 0);
});

check("an unjudged video is never a rename candidate", () => {
  assert.equal(renamePriority(v({ eraMultiple: 0.01, judged: false, publishedAt: NOW - 1 * DAY }), NOW), 0);
});

// ── the engagement heuristic (NOT a paid-views detector) ────────────────────

check("a video with big views and flat engagement is flagged", () => {
  const normal = Array.from({ length: 20 }, () =>
    v({ views: 10000, likes: 400, comments: 100, eraMultiple: 1 }),
  );
  // 5x the views, but the same absolute engagement as an ordinary video —
  // the extra viewers did nothing, which is what paid traffic looks like.
  const odd = v({ videoId: "odd", views: 50000, likes: 420, comments: 90, eraMultiple: 5 });

  const flagged = engagementAnomalies([...normal, odd]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].videoId, "odd");
  assert.ok(flagged[0].shortfall > 0.7, `should be far below the norm, got ${flagged[0].shortfall}`);
});

check("a genuine hit with proportionate engagement is NOT flagged", () => {
  // The important negative: a video can be a huge outlier and completely
  // organic. Flagging it would put a real success under suspicion.
  const normal = Array.from({ length: 20 }, () =>
    v({ views: 10000, likes: 400, comments: 100, eraMultiple: 1 }),
  );
  const hit = v({ videoId: "hit", views: 200000, likes: 8000, comments: 2000, eraMultiple: 20 });
  assert.deepEqual(engagementAnomalies([...normal, hit]), []);
});

check("videos with no engagement data are never called suspicious", () => {
  // Likes hidden and comments disabled is a channel setting, not a signal.
  const normal = Array.from({ length: 20 }, () =>
    v({ views: 10000, likes: 400, comments: 100, eraMultiple: 1 }),
  );
  const noData = { ...v({ videoId: "quiet", views: 90000, eraMultiple: 9 }) };
  delete (noData as any).likes;
  delete (noData as any).comments;
  assert.ok(!engagementAnomalies([...normal, noData]).some((f) => f.videoId === "quiet"));
});

check("an ordinary-performing video is not flagged however quiet it is", () => {
  // The flag needs BOTH halves: unusual views AND flat engagement. A video
  // with normal views and low engagement is just a quiet video.
  const normal = Array.from({ length: 20 }, () =>
    v({ views: 10000, likes: 400, comments: 100, eraMultiple: 1 }),
  );
  const quiet = v({ videoId: "quiet", views: 9000, likes: 5, comments: 0, eraMultiple: 0.9 });
  assert.ok(!engagementAnomalies([...normal, quiet]).some((f) => f.videoId === "quiet"));
});

check("too small a catalogue yields no verdict at all", () => {
  const tiny = Array.from({ length: MIN_SAMPLE - 1 }, () => v({ views: 10000, likes: 1, comments: 0, eraMultiple: 9 }));
  assert.deepEqual(engagementAnomalies(tiny), []);
});

// ── market position ─────────────────────────────────────────────────────────

check("rank by subscribers and rank by median views can disagree", () => {
  // The interesting case: smallest channel, best videos. Reporting only the
  // subscriber rank would hide the one genuinely good piece of news.
  const subject = { channelId: "UCsubject", subscriberCount: 63500 };
  const subjectVideos = Array.from({ length: 10 }, () => v({ views: 30000 }));
  const competitors = [
    { channel: { channelId: "UCbig", subscriberCount: 900000 }, videos: Array.from({ length: 10 }, () => v({ channelId: "UCbig", views: 12000 })) },
    { channel: { channelId: "UCmid", subscriberCount: 200000 }, videos: Array.from({ length: 10 }, () => v({ channelId: "UCmid", views: 9000 })) },
  ];
  const r = marketRanks(subject, subjectVideos, competitors);
  assert.equal(r.subscriberRank, 3, "smallest by subscribers");
  assert.equal(r.medianViewsRank, 1, "but best by median views");
  assert.equal(r.competitorCount, 2);
});

// ── title feature extraction ────────────────────────────────────────────────

check("title constructions are recognised", () => {
  const cases: [string, string][] = [
    ["How to Scrape ANY Website in 9 Minutes", "How to"],
    ["25 Things You Didn't Know ChatGPT Could Do", "Numbered list"],
    ["Is AI Coming For Your Job?", "Question"],
    ["I Tried Every AI Browser So You Don't Have To", "I tried / I built"],
    ["Lovable vs Bolt vs Cursor", "Versus"],
    ["Genspark AI Complete Tutorial (2026)", "Tutorial / Guide"],
    ["The AI Agency Gold Rush is OVER... Now What?!", "Negative / warning"],
    ["Some words about a thing", "Plain statement"],
  ];
  for (const [title, expected] of cases) {
    assert.equal(titleFeatures(title).pattern, expected, `"${title}"`);
  }
});

check("title flags read real titles correctly", () => {
  const f = titleFeatures("How to Scrape UNLIMITED Leads From Facebook Groups (100% Automated)");
  assert.equal(f.hasNumber, true);
  assert.equal(f.hasBrackets, true);
  assert.equal(f.isAllCapsWord, true, "UNLIMITED is a shout");
  assert.equal(f.hasQuestion, false);
  assert.equal(f.hasYear, false);

  // A two-letter acronym is not a shout — otherwise every AI title trips it.
  assert.equal(titleFeatures("What AI Can Do For You").isAllCapsWord, false);
  assert.equal(titleFeatures("Genspark AI Complete Tutorial (2026)").hasYear, true);
});

check("an empty title does not throw", () => {
  const f = titleFeatures("");
  assert.equal(f.wordCount, 0);
  assert.equal(f.charLength, 0);
  assert.equal(f.pattern, "Plain statement");
});

// ── structure + thumbnail passes wire up ────────────────────────────────────

check("structure correlations only report what they can support", () => {
  const pool = [
    ...Array.from({ length: 20 }, (_, i) => v({ title: `${i + 1} ways to do it`, eraMultiple: 2 })),
    ...Array.from({ length: 20 }, () => v({ title: "A plain title with no digits", eraMultiple: 0.5 })),
  ].map((x) => ({ ...x, titleFeatures: titleFeatures(x.title) }));

  const rows = titleStructureCorrelations(pool);
  const num = rows.find((r) => r.attribute === "Contains a number");
  assert.ok(num, "with 20 each side this is reportable");
  assert.ok(num!.medianMultipleWith > num!.medianMultipleWithout);
  // Nothing here is a question or names a year, so those must be absent
  // entirely rather than reported as 0.
  assert.ok(!rows.some((r) => r.attribute === "Is a question"));
});

check("thumbnail correlations ignore videos with no vision data", () => {
  const analysed = Array.from({ length: 12 }, () =>
    v({ eraMultiple: 2, thumbnail: { face: "dominant", expression: "shock", textWordCount: 5, textContent: "WOW", colourEnergy: "vivid", clutter: "clean", subject: "person" } }),
  );
  const plain = Array.from({ length: 12 }, () =>
    v({ eraMultiple: 0.5, thumbnail: { face: "none", expression: null, textWordCount: 0, textContent: null, colourEnergy: "muted", clutter: "busy", subject: "ui" } }),
  );
  const unanalysed = Array.from({ length: 50 }, () => v({ eraMultiple: 99 }));

  const rows = thumbnailCorrelations([...analysed, ...plain, ...unanalysed]);
  const face = rows.find((r) => r.attribute === "Face in thumbnail")!;
  assert.ok(face, "should report");
  assert.equal(face.sampleSize, 12, "the 50 unanalysed videos must not be counted");
  assert.ok(face.medianMultipleWith > face.medianMultipleWithout);
});

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
