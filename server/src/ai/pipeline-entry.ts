/**
 * Bundle entry for the original AI pipeline.
 *
 * esbuild bundles this with aliases (see scripts/build-pipeline.mjs):
 *   openai                          -> ../ai/openai-shim   (Groq + Claude)
 *   zite-integrations-backend-sdk   -> ../zite/sdk         (SQLite store)
 *   zite-file-upload-sdk            -> ../ai/upload-shim
 *
 * That lets us execute the original src/api/runPipeline.ts — the full
 * transcription + AI-director logic — completely unchanged.
 */
// @ts-ignore - resolved at bundle time from the repo's original app source
import runPipelineEndpoint from "../../../src/api/runPipeline";

export interface PipelineContext {
  user: { id: string; email: string };
}

export async function runPipeline(input: unknown, context: PipelineContext): Promise<unknown> {
  // The original endpoint object exposes `.run(input, context)` via our
  // createEndpoint shim.
  return (runPipelineEndpoint as any).run(input, context);
}
