/**
 * FOLLOW-UP CADENCE + AUTO-CLOSE (2026-09-30) — "without deals falling into
 * the cracks", focused on the brands worth it (agent/focus.ts grades).
 *
 * A deal is SILENT when the newest real message across all its threads is
 * Jake's. The silence starts at Jake's first unanswered email (the anchor);
 * Jake's later emails in the same silence are follow-ups (emails < 24 h apart
 * count as one). Everything is derived from the synced mail, so:
 *   - a follow-up counts only once Jake actually SENT it (a draft never shows
 *     up as a sent message), and Jake's own manual follow-ups count too;
 *   - a drafted-but-unsent follow-up (ledger row, or a DRAFT in the thread)
 *     blocks the next one — never two drafts in a thread (#73).
 *
 * Cadence (days after the anchor, per focus grade; settings.ts):
 *   A 5 / 12 / 21 · B 5 / 12 · C 7 — and never sooner than the gap between two
 *   steps after Jake's last email, so a manual nudge pushes the next one out.
 * Auto-close: cadence used up + `closeAfterDays` (7) of silence → "Poor Fit
 * Now" via the board's updateDeal (stage event + lost_at) with lost reason
 * "ghosted" and a System comment.
 * Backlog: silent ≥ `backlogDays` (60) since Jake's last email → grade A gets
 * ONE re-engagement (closed `backlogCloseAfterDays` (10) later if still
 * silent); B / C close now. Closures are capped per run.
 *
 * Never: a follow-up or close on a deal whose brand wrote last (the inbound
 * agent owns it), in production (not an open deal), in "Potential Future
 * Collaboration" (Jake parked it), or where the focus scorer says a follow-up
 * is wrong (they/Jake declined, "not now"). Never auto-close with a human
 * stage move in the last 14 days, an open Slack question on any deal thread, a
 * draft waiting, or in Waiting For Invoice / Waiting For Payment (agreed deals:
 * follow-ups only).
 *
 * Drafts use the agent's drafter (writeDraft: Opus + rulebook + Jake's voice)
 * and the same pre-save checks (+ a "never re-quote lower" check), saved as
 * Gmail drafts only when saveToGmail is on (live); otherwise preview items.
 */
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import { withUsageScope, type ScopedCall } from "../../ai/usageScope.js";
import { HANDLERS as DEAL_HANDLERS } from "../handlers.js";
import { loadStageConfig } from "../stageUtils.js";
import { gmailConnected, getThread, createReplyDraft } from "../integrations/gmail.js";
import { myAddresses, invalidateMatching } from "../matching.js";
import { getSettings, getFollowUpSettings, type FollowUpSettings } from "./settings.js";
import {
  createRun, updateRun, getRun, insertItem, toItem, answersForThread, relevantLessons, emptyCounts,
  type AgentItem, type Check, type Counts, type Decision, type RunSummary,
} from "./store.js";
import { computeAvailability } from "./availability.js";
import { similarThreads, formatPastThreads } from "./history.js";
import { writeDraft, toHtml, type DraftContext, type DraftResult } from "./draft.js";
import { codeChecks, modelCheck } from "./checks.js";
import { dealContextText, brandHistoryText, transcriptOf, type DealMatch } from "./context.js";
import {
  openDeals, dealThreadIds, localMessages, allFocus, refreshFocus, type OpenDeal, type FocusRow, type LocalMsg, type Grade,
} from "./focus.js";
import {
  ACCOUNT_FALLBACK, parseGmailMessage, domainOf, rootDomain, longDate, errMsg, clip, priceCalls, extractEmail, stripQuoted, FREEMAIL,
  type ParsedMessage,
} from "./util.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_agent_followups (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  deal_id TEXT NOT NULL,
  thread_id TEXT,
  kind TEXT NOT NULL,
  n INTEGER,
  anchor_at TEXT,
  grade TEXT,
  score INTEGER,
  preview INTEGER NOT NULL,
  status TEXT NOT NULL,
  item_id TEXT,
  gmail_draft_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS deals_agent_followups_deal ON deals_agent_followups (deal_id, anchor_at);
`);

const DAY = 86_400_000;
const now = () => new Date().toISOString();
const MERGE_WINDOW = DAY;            // Jake emails < 24 h apart = one touch
const HUMAN_MOVE_DAYS = 14;
const NO_FOLLOW_STAGE_KEYS = new Set(["potential_future_collaboration"]);
const NO_CLOSE_STAGE_KEYS = new Set(["waiting_for_invoice", "waiting_for_payment"]);

/* ── ledger ───────────────────────────────────────────────────────────────── */

type LedgerKind = "followup" | "reengage" | "close" | "nofollow";
type LedgerStatus = "preview" | "drafted" | "sent" | "discarded" | "flagged" | "closed" | "skipped";
interface LedgerRow {
  id: string; runId: string | null; dealId: string; threadId: string | null; kind: LedgerKind; n: number | null; anchorAt: string | null;
  grade: string | null; score: number | null; preview: boolean; status: LedgerStatus; itemId: string | null; gmailDraftId: string | null;
  createdAt: string; resolvedAt: string | null; note: string | null;
}
const toLedger = (r: any): LedgerRow => ({
  id: r.id, runId: r.run_id, dealId: r.deal_id, threadId: r.thread_id, kind: r.kind, n: r.n, anchorAt: r.anchor_at, grade: r.grade, score: r.score,
  preview: r.preview === 1, status: r.status, itemId: r.item_id, gmailDraftId: r.gmail_draft_id, createdAt: r.created_at, resolvedAt: r.resolved_at, note: r.note,
});

function insertLedger(r: Omit<LedgerRow, "id" | "createdAt" | "resolvedAt">): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO deals_agent_followups (id, run_id, deal_id, thread_id, kind, n, anchor_at, grade, score, preview, status, item_id, gmail_draft_id, created_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, r.runId, r.dealId, r.threadId, r.kind, r.n, r.anchorAt, r.grade, r.score, r.preview ? 1 : 0, r.status, r.itemId, r.gmailDraftId, now(), r.note,
  );
  return id;
}

/** Live rows for this deal + silence (preview rows never block or count). */
function liveLedger(dealId: string, anchorAt: string): LedgerRow[] {
  return (db.prepare(`SELECT * FROM deals_agent_followups WHERE deal_id = ? AND anchor_at = ? AND preview = 0 ORDER BY created_at`).all(dealId, anchorAt) as any[]).map(toLedger);
}

/**
 * Live drafted follow-ups: SENT once Jake's real message shows up in the
 * thread after the draft was saved; DISCARDED when the Gmail draft is gone
 * without a send (checked with one threads.get, only after a day).
 */
async function resolveLedger(myEmail: string, log: (m: string) => void): Promise<void> {
  const rows = (db.prepare(`SELECT * FROM deals_agent_followups WHERE preview = 0 AND status = 'drafted'`).all() as any[]).map(toLedger);
  for (const r of rows) {
    if (!r.threadId) continue;
    const sent = db.prepare(`SELECT MIN(date_iso) AS d FROM deals_emails WHERE thread_id = ? AND is_from_me = 1 AND date_iso >= ?
      AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%')`).get(r.threadId, new Date(Date.parse(r.createdAt) - 60_000).toISOString()) as { d: string | null };
    if (sent?.d) {
      db.prepare(`UPDATE deals_agent_followups SET status = 'sent', resolved_at = ? WHERE id = ?`).run(sent.d, r.id);
      continue;
    }
    if (Date.now() - Date.parse(r.createdAt) < DAY) continue;
    try {
      const t = await getThread(r.threadId);
      const msgs = (t.messages ?? []).map((m: any) => parseGmailMessage(m, myEmail));
      const sentLive = msgs.find((m: ParsedMessage) => !m.isDraft && m.isFromMe && m.date.getTime() >= Date.parse(r.createdAt) - 60_000);
      if (sentLive) {
        db.prepare(`UPDATE deals_agent_followups SET status = 'sent', resolved_at = ? WHERE id = ?`).run(sentLive.date.toISOString(), r.id);
      } else if (!msgs.some((m: ParsedMessage) => m.isDraft)) {
        db.prepare(`UPDATE deals_agent_followups SET status = 'discarded', resolved_at = ? WHERE id = ?`).run(now(), r.id);
        log(`Follow-up draft for deal ${r.dealId} was deleted without sending — counted as skipped by Jake.`);
      }
    } catch (e) {
      log(`Could not check follow-up draft in thread ${r.threadId}: ${errMsg(e)}`);
    }
  }
}

