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
import { runFfmpeg } from "./ffmpeg.js";
import type { RenderManifest } from "./manifest.js";

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

  if (job.kind === "manifest") {
    const manifest = JSON.parse(job.manifest_json || "{}") as RenderManifest;
    const built = await buildArgsFromManifest(manifest, abs);
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

  completeJob(job.id, file, result.durationSec);
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
