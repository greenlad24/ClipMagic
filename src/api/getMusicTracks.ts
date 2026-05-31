import { z } from 'zod';
import { createEndpoint, MusicTracks } from 'zite-integrations-backend-sdk';

const TrackSchema = z.object({
  id: z.string(),
  trackName: z.string().optional(),
  bpm: z.number().optional(),
  key: z.string().optional(),
  durationSeconds: z.number().optional(),
  mood: z.array(z.string()).optional(),
  analysisStatus: z.string().optional(),
  audioUrl: z.string().optional(),
});

export default createEndpoint({
  authenticated: true,
  description: 'List all music tracks for the current user',
  inputSchema: z.object({}),
  outputSchema: z.object({ tracks: z.array(TrackSchema) }),
  execute: async ({ context }) => {
    const { records } = await MusicTracks.findAll({
      filters: { user: context.user.id },
      limit: 50,
    });
    return {
      tracks: records.map((t) => ({
        id: t.id,
        trackName: t.trackName,
        bpm: t.bpm,
        key: t.key,
        durationSeconds: t.durationSeconds,
        mood: t.mood ?? [],
        analysisStatus: t.analysisStatus,
        audioUrl: t.audioUrl,
      })),
    };
  },
});
