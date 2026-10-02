/**
 * Deal Organizer — THE Gmail sync pipeline (centralized, Jake 2026-09-30).
 *
 * One function, `runSync`, used by the twice-daily schedule (as the agent's
 * pre-run step, and on its own when the agent is disabled) and by the manual
 * "sync now" button (STREAMER runSyncNow). In order:
 *
 *   1. threadIndex — syncThreadIndex (thread list for the Emails page)
 *   2. emails      — syncEmails, INCREMENTAL (Gmail history; date-window
 *                    fallback when the stored historyId is too old)
 *   3. brands      — brand extraction for new / uncached threads only
 *                    (companies.ts extractNewThreadBrands — the only place the
 *                    brand AI runs; the Emails/Companies pages just read)
 *   4. scan        — the AI deal scan (create/update deals), scheduled mode
 *
 * Process-wide lock: one pipeline at a time; a second caller ATTACHES to the
 * running one (gets its progress from then on and the same result). A
 * stand-alone scanGmail call waits for the same lock (syncLock.ts).
 *
 * Every run is recorded in `deals_sync_status` (the last 50 are kept).
 * Never throws: each step is isolated, and the status says what happened.
 * Writes only deals_* tables; sends nothing.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { syncEmails, syncThreadIndex } from "./gmailSync.js";
import { scanGmailUnlocked } from "./scan.js";
import { fillDealFields } from "./dealFields.js";
import { extractNewThreadBrands } from "./companies.js";
import { connectedAccounts } from "./common.js";
import { withSyncLock } from "./syncLock.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_sync_status (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  steps_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS deals_sync_status_started ON deals_sync_status (started_at);
`);

export type SyncTrigger = "schedule" | "manual";
export type SyncStepName = "threadIndex" | "emails" | "brands" | "scan" | "dealFields";

export interface SyncStepStatus {
  step: SyncStepName;
  ok: boolean;
  ms: number;
  counts: Record<string, number>;
  message: string;
  error: string | null;
}

export interface SyncStatus {
  id: string;
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string | null;
  /** null while running */
  ok: boolean | null;
  steps: SyncStepStatus[];
  summary: string;
}

/** Progress chunk (runSyncNow streams these). */
export interface SyncProgress { step: SyncStepName | "sync"; message: string }

/* ── persistence ─────────────────────────────────────────────────────────── */

function saveStatus(s: SyncStatus): void {
  db.prepare(`INSERT INTO deals_sync_status (id, trigger, started_at, finished_at, ok, steps_json, summary)
      VALUES (@id, @trigger, @startedAt, @finishedAt, @ok, @steps, @summary)
      ON CONFLICT(id) DO UPDATE SET finished_at = @finishedAt, ok = @ok, steps_json = @steps, summary = @summary`)
    .run({ id: s.id, trigger: s.trigger, startedAt: s.startedAt, finishedAt: s.finishedAt, ok: s.ok === null ? null : s.ok ? 1 : 0, steps: JSON.stringify(s.steps), summary: s.summary });
  db.prepare(`DELETE FROM deals_sync_status WHERE id NOT IN (SELECT id FROM deals_sync_status ORDER BY started_at DESC LIMIT 50)`).run();
}

function rowToStatus(r: any): SyncStatus {
  let steps: SyncStepStatus[] = [];
  try { steps = JSON.parse(r.steps_json || "[]"); } catch { /* keep [] */ }
  return {
    id: r.id, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at ?? null,
    ok: r.ok === null || r.ok === undefined ? null : r.ok === 1, steps, summary: r.summary ?? "",
  };
}