/* ── guards ───────────────────────────────────────────────────────────────── */

/** A stage move through the board in the last 14 days that wasn't the agent's own. */
function humanMovedRecently(dealId: string): string | null {
  const since = new Date(Date.now() - HUMAN_MOVE_DAYS * DAY).toISOString();
  let events: Array<{ at: string; to_stage: string }> = [];
  try {
    events = db.prepare(`SELECT at, to_stage FROM deals_stage_events WHERE deal_id = ? AND at >= ? AND source = 'board' ORDER BY at DESC`).all(dealId, since) as any[];
  } catch { return null; /* no stage history table yet */ }
  for (const e of events) {
    const agentMove = db.prepare(`SELECT 1 FROM deals_agent_items WHERE deal_id = ? AND (reason LIKE '%moved deal%' OR reason LIKE '%created deal%')
      AND abs(julianday(created_at) - julianday(?)) * 1440 < 10 LIMIT 1`).get(dealId, e.at);
    const ours = db.prepare(`SELECT 1 FROM deals_agent_followups WHERE deal_id = ? AND kind = 'close' AND preview = 0 AND abs(julianday(created_at) - julianday(?)) * 1440 < 10 LIMIT 1`).get(dealId, e.at);
    if (!agentMove && !ours) return `${e.at.slice(0, 10)} → "${e.to_stage}"`;
  }
  return null;
}

function openQuestionOn(threadIds: string[]): boolean {
  if (!threadIds.length) return false;
  return Boolean(db.prepare(`SELECT 1 FROM deals_agent_questions WHERE preview = 0 AND kind = 'question' AND answer IS NULL
    AND thread_id IN (${threadIds.map(() => "?").join(",")}) LIMIT 1`).get(...threadIds));
}

/* ── the plan (pure: local tables only, no AI, no Gmail) ──────────────────── */

export type PlanAction = "followup" | "reengage" | "close" | "wait" | "blocked" | "none";
export interface PlanEntry {
  deal: OpenDeal;
  focus: FocusRow | null;
  action: PlanAction;
  /** Follow-up number this silence (1-based) for followup/reengage; touches so far otherwise. */
  n: number;
  total: number;
  sent: number;
  dueAt: string | null;
  threadIds: string[];
  /** The thread Jake last wrote in — where the follow-up goes. */
  threadId: string | null;
  subject: string;
  counterpart: string;
  anchorAt: string | null;
  lastJakeAt: string | null;
  daysSilent: number | null;
  status: string;
  closeKind?: "cadence" | "backlog" | "reengaged" | "declined" | "not_now";
  /** For action "close": the stage key to move to and the lost reason (null for "not now"). */
  toStageKey?: string;
  lostReason?: string | null;
}

function collapse(msgs: LocalMsg[]): LocalMsg[][] {
  const groups: LocalMsg[][] = [];
  for (const m of msgs) {
    const g = groups[groups.length - 1];
    if (g && Date.parse(m.date) - Date.parse(g[g.length - 1].date) < MERGE_WINDOW) g.push(m);
    else groups.push([m]);
  }
  return groups;
}

const day = (iso: string) => iso.slice(0, 10);
const plus = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();

/** Internal / not-a-sponsorship cards: never followed up or auto-closed. */
function skipReason(deal: OpenDeal): string | null {
  if (deal.dealType && !["dedicated", "shorts"].includes(deal.dealType)) return `Not a sponsorship deal (type "${deal.dealType}") — no follow-ups or auto-close`;
  const email = extractEmail(deal.clientEmail);
  let mine = false;
  try { mine = myAddresses().has(email); } catch { /* ignore */ }
  if (mine || /(^|[@.])(jakedaw\.com|weshare[\w-]*\.[a-z.]+)$/i.test(email) || /\bElad\b/i.test(`${deal.clientName} ${deal.projectName ?? ""}`)) {
    return "Internal card (Jake / Weshare / Elad) — no follow-ups or auto-close";
  }
  return null;
}

