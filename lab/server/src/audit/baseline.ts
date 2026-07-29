/**
 * Performance baselines for a channel audit — pure, no I/O, unit-tested.
 *
 * The whole audit rests on one judgement: did THIS video do better or worse
 * than it should have? Get the baseline wrong and every downstream conclusion —
 * which titles to copy, which to rewrite, what the thumbnails prove — is drawn
 * from the wrong set of videos.
 *
 * MEASURED ON A REAL CHANNEL (Jake Dawson, 117 long-form, 2024-10 to 2026-07),
 * which is where the design came from rather than from taste:
 *
 *   age of video     n    median views
 *   7-30 days        1        31,392
 *   30-90 days       9        26,441
 *   90-180 days     15        18,137
 *   180-365 days    21         9,215
 *   over a year     69         4,738
 *
 * Views do NOT mature upward with age here — the opposite. The channel grew, so
 * an old video did a fraction of what a new one does regardless of how good it
 * was. Judged against one flat median, 59% of that catalogue reads as
 * "underperforming", which is not a finding, it is an artefact of growth.
 *
 * So a video is judged against ITS OWN ERA: the median of the videos published
 * either side of it. On that channel this changed the verdict for 20 of 114
 * videos (18%). The clearest case scored 2.6x against a flat median and 13.6x
 * against its era — a genuine hit whose neighbours were doing ~1,500 views,
 * which a flat baseline would have buried instead of learned from.
 */

/** Anything with a publish time and a view count can be scored. */
export interface ScorableVideo {
  videoId: string;
  title: string;
  /** Epoch ms. */
  publishedAt: number;
  views: number;
  durationSeconds: number;
}

export interface ScoredVideo extends ScorableVideo {
  /** Median views of the videos published around this one. */
  eraMedian: number;
  /** views ÷ eraMedian. 1.0 is exactly par for its time. */
  eraMultiple: number;
  /** views ÷ the whole-catalogue median — kept only to show how misleading it is. */
  flatMultiple: number;
  /**
   * views ÷ the channel's subscriber count. Null when subscribers are hidden.
   *
   * A SECOND, INDEPENDENT axis, and it answers a different question from the
   * era multiple. Era says "this beat what this channel normally does" — that
   * the packaging worked on its own audience. Views-per-sub says "this reached
   * beyond the audience that already existed" — that it travelled. A video can
   * be strong on one and weak on the other, and the two disagreeing is itself
   * informative: high era + low reach is a video its subscribers loved and
   * nobody else saw.
   *
   * Note it is a CHANNEL-level denominator applied to every video, so it cannot
   * distinguish two videos on the same channel as cleanly as the era multiple
   * can. Its real strength is comparing ACROSS channels of different sizes,
   * which is exactly what the market half of the audit needs.
   */
  viewsPerSub: number | null;
  /** Days since publication at the time of scoring. */
  ageDays: number;
  /**
   * False when the video is too young for its view count to mean anything. It
   * still appears in the report — it is simply not evidence, and never a rename
   * candidate. A video published this morning is not underperforming.
   */
  judged: boolean;
  /** Which pool it was judged in. Shorts and long-form never share a baseline. */
  format: VideoFormat;
}

export type VideoFormat = "short" | "long";

/**
 * YouTube's own Shorts ceiling. Mixing the two formats would wreck both
 * baselines: on the measured channel the long-form median is 8,089 views and
 * the Shorts median is 905, so one pooled median describes neither.
 */
export const SHORTS_MAX_SECONDS = 180;

/**
 * Videos younger than this are shown but not scored.
 *
 * Two weeks is not "views have finished accumulating" — they never really do.
 * It is the point where a view count says more about the video than about how
 * long it has been up. The real 4-hour-old upload that prompted this had 33
 * views against a channel median of 8,089, and calling that a failure would
 * have been the tool's most obviously wrong output.
 */
export const MIN_JUDGEABLE_AGE_DAYS = 14;

/**
 * How many neighbours each side form a video's era.
 *
 * Seven each way (up to 14 peers) is a compromise: wide enough that one freak
 * hit cannot define an era, narrow enough to track a channel that is growing
 * fast. A channel posting weekly gets roughly a three-month window.
 */
export const ERA_WINDOW = 7;

