/**
 * The audit's baseline maths.
 *
 * Every conclusion the tool draws — which titles to copy, which to rewrite,
 * what the thumbnails prove — comes from these numbers, so the cases that
 * matter are the ones where a naive baseline gives a confidently wrong answer.
 *
 *   node --experimental-strip-types src/scripts/audit-baseline.test.ts
 */
import assert from "node:assert/strict";
import {
  scoreCatalogue,
  outliers,
  underperformers,
  ageCurve,
  reachOutliers,
  median,
  formatOf,
  MIN_JUDGEABLE_AGE_DAYS,
  SHORTS_MAX_SECONDS,
  type ScorableVideo,
} from "../audit/baseline.js";

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

function vid(daysAgo: number, views: number, extra: Partial<ScorableVideo> = {}): ScorableVideo {
  return {
    videoId: `v${daysAgo}_${views}`,
    title: `video ${daysAgo}d ${views}v`,
    publishedAt: NOW - daysAgo * DAY,
    views,
    durationSeconds: 600,
    ...extra,
  };
}

// ── the growing-channel problem, which is the reason this module exists ──────

check("a growing channel's old videos are not all failures", () => {
  // Modelled on the measured channel: ~5k views a year ago, ~25k now, and a
  // steady climb between. Nothing here is a genuine under-performer; every
  // video is exactly par for its moment.
  const videos: ScorableVideo[] = [];
  for (let i = 0; i < 40; i++) {
    const daysAgo = 700 - i * 17;
    const views = Math.round(4000 + i * 550); // the channel growing, not videos winning
    videos.push(vid(daysAgo, views));
  }
  const scored = scoreCatalogue(videos, NOW);
  const judged = scored.filter((v) => v.judged);

  const flatBad = judged.filter((v) => v.flatMultiple < 1).length;
  const eraBad = judged.filter((v) => v.eraMultiple < 1).length;

  assert.ok(
    flatBad >= judged.length * 0.4,
    `a flat median should condemn much of a growing channel, flagged ${flatBad}/${judged.length}`,
  );
  // Era-relative should find almost nothing wrong, because nothing IS wrong.
  assert.ok(
    eraBad <= judged.length * 0.2,
    `era-relative should not condemn a channel that merely grew, flagged ${eraBad}/${judged.length}`,
  );
});

check("a genuine old hit outranks a mediocre recent video", () => {
  // The real case this was built from: 20,946 views among peers doing ~1,500
  // reads as 2.6x on a flat median and 13.6x against its era.
  const videos: ScorableVideo[] = [];
  for (let i = 0; i < 12; i++) videos.push(vid(700 - i * 10, 1500)); // the old era
  videos.push(vid(640, 20000, { videoId: "old-hit", title: "old hit" }));
  for (let i = 0; i < 12; i++) videos.push(vid(200 - i * 10, 25000)); // the new era
  videos.push(vid(150, 26000, { videoId: "recent-par", title: "recent par" }));

  const scored = scoreCatalogue(videos, NOW);
  const hit = scored.find((v) => v.videoId === "old-hit")!;
  const par = scored.find((v) => v.videoId === "recent-par")!;

  assert.ok(hit.eraMultiple > 5, `the old hit should stand out, got ${hit.eraMultiple.toFixed(1)}x`);
  assert.ok(par.eraMultiple < 2, `a par video should not, got ${par.eraMultiple.toFixed(1)}x`);
  assert.ok(
    hit.eraMultiple > par.eraMultiple,
    "the old hit must rank above the recent par video — it is the one with something to teach",
  );
  // And the flat view gets it backwards, which is the whole point.
  assert.ok(par.flatMultiple > hit.flatMultiple, "a flat median should prefer the recent one");
});

// ── videos too young to judge ────────────────────────────────────────────────

check("a video published today is not called a failure", () => {
  const videos = [
    ...Array.from({ length: 20 }, (_, i) => vid(400 - i * 15, 8000)),
    vid(0.2, 33, { videoId: "brand-new", title: "published four hours ago" }),
  ];
  const scored = scoreCatalogue(videos, NOW);
  const fresh = scored.find((v) => v.videoId === "brand-new")!;

  assert.equal(fresh.judged, false, "too young to score");
  assert.ok(fresh.eraMultiple < 0.1, "its raw multiple is terrible, which is why judged matters");
  assert.ok(
    !underperformers(scored, "long").some((v) => v.videoId === "brand-new"),
    "and it must never be offered as a rename candidate",
  );
  assert.ok(
    scored.some((v) => v.videoId === "brand-new"),
    "it still appears in the report — hidden is not the same as unjudged",
  );
});

check("the judgement cutoff is exactly at the boundary", () => {
  const base = Array.from({ length: 20 }, (_, i) => vid(400 - i * 15, 8000));
  const scored = scoreCatalogue(
    [...base, vid(MIN_JUDGEABLE_AGE_DAYS + 0.1, 100, { videoId: "just-old-enough" }), vid(MIN_JUDGEABLE_AGE_DAYS - 0.1, 100, { videoId: "just-too-new" })],
    NOW,
  );
  assert.equal(scored.find((v) => v.videoId === "just-old-enough")!.judged, true);
  assert.equal(scored.find((v) => v.videoId === "just-too-new")!.judged, false);
});

// ── formats must never share a baseline ─────────────────────────────────────

