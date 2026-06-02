/**
 * Bundle entry for the original AI pipeline + shot-media endpoints.
 *
 * esbuild bundles this with aliases (see scripts/build-pipeline.mjs):
 *   openai                          -> ../ai/openai-shim   (Groq + Claude)
 *   zite-integrations-backend-sdk   -> ../zite/sdk         (SQLite store)
 *   zite-file-upload-sdk            -> ../ai/upload-shim
 *
 * That lets us execute the original endpoint logic — the full transcription +
 * AI-director (runPipeline), plus screencast/B-roll capture (captureShots),
 * single-shot recapture (recaptureShot) and promo-video indexing
 * (indexPromoVideo) — completely unchanged. In this version of the app,
 * "screencast" capture is promo-video *retrieval* from an indexed pool and
 * "B-roll" is Kinovi generation; there is no headless-browser step, so no
 * separate capture microservice is required.
 */
// @ts-ignore - resolved at bundle time from the repo's original app source
import runPipelineEndpoint from "../../../src/api/runPipeline";
// @ts-ignore
import captureShotsEndpoint from "../../../src/api/captureShots";
// @ts-ignore
import recaptureShotEndpoint from "../../../src/api/recaptureShot";
// @ts-ignore
import reviewEditEndpoint from "../../../src/api/reviewEdit";
// @ts-ignore
import indexPromoVideoEndpoint from "../../../src/api/indexPromoVideo";
// @ts-ignore
import savePromoVideoEndpoint from "../../../src/api/savePromoVideo";
// @ts-ignore
import getWaveformEndpoint from "../../../src/api/getWaveform";

import { Projects } from "../zite/store.js";
import {
  beginRun,
  setActiveRun,
  setRunFlags,
  buildReport,
  reportLogLine,
  finishRun,
  getRun,
} from "./runAccounting.js";

export interface PipelineContext {
  user: { id: string; email: string };
}

const run = (endpoint: unknown, input: unknown, context: PipelineContext) =>
  (endpoint as { run: (i: unknown, c: PipelineContext) => Promise<unknown> }).run(input, context);

/**
 * runPipeline wrapped with per-run AI/compute accounting. We open a run BEFORE
 * the original endpoint executes (so the Claude/Groq shims attribute every real
 * `usage` to it), then derive the emphasis-fold flags from the persisted
 * director/subtitle JSON and build + persist the Optimization Report.
 *
 * The original src/api/runPipeline.ts is untouched — accounting is recorded by
 * the shims and finalized here at the bundle boundary.
 */
export const runPipeline = async (input: unknown, ctx: PipelineContext) => {
  const projectId = (input as { projectId?: string })?.projectId;
  if (!projectId) return run(runPipelineEndpoint, input, ctx);

  // Open a FRESH run; the Claude/Groq shims attribute every real `usage` to it.
  beginRun(projectId);
  try {
    const result = await run(runPipelineEndpoint, input, ctx);
    // Persist a report NOW (transcription + research + director + any emphasis
    // fallback) so the timeline can show it immediately. Keep the run OPEN so
    // the later reviewEdit call's usage is attributed to the same run.
    await finalizeOptimizationReport(projectId, { final: false });
    return result;
  } catch (e) {
    // Don't let report bookkeeping mask a real pipeline error; just clean up.
    finishRun(projectId);
    throw e;
  }
};

/**
 * Derive the optimization flags from what the run actually persisted, build the
 * report from the real recorded usage, store it on the project, and log a line.
 * Best-effort: a reporting failure never fails the pipeline.
 *
 * @param opts.final  when true, the run is closed (memory freed) after building.
 *                    runPipeline persists a non-final report and leaves the run
 *                    open; reviewEdit closes it once its review call is recorded.
 */
