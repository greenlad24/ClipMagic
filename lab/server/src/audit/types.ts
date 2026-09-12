/**
 * Shared contract for the Channel Audit LAB tool.
 *
 * Point it at a channel and it returns: what niche it is really in, who it is
 * actually competing with, what its titles and thumbnails have in common, where
 * it sits in that market, what it could grow into, and a proposed new title for
 * every video — each backed by a real outlier from the market rather than
 * taste.
 *
 * Two modes, one pipeline. `own` is written for the person who can act on it
 * (renames, growth areas). `teardown` points the same machinery at someone
 * else's channel and reads as a diagnosis instead.
 *
 * The run has a DELIBERATE PAUSE in the middle: the niche and competitor set
 * are proposed, and nothing expensive happens until they are approved. If the
 * tool has misread the market, everything downstream is built on the wrong
 * comparison set, and the cheapest possible moment to catch that is before the
 * scan rather than in the finished report.
 */
import type { ScoredVideo } from "./baseline.ts";
import type { AuditChartData, AuditSeriesQuery } from "./series.ts";

export type { AuditChartData, AuditSeriesQuery };

export type AuditMode = "own" | "teardown";

export type AuditStatus =
  | "ingesting" // channel + catalogue + view stats
  | "proposing" // inferring the niche and a competitor set
  | "awaiting-approval" // PAUSED — waiting for the operator to confirm the market
  | "scanning" // competitor catalogues
  | "analysing" // titles, thumbnails, content, market position
  | "renaming" // a proposed title per video
  | "completed"
  | "failed";

/**
 * A stage of the pipeline, for recording what a run could not do.
 *
 * Only `ingest` is fatal — see audit/recovery.ts, which owns what each stage
 * costs the report when it is missing.
 */
export type AuditStage =
  | "ingest"
  | "market"
  | "thumbnails"
  | "content"
  | "topics"
  | "renames"
  | "report"
  | "plan";

/**
 * A stage the run skipped, and what the report loses without it.
 *
 * Recorded whether the pipeline decided by itself (`automatic`) or the operator
 * pressed Skip. Kept on the run and shown on the report, because a section that
 * is absent because nothing could be gathered must never be mistaken for a
 * section that had nothing to report.
 */
export interface AuditGap {
  stage: AuditStage;
  /** Human name for the stage, e.g. "The competitor market". */
  label: string;
  /** Why it could not run — the error, in the words the operator will see. */
  reason: string;
  /** What the report loses. Written for the operator, and given to the model. */
  consequence: string;
  /** False when the operator pressed Skip themselves. */
  automatic: boolean;
  at: number;
}

export interface AuditInput {
  /** Channel URL, @handle or raw channel id. */
  channel: string;
  mode: AuditMode;
  /**
   * The creator's own framing, given BEFORE the run: what the channel is about
   * now, what they are trying to build. A catalogue is a history, so a channel
   * that has changed direction will otherwise be analysed as the channel it
   * used to be — and only its owner knows that. Feeds the market inference, the
   * topic clustering, the report and the action plan.
   */
  angle?: string;
  /** Human label for the run; defaults to the channel title. */
  title?: string;
  /**
   * Skip the approval pause and scan whatever was proposed. For re-runs of a
   * channel whose market is already settled — never the default, because an
   * unattended wrong market silently wastes the day's quota.
   */
  autoApprove?: boolean;
  /**
   * Run against a SAVED market instead of discovering one.
   *
   * A market is a named set of competitors, not a property of a channel: the
   * same channel can be audited against "AI automation" and against "AI tool
   * reviews" and get different answers, which is the point. Reusing one skips
   * the search (~600 quota units) and the approval step, and makes two runs
   * strictly comparable because the comparison set did not move.
   */
  marketId?: string;
}

