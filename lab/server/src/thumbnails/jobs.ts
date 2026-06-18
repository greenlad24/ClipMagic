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
 * edits vary in count from 0 to 4. The character SWAP is now the LAST image
 * operation (so the final face can't drift), so it owns the heaviest band and
 * sits just before finalize:
 *
 *   fetch source        5
 *   change outfit      20
 *   optional edits     25   (spread across however many actually run + background)
 *   swap in character  35   (the strong final identity swap — the most important)
 *   finalize           15   (crop to a clean, native-resolution 16:9 JPG)
 *                     ───
 *                     100
 */
export const PHASE_WEIGHTS = {
  fetch: 5,
  outfit: 20,
  edits: 25,
  swap: 35,
  finalize: 15,
} as const;
export type Phase = keyof typeof PHASE_WEIGHTS;

/** Cumulative percent AT THE START of each phase (its floor). */
export const PHASE_START: Record<Phase, number> = {
  fetch: 0,
  outfit: PHASE_WEIGHTS.fetch, // 5
  edits: PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.outfit, // 25
  swap: PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.outfit + PHASE_WEIGHTS.edits, // 50
  finalize:
    PHASE_WEIGHTS.fetch +
    PHASE_WEIGHTS.outfit +
    PHASE_WEIGHTS.edits +
    PHASE_WEIGHTS.swap, // 85
};

/** Human label per phase (shown under each variant). */
export const PHASE_LABEL: Record<Phase, string> = {
  fetch: "Fetching source thumbnail",
  outfit: "Changing outfit",
  edits: "Applying text/logo edits",
  swap: "Swapping in your character",
  finalize: "Finalizing thumbnail",
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

/**
 * One provider sub-run within a variant. A variant now has exactly ONE of these
 * (the single chosen provider), carrying its OWN progress + download. The list
 * shape is kept (length 1) so the rest of the job model is unchanged.
 */
export interface ProviderResult {
  /** Which provider drove this sub-run. */
  provider: string;
  /** Display label for the result ("Nano Banana Pro · 4K", "Nano Banana (Flash)"). */
  label: string;
  status: VariantStatus;
  /** Current step sentence for THIS sub-run. */
  stepLabel: string;
  /** 0..100, monotonic per sub-run. */
  percent: number;
  /** Present THE MOMENT this sub-run finishes successfully. */
  outputUrl?: string;
  /** Present when this sub-run errored (the sibling keeps going). */
  error?: string;
  /** Contrarian only: lets the UI re-render the headline at a new size live. */
  overlay?: ContrarianOverlay;
}

/** Everything needed to RE-RENDER a contrarian headline onto its base image. */
export interface ContrarianOverlay {
  /** Served URL of the pre-text composite (the base to re-draw the headline on). */
  baseUrl: string;
  templateId: string;
  text: string;
  emphasis: string;
  /** The size multiplier currently rendered (1 = box fit). */
  textScale: number;
  /** The vertical nudge currently rendered (fraction of frame height; 0 = centred). */
  textOffsetY: number;
}

/**
 * One generated variant (one selected pick). Carries its `results` (a single
 * provider sub-run). The top-level status/stepLabel/percent/outputUrl/error are
 * DERIVED aggregates over that result — `percent` is its mean, `status` tracks
 * it, and `outputUrl`/`error` surface its success / failure — so callers that
 * only need a single summary still work.
 */
export interface JobVariant {
  index: number;
  videoId: string;
  sourceThumbnailUrl: string;
  expression: string;
  /** The provider sub-run(s) — always exactly one now. */
  results: ProviderResult[];
  status: VariantStatus;
  /** Current step sentence ("Changing outfit", "Finalizing thumbnail", …). */
  stepLabel: string;
  /** 0..100, monotonic per variant (mean of the sub-runs). */
  percent: number;
  /** Present THE MOMENT a sub-run finishes successfully (first success). */
  outputUrl?: string;
  /** Present when EVERY sub-run errored (per-provider failures live on results). */
  error?: string;
  /** Contrarian only: re-render info for the first successful sub-run. */
  overlay?: ContrarianOverlay;
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

/**
 * Create a job seeded with one queued variant per pick. Each seed lists the
 * provider sub-run to render (always one entry — the single chosen provider).
 * `providers` defaults to a single empty-label sub-run so old callers/tests that
 * don't pass providers still get a coherent one-result variant.
 */
export function createJob(
  seeds: Array<{
    videoId: string;
    sourceThumbnailUrl: string;
    expression: string;
    providers?: Array<{ provider: string; label: string }>;
  }>,
): ThumbnailJob {
  reap();
  const now = Date.now();
  const job: ThumbnailJob = {
    id: nanoid(),
    percent: 0,
    done: seeds.length === 0,
    variants: seeds.map((s, index) => {
      const providers = s.providers && s.providers.length > 0 ? s.providers : [{ provider: "", label: "" }];
      return {
        index,
        videoId: s.videoId,
        sourceThumbnailUrl: s.sourceThumbnailUrl,
        expression: s.expression,
        results: providers.map((p) => ({
          provider: p.provider,
          label: p.label,
          status: "queued" as VariantStatus,
          stepLabel: "Queued",
          percent: 0,
        })),
        status: "queued" as VariantStatus,
        stepLabel: "Queued",
        percent: 0,
      };
    }),
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
 * Re-derive a variant's aggregate from its provider sub-runs:
 *   percent  — monotonic MEAN of the sub-run percents (so the variant bar tracks
 *              the average of the side-by-side runs and never goes backwards).
 *   status   — "running" while any sub-run is queued/running; once all are
 *              terminal it's "done" if ANY succeeded, else "error".
 *   stepLabel— the step of the furthest-behind still-running sub-run (else a
 *              terminal summary), so the single summary line is meaningful.
 *   outputUrl— the FIRST successful sub-run's URL (a one-glance summary).
 *   error    — only set when EVERY sub-run errored (per-provider failures live on
 *              the results themselves, so one failure never erases the other's URL).
 */
function recomputeVariant(v: JobVariant): void {
  const rs = v.results;
  const mean = rs.length ? rs.reduce((s, r) => s + r.percent, 0) / rs.length : 0;
  v.percent = Math.max(v.percent, Math.round(mean));
  const anyActive = rs.some((r) => r.status === "queued" || r.status === "running");
  const anyDone = rs.some((r) => r.status === "done");
  if (anyActive) {
    v.status = "running";
    const running = rs.filter((r) => r.status === "queued" || r.status === "running");
    const behind = running.reduce((a, b) => (b.percent < a.percent ? b : a), running[0]);
    v.stepLabel = behind?.stepLabel ?? v.stepLabel;
  } else {
    v.status = anyDone ? "done" : "error";
    v.stepLabel = anyDone ? "Done" : "Failed";
  }
  const firstDone = rs.find((r) => r.status === "done" && r.outputUrl);
  v.outputUrl = firstDone?.outputUrl;
  v.overlay = firstDone?.overlay;
  v.error = anyDone ? undefined : rs.find((r) => r.error)?.error;
}

/** Attach contrarian re-render info to a finished sub-run (and re-derive the aggregate). */
export function attachResultOverlay(job: ThumbnailJob, variantIndex: number, provider: string, overlay: ContrarianOverlay): void {
  const v = job.variants[variantIndex];
  if (!v) return;
  const r = findResult(v, provider);
  if (!r) return;
  r.overlay = overlay;
  recomputeVariant(v);
  job.updatedAt = Date.now();
}

/** Locate a sub-run within a variant by provider id (or index for the lone run). */
function findResult(v: JobVariant, provider: string): ProviderResult | undefined {
  if (v.results.length === 1) return v.results[0];
  return v.results.find((r) => r.provider === provider);
}

/**
 * Update ONE provider sub-run's live progress. `percent` is clamped to [0,100]
 * and never allowed to decrease (monotonic per sub-run). Re-derives the variant
 * aggregate + the overall bar.
 */
export function updateResult(
  job: ThumbnailJob,
  variantIndex: number,
  provider: string,
  patch: Partial<Pick<ProviderResult, "status" | "stepLabel" | "percent" | "outputUrl" | "error">>,
): void {
  const v = job.variants[variantIndex];
  if (!v) return;
  const r = findResult(v, provider);
  if (!r) return;
  if (patch.status !== undefined) r.status = patch.status;
  if (patch.stepLabel !== undefined) r.stepLabel = patch.stepLabel;
  if (patch.percent !== undefined) {
    r.percent = Math.max(r.percent, Math.max(0, Math.min(100, Math.round(patch.percent))));
  }
  if (patch.outputUrl !== undefined) r.outputUrl = patch.outputUrl;
  if (patch.error !== undefined) r.error = patch.error;
  recomputeVariant(v);
  job.updatedAt = Date.now();
  recomputeOverall(job);
}

/** Mark ONE provider sub-run terminal (done with a URL, or errored). */
export function finishResult(
  job: ThumbnailJob,
  variantIndex: number,
  provider: string,
  result: { outputUrl: string } | { error: string },
): void {
  if ("outputUrl" in result) {
    updateResult(job, variantIndex, provider, { status: "done", stepLabel: "Done", percent: 100, outputUrl: result.outputUrl });
  } else {
    updateResult(job, variantIndex, provider, { status: "error", stepLabel: "Failed", percent: 100, error: result.error });
  }
  maybeFinish(job);
}

/**
 * Update a variant's live progress by fanning the patch across ALL its sub-runs.
 * Used for variant-wide transitions (e.g. the shared fetch phase) and kept for
 * back-compat with callers/tests that drive a single-sub-run variant directly.
 */
export function updateVariant(
  job: ThumbnailJob,
  index: number,
  patch: Partial<Pick<JobVariant, "status" | "stepLabel" | "percent" | "outputUrl" | "error">>,
): void {
  const v = job.variants[index];
  if (!v) return;
  for (const r of v.results) {
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.stepLabel !== undefined) r.stepLabel = patch.stepLabel;
    if (patch.percent !== undefined) {
      r.percent = Math.max(r.percent, Math.max(0, Math.min(100, Math.round(patch.percent))));
    }
    if (patch.outputUrl !== undefined) r.outputUrl = patch.outputUrl;
    if (patch.error !== undefined) r.error = patch.error;
  }
  recomputeVariant(v);
  job.updatedAt = Date.now();
  recomputeOverall(job);
}

/**
 * Mark a WHOLE variant terminal across every sub-run: done (with one outputUrl)
 * or error (with a message). Used in single-provider mode and for variant-wide
 * failures (e.g. the source download threw before any sub-run started).
 */
export function finishVariant(
  job: ThumbnailJob,
  index: number,
  result: { outputUrl: string } | { error: string },
): void {
  if ("outputUrl" in result) {
    updateVariant(job, index, { status: "done", stepLabel: "Done", percent: 100, outputUrl: result.outputUrl });
  } else {
    updateVariant(job, index, { status: "error", stepLabel: "Failed", percent: 100, error: result.error });
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
    // Deep-copy each variant (incl. its sub-runs) so a poll response can't be
    // mutated by later progress ticks.
    variants: job.variants.map((v) => ({ ...v, results: v.results.map((r) => ({ ...r })) })),
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
