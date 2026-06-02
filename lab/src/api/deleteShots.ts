import { z } from 'zod';
import { createEndpoint, Shots } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Delete one or more shots by ID from the database.',
  inputSchema: z.object({
    shotIds: z.array(z.string()).min(1).max(200),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    deleted: z.number(),
  }),
  execute: async ({ input }) => {
    const results = await Promise.allSettled(
      input.shotIds.map(id => Shots.delete({ id })),
    );
    const deleted = results.filter(r => r.status === 'fulfilled').length;
    return { success: deleted > 0, deleted };
  },
});
