/**
 * Unit checks for the Narration Cutter's ANALYZE-job transport (no ffmpeg, no
 * network, no keys). These assert the parts that MUST be correct regardless of
 * the live providers:
 *   • the analyze-job stage machine advances and reports monotonic progress;
 *   • a non-fatal transcription warning still lets the job complete (energy-only);
 *   • a fatal step fails the job with a clear reason and freezes progress;
 *   • the poll snapshot only ships the heavy result once `done`;
 *   • the withTimeout wrapper resolves fast work and rejects a hang.
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-analyze-job.test.ts
 */
import assert from "node:assert/strict";
import {
  createAnalyzeJob, getAnalyzeJob, setStage, setWarning, completeAnalyze, failAnalyze,
  pollSnapshot, ANALYZE_STAGE_PROGRESS, ANALYZE_STAGE_LABEL,
  type AnalyzeResultPayload,
} from "../cutter/analyzeJob.js";
import { withTimeout, TimeoutError } from "../util/withTimeout.js";

let passed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      pending.push(
        (r as Promise<void>).then(
          () => { passed++; console.log(`  ok  ${name}`); },
          (e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; },
        ),
      );
      return;
    }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

const fakeResult = (): AnalyzeResultPayload => ({
  sourceUrl: "x", duration: 12, hasAudio: true,
  envelope: { db: [-30, -40, -50], hop: 0.1, floorDb: -60 },
  words: [{ word: "hi", start: 0, end: 0.4 }],
  transcript: "hi", takes: [{ id: "t0" }], defaults: { gap: 0.2 },
});

// ── Registry: create → fetch → terminal ──────────────────────────────────────
check("createAnalyzeJob starts queued and is fetchable by id", () => {
  const job = createAnalyzeJob();
  assert.equal(job.stage, "queued");
  assert.equal(job.stageLabel, ANALYZE_STAGE_LABEL.queued);
  assert.equal(getAnalyzeJob(job.id)?.id, job.id);
});

// ── Stage progress is monotonic and labelled ──────────────────────────────────
check("setStage advances progress monotonically and never regresses", () => {
  const job = createAnalyzeJob();
  setStage(job, "resolving");
  assert.equal(job.progress, ANALYZE_STAGE_PROGRESS.resolving);
  setStage(job, "transcribing");
  assert.equal(job.progress, ANALYZE_STAGE_PROGRESS.transcribing);
  // A "backward" stage must not lower the bar.
  setStage(job, "resolving");
  assert.equal(job.progress, ANALYZE_STAGE_PROGRESS.transcribing);
  assert.equal(job.stageLabel, ANALYZE_STAGE_LABEL.resolving);
});

// ── Warning is non-fatal: job still completes with a result ───────────────────
check("transcription warning is non-fatal — job completes energy-only", () => {
  const job = createAnalyzeJob();
  setStage(job, "transcribing");
  setWarning(job, "transcription unavailable: no GROQ key — timeline has no transcript labels");
  completeAnalyze(job, fakeResult());
  assert.equal(job.stage, "done");
  assert.equal(job.progress, 1);
  assert.ok(job.warning?.includes("transcription unavailable"));
  assert.equal(job.error, null);
  assert.ok(job.result);
});

// ── Fatal failure: clear reason, frozen progress, no result ───────────────────
check("failAnalyze records a reason, freezes progress, ships no result", () => {
  const job = createAnalyzeJob();
  setStage(job, "waveform"); // got partway
  const at = job.progress;
  failAnalyze(job, "building the waveform timed out after 180000ms");
  assert.equal(job.stage, "failed");
  assert.equal(job.progress, at); // frozen, not reset
  assert.ok(job.error?.includes("timed out"));
  assert.equal(job.result, null);
});

// ── Poll snapshot only ships the heavy result once done ───────────────────────
check("pollSnapshot withholds result until done, includes it after", () => {
  const job = createAnalyzeJob();
  setStage(job, "transcribing");
  assert.equal(pollSnapshot(job).result, null);
  completeAnalyze(job, fakeResult());
  const snap = pollSnapshot(job);
  assert.equal(snap.stage, "done");
  assert.ok(snap.result);
  assert.equal(snap.result?.takes.length, 1);
});

// ── withTimeout resolves fast work and rejects a hang ─────────────────────────
check("withTimeout resolves when the inner promise settles in time", async () => {
  const v = await withTimeout(Promise.resolve(42), 1000, "fast");
  assert.equal(v, 42);
});

check("withTimeout rejects with TimeoutError when the inner promise is too slow", async () => {
  // A promise that settles AFTER the bound (kept short so the test is fast). The
  // timeout must win and reject before the slow work resolves.
  // NOTE: the slow timer is deliberately NOT unref'd so the event loop stays
  // alive long enough for withTimeout's (unref'd) 20ms timer to fire & reject.
  const slow = new Promise<number>((res) => { setTimeout(() => res(1), 200); });
  await assert.rejects(
    () => withTimeout(slow, 20, "Groq"),
    (e: unknown) => e instanceof TimeoutError && /Groq timed out after 20ms/.test((e as Error).message),
  );
});

check("withTimeout(0) leaves the promise unbounded (no timer)", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 0, "unbounded");
  assert.equal(v, "ok");
});

check("withTimeout propagates the inner rejection unchanged", async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("boom")), 1000, "x"),
    /boom/,
  );
});

await Promise.all(pending);
console.log(`\n${passed} checks passed`);
