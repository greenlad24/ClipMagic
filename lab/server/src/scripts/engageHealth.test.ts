/**
 * Unit checks for the autonomous poster's heartbeat and wedge detection
 * (skool/engageSchedule):
 *   - describeLockHold()  busy vs. wedged, and the wording an operator reads
 *   - schedulerHealth()   safe shape on a database that has never ticked
 *   - the heartbeat       written by a cycle that did nothing at all
 *   - the overlap guard   refuses a second cycle, and SAYS WHY
 *
 * ⚠️ THE POINT OF THESE IS THAT A DEAD SCHEDULER LOOKS EXACTLY LIKE A QUIET
 * ONE. A tick with nothing due logs nothing and writes nothing, so no other
 * assertion in this repo can tell "armed and idle" from "stopped three days
 * ago". Everything here is about making that difference observable.
 *
 * Runs against a throwaway DATA_DIR, so importing engageSchedule (which opens
 * the sqlite db via db/index) never touches real lab data — and the schedule in
 * a fresh database is OFF, which is what keeps `tickNow` from reaching the
 * network or the browser. Run:
 *   cd lab/server && npx tsx src/scripts/engageHealth.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-engage-health-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const sched = await import("../skool/engageSchedule.js");
  const { db } = await import("../db/index.js");
  const { STUCK_AFTER_MS, describeLockHold, schedulerHealth, tickNow, getSchedule } = sched;

  /* ── the pure judgement ── */

  await check("describeLockHold: a cycle inside the limit is busy, not wedged", () => {
    const r = describeLockHold(90_000);
    assert.equal(r.wedged, false);
    assert.match(r.detail, /running for 90s/);
  });

  await check("describeLockHold: the boundary itself is NOT wedged", () => {
    // A cycle that has run for exactly the limit is still allowed to finish —
    // otherwise the threshold would fire on the tick that legitimately reaches
    // it, and a slow-but-working publish would be reported as a dead one.
    assert.equal(describeLockHold(STUCK_AFTER_MS).wedged, false);
    assert.equal(describeLockHold(STUCK_AFTER_MS + 1).wedged, true);
  });

  await check("describeLockHold: a wedged cycle names the consequence, not just the fact", () => {
    const r = describeLockHold(4 * 3600_000);
    assert.equal(r.wedged, true);
    assert.match(r.detail, /WEDGED/);
    assert.match(r.detail, /240 min/);
    // The operator must be told that posting has STOPPED and that a restart is
    // the fix; "a cycle is taking a while" would send them away reassured.
    assert.match(r.detail, /nothing can post/);
    assert.match(r.detail, /restarted/);
  });

  /* ── the stored heartbeat ── */

  await check("the migration reaches an existing database, not just a fresh one", () => {
    const cols = (db.prepare("PRAGMA table_info(skool_settings)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.ok(cols.includes("engage_tick_json"), `engage_tick_json missing from: ${cols.join(", ")}`);
  });

  await check("schedulerHealth: a database that has never ticked reports nulls, not zeroes", () => {
    const h = schedulerHealth();
    // ⚠️ null, NOT 0. Epoch would render as 1 Jan 1970 and read as "ticked long
    // ago" — the same shape as a scheduler that died in 1970, which is exactly
    // the confusion this field exists to prevent.
    assert.equal(h.lastStartedAt, null);
    assert.equal(h.lastFinishedAt, null);
    assert.equal(h.runningSinceMs, null);
    assert.equal(h.stuck, false);
    assert.equal(h.armed, false, "the loop was never started in this process");
    assert.equal(h.intervalMs, 600_000);
  });

  await check("the schedule in a fresh database is OFF (this is what keeps the test offline)", () => {
    assert.equal(getSchedule().enabled, false);
  });

  await check("a cycle that does nothing still leaves a heartbeat", async () => {
    const before = Date.now();
    const r = await tickNow("https://www.skool.com/example");
    assert.equal(r.started, true);
    // The schedule is off, so the tick declined to do anything...
    assert.ok(r.result?.skipped, "expected the disabled schedule to skip");
    assert.deepEqual(r.result?.processed, []);
    // ...and that is precisely the case that must still be recorded.
    const h = schedulerHealth();
    assert.ok(h.lastStartedAt !== null && h.lastStartedAt >= before);
    assert.ok(h.lastFinishedAt !== null && h.lastFinishedAt >= h.lastStartedAt);
    assert.equal(h.runningSinceMs, null, "the lock must be released once the cycle ends");
  });

  await check("the heartbeat survives a reopened database (it is on disk, not in memory)", () => {
    const Database = db.constructor as new (p: string) => { prepare: (s: string) => { get: () => unknown } };
    const fresh = new Database(String(process.env.DB_PATH));
    const row = fresh.prepare("SELECT engage_tick_json AS j FROM skool_settings WHERE id = 1").get() as
      | { j?: string }
      | undefined;
    const stored = JSON.parse(row?.j || "{}") as { lastFinishedAt?: number };
    assert.ok(typeof stored.lastFinishedAt === "number", "a restart must be able to read the last heartbeat");
  });

  /* ── the overlap guard ── */

  await check("a second cycle is refused WITH A REASON while one is in flight", async () => {
    // Not awaited: tickNow takes the lock synchronously before its first await,
    // so the second call below lands while the first is still running.
    const first = tickNow("https://www.skool.com/example");
    const second = await tickNow("https://www.skool.com/example");
    assert.equal(second.started, false);
    assert.equal(second.result, null);
    // ⚠️ The refusal must carry a detail. A bare `started: false` is what made
    // the wedge invisible from the "Run now" button in the first place.
    assert.match(String(second.detail), /running for/);
    await first;
  });

  await check("the in-flight cycle is visible in health while it runs", async () => {
    const first = tickNow("https://www.skool.com/example");
    const h = schedulerHealth();
    assert.ok(h.runningSinceMs !== null, "a running cycle must be observable, not just guarded");
    assert.equal(h.stuck, false);
    await first;
    assert.equal(schedulerHealth().runningSinceMs, null);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
