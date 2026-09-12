/**
 * What an audit does when a stage fails.
 *
 * The cases that matter are the ones where carrying on is WORSE than stopping:
 * substituting a market that is not the same market, scoring a channel against
 * a set it is itself in, or presenting "rank 1 of 1" as a position. Each of
 * those is a confident, wrong report — the failure mode this whole path exists
 * to avoid, since the point of skipping a step is to keep the rest trustworthy.
 *
 *   node --experimental-strip-types src/scripts/audit-recovery.test.ts
 */
import assert from "node:assert/strict";
import {
  STAGE_ORDER,
  willRecurToday,
  STAGE_META,
  isFatal,
  gapFor,
  addGap,
  inferFailedStage,
  skipPlan,
  withoutSubject,
  marketFitScore,
  rankMarketFallbacks,
  MARKET_FIT_FLOOR,
} from "../audit/recovery.js";
import type { AuditGap, AuditVideo, ProposedCompetitor, SavedMarket } from "../audit/types.js";

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

const video = (id: string, extra: Partial<AuditVideo> = {}): AuditVideo =>
  ({
    videoId: id,
    channelId: "UCsubject",
    title: id,
    publishedAt: 0,
    views: 1000,
    likes: 0,
    comments: 0,
    durationSeconds: 600,
    thumbnailUrl: "",
    format: "long",
    ageDays: 100,
    judged: true,
    eraMedian: 1000,
    eraMultiple: 1,
    flatMultiple: 1,
    ...extra,
  }) as AuditVideo;

const competitor = (over: Partial<ProposedCompetitor>): ProposedCompetitor => ({
  channelId: null,
  handle: null,
  title: "someone",
  reason: "",
  include: true,
  ...over,
});

const savedMarket = (over: Partial<SavedMarket>): SavedMarket =>
  ({
    id: "m1",
    name: "a market",
    niche: "a niche",
    competitors: [competitor({ channelId: "UCa", title: "A" })],
    discoveredFrom: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as SavedMarket;

const run = (over: any = {}) => ({
  status: "failed",
  error: null,
  subject: { channelId: "UCsubject", handle: "subject", title: "Subject", subscriberCount: 1000, videoCount: 10, viewCount: 1 },
  videos: [video("a")],
  competitors: [],
  approved: null,
  proposal: null,
  findings: null,
  failedStage: null,
  ...over,
});

// ── what may be skipped ────────────────────────────────────────────────────

check("only the ingest is fatal — every later stage can be skipped", () => {
  assert.equal(isFatal("ingest"), true);
  for (const stage of STAGE_ORDER.filter((s) => s !== "ingest")) {
    assert.equal(isFatal(stage), false, `${stage} should be skippable`);
  }
});

check("every stage says what its absence costs", () => {
  for (const stage of STAGE_ORDER) {
    const meta = STAGE_META[stage];
    assert.ok(meta.label.length > 3, `${stage} needs a label`);
    // The consequence is shown to the operator AND handed to the model writing
    // the report. A vague one produces a report that writes around the hole.
    assert.ok(meta.consequence.length > 30, `${stage} needs a real consequence`);
  }
});

// ── the gap record ─────────────────────────────────────────────────────────

check("a stage skipped twice is still one gap, with the newest reason", () => {
  let gaps: AuditGap[] = [];
  gaps = addGap(gaps, gapFor("market", "quota", true, 1));
  gaps = addGap(gaps, gapFor("market", "still quota", false, 2));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "still quota");
  assert.equal(gaps[0].automatic, false);
});

check("gaps are listed in pipeline order, not the order they happened", () => {
  let gaps: AuditGap[] = [];
  gaps = addGap(gaps, gapFor("plan", "later", true));
  gaps = addGap(gaps, gapFor("market", "earlier", true));
  assert.deepEqual(
    gaps.map((g) => g.stage),
    ["market", "plan"],
  );
});

// ── where a failed run died ────────────────────────────────────────────────

check("a run with no catalogue died in the ingest", () => {
  assert.equal(inferFailedStage(run({ subject: null, videos: [] })), "ingest");
  assert.equal(inferFailedStage(run({ videos: [] })), "ingest");
});

check("a proposal with no competitors at all means the market died", () => {
  // The exact state of the run this path was built for: the catalogue read, the
  // niche named, and discovery killed by a search-quota cap before it could put
  // a single competitor on the proposal.
  const proposal = { niche: "n", nicheDescription: "", subjectSummary: "", audience: "", competitors: [] };
  assert.equal(inferFailedStage(run({ proposal }) as any), "market");
});

check("a stage already skipped is never blamed for the next failure", () => {
  const gaps = [gapFor("market", "quota", true)];
  // No competitors because the market was skipped — the thumbnails are what
  // died this time.
  assert.equal(inferFailedStage(run({ gaps }) as any), "thumbnails");
});

check("competitors wanted but none scanned means the market died", () => {
  const proposal = { niche: "n", nicheDescription: "", subjectSummary: "", audience: "", competitors: [competitor({ include: true })] };
  assert.equal(inferFailedStage(run({ proposal })), "market");
});

check("a scanned market with unread thumbnails means the thumbnails died", () => {
  const proposal = { niche: "n", nicheDescription: "", subjectSummary: "", audience: "", competitors: [competitor({ include: true })] };
  const scanned = run({ proposal, competitors: [{ channelId: "UCa" }] });
  assert.equal(inferFailedStage(scanned), "thumbnails");
});

check("read thumbnails but no findings means the write-up died", () => {
  const scanned = run({ competitors: [{ channelId: "UCa" }], videos: [video("a", { thumbnail: { faces: 1 } as any })] });
  assert.equal(inferFailedStage(scanned), "report");
});

// ── the skip plan ──────────────────────────────────────────────────────────

check("only a failed run can be skipped", () => {
  const r = skipPlan(run({ status: "completed" }) as any);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /completed/);
});

