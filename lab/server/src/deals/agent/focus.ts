/**
 * FOCUS SCORE per open deal (2026-09-30) — which brands are worth Jake's
 * follow-ups: the best-fit, right-price, easy-to-work-with ones.
 *
 * Three dimensions, each judged from the deal's threads (every related thread,
 * local tables only — zero Gmail calls):
 *   fit    the agent's #41 verdict: a cached verdict (agent items for the deal's
 *          threads, then the fit cache by brand/domain) wins; otherwise the
 *          scoring model applies #41 to the pitch in the thread.
 *   price  their stated budget / offer / agreed price vs our range
 *          ($6,500–$7,000, floor $6,000; below $4,000 = low — #19/#27).
 *   ease   demands (revisions, exclusivity, usage rights), contract redlines,
 *          pushback rounds, slow/unclear replies, tone (#31 "easy to work with").
 * The model returns levels + one-line reasons; the SCORE is computed here, in
 * code, so it is stable and explainable:
 *   fit  fit 40 · partial 26 · unknown 20 · none 0
 *   price in_range 35 · near ($4k–$5,999) 16 · unknown 14 · low (<$4k) 5
 *   ease easy 25 · normal 15 · demanding 4
 *   grade A ≥ 72, B ≥ 48, else C; caps: no fit → C; low price or demanding → at most B.
 *
 * Stored in deals_agent_focus; recomputed only when the deal's threads changed
 * (message count or latest message date differ from what was scored).
 * Model: the triage tier (Sonnet), purpose deals-agent-classify.
 */
