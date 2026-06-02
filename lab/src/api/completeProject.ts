import { z } from 'zod';
import { createEndpoint, Projects, ZiteError } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Mark a project as Complete after browser-based rendering and store the output URL',
  inputSchema: z.object({
    projectId: z.string(),
    outputUrl: z.string(),
  }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ input, context }) => {
    const project = await Projects.findOne({ id: input.projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });

    const userId = Array.isArray(project.user) ? project.user[0] : project.user;
    if (userId !== context.user.id) throw new ZiteError({ code: 'FORBIDDEN', message: 'Access denied' });

    await Projects.update({
      id: input.projectId,
      record: { outputUrl: input.outputUrl, status: 'Complete' },
    });

    return { success: true };
  },
});
