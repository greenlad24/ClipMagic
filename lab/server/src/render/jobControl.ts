/**
 * Live process-control registry for render jobs.
 *
 * The render worker spawns ffmpeg (and, for manifest jobs, sequential Remotion
 * composite passes that themselves shell out to ffmpeg). To make a RUNNING job
 * pause/resume/cancel-able we need a handle on the OS process tree it owns.
 *
 * Strategy:
 *   • ffmpeg is spawned `detached`, so it leads its own process GROUP. Signalling
 *     the negative pid (`-pgid`) reaches the whole tree (ffmpeg + any helpers it
 *     forked) rather than just the leader — important so a SIGSTOP/SIGCONT/kill
 *     actually freezes/ends everything.
 *   • This module tracks the currently-running child per jobId plus a small
 *     "intent" flag (pause/cancel requested). The worker registers/unregisters
 *     its active child around each spawn and consults the intent at stage
 *     boundaries (between the main render and the Remotion stages, which can't be
 *     SIGSTOP'd cleanly) so a pause/cancel requested mid-job is honoured.
 *
 * Pure-ish: the only side effects are `process.kill`. That single call is
 * injectable (`__setKiller`) so the state machine can be unit-tested without
 * spawning real processes.
 */
import type { ChildProcess } from "node:child_process";

export type JobIntent = "none" | "pause" | "cancel";

interface Entry {
  child: ChildProcess | null;
  /** What the operator asked for while the job was/may be running. */
  intent: JobIntent;
}

const registry = new Map<string, Entry>();

/** Signal sender, injectable for tests (default: real process.kill). */
type Killer = (pid: number, signal: NodeJS.Signals) => void;
let killer: Killer = (pid, signal) => {
  process.kill(pid, signal);
};

/** Test seam — swap the signal sender. Returns a restore fn. */
export function __setKiller(fn: Killer): () => void {
  const prev = killer;
  killer = fn;
  return () => {
    killer = prev;
  };
}

function entry(jobId: string): Entry {
  let e = registry.get(jobId);
  if (!e) {
    e = { child: null, intent: "none" };
    registry.set(jobId, e);
  }
  return e;
}

/**
 * Send a POSIX signal to the whole process group led by `child` (falling back to
 * the bare pid if the group send fails, e.g. on platforms without process
 * groups). Never throws — a dead/exited child just no-ops.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative pid targets the process group (child was spawned detached).
    killer(-pid, signal);
  } catch {
    try {
      killer(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Mark a job as live and attach the child currently doing its work. */
export function registerChild(jobId: string, child: ChildProcess): void {
  const e = entry(jobId);
  e.child = child;
  // If a pause/cancel landed before this stage's child existed, apply it now.
  if (e.intent === "pause") signalTree(child, "SIGSTOP");
  else if (e.intent === "cancel") signalTree(child, "SIGTERM");
}

/** Detach the child once a stage finishes (the entry survives for late intents). */
export function clearChild(jobId: string, child: ChildProcess): void {
  const e = registry.get(jobId);
  if (e && e.child === child) e.child = null;
}

/** Forget a job entirely once it reaches a terminal state. */
export function forgetJob(jobId: string): void {
  registry.delete(jobId);
}

export function getIntent(jobId: string): JobIntent {
  return registry.get(jobId)?.intent ?? "none";
}

/** True once a pause/cancel has been requested for a live job. */
export function isControlled(jobId: string): boolean {
  return registry.has(jobId);
}

/**
 * Request a PAUSE. If a child is currently running it is SIGSTOP'd immediately;
 * otherwise the intent is remembered so the next stage's child starts stopped /
 * the worker bails before the next stage. Returns true if the job was live.
 */
export function requestPause(jobId: string): boolean {
  const e = registry.get(jobId);
  if (!e) return false;
  e.intent = "pause";
  if (e.child) signalTree(e.child, "SIGSTOP");
  return true;
}

/**
 * Request a RESUME of a paused-running job: SIGCONT the tree and clear intent.
 * Returns true if the job was live (had a tracked entry).
 */
export function requestResume(jobId: string): boolean {
  const e = registry.get(jobId);
  if (!e) return false;
  e.intent = "none";
  if (e.child) signalTree(e.child, "SIGCONT");
  return true;
}

/**
 * Request a CANCEL. SIGCONT first (a paused tree can't process SIGTERM), then
 * SIGTERM, then a SIGKILL escalation after a grace period in case it ignores the
 * polite signal. Returns true if the job was live.
 */
export function requestCancel(jobId: string, killAfterMs = 4000): boolean {
  const e = registry.get(jobId);
  if (!e) return false;
  e.intent = "cancel";
  const child = e.child;
  if (child) {
    signalTree(child, "SIGCONT"); // un-pause so it can act on termination
    signalTree(child, "SIGTERM");
    const pid = child.pid;
    if (pid) {
      const t = setTimeout(() => {
        // Only escalate if this exact child is still the live one.
        const cur = registry.get(jobId);
        if (cur && cur.child === child) signalTree(child, "SIGKILL");
      }, killAfterMs);
      // Don't keep the event loop alive solely for the escalation timer.
      if (typeof t.unref === "function") t.unref();
    }
  }
  return true;
}
