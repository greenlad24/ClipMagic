import { z } from 'zod';
import { createEndpoint, ZiteError } from 'zite-integrations-backend-sdk';

/**
 * Previously generated R2 presigned PUT URLs for direct browser uploads.
 * All uploads now go through Zite's built-in file storage via the
 * `uploadFile` function from 'zite-file-upload-sdk' on the frontend.
 * This endpoint is kept for API compatibility but will always return an error
 * directing callers to use the Zite file upload SDK instead.
 */
export default createEndpoint({
  authenticated: true,
  description: 'Deprecated: R2 presigned URLs are no longer used. Use uploadFile from zite-file-upload-sdk on the frontend instead.',
  inputSchema: z.object({
    key: z.string().min(1).max(500),
  }),
  outputSchema: z.object({
    putUrl: z.string(),
    getUrl: z.string(),
  }),
  execute: async () => {
    throw new ZiteError({
      code: 'BAD_REQUEST',
      message:
        'R2 upload URLs are no longer supported. Use uploadFile() from zite-file-upload-sdk directly in the frontend instead.',
    });
  },
});
