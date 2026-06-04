/**
 * High-level Pause / Resume / Cancel actions for render jobs.
 *
 * These coordinate the two halves of a job's state:
 *   • the persistent DB row (`render_jobs.status`), and
 *   • the live OS process tree (via the job-control registry).
 *
 * The split keeps the DB transitions pure/unit-testable (db/jobs.ts) and the
 * signalling injectable (render/jobControl.ts). This module is the seam the
 * endpoints call.
 */
import {
  getJob,
  isTerminalStatus,
  markPaused,
  resumeJob as resumeJobRow,
  cancelJob as cancelJobRow,
} from "../db/jobs.js";
import type { JobStatus } from "../db/index.js";
import { requestPause, requestResume, requestCancel, isControlled } from "./jobControl.js";
import { pump } from "./worker.js";

export interface JobActionResult {
  ok: boolean;
  status?: JobStatus;
  message?: string;
}

/**
 * Pause a job. A RUNNING job (live in the registry) is SIGSTOP'd; the worker
 * flips the row to 'paused' once stopped (so it never races a near-finished
 * render to completion). A merely QUEUED job is flipped to 'paused' directly so
 * `pump` won't start it.
 */
export function pauseJob(id: string): JobActionResult {
  const job = getJob(id);
  if (!job) return { ok: false, message: "Job not found." };
  if (isTerminalStatus(job.status)) return { ok: false, message: "Job already finished." };
  if (job.status === "paused") return { ok: true, status: "paused" };

  // Signal a live process tree (SIGSTOP). For a queued/untracked job this is a
  // no-op. Then flip the row to 'paused' so it reflects intent immediately and
  // `pump` won't (re)start it — the worker stays blocked in its (now-stopped)
  // ffmpeg await, holding its slot, which is exactly the slot semantics we want.
  if (isControlled(id)) requestPause(id);
  markPaused(id);
  return { ok: true, status: "paused" };
}

/**
 * Resume a paused job. If its process tree is still live (paused mid-render) we
 * SIGCONT it and return the row to 'active'; otherwise the never-started job
 * returns to 'queued' and we pump the worker.
 */
export function resumeJob(id: string): JobActionResult {
  const job = getJob(id);
  if (!job) return { ok: false, message: "Job not found." };
  if (job.status !== "paused") {
    if (isTerminalStatus(job.status)) return { ok: false, message: "Job already finished." };
    return { ok: true, status: job.status }; // already running/queued
  }
  const wasRunning = isControlled(id);
  // Flip the DB row first so the worker's checkpoint sees 'none' intent → active.
  const next = resumeJobRow(id, wasRunning);
  if (wasRunning) requestResume(id);
  else pump();
  return { ok: true, status: next };
}

/**
 * Cancel a job. Marks the row 'canceled' (so `pump` skips a queued one) and, if
 * live, terminates the process tree (SIGTERM→SIGKILL). The worker's catch path
 * cleans partial output. Idempotent on terminal jobs.
 */
export function cancelJob(id: string): JobActionResult {
  const job = getJob(id);
  if (!job) return { ok: false, message: "Job not found." };
  if (isTerminalStatus(job.status)) return { ok: false, message: "Job already finished." };

  if (isControlled(id)) requestCancel(id);
  cancelJobRow(id, "Canceled by user");
  return { ok: true, status: "canceled" };
}
