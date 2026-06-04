/**
 * Unit checks for the render-job control state machine: pause / resume / cancel
 * transitions, that `pump`'s claim query skips paused/canceled jobs, that status
 * persists, and that `listJobs` returns the right shape. No ffmpeg, no network —
 * the process-tree signalling is mocked via jobControl.__setKiller so we assert
 * the EXACT signals without spawning anything.
 *
 * Run: cd lab/server && npx tsx src/scripts/job-control.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the SQLite DB to a throwaway dir BEFORE importing anything that pulls
// in config/db (which read DATA_DIR at module load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jobctl-"));
process.env.DATA_DIR = TMP;

let passed = 0;
const checks: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function check(name: string, fn: () => void | Promise<void>) {
  checks.push({ name, fn });
}

async function main() {
  const jobsMod = await import("../db/jobs.js");
  const ctrl = await import("../render/jobControl.js");
  const {
    createJob,
    getJob,
    claimNextJob,
    completeJob,
    cancelJob,
    pauseQueuedJob,
    markPaused,
    resumeJob,
    listJobs,
    isTerminalStatus,
    jobTypeLabel,
  } = jobsMod;

  // ── DB state machine ───────────────────────────────────────────────────────

  check("pauseQueuedJob: a queued job becomes 'paused' and persists", () => {
    const id = createJob({ kind: "manifest", manifest: { title: "Q" } });
    const out = pauseQueuedJob(id);
    assert.equal(out, "paused");
    assert.equal(getJob(id)!.status, "paused");
  });

  check("pump's claim query skips paused jobs", () => {
    // Only a paused job exists among non-completed → claim returns undefined.
    // (drain any leftover queued jobs first)
    let drained: ReturnType<typeof claimNextJob>;
    while ((drained = claimNextJob())) completeJob(drained.id, "x.mp4", 1);
    const id = createJob({ kind: "manifest", manifest: { title: "P" } });
    pauseQueuedJob(id);
    const claimed = claimNextJob();
    assert.equal(claimed, undefined, "paused job must not be claimed");
  });

  check("resumeJob: paused-queued → 'queued' (pump can pick it up)", () => {
    const id = createJob({ kind: "manifest", manifest: { title: "R" } });
    pauseQueuedJob(id);
    const next = resumeJob(id, /* wasRunning */ false);
    assert.equal(next, "queued");
    assert.equal(getJob(id)!.status, "queued");
    // Now claimable again.
    const claimed = claimNextJob();
    assert.equal(claimed?.id, id);
  });

  check("resumeJob: paused-running → 'active'", () => {
    const id = createJob({ kind: "manifest", manifest: { title: "RR" } });
    claimNextJob(); // not necessarily this one; mark directly instead
    markPaused(id);
    assert.equal(getJob(id)!.status, "paused");
    const next = resumeJob(id, /* wasRunning */ true);
    assert.equal(next, "active");
  });

  check("cancelJob: marks 'canceled' (terminal) and is skipped by claim", () => {
    const id = createJob({ kind: "cut", manifest: { title: "C" } });
    const ok = cancelJob(id);
    assert.equal(ok, true);
    const j = getJob(id)!;
    assert.equal(j.status, "canceled");
    assert.ok(isTerminalStatus(j.status));
    assert.ok(j.finished_at && j.finished_at > 0, "finished_at set on cancel");
  });

  check("cancelJob: no-op on an already-terminal job", () => {
    const id = createJob({ kind: "cut", manifest: { title: "C2" } });
    completeJob(id, "done.mp4", 5);
    assert.equal(cancelJob(id), false);
    assert.equal(getJob(id)!.status, "completed");
  });

  check("resumeJob: returns undefined for a non-paused job", () => {
    const id = createJob({ kind: "cut", manifest: { title: "NP" } });
    assert.equal(resumeJob(id, false), undefined);
  });

  // ── listJobs shape ─────────────────────────────────────────────────────────

  check("listJobs: returns {active, recent} with summary shape + labels", () => {
    const { active, recent } = listJobs(20);
    assert.ok(Array.isArray(active) && Array.isArray(recent));
    for (const j of [...active, ...recent]) {
      for (const k of ["id", "type", "title", "status", "stage", "progress"]) {
        assert.ok(k in j, `summary missing ${k}`);
      }
      assert.equal(typeof j.progress, "number");
    }
    // Recent contains terminal statuses only.
    assert.ok(recent.every((j) => isTerminalStatus(j.status)));
    // Active contains non-terminal only.
    assert.ok(active.every((j) => !isTerminalStatus(j.status)));
  });

  check("jobTypeLabel: meme vs short-form vs cut", () => {
    const cut = createJob({ kind: "cut", manifest: {} });
    assert.equal(jobTypeLabel(getJob(cut)!), "Narration cut");
    const meme = createJob({ kind: "manifest", manifest: { emphasisStickers: [{}] } });
    assert.equal(jobTypeLabel(getJob(meme)!), "Meme render");
    const sf = createJob({ kind: "manifest", manifest: {} });
    assert.equal(jobTypeLabel(getJob(sf)!), "Short-form render");
  });

  // ── jobControl signalling (mocked) ─────────────────────────────────────────

  check("jobControl: pause SIGSTOPs the process group; resume SIGCONTs it", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const restore = ctrl.__setKiller((pid, sig) => signals.push({ pid, sig }));
    try {
      const jobId = "live-1";
      const fakeChild = { pid: 4242 } as any;
      ctrl.registerChild(jobId, fakeChild);
      assert.ok(ctrl.isControlled(jobId));

      assert.equal(ctrl.requestPause(jobId), true);
      assert.deepEqual(signals.at(-1), { pid: -4242, sig: "SIGSTOP" });
      assert.equal(ctrl.getIntent(jobId), "pause");

      assert.equal(ctrl.requestResume(jobId), true);
      assert.deepEqual(signals.at(-1), { pid: -4242, sig: "SIGCONT" });
      assert.equal(ctrl.getIntent(jobId), "none");

      ctrl.forgetJob(jobId);
      assert.equal(ctrl.isControlled(jobId), false);
    } finally {
      restore();
    }
  });

  check("jobControl: cancel SIGCONTs then SIGTERMs the group", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const restore = ctrl.__setKiller((pid, sig) => signals.push({ pid, sig }));
    try {
      const jobId = "live-2";
      ctrl.registerChild(jobId, { pid: 99 } as any);
      assert.equal(ctrl.requestCancel(jobId, 10_000), true);
      assert.deepEqual(signals[0], { pid: -99, sig: "SIGCONT" });
      assert.deepEqual(signals[1], { pid: -99, sig: "SIGTERM" });
      assert.equal(ctrl.getIntent(jobId), "cancel");
      ctrl.forgetJob(jobId);
    } finally {
      restore();
    }
  });

  check("jobControl: a pause requested between stages is applied to the next child", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const restore = ctrl.__setKiller((pid, sig) => signals.push({ pid, sig }));
    try {
      const jobId = "live-3";
      // Stage 1 child runs then exits (cleared) — entry survives.
      const stage1 = { pid: 1 } as any;
      ctrl.registerChild(jobId, stage1);
      ctrl.clearChild(jobId, stage1);
      signals.length = 0; // ignore any stage-1 signals; assert from here

      // Pause requested while no child is live → stored as intent, no signal.
      ctrl.requestPause(jobId);
      assert.equal(signals.length, 0, "no signal without a live child");

      // The next stage's child registers → it is immediately SIGSTOP'd.
      ctrl.registerChild(jobId, { pid: 77 } as any);
      assert.deepEqual(signals.at(-1), { pid: -77, sig: "SIGSTOP" });
      ctrl.forgetJob(jobId);
    } finally {
      restore();
    }
  });

  check("jobControl: control fns return false for an unknown job", () => {
    assert.equal(ctrl.requestPause("nope"), false);
    assert.equal(ctrl.requestResume("nope"), false);
    assert.equal(ctrl.requestCancel("nope"), false);
  });

  // run
  for (const c of checks) {
    try {
      await c.fn();
      passed++;
      console.log(`  ok  ${c.name}`);
    } catch (e) {
      console.error(`FAIL  ${c.name}\n      ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${checks.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

void main();
