import { z } from 'zod';
import { createEndpoint, Projects, ZiteError } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Get a single project by ID',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      title: z.string().optional(),
      status: z.string().optional(),
      transcript: z.string().optional(),
      accentColor: z.string().optional(),
      durationSeconds: z.number().optional(),
      outputUrl: z.string().optional(),
      narrationUrl: z.string().optional(),
      videoChunksJson: z.string().optional(),
      directorJson: z.string().optional(),
      beatStructureJson: z.string().optional(),
      animationMapJson: z.string().optional(),
      subtitlesJson: z.string().optional(),
      validationErrors: z.string().optional(),
      musicTrack: z.string().optional(),
      musicVolume: z.number().optional(),
      createdAt: z.string().optional(),
    }),
  }),
  execute: async ({ input, context }) => {
    const project = await Projects.findOne({ id: input.projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });
    const userId = Array.isArray(project.user) ? project.user[0] : project.user;
    if (userId !== context.user.id) throw new ZiteError({ code: 'FORBIDDEN', message: 'Access denied' });
    return {
      project: {
        id: project.id,
        title: project.title,
        status: project.status,
        transcript: project.transcript,
        accentColor: project.accentColor,
        durationSeconds: project.durationSeconds,
        outputUrl: project.outputUrl,
        narrationUrl: project.narrationUrl,
        videoChunksJson: project.videoChunksJson,
        directorJson: project.directorJson,
        beatStructureJson: project.beatStructureJson,
        animationMapJson: project.animationMapJson,
        subtitlesJson: project.subtitlesJson,
        validationErrors: project.validationErrors,
        musicTrack: Array.isArray(project.musicTrack) ? project.musicTrack[0] : project.musicTrack,
        musicVolume: project.musicVolume,
        createdAt: project.createdAt,
      },
    };
  },
});
