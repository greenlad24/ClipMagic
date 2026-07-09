/**
 * Contract for the Jake Dawson YouTube Script Generator.
 *
 * A run takes a plain-text video idea (+ optional brief), classifies it
 * (Stage 0) and PAUSES for the user to confirm/edit the detected video type +
 * title, then runs the 7-stage methodology verbatim and in sequence on Opus 4.8
 * (research → outline → all-4 hooks → optional sponsor segment → section-by-
 * section with a review pass → outro → final review), and assembles the full
 * document (all four hook formulas + meat + outro). Prompts live as files in
 * scriptgen/prompts/; SOUL.md + story-shrapnel-bank.md in scriptgen/reference/.
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

export interface ScriptStages {
  research: string | null;
  outline: string | null;
  /** All four hook formulas (Stage 3). */
  hooks: string | null;
  /** Only for mid-roll sponsorships (Stage 4). */
  sponsorSegment: string | null;
  sections: ScriptSection[];
  outro: string | null;
  /** Stage 7 final-review change notes. */
  reviewNotes: string[];
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
}

/** Compact row for the saved-scripts history. */
export interface ScriptRunListItem {
  id: string;
  title: string;
  videoType: VideoType | null;
  status: ScriptRunStatus;
  createdAt: number;
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
}

export interface ScriptGenStatus {
  anthropicConfigured: boolean;
  /** The Opus model the tool runs on. */
  model: string;
}
