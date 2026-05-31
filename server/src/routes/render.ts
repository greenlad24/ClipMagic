import { Router } from "express";
import { z } from "zod";
import { createJob, getJob, type RenderJob } from "../db/jobs.js";
import { db } from "../db/index.js";
import { asyncHandler } from "../middleware.js";
import { pump } from "../render/worker.js";
import { publicUrlFor } from "../lib/urls.js";
import type { Request } from "express";

/**
 * Render API in two flavours that share the same queue + local FFmpeg engine:
 *
 *  1. Rendi-compatible shim (/v1/run-ffmpeg-command, /v1/commands/:id) so the
 *     existing frontend adapter (src/utils/rendiAdapter.ts + submitRendiJob)
 *     works against this server by only changing the base URL. Drop-in Rendi
 *     replacement — no rewrite of the client render path required.
 *
 *  2. Native manifest API (/api/render/manifest, /api/render/:id) which takes a
 *     RenderManifest directly and is what the bulk path uses.
 */

// ── Status mapping ───────────────────────────────────────────────────────────
function toRendiStatus(s: RenderJob["status"]): string {
  switch (s) {
    case "queued":
      return "QUEUED";
    case "active":
      return "RUNNING";
    case "completed":
      return "SUCCESS";
    default:
      return "FAILED";
  }
}

function outputUrl(req: Request, job: RenderJob): string | null {
  return job.output_file ? publicUrlFor(req, `/api/outputs/${job.output_file}`) : null;
}

// ── Rendi-compatible shim ────────────────────────────────────────────────────
export const rendiRouter = Router();

const runSchema = z.object({
  input_files: z.record(z.string()).default({}),
  ffmpeg_command: z.string().min(1),
  output_files: z.record(z.string()).optional(),
  // Optional extension so we can show real progress on the Rendi path too.
  duration_seconds: z.number().positive().optional(),
  project_id: z.string().optional(),
});

rendiRouter.post(
  "/run-ffmpeg-command",
  asyncHandler(async (req, res) => {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const { input_files, ffmpeg_command, output_files, duration_seconds, project_id } = parsed.data;
    const outputName = output_files ? Object.values(output_files)[0] || "output.mp4" : "output.mp4";

    const id = createJob({
      kind: "command",
      command: ffmpeg_command,
      inputFiles: input_files,
      outputName,
      projectId: project_id ?? null,
    });
    if (duration_seconds) {
      db.prepare("UPDATE render_jobs SET duration_sec=? WHERE id=?").run(duration_seconds, id);
    }
    if (project_id) {
      db.prepare("UPDATE projects SET render_command_id=?, status='Rendering', updated_at=? WHERE id=?")
        .run(id, Date.now(), project_id);
    }
    pump();
    res.json({ command_id: id });
  })
);

rendiRouter.get("/commands/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Unknown command" });
    return;
  }
  const status = toRendiStatus(job.status);
  const url = outputUrl(req, job);
  const output_files = url ? { out_1: { storage_url: url } } : {};
  res.json({
    command_id: job.id,
    status,
    progress: job.progress,
    error: job.error,
    output_files,
  });
});

// ── Native manifest API ──────────────────────────────────────────────────────
export const renderRouter = Router();

const manifestSchema = z.object({
  manifest: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    fps: z.number().positive(),
    durationSeconds: z.number().positive(),
    narration: z.object({ videoUrl: z.string().min(1) }).passthrough(),
  }).passthrough(),
  projectId: z.string().optional(),
  outputName: z.string().optional(),
});

renderRouter.post(
  "/manifest",
  asyncHandler(async (req, res) => {
    const parsed = manifestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid manifest", details: parsed.error.flatten() });
      return;
    }
    const { manifest, projectId, outputName } = parsed.data;
    const id = createJob({
      kind: "manifest",
      manifest,
      outputName: outputName || `${projectId || "render"}.mp4`,
      projectId: projectId ?? null,
    });
    db.prepare("UPDATE render_jobs SET duration_sec=? WHERE id=?")
      .run((manifest as { durationSeconds: number }).durationSeconds, id);
    if (projectId) {
      db.prepare("UPDATE projects SET render_command_id=?, status='Rendering', updated_at=? WHERE id=?")
        .run(id, Date.now(), projectId);
    }
    pump();
    res.json({ jobId: id });
  })
);

renderRouter.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    outputUrl: outputUrl(req, job),
    durationSec: job.duration_sec,
  });
});

export default renderRouter;
