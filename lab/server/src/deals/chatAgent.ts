/**
 * Deal Organizer — the Home AI chat as ONE tool-using assistant (redesign
 * 2026-09-30). Replaces the regex router of chat.ts (chatAI stays in place,
 * untouched, for anything still calling it).
 *
 *   model   Claude Sonnet 4.6 (research tier), REAL token streaming, at most
 *           8 tool rounds and ~60k tokens per turn (the last round is forced to
 *           answer in text). System block = role + stage list + the agent's
 *           rulebook + channel context, prompt-cached.
 *   memory  deals_chat_sessions / deals_chat_turns (kept 30 days): each turn's
 *           API messages (tool results clipped) are replayed, so "tell me more
 *           about them" / "the second one" resolve against the conversation.
 *   tools   read: pipeline_summary (the Analytics handler, opaque), search_deals,
 *           get_deal, follow_up_queue, search_threads (local first; Gmail search
 *           only on 0 local hits), get_thread (local first), agent_items,
 *           agent_questions, availability, check_fit (agent/fit.ts + its cache).
 *           action → PROPOSALS only (the UI confirms): draft_reply (draftService
 *           = the agent's drafter), draft_follow_ups (getFollowUpDrafts),
 *           propose_deal_update (confirm chip → updateDeal). Nothing here writes
 *           to Gmail or the board; this assistant cannot send (only a Send
 *           button Jake clicks can — gmail.ts runAsManualSend).
 *
 * STREAM (NDJSON `chunk` values):
 *   { type: "session", sessionId, title }
 *   { type: "text", delta }                                   token stream
 *   { type: "tool", id, name, status: "running"|"done"|"error", label, summary? }
 *   { type: "card", kind, data }   kind: followups | draft | thread | threads |
 *                                  queue | fit | deal_update | deals
 *   { type: "refs", refs: [{ type: "deal"|"thread", id, label, url, gmailUrl? }] }
 *   { type: "usage", rounds, inputTokens, outputTokens, cacheReadTokens, costUsd }
 * RESULT: { sessionId, turnId, text, parts, refs, costUsd, rounds }
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { claudeToolStreamTurn, type ToolTurnBlock } from "../ai/claude.js";
import { modelForTier } from "../ai/config.js";
import { withUsageScope, type ScopedCall } from "../ai/usageScope.js";
import { getAnalytics } from "./analytics.js";
import { loadStageConfig } from "./stageUtils.js";
import { connectedAccount, FALLBACK_MY_EMAIL, parse, type Emit } from "./common.js";
import { followUpQueue, searchThreadsLocal, threadSummaries, type InboxThread } from "./inbox.js";
import { threadsForDeal, latestThreadForDeal, brandForDeal, brandEq } from "./matching.js";
import { getThread as getThreadHandler } from "./threads.js";
import { getFollowUpDrafts } from "./replies.js";
import { draftReplyForThread } from "./draftService.js";
import * as gmail from "./integrations/gmail.js";
import { loadRulebook, channelContext } from "./agent/rulebook.js";
import { computeAvailability } from "./agent/availability.js";
import { checkFit } from "./agent/fit.js";
import { getFitCache, listQuestions } from "./agent/store.js";
import { priceCalls, stripQuoted, longDate } from "./agent/util.js";

/* ── storage ─────────────────────────────────────────────────────────────── */

db.exec(`
CREATE TABLE IF NOT EXISTS deals_chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deals_chat_sessions_updated ON deals_chat_sessions (updated_at);

CREATE TABLE IF NOT EXISTS deals_chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  api_json TEXT NOT NULL,      -- the turn's Messages-API messages (tool results clipped), replayed as memory
  display_json TEXT NOT NULL,  -- what the UI renders: { text, parts, refs }
  cost_usd REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_chat_turns_session ON deals_chat_turns (session_id, seq);
`);

const KEEP_DAYS = 30;
const MAX_ROUNDS = 8;
const TOKEN_CAP = 60_000;
const HISTORY_CHARS = 48_000;
const STORED_TOOL_RESULT_CHARS = 2_500;
const LIVE_TOOL_RESULT_CHARS = 16_000;

function purgeOld(): void {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
  db.prepare(`DELETE FROM deals_chat_turns WHERE session_id IN (SELECT id FROM deals_chat_sessions WHERE updated_at < ?)`).run(cutoff);
  db.prepare(`DELETE FROM deals_chat_sessions WHERE updated_at < ?`).run(cutoff);
}

type ApiMessage = { role: "user" | "assistant"; content: any };

function loadHistory(sessionId: string): ApiMessage[] {
  const turns = db.prepare(`SELECT api_json FROM deals_chat_turns WHERE session_id = ? ORDER BY seq DESC LIMIT 30`).all(sessionId) as { api_json: string }[];
  const picked: ApiMessage[][] = [];
  let chars = 0;
  for (const t of turns) {
    chars += t.api_json.length;
    if (picked.length && chars > HISTORY_CHARS) break;
    try { picked.unshift(JSON.parse(t.api_json)); } catch { /* skip a bad row */ }
  }
  return picked.flat();
}

/* ── display parts + refs ────────────────────────────────────────────────── */

export interface ChatRef { type: "deal" | "thread"; id: string; label: string; url: string; gmailUrl?: string }
export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; status: "running" | "done" | "error"; label: string; summary?: string }
  | { kind: "card"; card: string; data: unknown };

const dealUrl = (id: string) => `/deal-organizer/deals/${id}`;
const threadUrl = (id: string) => `/deal-organizer/emails?thread=${id}`;
const dealRef = (id: string, label: string): ChatRef => ({ type: "deal", id, label, url: dealUrl(id) });
const threadRef = (id: string, label: string): ChatRef => ({ type: "thread", id, label, url: threadUrl(id), gmailUrl: gmail.gmailThreadUrl(id) });

/* ── tools ───────────────────────────────────────────────────────────────── */

interface ToolCtx { myEmail: string; progress: (label: string) => void }
interface ToolOut { result: unknown; summary: string; refs?: ChatRef[]; card?: { kind: string; data: unknown }; /** Spend booked in a nested usage scope (the drafter) — added to the turn. */ costUsd?: number }
interface ToolDef {
  name: string;
  label: (input: any) => string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: any, ctx: ToolCtx) => Promise<ToolOut>;
}

const clip = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