/** What to do with ONE deal, from its messages (local, or local + the live Gmail thread). Pure apart from ledger/guard reads. */
function evaluateDeal(deal: OpenDeal, f: FocusRow | null, threadIds: string[], msgs: LocalMsg[], fs: FollowUpSettings, opts: { live: boolean; t0: number }): PlanEntry {
  const t0 = opts.t0;
  const real = msgs.filter((m) => !m.isDraft);
  const base: PlanEntry = {
    deal, focus: f, action: "none", n: 0, total: 0, sent: 0, dueAt: null, threadIds, threadId: null, subject: real[0]?.subject ?? "",
    counterpart: "", anchorAt: null, lastJakeAt: null, daysSilent: null, status: "",
  };
  const mk = (p: Partial<PlanEntry>): PlanEntry => ({ ...base, ...p });
  if (!real.length) return mk({ status: "No emails synced for this deal" });
  const skip = skipReason(deal);
  if (skip) return mk({ status: skip });

  const last = real[real.length - 1];
  const lastInboundIdx = real.map((m) => m.isFromMe).lastIndexOf(false);
  const lastInbound = lastInboundIdx >= 0 ? real[lastInboundIdx] : null;
  base.counterpart = lastInbound?.fromEmail ?? extractEmail(last.to.split(",")[0]);
  base.threadId = last.threadId;
  base.subject = last.subject || base.subject;
  const daysIdle = (t0 - Date.parse(last.date)) / DAY;

  const draftWaitingAfter = (iso: string) => msgs.some((m) => m.isDraft && m.date > iso);
  const closeGuard = (ledgerDrafted: boolean): string | null => {
    if (!fs.autoCloseEnabled) return "auto-close is off";
    if (NO_CLOSE_STAGE_KEYS.has(deal.stageKey)) return `"${deal.stage}" is never auto-closed`;
    const moved = humanMovedRecently(deal.id);
    if (moved) return `moved by hand ${moved} (last ${HUMAN_MOVE_DAYS} days)`;
    if (opts.live && openQuestionOn(threadIds)) return "open Slack question";
    if (ledgerDrafted || draftWaitingAfter(last.date)) return "a draft is waiting in the thread";
    return null;
  };

  if (NO_FOLLOW_STAGE_KEYS.has(deal.stageKey)) return mk({ status: `Parked in "${deal.stage}" — no follow-ups or auto-close` });
  if (!f) return mk({ action: "wait", status: "Not scored yet — scored on the next run" });

  // ── dead deals: the thread shows it's over ──
  const oc = f.reasons.outcome;
  if (!f.followUpOk && oc && oc.state !== "open") {
    if (real.some((m) => !m.isFromMe && m.date > (f.lastMsgAt ?? ""))) return mk({ action: "wait", status: "The brand wrote since the deal was scored — re-scored on the next run" });
    if (daysIdle < 3) return mk({ status: `Conversation ended (${oc.state.replace("_", " ")}) — waiting 3 days before tidying the card` });
    const g = closeGuard(false);
    const move = deadMove(oc.state, oc.lostReason);
    const why = `${oc.state === "not_now" ? "Not now" : oc.state === "they_declined" ? "They declined" : oc.state === "jake_declined" ? "Jake declined" : "Deal ended"}: ${oc.why || f.reasons.followUpWhy}`;
    if (g) return mk({ daysSilent: Math.floor(daysIdle), status: `${why} — not moving: ${g}` });
    return mk({ action: "close", daysSilent: Math.floor(daysIdle), closeKind: oc.state === "not_now" ? "not_now" : "declined", toStageKey: move.stageKey, lostReason: move.lostReason, status: why });
  }

  if (!last.isFromMe) return mk({ status: "Brand wrote last — Jake's reply is due (the inbound agent handles it)" });

  const touches = collapse(real.slice(lastInboundIdx + 1));
  const lastTouch = touches[touches.length - 1];
  const lastJake = lastTouch[lastTouch.length - 1];
  const anchorAt = touches[0][0].date;
  const lastJakeAt = lastJake.date;
  const daysSilent = (t0 - Date.parse(lastJakeAt)) / DAY;
  Object.assign(base, { anchorAt, lastJakeAt, daysSilent: Math.floor(daysSilent), threadId: lastJake.threadId, subject: lastJake.subject || base.subject });

  const grade: Grade = f.grade;
  const cadence = fs.cadence[grade];
  const ledger = opts.live ? liveLedger(deal.id, anchorAt) : [];
  const discarded = ledger.filter((r) => (r.kind === "followup" || r.kind === "reengage") && r.status === "discarded").length;
  const sent = touches.length - 1;
  const consumed = sent + discarded;
  Object.assign(base, { sent, total: cadence.length, n: consumed });

  if (!f.followUpOk) return mk({ status: `No follow-up: ${f.reasons.followUpWhy || "the thread says a follow-up would be wrong"}` });
  const nofollow = ledger.find((r) => r.kind === "nofollow");
  if (nofollow) return mk({ status: `No follow-up (drafter): ${nofollow.note ?? ""}` });

  const ledgerDrafted = ledger.some((r) => r.status === "drafted");
  if (ledgerDrafted || draftWaitingAfter(lastJakeAt)) return mk({ action: "blocked", status: "A draft is waiting in the thread — the next follow-up waits until it's sent or deleted (#73)" });
  if (opts.live && openQuestionOn(threadIds)) return mk({ action: "blocked", status: "Waiting for Jake's answer on Slack" });
  const flaggedRecently = ledger.find((r) => r.status === "flagged" && t0 - Date.parse(r.createdAt) < 3 * DAY);
  if (flaggedRecently) return mk({ action: "blocked", status: `Last follow-up draft failed the checks (${day(flaggedRecently.createdAt)}) — retried after 3 days` });

  const closeOr = (kind: PlanEntry["closeKind"], why: string): PlanEntry => {
    const g = closeGuard(ledgerDrafted);
    if (g) return mk({ action: "none", status: `${why} — not closing: ${g}` });
    return mk({ action: "close", closeKind: kind, toStageKey: "poor_fit_now", lostReason: "ghosted", status: why });
  };

  // A backlog re-engagement already went out (or was dropped by Jake) for this silence.
  const reengage = ledger.find((r) => r.kind === "reengage" && (r.status === "sent" || r.status === "discarded"));
  if (reengage) {
    if (daysSilent >= fs.backlogCloseAfterDays) return closeOr("reengaged", `Re-engagement ${reengage.status === "sent" ? "sent" : "dropped"}, still silent after ${Math.floor(daysSilent)} days`);
    return mk({ action: "wait", dueAt: plus(lastJakeAt, fs.backlogCloseAfterDays), status: `Re-engaged — auto-close ${day(plus(lastJakeAt, fs.backlogCloseAfterDays))} if still silent` });
  }

  // Backlog: silent for months.
  if (daysSilent >= fs.backlogDays) {
    if (grade === "A" && fs.followUpsEnabled) return mk({ action: "reengage", n: consumed + 1, dueAt: lastJakeAt, status: `Silent ${Math.floor(daysSilent)} days — one re-engagement (focus A)` });
    return closeOr("backlog", `Silent ${Math.floor(daysSilent)} days since Jake's last email (focus ${grade})`);
  }

  if (consumed < cadence.length) {
    const dayN = cadence[consumed];
    const gap = dayN - (consumed > 0 ? cadence[consumed - 1] : 0);
    const due = new Date(Math.max(Date.parse(plus(anchorAt, dayN)), Date.parse(plus(lastJakeAt, Math.max(1, gap))))).toISOString();
    if (t0 >= Date.parse(due) && fs.followUpsEnabled) return mk({ action: "followup", n: consumed + 1, dueAt: due, status: `Follow-up #${consumed + 1} of ${cadence.length} due (silent ${Math.floor(daysSilent)} days)` });
    return mk({ action: "wait", dueAt: due, status: fs.followUpsEnabled ? `Follow-up #${consumed + 1} of ${cadence.length} due ${day(due)}` : "Follow-ups are off" });
  }
  const closeDue = plus(lastJakeAt, fs.closeAfterDays);
  if (t0 >= Date.parse(closeDue)) return closeOr("cadence", `${cadence.length ? `All ${cadence.length} follow-up(s) done` : "No follow-ups for this grade"}, silent ${Math.floor(daysSilent)} days`);
  return mk({ action: "wait", dueAt: closeDue, status: `${cadence.length ? `All ${cadence.length} follow-up(s) done` : "No follow-ups for this grade"} — auto-close ${day(closeDue)} if still silent` });
}

/** Where a dead deal goes: "not now" → Potential Future Collaboration; declines → a lost column with a lost reason. */
function deadMove(state: string, reason: string | null): { stageKey: string; lostReason: string | null } {
  if (state === "not_now") return { stageKey: "potential_future_collaboration", lostReason: null };
  const theirs = ["budget", "no_fit", "timing_capacity", "price_below_4k", "duplicate", "not_a_sponsorship", "other"];
  const jakes = ["no_fit", "price_below_4k", "format_not_sold", "duplicate", "not_a_sponsorship", "other"];
  if (state === "they_declined") return { stageKey: "poor_fit_now", lostReason: reason && theirs.includes(reason) ? reason : "budget" };
  if (state === "jake_declined") return { stageKey: "rejected", lostReason: reason && jakes.includes(reason) ? reason : "no_fit" };
  return { stageKey: "poor_fit_now", lostReason: reason && reason !== "ghosted" ? reason : "other" };
}

export async function planFollowUps(fs: FollowUpSettings, opts: { live: boolean; at?: Date }): Promise<PlanEntry[]> {
  const t0 = (opts.at ?? new Date()).getTime();
  const focus = allFocus();
  const deals = await openDeals();
  return deals.map((deal) => {
    const threadIds = dealThreadIds(deal);
    return evaluateDeal(deal, focus.get(deal.id) ?? null, threadIds, localMessages(threadIds), fs, { live: opts.live, t0 });
  });
}

/**
 * Re-check one planned action against the LIVE Gmail thread before acting (the
 * local mail can lag or miss messages — e.g. the imported history has no July).
 * Returns the re-evaluated entry (its action may have changed).
 */
async function revalidate(e: PlanEntry, fs: FollowUpSettings, myEmail: string, live: boolean): Promise<{ entry: PlanEntry; thread: any | null; notFound: boolean }> {
  if (!e.threadId) return { entry: e, thread: null, notFound: false };
  let thread: any;
  try {
    thread = await getThread(e.threadId);
  } catch (err) {
    if (/\(404\)/.test(errMsg(err))) return { entry: e, thread: null, notFound: true };
    throw err;
  }
  const gm: LocalMsg[] = (thread.messages ?? []).map((m: any) => parseGmailMessage(m, myEmail)).map((m: ParsedMessage) => ({
    messageId: m.id, threadId: e.threadId!, subject: m.subject, fromEmail: m.fromEmail, fromName: m.fromName, to: m.to, date: m.date.toISOString(),
    isFromMe: m.isFromMe, isDraft: m.isDraft, body: m.fresh,
  }));
  const others = localMessages(e.threadIds.filter((t) => t !== e.threadId));
  const merged = [...others, ...gm].sort((a, b) => a.date.localeCompare(b.date));
  return { entry: evaluateDeal(e.deal, e.focus, e.threadIds, merged, fs, { live, t0: Date.now() }), thread, notFound: false };
}

/* ── one follow-up draft ──────────────────────────────────────────────────── */

export interface StepCtx {
  runId: string;
  live: { gmail: boolean; slack: boolean };
  myEmail: string;
  signature: string;
  progress: (m: string) => void;
  counts: Counts;
  onItem?: (item: AgentItem) => void;
  saveCounts?: () => void;
}

