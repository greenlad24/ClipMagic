/**
 * Keyword Research orchestrator + in-memory job registry.
 *
 * Mirrors the Thumbnail Designer's start→poll pattern (thumbnails/jobs.ts +
 * orchestrate.ts): `startResearch` validates, creates the persisted run row,
 * registers an in-memory job, kicks the work off with a fire-and-forget
 * `void runResearch(...)`, and returns { jobId, runId } synchronously. The UI
 * polls `getResearchSnapshot(jobId)` for a live phase label + percent while the
 * run grinds through: resolve seeds → expand (autocomplete) → trends →
 * per-keyword competition/scoring → cluster → summarize.
 *
 * The heavy work is quota-aware: only the capped candidate set is scored with the
 * YouTube Data API, and a YoutubeQuotaError stops further Data-API calls (already
 * scored keywords are kept, and the remaining ones are still saved on the free
 * signals). runResearch NEVER throws — any failure lands on the job + run row.
 */
import { nanoid } from "nanoid";
import { ZiteError } from "../zite/store.js";
import {
  normalizeKeyword,
  SCORING,
  type CompetitorRef,
  type KeywordMetrics,
  type MarketAnalysis,
  type ResearchInput,
  type ResearchJobSnapshot,
  type ResearchRunSummary,
  type RunStatus,
} from "./types.js";
import {
  expandAutocomplete,
  googleTrends,
  youtubeCompetition,
  dataForSeoSearchVolume,
  dataForSeoKeywordIdeas,
  type CompetitionVideoRow,
  type DfsVolume,
  type DataForSeoCreds,
} from "./sources.js";
import {
  autocompleteScore,
  competitionScore,
  computeGapFlags,
  demandScore,
  opportunityScore,
  volumeScore,
} from "./scoring.js";
import { clusterKeywords, expandSeedsFromTopic, generateInsights, inferMarket } from "./ai.js";
import { youtubeConfigured, searchKeywordVideos, YoutubeQuotaError } from "../thumbnails/youtube.js";
import { getDataForSeoCreds } from "../settings/postizSecrets.js";
import {
  createRun,
  updateRun,
  upsertKeyword,
  getFreshKeyword,
  replaceDominance,
  upsertCompetitor,
  hydrateRun,
} from "../db/keywordResearch.js";
import type { ResearchRunResult } from "./types.js";

// ── In-memory job registry (ephemeral; the run itself is persisted in SQLite) ──
interface ResearchJob {
  id: string;
  runId: string;
  status: RunStatus;
  phase: string;
  percent: number;
  keywordsFound: number;
  keywordsScored: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const JOB_TTL_MS = 30 * 60_000; // keep finished jobs pollable for 30 min
const MAX_JOBS = 50;
const jobs = new Map<string, ResearchJob>();

function reap(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.status !== "running" && j.updatedAt < cutoff) jobs.delete(id);
  }
  if (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= jobs.size - MAX_JOBS; i++) if (oldest[i]) jobs.delete(oldest[i].id);
  }
}

/** Set phase label + a monotonic percent (never goes backwards). */
function setPhase(job: ResearchJob, phase: string, percent: number): void {
  job.phase = phase;
  job.percent = Math.max(job.percent, Math.max(0, Math.min(100, Math.round(percent))));
  job.updatedAt = Date.now();
}

export function getResearchSnapshot(jobId: string): ResearchJobSnapshot | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    runId: job.runId,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    keywordsFound: job.keywordsFound,
    keywordsScored: job.keywordsScored,
    error: job.error,
  };
}

// ── Public entry ──────────────────────────────────────────────────────────────

/**
 * Validate the input per mode, create the run row + job, and kick the background
 * runner off. Returns { jobId, runId } immediately. Throws ZiteError BAD_REQUEST
 * when the mode's required input is empty.
 */
