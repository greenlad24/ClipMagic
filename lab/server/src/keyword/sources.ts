/**
 * Free data-source fetchers for the Keyword Research tool. Each takes an
 * injectable fetch (defaulting to the global `fetch`) so it's testable and so one
 * source failing never takes the run down — every fetcher is wrapped to degrade
 * gracefully (empty/partial result) rather than throw. The one exception is
 * youtubeCompetition, which rethrows a typed YoutubeQuotaError so the runner can
 * stop making quota-priced Data API calls and keep what it already scored.
 *
 * Signals used:
 *   - YouTube autocomplete (suggestqueries) — free, unofficial. Depth + "alphabet
 *     soup" (seed + a..z) expansion gives both candidate keywords AND a demand
 *     proxy (how readily YouTube suggests them).
 *   - Google Trends (unofficial widget API) — best-effort relative interest.
 *     Often blocks datacenter IPs, so it MUST tolerate total failure.
 *   - YouTube Data API — the competition signal (top videos' views, channel
 *     subs, corpus size). Quota-priced, so used sparingly by the runner.
 */
import { normalizeKeyword, SCORING } from "./types.js";
import {
  searchKeywordVideos,
  fetchVideoStats,
  fetchChannelStats,
  YoutubeQuotaError,
  SHORTS_MAX_SECONDS,
  type FetchFn,
  type VideoStats,
  type ChannelStats,
} from "../thumbnails/youtube.js";

/** How many top-by-views long-form US videos to return per keyword. */
const COMPETITION_RESULTS = 10;
/** RFC3339 timestamp one year ago (competitor videos must be from the last year). */
function oneYearAgoIso(): string {
  return new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
}

/** The web-fetch shape these free sources need (subset of the global fetch). */
export type WebFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }>;

function resolveWebFetch(fetchImpl?: WebFetch): WebFetch {
  return fetchImpl ?? ((url, init) => fetch(url, init));
}

/** POST+JSON fetch shape (used by the DataForSEO adapter). */
export type JsonFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

function resolveJsonFetch(fetchImpl?: JsonFetch): JsonFetch {
  return fetchImpl ?? ((url, init) => fetch(url, init));
}

/** Run async tasks with a small concurrency cap (politeness for unofficial APIs). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── YouTube autocomplete ─────────────────────────────────────────────────────

/**
 * Raw YouTube autocomplete for a single seed. The client=firefox endpoint
 * returns JSON `[query, [suggestion, …]]`. Returns [] on any failure so a single
 * blocked request never breaks expansion.
 */
export async function youtubeAutocomplete(seed: string, fetchImpl?: WebFetch): Promise<string[]> {
  const q = seed.trim();
  if (!q) return [];
  const doFetch = resolveWebFetch(fetchImpl);
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(q)}`;
  try {
    const res = await doFetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    const parsed = JSON.parse(text);
    const suggestions = Array.isArray(parsed) ? parsed[1] : null;
    if (!Array.isArray(suggestions)) return [];
    return suggestions.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Expand a seed with "alphabet soup": autocomplete on the seed AND on
 * `seed + " " + letter` for a..z, then dedupe (by normalized form) and cap at
 * ~60 suggestions per seed. Uses a small concurrency cap to stay polite to the
 * unofficial endpoint. Always resolves (never throws).
 */
export async function expandAutocomplete(seed: string, fetchImpl?: WebFetch): Promise<string[]> {
  const base = seed.trim();
  if (!base) return [];
  const queries = [base, ...Array.from({ length: 26 }, (_, i) => `${base} ${String.fromCharCode(97 + i)}`)];
  const results = await mapLimit(queries, 5, (q) => youtubeAutocomplete(q, fetchImpl));

  const seen = new Set<string>();
  const out: string[] = [];
  // Keep the seed's own direct suggestions first (results[0]), then the soup.
  for (const list of results) {
    for (const s of list) {
      const norm = normalizeKeyword(s);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(s);
      if (out.length >= 60) return out;
    }
  }
  return out;
}

// ── Google Trends (best-effort, unofficial) ──────────────────────────────────

/** Strip Trends' anti-JSON-hijack prefix `)]}',` before parsing. */
function stripTrendsPrefix(text: string): string {
  const trimmed = text.replace(/^\)\]\}',?\s*/, "");
  return trimmed;
}

