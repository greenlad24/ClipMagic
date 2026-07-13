/**
 * Orchestrator + in-memory job registry for the Jake Dawson Script Generator.
 *
 * A run is two-phase:
 *   1. startScript() — synchronous, one Opus call. Classifies the idea (Stage 0)
 *      and PAUSES at 'awaiting_confirmation' for the user to confirm/edit the
 *      detected video type + title.
 *   2. continueScript() — the user's confirmed ScriptSetup kicks off the 7-stage
 *      methodology as a fire-and-forget background job (runScript). The frontend
 *      polls getScriptSnapshot(jobId) for phase/percent while it runs.
 *
 * runScript() runs the stages VERBATIM and IN SEQUENCE on Opus 4.8, persisting
 * ScriptStages to the DB incrementally after each stage, and NEVER throws — any
 * failure is captured onto both the job and the run row as status 'failed'.
 *
 * The stage prompts are the source of truth; we only fill the specific bracket
 * tokens each stage exposes (see prompts.ts fill()) and keep the rest verbatim.
 */
import { nanoid } from "nanoid";
import { opusScriptChat, extractJson, scriptgenUsageTotal, resetScriptgenUsage } from "../ai/claude.js";
import { ZiteError } from "../zite/store.js";
import { createRun, updateRun, getRun } from "../db/scriptRuns.js";
import { loadPrompt, fill, systemPreamble } from "./prompts.js";
import {
  parseCtaPass,
  applyBriefEdits,
  buildContinuityLedger,
  scriptQuality,
  auditClaims,
  wordBudget,
  toCleanProse,
  extractPrompts,
  ensureCanonicalOutro,
} from "./edits.js";
import type { ContinuityLedger } from "./edits.js";
import type {
  ScriptInput,
  ScriptSetup,
  Sponsorship,
  Stage0Result,
  BriefCheck,
  ClaimAudit,
  ReviewChecklist,
  ScriptSource,
  ScriptStages,
  ScriptRunResult,
  ScriptJobSnapshot,
  ScriptRunStatus,
  RefineMessage,
  VideoType,
} from "./types.js";

// ── Stage 2 research-paste block ──────────────────────────────────────────────
// The exact bracketed instruction block in stage2-outline.md that we replace
// wholesale with the Stage 1 research text. Kept byte-for-byte so the split/join
// match succeeds.
const STAGE2_RESEARCH_BLOCK = `[PASTE YOUR RESEARCH HERE - This section is CRITICAL. Include:
- Tools you've tested and your findings
- Specific features you discovered
- Personal experiences and results
- Pricing details you've verified
- Screenshots or examples you have
- Discoveries you made while testing
- Comparisons you've done
- Any insider knowledge or non-obvious insights
- What worked really well
- Best use cases you found

The outline MUST incorporate these findings prominently and structure the video around YOUR specific discoveries, not generic information.]`;

const VIDEO_TYPES: VideoType[] = [
  "Tutorial",
  "List/Roundup",
  "Tool Review",
  "Business Guide",
  "Opinion",
];

/** Normalize any classifier output into the coarse VideoType union. */
function coerceVideoType(v: unknown): VideoType {
  const s = String(v ?? "").trim();
  const exact = VIDEO_TYPES.find((t) => t.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const l = s.toLowerCase();
  if (l.includes("list") || l.includes("round")) return "List/Roundup";
  if (l.includes("review")) return "Tool Review";
  if (l.includes("business") || l.includes("guide")) return "Business Guide";
  if (l.includes("opinion") || l.includes("comment")) return "Opinion";
  return "Tutorial";
}

/** The Stage 3 / hook "SPONSORSHIP STATUS" line for a given sponsorship. */
export function sponsorshipLabel(s: Sponsorship | undefined | null): string {
  if (!s || s.mode === "organic") return "Organic";
  const name = (s.sponsorName || "the sponsor").trim() || "the sponsor";
  if (s.mode === "whole-video") return `Whole-video sponsorship — ${name}`;
  return `Mid-roll segment — ${name}`;
}

// ── Stage 0 ───────────────────────────────────────────────────────────────────

/** Classify the idea + propose titles. One Opus call, tolerant JSON parse. */
export async function runStage0(input: ScriptInput): Promise<Stage0Result> {
  const idea = (input.idea || "").trim();
  const brief = (input.brief || "").trim();
  const raw = await opusScriptChat({
    system: loadPrompt("stage0-classify"),
    messages: [{ role: "user", content: `VIDEO IDEA:\n${idea}\n\nBRIEF:\n${brief || "(none)"}` }],
    maxTokens: 1500,
    thinking: false, // classify + name: mechanical, and thinking bills as output
    label: "stage0-classify",
    purpose: "scriptgen",
  });

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const videoType = coerceVideoType(parsed.videoType);
  let titleOptions = Array.isArray(parsed.titleOptions)
    ? parsed.titleOptions.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : [];
  const recommendedTitle =
    typeof parsed.recommendedTitle === "string" && parsed.recommendedTitle.trim()
      ? parsed.recommendedTitle.trim()
      : titleOptions[0] || idea || "Untitled video";
  if (titleOptions.length === 0) titleOptions = [recommendedTitle];

  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;

  return {
    videoTypeDetailed: str(parsed.videoTypeDetailed, videoType),
    videoType,
    titleOptions,
    recommendedTitle,
    coreTopic: str(parsed.coreTopic, idea),
    specificFocus: str(parsed.specificFocus, brief),
    itemCount:
      typeof parsed.itemCount === "number" && Number.isFinite(parsed.itemCount) && parsed.itemCount >= 3
        ? Math.round(parsed.itemCount)
        : null,
  };
}

/**
 * Start a run: validate, create the row, classify, then park at the
 * type/title confirmation checkpoint. Synchronous (one Opus call).
 */
export async function startScript(input: ScriptInput): Promise<{ runId: string; stage0: Stage0Result }> {
  if (!input || typeof input.idea !== "string" || !input.idea.trim()) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "A video idea is required to start a script." });
  }
  const runId = createRun(input);
  try {
    const stage0 = await runStage0(input);
    updateRun(runId, {
      stage0,
      title: stage0.recommendedTitle,
      videoType: stage0.videoType,
      status: "awaiting_confirmation",
    });
    return { runId, stage0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateRun(runId, { status: "failed", error: msg });
    throw e;
  }
}

// ── In-memory job registry ────────────────────────────────────────────────────
// A run is single-server + minutes-long. An in-memory Map is plenty; finished
// jobs are reaped after a TTL and the map is hard-capped so it never leaks.

interface ScriptJob {
  id: string;
  runId: string;
  status: ScriptRunStatus;
  phase: string;
  percent: number;
  error: string | null;
  /** Live spend, so the cost is watched while it happens rather than afterwards. */
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 50;
const jobs = new Map<string, ScriptJob>();

function reap(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const terminal = job.status === "completed" || job.status === "failed";
    if (terminal && job.updatedAt < cutoff) jobs.delete(id);
  }
  if (jobs.size >= MAX_JOBS) {
    // Only terminal jobs are evictable. Dropping a running job would blind the
    // frontend mid-run: its polled jobId starts 404ing with the work still going.
    const evictable = [...jobs.values()]
      .filter((j) => j.status === "completed" || j.status === "failed")
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = jobs.size - MAX_JOBS + 1;
    for (let i = 0; i < excess && i < evictable.length; i++) jobs.delete(evictable[i].id);
  }
}

