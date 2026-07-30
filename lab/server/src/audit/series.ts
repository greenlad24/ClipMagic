/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SERIES — turning a question into numbers the model did not make up.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A custom report section is written by a model, and every chart in it has to
 * carry figures. The obvious way to build that is to let the model emit the
 * chart data along with the prose. That way is wrong, and wrong in the exact
 * way this whole tool was built to avoid: a fabricated bar looks identical to a
 * measured one, and it is the measured ones that earn the report its authority.
 *
 * So the split is: THE MODEL CHOOSES THE QUESTION, THE SERVER COMPUTES THE
 * ANSWER. A chart spec names a population, a way of grouping it and a thing to
 * measure. Everything numeric comes out of this file, from the run's own data,
 * by plain arithmetic. There is no path by which a number reaches a chart
 * without having been computed here.
 *
 * Three rules follow from that, and they are the reason this file is pure:
 *
 *   • EVERY GROUP CARRIES ITS SAMPLE SIZE. A 3.4x median over two videos and
 *     one over forty are not the same claim, and a bar chart flattens them into
 *     the same bar unless n travels with the value.
 *   • DROPPED GROUPS ARE REPORTED, NEVER SILENT. A group under the sample floor
 *     is removed from the chart and listed in `dropped`, because a chart that
 *     quietly omits half its categories reads as complete.
 *   • JUDGED-ONLY BY DEFAULT. A video published this morning has no meaningful
 *     view count (see MIN_JUDGEABLE_AGE_DAYS). It is not evidence and must not
 *     move a median.
 */
import { formatOf, median, type VideoFormat } from "./baseline.js";
import type { AuditChannel, AuditVideo } from "./types.js";

/** How a population is cut up. */
export const SERIES_DIMENSIONS = [
  "topic",
  "titlePattern",
  "titleLength",
  "thumbnailFace",
  "thumbnailColour",
  "thumbnailClutter",
  "thumbnailText",
  "ageBand",
  "publishMonth",
  "channel",
  "format",
  "durationBand",
  "video",
] as const;
export type SeriesDimension = (typeof SERIES_DIMENSIONS)[number];

/** What gets measured per group. */
export const SERIES_MEASURES = [
  "medianEraMultiple",
  "medianViews",
  "totalViews",
  "videoCount",
  "medianViewsPerSub",
  "medianEngagementRate",
  "shareOfVideos",
] as const;
export type SeriesMeasure = (typeof SERIES_MEASURES)[number];

/**
 * Which population. `compare` puts the channel and the market side by side on
 * the SAME measure — two series, one axis. Never two measures on two axes: a
 * dual axis can be made to show any relationship you like by choosing scales.
 */
export const SERIES_SCOPES = ["own", "market", "compare"] as const;
export type SeriesScope = (typeof SERIES_SCOPES)[number];

export interface SeriesFilter {
  format?: VideoFormat | null;
  /** Default true. Only videos old enough for their views to mean something. */
  judgedOnly?: boolean;
  /** Only videos published within this many days. */
  sinceDays?: number | null;
  /** Only these topic labels, as named in the report. */
  topics?: string[] | null;
}

export interface AuditSeriesQuery {
  scope: SeriesScope;
  groupBy: SeriesDimension;
  measure: SeriesMeasure;
  filter?: SeriesFilter;
  /** Keep at most this many groups, largest measure first. Default 12. */
  limit?: number;
  /** Groups smaller than this are dropped and listed. Default 3 (1 for `video`). */
  minSampleSize?: number;
}

export interface SeriesPoint {
  label: string;
  value: number;
  /** Videos behind `value`. */
  n: number;
  /** The market's figure on the same measure — `compare` scope only. */
  secondary?: number;
  nSecondary?: number;
}

export interface AuditChartData {
  points: SeriesPoint[];
  /** Axis label for the measure, e.g. "Median views ÷ era median". */
  measureLabel: string;
  /** Axis label for the grouping, e.g. "Topic". */
  groupLabel: string;
  /** Series names, in point order: [own] or [own, market]. */
  seriesLabels: string[];
  /** Groups removed for being under the sample floor. Stated, never silent. */
  dropped: { label: string; n: number }[];
  /** Plain-language note on exactly what was counted. Rendered under the chart. */
  note: string;
  /** True when 1.0 is a real midpoint for this measure (era multiples). */
  parAtOne: boolean;
  /** Set when the query could not be answered from the data on this run. */
  unavailable?: string;
}