check("Shorts and long-form are scored in separate pools", () => {
  // The measured channel: long-form median 8,089, Shorts median 905. One
  // pooled median would describe neither, and would make every Short look like
  // a catastrophe and every long-form video look like a triumph.
  const videos = [
    ...Array.from({ length: 15 }, (_, i) => vid(400 - i * 20, 8000)),
    ...Array.from({ length: 15 }, (_, i) => vid(400 - i * 20, 900, { durationSeconds: 45 })),
  ];
  const scored = scoreCatalogue(videos, NOW);
  const long = scored.filter((v) => v.format === "long");
  const short = scored.filter((v) => v.format === "short");

  assert.equal(long.length, 15);
  assert.equal(short.length, 15);
  for (const v of short) {
    assert.ok(
      Math.abs(v.eraMultiple - 1) < 0.25,
      `a typical Short must read as par among Shorts, got ${v.eraMultiple.toFixed(2)}x`,
    );
  }
  assert.equal(outliers(scored, "short").length, 0, "no Short should look like an outlier here");
});

check("a Short is anything up to three minutes", () => {
  assert.equal(formatOf(SHORTS_MAX_SECONDS), "short");
  assert.equal(formatOf(SHORTS_MAX_SECONDS + 1), "long");
  // Duration 0 means we could not read it; treat as long-form rather than
  // silently dropping the video into the Shorts pool.
  assert.equal(formatOf(0), "long");
});

// ── the mechanics ───────────────────────────────────────────────────────────

check("a video is never part of its own baseline", () => {
  // One monstrous outlier must not drag its own era up to meet it.
  const videos = [
    ...Array.from({ length: 20 }, (_, i) => vid(400 - i * 15, 5000)),
    vid(250, 1_400_000, { videoId: "monster" }),
  ];
  const scored = scoreCatalogue(videos, NOW);
  const monster = scored.find((v) => v.videoId === "monster")!;
  assert.equal(monster.eraMedian, 5000, "its peers, not itself");
  assert.ok(monster.eraMultiple > 200, `should read as enormous, got ${monster.eraMultiple.toFixed(0)}x`);
});

check("a catalogue too small for an era still scores", () => {
  const scored = scoreCatalogue([vid(100, 500), vid(50, 1500)], NOW);
  for (const v of scored) {
    assert.ok(Number.isFinite(v.eraMultiple), "must not be NaN");
    assert.ok(v.eraMedian > 0, "must fall back to the flat median rather than divide by zero");
  }
});

check("an empty catalogue is not an error", () => {
  assert.deepEqual(scoreCatalogue([], NOW), []);
  assert.equal(median([]), 0);
});

check("a channel with no views anywhere does not produce NaN", () => {
  const scored = scoreCatalogue(Array.from({ length: 5 }, (_, i) => vid(100 - i * 10, 0)), NOW);
  for (const v of scored) {
    assert.equal(v.eraMultiple, 0);
    assert.equal(v.flatMultiple, 0);
  }
});

check("median handles even and odd counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
});

check("the age curve reports the shape that motivated all this", () => {
  const videos = [
    ...Array.from({ length: 5 }, (_, i) => vid(500 + i * 20, 4700)),
    ...Array.from({ length: 5 }, (_, i) => vid(120 + i * 10, 18000)),
    ...Array.from({ length: 5 }, (_, i) => vid(40 + i * 5, 26000)),
  ];
  const curve = ageCurve(scoreCatalogue(videos, NOW), "long");
  const older = curve.find((b) => b.fromDays === 365)!;
  const mid = curve.find((b) => b.fromDays === 90)!;
  const recent = curve.find((b) => b.fromDays === 30)!;
  assert.ok(recent.medianViews > mid.medianViews, "recent should out-perform mid");
  assert.ok(mid.medianViews > older.medianViews, "mid should out-perform old");
  assert.equal(older.count, 5);
});

check("views-per-sub is a second, independent axis", () => {
  // The two disagree on purpose. This video did exactly par for its era but
  // reached ten times the channel's subscriber count — it travelled, and only
  // the reach axis can see that.
  const videos = [
    ...Array.from({ length: 20 }, (_, i) => vid(400 - i * 15, 10000)),
    vid(200, 10000, { videoId: "travelled" }),
  ];
  const scored = scoreCatalogue(videos, NOW, { subscriberCount: 1000 });
  const t = scored.find((v) => v.videoId === "travelled")!;
  assert.ok(Math.abs(t.eraMultiple - 1) < 0.2, "par for its era");
  assert.equal(t.viewsPerSub, 10, "but ten views per subscriber");

  const reach = reachOutliers(scored, "long", 5);
  assert.ok(reach.length > 0, "the reach axis should surface it");
  assert.equal(outliers(scored, "long", 2).length, 0, "the era axis should not");
});

check("views-per-sub is null when subscribers are unknown", () => {
  // Hidden subscriber counts are common. Null is honest; zero would read as
  // "this video reached nobody" and would sort to the bottom of every list.
  const scored = scoreCatalogue([vid(100, 5000), vid(50, 6000)], NOW);
  for (const v of scored) assert.equal(v.viewsPerSub, null);
  assert.equal(reachOutliers(scored, "long").length, 0, "and it is never an outlier");

  const hidden = scoreCatalogue([vid(100, 5000)], NOW, { subscriberCount: 0 });
  assert.equal(hidden[0].viewsPerSub, null, "zero subscribers must not divide by zero");
});

check("outliers and underperformers never overlap", () => {
  const videos = [
    ...Array.from({ length: 20 }, (_, i) => vid(400 - i * 15, 8000)),
    vid(200, 60000, { videoId: "hit" }),
    vid(180, 400, { videoId: "flop" }),
  ];
  const scored = scoreCatalogue(videos, NOW);
  const up = new Set(outliers(scored, "long").map((v) => v.videoId));
  const down = new Set(underperformers(scored, "long").map((v) => v.videoId));
  assert.ok(up.has("hit"));
  assert.ok(down.has("flop"));
  for (const id of up) assert.ok(!down.has(id), `${id} cannot be both`);
});

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
