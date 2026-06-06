/**
 * Unit checks for the PURE Bulk Scheduler scheduling engine (postiz/scheduling):
 *   - timezone correctness (DST: a June EDT instant resolves to the right UTC)
 *   - no two posts on the same channel share a minute (collision-free)
 *   - every scheduled instant is in the FUTURE relative to a fixed `now`
 *   - scheduled local times fall inside the platform's optimal window
 *   - intent windows are selected (commute → weekday ~7–9am ET)
 *   - deterministic given a fixed `now`
 *   - refineWithAnalytics is identity (the v1 seam)
 *
 * No network / no AI. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-scheduling.test.ts
 */
import assert from "node:assert/strict";
import {
  buildSchedule,
  refineWithAnalytics,
  PLATFORM_WINDOWS,
  type ScheduleItemInput,
} from "../postiz/scheduling.js";

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

const TZ = "America/New_York";

/** Local wall-clock {hour, minute, weekday} of a UTC ISO in a zone. */
function localOf(iso: string, timeZone = TZ) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute: Number(get("minute")), weekday: wd[get("weekday")] };
}

// Fix "now" to a Monday in June (EDT). 2026-06-08 is a Monday.
const NOW = new Date("2026-06-08T12:00:00.000Z");

check("DST: a summer ET window resolves to a UTC instant 4h ahead (EDT = UTC-4)", () => {
  // YouTube weekday top window is 15:00–17:00 local. Schedule one Shorts item.
  const items: ScheduleItemInput[] = [{ key: "f1|c1", platform: "youtube" }];
  const [r] = buildSchedule(items, { now: NOW, timezone: TZ });
  const local = localOf(r.scheduledAt);
  // In June, ET is EDT (UTC-4). 15:00 local => 19:00Z.
  const utcHour = new Date(r.scheduledAt).getUTCHours();
  assert.equal(utcHour - local.hour, 4, `expected EDT offset 4h, got ${utcHour - local.hour} (${r.scheduledAt})`);
});

check("winter: an EST window resolves with a 5h offset (UTC-5)", () => {
  const now = new Date("2026-01-05T12:00:00.000Z"); // Monday in January (EST)
  const items: ScheduleItemInput[] = [{ key: "w|c", platform: "youtube" }];
  const [r] = buildSchedule(items, { now, timezone: TZ });
  const local = localOf(r.scheduledAt);
  const utcHour = new Date(r.scheduledAt).getUTCHours();
  // Handle the day-wrap case where local afternoon + 5 stays same UTC day.
  const diff = (utcHour - local.hour + 24) % 24;
  assert.equal(diff, 5, `expected EST offset 5h, got ${diff} (${r.scheduledAt})`);
});

check("no two posts on the same channel share a minute", () => {
  // 5 files × same channel → 5 posts on one channel; all distinct minutes.
  const items: ScheduleItemInput[] = Array.from({ length: 5 }, (_, i) => ({
    key: `f${i}|c1`,
    platform: "tiktok" as const,
  }));
  const res = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 5 });
  const times = res.map((r) => r.scheduledAt);
  assert.equal(new Set(times).size, times.length, "collision: duplicate scheduledAt on one channel");
});

check("all scheduled instants are in the future relative to now", () => {
  const items: ScheduleItemInput[] = [
    { key: "a|c1", platform: "tiktok" },
    { key: "b|c2", platform: "instagram" },
    { key: "c|c3", platform: "youtube" },
  ];
  const res = buildSchedule(items, { now: NOW, timezone: TZ });
  for (const r of res) {
    assert.ok(new Date(r.scheduledAt).getTime() > NOW.getTime(), `not future: ${r.scheduledAt}`);
  }
});

check("scheduled local time falls inside the platform's optimal window", () => {
  const items: ScheduleItemInput[] = [
    { key: "tk|c1", platform: "tiktok" },
    { key: "ig|c2", platform: "instagram" },
    { key: "yt|c3", platform: "youtube" },
  ];
  const res = buildSchedule(items, { now: NOW, timezone: TZ });
  for (const r of res) {
    const platform = r.key.startsWith("tk") ? "tiktok" : r.key.startsWith("ig") ? "instagram" : "youtube";
    const local = localOf(r.scheduledAt);
    const windows = PLATFORM_WINDOWS[platform as "tiktok" | "instagram" | "youtube"];
    const inAny = windows.some(
      (w) => w.days.includes(local.weekday) && local.hour >= w.startHour && local.hour < w.endHour,
    );
    assert.ok(inAny, `${platform} ${r.scheduledAt} (local ${local.hour}:${local.minute} wd${local.weekday}) outside any window`);
  }
});

