/**
 * Turning a scored catalogue into claims — pure, no I/O, unit-tested.
 *
 * Every "X wins" in the report comes from here, and the hard part is not the
 * arithmetic but refusing to make a claim the data cannot support. Two rules
 * run through the whole module:
 *
 *  1. NOTHING IS CONCLUDED FROM A HANDFUL OF VIDEOS. A pattern seen three times
 *     is an anecdote. `MIN_SAMPLE` is the floor, and anything below it is
 *     dropped rather than reported with a quiet caveat nobody reads.
 *
 *  2. EVERY COMPARISON IS AGAINST THE ALTERNATIVE, not against the average. "8
 *     of your top 10 have a face" means nothing if 8 of every 10 videos have a
 *     face. The number that matters is how videos WITH an attribute did against
 *     videos WITHOUT it, which is what `correlate` computes.
 *
 * Medians throughout, never means: one 1.4M-view outlier in a catalogue whose
 * median is 8k would otherwise define every pattern it happens to belong to.
 */
import { median } from "./baseline.js";
import type { ScoredVideo } from "./baseline.js";
import type { AuditVideo, TitleFeatures, ThumbnailFindings } from "./types.js";

/**
 * Below this a pattern is an anecdote, not a finding.
 *
 * Five is low, and chosen knowing it: a 127-video catalogue split by title
 * construction leaves few large buckets, and a floor of ten would report
 * nothing at all. The sample size travels with every claim so the reader can
 * discount it themselves.
 */
export const MIN_SAMPLE = 5;