export interface SeriesContext {
  subject: AuditChannel | null;
  videos: AuditVideo[];
  marketVideos: AuditVideo[];
  competitors: AuditChannel[];
  topics: { topic: string; videoIds?: string[]; marketVideoIds?: string[] }[];
  now?: number;
}

const DIMENSION_LABEL: Record<SeriesDimension, string> = {
  topic: "Topic",
  titlePattern: "Title pattern",
  titleLength: "Title length",
  thumbnailFace: "Face in thumbnail",
  thumbnailColour: "Thumbnail colour energy",
  thumbnailClutter: "Thumbnail clutter",
  thumbnailText: "Text on thumbnail",
  ageBand: "Age",
  publishMonth: "Published",
  channel: "Channel",
  format: "Format",
  durationBand: "Length",
  video: "Video",
};

const MEASURE_LABEL: Record<SeriesMeasure, string> = {
  medianEraMultiple: "Median views ÷ era median",
  medianViews: "Median views",
  totalViews: "Total views",
  videoCount: "Videos",
  medianViewsPerSub: "Median views ÷ subscribers",
  medianEngagementRate: "Median (likes + comments) ÷ views, %",
  shareOfVideos: "Share of videos, %",
};

/**
 * Dimensions with a natural order. Sorting these by value would be actively
 * misleading — an age curve reordered by size is no longer a curve.
 */
const ORDINAL: ReadonlySet<SeriesDimension> = new Set([
  "ageBand",
  "publishMonth",
  "titleLength",
  "durationBand",
]);

const AGE_BANDS: { label: string; to: number }[] = [
  { label: "0–7d", to: 7 },
  { label: "7–30d", to: 30 },
  { label: "30–90d", to: 90 },
  { label: "90–180d", to: 180 },
  { label: "180–365d", to: 365 },
  { label: "365d+", to: Infinity },
];

const DURATION_BANDS: { label: string; to: number }[] = [
  { label: "under 3m", to: 180 },
  { label: "3–8m", to: 480 },
  { label: "8–15m", to: 900 },
  { label: "15–30m", to: 1800 },
  { label: "30m+", to: Infinity },
];

const TITLE_LENGTH_BANDS: { label: string; to: number }[] = [
  { label: "under 40 chars", to: 40 },
  { label: "40–55", to: 55 },
  { label: "55–70", to: 70 },
  { label: "70+", to: Infinity },
];

function band(bands: { label: string; to: number }[], value: number): string {
  for (const b of bands) if (value < b.to) return b.label;
  return bands[bands.length - 1].label;
}

