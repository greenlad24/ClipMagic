/**
 * Submit a Rendi FFmpeg render job.
 *
 * Server-side only. Builds the internal render manifest from project data,
 * validates required media, converts to an FFmpeg command, uploads the SRT
 * subtitle file to R2, POSTs to Rendi, and stores the job record.
 */
import { z } from 'zod';
import {
  createEndpoint,
  ZiteError,
  Projects,
  Shots,
  MusicTracks,
  RenderJobs,
} from 'zite-integrations-backend-sdk';
import { buildRenderManifest } from '../utils/renderManifest';
import { runPreflightValidation } from '../utils/renderPreflight';
import { manifestToRendi } from '../utils/rendiAdapter';
import { getRendiConfig, rendiHeaders } from '../utils/rendiConfig';
import { probeMediaUrls } from '../utils/mediaProbe';
import { putToR2 } from '../utils/r2Put';
import type { TimelineShot, SubtitleEvent } from '../components/timeline/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function generateJobId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rj_${ts}_${rand}`;
}

function hashPayload(json: string): string {
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Derive output filename from the narration URL, normalized to .mp4 */
function deriveOutputFilename(narrationUrl: string): string {
  try {
    const pathname = new URL(narrationUrl).pathname;
    const basename = pathname.split('/').pop() || 'output';
    // Strip extension and normalize
    const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
    // Clean up any non-alphanumeric characters except hyphens and underscores
    const clean = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${clean}.mp4`;
  } catch {
    return 'output.mp4';
  }
}

// ── endpoint ─────────────────────────────────────────────────────────────────

export default createEndpoint({
  authenticated: true,
  description: 'Build render manifest, validate, convert to Rendi FFmpeg command, POST to Rendi API, and store job record.',
  inputSchema: z.object({
    projectId: z.string(),
  }),
  outputSchema: z.object({
    jobId: z.string(),
    renderJobRecordId: z.string(),
    rendiCommandId: z.string(),
    status: z.string(),
    reused: z.boolean(),
    diagnostics: z.object({
      totalScenes: z.number(),
      hasSubtitles: z.boolean(),
      hasMusic: z.boolean(),
      srtLineCount: z.number(),
      estimatedPayloadKB: z.number(),
    }),
  }),
  execute: async ({ input }) => {
    // ── 1. Load project ──────────────────────────────────────────────────
    const project = await Projects.findOne({ id: input.projectId });
    if (!project) {
      throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found.' });
    }
    // ── 1b. Resolve narration from Dropbox ─────────────────────────────
    const projectTitle = project.title ?? 'Untitled';

    // Refresh Dropbox access token using app key/secret + refresh token
    const dbxAppKey = process.env.ZITE_DROPBOX_APP_KEY;
    const dbxAppSecret = process.env.ZITE_DROPBOX_APP_SECRET;
    const dbxRefreshToken = process.env.ZITE_DROPBOX_REFRESH_TOKEN;
    if (!dbxAppKey || !dbxAppSecret || !dbxRefreshToken) {
      throw new ZiteError({
        code: 'INTERNAL_ERROR',
        message: 'Dropbox credentials not configured. Need ZITE_DROPBOX_APP_KEY, ZITE_DROPBOX_APP_SECRET, and ZITE_DROPBOX_REFRESH_TOKEN.',
      });
    }

    console.log('[dropbox] Refreshing access token...');
    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: dbxRefreshToken,
        client_id: dbxAppKey,
        client_secret: dbxAppSecret,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => 'unknown');
      throw new ZiteError({
        code: 'INTERNAL_ERROR',
        message: `Dropbox token refresh failed (${tokenRes.status}): ${errText}`,
      });
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };
    const dropboxToken = tokenData.access_token;
    console.log('[dropbox] Access token refreshed successfully');

    console.log(`[dropbox] Searching /Narration input for "${projectTitle}"...`);

    // Search for an MP4 matching the project title
    const searchRes = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: projectTitle,
        options: {
          path: '/Narration input',
          max_results: 20,
          file_extensions: ['mp4', 'mov', 'MP4', 'MOV'],
        },
      }),
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text().catch(() => 'unknown');
      throw new ZiteError({
        code: 'INTERNAL_ERROR',
        message: `Dropbox search failed (${searchRes.status}): ${errText}`,
      });
    }

    const searchData = (await searchRes.json()) as {
      matches: Array<{ metadata: { metadata: { '.tag': string; name: string; path_lower: string; path_display: string } } }>;
    };

    // Filter to files whose name (without extension) closely matches the project title
    const titleNorm = projectTitle.toLowerCase().trim();
    const matches = searchData.matches
      .map(m => m.metadata.metadata)
      .filter(m => m['.tag'] === 'file')
      .filter(m => {
        const nameNoExt = m.name.replace(/\.[^.]+$/, '').toLowerCase().trim();
        return nameNoExt === titleNorm;
      });

    if (matches.length === 0) {
      // List available files for a helpful error
      const allNames = searchData.matches.map(m => m.metadata.metadata.name);
      const nameList = allNames.length > 0
        ? `Found these files instead:\n${allNames.map(n => `  • ${n}`).join('\n')}`
        : 'The folder appears empty or no video files were found.';
      throw new ZiteError({
        code: 'NOT_FOUND',
        message:
          `Could not find a narration video matching "${projectTitle}" in Dropbox /Narration input.\n\n` +
          `Expected a file named "${projectTitle}.mp4" (case-insensitive).\n\n${nameList}`,
      });
    }

    const matchedFile = matches[0];
    console.log(`[dropbox] Found: ${matchedFile.path_display}`);

    // Get a temporary download link
    const linkRes = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dropboxToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: matchedFile.path_lower }),
    });

    if (!linkRes.ok) {
      const errText = await linkRes.text().catch(() => 'unknown');
      throw new ZiteError({
        code: 'INTERNAL_ERROR',
        message: `Dropbox get_temporary_link failed (${linkRes.status}): ${errText}`,
      });
    }

    const linkData = (await linkRes.json()) as { link: string };
    const resolvedNarrationUrl = linkData.link;
    console.log(`[dropbox] Temporary link acquired (valid ~4h)`);

    // Save Dropbox path for traceability
    await Projects.update({
      id: input.projectId,
      record: { narrationDropboxUrl: matchedFile.path_display },
    });

    // ── 2. Load shots ────────────────────────────────────────────────────
    const { records: shotRecords } = await Shots.findAll({
      filters: { project: input.projectId },
      limit: 500,
    });
    if (shotRecords.length === 0) {
      throw new ZiteError({ code: 'BAD_REQUEST', message: 'Project has no shots.' });
    }

    const shots: TimelineShot[] = shotRecords.map((s) => ({
      id: s.id,
      caption: s.caption ?? '',
      shotType: s.shotType,
      beat: s.beat,
      startTime: s.startTime,
      endTime: s.endTime,
      clipUrl: s.clipUrl,
      transitionIn: s.transitionIn,
      sfxIn: s.sfxIn,
      uiLabelsJson: s.uiLabelsJson,
      targetUrl: s.targetUrl,
      targetSelector: s.targetSelector,
      actionsJson: s.actionsJson,
      captureStatus: s.captureStatus,
    }));

    // ── 3. Parse subtitles ───────────────────────────────────────────────
    let subtitles: SubtitleEvent[] = [];
    if (project.subtitlesJson) {
      try { subtitles = JSON.parse(project.subtitlesJson); } catch { /* */ }
    }

    // ── 4. Load music track ──────────────────────────────────────────────
    let musicUrl: string | undefined;
    let musicTrackName: string | undefined;
    let musicBpm: number | undefined;
    const musicTrackId = Array.isArray(project.musicTrack)
      ? project.musicTrack[0] : project.musicTrack;
    if (musicTrackId) {
      const track = await MusicTracks.findOne({ id: musicTrackId });
      if (track) {
        musicUrl = track.audioUrl;
        musicTrackName = track.trackName;
        musicBpm = track.bpm;
      }
    }

    // ── 5. Build render manifest ─────────────────────────────────────────
    const manifest = buildRenderManifest({
      projectId: project.id,
      title: project.title ?? 'Untitled',
      narrationUrl: resolvedNarrationUrl,
      videoChunksJson: project.videoChunksJson,
      durationSeconds: project.durationSeconds ?? 0,
      shots,
      subtitles,
      musicUrl,
      musicVolume: project.musicVolume != null ? project.musicVolume / 100 : 0.04,
      musicTrackName,
      musicBpm,
      animationMapJson: project.animationMapJson,
      width: 1080,
      height: 1920,
    });

    // ── 6. Preflight validation ──────────────────────────────────────────
    const preflight = runPreflightValidation(manifest);
    if (!preflight.ok) {
      const errorLines = preflight.errors.map(e => `• ${e.message}`).join('\n');
      throw new ZiteError({
        code: 'BAD_REQUEST',
        message: `${preflight.summary}\n\n${errorLines}`,
      });
    }

    // ── 6b. Media probe ──────────────────────────────────────────────────
    const probeTargets: Array<{ url: string; kind: 'video' | 'audio'; label: string }> = [
      { url: resolvedNarrationUrl, kind: 'video', label: 'Narration video' },
    ];
    for (const scene of manifest.scenes) {
      if (scene.overlay?.clipUrl && scene.overlay.mediaType !== 'image') {
        probeTargets.push({
          url: scene.overlay.clipUrl,
          kind: 'video',
          label: `Overlay clip for "${scene.caption.slice(0, 40) || scene.shotId}"`,
        });
      }
    }
    if (manifest.music?.audioUrl) {
      probeTargets.push({ url: manifest.music.audioUrl, kind: 'audio', label: 'Music track' });
    }

    console.log(`[mediaProbe] Probing ${probeTargets.length} assets...`);
    const probeResults = await probeMediaUrls(probeTargets);
    const failedProbes = probeResults.filter(r => !r.ok);
    if (failedProbes.length > 0) {
      const assetErrors = failedProbes.map(f => `• ${f.label}: ${f.error}`).join('\n');
      throw new ZiteError({
        code: 'BAD_REQUEST',
        message: `Media asset validation failed for ${failedProbes.length} file(s).\n\n${assetErrors}`,
      });
    }

    // ── 7. Convert to Rendi payload ──────────────────────────────────────
    const jobId = generateJobId();
    const outputFilename = deriveOutputFilename(resolvedNarrationUrl);

    const adaptResult = manifestToRendi(manifest, {
      renderJobId: jobId,
      outputFilename,
      musicVolumeOverride: 0.04,
    });

    // ── 7b. Upload SRT to R2 if needed ───────────────────────────────────
    if (adaptResult.srtContent && adaptResult.srtInputKey) {
      const srtR2Key = `renders/${project.id}/${jobId}/subtitles.srt`;
      console.log(`[rendi] Uploading SRT (${adaptResult.srtContent.length} chars) to R2: ${srtR2Key}`);
      const srtUrl = await putToR2(srtR2Key, adaptResult.srtContent, 'text/plain; charset=utf-8');
      adaptResult.payload.input_files[adaptResult.srtInputKey] = srtUrl;
      console.log(`[rendi] SRT uploaded: ${srtUrl}`);
    }

    // ── 7c. Dedup check ──────────────────────────────────────────────────
    const payloadJson = JSON.stringify(adaptResult.payload);
    const payloadHash = hashPayload(payloadJson);

    const { records: existingJobs } = await RenderJobs.findAll({
      filters: {
        project: input.projectId,
        payloadHash,
        status: { in: ['Submitted', 'Processing'] },
      },
      limit: 1,
    });

    if (existingJobs.length > 0) {
      const existing = existingJobs[0];
      return {
        jobId: existing.jobId ?? existing.id,
        renderJobRecordId: existing.id,
        rendiCommandId: existing.j2VProjectId ?? '',
        status: existing.status ?? 'Submitted',
        reused: true,
        diagnostics: {
          totalScenes: 0, hasSubtitles: false, hasMusic: false,
          srtLineCount: 0, estimatedPayloadKB: 0,
        },
      };
    }

    // ── 8. POST to Rendi ─────────────────────────────────────────────────
    const config = getRendiConfig();
    console.log(`[rendi] Submitting FFmpeg command (${adaptResult.diagnostics.estimatedCommandLength} chars)...`);

    const res = await fetch(`${config.baseUrl}/v1/run-ffmpeg-command`, {
      method: 'POST',
      headers: rendiHeaders(config),
      body: payloadJson,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      throw new ZiteError({
        code: 'INTERNAL_ERROR',
        message: `Rendi API returned ${res.status}: ${errText}`,
      });
    }

    const rendiResponse = (await res.json()) as { command_id?: string; [k: string]: unknown };
    const rendiCommandId = rendiResponse.command_id ?? '';
    console.log(`[rendi] Command submitted: ${rendiCommandId}`);

    // ── 9. Store render job record ───────────────────────────────────────
    const now = new Date().toISOString();
    const record = await RenderJobs.create({
      record: {
        jobId,
        j2VProjectId: rendiCommandId, // Reuse J2V field for Rendi command ID
        project: input.projectId,
        payloadHash,
        submittedAt: now,
        status: 'Submitted',
      },
    });

    // ── 10. Update project status ────────────────────────────────────────
    await Projects.update({
      id: input.projectId,
      record: { status: 'Rendering' },
    });

    // ── 11. Return ───────────────────────────────────────────────────────
    const diag = adaptResult.diagnostics;
    return {
      jobId,
      renderJobRecordId: record.id,
      rendiCommandId,
      status: 'Submitted',
      reused: false,
      diagnostics: {
        totalScenes: diag.totalScenes,
        hasSubtitles: diag.hasSubtitles,
        hasMusic: diag.hasMusic,
        srtLineCount: diag.srtLineCount,
        estimatedPayloadKB: Math.round(payloadJson.length / 1024 * 100) / 100,
      },
    };
  },
});
