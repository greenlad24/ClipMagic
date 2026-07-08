/**
 * Typed helpers over the Keyword Research tables (kw_keywords, kw_competitors,
 * kw_dominance, kw_runs — defined in db/index.ts). Mirrors db/jobs.ts: plain
 * better-sqlite3 prepared statements, nanoid() ids, Date.now() timestamps, and
 * db.transaction for the multi-row dominance replace.
 *
 * kw_keywords is a GLOBAL cache keyed by the normalized keyword and refreshed on
 * a TTL (SCORING.cacheTtlMs), so a run reuses fresh keywords instead of burning
 * quota re-scoring them. kw_runs is the saved-runs history: it stores the ordered
 * keyword list + clusters/market/summary, and hydrateRun reassembles the full
 * ResearchRunResult by joining each keyword back out of the cache.
 */
import { nanoid } from "nanoid";
import { db } from "./index.js";
import {
  normalizeKeyword,
  type CompetitorRef,
  type ChannelProfile,
  type GapFlags,
  type InsightsReport,
  type KeywordCluster,
  type KeywordMetrics,
  type MarketAnalysis,
  type ResearchInput,
  type ResearchMode,
  type ResearchRunListItem,
  type ResearchRunResult,
  type ResearchRunSummary,
  type RunStatus,
} from "../keyword/types.js";

const now = () => Date.now();

// ── kw_keywords ──────────────────────────────────────────────────────────────

/** Raw kw_keywords row shape (SQLite columns). */
interface KeywordRow {
  keyword: string;
  display: string;
  demand_score: number | null;
  competition_score: number | null;
  opportunity_score: number | null;
  trends_score: number | null;
  autocomplete_score: number | null;
  search_volume: number | null;
  cpc: number | null;
  paid_competition: number | null;
  competition_fetched: number | null;
  yt_result_count: number | null;
  top_view_median: number | null;
  top_view_max: number | null;
  avg_channel_subs: number | null;
  top_video_age_days: number | null;
  gap_flags_json: string | null;
  sources_json: string | null;
  last_fetched_at: number | null;
}

const DEFAULT_GAP_FLAGS: GapFlags = {
  demandVsCompetition: false,
  smallChannelOutlier: false,
  underservedSubtopic: false,
  freshnessGap: false,
};