import { db } from "../../db/index.js";
import { loadStageConfig } from "../stageUtils.js";
import { threadIdsForDeal } from "../matching.js";
import { loadRulebook, channelContext } from "./rulebook.js";
import { aiJSON, triageModel, clip, errMsg, stripQuoted, extractEmail, domainOf, rootDomain, FREEMAIL } from "./util.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_agent_focus (
  deal_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  fit TEXT,
  price TEXT,
  ease TEXT,
  reasons_json TEXT NOT NULL DEFAULT '{}',
  computed_at TEXT NOT NULL,
  thread_msg_count INTEGER NOT NULL DEFAULT 0,
  last_msg_at TEXT,
  fit_source TEXT,
  offer_usd REAL,
  followup_ok INTEGER,
  model TEXT
);
CREATE INDEX IF NOT EXISTS deals_agent_focus_score ON deals_agent_focus (score);
`);

const DAY = 86_400_000;
const now = () => new Date().toISOString();

export type Grade = "A" | "B" | "C";
export type FitLevel = "fit" | "partial" | "none" | "unknown";
export type PriceLevel = "in_range" | "near" | "low" | "unknown";
export type EaseLevel = "easy" | "normal" | "demanding";

export interface FocusReasons {
  fit: string;
  price: string;
  ease: string;
  /** What Jake last offered / what is pending from the brand — fed to the follow-up drafter. */
  offered: string;
  pending: string;
  /** false when a follow-up would be wrong (they declined, Jake declined, deal concluded, "not now"). */
  followUpOk: boolean;
  followUpWhy: string;
  demands: string[];
  lastQuotedUsd: number | null;
  /** How the conversation stands (for closing dead deals with the right lost reason). Absent on old rows. */
  outcome?: { state: OutcomeState; lostReason: string | null; why: string };
}

export type OutcomeState = "open" | "they_declined" | "jake_declined" | "not_now" | "ended_other";
export const LOST_REASONS = ["price_below_4k", "budget", "no_fit", "ghosted", "timing_capacity", "format_not_sold", "duplicate", "not_a_sponsorship", "other"] as const;

export interface FocusRow {
  dealId: string;
  score: number;
  grade: Grade;
  fit: FitLevel;
  price: PriceLevel;
  ease: EaseLevel;
  reasons: FocusReasons;
  computedAt: string;
  threadMsgCount: number;
  lastMsgAt: string | null;
  fitSource: "agent" | "cache" | "thread" | null;
  offerUsd: number | null;
  followUpOk: boolean;
}

const j = (s: string | null | undefined, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function toRow(r: any): FocusRow {
  const reasons = j(r.reasons_json, {});
  return {
    dealId: r.deal_id, score: r.score, grade: r.grade, fit: r.fit, price: r.price, ease: r.ease,
    reasons: {
      fit: "", price: "", ease: "", offered: "", pending: "", followUpOk: true, followUpWhy: "", demands: [], lastQuotedUsd: null,
      ...reasons,
    },
    computedAt: r.computed_at, threadMsgCount: r.thread_msg_count, lastMsgAt: r.last_msg_at ?? null,
    fitSource: r.fit_source ?? null, offerUsd: r.offer_usd ?? null, followUpOk: r.followup_ok !== 0,
  };
}

export function getFocus(dealId: string): FocusRow | null {
  const r = db.prepare(`SELECT * FROM deals_agent_focus WHERE deal_id = ?`).get(dealId);
  return r ? toRow(r) : null;
}

export function allFocus(): Map<string, FocusRow> {
  const m = new Map<string, FocusRow>();
  for (const r of db.prepare(`SELECT * FROM deals_agent_focus`).all() as any[]) m.set(r.deal_id, toRow(r));
  return m;
}

/* ── scoring (pure) ───────────────────────────────────────────────────────── */

const FIT_PTS: Record<FitLevel, number> = { fit: 40, partial: 26, unknown: 20, none: 0 };
const PRICE_PTS: Record<PriceLevel, number> = { in_range: 35, near: 16, unknown: 14, low: 5 };
const EASE_PTS: Record<EaseLevel, number> = { easy: 25, normal: 15, demanding: 4 };

export function scoreOf(fit: FitLevel, price: PriceLevel, ease: EaseLevel): { score: number; grade: Grade } {
  const score = FIT_PTS[fit] + PRICE_PTS[price] + EASE_PTS[ease];
  let grade: Grade = score >= 72 ? "A" : score >= 48 ? "B" : "C";
  if (fit === "none") grade = "C";
  else if ((price === "low" || ease === "demanding") && grade === "A") grade = "B";
  return { score, grade };
}

/* ── open deals + their threads (local tables only) ───────────────────────── */

export interface OpenDeal {
  id: string;
  clientName: string;
  clientEmail: string;
  projectName: string | null;
  stage: string;       // display name (as stored)
  stageKey: string;    // stage key
  sourceThreadId: string | null;
  agreedPrice: number | null;
  estimatedValue: number | null;
  deadlineDate: string | null;
  dealType: string | null;
  about: string | null;
  opportunity: string | null;
  keyDetails: string | null;
  nextSteps: string | null;
}

const LOST_KEYS = new Set(["rejected", "poor_fit_now"]);

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

/** Every open deal: not archived, not merged, not lost, before production. */
export async function openDeals(): Promise<OpenDeal[]> {
  const cfg = await loadStageConfig();
  const names = cfg.records
    .filter((r) => !r.isProductionStage && !LOST_KEYS.has(r.stageKey ?? ""))
    .map((r) => r.displayName ?? "")
    .filter(Boolean);
  if (!names.length) return [];
  const dd = hasColumn("deals_deals", "deadline_date") ? "deadline_date" : "NULL AS deadline_date";
  const ap = hasColumn("deals_deals", "agreed_price") ? "agreed_price, deal_type" : "NULL AS agreed_price, NULL AS deal_type";
  const rows = db.prepare(`SELECT id, client_name, client_email, project_name, stage, source_thread_id, estimated_value, ${ap}, ${dd},
      about, opportunity, key_details, next_steps
    FROM deals_deals WHERE (archived IS NULL OR archived = 0) AND merged_into IS NULL AND stage IN (${names.map(() => "?").join(",")})`).all(...names) as any[];
  return rows.map((r) => ({
    id: r.id, clientName: r.client_name ?? "", clientEmail: r.client_email ?? "", projectName: r.project_name ?? null,
    stage: r.stage, stageKey: cfg.fromDB[r.stage] ?? "", sourceThreadId: r.source_thread_id || null,
    agreedPrice: r.agreed_price ?? null, estimatedValue: r.estimated_value ?? null, deadlineDate: r.deadline_date ?? null, dealType: r.deal_type ?? null,
    about: r.about ?? null, opportunity: r.opportunity ?? null, keyDetails: r.key_details ?? null, nextSteps: r.next_steps ?? null,
  }));
}

/** Thread ids of a deal: the shared matcher (every related thread), the source thread as a floor. */
export function dealThreadIds(deal: { id: string; sourceThreadId: string | null }): string[] {
  const ids = new Set<string>();
  if (deal.sourceThreadId) ids.add(deal.sourceThreadId);
  try {
    for (const t of threadIdsForDeal(deal.id)) ids.add(t);
  } catch { /* matcher unavailable → source thread only */ }
  return [...ids];
}

export interface LocalMsg {
  messageId: string;
  threadId: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  to: string;
  date: string;       // ISO
  isFromMe: boolean;
  isDraft: boolean;
  body: string;       // quotes stripped
}

/** All messages of the given threads from deals_emails, oldest first, de-duplicated (drafts flagged, not removed). */
export function localMessages(threadIds: string[]): LocalMsg[] {
  if (!threadIds.length) return [];
  const out = new Map<string, LocalMsg>();
  for (let i = 0; i < threadIds.length; i += 400) {
    const ids = threadIds.slice(i, i + 400);
    const rows = db.prepare(`SELECT message_id, thread_id, subject, from_email, from_name, to_email, date_iso, is_from_me, labels, body_text, snippet
      FROM deals_emails WHERE thread_id IN (${ids.map(() => "?").join(",")}) AND date_iso IS NOT NULL`).all(...ids) as any[];
    for (const r of rows) {
      const key = r.message_id || `${r.thread_id}:${r.date_iso}:${r.from_email}`;
      if (out.has(key)) continue;
      const labels: string[] = j(r.labels, []);
      out.set(key, {
        messageId: r.message_id ?? key, threadId: r.thread_id, subject: r.subject ?? "", fromEmail: String(r.from_email ?? "").toLowerCase(),
        fromName: r.from_name ?? "", to: r.to_email ?? "", date: r.date_iso, isFromMe: r.is_from_me === 1 || r.is_from_me === "True",
        isDraft: labels.includes("DRAFT"), body: stripQuoted(String(r.body_text || r.snippet || "")),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** "What changed" signature: non-draft message count + latest date. */
export function threadSignature(msgs: LocalMsg[]): { count: number; lastAt: string | null } {
  const real = msgs.filter((m) => !m.isDraft);
  return { count: real.length, lastAt: real.length ? real[real.length - 1].date : null };
}

/* ── fit: reuse the agent's verdicts ──────────────────────────────────────── */

const slug = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function cachedFit(deal: OpenDeal, threadIds: string[]): { verdict: "fit" | "partial" | "none"; notes: string; source: "agent" | "cache" } | null {
  // 1. The agent's own verdict on one of this deal's threads (newest first).
  if (threadIds.length) {
    const r = db.prepare(`SELECT fit FROM deals_agent_items WHERE fit IS NOT NULL AND (deal_id = ? OR thread_id IN (${threadIds.map(() => "?").join(",")})) ORDER BY created_at DESC LIMIT 1`)
      .get(deal.id, ...threadIds) as { fit: string } | undefined;
    const f = j(r?.fit, null);
    if (f && ["fit", "partial", "none"].includes(f.verdict)) return { verdict: f.verdict, notes: String(f.notes ?? ""), source: "agent" };
  }
  // 2. The fit cache, matched by the brand name or the brand's own (non-freemail) domain.
  const brand = slug(deal.projectName || deal.clientName);
  const root = rootDomain(domainOf(extractEmail(deal.clientEmail)));
  const domainOk = root && !FREEMAIL.has(root);
  const rows = db.prepare(`SELECT domain, result, cached_at FROM deals_agent_fit_cache WHERE domain LIKE 'product:%' ORDER BY cached_at DESC`).all() as any[];
  for (const r of rows) {
    const [, dom = "", product = ""] = String(r.domain).split(":");
    const hit = (domainOk && rootDomain(dom) === root) || (brand.length >= 4 && (slug(dom).startsWith(brand) || slug(product).startsWith(brand)));
    if (!hit) continue;
    const f = j(r.result, null);
    if (f && ["fit", "partial", "none"].includes(f.verdict)) return { verdict: f.verdict, notes: String(f.notes ?? ""), source: "cache" };
  }
  return null;
}

/* ── the model call ───────────────────────────────────────────────────────── */

function systemPrompt(): string {
  return [
    "You rate open YouTube sponsorship deals for Jake Dawson (AI tools tutorials for solopreneurs, small-business owners and non-technical entrepreneurs) so the agent knows which silent brands deserve follow-ups. Jake's goal (#31): about 3 sponsors a month at ~$6,500–$7,000 who are EASY to work with (not over-demanding).",
    "You judge three things from the email threads and the board record, and never invent facts:",
    "",
    "FIT (#41) — only when no verdict is given to you: fit = aimed at no-code users, business owners, non-technical entrepreneurs/professionals; partial = not aimed at them but a work/business angle makes it work; none = no angle works (consumer hardware, dev-only infra, crypto, etc.); unknown = the thread doesn't say what the product is.",
    "",
    "PRICE — ONLY the BRAND's own number counts: their stated budget, their offer/counter-offer, or a price they explicitly agreed to in writing. Jake's own quote is NOT their number, and neither is a card value with no email behind it. Compare it with our range: normal $6,500–$7,000 for a dedicated video, floor $6,000 (#19/#27).",
    "  in_range = they agreed to, offered, or have a budget of $6,000+ for a dedicated video (or accepted Jake's quote without pushback, or $2,500 per Short for a Shorts deal);",
    "  near = their number is $4,000–$5,999;",
    "  low = their number is below $4,000 (or only affiliate / gifted product / revenue share);",
    "  unknown = no number from their side yet — e.g. they went silent right after Jake's quote, or only acknowledged it ('thanks, I'll check with the team'). This is the most common case for silent brands; don't guess.",
    "",
    "EASE — how easy they are to work with, from the thread:",
    "  easy = few, reasonable asks; quick clear replies; accepts our terms (#25 payment ladder, #34 contract terms, 2 script rounds + 1 video round);",
    "  normal = usual questions and one negotiation round;",
    "  demanding = many demands (extra revision rounds, exclusivity beyond 1 month, broad usage/ad rights, whitelisting, heavy contract redlines, net-30/45, pay-after-publish, strict scripted talking points, tight deadlines), repeated pushback rounds, slow or unclear replies, or a pushy/rude tone.",
    "",
    "FOLLOW-UP — is a polite follow-up appropriate if the brand stays silent? false when they declined, said 'not now / next quarter', Jake declined them, the deal concluded, or Jake's last email closed the conversation; true otherwise. Also note what Jake last offered and what is pending from them (one line each).",
    "",
    "OUTCOME — how the conversation stands right now:",
    "  open = still alive (waiting on either side, nobody said no);",
    "  they_declined = the brand said no / can't meet the rate / went another direction / budget too small;",
    "  jake_declined = Jake said no or passed (no fit, price too low, format we don't sell, duplicate agency, not a sponsorship);",
    "  not_now = either side explicitly said later / next quarter / timing isn't right now but maybe in future;",
    "  ended_other = the deal ended some other way (campaign date passed, contact left, duplicate card, suspicious sender).",
    "  lostReason (only when declined/ended): price_below_4k (their number < $4,000) | budget (they couldn't meet our rate) | no_fit | timing_capacity | format_not_sold | duplicate | not_a_sponsorship | other.",
    "",
    "Reasons: ONE short line per dimension, specific (numbers, the actual asks), no filler.",
    "",
    "=== RULEBOOK (prices, terms, fit) ===",
    loadRulebook(),
    "",
    "=== CHANNEL CONTEXT ===",
    channelContext("fit"),
  ].join("\n");
}

function transcriptFor(msgs: LocalMsg[], maxChars = 16000): string {
  const real = msgs.filter((m) => !m.isDraft);
  const parts = real.map((m) => `----- ${m.date.slice(0, 16).replace("T", " ")} UTC ${m.isFromMe ? "[JAKE]" : `[${m.fromName || m.fromEmail} <${m.fromEmail}>]`} (${clip(m.subject, 80)})\n${clip(m.body, 2500)}`);
  // Keep the first message (the pitch) + as many of the latest as fit.
  if (parts.join("\n\n").length <= maxChars) return parts.join("\n\n");
  const first = parts[0];
  const tail: string[] = [];
  let len = first.length;
  for (let i = parts.length - 1; i > 0; i--) {
    if (len + parts[i].length > maxChars) break;
    tail.unshift(parts[i]);
    len += parts[i].length;
  }
  return [first, `----- (${parts.length - 1 - tail.length} older message(s) omitted) -----`, ...tail].join("\n\n");
}

/** Reply-speed facts, computed (the model sees them as facts, not guesses). */
function responsiveness(msgs: LocalMsg[]): string {
  const real = msgs.filter((m) => !m.isDraft);
  const gaps: number[] = [];
  for (let i = 1; i < real.length; i++) {
    if (!real[i].isFromMe && real[i - 1].isFromMe) gaps.push((Date.parse(real[i].date) - Date.parse(real[i - 1].date)) / 3_600_000);
  }
  const theirs = real.filter((m) => !m.isFromMe).length;
  const mine = real.length - theirs;
  if (!gaps.length) return `Messages: ${theirs} from them, ${mine} from Jake. They have not answered any of Jake's emails yet.`;
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  return `Messages: ${theirs} from them, ${mine} from Jake. Their reply time to Jake: median ${med < 48 ? `${Math.round(med)} h` : `${Math.round(med / 24)} days`} over ${gaps.length} reply(ies).`;
}