// Point GOOGLE_TRENDS_BASE_URL at a reverse-proxy/mirror to route Trends off a
// non-datacenter IP (Trends frequently throttles cloud IPs).
const TRENDS_BASE = process.env.GOOGLE_TRENDS_BASE_URL || "https://trends.google.com";
const TRENDS_TIME = "today 12-m";
/** Retries per batch — Trends is flaky from datacenter IPs, so back off + retry. */
const TRENDS_MAX_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort Google Trends interest for a batch of ≤5 keywords (Trends'
 * comparison limit). Does the token dance (explore → multiline widget) and maps
 * each keyword's average interest to 0–100. FULLY wrapped: any failure/HTTP block
 * yields an empty (or partial) map — Trends frequently blocks datacenter IPs, so
 * the tool must still work with all-null trends.
 *
 * Keys in the returned map are the INPUT keyword strings (verbatim).
 */
export async function googleTrends(keywords: string[], fetchImpl?: WebFetch): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const doFetch = resolveWebFetch(fetchImpl);
  const headers = { "accept-language": "en-US,en;q=0.9" };

  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += 5) {
    const batch = keywords.slice(i, i + 5).filter((k) => k.trim());
    if (batch.length) batches.push(batch);
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const before = out.size;
    // Retry with exponential backoff. trendsBatch adds ≥1 entry when it succeeds
    // (even a 0-interest keyword is set), so "no new entries" means blocked → retry.
    for (let attempt = 1; attempt <= TRENDS_MAX_ATTEMPTS; attempt++) {
      try {
        await trendsBatch(batch, doFetch, headers, out);
      } catch {
        // fall through to backoff/retry
      }
      if (out.size > before) break;
      if (attempt < TRENDS_MAX_ATTEMPTS) await sleep(400 * attempt * attempt); // 400ms, 1600ms
    }
    if (bi < batches.length - 1) await sleep(300); // politeness between batches
  }
  return out;
}

/** One Trends comparison batch (≤5 keywords), writing averages into `out`. */
async function trendsBatch(
  batch: string[],
  doFetch: WebFetch,
  headers: Record<string, string>,
  out: Map<string, number>,
): Promise<void> {
  // 1) explore: get the multiline widget's token + request.
  const exploreReq = {
    comparisonItem: batch.map((keyword) => ({ keyword, geo: "US", time: TRENDS_TIME })),
    category: 0,
    property: "",
  };
  const exploreUrl =
    `${TRENDS_BASE}/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(exploreReq))}&tz=0`;
  const exploreRes = await doFetch(exploreUrl, { headers });
  if (!exploreRes.ok) return;
  const explore = JSON.parse(stripTrendsPrefix(await exploreRes.text()));
  const widgets: any[] = Array.isArray(explore?.widgets) ? explore.widgets : [];
  const multiline = widgets.find((w) => w?.id === "TIMESERIES");
  if (!multiline?.token || !multiline?.request) return;

  // 2) multiline: fetch the interest-over-time series.
  const dataUrl =
    `${TRENDS_BASE}/trends/api/widgetdata/multiline?hl=en-US&tz=0` +
    `&req=${encodeURIComponent(JSON.stringify(multiline.request))}&token=${encodeURIComponent(multiline.token)}`;
  const dataRes = await doFetch(dataUrl, { headers });
  if (!dataRes.ok) return;
  const data = JSON.parse(stripTrendsPrefix(await dataRes.text()));
  const timeline: any[] = Array.isArray(data?.default?.timelineData) ? data.default.timelineData : [];
  if (timeline.length === 0) return;

  // Average each keyword's series (values are parallel arrays, one slot/keyword).
  const sums = new Array(batch.length).fill(0);
  let n = 0;
  for (const point of timeline) {
    const values: any[] = Array.isArray(point?.value) ? point.value : [];
    for (let j = 0; j < batch.length; j++) {
      const v = Number(values[j]);
      if (Number.isFinite(v)) sums[j] += v;
    }
    n++;
  }
  if (n === 0) return;
  for (let j = 0; j < batch.length; j++) {
    const avg = sums[j] / n; // Trends values are already 0–100 relative interest.
    out.set(batch[j], Math.max(0, Math.min(100, Math.round(avg))));
  }
}

