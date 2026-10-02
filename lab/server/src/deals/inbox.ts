/**
 * Deal Organizer — the local-first inbox (Emails page + chat tools).
 *
 * Every read here is SQL over the tables the syncs fill (deals_emails,
 * deals_thread_index, deals_thread_brands, deals_deals, deals_agent_*). Zero
 * Gmail calls, zero AI calls — a page open costs nothing.
 *
 *   listInbox({ view, q, brand })  the Emails page views:
 *      needs_reply   (default) the other side wrote last, not spam/automated, no
 *                    pending draft, deal not lost/done, not marked done, not a
 *                    message the agent judged "no reply needed". Oldest first.
 *      agent_drafted the live agent saved a Gmail draft (newest first).
 *      asked         the agent asked Jake on Slack and he hasn't answered.
 *      waiting       Jake wrote last ≥ 3 days ago on an open follow-up-stage
 *                    deal's thread (same rule as followUpQueue / the chat).
 *      done          deal lost/completed, marked done, or no reply needed.
 *      all           everything, newest first (search: subject, people, brand,
 *                    snippet, body).
 *      brands        threads grouped by extracted brand (recency order).
 *   followUpQueue()   deal-level "waiting on them" / "owed reply" (chat tool).
 *
 * Own tables:
 *   deals_inbox_refresh  one row per light inbox refresh (gmailSync.refreshInbox)
 *   deals_inbox_marks    "no reply needed" marks, per thread + latest message
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { gmailThreadUrl } from "./integrations/gmail.js";
import { domainOf, rootDomain } from "./common.js";
import { dealsForThread, brandForThread, isAgencySender, latestThreadForDeal } from "./matching.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_inbox_refresh (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  skipped TEXT,
  counts TEXT NOT NULL DEFAULT '{}',
  error TEXT
);
CREATE INDEX IF NOT EXISTS deals_inbox_refresh_started ON deals_inbox_refresh (started_at);

CREATE TABLE IF NOT EXISTS deals_inbox_marks (
  thread_id TEXT PRIMARY KEY,
  message_id TEXT,
  mark TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
`);

const DAY = 86_400_000;
const now = () => new Date().toISOString();

/* ── refresh log ─────────────────────────────────────────────────────────── */

export interface InboxRefreshRecord {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  skipped: string | null;
  counts: Record<string, number>;
  error: string | null;
}

function toRefresh(r: any): InboxRefreshRecord {
  let counts: Record<string, number> = {};
  try { counts = JSON.parse(r.counts || "{}"); } catch { /* keep {} */ }
  return {
    id: r.id, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at ?? null,
    ok: r.ok === null || r.ok === undefined ? null : r.ok === 1, skipped: r.skipped ?? null, counts, error: r.error ?? null,
  };
}

export function recordRefresh(rec: Omit<InboxRefreshRecord, "id"> & { id?: string }): string {
  const id = rec.id ?? randomUUID();
  db.prepare(`INSERT INTO deals_inbox_refresh (id, trigger, started_at, finished_at, ok, skipped, counts, error)
      VALUES (@id, @trigger, @startedAt, @finishedAt, @ok, @skipped, @counts, @error)
      ON CONFLICT(id) DO UPDATE SET finished_at = @finishedAt, ok = @ok, skipped = @skipped, counts = @counts, error = @error`)
    .run({
      id, trigger: rec.trigger, startedAt: rec.startedAt, finishedAt: rec.finishedAt,
      ok: rec.ok === null ? null : rec.ok ? 1 : 0, skipped: rec.skipped, counts: JSON.stringify(rec.counts ?? {}), error: rec.error,
    });
  db.prepare(`DELETE FROM deals_inbox_refresh WHERE id NOT IN (SELECT id FROM deals_inbox_refresh ORDER BY started_at DESC LIMIT 300)`).run();
  return id;
}

