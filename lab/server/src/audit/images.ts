/**
 * Fetching thumbnails for the vision pass.
 *
 * YouTube serves these from i.ytimg.com with no API key and no quota cost, so
 * the only real constraints are politeness and the fact that a channel audit
 * may want several hundred of them.
 */

/** Concurrent image fetches. High enough to be quick, low enough to be polite. */
const CONCURRENCY = 6;

/** Skip anything implausibly large — a thumbnail is tens of kilobytes. */
const MAX_BYTES = 2_000_000;

export interface FetchedImage {
  videoId: string;
  data: string; // base64
  mediaType: string;
}

/**
 * Download thumbnails and base64 them.
 *
 * A missing thumbnail is not an error: YouTube does not serve the high-quality
 * variant for every video, and one absent image must not sink a pass that runs
 * over hundreds. Failures are simply absent from the result, and the analysis
 * only ever correlates over videos it actually has attributes for.
 */
export async function fetchThumbnails(
  videos: { videoId: string; thumbnailUrl: string }[],
  signal?: AbortSignal,
): Promise<FetchedImage[]> {
  const out: FetchedImage[] = [];
  const queue = [...videos];

  async function worker() {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (signal?.aborted) return;
      try {
        const r = await fetch(next.thumbnailUrl, { signal });
        if (!r.ok) continue;
        const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
        // Anthropic accepts these four; anything else would be rejected at the
        // API and cost us the whole batch it was in.
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) continue;
        out.push({ videoId: next.videoId, data: buf.toString("base64"), mediaType: type });
      } catch {
        // Network hiccup on one image: skip it.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videos.length) }, worker));
  return out;
}
