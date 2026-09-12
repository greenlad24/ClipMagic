/**
 * Comparing the audited channel against a NAMED channel that is not in its
 * market — the "how do I compare to that person" question a teardown provokes.
 *
 * The cases that matter are the ones where a comparison looks fine and means
 * nothing. Two channels' era multiples both sit at ~1.0 against their own
 * medians, so ranking channels by era multiple is circular; the market set is
 * over-performers only, so it can never stand in for a typical catalogue; and a
 * fetched channel has no topic membership, so grouping it by this channel's
 * topics would silently produce an empty or borrowed answer.
 *
 *   node --experimental-strip-types src/scripts/audit-guest.test.ts
 */
import assert from "node:assert/strict";
import { buildSeries, formFor, describeAvailableData, type SeriesContext } from "../audit/series.js";
import { channelRefsIn } from "../audit/sections.js";
import { correctEmptyPromise, asksForASection } from "../audit/chat.js";
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
const NOW = Date.UTC(2026, 8, 2);

const channel = (id: string, title: string, subs: number): AuditChannel =>
  ({ channelId: id, handle: title.toLowerCase().replace(/\s/g, ""), title, subscriberCount: subs, videoCount: 100, viewCount: 1_000_000 }) as AuditChannel;

let seq = 0;
const video = (over: Partial<AuditVideo> = {}): AuditVideo =>
  ({
    videoId: `v${++seq}`,
    channelId: "UCsubject",
    title: "How to do the thing",
    publishedAt: NOW - 200 * DAY,
    views: 10_000,
    likes: 100,
    comments: 10,
    durationSeconds: 600,
    thumbnailUrl: "",
    format: "long",
    ageDays: 200,
    judged: true,
    eraMedian: 10_000,
    eraMultiple: 1,
    flatMultiple: 1,
    titleFeatures: { pattern: "how-to", wordCount: 5 } as any,
    ...over,
  }) as AuditVideo;

const guestChannel = channel("UCguest", "Jake Dawson", 66_600);

const ctxWith = (over: Partial<SeriesContext> = {}): SeriesContext => ({
  subject: channel("UCsubject", "Sabrina", 378_000),
  videos: [
    video({ views: 20_000, eraMultiple: 2, titleFeatures: { pattern: "numbered", wordCount: 6 } as any }),
    video({ views: 18_000, eraMultiple: 1.8, titleFeatures: { pattern: "numbered", wordCount: 7 } as any }),
    video({ views: 16_000, eraMultiple: 1.6, titleFeatures: { pattern: "numbered", wordCount: 6 } as any }),
    video({ views: 5_000, eraMultiple: 0.5, titleFeatures: { pattern: "how-to", wordCount: 5 } as any }),
    video({ views: 4_000, eraMultiple: 0.4, titleFeatures: { pattern: "how-to", wordCount: 5 } as any }),
    video({ views: 3_000, eraMultiple: 0.3, titleFeatures: { pattern: "how-to", wordCount: 6 } as any }),
  ],
  marketVideos: [],
  competitors: [],
  topics: [],
  now: NOW,
  ...over,
});

const guestVideos = [
  video({ channelId: "UCguest", views: 9_000, eraMultiple: 1.4, titleFeatures: { pattern: "numbered", wordCount: 6 } as any }),
  video({ channelId: "UCguest", views: 8_500, eraMultiple: 1.3, titleFeatures: { pattern: "numbered", wordCount: 6 } as any }),
  video({ channelId: "UCguest", views: 8_000, eraMultiple: 1.2, titleFeatures: { pattern: "numbered", wordCount: 7 } as any }),
  video({ channelId: "UCguest", views: 7_000, eraMultiple: 0.9, titleFeatures: { pattern: "how-to", wordCount: 5 } as any }),
  video({ channelId: "UCguest", views: 6_500, eraMultiple: 0.8, titleFeatures: { pattern: "how-to", wordCount: 5 } as any }),
  video({ channelId: "UCguest", views: 6_000, eraMultiple: 0.7, titleFeatures: { pattern: "how-to", wordCount: 6 } as any }),
];

const withGuest = (truncated = false) =>
  ctxWith({ guest: { channel: guestChannel, videos: guestVideos, truncated } });

// ── the comparison has to exist before it can be drawn ─────────────────────

check("asking for a guest scope with no channel fetched says so", () => {
  const d = buildSeries({ scope: "compare-guest", groupBy: "titlePattern", measure: "medianViews" }, ctxWith());
  assert.match(d.unavailable ?? "", /No second channel has been fetched/);
});