/** Last refresh that actually ran (ok or failed), last attempt of any kind, and today's Gmail call count. */
export function inboxRefreshStatus(): { lastOk: InboxRefreshRecord | null; lastAttempt: InboxRefreshRecord | null; gmailCallsToday: number; refreshesToday: number } {
  const lastOk = db.prepare(`SELECT * FROM deals_inbox_refresh WHERE ok = 1 ORDER BY started_at DESC LIMIT 1`).get();
  const lastAttempt = db.prepare(`SELECT * FROM deals_inbox_refresh ORDER BY started_at DESC LIMIT 1`).get();
  const since = new Date(Date.now() - DAY).toISOString();
  const rows = db.prepare(`SELECT counts FROM deals_inbox_refresh WHERE started_at >= ?`).all(since) as { counts: string }[];
  let calls = 0;
  for (const r of rows) { try { calls += Number(JSON.parse(r.counts || "{}").gmailCalls ?? 0); } catch { /* skip */ } }
  return { lastOk: lastOk ? toRefresh(lastOk) : null, lastAttempt: lastAttempt ? toRefresh(lastAttempt) : null, gmailCallsToday: calls, refreshesToday: rows.length };
}

/* ── marks ───────────────────────────────────────────────────────────────── */

export function markThreadDone(threadId: string, done: boolean, note?: string): void {
  if (!done) { db.prepare(`DELETE FROM deals_inbox_marks WHERE thread_id = ?`).run(threadId); return; }
  const last = db.prepare(`SELECT message_id FROM deals_emails WHERE thread_id = ? AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%') ORDER BY date_iso DESC, rowid DESC LIMIT 1`).get(threadId) as { message_id: string } | undefined;
  db.prepare(`INSERT INTO deals_inbox_marks (thread_id, message_id, mark, note, created_at) VALUES (?, ?, 'done', ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET message_id = excluded.message_id, mark = excluded.mark, note = excluded.note, created_at = excluded.created_at`)
    .run(threadId, last?.message_id ?? null, note ?? null, now());
}

/* ── stages ──────────────────────────────────────────────────────────────── */

/** Follow-up stages by KEY — the same list as replies.ts getFollowUpDrafts. */
export const FOLLOW_UP_STAGE_KEYS = [
  "started_negotiation_no_answer",
  "to_follow_up_with",
  "potential_future_collaboration",
  "contract_negotiation",
  "new_requests",
];
const LOST_KEYS = new Set(["rejected", "poor_fit_now"]);
const DONE_KEYS = new Set(["completed", "second_invoice_paid"]);

interface StageInfo { key: string; name: string; production: boolean; order: number }
function stageMap(): Map<string, StageInfo> {
  const rows = db.prepare(`SELECT stage_key, display_name, is_production_stage, sort_order FROM deals_stage_config`).all() as any[];
  const m = new Map<string, StageInfo>();
  for (const r of rows) if (r.display_name) m.set(r.display_name, { key: r.stage_key, name: r.display_name, production: r.is_production_stage === 1, order: r.sort_order ?? 0 });
  return m;
}

export type DealState = "open" | "production" | "lost" | "done";
function dealState(stage: StageInfo | undefined, archived: boolean): DealState {
  if (archived) return "lost";
  if (!stage) return "open";
  if (LOST_KEYS.has(stage.key)) return "lost";
  if (DONE_KEYS.has(stage.key)) return "done";
  if (stage.production) return "production";
  return "open";
}

/* ── automated / noise ───────────────────────────────────────────────────── */

const AUTOMATED_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|noreply-\w+|notifications?|notify|mailer-daemon|postmaster|alerts?|digest|newsletters?|billing|receipts?|affiliates?|calendar-notification|drive-shares-\w+|comments-noreply|security)([._+-]|$)/i;
const AUTOMATED_ROOTS = new Set([
  "google.com", "youtube.com", "facebookmail.com", "linkedin.com", "stripe.com", "wise.com", "paypal.com", "anthropic.com",
  "claude.ai", "openai.com", "skool.com", "github.com", "substack.com", "similarweb.com", "rewardful.com", "tiktok.com",
  "fillout.com", "zite.com", "slack.com", "notion.so", "medium.com", "mailchimp.com", "hubspot.com", "canva.com",
]);
export function isAutomatedSender(email: string): boolean {
  const e = (email || "").toLowerCase();
  if (!e.includes("@")) return false;
  const [local, dom] = e.split("@");
  return AUTOMATED_LOCAL.test(local) || AUTOMATED_ROOTS.has(rootDomain(dom));
}