check("a run that never ingested cannot be carried on", () => {
  const r = skipPlan(run({ subject: null, videos: [] }) as any);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /start it again/i);
});

check("a quota cap is skipped, not retried — it would fail again today", () => {
  const approved = { niche: "n", nicheDescription: "", subjectSummary: "", audience: "", competitors: [competitor({ include: true })] };
  const r: any = skipPlan(run({
    failedStage: "market",
    approved,
    error: "YouTube API quota is exhausted for today. The audit stopped; what it had already gathered is kept.",
  }) as any);
  assert.equal(r.ok, true);
  assert.equal(r.plan.stage, "market");
  assert.equal(r.plan.action, "skip");
  assert.equal(r.plan.market, null, "a skipped market must not be scanned anyway");
});

check("a restart is retried, and keeps the market it was going to use", () => {
  const approved = { niche: "n", nicheDescription: "", subjectSummary: "", audience: "", competitors: [competitor({ include: true })] };
  const r: any = skipPlan(run({
    failedStage: "market",
    approved,
    error: "The server restarted while this audit was running.",
  }) as any);
  assert.equal(r.plan.action, "retry");
  assert.deepEqual(r.plan.market, approved);
});

check("what will still be true today, and what will not", () => {
  assert.equal(willRecurToday("YouTube API quota is exhausted for today."), true);
  assert.equal(willRecurToday("Quota exceeded for quota metric 'Search Queries'"), true);
  assert.equal(willRecurToday("The YouTube Data API key is not configured."), true);
  assert.equal(willRecurToday("The server restarted while this audit was running."), false);
  assert.equal(willRecurToday("fetch failed"), false);
  assert.equal(willRecurToday("Overloaded"), false);
  assert.equal(willRecurToday(""), false, "an unknown reason is worth one more try");
});

check("work already paid for is reused, and only what exists", () => {
  const approved = { niche: "n", nicheDescription: "", subjectSummary: "", audience: "", competitors: [competitor({ include: true })] };
  const withThumbs = run({
    failedStage: "report",
    approved,
    videos: [video("a", { thumbnail: { faces: 1 } as any }), video("b")],
  });
  const r: any = skipPlan(withThumbs as any);
  assert.equal(r.plan.reuseThumbnails, true);
  assert.equal(r.plan.reuseRenames, false, "no renames on the row — nothing to reuse");
  assert.deepEqual(r.plan.market, approved, "a report that failed keeps the market it was written about");
});

check("excluded competitors never come back through the skip path", () => {
  const proposal = {
    niche: "n",
    nicheDescription: "",
    subjectSummary: "",
    audience: "",
    competitors: [competitor({ title: "in", include: true }), competitor({ title: "out", include: false })],
  };
  const r: any = skipPlan(run({ failedStage: "thumbnails", proposal }) as any);
  assert.deepEqual(r.plan.market.competitors.map((c: ProposedCompetitor) => c.title), ["in"]);
});

// ── the subject is never part of its own market ────────────────────────────

check("the audited channel is dropped from a substituted market, by id or handle", () => {
  const kept = withoutSubject(
    [
      competitor({ channelId: "UCother", title: "Other" }),
      competitor({ channelId: "UCsubject", title: "Subject by id" }),
      competitor({ handle: "@Subject", title: "Subject by handle" }),
    ],
    { channelId: "UCsubject", handle: "subject" },
  );
  assert.deepEqual(kept.map((c) => c.title), ["Other"]);
});

check("dropping the subject does not drop everyone when it has no handle", () => {
  const kept = withoutSubject([competitor({ channelId: "UCa" }), competitor({ handle: "b" })], {
    channelId: "UCsubject",
    handle: null,
  });
  assert.equal(kept.length, 2);
});

// ── which saved market may stand in ────────────────────────────────────────

check("a market about something else scores near zero", () => {
  const score = marketFitScore("AI tools for solopreneur income and automation", savedMarket({
    name: "Live music covers",
    niche: "independent musicians performing live sessions",
  }));
  assert.ok(score < 0.2, `expected a low score, got ${score}`);
});

check("a market covering the same ground scores above the floor", () => {
  const score = marketFitScore("AI tools for solopreneur income and automation", savedMarket({
    name: "AI solopreneur tools",
    niche: "AI automation tools for solopreneur income",
  }));
  assert.ok(score >= MARKET_FIT_FLOOR, `expected >= ${MARKET_FIT_FLOOR}, got ${score}`);
});

check("the wrong market is never even shortlisted", () => {
  const candidates = rankMarketFallbacks("AI tools for solopreneur income and automation", [
    savedMarket({ id: "music", name: "Live music covers", niche: "musicians performing live sessions" }),
  ]);
  assert.deepEqual(candidates, [], "a music market must not be offered for an AI-tools channel");
});

check("shortlisting prefers the closer market and caps the list", () => {
  const ranked = rankMarketFallbacks(
    "AI tools for solopreneur income and automation",
    [
      savedMarket({ id: "close", name: "AI solopreneur income tools", niche: "AI automation for solopreneur income" }),
      savedMarket({ id: "loose", name: "AI automation", niche: "AI automation tutorials" }),
      savedMarket({ id: "music", name: "Live music", niche: "musicians" }),
    ],
    { limit: 1 },
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].market.id, "close");
});

check("an empty market is never offered as a stand-in", () => {
  const ranked = rankMarketFallbacks("AI tools for solopreneur income and automation", [
    savedMarket({ id: "empty", name: "AI solopreneur income tools", niche: "AI automation for solopreneur income", competitors: [] }),
  ]);
  assert.deepEqual(ranked, []);
});

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
