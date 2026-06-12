/**
 * Auto-Screencast orchestration.
 *
 * autoScreencast({ projectId }):
 *   1. Load the project (transcript + subtitlesJson word timings + duration) and
 *      its shots.
 *   2. Capture EXISTING user-set Screencast shots that have a targetUrl but no
 *      finished clip (captureStatus != "Done"), AND plan + capture NEW AI moments
 *      from the script (script-guided planner).
 *   3. For each captured clip, UPSERT the shot following the z_shots conventions
 *      used elsewhere: shotType "Screencast", targetUrl, clipUrl = the local
 *      output ref the render resolves, captureStatus "Done", startTime/endTime,
 *      and uiLabelsJson carrying the overlay-timing metadata the render reads.
 *   4. Per-item isolation: one failed capture marks THAT shot "Error" and the run
 *      continues; the response reports per-moment results.
 *
 * The AI call, URL validator, capture engine, and store are all INJECTABLE so the
 * whole orchestration (upsert shape + per-item isolation) is unit-tested with
 * mocks — no Chromium, ffmpeg, network, or DB.
 */
import { Projects, Shots } from "../zite/store.js";
import type { Record_ } from "../zite/store.js";
import { config } from "../config.js";
import { claudeJSONForPurpose } from "../ai/claude.js";
import {
  planScreencasts,
  type PlannerWord,
  type PlannerPrompt,
  type PlannedMoment,
} from "./planner.js";
import { validateUrlReachable } from "./validateUrl.js";
import { captureScreencast, type CaptureScreencastResult } from "./screencast.js";

// ── Per-video gate (mirrors motion/director.ts motionGraphicsEnabledFor) ──────

/**
 * Whether automatic in-pipeline screencast capture should run for a project.
 * Default ON: it runs unless the user switched the per-video toggle OFF
 * (project.autoScreencast === false) or the global SCREENCAST_DISABLED=1 escape
 * hatch force-disables it. `undefined`/missing toggle = on (older projects, the
 * default create flow). This decision is independent of runtime availability
 * (Chromium), which the caller probes separately and falls back on gracefully.
 */
export function autoScreencastEnabledFor(projectAutoScreencast: unknown): boolean {
  if (config.autoScreencastDisabled) return false;
  return projectAutoScreencast !== false;
}

// ── Injectable seams (default to the real implementations) ────────────────────

export interface AutoScreencastDeps {
  askModel?: (prompt: PlannerPrompt) => Promise<string>;
  validateUrl?: (url: string) => Promise<boolean>;
  capture?: (args: { url: string; durationSec: number; outName: string }) => Promise<CaptureScreencastResult>;
  store?: {
    findProject: (id: string) => Promise<Record_ | null>;
    findShots: (projectId: string) => Promise<Record_[]>;
    findShot: (id: string) => Promise<Record_ | null>;
    createShot: (record: Record<string, unknown>) => Promise<Record_>;
    updateShot: (id: string, record: Record<string, unknown>) => Promise<unknown>;
  };
}

export interface AutoScreencastInput {
  projectId: string;
  userId?: string;
  /** Max NEW AI-planned moments (existing Screencast shots are always captured). */
  maxMoments?: number;
  /**
   * Overall wall-clock budget (ms) for this whole run. When the pipeline runs
   * this INLINE before building the render manifest, the budget guarantees a hung
   * site can't stall generation: once exceeded we STOP STARTING new captures and
   * leave the rest Pending (handled by the existing promo-retrieval fallback).
   * Omit/0 = no overall ceiling (the per-capture nav timeout still applies).
   */
  budgetMs?: number;
  /** Injectable clock for deterministic budget tests. Defaults to Date.now. */
  now?: () => number;
}

export interface AutoScreencastResult {
  planned: number;
  captured: number;
  skipped: Array<{ reason: string; url?: string }>;
  failed: Array<{ error: string; url?: string; shotId?: string }>;
  /** True when the overall budget was hit and remaining moments were abandoned. */
  timedOut?: boolean;
}