// ── YouTube competition (quota-priced Data API) ──────────────────────────────

/** A top-ranking video for a keyword, with its channel + stats joined on. */
export interface CompetitionVideoRow {
  videoId: string;
  title: string;
  views: number;
  publishedAt: string | null;
  channelId: string;
  channelTitle: string;
  subscriberCount: number | null;
}

export interface CompetitionResult {
  /** pageInfo.totalResults from search (approximate corpus size), or null. */
  resultCount: number | null;
  videos: CompetitionVideoRow[];
}

/**
 * Fetch the YouTube competition picture for one keyword: one search.list (top ~10
 * by view count), then a batched videos.list (views + publishedAt) and
 * channels.list (subscriber counts). Rethrows YoutubeQuotaError so the runner can
 * stop; returns safe empties for any other failure.
 */
export async function youtubeCompetition(keyword: string, fetchImpl?: FetchFn): Promise<CompetitionResult> {
  const q = keyword.trim();
  if (!q) return { resultCount: null, videos: [] };

  // Oversample (search.list is 100 units regardless of maxResults) — US, by view
  // count, from the last year — so we still have ≥10 after dropping Shorts.
  let search;
  try {
    search = await searchKeywordVideos(q, 50, fetchImpl, { publishedAfter: oneYearAgoIso() });
  } catch (e) {
    if (e instanceof YoutubeQuotaError) throw e;
    return { resultCount: null, videos: [] };
  }
  if (search.hits.length === 0) return { resultCount: search.resultCount, videos: [] };

  // Get views + duration for every candidate first, so we can drop Shorts and
  // rank by real view count before spending a channels.list call.
  let videoStats: Map<string, VideoStats> = new Map();
  try {
    videoStats = await fetchVideoStats(search.hits.map((h) => h.videoId), fetchImpl);
  } catch (e) {
    if (e instanceof YoutubeQuotaError) throw e;
  }

  const longForm = search.hits
    .map((h) => ({ h, vs: videoStats.get(h.videoId) }))
    // Long-form only: duration must exceed the Shorts ceiling (drops Shorts and
    // anything whose duration we couldn't read).
    .filter((x) => x.vs !== undefined && x.vs.durationSeconds > SHORTS_MAX_SECONDS)
    .sort((a, b) => (b.vs!.views ?? 0) - (a.vs!.views ?? 0))
    .slice(0, COMPETITION_RESULTS);

  // Subscriber counts only for the surviving top-10 channels.
  let channelStats: Map<string, ChannelStats> = new Map();
  try {
    channelStats = await fetchChannelStats(
      longForm.map((x) => x.h.channelId).filter((id) => id),
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof YoutubeQuotaError) throw e;
  }

  const videos: CompetitionVideoRow[] = longForm.map(({ h, vs }) => {
    const cs = channelStats.get(h.channelId);
    return {
      videoId: h.videoId,
      title: h.title,
      views: vs?.views ?? 0,
      publishedAt: vs?.publishedAt ?? null,
      channelId: h.channelId,
      channelTitle: h.channelTitle || cs?.title || "",
      subscriberCount: cs?.subscriberCount ?? null,
    };
  });

  return { resultCount: search.resultCount, videos };
}

// ── DataForSEO (optional, paid — exact search volume + keyword ideas) ─────────

const DATAFORSEO_BASE = process.env.DATAFORSEO_BASE_URL || "https://api.dataforseo.com";

export interface DataForSeoCreds {
  login: string;
  password: string;
}

/** Real demand data for one keyword, from DataForSEO. */
export interface DfsVolume {
  volume: number | null;
  cpc: number | null;
  /** Paid competition index 0–100 (Google Ads), or null. */
  competitionIndex: number | null;
}

/** HTTP Basic header for DataForSEO. The credential is never logged. */
function dfsAuthHeader(creds: DataForSeoCreds): Record<string, string> {
  const token = Buffer.from(`${creds.login}:${creds.password}`).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json" };
}

