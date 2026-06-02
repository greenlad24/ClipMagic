import { z } from 'zod';
import { createEndpoint } from 'zite-integrations-backend-sdk';

/**
 * Returns a download URL for a stored file.
 * Since all media is now stored on Zite's built-in file storage (permanent, public URLs),
 * this endpoint returns the URL as-is. The endpoint is preserved for API compatibility.
 */
export default createEndpoint({
  authenticated: true,
  description: 'Returns a download URL for a stored file. Zite storage URLs are permanent and returned as-is.',
  inputSchema: z.object({
    /** The stored file URL */
    fileUrl: z.string(),
  }),
  outputSchema: z.object({
    /** The URL to use for downloading/playing the file */
    downloadUrl: z.string(),
  }),
  execute: async ({ input }) => {
    // Zite storage returns permanent public URLs — return as-is
    return { downloadUrl: input.fileUrl };
  },
});
