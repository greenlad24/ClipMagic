/**
 * Unit checks for WARM-UP MODE — the ramping cadence in postiz/dropSequencing:
 *   - the ramp's phase boundaries land on the exact days the spec calls for
 *   - phase 1 is 3 drops a WEEK on a fixed rhythm (rest days are truly closed)
 *   - phases 2 and 3 are 1/day and 2/day
 *   - the ramp is relative to the PLAN's first day, not the epoch
 *   - packing under a ramp still places every video once, honors the same-look
 *     gap, and never exceeds a day's capacity
 *   - a flat cadence (no ramp) behaves exactly as before
 *   - integration: the per-channel day cap clears the ramp's busiest day, so a
 *     drop's whole cohort still lands on ONE local day
 *   - a degenerate ramp degrades instead of spinning forever
 *
 * No network / no AI. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-warmup.test.ts
 */
import assert from "node:assert/strict";
import { buildSchedule, type ScheduleItemInput } from "../postiz/scheduling.js";
import {
  sequenceDrops,
  rampCapacityFn,
  rampPeakPerDay,
  rampDaysToClear,
  WARM_UP_RAMP,
  type CadencePhase,
  type DropFile,
} from "../postiz/dropSequencing.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

/** Capacity totals per 7-day week, for `weeks` weeks starting at `startDay`. */
function weeklyTotals(ramp: readonly CadencePhase[], weeks: number, startDay = 0): number[] {
  const cap = rampCapacityFn(ramp, startDay);
  const out: number[] = [];
  for (let w = 0; w < weeks; w++) {
    let total = 0;
    for (let d = 0; d < 7; d++) total += cap(startDay + w * 7 + d);
    out.push(total);
  }
  return out;
}

function fixture(looks: number, perLook: number): DropFile[] {
  const files: DropFile[] = [];
  for (let g = 0; g < looks; g++) {
    for (let i = 0; i < perLook; i++) files.push({ fileId: `look${g}_${i}`, groupId: `look${g}` });
  }
  return files;
}

// ── the ramp itself ───────────────────────────────────────────────────────────
check("warm-up ramp: 3/week for 4 weeks, then 1/day for 4, then 2/day", () => {
  assert.deepEqual(weeklyTotals(WARM_UP_RAMP, 12), [3, 3, 3, 3, 7, 7, 7, 7, 14, 14, 14, 14]);
});

check("phase boundaries are exact (day 27|28 and day 55|56)", () => {
  const cap = rampCapacityFn(WARM_UP_RAMP, 0);
  // Last week of phase 1 still has closed days; the first day of phase 2 does not.
  assert.equal(weeklyTotals(WARM_UP_RAMP, 4).reduce((a, b) => a + b, 0), 12, "4 weeks = 12 drops");
  assert.equal(cap(28), 1, "day 28 opens phase 2 at 1/day");
  assert.equal(cap(55), 1, "day 55 is still phase 2");
  assert.equal(cap(56), 2, "day 56 opens phase 3 at 2/day");
  assert.equal(cap(400), 2, "the final phase runs forever");
});

check("phase 1 is a fixed weekly rhythm, not 3 days clumped together", () => {
  const cap = rampCapacityFn(WARM_UP_RAMP, 0);
  const week = [0, 1, 2, 3, 4, 5, 6].map((d) => cap(d));
  assert.deepEqual(week, [1, 0, 1, 0, 1, 0, 0], "3/week lands on days 0, 2, 4");
  // The same shape repeats every week of the phase — that predictability is the point.
  for (let w = 0; w < 4; w++) {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((d) => cap(w * 7 + d)), week, `week ${w + 1} differs`);
  }
});

check("the ramp is relative to the plan's first day, not day 0", () => {
  const cap = rampCapacityFn(WARM_UP_RAMP, 10);
  assert.equal(cap(9), 0, "days before the start hold nothing");
  assert.equal(cap(10), 1, "the plan's first day opens phase 1");
  assert.deepEqual(weeklyTotals(WARM_UP_RAMP, 12, 10), [3, 3, 3, 3, 7, 7, 7, 7, 14, 14, 14, 14]);
  assert.equal(cap(10 + 56), 2, "phase 3 still opens 56 days into the PLAN");
});

check("rampPeakPerDay reports the busiest day (the per-channel cap must clear it)", () => {
  assert.equal(rampPeakPerDay(WARM_UP_RAMP), 2);
  assert.equal(rampPeakPerDay([{ weeks: 1, perWeek: 3 }, { perDay: 5 }]), 5);
});