function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k\b|K\b)?|\b(\d{1,3}(?:,\d{3})+|\d{4,5})\s?(?:USD|usd|dollars)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let v = Number((m[1] ?? m[3] ?? "").replace(/,/g, ""));
    if (m[2]) v *= 1000;
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

/** "Never re-quote a lower price": no dedicated-video number below Jake's last quote, and no new lower number. */
/**
 * no_price_change: a follow-up names no price unless Jake's LAST email in the
 * thread named one — and then only that exact number (never lower, never a
 * "new" rate the brand hasn't seen from this thread).
 */
export function priceChangeCheck(draftBody: string, lastJakeText: string): Check {
  const allowed = [...new Set(moneyAmounts(lastJakeText))];
  const bad = moneyAmounts(draftBody).filter((v) => !allowed.includes(v));
  const fmt = (v: number) => `$${v.toLocaleString("en-US")}`;
  return {
    name: "no_price_change",
    ok: bad.length === 0,
    detail: bad.length
      ? `${bad.map(fmt).join(", ")} ${allowed.length ? `differs from Jake's last email (${allowed.map(fmt).join(", ")})` : "— Jake's last email named no price"}: a follow-up never changes or introduces a price. ${allowed.length ? `Restate only ${allowed.map(fmt).join(" / ")}, or leave the price out.` : "Leave the price out."}`
      : allowed.length ? `No price other than Jake's last one (${allowed.map(fmt).join(", ")}).` : "No price mentioned (Jake's last email named none).",
  };
}

/* ── recipients + greeting ────────────────────────────────────────────────── */