/* ── thread summaries (one pass over the local tables) ───────────────────── */

export interface InboxDeal { id: string; name: string; stage: string; stageKey: string | null; state: DealState; matchedBy: "thread" | "email" | "domain" }
export interface InboxAgent {
  itemId: string; decision: string; reason: string; draftText: string | null; checksOk: boolean | null;
  gmailDraftId: string | null; createdAt: string; forLatest: boolean; sent: boolean;
}
export interface InboxQuestion { id: string; question: string; proposal: string | null; askedAt: string; slackPermalink: string | null }
export interface InboxThread {
  threadId: string;
  subject: string;
  counterpart: { name: string; email: string };
  brand: string | null;
  isAgency: boolean;
  snippet: string;
  lastAt: string | null;
  lastFromMe: boolean;
  lastInboundAt: string | null;
  waitingDays: number | null;
  messageCount: number;
  unread: boolean;
  hasGmailDraft: boolean;
  labels: string[];
  junk: boolean;
  automated: boolean;
  deal: InboxDeal | null;
  agent: InboxAgent | null;
  question: InboxQuestion | null;
  markedDone: boolean;
  doneReason: string | null;
  gmailUrl: string;
}

const j = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
const emailIn = (raw: string | null | undefined): string => {
  const s = String(raw ?? "").split(",")[0] ?? "";
  return (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase();
};

/** Every thread with local mail, derived fields filled. ~1k threads → a few ms. */
export function threadSummaries(myEmail: string): InboxThread[] {
  const me = (myEmail || "").toLowerCase();
  const rows = db.prepare(`
    WITH e AS (
      SELECT thread_id, message_id, date_iso, is_from_me, from_email, from_name, to_email, subject, snippet, labels, is_read,
        CASE WHEN labels LIKE '%"DRAFT"%' THEN 1 ELSE 0 END AS dr, rowid AS rid
      FROM deals_emails WHERE thread_id IS NOT NULL AND thread_id != ''
    ),
    r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY date_iso DESC, rid DESC) rn FROM e WHERE dr = 0),
    f AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY date_iso ASC, rid ASC) rn FROM e WHERE dr = 0),
    li AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY date_iso DESC, rid DESC) rn FROM e WHERE dr = 0 AND is_from_me = 0),
    a AS (SELECT thread_id, SUM(1 - dr) n, MAX(CASE WHEN dr = 1 THEN date_iso END) draft_at,
            SUM(CASE WHEN dr = 0 AND is_read = 0 AND is_from_me = 0 THEN 1 ELSE 0 END) unread FROM e GROUP BY thread_id)
    SELECT a.thread_id, a.n, a.draft_at, a.unread,
      r.message_id last_id, r.date_iso last_at, r.is_from_me last_me, r.labels last_labels, r.snippet last_snippet,
      f.subject first_subject, f.from_email first_from, f.from_name first_from_name, f.to_email first_to, f.is_from_me first_me,
      li.date_iso in_at, li.from_email in_from, li.from_name in_from_name, li.message_id in_id,
      ti.subject ti_subject, ti.message_count ti_count
    FROM a
    LEFT JOIN r ON r.thread_id = a.thread_id AND r.rn = 1
    LEFT JOIN f ON f.thread_id = a.thread_id AND f.rn = 1
    LEFT JOIN li ON li.thread_id = a.thread_id AND li.rn = 1
    LEFT JOIN deals_thread_index ti ON ti.thread_id = a.thread_id
  `).all() as any[];

  const brands = new Map<string, { brand: string; domain: string }>();
  for (const b of db.prepare(`SELECT thread_id, brand_name, sender_domain FROM deals_thread_brands`).all() as any[]) {
    if (b.thread_id) brands.set(b.thread_id, { brand: (b.brand_name ?? "").trim(), domain: (b.sender_domain ?? "").toLowerCase() });
  }

  const stages = stageMap();
  const dealRows = db.prepare(`SELECT id, client_name, project_name, client_email, stage, archived, merged_into, source_thread_id, updated_at
    FROM deals_deals WHERE merged_into IS NULL`).all() as any[];
  const live = new Map(dealRows.map((d) => [d.id, d]));
  const toDeal = (d: any, by: InboxDeal["matchedBy"]): InboxDeal => {
    const st = stages.get(d.stage ?? "");
    return { id: d.id, name: d.project_name || d.client_name || "(deal)", stage: d.stage ?? "", stageKey: st?.key ?? null, state: dealState(st, d.archived === 1), matchedBy: by };
  };
  /**
   * The thread's deal = the shared matcher (matching.ts): exactly the deal(s) whose
   * Files list this thread (source, manual link, contact closure, same company +
   * same brand, signing notices), best first. matchedBy: source/manual → "thread",
   * contact/platform → "email", same company + brand → "domain".
   */
  const dealOf = (threadId: string, brand: string | null): InboxDeal | null => {
    for (const h of dealsForThread(threadId, { brand })) {
      const d = live.get(h.dealId);
      if (!d) continue;
      const by: InboxDeal["matchedBy"] = h.matchedBy === "source" || h.matchedBy === "manual" ? "thread" : h.matchedBy === "domain+brand" ? "domain" : "email";
      return toDeal(d, by);
    }
    return null;
  };

  const agentByThread = new Map<string, any>();
  for (const it of db.prepare(`SELECT id, thread_id, message_id, decision, reason, draft_text, checks, gmail_draft_id, created_at FROM deals_agent_items
      WHERE preview = 0 ORDER BY created_at DESC`).all() as any[]) {
    if (!agentByThread.has(it.thread_id)) agentByThread.set(it.thread_id, it);
  }
  const questionByThread = new Map<string, any>();
  for (const q of db.prepare(`SELECT id, thread_id, question, proposal, asked_at, slack_permalink FROM deals_agent_questions
      WHERE kind = 'question' AND answer IS NULL AND preview = 0 ORDER BY asked_at DESC`).all() as any[]) {
    if (!questionByThread.has(q.thread_id)) questionByThread.set(q.thread_id, q);
  }
  const marks = new Map<string, { message_id: string | null; note: string | null }>();
  for (const m of db.prepare(`SELECT thread_id, message_id, note FROM deals_inbox_marks WHERE mark = 'done'`).all() as any[]) marks.set(m.thread_id, m);

  const nowMs = Date.now();
  const out: InboxThread[] = [];
  for (const r of rows) {
    const labels = j<string[]>(r.last_labels, []);
    const lastFromMe = r.last_me === 1;
    const counterpartEmail = (r.in_from || (r.first_me === 1 ? emailIn(r.first_to) : r.first_from) || "").toLowerCase();
    const counterpartName = r.in_from_name || (r.first_me === 1 ? counterpartEmail : r.first_from_name) || counterpartEmail;
    // Brand + agency: the shared logic (extracted brand, else subject / the brand's own domain).
    const brand = brandForThread(r.thread_id) || brands.get(r.thread_id)?.brand || null;
    const isAgency = !!brand && isAgencySender(counterpartEmail, brand);

    const deal = dealOf(r.thread_id, brand);

    const a = agentByThread.get(r.thread_id);
    const agent: InboxAgent | null = a ? (() => {
      const checks = j<Array<{ ok: boolean }>>(a.checks, []);
      return {
        itemId: a.id, decision: a.decision, reason: a.reason ?? "", draftText: a.draft_text ?? null,
        checksOk: checks.length ? checks.every((c) => c.ok) : null, gmailDraftId: a.gmail_draft_id ?? null, createdAt: a.created_at,
        forLatest: !!a.message_id && (a.message_id === r.in_id || a.message_id === r.last_id),
        sent: lastFromMe && !!r.last_at && r.last_at > a.created_at,
      };
    })() : null;
    const q = questionByThread.get(r.thread_id);
    const question: InboxQuestion | null = q ? { id: q.id, question: q.question, proposal: q.proposal ?? null, askedAt: q.asked_at, slackPermalink: q.slack_permalink ?? null } : null;
    const mark = marks.get(r.thread_id);
    const markedDone = !!mark && (!mark.message_id || mark.message_id === r.last_id);
    const hasGmailDraft = !!r.draft_at && (!r.last_at || r.draft_at >= r.last_at);
    const junk = labels.includes("SPAM") || labels.includes("TRASH");
    const automated = isAutomatedSender(counterpartEmail) ||
      (!deal && (labels.includes("CATEGORY_PROMOTIONS") || labels.includes("CATEGORY_UPDATES") || labels.includes("CATEGORY_SOCIAL")));

    let doneReason: string | null = null;
    if (deal?.state === "lost") doneReason = `Deal ${deal.stage || "archived"}`;
    else if (deal?.state === "done") doneReason = `Deal ${deal.stage}`;
    else if (markedDone) doneReason = mark?.note || "Marked no reply needed";
    else if (agent?.forLatest && (agent.decision === "skip" || agent.decision === "spam") && !lastFromMe) doneReason = `Agent: ${agent.reason.slice(0, 140)}`;

    out.push({
      threadId: r.thread_id,
      subject: r.first_subject || r.ti_subject || "(no subject)",
      counterpart: { name: counterpartName, email: counterpartEmail },
      brand,
      isAgency,
      snippet: decodeEntities(r.last_snippet ?? ""),
      lastAt: r.last_at ?? null,
      lastFromMe,
      lastInboundAt: r.in_at ?? null,
      waitingDays: r.last_at ? Math.floor((nowMs - Date.parse(r.last_at)) / DAY) : null,
      messageCount: Math.max(Number(r.n ?? 0), Number(r.ti_count ?? 0)),
      unread: Number(r.unread ?? 0) > 0,
      hasGmailDraft: hasGmailDraft || !!(agent?.gmailDraftId && !agent.sent && agent.forLatest),
      labels,
      junk,
      automated,
      deal,
      agent,
      question,
      markedDone,
      doneReason,
      gmailUrl: gmailThreadUrl(r.thread_id),
    });
  }
  return out;
}

/* ── views ───────────────────────────────────────────────────────────────── */

export type InboxView = "needs_reply" | "agent_drafted" | "asked" | "waiting" | "done" | "all" | "brands";
export const NEEDS_REPLY_WINDOW_DAYS = 60;
const DONE_WINDOW_DAYS = 90;
const WAITING_MIN_DAYS = 3;

const ageDays = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / DAY : Infinity);

