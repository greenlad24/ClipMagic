import { nanoid } from "nanoid";
import { db, type JobStatus } from "./index.js";

/** A render job row, as used by the queue and the Rendi-compatible API. */
export interface RenderJob {
  id: string;
  kind: "command" | "manifest" | "cut";
  status: JobStatus;
  progress: number;
  command: string | null;
  input_files_json: string | null;
  output_name: string;
  manifest_json: string | null;
  output_file: string | null;
  duration_sec: number | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  project_id: string | null;
  batch_item_id: string | null;
  /** Human label for the current sub-stage ("Rendering stickers 3/6"), or null. */
  stage_label: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const now = () => Date.now();

export interface CreateJobInput {
  kind: "command" | "manifest" | "cut";
  command?: string;
  inputFiles?: Record<string, string>;
  outputName?: string;
  manifest?: unknown;
  projectId?: string | null;
  batchItemId?: string | null;
  maxAttempts?: number;
}

export function createJob(input: CreateJobInput): string {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO render_jobs
       (id, kind, status, progress, command, input_files_json, output_name,
        manifest_json, attempts, max_attempts, project_id, batch_item_id,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    input.kind,
    "queued",
    0,
    input.command ?? null,
    input.inputFiles ? JSON.stringify(input.inputFiles) : null,
    input.outputName ?? `${id}.mp4`,
    input.manifest ? JSON.stringify(input.manifest) : null,
    0,
    input.maxAttempts ?? 2,
    input.projectId ?? null,
    input.batchItemId ?? null,
    t,
    t
  );
  return id;
}

export function getJob(id: string): RenderJob | undefined {
  return db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(id) as RenderJob | undefined;
}

/** A render job is in a terminal state — no further work or control applies. */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

/**
 * Atomically claim the next queued job and mark it active. Uses an immediate
 * transaction so concurrent worker slots never grab the same row. Paused-queued
 * jobs are intentionally NOT claimed (their status is 'paused', not 'queued').
 */
export const claimNextJob = db.transaction((): RenderJob | undefined => {
  const row = db
    .prepare("SELECT * FROM render_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get() as RenderJob | undefined;
  if (!row) return undefined;
  const t = now();
  db.prepare(
    "UPDATE render_jobs SET status='active', started_at=?, updated_at=?, attempts=attempts+1 WHERE id=?"
  ).run(t, t, row.id);
  return { ...row, status: "active", started_at: t, attempts: row.attempts + 1 };
});

export function setProgress(id: string, progress: number): void {
  db.prepare("UPDATE render_jobs SET progress=?, updated_at=? WHERE id=?").run(progress, now(), id);
}

/**
 * Publish the current sub-stage label AND progress in one write. Used by the
 * render worker to narrate the post-render Remotion stage ("Rendering stickers
 * 3/6" → "Compositing video…") so the panel/Meme page reflect the slow part
 * instead of parking at 100%. Pass `label = null` to clear it.
 */
export function setStage(id: string, label: string | null, progress: number): void {
  db.prepare("UPDATE render_jobs SET stage_label=?, progress=?, updated_at=? WHERE id=?")
    .run(label, progress, now(), id);
}

export function completeJob(id: string, outputFile: string, durationSec: number): void {
  const t = now();
  db.prepare(
    `UPDATE render_jobs
       SET status='completed', progress=1, stage_label=NULL, output_file=?, duration_sec=?, error=NULL,
           finished_at=?, updated_at=?
     WHERE id=?`
  ).run(outputFile, durationSec, t, t, id);
}

/**
 * Record a failure. If retries remain the job goes back to 'queued', otherwise
 * it is marked 'failed'. Returns the resulting status.
 */
export function failJob(id: string, error: string): JobStatus {
  const job = getJob(id);
  if (!job) return "failed";
  const t = now();
  if (job.attempts < job.max_attempts) {
    db.prepare(
      "UPDATE render_jobs SET status='queued', error=?, updated_at=? WHERE id=?"
    ).run(error, t, id);
    return "queued";
  }
  db.prepare(
    "UPDATE render_jobs SET status='failed', error=?, finished_at=?, updated_at=? WHERE id=?"
  ).run(error, t, t, id);
  return "failed";
}

/**
 * Manually re-queue a single job (e.g. a failed bulk item the user retries).
 * Resets attempts and progress so it gets a fresh run. Returns true if the job
 * existed and was re-queued.
 */
export function retryJob(id: string): boolean {
  const job = getJob(id);
  if (!job) return false;
  if (job.status === "active") return false; // don't disturb a running job
  const t = now();
  db.prepare(
    `UPDATE render_jobs
       SET status='queued', progress=0, stage_label=NULL, attempts=0, error=NULL,
           output_file=NULL, started_at=NULL, finished_at=NULL, updated_at=?
     WHERE id=?`
  ).run(t, id);
  return true;
}

/** Re-queue every failed job belonging to a batch. Returns the count requeued. */
export function retryFailedInBatch(batchId: string): number {
  const rows = db
    .prepare(
      `SELECT j.id AS id
         FROM batch_items i JOIN render_jobs j ON j.id = i.job_id
        WHERE i.batch_id = ? AND j.status = 'failed'`
    )
    .all(batchId) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) if (retryJob(r.id)) n++;
  return n;
}

/** On boot, any job left 'active' by a crash/restart is requeued. */
export function requeueStuckJobs(): number {
  const res = db
    .prepare("UPDATE render_jobs SET status='queued', updated_at=? WHERE status='active'")
    .run(now());
  return res.changes;
}

/** Set a job's status directly (used by the control layer after signaling). */
export function setStatus(id: string, status: JobStatus): void {
  const t = now();
  const finished = isTerminalStatus(status) ? t : null;
  db.prepare(
    "UPDATE render_jobs SET status=?, finished_at=COALESCE(?, finished_at), updated_at=? WHERE id=?"
  ).run(status, finished, t, id);
}

/**
 * Pause a job's QUEUE state. A queued job becomes 'paused' so `pump` won't start
 * it; an already-active job is left to the live control layer (it stays 'active'
 * in the DB until the worker observes the SIGSTOP — see markPaused). Returns the
 * resulting DB status, or undefined if the job is missing/terminal.
 */
export function pauseQueuedJob(id: string): JobStatus | undefined {
  const job = getJob(id);
  if (!job || isTerminalStatus(job.status)) return undefined;
  if (job.status === "queued") {
    setStatus(id, "paused");
    return "paused";
  }
  return job.status; // active/paused — caller handles the live process
}

/** Mark a running job paused once its process tree has been SIGSTOP'd. */
export function markPaused(id: string): void {
  const job = getJob(id);
  if (!job || isTerminalStatus(job.status)) return;
  setStatus(id, "paused");
}

/**
 * Resume a paused job. A paused-queued (never-started) job returns to 'queued'
 * so `pump` picks it up; a paused-running job returns to 'active' (its process
 * tree is SIGCONT'd by the control layer). `wasRunning` tells us which: true if
 * the live registry still holds the job's process. Returns the new status.
 */
export function resumeJob(id: string, wasRunning: boolean): JobStatus | undefined {
  const job = getJob(id);
  if (!job || job.status !== "paused") return undefined;
  const next: JobStatus = wasRunning ? "active" : "queued";
  setStatus(id, next);
  return next;
}

/**
 * Cancel a job. Always lands on 'canceled' (terminal). The control layer is
 * responsible for killing any live process tree and cleaning partial output.
 */
export function cancelJob(id: string, reason = "Canceled by user"): boolean {
  const job = getJob(id);
  if (!job || isTerminalStatus(job.status)) return false;
  const t = now();
  db.prepare(
    "UPDATE render_jobs SET status='canceled', error=?, finished_at=?, updated_at=? WHERE id=?"
  ).run(reason, t, t, id);
  return true;
}

/** A friendly, human-readable label for a job, derived from its kind/manifest. */
export function jobTitle(job: RenderJob): string {
  // The render manifest / cut spec / command may carry a usable name.
  if (job.output_name && job.output_name !== "output.mp4") {
    const base = job.output_name.replace(/\.[^.]+$/, "");
    if (base.trim()) return base;
  }
  try {
    if (job.manifest_json) {
      const m = JSON.parse(job.manifest_json) as { title?: string };
      if (m.title) return String(m.title);
    }
  } catch {
    /* ignore */
  }
  return jobTypeLabel(job);
}

/** A coarse type label for the panel grouping ("Short-form render", etc.). */
export function jobTypeLabel(job: RenderJob): string {
  if (job.kind === "cut") return "Narration cut";
  if (job.kind === "command") return "Render";
  // kind === "manifest": distinguish meme (emphasis stickers) from short-form.
  try {
    const m = JSON.parse(job.manifest_json || "{}") as {
      emphasisStickers?: unknown[];
      motionGraphics?: unknown[];
    };
    if (Array.isArray(m.emphasisStickers) && m.emphasisStickers.length > 0) return "Meme render";
    if (Array.isArray(m.motionGraphics) && m.motionGraphics.length > 0) return "Motion render";
  } catch {
    /* ignore */
  }
  return "Short-form render";
}

/** A short stage label per status, surfaced in the panel under the title. */
export function jobStageLabel(job: RenderJob): string {
  switch (job.status) {
    case "queued":
      return "Waiting in queue";
    case "active":
      // The worker publishes a live sub-stage ("Rendering stickers 3/6",
      // "Compositing video…") during the post-render Remotion stage; show it so
      // the panel narrates the slow part instead of a flat "Rendering".
      return job.stage_label || "Rendering";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return job.error ? "Failed" : "Failed";
    case "canceled":
      return "Canceled";
    default:
      return "";
  }
}

export interface JobSummary {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  outputFile: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

function toSummary(job: RenderJob): JobSummary {
  return {
    id: job.id,
    type: jobTypeLabel(job),
    title: jobTitle(job),
    status: job.status,
    stage: jobStageLabel(job),
    progress: job.progress ?? 0,
    error: job.error ?? null,
    outputFile: job.output_file ?? null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    finishedAt: job.finished_at ?? null,
  };
}

/**
 * List jobs for the Background Jobs panel: every non-terminal job (queued,
 * active, paused) plus the most recent `recentLimit` terminal jobs. Active jobs
 * sort to the top, then queued/paused, then recent terminal by finish time.
 */
export function listJobs(recentLimit = 12): { active: JobSummary[]; recent: JobSummary[] } {
  const live = db
    .prepare(
      `SELECT * FROM render_jobs
        WHERE status IN ('active','queued','paused')
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                 created_at ASC`
    )
    .all() as RenderJob[];
  const recent = db
    .prepare(
      `SELECT * FROM render_jobs
        WHERE status IN ('completed','failed','canceled')
        ORDER BY COALESCE(finished_at, updated_at) DESC
        LIMIT ?`
    )
    .all(recentLimit) as RenderJob[];
  return { active: live.map(toSummary), recent: recent.map(toSummary) };
}

export function queueDepth(): { queued: number; active: number } {
  const q = db.prepare("SELECT COUNT(*) c FROM render_jobs WHERE status='queued'").get() as {
    c: number;
  };
  const a = db.prepare("SELECT COUNT(*) c FROM render_jobs WHERE status='active'").get() as {
    c: number;
  };
  return { queued: q.c, active: a.c };
}