const ordinalIndex = (dim: SeriesDimension, label: string): number => {
  if (dim === "ageBand") return AGE_BANDS.findIndex((b) => b.label === label);
  if (dim === "durationBand") return DURATION_BANDS.findIndex((b) => b.label === label);
  if (dim === "titleLength") return TITLE_LENGTH_BANDS.findIndex((b) => b.label === label);
  return 0; // publishMonth sorts lexically, which is chronological for YYYY-MM
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Which group a video falls in, or null when this video can't answer. */
function groupOf(
  v: AuditVideo,
  dim: SeriesDimension,
  ctx: SeriesContext,
  topicOf: Map<string, string>,
  channelNames: Map<string, string>,
  now: number,
): string | null {
  switch (dim) {
    case "topic":
      return topicOf.get(v.videoId) ?? null;
    case "titlePattern":
      return v.titleFeatures?.pattern ?? null;
    case "titleLength":
      return band(TITLE_LENGTH_BANDS, v.titleFeatures?.charLength ?? v.title.length);
    // A thumbnail the vision pass never read is ABSENT, not "none". Returning a
    // value here would fold unread images into the no-face bucket and quietly
    // bias every thumbnail correlation toward whatever the gaps happened to be.
    case "thumbnailFace":
      return v.thumbnail ? v.thumbnail.face : null;
    case "thumbnailColour":
      return v.thumbnail ? v.thumbnail.colourEnergy : null;
    case "thumbnailClutter":
      return v.thumbnail ? v.thumbnail.clutter : null;
    case "thumbnailText":
      return v.thumbnail ? (v.thumbnail.textWordCount > 0 ? "has text" : "no text") : null;
    case "ageBand":
      return band(AGE_BANDS, Math.max(0, (now - v.publishedAt) / 86_400_000));
    case "publishMonth":
      return new Date(v.publishedAt).toISOString().slice(0, 7);
    case "channel":
      return channelNames.get(v.channelId) ?? v.channelId;
    case "format":
      return formatOf(v.durationSeconds) === "short" ? "Shorts" : "Long-form";
    case "durationBand":
      return band(DURATION_BANDS, v.durationSeconds);
    case "video":
      return clip(v.title, 48);
  }
}

/** The measure over one group, or null when the data can't support it. */
function measureOf(vs: AuditVideo[], measure: SeriesMeasure, populationSize: number): number | null {
  if (!vs.length) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  switch (measure) {
    case "medianEraMultiple":
      return round(median(vs.map((v) => v.eraMultiple)));
    case "medianViews":
      return Math.round(median(vs.map((v) => v.views)));
    case "totalViews":
      return vs.reduce((s, v) => s + v.views, 0);
    case "videoCount":
      return vs.length;
    case "medianViewsPerSub": {
      // Hidden subscriber counts make this null per video; a group with none is
      // unanswerable rather than zero.
      const xs = vs.map((v) => v.viewsPerSub).filter((x): x is number => typeof x === "number");
      return xs.length ? round(median(xs)) : null;
    }
    case "medianEngagementRate": {
      const xs = vs
        .filter((v) => v.views > 0 && (typeof v.likes === "number" || typeof v.comments === "number"))
        .map((v) => (((v.likes ?? 0) + (v.comments ?? 0)) / v.views) * 100);
      return xs.length ? round(median(xs)) : null;
    }
    case "shareOfVideos":
      return populationSize ? round((vs.length / populationSize) * 100) : null;
  }
}

function applyFilter(
  vs: AuditVideo[],
  filter: SeriesFilter | undefined,
  topicOf: Map<string, string>,
  now: number,
): AuditVideo[] {
  const judgedOnly = filter?.judgedOnly !== false;
  return vs.filter((v) => {
    if (judgedOnly && !v.judged) return false;
    if (filter?.format && formatOf(v.durationSeconds) !== filter.format) return false;
    if (filter?.sinceDays && filter.sinceDays > 0) {
      if ((now - v.publishedAt) / 86_400_000 > filter.sinceDays) return false;
    }
    if (filter?.topics?.length) {
      const t = topicOf.get(v.videoId);
      if (!t || !filter.topics.includes(t)) return false;
    }
    return true;
  });
}

/**
 * Compute one chart's numbers.
 *
 * Never throws and never returns a partially-true chart: a query the run's data
 * cannot answer comes back with `unavailable` set and no points, so the caller
 * can drop the chart and say why rather than render an empty axis.
 */
export function buildSeries(query: AuditSeriesQuery, ctx: SeriesContext): AuditChartData {
  const now = ctx.now ?? Date.now();
  const dim = query.groupBy;
  const measure = query.measure;
  const limit = Math.max(1, Math.min(30, query.limit ?? 12));
  const floor = Math.max(1, query.minSampleSize ?? (dim === "video" ? 1 : 3));

  const topicOf = new Map<string, string>();
  const marketTopicOf = new Map<string, string>();
  for (const t of ctx.topics ?? []) {
    for (const id of t.videoIds ?? []) topicOf.set(id, t.topic);
    for (const id of t.marketVideoIds ?? []) marketTopicOf.set(id, t.topic);
  }
  const channelNames = new Map<string, string>();
  for (const c of ctx.competitors ?? []) channelNames.set(c.channelId, c.title);
  if (ctx.subject) channelNames.set(ctx.subject.channelId, ctx.subject.title);

  const base: AuditChartData = {
    points: [],
    measureLabel: MEASURE_LABEL[measure],
    groupLabel: DIMENSION_LABEL[dim],
    seriesLabels: query.scope === "compare" ? ["This channel", "The market"] : [query.scope === "market" ? "The market" : "This channel"],
    dropped: [],
    note: "",
    parAtOne: measure === "medianEraMultiple",
  };

  // `channel` over the channel's own catalogue is a single bar of itself. It is
  // a market question, so it is answered as one rather than drawn as one bar.
  if (dim === "channel" && query.scope === "own") {
    return { ...base, unavailable: "Grouping by channel only means something across the market, not within one channel." };
  }

  // ── the outlier trap ──────────────────────────────────────────────────────
  // The market set is not a sample of the market. It is the market's
  // OVER-PERFORMERS — competitor videos kept only when they beat their own
  // channel's norm by 1.5x or more. That selection is fine for "what does good
  // look like over there", and fatal for the era multiple specifically: the
  // median era multiple of a set filtered to era multiple >= 1.5 is >= 1.5 no
  // matter what anyone published. It measures the filter, not the channels.
  //
  // This is not a caveat that can be written under the chart. Left available,
  // it produced a real section reading "competitors sit at 6.57 against your
  // 0.94" — a confident, wrong, entirely artefactual finding. So the query is
  // refused and the alternative is named.
  if (measure === "medianEraMultiple" && (query.scope === "market" || query.scope === "compare")) {
    return {
      ...base,
      unavailable:
        "The era multiple cannot be compared against the market. Only the market's over-performers were kept as " +
        "evidence (videos beating their own channel's norm by 1.5x or more), so their median era multiple is high " +
        "by definition and says nothing about them. Compare on median views instead, or measure the era multiple " +
        "on this channel alone.",
    };
  }

  const own = applyFilter(ctx.videos ?? [], query.filter, topicOf, now);
  const market = applyFilter(ctx.marketVideos ?? [], query.filter, marketTopicOf, now);

  const wantOwn = query.scope === "own" || query.scope === "compare";
  const wantMarket = query.scope === "market" || query.scope === "compare";

  if (wantOwn && !own.length && !wantMarket) {
    return { ...base, unavailable: "No videos on this channel match that filter." };
  }
  if (wantMarket && !market.length && !wantOwn) {
    return { ...base, unavailable: "No market videos match that filter." };
  }

  const bucket = (vs: AuditVideo[], topics: Map<string, string>) => {
    const groups = new Map<string, AuditVideo[]>();
    for (const v of vs) {
      const g = groupOf(v, dim, ctx, topics, channelNames, now);
      if (g === null) continue;
      const list = groups.get(g);
      if (list) list.push(v);
      else groups.set(g, [v]);
    }
    return groups;
  };

  const ownGroups = wantOwn ? bucket(own, topicOf) : new Map<string, AuditVideo[]>();
  const marketGroups = wantMarket ? bucket(market, marketTopicOf) : new Map<string, AuditVideo[]>();

  const labels = new Set<string>([...ownGroups.keys(), ...marketGroups.keys()]);
  if (!labels.size) {
    return {
      ...base,
      unavailable:
        dim.startsWith("thumbnail")
          ? "No thumbnails on this run have been read by the vision pass, so there is nothing to group by."
          : dim === "topic"
            ? "This run has no topic membership recorded, so videos cannot be grouped by topic."
            : "Nothing in this run can be grouped that way.",
    };
  }

  // The denominator for `shareOfVideos` is the whole filtered population, so a
  // share is a share of everything rather than of the groups that survived.
  const ownTotal = own.length;
  const marketTotal = market.length;

  const dropped: { label: string; n: number }[] = [];
  const points: SeriesPoint[] = [];

  for (const label of labels) {
    const o = ownGroups.get(label) ?? [];
    const m = marketGroups.get(label) ?? [];
    // The sample floor applies to whichever side the chart is actually about.
    const primaryN = query.scope === "market" ? m.length : o.length;
    if (primaryN < floor) {
      dropped.push({ label, n: primaryN });
      continue;
    }
    const primary = measureOf(query.scope === "market" ? m : o, measure, query.scope === "market" ? marketTotal : ownTotal);
    if (primary === null) {
      dropped.push({ label, n: primaryN });
      continue;
    }
    const point: SeriesPoint = { label, value: primary, n: primaryN };
    if (query.scope === "compare") {
      const sec = measureOf(m, measure, marketTotal);
      if (sec !== null) {
        point.secondary = sec;
        point.nSecondary = m.length;
      }
    }
    points.push(point);
  }

  if (!points.length) {
    return {
      ...base,
      dropped: dropped.sort((a, b) => b.n - a.n),
      unavailable: `Every group had fewer than ${floor} videos behind it, which is too few to chart honestly.`,
    };
  }

  if (ORDINAL.has(dim)) {
    points.sort((a, b) =>
      dim === "publishMonth" ? a.label.localeCompare(b.label) : ordinalIndex(dim, a.label) - ordinalIndex(dim, b.label),
    );
  } else {
    points.sort((a, b) => b.value - a.value);
  }

  const kept = points.slice(0, limit);
  const overflow = points.length - kept.length;

  const population =
    query.scope === "compare"
      ? `${ownTotal} of this channel's videos and ${marketTotal} market videos`
      : query.scope === "market"
        ? `${marketTotal} market videos`
        : `${ownTotal} of this channel's videos`;
  const filterBits: string[] = [];
  if (query.filter?.format) filterBits.push(query.filter.format === "short" ? "Shorts only" : "long-form only");
  if (query.filter?.judgedOnly !== false) filterBits.push("old enough to judge");
  if (query.filter?.sinceDays) filterBits.push(`published in the last ${query.filter.sinceDays} days`);
  if (query.filter?.topics?.length) filterBits.push(`topics: ${query.filter.topics.join(", ")}`);

  const noteBits = [
    `${MEASURE_LABEL[measure].toLowerCase()} by ${DIMENSION_LABEL[dim].toLowerCase()}, over ${population}` +
      `${filterBits.length ? ` (${filterBits.join("; ")})` : ""}.`,
    // Any figure drawn from the market is drawn from its best work only. Said
    // every time, because a reader comparing two bars will not otherwise know
    // the two bars were selected on different terms.
    query.scope === "market" || query.scope === "compare"
      ? "The market figures cover competitors' over-performers only — the audit keeps their best videos as evidence, not their whole catalogues — so read them as what good looks like there, not as their average."
      : "",
    `Groups with fewer than ${floor} video${floor === 1 ? "" : "s"} are not shown.`,
    dropped.length ? `${dropped.length} group${dropped.length === 1 ? "" : "s"} dropped on that floor: ${dropped.slice(0, 6).map((d) => `${d.label} (${d.n})`).join(", ")}${dropped.length > 6 ? "…" : ""}.` : "",
    overflow > 0 ? `${overflow} further group${overflow === 1 ? "" : "s"} below the top ${limit} are not shown.` : "",
  ].filter(Boolean);

  return {
    ...base,
    points: kept,
    dropped: dropped.sort((a, b) => b.n - a.n),
    note: noteBits.join(" "),
  };
}

/**
 * The chart form follows the data, not the model's taste.
 *
 * Deliberately not a decision the model gets to make. Form is a function of
 * what is being shown — an ordinal axis is a line, a measure with a real
 * midpoint diverges around it, two populations on one measure are grouped bars
 * — so deriving it here means a section can never come back with a pie chart of
 * medians because a prompt drifted.
 */
export type ChartForm = "bars" | "grouped" | "diverging" | "line";

export function formFor(query: AuditSeriesQuery, data: AuditChartData): ChartForm {
  if (ORDINAL.has(query.groupBy)) return "line";
  if (query.scope === "compare" && data.points.some((p) => typeof p.secondary === "number")) return "grouped";
  if (data.parAtOne) return "diverging";
  return "bars";
}

/**
 * A plain-language inventory of what this run can actually be asked about.
 *
 * Handed to the model before it designs a section, so it queries what exists
 * rather than what it hopes exists — the difference between a chart and an
 * apology. Cheap to produce and small enough to send every time.
 */
export function describeAvailableData(ctx: SeriesContext): string {
  const own = ctx.videos ?? [];
  const market = ctx.marketVideos ?? [];
  const judged = own.filter((v) => v.judged);
  const withThumbs = own.filter((v) => v.thumbnail).length;
  const marketThumbs = market.filter((v) => v.thumbnail).length;
  const withEngagement = own.filter((v) => typeof v.likes === "number" || typeof v.comments === "number").length;
  const withPaid = own.filter((v) => typeof v.paidViews === "number").length;
  const renamed = own.filter((v) => v.rename).length;
  const topics = (ctx.topics ?? []).filter((t) => (t.videoIds?.length ?? 0) > 0);
  const patterns = [...new Set(own.map((v) => v.titleFeatures?.pattern).filter(Boolean))] as string[];

  const lines = [
    `THIS CHANNEL: ${own.length} videos (${judged.length} old enough to judge, ${own.filter((v) => formatOf(v.durationSeconds) === "short").length} Shorts).`,
    `THE MARKET: ${market.length} competitor videos kept as evidence, across ${(ctx.competitors ?? []).length} channels.`,
    `THUMBNAILS READ: ${withThumbs}/${own.length} of this channel's, ${marketThumbs}/${market.length} of the market's.`,
    `LIKES + COMMENTS: on ${withEngagement}/${own.length} of this channel's videos.`,
    withPaid ? `PAID-VIEW SPLIT: on ${withPaid} videos (this channel only).` : `PAID-VIEW SPLIT: not available.`,
    renamed ? `PROPOSED RENAMES: ${renamed} videos.` : `PROPOSED RENAMES: none on this run.`,
    topics.length
      ? `TOPICS (with real membership): ${topics.map((t) => `${t.topic} (${t.videoIds?.length ?? 0})`).join(", ")}`
      : `TOPICS: none with recorded membership on this run — do not group by topic.`,
    patterns.length ? `TITLE PATTERNS SEEN: ${patterns.join(", ")}` : `TITLE PATTERNS: none recorded.`,
  ];
  return lines.join("\n");
}