export function startResearch(input: ResearchInput): { jobId: string; runId: string } {
  validateInput(input);
  reap();
  const runId = createRun(input);
  const now = Date.now();
  const job: ResearchJob = {
    id: nanoid(),
    runId,
    status: "running",
    phase: "Starting…",
    percent: 0,
    keywordsFound: 0,
    keywordsScored: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  // Fire-and-forget: runResearch never throws (it records onto the job + run).
  void runResearch(job, runId, input);
  return { jobId: job.id, runId };
}

/**
 * Backfill exact DataForSEO search volume onto an EXISTING run's keywords without
 * a full re-run: fetch volume for the run's keyword list, recompute demand +
 * opportunity (competition/gaps are unchanged and reused from cache), re-sort,
 * re-summarize, regenerate insights, and persist. Returns the updated run.
 * Throws ZiteError when DataForSEO isn't configured or the run is unknown/empty.
 */
export async function refreshRunVolume(runId: string): Promise<ResearchRunResult> {
  const creds = getDataForSeoCreds();
  if (!creds) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "Add your DataForSEO login + password in Settings → Keyword Research first.",
    });
  }
  const current = hydrateRun(runId);
  if (!current) throw new ZiteError({ code: "NOT_FOUND", message: "Research run not found." });
  if (current.keywords.length === 0) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "This run has no keywords to refresh." });
  }

  const vols = await dataForSeoSearchVolume(
    current.keywords.map((k) => k.keyword),
    creds,
  );

  const updated: KeywordMetrics[] = current.keywords.map((k) => {
    const v = vols.get(normalizeKeyword(k.keyword));
    if (!v) return k;
    const volScore = v.volume !== null ? volumeScore(v.volume) : null;
    const ytVolume = k.ytResultCount && k.ytResultCount > 0 ? logScore(k.ytResultCount, 1_000_000) : 0;
    const demand = demandScore({
      autocomplete: k.autocompleteScore,
      trends: k.trendsScore,
      ytVolume,
      volumeScore: volScore,
    });
    const opportunity = opportunityScore(demand, k.competitionScore, k.gapFlags);
    const sources = v.volume !== null && !k.sources.includes("dataforseo") ? [...k.sources, "dataforseo"] : k.sources;
    const m: KeywordMetrics = {
      ...k,
      searchVolume: v.volume,
      cpc: v.cpc,
      paidCompetition: v.competitionIndex,
      demandScore: demand,
      opportunityScore: opportunity,
      sources,
      lastFetchedAt: Date.now(),
    };
    upsertKeyword(m); // dominance/competition rows are untouched.
    return m;
  });

  const sorted = [...updated].sort((a, b) => b.opportunityScore - a.opportunityScore);
  const summary = summarize(sorted);
  const insights = await generateInsights({
    niche: current.niche,
    keywords: sorted,
    clusters: current.clusters,
    market: current.market,
  });
  updateRun(runId, { keywordList: sorted.map((r) => normalizeKeyword(r.keyword)), summary, insights });

  const result = hydrateRun(runId);
  if (!result) throw new ZiteError({ code: "NOT_FOUND", message: "Research run not found." });
  return result;
}

function validateInput(input: ResearchInput): void {
  const bad = (message: string) => new ZiteError({ code: "BAD_REQUEST", message });
  const nonEmpty = (arr?: string[]) => Array.isArray(arr) && arr.some((s) => s && s.trim());
  switch (input.mode) {
    case "seeds":
      if (!nonEmpty(input.seeds)) throw bad("Enter at least one seed keyword.");
      break;
    case "topic":
      if (!input.topic?.trim()) throw bad("Enter a topic/niche to expand.");
      break;
    case "competitors":
      if (!nonEmpty(input.competitors)) throw bad("Enter at least one competitor channel.");
      break;
    case "ai":
      if (!input.freeText?.trim()) throw bad("Enter a description for the AI to analyze.");
      break;
    default:
      throw bad(`Unknown research mode: ${String((input as ResearchInput).mode)}`);
  }
}

// ── The background runner ─────────────────────────────────────────────────────

