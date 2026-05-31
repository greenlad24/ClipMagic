import { z } from 'zod';
import { createEndpoint, Projects, Shots, MusicTracks } from 'zite-integrations-backend-sdk';
import crypto from 'crypto';

// ── R2 / S3-compatible deletion helpers ───────────────────────────────────────

function sha256hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getSigningKey(secret: string, dateStamp: string): Buffer {
  const kDate    = hmacSha256(Buffer.from('AWS4' + secret), dateStamp);
  const kRegion  = hmacSha256(kDate,    'auto');
  const kService = hmacSha256(kRegion,  's3');
  return           hmacSha256(kService, 'aws4_request');
}

async function deleteR2Object(key: string): Promise<void> {
  const accountId  = process.env.ZITE_R2_ACCOUNT_ID ?? '';
  const accessKeyId = process.env.ZITE_R2_ACCESS_KEY_ID ?? '';
  const secretKey  = process.env.ZITE_R2_SECRET_ACCESS_KEY ?? '';
  const bucket     = process.env.ZITE_R2_BUCKET_NAME ?? '';

  if (!accountId || !accessKeyId || !secretKey || !bucket || !key) return;

  const host  = `${accountId}.r2.cloudflarestorage.com`;
  const now   = new Date();
  const pad   = (n: number) => String(n).padStart(2, '0');
  const dateStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const timePart  = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const amzDate   = `${dateStamp}T${timePart}Z`;

  // URL-encode each path segment (but not the slashes)
  const encodedKey = key.split('/').map((s) => encodeURIComponent(s)).join('/');
  const canonicalUri = `/${bucket}/${encodedKey}`;
  const signedHeaders = 'host;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const emptyPayload = sha256hex('');

  const canonicalRequest = [
    'DELETE', canonicalUri, '',
    canonicalHeaders, signedHeaders, emptyPayload,
  ].join('\n');

  const credScope  = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', getSigningKey(secretKey, dateStamp))
    .update(stringToSign).digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const res = await fetch(`https://${host}/${bucket}/${encodedKey}`, {
      method: 'DELETE',
      headers: { Host: host, 'X-Amz-Date': amzDate, Authorization: authHeader },
    });
    // 204 = deleted, 404 = already gone — both are fine
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      console.warn(`[deleteProject] R2 DELETE failed for "${key}": HTTP ${res.status}`);
    }
  } catch (e: any) {
    console.warn(`[deleteProject] R2 DELETE error for "${key}":`, e?.message ?? String(e));
  }
}

/**
 * Attempt to extract an R2 object key from a stored URL.
 * Returns null for external URLs (YouTube, Kinovi, thum.io, data:, etc.)
 */
function extractR2Key(url: string): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return null;
  if (/youtube\.com|youtu\.be|vimeo\.com|thum\.io|kinovi\.ai/i.test(url)) return null;

  const publicBase = (process.env.ZITE_R2_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (publicBase && url.startsWith(publicBase + '/')) {
    // e.g. https://pub-xxx.r2.dev/1234567_audio.wav  → 1234567_audio.wav
    return decodeURIComponent(url.slice(publicBase.length + 1));
  }
  return null;
}

// ── Batch helper ──────────────────────────────────────────────────────────────

/**
 * Run an array of async tasks in serial batches of `size` to stay well
 * under the Zite DB rate limit (50 req/s per base).
 */
async function batchedDelete(ids: string[], delFn: (id: string) => Promise<unknown>, size = 8): Promise<void> {
  for (let i = 0; i < ids.length; i += size) {
    await Promise.all(ids.slice(i, i + size).map(delFn));
    // Brief pause between batches so we never burst above the rate limit
    if (i + size < ids.length) await new Promise<void>((r) => setTimeout(r, 150));
  }
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default createEndpoint({
  authenticated: true,
  description: 'Delete one or more projects, all associated shots, and any R2-stored files (narration, audio, output, video chunks, shot clips)',
  inputSchema: z.object({
    projectIds: z.array(z.string()).min(1),
  }),
  outputSchema: z.object({
    deleted: z.number(),
  }),
  execute: async ({ input }) => {
    for (const projectId of input.projectIds) {
      // 1. Fetch project record to collect all file URLs
      const project = await Projects.findOne({ id: projectId });

      const fileUrls: string[] = [];

      // Collect the music track's audio URL so we can EXCLUDE it from deletion.
      // Music tracks are shared resources that belong to the user's library —
      // they must never be deleted when a project is removed.
      const protectedUrls = new Set<string>();
      if (project) {
        const musicTrackId = Array.isArray(project.musicTrack)
          ? project.musicTrack[0]
          : project.musicTrack;
        if (musicTrackId) {
          const track = await MusicTracks.findOne({ id: musicTrackId });
          if (track?.audioUrl) protectedUrls.add(track.audioUrl);
        }
      }

      if (project) {
        if (project.narrationUrl) fileUrls.push(project.narrationUrl);
        if (project.audioUrl)     fileUrls.push(project.audioUrl);  // extracted narration WAV, not music
        if (project.outputUrl)    fileUrls.push(project.outputUrl);

        // Video is uploaded as chunks — collect each chunk URL
        try {
          if (project.videoChunksJson) {
            const chunks = JSON.parse(project.videoChunksJson) as string[];
            fileUrls.push(...chunks.filter(Boolean));
          }
        } catch { /* malformed JSON — skip */ }
      }

      // 2. Fetch all shots and collect their clip URLs
      const { records: shots } = await Shots.findAll({
        filters: { project: projectId },
        limit: 2000,
      });

      for (const shot of shots) {
        if (shot.clipUrl) fileUrls.push(shot.clipUrl);
      }

      // 3. Delete shots in small batches to stay under the DB rate limit,
      //    then delete the project record itself.
      await batchedDelete(shots.map((s) => s.id), (id) => Shots.delete({ id }));
      await Projects.delete({ id: projectId });

      // 4. Delete files from R2 (non-fatal — best effort)
      // Explicitly skip any URL that belongs to a music track or other shared resource.
      const r2Keys = [...new Set(fileUrls)]
        .filter((url) => !protectedUrls.has(url))
        .map(extractR2Key)
        .filter((k): k is string => k !== null && k.length > 0);

      if (r2Keys.length > 0) {
        console.log(`[deleteProject] Removing ${r2Keys.length} R2 file(s) for project ${projectId}`);
        await Promise.all(r2Keys.map(deleteR2Object));
      }
    }

    return { deleted: input.projectIds.length };
  },
});
