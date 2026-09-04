/**
 * Runs a queue of script ideas, one finished script at a time.
 *
 * STRICTLY SERIAL, and not as a courtesy to the API. `scriptgenTally` in
 * ai/claude.ts is module-level state zeroed at the start of every run, so two
 * runs inside one process would interleave their token counts: every reported
 * cost would be wrong and the $12 ceiling would fire on their combined spend.
 * Concurrency here is not a tuning knob, it is a correctness bug.
 *
 * The queue lives in the DB and the next item is read back from it on every
 * iteration, which is what makes the worker resumable and lets an item be
 * skipped while the queue is already moving.
 */
import {
  getQueue,
  nextQueued,
  updateItem,
  updateQueue,
  type ScriptQueue,
  type ScriptQueueItem,
} from "../db/scriptQueue.js";
import { getRun } from "../db/scriptRuns.js";
import { startScript, continueScript, getScriptSnapshot } from "./run.js";
import type { ScriptSetup } from "./types.js";

/**
 * Which queues this process is currently working. In-memory on purpose: it
 * answers "is a worker live in THIS process", which is exactly a per-process
 * question. Durable state is the DB's job.
 */
const live = new Set<string>();

export function isQueueRunning(queueId: string): boolean {
  return live.has(queueId);
}

/** How often the worker asks the job registry whether a run has finished. */
const POLL_MS = 4000;
/**
 * A single script is ~30 minutes. Ninety is generous enough that a slow research
 * stage is never mistaken for a hang, and short enough that a genuinely stuck
 * run cannot hold a five-item queue forever.
 */
const RUN_TIMEOUT_MS = 90 * 60 * 1000;

/** Stage 0 proposes; a queued item has nobody to confirm, so it accepts. */
function autoSetup(stage0: {
  videoType: ScriptSetup["videoType"];
  recommendedTitle: string;
  coreTopic: string;
  specificFocus: string;
}): ScriptSetup {
  return {
    videoType: stage0.videoType,
    title: stage0.recommendedTitle,
    coreTopic: stage0.coreTopic,
    specificFocus: stage0.specificFocus,
    // A queued idea carries no sponsor: sponsorship is a per-video commercial
    // decision and defaulting it to anything else would put a plug in a script
    // nobody sold.
    sponsorship: { mode: "organic", sponsorName: "" },
    targetLength: "10-12+ minutes",
    mode: "full",
  };
}

/** Wait for one run to reach a terminal state, reporting its cost as it goes. */
async function awaitRun(jobId: string, itemId: string): Promise<{ ok: boolean; error: string; cost: number }> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastCost = 0;
  for (;;) {
    const snap = getScriptSnapshot(jobId);
    if (!snap) {
      // The registry reaps finished jobs after a TTL, so a vanished job is not
      // an error — ask the durable row what happened instead.
      return { ok: true, error: "", cost: lastCost };
    }
    if (snap.costUsd !== lastCost) {
      lastCost = snap.costUsd;
      updateItem(itemId, { costUsd: lastCost });
    }
    if (snap.status === "completed") return { ok: true, error: "", cost: lastCost };
    if (snap.status === "failed") return { ok: false, error: snap.error || "The run failed.", cost: lastCost };
    if (Date.now() > deadline) {
      return { ok: false, error: `Still running after ${RUN_TIMEOUT_MS / 60000} minutes — giving up on it.`, cost: lastCost };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Generate one queued idea, start to finish. Never throws. */
async function runOne(item: ScriptQueueItem): Promise<void> {
  updateItem(item.id, { status: "running", startedAt: Date.now(), error: "" });
  try {
    const { runId, stage0 } = await startScript(item.input);
    updateItem(item.id, { runId, title: stage0.recommendedTitle });

    const { jobId } = await continueScript(runId, autoSetup(stage0));
    const res = await awaitRun(jobId, item.id);

    // The run row is the authority on what happened; the job registry is a
    // live view that expires.
    const run = getRun(runId);
    const failed = !res.ok || run?.status === "failed";
    updateItem(item.id, {
      status: failed ? "failed" : "done",
      error: failed ? res.error || run?.error || "The run failed." : "",
      costUsd: res.cost,
      finishedAt: Date.now(),
    });
  } catch (e) {
    updateItem(item.id, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      finishedAt: Date.now(),
    });
  }
}

/**
 * Work the queue until it is empty, paused, or deleted.
 *
 * One item failing does not stop the queue — four good scripts out of five is a
 * better outcome than one failure discarding the other four. A queue that
 * disappears mid-run does stop it, immediately.
 */
async function work(queueId: string): Promise<void> {
  try {
    for (;;) {
      const q = getQueue(queueId);
      // Deleted, or paused from the UI between items.
      if (!q || q.status !== "running") return;
      const item = nextQueued(queueId);
      if (!item) {
        updateQueue(queueId, { status: "done" });
        const done = getQueue(queueId);
        const failed = (done?.items ?? []).filter((i) => i.status === "failed").length;
        const total = (done?.items ?? []).length;
        const spend = (done?.items ?? []).reduce((a, i) => a + i.costUsd, 0);
        console.log(
          `[scriptqueue] ${queueId} finished: ${total - failed}/${total} script(s), $${spend.toFixed(2)}` +
            (failed ? ` — ${failed} failed` : ""),
        );
        return;
      }
      console.log(`[scriptqueue] ${queueId} item ${item.idx + 1}: "${item.input.idea.slice(0, 60)}"`);
      await runOne(item);
    }
  } finally {
    live.delete(queueId);
  }
}

/** Start (or resume) a queue. Returns immediately; the work continues in the background. */
export function startQueue(queueId: string): ScriptQueue | null {
  const q = getQueue(queueId);
  if (!q) return null;
  if (live.has(queueId)) return q;
  live.add(queueId);
  updateQueue(queueId, { status: "running", error: "" });
  void work(queueId);
  return getQueue(queueId);
}

/**
 * Stop after the current script.
 *
 * Deliberately not mid-script: a run that is 20 minutes and $4 deep should be
 * allowed to finish and be kept. The loop checks the queue's status between
 * items, so this takes effect at the next boundary.
 */
export function pauseQueue(queueId: string): ScriptQueue | null {
  updateQueue(queueId, { status: "paused" });
  return getQueue(queueId);
}