function createJob(runId: string): ScriptJob {
  reap();
  const t = Date.now();
  const job: ScriptJob = {
    id: nanoid(),
    runId,
    status: "running",
    phase: "Starting…",
    percent: 0,
    error: null,
    costUsd: 0,
    createdAt: t,
    updatedAt: t,
  };
  jobs.set(job.id, job);
  return job;
}

/** Advance the job's phase label + monotonic percent. */
function progress(job: ScriptJob, phase: string, percent: number): void {
  job.phase = phase;
  job.percent = Math.max(job.percent, Math.min(100, Math.round(percent)));
  job.costUsd = Number(scriptgenUsageTotal().costUsd.toFixed(4));
  job.updatedAt = Date.now();
}

export function getScriptSnapshot(jobId: string): ScriptJobSnapshot | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    jobId: job.id,
    runId: job.runId,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    error: job.error,
    costUsd: job.costUsd,
  };
}

/**
 * Confirm the type/title checkpoint and launch Stages 1–7 as a background job.
 * Returns synchronously; the heavy work runs fire-and-forget in runScript().
 */
export function continueScript(runId: string, setup: ScriptSetup): { jobId: string; runId: string } {
  const run = getRun(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Script run not found." });
  // Without this, calling continue twice launches two background jobs writing to
  // the same row — the second silently overwrites the first, and both bill Opus.
  // A failed run may be resumed: every stage it already paid for is persisted,
  // and runScript skips whatever is present. A completed or running one may not.
  if (run.status !== "awaiting_confirmation" && run.status !== "failed") {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `This script is already ${run.status}; it cannot be started again.`,
    });
  }
  updateRun(runId, { setup, title: setup.title, videoType: setup.videoType, status: "running" });
  const job = createJob(runId);
  void runScript(job.id, runId, setup, run.input, run.stage0);
  return { jobId: job.id, runId };
}

// ── Outline section parsing ───────────────────────────────────────────────────

interface OutlineSection {
  name: string;
  text: string;
}

/** Turn a "#### ⏱️ SECTION (timestamp)" header line into a short section name. */
function cleanSectionName(header: string): string {
  return (
    header
      .replace(/^#+/, "")
      .replace(/⏱️/g, "")
      .replace(/[️⏱]/g, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim() || "Section"
  );
}

/**
 * Split the Stage 2 outline into draftable sections by its "####" headers,
 * dropping the HOOK section (Stage 3 owns it) and any trailing WRAP-UP/CTA
 * section (Stage 6 owns it). If the outline has no headers, the whole thing
 * (minus a HOOK header block if present) is treated as one section.
 */
function parseOutlineSections(outline: string): OutlineSection[] {
  const text = outline.trim();
  if (!text) return [];
  const lines = text.split("\n");
  const headerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Models emit section headers as level 2–4 markdown headers (##/###/####),
    // not always ####. Split on any of them; noise headers are filtered below.
    if (/^\s*#{2,4}\s/.test(lines[i])) headerIdx.push(i);
  }
  if (headerIdx.length === 0) {
    return [{ name: "Main content", text }];
  }

  const raw: { name: string; text: string; bodyLen: number }[] = [];
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h];
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1] : lines.length;
    const block = lines.slice(start, end).join("\n").trim();
    const bodyLen = lines.slice(start + 1, end).join("\n").trim().length;
    raw.push({ name: cleanSectionName(lines[start]), text: block, bodyLen });
  }

  // Drop non-script headers: the outline title (starts with a quote), the
  // hook (Stage 3), production/thumbnail/title-option notes, and near-empty
  // container headers (e.g. a bare "STEP-BY-STEP BUILD" whose steps follow as
  // their own sub-headers).
  const droppable = (s: { name: string; bodyLen: number }): boolean =>
    /hook/i.test(s.name) ||
    /video outline|production notes?|thumbnail|title options?|📹/i.test(s.name) ||
    s.name.startsWith('"') ||
    s.bodyLen < 40;
  const filtered = raw.filter((s) => !droppable(s));
  // Drop trailing wrap-up / CTA / outro sections (Stage 6 owns the close).
  while (filtered.length && /wrap.?up|cta|call to action|outro/i.test(filtered[filtered.length - 1].name)) {
    filtered.pop();
  }

  if (filtered.length > 0) return filtered.map((s) => ({ name: s.name, text: s.text }));
  // Everything got filtered — fall back to the whole outline minus any hook block.
  const nonHook = raw.filter((s) => !/hook/i.test(s.name));
  if (nonHook.length > 0) {
    return [{ name: "Main content", text: nonHook.map((s) => s.text).join("\n\n") }];
  }
  return [{ name: "Main content", text }];
}

/** Cumulative percent at the START of section i (spread 55→85 across N sections). */
function sectionStartPercent(i: number, total: number): number {
  if (total <= 0) return 55;
  return 55 + Math.round((i / total) * 30);
}

/** "1m 42s" / "12m 03s" — human-readable wall-clock duration. */
function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}

// ── Injected context blocks ───────────────────────────────────────────────────
// These are appended/prepended to the stage prompts at call time rather than
// edited into the .md files. The prompts are proven; these carry the one thing
// the model cannot know on its own (what day it is) and the one thing the
// pipeline structurally hides from it (what the other sections already said).

/** "July 10, 2026" — the model has no clock, and every stage prompt asks for currency. */
function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Prepended to Stage 1. The research prompt asks for "the last 6 months" — of what? */
function researchDateBlock(today: string): string {
  return [
    `TODAY'S DATE IS ${today}.`,
    "",
    "Your training data is older than today, and this topic moves. Pricing, plan tiers, credit costs, free-trial terms, feature availability, version numbers, and the tool's actual interface must come from a web search you run right now — never from memory, and never from what seems reasonable.",
    "",
    `Next to every price, tier, credit cost, version number, and statistic you report, write the date it was verified, like this: "€20/month (verified ${today})". If a source is older, give the source's date instead.`,
    "",
    "If a search cannot confirm a detail, write that you could not confirm it. A gap you flag is useful. A gap you fill from memory is how a script ends up telling a hundred thousand people to click a button that no longer exists.",
  ].join("\n");
}

/**
 * Only Tool Reviews get the three-build shape. Jake's approved Tutorial walks
 * one build (or a set of topic blocks); a roundup can't be three stories without
 * ceasing to be a roundup; and no approved Business Guide or Opinion exists to
 * generalise from.
 */
const STORY_TYPES = new Set<VideoType>(["Tool Review"]);

/**
 * Prepended to Stage 2 for how-do-I-use-this videos. Overrides the format menu
 * in stage2-outline.md, which defaults a Tool Review to a feature-by-feature
 * breakdown plus a cons section plus a verdict — three things the audience
 * doesn't watch for. The viewer wants to see the tool used for their benefit.
 *
 * Also pins the header depth: the outline's `###` sub-headers are what turned
 * one "FEATURE-BY-FEATURE BREAKDOWN" section into six drafted sections.
 */
