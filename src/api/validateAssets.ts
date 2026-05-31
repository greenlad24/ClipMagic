import { z } from 'zod';
import { createEndpoint, Projects, Shots, MusicTracks, ZiteError } from 'zite-integrations-backend-sdk';

/**
 * Server-side asset validation. Can be called independently for diagnostics.
 * The primary export path now validates assets client-side in browserRenderer.ts
 * before starting the in-browser export. This endpoint is preserved for API use.
 */
export default createEndpoint({
  authenticated: true,
  description: 'Validate all assets required for export — narration, music, overlay clips (server-side check)',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    assetReport: z.object({
      narrationUrl: z.string().nullable(),
      narrationReachable: z.boolean(),
      audioUrl: z.string().nullable(),
      audioReachable: z.boolean(),
      musicUrl: z.string().nullable(),
      musicReachable: z.boolean(),
      totalOverlayShots: z.number(),
      reachableOverlays: z.number(),
      failedOverlays: z.array(z.object({
        shotId: z.string(),
        shotType: z.string(),
        caption: z.string(),
        clipUrl: z.string(),
        error: z.string(),
      })),
    }),
  }),
  execute: async ({ input }) => {
    const project = await Projects.findOne({ id: input.projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });

    const errors: string[] = [];
    const warnings: string[] = [];

    // Check narration
    const narrationUrl = project.narrationUrl ?? null;
    let narrationReachable = false;
    if (!narrationUrl && !project.audioUrl) {
      errors.push('Project has no narration video or audio URL.');
    } else if (narrationUrl) {
      narrationReachable = await checkUrl(narrationUrl);
      if (!narrationReachable) errors.push(`Narration video is unreachable: ${narrationUrl}`);
    }

    // Check audio
    const audioUrl = project.audioUrl ?? null;
    let audioReachable = false;
    if (audioUrl) {
      audioReachable = await checkUrl(audioUrl);
      if (!audioReachable && !narrationReachable) {
        errors.push(`Audio URL is unreachable: ${audioUrl}`);
      } else if (!audioReachable) {
        warnings.push(`Separate audio URL is unreachable (will extract from narration video): ${audioUrl}`);
      }
    }

    // Check music
    const trackId = Array.isArray(project.musicTrack) ? project.musicTrack[0] : project.musicTrack;
    let musicUrl: string | null = null;
    let musicReachable = false;
    if (trackId) {
      const track = await MusicTracks.findOne({ id: trackId });
      musicUrl = track?.audioUrl ?? null;
      if (musicUrl) {
        musicReachable = await checkUrl(musicUrl);
        if (!musicReachable) warnings.push(`Music track is unreachable: ${musicUrl}`);
      } else {
        warnings.push('Music track record exists but has no audio URL.');
      }
    }

    // Check overlay clips
    const { records: shots } = await Shots.findAll({ filters: { project: input.projectId }, limit: 200 });
    const overlayShots = shots.filter(s => s.shotType !== 'Talking Head');
    const failedOverlays: Array<{ shotId: string; shotType: string; caption: string; clipUrl: string; error: string }> = [];

    for (const s of overlayShots) {
      if (!s.clipUrl) {
        failedOverlays.push({
          shotId: s.id,
          shotType: s.shotType ?? 'Unknown',
          caption: (s.caption ?? '').slice(0, 80),
          clipUrl: '',
          error: 'No clipUrl set — shot has no generated media',
        });
        continue;
      }
      const ok = await checkUrl(s.clipUrl);
      if (!ok) {
        failedOverlays.push({
          shotId: s.id,
          shotType: s.shotType ?? 'Unknown',
          caption: (s.caption ?? '').slice(0, 80),
          clipUrl: s.clipUrl,
          error: 'URL is unreachable or returned non-200 status',
        });
      }
    }

    if (failedOverlays.length > 0) {
      const missing = failedOverlays.filter(f => !f.clipUrl).length;
      const unreachable = failedOverlays.length - missing;
      if (missing > 0) errors.push(`${missing} overlay shot(s) have no clip URL.`);
      if (unreachable > 0) errors.push(`${unreachable} overlay clip(s) are unreachable — final export would be missing Screencast/B-Roll.`);
    }

    if (project.durationSeconds === undefined || project.durationSeconds <= 0) {
      errors.push('Project duration is 0 or undefined.');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      assetReport: {
        narrationUrl,
        narrationReachable,
        audioUrl,
        audioReachable,
        musicUrl,
        musicReachable,
        totalOverlayShots: overlayShots.length,
        reachableOverlays: overlayShots.length - failedOverlays.length,
        failedOverlays,
      },
    };
  },
});

async function checkUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return true;
    // Some CDNs block HEAD, try GET with range
    const res2 = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    return res2.ok || res2.status === 206;
  } catch {
    return false;
  }
}
