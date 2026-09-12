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

/**
 * One screenshot of the tool as it is TODAY, uploaded by the user at setup.
 *
 * The bytes live on disk under DATA_DIR/scriptgen/shots (see scriptgen/shots.ts)
 * rather than in the run row: a run carries a dozen PNGs of a dashboard, and
 * `stages_json` is read and written back on every stage boundary.
 *
 * `note` is what the user typed about that shot ("this is the pricing page,
 * logged in on the paid tier"). It is the only thing that tells the reader what
 * they are looking at when the screen itself is ambiguous, and it is carried
 * into the sheet verbatim.
 */
export interface ScreenshotRef {
  id: string;
  /** Original filename, shown in the UI and used as the shot's label. */
  name: string;
  /** image/png | image/jpeg | image/webp | image/gif — what Anthropic accepts. */
  mediaType: string;
  bytes: number;
  /** Optional user note about what this screenshot shows. */
  note?: string;
  /** When it was uploaded. */
  uploadedAt: number;
}

export interface ScriptInput {
  /** The plain-text video idea (required). */
  idea: string;
  /** Optional extra angle/context. */
  brief?: string;
  sponsorship?: Sponsorship;
  /** Defaults to "10–12 minutes minimum". */
  targetLength?: string;
  /**
   * Screenshots of the tool taken today. Optional, and the single highest
   * authority in the run: a screen the user photographed this morning outranks
   * the vendor's own page, a tutorial recorded in July, and every review blog.
   *
   * They matter most exactly where the web is weakest — a tool that launched
   * last month, or one nobody has written about — which is also where a script
   * built from search results goes stale or invents things.
   */
  screenshots?: ScreenshotRef[];
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
  /**
   * How much current, trustworthy writing about this topic the web is likely to
   * hold. Judged at classify-time, before a single search is bought, and used
   * for one thing: telling the user at the checkpoint whether screenshots are
   * optional or are about to be the only real source this run has.
   *
   * "thin" is the case that produced hedged scripts — a tool too new or too
   * small for anyone to have written about it accurately, where search returns
   * SEO pages that restamp year-old copy with the current year in the title.
   *
   * Null on runs that predate this field.
   */
  coverageRisk?: CoverageRisk | null;
  /** One sentence on why, shown to the user next to the upload control. */
  coverageNote?: string | null;
}

/**
 * How well-covered a topic is by current writing on the open web.
 *
 *   "normal" — an established tool with real, dateable coverage.
 *   "thin"   — new, niche, or renamed: expect stale aggregator copy and little
 *              from the vendor. Screenshots do the heavy lifting here.
 */
export type CoverageRisk = "normal" | "thin";

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
  /**
   * These four were asked for in stage7-review.md but never existed here, so
   * coerceChecklist dropped them on every run — the review performed the check
   * and the answer was discarded before it reached the artifact.
   */
  threeFunnyLines: boolean;
  noSilentStretch: boolean;
  noGenericApproval: boolean;
  noLiftedLines: boolean;
  /** No AI-register phrasing left in the script. */
  noSlopPhrasing: boolean;
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
  /** AI-register phrasings that survived — measured to appear in no reference script. */
  slopPhrases: string[];
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
  /** Optional: runs stored before these were measured don't carry them. */
  demoAnchors?: number;
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

/**
 * Where the research's sources actually came from.
 *
 * Written after Stage 1 from the sources the search returned, NOT asked of the
 * model — the run that motivated this one read 19 third-party review sites and
 * two stale vendor help pages, and reported itself as having researched the
 * product thoroughly. A count is not a judgement call.
 *
 *   firstParty  — pages on the vendor's own domain(s): pricing, docs, changelog.
 *   community   — forums, Reddit, GitHub, Discord: people using the thing.
 *   aggregator  — review farms and software directories. These restamp old copy
 *                 with the current year, so they LOOK current to a date-anchored
 *                 search and are the main way a stale price gets in.
 */