/** An open follow-up-stage deal, and this is the deal's live thread (its most recently active one — shared matcher). */
function isFollowUpStage(t: InboxThread): boolean {
  if (!t.deal || t.deal.matchedBy === "domain" || t.deal.state !== "open" || !t.deal.stageKey || !FOLLOW_UP_STAGE_KEYS.includes(t.deal.stageKey)) return false;
  return (latestThreadForDeal(t.deal.id)?.threadId ?? null) === t.threadId;
}

export function inView(t: InboxThread, view: InboxView, opts: { includeOld?: boolean } = {}): boolean {
  switch (view) {
    case "needs_reply":
      return !t.lastFromMe && !t.junk && !t.automated && !t.hasGmailDraft && !t.doneReason &&
        (opts.includeOld || ageDays(t.lastInboundAt) <= NEEDS_REPLY_WINDOW_DAYS);
    case "agent_drafted":
      return !!t.agent && t.agent.decision === "draft" && !!t.agent.gmailDraftId && ageDays(t.agent.createdAt) <= 30;
    case "asked":
      return !!t.question;
    case "waiting":
      return t.lastFromMe && !t.junk && (t.waitingDays ?? 0) >= WAITING_MIN_DAYS && isFollowUpStage(t);
    case "done":
      return !!t.doneReason && !t.junk && (opts.includeOld || ageDays(t.lastAt) <= DONE_WINDOW_DAYS);
    case "all":
    case "brands":
      return true;
  }
}

