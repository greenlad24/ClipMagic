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

export interface AuditInput {
  /** Channel URL, @handle or raw channel id. */
  channel: string;
  mode: AuditMode;
  /** Human label for the run; defaults to the channel title. */
  title?: string;
  /**
   * Skip the approval pause and scan whatever was proposed. For re-runs of a
   * channel whose market is already settled — never the default, because an
   * unattended wrong market silently wastes the day's quota.
   */
  autoApprove?: boolean;
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
  position: MarketPosition;
  growth: GrowthArea[];
  /** Written last, over everything above. */
  summary: string;
}

export interface TitleFindings {
  /** Patterns that over-perform, with the evidence. */
  winning: { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[];
  losing: { pattern: string; medianMultiple: number; sampleSize: number; examples: string[] }[];
  /** Prose, grounded in the above. */
  verdict: string;
}

export interface ThumbnailFindings {
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
  /** Topic clusters found across the catalogue and how each performs. */
  topics: { topic: string; count: number; medianMultiple: number; examples: string[] }[];
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

/** One API call's tokens and price, so a run's bill can be decomposed. */
export interface AuditCallUsage {
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
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

/** Live progress while a run is in flight. */
export interface AuditJobSnapshot {
  runId: string;
  status: AuditStatus;
  stage: string;
  progress: number; // 0..1
  error: string | null;
}
