/**
 * Unit checks for the PURE drop sequencer (postiz/dropSequencing) and its
 * integration with the scheduling engine (postiz/scheduling):
 *   - filename → look grouping (batch suffix stripping, edge cases)
 *   - the min same-look gap is NEVER violated
 *   - the per-day cadence cap is NEVER exceeded
 *   - looks are actually MIXED (few same-look adjacencies in the day order)
 *   - deterministic given a seed; a different seed reshuffles
 *   - every video is placed exactly once
 *   - integration: all channels of one drop land on the SAME local day
 *
 * No network / no AI. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-dropseq.test.ts
 */
import assert from "node:assert/strict";
import {
  groupKeyForFilename,
  sequenceDrops,
  countLooks,
  type DropFile,
} from "../postiz/dropSequencing.js";
import { buildSchedule, type ScheduleItemInput } from "../postiz/scheduling.js";

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

// ── grouping ──────────────────────────────────────────────────────────────────
check("groupKeyForFilename strips batch numeric suffixes + extension", () => {
  assert.equal(groupKeyForFilename("SpaceFacts_12.mp4"), "spacefacts");
  assert.equal(groupKeyForFilename("SpaceFacts_1.mp4"), "spacefacts");
  assert.equal(groupKeyForFilename("Neon Loop - 3.mov"), "neon loop");
  assert.equal(groupKeyForFilename("cats (7).mp4"), "cats");
  assert.equal(groupKeyForFilename("beach.day.4.webm"), "beach.day");
  // No separable number → its own group (whole name minus extension).
  assert.equal(groupKeyForFilename("oneoff.mp4"), "oneoff");
  // Two clips of the same look share a key regardless of index width.
  assert.equal(groupKeyForFilename("Look A_2.mp4"), groupKeyForFilename("Look A_37.mp4"));
});

// ── helpers to build a fixture of N looks × M clips ───────────────────────────
function fixture(looks: number, perLook: number): DropFile[] {
  const files: DropFile[] = [];
  for (let g = 0; g < looks; g++) {
    for (let i = 0; i < perLook; i++) {
      files.push({ fileId: `look${g}_${i}`, groupId: `look${g}` });
    }
  }
  return files;
}

/** Assert the drop plan never violates the gap or the cadence. */
function assertValid(files: DropFile[], cadence: number, gap: number, seed: number) {
  const plan = sequenceDrops(files, { videosPerDay: cadence, minGapDays: gap, seed });
  // Every file placed exactly once.
  assert.equal(plan.length, files.length, "every file placed once");
  const ids = new Set(plan.map((p) => p.fileId));
  assert.equal(ids.size, files.length, "no duplicate placements");
  // Cadence: never more than `cadence` drops on a day.
  const perDay = new Map<number, number>();
  for (const p of plan) perDay.set(p.dayOffset, (perDay.get(p.dayOffset) ?? 0) + 1);
  for (const [day, n] of perDay) assert.ok(n <= cadence, `day ${day} has ${n} > cadence ${cadence}`);
  // Gap: two drops of the same look are ≥ gap days apart.
  const daysByGroup = new Map<string, number[]>();
  for (const p of plan) {
    const arr = daysByGroup.get(p.groupId) ?? [];
    arr.push(p.dayOffset);
    daysByGroup.set(p.groupId, arr);
  }
  for (const [g, days] of daysByGroup) {
    const sorted = [...days].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] - sorted[i - 1] >= gap, `look ${g}: gap ${sorted[i] - sorted[i - 1]} < ${gap}`);
    }
  }
  return plan;
}

check("gap is never violated across many looks/cadences/seeds", () => {
  for (const cadence of [1, 2, 3, 5]) {
    for (const gap of [0, 2, 3, 4]) {
      for (const seed of [1, 7, 42, 1000]) {
        assertValid(fixture(6, 20), cadence, gap, seed); // 120 clips
      }
    }
  }
});

check("a single dominant look still respects the gap (stretches the plan)", () => {
  // 50 of one look + 3 of another, gap 3 → the big look paces at 1 per 3 days.
  const files = [...fixture(1, 50).map((f) => ({ ...f, groupId: "big" })), ...fixture(1, 3).map((f) => ({ ...f, fileId: `s${f.fileId}`, groupId: "small" }))];
  const plan = assertValid(files, 2, 3, 5);
  const bigDays = plan.filter((p) => p.groupId === "big").map((p) => p.dayOffset).sort((a, b) => a - b);
  assert.ok(bigDays[bigDays.length - 1] >= 49 * 3, "big look spans ~1 per 3 days");
});

