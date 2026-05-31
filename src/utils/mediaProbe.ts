/**
 * Server-side media asset validation.
 *
 * Performs HTTP HEAD + partial GET to verify that a media URL:
 *  1. Is reachable (HTTP 2xx)
 *  2. Has a recognized media content-type
 *  3. Has a content-length that isn't suspiciously small or exactly a chunk boundary
 *  4. For video files: the first bytes contain a valid MP4/MOV header (ftyp box)
 *
 * This runs inside Cloudflare Workers — no ffprobe, so we rely on HTTP headers
 * and the first 64 bytes of the file to detect container validity.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MediaProbeResult {
  url: string;
  ok: boolean;
  /** Human-readable description of what's wrong (empty when ok) */
  error: string;
  /** Diagnostics for logging */
  details: {
    httpStatus?: number;
    contentType?: string;
    contentLength?: number;
    hasFtypBox?: boolean;
    hasMoovHint?: boolean;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** 20 MiB — the exact chunk size used by uploadVideoChunks */
const CHUNK_BOUNDARY_BYTES = 20 * 1024 * 1024;
/** Allow 512 bytes of tolerance around the boundary */
const CHUNK_BOUNDARY_TOLERANCE = 512;

const VIDEO_CONTENT_TYPES = [
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo',
  'video/x-matroska', 'application/octet-stream',
];

const AUDIO_CONTENT_TYPES = [
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4',
  'audio/x-wav', 'audio/webm', 'application/octet-stream',
];

// MP4/MOV files begin with a box whose type is 'ftyp'
const FTYP_MAGIC = new Uint8Array([0x66, 0x74, 0x79, 0x70]); // "ftyp"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function looksLikeChunkUrl(url: string): boolean {
  // Detect filenames like "video_part001.mp4", "clip_part002.mp4"
  return /_part\d{2,}\./.test(url);
}

function bytesMatch(a: Uint8Array, b: Uint8Array, offset: number): boolean {
  for (let i = 0; i < b.length; i++) {
    if (a[offset + i] !== b[i]) return false;
  }
  return true;
}

function isExactChunkBoundary(bytes: number): boolean {
  const remainder = bytes % CHUNK_BOUNDARY_BYTES;
  return remainder < CHUNK_BOUNDARY_TOLERANCE || (CHUNK_BOUNDARY_BYTES - remainder) < CHUNK_BOUNDARY_TOLERANCE;
}

// ─── Main probe ──────────────────────────────────────────────────────────────

/**
 * Probe a single media URL for reachability and container validity.
 * Timeout: 10 seconds per URL.
 */
export async function probeMediaUrl(
  url: string,
  kind: 'video' | 'audio' = 'video',
): Promise<MediaProbeResult> {
  const details: MediaProbeResult['details'] = {};

  // ── 0. Chunk-URL pattern check ─────────────────────────────────────────
  if (kind === 'video' && looksLikeChunkUrl(url)) {
    return {
      url, ok: false,
      error: `URL appears to be an intermediate chunk file (${url.split('/').pop()}). ` +
             `Use the assembled narration URL, not a part file.`,
      details,
    };
  }

  // ── 1. HEAD request ────────────────────────────────────────────────────
  let headRes: Response;
  try {
    headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    return {
      url, ok: false,
      error: `Asset unreachable: ${err.message ?? 'network error'}`,
      details,
    };
  }

  details.httpStatus = headRes.status;
  details.contentType = headRes.headers.get('content-type') ?? undefined;
  const clHeader = headRes.headers.get('content-length');
  details.contentLength = clHeader ? parseInt(clHeader, 10) : undefined;

  if (!headRes.ok) {
    return {
      url, ok: false,
      error: `Asset returned HTTP ${headRes.status} (${headRes.statusText}).`,
      details,
    };
  }

  // ── 2. Content-type check ──────────────────────────────────────────────
  const ct = (details.contentType ?? '').toLowerCase().split(';')[0].trim();
  const allowedTypes = kind === 'video' ? VIDEO_CONTENT_TYPES : AUDIO_CONTENT_TYPES;
  // We allow application/octet-stream since CDNs often use it
  if (ct && !allowedTypes.includes(ct)) {
    return {
      url, ok: false,
      error: `Unexpected content-type "${ct}" for a ${kind} file. Expected one of: ${allowedTypes.filter(t => t !== 'application/octet-stream').join(', ')}.`,
      details,
    };
  }

  // ── 3. Size check (exact chunk boundary = suspicious) ──────────────────
  if (details.contentLength !== undefined) {
    if (details.contentLength < 1024) {
      return {
        url, ok: false,
        error: `File is only ${details.contentLength} bytes — too small to be a valid ${kind} file.`,
        details,
      };
    }
    if (kind === 'video' && details.contentLength > 1024 && isExactChunkBoundary(details.contentLength)) {
      // Warning-level: we still check the ftyp box below
      // but flag it for diagnostics
    }
  }

  // ── 4. For video: fetch first 64 bytes and check for ftyp box ─────────
  if (kind === 'video') {
    try {
      const rangeRes = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-63' },
        signal: AbortSignal.timeout(10_000),
      });
      // Some servers don't support Range and return 200 with full body — that's fine
      const buf = new Uint8Array(await rangeRes.arrayBuffer());

      if (buf.length >= 8) {
        // ftyp box: bytes 4-7 should be "ftyp"
        const hasFtyp = bytesMatch(buf, FTYP_MAGIC, 4);
        details.hasFtypBox = hasFtyp;

        if (!hasFtyp) {
          return {
            url, ok: false,
            error: `File does not start with a valid MP4/MOV container header (no ftyp box). ` +
                   `The file may be truncated, a raw byte chunk, or not a valid video.`,
            details,
          };
        }
      }
    } catch {
      // If range request fails, skip this check (HEAD already passed)
    }

    // ── 5. Size at exact chunk boundary + valid ftyp = still suspicious ──
    if (
      details.contentLength !== undefined &&
      isExactChunkBoundary(details.contentLength) &&
      details.contentLength <= CHUNK_BOUNDARY_BYTES + CHUNK_BOUNDARY_TOLERANCE
    ) {
      // The first chunk of a multi-chunk upload has a valid ftyp but is
      // truncated (moov atom likely missing or incomplete)
      return {
        url, ok: false,
        error: `File size (${(details.contentLength / 1024 / 1024).toFixed(1)} MiB) is exactly ` +
               `at the 20 MiB chunk boundary, suggesting this is an incomplete chunk upload ` +
               `rather than the full assembled video. The moov atom is likely missing.`,
        details,
      };
    }
  }

  return { url, ok: true, error: '', details };
}

/**
 * Probe multiple URLs in parallel. Returns all results.
 */
export async function probeMediaUrls(
  urls: Array<{ url: string; kind: 'video' | 'audio'; label: string }>,
): Promise<Array<MediaProbeResult & { label: string }>> {
  const results = await Promise.all(
    urls.map(async ({ url, kind, label }) => {
      const r = await probeMediaUrl(url, kind);
      return { ...r, label };
    }),
  );
  return results;
}