export interface ScoreResult { row: FocusRow; skipped?: string }

/** Score ONE deal now (one model call). Writes deals_agent_focus. */
export async function scoreDeal(deal: OpenDeal, opts: { threadIds?: string[]; msgs?: LocalMsg[] } = {}): Promise<FocusRow> {
  const threadIds = opts.threadIds ?? dealThreadIds(deal);
  const msgs = opts.msgs ?? localMessages(threadIds);
  const sig = threadSignature(msgs);
  const cached = cachedFit(deal, threadIds);

  const record = [
    `Brand / deal: ${deal.projectName || deal.clientName} (${deal.clientName} <${deal.clientEmail}>)`,
    `Board column: ${deal.stage}`,
    deal.dealType ? `Deal type: ${deal.dealType}` : "",
    deal.agreedPrice ? `Agreed price on the card: $${deal.agreedPrice}` : "",
    deal.estimatedValue ? `Estimated value on the card: $${deal.estimatedValue}${deal.estimatedValue < 6000 ? " (may be from the older $5,000–$5,500 price era)" : ""}` : "",
    deal.deadlineDate ? `Their deadline / launch date (parsed from the card): ${deal.deadlineDate}` : "",
    deal.about ? `About: ${clip(deal.about, 400)}` : "",
    deal.opportunity ? `Opportunity: ${clip(deal.opportunity, 300)}` : "",
    deal.keyDetails ? `Key details: ${clip(deal.keyDetails, 500)}` : "",
  ].filter(Boolean).join("\n");

  const user = [
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    "=== BOARD RECORD ===",
    record,
    "",
    cached ? `=== FIT VERDICT ALREADY KNOWN (agent #41 check — use it, don't re-judge) ===\n${cached.verdict.toUpperCase()}: ${clip(cached.notes, 400)}` : "=== FIT === (no verdict yet — judge it from the pitch, #41)",
    "",
    `=== RESPONSIVENESS (computed) ===\n${responsiveness(msgs)}`,
    "",
    `=== THREADS (${threadIds.length} thread(s), oldest first, quotes stripped) ===`,
    msgs.length ? transcriptFor(msgs) : "(no emails synced for this deal)",
    "",
    `Return JSON exactly:
{"fit":{"level":"fit"|"partial"|"none"|"unknown","reason":string},
 "price":{"level":"in_range"|"near"|"low"|"unknown","theirOfferUsd":number|null,"lastQuotedByJakeUsd":number|null /* the last dedicated-video price Jake quoted, if any */,"reason":string},
 "ease":{"level":"easy"|"normal"|"demanding","demands":string[] /* their concrete asks, short */,"reason":string},
 "followUp":{"ok":boolean,"why":string,"offered":string /* what Jake last offered, one line */,"pending":string /* what we're waiting on from them, one line */},
 "outcome":{"state":"open"|"they_declined"|"jake_declined"|"not_now"|"ended_other","lostReason":string|null,"why":string /* one line, quote the decisive words */}}`,
  ].join("\n");

  const r = await aiJSON<any>({ model: triageModel(), purpose: "deals-agent-classify", system: systemPrompt(), user });
  const lvl = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  const fit: FitLevel = cached ? cached.verdict : lvl(r?.fit?.level, ["fit", "partial", "none", "unknown"] as const, "unknown");
  const price = lvl(r?.price?.level, ["in_range", "near", "low", "unknown"] as const, "unknown");
  const ease = lvl(r?.ease?.level, ["easy", "normal", "demanding"] as const, "normal");
  const { score, grade } = scoreOf(fit, price, ease);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const reasons: FocusReasons = {
    fit: cached ? `${cached.source === "agent" ? "Agent fit check" : "Fit check (cache)"}: ${clip(cached.notes, 220)}` : clip(String(r?.fit?.reason ?? ""), 240),
    price: clip(String(r?.price?.reason ?? ""), 240),
    ease: clip(String(r?.ease?.reason ?? ""), 240),
    offered: clip(String(r?.followUp?.offered ?? ""), 300),
    pending: clip(String(r?.followUp?.pending ?? ""), 300),
    followUpOk: r?.followUp?.ok !== false,
    followUpWhy: clip(String(r?.followUp?.why ?? ""), 240),
    demands: Array.isArray(r?.ease?.demands) ? r.ease.demands.map((x: unknown) => clip(String(x), 80)).slice(0, 8) : [],
    lastQuotedUsd: num(r?.price?.lastQuotedByJakeUsd),
    outcome: {
      state: lvl(r?.outcome?.state, ["open", "they_declined", "jake_declined", "not_now", "ended_other"] as const, "open"),
      lostReason: (LOST_REASONS as readonly string[]).includes(r?.outcome?.lostReason) ? r.outcome.lostReason : null,
      why: clip(String(r?.outcome?.why ?? ""), 240),
    },
  };
  const offer = num(r?.price?.theirOfferUsd) ?? deal.agreedPrice ?? null;
  db.prepare(`INSERT INTO deals_agent_focus (deal_id, score, grade, fit, price, ease, reasons_json, computed_at, thread_msg_count, last_msg_at, fit_source, offer_usd, followup_ok, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deal_id) DO UPDATE SET score = excluded.score, grade = excluded.grade, fit = excluded.fit, price = excluded.price, ease = excluded.ease,
      reasons_json = excluded.reasons_json, computed_at = excluded.computed_at, thread_msg_count = excluded.thread_msg_count, last_msg_at = excluded.last_msg_at,
      fit_source = excluded.fit_source, offer_usd = excluded.offer_usd, followup_ok = excluded.followup_ok, model = excluded.model`).run(
    deal.id, score, grade, fit, price, ease, JSON.stringify(reasons), now(), sig.count, sig.lastAt, cached ? cached.source : "thread", offer,
    reasons.followUpOk ? 1 : 0, triageModel(),
  );
  return getFocus(deal.id)!;
}

