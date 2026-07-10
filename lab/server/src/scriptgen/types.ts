/**
 * Contract for the Jake Dawson YouTube Script Generator.
 *
 * A run takes a plain-text video idea (+ optional brief), classifies it
 * (Stage 0) and PAUSES for the user to confirm/edit the detected video type +
 * title, then runs the methodology verbatim and in sequence on Opus 4.8
 * (research → outline → all-4 hooks → optional sponsor segment → section-by-
 * section with a review pass → outro → CTA placement → brief adherence → final
 * review), and assembles the full document (all four hook formulas + meat + outro).
 *
 * Stage 5.5 (CTA placement) runs AFTER the outro even though it's numbered 5.5:
 * it has to see the end of the video to strip the outro's trailing comment
 * prompt, and it needs the Stage 3 hooks to place the subscribe clause.
 *
 * Stage 6.5 (brief adherence) runs only when the input carried a brief, and sits
 * before Stage 7 so the final voice review covers any sentence it inserted.
 *
 * Prompts live as files in scriptgen/prompts/; SOUL.md + story-shrapnel-bank.md
 * in scriptgen/reference/.
 */

export type SponsorshipMode = "organic" | "whole-video" | "mid-roll";
export interface Sponsorship {
  mode: SponsorshipMode;
  sponsorName: string | null;
}

export interface ScriptInput {
  /** The plain-text video idea (required). */
  idea: string;
  /** Optional extra angle/context. */
  brief?: string;
  sponsorship?: Sponsorship;
  /** Defaults to "10–12 minutes minimum". */
  targetLength?: string;
}

export type VideoType = "Tutorial" | "List/Roundup" | "Tool Review" | "Business Guide" | "Opinion";

/** Stage 0 output — the classifier's read of the idea. */
export interface Stage0Result {
  videoTypeDetailed: string;
  videoType: VideoType;
  titleOptions: string[];
  recommendedTitle: string;
  coreTopic: string;
  specificFocus: string;
  /**
   * How many items/use cases the video should cover, judged from the idea and
   * brief. Null when the video isn't item-based. Never derived from the title.
   */
  itemCount: number | null;
}

/** The user-confirmed setup after the Stage 0 checkpoint (drives Stages 1–7). */
export interface ScriptSetup {
  videoType: VideoType;
  title: string;
  coreTopic: string;
  specificFocus: string;
  sponsorship: Sponsorship;
  targetLength: string;
}

export interface ScriptSection {
  name: string;
  /** Stage 5 first pass. */
  draft: string;
  /** After the Stage 5 review pass (14-year-old reading level). */
  final: string;
}

/**
 * Stage 6.5 — how well the finished script delivers the user's brief, and what
 * the pass did about it. Only produced when the run's input carried a brief.
 *
 * The pass prescribes sentence-level edits ({mode, find, text}); the orchestrator
 * applies them itself, discarding any whose `find` text isn't uniquely present.
 * That's what keeps this a targeted fix rather than a whole-script rewrite —
 * it's enforced in code, not merely requested in the prompt.
 */
export interface BriefCheck {
  /** 0–100 coverage of the brief (voice/pacing are Stage 7's job, not scored here). */
  score: number;
  verdict: string;
  /** Brief requests deliberately NOT fixed (voice conflict, too big for a sentence edit). */
  gaps: string[];
  /** One line per edit actually applied to the script. */
  editsApplied: string[];
  /** One line per edit discarded, with why (find text missing, ambiguous, or too long). */
  editsSkipped: string[];
}

/** A page the Stage 1 web research actually rested on. */
export interface ScriptSource {
  url: string;
  title: string;
}

/** Stage 7's per-item pass/fail. The model already returns this; we now keep it. */
export interface ReviewChecklist {
  shortHook: boolean;
  largeMeat: boolean;
  fourteenYearOld: boolean;
  noPunchSideways: boolean;
  noPunchDown: boolean;
  welcomeAtHookEnd: boolean;
  noIncomeClaims: boolean;
  demosNotDescribes: boolean;
}

