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
  /** Jake gives roughly a third of every video to a handful of demonstrations
   *  he lets run past 25 seconds (ref1-4: 5-9 of them, 26-49% of runtime).
   *  Median hold does not catch their absence — a plan can match the median
   *  with many medium shots and still never let one screen breathe. */
  longDemos: number;
  longDemoPct: number;
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
  /** Per-round measurements from the repair loop, oldest first. `raw` is the
   *  model's answer verbatim — kept because a round that parses to nothing
   *  otherwise leaves no evidence of what it actually wrote. */
  rounds: {
    round: number;
    penalty: number;
    measure: PlanMeasure;
    deviations: string[];
    raw?: string;
  }[];
  /** Tokens and price per API call, so a run's bill can be decomposed. */
  calls: PlanCallUsage[];
  beats: Beat[];
  /** The verified UI fact sheet the screencast instructions were grounded in. */
  research: string | null;
  /**
   * The generated full-screen cards, and where that stage got to. Null until
   * the motion stage is first used — planning never touches it.
   */
  motion: PlanMotion | null;
  costUsd: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Motion graphics (the plan's full-screen cards, generated) ────────────────
// Only the two text kinds can be generated: Higgsfield's output is opaque
// video, so a clip can REPLACE a frame but never sit over Jake's own footage.

/** One plan line that means "cut away to a full-screen card", so it can be generated. */
export interface GraphicSlot {
  /** Index into the plan's own line order, so a result can be put back in place. */
  index: number;
  start: number;
  end: number;
  kind: string;
  /** The words that go ON the card. */
  text: string;
  durationSec: number;
}

/**
 * One still generated during the sample round. Jake picks one of these and it
 * becomes the style reference every other card is generated against — an
 * approved frame is a more precise spec than any written style guide.
 */
export interface MotionSample {
  slotIndex: number;
  text: string;
  /** Higgsfield's hosted still. This URL is what gets reused as the reference. */
  stillUrl: string;
  /** Local copy, relative to the run's motion directory. */
  file: string;
}

/** A finished card: still, animation, and the clip cut to the slot's length. */
export interface MotionGraphicAsset {
  index: number;
  start: number;
  end: number;
  text: string;
  stillUrl: string;
  videoUrl: string;
  /** The slot-fitted clip — this is the one to cut into the timeline. */
  file: string;
  /** Higgsfield's own 5s/10s render, kept so a fit can be redone without paying again. */
  rawFile: string;
  durationSec: number;
}

export type MotionPhase =
  | "idle"                // nothing generated yet
  | "sampling"            // generating style samples
  | "awaiting-approval"   // samples are ready; waiting for Jake to pick one
  | "ready"               // a style is approved; the full set can be generated
  | "generating"          // making every card against the approved reference
  | "completed"
  | "failed";

/** Everything the motion-graphics stage knows about one plan run. */
export interface PlanMotion {
  phase: MotionPhase;
  /** Every generatable slot in the plan, in plan order. */
  slots: GraphicSlot[];
  samples: MotionSample[];
  /** The approved reference still. Generating the full set requires this. */
  styleStillUrl: string | null;
  /** Free-text style notes carried into every prompt alongside the reference. */
  styleExtra: string | null;
  graphics: MotionGraphicAsset[];
  /** Honest count of what was actually generated, since each one costs credits. */
  stillsGenerated: number;
  clipsGenerated: number;
  error: string | null;
  updatedAt: number;
}

/** Live progress while a sample round or a full generation is in flight. */
export interface MotionJobSnapshot {
  runId: string;
  phase: MotionPhase;
  stage: string;
  progress: number; // 0..1
  done: number;
  total: number;
  error: string | null;
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

/** What one Anthropic call cost, and why. */
export interface PlanCallUsage {
  /** Which step made the call, e.g. "research" or "plan round 2". */
  label: string;
  input: number;
  output: number;
  cacheWrite: number;
  /** Zero across repair rounds means the context is being re-sent at full price. */
  cacheRead: number;
  costUsd: number;
}
