/**
 * Unit checks for the persistent per-channel scheduling LEDGER + continuity:
 *   - the per-CHANNEL daily cap is enforced at the configured value (2/day);
 *   - continuity: given a ledger through day D, a new batch starts on D (topping
 *     up the partial last day to the cap) then D+1…, never before `now`, never
 *     exceeding the cap, never colliding with a seeded instant;
 *   - de-dupe: a (channelId, fileId) already in the ledger is skipped;
 *   - recordScheduled persists only what's recorded and round-trips on reload;
 *   - two different channels schedule INDEPENDENTLY.
 *
 * Pure + a throwaway ledger file (BULK_SCHEDULE_LEDGER_PATH). No network/AI. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-ledger.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSchedule,
  type ScheduleItemInput,
  type ChannelStartState,
} from "../postiz/scheduling.js";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

const TZ = "America/New_York";
const NOW = new Date("2026-06-08T12:00:00.000Z"); // Monday in June (EDT)

/** Local "YYYY-MM-DD" of a UTC ISO in a zone. */
function localDay(iso: string, timeZone = TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Count scheduled posts per local day. */
function countsByDay(isos: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const iso of isos) out[localDay(iso)] = (out[localDay(iso)] ?? 0) + 1;
  return out;
}

async function main() {
  // ── Pure-engine checks (no fs) ─────────────────────────────────────────────
  await check("cap is enforced PER CHANNEL at 2/day", () => {
    // 6 files × ONE channel, cap 2 → exactly 2 per local day across 3 days.
    const items: ScheduleItemInput[] = Array.from({ length: 6 }, (_, i) => ({
      key: `f${i}|c1`,
      platform: "tiktok" as const,
      channelId: "c1",
    }));
    const res = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 2 });
    const counts = countsByDay(res.map((r) => r.scheduledAt));
    for (const [day, n] of Object.entries(counts)) {
      assert.ok(n <= 2, `day ${day} has ${n} posts, exceeds cap 2`);
    }
    assert.equal(res.length, 6);
    // 6 posts at 2/day → 3 distinct days.
    assert.equal(Object.keys(counts).length, 3, "expected 3 distinct days at 2/day");
  });

  await check("two different channels schedule INDEPENDENTLY", () => {
    // 2 files × 2 channels, cap 2. Each channel should get both files on day one
    // (since the cap is 2/day PER CHANNEL), not bleed into each other's days.
    const items: ScheduleItemInput[] = [];
    for (const f of ["fa", "fb"]) {
      for (const c of ["c1", "c2"]) items.push({ key: `${f}|${c}`, platform: "tiktok", channelId: c });
    }
    const res = buildSchedule(items, { now: NOW, timezone: TZ, maxPerChannelPerDay: 2 });
    const byChannel = (cid: string) =>
      res.filter((r) => r.key.endsWith(`|${cid}`)).map((r) => r.scheduledAt);
    const c1 = byChannel("c1");
    const c2 = byChannel("c2");
    assert.equal(c1.length, 2);
    assert.equal(c2.length, 2);
    // Each channel's two posts both land on the SAME first day (cap 2 fits both).
    assert.equal(Object.keys(countsByDay(c1)).length, 1, "c1 spread beyond one day");
    assert.equal(Object.keys(countsByDay(c2)).length, 1, "c2 spread beyond one day");
  });

  await check("continuity: starts on the furthest day, tops it up, never collides", () => {
    // Ledger: channel c1 already has ONE post on a future day D (so cap-2 has room
    // for exactly one more on D), plus an occupied instant the engine must avoid.
    const D = "2026-06-10"; // Wed, two days out
    const occupied = new Date("2026-06-10T13:05:00.000Z").toISOString(); // an EDT slot
    const startStates: Record<string, ChannelStartState> = {
      c1: { furthestLocalDay: D, countsByLocalDay: { [D]: 1 }, occupiedInstants: [occupied] },
    };
    // Schedule 3 new posts for c1 with cap 2.
    const items: ScheduleItemInput[] = Array.from({ length: 3 }, (_, i) => ({
      key: `n${i}|c1`,
      platform: "tiktok" as const,
      channelId: "c1",
    }));
    const res = buildSchedule(items, {
      now: NOW,
      timezone: TZ,
      maxPerChannelPerDay: 2,
      channelStartStates: startStates,
    });
    const isos = res.map((r) => r.scheduledAt);
    // None before now.
    for (const iso of isos) assert.ok(new Date(iso).getTime() > NOW.getTime(), `not future: ${iso}`);
    // None on the occupied instant.
    assert.ok(!isos.includes(occupied), "collided with a seeded instant");
    // None before D (continuity starts at the furthest seeded day).
    for (const iso of isos) assert.ok(localDay(iso) >= D, `${iso} lands before furthest day ${D}`);
    // Day D gets exactly ONE new post (it already had 1; cap 2 leaves room for 1).
    const counts = countsByDay(isos);
    assert.equal(counts[D] ?? 0, 1, `expected exactly 1 new post on ${D}, got ${counts[D]}`);
    // The remaining 2 roll forward, still ≤ 2/day.
    for (const [day, n] of Object.entries(counts)) assert.ok(n <= 2, `day ${day} exceeds cap`);
    assert.equal(res.length, 3);
  });

  await check("a fully-filled last day rolls entirely to the next eligible day", () => {
    const D = "2026-06-10";
    const startStates: Record<string, ChannelStartState> = {
      c1: { furthestLocalDay: D, countsByLocalDay: { [D]: 2 } }, // already at cap
    };
    const items: ScheduleItemInput[] = [{ key: "x|c1", platform: "tiktok", channelId: "c1" }];
    const [r] = buildSchedule(items, {
      now: NOW,
      timezone: TZ,
      maxPerChannelPerDay: 2,
      channelStartStates: startStates,
    });
    assert.ok(localDay(r.scheduledAt) > D, `expected a day after ${D}, got ${localDay(r.scheduledAt)}`);
  });

  // ── Ledger persistence (throwaway file) ─────────────────────────────────────
  const ledgerFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-ledger-")),
    "ledger.json",
  );
  process.env.BULK_SCHEDULE_LEDGER_PATH = ledgerFile;
  const ledger = await import("../postiz/scheduleLedger.js");

  await check("getChannelState is empty before anything is recorded", () => {
    const s = ledger.getChannelState("chX");
    assert.equal(s.scheduledAt.length, 0);
    assert.equal(s.fileIds.size, 0);
  });

  await check("recordScheduled persists and round-trips on reload", () => {
    ledger.recordScheduled("chX", "render:a.mp4", "2026-06-09T13:00:00.000Z");
    ledger.recordScheduled("chX", "render:b.mp4", "2026-06-10T13:00:00.000Z");
    // Re-read from disk.
    const s = ledger.getChannelState("chX");
    assert.equal(s.scheduledAt.length, 2);
    assert.ok(s.fileIds.has("render:a.mp4"));
    assert.ok(s.fileIds.has("render:b.mp4"));
    // Persisted to the actual file.
    const raw = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(raw.chX.scheduledAt.length, 2);
  });

  await check("recordScheduled is idempotent on the same (channel, instant)/(channel, file)", () => {
    ledger.recordScheduled("chX", "render:a.mp4", "2026-06-09T13:00:00.000Z"); // dup
    const s = ledger.getChannelState("chX");
    assert.equal(s.scheduledAt.length, 2, "duplicate instant double-counted");
    assert.equal(s.fileIds.size, 2, "duplicate fileId double-counted");
  });

  await check("deriveChannelTimeline yields furthest day + per-day counts", () => {
    ledger.recordScheduled("chY", "render:1.mp4", "2026-06-09T13:00:00.000Z");
    ledger.recordScheduled("chY", "render:2.mp4", "2026-06-09T13:30:00.000Z");
    ledger.recordScheduled("chY", "render:3.mp4", "2026-06-11T13:00:00.000Z");
    const s = ledger.getChannelState("chY");
    const t = ledger.deriveChannelTimeline(s.scheduledAt, TZ);
    assert.equal(t.furthestLocalDay, "2026-06-11");
    assert.equal(t.countsByLocalDay["2026-06-09"], 2);
    assert.equal(t.countsByLocalDay["2026-06-11"], 1);
  });

  await check("de-dupe: a (channel, file) already in the ledger is detected", () => {
    const s = ledger.getChannelState("chX");
    // Mimics bulkScheduler's dedupe predicate.
    assert.ok(s.fileIds.has("render:a.mp4"), "should detect existing pair");
    assert.ok(!s.fileIds.has("render:new.mp4"), "should not flag a new pair");
  });

  await check("missing/corrupt ledger file degrades to empty state (never throws)", () => {
    fs.writeFileSync(ledgerFile, "{ not json");
    const s = ledger.getChannelState("chX");
    assert.equal(s.scheduledAt.length, 0);
    assert.equal(s.fileIds.size, 0);
  });

  console.log(`\n${passed} checks passed`);
}

void main();
