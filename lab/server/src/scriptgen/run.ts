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
import { opusScriptChat, extractJson } from "../ai/claude.js";
import { ZiteError } from "../zite/store.js";
import { createRun, updateRun, getRun } from "../db/scriptRuns.js";
import { loadPrompt, fill, systemPreamble } from "./prompts.js";
import type {
  ScriptInput,
  ScriptSetup,
  Sponsorship,
  Stage0Result,
  ScriptStages,
  ScriptJobSnapshot,
  ScriptRunStatus,
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
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= jobs.size - MAX_JOBS; i++) {
      if (oldest[i]) jobs.delete(oldest[i].id);
    }
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
  };
}

/**
 * Confirm the type/title checkpoint and launch Stages 1–7 as a background job.
 * Returns synchronously; the heavy work runs fire-and-forget in runScript().
 */
export function continueScript(runId: string, setup: ScriptSetup): { jobId: string; runId: string } {
  const run = getRun(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Script run not found." });
  updateRun(runId, { setup, title: setup.title, videoType: setup.videoType, status: "running" });
  const job = createJob(runId);
  void runScript(job.id, runId, setup, run.input);
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

// ── The 7-stage run (background, never throws) ────────────────────────────────

async function runScript(
  jobId: string,
  runId: string,
  setup: ScriptSetup,
  input: ScriptInput,
): Promise<void> {
  void input; // the run is driven entirely by the confirmed setup
  const job = jobs.get(jobId);
  if (!job) return;

  const stages: ScriptStages = {
    research: null,
    outline: null,
    hooks: null,
    sponsorSegment: null,
    sections: [],
    outro: null,
    reviewNotes: [],
  };
  const persist = () => updateRun(runId, { stages });

  try {
    const videoType = setup.videoType;
    const title = setup.title;
    const targetLength = (setup.targetLength || "").trim() || "10–12 minutes minimum";
    const sponsorLabel = sponsorshipLabel(setup.sponsorship);

    // ── Stage 1 — RESEARCH (live web) ──
    progress(job, "Researching the web…", 10);
    const s1 = fill(loadPrompt("stage1-research"), {
      "[SELECT ONE: Tutorial / List/Roundup / Tool Review / Business Guide / Opinion]": videoType,
      "[INSERT VIDEO TITLE HERE]": title,
      "[What specifically needs research - tool name, concept, strategy, etc.]": setup.coreTopic,
      "[INSERT TYPE]": videoType,
      "[INSERT WHAT TO RESEARCH]": setup.coreTopic,
      "[INSERT ANY SPECIFIC ANGLES OR QUESTIONS TO ANSWER]": setup.specificFocus || "(none specified)",
    });
    stages.research = await opusScriptChat({
      system: systemPreamble(false),
      messages: [{ role: "user", content: s1 }],
      webSearch: true,
      maxTokens: 16000,
      purpose: "scriptgen",
    });
    persist();

    // ── Stage 2 — OUTLINE ──
    progress(job, "Building the outline…", 30);
    const s2 = fill(loadPrompt("stage2-outline"), {
      "[SELECT ONE: Tutorial / List/Roundup / Tool Review / Business Guide / Opinion]": videoType,
      "[INSERT VIDEO TITLE HERE]": title,
      [STAGE2_RESEARCH_BLOCK]: stages.research ?? "",
    });
    stages.outline = await opusScriptChat({
      system: systemPreamble(false),
      messages: [{ role: "user", content: s2 }],
      maxTokens: 16000,
      purpose: "scriptgen",
    });
    persist();

    // ── Stage 3 — ALL FOUR HOOKS ──
    progress(job, "Writing all four hooks…", 45);
    const s3 = fill(loadPrompt("stage3-hooks"), {
      "[Tutorial / Tool Review / Business Guide / Opinion / Listicle / Roundup]": videoType,
      "[Whole-video sponsorship — sponsor name / Mid-roll segment — sponsor name / Organic]": sponsorLabel,
      "[Whole-video sponsored — sponsor name / Mid-roll segment sponsored — sponsor name / Organic]": sponsorLabel,
      "[Confirm 10-12+ minutes — default for all Jake Dawson videos]": targetLength,
      "[paste from Stage 2]": stages.outline ?? "",
    });
    stages.hooks = await opusScriptChat({
      system: systemPreamble(false),
      messages: [{ role: "user", content: s3 }],
      maxTokens: 16000,
      purpose: "scriptgen",
    });
    persist();

    // ── Stage 4 — SPONSOR SEGMENT (mid-roll only) ──
    if (setup.sponsorship?.mode === "mid-roll") {
      progress(job, "Writing the sponsor segment…", 50);
      const s4 = fill(loadPrompt("stage4-sponsor"), {
        "[INSERT SPONSOR]": (setup.sponsorship.sponsorName || "the sponsor").trim() || "the sponsor",
        "[INSERT TITLE]": title,
        "[INSERT CONTEXT FROM THE OUTLINE]": stages.outline ?? "",
      });
      stages.sponsorSegment = await opusScriptChat({
        system: systemPreamble(false),
        messages: [{ role: "user", content: s4 }],
        purpose: "scriptgen",
      });
      persist();
    }

    // ── Stage 5 — SECTIONS (draft + 14-year-old review pass) ──
    const sectionOutlines = parseOutlineSections(stages.outline ?? "");
    const total = sectionOutlines.length;
    for (let i = 0; i < total; i++) {
      const sec = sectionOutlines[i];
      progress(job, `Writing section ${i + 1}/${total}…`, sectionStartPercent(i, total));
      const draftPrompt = fill(loadPrompt("stage5-section"), {
        "[PASTE THE SECTION YOU'RE WORKING ON]": sec.text,
      });
      const draft = await opusScriptChat({
        system: systemPreamble(true),
        messages: [{ role: "user", content: draftPrompt }],
        maxTokens: 16000,
        purpose: "scriptgen",
      });
      const reviewPrompt = fill(loadPrompt("stage5-review"), { "[PASTE SECTION]": draft });
      const final = await opusScriptChat({
        system: systemPreamble(false),
        messages: [{ role: "user", content: reviewPrompt }],
        maxTokens: 16000,
        purpose: "scriptgen",
      });
      stages.sections.push({ name: sec.name, draft, final });
      persist();
    }

    // ── Stage 6 — OUTRO ──
    progress(job, "Writing the outro…", 88);
    const s6 = fill(loadPrompt("stage6-outro"), {
      "[INSERT TYPE]": videoType,
      "[INSERT TITLE]": title,
      "[PASTE OUTLINE]": stages.outline ?? "",
    });
    stages.outro = await opusScriptChat({
      system: systemPreamble(false),
      messages: [{ role: "user", content: s6 }],
      purpose: "scriptgen",
    });
    persist();

    // ── Assemble the document ──
    progress(job, "Assembling the document…", 92);
    const topPart =
      `# ${title}\n\n## HOOKS — pick one\n\n${stages.hooks ?? ""}\n\n` +
      (stages.sponsorSegment ? `## SPONSOR SEGMENT (mid-roll)\n\n${stages.sponsorSegment}\n\n` : "");
    const sectionsBody = stages.sections.map((s) => s.final).join("\n\n");
    const scriptBody = `## SCRIPT\n\n${sectionsBody}\n\n## OUTRO\n\n${stages.outro ?? ""}`;
    let finalDocument = topPart + scriptBody;
    updateRun(runId, { finalDocument });

    // ── Stage 7 — FINAL REVIEW (reviews the SCRIPT+OUTRO body, not the hooks) ──
    progress(job, "Final review pass…", 96);
    const s7 = fill(loadPrompt("stage7-review"), { "[PASTE FULL SCRIPT]": scriptBody });
    const raw7 = await opusScriptChat({
      system: systemPreamble(false),
      messages: [{ role: "user", content: s7 }],
      maxTokens: 16000,
      purpose: "scriptgen",
    });
    let reviewNotes: string[] = [];
    let reviewOk = false;
    try {
      const parsed = JSON.parse(extractJson(raw7)) as {
        revisedScript?: unknown;
        changes?: unknown;
      };
      const revised =
        typeof parsed.revisedScript === "string" && parsed.revisedScript.trim()
          ? parsed.revisedScript
          : null;
      const changes = Array.isArray(parsed.changes)
        ? parsed.changes.filter((x): x is string => typeof x === "string")
        : [];
      if (revised) {
        finalDocument = topPart + revised;
        reviewNotes = changes;
        reviewOk = true;
      }
    } catch {
      reviewOk = false;
    }
    if (!reviewOk) {
      reviewNotes = ["Final review could not be parsed; script assembled without automated fixes."];
    }
    stages.reviewNotes = reviewNotes;
    updateRun(runId, { stages, finalDocument });

    // ── Done ──
    progress(job, "Done", 100);
    job.status = "completed";
    job.updatedAt = Date.now();
    updateRun(runId, { status: "completed" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    job.status = "failed";
    job.error = msg;
    job.updatedAt = Date.now();
    updateRun(runId, { status: "failed", error: msg });
  }
}
