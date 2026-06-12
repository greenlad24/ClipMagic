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
import { claudeJSONForPurpose } from "../ai/claude.js";
import {
  planScreencasts,
  type PlannerWord,
  type PlannerPrompt,
  type PlannedMoment,
} from "./planner.js";
import { validateUrlReachable } from "./validateUrl.js";
import { captureScreencast, type CaptureScreencastResult } from "./screencast.js";

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
}

export interface AutoScreencastResult {
  planned: number;
  captured: number;
  skipped: Array<{ reason: string; url?: string }>;
  failed: Array<{ error: string; url?: string; shotId?: string }>;
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
