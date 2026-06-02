import { z } from 'zod';
import { createEndpoint, Projects, ZiteError } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Update project settings (music volume, etc.) without touching shots or status',
  inputSchema: z.object({
    projectId: z.string(),
    musicVolume: z.number().min(0).max(1).optional(), // 0–1 float (3% = 0.03)
  }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ input, context }) => {
    const project = await Projects.findOne({ id: input.projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });

    const userId = Array.isArray(project.user) ? project.user[0] : project.user;
    if (userId !== context.user.id) throw new ZiteError({ code: 'FORBIDDEN', message: 'Access denied' });

    const updates: Partial<typeof project> = {};
    if (input.musicVolume !== undefined) updates.musicVolume = input.musicVolume;

    if (Object.keys(updates).length > 0) {
      await Projects.update({ id: input.projectId, record: updates });
    }
    return { success: true };
  },
});
