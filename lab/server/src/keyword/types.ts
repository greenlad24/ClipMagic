/**
 * Shared contract for the YouTube Keyword Research LAB tool.
 *
 * This file is the single source of truth for the shapes the data-source engine,
 * the AI helpers, the job runner, the zite handlers and the frontend all speak.
 * No YouTube API gives an official search-volume number, so "demand" is an
 * AGGREGATE SCORE (0–100) computed from several free signals (YouTube
 * autocomplete depth/position, Google Trends interest, YouTube result
 * volume/view velocity) plus, optionally, a paid provider. Everything is cached
 * in SQLite (see db/keywordResearch.ts) and refreshed on a TTL rather than
 * refetched every run.
 */

/** How a research run is seeded. */
export type ResearchMode = "seeds" | "topic" | "competitors" | "ai";

export interface ResearchInput {
  mode: ResearchMode;
  /** Human label for the run / niche (shown in history). */
  niche?: string;
  /** mode=seeds: one or more seed keywords. */
  seeds?: string[];
  /** mode=topic: a niche description Claude expands into seeds. */
  topic?: string;
  /** mode=competitors: channel URLs / @handles / channel ids to mine. */
  competitors?: string[];
  /** mode=ai: free text; Claude infers the market, competitors and seeds. */
  freeText?: string;
  /** Cap on keywords scored with the (quota-limited) YouTube Data API. */
  maxKeywords?: number;
  /** Force a refetch even when a cached keyword is still fresh. */
  refresh?: boolean;
  /**
   * The user's OWN channel (URL / @handle / channel id). When set, the tool
   * fetches their uploaded videos to (a) flag keywords they've already covered,
   * (b) seed research from their topics, and (c) recommend new avenues for scale.
   */
  channelUrl?: string;
}

/** The four opportunity signals the user asked for. */
export interface GapFlags {
  /** High demand, low competition — the classic opportunity. */
  demandVsCompetition: boolean;
  /** Small/new channels ranking big for this keyword (low authority barrier). */
  smallChannelOutlier: boolean;
  /** Many related queries but few good/recent videos answering them. */
  underservedSubtopic: boolean;
  /** Top-ranking videos are stale (older than the freshness threshold). */
  freshnessGap: boolean;
}

/** One competing video/channel that ranks for a keyword ("who dominates it"). */
export interface CompetitorRef {
  channelId: string;
  channelTitle: string;
  subscriberCount: number | null;
  /** 1 = the top result for this keyword. */
  rank: number;
  videoId: string;
  videoTitle: string;
  videoViews: number;
  videoPublishedAt: string | null;
}

/** Everything known + computed about a single keyword. */
export interface KeywordMetrics {
  keyword: string;
  /** 0–100 aggregate demand. */
  demandScore: number;
  /** 0–100, higher = harder to rank. */
  competitionScore: number;
  /** 0–100, high demand + low competition + gap bonuses. */
  opportunityScore: number;
  /** 0–100 Google Trends interest, or null when Trends was unavailable. */
  trendsScore: number | null;
  /** 0–100 from autocomplete position + how many sub-suggestions it spawns. */
  autocompleteScore: number;
  /** Real monthly Google search volume from DataForSEO, or null (free signals only). */
  searchVolume: number | null;
  /** Average CPC (USD) from DataForSEO, or null. */
  cpc: number | null;
  /** DataForSEO paid-competition index 0–100, or null. */
  paidCompetition: number | null;
  ytResultCount: number | null;
  topViewMedian: number | null;
  topViewMax: number | null;
  avgChannelSubs: number | null;
  /** Age (days) of the top-ranked video — drives the freshness gap. */
  topVideoAgeDays: number | null;
  gapFlags: GapFlags;
  cluster: string | null;
  /** Which signals contributed (e.g. ["autocomplete","trends","youtube"]). */
  sources: string[];
  /** Up to a few top-ranking competitors for this keyword. */
  topCompetitors: CompetitorRef[];
  /**
   * Whether YouTube competitor data (views/subs/dates) has been fetched for this
   * keyword. False for keywords beyond the upfront competition budget — the UI
   * shows "—" for competition/opportunity and fetches it on click.
   */
  competitionFetched: boolean;
  /** True when this keyword matches one of the user's own uploaded videos. */
  alreadyCovered: boolean;
  lastFetchedAt: number;
}

export interface KeywordCluster {
  name: string;
  /** Keyword strings belonging to this cluster. */
  keywords: string[];
  rationale?: string;
}

/** One of the user's own uploaded videos (for channel analysis). */
export interface ChannelVideo {
  videoId: string;
  title: string;
  views: number;
  publishedAt: string | null;
}

/** The user's own channel profile — what they've already posted. */
export interface ChannelProfile {
  channelId: string;
  title: string;
  handle: string | null;
  url: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  /** Their uploads (recent/top), used for gaps + already-covered matching. */
  videos: ChannelVideo[];
  fetchedAt: number;
}