function storyStructureBlock(wordBudget: number): string {
  const perStory = Math.round((wordBudget * 0.62) / 3 / 50) * 50;
  return [
    "## SCRIPT STRUCTURE — this overrides the format section below",
    "",
    "Whatever format the instructions further down propose for this video type, the body of this script has exactly six sections, in this order:",
    "",
    "1. **INTRO** — short. Who this is for and what they're about to watch happen.",
    "2. **STORY ONE — a use case, built on screen**",
    "3. **STORY TWO — a different use case, built on screen**",
    "4. **STORY THREE — a third use case, built on screen**",
    "5. **PRICING** — what it costs, how the billing model actually works, and where a person gets surprised by a bill.",
    "6. **HONEST THOUGHTS** — very short. Thirty seconds at most.",
    "",
    "### What a story is",
    "",
    "A story is one concrete use case, taken from somebody's real problem all the way to a working result — and **built on screen, step by step**. Three stories means three separate builds. Not one build shown three ways. Not three features described. Three times the viewer watches a thing get made.",
    "",
    "Inside a story: the problem a real person has, then the build. The build is actual steps — what to click, what to type, what to set, in order, specific enough that someone can follow along with their own account open. The features appear because this build needs them; the viewer meets a feature by watching it get used, never as an item on a list.",
    "",
    "Pick three use cases far enough apart that the viewer sees the range of the tool. A lead finder, a price tracker, a weekly report — three different jobs, three different builds.",
    "",
    `Each story gets roughly **${perStory} words**. That's enough for the problem, the build, and the payoff — so don't pad, and don't cut the steps.`,
    "",
    "The honest caveats live INSIDE the stories, at the moment they're earned — when the build gets expensive, when a step is fiddly, when something didn't work the first time. One or two sentences, then back to the work.",
    "",
    "### What this script does NOT have",
    "",
    "- No feature-by-feature breakdown, feature tour, or numbered feature list. If a feature doesn't earn its place inside a build, it doesn't go in the video.",
    "- No pros-and-cons section. No cons section. No 'the honest truth' section.",
    "- No final verdict, no scorecard, no 'who should buy this' summary.",
    "",
    "### The honest-thoughts section",
    "",
    "Thirty seconds. Jake's actual take, said once, plainly, the way you'd answer a friend who asked 'so is it any good?'. It is NOT a balanced weighing of pros against cons, and it is not a list of anything. A couple of sentences on what genuinely impressed him and one on what he'd want to see improve. Then stop.",
    "",
    "### Header rules (these matter)",
    "",
    "Use a `##` header for each of the six sections above, and for the hook and the wrap-up. Do NOT use `###` or `####` sub-headers anywhere inside a section — the steps inside a build are written as prose and numbered inline, not as their own headers. A sub-header inside a story gets drafted as if it were its own section of the video, which breaks the script.",
  ].join("\n");
}

/**
 * Appended to Stage 6. The outro prompt's MKBHD pattern is itself an honest-
 * thoughts beat, and the script now has a dedicated (short) one right before it.
 * Without this the video says its take twice.
 */
function outroNoVerdictBlock(videoType: VideoType, sponsored: boolean, sponsorName: string): string {
  void videoType;
  return [
    "",
    "",
    "---",
    "",
    "## THE OUTRO PATTERN ABOVE IS OUT OF DATE — USE THIS ONE",
    "",
    "Jake's approved scripts don't close on the MKBHD honest-enthusiasm beat. By the time the outro arrives, the honest take has already happened earlier in the video. Do not give it again: no 'my take so far is', no 2–3 specific wins, no verify-later pact.",
    "",
    "Write the close in this order, skipping anything that doesn't apply:",
    "",
    sponsored
      ? `1. **The ${sponsorName} link.** It's free to start (if it is) — tell them where to go. One or two sentences, warm, no pressure.`
      : "1. **Skool** — only if this video referenced prompts, templates, or resources people would want. One soft sentence, link's in the description. Skip it entirely otherwise.",
    "2. **Social** — follow on TikTok and Instagram, because Jake posts short clips there he doesn't put on YouTube. Links in the description.",
    "3. **The bell** — click the notification bell so they catch the next one the second it goes up.",
    "4. **The comment prompt** — a real question about THIS video's topic, the kind Jake would actually want answered. \"Which of these would you build first?\" He reads every one.",
    "",
    "STOP THERE. Do NOT write a sign-off, do NOT tease the next video, do NOT say what's coming up, do NOT say \"thanks for watching\" or \"see you\". A fixed closing line is added automatically after your outro — anything you write along those lines will be deleted. End on the comment prompt.",
    "",
    "Keep the whole thing under about 160 words. Warm, quick, no lingering.",
  ].join("\n");
}

/**
 * Appended to Stage 7. Stage 7 REWRITES the script against its checklist, and
 * that checklist asks "honest thoughts included?" — which is exactly how a
 * deleted verdict section grows back on the last pass.
 */
function reviewStructureGuard(videoType: VideoType): string {
  if (!STORY_TYPES.has(videoType)) return "";
  return [
    "",
    "",
    "---",
    "",
    "STRUCTURE IS DELIBERATE — DO NOT 'FIX' IT.",
    "",
    "This script is built as three use-case stories, then pricing, then a very short honest-thoughts beat. That is the intended shape. When the checklist above asks whether honest thoughts are included, the short honest-thoughts beat satisfies it — as do the caveats woven inside the stories.",
    "",
    "Do not add a pros-and-cons section. Do not add a cons section. Do not add a final verdict, a scorecard, or a 'who should buy this'. Do not expand the honest-thoughts beat beyond about thirty seconds, and do not turn it into a balanced weighing of good against bad. Do not reorganise the stories into a feature list.",
    "The script ends with a fixed closing line (\"Thanks so much for hanging out… See you there.\"). Leave it exactly as it is. Do not tease the next video's topic, do not add or change the sign-off.",
    "",
    "Fix voice, clarity, accuracy, and reading level. Leave the architecture alone.",
  ].join("\n");
}

/** Prepended to Stage 2. The outline is the only thing Stage 5 gets to see. */
function outlineFidelityBlock(today: string, budget: number): string {
  return [
    `TODAY'S DATE IS ${today}.`,
    "",
    `TARGET LENGTH: about **${budget} words** of spoken script — roughly ${Math.round(budget / 150)} minutes. Build an outline that fits in that. Timestamps in the template below are illustrative; this word count is the real constraint.`,
    "",
    "The section writer who works from this outline will see NOTHING ELSE except a fact sheet — not the research, not the sources. So every exact price, exact click path, exact setting, and exact number that belongs in the finished script has to be carried into this outline verbatim, with its verification date. Do not round them, do not summarize them into 'affordable' or 'a few clicks'. Copy them.",
    "",
    "Where the research could not confirm something, leave it out of the outline rather than smoothing over the gap.",
  ].join("\n");
}

/**
 * Appended to the CTA pass for sponsored videos. The sponsor's offer/link belongs
 * in exactly two places — once early, once at the close — and nowhere else. The
 * rules alone weren't enough: one run said "free to start, no card" five times in
 * the body, which reads as an ad rather than a recommendation.
 */
function sponsorCapBlock(sponsored: boolean, sponsorName: string): string {
  if (!sponsored) return "";
  return [
    "",
    "---",
    "",
    `## SPONSOR PROMOTION — HARD CAP (this is a sponsored video for ${sponsorName})`,
    "",
    `The ${sponsorName} offer and link ("free to start", "no card", "link's in the description", "sign up") may appear EXACTLY TWICE in the SCRIPT body: once in the first minute, and once at the very end. That's it.`,
    "",
    "Find every other place the offer or link is repeated in between and CUT it — delete the promotional clause and stitch the sentence back together so the surrounding content still flows. The value of the tool should carry the video; the plug is a light touch at each end, not a drumbeat.",
    "",
    "This does NOT touch Jake's own asks — the like, the comment, the Skool link, the TikTok/Instagram follow, the notification bell all stay. Only the SPONSOR's repeated offer/link gets trimmed to two.",
    "",
    "In the NOTES block, say how many sponsor plugs you removed.",
  ].join("\n");
}

