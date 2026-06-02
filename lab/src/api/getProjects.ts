import { z } from 'zod';
import { createEndpoint, Projects } from 'zite-integrations-backend-sdk';

const ProjectSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  narrationUrl: z.string().optional(),
  outputUrl: z.string().optional(),
  accentColor: z.string().optional(),
  durationSeconds: z.number().optional(),
  createdAt: z.string().optional(),
});

export default createEndpoint({
  authenticated: true,
  description: 'List all projects for the current user',
  inputSchema: z.object({}),
  outputSchema: z.object({ projects: z.array(ProjectSchema) }),
  execute: async ({ context }) => {
    const { records } = await Projects.findAll({
      filters: { user: context.user.id },
      limit: 50,
    });
    const projects = records
      .sort((a, b) => ((b.createdAt ?? '') > (a.createdAt ?? '') ? 1 : -1))
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        narrationUrl: p.narrationUrl,
        outputUrl: p.outputUrl,
        accentColor: p.accentColor,
        durationSeconds: p.durationSeconds,
        createdAt: p.createdAt,
      }));
    return { projects };
  },
});