check("a fetched channel is named on the axis, not called 'the market'", () => {
  const d = buildSeries({ scope: "compare-guest", groupBy: "titlePattern", measure: "medianViews" }, withGuest());
  assert.deepEqual(d.seriesLabels, ["This channel", "Jake Dawson"]);
  assert.ok(!d.unavailable, d.unavailable);
});

// ── the circular comparison ────────────────────────────────────────────────

check("ranking channels by era multiple is refused — every channel is ~1.0 by definition", () => {
  for (const scope of ["own", "market", "compare", "guest", "compare-guest"] as const) {
    const d = buildSeries({ scope, groupBy: "channel", measure: "medianEraMultiple" }, withGuest());
    assert.match(d.unavailable ?? "", /about 1\.0 by definition|only means something across the market/, `scope ${scope}`);
  }
});

check("but the era multiple IS allowed within a fetched channel — it is a whole catalogue", () => {
  const d = buildSeries({ scope: "guest", groupBy: "titlePattern", measure: "medianEraMultiple" }, withGuest());
  assert.ok(!d.unavailable, d.unavailable);
  const numbered = d.points.find((p) => p.label.toLowerCase().includes("number"));
  assert.ok(numbered, `expected a numbered-title group, got ${d.points.map((p) => p.label).join(", ")}`);
  assert.equal(numbered!.n, 3);
});

check("the market keeps its era-multiple refusal — it is over-performers only", () => {
  const d = buildSeries(
    { scope: "compare", groupBy: "titlePattern", measure: "medianEraMultiple" },
    ctxWith({ marketVideos: guestVideos }),
  );
  assert.match(d.unavailable ?? "", /cannot be compared against the market/);
});

// ── what a guest can and cannot be grouped by ──────────────────────────────

check("a fetched channel is never grouped by this channel's topics", () => {
  const ctx = ctxWith({
    guest: { channel: guestChannel, videos: guestVideos },
    topics: [{ topic: "AI money", videoIds: ["v1", "v2", "v3"] }],
  });
  const d = buildSeries({ scope: "guest", groupBy: "topic", measure: "medianViews" }, ctx);
  assert.match(d.unavailable ?? "", /Topics were only worked out for this channel/);
});

// ── the comparison itself ──────────────────────────────────────────────────

check("compare-guest puts both channels on one measure, each with its own n", () => {
  const d = buildSeries({ scope: "compare-guest", groupBy: "titlePattern", measure: "medianViews" }, withGuest());
  const numbered = d.points.find((p) => p.label.toLowerCase().includes("number"))!;
  assert.equal(numbered.value, 18_000, "this channel's median for numbered titles");
  assert.equal(numbered.secondary, 8_500, "the fetched channel's median for the same");
  assert.equal(numbered.n, 3);
  assert.equal(numbered.nSecondary, 3);
});

check("two populations on one measure are drawn as grouped bars", () => {
  const query = { scope: "compare-guest", groupBy: "titlePattern", measure: "medianViews" } as const;
  const d = buildSeries(query, withGuest());
  assert.equal(formFor(query, d), "grouped");
});

check("the note says a fetched channel is its typical work, not its best", () => {
  const d = buildSeries({ scope: "compare-guest", groupBy: "titlePattern", measure: "medianViews" }, withGuest());
  assert.match(d.note, /whole catalogue, not its best videos/);
  // And the market's over-performers warning must NOT be attached to it.
  assert.ok(!/over-performers only/.test(d.note), "a guest is not the market");
});

check("a capped catalogue says it was capped", () => {
  const d = buildSeries({ scope: "guest", groupBy: "titlePattern", measure: "medianViews" }, withGuest(true));
  assert.match(d.note, /most recent uploads, in full/);
});

check("the planner is told when a channel is already fetched, so it is not fetched twice", () => {
  assert.match(describeAvailableData(withGuest()), /ALREADY FETCHED FOR COMPARISON: Jake Dawson/);
  assert.match(describeAvailableData(ctxWith()), /NO OTHER CHANNEL FETCHED YET/);
});

// ── reading the channel out of what was actually typed ─────────────────────