async function runResearch(job: ResearchJob, runId: string, input: ResearchInput): Promise<void> {
  try {
    let market: MarketAnalysis | null = null;
    // Optional DataForSEO: exact volume + extra keyword ideas. null = free signals only.
    const dfsCreds = getDataForSeoCreds();
    // normalized keyword → real demand data (from ideas + search-volume calls).
    const volumeByKeyword = new Map<string, DfsVolume>();

    // Phase 1 — resolve seeds by mode.
    setPhase(job, "Resolving seeds…", 3);
    let seeds: string[] = [];
    if (input.mode === "seeds") {
      seeds = (input.seeds ?? []).map((s) => s.trim()).filter(Boolean);
    } else if (input.mode === "topic") {
      seeds = await expandSeedsFromTopic(input.topic ?? "");
    } else if (input.mode === "competitors") {
      seeds = await seedsFromCompetitors(input.competitors ?? []);
    } else if (input.mode === "ai") {
      const inferred = await inferMarket(input.freeText ?? "");
      market = inferred.market;
      seeds = [...inferred.seeds, ...inferred.competitors];
      updateRun(runId, { market });
    }
    seeds = dedupeStrings(seeds);
    if (seeds.length === 0) throw new Error("No seed keywords could be resolved for this run.");

    // Phase 1b — DataForSEO keyword ideas (extra discovery beyond autocomplete).
    const ideaKeywords: string[] = [];
    if (dfsCreds) {
      setPhase(job, "Fetching DataForSEO keyword ideas…", 8);
      for (const seed of seeds.slice(0, 5)) {
        const ideas = await dataForSeoKeywordIdeas(seed, dfsCreds, SCORING.dataForSeoIdeasPerSeed);
        for (const idea of ideas) {
          ideaKeywords.push(idea.keyword);
          volumeByKeyword.set(normalizeKeyword(idea.keyword), {
            volume: idea.volume,
            cpc: idea.cpc,
            competitionIndex: idea.competitionIndex,
          });
        }
      }
    }

    // Phase 2 — expand each seed via autocomplete; fold in the DataForSEO ideas.
    setPhase(job, "Expanding keywords…", 12);
    const candidates = await buildCandidates(seeds, input.maxKeywords ?? SCORING.defaultMaxKeywords, ideaKeywords);
    job.keywordsFound = candidates.length;
    setPhase(job, `Expanded to ${candidates.length} keywords`, 22);

    // Phase 2b — exact search volume for the whole candidate set (one batched call).
    if (dfsCreds) {
      setPhase(job, "Fetching search volume (DataForSEO)…", 24);
      const vols = await dataForSeoSearchVolume(candidates.map((c) => c.display), dfsCreds);
      for (const [k, v] of vols) volumeByKeyword.set(k, v);
    }
    // How many candidates EXTEND each candidate (a "sub-suggestion spawned")?
    // Feeds the autocomplete breadth score + the underserved-subtopic gap.
    const childCounts = computeChildCounts(candidates);

    // Phase 3 — best-effort Google Trends over the candidates.
    setPhase(job, "Reading Google Trends…", 25);
    const trends = await googleTrends(candidates.map((c) => c.display));

    // Phase 4 — per-keyword competition + scoring (quota-aware).
    const ytOn = youtubeConfigured();
    let quotaHit = false;
    const results: KeywordMetrics[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const scored = i + 1;
      const pct = 25 + Math.round((scored / candidates.length) * 63); // 25 → 88
      setPhase(job, `Scoring competition ${scored}/${candidates.length}${quotaHit ? " (quota reached)" : ""}`, pct);

      // Reuse a fresh cache hit unless a refresh was requested.
      if (!input.refresh) {
        const cached = getFreshKeyword(c.normalized, SCORING.cacheTtlMs);
        if (cached) {
          results.push(cached);
          job.keywordsScored = scored;
          continue;
        }
      }

      // Competition via the Data API (skipped when off or after a quota stop).
      let comp: { resultCount: number | null; videos: CompetitionVideoRow[] } = { resultCount: null, videos: [] };
      if (ytOn && !quotaHit) {
        try {
          comp = await youtubeCompetition(c.display);
        } catch (e) {
          if (e instanceof YoutubeQuotaError) {
            quotaHit = true; // stop hammering quota; keep scoring on free signals.
          } else {
            comp = { resultCount: null, videos: [] };
          }
        }
      }

      const metrics = scoreKeyword(
        c,
        childCounts.get(c.normalized) ?? 0,
        trends.get(c.display) ?? null,
        comp,
        volumeByKeyword.get(c.normalized) ?? null,
      );
      persistKeyword(metrics, comp.videos);
      results.push(metrics);
      job.keywordsScored = scored;
    }

    // Phase 5 — cluster the final list and tag each keyword.
    setPhase(job, "Clustering keywords…", 90);
    const clusters = await clusterKeywords(results.map((r) => r.keyword));
    const clusterOf = new Map<string, string>();
    for (const cl of clusters) for (const k of cl.keywords) clusterOf.set(normalizeKeyword(k), cl.name);
    for (const r of results) r.cluster = clusterOf.get(normalizeKeyword(r.keyword)) ?? null;

    // Phase 6 — AI insights/recommendations over the scored results (all modes).
    setPhase(job, "Generating insights…", 93);
    const niche = input.niche?.trim() || deriveNiche(input, seeds);
    const sorted = [...results].sort((a, b) => b.opportunityScore - a.opportunityScore);
    const insights = await generateInsights({ niche, keywords: sorted, clusters, market });

    // Phase 7 — summarize + persist the completed run.
    setPhase(job, "Summarizing…", 97);
    const summary = summarize(sorted);
    updateRun(runId, {
      status: "completed",
      keywordList: sorted.map((r) => normalizeKeyword(r.keyword)),
      clusters,
      market,
      insights,
      summary,
      niche,
    });

    job.status = "completed";
    setPhase(job, quotaHit ? "Completed (YouTube quota was reached)" : "Completed", 100);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    job.status = "failed";
    job.error = message;
    job.updatedAt = Date.now();
    updateRun(runId, { status: "failed", error: message });
  }
}

