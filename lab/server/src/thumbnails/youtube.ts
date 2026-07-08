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
export const SHORTS_MAX_SECONDS = 180;
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

/**
 * YouTube auto-generated thumbnail variants.
 *
 * Aspect ratios matter for the recreation chain: the image we FEED into Nano
 * Banana must be a true 16:9 frame, never the 4:3 letterboxed `hqdefault`.
 *   - maxresdefault.jpg — 1280×720, 16:9. Only exists for higher-res uploads.
 *   - mqdefault.jpg     — 320×180,  16:9. Always exists. Our 16:9 fallback.
 *   - hqdefault.jpg     — 480×360,  4:3 (letterboxed). NEVER fed into the chain;
 *                         fine only as a cheap grid-preview placeholder.
 */
export function hqThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
export function maxresThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}
/** 320×180 — always present, true 16:9. The guaranteed-16:9 fallback source. */
export function mqThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
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

/**
 * Thrown when the YouTube Data API reports the daily quota is exhausted. Callers
 * (e.g. the Keyword Research runner) catch this to STOP hammering the API and
 * keep whatever was already scored, rather than failing the whole run.
 */
export class YoutubeQuotaError extends Error {
  constructor(message = "YouTube Data API quota exceeded.") {
    super(message);
    this.name = "YoutubeQuotaError";
  }
}

/** True when a YouTube API error payload/status indicates quota exhaustion. */
function isQuotaError(status: number, json: any): boolean {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status;
  return reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "dailyLimitExceeded";
}

/** Surface a YouTube API error (search or videos.list) with an actionable message. */
function youtubeError(status: number, json: any): Error {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status;
  const msg = json?.error?.message || `YouTube API HTTP ${status}`;
  if (isQuotaError(status, json)) {
    return new YoutubeQuotaError(`YouTube API quota exceeded: ${msg}`);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Keyword Research helpers (competition signals). These share the injectable
// FetchFn + the server-only key getter, and surface a YoutubeQuotaError so the
// research runner can stop making quota-priced calls (search.list = 100 units,
// videos.list / channels.list = 1 unit each) and keep what it already scored.
// ─────────────────────────────────────────────────────────────────────────────

/** One raw search hit for a keyword (before stats are joined on). */
export interface KeywordSearchHit {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
}

export interface KeywordSearchResult {
  hits: KeywordSearchHit[];
  /** pageInfo.totalResults when present (an approximate corpus size), else null. */
  resultCount: number | null;
}

/**
 * Parse a search.list (part=snippet) response into keyword search hits + the
 * reported total-results count. Pure + exported for unit testing against a
 * captured response.
 */
export function parseKeywordSearch(json: any): KeywordSearchResult {
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  const hits: KeywordSearchHit[] = [];
  for (const it of items) {
    const videoId = it?.id?.videoId;
    if (typeof videoId !== "string" || !videoId) continue;
    hits.push({
      videoId,
      title: typeof it?.snippet?.title === "string" ? it.snippet.title : "(untitled)",
      channelId: typeof it?.snippet?.channelId === "string" ? it.snippet.channelId : "",
      channelTitle: typeof it?.snippet?.channelTitle === "string" ? it.snippet.channelTitle : "",
    });
  }
  const total = json?.pageInfo?.totalResults;
  const resultCount = typeof total === "number" && Number.isFinite(total) ? total : null;
  return { hits, resultCount };
}

/**
 * Run ONE search.list (100 quota units) for a keyword — the most-viewed videos,
 * US/English-targeted — and return the top `maxResults` hits + total-results.
 * Throws YoutubeQuotaError on quota exhaustion so the runner can stop.
 */
export async function searchKeywordVideos(
  keyword: string,
  maxResults = 10,
  fetchImpl?: FetchFn,
  opts?: { publishedAfter?: string | null; longOnly?: boolean },
): Promise<KeywordSearchResult> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  const q = keyword.trim();
  if (!q) return { hits: [], resultCount: null };

  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    order: "viewCount",
    maxResults: String(Math.max(1, Math.min(50, maxResults))),
    regionCode: REGION_CODE,
    relevanceLanguage: RELEVANCE_LANGUAGE,
    q,
    key,
  });
  // videoDuration=long (>20min) is too strict; we drop Shorts precisely by real
  // duration after videos.list. But a publishedAfter recency window IS applied here.
  if (opts?.publishedAfter) params.set("publishedAfter", opts.publishedAfter);
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
  return parseKeywordSearch(json);
}

/** Video stats joined onto a keyword hit (from videos.list). */
export interface VideoStats {
  views: number;
  publishedAt: string | null;
  /** Duration in seconds (from contentDetails) — used to drop Shorts. */
  durationSeconds: number;
}

/**
 * Parse a videos.list (part=statistics,snippet,contentDetails) response into
 * videoId → stats (views, publish date, duration). Pure + exported for testing.
 */
