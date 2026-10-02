/**
 * Sponsorship email agent — the HTTP surface (mounted by the integrator next
 * to the Deal Organizer's own handlers). Plain JSON handlers + one streamer.
 *
 *   getAgentStatus / updateAgentSettings / listAgentRuns / getAgentRun /
 *   listAgentQuestions / listAgentLessons      → AGENT_HANDLERS
 *   runAgentNow (NDJSON chunks)                → AGENT_STREAMERS
 */
import { getSettings, updateSettings, getFollowUpSettings, updateFollowUpSettings, type FollowUpSettings } from "./settings.js";
import { focusList, runFollowUpsPreview } from "./followups.js";
import { focusMap, refreshFocus } from "./focus.js";
import { withUsageScope, type ScopedCall } from "../../ai/usageScope.js";
import { priceCalls } from "./util.js";
import { runAgent, isRunning } from "./run.js";
import { nextSlot } from "./schedule.js";
import { listRuns, getRun, itemsForRun, listQuestions, listLessons, updateLessonText, deleteLesson, lastRun as lastFinishedRun, type RunSummary } from "./store.js";
import { understandRules } from "./teach.js";
import { insertRules, listRules as listHouseRules, updateRule as updateHouseRule, retireRule } from "./houseRules.js";
import { TZ } from "./util.js";

type Emit = (chunk: unknown) => void;

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function status() {
  const s = getSettings();
  const latest = listRuns(1)[0] ?? null;
  const next = s.enabled ? nextSlot(s.times) : null;
  return {
    enabled: s.enabled,
    saveToGmail: s.saveToGmail,
    postToSlack: s.postToSlack,
    times: s.times,
    timezone: TZ,
    lastRun: (latest as RunSummary | null) ?? lastFinishedRun(),
    nextRunAt: next ? next.toISOString() : null,
    running: isRunning(),
    signature: s.signature,
    /** Additive: follow-up cadence + auto-close settings (agent/followups.ts). */
    followUps: getFollowUpSettings(),
  };
}

