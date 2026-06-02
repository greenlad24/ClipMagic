import { z } from 'zod';
import { createEndpoint, MusicTracks, ZiteError } from 'zite-integrations-backend-sdk';

function expandCurve(curve: number[], target: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const t = (i / (target - 1)) * (curve.length - 1);
    const a = curve[Math.floor(t)] ?? 0.5;
    const b = curve[Math.ceil(t)] ?? a;
    out.push(a + (t % 1) * (b - a));
  }
  return out;
}

function synthWaveform(bpm: number, duration: number, energyCurve: number[], numSamples = 300): number[] {
  const beatDur = 60 / bpm;
  const expanded = energyCurve.length < 20 ? expandCurve(energyCurve, 120) : energyCurve;
  const peaks: number[] = [];

  for (let i = 0; i < numSamples; i++) {
    const t = (i / numSamples) * duration;
    const eT = (t / duration) * (expanded.length - 1);
    const e0 = expanded[Math.floor(eT)] ?? 0.5;
    const e1 = expanded[Math.ceil(eT)] ?? e0;
    const energy = e0 + (eT % 1) * (e1 - e0);
    const beatPhase = (t % beatDur) / beatDur;
    const pulse = Math.pow(Math.max(0, Math.cos(beatPhase * Math.PI * 2)), 3);
    const noise = 0.07 * (Math.sin(t * 17.3) + Math.sin(t * 11.7 + 1.2));
    peaks.push(Math.max(0.05, Math.min(1, energy * (0.55 + 0.45 * pulse) + noise)));
  }
  return peaks;
}

export default createEndpoint({
  description: 'Generate waveform peaks, beat grid, downbeats, and section markers for a music track',
  inputSchema: z.object({ trackId: z.string() }),
  outputSchema: z.object({
    peaks: z.array(z.number()),
    bpm: z.number(),
    duration: z.number(),
    beatGrid: z.array(z.number()),
    downbeats: z.array(z.number()),
    sectionMarkers: z.record(z.string(), z.number()),
  }),
  execute: async ({ input }) => {
    const track = await MusicTracks.findOne({ id: input.trackId });
    if (!track) throw new ZiteError({ code: 'NOT_FOUND', message: 'Track not found' });

    const bpm = track.bpm ?? 124;
    const duration = track.durationSeconds ?? 60;
    let energyCurve = [0.3, 0.5, 0.7, 0.9, 0.85, 0.7, 0.55, 0.4, 0.35];
    try { if (track.energyCurveJson) energyCurve = JSON.parse(track.energyCurveJson); } catch { /* use default */ }

    // Parse persisted beat grid / downbeats / section markers
    let beatGrid: number[] = [];
    let downbeats: number[] = [];
    let sectionMarkers: Record<string, number> = {};

    try { if (track.beatGridJson) beatGrid = JSON.parse(track.beatGridJson); } catch { /* */ }
    try { if (track.downbeatsJson) downbeats = JSON.parse(track.downbeatsJson); } catch { /* */ }
    try { if (track.sectionMarkersJson) sectionMarkers = JSON.parse(track.sectionMarkersJson); } catch { /* */ }

    // Generate beat grid from BPM if not stored
    if (beatGrid.length === 0) {
      const beatDur = 60 / bpm;
      for (let t = 0; t <= duration + beatDur; t += beatDur) {
        beatGrid.push(parseFloat(t.toFixed(3)));
      }
    }
    if (downbeats.length === 0) {
      downbeats = beatGrid.filter((_, i) => i % 4 === 0);
    }
    if (Object.keys(sectionMarkers).length === 0) {
      const barDur = (60 / bpm) * 4;
      sectionMarkers = {
        intro_end: parseFloat((barDur * 4).toFixed(3)),
        build_start: parseFloat((barDur * 8).toFixed(3)),
        drop: parseFloat((barDur * 16).toFixed(3)),
        climax_start: parseFloat((barDur * 24).toFixed(3)),
      };
    }

    return {
      peaks: synthWaveform(bpm, duration, energyCurve),
      bpm,
      duration,
      beatGrid,
      downbeats,
      sectionMarkers,
    };
  },
});
