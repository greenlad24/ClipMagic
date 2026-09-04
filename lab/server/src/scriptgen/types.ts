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

/**
 * What a run is asked to produce.
 *
 * "outline" stops after the outline (research → fact sheet → outline → brief
 * coverage) instead of going on to write the video. It is a deliberate stopping
 * point, not a failure: the outline is the plan, and it is far cheaper to read,
 * cut and re-order a plan than a finished script. Everything it paid for is
 * persisted, so writing the full script from it later resumes rather than
 * re-buying the research.
 */
export type ScriptMode = "full" | "outline";

/** One tutorial the workflow sheet was built from. */
export interface VideoSourceRef {
  title: string;
  channel: string;
  url: string;
  publishedAt: string;
  views: number;
}

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
  /** Defaults to "full" — runs that predate outline mode have no mode at all. */
  mode?: ScriptMode;
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
  leanOpen: boolean;
  noSectionAnnouncement: boolean;
  toolNamedNotVague: boolean;
  noStaleFacts: boolean;
}

/** One hook, scored. Stage 3 writes four; this is how Jake chooses between them. */
export interface HookRank {
  /** 1-based position in the hooks block, in the order Stage 3 wrote them. */
  hook: number;
  /** The formula label Stage 3 gave it, e.g. "FORMULA A-LONG — 5-Beat Confession Reframe". */
  label: string;
  /** 0-100, judged: does this make someone stay past the first ten seconds. */
  virality: number;
  /** 0-100, MEASURED: how much of the topic's search language it carries, and how early. */
  seo: number;
  /** One clause on the virality score. */
  why: string;
  /** The traffic this hook is built for — browse, search, mobile. */
  bestFor: string;
}

/**
 * A question the hook plants and deliberately does not answer, paid off later in
 * a named section. Decided at outline time — the loop has to be something the
 * video genuinely delivers, and only the outline knows what that is — then
 * opened by the hooks and closed by the section that owns it.
 */
export interface OpenLoop {
  /** The tease, as the hook will pose it. */
  question: string;
  /** What actually answers it. Taken from the outline, so it cannot be a promise the video never keeps. */
  payoff: string;
  /** 1-based index into the outline's sections — the one that closes it. */
  closesInSection: number;
  /** Set after the sections are written: did that section actually pay it off? */
  closed?: boolean;
}

/** Deterministic fact check of the finished script against the Stage 1.5 fact sheet. */
export interface ClaimAudit {
  /** Numbers the script asserts that the fact sheet never established. */
  unsupportedNumbers: string[];
  /** Fenced topics the script mentions — may be a rebuttal, so check rather than assume. */
  fencedTopicsMentioned: string[];
  /** First-person "I tested it for 30 days" claims with nothing behind them. */
  experienceClaims: string[];
  /** Sponsor plugs beyond the two allowed (one early, one at the close). */
  excessSponsorPlugs: string[];
  /** Banned words that survived into the finished script. */
  bannedWords: string[];
  /**
   * Names of the people whose tutorials fed the workflow sheet, found in the
   * script. A run said "that's the version Nate actually runs day to day" —
   * Nate being the presenter of two source videos, never introduced, and no
   * part of Jake's voice.
   */
  sourceNames: string[];
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

/** One brief request, and what the outline did with it (Stage 2.5). */
export interface CoverageItem {
  item: string;
  status: "covered" | "added" | "gap";
  where: string;
}

/**
 * Stage 2.5 — how completely the OUTLINE carries the brief, checked while a
 * missing item can still be given its own section.
 *
 * Stage 6.5 asks the same question of the finished script, but it runs at 91%
 * and can only make sentence-level edits: on the Expertise run it scored 48/100,
 * reported that three brief requests "need their own section", and shipped
 * anyway, because by then there was no way to add one.
 */
export interface BriefCoverage {
  score: number;
  verdict: string;
  items: CoverageItem[];
  /** True when the pass rewrote the outline to cover something Stage 2 dropped. */
  outlineRevised: boolean;
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
  /**
   * What recent video tutorials actually show on screen: click paths, real UI
   * labels, values typed, and what they disagree about. Null when video research
   * is unconfigured or the topic had no recent tutorials.
   */
  videoWorkflows?: string | null;
  /** The videos it was built from, for the deliverable's source list. */
  videoSources?: VideoSourceRef[];
  outline: string | null;
  /** Stage 2.5 — brief coverage judged at outline-time. Null when the run had no brief. */
  briefCoverage: BriefCoverage | null;
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
  /** Stage 2.6 — the loops the hook opens and the sections close. Null when the pass found none. */
  openLoops: OpenLoop[] | null;
  /** Stage 3.5 — the four hooks ranked on virality and search value. */
  hookRanking: HookRank[] | null;
  /** Stage 7 final-review change notes. */
  reviewNotes: string[];
  /** Stage 7's checklist. The model returns it on every run; it used to be discarded. */
  reviewChecklist: ReviewChecklist | null;
  /** Computed from the finished document — repetition + spoken-ness. */
  quality: ScriptQuality | null;
  /** Computed from the finished document — unsupported numbers + fenced topics. */
  claimAudit: ClaimAudit | null;
  /** What the claim-fix pass rewrote, and what it refused to. Null when the audit found nothing. */
  claimFix: { applied: string[]; skipped: string[] } | null;
}

/**
 * One turn of the post-generation paragraph-refinement chat. Jake pastes a
 * paragraph from the finished script plus what he wants changed; the model
 * rewrites only that paragraph, grounded in this run's own research + fact
 * sheet. The thread is persisted with the run so it survives a reload.
 *
 * `content` is exactly what was sent to / returned by the model — for a user
 * turn that's the composed "PARAGRAPH… / WHAT TO CHANGE…" block, for an
 * assistant turn it's the rewritten paragraph (or a one-line "can't ground
 * that" reply).
 */
export interface RefineMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
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
  /**
   * Jake's hand-edited script, or null if he never touched it. Kept apart from
   * `finalDocument` so a regenerating pass cannot destroy the edit — and so
   * "revert to what the machine wrote" stays possible forever.
   */
  editedDocument: string | null;
  /** When that edit was last saved. */
  editedAt: number | null;
  /** Post-generation paragraph-refinement chat, oldest first. Empty until used. */
  refineChat: RefineMessage[];
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
  /** What the run produced, so an outline isn't mistaken for a finished script. */
  mode: ScriptMode;
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