export const AGENT_HANDLERS = {
  getAgentStatus: () => status(),

  updateAgentSettings: (input: { enabled?: boolean; saveToGmail?: boolean; postToSlack?: boolean; times?: string[]; signature?: string; followUps?: Partial<FollowUpSettings> }) => {
    const patch: Record<string, unknown> = {};
    for (const k of ["enabled", "saveToGmail", "postToSlack"] as const) {
      if (input?.[k] !== undefined) {
        if (typeof input[k] !== "boolean") bad(`${k} must be true or false`);
        patch[k] = input[k];
      }
    }
    if (input?.times !== undefined) {
      if (!Array.isArray(input.times)) bad("times must be a list like [\"08:00\",\"20:00\"]");
      patch.times = input.times;
    }
    if (input?.signature !== undefined) {
      if (typeof input.signature !== "string") bad("signature must be text");
      patch.signature = input.signature;
    }
    if (input?.followUps !== undefined) {
      const fu = input.followUps;
      if (!fu || typeof fu !== "object" || Array.isArray(fu)) bad("followUps must be an object");
      for (const k of ["followUpsEnabled", "autoCloseEnabled"] as const) {
        if (fu[k] !== undefined && typeof fu[k] !== "boolean") bad(`followUps.${k} must be true or false`);
      }
      for (const k of ["perRunCap", "closeAfterDays", "backlogDays", "backlogCloseAfterDays", "closuresPerRunCap", "focusPerRunCap"] as const) {
        if (fu[k] !== undefined && !Number.isFinite(Number(fu[k]))) bad(`followUps.${k} must be a number`);
      }
      if (fu.cadence !== undefined) {
        if (!fu.cadence || typeof fu.cadence !== "object") bad("followUps.cadence must be {A:[days],B:[days],C:[days]}");
        for (const g of ["A", "B", "C"] as const) {
          const v = (fu.cadence as any)[g];
          if (v !== undefined && (!Array.isArray(v) || v.some((x: unknown) => !Number.isFinite(Number(x)) || Number(x) < 1 || Number(x) > 120))) bad(`followUps.cadence.${g} must be a list of days (1–120)`);
        }
      }
      updateFollowUpSettings(fu);
    }
    updateSettings(patch as any);
    return status();
  },

  listAgentRuns: (input: { limit?: number }) => {
    const limit = Math.max(1, Math.min(200, Number(input?.limit) || 20));
    return { runs: listRuns(limit) };
  },

  getAgentRun: (input: { id?: string }) => {
    if (!input?.id) bad("id is required");
    const run = getRun(input.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    return { run, items: itemsForRun(input.id) };
  },

  listAgentQuestions: (input: { status?: "open" | "answered" }) => {
    const st = input?.status;
    if (st !== undefined && st !== "open" && st !== "answered") bad("status must be open or answered");
    return {
      questions: listQuestions(st).map((q) => ({
        id: q.id, threadId: q.threadId, subject: q.subject, question: q.question, askedAt: q.askedAt,
        slackPermalink: q.slackPermalink, answer: q.answer, answeredAt: q.answeredAt,
      })),
    };
  },

  listAgentLessons: (input: { limit?: number }) => {
    const limit = Math.max(1, Math.min(500, Number(input?.limit) || 100));
    return { lessons: listLessons(limit) };
  },

  updateAgentLesson: (input: { id: string; lesson: string }) => ({ lesson: updateLessonText(String(input?.id ?? ""), String(input?.lesson ?? "")) }),
  deleteAgentLesson: (input: { id: string }) => { deleteLesson(String(input?.id ?? "")); return { ok: true }; },

  /* ── Jake's own rules (teach.ts / houseRules.ts) ── */
  /** Read a pasted conversation or note and return the rules it decides — nothing is saved (one Opus call). */
  understandAgentRules: async (input: { text: string }) => understandRules(String(input?.text ?? "")),
  /** Save the rules Jake confirmed (possibly edited) with the text they came from. */
  saveAgentRules: (input: { text?: string; rules: Array<{ rule: string; scope?: string; brand?: string | null; stage?: string | null; overrides?: string | null }> }) => {
    const rules = Array.isArray(input?.rules) ? input.rules : [];
    if (!rules.length) throw Object.assign(new Error("No rules to save."), { status: 400 });
    return { rules: insertRules(rules, { source: "lab", raw: input?.text ? String(input.text) : undefined }) };
  },
  listAgentRules: (input: { includeRetired?: boolean }) => ({ rules: listHouseRules(input?.includeRetired === true) }),
  updateAgentRule: (input: { id: string; rule?: string; scope?: string; brand?: string | null; stage?: string | null }) => {
    const r = updateHouseRule(String(input?.id ?? ""), input ?? {});
    if (!r) throw Object.assign(new Error("That rule no longer exists."), { status: 404 });
    return { rule: r };
  },
  retireAgentRule: (input: { id: string }) => { retireRule(String(input?.id ?? "")); return { ok: true }; },

  /** Focus list: every open deal with its A/B/C score, reasons and follow-up status (no AI, no Gmail). */
  listAgentFocus: async () => focusList(),

  /** Kanban badge data: dealId → { grade, score, reason }. */
  getAgentFocusMap: () => ({ focus: focusMap() }),
};

export const AGENT_STREAMERS = {
  /**
   * One-time / on-demand focus backfill: score every open deal whose threads
   * changed (`force: true` rescores all). `limit` caps the model calls (default 400).
   */
  runFocusBackfill: async (input: { force?: boolean; limit?: number }, emit: Emit) => {
    const calls: ScopedCall[] = [];
    const r = await withUsageScope({ calls }, () => refreshFocus({
      cap: Math.max(1, Math.min(1000, Number(input?.limit) || 400)), force: input?.force === true, concurrency: 4,
      log: (message) => emit({ type: "progress", message }),
    }));
    const cost = priceCalls(calls);
    emit({ type: "progress", message: `Focus backfill done: ${r.scored} scored, ${r.failed} failed, ${r.pending} left — AI cost ≈ $${cost.usd.toFixed(3)}.` });
    return { ...r, costUsd: cost.usd };
  },

  /** Preview of only the focus + follow-up + auto-close step (never writes Gmail, Slack or the board). */
  runFollowUpsPreview: async (_input: unknown, emit: Emit) => runFollowUpsPreview({
    onProgress: (message) => emit({ type: "progress", message }),
    onItem: (item) => emit({ type: "item", item }),
  }),

  /** `{ preview?: boolean }` — preview:true forces a preview even when the switches are on. */
  runAgentNow: async (input: { preview?: boolean }, emit: Emit): Promise<RunSummary> => {
    return runAgent({
      trigger: "manual",
      forcePreview: input?.preview === true,
      onProgress: (message) => emit({ type: "progress", message }),
      onItem: (item) => emit({ type: "item", item }),
    });
  },
};