function threadLite(t: InboxThread) {
  return {
    threadId: t.threadId, subject: t.subject, with: t.counterpart.name && t.counterpart.name !== t.counterpart.email ? `${t.counterpart.name} <${t.counterpart.email}>` : t.counterpart.email,
    brand: t.brand, lastAt: t.lastAt, lastFrom: t.lastFromMe ? "Jake" : "them", daysSinceLast: t.waitingDays, messages: t.messageCount,
    hasPendingDraft: t.hasGmailDraft, deal: t.deal ? { id: t.deal.id, name: t.deal.name, stage: t.deal.stage } : null,
    agent: t.agent ? { decision: t.agent.decision, reason: clip(t.agent.reason, 200), forLatestMessage: t.agent.forLatest } : null,
    openQuestionToJake: t.question ? clip(t.question.question, 200) : null, snippet: clip(t.snippet, 160),
  };
}

async function stageInfo() {
  const cfg = await loadStageConfig();
  return cfg;
}

const TOOLS: ToolDef[] = [
  {
    name: "pipeline_summary",
    label: () => "Reading pipeline metrics",
    description: "The pipeline metrics — exactly what the Analytics page shows (revenue, deals per stage/group, win rate, follow-up debt …), plus live board counts per stage. Use for any 'how many / how much / pipeline value / how are we doing' question and quote its numbers verbatim.",
    input_schema: obj({}),
    run: async () => {
      let analytics: unknown = null;
      let error: string | null = null;
      try { analytics = await getAnalytics({}); } catch (e: any) { error = String(e?.message ?? e); }
      const board = db.prepare(`SELECT stage, COUNT(*) AS n FROM deals_deals WHERE (archived IS NULL OR archived = 0) AND merged_into IS NULL GROUP BY stage ORDER BY n DESC`).all();
      const json = JSON.stringify(analytics ?? null);
      return {
        result: { analytics: json.length > 14_000 ? `${json.slice(0, 14_000)}…(truncated)` : analytics, analyticsError: error, liveBoardCountsByStage: board },
        summary: error ? `Analytics unavailable (${clip(error, 80)}) · board counts only` : "Analytics metrics + live board counts",
      };
    },
  },
  {
    name: "search_deals",
    label: (i) => (i?.text ? `Searching deals for "${clip(i.text, 40)}"` : "Listing deals"),
    description: "Search the deal board. text matches client, project/brand, email, description; stage = a stage key or column name. Returns ids for [[deal:ID]] citations.",
    input_schema: obj({
      text: { type: "string", description: "Words to find (brand, person, domain). Empty = all." },
      stage: { type: "string", description: "Stage key (e.g. contract_negotiation) or column name." },
      includeArchived: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 60 },
    }),
    run: async (i) => {
      const cfg = await stageInfo();
      const conds = ["d.merged_into IS NULL"];
      const vals: unknown[] = [];
      if (!i?.includeArchived) conds.push("(d.archived IS NULL OR d.archived = 0)");
      if (i?.stage) {
        const s = String(i.stage);
        const name = cfg.toDB[s] ?? cfg.stagesForAI.find((x) => x.toLowerCase() === s.toLowerCase()) ?? s;
        conds.push("d.stage = ?"); vals.push(name);
      }
      const text = String(i?.text ?? "").trim().toLowerCase();
      if (text) {
        for (const w of text.split(/\s+/).slice(0, 5)) {
          conds.push("(lower(coalesce(d.client_name,'')) || ' ' || lower(coalesce(d.project_name,'')) || ' ' || lower(coalesce(d.client_email,'')) || ' ' || lower(coalesce(d.description,''))) LIKE ?");
          vals.push(`%${w}%`);
        }
      }
      const limit = Math.max(1, Math.min(60, Number(i?.limit) || 25));
      const rows = db.prepare(`
        WITH last AS (SELECT thread_id, date_iso, is_from_me, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY date_iso DESC, rowid DESC) rn
                      FROM deals_emails WHERE labels IS NULL OR labels NOT LIKE '%"DRAFT"%')
        SELECT d.id, d.client_name, d.project_name, d.client_email, d.stage, d.estimated_value, d.deadline, d.updated_at, d.archived, d.source_thread_id,
               l.date_iso AS last_email_at, l.is_from_me AS last_from_me
        FROM deals_deals d LEFT JOIN last l ON l.thread_id = d.source_thread_id AND l.rn = 1
        WHERE ${conds.join(" AND ")}
        ORDER BY d.updated_at DESC LIMIT ?`).all(...vals, limit) as any[];
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM deals_deals d WHERE ${conds.join(" AND ")}`).get(...vals) as any).n;
      const deals = rows.map((r) => {
        // Last email across ALL the deal's threads (shared matcher), not just its source thread.
        const lt = latestThreadForDeal(r.id);
        const lastAt = lt?.lastAt ?? r.last_email_at ?? null;
        const lastMe = lt?.lastAt ? lt.lastFromMe === true : r.last_from_me === 1;
        return {
          id: r.id, name: r.project_name || r.client_name, client: r.client_name, email: r.client_email, stage: r.stage,
          boardValueUsd: r.estimated_value ?? null, deadline: r.deadline ?? null, updatedAt: r.updated_at, archived: r.archived === 1,
          threadId: lt?.threadId ?? r.source_thread_id ?? null, lastEmailAt: lastAt, lastEmailFrom: lastAt ? (lastMe ? "Jake" : "them") : null,
        };
      });
      return {
        result: { total, shown: deals.length, deals, note: "boardValueUsd: 5,500 is an old default, not a real price." },
        summary: `${total} deal${total === 1 ? "" : "s"} found`,
        refs: deals.map((d) => dealRef(d.id, d.name || d.client || "deal")),
        card: deals.length ? { kind: "deals", data: { deals: deals.slice(0, 12), total } } : undefined,
      };
    },
  },
  {
    name: "get_deal",
    label: () => "Opening a deal",
    description: "Everything about one deal: fields, recent comments, open to-dos, and the latest messages across ALL its email threads (the same threads as the card's Files).",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
    run: async (i) => {
      const d = db.prepare(`SELECT * FROM deals_deals WHERE id = ?`).get(String(i?.id ?? "")) as any;
      if (!d) return { result: { error: "No deal with that id." }, summary: "Deal not found" };
      const comments = db.prepare(`SELECT author, content, created_at FROM deals_deal_comments WHERE deal_id = ? ORDER BY created_at DESC LIMIT 6`).all(d.id) as any[];
      const actions = db.prepare(`SELECT content, status, created_at FROM deals_deal_actions WHERE deal_id = ? AND status != 'Done' ORDER BY created_at DESC LIMIT 10`).all(d.id) as any[];
      // ALL the deal's threads (shared matcher — the same set as the card's Files), latest emails across them.
      const dealThreads = threadsForDeal(d.id).filter((t) => t.matchedBy !== "platform");
      const tids = dealThreads.length ? dealThreads.map((t) => t.threadId) : d.source_thread_id ? [d.source_thread_id] : [];
      const msgs = tids.length ? db.prepare(`SELECT thread_id, subject, from_name, is_from_me, date_iso, body_text, snippet FROM deals_emails WHERE thread_id IN (${tids.map(() => "?").join(",")}) AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%') ORDER BY date_iso DESC LIMIT 4`).all(...tids) as any[] : [];
      const name = d.project_name || d.client_name || "deal";
      const live = latestThreadForDeal(d.id)?.threadId ?? d.source_thread_id ?? null;
      const refs = [dealRef(d.id, name), ...(live ? [threadRef(live, `${name} thread`)] : [])];
      return {
        result: {
          id: d.id, name, client: d.client_name, email: d.client_email, stage: d.stage, boardValueUsd: d.estimated_value ?? null, deadline: d.deadline ?? null,
          archived: d.archived === 1, about: clip(d.about, 600), opportunity: clip(d.opportunity, 600), keyDetails: clip(d.key_details, 900), nextSteps: clip(d.next_steps, 500),
          description: clip(d.description, 500), links: clip(d.links, 400), createdAt: d.created_at, updatedAt: d.updated_at, stageChangedAt: d.stage_changed_at ?? null,
          threadId: live, threadIds: tids, brand: brandForDeal(d.id), lastFollowUpDraftedAt: d.last_follow_up_drafted_at ?? null, lastFollowUpSentAt: d.last_follow_up_sent_at ?? null,
          comments: comments.map((c) => ({ by: c.author, at: c.created_at, text: clip(c.content, 300) })),
          openTodos: actions.map((a) => ({ status: a.status, text: clip(a.content, 200) })),
          latestEmails: msgs.map((m) => ({ from: m.is_from_me === 1 ? "Jake" : m.from_name, at: m.date_iso, ...(tids.length > 1 ? { thread: clip(m.subject, 80) } : {}), text: clip(stripQuoted(m.body_text || m.snippet || ""), 700) })),
        },
        summary: `${name} — ${d.stage}`,
        refs,
      };
    },
  },
  {
    name: "follow_up_queue",
    label: () => "Checking who needs a follow-up",
    description: "Follow-up debt from the synced emails, over ALL open deals in follow-up stages (New Requests, Negotiation, To Follow Up With, Started Negotiation, Potential Future Collaboration): waiting_on_them = Jake wrote last ≥ minDays ago; owed_reply = the brand wrote last (Jake owes a reply). Sorted oldest first.",
    input_schema: obj({
      kind: { type: "string", enum: ["waiting_on_them", "owed_reply", "both"] },
      minDays: { type: "integer", minimum: 0, maximum: 365 },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Items listed per group (counts always cover everything)." },
    }),
    run: async (i) => {
      const minDays = Number.isFinite(Number(i?.minDays)) ? Number(i.minDays) : 3;
      const q = followUpQueue(minDays);
      const kind = i?.kind ?? "both";
      const limit = Math.max(1, Math.min(200, Number(i?.limit) || 30));
      const fmt = (x: typeof q.waitingOnThem[number]) => ({ dealId: x.dealId, deal: x.dealName, stage: x.stage, daysSilent: x.daysSilent, threadId: x.threadId, subject: x.subject });
      const result = {
        counts: { waitingOnThem: q.waitingOnThem.length, owedReply: q.owedReply.length, noEmailsSynced: q.noEmails.length, jakeWroteRecently: q.recent.length, dealsConsidered: q.totalDeals },
        minDays,
        waitingOnThem: kind === "owed_reply" ? undefined : q.waitingOnThem.slice(0, limit).map(fmt),
        owedReply: kind === "waiting_on_them" ? undefined : q.owedReply.slice(0, limit).map(fmt),
      };
      const shown = [...(result.waitingOnThem ?? []), ...(result.owedReply ?? [])];
      return {
        result,
        summary: `Checked ${q.totalDeals} deals · ${q.waitingOnThem.length} waiting on them · ${q.owedReply.length} owe a reply`,
        refs: shown.map((x) => dealRef(x.dealId, x.deal)),
        card: { kind: "queue", data: { counts: result.counts, minDays, waitingOnThem: q.waitingOnThem.slice(0, 60), owedReply: q.owedReply.slice(0, 60), kind } },
      };
    },
  },
  {
    name: "search_threads",
    label: (i) => (i?.q ? `Searching emails for "${clip(i.q, 40)}"` : "Loading recent threads"),
    description: "Find email threads in the synced mailbox by brand, person, domain or subject words. Pass ONLY the name/keyword as q (e.g. 'apify', not 'pull up the apify thread'). q='' lists the most recent threads. Searches Gmail itself only when nothing local matches.",
    input_schema: obj({ q: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 } }),
    run: async (i, ctx) => {
      const q = String(i?.q ?? "").trim();
      const limit = Math.max(1, Math.min(30, Number(i?.limit) || 10));
      const local = searchThreadsLocal(ctx.myEmail, q, limit);
      if (!q) {
        const threads = local.map(threadLite);
        return {
          result: { source: "local", count: threads.length, threads },
          summary: `${threads.length} thread${threads.length === 1 ? "" : "s"} (most recent)`,
          refs: local.map((t) => threadRef(t.threadId, t.brand || t.subject)),
          card: threads.length ? { kind: "threads", data: { q, threads } } : undefined,
        };
      }
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hasAll = (x: string | null | undefined) => words.length > 0 && words.every((w) => (x ?? "").toLowerCase().includes(w));
      const where = (t: InboxThread) => {
        const m = [hasAll(t.brand) && "brand", hasAll(t.subject) && "subject", hasAll(`${t.counterpart.name} ${t.counterpart.email}`) && "sender", hasAll(t.deal?.name) && "deal"].filter(Boolean);
        return m.length ? m.join("+") : "email body only (the name may just be mentioned)";
      };
      const threads: any[] = local.map((t) => ({ ...threadLite(t), matchedIn: where(t) }));
      const strong = threads.some((t) => t.matchedIn !== "email body only (the name may just be mentioned)");
      // Deals on the board whose thread isn't synced locally yet.
      const localIds = new Set(local.map((t) => t.threadId));
      const dealRows = db.prepare(`SELECT id, client_name, project_name, stage, source_thread_id FROM deals_deals WHERE merged_into IS NULL AND source_thread_id IS NOT NULL AND source_thread_id != ''
          AND ${words.map(() => "(lower(coalesce(project_name,'')) || ' ' || lower(coalesce(client_name,'')) || ' ' || lower(coalesce(client_email,''))) LIKE ?").join(" AND ")}
          ORDER BY updated_at DESC LIMIT 5`).all(...words.map((w) => `%${w}%`)) as any[];
      for (const d of dealRows) {
        if (localIds.has(d.source_thread_id)) continue;
        localIds.add(d.source_thread_id);
        threads.push({ threadId: d.source_thread_id, subject: d.project_name || d.client_name, deal: { id: d.id, name: d.project_name || d.client_name, stage: d.stage }, matchedIn: "deal board (thread not synced locally — get_thread fetches it)", local: false });
      }
      let source = "local";
      if (!strong && !dealRows.length) {
        // Nothing solid locally → ONE Gmail search (read-only).
        try {
          const r: any = await gmail.listThreads(`"${q.replace(/"/g, "")}" -in:spam -in:trash`, limit);
          for (const t of r.threads ?? []) {
            if (localIds.has(t.id)) continue;
            localIds.add(t.id);
            threads.push({ threadId: t.id, snippet: clip(t.snippet, 200), matchedIn: "Gmail search (not synced locally — get_thread fetches it)", local: false });
          }
          source = "local+gmail";
        } catch (e: any) {
          source = `local (Gmail search failed: ${clip(e?.message ?? e, 80)})`;
        }
      }
      const shown = threads.slice(0, limit + 5);
      return {
        result: { source, count: shown.length, threads: shown },
        summary: `${shown.length} thread${shown.length === 1 ? "" : "s"} for "${clip(q, 30)}"${source !== "local" ? ` (${source})` : ""}`,
        refs: shown.map((t) => threadRef(t.threadId, t.brand || t.deal?.name || t.subject || clip(t.snippet, 40) || "thread")),
        card: local.length ? { kind: "threads", data: { q, threads: local.map(threadLite) } } : undefined,
      };
    },
  },
  {
    name: "get_thread",
    label: () => "Reading the thread",
    description: "Read one email thread (oldest first, quotes stripped): who said what, plus its deal, the email agent's decision and any open question to Jake.",
    input_schema: obj({ threadId: { type: "string" }, maxMessages: { type: "integer", minimum: 1, maximum: 20 } }, ["threadId"]),
    run: async (i, ctx) => {
      const threadId = String(i?.threadId ?? "").trim();
      if (!/^[A-Za-z0-9]+$/.test(threadId)) return { result: { error: "Invalid threadId" }, summary: "Invalid thread id" };
      const t: any = await getThreadHandler({ threadId });
      const all = (t.messages ?? []).filter((m: any) => !m.isDraft);
      if (!all.length) return { result: { error: "Thread not found (not synced and not in Gmail)." }, summary: "Thread not found" };
      const max = Math.max(1, Math.min(20, Number(i?.maxMessages) || 8));
      const shown = all.slice(-max);
      const summary = threadSummaries(ctx.myEmail).find((s) => s.threadId === threadId) ?? null;
      const messages = shown.map((m: any) => ({ from: m.isFromMe ? "Jake" : `${m.fromName} <${m.fromEmail}>`, date: m.date, text: clip(stripQuoted(m.body || ""), 1500) }));
      const refs: ChatRef[] = [threadRef(threadId, t.subject || "thread")];
      if (t.dealInfo?.id) refs.push(dealRef(t.dealInfo.id, t.dealInfo.projectName || t.dealInfo.clientName || "deal"));
      return {
        result: {
          threadId, subject: t.subject, totalMessages: all.length, shownMessages: shown.length, messages,
          deal: t.dealInfo ? { id: t.dealInfo.id, name: t.dealInfo.projectName || t.dealInfo.clientName, stage: t.dealInfo.stageName || t.dealInfo.stage } : null,
          agent: summary?.agent ? { decision: summary.agent.decision, reason: clip(summary.agent.reason, 300), hasGmailDraft: !!summary.agent.gmailDraftId } : null,
          openQuestionToJake: summary?.question?.question ?? null,
          pendingDraftInThread: summary?.hasGmailDraft ?? false,
        },
        summary: `${t.subject || "Thread"} · ${all.length} message${all.length === 1 ? "" : "s"}`,
        refs,
        card: {
          kind: "thread",
          data: {
            threadId, subject: t.subject, gmailUrl: gmail.gmailThreadUrl(threadId), totalMessages: all.length,
            deal: t.dealInfo ? { id: t.dealInfo.id, name: t.dealInfo.projectName || t.dealInfo.clientName, stage: t.dealInfo.stageName || t.dealInfo.stage } : null,
            messages: all.slice(-3).map((m: any) => ({ from: m.isFromMe ? "Jake" : m.fromName, isFromMe: !!m.isFromMe, date: m.date, text: clip(stripQuoted(m.body || ""), 600) })),
            agent: summary?.agent ?? null, question: summary?.question ?? null,
          },
        },
      };
    },
  },
  {
    name: "agent_items",
    label: () => "Checking the email agent's work",
    description: "What the live email agent did per thread (draft / ask / skip / spam / flag) with its reason.",
    input_schema: obj({
      decision: { type: "string", enum: ["draft", "ask", "skip", "spam", "flag"] },
      sinceDays: { type: "integer", minimum: 1, maximum: 60 },
      limit: { type: "integer", minimum: 1, maximum: 60 },
    }),
    run: async (i) => {
      const since = new Date(Date.now() - (Number(i?.sinceDays) || 7) * 86_400_000).toISOString();
      const rows = db.prepare(`SELECT id, thread_id, subject, from_addr, brand, stage, decision, reason, gmail_draft_id, deal_id, created_at FROM deals_agent_items
        WHERE preview = 0 AND created_at >= ? ${i?.decision ? "AND decision = ?" : ""} ORDER BY created_at DESC LIMIT ?`)
        .all(...[since, ...(i?.decision ? [i.decision] : []), Math.max(1, Math.min(60, Number(i?.limit) || 25))]) as any[];
      const items = rows.map((r) => ({ threadId: r.thread_id, subject: r.subject, from: r.from_addr, brand: r.brand, decision: r.decision, reason: clip(r.reason, 300), gmailDraftSaved: !!r.gmail_draft_id, dealId: r.deal_id, at: r.created_at }));
      return {
        result: { count: items.length, items },
        summary: `${items.length} agent item${items.length === 1 ? "" : "s"}`,
        refs: items.map((x) => threadRef(x.threadId, x.brand || x.subject || "thread")),
      };
    },
  },
  {
    name: "agent_questions",
    label: () => "Checking the agent's questions",
    description: "Questions the email agent asked Jake on Slack (open = not answered yet).",
    input_schema: obj({ open: { type: "boolean" } }),
    run: async (i) => {
      const qs = listQuestions(i?.open === false ? "answered" : "open").slice(0, 40);
      const rows = db.prepare(`SELECT id, proposal FROM deals_agent_questions WHERE id IN (${qs.map(() => "?").join(",") || "''"})`).all(...qs.map((q) => q.id)) as any[];
      const prop = new Map(rows.map((r) => [r.id, r.proposal]));
      const items = qs.map((q) => ({ threadId: q.threadId, subject: q.subject, question: q.question, proposal: clip(prop.get(q.id), 500), askedAt: q.askedAt, answer: q.answer, slack: q.slackPermalink }));
      return { result: { count: items.length, items }, summary: `${items.length} ${i?.open === false ? "answered" : "open"} question${items.length === 1 ? "" : "s"}`, refs: items.map((x) => threadRef(x.threadId, x.subject || "thread")) };
    },
  },
  {
    name: "availability",
    label: () => "Checking availability",
    description: "Live sponsorship availability from the board (rules #24 #31–#33): slots per month (3 dedicated videos), earliest priority and standard booking windows.",
    input_schema: obj({}),
    run: async () => {
      const a = computeAvailability();
      return { result: { text: a.text, months: a.months.map((m) => ({ month: m.name, booked: m.booked.length, free: m.free })), priorityFrom: a.priorityFrom, standardMonth: a.standardMonth }, summary: `${a.months[0]?.name}: ${a.months[0]?.free} free · priority from ${a.priorityFrom}` };
    },
  },
  {
    name: "check_fit",
    label: (i) => `Checking sponsor fit: ${clip(i?.brand, 40)}`,
    description: "Is a company/product a good sponsor for Jake's channel? The email agent's own fit check (#41: fit / partial / none, with the angle for partial), from the brand's site + a web search; cached 30 days per domain. Pass the company name only (e.g. 'Otter.ai', 'Descript') and its domain if known.",
    input_schema: obj({
      brand: { type: "string" },
      domain: { type: "string", description: "e.g. otter.ai — improves the lookup and the cache key" },
      product: { type: "string" },
    }, ["brand"]),
    run: async (i, ctx) => {
      const brand = String(i?.brand ?? "").trim();
      if (!brand) return { result: { error: "brand is required" }, summary: "No brand given" };
      const domain = String(i?.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") ||
        (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(brand) ? brand.toLowerCase() : "");
      const product = i?.product ? String(i.product) : null;
      const cacheKey = `product:${(domain || brand).toLowerCase()}:${(product ?? "").toLowerCase().slice(0, 40)}`;
      const cached = !!getFitCache(cacheKey);
      if (!cached) ctx.progress(`Researching ${brand} (site + web search)…`);
      const fit = await checkFit({
        kind: "product", brand, product, domain: domain || null, urls: [],
        emailSummary: `Jake asked in the Deal Organizer chat whether ${brand}${product ? ` (${product})` : ""} would be a good sponsor for his channel.`,
        log: (m) => ctx.progress(m),
      });
      const b = brand.toLowerCase().replace(/\.[a-z]+$/, "");
      const past = db.prepare(`SELECT id, client_name, project_name, stage, archived, updated_at FROM deals_deals WHERE merged_into IS NULL AND (lower(coalesce(project_name,'')) LIKE ? OR lower(coalesce(client_name,'')) LIKE ? OR lower(coalesce(client_email,'')) LIKE ?) ORDER BY updated_at DESC LIMIT 5`)
        .all(`%${b}%`, `%${b}%`, `%${domain || b}%`) as any[];
      // + deals whose brand (shared matcher) is this brand, even when their name doesn't say it.
      const seenIds = new Set(past.map((d) => d.id));
      for (const d of db.prepare(`SELECT id, client_name, project_name, stage, archived, updated_at FROM deals_deals WHERE merged_into IS NULL ORDER BY updated_at DESC`).all() as any[]) {
        if (past.length >= 8) break;
        if (!seenIds.has(d.id) && brandEq(brandForDeal(d.id), brand)) { past.push(d); seenIds.add(d.id); }
      }
      const pastDeals = past.map((d) => ({ id: d.id, name: d.project_name || d.client_name, stage: d.stage, archived: d.archived === 1, updatedAt: d.updated_at }));
      return {
        result: { brand, domain: domain || null, verdict: fit.verdict, angle: fit.angle, notes: fit.notes, sources: fit.sources, cached, pastDealsWithThisBrand: pastDeals },
        summary: `${brand}: ${fit.verdict.toUpperCase()}${cached ? " (cached)" : ""}`,
        refs: pastDeals.map((d) => dealRef(d.id, d.name || brand)),
        card: { kind: "fit", data: { brand, domain: domain || null, verdict: fit.verdict, angle: fit.angle, notes: fit.notes, sources: fit.sources, cached, pastDeals } },
      };
    },
  },
  {
    name: "draft_reply",
    label: () => "Drafting a reply (agent drafter)",
    description: "Write a reply draft for one thread with the email agent's own drafter (Opus 5.5 + the rulebook + pre-save checks, one redraft; ~$0.15). Only when Jake asks for a reply/draft. Returns a PROPOSAL shown as a card: Jake edits it, then clicks Send or Save as Gmail draft himself — nothing is saved or sent by this tool.",
    input_schema: obj({
      threadId: { type: "string" },
      instructions: { type: "string", description: "Jake's direction for this reply, in his words (optional)." },
    }, ["threadId"]),
    run: async (i, ctx) => {
      const threadId = String(i?.threadId ?? "").trim();
      const r = await draftReplyForThread({ threadId, instructions: i?.instructions ? String(i.instructions) : undefined, onProgress: (m) => ctx.progress(m) });
      const failed = r.checks.filter((c) => !c.ok);
      const refs: ChatRef[] = [threadRef(threadId, r.brand || r.reply.subject || "thread")];
      if (r.deal) refs.push(dealRef(r.deal.id, r.deal.name));
      return {
        result: {
          action: r.action, summary: r.summary, goal: r.goal, stage: r.stage, brand: r.brand,
          checksPassed: r.checksPassed, failedChecks: failed.map((c) => `${c.name}: ${c.detail}`), warnings: r.warnings,
          ask: r.ask, draftBody: r.action === "draft" ? clip(r.body, 1500) : null, costUsd: r.costUsd,
          note: "The full draft is shown to Jake in a card with Edit / Send / Save as Gmail draft, and he can open the whole thread beside the chat. Do not repeat it.",
        },
        summary: r.action === "draft" ? `Draft ready · checks ${r.checksPassed ? "passed" : `${failed.length} failed`} · $${r.costUsd.toFixed(2)}` : r.action === "ask" ? "The drafter needs your decision" : "The drafter says no reply is needed",
        refs,
        card: { kind: "draft", data: r },
        costUsd: r.costUsd,
      };
    },
  },
  {
    name: "draft_follow_ups",
    label: () => "Writing follow-up drafts",
    description: "Write follow-up drafts for stale deals where JAKE wrote last ≥ 3 days ago (follow_up_queue's waitingOnThem list — never the owedReply ones: those need a real reply → draft_reply). Pass up to 25 dealIds from waitingOnThem; without dealIds it takes the longest-silent eligible deals (max 25 per run). Reads each thread from Gmail, classifies it, drafts template/custom follow-ups. Returns a card — Jake reviews each and sends it or saves it as a Gmail draft. Never moves a deal: a low offer comes back as a suggested stage.",
    input_schema: obj({ dealIds: { type: "array", items: { type: "string" }, maxItems: 25 } }),
    run: async (i, ctx) => {
      // Only deals Jake is waiting on can get a follow-up; the brand-wrote-last ones need a reply.
      const q = followUpQueue(3);
      const waiting = new Set(q.waitingOnThem.map((x) => x.dealId));
      const asked: string[] = Array.isArray(i?.dealIds) ? [...new Set<string>(i.dealIds.map(String))] : [];
      const ids = asked.filter((id) => waiting.has(id)).slice(0, 25);
      const dropped = asked.filter((id) => !waiting.has(id));
      if (asked.length && !ids.length) {
        return { result: { drafts: 0, error: "None of those deals is waiting on the brand (Jake wrote last ≥ 3 days ago). Owed replies need draft_reply per thread.", dropped }, summary: "No eligible deals in that list" };
      }
      ctx.progress(`Reading ${ids.length || "the longest-silent"} thread${ids.length === 1 ? "" : "s"} and writing drafts…`);
      const r: any = await getFollowUpDrafts({ dealIds: ids.length ? ids : undefined });
      const deals: any[] = r.deals ?? [];
      return {
        result: {
          drafts: deals.length, scanned: r.scanned,
          droppedNotWaitingOnThem: dropped.length ? dropped : undefined,
          skippedNote: "A checked deal gets no draft when a draft is already waiting in the thread, the brand has replied since, or the classifier says a follow-up isn't appropriate.",
          items: deals.map((d) => ({ dealId: d.dealId, company: d.companyName, daysSilent: d.daysSinceLast, priorFollowUps: d.priorFollowUpCount, classification: d.classification, suggestedStage: d.suggestedStage ?? null })),
          note: "Shown to Jake as a card (edit / send / save as Gmail draft / skip). Nothing saved or sent yet.",
        },
        summary: `${deals.length} follow-up draft${deals.length === 1 ? "" : "s"} (of ${r.scanned} checked)`,
        refs: deals.map((d) => dealRef(d.dealId, d.companyName)),
        card: { kind: "followups", data: { deals, autoMoved: [] } },
      };
    },
  },
  {
    name: "propose_deal_update",
    label: () => "Preparing a deal change",
    description: "Propose a change to a deal (stage, value, deadline, next steps, agreed price, slot month, lost reason, deal type). Creates a confirm button for Jake — NOTHING changes until he clicks it. Say you proposed it; never say it's done.",
    input_schema: obj({
      dealId: { type: "string" },
      changes: obj({
        stage: { type: "string", description: "Stage key or column name" },
        estimated_value: { type: "number" },
        deadline: { type: "string" },
        next_steps: { type: "string" },
        agreed_price: { type: "number" },
        slot_month: { type: "string", description: "YYYY-MM" },
        lost_reason: { type: "string" },
        deal_type: { type: "string", enum: ["dedicated", "shorts", "service", "other"] },
      }),
      reason: { type: "string" },
    }, ["dealId", "changes"]),
    run: async (i) => {
      const d = db.prepare(`SELECT * FROM deals_deals WHERE id = ?`).get(String(i?.dealId ?? "")) as any;
      if (!d) return { result: { error: "No deal with that id." }, summary: "Deal not found" };
      const cfg = await stageInfo();
      const ch = (i?.changes ?? {}) as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      const current: Record<string, unknown> = {};
      const problems: string[] = [];
      if (ch.stage !== undefined) {
        const s = String(ch.stage);
        const key = cfg.toDB[s] ? s : cfg.fromDB[s] ?? cfg.records.find((r) => (r.displayName ?? "").toLowerCase() === s.toLowerCase() || (r.stageKey ?? "") === s.toLowerCase())?.stageKey;
        if (!key) problems.push(`Unknown stage "${s}"`);
        else {
          updates.stage = key;
          const prod = cfg.prodDbNames.has(cfg.toDB[key]);
          updates.in_production = prod;
          current.stage = d.stage;
          if (prod && !cfg.prodDbNames.has(d.stage)) problems.push("Moving INTO production — only when the contract is signed by both sides (#31).");
        }
      }
      for (const [k, col] of [["estimated_value", "estimated_value"], ["deadline", "deadline"], ["next_steps", "next_steps"], ["agreed_price", "agreed_price"], ["slot_month", "slot_month"], ["lost_reason", "lost_reason"], ["deal_type", "deal_type"]] as const) {
        if (ch[k] === undefined) continue;
        updates[k] = ch[k];
        current[k] = d[col] ?? null;
      }
      if (!Object.keys(updates).length) return { result: { error: "No changes given.", problems }, summary: "Nothing to change" };
      const name = d.project_name || d.client_name || "deal";
      const data = {
        dealId: d.id, dealName: name, current, updates,
        proposedStageName: updates.stage ? cfg.toDB[String(updates.stage)] : null,
        reason: i?.reason ? String(i.reason) : "", warnings: problems,
      };
      return {
        result: { proposed: true, waitingForJakeToConfirm: true, dealId: d.id, updates, warnings: problems },
        summary: `Proposed change to ${name} — waiting for your confirm`,
        refs: [dealRef(d.id, name)],
        card: { kind: "deal_update", data },
      };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const API_TOOLS = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

/* ── system prompt (cached) ──────────────────────────────────────────────── */

async function systemBlocks(): Promise<Array<{ text: string; cache?: boolean }>> {
  const cfg = await loadStageConfig();
  const stages = cfg.records.map((r, i) => `${i + 1}. ${r.displayName} (key ${r.stageKey}${r.isProductionStage ? ", production" : ""})`).join("\n");
  let rulebook = "";
  try { rulebook = loadRulebook(); } catch (e: any) { rulebook = `(rulebook unavailable: ${e?.message ?? e})`; }
  const main = [
    "You are the Deal Organizer assistant for Jake Dawson — the CRM for his YouTube sponsorship deals (AI-tools channel for solopreneurs and small-business owners). You talk to Jake himself.",
    "",
    "WORK THROUGH THE TOOLS. Never invent a number, deal, email, date, price or availability — look it up.",
    "- Pipeline / 'how many / how much / how are we doing' → pipeline_summary (the same numbers as the Analytics page — quote them exactly), search_deals, get_deal, availability.",
    "- Who needs a follow-up / stale / ghosted → follow_up_queue (it counts EVERY candidate). To write them → draft_follow_ups with the dealIds (a review card; nothing saved until Jake clicks).",
    "- A thread or emails with someone ('pull up the apify thread', 'what did Framia say in their last email') → search_threads with ONLY the brand/person as q, then get_thread on the best match. 'emails' / 'inbox' / 'recent threads' → search_threads with q=''.",
    "- A reply ('how should I reply to Softr about the price?', 'draft a reply to …') → find the thread, read it if needed, then draft_reply(threadId, instructions = Jake's direction in his words). It is the email agent's own drafter (Opus 5.5 + rulebook + checks, ~$0.15): call it only when Jake wants a reply/draft, once per thread per request. For 'how should I reply' also give your short advice.",
    "- 'Is X a good sponsor / research X / would X fit' → check_fit with the company name only (e.g. 'Otter.ai', 'Descript') and its domain if you know it. Explain the verdict (fit / partial / none) and the angle.",
    "- What the email agent did or asked → agent_items / agent_questions.",
    "- Changing a deal (stage, value, deadline, next steps, agreed price, slot month, lost reason) → propose_deal_update. It only PROPOSES; Jake confirms with a button. Never say a deal was moved or changed — say you proposed it.",
    "- Follow-ups like 'tell me more about them', 'the second one', 'draft it', 'and Descript?' refer to the conversation so far — resolve them from it (ids are in earlier tool results). Never research a pronoun as a company.",
    "",
    "RULES",
    "- The rulebook below is the source of truth for prices, terms, payment, availability, formats and routing; it wins over old deal values, old emails and your own ideas. Board values of 5,500 are an old default, not a price.",
    "- You never send or save anything. Jake clicks Send (it sends) or Save as Gmail draft on the card himself. Thread links ([[thread:ID]]) open the thread beside the chat, where he can also reply. Never claim you saved, sent or moved anything.",
    "- Cite what you mention from a tool with [[deal:ID]] for a deal and [[thread:THREAD_ID]] for an email thread, ids exactly as the tools returned them. The app turns them into links; don't write URLs for them.",
    "- Be brief — Jake reads on his phone. Lead with the answer, then a short list if needed. When a tool shows a card (drafts, follow-ups, a thread, a fit check, a proposed change, a queue), don't repeat the card — one or two lines on what matters.",
    "- If a tool fails or finds nothing, say so plainly and suggest the next step. Ask a short question only when you truly can't tell what Jake means.",
    "",
    "=== BOARD COLUMNS (in order) ===",
    stages,
    "",
    "=== RULEBOOK (source of truth) ===",
    rulebook,
    "",
    "=== CHANNEL CONTEXT ===",
    channelContext("fit"),
  ].join("\n");
  const today = `Today is ${longDate(new Date())} (Jake is in Bangkok, UTC+7).`;
  return [{ text: main, cache: true }, { text: today }];
}

/* ── the turn ────────────────────────────────────────────────────────────── */

const activeSessions = new Set<string>();

export async function chatAgent(raw: unknown, emit: Emit) {
  const input = parse(z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(8000) }), raw);
  purgeOld();

  let sessionId = input.sessionId && db.prepare(`SELECT id FROM deals_chat_sessions WHERE id = ?`).get(input.sessionId) ? input.sessionId : "";
  const nowIso = new Date().toISOString();
  if (!sessionId) {
    sessionId = randomUUID();
    db.prepare(`INSERT INTO deals_chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(sessionId, clip(input.message.replace(/\s+/g, " ").trim(), 80), nowIso, nowIso);
  }
  if (activeSessions.has(sessionId)) {
    throw Object.assign(new Error("This chat is still answering — wait for it to finish (or start a new chat)."), { status: 409 });
  }
  activeSessions.add(sessionId);
  const title = (db.prepare(`SELECT title FROM deals_chat_sessions WHERE id = ?`).get(sessionId) as any)?.title ?? "";
  emit({ type: "session", sessionId, title });

  const myEmail = (connectedAccount()?.email ?? FALLBACK_MY_EMAIL).toLowerCase();
  const history = loadHistory(sessionId);
  const userMsg: ApiMessage = { role: "user", content: input.message };
  const turnMsgs: ApiMessage[] = [userMsg];
  const parts: ChatPart[] = [];
  const refs = new Map<string, ChatRef>();
  const calls: ScopedCall[] = [];
  let rounds = 0;
  let inputTokens = 0, outputTokens = 0, cacheRead = 0;
  let finalText = "";
  let nestedCost = 0;

  let sepPending = false;
  const pushText = (raw: string) => {
    const d = sepPending ? `\n\n${raw}` : raw;
    sepPending = false;
    const last = parts[parts.length - 1];
    if (last && last.kind === "text") last.text += d;
    else parts.push({ kind: "text", text: d });
    finalText += d;
    emit({ type: "text", delta: d });
  };

  try {
    await withUsageScope({ calls }, async () => {
      const system = await systemBlocks();
      const model = modelForTier("research");
      for (;;) {
        rounds++;
        const force = rounds >= MAX_ROUNDS || inputTokens + outputTokens >= TOKEN_CAP;
        sepPending = !!finalText && !/\n\s*$/.test(finalText);
        const r = await claudeToolStreamTurn({
          model, purpose: "deals-chat", system, tools: API_TOOLS,
          messages: [...history, ...turnMsgs],
          maxTokens: 2500, toolChoice: force ? "none" : "auto", cacheLastMessage: true,
          onText: pushText,
        });
        inputTokens += (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
        outputTokens += r.usage.output_tokens ?? 0;
        cacheRead += r.usage.cache_read_input_tokens ?? 0;
        const content = r.content.filter((b) => b.type !== "text" || b.text.trim());
        if (content.length) turnMsgs.push({ role: "assistant", content });
        const uses = content.filter((b): b is Extract<ToolTurnBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (!uses.length || force) break;

        const results = await Promise.all(uses.map(async (u) => {
          const def = TOOL_BY_NAME.get(u.name);
          const label = def ? def.label(u.input) : u.name;
          const part: ChatPart = { kind: "tool", id: u.id, name: u.name, status: "running", label };
          parts.push(part);
          emit({ type: "tool", id: u.id, name: u.name, status: "running", label });
          const progress = (l: string) => emit({ type: "tool", id: u.id, name: u.name, status: "running", label: l });
          try {
            if (!def) throw new Error(`Unknown tool ${u.name}`);
            const out = await def.run(u.input ?? {}, { myEmail, progress });
            Object.assign(part, { status: "done", summary: out.summary });
            nestedCost += out.costUsd ?? 0;
            emit({ type: "tool", id: u.id, name: u.name, status: "done", label, summary: out.summary });
            if (out.card) {
              parts.push({ kind: "card", card: out.card.kind, data: out.card.data });
              emit({ type: "card", kind: out.card.kind, data: out.card.data });
            }
            const fresh = (out.refs ?? []).filter((x) => !refs.has(`${x.type}:${x.id}`));
            for (const x of fresh) refs.set(`${x.type}:${x.id}`, x);
            if (fresh.length) emit({ type: "refs", refs: fresh });
            const json = JSON.stringify(out.result ?? null);
            return { type: "tool_result", tool_use_id: u.id, content: json.length > LIVE_TOOL_RESULT_CHARS ? `${json.slice(0, LIVE_TOOL_RESULT_CHARS)}…(truncated)` : json };
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            Object.assign(part, { status: "error", summary: clip(msg, 200) });
            emit({ type: "tool", id: u.id, name: u.name, status: "error", label, summary: clip(msg, 200) });
            return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ error: msg }), is_error: true };
          }
        }));
        turnMsgs.push({ role: "user", content: results });
      }
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    sepPending = !!finalText;
    pushText(`Sorry — the assistant hit an error: ${clip(msg, 300)}`);
    // Keep the memory valid: a turn that broke mid-tool-loop is stored as plain text only.
    turnMsgs.splice(1, turnMsgs.length - 1, { role: "assistant", content: finalText || "(error)" });
  } finally {
    activeSessions.delete(sessionId);
  }

  // A turn must end on an assistant message for the replay to alternate.
  if (turnMsgs[turnMsgs.length - 1].role !== "assistant") turnMsgs.push({ role: "assistant", content: finalText.trim() || "(no answer)" });
  const cost = Math.round((priceCalls(calls).usd + nestedCost) * 10000) / 10000;
  emit({ type: "usage", rounds, inputTokens, outputTokens, cacheReadTokens: cacheRead, costUsd: cost });

  // ── persist (tool results clipped for memory) ──
  const stored = turnMsgs.map((m) => (Array.isArray(m.content)
    ? { role: m.role, content: m.content.map((b: any) => (b.type === "tool_result" && typeof b.content === "string" && b.content.length > STORED_TOOL_RESULT_CHARS ? { ...b, content: `${b.content.slice(0, STORED_TOOL_RESULT_CHARS)}…(clipped in memory)` } : b)) }
    : m));
  const refList = [...refs.values()];
  const seq = ((db.prepare(`SELECT MAX(seq) AS s FROM deals_chat_turns WHERE session_id = ?`).get(sessionId) as any)?.s ?? 0) + 1;
  const turnId = randomUUID();
  db.prepare(`INSERT INTO deals_chat_turns (id, session_id, seq, user_text, api_json, display_json, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(turnId, sessionId, seq, input.message, JSON.stringify(stored), JSON.stringify({ text: finalText, parts, refs: refList }), cost, new Date().toISOString());
  db.prepare(`UPDATE deals_chat_sessions SET updated_at = ?, cost_usd = cost_usd + ? WHERE id = ?`).run(new Date().toISOString(), cost, sessionId);

  return { sessionId, turnId, text: finalText, parts, refs: refList, costUsd: cost, rounds };
}

/* ── session handlers ────────────────────────────────────────────────────── */

export function listChatSessions(raw: unknown) {
  const input = parse(z.object({ limit: z.number().int().min(1).max(100).optional() }), raw);
  purgeOld();
  const rows = db.prepare(`SELECT s.id, s.title, s.created_at, s.updated_at, s.cost_usd, (SELECT COUNT(*) FROM deals_chat_turns t WHERE t.session_id = s.id) AS turns
    FROM deals_chat_sessions s ORDER BY s.updated_at DESC LIMIT ?`).all(input.limit ?? 30) as any[];
  return { sessions: rows.map((r) => ({ id: r.id, title: r.title ?? "", createdAt: r.created_at, updatedAt: r.updated_at, costUsd: r.cost_usd ?? 0, turns: r.turns })) };
}

export function getChatSession(raw: unknown) {
  const input = parse(z.object({ id: z.string() }), raw);
  const s = db.prepare(`SELECT * FROM deals_chat_sessions WHERE id = ?`).get(input.id) as any;
  if (!s) throw Object.assign(new Error("Chat not found (chats are kept 30 days)."), { status: 404 });
  const turns = db.prepare(`SELECT id, seq, user_text, display_json, cost_usd, created_at FROM deals_chat_turns WHERE session_id = ? ORDER BY seq`).all(input.id) as any[];
  return {
    session: { id: s.id, title: s.title ?? "", createdAt: s.created_at, updatedAt: s.updated_at, costUsd: s.cost_usd ?? 0 },
    turns: turns.map((t) => {
      let d: any = {};
      try { d = JSON.parse(t.display_json); } catch { /* keep {} */ }
      return { id: t.id, seq: t.seq, userText: t.user_text, text: d.text ?? "", parts: d.parts ?? [], refs: d.refs ?? [], costUsd: t.cost_usd ?? 0, createdAt: t.created_at };
    }),
  };
}

export function deleteChatSession(raw: unknown) {
  const input = parse(z.object({ id: z.string() }), raw);
  db.prepare(`DELETE FROM deals_chat_turns WHERE session_id = ?`).run(input.id);
  const r = db.prepare(`DELETE FROM deals_chat_sessions WHERE id = ?`).run(input.id);
  return { deleted: r.changes > 0 };
}

/** Test/verification hook: the tool registry (names, descriptions, schemas). */
export const CHAT_TOOL_NAMES = TOOLS.map((t) => t.name);