export function formatOf(durationSeconds: number): VideoFormat {
  return durationSeconds > 0 && durationSeconds <= SHORTS_MAX_SECONDS ? "short" : "long";
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Score every video against its own era, within its own format.
 *
 * @param videos any order; they are sorted by publish time internally.
 * @param now epoch ms, injected so tests are not clock-dependent.
 */
export function scoreCatalogue(
  videos: ScorableVideo[],
  now: number,
  opts: { subscriberCount?: number | null } = {},
): ScoredVideo[] {
  const subs = opts.subscriberCount && opts.subscriberCount > 0 ? opts.subscriberCount : null;
  const out: ScoredVideo[] = [];

  for (const format of ["long", "short"] as const) {
    const pool = videos
      .filter((v) => formatOf(v.durationSeconds) === format)
      .sort((a, b) => a.publishedAt - b.publishedAt);
    if (!pool.length) continue;

    const flatMedian = median(pool.map((v) => v.views));

    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      // The video's own views are excluded from its baseline — otherwise every
      // video is partly measured against itself, which drags every multiple
      // toward 1.0 and is worst exactly where the sample is smallest.
      const peers = [
        ...pool.slice(Math.max(0, i - ERA_WINDOW), i),
        ...pool.slice(i + 1, i + 1 + ERA_WINDOW),
      ].map((p) => p.views);
      // A channel with too few videos to form an era falls back to the flat
      // median: less accurate, but defined, and the caller can see the pool size.
      const eraMedian = median(peers) || flatMedian;
      const ageDays = (now - v.publishedAt) / 86_400_000;

      out.push({
        ...v,
        format,
        eraMedian,
        eraMultiple: eraMedian > 0 ? v.views / eraMedian : 0,
        flatMultiple: flatMedian > 0 ? v.views / flatMedian : 0,
        viewsPerSub: subs ? v.views / subs : null,
        ageDays,
        judged: ageDays >= MIN_JUDGEABLE_AGE_DAYS,
      });
    }
  }

  return out.sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * The videos worth learning from: judged, in this format, and well above par.
 *
 * These are what a rename is modelled on, so the bar is deliberately high — a
 * video that merely did fine teaches nothing about why anything won.
 */
export function outliers<T extends ScoredVideo>(scored: T[], format: VideoFormat, minMultiple = 2): T[] {
  return scored
    .filter((v) => v.judged && v.format === format && v.eraMultiple >= minMultiple)
    .sort((a, b) => b.eraMultiple - a.eraMultiple);
}

/**
 * The videos with the most to gain from repackaging, worst first.
 *
 * Ranked by era multiple rather than raw views on purpose: an old video with
 * 400 views that its neighbours beat ten times over is a far better rename
 * candidate than a recent one with 5,000 that merely did par.
 */
export function underperformers<T extends ScoredVideo>(
  scored: T[],
  format: VideoFormat,
  maxMultiple = 1,
): T[] {
  return scored
    .filter((v) => v.judged && v.format === format && v.eraMultiple < maxMultiple)
    .sort((a, b) => a.eraMultiple - b.eraMultiple);
}

/**
 * Videos that travelled furthest beyond the channel's own audience.
 *
 * The other outlier axis. Ranked by views-per-subscriber rather than by era
 * multiple, so it surfaces the videos that reached NEW people rather than the
 * ones that merely did well with the existing audience. Across channels of
 * different sizes this is the comparable measure — a 5,000-view video on a
 * 500-subscriber channel outreached a 50,000-view video on a 100,000-sub one.
 */
export function reachOutliers<T extends ScoredVideo>(
  scored: T[],
  format: VideoFormat,
  minRatio = 1,
): T[] {
  return scored
    .filter((v) => v.judged && v.format === format && v.viewsPerSub !== null && v.viewsPerSub >= minRatio)
    .sort((a, b) => (b.viewsPerSub ?? 0) - (a.viewsPerSub ?? 0));
}

/** Median views per age bucket — the evidence that a flat baseline is wrong. */
export function ageCurve(
  scored: ScoredVideo[],
  format: VideoFormat,
  buckets: [number, number][] = [
    [0, 7],
    [7, 30],
    [30, 90],
    [90, 180],
    [180, 365],
    [365, Number.POSITIVE_INFINITY],
  ],
): { fromDays: number; toDays: number; count: number; medianViews: number }[] {
  const pool = scored.filter((v) => v.format === format);
  return buckets.map(([fromDays, toDays]) => {
    const b = pool.filter((v) => v.ageDays >= fromDays && v.ageDays < toDays);
    return { fromDays, toDays, count: b.length, medianViews: median(b.map((v) => v.views)) };
  });
}