/** Title constructions worth telling apart, tried in order — first match wins. */
const TITLE_PATTERNS: { pattern: string; test: RegExp }[] = [
  { pattern: "How to", test: /^\s*how\s+(to|i|we)\b/i },
  { pattern: "Numbered list", test: /^\s*\d+\s+\w/ },
  { pattern: "Question", test: /\?\s*$/ },
  { pattern: "I tried / I built", test: /^\s*(i|we)\s+(tried|built|made|tested|used|spent)\b/i },
  { pattern: "Versus", test: /\bvs\.?\b|\bversus\b/i },
  { pattern: "Tutorial / Guide", test: /\b(tutorial|guide|walkthrough|course)\b/i },
  { pattern: "Announcement", test: /\b(just|new|finally|now)\b.*\b(released|launched|added|made|is here)\b/i },
  { pattern: "Superlative", test: /\b(best|worst|ultimate|complete|insane|wild|crazy)\b/i },
  { pattern: "Negative / warning", test: /\b(stop|never|don'?t|avoid|mistake|wrong|dead|over)\b/i },
];

export function titleFeatures(title: string): TitleFeatures {
  const t = title || "";
  const matched = TITLE_PATTERNS.find((p) => p.test.test(t));
  return {
    charLength: t.length,
    wordCount: t.trim() ? t.trim().split(/\s+/).length : 0,
    hasNumber: /\d/.test(t),
    hasBrackets: /[([]/.test(t),
    hasQuestion: /\?/.test(t),
    hasYear: /\b20\d{2}\b/.test(t),
    // A word in caps that isn't an acronym — "UNLIMITED", not "AI".
    isAllCapsWord: /\b[A-Z]{4,}\b/.test(t),
    pattern: matched ? matched.pattern : "Plain statement",
  };
}

/** Only judged videos of one format ever form evidence. */
export function evidencePool(videos: AuditVideo[], format: "long" | "short" = "long"): AuditVideo[] {
  return videos.filter((v) => v.judged && v.format === format);
}

/**
 * How videos WITH an attribute performed against those WITHOUT.
 *
 * Returns null when either side is too small to mean anything — a comparison
 * needs both halves, and "all 40 of your videos have this" is not evidence that
 * it works, it is evidence that you have never tried the alternative.
 */
export function correlate(
  pool: AuditVideo[],
  label: string,
  value: string,
  has: (v: AuditVideo) => boolean,
): ThumbnailFindings["correlations"][number] | null {
  const withIt = pool.filter(has);
  const without = pool.filter((v) => !has(v));
  if (withIt.length < MIN_SAMPLE || without.length < MIN_SAMPLE) return null;
  return {
    attribute: label,
    value,
    medianMultipleWith: round2(median(withIt.map((v) => v.eraMultiple))),
    medianMultipleWithout: round2(median(without.map((v) => v.eraMultiple))),
    sampleSize: withIt.length,
  };
}

/** Group by title construction and report how each performed. */
export function titlePatternPerformance(
  pool: AuditVideo[],
): { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[] {
  const byPattern = new Map<string, AuditVideo[]>();
  for (const v of pool) {
    const p = v.titleFeatures?.pattern ?? titleFeatures(v.title).pattern;
    if (!byPattern.has(p)) byPattern.set(p, []);
    byPattern.get(p)!.push(v);
  }
  return [...byPattern.entries()]
    .filter(([, vs]) => vs.length >= MIN_SAMPLE)
    .map(([pattern, vs]) => ({
      pattern,
      medianMultiple: round2(median(vs.map((v) => v.eraMultiple))),
      sampleSize: vs.length,
      examples: vs
        .slice()
        .sort((a, b) => b.eraMultiple - a.eraMultiple)
        .slice(0, 3)
        .map((v) => v.title),
    }))
    .sort((a, b) => b.medianMultiple - a.medianMultiple);
}

/** Structural title correlations — length, numbers, brackets, caps. */
export function titleStructureCorrelations(pool: AuditVideo[]): ThumbnailFindings["correlations"] {
  const feat = (v: AuditVideo) => v.titleFeatures ?? titleFeatures(v.title);
  const lengths = pool.map((v) => feat(v).charLength);
  const medLen = median(lengths);
  const out = [
    correlate(pool, "Contains a number", "yes", (v) => feat(v).hasNumber),
    correlate(pool, "Contains brackets", "yes", (v) => feat(v).hasBrackets),
    correlate(pool, "Is a question", "yes", (v) => feat(v).hasQuestion),
    correlate(pool, "Names a year", "yes", (v) => feat(v).hasYear),
    correlate(pool, "Has a SHOUTED word", "yes", (v) => feat(v).isAllCapsWord),
    // Split at this channel's own median length rather than a rule of thumb —
    // "short" means short for them.
    correlate(pool, "Longer than usual", `over ${Math.round(medLen)} chars`, (v) => feat(v).charLength > medLen),
  ];
  return out.filter((c): c is NonNullable<typeof c> => c !== null);
}

/** Thumbnail attribute correlations, from the vision pass. */
export function thumbnailCorrelations(pool: AuditVideo[]): ThumbnailFindings["correlations"] {
  const withThumbs = pool.filter((v) => v.thumbnail);
  const out = [
    correlate(withThumbs, "Face in thumbnail", "any", (v) => (v.thumbnail?.face ?? "none") !== "none"),
    correlate(withThumbs, "Face size", "dominant", (v) => v.thumbnail?.face === "dominant"),
    correlate(withThumbs, "Text on thumbnail", "any", (v) => (v.thumbnail?.textWordCount ?? 0) > 0),
    correlate(withThumbs, "Text amount", "4+ words", (v) => (v.thumbnail?.textWordCount ?? 0) >= 4),
    correlate(withThumbs, "Colour", "vivid", (v) => v.thumbnail?.colourEnergy === "vivid"),
    correlate(withThumbs, "Composition", "clean", (v) => v.thumbnail?.clutter === "clean"),
    correlate(withThumbs, "Composition", "busy", (v) => v.thumbnail?.clutter === "busy"),
  ];
  return out.filter((c): c is NonNullable<typeof c> => c !== null);
}

/**
 * Split pattern performance into what wins and what loses.
 *
 * The cut is at par (1.0) rather than at the middle of the list: half of
 * anything is always "below average", which is arithmetic, not advice.
 */
export function splitWinnersLosers<T extends { medianMultiple: number }>(rows: T[]): { winning: T[]; losing: T[] } {
  return {
    winning: rows.filter((r) => r.medianMultiple >= 1.2),
    losing: rows.filter((r) => r.medianMultiple < 0.8),
  };
}

/**
 * Rank videos by how much a rename could plausibly gain.
 *
 * Under-performance alone is the wrong ranking. A retitle works by changing
 * what a video does in search and suggested, so the gain is bounded by the
 * impressions it still gets: a 2.5-year-old flop in a fast-moving niche is
 * mostly beyond help, while a recent near-miss sits in front of an audience
 * that still exists.
 *
 * DECAY IS EXPONENTIAL, HALF-LIFE ONE YEAR. A linear 1/(1+years) was tried
 * first and is too flat to say what it means — it still gave a 900-day-old
 * video 29% weight, enough for a long-dead 0.3x to outrank a 30-day-old 0.8x.
 * Whether that ordering is right is a product judgement rather than a fact, and
 * this is the judgement: recency wins, because a title change on a video nobody
 * is served any more does nothing.
 */
export function renamePriority(v: AuditVideo, now: number): number {
  if (!v.judged) return 0;
  const shortfall = Math.max(0, 1 - v.eraMultiple); // 0 when at or above par
  const ageYears = (now - v.publishedAt) / (365 * 86_400_000);
  const recency = Math.pow(0.5, ageYears); // 1.0 today, 0.5 at a year, 0.18 at three
  return round2(shortfall * recency * 100);
}

/**
 * Videos whose views look out of step with how people reacted to them.
 *
 * WHAT THIS IS NOT: a paid-views detector. Nobody outside a channel can see its
 * paid/organic split — no public API exposes it at any price — and a tool that
 * says "promoted" from engagement alone is guessing about someone's spending.
 * So this reports exactly what it measures: views far above this channel's norm
 * while likes and comments stayed near or below it.
 *
 * That pattern IS consistent with paid promotion, because ad-served views come
 * from people who did not choose the video. It is equally consistent with a
 * video that got picked up by a broad, casual audience, or one that answered a
 * question so completely that nobody had anything to say. The report labels it
 * "unusual engagement ratio" and leaves the conclusion to the person who knows
 * whether they bought ads.
 *
 * It matters for the audit's integrity regardless of cause: a video with
 * inflated views and flat engagement is weak evidence about packaging, so the
 * caller can keep it out of the outlier set the renamer learns from.
 */
export function engagementAnomalies(
  pool: AuditVideo[],
  { minEraMultiple = 1.5, ratioOfMedian = 0.4 }: { minEraMultiple?: number; ratioOfMedian?: number } = {},
): {
  videoId: string;
  title: string;
  views: number;
  eraMultiple: number;
  engagementRate: number;
  channelMedianRate: number;
  /** How far below the channel's norm this video's engagement sat. */
  shortfall: number;
}[] {
  // Videos with no engagement data at all (comments disabled, likes hidden)
  // cannot be judged either way and must not be counted as suspicious.
  const rated = pool
    .filter((v) => v.views > 0 && (v.likes !== undefined || v.comments !== undefined))
    .map((v) => ({ v, rate: ((v.likes ?? 0) + (v.comments ?? 0)) / v.views }));
  if (rated.length < MIN_SAMPLE) return [];

  const medianRate = median(rated.map((r) => r.rate));
  if (medianRate <= 0) return [];

  return rated
    .filter((r) => r.v.eraMultiple >= minEraMultiple && r.rate <= medianRate * ratioOfMedian)
    .map((r) => ({
      videoId: r.v.videoId,
      title: r.v.title,
      views: r.v.views,
      eraMultiple: round2(r.v.eraMultiple),
      engagementRate: Number(r.rate.toFixed(5)),
      channelMedianRate: Number(medianRate.toFixed(5)),
      shortfall: round2(medianRate > 0 ? 1 - r.rate / medianRate : 0),
    }))
    .sort((a, b) => b.shortfall - a.shortfall);
}

/** Where this channel sits among the scanned set, by two different measures. */
export function marketRanks(
  subject: { channelId: string; subscriberCount: number | null },
  subjectVideos: AuditVideo[],
  competitors: { channel: { channelId: string; subscriberCount: number | null }; videos: AuditVideo[] }[],
): { subscriberRank: number; medianViewsRank: number; competitorCount: number } {
  const medianViewsOf = (vs: AuditVideo[]) => median(evidencePool(vs).map((v) => v.views));

  const all = [
    { id: subject.channelId, subs: subject.subscriberCount ?? 0, medViews: medianViewsOf(subjectVideos) },
    ...competitors.map((c) => ({
      id: c.channel.channelId,
      subs: c.channel.subscriberCount ?? 0,
      medViews: medianViewsOf(c.videos),
    })),
  ];

  const bySubs = [...all].sort((a, b) => b.subs - a.subs);
  const byViews = [...all].sort((a, b) => b.medViews - a.medViews);

  return {
    subscriberRank: bySubs.findIndex((x) => x.id === subject.channelId) + 1,
    medianViewsRank: byViews.findIndex((x) => x.id === subject.channelId) + 1,
    competitorCount: competitors.length,
  };
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Re-export so callers don't need two imports for the common case. */
export type { ScoredVideo };


/**
 * Title-pattern performance across the MARKET's full catalogues.
 *
 * Each competitor video is already scored against its OWN channel's era, so
 * pooling them is legitimate: a 3x is a 3x whether the channel has 20k
 * subscribers or 900k. That is the point — it is what makes the market sample
 * comparable at all, and it is why the audit ingests whole competitor
 * catalogues rather than only their hits.
 */
export function marketTitlePatterns(competitorVideos: AuditVideo[]): {
  winning: ReturnType<typeof titlePatternPerformance>;
  losing: ReturnType<typeof titlePatternPerformance>;
  sampleSize: number;
} | null {
  const pool = competitorVideos
    .filter((v) => v.judged && v.format === "long")
    .map((v) => ({ ...v, titleFeatures: v.titleFeatures ?? titleFeatures(v.title) }));
  // A market smaller than this cannot say anything a single channel could not.
  if (pool.length < 40) return null;
  const rows = titlePatternPerformance(pool);
  const { winning, losing } = splitWinnersLosers(rows);
  return { winning, losing, sampleSize: pool.length };
}

/**
 * What winning thumbnails have in common — yours and the market's together.
 *
 * Deliberately a SHARE, not a correlation. The market's non-outliers never have
 * their thumbnails read, so there is no comparison group on that side; claiming
 * a correlation from winners alone is the survivorship error this whole module
 * exists to avoid. "78% of winners have a dominant face" is a true and useful
 * sentence. "Dominant faces cause wins" is not one we can support.
 */
export function outlierThumbnailProfile(
  outliers: AuditVideo[],
): { attribute: string; value: string; share: number; sampleSize: number }[] {
  const withThumbs = outliers.filter((v) => v.thumbnail);
  if (withThumbs.length < MIN_SAMPLE) return [];
  const n = withThumbs.length;
  const pct = (k: number) => Math.round((k / n) * 100) / 100;
  const count = (f: (v: AuditVideo) => boolean) => withThumbs.filter(f).length;

  return [
    { attribute: "Face", value: "any", share: pct(count((v) => (v.thumbnail?.face ?? "none") !== "none")), sampleSize: n },
    { attribute: "Face", value: "dominant", share: pct(count((v) => v.thumbnail?.face === "dominant")), sampleSize: n },
    { attribute: "Text on thumbnail", value: "any", share: pct(count((v) => (v.thumbnail?.textWordCount ?? 0) > 0)), sampleSize: n },
    { attribute: "Text", value: "3 words or fewer", share: pct(count((v) => (v.thumbnail?.textWordCount ?? 0) > 0 && (v.thumbnail?.textWordCount ?? 0) <= 3)), sampleSize: n },
    { attribute: "Colour", value: "vivid", share: pct(count((v) => v.thumbnail?.colourEnergy === "vivid")), sampleSize: n },
    { attribute: "Composition", value: "clean", share: pct(count((v) => v.thumbnail?.clutter === "clean")), sampleSize: n },
  ];
}
