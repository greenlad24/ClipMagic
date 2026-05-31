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
import indexPromoVideoEndpoint from "../../../src/api/indexPromoVideo";

export interface PipelineContext {
  user: { id: string; email: string };
}

const run = (endpoint: unknown, input: unknown, context: PipelineContext) =>
  (endpoint as { run: (i: unknown, c: PipelineContext) => Promise<unknown> }).run(input, context);

export const runPipeline = (input: unknown, ctx: PipelineContext) => run(runPipelineEndpoint, input, ctx);
export const captureShots = (input: unknown, ctx: PipelineContext) => run(captureShotsEndpoint, input, ctx);
export const recaptureShot = (input: unknown, ctx: PipelineContext) => run(recaptureShotEndpoint, input, ctx);
export const indexPromoVideo = (input: unknown, ctx: PipelineContext) => run(indexPromoVideoEndpoint, input, ctx);
