/**
 * In-memory progress store for the Thumbnail Designer's GENERATION step.
 *
 * Generation used to run as one long, blocking request that returned every
 * recreated thumbnail at once behind a single spinner — no feedback while the
 * (slow, multi-call) Nano Banana chain ground through each pick. This turns it
 * into a polled job, mirroring the Narration Cutter's analyze-job pattern
 * (`cutter/analyzeJob.ts`):
 *   - `startThumbnailGeneration` creates a job, kicks the work off in the
 *     background, and returns a jobId immediately.
 *   - `thumbnailJobStatus` returns a live snapshot the UI polls every ~1.2s:
 *     an overall (monotonic) percent, a per-variant row with its current step
 *     label + sub-percent, and each variant's outputUrl THE MOMENT it lands.
 *
 * Generation is short-lived + single-server, so an in-memory Map is plenty;
 * finished jobs are reaped after a TTL (and capped) so it never grows unbounded.
 *
 * The progress MATH here is pure + in-memory (no network, no ffmpeg, no AI), so
 * the monotonic-overall and phase-weighting invariants are unit-testable in
 * isolation. The heavy work is driven from the endpoint, which only calls the
 * small mutators below.
 */
import { nanoid } from "nanoid";

/** Lifecycle of one variant (one selected pick). */
export type VariantStatus = "queued" | "running" | "done" | "error";

/**
 * The recreation chain runs in phases of fixed RELATIVE weight (summing to 100)
 * so the per-variant bar stays smooth even though the optional art-director
 * edits vary in count from 0 to 4:
 *
 *   fetch source        5
 *   replace character  35
 *   change outfit      25
 *   optional edits     20   (spread across however many actually run)
 *   finalize           15   (crop + upscale to 1080p)
 *                     ───
 *                     100
 */
export const PHASE_WEIGHTS = {
  fetch: 5,
  replaceCharacter: 35,
  outfit: 25,
  edits: 20,
  finalize: 15,
} as const;
export type Phase = keyof typeof PHASE_WEIGHTS;

/** Cumulative percent AT THE START of each phase (its floor). */
export const PHASE_START: Record<Phase, number> = {
  fetch: 0,
  replaceCharacter: PHASE_WEIGHTS.fetch, // 5
  outfit: PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.replaceCharacter, // 40
  edits: PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.replaceCharacter + PHASE_WEIGHTS.outfit, // 65
  finalize:
    PHASE_WEIGHTS.fetch +
    PHASE_WEIGHTS.replaceCharacter +
    PHASE_WEIGHTS.outfit +
    PHASE_WEIGHTS.edits, // 85
};

/** Human label per phase (shown under each variant). */
export const PHASE_LABEL: Record<Phase, string> = {
  fetch: "Fetching source thumbnail",
  replaceCharacter: "Replacing character",
  outfit: "Changing outfit",
  edits: "Applying text/logo edits",
  finalize: "Upscaling to 1080p",
};

/**
 * Compute a variant's cumulative percent at the point a phase COMPLETES `frac`
 * (0..1) of its work. For the optional-edits phase, `frac` is "edits done so
 * far / total planned edits"; pass frac=1 (or 0 planned edits) to mean the band
 * is fully consumed. Always lands within [phase floor, next phase floor].
 */
export function phasePercent(phase: Phase, frac: number): number {
  const start = PHASE_START[phase];
  const weight = PHASE_WEIGHTS[phase];
  const f = Math.max(0, Math.min(1, frac));
  return Math.round(start + weight * f);
}

/** One generated variant, surfaced live to the UI. */
export interface JobVariant {
  index: number;
  videoId: string;
  sourceThumbnailUrl: string;
  expression: string;
  status: VariantStatus;
  /** Current step sentence ("Replacing character", "Upscaling to 1080p", …). */
  stepLabel: string;
  /** 0..100, monotonic per variant. */
  percent: number;
  /** Present THE MOMENT this variant finishes successfully. */
  outputUrl?: string;
  /** Present when this variant errored (others keep going). */
  error?: string;
}

export interface ThumbnailJob {
  id: string;
  /** Overall 0..100, monotonic — the mean of the per-variant percents. */
  percent: number;
  /** True once every variant is done or errored. */
  done: boolean;
  /** Fatal job-level error (the background runner crashed). Per-variant
   *  failures live on the variant, not here. */
  error?: string;
  variants: JobVariant[];
  createdAt: number;
  updatedAt: number;
}

/** A poll-friendly snapshot (a structural copy so callers can't mutate state). */
export interface ThumbnailJobSnapshot {
  jobId: string;
  percent: number;
  done: boolean;
  error: string | null;
  variants: JobVariant[];
}

