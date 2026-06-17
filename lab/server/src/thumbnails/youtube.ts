/**
 * YouTube Data API search for the Thumbnail Designer — finds the top-performing
 * LONG-FORM videos for a keyword so their thumbnails can be recreated with the
 * user's character.
 *
 * Two API calls per search:
 *   1. GET {BASE}/youtube/v3/search
 *        ?part=snippet&type=video&order=viewCount&maxResults=<OVERSAMPLE>
 *        &publishedAfter=<RFC3339>&q=<keyword>&key=<KEY>
 *      Ordered by view count, oversampled so we still have ≥6 left after the
 *      Shorts filter.
 *   2. GET {BASE}/youtube/v3/videos
 *        ?part=contentDetails&id=<comma-ids>&key=<KEY>
 *      Real durations for the candidates, so we can DROP Shorts (≤180s) — the
 *      search API doesn't expose duration. The survivors keep their original
 *      (view-count) order; we return the top 6.
 *
 * Recency: by default the search is capped to the last 2 years (the most-viewed
 * thumbnails worth copying are recent). Override with THUMBNAIL_SEARCH_YEARS
 * (integer; 0 = all-time, no cap).
 *
 * The HTTP layer is INJECTABLE so tests can mock it (no network, no real key).
 * The API key is read via the server-only getter and never logged.
 */
import { getYoutubeDataApiKey } from "../settings/postizSecrets.js";

const YT_BASE = process.env.YOUTUBE_BASE_URL || "https://www.googleapis.com";

/** How many candidates to pull from search before duration-filtering down to RESULT_COUNT. */
const OVERSAMPLE = 50; // YouTube search.list max page size
/** Anything at or below this many seconds is treated as a Short and dropped. */
const SHORTS_MAX_SECONDS = 180;
/** Final number of long-form results returned to the UI. */
const RESULT_COUNT = 20;
/** Bias results to English + the US market. */
const REGION_CODE = "US";
const RELEVANCE_LANGUAGE = "en";

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
 * Parse an ISO-8601 duration (YouTube `contentDetails.duration`, e.g. "PT4M13S",
 * "PT1H2M", "PT45S", "P0D") into TOTAL SECONDS. Tolerates hours/minutes/seconds
 * in any subset; returns 0 for an unparseable / missing value. Days+ are folded
 * in too (a video that long is certainly not a Short). Pure + exported for unit
 * testing the edge cases. We only need the seconds total for the Shorts filter.
 */
export function parseIsoDurationSeconds(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const m = iso.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  const seconds = Number(m[4] || 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Map a videos.list response (part=contentDetails) into videoId → seconds. Pure +
 * exported so the Shorts filter is testable against a captured response.
 */
export function parseVideoDurations(json: any): Map<string, number> {
  const out = new Map<string, number>();
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  for (const it of items) {
    const id = it?.id;
    if (typeof id === "string" && id) out.set(id, parseIsoDurationSeconds(it?.contentDetails?.duration));
  }
  return out;
}

/**
 * Parse a YouTube search API response into our result shape, IN ORDER (the API
 * returns them by the requested `order`, i.e. view count). Prefers the snippet's
 * maxres thumbnail when present (the API only lists it for videos that have one),
 * otherwise derives the always-present hqdefault. Skips malformed items. Pure +
 * exported for unit testing against a captured response.
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
 * Keep only LONG-FORM candidates (duration > SHORTS_MAX_SECONDS), preserving the
 * input (view-count) order, and return the top `limit`. A candidate with no known
 * duration is dropped (safer: we never want to surface a Short by accident). Pure
 * + exported for unit testing the Shorts exclusion + top-N selection.
 */
export function selectLongForm(
  ordered: ThumbnailSearchResult[],
  durations: Map<string, number>,
  limit = RESULT_COUNT,
): ThumbnailSearchResult[] {
  const out: ThumbnailSearchResult[] = [];
  for (const r of ordered) {
    const secs = durations.get(r.videoId);
    if (typeof secs === "number" && secs > SHORTS_MAX_SECONDS) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * RFC3339 timestamp for "now minus N years", or null when N <= 0 (all-time).
 * Reads THUMBNAIL_SEARCH_YEARS (default 2). Exported so the contract is testable.
 */
export function recencyPublishedAfter(now: Date = new Date()): string | null {
  const years = Number.parseInt(process.env.THUMBNAIL_SEARCH_YEARS ?? "2", 10);
  if (!Number.isFinite(years) || years <= 0) return null;
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString();
}

/** Resolve the injectable fetch once (real fetch wrapped to the narrow shape). */
function resolveFetch(fetchImpl?: FetchFn): FetchFn {
  return (
    fetchImpl ??
    (async (u) => {
      const r = await fetch(u);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    })
  );
}

/** Surface a YouTube API error (search or videos.list) with an actionable message. */
function youtubeError(status: number, json: any): Error {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status;
  const msg = json?.error?.message || `YouTube API HTTP ${status}`;
  if (reason === "quotaExceeded" || status === 403) {
    return new Error(`YouTube search failed: ${msg} (check the key has YouTube Data API v3 enabled and quota remaining).`);
  }
  return new Error(`YouTube search failed: ${msg}`);
}

/** Fetch real durations for a set of video ids via videos.list (contentDetails). */
async function fetchDurations(ids: string[], key: string, doFetch: FetchFn): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const params = new URLSearchParams({ part: "contentDetails", id: ids.join(","), key });
  const url = `${YT_BASE}/youtube/v3/videos?${params.toString()}`;
  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw youtubeError(res.status, json);
  return parseVideoDurations(json);
}

/**
 * Search YouTube for the most-viewed LONG-FORM videos matching a keyword and
 * return up to `maxResults` (default 20) thumbnails, English + US-targeted.
 * Oversamples by view count,
 * fetches real durations, drops Shorts (≤180s), and returns the top survivors in
 * view-count order. Applies the recency cap (THUMBNAIL_SEARCH_YEARS, default 2y).
 * Surfaces quota / invalid-key / network problems with clear messages.
 */
export async function searchTopThumbnails(
  keyword: string,
  maxResults = RESULT_COUNT,
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
    maxResults: String(OVERSAMPLE),
    // English + US-targeted results.
    regionCode: REGION_CODE,
    relevanceLanguage: RELEVANCE_LANGUAGE,
    q,
    key,
  });
  const publishedAfter = recencyPublishedAfter();
  if (publishedAfter) params.set("publishedAfter", publishedAfter);
  const url = `${YT_BASE}/youtube/v3/search?${params.toString()}`;

  const doFetch = resolveFetch(fetchImpl);

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw youtubeError(res.status, json);

  // Candidates in view-count order, then drop Shorts via real durations.
  const candidates = parseSearchResponse(json);
  if (candidates.length === 0) return [];
  const durations = await fetchDurations(
    candidates.map((c) => c.videoId),
    key,
    doFetch,
  );
  return selectLongForm(candidates, durations, maxResults);
}