check("rampDaysToClear agrees with the capacity it is derived from", () => {
  for (const count of [1, 3, 12, 40, 100, 227]) {
    const days = rampDaysToClear(count, WARM_UP_RAMP);
    const cap = rampCapacityFn(WARM_UP_RAMP, 0);
    let sum = 0;
    for (let d = 0; d < days; d++) sum += cap(d);
    assert.ok(sum >= count, `${count} videos: ${days} days only holds ${sum}`);
    let sumBefore = 0;
    for (let d = 0; d < days - 1; d++) sumBefore += cap(d);
    assert.ok(sumBefore < count, `${count} videos: ${days} days is not the earliest`);
  }
});

check("a 227-video batch reaches the daily phases (warm-up alone would take years)", () => {
  // 12 in weeks 1–4 and 28 in weeks 5–8, so anything bigger than 40 must ramp.
  assert.equal(rampDaysToClear(40, WARM_UP_RAMP), 56, "40 videos exactly fills the first 8 weeks");
  const days = rampDaysToClear(227, WARM_UP_RAMP);
  assert.ok(days > 56 && days < 200, `227 videos should land past the ramp but inside a season, got ${days}`);
});

// ── packing under a ramp ──────────────────────────────────────────────────────
check("packing never exceeds a day's capacity and closes rest days", () => {
  const files = fixture(6, 20); // 120 videos
  const assignments = sequenceDrops(files, {
    videosPerDay: 8, // must be ignored in favour of the ramp
    minGapDays: 0,
    seed: 7,
    startDayOffset: 3,
    ramp: WARM_UP_RAMP,
  });
  const cap = rampCapacityFn(WARM_UP_RAMP, 3);
  const perDay = new Map<number, number>();
  for (const a of assignments) perDay.set(a.dayOffset, (perDay.get(a.dayOffset) ?? 0) + 1);
  for (const [day, n] of perDay) {
    assert.ok(day >= 3, `day ${day} is before the plan's start`);
    assert.ok(n <= cap(day), `day ${day} holds ${n} but capacity is ${cap(day)}`);
    assert.ok(cap(day) > 0, `day ${day} is a rest day and must hold nothing`);
  }
});

check("packing under a ramp places every video exactly once", () => {
  const files = fixture(5, 25);
  const assignments = sequenceDrops(files, {
    videosPerDay: 2,
    minGapDays: 3,
    seed: 4242,
    startDayOffset: 1,
    ramp: WARM_UP_RAMP,
  });
  assert.equal(assignments.length, files.length);
  assert.equal(new Set(assignments.map((a) => a.fileId)).size, files.length);
});

check("the same-look gap still holds under a ramp", () => {
  const gap = 3;
  const files = fixture(4, 15);
  const assignments = sequenceDrops(files, {
    videosPerDay: 2,
    minGapDays: gap,
    seed: 11,
    startDayOffset: 1,
    ramp: WARM_UP_RAMP,
  });
  const days = new Map<string, number[]>();
  for (const a of assignments) days.set(a.groupId, [...(days.get(a.groupId) ?? []), a.dayOffset]);
  for (const [look, ds] of days) {
    const sorted = [...ds].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] - sorted[i - 1] >= gap, `${look}: ${sorted[i - 1]} → ${sorted[i]} breaks the ${gap}d gap`);
    }
  }
});

check("slots are contiguous within a day (0..capacity-1)", () => {
  const assignments = sequenceDrops(fixture(4, 20), {
    videosPerDay: 2,
    minGapDays: 0,
    seed: 3,
    startDayOffset: 1,
    ramp: WARM_UP_RAMP,
  });
  const byDay = new Map<number, number[]>();
  for (const a of assignments) byDay.set(a.dayOffset, [...(byDay.get(a.dayOffset) ?? []), a.slot]);
  for (const [day, slots] of byDay) {
    const sorted = [...slots].sort((x, y) => x - y);
    assert.deepEqual(sorted, sorted.map((_, i) => i), `day ${day} has non-contiguous slots ${slots}`);
  }
});

check("same seed → same warm-up plan; a new seed reshuffles", () => {
  const files = fixture(5, 12);
  const opts = { videosPerDay: 2, minGapDays: 2, startDayOffset: 1, ramp: WARM_UP_RAMP };
  const a = sequenceDrops(files, { ...opts, seed: 1 });
  const b = sequenceDrops(files, { ...opts, seed: 1 });
  const c = sequenceDrops(files, { ...opts, seed: 2 });
  assert.deepEqual(a, b, "same seed must reproduce the plan");
  assert.notDeepEqual(a.map((x) => x.fileId), c.map((x) => x.fileId), "a new seed should reshuffle");
});

// ── the flat path is untouched ────────────────────────────────────────────────
check("no ramp → the original flat cadence, unchanged", () => {
  const files = fixture(4, 10);
  const opts = { videosPerDay: 3, minGapDays: 2, seed: 9, startDayOffset: 1 };
  const flat = sequenceDrops(files, opts);
  const perDay = new Map<number, number>();
  for (const a of flat) perDay.set(a.dayOffset, (perDay.get(a.dayOffset) ?? 0) + 1);
  for (const [day, n] of perDay) assert.ok(n <= 3, `day ${day} holds ${n} > 3`);
  // An explicitly empty ramp is the same as none at all.
  assert.deepEqual(sequenceDrops(files, { ...opts, ramp: [] }), flat);
});