// ── Phase helpers ─────────────────────────────────────────────────────────────

interface Candidate {
  display: string;
  normalized: string;
  /** Best (lowest) autocomplete position observed (1 = top suggestion). */
  rank: number;
}

/**
 * Derive seed topics from competitor channels: search each channel/handle for its
 * most-viewed videos and use those titles (plus the competitor name) as seeds.
 * Quota/failure-tolerant — falls back to the raw competitor strings.
 */
async function seedsFromCompetitors(competitors: string[]): Promise<string[]> {
  const names = competitors.map((c) => c.trim()).filter(Boolean).slice(0, 5);
  const seeds: string[] = [...names];
  if (!youtubeConfigured()) return seeds;
  for (const name of names) {
    try {
      const res = await searchKeywordVideos(name, 5);
      for (const hit of res.hits) if (hit.title) seeds.push(hit.title);
    } catch {
      // Quota or lookup failure — the competitor name alone still seeds expansion.
    }
  }
  return seeds;
}

/**
 * Expand every seed via autocomplete into a deduped, position-ranked candidate
 * set. `extra` keywords (e.g. DataForSEO ideas) are added DIRECTLY, without their
 * own alphabet-soup expansion, so extra discovery doesn't multiply autocomplete
 * calls.
 */
async function buildCandidates(seeds: string[], cap: number, extra: string[] = []): Promise<Candidate[]> {
  const byNorm = new Map<string, Candidate>();
  const add = (display: string, rank: number) => {
    const normalized = normalizeKeyword(display);
    if (!normalized) return;
    const existing = byNorm.get(normalized);
    if (existing) {
      if (rank < existing.rank) existing.rank = rank;
    } else {
      byNorm.set(normalized, { display: display.trim(), normalized, rank });
    }
  };

  for (const seed of seeds) {
    add(seed, 1); // the seed itself is a top-priority candidate.
    const suggestions = await expandAutocomplete(seed);
    suggestions.forEach((s, idx) => add(s, idx + 1));
  }
  // DataForSEO ideas: added directly (mid-priority rank), not autocomplete-expanded.
  extra.forEach((k, idx) => add(k, idx + 1));

  return [...byNorm.values()].slice(0, Math.max(1, cap));
}

/** For each candidate, how many OTHER candidates extend it (`c + " " + …`). */
function computeChildCounts(candidates: Candidate[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of candidates) {
    let n = 0;
    const prefix = c.normalized + " ";
    for (const other of candidates) {
      if (other !== c && other.normalized.startsWith(prefix)) n++;
    }
    out.set(c.normalized, n);
  }
  return out;
}

