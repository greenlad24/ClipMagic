import { z } from 'zod';
import { createEndpoint, PromoVideos } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'List all promotional videos in the library with index status',
  inputSchema: z.object({}),
  outputSchema: z.object({
    videos: z.array(z.object({
      id: z.string(),
      productName: z.string().optional(),
      keywords: z.string().optional(),
      description: z.string().optional(),
      videoUrl: z.string().optional(),
      addedAt: z.string().optional(),
      indexStatus: z.string().optional(),
      segmentCount: z.number().optional(),
    })),
  }),
  execute: async () => {
    const { records } = await PromoVideos.findAll({ limit: 200 });
    return {
      videos: records.map((r) => {
        let segmentCount: number | undefined;
        if (r.contentIndexJson) {
          try {
            const idx = JSON.parse(r.contentIndexJson);
            segmentCount = Array.isArray(idx.segments) ? idx.segments.length : undefined;
          } catch { /* ignore */ }
        }
        return {
          id: r.id,
          productName: r.productName,
          keywords: r.keywords,
          description: r.description,
          videoUrl: r.videoUrl,
          addedAt: r.addedAt,
          indexStatus: r.indexStatus,
          segmentCount,
        };
      }),
    };
  },
});
