/**
 * The Script Generator's queue: several ideas in, one finished script at a time.
 *
 * Rows, not memory. A queue of five scripts is more than two hours of work, so
 * it has to survive a container restart, a closed tab, and a laptop going to
 * sleep — the same reasoning that put Tutorial Studio's batch items in the DB.
 */
import { randomUUID } from "node:crypto";
import { db } from "./index.js";
import type { ScriptInput } from "../scriptgen/types.js";

export type QueueStatus = "idle" | "running" | "paused" | "done";
/** `skipped` is the operator's decision; `failed` is the pipeline's. Not the same thing. */
export type QueueItemStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface ScriptQueueItem {
  id: string;
  queueId: string;
  idx: number;
  input: ScriptInput;
  status: QueueItemStatus;
  runId: string | null;
  title: string;
  costUsd: number;
  error: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ScriptQueue {
  id: string;
  name: string;
  status: QueueStatus;
  error: string;
  createdAt: number;
  updatedAt: number;
  items: ScriptQueueItem[];
}

interface QueueRow {
  id: string;
  name: string;
  status: string;
  error: string;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: string;
  queue_id: string;
  idx: number;
  input_json: string;
  status: string;
  run_id: string | null;
  title: string;
  cost_usd: number;
  error: string;
  started_at: number | null;
  finished_at: number | null;
}

function toItem(r: ItemRow): ScriptQueueItem {
  let input: ScriptInput;
  try {
    input = JSON.parse(r.input_json) as ScriptInput;
  } catch {
    // A row whose JSON cannot be read must not take the whole queue down; it
    // shows up as an item with no idea in it, which is visibly wrong.
    input = { idea: "" } as ScriptInput;
  }
  return {
    id: r.id,
    queueId: r.queue_id,
    idx: r.idx,
    input,
    status: r.status as QueueItemStatus,
    runId: r.run_id,
    title: r.title,
    costUsd: r.cost_usd,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** Create a queue and its items in ONE transaction — a half-written queue would run wrong. */
export function createQueue(name: string, inputs: ScriptInput[]): string {
  const id = randomUUID();
  const t = Date.now();
  const insertQueue = db.prepare(
    "INSERT INTO script_queue (id, name, status, error, created_at, updated_at) VALUES (?, ?, 'idle', '', ?, ?)",
  );
  const insertItem = db.prepare(
    "INSERT INTO script_queue_items (id, queue_id, idx, input_json, status) VALUES (?, ?, ?, ?, 'queued')",
  );
  db.transaction(() => {
    insertQueue.run(id, name, t, t);
    inputs.forEach((input, i) => {
      insertItem.run(randomUUID(), id, i, JSON.stringify(input));
    });
  })();
  return id;
}

export function getQueue(id: string): ScriptQueue | null {
  const row = db.prepare("SELECT * FROM script_queue WHERE id = ?").get(id) as QueueRow | undefined;
  if (!row) return null;
  const items = db
    .prepare("SELECT * FROM script_queue_items WHERE queue_id = ? ORDER BY idx")
    .all(id) as ItemRow[];
  return {
    id: row.id,
    name: row.name,
    status: row.status as QueueStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map(toItem),
  };
}

export function listQueues(limit = 20): ScriptQueue[] {
  const rows = db
    .prepare("SELECT * FROM script_queue ORDER BY created_at DESC LIMIT ?")
    .all(limit) as QueueRow[];
  return rows.map((r) => getQueue(r.id)).filter((q): q is ScriptQueue => q !== null);
}

export function updateQueue(id: string, patch: { status?: QueueStatus; error?: string; name?: string }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  if (patch.name !== undefined) {
    sets.push("name = ?");
    vals.push(patch.name);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(Date.now(), id);
  db.prepare(`UPDATE script_queue SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function updateItem(
  id: string,
  patch: {
    status?: QueueItemStatus;
    runId?: string | null;
    title?: string;
    costUsd?: number;
    error?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
  },
): void {
  const map: Array<[string, unknown]> = [];
  if (patch.status !== undefined) map.push(["status", patch.status]);
  if (patch.runId !== undefined) map.push(["run_id", patch.runId]);
  if (patch.title !== undefined) map.push(["title", patch.title]);
  if (patch.costUsd !== undefined) map.push(["cost_usd", patch.costUsd]);
  if (patch.error !== undefined) map.push(["error", patch.error]);
  if (patch.startedAt !== undefined) map.push(["started_at", patch.startedAt]);
  if (patch.finishedAt !== undefined) map.push(["finished_at", patch.finishedAt]);
  if (map.length === 0) return;
  db.prepare(`UPDATE script_queue_items SET ${map.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...map.map(([, v]) => v),
    id,
  );
  const row = db.prepare("SELECT queue_id FROM script_queue_items WHERE id = ?").get(id) as
    | { queue_id: string }
    | undefined;
  if (row) db.prepare("UPDATE script_queue SET updated_at = ? WHERE id = ?").run(Date.now(), row.queue_id);
}

export function deleteQueue(id: string): void {
  db.prepare("DELETE FROM script_queue_items WHERE queue_id = ?").run(id);
  db.prepare("DELETE FROM script_queue WHERE id = ?").run(id);
}

/**
 * The next item to run: the first still queued.
 *
 * Reading this from the DB each time — rather than iterating a list captured at
 * start — is what makes the worker resumable and lets an item be skipped or
 * added while the queue is already moving.
 */
export function nextQueued(queueId: string): ScriptQueueItem | null {
  const row = db
    .prepare("SELECT * FROM script_queue_items WHERE queue_id = ? AND status = 'queued' ORDER BY idx LIMIT 1")
    .get(queueId) as ItemRow | undefined;
  return row ? toItem(row) : null;
}

/**
 * A queue item left `running` by a restart is not running any more.
 *
 * Called at boot, next to the same sweep for orphaned script runs: the process
 * that owned the work is gone, so the row is a lie until it is corrected.
 */
export function failOrphanedQueueItems(): void {
  const t = Date.now();
  const items = db
    .prepare("UPDATE script_queue_items SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
    .run("The server restarted while this script was generating.", t);
  const queues = db
    .prepare("UPDATE script_queue SET status = 'paused', updated_at = ? WHERE status = 'running'")
    .run(t);
  if (items.changes > 0 || queues.changes > 0) {
    console.warn(
      `[scriptqueue] boot: ${items.changes} item(s) and ${queues.changes} queue(s) were mid-run at restart — ` +
        `items marked failed, queues paused so nothing restarts on its own.`,
    );
  }
}
