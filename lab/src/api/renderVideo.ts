import { z } from 'zod';
import { createEndpoint, ZiteError } from 'zite-integrations-backend-sdk';

/**
 * DEPRECATED — External render service export path.
 *
 * This endpoint previously posted a manifest to an external FFmpeg render service
 * and polled for completion. It has been disabled because:
 * - The external service dependency was unreliable
 * - All exports now happen in-browser via the browser renderer
 * - No external render worker is needed
 *
 * The endpoint is preserved for API compatibility but will return an error
 * directing users to use the in-browser export instead.
 */
export default createEndpoint({
  authenticated: true,
  description: '[DEPRECATED] External render service export — disabled. Use in-browser export instead.',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({
    success: z.boolean(),
    outputUrl: z.string(),
    message: z.string().optional(),
  }),
  execute: async () => {
    throw new ZiteError({
      code: 'BAD_REQUEST',
      message:
        'External render service export is disabled. ' +
        'All video exports now happen in-browser via the "Export in Browser" button. ' +
        'No external FFmpeg service is used.',
    });
  },
});
