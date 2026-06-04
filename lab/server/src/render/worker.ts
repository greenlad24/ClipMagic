import path from "node:path";
import { config, ensureDirs } from "../config.js";
import {
  claimNextJob,
  completeJob,
  failJob,
  setProgress,
  requeueStuckJobs,
  queueDepth,
  type RenderJob,
} from "../db/jobs.js";
import { resolveCommand } from "./command.js";
import { buildArgsFromManifest } from "./build.js";
import { buildCutArgs, type CutSpec } from "./cut.js";
import { runFfmpeg } from "./ffmpeg.js";
import type { RenderManifest } from "./manifest.js";
import { Projects, MemeProjects } from "../zite/store.js";
import { mergeRenderStats, type OptimizationReport } from "../ai/runAccounting.js";
import { applyMotionGraphics } from "../motion/stage.js";
import { applyEmphasisStickers } from "../meme/stage.js";
import fs from "node:fs";

/**
 * In-process render worker pool backed by the SQLite job queue. Runs up to
 * `RENDER_CONCURRENCY` FFmpeg jobs at once. No Redis / external broker — that
 * keeps the whole product on a single droplet (the "save costs / one server"
 * goal) while still draining a 300+ job backlog reliably, with persistence and
 * retries across restarts.
 *
 * Model: each free slot claims and processes exactly one job, then calls pump()
 * to refill. pump() is gated on queue depth so it never busy-spins when idle.
 */

let running = false;
let activeSlots = 0;
let wakeTimer: NodeJS.Timeout | null = null;

function outputPathFor(job: RenderJob): { file: string; abs: string } {
  const ext = path.extname(job.output_name) || ".mp4";
  const file = `${job.id}${ext}`;
  return { file, abs: path.join(config.outputsDir, file) };
}