// ── Defaults wiring the real services ─────────────────────────────────────────

const defaultStore: NonNullable<AutoScreencastDeps["store"]> = {
  findProject: (id) => Projects.findOne({ id }),
  findShots: async (projectId) => (await Shots.findAll({ filters: { project: projectId }, limit: 1000 })).records,
  findShot: (id) => Shots.findOne({ id }),
  createShot: (record) => Shots.create({ record }),
  updateShot: (id, record) => Shots.update({ id, record }),
};

const defaultAskModel = (prompt: PlannerPrompt): Promise<string> =>
  claudeJSONForPurpose({
    // research tier (Sonnet) — scoped extraction, cheap; attributed to its own
    // "screencast" purpose in the run/cost report (matches the caption pattern).
    tier: "research",
    purpose: "screencast",
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });

const defaultCapture = (args: { url: string; durationSec: number; outName: string }) =>
  captureScreencast(args);

// ── Word-timing extraction ────────────────────────────────────────────────────

/**
 * Flatten a project's subtitlesJson (array of events, each with word-level
 * timings) into a flat word list for the planner. Tolerates the two shapes seen
 * in the codebase: events with `.words[]` (each {text/word,start,end}), or a flat
 * word array.
 */
export function wordsFromSubtitles(subtitlesJson: string | undefined | null): PlannerWord[] {
  if (!subtitlesJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(subtitlesJson);
  } catch {
    return [];
  }
  const events = Array.isArray(parsed) ? parsed : [];
  const out: PlannerWord[] = [];
  const pushWord = (w: any) => {
    const text = typeof w?.text === "string" ? w.text : typeof w?.word === "string" ? w.word : "";
    const start = Number(w?.start);
    const end = Number(w?.end);
    if (text && Number.isFinite(start) && Number.isFinite(end)) out.push({ text, start, end });
  };
  for (const ev of events) {
    if (Array.isArray((ev as any)?.words)) for (const w of (ev as any).words) pushWord(w);
    else pushWord(ev); // flat word array fallback
  }
  return out;
}

// ── Shot upsert ────────────────────────────────────────────────────────────────

/**
 * Build the uiLabelsJson for a captured screencast shot — the SAME label keys the
 * render's submitRendiJob reads (overlayDelaySeconds, showNarratorFirst,
 * mediaType, clip offsets) plus the capture provenance. Merges over any existing
 * labels so a recapture doesn't clobber user edits.
 */
export function buildScreencastLabels(args: {
  existing?: Record<string, unknown>;
  captureUrl: string;
  transcriptSnippet?: string;
  retrievalConfidence?: number;
}): string {
  return JSON.stringify({
    ...(args.existing ?? {}),
    captureType: "browser",
    captureUrl: args.captureUrl,
    transcriptSnippet: args.transcriptSnippet ?? (args.existing?.transcriptSnippet as string) ?? "",
    overlayDelaySeconds: 1.0,
    showNarratorFirst: true,
    mediaType: "video",
    clipStartOffset: 0,
    clipEndOffset: 0,
    retrievalConfidence: args.retrievalConfidence ?? 1,
  });
}