/** Coerce DataForSEO's competition_index (0–100, sometimes null/string) to a number|null. */
function toCompetitionIndex(x: unknown): number | null {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/**
 * Exact monthly Google search volume + CPC + paid competition for a batch of
 * keywords (Google Ads → Search Volume, US/English). One task holds up to 1000
 * keywords. Best-effort: any failure logs a redacted warning and yields an empty
 * map so the run still completes on free signals. Keyed by NORMALIZED keyword.
 */
export async function dataForSeoSearchVolume(
  keywords: string[],
  creds: DataForSeoCreds,
  fetchImpl?: JsonFetch,
): Promise<Map<string, DfsVolume>> {
  const out = new Map<string, DfsVolume>();
  const clean = keywords.map((k) => k.trim()).filter(Boolean).slice(0, 1000);
  if (clean.length === 0) return out;
  const doFetch = resolveJsonFetch(fetchImpl);
  const url = `${DATAFORSEO_BASE}/v3/keywords_data/google_ads/search_volume/live`;
  const body = JSON.stringify([
    {
      keywords: clean,
      location_code: SCORING.dataForSeoLocationCode,
      language_code: SCORING.dataForSeoLanguageCode,
    },
  ]);
  try {
    const res = await doFetch(url, { method: "POST", headers: dfsAuthHeader(creds), body });
    if (!res.ok) {
      console.warn(`[keyword] DataForSEO search_volume HTTP ${res.status}`);
      return out;
    }
    const json = await res.json();
    const items: any[] = json?.tasks?.[0]?.result ?? [];
    for (const it of items) {
      const kw = typeof it?.keyword === "string" ? it.keyword : null;
      if (!kw) continue;
      out.set(normalizeKeyword(kw), {
        volume: Number.isFinite(it?.search_volume) ? Number(it.search_volume) : null,
        cpc: Number.isFinite(it?.cpc) ? Number(it.cpc) : null,
        competitionIndex: toCompetitionIndex(it?.competition_index),
      });
    }
  } catch (e) {
    console.warn(`[keyword] DataForSEO search_volume failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** One keyword idea from DataForSEO Labs, with its demand data joined on. */
export interface DfsIdea extends DfsVolume {
  keyword: string;
}

/**
 * DataForSEO Labs keyword ideas for a seed (keywords relevant to the seed, with
 * their search volume inline), US/English. Used to DISCOVER keywords beyond
 * autocomplete. Best-effort → empty array on any failure.
 */
export async function dataForSeoKeywordIdeas(
  seed: string,
  creds: DataForSeoCreds,
  limit: number,
  fetchImpl?: JsonFetch,
): Promise<DfsIdea[]> {
  const q = seed.trim();
  if (!q) return [];
  const doFetch = resolveJsonFetch(fetchImpl);
  const url = `${DATAFORSEO_BASE}/v3/dataforseo_labs/google/keyword_ideas/live`;
  const body = JSON.stringify([
    {
      keywords: [q],
      location_code: SCORING.dataForSeoLocationCode,
      language_code: SCORING.dataForSeoLanguageCode,
      limit: Math.max(1, Math.min(1000, limit)),
    },
  ]);
  try {
    const res = await doFetch(url, { method: "POST", headers: dfsAuthHeader(creds), body });
    if (!res.ok) {
      console.warn(`[keyword] DataForSEO keyword_ideas HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    const items: any[] = json?.tasks?.[0]?.result?.[0]?.items ?? [];
    const out: DfsIdea[] = [];
    for (const it of items) {
      const kw = typeof it?.keyword === "string" ? it.keyword : null;
      if (!kw) continue;
      const info = it?.keyword_info ?? {};
      out.push({
        keyword: kw,
        volume: Number.isFinite(info?.search_volume) ? Number(info.search_volume) : null,
        cpc: Number.isFinite(info?.cpc) ? Number(info.cpc) : null,
        competitionIndex: toCompetitionIndex(info?.competition),
      });
    }
    return out;
  } catch (e) {
    console.warn(`[keyword] DataForSEO keyword_ideas failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
