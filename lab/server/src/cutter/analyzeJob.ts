/**
 * In-memory job state for the Narration Cutter's ANALYZE step.
 *
 * The analyze step (resolve → probe → transcribe → waveform → segment) used to
 * run as one blocking request that froze the editor for minutes with a generic
 * spinner and an opaque failure if Groq hung. This turns it into a polled job:
 * the endpoint returns a jobId immediately, the heavy work runs in the
 * background updating a stage + numeric progress, and the editor polls for live
 * feedback (stage label, progress bar, a non-fatal transcription warning, or a
 * clear fatal error). It mirrors the existing render-job poll shape so the UI
 * pattern is consistent.
 *
 * The STATE machine here is pure + in-memory (no DB, no ffmpeg, no network) so
 * its transitions and progress/stage reporting are unit-testable in isolation.
 * The actual heavy work is driven from the endpoint, which only calls the small
 * mutators below.
 */
import { nanoid } from "nanoid";

/** Ordered analyze stages. `done`/`failed` are terminal. */
export type AnalyzeStage =
  | "queued"
  | "resolving"
  | "transcribing"
  | "waveform"
  | "segmenting"
  | "done"
  | "failed";

/** Human-readable label per stage (shown in the editor). */
export const ANALYZE_STAGE_LABEL: Record<AnalyzeStage, string> = {
  queued: "Queued",
  resolving: "Loading video",
  transcribing: "Transcribing (Groq)",
  waveform: "Building waveform",
  segmenting: "Segmenting takes",
  done: "Ready",
  failed: "Failed",
};

/**
 * Monotonic progress floor per stage (0..1). We report the floor on stage entry
 * and let `done` reach 1, so the bar only ever moves forward — never jumps back.
 */
export const ANALYZE_STAGE_PROGRESS: Record<AnalyzeStage, number> = {
  queued: 0.02,
  resolving: 0.1,
  transcribing: 0.35,
  waveform: 0.7,
  segmenting: 0.9,
  done: 1,
  failed: 0, // progress is frozen at wherever it failed (see setStage)
};

/** The analyze result payload (what the old blocking endpoint returned). */
export interface AnalyzeResultPayload {
  sourceUrl: string;
  duration: number;
  hasAudio: boolean;
  width?: number | null;
  height?: number | null;
  envelope: { db: number[]; hop: number; floorDb: number };
  words: { word: string; start: number; end: number }[];
  transcript: string;
  takes: unknown[];
  defaults: unknown;
}

export interface AnalyzeJob {
  id: string;
  stage: AnalyzeStage;
  /** Stage label, denormalized so the poll response is self-contained. */
  stageLabel: string;
  /** 0..1, monotonic. */
  progress: number;
  /** Non-fatal note (e.g. transcription unavailable) — analyze still completes. */
  warning: string | null;
  /** Fatal reason when `stage === "failed"`. */
  error: string | null;
  /** Present once `stage === "done"`. */
  result: AnalyzeResultPayload | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Advance a job to a new stage. Progress moves to the stage's floor but never
 * decreases (monotonic). `failed` freezes progress where it was so the bar shows
 * how far it got. Mutates + returns the same object.
 */
export function setStage(job: AnalyzeJob, stage: AnalyzeStage): AnalyzeJob {
  job.stage = stage;
  job.stageLabel = ANALYZE_STAGE_LABEL[stage];
  if (stage !== "failed") {
    job.progress = Math.max(job.progress, ANALYZE_STAGE_PROGRESS[stage]);
  }
  job.updatedAt = Date.now();
  return job;
}

/** Record a non-fatal warning (transcription unavailable, etc.). */
export function setWarning(job: AnalyzeJob, warning: string): AnalyzeJob {
  job.warning = warning;
  job.updatedAt = Date.now();
  return job;
}

/** Complete the job with its result payload. */
export function completeAnalyze(job: AnalyzeJob, result: AnalyzeResultPayload): AnalyzeJob {
  job.result = result;
  setStage(job, "done");
  return job;
}

/** Fail the job with a clear reason. */
export function failAnalyze(job: AnalyzeJob, error: string): AnalyzeJob {
  job.error = error;
  setStage(job, "failed");
  return job;
}

/** A poll-friendly snapshot (no heavy `result.envelope` arrays unless done). */
export interface AnalyzePoll {
  jobId: string;
  stage: AnalyzeStage;
  stageLabel: string;
  progress: number;
  warning: string | null;
  error: string | null;
  result: AnalyzeResultPayload | null;
}

export function pollSnapshot(job: AnalyzeJob): AnalyzePoll {
  return {
    jobId: job.id,
    stage: job.stage,
    stageLabel: job.stageLabel,
    progress: job.progress,
    warning: job.warning,
    error: job.error,
    // Only ship the (large) envelope payload once it's actually ready.
    result: job.stage === "done" ? job.result : null,
  };
}

// ── In-memory registry ───────────────────────────────────────────────────────
// Analyze jobs are ephemeral (a few minutes), so a Map is plenty. Finished jobs
// are reaped after a TTL so the editor can still fetch the result a few times.

const JOB_TTL_MS = 10 * 60_000; // keep finished jobs pollable for 10 min
const jobs = new Map<string, AnalyzeJob>();

export function createAnalyzeJob(): AnalyzeJob {
  reapExpired();
  const now = Date.now();
  const job: AnalyzeJob = {
    id: nanoid(),
    stage: "queued",
    stageLabel: ANALYZE_STAGE_LABEL.queued,
    progress: ANALYZE_STAGE_PROGRESS.queued,
    warning: null,
    error: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getAnalyzeJob(id: string): AnalyzeJob | undefined {
  return jobs.get(id);
}

function reapExpired(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const terminal = job.stage === "done" || job.stage === "failed";
    if (terminal && job.updatedAt < cutoff) jobs.delete(id);
  }
}
