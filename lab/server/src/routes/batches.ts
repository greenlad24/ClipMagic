import { Router } from "express";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import archiver from "archiver";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { createJob, getJob, retryFailedInBatch } from "../db/jobs.js";
import { asyncHandler } from "../middleware.js";
import { pump } from "../render/worker.js";
import { publicUrlFor } from "../lib/urls.js";

/**
 * Bulk rendering. A batch is N videos rendered from N manifests through the same
 * queue + local FFmpeg engine. This is how the app scales to 300+ videos:
 * upload all sources, POST one batch of manifests, then watch the dashboard and
 * download everything as a zip when done. Concurrency is bounded by the worker
 * pool (RENDER_CONCURRENCY), so the droplet stays healthy under a large backlog.
 */
const router = Router();
const now = () => Date.now();

const itemSchema = z.object({
  name: z.string().optional(),
  outputName: z.string().optional(),
  manifest: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
      fps: z.number().positive(),
      durationSeconds: z.number().positive(),
      narration: z.object({ videoUrl: z.string().min(1) }).passthrough(),
    })
    .passthrough(),
});

const createSchema = z.object({
  name: z.string().min(1).default("Batch"),
  items: z.array(itemSchema).min(1).max(2000),
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid batch", details: parsed.error.flatten() });
      return;
    }
    const { name, items } = parsed.data;
    const batchId = nanoid();

    const tx = db.transaction(() => {
      db.prepare("INSERT INTO batches (id, name, created_at) VALUES (?,?,?)").run(batchId, name, now());
      const insItem = db.prepare(
        "INSERT INTO batch_items (id, batch_id, idx, name, job_id, created_at) VALUES (?,?,?,?,?,?)"
      );
      items.forEach((item, i) => {
        const itemId = nanoid();
        const itemName = item.name || `${name}_${i + 1}`;
        const jobId = createJob({
          kind: "manifest",
          manifest: item.manifest,
          outputName: item.outputName || `${itemName.replace(/[^a-zA-Z0-9-_]+/g, "_")}.mp4`,
          batchItemId: itemId,
        });
        db.prepare("UPDATE render_jobs SET duration_sec=? WHERE id=?").run(
          item.manifest.durationSeconds,
          jobId
        );
        insItem.run(itemId, batchId, i, itemName, jobId, now());
      });
    });
    tx();

    pump();
    res.json({ batchId, count: items.length });
  })
);

router.get("/", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id, b.name, b.created_at,
         (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id=b.id) AS total
       FROM batches b ORDER BY b.created_at DESC`
    )
    .all() as Array<{ id: string; name: string; created_at: number; total: number }>;
  const withCounts = rows.map((b) => ({ ...b, ...statusCounts(b.id) }));
  res.json({ batches: withCounts });
});

router.get("/:id", (req, res) => {
  const batch = db.prepare("SELECT * FROM batches WHERE id = ?").get(req.params.id);
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  const items = db
    .prepare("SELECT * FROM batch_items WHERE batch_id = ? ORDER BY idx ASC")
    .all(req.params.id) as Array<{ id: string; idx: number; name: string; job_id: string | null }>;
  const detailed = items.map((it) => {
    const job = it.job_id ? getJob(it.job_id) : undefined;
    return {
      id: it.id,
      index: it.idx,
      name: it.name,
      status: job?.status ?? "queued",
      progress: job?.progress ?? 0,
      error: job?.error ?? null,
      outputUrl: job?.output_file ? publicUrlFor(req, `/api/outputs/${job.output_file}`) : null,
    };
  });
  res.json({ batch, ...statusCounts(req.params.id), items: detailed });
});

/** Re-queue all failed items in a batch (bulk "retry failed" button). */
router.post("/:id/retry-failed", (req, res) => {
  const batch = db.prepare("SELECT id FROM batches WHERE id = ?").get(req.params.id);
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  const requeued = retryFailedInBatch(req.params.id);
  pump();
  res.json({ requeued });
});

router.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    const batch = db.prepare("SELECT * FROM batches WHERE id = ?").get(req.params.id) as
      | { name: string }
      | undefined;
    if (!batch) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }
    const items = db
      .prepare("SELECT * FROM batch_items WHERE batch_id = ? ORDER BY idx ASC")
      .all(req.params.id) as Array<{ name: string; job_id: string | null }>;

    const files: { abs: string; name: string }[] = [];
    for (const it of items) {
      const job = it.job_id ? getJob(it.job_id) : undefined;
      if (job?.output_file) {
        const abs = path.join(config.outputsDir, job.output_file);
        if (fs.existsSync(abs)) {
          files.push({ abs, name: `${it.name}${path.extname(job.output_file)}` });
        }
      }
    }
    if (files.length === 0) {
      res.status(409).json({ error: "No completed outputs to download yet" });
      return;
    }

    const safe = batch.name.replace(/[^a-zA-Z0-9-_]+/g, "_") || "batch";
    res.attachment(`${safe}.zip`);
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      res.status(500).end(err.message);
    });
    archive.pipe(res);
    for (const f of files) archive.file(f.abs, { name: f.name });
    await archive.finalize();
  })
);

function statusCounts(batchId: string): {
  completed: number;
  failed: number;
  active: number;
  queued: number;
} {
  const rows = db
    .prepare(
      `SELECT j.status AS status, COUNT(*) AS c
         FROM batch_items i JOIN render_jobs j ON j.id = i.job_id
        WHERE i.batch_id = ? GROUP BY j.status`
    )
    .all(batchId) as Array<{ status: string; c: number }>;
  const out = { completed: 0, failed: 0, active: 0, queued: 0 };
  for (const r of rows) {
    if (r.status === "completed") out.completed = r.c;
    else if (r.status === "failed") out.failed = r.c;
    else if (r.status === "active") out.active = r.c;
    else out.queued += r.c;
  }
  return out;
}

export default router;