async function processJob(job: RenderJob): Promise<void> {
  const { file, abs } = outputPathFor(job);
  let totalDuration = 0;
  let args: string[];
  let measureStats: { hits: number; misses: number } | undefined;

  if (job.kind === "manifest") {
    const manifest = JSON.parse(job.manifest_json || "{}") as RenderManifest;
    const built = await buildArgsFromManifest(manifest, abs);
    args = built.args;
    totalDuration = built.totalDuration;
    measureStats = built.measureStats;
  } else if (job.kind === "cut") {
    // Narration cut: trim source to keep-segments and concatenate. The spec is
    // stored in the manifest_json column.
    const spec = JSON.parse(job.manifest_json || "{}") as CutSpec;
    const built = buildCutArgs(spec, abs);
    args = built.args;
    totalDuration = built.totalDuration;
  } else {
    const inputFiles = JSON.parse(job.input_files_json || "{}") as Record<string, string>;
    // Rendi commands use a single output placeholder; accept common names.
    const outputs: Record<string, string> = { out_1: abs, out_0: abs, output: abs };
    const resolved = await resolveCommand(job.command || "", inputFiles, outputs);
    args = resolved.args;
    totalDuration = job.duration_sec ?? 0;
  }

  let lastWritten = 0;
  const result = await runFfmpeg(args, totalDuration, (frac) => {
    const pct = Math.round(frac * 100) / 100;
    if (pct - lastWritten >= 0.02 || pct >= 1) {
      lastWritten = pct;
      setProgress(job.id, pct);
    }
  });

  // ── Motion-graphics stage (flag-gated, best-effort) ────────────────────────
  // Composite the director's Remotion overlays onto the just-finished render. A
  // SEPARATE pass that writes a new file and atomically replaces `abs`; if the
  // flag is off or anything fails, `abs` is left exactly as the main render
  // produced it (zero regression). Only manifest jobs carry motion graphics.
  let motionSpawns = 0;
  if (job.kind === "manifest" && config.motionGraphicsEnabled) {
    const manifest = JSON.parse(job.manifest_json || "{}") as RenderManifest;
    const graphics = manifest.motionGraphics ?? [];
    if (graphics.length > 0) {
      try {
        const r = await applyMotionGraphics(abs, graphics, totalDuration);
        if (r.replacedFile && r.replacedFile !== abs) {
          fs.renameSync(r.replacedFile, abs);
        }
        motionSpawns = r.ffmpegSpawns;
      } catch (e) {
        console.warn(
          `[worker] motion-graphics stage skipped for job ${job.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  // ── Emphasis-sticker stage (Meme/Sticker editor, best-effort) ──────────────
  // Composites the funny generated stills BELOW the captions for manifest jobs
  // that carry emphasisStickers. Same isolated, never-throws design as the
  // motion stage: on missing Chromium / image / any error, `abs` is left as the
  // captions-only render produced it (graceful fallback). Independent of the
  // MOTION_GRAPHICS flag — the meme editor opts in by populating the field.
  if (job.kind === "manifest") {
    const manifest = JSON.parse(job.manifest_json || "{}") as RenderManifest;
    const stickers = manifest.emphasisStickers ?? [];
    if (stickers.length > 0) {
      try {
        const r = await applyEmphasisStickers(abs, stickers, totalDuration);
        if (r.replacedFile && r.replacedFile !== abs) {
          fs.renameSync(r.replacedFile, abs);
        }
        motionSpawns += r.ffmpegSpawns;
      } catch (e) {
        console.warn(
          `[worker] emphasis-sticker stage skipped for job ${job.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }

  completeJob(job.id, file, result.durationSec);

  // Complete the Optimization Report's speed section with REAL render-time
  // numbers: caption-memo hits/misses and the ffmpeg spawn count (1 main render
  // + 2 per caption measurement). Best-effort — never fails the render.
  if (job.kind === "manifest" && job.project_id && measureStats) {
    try {
      // The report lives on the project record. Short-form/bulk use Projects;
      // the Meme/Sticker editor uses MemeProjects. Look up whichever holds it so
      // the meme editor's render-time sticker spawns land in its report too.
      const inProjects = await Projects.findOne({ id: job.project_id });
      const store = inProjects?.optimizationReportJson ? Projects : MemeProjects;
      const project = inProjects?.optimizationReportJson
        ? inProjects
        : await MemeProjects.findOne({ id: job.project_id });
      if (project?.optimizationReportJson) {
        const report = JSON.parse(project.optimizationReportJson as string) as OptimizationReport;
        const ffmpegSpawns = 1 + measureStats.misses * 2 + motionSpawns;
        const updated = mergeRenderStats(report, {
          captionMeasureHits: measureStats.hits,
          captionMeasureMisses: measureStats.misses,
          ffmpegSpawns,
          motionGraphicsSpawns: motionSpawns,
        });
        await store.update({
          id: job.project_id,
          record: { optimizationReportJson: JSON.stringify(updated) },
        });
      }
    } catch (e) {
      console.warn(
        `[OptimizationReport] render-stats merge skipped for ${job.project_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Run a single slot: claim one job, process it, then refill the pool. */
function startSlot(): void {
  activeSlots++; // synchronous — pump() relies on this being set before it loops
  void (async () => {
    try {
      const job = claimNextJob();
      if (!job) return;
      try {
        await processJob(job);
        console.log(`[worker] job ${job.id} completed`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = failJob(job.id, msg);
        console.error(
          `[worker] job ${job.id} ${status === "queued" ? "retrying" : "failed"}: ${msg.split("\n")[0]}`
        );
      }
    } finally {
      activeSlots--;
      pump();
    }
  })();
}

/** Fill idle slots while there is queued work. Safe to call repeatedly. */
export function pump(): void {
  if (!running) return;
  while (activeSlots < config.renderConcurrency && queueDepth().queued > 0) {
    startSlot();
  }
}

export function startWorker(): void {
  if (running) return;
  ensureDirs();
  const requeued = requeueStuckJobs();
  if (requeued > 0) console.log(`[worker] requeued ${requeued} interrupted job(s)`);
  running = true;
  console.log(`[worker] started — concurrency=${config.renderConcurrency}`);
  wakeTimer = setInterval(() => pump(), 2000); // safety net for missed wakes
  pump();
}

export function stopWorker(): void {
  running = false;
  if (wakeTimer) clearInterval(wakeTimer);
  wakeTimer = null;
}