/** Deterministic fact check of the finished script against the Stage 1.5 fact sheet. */
export interface ClaimAudit {
  /** Numbers the script asserts that the fact sheet never established. */
  unsupportedNumbers: string[];
  /** Fenced topics the script mentions — may be a rebuttal, so check rather than assume. */
  fencedTopicsMentioned: string[];
  /** First-person "I tested it for 30 days" claims with nothing behind them. */
  experienceClaims: string[];
  numbersChecked: number;
}

/** Computed, not modelled: is the finished script repetitive, does it sound spoken. */
export interface ScriptQuality {
  words: number;
  sentences: number;
  meanSentenceWords: number;
  burstiness: number;
  repeatedPhraseCount: number;
  worstPhraseRepeats: number;
  worstPhrase: string | null;
  discourseMarkerOpenings: number;
}

export interface ScriptStages {
  research: string | null;
  /** Stage 1 — the sources the research rested on, so a price claim can be traced. */
  sources: ScriptSource[];
  /**
   * Stage 1.5 — the falsifiable details distilled out of the research: exact
   * prices, exact click paths, versions, links, and the date each was verified.
   * Handed to every Stage 5 section draft so the writer never has to invent a
   * number or a button name that the outline happened to compress away.
   */
  factSheet: string | null;
  outline: string | null;
  /** All four hook formulas (Stage 3). */
  hooks: string | null;
  /** Only for mid-roll sponsorships (Stage 4). */
  sponsorSegment: string | null;
  sections: ScriptSection[];
  outro: string | null;
  /** Stage 5.5 — the four hooks with the subscribe clause tagged onto each welcome beat. */
  hooksWithCta: string | null;
  /** Stage 5.5 — sections + outro with the like/comment CTAs placed and the end comment prompt removed. */
  ctaScript: string | null;
  /** Stage 5.5 — what the CTA pass placed and removed. */
  ctaNotes: string[];
  /** Stage 6.5 — brief adherence score + applied edits. Null when the run had no brief. */
  briefCheck: BriefCheck | null;
  /** Stage 7 final-review change notes. */
  reviewNotes: string[];
  /** Stage 7's checklist. The model returns it on every run; it used to be discarded. */
  reviewChecklist: ReviewChecklist | null;
  /** Computed from the finished document — repetition + spoken-ness. */
  quality: ScriptQuality | null;
  /** Computed from the finished document — unsupported numbers + fenced topics. */
  claimAudit: ClaimAudit | null;
}

export type ScriptRunStatus =
  | "classifying"
  | "awaiting_confirmation"
  | "running"
  | "completed"
  | "failed";

export interface ScriptRunResult {
  runId: string;
  title: string;
  input: ScriptInput;
  setup: ScriptSetup | null;
  stage0: Stage0Result | null;
  stages: ScriptStages;
  /** Assembled document: all-4-hooks + [sponsor segment] + meat + outro. */
  finalDocument: string | null;
  status: ScriptRunStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Wall-clock time spent generating Stages 1–7, in ms. Accumulates across resume. */
  generationMs: number;
}

/** Compact row for the saved-scripts history. */
export interface ScriptRunListItem {
  id: string;
  title: string;
  videoType: VideoType | null;
  status: ScriptRunStatus;
  createdAt: number;
  /** Wall-clock generation time in ms, for the history row. */
  generationMs: number;
}

/** Live snapshot the frontend polls while a run is in flight. */
export interface ScriptJobSnapshot {
  jobId: string;
  runId: string;
  status: ScriptRunStatus;
  /** Human phase label ("Researching (web)…", "Writing section 3/6…"). */
  phase: string;
  percent: number;
  error: string | null;
  /** Live spend for this run, in USD, so cost is watched while it happens. */
  costUsd: number;
}

export interface ScriptGenStatus {
  anthropicConfigured: boolean;
  /** The Opus model the tool runs on. */
  model: string;
}
