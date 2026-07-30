/**
 * The custom-section series builder, and the cost maths behind a run's bill.
 *
 * Two things are being defended here, and they are the two places where this
 * feature could quietly lie.
 *
 * FIRST, THE CHARTS. A custom section lets a model choose what to measure, and
 * the only reason that is safe is that it cannot choose what the measurement
 * says. So the cases below are the ones where a careless implementation would
 * produce a chart that looks fine and is wrong: a median over two videos drawn
 * beside one over forty, an unread thumbnail folded into the "no face" bucket,
 * an age curve reordered by size until it is no longer a curve.
 *
 * SECOND, THE BILL. Every audit ever run reported $0.00 because the model it
 * uses had no rate on file and nothing was collecting usage anyway. A zero is
 * the most believable wrong number there is, so the tests insist a missing rate
 * reads as UNKNOWN rather than free.
 *
 *   node --experimental-strip-types src/scripts/audit-series.test.ts
 */
import assert from "node:assert/strict";
import { buildSeries, describeAvailableData, formFor, type SeriesContext } from "../audit/series.js";
import { costByLabel, totalCost, hasUnpriced, type ScopedCall } from "../ai/usageScope.js";
import { ANTHROPIC_RATES, tokenCost } from "../ai/pricing.js";
import type { AuditChannel, AuditVideo } from "../audit/types.js";

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

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 29);

function vid(o: Partial<AuditVideo> & { videoId: string; eraMultiple: number }): AuditVideo {
  return {
    channelId: "own",
    thumbnailUrl: "",
    title: o.videoId,
    publishedAt: NOW - 200 * DAY,
    views: 1000,
    durationSeconds: 600,
    eraMedian: 1000,
    flatMultiple: 1,
    viewsPerSub: 0.1,
    ageDays: 200,
    judged: true,
    ...o,
  } as AuditVideo;
}

const channel = (id: string, title: string): AuditChannel => ({
  channelId: id,
  handle: null,
  title,
  subscriberCount: 1000,
  videoCount: 10,
  viewCount: 100000,
});

function ctxOf(over: Partial<SeriesContext> = {}): SeriesContext {
  return {
    subject: channel("own", "Mine"),
    videos: [],
    marketVideos: [],
    competitors: [],
    topics: [],
    now: NOW,
    ...over,
  };
}

/* ── sample sizes travel with the numbers ─────────────────────────────────── */

