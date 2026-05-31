import { nanoid } from "nanoid";
import { db, type JobStatus } from "./index.js";

/** A render job row, as used by the queue and the Rendi-compatible API. */
export interface RenderJob {
  id: string;
  kind: "command" | "manifest";
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
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const now = () => Date.now();

export interface CreateJobInput {
  kind: "command" | "manifest";
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

/**
 * Atomically claim the next queued job and mark it active. Uses an immediate
 * transaction so concurrent worker slots never grab the same row.
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

export function completeJob(id: string, outputFile: string, durationSec: number): void {
  const t = now();
  db.prepare(
    `UPDATE render_jobs
       SET status='completed', progress=1, output_file=?, duration_sec=?, error=NULL,
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

/** On boot, any job left 'active' by a crash/restart is requeued. */
export function requeueStuckJobs(): number {
  const res = db
    .prepare("UPDATE render_jobs SET status='queued', updated_at=? WHERE status='active'")
    .run(now());
  return res.changes;
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
