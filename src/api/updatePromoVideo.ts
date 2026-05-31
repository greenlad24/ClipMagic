import { z } from 'zod';
import { createEndpoint, PromoVideos } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Update the metadata of an existing promo video (product name, keywords, description)',
  inputSchema: z.object({
    videoId: z.string(),
    productName: z.string().optional(),
    keywords: z.string().optional(),
    description: z.string().optional(),
  }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ input }) => {
    await PromoVideos.update({
      id: input.videoId,
      record: {
        productName: input.productName,
        keywords: input.keywords,
        description: input.description,
      },
    });
    return { success: true };
  },
});
