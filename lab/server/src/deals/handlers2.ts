/**
 * Deal Organizer — Phase 2 endpoints: Gmail accounts + sync, threads,
 * companies, the deal scanner, replies/follow-ups, chat and analytics.
 *
 * HANDLERS2 — plain JSON handlers, same contract as ./handlers.ts HANDLERS
 * (input = request body; errors carry `status` 400/404).
 *
 * STREAMERS — long or streaming endpoints, for the NDJSON protocol of
 * news/routes.ts: each `emit(chunk)` becomes a line `{"chunk": <chunk>}`, then
 * `{"result": <return value>}` or `{"error": {"message"}}`. Chunk shapes:
 *
 *   chatAI          chunk = string — text to APPEND to the assistant bubble
 *                   (what the original `stream.write`d). Modes C/D: one status
 *                   line. Modes A/B: the whole answer as ONE chunk (the Lab's
 *                   Claude helper does not stream tokens), and for a low-
 *                   confidence Mode A a second chunk with the "Research X?"
 *                   suffix. result = { text, mode: 'A'|'B'|'C'|'D',
 *                   companyName?, searchTerm? }.
 *
 *   syncThreadIndex chunk = { phase: 'metadata', progress: number, total: number }
 *                   — the object the original wrote as an NDJSON line (it is
 *                   now already parsed). Sent once after listing (progress 0)
 *                   and after every batch of 25 threads.
 *                   result = { indexed, isInitialSync, accountsProcessed }.
 *
 *   scanGmail       chunk = { ts, level: 'info'|'success'|'warn'|'error', step,
 *                   message } — each scan log entry as it is written (the same
 *                   entries the result's `logs` array holds). The original
 *                   was not streamed; the plain version is also in HANDLERS2.
 *                   result = the original scanGmail output. Waits for the
 *                   process-wide sync lock first (never runs beside the pipeline).
 *
 *   runSyncNow      THE centralized sync (scheduledSync.ts runSync, trigger
 *                   "manual"): threadIndex → emails → brands → scan. If a sync
 *                   is already running it attaches to it. chunk = { step:
 *                   'sync'|'threadIndex'|'emails'|'brands'|'scan', message }.
 *                   result = SyncStatus { id, trigger, startedAt, finishedAt,
 *                   ok, steps: [{ step, ok, ms, counts, message, error }], summary }.
 *
 * getSyncStatus (HANDLERS2) → { running: boolean, current: SyncStatus|null
 *   (the run in progress, steps so far), last: SyncStatus|null (last finished
 *   run), nextRunAt: ISO|null (next scheduled slot, from the agent's times) }.
 */
import type { Handler, Streamer } from "./common.js";
import { getAccounts, getGmailAuthUrl, exchangeGmailCode, removeAccount, syncEmails, syncThreadIndex } from "./gmailSync.js";
import { listThreads, lookupThread, getThread, getEmailAttachment } from "./threads.js";
import { listCompanies, clearThreadBrandsCache } from "./companies.js";
import { scanGmail } from "./scan.js";
import { generateReply, sendReply, getFollowUpDrafts, sendFollowUp, sendGmailDraft } from "./replies.js";
import { chatAI } from "./chat.js";
import { getAnalytics } from "./analytics.js";
import { runSync, currentSync, lastSyncStatus } from "./scheduledSync.js";
import { parse } from "./common.js";
import { z } from "zod";
import { getSettings } from "./agent/settings.js";
import { nextSlot } from "./agent/schedule.js";

const getSyncStatus: Handler = async (input) => {
  parse(z.object({}), input);
  const cur = currentSync();
  let nextRunAt: string | null = null;
  try { nextRunAt = nextSlot(getSettings().times)?.toISOString() ?? null; } catch { /* settings unreadable */ }
  return { running: cur !== null, current: cur, last: lastSyncStatus(), nextRunAt };
};

export const HANDLERS2: Record<string, Handler> = {
  getAccounts,
  getGmailAuthUrl,
  exchangeGmailCode,
  removeAccount,
  syncEmails,
  listThreads,
  lookupThread,
  getThread,
  getEmailAttachment,
  listCompanies,
  clearThreadBrandsCache,
  scanGmail: (input) => scanGmail(input),
  generateReply,
  sendReply,
  getFollowUpDrafts,
  sendFollowUp,
  sendGmailDraft,
  getAnalytics: (input) => getAnalytics(input),
  getSyncStatus,
};

export const STREAMERS: Record<string, Streamer> = {
  chatAI: (input, emit) => chatAI(input, emit),
  syncThreadIndex: (input, emit) => syncThreadIndex(input, emit),
  scanGmail: (input, emit) => scanGmail(input, (entry) => emit(entry)),
  runSyncNow: (input, emit) => { parse(z.object({}), input); return runSync("manual", (p) => emit(p)); },
};
