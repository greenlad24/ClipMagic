/**
 * Poll Rendi render status for a given render job.
 *
 * Single-shot: performs one GET poll and returns the current status.
 * The frontend calls this repeatedly every 5 s until `terminal` is true.
 */
import { z } from 'zod';
import {
  createEndpoint,
  ZiteError,
  RenderJobs,
  Projects,
} from 'zite-integrations-backend-sdk';
import { verifyAndPersist } from '../utils/rendiVerify';

const TIMEOUT_MINUTES = 20;
const POLL_INTERVAL_MS = 5_000;

export default createEndpoint({
  authenticated: true,
  description: 'Single-shot poll of Rendi FFmpeg render status. Call repeatedly from frontend every 5 s until terminal === true.',
  inputSchema: z.object({
    renderJobRecordId: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    terminal: z.boolean(),
    outputUrl: z.string().nullable(),
    subtitleAssUrl: z.string().nullable(),
    renderingTime: z.number().nullable(),
    outputWidth: z.number().nullable(),
    outputHeight: z.number().nullable(),
    outputDuration: z.number().nullable(),
    errorMessage: z.string().nullable(),
    pollIntervalMs: z.number(),
  }),
  execute: async ({ input }) => {
    const job = await RenderJobs.findOne({ id: input.renderJobRecordId });
    if (!job) {
      throw new ZiteError({ code: 'NOT_FOUND', message: 'Render job not found.' });
    }

    // Already terminal
    if (job.status === 'Done' || job.status === 'Error') {
      return {
        status: job.status,
        terminal: true,
        outputUrl: job.outputUrl ?? null,
        subtitleAssUrl: job.subtitleAssUrl ?? null,
        renderingTime: job.renderingTime ?? null,
        outputWidth: job.outputWidth ?? null,
        outputHeight: job.outputHeight ?? null,
        outputDuration: job.outputDuration ?? null,
        errorMessage: job.errorMessage ?? null,
        pollIntervalMs: POLL_INTERVAL_MS,
      };
    }

    // Timeout check
    const submittedAt = job.submittedAt ? new Date(job.submittedAt).getTime() : Date.now();
    const elapsedMin = (Date.now() - submittedAt) / 60_000;

    if (elapsedMin > TIMEOUT_MINUTES) {
      const errMsg = `Render timed out after ${Math.round(elapsedMin)} minutes.`;
      await RenderJobs.update({
        id: job.id,
        record: { status: 'Error', errorMessage: errMsg },
      });
      const projectId = Array.isArray(job.project) ? job.project[0] : job.project;
      if (projectId) {
        await Projects.update({ id: projectId, record: { status: 'Error' } });
      }
      return {
        status: 'Error',
        terminal: true,
        outputUrl: null,
        subtitleAssUrl: null,
        renderingTime: null,
        outputWidth: null,
        outputHeight: null,
        outputDuration: null,
        errorMessage: errMsg,
        pollIntervalMs: POLL_INTERVAL_MS,
      };
    }

    // Verify via Rendi API
    if (!job.j2VProjectId) {
      throw new ZiteError({
        code: 'BAD_REQUEST',
        message: 'Render job has no Rendi Command ID — cannot poll.',
      });
    }

    const projectId = Array.isArray(job.project) ? job.project[0] : job.project;
    const result = await verifyAndPersist(job.id, job.j2VProjectId, projectId);

    return { ...result, pollIntervalMs: POLL_INTERVAL_MS };
  },
});
