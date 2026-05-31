import { z } from 'zod';
import { createEndpoint, Projects } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Create a new ShortStack project',
  inputSchema: z.object({
    narrationUrl: z.string().optional(),
    contextHint: z.string().optional(),
    accentColor: z.string().optional(),
    musicTrackId: z.string().optional(),
    audioUrl: z.string().optional(),
    videoChunksJson: z.string().optional(),
  }),
  outputSchema: z.object({ projectId: z.string() }),
  execute: async ({ input, context }) => {
    const project = await Projects.create({
      record: {
        title: 'Processing…',
        status: 'Uploading',
        narrationUrl: input.narrationUrl || undefined, // avoid storing empty string in URL field
        contextHint: input.contextHint,
        accentColor: input.accentColor ?? '#FFD60A',
        musicTrack: input.musicTrackId ?? undefined,
        user: context.user.id,
        audioUrl: input.audioUrl,
        videoChunksJson: input.videoChunksJson,
      },
    });
    return { projectId: project.id };
  },
});
