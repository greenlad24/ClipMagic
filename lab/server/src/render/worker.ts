import path from "node:path";
import { config, ensureDirs } from "../config.js";
import {
  claimNextJob,
  completeJob,
  failJob,
  setProgress,
  setStage,
  requeueStuckJobs,
  queueDepth,
  getJob,
  markPaused,
  cancelJob as cancelJobRow,
  type RenderJob,
} from "../db/jobs.js";
import { mainRenderProgress, stageProgress } from "./progress.js";
import { resolveCommand } from "./command.js";
import { buildArgsFromManifest } from "./build.js";
import { buildCutArgs, type CutSpec } from "./cut.js";
import { runFfmpeg, FfmpegCanceledError } from "./ffmpeg.js";
import { getIntent, forgetJob } from "./jobControl.js";
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

/**
 * After a canceled job unwinds: ensure the row is 'canceled' (the control layer
 * usually set it already, but a forced ffmpeg kill can race ahead of it) and
 * remove any partial output file so a half-written .mp4 is never served.
 */
function finalizeCanceled(job: RenderJob): void {
  const fresh = getJob(job.id);
  if (fresh && fresh.status !== "canceled") {
    cancelJobRow(job.id, "Canceled by user");
  }
  const { abs } = outputPathFor(job);
  fs.rm(abs, { force: true }, () => {});
}

/** Raised when a job is canceled mid-flight so processJob unwinds cleanly. */
class JobCanceledError extends Error {
  constructor() {
    super("job canceled");
    this.name = "JobCanceledError";
  }
}

/**
 * A cooperative checkpoint between heavy stages. The main ffmpeg render is
 * paused/killed at the process level, but the sequential Remotion composite
 * stages can't be SIGSTOP'd cleanly — so before each we honour any pause/cancel
 * intent here: cancel throws to unwind; pause blocks (and flips the DB to
 * 'paused') until the operator resumes or cancels.
 */
