/**
 * Typed helpers over the Tutorial Studio batch tables (ts_batches,
 * ts_batch_items — defined in db/index.ts). Same shape as db/avatar.ts: plain
 * better-sqlite3 prepared statements, nanoid() ids, Date.now() timestamps.
 *
 * A batch is a review queue that later becomes a render queue. Items are
 * created as IDEAS, gain a script, get edited and approved, and only then are
 * handed to the sidecar as jobs. Nothing here spends money; the endpoints do.
 */
import { nanoid } from "nanoid";
import { db } from "./index.js";

const now = () => Date.now();

export type BatchStatus = "ideas" | "scripting" | "review" | "rendering" | "done";
export type BatchItemStatus =
  | "idea"
  | "scripted"
  | "approved"
  | "queued"
  | "rendering"
  | "done"
  | "failed";

export interface Batch {
  id: string;
  name: string;
  theme: string;
  avatarId: string;
  environment: string;
  targetCount: number;
  status: BatchStatus;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface BatchItem {
  id: string;
  batchId: string;
  idx: number;
  topic: string;
  hook: string;
  picked: boolean;
  approved: boolean;
  script: Record<string, unknown> | null;
  outfit: string;
  scene: string;
  jobId: string;
  status: BatchItemStatus;
  error: string;
  createdAt: number;
  updatedAt: number;
}

function rowToBatch(r: any): Batch {
  return {
    id: r.id,
    name: r.name ?? "",
    theme: r.theme ?? "",
    avatarId: r.avatar_id ?? "",
    environment: r.environment ?? "",
    targetCount: r.target_count ?? 30,
    status: r.status,
    error: r.error ?? "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToItem(r: any): BatchItem {
  let script: Record<string, unknown> | null = null;
  if (r.script_json) {
    try {
      script = JSON.parse(r.script_json);
    } catch {
      script = null; // a corrupt row must not break the whole batch view
    }
  }
  return {
    id: r.id,
    batchId: r.batch_id,
    idx: r.idx,
    topic: r.topic ?? "",
    hook: r.hook ?? "",
    picked: Boolean(r.picked),
    approved: Boolean(r.approved),
    script,
    outfit: r.outfit ?? "",
    scene: r.scene ?? "",
    jobId: r.job_id ?? "",
    status: r.status,
    error: r.error ?? "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── batches ──────────────────────────────────────────────────────────────────

export function createBatch(input: {
  name: string;
  theme: string;
  avatarId: string;
  environment: string;
  targetCount: number;
}): Batch {
  const id = nanoid(12);
  const t = now();
  db.prepare(
    `INSERT INTO ts_batches (id, name, theme, avatar_id, environment, target_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ideas', ?, ?)`,
  ).run(id, input.name, input.theme, input.avatarId, input.environment, input.targetCount, t, t);
  return getBatch(id)!;
}

export function getBatch(id: string): Batch | null {
  const r = db.prepare("SELECT * FROM ts_batches WHERE id = ?").get(id);
  return r ? rowToBatch(r) : null;
}

export function listBatches(limit = 50): Batch[] {
  return db
    .prepare("SELECT * FROM ts_batches ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(rowToBatch);
}

export function updateBatch(
  id: string,
  fields: Partial<Pick<Batch, "name" | "status" | "error" | "avatarId" | "environment">>,
): Batch | null {
  const cur = getBatch(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE ts_batches SET name = ?, status = ?, error = ?, avatar_id = ?, environment = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.name ?? cur.name,
    fields.status ?? cur.status,
    fields.error ?? cur.error,
    fields.avatarId ?? cur.avatarId,
    fields.environment ?? cur.environment,
    now(),
    id,
  );
  return getBatch(id);
}

export function deleteBatch(id: string): boolean {
  db.prepare("DELETE FROM ts_batch_items WHERE batch_id = ?").run(id);
  return db.prepare("DELETE FROM ts_batches WHERE id = ?").run(id).changes > 0;
}

// ── items ────────────────────────────────────────────────────────────────────

/** Replaces the batch's items wholesale — used when ideas are (re)generated. */
export function replaceItems(
  batchId: string,
  ideas: Array<{ topic: string; hook: string }>,
): BatchItem[] {
  const t = now();
  const insert = db.prepare(
    `INSERT INTO ts_batch_items (id, batch_id, idx, topic, hook, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'idea', ?, ?)`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM ts_batch_items WHERE batch_id = ?").run(batchId);
    ideas.forEach((idea, i) => {
      insert.run(nanoid(12), batchId, i, idea.topic, idea.hook, t, t);
    });
  })();
  return listItems(batchId);
}

export function listItems(batchId: string): BatchItem[] {
  return db
    .prepare("SELECT * FROM ts_batch_items WHERE batch_id = ? ORDER BY idx")
    .all(batchId)
    .map(rowToItem);
}

export function getItem(id: string): BatchItem | null {
  const r = db.prepare("SELECT * FROM ts_batch_items WHERE id = ?").get(id);
  return r ? rowToItem(r) : null;
}

export function setPicked(batchId: string, pickedIds: string[]): BatchItem[] {
  const set = new Set(pickedIds);
  const t = now();
  const upd = db.prepare("UPDATE ts_batch_items SET picked = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => {
    for (const item of listItems(batchId)) {
      upd.run(set.has(item.id) ? 1 : 0, t, item.id);
    }
  })();
  return listItems(batchId);
}

export function updateItem(
  id: string,
  fields: Partial<{
    script: Record<string, unknown> | null;
    approved: boolean;
    outfit: string;
    scene: string;
    jobId: string;
    status: BatchItemStatus;
    error: string;
    topic: string;
  }>,
): BatchItem | null {
  const cur = getItem(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE ts_batch_items
        SET topic = ?, script_json = ?, approved = ?, outfit = ?, scene = ?, job_id = ?,
            status = ?, error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    fields.topic ?? cur.topic,
    fields.script === undefined
      ? cur.script
        ? JSON.stringify(cur.script)
        : null
      : fields.script
        ? JSON.stringify(fields.script)
        : null,
    (fields.approved ?? cur.approved) ? 1 : 0,
    fields.outfit ?? cur.outfit,
    fields.scene ?? cur.scene,
    fields.jobId ?? cur.jobId,
    fields.status ?? cur.status,
    fields.error ?? cur.error,
    now(),
    id,
  );
  return getItem(id);
}