/** Appended to every Stage 5 draft. Overrides "ONLY use information from the outline". */
function factSheetBlock(factSheet: string): string {
  return [
    "",
    "---",
    "",
    "## FACT SHEET — authoritative for every checkable detail",
    "",
    "Everything above tells you HOW to write. This tells you WHAT IS TRUE. It overrides the last line of the instructions above: the outline and this fact sheet together are your sources.",
    "",
    "Where the fact sheet gives an exact price, click path, version, or number, use it exactly as written, including its verification date where saying the date out loud sounds natural. Never invent a price, a menu name, a button label, or a statistic that appears in neither the outline nor the fact sheet. If a step you need isn't in either, describe the goal instead of naming a control that may not exist — say \"open the settings for that agent\", not \"click the gear icon in the top right\".",
    "",
    "Anything under DO NOT CLAIM must not appear in the script in any form.",
    "",
    factSheet,
  ].join("\n");
}

/**
 * The refine chat's context: the finished script plus every review that ran over
 * it. A hand-edit has to stay consistent with the rest of the video and must not
 * undo a decision a review already made, so the whole script and the review
 * artifacts (Stage 7 notes, the claim audit, the brief check) go into the
 * system prefix. Byte-stable across a thread, so it caches.
 */
function scriptAndReviewsBlock(run: ScriptRunResult): string {
  const s = run.stages;
  const lines: string[] = [
    "",
    "---",
    "",
    "## THE FINISHED SCRIPT",
    "",
    "This is the whole video as it was generated and reviewed. The paragraph Jake pastes is lifted from here. Rewrite it so it still fits this script — don't repeat a point another paragraph already makes, keep the running voice and threads, and match the surrounding pace.",
    "",
    run.finalDocument ?? "(no assembled document)",
  ];

  const reviewParts: string[] = [];
  if (s.reviewNotes.length) {
    reviewParts.push(
      "### Final voice/craft review — what the review pass already changed, and why\n" +
        s.reviewNotes.map((n) => `- ${n}`).join("\n"),
    );
  }
  if (s.claimAudit) {
    const a = s.claimAudit;
    const auditLines: string[] = [];
    if (a.unsupportedNumbers.length) auditLines.push(`Numbers with no source: ${a.unsupportedNumbers.join(", ")}`);
    if (a.bannedWords.length) auditLines.push(`Banned words/phrasings flagged: ${a.bannedWords.join("; ")}`);
    if (a.experienceClaims.length) auditLines.push(`Invented first-person experience flagged: ${a.experienceClaims.join("; ")}`);
    if (a.excessSponsorPlugs.length) auditLines.push(`Over-promotion flagged (2 plugs allowed): ${a.excessSponsorPlugs.join("; ")}`);
    if (a.fencedTopicsMentioned.length) auditLines.push(`Fenced topics mentioned: ${a.fencedTopicsMentioned.join(", ")}`);
    if (auditLines.length) {
      reviewParts.push(
        "### Claim audit — issues the fact-check raised\n" +
          auditLines.map((l) => `- ${l}`).join("\n") +
          "\nDon't reintroduce any of these when you rewrite.",
      );
    }
  }
  if (s.briefCheck) {
    const b = s.briefCheck;
    const bl = [`Brief coverage scored ${b.score}/100 — ${b.verdict}`];
    if (b.gaps.length) bl.push(`Deliberately left out (don't force back in): ${b.gaps.join("; ")}`);
    reviewParts.push("### Brief adherence review\n" + bl.map((l) => `- ${l}`).join("\n"));
  }

  if (reviewParts.length) {
    lines.push(
      "",
      "---",
      "",
      "## THE REVIEWS MADE ON THIS SCRIPT",
      "",
      "These passes already ran over the finished script. Honor their decisions — your rewrite must not undo a fix or bring back something a review removed.",
      "",
      reviewParts.join("\n\n"),
    );
  }

  return lines.join("\n");
}

/**
 * Appended to every Stage 5 draft after the first. Each section is drafted in its
 * own API call, so without this the model cannot see the rest of the video — and
 * every section independently reaches for the top of the same phrase menus.
 */
function continuityBlock(
  index: number,
  total: number,
  sectionsDone: string[],
  ledger: ContinuityLedger,
  sectionWords: number,
): string {
  const lines: string[] = [
    "",
    "---",
    "",
    `## CONTINUITY — this is section ${index + 1} of ${total}`,
    "",
    `Write roughly **${sectionWords} words** for this section. That's a budget, not a suggestion — the video has a runtime to hit, and every section that overruns steals from the ones after it.`,
    "",
  ];

  if (sectionsDone.length > 0) {
    lines.push(
      `Already covered, in order: ${sectionsDone.join(" → ")}.`,
      "Don't re-explain any of it. If you need to lean on something from an earlier section, refer back in half a sentence and move on.",
      "",
    );
  }

  if (ledger.overusedPhrases.length > 0) {
    lines.push(
      "You've now used each of these three or more times. That's past a rhythm and into a habit. Say these another way — not because repeating yourself is bad, but because these specific ones are spent:",
      ledger.overusedPhrases.map((s) => `- ${s}`).join("\n"),
      "",
    );
  }

  lines.push(
    "## RHYTHM — this is what decides whether it sounds spoken",
    "",
    "Repeating yourself is fine. Jake says \"let me show you\" eight times in one tutorial, because it's the beat that resets the viewer before each demo. Don't avoid a phrase just because you already used it. Anchor phrases that recur are how a script coheres.",
    "",
    "What makes a script sound machine-written is every sentence being the same length. So vary them, hard. A three-word sentence slammed up against a thirty-word one that doubles back on itself the way people do when they're working something out while they're saying it. Then a short one. Then a fragment.",
    "",
    "Jake's approved scripts measure about 0.7 on sentence-length variation. Scripts that read as machine-made sit near 0.58. That gap is entirely in the mix, never in the average — his tutorial averages eight words a sentence and his review averages fourteen, and both sound like a person, because both swing.",
    "",
    "\"Now,\" \"So,\" \"Alright,\" \"Look,\" \"And,\" \"But,\" \"Honestly\" — the little words people open sentences with — are the connective tissue of speech. Use them freely.",
    "",
    "Read it back as speech before you finish. If it sounds written-to-be-read rather than said out loud, rewrite it.",
  );

  return lines.join("\n");
}

/**
 * Appended to the Stage 5 review call. The review already rewrites each section
 * for clarity and reading level — it is the second-cheapest place in the whole
 * pipeline to also fix repetition and unsupported numbers, because it costs no
 * additional call. It was previously doing that work blind: it saw neither what
 * the rest of the video had already said, nor what the research established.
 */
function reviewGuardBlock(ledger: ContinuityLedger, hasFactSheet: boolean): string {
  const lines: string[] = ["", "---", ""];
  const bullets = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

  if (ledger.overusedPhrases.length > 0) {
    lines.push(
      "While you rewrite, retire these. Each has already been used three or more times across the video — past a rhythm, into a habit. Change this section's wording, not its meaning:",
      bullets(ledger.overusedPhrases),
      "",
      "Repetition itself is fine and Jake relies on it. Only these specific over-used phrases need changing, and the little opening words (\"Now,\" \"So,\" \"Alright,\") never do.",
      "",
    );
  }

  lines.push(
    "Do not shorten sentences to hit the reading level. Reading level is about VOCABULARY — everyday words, no jargon. It is not about sentence length. Long, winding, spoken-sounding sentences are correct and should survive your edit.",
    "",
    "Banned words — rewrite any of these out of this section: \"caveat\" (say \"the catch is\"), \"clever\" (say what it does), \"which\" (split the sentence or use \"that\"), \"whether\" (say \"if\"). Say \"Imagine …\" never \"Picture …\". And never a bare clipped question like \"No door?\" — lead with the little word a person would say: \"And if there's no door?\"",
    "",
    "Vary sentence length hard: three words, then thirty, then a fragment. Uniform sentence length is what makes a script sound machine-read.",
    "",
  );

  if (hasFactSheet) {
    lines.push(
      "Every price, number, version, and click path in this section must already appear in the FACT SHEET in your system prompt. If this section states a figure that isn't there, don't smooth it over — cut it, or replace it with the figure the fact sheet gives. Never round a price into a nicer number. Never name a button the fact sheet doesn't name.",
      "",
    );
  }

  lines.push("Output ONLY the rewritten section, as before. No commentary.");
  return lines.join("\n");
}

