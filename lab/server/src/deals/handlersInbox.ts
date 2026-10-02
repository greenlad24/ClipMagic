/**
 * Deal Organizer — endpoints of the Emails-page / chat redesign (2026-09-30).
 * Wired by the integrator in routes.ts next to HANDLERS2 / STREAMERS.
 *
 * HANDLERS_INBOX (JSON; ZERO Gmail and ZERO AI calls unless noted)
 *   listInbox        { view?: needs_reply|agent_drafted|asked|waiting|done|all|brands, q?, brand?, includeOld?, limit? }
 *                    → { view, counts, olderNeedsReply, threads: InboxThread[], brands: BrandGroup[], total, myEmail, refresh }
 *   getInboxStatus   {} → { lastOk, lastAttempt, gmailCallsToday, refreshesToday, everyMinutes, nextRefreshAt, running }
 *   refreshInbox     {} → the light refresh now (history.list + only-new messages; NO AI; skipped while the full sync runs)
 *   getInboxThread   { threadId } → getThread's shape + { inbox: InboxThread | null }   (getThread may do ONE repair fetch)
 *   markInboxDone    { threadId, done?: boolean, note? } → { ok }   ("no reply needed"; undone by done:false or a new message)
 *   linkThreadToDeal { threadId, dealId } → { ok, dealId }   (manual link in deals_deal_threads; also the source
 *                    thread when the deal has none; board stage untouched)
 *   listChatSessions { limit? } / getChatSession { id } / deleteChatSession { id }
 *
 * STREAMERS_INBOX (NDJSON)
 *   chatAgent        { sessionId?, message } — see chatAgent.ts for the chunk types
 *   draftReply       { threadId, instructions? } — chunk { type:'progress', message };
 *                    result = DraftReplyResult (agent drafter, preview; nothing saved)
 *
 * STREAMERS_INBOX_CONCURRENT — streamer names that must NOT use routes.ts's
 * global one-run-per-function guard (chat has its own per-session lock;
 * draftReply its own per-thread one).
 */
import { z } from "zod";
import { db } from "../db/index.js";
import { parse, connectedAccount, FALLBACK_MY_EMAIL, type Handler, type Streamer } from "./common.js";
import { listInboxData, inboxRefreshStatus, markThreadDone, threadSummaries, type InboxView } from "./inbox.js";
import { refreshInbox } from "./gmailSync.js";
import { getThread } from "./threads.js";
import { chatAgent, listChatSessions, getChatSession, deleteChatSession } from "./chatAgent.js";
import { draftReplyForThread } from "./draftService.js";
import { markDealTouched } from "./db.js";
import { syncLockBusy } from "./syncLock.js";
import { gmailThreadUrl } from "./integrations/gmail.js";
import { linkDealThread } from "./dealFiles.js";

const REFRESH_MINUTES = 15;
const myEmail = () => (connectedAccount()?.email ?? FALLBACK_MY_EMAIL).toLowerCase();

function statusPayload() {
  const s = inboxRefreshStatus();
  const lastStart = s.lastAttempt?.startedAt ? Date.parse(s.lastAttempt.startedAt) : NaN;
  return {
    ...s,
    everyMinutes: REFRESH_MINUTES,
    nextRefreshAt: Number.isFinite(lastStart) ? new Date(lastStart + REFRESH_MINUTES * 60_000).toISOString() : null,
    running: syncLockBusy(),
  };
}

const VIEWS = ["needs_reply", "agent_drafted", "asked", "waiting", "done", "all", "brands"] as const;

export const HANDLERS_INBOX: Record<string, Handler> = {
  listInbox: (raw) => {
    const input = parse(z.object({
      view: z.enum(VIEWS).optional(),
      q: z.string().max(200).optional(),
      brand: z.string().max(200).optional(),
      includeOld: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }), raw);
    const me = myEmail();
    return { ...listInboxData({ myEmail: me, view: input.view as InboxView | undefined, q: input.q, brand: input.brand, includeOld: input.includeOld, limit: input.limit }), myEmail: me, refresh: statusPayload() };
  },

  getInboxStatus: (raw) => { parse(z.object({}), raw); return statusPayload(); },

  refreshInbox: async (raw) => {
    parse(z.object({}), raw);
    const r = await refreshInbox("manual");
    return { ...r, status: statusPayload() };
  },

  getInboxThread: async (raw) => {
    const input = parse(z.object({ threadId: z.string().regex(/^[A-Za-z0-9]+$/) }), raw);
    const t: any = await getThread({ threadId: input.threadId });
    const inbox = threadSummaries(myEmail()).find((x) => x.threadId === input.threadId) ?? null;
    return { ...t, gmailUrl: gmailThreadUrl(input.threadId), inbox };
  },

  markInboxDone: (raw) => {
    const input = parse(z.object({ threadId: z.string().regex(/^[A-Za-z0-9]+$/), done: z.boolean().optional(), note: z.string().max(300).optional() }), raw);
    markThreadDone(input.threadId, input.done !== false, input.note);
    return { ok: true };
  },

  linkThreadToDeal: (raw) => {
    const input = parse(z.object({ threadId: z.string().regex(/^[A-Za-z0-9]+$/), dealId: z.string() }), raw);
    const d = db.prepare(`SELECT id, source_thread_id FROM deals_deals WHERE id = ?`).get(input.dealId) as { id: string; source_thread_id: string | null } | undefined;
    if (!d) throw Object.assign(new Error("Deal not found"), { status: 404 });
    // One link table for the Emails page and the deal's "Files & threads" (dealFiles.ts):
    // the thread becomes a manual link. A deal with no source thread also gets it as
    // its source (as before); an existing source thread is kept — re-pointing it would
    // silently drop the deal's original conversation.
    linkDealThread(input.dealId, input.threadId);
    if (!d.source_thread_id) {
      db.prepare(`UPDATE deals_deals SET source_thread_id = ?, thread_link = COALESCE(NULLIF(thread_link, ''), ?), updated_at = ? WHERE id = ?`)
        .run(input.threadId, gmailThreadUrl(input.threadId), new Date().toISOString(), input.dealId);
    }
    markDealTouched(input.dealId);
    return { ok: true, dealId: input.dealId };
  },

  listChatSessions: (raw) => listChatSessions(raw),
  getChatSession: (raw) => getChatSession(raw),
  deleteChatSession: (raw) => deleteChatSession(raw),
};

export const STREAMERS_INBOX: Record<string, Streamer> = {
  chatAgent: (input, emit) => chatAgent(input, emit),
  draftReply: async (raw, emit) => {
    const input = parse(z.object({ threadId: z.string().regex(/^[A-Za-z0-9]+$/), instructions: z.string().max(4000).optional() }), raw);
    return draftReplyForThread({ threadId: input.threadId, instructions: input.instructions, onProgress: (message) => emit({ type: "progress", message }) });
  },
};

/** Streamers that bypass routes.ts's global one-run-per-function guard. */
export const STREAMERS_INBOX_CONCURRENT = new Set(["chatAgent", "draftReply"]);