export interface SourceAudit {
  total: number;
  firstParty: number;
  community: number;
  aggregator: number;
  /** The vendor hostnames this audit was judged against. */
  vendorHosts: string[];
  /** Hostnames counted as first-party, for the log line and the UI. */
  firstPartyHosts: string[];
  /**
   * True when the research never opened a single page the vendor publishes.
   * Not an error — some topics have no vendor — but on a tool walkthrough it is
   * the strongest available signal that the prices in this run are hearsay.
   */
  noFirstParty: boolean;
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
   * Stage 0.4 — what the user's own screenshots show, read before anything is
   * searched for. Exact labels, prices, tiers and states as of the day they were
   * taken, plus what the shots do NOT cover so the research knows where to look.
   *
   * This is the top of the evidence order for the whole run. Undefined when the
   * stage never ran (no screenshots uploaded); null when it ran and the images
   * turned out to be unreadable.
   */
  screenshotSheet?: string | null;
  /** Which screenshots that sheet was built from, for the deliverable's source list. */
  screenshotRefs?: ScreenshotRef[];
  /**
   * Stage 1 — whether the research ever opened a page the vendor itself
   * publishes, or spent the whole budget on third-party review sites. Undefined
   * on runs that predate the audit.
   */
  sourceAudit?: SourceAudit;
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

/* ────────────────────────── the edit loop ────────────────────────── */

/**
 * A point Jake declared finished, kept so it can be restored and compared.
 *
 * ⚠️ SNAPSHOTTED ON "DONE", NOT ON AUTOSAVE. See the table comment in
 * db/index.ts: the autosave column is the live text, a version is a decision.
 */
export interface ScriptVersion {
  id: string;
  runId: string;
  /** 1-based within the run. Version 1 is always what the pipeline wrote. */
  versionNo: number;
  /**
   * `generated` — the pipeline's own words. `edit` — Jake's. `rules` — the
   * approved-rules pass rewriting the parts he had not touched.
   *
   * ⚠️ `generated` AND `rules` ARE BOTH LEARNING BASELINES, and that is what the
   * third value is for. After a rules pass the machine's text is no longer
   * `finalDocument`, so a later "Done" that diffed against `finalDocument` would
   * read the machine's own rewrite as an edit by Jake and learn from it —
   * a model teaching itself its own habits, one approval at a time.
   */
  source: "generated" | "edit" | "rules";
  text: string;
  note: string;
  createdAt: number;
  chars: number;
  words: number;
}

/** Counts from the deterministic diff — see scriptgen/editDiff.ts. */
export interface ScriptEditStats {
  generatedParagraphs: number;
  editedParagraphs: number;
  kept: number;
  rewritten: number;
  cut: number;
  added: number;
  generatedWords: number;
  editedWords: number;
  keptRatio: number;
  thirds: [number, number, number];
}

/** One before/after pair, straight out of the diff — never paraphrased. */
export interface ScriptLessonEvidence {
  before: string;
  after: string;
}

/**
 * Something the generator should do differently next time, proposed from a diff.
 *
 * ⚠️⚠️ INERT UNTIL APPROVED. Only `state === "approved"` reaches the system
 * prompt; a pending lesson is a suggestion on a screen and nothing more.
 */
export interface ScriptLesson {
  id: string;
  runId: string;
  reviewId: string;
  rule: string;
  rationale: string;
  evidence: ScriptLessonEvidence[];
  scope: "voice" | "structure" | "format" | "facts";
  state: "pending" | "approved" | "rejected" | "retired";
  createdAt: number;
  decidedAt: number | null;
  /** The script it was learned from, for the panel. Not stored — joined on read. */
  runTitle?: string;
}

/** One "Done" click: the diff that was measured and what came out of it. */
export interface ScriptEditReview {
  id: string;
  runId: string;
  versionId: string;
  stats: ScriptEditStats;
  status: "ready" | "failed";
  error: string | null;
  costUsd: number;
  createdAt: number;
  lessons: ScriptLesson[];
}