interface Addr { name: string; email: string }
export function parseAddrs(s: string | null | undefined): Addr[] {
  const out: Addr[] = [];
  const re = /(?:"([^"]*)"|([^",<]*?))\s*<([^>\s]+@[^>\s]+)>|([\w.+'-]+@[\w-]+(?:\.[\w-]+)+)/g;
  let m: RegExpExecArray | null;
  const str = String(s ?? "");
  while ((m = re.exec(str))) {
    const email = (m[3] ?? m[4] ?? "").trim().toLowerCase();
    if (!email || out.some((a) => a.email === email)) continue;
    out.push({ name: (m[1] ?? m[2] ?? "").trim(), email });
  }
  return out;
}

const GENERIC_WORD = /^(info|hello|hi|hey|team|contact|partners?|partnerships?|marketing|business|collabs?|collaborations?|support|admin|sales|pr|media|creators?|sponsorships?|sponsors?|influencers?|affiliates?|affiliate|growth|brand|brands|ads|noreply|office|mail|jobs|hr|the|dear|mr|mrs|ms|dr)$/i;
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** A plausible first name from a display name, else from the address' local part; null if neither looks like a person. */
export function firstNameOf(name: string, email: string): string | null {
  const n = name.replace(/["']/g, "").trim();
  if (n && !n.includes("@")) {
    const tok = n.split(/[\s,|/()]+/).find(Boolean) ?? "";
    if (/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{1,20}$/.test(tok) && !GENERIC_WORD.test(tok)) return cap(tok);
  }
  const first = email.split("@")[0].split(/[._-]/)[0] ?? "";
  if (/^[a-z]{3,12}$/i.test(first) && !GENERIC_WORD.test(first) && email.split("@")[0].split(/[._-]/).every((p) => !/\d/.test(p))) return cap(first);
  return null;
}

interface Recipients { to: string; toEmail: string; cc: string | undefined; greet: string; signatureNames: string[] }

/**
 * TO = the brand-side person who last wrote to Jake in this thread (the deal's
 * contact or the same company domain; else someone Jake last wrote to; else the
 * last sender). CC = the other brand-side people on Jake's last email.
 * Greeting = the To person's own first name (never someone who isn't a recipient).
 */
function pickRecipients(msgs: ParsedMessage[], latestJake: ParsedMessage, deal: OpenDeal, me: Set<string>): Recipients | null {
  const client = extractEmail(deal.clientEmail);
  const rootOf = (e: string) => { const r = rootDomain(domainOf(e)); return r && !FREEMAIL.has(r) ? r : null; };
  const clientRoot = rootOf(client);
  const R = parseAddrs(`${latestJake.to},${latestJake.cc}`).filter((a) => !me.has(a.email));
  const inbound = msgs.filter((m) => !m.isFromMe && !me.has(m.fromEmail)).reverse();
  const isClientSide = (e: string) => e === client || (!!clientRoot && rootOf(e) === clientRoot);
  let pick: { email: string; header: string; name: string } | null = null;
  const fromMsg = (m: ParsedMessage) => {
    const rt = parseAddrs(m.replyTo)[0];
    return rt && rt.email !== m.fromEmail && !me.has(rt.email) ? { email: rt.email, header: m.replyTo, name: rt.name || m.fromName } : { email: m.fromEmail, header: m.from, name: m.fromName };
  };
  const c1 = inbound.find((m) => isClientSide(m.fromEmail));
  if (c1) pick = fromMsg(c1);
  if (!pick && client) {
    const seen = msgs.flatMap((m) => parseAddrs(`${m.to},${m.cc}`)).find((a) => a.email === client);
    if (seen) pick = { email: client, header: seen.name ? `${seen.name} <${client}>` : client, name: seen.name };
  }
  if (!pick) { const c3 = inbound.find((m) => R.some((r) => r.email === m.fromEmail)); if (c3) pick = fromMsg(c3); }
  if (!pick && inbound[0]) pick = fromMsg(inbound[0]);
  if (!pick && R[0]) pick = { email: R[0].email, header: R[0].name ? `${R[0].name} <${R[0].email}>` : R[0].email, name: R[0].name };
  if (!pick) return null;
  const toRoot = rootOf(pick.email);
  const cc = R.filter((a) => a.email !== pick!.email && (isClientSide(a.email) || (!!toRoot && rootOf(a.email) === toRoot)))
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));
  // The To person's name: their own From header wins, then any header naming them.
  const ownFrom = msgs.find((m) => m.fromEmail === pick!.email && m.fromName && m.fromName !== pick!.email);
  const headerName = msgs.flatMap((m) => parseAddrs(`${m.to},${m.cc}`)).find((a) => a.email === pick!.email && a.name)?.name ?? "";
  const greet = firstNameOf(ownFrom?.fromName || pick.name || headerName, pick.email) ?? "there";
  // Names the To person signs with (last lines of their own messages) — also allowed as the greeting.
  const signatureNames = [...new Set(msgs.filter((m) => m.fromEmail === pick!.email).flatMap((m) => m.fresh.split("\n").slice(-8))
    .flatMap((l) => l.match(/^[\s\-–—]*([A-Z][a-zÀ-ÿ'-]{1,20})\b/)?.[1] ?? []).filter((w) => !GENERIC_WORD.test(w) && !/^(Best|Kind|Regards|Thanks|Thank|Cheers|Sent|On|From|Warm|Sincerely|Looking|Please|Let|We|I|Our|If)$/.test(w)))];
  return { to: pick.header.trim() || pick.email, toEmail: pick.email, cc: cc.length ? cc.join(", ") : undefined, greet, signatureNames };
}

/** The draft must greet the To person (their name / signature name) or "there" — never anyone else. */
function greetingCheck(body: string, rc: Recipients): Check {
  const first = body.split("\n").find((l) => l.trim())?.trim() ?? "";
  const m = first.match(/^(?:hi|hello|hey|dear)\s+([^,!\n]+?)\s*[,!]/i);
  if (!m) return { name: "greeting", ok: false, detail: `Must open with "Hi ${rc.greet}," (the person the email is addressed to).` };
  const who = m[1].trim().split(/\s+/)[0].toLowerCase();
  const allowed = new Set([rc.greet.toLowerCase(), "there", "team", ...rc.signatureNames.map((n) => n.toLowerCase())]);
  return allowed.has(who)
    ? { name: "greeting", ok: true, detail: `Greets ${m[1].trim()} — the To recipient.` }
    : { name: "greeting", ok: false, detail: `Greets "${m[1].trim()}", but the email goes to ${rc.to}. Open with "Hi ${rc.greet},".` };
}

/** A few of Jake's real FOLLOW-UPS (his email after his own email, 2+ days apart) — voice for nudges. */
function jakeFollowUpSamples(n = 3): string[] {
  try {
    const rows = db.prepare(`
      WITH m AS (
        SELECT thread_id, date_iso, is_from_me, body_text,
               LAG(is_from_me) OVER (PARTITION BY thread_id ORDER BY date_iso) AS prev_me,
               LAG(date_iso) OVER (PARTITION BY thread_id ORDER BY date_iso) AS prev_at
        FROM deals_emails WHERE labels IS NULL OR labels NOT LIKE '%"DRAFT"%'
      )
      SELECT thread_id, body_text FROM m
      WHERE is_from_me = 1 AND prev_me = 1 AND julianday(date_iso) - julianday(prev_at) >= 2 AND date_iso >= '2026-03-01'
      ORDER BY date_iso DESC LIMIT 80`).all() as Array<{ thread_id: string; body_text: string }>;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const t = stripQuoted(r.body_text ?? "").split(/\n\s*Best regards,?/i)[0].trim();
      if (seen.has(r.thread_id) || t.length < 60 || t.length > 900 || /\$\s?\d/.test(t)) continue;
      seen.add(r.thread_id);
      out.push(t);
      if (out.length >= n) break;
    }
    return out;
  } catch {
    return [];
  }
}

function dealMatchOf(deal: OpenDeal): DealMatch {
  return {
    id: deal.id, clientName: deal.clientName, clientEmail: deal.clientEmail, projectName: deal.projectName, stage: deal.stage,
    value: deal.estimatedValue, deadline: deal.deadlineDate, archived: false, updatedAt: "", sourceThreadId: deal.sourceThreadId, matchedBy: "thread",
  };
}

function focusLine(f: FocusRow): string {
  return `focus ${f.grade} (${f.score}) — fit ${f.fit}, price ${f.price.replace("_", " ")}, ease ${f.ease}`;
}

function bump(ctx: StepCtx, decision: Decision, extra: "followUps" | "closed" | null): void {
  const k: Record<Decision, keyof Counts> = { draft: "drafted", skip: "skipped", spam: "spam", flag: "flagged", ask: "asked" };
  (ctx.counts as any)[k[decision]] = ((ctx.counts as any)[k[decision]] ?? 0) + 1;
  if (extra) ctx.counts[extra] = (ctx.counts[extra] ?? 0) + 1;
  try { ctx.saveCounts?.(); } catch { /* ignore */ }
}

function record(ctx: StepCtx, e: PlanEntry, decision: Decision, reason: string, extra: Partial<{ draftText: string | null; checks: Check[]; gmailDraftId: string | null; edgeCase: string; goal: string; from: string; applied: string[] }> = {}): AgentItem {
  const applied = extra.applied ?? [];
  const row = {
    runId: ctx.runId, preview: !ctx.live.gmail, threadId: e.threadId ?? e.deal.sourceThreadId ?? "", messageId: null, subject: e.subject || "(no subject)",
    from: extra.from ?? e.counterpart, brand: e.deal.projectName || e.deal.clientName, stage: e.deal.stage, edgeCase: extra.edgeCase ?? null, goal: extra.goal ?? null,
    decision, reason: applied.length ? `${reason} · ${applied.join("; ")}` : reason, fit: null, draftText: extra.draftText ?? null, checks: extra.checks ?? [],
    gmailDraftId: extra.gmailDraftId ?? null, slackPermalink: null, dealId: e.deal.id, label: null, boardStage: null, applied,
  };
  const id = insertItem(row);
  ctx.progress(`[${decision.toUpperCase()}] ${clip(row.brand, 40)} — ${clip(row.reason, 220)}`);
  const item = toItem({
    id, thread_id: row.threadId, subject: row.subject, from_addr: row.from, brand: row.brand, stage: row.stage, edge_case: row.edgeCase, decision, reason: row.reason,
    fit: null, draft_text: row.draftText, checks: JSON.stringify(row.checks), gmail_draft_id: row.gmailDraftId, slack_permalink: null, deal_id: row.dealId, created_at: now(),
  });
  try { ctx.onItem?.(item); } catch { /* ignore */ }
  return item;
}

async function draftFollowUp(ctx: StepCtx, e: PlanEntry, thread: any, availabilityText: string, boardStages: string[]): Promise<void> {
  const f = e.focus!;
  const kind: LedgerKind = e.action === "reengage" ? "reengage" : "followup";
  const label = kind === "reengage" ? `Re-engagement (silent ${e.daysSilent} days)` : `Follow-up #${e.n} of ${e.total}`;
  const edgeCase = `${kind === "reengage" ? "Re-engagement" : `Follow-up #${e.n}`} · focus ${f.grade}`;
  const ledgerBase = { runId: ctx.runId, dealId: e.deal.id, threadId: e.threadId, kind, n: e.n, anchorAt: e.anchorAt, grade: f.grade, score: f.score, preview: !ctx.live.gmail, gmailDraftId: null as string | null };

  const all: ParsedMessage[] = (thread.messages ?? []).map((m: any) => parseGmailMessage(m, ctx.myEmail));
  const msgs = all.filter((m) => !m.isDraft);
  const latest = msgs[msgs.length - 1];
  if (!latest) return;
  if (all.some((m) => m.isDraft)) {
    record(ctx, e, "skip", `${label} not written: an unsent draft is already waiting in this thread (#73).`, { edgeCase });
    bump(ctx, "skip", null);
    return;
  }
  if (!latest.isFromMe) {
    record(ctx, e, "skip", `${label} not needed: the brand replied since the last sync — the inbound run handles it.`, { edgeCase });
    bump(ctx, "skip", null);
    return;
  }

  const lastInbound = [...msgs].reverse().find((m) => !m.isFromMe) ?? null;
  let me = new Set<string>([ctx.myEmail]);
  try { me = new Set([...myAddresses(), ctx.myEmail]); } catch { /* ignore */ }
  const rc = pickRecipients(msgs, latest, e.deal, me);
  if (!rc) {
    record(ctx, e, "skip", `${label} not written: no brand-side recipient found in the thread.`, { edgeCase });
    bump(ctx, "skip", null);
    return;
  }
  const to = rc.to;
  const counterpartEmail = rc.toEmail;
  const firstName = rc.greet;
  const transcript = transcriptOf(msgs);
  const earlierJake = msgs.filter((m) => m.isFromMe).map((m) => m.fresh);
  const inboundText = msgs.filter((m) => !m.isFromMe).map((m) => m.fresh).join("\n");
  const brand = e.deal.projectName || e.deal.clientName;
  const subject = msgs[0]?.subject || latest.subject || e.subject;
  const domain = rootDomain(domainOf(counterpartEmail));
  const answers = answersForThread(e.threadId!);
  const daysSilent = Math.floor((Date.now() - latest.date.getTime()) / DAY);
  const lastJakePrices = [...new Set(moneyAmounts(latest.fresh))].map((v) => `$${v.toLocaleString("en-US")}`);
  const goal = kind === "reengage"
    ? `Brand silent ${daysSilent} days since Jake's last email (${longDate(latest.date)}); one-time re-engagement to see if the collaboration is still on their roadmap.`
    : `Brand silent ${daysSilent} days since Jake's last email (${longDate(latest.date)}); follow-up #${e.n} of ${e.total} — a light nudge towards the next step.`;

  const brief = [
    kind === "reengage"
      ? `THIS IS A ONE-TIME RE-ENGAGEMENT, not a reply. ${brand} has not answered for ${daysSilent} days (over two months). The latest message in the thread is Jake's own.`
      : `THIS IS FOLLOW-UP #${e.n} OF ${e.total}, not a reply. ${brand} has not answered Jake's email of ${longDate(latest.date)} (${daysSilent} days ago). The latest message in the thread is Jake's own.`,
    `What Jake offered last: ${f.reasons.offered || "(see the thread)"}`,
    `What we are waiting on from them: ${f.reasons.pending || "(see the thread)"}`,
    e.deal.deadlineDate ? `Their deadline / launch date on the card: ${e.deal.deadlineDate}${e.deal.deadlineDate < new Date().toISOString().slice(0, 10) ? " (already passed — don't hold them to it; offer the next available window instead)" : ""}.` : "",
    "Write the follow-up Jake would send:",
    `- The email goes To: ${to}${rc.cc ? ` (Cc: ${rc.cc})` : ""}. Open with exactly "Hi ${firstName}," — greet ONLY the person it is addressed to${rc.signatureNames.length ? ` (their signature name ${rc.signatureNames.join("/")} is also fine)` : ""}; never greet anyone else from the thread.`,
    "- 2–4 short sentences, relaxed and confident, in Jake's voice (see the follow-up samples below).",
    "- Remind them in half a sentence what is on the table / what is pending, then ONE clear, easy next step (e.g. confirm the slot, send the brief, sign the contract, pick a month).",
    kind === "reengage"
      ? "- Ask simply whether this is still on their roadmap; you may mention the next open month from the availability block. Warm, no guilt, no 'last chance'."
      : e.n >= e.total ? "- This is the last scheduled nudge: keep the door open politely (happy to pick it up whenever the timing works). No ultimatum, no 'closing your file'." : "- A light nudge — no pressure, no guilt ('just bumping this', 'did you see my email' are fine only if natural).",
    lastJakePrices.length
      ? `- PRICE: don't mention a price unless it helps; if you do, use ONLY ${lastJakePrices.join(" / ")} exactly as in Jake's last email — never a different number, never the floor, Shorts, discounts or new terms.`
      : "- PRICE: Jake's last email named no price, so the follow-up names NO price at all (no rate, no floor, no Shorts, no discounts, no new terms) — even if older emails quoted an outdated rate.",
    "- Never plant doubts ('will you be ok if…', 'no worries if not'), never apologise for following up, never mention an agent, a follow-up schedule, the board or Slack.",
    "- If a follow-up would be wrong (they declined, Jake declined them, the deal is done, they said 'not now', or Jake's last email already closed the conversation), return action \"no_reply\" and say why in summary.",
    "- Only return \"ask\" if the nudge truly needs something from Jake (a link, a date he hasn't committed to).",
  ].filter(Boolean).join("\n");

  const past = similarThreads({ threadId: e.threadId!, stage: "Reply", edgeCase: "follow-up after the brand went silent", goal, brand, domain, subject });
  const samples = jakeFollowUpSamples(3);
  const dctx: DraftContext = {
    todayLine: `Today is ${longDate(new Date())} (Bangkok).`,
    subject, latestFromName: firstName, transcript, firstReply: false,
    stage: "Reply", edgeCase: kind === "reengage" ? "re-engagement after 2+ months of silence" : `follow-up #${e.n} after silence`, goal,
    brand, product: e.deal.projectName, triageFlags: `Deal ${focusLine(f)}. Reasons — fit: ${f.reasons.fit} | price: ${f.reasons.price} | ease: ${f.reasons.ease}`,
    dealContext: dealContextText([dealMatchOf(e.deal)]), brandHistory: brandHistoryText(e.threadId!, counterpartEmail),
    availabilityText, fitText: `${f.fit.toUpperCase()}. ${f.reasons.fit}`,
    pastThreads: formatPastThreads(past),
    voiceSamples: samples.length ? samples : [],
    lessons: relevantLessons(brand, "Reply").map((l) => `${l.brand ? `[${l.brand}] ` : l.stage ? `[${l.stage}] ` : ""}${l.lesson}`),
    jakeAnswers: answers.map((a) => `Q: ${a.question}\nJake: ${a.answer}`).join("\n\n"),
    audienceSnapshot: "", extraInstructions: brief, boardStages,
  };

  let d: DraftResult = await writeDraft(dctx);
  const finishNoFollow = (why: string) => {
    const it = record(ctx, e, "skip", `${label} not written — ${why} (${focusLine(f)})`, { edgeCase, goal });
    insertLedger({ ...ledgerBase, kind: "nofollow", status: "skipped", itemId: it.id, note: clip(why, 300) });
    bump(ctx, "skip", null);
  };
  if (d.action === "no_reply") return finishNoFollow(`drafter says no follow-up: ${d.summary}`);
  if (d.action === "ask") {
    const it = record(ctx, e, "flag", `${label} needs Jake: ${d.ask?.question ?? d.summary}${d.ask?.proposal ? ` — proposal: ${clip(d.ask.proposal, 300)}` : ""} (${focusLine(f)})`, { edgeCase, goal });
    insertLedger({ ...ledgerBase, status: "flagged", itemId: it.id, note: clip(d.ask?.question ?? d.summary, 300) });
    bump(ctx, "flag", null);
    return;
  }

  const runChecks = async (body: string): Promise<Check[]> => {
    const full = `${body}\n\n${ctx.signature}`;
    const code = codeChecks({ body: full, signature: ctx.signature, firstReply: false, inboundText, approvedOverrides: answers.map((a) => a.answer ?? "").join("\n"), earlierJakeText: earlierJake.join("\n"), fitVerdict: null });
    const rq = priceChangeCheck(body, latest.fresh);
    const gr = greetingCheck(body, rc);
    let model: Check[] = [];
    try {
      model = await modelCheck({
        draft: full, transcript, triageGoal: `${goal} (This is Jake's follow-up to his own unanswered email — the 'latest email' to answer is Jake's; judge it as a nudge, not a reply.)`,
        availabilityText, jakeAnswers: dctx.jakeAnswers, firstReply: false, todayLine: dctx.todayLine,
        facts: [`Product fit (#41): ${dctx.fitText}`, dctx.dealContext ? `Board record:\n${dctx.dealContext}` : ""].filter(Boolean).join("\n\n"),
      });
    } catch (err) {
      model = [{ name: "model_check", ok: false, detail: `Checker model failed: ${errMsg(err)}` }];
    }
    return [...code, rq, gr, ...model];
  };
  let checks = await runChecks(d.body);
  if (checks.some((c) => !c.ok)) {
    const problems = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    ctx.progress(`Redrafting ${label} for ${brand} — ${clip(problems.join(" | "), 200)}`);
    const d2 = await writeDraft(dctx, { previous: d.body, problems });
    if (d2.action === "no_reply") return finishNoFollow(`drafter says no follow-up: ${d2.summary}`);
    if (d2.action === "draft") { d = d2; checks = await runChecks(d.body); }
  }
  const draftText = `${d.body}\n\n${ctx.signature}`;
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    const it = record(ctx, e, "flag", `${label} failed the pre-save checks twice — not saved: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}`, { edgeCase, goal, draftText, checks });
    insertLedger({ ...ledgerBase, status: "flagged", itemId: it.id, note: clip(failed.map((c) => c.name).join(", "), 200) });
    bump(ctx, "flag", null);
    return;
  }

  const applied: string[] = [];
  let gmailDraftId: string | null = null;
  if (ctx.live.gmail) {
    const fresh = await getThread(e.threadId!);
    const freshMsgs: ParsedMessage[] = (fresh.messages ?? []).map((m: any) => parseGmailMessage(m, ctx.myEmail));
    if (freshMsgs.some((m) => m.isDraft)) {
      record(ctx, e, "skip", `${label} not saved: a draft appeared in this thread while the agent was working (#73).`, { edgeCase, goal, draftText, checks });
      bump(ctx, "skip", null);
      return;
    }
    const r = await createReplyDraft({
      threadId: e.threadId!, to, cc: rc.cc, subject, body: draftText, html: toHtml(draftText),
      inReplyTo: latest.messageIdHeader || undefined,
      references: [latest.references, latest.messageIdHeader].filter(Boolean).join(" ") || undefined,
    });
    gmailDraftId = r?.id ?? null;
    applied.push("Gmail draft saved");
    // The board's own follow-up bookkeeping (gmailSync.markFollowUpsSent flips last_follow_up_sent_at once Jake sends it).
    try { db.prepare(`UPDATE deals_deals SET last_follow_up_drafted_at = ? WHERE id = ?`).run(now(), e.deal.id); } catch { /* column optional */ }
  } else {
    applied.push("(preview) draft stored in the Lab only");
  }
  const reasons = `fit: ${clip(f.reasons.fit, 90)}; price: ${clip(f.reasons.price, 90)}; ease: ${clip(f.reasons.ease, 90)}`;
  const it = record(ctx, e, "draft", `${label} · ${focusLine(f)} (${reasons}) — To ${to}${rc.cc ? `, Cc ${rc.cc}` : ""} — ${d.summary}`, { edgeCase, goal, draftText, checks, gmailDraftId, applied, from: to });
  insertLedger({ ...ledgerBase, status: ctx.live.gmail ? "drafted" : "preview", itemId: it.id, gmailDraftId, note: null });
  bump(ctx, "draft", "followUps");
}

/* ── one auto-close / tidy-up move ────────────────────────────────────────── */

/**
 * The agent's own board move: NOT updateDeal (that stamps human_touched_at and
 * marks typed fields as human). stage_source is 'agent-followups' while the
 * stage changes (so the stage trigger records that as the event source), then
 * 'agent'. lost_reason is written as an AI/agent value (not human), and the
 * field-extraction queue flag the trigger raises is put back, so the AI
 * doesn't immediately re-guess the reason we just set.
 */
function agentMoveDeal(dealId: string, toDisplay: string, lostReason: string | null): void {
  db.transaction(() => {
    const cur = db.prepare(`SELECT fields_source, fields_dirty, lost_reason FROM deals_deals WHERE id = ?`).get(dealId) as any;
    if (!cur) throw new Error("deal not found");
    const t = now();
    db.prepare(`UPDATE deals_deals SET stage = ?, stage_source = 'agent-followups', stage_changed_at = ?, updated_at = ? WHERE id = ?`).run(toDisplay, t, t, dealId);
    let src: Record<string, string> = {};
    try { src = cur.fields_source ? JSON.parse(cur.fields_source) : {}; } catch { src = {}; }
    if (lostReason) src.lost_reason = "ai";
    db.prepare(`UPDATE deals_deals SET stage_source = 'agent', lost_reason = ?, fields_source = ?, fields_dirty = ? WHERE id = ?`)
      .run(lostReason ?? cur.lost_reason ?? null, JSON.stringify(src), cur.fields_dirty ?? null, dealId);
  })();
}

async function closeDeal(ctx: StepCtx, e: PlanEntry, toDisplay: string, threadGone: boolean): Promise<void> {
  const f = e.focus;
  const touches = e.sent > 0 ? `${e.sent} follow-up(s)` : "no follow-ups";
  const lost = e.lostReason ?? null;
  const dead = e.closeKind === "declined" || e.closeKind === "not_now";
  const why = dead
    ? `${e.status}${f ? ` (focus ${f.grade})` : ""}`
    : e.closeKind === "backlog"
      ? `no reply for ${e.daysSilent} days since Jake's last email (${e.lastJakeAt ? day(e.lastJakeAt) : "?"}), ${touches}${f ? `, focus ${f.grade}` : ""} — backlog clean-up`
      : e.closeKind === "reengaged"
        ? `no reply ${e.daysSilent} days after the re-engagement email (${e.lastJakeAt ? day(e.lastJakeAt) : "?"})${f ? `, focus ${f.grade}` : ""}`
        : `no reply for ${e.daysSilent} days after the last follow-up (${e.lastJakeAt ? day(e.lastJakeAt) : "?"}), ${touches}${f ? `, focus ${f.grade}` : ""}`;
  const verb = e.closeKind === "not_now" ? "Parked" : "Auto-closed";
  const comment = `${verb} by the agent: ${why}. Moved from "${e.deal.stage}" to "${toDisplay}"${lost ? ` with lost reason "${lost}"` : ""}.${threadGone ? " (The thread is no longer in Gmail.)" : ""} If they write back, the agent picks the thread up again — move the card back any time.`;
  const edgeCase = e.closeKind === "not_now" ? "Auto-park · not now" : `Auto-close · ${lost ?? "closed"}`;
  const applied: string[] = [];
  if (ctx.live.gmail) {
    try {
      agentMoveDeal(e.deal.id, toDisplay, lost);
      await DEAL_HANDLERS.addComment({ dealId: e.deal.id, content: comment, author: "System" });
      applied.push(`moved "${e.deal.stage}" → "${toDisplay}"${lost ? ` (lost: ${lost})` : ""}`);
    } catch (err) {
      record(ctx, e, "flag", `${verb} failed for ${e.deal.projectName || e.deal.clientName}: ${errMsg(err)}`, { edgeCase });
      bump(ctx, "flag", null);
      return;
    }
  } else {
    applied.push(`(preview) would move "${e.deal.stage}" → "${toDisplay}"${lost ? ` (lost: ${lost})` : ""} + System comment`);
  }
  const it = record(ctx, e, "skip", `${verb}${lost ? ` (${lost})` : ""}: ${why}.`, { edgeCase, applied });
  insertLedger({ runId: ctx.runId, dealId: e.deal.id, threadId: e.threadId, kind: "close", n: e.sent, anchorAt: e.anchorAt, grade: f?.grade ?? null, score: f?.score ?? null, preview: !ctx.live.gmail, status: ctx.live.gmail ? "closed" : "preview", itemId: it.id, gmailDraftId: null, note: `${e.closeKind ?? ""}${lost ? `:${lost}` : ""}` });
  bump(ctx, "skip", "closed");
}

/* ── the run step ─────────────────────────────────────────────────────────── */

/** Best first: focus score, then the nearer deadline, then the longest silence. */
function bestFirst(a: PlanEntry, b: PlanEntry): number {
  return (b.focus?.score ?? 0) - (a.focus?.score ?? 0)
    || (a.deal.deadlineDate ?? "9999").localeCompare(b.deal.deadlineDate ?? "9999")
    || (b.daysSilent ?? 0) - (a.daysSilent ?? 0);
}

/** Duplicate cards can share a thread: prefer the card whose contact is a company address, then the best score. */
function companyContact(e: PlanEntry): number {
  const r = rootDomain(domainOf(extractEmail(e.deal.clientEmail)));
  return r && !FREEMAIL.has(r) ? 1 : 0;
}

/**
 * Called by runAgent after the inbound threads are handled. Never throws.
 */
export async function runFollowUpStep(ctx: StepCtx, opts: { focusCap?: number } = {}): Promise<{ plan: PlanEntry[] }> {
  const fs = getFollowUpSettings();
  if (!fs.followUpsEnabled && !fs.autoCloseEnabled) {
    ctx.progress("Follow-ups and auto-close are both off — skipping the follow-up step.");
    return { plan: [] };
  }
  try {
    if (ctx.live.gmail) await resolveLedger(ctx.myEmail, ctx.progress);
  } catch (e) { ctx.progress(`Follow-up ledger check failed: ${errMsg(e)}`); }

  const cap = opts.focusCap ?? fs.focusPerRunCap;
  try {
    let lines = 0;
    const r = await refreshFocus({ cap, log: (m) => { if (lines++ < 40) ctx.progress(m); } });
    ctx.progress(`Focus scores: ${r.scored} (re)scored${r.failed ? `, ${r.failed} failed` : ""}${r.pending ? `, ${r.pending} still waiting (cap ${cap}/run)` : ""} — ${r.total} open deals.`);
  } catch (e) { ctx.progress(`Focus scoring failed: ${errMsg(e)}`); }

  let plan: PlanEntry[] = [];
  try {
    plan = await planFollowUps(fs, { live: ctx.live.gmail });
  } catch (e) {
    ctx.progress(`Follow-up planning failed: ${errMsg(e)}`);
    return { plan: [] };
  }
  // One follow-up per thread (duplicate cards); never close a card whose thread is being followed up.
  const byThread = new Map<string, PlanEntry>();
  for (const p of plan.filter((x) => (x.action === "followup" || x.action === "reengage") && x.threadId)) {
    const cur = byThread.get(p.threadId!);
    if (!cur || companyContact(p) - companyContact(cur) > 0 || (companyContact(p) === companyContact(cur) && bestFirst(p, cur) < 0)) byThread.set(p.threadId!, p);
  }
  const due = [...byThread.values()].sort(bestFirst);
  const closes = plan.filter((p) => p.action === "close" && !(p.threadId && byThread.has(p.threadId))).sort((a, b) => (b.daysSilent ?? 0) - (a.daysSilent ?? 0));
  const deadCount = closes.filter((c) => c.closeKind === "declined" || c.closeKind === "not_now").length;
  ctx.progress(`Follow-ups: ${due.length} due (drafting up to ${fs.perRunCap}, best focus first); closes: ${closes.length} due (${closes.length - deadCount} ghosted, ${deadCount} ended/not-now; up to ${fs.closuresPerRunCap} this run).`);

  const availability = computeAvailability();
  const stageCfg = await loadStageConfig();

  // Follow-ups: each re-checked against the live Gmail thread first; a slot is used only by a real attempt.
  if (fs.followUpsEnabled) {
    let next = 0, attempted = 0;
    const worker = async () => {
      while (next < due.length && attempted < fs.perRunCap) {
        const e0 = due[next++];
        try {
          const v = await revalidate(e0, fs, ctx.myEmail, ctx.live.gmail);
          if (v.notFound) {
            attempted++;
            const it = record(ctx, e0, "skip", `Follow-up not written: this thread no longer exists in the Gmail mailbox (imported history).`, { edgeCase: "Follow-up" });
            insertLedger({ runId: ctx.runId, dealId: e0.deal.id, threadId: e0.threadId, kind: "nofollow", n: e0.n, anchorAt: e0.anchorAt, grade: e0.focus?.grade ?? null, score: e0.focus?.score ?? null, preview: !ctx.live.gmail, status: "skipped", itemId: it.id, gmailDraftId: null, note: "thread not found in Gmail (404)" });
            bump(ctx, "skip", null);
            continue;
          }
          const e = v.entry;
          if (e.action !== "followup" && e.action !== "reengage") {
            ctx.progress(`Re-planned from the live thread — ${e.deal.projectName || e.deal.clientName}: ${e.status}`);
            continue;
          }
          attempted++;
          await draftFollowUp(ctx, e, v.thread, availability.text, stageCfg.stagesForAI);
        } catch (err) {
          record(ctx, e0, "flag", `Follow-up error — nothing written: ${errMsg(err)}`, { edgeCase: "Follow-up" });
          bump(ctx, "flag", null);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  if (fs.autoCloseEnabled) {
    let done = 0;
    for (const e0 of closes) {
      if (done >= fs.closuresPerRunCap) break;
      try {
        const v = await revalidate(e0, fs, ctx.myEmail, ctx.live.gmail);
        const e = v.notFound ? e0 : v.entry;
        if (e.action !== "close") {
          ctx.progress(`Not closing ${e.deal.projectName || e.deal.clientName} — the live thread says: ${e.status}`);
          continue;
        }
        const toDisplay = stageCfg.toDB[e.toStageKey ?? "poor_fit_now"];
        if (!toDisplay) { ctx.progress(`No "${e.toStageKey}" column on the board — can't close ${e.deal.projectName || e.deal.clientName}.`); continue; }
        done++;
        await closeDeal(ctx, e, toDisplay, v.notFound);
      } catch (err) { ctx.progress(`Auto-close failed for ${e0.deal.projectName || e0.deal.clientName}: ${errMsg(err)}`); }
    }
    if (done && ctx.live.gmail) { try { invalidateMatching(); } catch { /* cache only */ } }
  }
  return { plan };
}

/* ── follow-ups on their own (preview button / tests) ─────────────────────── */

/**
 * A PREVIEW run of only the focus + follow-up step (no inbound threads, no
 * learning, no Slack). Always preview: nothing is written to Gmail or the board.
 */
export async function runFollowUpsPreview(opts: { onProgress?: (m: string) => void; onItem?: (i: AgentItem) => void; focusCap?: number } = {}): Promise<RunSummary & { costUsd: number }> {
  const settings = getSettings();
  const run = createRun("manual", true);
  const calls: ScopedCall[] = [];
  const log: string[] = [];
  const progress = (m: string) => { log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); try { opts.onProgress?.(m); } catch { /* ignore */ } };
  const counts: Counts = emptyCounts();
  try {
    await withUsageScope({ calls }, async () => {
      const conn = gmailConnected();
      if (!conn.connected) throw new Error("Gmail is not connected.");
      progress("Follow-ups preview (focus + cadence + auto-close only) — nothing is written to Gmail, Slack or the board.");
      await runFollowUpStep({
        runId: run.id, live: { gmail: false, slack: false }, myEmail: (conn.email ?? ACCOUNT_FALLBACK).toLowerCase(), signature: settings.signature,
        progress, counts, onItem: opts.onItem, saveCounts: () => updateRun(run.id, { counts, log }),
      }, { focusCap: opts.focusCap });
    });
    const cost = priceCalls(calls);
    progress(`Done. ${counts.followUps ?? 0} follow-up draft(s), ${counts.closed ?? 0} auto-close(s). AI cost ≈ $${cost.usd.toFixed(3)}.`);
    updateRun(run.id, { counts, status: "done", finished: true, costUsd: cost.usd, log });
    return { ...getRun(run.id)!, costUsd: cost.usd };
  } catch (e) {
    const cost = priceCalls(calls);
    updateRun(run.id, { counts, status: "failed", error: errMsg(e), finished: true, costUsd: cost.usd, log });
    return { ...getRun(run.id)!, costUsd: cost.usd };
  }
}

/* ── the Focus list (Agent page) ──────────────────────────────────────────── */

export interface FocusListRow {
  dealId: string;
  dealName: string;
  clientEmail: string;
  stage: string;
  grade: Grade | null;
  score: number | null;
  fit: string | null;
  price: string | null;
  ease: string | null;
  reasons: FocusRow["reasons"] | null;
  computedAt: string | null;
  followUp: {
    action: PlanAction; status: string; n: number; total: number; sent: number; dueAt: string | null; lastJakeAt: string | null; daysSilent: number | null; threadId: string | null;
    /** For action "close": where the card goes and why (ghosted / declined / not now). */
    closeKind: string | null; toStageKey: string | null; lostReason: string | null;
  };
}

export async function focusList(): Promise<{ rows: FocusListRow[]; settings: FollowUpSettings; counts: Record<string, number> }> {
  const fs = getFollowUpSettings();
  const plan = await planFollowUps(fs, { live: getSettings().saveToGmail });
  const rows: FocusListRow[] = plan.map((p) => ({
    dealId: p.deal.id, dealName: p.deal.projectName || p.deal.clientName, clientEmail: p.deal.clientEmail, stage: p.deal.stage,
    grade: p.focus?.grade ?? null, score: p.focus?.score ?? null, fit: p.focus?.fit ?? null, price: p.focus?.price ?? null, ease: p.focus?.ease ?? null,
    reasons: p.focus?.reasons ?? null, computedAt: p.focus?.computedAt ?? null,
    followUp: {
      action: p.action, status: p.status, n: p.n, total: p.total, sent: p.sent, dueAt: p.dueAt, lastJakeAt: p.lastJakeAt, daysSilent: p.daysSilent, threadId: p.threadId,
      closeKind: p.closeKind ?? null, toStageKey: p.toStageKey ?? null, lostReason: p.lostReason ?? null,
    },
  }));
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.dealName.localeCompare(b.dealName));
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, unscored: 0, followup: 0, reengage: 0, close: 0, wait: 0, blocked: 0, none: 0 };
  for (const r of rows) {
    counts[r.grade ?? "unscored"]++;
    counts[r.followUp.action]++;
  }
  return { rows, settings: fs, counts };
}