// ── In-memory registry ───────────────────────────────────────────────────────
// Generation jobs are ephemeral (seconds to a couple of minutes). Finished jobs
// are reaped after a TTL so the UI can still fetch the final snapshot a few
// times, and the map is hard-capped so a long session never leaks memory.
const JOB_TTL_MS = 10 * 60_000; // keep finished jobs pollable for 10 min
const MAX_JOBS = 50; // hard cap (oldest evicted first)
const jobs = new Map<string, ThumbnailJob>();

/** Create a job seeded with one queued variant per pick. */
export function createJob(
  seeds: Array<{ videoId: string; sourceThumbnailUrl: string; expression: string }>,
): ThumbnailJob {
  reap();
  const now = Date.now();
  const job: ThumbnailJob = {
    id: nanoid(),
    percent: 0,
    done: seeds.length === 0,
    variants: seeds.map((s, index) => ({
      index,
      videoId: s.videoId,
      sourceThumbnailUrl: s.sourceThumbnailUrl,
      expression: s.expression,
      status: "queued",
      stepLabel: "Queued",
      percent: 0,
    })),
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): ThumbnailJob | undefined {
  return jobs.get(id);
}

/** Recompute the overall percent (mean of per-variant percents), monotonic. */
function recomputeOverall(job: ThumbnailJob): void {
  if (job.variants.length === 0) {
    job.percent = 100;
    return;
  }
  const mean = job.variants.reduce((s, v) => s + v.percent, 0) / job.variants.length;
  job.percent = Math.max(job.percent, Math.round(mean)); // never goes backwards
}

/**
 * Update one variant's live progress. `percent` is clamped to [0,100] and never
 * allowed to decrease (monotonic per variant). Recomputes the overall bar.
 */
export function updateVariant(
  job: ThumbnailJob,
  index: number,
  patch: Partial<Pick<JobVariant, "status" | "stepLabel" | "percent" | "outputUrl" | "error">>,
): void {
  const v = job.variants[index];
  if (!v) return;
  if (patch.status !== undefined) v.status = patch.status;
  if (patch.stepLabel !== undefined) v.stepLabel = patch.stepLabel;
  if (patch.percent !== undefined) {
    v.percent = Math.max(v.percent, Math.max(0, Math.min(100, Math.round(patch.percent))));
  }
  if (patch.outputUrl !== undefined) v.outputUrl = patch.outputUrl;
  if (patch.error !== undefined) v.error = patch.error;
  job.updatedAt = Date.now();
  recomputeOverall(job);
}

/**
 * Mark a variant terminal: done (with outputUrl) or error (with message). Either
 * way the variant's bar snaps to 100 so the overall bar can reach 100 when every
 * variant is terminal.
 */
export function finishVariant(
  job: ThumbnailJob,
  index: number,
  result: { outputUrl: string } | { error: string },
): void {
  if ("outputUrl" in result) {
    updateVariant(job, index, {
      status: "done",
      stepLabel: "Done",
      percent: 100,
      outputUrl: result.outputUrl,
    });
  } else {
    updateVariant(job, index, {
      status: "error",
      stepLabel: "Failed",
      percent: 100,
      error: result.error,
    });
  }
  maybeFinish(job);
}

/** Set the whole job done when every variant is terminal. */
function maybeFinish(job: ThumbnailJob): void {
  const allTerminal = job.variants.every((v) => v.status === "done" || v.status === "error");
  if (allTerminal) {
    job.done = true;
    job.updatedAt = Date.now();
  }
}

/** Mark the whole job done (e.g. the runner finished or crashed). */
export function completeJob(job: ThumbnailJob, error?: string): void {
  if (error) job.error = error;
  job.done = true;
  job.updatedAt = Date.now();
}

export function snapshot(job: ThumbnailJob): ThumbnailJobSnapshot {
  return {
    jobId: job.id,
    percent: job.percent,
    done: job.done,
    error: job.error ?? null,
    // Copy each variant so a poll response can't be mutated by later progress ticks.
    variants: job.variants.map((v) => ({ ...v })),
  };
}

/** GC finished jobs past their TTL, then evict oldest if still over the cap. */
function reap(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.done && job.updatedAt < cutoff) jobs.delete(id);
  }
  if (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= jobs.size - MAX_JOBS; i++) {
      if (oldest[i]) jobs.delete(oldest[i].id);
    }
  }
}

/** Test-only: clear the registry between cases. */
export function _resetJobsForTest(): void {
  jobs.clear();
}
