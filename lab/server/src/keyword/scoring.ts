/**
 * Pure scoring functions for the Keyword Research tool — no I/O, so the maths is
 * unit-testable in isolation. Everything lands on a 0–100 scale and reads its
 * tunables from SCORING (keyword/types.ts) so the engine and any tests agree.
 *
 * There is no official YouTube search-volume number, so "demand" is an aggregate
 * of free signals (autocomplete depth/position, Google Trends, YouTube result
 * volume) and "competition" is how hard the top results look to unseat (huge
 * views, big channels, a deep corpus). "Opportunity" rewards high demand + low
 * competition, nudged up by each gap flag.
 */
import { SCORING, type GapFlags } from "./types.js";

const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));

/** log10-scaled 0–100: `full` (e.g. 10M) maps to ~100, 0 maps to 0. */
function logScore(value: number, full: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const num = Math.log10(value + 1);
  const den = Math.log10(full + 1);
  return clamp((num / den) * 100);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Autocomplete signal: earlier position (positionRank 1 = the top suggestion)
 * and more child sub-suggestions both push the score up. Weighted 60% position,
 * 40% breadth. positionRank ≤ 1 is treated as top; rank 11+ contributes nothing
 * from position. ~12 child suggestions saturates the breadth component.
 */
export function autocompleteScore(positionRank: number, subSuggestionCount: number): number {
  const rank = Number.isFinite(positionRank) && positionRank > 0 ? positionRank : 999;
  const pos = clamp(100 - (rank - 1) * 10);
  const breadth = clamp(Math.max(0, subSuggestionCount) * 8);
  return Math.round(0.6 * pos + 0.4 * breadth);
}

/** Real monthly search volume → 0–100 (log-scaled; SCORING.volumeFullScale ≈ 100). */
export function volumeScore(monthlyVolume: number): number {
  return Math.round(logScore(monthlyVolume, SCORING.volumeFullScale));
}

/**
 * Aggregate demand from the available signals. When real DataForSEO volume is
 * present (`volumeScore` non-null) it dominates via SCORING.demandWeightsWithVolume
 * (the free autocomplete/trends proxies only refine it); otherwise demand falls
 * back to the free-signal weights (autocomplete + ytVolume + trends). In both
 * cases a missing (null) Trends signal is dropped and the remaining weights are
 * renormalized so demand still spans 0–100.
 */
export function demandScore(input: {
  autocomplete: number;
  trends: number | null;
  ytVolume: number;
  volumeScore?: number | null;
}): number {
  const hasVolume =
    input.volumeScore !== undefined && input.volumeScore !== null && Number.isFinite(input.volumeScore);
  const parts: Array<{ value: number; weight: number }> = [];
  if (hasVolume) {
    const w = SCORING.demandWeightsWithVolume;
    parts.push({ value: clamp(input.volumeScore as number), weight: w.volume });
    parts.push({ value: clamp(input.autocomplete), weight: w.autocomplete });
    if (input.trends !== null && Number.isFinite(input.trends)) {
      parts.push({ value: clamp(input.trends), weight: w.trends });
    }
  } else {
    const w = SCORING.demandWeights;
    parts.push({ value: clamp(input.autocomplete), weight: w.autocomplete });
    parts.push({ value: clamp(input.ytVolume), weight: w.ytVolume });
    if (input.trends !== null && Number.isFinite(input.trends)) {
      parts.push({ value: clamp(input.trends), weight: w.trends });
    }
  }
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return 0;
  const score = parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
  return Math.round(clamp(score));
}

/** One top-ranking video's competition inputs. */
export interface CompetitionVideo {
  views: number;
  subscriberCount: number | null;
}

/**
 * Competition: higher when the top videos pull huge views, come from big
 * channels, and the corpus is deep. 50% view muscle (median of the top views),
 * 35% channel authority (median subs), 15% corpus depth (result count). All on a
 * log scale so the difference between 10k and 10M matters more than 10M vs 11M.
 */
export function competitionScore(videos: CompetitionVideo[], resultCount: number | null): number {
  if (videos.length === 0 && (resultCount === null || resultCount <= 0)) return 0;
  const viewScore = logScore(median(videos.map((v) => v.views)), 10_000_000);
  const subs = videos.map((v) => v.subscriberCount).filter((s): s is number => typeof s === "number" && s > 0);
  const subScore = subs.length ? logScore(median(subs), 10_000_000) : 0;
  const countScore = resultCount && resultCount > 0 ? logScore(resultCount, 1_000_000) : 0;
  return Math.round(clamp(0.5 * viewScore + 0.35 * subScore + 0.15 * countScore));
}

/** Inputs for the four opportunity gap flags. */
export interface GapInput {
  demand: number;
  competition: number;
  /** Top-ranking videos (for the small-channel outlier check). */
  videos: Array<{ views: number; subscriberCount: number | null }>;
  /** How many autocomplete child suggestions this keyword spawned. */
  autocompleteChildCount: number;
  /** Age (days) of the top-ranked video, or null when unknown. */
  topVideoAgeDays: number | null;
}

/** A "strong" video for the underserved check: a clearly-established result. */
const STRONG_VIDEO_VIEWS = 100_000;

/** Compute all four gap flags from a keyword's demand/competition + top videos. */
export function computeGapFlags(input: GapInput): GapFlags {
  const demandVsCompetition =
    input.demand >= SCORING.gapDemandFloor && input.competition <= SCORING.gapCompetitionCeiling;

  const smallChannelOutlier = input.videos.some(
    (v) =>
      typeof v.subscriberCount === "number" &&
      v.subscriberCount >= 0 &&
      v.subscriberCount <= SCORING.smallChannelSubThreshold &&
      v.views > 0 &&
      v.views >= v.subscriberCount * SCORING.smallChannelViewMultiple,
  );

  const strongVideos = input.videos.filter((v) => v.views >= STRONG_VIDEO_VIEWS).length;
  const underservedSubtopic = input.autocompleteChildCount >= 8 && strongVideos <= 2;

  const freshnessGap =
    typeof input.topVideoAgeDays === "number" && input.topVideoAgeDays > SCORING.freshnessStaleDays;

  return { demandVsCompetition, smallChannelOutlier, underservedSubtopic, freshnessGap };
}

/**
 * Opportunity: base = demand × (1 − competition/100) — high demand only counts
 * when it isn't already saturated — plus a small bonus per gap flag. Clamped to
 * 0–100.
 */
export function opportunityScore(demand: number, competition: number, gaps: GapFlags): number {
  let score = clamp(demand) * (1 - clamp(competition) / 100);
  if (gaps.demandVsCompetition) score += 8;
  if (gaps.smallChannelOutlier) score += 6;
  if (gaps.underservedSubtopic) score += 5;
  if (gaps.freshnessGap) score += 4;
  return Math.round(clamp(score));
}