/**
 * Appended to Stage 7. Its checklist still asks "no competitor references?" and
 * "no income claims?" in their old, absolute form — and Stage 7 REWRITES the
 * script against that checklist. Without this, it strips exactly the lines the
 * amended rules now permit.
 */
function reviewRuleGuard(sponsored: boolean): string {
  return [
    "",
    "",
    "---",
    "",
    "HOW TO READ TWO ITEMS ON THAT CHECKLIST:",
    "",
    sponsored
      ? '**Competitors.** This video IS sponsored, so the old rule stands in full: no competing tool may be named, in any way. Mark noPunchSideways false and remove the line if one appears.'
      : '**Competitors.** This video is NOT sponsored, so naming a competing tool is allowed and often useful ("you\'ll still want Figma for the final version"). Do NOT remove such a line, and do NOT mark noPunchSideways false for it. That item now means contempt — "better than X", sneering, making another tool the punchline. Naming is not punching.',
    "",
    '**Income claims.** The rule bans promising the VIEWER money they will earn — "this can make you thousands," "$5k a month." It does NOT ban talking about cost or savings. "This would otherwise cost you thousands" and "it saved me a week of work" are fine and must not be removed.',
    "",
    "**Credentials.** One sentence of Jake's background, stated once and moved past, is allowed — even in the hook. Only remove it if it runs on, or if it comes back a second time.",
    "",
    "**Punching down still fails, always.** Any line that positions the viewer, or people like them, as the ones doing it wrong — cut it and mark noPunchDown false.",
    sponsored
      ? "**Sponsor plug cap.** The sponsor's offer/link (\"free to start\", \"no card\", \"link in the description\") may appear at most TWICE — once early, once at the close. If you see it more often, remove the extra ones; do NOT add any, even if the brief asked for several CTAs. Two is the ceiling."
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * Stage 7 returns a checklist of eight booleans on every run. It used to be
 * parsed and thrown away. Anything missing or non-boolean reads as a fail —
 * an absent answer is not a pass.
 */
function coerceChecklist(raw: unknown): ReviewChecklist | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const b = (k: string): boolean => c[k] === true;
  return {
    shortHook: b("shortHook"),
    largeMeat: b("largeMeat"),
    fourteenYearOld: b("fourteenYearOld"),
    noPunchSideways: b("noPunchSideways"),
    noPunchDown: b("noPunchDown"),
    welcomeAtHookEnd: b("welcomeAtHookEnd"),
    noIncomeClaims: b("noIncomeClaims"),
    demosNotDescribes: b("demosNotDescribes"),
    leanOpen: b("leanOpen"),
    noSectionAnnouncement: b("noSectionAnnouncement"),
    toolNamedNotVague: b("toolNamedNotVague"),
  };
}

// ── Stage 6.5 brief adherence ─────────────────────────────────────────────────

/** Parse the Stage 6.5 JSON, apply its edits (see edits.ts), and summarize. Never throws. */
function runBriefEdits(raw: string, script: string): { script: string; check: BriefCheck } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  } catch {
    return {
      script,
      check: {
        score: 0,
        verdict: "Brief adherence check could not be parsed; the script was left unchanged.",
        gaps: [],
        editsApplied: [],
        editsSkipped: [],
      },
    };
  }

  const rawScore = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const { script: edited, applied, skipped } = applyBriefEdits(script, parsed.edits);

  return {
    script: edited,
    check: {
      score,
      verdict:
        typeof parsed.verdict === "string" && parsed.verdict.trim()
          ? parsed.verdict.trim()
          : "No verdict returned.",
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g): g is string => typeof g === "string") : [],
      editsApplied: applied,
      editsSkipped: skipped,
    },
  };
}

// ── The full run (background, never throws) ───────────────────────────────────