export function parseVideoStats(json: any): Map<string, VideoStats> {
  const out = new Map<string, VideoStats>();
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  for (const it of items) {
    const id = it?.id;
    if (typeof id !== "string" || !id) continue;
    const views = Number(it?.statistics?.viewCount);
    const publishedAt = typeof it?.snippet?.publishedAt === "string" ? it.snippet.publishedAt : null;
    out.set(id, {
      views: Number.isFinite(views) ? views : 0,
      publishedAt,
      durationSeconds: parseIsoDurationSeconds(it?.contentDetails?.duration),
    });
  }
  return out;
}

/**
 * Batched videos.list (1 quota unit; up to 50 ids/call) for view counts, publish
 * dates + durations. Throws YoutubeQuotaError on quota exhaustion.
 */
export async function fetchVideoStats(ids: string[], fetchImpl?: FetchFn): Promise<Map<string, VideoStats>> {
  if (ids.length === 0) return new Map();
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  const doFetch = resolveFetch(fetchImpl);
  const out = new Map<string, VideoStats>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const params = new URLSearchParams({ part: "statistics,snippet,contentDetails", id: batch.join(","), key });
    const url = `${YT_BASE}/youtube/v3/videos?${params.toString()}`;
    let res: { ok: boolean; status: number; json: () => Promise<any> };
    try {
      res = await doFetch(url);
    } catch (e) {
      throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw youtubeError(res.status, json);
    for (const [k, v] of parseVideoStats(json)) out.set(k, v);
  }
  return out;
}

/** Channel stats (from channels.list). */
export interface ChannelStats {
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  title: string;
}

/**
 * Parse a channels.list (part=statistics,snippet) response into channelId →
 * stats. subscriberCount is null when the channel hides it. Pure + exported.
 */
export function parseChannelStats(json: any): Map<string, ChannelStats> {
  const out = new Map<string, ChannelStats>();
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  for (const it of items) {
    const id = it?.id;
    if (typeof id !== "string" || !id) continue;
    const s = it?.statistics ?? {};
    const hidden = s?.hiddenSubscriberCount === true;
    const subs = Number(s?.subscriberCount);
    const vids = Number(s?.videoCount);
    const views = Number(s?.viewCount);
    out.set(id, {
      subscriberCount: hidden || !Number.isFinite(subs) ? null : subs,
      videoCount: Number.isFinite(vids) ? vids : null,
      viewCount: Number.isFinite(views) ? views : null,
      title: typeof it?.snippet?.title === "string" ? it.snippet.title : "",
    });
  }
  return out;
}

/**
 * Batched channels.list (1 quota unit; up to 50 ids/call) for subscriber counts.
 * Throws YoutubeQuotaError on quota exhaustion.
 */
export async function fetchChannelStats(ids: string[], fetchImpl?: FetchFn): Promise<Map<string, ChannelStats>> {
  const uniq = [...new Set(ids.filter((id) => id))];
  if (uniq.length === 0) return new Map();
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  const doFetch = resolveFetch(fetchImpl);
  const out = new Map<string, ChannelStats>();
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const params = new URLSearchParams({ part: "statistics,snippet", id: batch.join(","), key });
    const url = `${YT_BASE}/youtube/v3/channels?${params.toString()}`;
    let res: { ok: boolean; status: number; json: () => Promise<any> };
    try {
      res = await doFetch(url);
    } catch (e) {
      throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw youtubeError(res.status, json);
    for (const [k, v] of parseChannelStats(json)) out.set(k, v);
  }
  return out;
}

// ── Channel resolution + uploads (for the Keyword tool's "your channel" analysis) ──

/** One of a channel's uploaded videos (title + stats). */
export interface ChannelUpload {
  videoId: string;
  title: string;
  views: number;
  publishedAt: string | null;
}

/** A channel's profile + a sample of its uploads (youtube-local shape). */
export interface ChannelProfileData {
  channelId: string;
  title: string;
  handle: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  uploads: ChannelUpload[];
}

const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/;

/** GET + parse a YouTube Data API URL, throwing youtubeError (incl. quota) on failure. */
async function ytGetJson(url: string, doFetch: FetchFn): Promise<any> {
  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw youtubeError(res.status, json);
  return json;
}

/**
 * Resolve a channel URL / @handle / channel id / bare name to a channel id.
 * UC… id and /channel/UC… URLs cost 0 quota; @handle uses channels.list?forHandle
 * (1 unit); a bare name / /c/ / /user/ falls back to search.list (100 units).
 * Returns { channelId, handle } or null. Throws YoutubeQuotaError on quota.
 */