/** AI market read (mode=ai / mode=topic). */
export interface MarketAnalysis {
  overview: string;
  audience: string;
  topCompetitors: { name: string; note: string }[];
  contentAngles: string[];
}

/**
 * AI-synthesized insights for a run — the qualitative layer on top of the
 * numbers. Generated (all modes) from the scored keywords + clusters + market.
 */
export interface InsightsReport {
  /** 2–3 sentence read of the opportunity landscape for this niche. */
  summary: string;
  /** The best keywords to target, each with WHY it's an opportunity. */
  topOpportunities: { keyword: string; why: string }[];
  /** Concrete video ideas: a title + the keyword it targets + the angle. */
  contentIdeas: { title: string; keyword: string; angle: string }[];
  /** Saturated / low-value keywords to skip, with a reason. */
  avoid: { keyword: string; why: string }[];
  /**
   * NEW growth directions for the user's channel — topics with demand they
   * HAVEN'T covered yet. Populated only when a channel URL was supplied.
   */
  newAvenues: { topic: string; why: string }[];
  /** A cluster/series strategy — how to sequence content for momentum. */
  seriesStrategy: string;
}

export interface ResearchRunSummary {
  totalKeywords: number;
  /** Top keyword strings by opportunity score. */
  topOpportunities: string[];
  avgDemand: number;
  avgCompetition: number;
  /** How many keywords carry at least one gap flag. */
  gapCount: number;
}

export type RunStatus = "running" | "completed" | "failed";

/** The full, hydrated result of a run (returned by getResearchRun). */
export interface ResearchRunResult {
  runId: string;
  niche: string;
  mode: ResearchMode;
  keywords: KeywordMetrics[];
  clusters: KeywordCluster[];
  market: MarketAnalysis | null;
  insights: InsightsReport | null;
  /** The user's own channel profile, when a channel URL was supplied. */
  channel: ChannelProfile | null;
  summary: ResearchRunSummary;
  status: RunStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Compact row for the saved-runs history list. */
export interface ResearchRunListItem {
  id: string;
  niche: string;
  mode: ResearchMode;
  totalKeywords: number;
  gapCount: number;
  status: RunStatus;
  /** Pinned runs sort to the top of the history sidebar. */
  pinned: boolean;
  createdAt: number;
}

/** Live snapshot the frontend polls while a run is in flight. */
export interface ResearchJobSnapshot {
  jobId: string;
  runId: string;
  status: RunStatus;
  /** Human phase label ("Expanding keywords…", "Scoring competition 12/80"). */
  phase: string;
  /** 0–100 overall. */
  percent: number;
  keywordsFound: number;
  keywordsScored: number;
  error: string | null;
}

/** What keywordResearchStatus reports to gate the UI. */
export interface KeywordResearchStatus {
  youtubeConfigured: boolean;
  trendsAvailable: boolean;
  keywordApiConfigured: boolean;
  promptOptimizerConfigured: boolean;
}

/**
 * Central scoring + behaviour constants. Tunable in one place so the engine and
 * any tests agree. Weights within a group sum to 1.
 */
export const SCORING = {
  /** Cached keyword is reused (not refetched) while newer than this — data is
   * kept "at most a month old". */
  cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** How the 0–100 demand score is composed from FREE signals only. */
  demandWeights: { autocomplete: 0.4, trends: 0.35, ytVolume: 0.25 },
  /**
   * When real DataForSEO search volume is available it becomes the dominant
   * demand signal (the free autocomplete/trends proxies just refine it).
   */
  demandWeightsWithVolume: { volume: 0.6, autocomplete: 0.2, trends: 0.2 },
  /** Monthly search volume that maps to ~100 on the demand scale (log). */
  volumeFullScale: 1_000_000,
  /** DataForSEO request targeting: US, English. */
  dataForSeoLocationCode: 2840,
  dataForSeoLanguageCode: "en",
  /** How many keyword ideas to pull per seed from DataForSEO Labs. */
  dataForSeoIdeasPerSeed: 50,
  /** A channel at/under this many subs counts as "small" for the outlier gap. */
  smallChannelSubThreshold: 50_000,
  /** Small channel counts as an outlier when video views ≥ subs × this. */
  smallChannelViewMultiple: 3,
  /** Top video older than this many days → freshness gap. */
  freshnessStaleDays: 730,
  /** demandVsCompetition gap fires when demand ≥ this and competition ≤ this. */
  gapDemandFloor: 55,
  gapCompetitionCeiling: 45,
  /** Default cap on how many candidate keywords to DISCOVER + demand-score. */
  defaultMaxKeywords: 200,
  /**
   * How many top-by-demand keywords get YouTube competitor data fetched UPFRONT
   * (quota-bounded: each ≈ 100 units). The rest are fetched on click.
   */
  competitionUpfront: 80,
  /** How many top competitors to keep per keyword (richer detail view). */
  competitorsPerKeyword: 10,
  /** How many of the user's own uploads to fetch for channel analysis. */
  channelVideoSample: 50,
} as const;

/** Normalize a keyword for use as the cache primary key. */
export function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, " ");
}
