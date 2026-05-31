import { z } from 'zod';
import { createEndpoint, MusicTracks } from 'zite-integrations-backend-sdk';

function generateBeatGrid(bpm: number, durationSec: number): number[] {
  const beatDur = 60 / bpm;
  const grid: number[] = [];
  for (let t = 0; t <= durationSec + beatDur; t += beatDur) {
    grid.push(parseFloat(t.toFixed(3)));
  }
  return grid;
}

export default createEndpoint({
  authenticated: true,
  description: 'Save a music track and generate its beat grid metadata',
  inputSchema: z.object({
    trackName: z.string(),
    audioUrl: z.string(),
    bpm: z.number().min(60).max(200),
    key: z.string().optional(),
    mood: z.array(z.string()).optional(),
    durationSeconds: z.number().optional(),
  }),
  outputSchema: z.object({ trackId: z.string() }),
  execute: async ({ input, context }) => {
    const duration = input.durationSeconds ?? 120;
    const bpm = input.bpm;
    const beatDur = 60 / bpm;
    const barDur = beatDur * 4;

    const track = await MusicTracks.create({
      record: {
        trackName: input.trackName,
        audioUrl: input.audioUrl,
        bpm,
        key: input.key,
        mood: (input.mood ?? ['Tech', 'Cinematic']) as any,
        durationSeconds: duration,
        analysisStatus: 'Analyzing',
        user: context.user.id,
      },
    });

    const beatGrid = generateBeatGrid(bpm, duration);
    const downbeats = beatGrid.filter((_, i) => i % 4 === 0);
    const sectionMarkers = {
      intro_end: parseFloat((barDur * 4).toFixed(3)),
      build_start: parseFloat((barDur * 8).toFixed(3)),
      drop: parseFloat((barDur * 16).toFixed(3)),
      climax_start: parseFloat((barDur * 24).toFixed(3)),
    };
    const energyCurve = [0.3, 0.5, 0.7, 0.9, 0.85];

    await MusicTracks.update({
      id: track.id,
      record: {
        beatGridJson: JSON.stringify(beatGrid),
        downbeatsJson: JSON.stringify(downbeats),
        sectionMarkersJson: JSON.stringify(sectionMarkers),
        energyCurveJson: JSON.stringify(energyCurve),
        analysisStatus: 'Ready',
      },
    });

    return { trackId: track.id };
  },
});