function parseGapFlags(json: string | null): GapFlags {
  if (!json) return { ...DEFAULT_GAP_FLAGS };
  try {
    const p = JSON.parse(json) as Partial<GapFlags>;
    return {
      demandVsCompetition: !!p.demandVsCompetition,
      smallChannelOutlier: !!p.smallChannelOutlier,
      underservedSubtopic: !!p.underservedSubtopic,
      freshnessGap: !!p.freshnessGap,
    };
  } catch {
    return { ...DEFAULT_GAP_FLAGS };
  }
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Map a stored row → KeywordMetrics. `cluster` is not persisted on the cache row
 * (it's a per-run concept), so it comes back null here; hydrateRun assigns it.
 * topCompetitors are hydrated separately via getDominance.
 */
function rowToMetrics(row: KeywordRow): KeywordMetrics {
  return {
    keyword: row.display,
    demandScore: row.demand_score ?? 0,
    competitionScore: row.competition_score ?? 0,
    opportunityScore: row.opportunity_score ?? 0,
    trendsScore: row.trends_score,
    autocompleteScore: row.autocomplete_score ?? 0,
    searchVolume: row.search_volume,
    cpc: row.cpc,
    paidCompetition: row.paid_competition,
    competitionFetched: !!row.competition_fetched,
    alreadyCovered: false, // per-run; hydrateRun overrides from the run's covered set
    ytResultCount: row.yt_result_count,
    topViewMedian: row.top_view_median,
    topViewMax: row.top_view_max,
    avgChannelSubs: row.avg_channel_subs,
    topVideoAgeDays: row.top_video_age_days,
    gapFlags: parseGapFlags(row.gap_flags_json),
    cluster: null,
    sources: parseStringArray(row.sources_json),
    topCompetitors: getDominance(normalizeKeyword(row.keyword)),
    lastFetchedAt: row.last_fetched_at ?? 0,
  };
}

/** INSERT OR REPLACE a keyword into the global cache (keyed by normalized text). */
export function upsertKeyword(m: KeywordMetrics): void {
  const normalized = normalizeKeyword(m.keyword);
  db.prepare(
    `INSERT OR REPLACE INTO kw_keywords
       (keyword, display, demand_score, competition_score, opportunity_score,
        trends_score, autocomplete_score, search_volume, cpc, paid_competition,
        competition_fetched, yt_result_count, top_view_median, top_view_max,
        avg_channel_subs, top_video_age_days, gap_flags_json, sources_json,
        last_fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    normalized,
    m.keyword,
    m.demandScore,
    m.competitionScore,
    m.opportunityScore,
    m.trendsScore,
    m.autocompleteScore,
    m.searchVolume,
    m.cpc,
    m.paidCompetition,
    m.competitionFetched ? 1 : 0,
    m.ytResultCount,
    m.topViewMedian,
    m.topViewMax,
    m.avgChannelSubs,
    m.topVideoAgeDays,
    JSON.stringify(m.gapFlags),
    JSON.stringify(m.sources),
    m.lastFetchedAt || now(),
  );
}

/** Fetch a cached keyword (with its dominance), or null if unknown. */
export function getKeyword(normalized: string): KeywordMetrics | null {
  const row = db
    .prepare("SELECT * FROM kw_keywords WHERE keyword = ?")
    .get(normalizeKeyword(normalized)) as KeywordRow | undefined;
  return row ? rowToMetrics(row) : null;
}

/** Like getKeyword, but null when the cached row is older than `ttlMs`. */
export function getFreshKeyword(normalized: string, ttlMs: number): KeywordMetrics | null {
  const key = normalizeKeyword(normalized);
  const row = db.prepare("SELECT * FROM kw_keywords WHERE keyword = ?").get(key) as KeywordRow | undefined;
  if (!row) return null;
  if ((row.last_fetched_at ?? 0) < now() - ttlMs) return null;
  return rowToMetrics(row);
}

// ── kw_competitors ───────────────────────────────────────────────────────────

/** A channel row to cache (subset of what channels.list returns). */
export interface CompetitorRow {
  channelId: string;
  title: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
}

/** INSERT OR REPLACE a channel's cached stats. */
export function upsertCompetitor(c: CompetitorRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO kw_competitors
       (channel_id, title, subscriber_count, video_count, view_count, last_fetched_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(c.channelId, c.title, c.subscriberCount, c.videoCount, c.viewCount, now());
}

// ── kw_dominance ─────────────────────────────────────────────────────────────

interface DominanceRow {
  keyword: string;
  rank: number;
  channel_id: string | null;
  channel_title: string | null;
  subscriber_count: number | null;
  video_id: string | null;
  video_title: string | null;
  video_views: number | null;
  video_published_at: string | null;
  updated_at: number;
}

/**
 * Replace the entire dominance list for a keyword: delete the existing rows then
 * insert the new set, in one transaction (so a poll never sees a half-written
 * ranking).
 */
export const replaceDominance = db.transaction((keyword: string, refs: CompetitorRef[]): void => {
  const key = normalizeKeyword(keyword);
  const t = now();
  db.prepare("DELETE FROM kw_dominance WHERE keyword = ?").run(key);
  const insert = db.prepare(
    `INSERT INTO kw_dominance
       (keyword, rank, channel_id, channel_title, subscriber_count, video_id,
        video_title, video_views, video_published_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of refs) {
    insert.run(
      key,
      r.rank,
      r.channelId,
      r.channelTitle,
      r.subscriberCount,
      r.videoId,
      r.videoTitle,
      r.videoViews,
      r.videoPublishedAt,
      t,
    );
  }
});

/** The ranked competitors for a keyword (rank 1 = top result), ordered by rank. */
export function getDominance(keyword: string): CompetitorRef[] {
  const rows = db
    .prepare("SELECT * FROM kw_dominance WHERE keyword = ? ORDER BY rank ASC")
    .all(normalizeKeyword(keyword)) as DominanceRow[];
  return rows.map((r) => ({
    channelId: r.channel_id ?? "",
    channelTitle: r.channel_title ?? "",
    subscriberCount: r.subscriber_count,
    rank: r.rank,
    videoId: r.video_id ?? "",
    videoTitle: r.video_title ?? "",
    videoViews: r.video_views ?? 0,
    videoPublishedAt: r.video_published_at,
  }));
}

// ── kw_runs ──────────────────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  niche: string;
  mode: ResearchMode;
  input_json: string;
  status: RunStatus;
  keyword_list_json: string | null;
  clusters_json: string | null;
  market_json: string | null;
  insights_json: string | null;
  channel_json: string | null;
  covered_json: string | null;
  summary_json: string | null;
  error: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
}

/** Create a run row in the 'running' state and return its id. */
export function createRun(input: ResearchInput): string {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO kw_runs
       (id, niche, mode, input_json, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, input.niche?.trim() || "", input.mode, JSON.stringify(input), "running", t, t);
  return id;
}

/** Patch a run row. Only the provided fields are written. */
export function updateRun(
  id: string,
  patch: {
    status?: RunStatus;
    keywordList?: string[];
    clusters?: KeywordCluster[];
    market?: MarketAnalysis | null;
    insights?: InsightsReport | null;
    channel?: ChannelProfile | null;
    covered?: string[];
    summary?: ResearchRunSummary;
    error?: string | null;
    niche?: string;
  },
): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.keywordList !== undefined) {
    sets.push("keyword_list_json = ?");
    vals.push(JSON.stringify(patch.keywordList));
  }
  if (patch.clusters !== undefined) {
    sets.push("clusters_json = ?");
    vals.push(JSON.stringify(patch.clusters));
  }
  if (patch.market !== undefined) {
    sets.push("market_json = ?");
    vals.push(patch.market === null ? null : JSON.stringify(patch.market));
  }
  if (patch.insights !== undefined) {
    sets.push("insights_json = ?");
    vals.push(patch.insights === null ? null : JSON.stringify(patch.insights));
  }
  if (patch.channel !== undefined) {
    sets.push("channel_json = ?");
    vals.push(patch.channel === null ? null : JSON.stringify(patch.channel));
  }
  if (patch.covered !== undefined) {
    sets.push("covered_json = ?");
    vals.push(JSON.stringify(patch.covered));
  }
  if (patch.summary !== undefined) {
    sets.push("summary_json = ?");
    vals.push(JSON.stringify(patch.summary));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  if (patch.niche !== undefined) {
    sets.push("niche = ?");
    vals.push(patch.niche);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE kw_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getRunRow(id: string): RunRow | null {
  const row = db.prepare("SELECT * FROM kw_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ?? null;
}

/** History rows: pinned first, then newest-first. */
export function listRuns(): ResearchRunListItem[] {
  const rows = db.prepare("SELECT * FROM kw_runs ORDER BY pinned DESC, created_at DESC").all() as RunRow[];
  return rows.map((r) => {
    const summary = safeParse<ResearchRunSummary>(r.summary_json);
    const keywordList = safeParse<string[]>(r.keyword_list_json) ?? [];
    return {
      id: r.id,
      niche: r.niche,
      mode: r.mode,
      totalKeywords: summary?.totalKeywords ?? keywordList.length,
      gapCount: summary?.gapCount ?? 0,
      status: r.status,
      pinned: !!r.pinned,
      createdAt: r.created_at,
    };
  });
}

/** Pin/unpin a run (pinned runs sort to the top of the history sidebar). */
export function setRunPinned(id: string, pinned: boolean): void {
  db.prepare("UPDATE kw_runs SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now(), id);
}

export function deleteRun(id: string): void {
  db.prepare("DELETE FROM kw_runs WHERE id = ?").run(id);
}

/**
 * Reassemble the full ResearchRunResult: hydrate each keyword in the stored
 * ordered list from the cache, attach its cluster, and surface clusters/market/
 * summary. Keywords that fell out of the cache are skipped. Returns null when the
 * run id is unknown.
 */
export function hydrateRun(id: string): ResearchRunResult | null {
  const row = getRunRow(id);
  if (!row) return null;

  const keywordList = safeParse<string[]>(row.keyword_list_json) ?? [];
  const clusters = safeParse<KeywordCluster[]>(row.clusters_json) ?? [];
  const market = safeParse<MarketAnalysis>(row.market_json) ?? null;
  const insights = safeParse<InsightsReport>(row.insights_json) ?? null;
  const channel = safeParse<ChannelProfile>(row.channel_json) ?? null;
  const coveredSet = new Set((safeParse<string[]>(row.covered_json) ?? []).map((k) => normalizeKeyword(k)));

  // keyword (normalized) → cluster name, so each hydrated keyword gets tagged.
  const clusterOf = new Map<string, string>();
  for (const c of clusters) {
    for (const k of c.keywords) clusterOf.set(normalizeKeyword(k), c.name);
  }

  const keywords: KeywordMetrics[] = [];
  for (const norm of keywordList) {
    const m = getKeyword(norm);
    if (!m) continue;
    m.cluster = clusterOf.get(normalizeKeyword(norm)) ?? null;
    m.alreadyCovered = coveredSet.has(normalizeKeyword(norm));
    keywords.push(m);
  }

  const summary: ResearchRunSummary =
    safeParse<ResearchRunSummary>(row.summary_json) ??
    { totalKeywords: keywords.length, topOpportunities: [], avgDemand: 0, avgCompetition: 0, gapCount: 0 };

  return {
    runId: row.id,
    niche: row.niche,
    mode: row.mode,
    keywords,
    clusters,
    market,
    insights,
    channel,
    summary,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
