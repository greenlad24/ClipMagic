import { z } from 'zod';
import { createEndpoint, Shots } from 'zite-integrations-backend-sdk';

const ShotSchema = z.object({
  id: z.string(),
  caption: z.string().optional(),
  shotType: z.string().optional(),
  beat: z.string().optional(),
  beatCount: z.number().optional(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  targetUrl: z.string().optional(),
  targetSelector: z.string().optional(),
  uiLabelsJson: z.string().optional(),
  transitionIn: z.string().optional(),
  sfxIn: z.string().optional(),
  clipUrl: z.string().optional(),
  captureStatus: z.string().optional(),
});

export default createEndpoint({
  authenticated: true,
  description: 'Get all shots for a project, ordered by start time',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({ shots: z.array(ShotSchema) }),
  execute: async ({ input }) => {
    const { records } = await Shots.findAll({
      filters: { project: input.projectId },
      limit: 200,
    });
    const shots = records
      .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
      .map((s) => ({
        id: s.id,
        caption: s.caption,
        shotType: s.shotType,
        beat: s.beat,
        beatCount: s.beatCount,
        startTime: s.startTime,
        endTime: s.endTime,
        targetUrl: s.targetUrl,
        targetSelector: s.targetSelector,
        uiLabelsJson: s.uiLabelsJson,
        transitionIn: s.transitionIn,
        sfxIn: s.sfxIn,
        clipUrl: s.clipUrl,
        captureStatus: s.captureStatus,
      }));
    return { shots };
  },
});