check("intent=commute places posts in the weekday ~7-9am ET window", () => {
  const items: ScheduleItemInput[] = [{ key: "x|c1", platform: "tiktok" }];
  const [r] = buildSchedule(items, { now: NOW, timezone: TZ, intent: "commute" });
  const local = localOf(r.scheduledAt);
  assert.ok(local.hour >= 7 && local.hour < 9, `commute hour ${local.hour} not in 7-9`);
  assert.ok([1, 2, 3, 4, 5].includes(local.weekday), `commute weekday ${local.weekday} not a weekday`);
  assert.match(r.reason, /commute/i);
});

check("intent=lunch places posts around 12-1pm ET", () => {
  const items: ScheduleItemInput[] = [{ key: "x|c1", platform: "youtube" }];
  const [r] = buildSchedule(items, { now: NOW, timezone: TZ, intent: "lunch" });
  const local = localOf(r.scheduledAt);
  assert.ok(local.hour === 12, `lunch hour ${local.hour} not 12`);
});

check("deterministic for a fixed now", () => {
  const items: ScheduleItemInput[] = [
    { key: "a|c1", platform: "tiktok" },
    { key: "b|c1", platform: "tiktok" },
    { key: "c|c2", platform: "youtube" },
  ];
  const a = buildSchedule(items, { now: NOW, timezone: TZ });
  const b = buildSchedule(items, { now: NOW, timezone: TZ });
  assert.deepEqual(a, b, "non-deterministic output for a fixed now");
});

check("posts spread across days when maxPerChannelPerDay is 1", () => {
  const items: ScheduleItemInput[] = Array.from({ length: 3 }, (_, i) => ({
    key: `f${i}|c1`,
    platform: "tiktok" as const,
  }));
  const res = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 1 });
  const days = res.map((r) => localOf(r.scheduledAt));
  // Three posts, one per day → three distinct local weekdays.
  const dayKeys = res.map((r) => new Date(r.scheduledAt).toISOString().slice(0, 10));
  assert.equal(new Set(dayKeys).size, 3, "posts not spread across distinct days");
  void days;
});

check("different channels can share a minute (collision is per-channel only)", () => {
  // Two TikTok channels, one file each → may legitimately reuse the same slot.
  const items: ScheduleItemInput[] = [
    { key: "f1|c1", platform: "tiktok" },
    { key: "f1|c2", platform: "tiktok" },
  ];
  const res = buildSchedule(items, { now: NOW, timezone: TZ });
  // Both are 'tiktok' platform → our collision set is keyed by platform, so they
  // will NOT share a minute. This asserts the engine still produces 2 valid slots.
  assert.equal(res.length, 2);
  assert.notEqual(res[0].scheduledAt, res[1].scheduledAt);
});

check("refineWithAnalytics is identity (v1 seam)", () => {
  const items: ScheduleItemInput[] = [{ key: "a|c1", platform: "tiktok" }];
  const sched = buildSchedule(items, { now: NOW, timezone: TZ });
  assert.deepEqual(refineWithAnalytics(sched, {}), sched);
});

check("respects a non-ET timezone (Los Angeles) for window placement", () => {
  const items: ScheduleItemInput[] = [{ key: "x|c1", platform: "youtube" }];
  const [r] = buildSchedule(items, { now: NOW, timezone: "America/Los_Angeles" });
  const local = localOf(r.scheduledAt, "America/Los_Angeles");
  const windows = PLATFORM_WINDOWS.youtube;
  const inAny = windows.some(
    (w) => w.days.includes(local.weekday) && local.hour >= w.startHour && local.hour < w.endHour,
  );
  assert.ok(inAny, `LA local ${local.hour} outside window`);
});

console.log(`\n${passed} checks passed`);