async function runScript(
  jobId: string,
  runId: string,
  setup: ScriptSetup,
  input: ScriptInput,
  stage0: Stage0Result | null,
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  // Resume: every stage already persisted was already paid for. Never buy it
  // twice. A prompt runs once per run row, and a failure costs only the stages
  // that hadn't landed yet.
  const priorRun = getRun(runId);
  const prior = priorRun?.stages;
  const stages: ScriptStages = {
    research: null,
    sources: [],
    factSheet: null,
    outline: null,
    hooks: null,
    sponsorSegment: null,
    sections: [],
    outro: null,
    hooksWithCta: null,
    ctaScript: null,
    ctaNotes: [],
    briefCheck: null,
    reviewNotes: [],
    reviewChecklist: null,
    quality: null,
    claimAudit: null,
  };
  const runStartedAt = Date.now();
  const priorGenerationMs = priorRun?.generationMs ?? 0;
  if (prior) {
    stages.research = prior.research;
    stages.sources = prior.sources ?? [];
    stages.factSheet = prior.factSheet;
    stages.outline = prior.outline;
    stages.hooks = prior.hooks;
    stages.sponsorSegment = prior.sponsorSegment;
    stages.sections = Array.isArray(prior.sections) ? [...prior.sections] : [];
    stages.outro = prior.outro;
    const done = [
      prior.research && "research",
      prior.factSheet && "fact sheet",
      prior.outline && "outline",
      prior.hooks && "hooks",
      prior.sections?.length ? `${prior.sections.length} section(s)` : null,
      prior.outro && "outro",
    ].filter(Boolean);
    if (done.length) console.log(`[scriptgen] resuming run ${runId}; already paid for: ${done.join(", ")}`);
  }

  const persist = () => updateRun(runId, { stages });
  // The spend cap is per run, not per process.
  resetScriptgenUsage();

  try {
    const videoType = setup.videoType;
    const title = setup.title;
    // Competitor mentions are allowed on organic videos and banned on sponsored
    // ones — the single rule that flips per video rather than per writer.
    const sponsored = (setup.sponsorship?.mode ?? "organic") !== "organic";
    const preamble = (withShrapnel: boolean) => systemPreamble(withShrapnel, sponsored);
    const targetLength = (setup.targetLength || "").trim() || "10–12 minutes minimum";
    const sponsorLabel = sponsorshipLabel(setup.sponsorship);
    // Anchored on Jake's approved scripts: a review lands at ~2,200 words and a
    // tutorial ~1,800. A list is sized by how many good items it has, not by a
    // runtime. "12 minutes minimum" was being read as a floor with no ceiling —
    // that is how a review reached 5,673 words.
    // The item count is Stage 0's judgement on the idea and brief. It is never
    // read off the title — a title is written to be clicked, not to be true.
    const budget = wordBudget(videoType, targetLength, stage0?.itemCount ?? null);

    const today = todayLabel();

    // ── Stage 1 — RESEARCH (live web) ──
    // Research runs ONCE per run row, ever. It is the single most expensive call
    // in the pipeline (web search + adaptive thinking), and it is already
    // persisted after it completes. If a later stage failed and this run is being
    // started again, reuse what was bought rather than buying it twice.
    if (!stages.research) {
    progress(job, "Researching the web…", 10);
    const s1 = fill(loadPrompt("stage1-research"), {
      "[SELECT ONE: Tutorial / List/Roundup / Tool Review / Business Guide / Opinion]": videoType,
      "[INSERT VIDEO TITLE HERE]": title,
      "[What specifically needs research - tool name, concept, strategy, etc.]": setup.coreTopic,
      "[INSERT TYPE]": videoType,
      "[INSERT WHAT TO RESEARCH]": setup.coreTopic,
      "[INSERT ANY SPECIFIC ANGLES OR QUESTIONS TO ANSWER]": setup.specificFocus || "(none specified)",
      "[Current date]": today,
    });
    stages.research = await opusScriptChat({
      system: preamble(false),
      messages: [{ role: "user", content: `${researchDateBlock(today)}\n\n---\n\n${s1}` }],
      webSearch: true,
      maxTokens: 16000,
      label: "stage1-research",
      sinkSources: stages.sources,
      purpose: "scriptgen",
    });
    persist();
    }

    // ── Stage 1.5 — FACT SHEET ──
    // The outline compresses; the section writer is told to use the outline only.
    // Anything checkable that the outline drops has to survive somewhere, or the
    // writer fills the hole from memory. This is that somewhere.
    if (!stages.factSheet) {
    progress(job, "Pulling out the checkable facts…", 22);
    const s15 = fill(loadPrompt("stage1.5-factsheet"), {
      "[TODAY'S DATE]": today,
      "[INSERT TITLE]": title,
      "[PASTE THE RESEARCH]": stages.research ?? "",
    });
    stages.factSheet = await opusScriptChat({
      system: preamble(false),
      messages: [{ role: "user", content: s15 }],
      maxTokens: 8000,
      thinking: false, // copying facts out of a document; nothing to reason about
      label: "stage1.5-factsheet",
      purpose: "scriptgen",
    });
    persist();
    }

    // ── Stage 2 — OUTLINE ──
    if (!stages.outline) {
    progress(job, "Building the outline…", 30);
    const s2 = fill(loadPrompt("stage2-outline"), {
      "[SELECT ONE: Tutorial / List/Roundup / Tool Review / Business Guide / Opinion]": videoType,
      "[INSERT VIDEO TITLE HERE]": title,
      [STAGE2_RESEARCH_BLOCK]: stages.research ?? "",
    });
    stages.outline = await opusScriptChat({
      system: preamble(false),
      messages: [
        {
          role: "user",
          content: [
            ...(STORY_TYPES.has(videoType) ? [storyStructureBlock(budget)] : []),
            outlineFidelityBlock(today, budget),
            s2,
          ].join("\n\n---\n\n"),
        },
      ],
      maxTokens: 16000,
      label: "stage2-outline",
      purpose: "scriptgen",
    });
    persist();
    }

    // ── Stage 3 — ALL FOUR HOOKS ──
    if (!stages.hooks) {
    progress(job, "Writing all four hooks…", 45);
    const s3 = fill(loadPrompt("stage3-hooks"), {
      "[Tutorial / Tool Review / Business Guide / Opinion / Listicle / Roundup]": videoType,
      "[Whole-video sponsorship — sponsor name / Mid-roll segment — sponsor name / Organic]": sponsorLabel,
      "[Whole-video sponsored — sponsor name / Mid-roll segment sponsored — sponsor name / Organic]": sponsorLabel,
      "[Confirm 10-12+ minutes — default for all Jake Dawson videos]": targetLength,
      "[paste from Stage 2]": stages.outline ?? "",
    });
    stages.hooks = await opusScriptChat({
      system: preamble(false),
      messages: [{ role: "user", content: s3 }],
      maxTokens: 16000,
      label: "stage3-hooks",
      purpose: "scriptgen",
    });
    persist();
    }

    // ── Stage 4 — SPONSOR SEGMENT (mid-roll only) ──
    if (setup.sponsorship?.mode === "mid-roll" && !stages.sponsorSegment) {
      progress(job, "Writing the sponsor segment…", 50);
      const s4 = fill(loadPrompt("stage4-sponsor"), {
        "[INSERT SPONSOR]": (setup.sponsorship.sponsorName || "the sponsor").trim() || "the sponsor",
        "[INSERT TITLE]": title,
        "[INSERT CONTEXT FROM THE OUTLINE]": stages.outline ?? "",
      });
      stages.sponsorSegment = await opusScriptChat({
        system: preamble(false),
        messages: [{ role: "user", content: s4 }],
        purpose: "scriptgen",
      });
      persist();
    }

    // ── Stage 5 — SECTIONS (draft + 14-year-old review pass) ──
    const sectionOutlines = parseOutlineSections(stages.outline ?? "");
    const total = sectionOutlines.length;
    const alreadyDrafted = stages.sections.length;
    if (alreadyDrafted > 0) {
      console.log(`[scriptgen] ${alreadyDrafted}/${total} sections already written — skipping those`);
    }
    for (let i = alreadyDrafted; i < total; i++) {
      const sec = sectionOutlines[i];
      progress(job, `Writing section ${i + 1}/${total}…`, sectionStartPercent(i, total));

      // The two things the section writer is otherwise blind to: what's true
      // (the fact sheet), and what the rest of the video already said (the ledger).
      const ledger = buildContinuityLedger(stages.sections.map((s) => s.final));
      // Spend the budget evenly across the drafted sections. The hook and outro
      // are written by their own stages and aren't drawn from this pot.
      const sectionWords = Math.max(150, Math.round((budget * 0.85) / total / 25) * 25);
      const draftPrompt =
        fill(loadPrompt("stage5-section"), {
          "[PASTE THE SECTION YOU'RE WORKING ON]": sec.text,
        }) + continuityBlock(i, total, stages.sections.map((s) => s.name), ledger, sectionWords);

      const draft = await opusScriptChat({
        system: preamble(true),
        // Byte-stable across every section, so the cache prefix actually engages.
        systemExtra: stages.factSheet ? [factSheetBlock(stages.factSheet)] : [],
        messages: [{ role: "user", content: draftPrompt }],
        maxTokens: 16000,
        label: `stage5-draft-${i + 1}`,
        purpose: "scriptgen",
      });
      const reviewPrompt =
        fill(loadPrompt("stage5-review"), { "[PASTE SECTION]": draft }) +
        reviewGuardBlock(ledger, Boolean(stages.factSheet));
      const final = await opusScriptChat({
        system: preamble(false),
        // Same cached prefix as the draft call, so the fact sheet the review now
        // checks against is read from cache rather than re-sent at full price.
        systemExtra: stages.factSheet ? [factSheetBlock(stages.factSheet)] : [],
        messages: [{ role: "user", content: reviewPrompt }],
        maxTokens: 16000,
        thinking: false, // reading-level rewrite + de-duplication; no judgement call
        label: `stage5-review-${i + 1}`,
        purpose: "scriptgen",
      });
      stages.sections.push({ name: sec.name, draft, final });
      persist();
    }

    // ── Stage 6 — OUTRO ──
    if (!stages.outro) {
    progress(job, "Writing the outro…", 88);
    const s6 = fill(loadPrompt("stage6-outro"), {
      "[INSERT TYPE]": videoType,
      "[INSERT TITLE]": title,
      "[PASTE OUTLINE]": stages.outline ?? "",
    });
    stages.outro = await opusScriptChat({
      system: preamble(false),
      messages: [
        {
          role: "user",
          content: `${s6}${outroNoVerdictBlock(videoType, sponsored, setup.sponsorship?.sponsorName || "the sponsor")}`,
        },
      ],
      label: "stage6-outro",
      purpose: "scriptgen",
    });
    persist();
    }

    // ── Stage 5.5 — CTA PLACEMENT ──
    // Numbered 5.5 but runs AFTER the outro: Rule 4 strips the outro's trailing
    // comment prompt, so the pass has to see the end of the video. It also takes
    // the Stage 3 hooks, tagging the subscribe clause onto all four welcome
    // beats so whichever hook Jake picks already carries it.
    progress(job, "Placing calls to action…", 90);
    const baseHooks = stages.hooks ?? "";
    const sectionsBody = stages.sections.map((s) => s.final).join("\n\n");
    const baseScriptBody = `## SCRIPT\n\n${sectionsBody}\n\n## OUTRO\n\n${stages.outro ?? ""}`;
    const s55 = fill(loadPrompt("stage5.5-cta"), {
      "[ONE LINE — WHAT THIS VIDEO IS ABOUT]": `${title} — ${setup.coreTopic}`,
      "[PASTE THE FOUR HOOK OPTIONS FROM STAGE 3]": baseHooks,
      "[PASTE THE FULL DRAFTED SCRIPT — SECTIONS + OUTRO]": baseScriptBody,
    });
    const raw55 = await opusScriptChat({
      system: preamble(false),
      messages: [{ role: "user", content: s55 + sponsorCapBlock(sponsored, setup.sponsorship?.sponsorName || "the tool") }],
      maxTokens: 16000,
      label: "stage5.5-cta",
      purpose: "scriptgen",
    });
    const cta = parseCtaPass(raw55);
    // The pass is told to change as little as possible, so a large shrink means a
    // truncated or malformed response. Keep the pre-CTA text rather than ship a
    // gutted script — a missing CTA is recoverable, a missing section isn't.
    const ctaIntact =
      cta !== null &&
      cta.script.length >= baseScriptBody.length * 0.5 &&
      cta.hooks.length >= baseHooks.length * 0.5;
    if (cta && ctaIntact) {
      stages.hooksWithCta = cta.hooks;
      stages.ctaScript = cta.script;
      stages.ctaNotes = cta.notes;
    } else {
      stages.ctaNotes = ["CTA placement pass could not be applied; script assembled without it."];
    }
    persist();

    // ── Stage 6.5 — BRIEF ADHERENCE (only when the run carried a brief) ──
    // Scores how well the script delivers the brief, then patches it with
    // sentence-level edits applied by applyBriefEdits() — never a rewrite. Runs
    // before Stage 7 so the final voice review covers anything inserted here.
    let scriptBody = stages.ctaScript ?? baseScriptBody;
    const briefText = (input.brief || "").trim();
    if (briefText) {
      progress(job, "Checking the script against the brief…", 91);
      const s65 =
        fill(loadPrompt("stage6.5-brief"), {
          "[INSERT TITLE]": title,
          "[PASTE THE BRIEF]": briefText,
          "[PASTE THE FULL SCRIPT]": scriptBody,
        }) +
        (sponsored
          ? `\n\n---\n\nSPONSOR PLUG CEILING: this brief may ask for "2–3 CTAs" pointing at the sponsor link. The ceiling is TWO sponsor-offer/link mentions in the spoken body — one early, one at the close — because more reads as an ad. Do not add sponsor plugs to satisfy the brief; if the brief's CTA count conflicts with this, record it as a gap. Jake's own like/comment/subscribe/Skool/social asks are separate and unaffected.`
          : "");
      const raw65 = await opusScriptChat({
        system: preamble(false),
        messages: [{ role: "user", content: s65 }],
        maxTokens: 8000,
        label: "stage6.5-brief",
        purpose: "scriptgen",
      });
      const { script: edited, check } = runBriefEdits(raw65, scriptBody);
      scriptBody = edited;
      stages.briefCheck = check;
      persist();
    }

    // ── Assemble the document ──
    progress(job, "Assembling the document…", 93);
    const topPart =
      `# ${title}\n\n## HOOKS — pick one\n\n${stages.hooksWithCta ?? baseHooks}\n\n` +
      (stages.sponsorSegment ? `## SPONSOR SEGMENT (mid-roll)\n\n${stages.sponsorSegment}\n\n` : "");
    let finalDocument = topPart + scriptBody;
    updateRun(runId, { finalDocument });

    // ── Stage 7 — FINAL REVIEW (reviews the SCRIPT+OUTRO body, not the hooks) ──
    progress(job, "Final review pass…", 96);
    const s7 =
      fill(loadPrompt("stage7-review"), { "[PASTE FULL SCRIPT]": scriptBody }) +
      reviewStructureGuard(videoType) +
      reviewRuleGuard(sponsored);
    const raw7 = await opusScriptChat({
      system: preamble(false),
      messages: [{ role: "user", content: s7 }],
      maxTokens: 16000,
      label: "stage7-review",
      purpose: "scriptgen",
    });
    let reviewNotes: string[] = [];
    let reviewOk = false;
    try {
      const parsed = JSON.parse(extractJson(raw7)) as {
        revisedScript?: unknown;
        changes?: unknown;
        checklist?: unknown;
      };
      const revised =
        typeof parsed.revisedScript === "string" && parsed.revisedScript.trim()
          ? parsed.revisedScript
          : null;
      const changes = Array.isArray(parsed.changes)
        ? parsed.changes.filter((x): x is string => typeof x === "string")
        : [];
      // Stage 7 re-emits the WHOLE script inside a JSON string. If it hits the
      // token ceiling the JSON still parses sometimes, leaving a truncated
      // script — which would silently replace a complete one. A big shrink means
      // truncation, not editing: keep the unreviewed script and say so.
      const truncated = revised !== null && revised.length < scriptBody.length * 0.6;
      if (revised && !truncated) {
        finalDocument = topPart + revised;
        reviewNotes = changes;
        reviewOk = true;
      } else if (truncated) {
        reviewNotes = [
          `Final review returned a truncated script (${revised!.length} vs ${scriptBody.length} chars) — discarded; script kept as written.`,
        ];
      }
      stages.reviewChecklist = coerceChecklist(parsed.checklist);
    } catch {
      reviewOk = false;
    }
    if (!reviewOk && reviewNotes.length === 0) {
      reviewNotes = ["Final review could not be parsed; script assembled without automated fixes."];
    }
    stages.reviewNotes = reviewNotes;

    // Deliverable: Jake reads continuous prose. Strip the headers, beat markers,
    // and timestamps that made the artifact look like a spec — and that were
    // feeding phantom numbers into the claim audit.
    const spokenBody = ensureCanonicalOutro(toCleanProse(reviewOk ? finalDocument.slice(topPart.length) : scriptBody));
    const prompts = extractPrompts(spokenBody);
    const promptAppendix =
      prompts.length > 0
        ? "\n\n---\n\n## PROMPT SUMMARY (for the description / pinned comment)\n\n" +
          prompts.map((p) => `**${p.label}:** "${p.text}"`).join("\n\n")
        : "";
    finalDocument = `${topPart}## SCRIPT\n\n${spokenBody}${promptAppendix}`;
    if (prompts.length > 0) console.log(`[scriptgen:prompts] extracted ${prompts.length} copy-paste prompt(s)`);

    // Audit and measure the SCRIPT BODY, not the assembled document. The document
    // leads with four alternate hooks and their production notes ("listicles for
    // TV-friendly / 35+ audience"), which are neither spoken nor claims — counting
    // them inflates the repetition metric and invents audit findings.
    const auditedBody = spokenBody;

    // Deterministic fact check: does the script assert a number the research never
    // established, or touch a topic the fact sheet fenced off? No model call.
    stages.claimAudit = auditClaims(
      auditedBody,
      stages.factSheet ?? "",
      input.brief ?? "",
      stages.hooksWithCta ?? stages.hooks ?? "",
      sponsored ? setup.sponsorship?.sponsorName || "the sponsor" : "",
    );
    if (
      stages.claimAudit.unsupportedNumbers.length ||
      stages.claimAudit.fencedTopicsMentioned.length ||
      stages.claimAudit.experienceClaims.length ||
      stages.claimAudit.excessSponsorPlugs.length ||
      stages.claimAudit.bannedWords.length
    ) {
      console.warn(
        `[scriptgen:claims] unsupported=${JSON.stringify(stages.claimAudit.unsupportedNumbers)} ` +
          `fenced=${JSON.stringify(stages.claimAudit.fencedTopicsMentioned)} ` +
          `experience=${JSON.stringify(stages.claimAudit.experienceClaims)} ` +
          `excessPlugs=${stages.claimAudit.excessSponsorPlugs.length} ` +
          `banned=${JSON.stringify(stages.claimAudit.bannedWords.slice(0, 6))}`,
      );
    }

    // Measured, not modelled: how repetitive and how spoken the finished script is.
    stages.quality = scriptQuality(auditedBody);
    console.log(
      `[scriptgen:quality] words=${stages.quality.words} burstiness=${stages.quality.burstiness} ` +
        `repeatedPhrases=${stages.quality.repeatedPhraseCount} worst=${stages.quality.worstPhraseRepeats}x ` +
        `"${stages.quality.worstPhrase ?? ""}"`,
    );
    updateRun(runId, { stages, finalDocument });

    // ── Done ──
    const generationMs = priorGenerationMs + (Date.now() - runStartedAt);
    const spend = scriptgenUsageTotal();
    console.log(
      `[scriptgen:usage] TOTAL(run) calls=${spend.calls} in=${spend.input} out=${spend.output} ` +
        `cache_read=${spend.cacheRead} cache_write=${spend.cacheWrite} $${spend.costUsd.toFixed(2)} ` +
        `${(spend.ms / 1000).toFixed(0)}s api | ${fmtDuration(generationMs)} wall`,
    );
    console.log(`[scriptgen:time] run ${runId} completed in ${fmtDuration(generationMs)} (${generationMs} ms wall clock)`);
    progress(job, "Done", 100);
    job.status = "completed";
    job.costUsd = Number(spend.costUsd.toFixed(4));
    job.updatedAt = Date.now();
    updateRun(runId, { status: "completed", generationMs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const generationMs = priorGenerationMs + (Date.now() - runStartedAt);
    job.status = "failed";
    job.error = msg;
    job.costUsd = Number(scriptgenUsageTotal().costUsd.toFixed(4));
    job.updatedAt = Date.now();
    console.warn(
      `[scriptgen] run ${runId} failed after ${fmtDuration(generationMs)} and $${job.costUsd.toFixed(2)}: ${msg}`,
    );
    updateRun(runId, { status: "failed", error: msg, generationMs });
  }
}

// ── Paragraph refinement (post-generation chat) ───────────────────────────────
// After the script is done and copied into a doc, Jake edits by hand. When a
// paragraph needs work he pastes it here with what to change; we rewrite ONLY
// that paragraph, grounded in this run's own research + fact sheet and its voice
// system. Stateless per call: the stored thread is loaded, the new turn is
// appended, one Opus call runs, and the whole updated thread is persisted and
// returned. No web search — the answer is grounded strictly in what the run
// already researched.

/** Cap the stored/replayed thread so a long editing session can't grow unbounded. */
const MAX_REFINE_MESSAGES = 40;

export async function refineParagraph(
  runId: string,
  paragraph: string,
  instruction: string,
): Promise<{ messages: RefineMessage[]; costUsd: number }> {
  const instr = (instruction || "").trim();
  if (!instr) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Tell me what to change about the paragraph." });
  }
  const run = getRun(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Script run not found." });
  if (!run.setup) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "This script hasn't been set up yet." });
  }
  if (!run.finalDocument) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "This script hasn't finished generating yet." });
  }

  const thread = run.refineChat ?? [];
  const para = (paragraph || "").trim();
  if (thread.length === 0 && !para) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Paste the paragraph you want rewritten to start." });
  }

  // A fresh paragraph resets what "this paragraph" refers to; a bare instruction
  // keeps refining the one from the previous turn (the model has it in context).
  const userContent = para
    ? `PARAGRAPH TO REWRITE:\n"""\n${para}\n"""\n\nWHAT TO CHANGE:\n${instr}`
    : `WHAT TO CHANGE:\n${instr}`;

  const sponsored = (run.setup.sponsorship?.mode ?? "organic") !== "organic";
  const instructions = fill(loadPrompt("refine-paragraph"), {
    "[VIDEO TITLE]": run.setup.title,
    "[VIDEO TYPE]": run.setup.videoType,
    "[SPONSORSHIP]": sponsorshipLabel(run.setup.sponsorship),
  });

  // The finished script + its reviews + the fact sheet are byte-stable across a
  // thread, so they ride the cached system prefix (breakpoint on the last block)
  // instead of being resent at full price on every follow-up.
  const systemExtra = [
    scriptAndReviewsBlock(run),
    ...(run.stages.factSheet ? [factSheetBlock(run.stages.factSheet)] : []),
    instructions,
  ];

  const modelMessages = [...thread, { role: "user" as const, content: userContent, ts: 0 }].map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // A refine call is independent of any generation run's budget, so zero the
  // per-run tally first — otherwise a finished run's ~$2 spend could trip the
  // SCRIPTGEN_MAX_USD ceiling before this tiny call ever runs.
  resetScriptgenUsage();
  const reply = await opusScriptChat({
    system: systemPreamble(true, sponsored),
    systemExtra,
    messages: modelMessages,
    // Adaptive thinking bills as output and counts toward this cap, and a big
    // instruction ("fold this whole tutorial in") can burn the whole budget on
    // reasoning before a word of answer lands. 6000 was low enough to truncate
    // to an empty text block; give thinking real headroom over the paragraph.
    maxTokens: 16000,
    label: "refine-paragraph",
    purpose: "scriptgen",
  });
  const costUsd = Number(scriptgenUsageTotal().costUsd.toFixed(4));

  // An empty reply means the model hit the token ceiling on thinking and never
  // emitted text. Don't persist a blank assistant turn (it reads as "no answer"
  // and corrupts the thread) — fail loudly so the caller can retry smaller.
  const answer = reply.trim();
  if (!answer) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message:
        "The rewrite ran out of room before it produced an answer — the change you asked for may be too big for one paragraph. Try a shorter instruction, or paste just the paragraph you want changed.",
    });
  }

  const ts = Date.now();
  const appended: RefineMessage[] = [
    ...thread,
    { role: "user", content: userContent, ts },
    { role: "assistant", content: answer, ts },
  ];
  const updated = appended.slice(-MAX_REFINE_MESSAGES);
  updateRun(runId, { refineChat: updated });
  return { messages: updated, costUsd };
}