/** Deals whose threads changed since they were scored (or were never scored). */
export function needsRescore(deal: OpenDeal, msgs: LocalMsg[], current: FocusRow | undefined): boolean {
  if (!current) return true;
  if (!current.followUpOk && !current.reasons.outcome) return true; // scored before the outcome field existed
  const sig = threadSignature(msgs);
  return sig.count !== current.threadMsgCount || (sig.lastAt ?? null) !== (current.lastMsgAt ?? null);
}

/**
 * Recompute the focus score for open deals whose threads changed, newest
 * activity first, at most `cap` model calls. `force` rescored everything
 * (backfill). Never throws; one bad deal is logged and skipped.
 */
export async function refreshFocus(opts: { cap: number; force?: boolean; concurrency?: number; log: (m: string) => void; onlyIds?: string[] }): Promise<{ scored: number; failed: number; pending: number; total: number }> {
  const deals = (await openDeals()).filter((d) => !opts.onlyIds || opts.onlyIds.includes(d.id));
  const current = allFocus();
  const todo: Array<{ deal: OpenDeal; threadIds: string[]; msgs: LocalMsg[]; lastAt: string }> = [];
  for (const deal of deals) {
    const threadIds = dealThreadIds(deal);
    const msgs = localMessages(threadIds);
    if (opts.force || needsRescore(deal, msgs, current.get(deal.id))) {
      todo.push({ deal, threadIds, msgs, lastAt: threadSignature(msgs).lastAt ?? "" });
    }
  }
  todo.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const batch = todo.slice(0, Math.max(0, opts.cap));
  let scored = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const t = batch[next++];
      try {
        const row = await scoreDeal(t.deal, { threadIds: t.threadIds, msgs: t.msgs });
        scored++;
        opts.log(`Focus ${row.grade} (${row.score}) — ${t.deal.projectName || t.deal.clientName}: fit ${row.fit}, price ${row.price}, ease ${row.ease}`);
      } catch (e) {
        failed++;
        opts.log(`Focus scoring failed for ${t.deal.projectName || t.deal.clientName}: ${errMsg(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(6, opts.concurrency ?? 3)) }, worker));
  // Scores of deals that are no longer open are kept (history) but never shown as "open".
  return { scored, failed, pending: todo.length - batch.length, total: deals.length };
}

/** For the kanban badge: every scored deal → grade, score, one-line reason. */
export function focusMap(): Record<string, { grade: Grade; score: number; reason: string; computedAt: string }> {
  const out: Record<string, { grade: Grade; score: number; reason: string; computedAt: string }> = {};
  for (const [id, f] of allFocus()) {
    out[id] = {
      grade: f.grade, score: f.score, computedAt: f.computedAt,
      reason: `Focus ${f.grade} (${f.score}/100)\nFit: ${f.fit} — ${f.reasons.fit}\nPrice: ${f.price.replace("_", " ")} — ${f.reasons.price}\nEase: ${f.ease} — ${f.reasons.ease}${f.followUpOk ? "" : `\nNo follow-up: ${f.reasons.followUpWhy}`}`,
    };
  }
  return out;
}

export const FOCUS_DAY_MS = DAY;