/** Compute all metrics for one candidate from its free signals + competition. */
function scoreKeyword(
  c: Candidate,
  childCount: number,
  trends: number | null,
  comp: { resultCount: number | null; videos: CompetitionVideoRow[] },
  vol: DfsVolume | null,
): KeywordMetrics {
  const acScore = autocompleteScore(c.rank, childCount);

  const videos = comp.videos;
  const views = videos.map((v) => v.views);
  const subsVals = videos.map((v) => v.subscriberCount).filter((s): s is number => typeof s === "number");
  const ytVolume = comp.resultCount && comp.resultCount > 0 ? logScore(comp.resultCount, 1_000_000) : 0;

  const volScore = vol && vol.volume !== null ? volumeScore(vol.volume) : null;
  const demand = demandScore({ autocomplete: acScore, trends, ytVolume, volumeScore: volScore });
  const competition = competitionScore(
    videos.map((v) => ({ views: v.views, subscriberCount: v.subscriberCount })),
    comp.resultCount,
  );
  const topVideoAgeDays = ageDays(videos[0]?.publishedAt ?? null);
  const gapFlags = computeGapFlags({
    demand,
    competition,
    videos: videos.map((v) => ({ views: v.views, subscriberCount: v.subscriberCount })),
    autocompleteChildCount: childCount,
    topVideoAgeDays,
  });
  const opportunity = opportunityScore(demand, competition, gapFlags);

  const sources = ["autocomplete"];
  if (trends !== null) sources.push("trends");
  if (videos.length > 0) sources.push("youtube");
  if (vol && vol.volume !== null) sources.push("dataforseo");

  const topCompetitors: CompetitorRef[] = videos.slice(0, SCORING.competitorsPerKeyword).map((v, idx) => ({
    channelId: v.channelId,
    channelTitle: v.channelTitle,
    subscriberCount: v.subscriberCount,
    rank: idx + 1,
    videoId: v.videoId,
    videoTitle: v.title,
    videoViews: v.views,
    videoPublishedAt: v.publishedAt,
  }));

  return {
    keyword: c.display,
    demandScore: demand,
    competitionScore: competition,
    opportunityScore: opportunity,
    trendsScore: trends,
    autocompleteScore: acScore,
    searchVolume: vol ? vol.volume : null,
    cpc: vol ? vol.cpc : null,
    paidCompetition: vol ? vol.competitionIndex : null,
    ytResultCount: comp.resultCount,
    topViewMedian: views.length ? Math.round(median(views)) : null,
    topViewMax: views.length ? Math.max(...views) : null,
    avgChannelSubs: subsVals.length ? Math.round(subsVals.reduce((s, n) => s + n, 0) / subsVals.length) : null,
    topVideoAgeDays,
    gapFlags,
    cluster: null,
    sources,
    topCompetitors,
    lastFetchedAt: Date.now(),
  };
}

/** Persist a scored keyword + its dominance + each competing channel. */
function persistKeyword(m: KeywordMetrics, videos: CompetitionVideoRow[]): void {
  upsertKeyword(m);
  replaceDominance(m.keyword, m.topCompetitors);
  for (const v of videos) {
    if (!v.channelId) continue;
    upsertCompetitor({
      channelId: v.channelId,
      title: v.channelTitle,
      subscriberCount: v.subscriberCount,
      videoCount: null,
      viewCount: null,
    });
  }
}

function summarize(sortedByOpportunity: KeywordMetrics[]): ResearchRunSummary {
  const total = sortedByOpportunity.length;
  const avg = (sel: (m: KeywordMetrics) => number) =>
    total ? Math.round(sortedByOpportunity.reduce((s, m) => s + sel(m), 0) / total) : 0;
  const gapCount = sortedByOpportunity.filter((m) => Object.values(m.gapFlags).some(Boolean)).length;
  return {
    totalKeywords: total,
    topOpportunities: sortedByOpportunity.slice(0, 10).map((m) => m.keyword),
    avgDemand: avg((m) => m.demandScore),
    avgCompetition: avg((m) => m.competitionScore),
    gapCount,
  };
}

function deriveNiche(input: ResearchInput, seeds: string[]): string {
  if (input.topic?.trim()) return input.topic.trim();
  if (input.freeText?.trim()) return input.freeText.trim().slice(0, 80);
  return seeds[0] ?? "Keyword research";
}

// ── small pure utilities ─────────────────────────────────────────────────────

function dedupeStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t) continue;
    const key = normalizeKeyword(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** log10-scaled 0–100 (matches scoring.ts's internal scale). */
function logScore(value: number, full: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.min(100, (Math.log10(value + 1) / Math.log10(full + 1)) * 100));
}

/** Age in whole days from an ISO publish date, or null when unknown/unparseable. */
function ageDays(publishedAt: string | null): number | null {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