check("a channel reference is found in the operator's own words", () => {
  assert.deepEqual(channelRefsIn("add a comparison with https://www.youtube.com/@Jake.Dawson"), [
    "https://www.youtube.com/@Jake.Dawson",
  ]);
  assert.deepEqual(channelRefsIn("how do I compare to @JakeDawson?"), ["@JakeDawson"]);
  assert.deepEqual(channelRefsIn("compare me to UCa5OAoQETuYHkx9Vh_TsMCg please"), ["UCa5OAoQETuYHkx9Vh_TsMCg"]);
  assert.deepEqual(channelRefsIn("add a section about my Shorts"), []);
});

check("a trailing full stop is not part of the handle", () => {
  assert.deepEqual(channelRefsIn("compare me with @Jake.Dawson."), ["@Jake.Dawson"]);
});

// ── the promise that did nothing ───────────────────────────────────────────

check("a reply promising a section with no action is corrected, not published as-is", () => {
  const promised = "Adding it. The section will fetch Jake Dawson's catalogue and compare it against yours.";
  assert.match(correctEmptyPromise(promised, null), /nothing was actually added/i);
  // With the action really returned, the reply stands untouched.
  assert.equal(correctEmptyPromise(promised, { kind: "add-section", request: "x" }), promised);
  // And an ordinary answer is never decorated with a correction.
  const answer = "Your numbered titles do 1.85x across 23 videos.";
  assert.equal(correctEmptyPromise(answer, null), answer);
});

check("an add-request is told apart from a question about the report", () => {
  // Worth retrying without history when it produces no action.
  assert.equal(asksForASection("add a comparison with https://www.youtube.com/@Jake.Dawson"), true);
  assert.equal(asksForASection("add a section about my Shorts"), true);
  assert.equal(asksForASection("I want a section on posting frequency"), true);
  // Not a request to change the document — answer it, do not re-ask.
  assert.equal(asksForASection("how does it compare to @Jake.Dawson?"), false);
  assert.equal(asksForASection("which of my titles did best?"), false);
});

check("the later phrasings of the same empty promise are caught too", () => {
  for (const reply of ["Re-issuing it now, same request.", "Kicking it off.", "Handing it off to the section pass."]) {
    assert.match(correctEmptyPromise(reply, null), /nothing was actually added/i, reply);
  }
});

check("a comparison with nothing on the other side stops calling itself one", () => {
  // The real case: face-on-thumbnail against a channel whose images were never
  // read. One series of bars under a two-series legend reads as a measured gap.
  const noThumbs = withGuest();
  const d = buildSeries({ scope: "compare-guest", groupBy: "thumbnailFace", measure: "medianEraMultiple" }, {
    ...noThumbs,
    videos: noThumbs.videos.map((v) => ({ ...v, thumbnail: { faceSize: "none" } as any })),
  });
  assert.ok(!d.unavailable, d.unavailable);
  assert.deepEqual(d.seriesLabels, ["This channel"], "the second name must come off");
  assert.match(d.note, /Nothing could be measured for Jake Dawson/);
});

check("a real two-sided comparison keeps both names", () => {
  const d = buildSeries({ scope: "compare-guest", groupBy: "titlePattern", measure: "medianViews" }, withGuest());
  assert.deepEqual(d.seriesLabels, ["This channel", "Jake Dawson"]);
  assert.ok(!/Nothing could be measured/.test(d.note));
});

check("two whole catalogues can be ranked channel by channel", () => {
  const d = buildSeries({ scope: "compare-guest", groupBy: "channel", measure: "medianViews" }, withGuest());
  assert.ok(!d.unavailable, d.unavailable);
  assert.deepEqual(d.seriesLabels, ["Each channel"]);
  assert.deepEqual(
    d.points.map((p) => p.label).sort(),
    ["Jake Dawson", "Sabrina"],
    "each channel gets its own bar, not an empty second series",
  );
});

check("ranking channels against the MARKET is refused — best-of beside average", () => {
  const d = buildSeries(
    { scope: "compare", groupBy: "channel", measure: "medianViews" },
    ctxWith({ marketVideos: guestVideos, competitors: [guestChannel] }),
  );
  assert.match(d.unavailable ?? "", /cannot be done fairly/);
});

check("the planner is warned when the fetched channel's thumbnails are unread", () => {
  assert.match(describeAvailableData(withGuest()), /ITS THUMBNAILS READ: 0\/6 — so a thumbnail comparison/);
  const read = ctxWith({
    guest: { channel: guestChannel, videos: guestVideos.map((v) => ({ ...v, thumbnail: { faceSize: "none" } as any })) },
  });
  assert.match(describeAvailableData(read), /ITS THUMBNAILS READ: 6\/6\./);
});

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