check("a degenerate ramp degrades to 1/day instead of spinning forever", () => {
  const files = fixture(2, 6);
  const assignments = sequenceDrops(files, {
    videosPerDay: 2,
    minGapDays: 0,
    seed: 1,
    startDayOffset: 0,
    ramp: [{ perWeek: 0 }],
  });
  assert.equal(assignments.length, files.length, "every video must still be placed");
  const perDay = new Map<number, number>();
  for (const a of assignments) perDay.set(a.dayOffset, (perDay.get(a.dayOffset) ?? 0) + 1);
  for (const [, n] of perDay) assert.equal(n, 1, "a capless phase falls back to 1/day");
});

check("fixedOrder (Randomize) is respected under a ramp", () => {
  const files = fixture(3, 6);
  const order = [...files].reverse().map((f) => f.fileId);
  const assignments = sequenceDrops(files, {
    videosPerDay: 2,
    minGapDays: 0,
    seed: 5,
    startDayOffset: 1,
    ramp: WARM_UP_RAMP,
    fixedOrder: order,
  });
  assert.deepEqual([...assignments].sort((a, b) => a.order - b.order).map((a) => a.fileId), order);
});

// ── integration with the scheduling engine ────────────────────────────────────
const TZ = "America/New_York";
const NOW = new Date("2026-06-10T12:00:00Z");

/** Local "YYYY-MM-DD" of an instant in TZ. */
function localDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

check("warm-up: every channel of one drop still lands on the SAME local day", () => {
  // The real failure mode: phase 3 puts 2 drops on a day, and if the engine's
  // per-channel cap were left at the phase-1 rate (1) the second drop would be
  // pushed to the next day for SOME channels only — splitting the cohort.
  const files = fixture(4, 20); // 80 videos, deep into phase 3
  const startDayOffset = 1;
  const assignments = sequenceDrops(files, {
    videosPerDay: 1,
    minGapDays: 0,
    seed: 21,
    startDayOffset,
    ramp: WARM_UP_RAMP,
  });
  const today = localDay(NOW.toISOString());
  const pinnedFor = new Map(assignments.map((a) => [a.fileId, addDays(today, a.dayOffset)]));

  const channels = ["fb", "ig", "yt", "tt"] as const;
  const platforms = ["generic", "instagram", "youtube", "tiktok"] as const;
  const items: ScheduleItemInput[] = [];
  for (const f of files) {
    for (let i = 0; i < channels.length; i++) {
      items.push({
        key: `${f.fileId}|${channels[i]}`,
        platform: platforms[i],
        channelId: channels[i],
        pinnedLocalDay: pinnedFor.get(f.fileId),
      });
    }
  }
  const results = buildSchedule(items, {
    now: NOW,
    timezone: TZ,
    maxPerChannelPerDay: rampPeakPerDay(WARM_UP_RAMP), // must clear the busiest phase
    seed: 21,
  });
  assert.equal(results.length, items.length, "every item must be placed");

  const dayByFile = new Map<string, Set<string>>();
  for (const r of results) {
    const fileId = r.key.split("|")[0];
    const set = dayByFile.get(fileId) ?? new Set<string>();
    set.add(localDay(r.scheduledAt));
    dayByFile.set(fileId, set);
  }
  for (const [fileId, days] of dayByFile) {
    assert.equal(days.size, 1, `${fileId} split across ${[...days].join(", ")}`);
    assert.equal([...days][0], pinnedFor.get(fileId), `${fileId} did not land on its pinned day`);
  }
});

check("warm-up: a too-small per-channel cap is what would split a cohort", () => {
  // Guards the reason peakPerDay exists: pin two drops to one day and cap the
  // channel at 1, and the engine legitimately rolls the second forward. If this
  // ever stops splitting, the cap above stopped being load-bearing.
  const today = localDay(NOW.toISOString());
  const day = addDays(today, 3);
  const items: ScheduleItemInput[] = ["a", "b"].map((f) => ({
    key: `${f}|ig`,
    platform: "instagram",
    channelId: "ig",
    pinnedLocalDay: day,
  }));
  const capped = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 1, seed: 3 });
  assert.notEqual(localDay(capped[0].scheduledAt), localDay(capped[1].scheduledAt), "cap 1 should split them");
  const ok = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 2, seed: 3 });
  assert.equal(localDay(ok[0].scheduledAt), localDay(ok[1].scheduledAt), "cap 2 should hold them together");
});

console.log(`\n${passed} checks passed.`);