function parseLabels(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────

export async function autoScreencast(
  input: AutoScreencastInput,
  deps: AutoScreencastDeps = {},
): Promise<AutoScreencastResult> {
  const store = deps.store ?? defaultStore;
  const askModel = deps.askModel ?? defaultAskModel;
  const validateUrl = deps.validateUrl ?? validateUrlReachable;
  const capture = deps.capture ?? defaultCapture;

  const project = await store.findProject(input.projectId);
  if (!project) throw new Error("Project not found");

  const shots = await store.findShots(input.projectId);
  const words = wordsFromSubtitles(project.subtitlesJson as string);
  const duration =
    (project.durationSeconds as number) ||
    shots.reduce((m, s) => Math.max(m, (s.endTime as number) ?? 0), 0) ||
    0;

  const result: AutoScreencastResult = { planned: 0, captured: 0, skipped: [], failed: [] };

  // Overall wall-clock ceiling. The render reads captureStatus/clipUrl, so when
  // this runs INLINE in the pipeline a hung site must never stall generation:
  // once the deadline passes we stop STARTING captures and leave the rest
  // untouched (Pending) for the existing promo-retrieval / talking-head fallback.
  const now = input.now ?? Date.now;
  const deadline =
    input.budgetMs && input.budgetMs > 0 ? now() + input.budgetMs : Number.POSITIVE_INFINITY;
  const outOfTime = () => now() >= deadline;

  // 1) EXISTING Screencast shots the user set (targetUrl present, not yet Done).
  const existingToCapture = shots.filter(
    (s) =>
      s.shotType === "Screencast" &&
      typeof s.targetUrl === "string" &&
      (s.targetUrl as string).trim() !== "" &&
      s.captureStatus !== "Done",
  );

  // 2) Plan NEW AI moments — must not overlap ANY existing non-TalkingHead shot.
  const plan = await planScreencasts({
    transcript: (project.transcript as string) || "",
    words,
    durationSeconds: duration,
    shots: shots.map((s) => ({
      shotType: s.shotType as string,
      startTime: s.startTime as number,
      endTime: s.endTime as number,
    })),
    maxMoments: input.maxMoments ?? 3,
    askModel,
    validateUrl,
  });
  result.planned = plan.planned.length;
  for (const sk of plan.skipped) result.skipped.push({ reason: sk.reason, url: sk.url });

  // ── Capture existing shots (per-item isolation) ────────────────────────────
  for (const shot of existingToCapture) {
    if (outOfTime()) {
      // Leave it Pending (we never marked it Capturing) → fallback handles it.
      result.timedOut = true;
      result.skipped.push({ reason: "screencast budget exceeded", url: shot.targetUrl as string });
      continue;
    }
    const url = (shot.targetUrl as string).trim();
    const durationSec = Math.max(3, ((shot.endTime as number) ?? 4) - ((shot.startTime as number) ?? 0));
    try {
      await store.updateShot(shot.id, { captureStatus: "Capturing" });
      const cap = await capture({ url, durationSec, outName: shot.id });
      const existing = parseLabels(shot.uiLabelsJson);
      await store.updateShot(shot.id, {
        shotType: "Screencast",
        targetUrl: url,
        clipUrl: cap.outputUrl,
        captureStatus: "Done",
        uiLabelsJson: buildScreencastLabels({
          existing,
          captureUrl: url,
          transcriptSnippet: existing.transcriptSnippet as string,
        }),
      });
      result.captured++;
    } catch (e) {
      await store.updateShot(shot.id, { captureStatus: "Error" }).catch(() => {});
      result.failed.push({ error: e instanceof Error ? e.message : String(e), url, shotId: shot.id });
    }
  }

  // ── Capture planned AI moments → CREATE new shots (per-item isolation) ──────
  for (const moment of plan.planned) {
    if (outOfTime()) {
      // Never created a shot for it → nothing to clean up; the beat simply keeps
      // whatever visual the director already planned for that window.
      result.timedOut = true;
      result.skipped.push({ reason: "screencast budget exceeded", url: moment.url });
      continue;
    }
    const durationSec = Math.max(3, moment.endSec - moment.startSec);
    try {
      const cap = await capture({ url: moment.url, durationSec, outName: `plan_${input.projectId}` });
      await store.createShot({
        project: input.projectId,
        user: input.userId,
        shotType: "Screencast",
        beat: "screencast",
        caption: moment.query,
        targetUrl: moment.url,
        clipUrl: cap.outputUrl,
        captureStatus: "Done",
        startTime: moment.startSec,
        endTime: moment.endSec,
        uiLabelsJson: buildScreencastLabels({
          captureUrl: moment.url,
          transcriptSnippet: moment.transcriptSnippet,
          retrievalConfidence: moment.confidence,
        }),
      });
      result.captured++;
    } catch (e) {
      result.failed.push({ error: e instanceof Error ? e.message : String(e), url: moment.url });
    }
  }

  return result;
}

// ── Pipeline injection step (gated, isolated) ─────────────────────────────────

export interface PipelineStepDeps {
  /** Cheap probe — true when a real Chromium binary exists on this host. */
  chromiumAvailable: () => boolean;
  /** Loads the project so its per-video toggle can be read. */
  findProject: (id: string) => Promise<Record_ | null>;
  /** The capture run (defaults to autoScreencast; injected in tests). */
  run?: (input: AutoScreencastInput) => Promise<AutoScreencastResult>;
  /** Optional logger (defaults to console.log / console.warn). */
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * The automatic screencast step the generation pipeline runs INLINE, just before
 * captureShots assigns media (and well before the render reads each shot's
 * clipUrl). It is intentionally a no-op — never throwing — when:
 *   • SCREENCAST_DISABLED=1 (global escape hatch), or
 *   • no Chromium is available here (nothing to capture with), or
 *   • the project's per-video toggle is OFF (project.autoScreencast === false).
 *
 * On any failure it logs and returns null so generation proceeds: every shot it
 * didn't finish is left Pending and handled by captureShots' existing fallback.
 *
 * Returns the run result when it ran, or null when it was skipped/failed.
 */
export async function autoScreencastPipelineStep(
  projectId: string | undefined,
  userId: string | undefined,
  deps: PipelineStepDeps,
): Promise<AutoScreencastResult | null> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  if (!projectId) return null;
  if (config.autoScreencastDisabled) return null;
  if (!deps.chromiumAvailable()) return null;
  try {
    const project = await deps.findProject(projectId);
    if (!project || !autoScreencastEnabledFor(project.autoScreencast)) return null;
    const runner = deps.run ?? ((i: AutoScreencastInput) => autoScreencast(i));
    const res = await runner({
      projectId,
      userId,
      maxMoments: config.autoScreencastMaxMoments,
      budgetMs: config.autoScreencastBudgetMs,
    });
    log(
      `[autoScreencast] project=${projectId} captured=${res.captured} planned=${res.planned} ` +
        `failed=${res.failed.length} skipped=${res.skipped.length}${res.timedOut ? " (budget hit)" : ""}`,
    );
    return res;
  } catch (e) {
    // A capture-stage failure must NEVER break generation.
    warn(`[autoScreencast] non-fatal failure for ${projectId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Recapture ONE existing Screencast shot using its current targetUrl. Powers the
 * PropertyPanel "Recapture" action so a user can edit the URL and re-shoot just
 * that shot. Same upsert conventions; per-item error handling.
 */
export async function recaptureScreencastShot(
  input: { shotId: string },
  deps: AutoScreencastDeps = {},
): Promise<{ success: boolean; clipUrl?: string; error?: string }> {
  const store = deps.store ?? defaultStore;
  const capture = deps.capture ?? defaultCapture;

  const shot = await store.findShot(input.shotId);
  if (!shot) return { success: false, error: "Shot not found" };

  const url = typeof shot.targetUrl === "string" ? shot.targetUrl.trim() : "";
  if (!url) return { success: false, error: "This shot has no target URL to capture." };

  const durationSec = Math.max(3, ((shot.endTime as number) ?? 4) - ((shot.startTime as number) ?? 0));
  try {
    await store.updateShot(shot.id, { captureStatus: "Capturing" });
    const cap = await capture({ url, durationSec, outName: shot.id });
    const existing = parseLabels(shot.uiLabelsJson);
    await store.updateShot(shot.id, {
      shotType: "Screencast",
      targetUrl: url,
      clipUrl: cap.outputUrl,
      captureStatus: "Done",
      uiLabelsJson: buildScreencastLabels({
        existing,
        captureUrl: url,
        transcriptSnippet: existing.transcriptSnippet as string,
      }),
    });
    return { success: true, clipUrl: cap.outputUrl };
  } catch (e) {
    await store.updateShot(shot.id, { captureStatus: "Error" }).catch(() => {});
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
