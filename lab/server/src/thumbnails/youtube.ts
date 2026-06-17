/**
 * YouTube Data API search for the Thumbnail Designer — finds the top-performing
 * videos for a keyword so their thumbnails can be recreated with the user's
 * character.
 *
 * GET {BASE}/youtube/v3/search
 *     ?part=snippet&type=video&order=viewCount&maxResults=6&q=<keyword>&key=<KEY>
 * Maps items[].id.videoId + snippet.title to a small result set; the thumbnail
 * URL is derived from the video id (try maxresdefault, fall back to hqdefault).
 *
 * The HTTP layer is INJECTABLE so tests can mock it (no network, no real key).
 * The API key is read via the server-only getter and never logged.
 */
import { getYoutubeDataApiKey } from "../settings/postizSecrets.js";

const YT_BASE = process.env.YOUTUBE_BASE_URL || "https://www.googleapis.com";

export interface ThumbnailSearchResult {
  videoId: string;
  title: string;
  /** Best-available thumbnail URL (maxres if present in the snippet, else hq). */
  thumbnailUrl: string;
}

export function youtubeConfigured(): boolean {
  return !!getYoutubeDataApiKey();
}

/** Injectable fetch — narrow shape so a test can supply a mock. */
export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/** hqdefault always exists; maxresdefault only for higher-res uploads. */
export function hqThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
export function maxresThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * Parse a YouTube search API response into our result shape. Prefers the
 * snippet's maxres thumbnail when present (the API only lists it for videos that
 * have one), otherwise derives the always-present hqdefault. Skips malformed
 * items. Pure + exported for unit testing against a captured response.
 */
export function parseSearchResponse(json: any): ThumbnailSearchResult[] {
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  const out: ThumbnailSearchResult[] = [];
  for (const it of items) {
    const videoId = it?.id?.videoId;
    if (typeof videoId !== "string" || !videoId) continue;
    const title = typeof it?.snippet?.title === "string" ? it.snippet.title : "(untitled)";
    const maxres = it?.snippet?.thumbnails?.maxres?.url;
    const thumbnailUrl = typeof maxres === "string" && maxres ? maxres : hqThumbnailUrl(videoId);
    out.push({ videoId, title, thumbnailUrl });
  }
  return out;
}

/**
 * Search YouTube for the top videos (by view count) matching a keyword and
 * return up to `maxResults` thumbnails. Surfaces quota / invalid-key / network
 * problems with clear, actionable messages.
 */
export async function searchTopThumbnails(
  keyword: string,
  maxResults = 6,
  fetchImpl?: FetchFn,
): Promise<ThumbnailSearchResult[]> {
  const key = getYoutubeDataApiKey();
  if (!key) {
    throw new Error("YouTube Data API key not configured — add YOUTUBE_DATA_API_KEY in Settings → Thumbnail Designer.");
  }
  const q = keyword.trim();
  if (!q) throw new Error("Enter a keyword to search YouTube thumbnails.");

  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    order: "viewCount",
    maxResults: String(maxResults),
    q,
    key,
  });
  const url = `${YT_BASE}/youtube/v3/search?${params.toString()}`;

  const doFetch: FetchFn =
    fetchImpl ??
    (async (u) => {
      const r = await fetch(u);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    });

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || json?.error?.status;
    const msg = json?.error?.message || `YouTube API HTTP ${res.status}`;
    if (reason === "quotaExceeded" || res.status === 403) {
      throw new Error(`YouTube search failed: ${msg} (check the key has YouTube Data API v3 enabled and quota remaining).`);
    }
    throw new Error(`YouTube search failed: ${msg}`);
  }
  return parseSearchResponse(json);
}
