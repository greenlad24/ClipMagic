/**
 * Contract for the Video Planner.
 *
 * Input is an EDITED NARRATION video (Jake to camera, already cut for pace).
 * Output is the plan his creative editor would write by hand:
 *
 *   [1:33 to 1:35] - {the instruction}
 *
 * This tool is deliberately separate from the Long-form editor: it produces the
 * plan only. Capturing the screencasts and assembling the video is a later
 * tool, which will build on this one's ingest + narration analysis.
 */

export type PlanRunStatus =
  | "ingesting"      // fetching/normalising the narration video
  | "transcribing"   // words + beat map
  | "researching"    // verifying the products' real UI
  | "planning"       // generating + repairing the plan
  | "completed"
  | "failed";

/** One line of the plan, parsed. */
export interface PlanLine {
  start: number;         // seconds
  end: number;
  kind: PlanElement;
  instruction: string;
}

export type PlanElement =
  | "screencast"
  | "talking_head"
  | "stock_footage"
  | "text_gradient"
  | "text_whiteboard"
  | "unknown";

/** One run of speech bounded by real silences, with delivery detail. */
export interface Beat {
  i: number;
  start: number;
  end: number;
  dur: number;
  /** Silence after this beat, in seconds. A cut lands cleanly here. */
  gapAfter: number;
  text: string;
  /** Words hit noticeably harder than the surrounding speech. */
  emphasis: string[];
}

/** How a generated plan compares to the measured corpus. */
export interface PlanMeasure {
  lines: number;
  coverStart: number | null;
  coverEnd: number | null;
  duration: number;
  gaps: { at: number; len: number }[];
  overlaps: { at: number; len: number }[];
  unknown: number;
  screencastPct: number;
  talkingHeadPct: number;
  stockPct: number;
  screencastHold: number;
  talkingHeadHold: number;
  /** Cuts per minute — catches over-cutting that the element mix hides. */
  shotsPerMin: number;
  shots: number;
  /** Cut rate in the retention-critical opening vs the body. Jake's openings
   *  run ~1.9x faster; a uniform rate is a real mismatch. Null when the video
   *  is too short for the split to mean anything. */
  openingShotsPerMin: number | null;
  bodyShotsPerMin: number | null;
  /** Hook pace ÷ body pace. Jake's own rule: the hook runs 1.9x the body, and
   *  the body settles back to a regular pace. Banding the two rates separately
   *  is not the same check — a plan can sit inside both and still be flat. */
  hookBodyRatio: number | null;
  titles: number;
  titlesPerMin: number;
  altPct: number;
  maxScreencastRun: number;
  longGradient: string[];
  gradientFullStop: number;
  /** Length of the delivered plan. It has to paste into a single Slack
   *  message, which caps at 40,000 characters. */
  chars: number;
}

export interface PlanInput {
  /** A Descript share URL, or an uploaded file id already in storage. */
  source: string;
  sourceKind: "descript" | "upload";
  /** Optional product URLs the creator knows are relevant. */
  productUrls?: string[];
  /** Skip the web-research stage (faster, but screencasts will be ungrounded). */
  skipResearch?: boolean;
  title?: string;
}

export interface PlanRunResult {
  runId: string;
  status: PlanRunStatus;
  title: string;
  input: PlanInput;
  durationSec: number | null;
  /** The deliverable, in Jake's line format. */
  plan: string | null;
  parsed: PlanLine[];
  measure: PlanMeasure | null;
  /** Per-round measurements from the repair loop, oldest first. */
  rounds: { round: number; penalty: number; measure: PlanMeasure; deviations: string[] }[];
  beats: Beat[];
  /** The verified UI fact sheet the screencast instructions were grounded in. */
  research: string | null;
  costUsd: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlanRunListItem {
  runId: string;
  title: string;
  status: PlanRunStatus;
  durationSec: number | null;
  lines: number;
  createdAt: number;
  updatedAt: number;
}

/** Live progress for the UI while a run is in flight. */
export interface PlanJobSnapshot {
  runId: string;
  status: PlanRunStatus;
  stage: string;
  progress: number; // 0..1
  error: string | null;
}