check("deterministic: same seed → identical plan; different seed reshuffles", () => {
  const files = fixture(5, 12);
  const a = sequenceDrops(files, { videosPerDay: 2, minGapDays: 3, seed: 99 });
  const b = sequenceDrops(files, { videosPerDay: 2, minGapDays: 3, seed: 99 });
  assert.deepEqual(a, b, "same seed reproduces the plan");
  const c = sequenceDrops(files, { videosPerDay: 2, minGapDays: 3, seed: 100 });
  const orderA = a.map((p) => p.fileId).join(",");
  const orderC = c.map((p) => p.fileId).join(",");
  assert.notEqual(orderA, orderC, "a different seed produces a different mix");
});

check("looks are mixed: consecutive drops rarely share a look", () => {
  // 4 looks, cadence 2, gap 0 (so the mixer, not the gap, drives adjacency).
  const plan = sequenceDrops(fixture(4, 15), { videosPerDay: 2, minGapDays: 0, seed: 3 });
  const order = [...plan].sort((a, b) => a.dayOffset - b.dayOffset || a.slot - b.slot);
  let adjacentSame = 0;
  for (let i = 1; i < order.length; i++) if (order[i].groupId === order[i - 1].groupId) adjacentSame++;
  // With 4 balanced looks the mixer should keep same-look adjacency very low.
  assert.ok(adjacentSame <= 3, `too many same-look adjacencies: ${adjacentSame}`);
});

check("startDayOffset shifts the whole plan forward (ledger continuity)", () => {
  const plan = sequenceDrops(fixture(3, 6), { videosPerDay: 2, minGapDays: 3, seed: 1, startDayOffset: 10 });
  assert.ok(Math.min(...plan.map((p) => p.dayOffset)) >= 10, "no drop before startDayOffset");
});

check("countLooks counts distinct groups", () => {
  assert.equal(countLooks(fixture(7, 3)), 7);
});

// ── integration with buildSchedule: same 24h across channels ──────────────────
const NOW = new Date("2026-06-08T12:00:00.000Z"); // a Monday, EDT

/** Local "YYYY-MM-DD" of an ISO instant in TZ. */
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

check("pinnedLocalDay: every channel of one drop posts on the SAME local day", () => {
  // One file → three channels (different platforms), all pinned to 2026-06-15.
  const pin = "2026-06-15";
  const items: ScheduleItemInput[] = [
    { key: "f1|tt", platform: "tiktok", channelId: "tt", pinnedLocalDay: pin },
    { key: "f1|ig", platform: "instagram", channelId: "ig", pinnedLocalDay: pin },
    { key: "f1|yt", platform: "youtube", channelId: "yt", pinnedLocalDay: pin },
  ];
  const res = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 2, seed: 5 });
  for (const r of res) assert.equal(localDay(r.scheduledAt), pin, `${r.key} not on pinned day`);
});

check("seed jitter keeps posts inside the platform window but off :00 sometimes", () => {
  // Schedule the same youtube item under several seeds; minutes should vary and
  // always fall inside the 15:00–17:00 (or other youtube) window hours.
  const mins = new Set<number>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const [r] = buildSchedule([{ key: "f|c", platform: "youtube", channelId: "c", pinnedLocalDay: "2026-06-15" }], {
      now: NOW,
      timezone: TZ,
      maxPerChannelPerDay: 2,
      seed,
    });
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(r.scheduledAt));
    const hh = Number(parts.find((p) => p.type === "hour")?.value);
    const mm = Number(parts.find((p) => p.type === "minute")?.value);
    mins.add(mm);
    assert.ok(hh >= 12 && hh < 22, `hour ${hh} outside youtube windows`);
  }
  assert.ok(mins.size > 1, "jitter should produce more than one distinct minute across seeds");
});

check("no seed → deterministic legacy placement (window start :00)", () => {
  const [r] = buildSchedule([{ key: "f|c", platform: "youtube", channelId: "c" }], { now: NOW, timezone: TZ });
  const mm = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(r.scheduledAt))
    .find((p) => p.type === "minute")?.value;
  assert.equal(Number(mm), 0, "legacy path places at the window's :00");
});

console.log(`\n${passed} checks passed.`);
