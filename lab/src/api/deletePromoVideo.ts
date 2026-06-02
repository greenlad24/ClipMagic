import { z } from 'zod';
import { createEndpoint, PromoVideos } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Delete a promotional video from the library',
  inputSchema: z.object({ videoId: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ input }) => {
    await PromoVideos.delete({ id: input.videoId });
    return { success: true };
  },
});