export async function resolveChannelId(
  input: string,
  fetchImpl?: FetchFn,
): Promise<{ channelId: string; handle: string | null } | null> {
  const raw = (input || "").trim();
  if (!raw) return null;
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  const doFetch = resolveFetch(fetchImpl);

  if (CHANNEL_ID_RE.test(raw)) return { channelId: raw, handle: null };

  let handle: string | null = null;
  let name: string | null = null;
  if (raw.includes("/")) {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      const parts = u.pathname.split("/").filter(Boolean);
      const chIdx = parts.indexOf("channel");
      if (chIdx >= 0 && CHANNEL_ID_RE.test(parts[chIdx + 1] || "")) {
        return { channelId: parts[chIdx + 1], handle: null };
      }
      const at = parts.find((p) => p.startsWith("@"));
      if (at) handle = at.replace(/^@/, "");
      else {
        const ci = parts.indexOf("c");
        const ui = parts.indexOf("user");
        name = (ci >= 0 ? parts[ci + 1] : ui >= 0 ? parts[ui + 1] : parts[parts.length - 1]) || null;
      }
    } catch {
      name = raw;
    }
  } else if (raw.startsWith("@")) {
    handle = raw.replace(/^@/, "");
  } else {
    name = raw;
  }

  if (handle) {
    const p = new URLSearchParams({ part: "id", forHandle: handle, key });
    const json = await ytGetJson(`${YT_BASE}/youtube/v3/channels?${p.toString()}`, doFetch);
    const id = json?.items?.[0]?.id;
    if (typeof id === "string" && id) return { channelId: id, handle };
    name = name ?? handle; // forHandle missed → try a search as a fallback
  }

  if (name) {
    const p = new URLSearchParams({ part: "snippet", type: "channel", maxResults: "1", q: name, key });
    const json = await ytGetJson(`${YT_BASE}/youtube/v3/search?${p.toString()}`, doFetch);
    const id = json?.items?.[0]?.snippet?.channelId ?? json?.items?.[0]?.id?.channelId;
    if (typeof id === "string" && id) return { channelId: id, handle };
  }
  return null;
}

/**
 * Fetch a channel's profile + a sample of its uploads (titles + views + dates).
 * channels.list (1u) → uploads playlist → playlistItems.list (1u/page, 50 each)
 * → videos.list (1u/50) for views. Throws YoutubeQuotaError on quota.
 */
export async function fetchChannelProfile(
  channelId: string,
  maxVideos = 50,
  fetchImpl?: FetchFn,
): Promise<ChannelProfileData | null> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  const doFetch = resolveFetch(fetchImpl);

  const cp = new URLSearchParams({ part: "snippet,statistics,contentDetails", id: channelId, key });
  const chJson = await ytGetJson(`${YT_BASE}/youtube/v3/channels?${cp.toString()}`, doFetch);
  const item = chJson?.items?.[0];
  if (!item) return null;
  const stats = item?.statistics ?? {};
  const subs = Number(stats?.subscriberCount);
  const vids = Number(stats?.videoCount);
  const views = Number(stats?.viewCount);
  const profile: ChannelProfileData = {
    channelId,
    title: typeof item?.snippet?.title === "string" ? item.snippet.title : "",
    handle: typeof item?.snippet?.customUrl === "string" ? item.snippet.customUrl.replace(/^@/, "") : null,
    subscriberCount: stats?.hiddenSubscriberCount === true || !Number.isFinite(subs) ? null : subs,
    videoCount: Number.isFinite(vids) ? vids : null,
    viewCount: Number.isFinite(views) ? views : null,
    uploads: [],
  };
  const uploadsPlaylist = item?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof uploadsPlaylist !== "string" || !uploadsPlaylist) return profile;

  const rows: { videoId: string; title: string; publishedAt: string | null }[] = [];
  let pageToken = "";
  const cap = Math.max(1, Math.min(200, maxVideos));
  while (rows.length < cap) {
    const pp = new URLSearchParams({ part: "snippet", playlistId: uploadsPlaylist, maxResults: "50", key });
    if (pageToken) pp.set("pageToken", pageToken);
    const pj = await ytGetJson(`${YT_BASE}/youtube/v3/playlistItems?${pp.toString()}`, doFetch);
    for (const it of Array.isArray(pj?.items) ? pj.items : []) {
      const vid = it?.snippet?.resourceId?.videoId;
      if (typeof vid !== "string" || !vid) continue;
      rows.push({
        videoId: vid,
        title: typeof it?.snippet?.title === "string" ? it.snippet.title : "",
        publishedAt: typeof it?.snippet?.publishedAt === "string" ? it.snippet.publishedAt : null,
      });
      if (rows.length >= cap) break;
    }
    pageToken = typeof pj?.nextPageToken === "string" ? pj.nextPageToken : "";
    if (!pageToken) break;
  }

  const vstats = await fetchVideoStats(rows.map((r) => r.videoId), fetchImpl);
  profile.uploads = rows.map((r) => ({
    videoId: r.videoId,
    title: r.title,
    views: vstats.get(r.videoId)?.views ?? 0,
    publishedAt: r.publishedAt,
  }));
  return profile;
}