/** A named, reusable set of competitors. */
export interface SavedMarket {
  id: string;
  name: string;
  niche: string;
  nicheDescription?: string;
  audience?: string;
  competitors: ProposedCompetitor[];
  /** The channel it was first discovered from — provenance, not ownership. */
  discoveredFrom?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A channel as the audit sees it — the subject or a competitor. */
export interface AuditChannel {
  channelId: string;
  handle: string | null;
  title: string;
  description?: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  thumbnailUrl?: string | null;
}

/** One video with its scoring, plus whatever the analysis passes attached. */
export interface AuditVideo extends ScoredVideo {
  channelId: string;
  thumbnailUrl: string;
  likes?: number;
  comments?: number;
  /**
   * Views that came from advertising, per YouTube Analytics. Only ever present
   * for the ONE channel that granted consent — no public API exposes anyone
   * else's split, so a teardown never has this.
   */
  paidViews?: number;
  /** views - paidViews. This is what the scoring uses when it is known. */
  organicViews?: number;
  /** Present once the thumbnail pass has run. */
  thumbnail?: ThumbnailAttributes;
  /** Present once the title pass has run. */
  titleFeatures?: TitleFeatures;
  /** Present once the renaming pass has run — `own` mode only. */
  rename?: RenameProposal;
}

/**
 * What a thumbnail actually contains, read by a vision model.
 *
 * Extracted per image by a CHEAP model: this is looking, not thinking. The
 * expensive reasoning happens later, over the correlation between these
 * attributes and views — which is plain arithmetic on top of these fields.
 * Keeping the two apart is what makes vision-on-every-thumbnail affordable.
 */
export interface ThumbnailAttributes {
  /** Is there a human face, and how large in frame. */
  face: "none" | "small" | "medium" | "dominant";
  /** The expression being sold, if a face is present. */
  expression: string | null;
  /** Words burned into the image. 0 when there is no text. */
  textWordCount: number;
  /** The largest text as read, for spotting recurring hooks. */
  textContent: string | null;
  /** Loud/saturated versus muted. */
  colourEnergy: "muted" | "moderate" | "vivid";
  /** How much is going on: a clean subject or a collage. */
  clutter: "clean" | "moderate" | "busy";
  /** Product UI, a person, an object, an abstract graphic… */
  subject: string;
  /** Anything else the model thought was doing the work. */
  notes?: string;
}

/** Structural facts about a title — measured, not judged. */
export interface TitleFeatures {
  charLength: number;
  wordCount: number;
  hasNumber: boolean;
  hasBrackets: boolean;
  hasQuestion: boolean;
  hasYear: boolean;
  isAllCapsWord: boolean;
  /** Leading construction: "How to", "I tried", "N things"… */
  pattern: string;
}

/** A proposed new title, and the evidence for it. */
export interface RenameProposal {
  proposed: string;
  /** Why this beats the current title, in one line. */
  rationale: string;
  /** The market outlier it is modelled on. */
  modelledOn?: { videoId: string; title: string; channelTitle: string; eraMultiple: number } | null;
  /** Keywords it targets, with volume when a paid source could supply it. */
  keywords: { text: string; searchVolume: number | null }[];
  /** How much of a change this is — a nudge or a rewrite. */
  changeLevel: "minor" | "moderate" | "rewrite";
  /** Higher means more to gain: worse performance, weaker title, better idea. */
  priority: number;
}

/** The niche and competitor set, as proposed and then as approved. */
export interface MarketProposal {
  niche: string;
  nicheDescription: string;
  /**
   * Set when this market did not come from a discovery — when search quota was
   * gone and a saved market was substituted instead. Shown on the approval
   * panel, because a substituted comparison set is the one thing in a report
   * the operator should always look at before it is spent against.
   */
  substitutionNote?: string;
  /** What this channel is actually about, in the tool's words — check this first. */
  subjectSummary: string;
  audience: string;
  competitors: ProposedCompetitor[];
}

export interface ProposedCompetitor {
  /** Channel id when resolved; a handle or search term when not yet. */
  channelId: string | null;
  handle: string | null;
  title: string;
  /** Why the AI thinks this is a real competitor. */
  reason: string;
  subscriberCount?: number | null;
  /** Set false to exclude it from the scan without deleting the suggestion. */
  include: boolean;
  /** True when the operator added it by hand. */
  addedByUser?: boolean;
}

/** What the analysis passes concluded. Every field is evidence-backed. */
export interface AuditFindings {
  /** Median views by age bucket — the growth shape of the channel. */
  ageCurve: { fromDays: number; toDays: number; count: number; medianViews: number }[];
  titles: TitleFindings;
  thumbnails: ThumbnailFindings;
  content: ContentFindings;
  /**
   * What the market's best videos DO, from their transcripts, and what their
   * viewers said, from their comments. Titles and thumbnails explain the click;
   * this is the only part of the audit that looks at why anyone stays.
   */
  contentPatterns?: {
    hookTypes: { type: string; count: number; share: number; examples: string[] }[];
    payoff: { at: string; count: number }[];
    /** What commenters wanted and did not get — direct video ideas. */
    viewerAsks: string[];
    praised: string[];
    sampleSize: number;
    verdict: string;
  } | null;
  position: MarketPosition;
  growth: GrowthArea[];
  /**
   * How to become the best channel in each category — the part someone acts on.
   * Written last, over every measurement, and required to cite them: a plan
   * that could have been written without the audit is worse than none.
   */
  actionPlan?: {
    categories: {
      name: string;
      standing: string;
      target: string;
      titleFormulas: string[];
      thumbnails: string[];
      topics: string[];
      firstThree: string[];
    }[];
    ninetyDays: string[];
    stopDoing: string[];
  } | null;
  /** Written last, over everything above. */
  summary: string;
}

export interface TitleFindings {
  /** Patterns that over-perform, with the evidence. */
  winning: { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[];
  losing: { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[];
  /**
   * The same analysis across the COMPETITORS' full catalogues.
   *
   * One channel of 117 videos is a thin base for a title formula — several
   * patterns never reach a reportable sample at all. Seven competitor
   * catalogues are thousands of videos, each scored against its own channel's
   * era, so a construction that wins across the market is evidence of a
   * different order from one that wins across a single channel.
   */
  market: {
    winning: { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[];
    losing: { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[];
    /** How many competitor videos the market analysis is drawn from. */
    sampleSize: number;
  } | null;
  /** Prose, grounded in the above. */
  verdict: string;
}

export interface ThumbnailFindings {
  /**
   * What the OUTLIERS look like — yours and the market's, pooled.
   *
   * A correlation needs both halves, and thumbnails are only read for the
   * subject's catalogue plus the market's over-performers, so there is no
   * "without" group on the market side. This is therefore a profile, not a
   * correlation: the share of winning thumbnails carrying each attribute. It
   * says what winners look like, not that the attribute caused the win — and it
   * is labelled that way wherever it is shown.
   */
  outlierProfile: { attribute: string; value: string; share: number; sampleSize: number }[];
  /** Attribute → how videos with it performed, against those without. */
  correlations: {
    attribute: string;
    value: string;
    medianMultipleWith: number;
    medianMultipleWithout: number;
    sampleSize: number;
  }[];
  verdict: string;
}

export interface ContentFindings {
  /**
   * Topic clusters found across the catalogue and how each performs.
   *
   * `videoIds` is the real membership and must be kept. It was omitted at first,
   * leaving `examples` — three titles — as the only record of which videos were
   * in a topic. A refocus by topic then reconstructed membership from those
   * three, so filtering to four topics kept twelve videos out of 127 and every
   * pattern table came back empty for want of a sample.
   */
  topics: {
    topic: string;
    count: number;
    medianMultiple: number;
    examples: string[];
    videoIds?: string[];
    /**
     * The same topic as the MARKET covers it. Without this there is no way to
     * say where the channel owns a subject and where the market is winning one
     * it barely touches — "where can I grow" needs a comparison, not just a
     * ranking of the channel against itself.
     */
    marketCount?: number;
    marketMedianViews?: number;
    /**
     * Which MARKET videos are in this topic. Same lesson as `videoIds` above,
     * one level out: without membership, a chart comparing this channel to the
     * market on a topic can only use the two pre-computed aggregates, and any
     * question the report did not anticipate is unanswerable.
     */
    marketVideoIds?: string[];
    /** This channel's share of the videos on this topic, 0-1. */
    share?: number;
  }[];
  /** Topics the market rewards that this channel barely touches. */
  gaps: { topic: string; evidence: string; marketExamples: string[] }[];
  verdict: string;
}

export interface MarketPosition {
  /** Rank by subscribers among the scanned set, 1 = largest. */
  subscriberRank: number;
  /** Rank by median views per video — the honest one. */
  medianViewsRank: number;
  competitorCount: number;
  /** Where this channel beats the market and where it is beaten. */
  strengths: string[];
  weaknesses: string[];
  verdict: string;
}

export interface GrowthArea {
  title: string;
  /** What to do, concretely. */
  action: string;
  /** The market evidence this rests on. */
  evidence: string;
  /** Rough effort against likely payoff. */
  effort: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
}

/**
 * A narrowing of what counts as EVIDENCE in the report.
 *
 * Channels change direction, and a catalogue is a history: the report can end
 * up describing work its owner has moved on from. A focus filters which videos
 * the findings are computed over — it deletes nothing, and clearing it restores
 * the full report.
 */
export interface AuditFocus {
  /** Only judge videos published within this many days. */
  sinceDays?: number | null;
  includeTopics?: string[] | null;
  excludeTopics?: string[] | null;
  /** One line, shown on the report so nobody forgets it is filtered. */
  note: string;
  /** How many videos survived — worth seeing before trusting a narrow report. */
  videoCount: number;
}

/** One turn of the report chat. */
export interface AuditChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
  /** Set on the assistant turn that re-aimed the report. */
  refocused?: { note: string; videoCount: number };
}

/**
 * A proposed title the operator actually applied, and what happened next.
 *
 * The audit advised and never found out whether it was right. Recording the
 * view count AT THE MOMENT OF APPLYING is what makes the later check mean
 * anything — without that baseline there is nothing to compare against, which
 * is also why this can only work going forward and never retroactively.
 */
export interface AppliedRename {
  runId: string;
  videoId: string;
  originalTitle: string;
  proposedTitle: string;
  appliedAt: number;
  /** Views at the moment it was applied — the baseline. */
  viewsAtApply: number;
  /** The channel's median views for that video's era, so growth is comparable. */
  eraMedianAtApply: number;
  /** Filled in on a later check. */
  checkedAt?: number | null;
  viewsAtCheck?: number | null;
}

/**
 * One API call's tokens and price, so a run's bill can be decomposed.
 *
 * Structurally the same shape as `ScopedCall` in ai/usageScope.ts, which is what
 * actually produces these — the audit opens a usage scope and every Claude call
 * inside it lands here. `model`, `ms` and `unpriced` are optional only because
 * runs recorded before cost tracking existed have neither; anything written now
 * carries all three.
 */
export interface AuditCallUsage {
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
  model?: string;
  ms?: number;
  /** The model had no published rate on file — cost is UNKNOWN, not zero. */
  unpriced?: boolean;
}

/**
 * One chart in a custom section.
 *
 * The spec is what was ASKED; `AuditChartData` alongside it is what was
 * MEASURED. They are stored separately on purpose — the query is reproducible,
 * so a reader can see exactly what question produced the picture, and a stale
 * chart can be recomputed rather than believed.
 *
 * `form` is derived from the query by the server, never chosen by the model.
 */
export interface AuditChartSpec {
  id: string;
  form: "bars" | "grouped" | "diverging" | "line";
  title: string;
  /** One line under the title: what the reader should take from it. */
  caption: string;
  query: AuditSeriesQuery;
}

/** A part of the report the operator asked for after the fact. */
export interface AuditReportSection {
  id: string;
  title: string;
  /** What was asked, verbatim — the section's own provenance. */
  request: string;
  summary: string;
  bullets: string[];
  charts: { spec: AuditChartSpec; data: AuditChartData }[];
  /** Any data fetched to answer this, in plain language. Empty when none was. */
  gathered: string[];
  /** How it was measured, so a claim can be checked rather than trusted. */
  method: string;
  createdAt: number;
  /** YouTube quota this section spent gathering. */
  quotaUnits: number;
}

export interface AuditRunResult {
  runId: string;
  status: AuditStatus;
  title: string;
  input: AuditInput;
  subject: AuditChannel | null;
  /** Proposed market, before approval. */
  proposal: MarketProposal | null;
  /** What the operator approved — what the scan actually used. */
  approved: MarketProposal | null;
  competitors: AuditChannel[];
  videos: AuditVideo[];
  /** Competitor videos kept as market evidence (their outliers). */
  marketVideos: AuditVideo[];
  findings: AuditFindings | null;
  /**
   * Stages this run could not do, and what each one costs the report.
   *
   * Empty on a clean run. A run that hit a daily quota cap mid-way finishes
   * with a gap rather than a failure — the report is then honest about its own
   * holes instead of silently missing a section.
   */
  gaps: AuditGap[];
  /**
   * Channels fetched to compare against, on a section's request. Kept on the
   * run so a later section reuses one rather than paying to ingest it twice.
   */
  guests: AuditGuestChannel[];
  /**
   * The stage a failed run died in, so "skip it and carry on" knows what it is
   * skipping. Null on runs that failed before this was recorded — recovery.ts
   * infers it from the row instead.
   */
  failedStage: AuditStage | null;
  /** Set when the report has been narrowed via the chat. */
  focus?: AuditFocus | null;
  /**
   * The findings as computed over the WHOLE catalogue, kept the first time a
   * focus is applied so it can be undone.
   *
   * A refocus rewrites `findings` in place. Without this the original report is
   * destroyed — which is what happened on the first real one: a bad topic
   * filter reduced it to twelve videos and there was nothing to go back to.
   * Narrowing what counts as evidence must never be a one-way door.
   */
  baseFindings?: AuditFindings | null;
  /** The conversation about this report. */
  chat: AuditChatMessage[];
  /**
   * Sections the operator asked for after the report was written. Additive:
   * a refocus rewrites `findings`, this only ever appends.
   */
  sections?: AuditReportSection[];
  calls: AuditCallUsage[];
  costUsd: number;
  /** YouTube Data API units spent — the other budget. */
  quotaUnits: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRunListItem {
  runId: string;
  title: string;
  status: AuditStatus;
  channelTitle: string | null;
  videoCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A channel fetched purely so the report can be compared against it.
 *
 * Asked for from the report chat ("add a comparison with @someone"), not part
 * of the market. The distinction matters more than it looks: the market set is
 * each competitor's OVER-PERFORMERS, so its numbers describe what good looks
 * like over there and nothing else. A guest is ingested as a WHOLE catalogue,
 * era-scored the same way the subject's is — so it is the one population in the
 * run that can be compared like for like, including on the era multiple the
 * market scopes have to refuse.
 */
export interface AuditGuestChannel {
  channel: AuditChannel;
  /** The whole catalogue, era-scored. Never an outliers-only subset. */
  videos: AuditVideo[];
  /** What the operator asked, which is why this channel is on the run. */
  request: string;
  /** True when only the most recent GUEST_MAX_VIDEOS uploads were taken. */
  truncated: boolean;
  quotaUnits: number;
  at: number;
}

/** Live progress while a run is in flight. */
export interface AuditJobSnapshot {
  runId: string;
  status: AuditStatus;
  stage: string;
  progress: number; // 0..1
  error: string | null;
}