async function checkpoint(jobId: string): Promise<void> {
  let announcedPause = false;
  for (;;) {
    const intent = getIntent(jobId);
    if (intent === "cancel") throw new JobCanceledError();
    if (intent === "pause") {
      if (!announcedPause) {
        markPaused(jobId);
        announcedPause = true;
      }
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    // intent === "none". If we had paused, the resume already flipped the DB
    // row back to 'active' (control layer), so just proceed.
    return;
  }
}

async function processJob(job: RenderJob): Promise<void> {
  const { file, abs } = outputPathFor(job);
  let totalDuration = 0;
  let args: string[];
  let measureStats: { hits: number; misses: number } | undefined;

  // Parse the manifest once so we know up front whether a post-render Remotion
  // stage (motion graphics / emphasis stickers) follows the main render. When it
  // does, the main render only owns the FRONT of the bar and the stage owns the
  // reserved tail — so 100% means the final output is truly done.
  const manifest =
    job.kind === "manifest"
      ? (JSON.parse(job.manifest_json || "{}") as RenderManifest)
      : null;
  const motionGraphics = manifest?.motionGraphics ?? [];
  const emphasisStickers = manifest?.emphasisStickers ?? [];
  const hasPostRender = motionGraphics.length > 0 || emphasisStickers.length > 0;

  if (job.kind === "manifest" && manifest) {
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

  // If a cancel was requested while the job sat queued, skip the spawn entirely.
  if (getIntent(job.id) === "cancel") throw new JobCanceledError();

  let lastWritten = 0;
  const result = await runFfmpeg(
    args,
    totalDuration,
    (frac) => {
      // Scale the main caption render into its band: [0, 0.55] when a post-render
      // stage follows, otherwise the whole bar [0, 1] (unchanged behaviour).
      const banded = mainRenderProgress(frac, hasPostRender);
      const pct = Math.round(banded * 100) / 100;
      // Throttle to ~2% steps; always flush the band's final value (frac>=1).
      if (pct - lastWritten >= 0.02 || frac >= 1) {
        lastWritten = pct;
        setProgress(job.id, pct);
      }
    },
    job.id,
  );

  // ── Motion-graphics stage (manifest-driven, best-effort) ───────────────────
  // Composite the director's Remotion overlays onto the just-finished render. A
  // SEPARATE pass that writes a new file and atomically replaces `abs`. The
  // decision (default-on toggle / force-disable) was already made at submit time
  // and is captured by whether the manifest carries any motionGraphics, so the
  // worker simply applies what's there. applyMotionGraphics still re-checks
  // Chromium availability and force-disable internally; on any failure `abs` is
  // left exactly as the main render produced it (zero regression).
  // Honour a pause/cancel requested during the main render before the (un-
  // signalable) Remotion composite stages begin.
  await checkpoint(job.id);

  // Drive the reserved tail [0.55, 1.0] of the bar from the post-render stage's
  // own 0..1 progress, and publish its human sub-stage label. Monotonic: never
  // moves the bar backwards. Best-effort — a reporting hiccup never blocks work.
  let lastStagePct = lastWritten;
  const reportStage = (frac: number, label: string) => {
    const pct = Math.round(stageProgress(frac) * 100) / 100;
    if (pct >= lastStagePct) {
      lastStagePct = pct;
      setStage(job.id, label, pct);
    }
  };

  let motionSpawns = 0;
  if (job.kind === "manifest" && motionGraphics.length > 0) {
    try {
      const r = await applyMotionGraphics(abs, motionGraphics, totalDuration, reportStage);
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

  // ── Emphasis-sticker stage (Meme/Sticker editor, best-effort) ──────────────
  // Composites the funny generated stills BELOW the captions for manifest jobs
  // that carry emphasisStickers. Same isolated, never-throws design as the
  // motion stage: on missing Chromium / image / any error, `abs` is left as the
  // captions-only render produced it (graceful fallback). Independent of the
  // MOTION_GRAPHICS flag — the meme editor opts in by populating the field.
  await checkpoint(job.id);

  let stickerStage: { applied: number; skipReason: string | null } | null = null;
  if (job.kind === "manifest" && emphasisStickers.length > 0) {
    try {
      const r = await applyEmphasisStickers(abs, emphasisStickers, totalDuration, reportStage);
      if (r.replacedFile && r.replacedFile !== abs) {
        fs.renameSync(r.replacedFile, abs);
      }
      motionSpawns += r.ffmpegSpawns;
      stickerStage = { applied: r.applied, skipReason: r.skipReason };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[worker] emphasis-sticker stage skipped for job ${job.id}: ${msg}`);
      stickerStage = { applied: 0, skipReason: `sticker stage error: ${msg}`.slice(0, 200) };
    }
  }

  completeJob(job.id, file, result.durationSec);

  // Persist the render-stage sticker outcome onto the meme record so the page can
  // show how many stickers landed and WHY a render fell back to captions-only
  // (Chromium unavailable, composite failed …) — instead of silently producing
  // none. Best-effort; only meme jobs carry emphasisStickers.
  if (job.kind === "manifest" && job.project_id && stickerStage) {
    try {
      await MemeProjects.update({
        id: job.project_id,
        record: {
          stickersApplied: stickerStage.applied,
          ...(stickerStage.skipReason ? { stickerSkipReason: stickerStage.skipReason } : {}),
        },
      });
    } catch (e) {
      console.warn(
        `[worker] sticker-stage diagnostics persist skipped for ${job.project_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

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
    let claimedId: string | null = null;
    try {
      const job = claimNextJob();
      if (!job) return;
      claimedId = job.id;
      try {
        await processJob(job);
        console.log(`[worker] job ${job.id} completed`);
      } catch (err) {
        if (err instanceof JobCanceledError || err instanceof FfmpegCanceledError) {
          // Cooperative/forced cancel — never retry. The control layer already
          // (or will) mark the row 'canceled' and clean partial output.
          finalizeCanceled(job);
          console.log(`[worker] job ${job.id} canceled`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          const status = failJob(job.id, msg);
          console.error(
            `[worker] job ${job.id} ${status === "queued" ? "retrying" : "failed"}: ${msg.split("\n")[0]}`
          );
        }
      }
    } finally {
      if (claimedId) forgetJob(claimedId);
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