check("every point carries the sample size behind it", () => {
  const ctx = ctxOf({
    videos: [
      vid({ videoId: "a", eraMultiple: 2, titleFeatures: { pattern: "How to" } as any }),
      vid({ videoId: "b", eraMultiple: 4, titleFeatures: { pattern: "How to" } as any }),
      vid({ videoId: "c", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
    ],
  });
  const data = buildSeries({ scope: "own", groupBy: "titlePattern", measure: "medianEraMultiple" }, ctx);
  assert.equal(data.points.length, 1);
  assert.equal(data.points[0].label, "How to");
  assert.equal(data.points[0].value, 2); // median of 1, 2, 4
  assert.equal(data.points[0].n, 3);
});

check("a group under the sample floor is dropped AND reported, never silent", () => {
  const ctx = ctxOf({
    videos: [
      vid({ videoId: "a", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
      vid({ videoId: "b", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
      vid({ videoId: "c", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
      // A single 9x video would otherwise be the tallest bar on the chart.
      vid({ videoId: "d", eraMultiple: 9, titleFeatures: { pattern: "I tried" } as any }),
    ],
  });
  const data = buildSeries({ scope: "own", groupBy: "titlePattern", measure: "medianEraMultiple" }, ctx);
  assert.deepEqual(
    data.points.map((p) => p.label),
    ["How to"],
  );
  assert.deepEqual(data.dropped, [{ label: "I tried", n: 1 }]);
  assert.ok(data.note.includes("I tried"), "the dropped group must be named in the note");
});

/* ── absent data is absent, not a category ────────────────────────────────── */

check("an unread thumbnail is excluded, not counted as having no face", () => {
  const ctx = ctxOf({
    videos: [
      vid({ videoId: "a", eraMultiple: 1, thumbnail: { face: "none" } as any }),
      vid({ videoId: "b", eraMultiple: 1, thumbnail: { face: "none" } as any }),
      vid({ videoId: "c", eraMultiple: 1, thumbnail: { face: "none" } as any }),
      // Never read by the vision pass — must not join the "none" bucket.
      vid({ videoId: "d", eraMultiple: 8 }),
      vid({ videoId: "e", eraMultiple: 8 }),
      vid({ videoId: "f", eraMultiple: 8 }),
    ],
  });
  const data = buildSeries({ scope: "own", groupBy: "thumbnailFace", measure: "medianEraMultiple" }, ctx);
  assert.equal(data.points.length, 1);
  assert.equal(data.points[0].label, "none");
  assert.equal(data.points[0].n, 3, "the three unread thumbnails must not inflate this group");
  assert.equal(data.points[0].value, 1);
});

check("a query the run cannot answer says so rather than drawing an empty axis", () => {
  const data = buildSeries(
    { scope: "own", groupBy: "topic", measure: "medianEraMultiple" },
    ctxOf({ videos: [vid({ videoId: "a", eraMultiple: 1 })] }),
  );
  assert.equal(data.points.length, 0);
  assert.ok(data.unavailable, "must be marked unavailable");
});

/* ── young videos are not evidence ────────────────────────────────────────── */

check("videos too young to judge stay out of the medians by default", () => {
  const ctx = ctxOf({
    videos: [
      vid({ videoId: "a", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
      vid({ videoId: "b", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
      vid({ videoId: "c", eraMultiple: 1, titleFeatures: { pattern: "How to" } as any }),
      // Published this morning: 0.02x means nothing yet.
      vid({
        videoId: "fresh",
        eraMultiple: 0.02,
        judged: false,
        ageDays: 0,
        publishedAt: NOW - 3600_000,
        titleFeatures: { pattern: "How to" } as any,
      }),
    ],
  });
  const judged = buildSeries({ scope: "own", groupBy: "titlePattern", measure: "medianEraMultiple" }, ctx);
  assert.equal(judged.points[0].n, 3);
  assert.equal(judged.points[0].value, 1);

  const all = buildSeries(
    { scope: "own", groupBy: "titlePattern", measure: "medianEraMultiple", filter: { judgedOnly: false } },
    ctx,
  );
  assert.equal(all.points[0].n, 4, "opting out must actually include it");
});

/* ── ordinal axes keep their order ────────────────────────────────────────── */

check("an age curve stays in age order instead of sorting by size", () => {
  const mk = (days: number, id: string) =>
    vid({ videoId: id, eraMultiple: 1, publishedAt: NOW - days * DAY, ageDays: days, views: days });
  const ctx = ctxOf({
    videos: [
      mk(3, "a1"), mk(4, "a2"), mk(5, "a3"),
      mk(400, "d1"), mk(401, "d2"), mk(402, "d3"),
      mk(40, "b1"), mk(41, "b2"), mk(42, "b3"),
    ],
  });
  const data = buildSeries({ scope: "own", groupBy: "ageBand", measure: "medianViews" }, ctx);
  assert.deepEqual(
    data.points.map((p) => p.label),
    ["0–7d", "30–90d", "365d+"],
    "must be chronological, not ranked by the measure",
  );
});

check("an ordinal grouping is drawn as a line, a par-based measure as diverging", () => {
  const ctx = ctxOf({
    videos: [1, 2, 3].map((i) => vid({ videoId: `a${i}`, eraMultiple: 1, titleFeatures: { pattern: "How to" } as any })),
  });
  const ageQ = { scope: "own" as const, groupBy: "ageBand" as const, measure: "medianViews" as const };
  assert.equal(formFor(ageQ, buildSeries(ageQ, ctx)), "line");

  const parQ = { scope: "own" as const, groupBy: "titlePattern" as const, measure: "medianEraMultiple" as const };
  assert.equal(formFor(parQ, buildSeries(parQ, ctx)), "diverging");

  const plainQ = { scope: "own" as const, groupBy: "titlePattern" as const, measure: "medianViews" as const };
  assert.equal(formFor(plainQ, buildSeries(plainQ, ctx)), "bars");
});

/* ── comparing against the market ─────────────────────────────────────────── */

check("compare puts both populations on ONE measure, each with its own n", () => {
  const own = [1, 2, 3].map((i) =>
    vid({ videoId: `o${i}`, eraMultiple: 1, views: 100, titleFeatures: { pattern: "How to" } as any }),
  );
  const market = [1, 2, 3, 4].map((i) =>
    vid({
      videoId: `m${i}`,
      channelId: "rival",
      eraMultiple: 3,
      views: 900,
      titleFeatures: { pattern: "How to" } as any,
    }),
  );
  const data = buildSeries(
    { scope: "compare", groupBy: "titlePattern", measure: "medianViews" },
    ctxOf({ videos: own, marketVideos: market, competitors: [channel("rival", "Rival")] }),
  );
  assert.equal(data.points.length, 1);
  assert.equal(data.points[0].value, 100);
  assert.equal(data.points[0].n, 3);
  assert.equal(data.points[0].secondary, 900);
  assert.equal(data.points[0].nSecondary, 4);
  assert.deepEqual(data.seriesLabels, ["This channel", "The market"]);
  const q = { scope: "compare" as const, groupBy: "titlePattern" as const, measure: "medianViews" as const };
  assert.equal(formFor(q, data), "grouped");
});

check("the era multiple is REFUSED against the market — it would measure the outlier filter", () => {
  // The market set holds only videos already filtered to >= 1.5x their own
  // channel's norm, so a median era multiple over it is >= 1.5 by construction.
  // Left available, this produced a real section claiming "competitors sit at
  // 6.57 against your 0.94", which is an artefact of the filter and not a fact.
  const own = [1, 2, 3].map((i) =>
    vid({ videoId: `o${i}`, eraMultiple: 0.94, titleFeatures: { pattern: "How to" } as any }),
  );
  const market = [1, 2, 3].map((i) =>
    vid({ videoId: `m${i}`, channelId: "rival", eraMultiple: 6.57, titleFeatures: { pattern: "How to" } as any }),
  );
  const ctx = ctxOf({ videos: own, marketVideos: market, competitors: [channel("rival", "Rival")] });

  for (const scope of ["compare", "market"] as const) {
    const data = buildSeries({ scope, groupBy: "titlePattern", measure: "medianEraMultiple" }, ctx);
    assert.equal(data.points.length, 0, `${scope} must not chart an era multiple against the market`);
    assert.ok(data.unavailable?.includes("over-performers"), "must explain WHY, and name the alternative");
    assert.ok(data.unavailable?.includes("median views"));
  }

  // The same comparison on views is allowed — biased, but honestly so, and the
  // note has to carry the bias with it.
  const views = buildSeries({ scope: "compare", groupBy: "titlePattern", measure: "medianViews" }, ctx);
  assert.equal(views.points.length, 1);
  assert.ok(views.note.includes("over-performers only"), "the selection bias must ride along with the numbers");

  // ...and on this channel alone it is exactly the right measure.
  const ownOnly = buildSeries({ scope: "own", groupBy: "titlePattern", measure: "medianEraMultiple" }, ctx);
  assert.equal(ownOnly.points[0].value, 0.94);
});

check("grouping by channel is refused for a single channel rather than drawn as one bar", () => {
  const data = buildSeries(
    { scope: "own", groupBy: "channel", measure: "medianViews" },
    ctxOf({ videos: [vid({ videoId: "a", eraMultiple: 1 })] }),
  );
  assert.ok(data.unavailable);
});

/* ── measures that cannot be computed say so ──────────────────────────────── */

check("a group with no likes or comments is dropped rather than scored zero", () => {
  const ctx = ctxOf({
    videos: [1, 2, 3].map((i) =>
      vid({ videoId: `a${i}`, eraMultiple: 1, views: 1000, titleFeatures: { pattern: "How to" } as any }),
    ),
  });
  const data = buildSeries({ scope: "own", groupBy: "titlePattern", measure: "medianEngagementRate" }, ctx);
  assert.equal(data.points.length, 0, "no engagement data means no bar, not a 0% bar");
  assert.ok(data.unavailable);
});

check("share of videos is a share of the whole population, not of the surviving groups", () => {
  const ctx = ctxOf({
    videos: [
      ...[1, 2, 3].map((i) => vid({ videoId: `a${i}`, eraMultiple: 1, titleFeatures: { pattern: "How to" } as any })),
      // One-off patterns fall under the floor but still count in the denominator.
      vid({ videoId: "z1", eraMultiple: 1, titleFeatures: { pattern: "Listicle" } as any }),
      vid({ videoId: "z2", eraMultiple: 1, titleFeatures: { pattern: "Question" } as any }),
    ],
  });
  const data = buildSeries({ scope: "own", groupBy: "titlePattern", measure: "shareOfVideos" }, ctx);
  assert.equal(data.points.length, 1);
  assert.equal(data.points[0].value, 60, "3 of 5 videos is 60%, not 100% of what survived");
});

/* ── the data manifest ────────────────────────────────────────────────────── */

check("the manifest warns the planner off topics when membership was never recorded", () => {
  const said = describeAvailableData(ctxOf({ videos: [vid({ videoId: "a", eraMultiple: 1 })] }));
  assert.ok(said.includes("do not group by topic"));
});

/* ── the bill ─────────────────────────────────────────────────────────────── */

const call = (over: Partial<ScopedCall>): ScopedCall => ({
  label: "audit-report",
  model: "claude-opus-5",
  input: 1000,
  output: 500,
  cacheWrite: 0,
  cacheRead: 0,
  costUsd: 0,
  ms: 100,
  ...over,
});

check("Opus 5 has a rate on file — the audit chat's model must be priceable", () => {
  const rate = ANTHROPIC_RATES["claude-opus-5"];
  assert.ok(rate, "claude-opus-5 missing from ANTHROPIC_RATES");
  // 1M in + 1M out at $5/$25.
  assert.equal(Math.round(tokenCost(rate, 1_000_000, 1_000_000) * 100) / 100, 30);
});

check("a run's bill decomposes by stage, dearest first", () => {
  const calls = [
    call({ label: "audit-thumbnail", costUsd: 0.4 }),
    call({ label: "audit-rename", costUsd: 1.5 }),
    call({ label: "audit-rename", costUsd: 0.5 }),
    call({ label: "audit-report", costUsd: 0.3 }),
  ];
  const rows = costByLabel(calls);
  assert.deepEqual(
    rows.map((r) => r.label),
    ["audit-rename", "audit-thumbnail", "audit-report"],
  );
  assert.equal(rows[0].costUsd, 2);
  assert.equal(rows[0].calls, 2);
  assert.equal(totalCost(calls), 2.7);
});

check("an unpriced model reads as UNKNOWN, not as free", () => {
  const calls = [call({ costUsd: 1 }), call({ model: "some-new-model", costUsd: 0, unpriced: true })];
  assert.ok(hasUnpriced(calls), "the total must be flagged as a floor, not a fact");
  assert.equal(totalCost(calls), 1);
  assert.ok(costByLabel(calls).some((r) => r.unpriced));
});

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