async function finalizeOptimizationReport(
  projectId: string,
  opts: { final: boolean },
): Promise<void> {
  try {
    const project = await Projects.findOne({ id: projectId });

    // Did the director return usable emphasis words? (If so, the standalone
    // emphasis call was folded away; if not, the fallback Haiku call ran — the
    // shim already recorded it under purpose "emphasis-fallback".)
    let directorEmphasisCount = 0;
    try {
      const dj = project?.directorJson ? JSON.parse(project.directorJson as string) : {};
      const raw = dj?.emphasisWords ?? dj?.emphasis_words ?? dj?.emphasis;
      if (Array.isArray(raw)) {
        directorEmphasisCount = raw.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0).length;
      }
    } catch { /* */ }

    // Reconstruct the EXACT main-app emphasis prompt body for THIS run's words:
    //   words.map((w, i) => `${i}:${w.word}`).join(' ')
    // The faithful word source is the persisted subtitlesJson (every transcript
    // word, in order); fall back to splitting the transcript text.
    const words = transcriptWordsFromProject(project);
    const wordList = words.map((w, i) => `${i}:${w}`).join(" ");

    const runState = getRun(projectId);
    const fallbackUsed = !!runState?.calls.some((c) => c.purpose === "emphasis-fallback");

    setRunFlags(projectId, {
      directorReturnedEmphasis: directorEmphasisCount > 0,
      emphasisFallbackUsed: fallbackUsed,
      transcriptWordList: wordList,
      transcriptWordCount: words.length,
    });

    const report = buildReport(projectId);
    if (report) {
      await Projects.update({
        id: projectId,
        record: { optimizationReportJson: JSON.stringify(report) },
      }).catch(() => {});
      console.log(reportLogLine(report));
    }
  } catch (e) {
    console.warn(
      `[OptimizationReport] failed for ${projectId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (opts.final) finishRun(projectId);
  }
}

/** Recover the transcript word list (text only, in order) from a project record. */
function transcriptWordsFromProject(project: { subtitlesJson?: unknown; transcript?: unknown } | null): string[] {
  if (project?.subtitlesJson) {
    try {
      const events = JSON.parse(project.subtitlesJson as string) as Array<{ words?: Array<{ text?: string }> }>;
      const out: string[] = [];
      for (const ev of events) for (const w of ev.words ?? []) if (w.text) out.push(w.text);
      if (out.length) return out;
    } catch { /* */ }
  }
  const t = (project?.transcript as string) ?? "";
  return t.split(/\s+/).filter(Boolean);
}
export const getWaveform = (input: unknown, ctx: PipelineContext) => run(getWaveformEndpoint, input, ctx);

// captureShots runs between runPipeline and reviewEdit. Re-point the active run
// to this project so any usage it records lands on the right report; it makes
// no LLM calls today, but this keeps attribution correct if that changes.
export const captureShots = (input: unknown, ctx: PipelineContext) => {
  const projectId = (input as { projectId?: string })?.projectId;
  if (projectId) setActiveRun(projectId);
  return run(captureShotsEndpoint, input, ctx);
};

export const recaptureShot = (input: unknown, ctx: PipelineContext) => run(recaptureShotEndpoint, input, ctx);

/**
 * reviewEdit is the END of the pipeline (the AI accuracy pass). Re-activate the
 * run so its real review-call usage is recorded, then FINALIZE the report
 * (adds the review line item) and close the run.
 */
export const reviewEdit = async (input: unknown, ctx: PipelineContext) => {
  const projectId = (input as { projectId?: string })?.projectId;
  if (!projectId) return run(reviewEditEndpoint, input, ctx);
  setActiveRun(projectId);
  try {
    const result = await run(reviewEditEndpoint, input, ctx);
    await finalizeOptimizationReport(projectId, { final: true });
    return result;
  } catch (e) {
    await finalizeOptimizationReport(projectId, { final: true }).catch(() => {});
    throw e;
  }
};
export const indexPromoVideo = (input: unknown, ctx: PipelineContext) => run(indexPromoVideoEndpoint, input, ctx);
export const savePromoVideo = (input: unknown, ctx: PipelineContext) => run(savePromoVideoEndpoint, input, ctx);