/** The most recent FINISHED run, or null. */
export function lastSyncStatus(): SyncStatus | null {
  const r = db.prepare(`SELECT * FROM deals_sync_status WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get();
  return r ? rowToStatus(r) : null;
}

/* ── the lock + attach ───────────────────────────────────────────────────── */

let current: { status: SyncStatus; promise: Promise<SyncStatus>; listeners: Set<(p: SyncProgress) => void> } | null = null;

/** The run in progress (its status so far), or null. */
export function currentSync(): SyncStatus | null {
  return current ? { ...current.status, steps: [...current.status.steps] } : null;
}

/**
 * Run the pipeline — or, if one is already running, attach to it: `onProgress`
 * receives its messages from now on and the returned promise is the same run.
 */
export function runSync(trigger: SyncTrigger, onProgress?: (p: SyncProgress) => void): Promise<SyncStatus> {
  if (current) {
    if (onProgress) {
      current.listeners.add(onProgress);
      try { onProgress({ step: "sync", message: `Joined the ${current.status.trigger} sync already running (started ${current.status.startedAt}).` }); } catch { /* ignore */ }
    }
    return current.promise;
  }
  const status: SyncStatus = { id: randomUUID(), trigger, startedAt: new Date().toISOString(), finishedAt: null, ok: null, steps: [], summary: "" };
  const listeners = new Set<(p: SyncProgress) => void>(onProgress ? [onProgress] : []);
  const promise = withSyncLock(() => pipeline(status, (p) => {
    for (const l of listeners) { try { l(p); } catch { /* a closed stream never stops the sync */ } }
  })).finally(() => { if (current?.status.id === status.id) current = null; });
  current = { status, promise, listeners };
  return promise;
}

/* ── the pipeline ────────────────────────────────────────────────────────── */

async function pipeline(status: SyncStatus, emit: (p: SyncProgress) => void): Promise<SyncStatus> {
  // A run that waited for the lock (behind a stand-alone scanGmail) starts now.
  status.startedAt = new Date().toISOString();
  saveStatus(status);
  const say = (step: SyncProgress["step"], message: string) => emit({ step, message });

  const finish = (summary: string, ok: boolean): SyncStatus => {
    status.finishedAt = new Date().toISOString();
    status.ok = ok;
    status.summary = summary;
    saveStatus(status);
    say("sync", `Sync done — ${summary}`);
    return { ...status };
  };

  try {
    if (connectedAccounts().length === 0) return finish("Gmail is not connected — nothing to sync.", false);
  } catch (e: any) {
    return finish(`Could not read the Gmail connection: ${e?.message ?? e}`, false);
  }

  const step = async (name: SyncStepName, fn: () => Promise<{ counts: Record<string, number>; message: string; ok?: boolean }>) => {
    const t0 = Date.now();
    say(name, "starting");
    let rec: SyncStepStatus;
    try {
      const r = await fn();
      rec = { step: name, ok: r.ok ?? true, ms: Date.now() - t0, counts: r.counts, message: r.message, error: null };
      say(name, r.message);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      rec = { step: name, ok: false, ms: Date.now() - t0, counts: {}, message: `FAILED: ${msg}`, error: msg };
      say(name, `FAILED: ${msg}`);
    }
    status.steps.push(rec);
    saveStatus(status);
    return rec;
  };

  // 1. Thread index
  await step("threadIndex", async () => {
    let total = 0;
    const r = await syncThreadIndex({}, (c: any) => { if (c && typeof c.total === "number") total = c.total; });
    return {
      counts: { indexed: r.indexed, listed: total },
      message: `${r.indexed} of ${total} thread(s) indexed${r.isInitialSync ? " (initial 90-day sync)" : ""}`,
    };
  });

  // 2. Email bodies — incremental (history), date-window fallback inside syncEmails
  await step("emails", async () => {
    const r: any = await syncEmails({ daysBack: 0, maxResults: 2000 });
    return { counts: { newEmails: r.newEmails ?? 0 }, message: r.message ?? `${r.newEmails ?? 0} email(s) synced` };
  });

  // 3. Brand extraction for new / uncached threads (the only brand-AI call site)
  await step("brands", async () => {
    const r = await extractNewThreadBrands();
    return {
      ok: r.failedBatches === 0 && r.errors.length === 0,
      counts: { threads: r.threads, cached: r.cached, extracted: r.extracted, branded: r.branded, retried: r.retried, failedBatches: r.failedBatches },
      message: `${r.extracted} thread(s) extracted (${r.branded} with a brand, ${r.retried} retries), ${r.cached} already cached${r.errors.length ? ` — ${r.errors.join("; ").slice(0, 300)}` : ""}`,
    };
  });

  // 4. The AI deal scan (scheduled mode: last 24 h)
  await step("scan", async () => {
    const r = await scanGmailUnlocked({ daysBack: 1 }, (e) => say("scan", `[${e.level}] ${e.step}: ${e.message}`));
    return {
      ok: !(r.errored > 0 && r.errored === r.groupsProcessed),
      counts: { scanned: r.scanned, groups: r.senderGroups, processed: r.groupsProcessed, created: r.created, updated: r.updated, nonDeals: r.nonDeals, errored: r.errored, capped: r.groupsCapped },
      message: r.message,
    };
  });

  // 5. Analytics fields (agreed price, publish month, lost reason, deal type) for
  //    deals that are new or changed stage — AI fills them silently (Jake's call).
  await step("dealFields", async () => {
    const r = await fillDealFields((m) => say("dealFields", m));
    const x = r.extraction;
    return {
      ok: !x || x.failed === 0 || x.filled > 0,
      counts: (x ? { deals: x.deals, filled: x.filled, failed: x.failed, costUsd: Math.round(x.costUsd * 1000) / 1000 } : {}) as Record<string, number>,
      message: x ? `${x.filled} of ${x.deals} deal(s) filled${x.failed ? `, ${x.failed} failed` : ""}${r.weeklyNote ? " · weekly note written" : ""}` : "nothing queued",
    };
  });

  const ok = status.steps.every((s) => s.ok);
  return finish(status.steps.map((s) => `${s.step}: ${s.message}`).join(" | "), ok);
}

/**
 * The agent's pre-run step / the agent-disabled slot (index.ts registers it).
 * Same signature as before: `{ ok, summary }`.
 */
export async function scheduledSync(log?: (msg: string) => void): Promise<{ ok: boolean; summary: string }> {
  const s = await runSync("schedule", (p) => { try { log?.(`sync ${p.step}: ${p.message}`); } catch { /* ignore */ } });
  return { ok: s.ok === true, summary: s.summary };
}