function sortFor(view: InboxView, list: InboxThread[]): InboxThread[] {
  const ts = (s: string | null) => (s ? Date.parse(s) : 0);
  if (view === "needs_reply") return list.sort((a, b) => ts(a.lastInboundAt) - ts(b.lastInboundAt));
  if (view === "waiting") return list.sort((a, b) => ts(a.lastAt) - ts(b.lastAt));
  if (view === "agent_drafted") return list.sort((a, b) => ts(b.agent?.createdAt ?? null) - ts(a.agent?.createdAt ?? null));
  if (view === "asked") return list.sort((a, b) => ts(b.question?.askedAt ?? null) - ts(a.question?.askedAt ?? null));
  return list.sort((a, b) => ts(b.lastAt) - ts(a.lastAt));
}

function matchesQuery(t: InboxThread, q: string, bodyHits: Set<string>): boolean {
  if (!q) return true;
  const hay = `${t.subject} ${t.counterpart.name} ${t.counterpart.email} ${t.brand ?? ""} ${t.snippet} ${t.deal?.name ?? ""}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w)) || bodyHits.has(t.threadId);
}

function bodySearch(q: string): Set<string> {
  if (!q || q.length < 3) return new Set();
  const rows = db.prepare(`SELECT DISTINCT thread_id FROM deals_emails WHERE body_text LIKE ? LIMIT 400`).all(`%${q}%`) as { thread_id: string }[];
  return new Set(rows.map((r) => r.thread_id));
}

export interface BrandGroup { brand: string; domain: string; threadCount: number; lastAt: string | null; threadIds: string[]; deal: InboxDeal | null; isAgency: boolean; needsReply: number }

export function listInboxData(input: { myEmail: string; view?: InboxView; q?: string; brand?: string; includeOld?: boolean; limit?: number }) {
  const view: InboxView = input.view ?? "needs_reply";
  const q = (input.q ?? "").trim().toLowerCase();
  const all = threadSummaries(input.myEmail);
  const counts: Record<Exclude<InboxView, "brands">, number> = { needs_reply: 0, agent_drafted: 0, asked: 0, waiting: 0, done: 0, all: 0 };
  let olderNeedsReply = 0;
  for (const t of all) {
    for (const v of Object.keys(counts) as Array<keyof typeof counts>) if (inView(t, v)) counts[v]++;
    if (!inView(t, "needs_reply") && inView(t, "needs_reply", { includeOld: true })) olderNeedsReply++;
  }
  const bodyHits = q ? bodySearch(q) : new Set<string>();
  const limit = Math.max(1, Math.min(500, input.limit ?? 200));

  if (view === "brands") {
    const groups = new Map<string, BrandGroup>();
    for (const t of all) {
      if (!t.brand || t.junk) continue;
      if (q && !matchesQuery(t, q, bodyHits)) continue;
      const key = t.brand.toLowerCase();
      const g = groups.get(key) ?? { brand: t.brand, domain: rootDomain(domainOf(t.counterpart.email)), threadCount: 0, lastAt: null, threadIds: [], deal: null, isAgency: t.isAgency, needsReply: 0 };
      g.threadCount++;
      g.threadIds.push(t.threadId);
      if (!g.lastAt || (t.lastAt && t.lastAt > g.lastAt)) g.lastAt = t.lastAt;
      if (!g.deal && t.deal) g.deal = t.deal;
      if (inView(t, "needs_reply")) g.needsReply++;
      groups.set(key, g);
    }
    const brands = [...groups.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "")).slice(0, limit);
    return { view, counts, olderNeedsReply, threads: [] as InboxThread[], brands, total: groups.size };
  }

  const brandFilter = (input.brand ?? "").trim().toLowerCase();
  let list = all.filter((t) => {
    if (brandFilter && (t.brand ?? "").toLowerCase() !== brandFilter) return false;
    if (view === "all") return (q ? true : !t.junk) && matchesQuery(t, q, bodyHits);
    return inView(t, view, { includeOld: input.includeOld }) && matchesQuery(t, q, bodyHits);
  });
  list = sortFor(view, list);
  return { view, counts, olderNeedsReply, threads: list.slice(0, limit), brands: [] as BrandGroup[], total: list.length };
}

/* ── follow-up queue (deal level; the chat's follow_up_queue tool) ────────── */

export interface QueueItem {
  dealId: string; dealName: string; clientName: string; clientEmail: string; stage: string; threadId: string;
  subject: string | null; lastAt: string | null; daysSilent: number | null; lastFromMe: boolean | null;
}

/**
 * Every open (not archived, not merged) deal in a follow-up stage that has a
 * thread, classified by the last real (non-draft) local email of its LIVE
 * thread — the most recently active of all its threads (shared matcher), not
 * just the source thread: Jake last and ≥ minDays old → waiting_on_them; the
 * brand last → owed_reply; no local email → no_emails. ALL candidates, oldest first.
 */
export function followUpQueue(minDays = WAITING_MIN_DAYS) {
  const stages = stageMap();
  const names = [...stages.values()].filter((s) => FOLLOW_UP_STAGE_KEYS.includes(s.key)).map((s) => s.name);
  if (!names.length) return { waitingOnThem: [] as QueueItem[], owedReply: [] as QueueItem[], noEmails: [] as QueueItem[], recent: [] as QueueItem[], totalDeals: 0 };
  const rows = (db.prepare(`
    SELECT d.id, d.client_name, d.project_name, d.client_email, d.stage, d.source_thread_id
    FROM deals_deals d
    WHERE (d.archived IS NULL OR d.archived = 0) AND d.merged_into IS NULL AND d.source_thread_id IS NOT NULL AND d.source_thread_id != ''
      AND d.stage IN (${names.map(() => "?").join(",")})
  `).all(...names) as any[]).map((r) => {
    const lt = latestThreadForDeal(r.id);
    return { ...r, thread_id: lt?.threadId ?? r.source_thread_id, date_iso: lt?.lastAt ?? null, is_from_me: lt?.lastFromMe ? 1 : 0, subject: lt?.subject ?? null };
  });
  const item = (r: any): QueueItem => ({
    dealId: r.id, dealName: r.project_name || r.client_name || "(deal)", clientName: r.client_name ?? "", clientEmail: r.client_email ?? "",
    stage: r.stage ?? "", threadId: r.thread_id, subject: r.subject ?? null, lastAt: r.date_iso ?? null,
    daysSilent: r.date_iso ? Math.floor((Date.now() - Date.parse(r.date_iso)) / DAY) : null,
    lastFromMe: r.date_iso ? r.is_from_me === 1 : null,
  });
  const all = rows.map(item);
  const byAge = (a: QueueItem, b: QueueItem) => (b.daysSilent ?? 0) - (a.daysSilent ?? 0);
  return {
    waitingOnThem: all.filter((i) => i.lastFromMe === true && (i.daysSilent ?? 0) >= minDays).sort(byAge),
    owedReply: all.filter((i) => i.lastFromMe === false).sort(byAge),
    noEmails: all.filter((i) => i.lastFromMe === null),
    recent: all.filter((i) => i.lastFromMe === true && (i.daysSilent ?? 0) < minDays),
    totalDeals: all.length,
  };
}

/* ── thread search (chat search_threads; local only) ─────────────────────── */

/**
 * Local thread search: every word of `q` in subject / people / brand / deal /
 * snippet, or `q` inside a body. Empty `q` = the most recent threads (spam,
 * trash and automated senders left out). Newest first.
 */
export function searchThreadsLocal(myEmail: string, q: string, limit = 12): InboxThread[] {
  const query = (q ?? "").trim().toLowerCase();
  const all = threadSummaries(myEmail);
  const n = Math.max(1, Math.min(50, limit));
  if (!query) return sortFor("all", all.filter((t) => !t.junk && !t.automated)).slice(0, n);
  const body = bodySearch(query);
  const words = query.split(/\s+/).filter(Boolean);
  // Rank: brand / deal / people / subject hits above body-only hits; newest first within a rank.
  const score = (t: InboxThread) => {
    const has = (s: string | null | undefined) => words.every((w) => (s ?? "").toLowerCase().includes(w));
    return (has(t.brand) ? 8 : 0) + (has(t.deal?.name) ? 6 : 0) + (has(`${t.counterpart.name} ${t.counterpart.email}`) ? 5 : 0) +
      (has(t.subject) ? 4 : 0) + (has(t.snippet) ? 1 : 0) + (body.has(t.threadId) ? 1 : 0) + (t.automated ? -3 : 0);
  };
  return all
    .filter((t) => !t.junk && matchesQuery(t, query, body))
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s || (b.t.lastAt ?? "").localeCompare(a.t.lastAt ?? ""))
    .slice(0, n)
    .map((x) => x.t);
}

/** Gmail snippets arrive HTML-escaped ("I&#39;m") — decode for display and search. */
export function decodeEntities(t: string): string {
  return t
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
