/**
 * Deal Organizer — analytics metrics (analytics redesign, 2026-09-30).
 *
 * PURE SQL + arithmetic over the local tables. No AI, no Gmail, no writes —
 * safe on every page load (< 100 ms on the live data). `getAnalytics`
 * (analytics.ts) returns exactly this object, and the chat assistant reuses it
 * for "pipeline_summary", so the output carries its own `definitions`.
 *
 * Business rules (SPEC/AGENT-RULES.md): goal ≈ $20,000/month from ~3 sponsors
 * (#30); at most 3 DEDICATED videos a month, Shorts never take a slot (#24);
 * list price $6,500 per dedicated video (#18), $2,500 per Short (#21).
 * Jake's decisions: revenue counts in the deal's PUBLISH/SLOT month; Shorts
 * count toward revenue, never toward the slots; pipeline value is shown at LIST
 * price until agreed prices exist (the old 5,500 estimates are never summed).
 *
 * Stage groups come from the stage table (sort order + production flag):
 * production-flag stages = won (published = after "Video Ready For Publish" →
 * "completed"); the two lost stages and the pre-production groups are
 * identified by stable stage KEYS; a custom stage inherits the group of the
 * nearest stage above it in sort order. Display names are never hardcoded.
 */
import { db } from "../db/index.js";
import { computeAvailability } from "./agent/availability.js";
import { threadsForDeal, brandForDeal, senderKind } from "./matching.js";
import "./db.js"; // runs the additive migrations (analytics columns / stage events) before the first query

export const DEALS_APP_BASE = "/deal-organizer";

export const GOALS = {
  monthlyRevenueUsd: 20_000,
  dedicatedSlotsPerMonth: 3,
  listPriceDedicatedUsd: 6_500,
  listPriceShortUsd: 2_500,
  staleAfterDays: 30,
} as const;

export type StageGroup = "new" | "following_up" | "negotiating" | "contract" | "production" | "completed" | "lost";
export const GROUP_ORDER: StageGroup[] = ["new", "following_up", "negotiating", "contract", "production", "completed", "lost"];
export const GROUP_LABELS: Record<StageGroup, string> = {
  new: "New",
  following_up: "Following up",
  negotiating: "Negotiating",
  contract: "Contract / invoice",
  production: "In production",
  completed: "Published",
  lost: "Lost",
};
const OPEN_GROUPS = new Set<StageGroup>(["new", "following_up", "negotiating", "contract"]);
const WON_GROUPS = new Set<StageGroup>(["production", "completed"]);

export const LOST_REASONS = [
  "price_below_4k", "budget", "no_fit", "ghosted", "timing_capacity",
  "format_not_sold", "duplicate", "not_a_sponsorship", "other",
] as const;
export type LostReason = (typeof LOST_REASONS)[number];
export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price_below_4k: "Price (offer below $4k)",
  budget: "Budget",
  no_fit: "Not a fit",
  ghosted: "Went silent",
  timing_capacity: "Timing / capacity",
  format_not_sold: "Format we don't sell",
  duplicate: "Duplicate",
  not_a_sponsorship: "Not a sponsorship",
  other: "Other",
};
/** Lost reasons that are not real losses (kept out of the win rate). */
const NOT_REAL_LOSS = new Set<string>(["duplicate", "not_a_sponsorship"]);

export const DEAL_TYPES = ["dedicated", "shorts", "service_vendor", "other"] as const;
export type DealType = (typeof DEAL_TYPES)[number];
/** Types that are sponsorships (NULL = not classified yet → included). */
const SPONSORSHIP_TYPES = new Set<string | null>(["dedicated", "shorts", null]);

const KEY_GROUPS: Record<string, StageGroup> = {
  rejected: "lost",
  poor_fit_now: "lost",
  new_requests: "new",
  to_follow_up_with: "following_up",
  potential_future_collaboration: "following_up",
  started_negotiation_no_answer: "following_up",
  contract_negotiation: "negotiating",
  waiting_for_invoice: "contract",
  waiting_for_payment: "contract",
};
/** The production stage after which the video is out (later production stages = published). */
const PUBLISH_KEY = "video_ready_publish";

export interface StageInfo { name: string; key: string; sortOrder: number; isProduction: boolean; group: StageGroup }

/** display name → stage info, from the live stage table. */
export function loadStageGroups(): Map<string, StageInfo> {
  const rows = db.prepare(`SELECT stage_key, display_name, sort_order, is_production_stage FROM deals_stage_config ORDER BY sort_order`).all() as any[];
  const publish = rows.find((r) => r.stage_key === PUBLISH_KEY);
  const out = new Map<string, StageInfo>();
  let prevNonProd: StageGroup = "new";
  for (const r of rows) {
    if (!r.display_name) continue;
    const isProduction = r.is_production_stage === 1;
    let group: StageGroup;
    if (isProduction) {
      group = r.stage_key === "completed" || (publish && r.sort_order > publish.sort_order) ? "completed" : "production";
    } else {
      group = KEY_GROUPS[r.stage_key] ?? prevNonProd;
      prevNonProd = group;
    }
    out.set(r.display_name, { name: r.display_name, key: r.stage_key, sortOrder: r.sort_order ?? 0, isProduction, group });
  }
  return out;
}

/* ── time helpers (Jake is in Bangkok, UTC+7; the box runs UTC) ──────────── */

const BKK_OFFSET_MS = 7 * 3_600_000;
const DAY = 86_400_000;
function bkkMonthKey(ms: number): string {
  const d = new Date(ms + BKK_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function addMonthKey(key: string, k: number): string {
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_SHORT[m - 1]} ${y}`;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/* ── domains (agency vs direct) ──────────────────────────────────────────── */

// Agency vs direct = the shared rule (matching.ts senderKind): the brand's own
// domain → direct; a company domain pitching several brands, or not named like
// the brand → agency; free-mail / platform / no brand → unknown.

/* ── the metrics ─────────────────────────────────────────────────────────── */

export interface DealRef {
  id: string;
  name: string;
  client: string;
  email: string;
  stage: string;
  group: StageGroup;
  dealType: string | null;
  agreedPrice: number | null;
  slotMonth: string | null;
  lostReason: string | null;
  wonAt: string | null;
  lostAt: string | null;
  firstEmailAt: string | null;
  lastEmailAt: string | null;
  /** Who owes the next email: "jake" (brand wrote last), "them" (Jake wrote last), null (no thread). */
  waitingOn: "jake" | "them" | null;
  daysWaiting: number | null;
  sender: "direct" | "agency" | "unknown";
  brand: string | null;
  url: string;
  threadId: string | null;
}

interface Bucket { key: string; label: string; minDays: number; maxDays: number | null; count: number; dealIds: string[] }

export interface AnalyticsMetrics {
  kind: "deal-organizer-analytics";
  version: 2;
  generatedAt: string;
  computeMs: number;
  currentMonth: string;
  definitions: Record<string, string>;
  goals: typeof GOALS;
  thisMonth: {
    month: string;
    label: string;
    bookedRevenueUsd: number;
    goalUsd: number;
    progressPct: number;
    pricedDealIds: string[];
    /** Won deals slotted this month with no agreed price yet (not in the revenue). */
    unpricedDealIds: string[];
    slots: Array<{ month: string; label: string; booked: number; capacity: number; free: number; dealIds: string[]; labels: string[] }>;
    /** Deals the agent counts as "not yet signed" (may take a slot soon). */
    pendingSignature: string[];
    openPipeline: {
      active: { count: number; listValueUsd: number; dealIds: string[] };
      stale: { count: number; listValueUsd: number; dealIds: string[] };
      agreedPriceCount: number;
    };
    repliesOwed: { count: number; dealIds: string[] };
  };
  months: Array<{
    month: string; label: string; isFuture: boolean;
    revenueUsd: number; pricedDealIds: string[]; unpricedDealIds: string[];
    dedicatedWon: number; dedicatedDealIds: string[]; shortsWon: number; untypedWon: number;
  }>;
  pipeline: Array<{ group: StageGroup; label: string; count: number; valueUsd: number; valueBasis: string; stages: Array<{ name: string; count: number }>; dealIds: string[] }>;
  followUp: {
    waitingOnThem: Bucket[];
    waitingOnJake: Bucket[];
    fresh: { count: number; dealIds: string[] };
    noThread: { count: number; dealIds: string[] };
    topWaitingOnJake: string[];
    topWaitingOnThem: string[];
  };
  replyTime: Array<{ month: string; label: string; medianHours: number | null; p75Hours: number | null; pairs: number }>;
  replyTimeOverall: { medianHours: number | null; pairs: number };
  conversion: {
    won: number; lost: number; winRate: number | null;
    wonIds: string[]; lostIds: string[];
    last90d: { won: number; lost: number; winRate: number | null };
    timeToClose: { medianDays: number | null; n: number; dealIds: string[] };
    lostReasons: Array<{ reason: string; label: string; count: number; dealIds: string[]; countsAsLoss: boolean }>;
    senders: Array<{ kind: "direct" | "agency" | "unknown"; label: string; count: number; won: number; lost: number; winRate: number | null; avgAgreedPriceUsd: number | null; priced: number; dealIds: string[] }>;
  };
  coverage: {
    sponsorshipDeals: number;
    excludedArchived: number;
    excludedNonSponsorship: number;
    classified: number;
    extracted: number;
    won: number; wonWithPrice: number; wonWithSlotMonth: number;
    lost: number; lostWithReason: number;
    noThread: number;
    lastExtractionAt: string | null;
    pendingExtraction: number;
    notes: string[];
  };
  deals: Record<string, DealRef>;
  weeklyNote: { week: string; note: string; createdAt: string } | null;
}

export function analyticsMetrics(opts: { now?: Date } = {}): AnalyticsMetrics {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const curMonth = bkkMonthKey(nowMs);
  const stages = loadStageGroups();

  const excludedArchived = (db.prepare(`SELECT COUNT(*) AS n FROM deals_deals WHERE NOT (archived IS NULL OR archived = 0) OR merged_into IS NOT NULL`).get() as { n: number }).n;
  // One pass over the sponsor inbox (drafts excluded): per-thread first/last
  // email + who wrote last, and the rows the reply-time section reuses.
  const emailRows = db.prepare(`
    SELECT thread_id, date_iso, is_from_me FROM deals_emails
    WHERE date_iso IS NOT NULL AND thread_id IS NOT NULL AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%')
    ORDER BY thread_id, date_iso
  `).all() as { thread_id: string; date_iso: string; is_from_me: number }[];
  const threadStats = new Map<string, { first: string; last: string; lastFromMe: boolean }>();
  for (const e of emailRows) {
    const t = threadStats.get(e.thread_id);
    if (!t) threadStats.set(e.thread_id, { first: e.date_iso, last: e.date_iso, lastFromMe: e.is_from_me === 1 });
    else { t.last = e.date_iso; t.lastFromMe = e.is_from_me === 1; }
  }
  const rows = (db.prepare(`
    SELECT d.id, d.client_name, d.client_email, d.project_name, d.stage, d.source_thread_id, d.created_at,
           d.agreed_price, d.slot_month, d.lost_reason, d.deal_type, d.won_at, d.lost_at,
           d.fields_extracted_at, d.fields_dirty,
           tb.brand_name, tb.sender_domain
    FROM deals_deals d
    LEFT JOIN deals_thread_brands tb ON tb.thread_id = d.source_thread_id
    WHERE (d.archived IS NULL OR d.archived = 0) AND d.merged_into IS NULL
  `).all() as any[]).map((r) => {
    // Every conversation thread of the deal (shared matcher: source, manual, contact closure), not just the source.
    let t: { first: string; last: string; lastFromMe: boolean } | undefined;
    const tids = threadsForDeal(r.id).filter((x) => x.matchedBy === "source" || x.matchedBy === "manual" || x.matchedBy === "contact").map((x) => x.threadId);
    for (const tid of tids.length ? tids : r.source_thread_id ? [r.source_thread_id] : []) {
      const s = threadStats.get(tid);
      if (!s) continue;
      if (!t) t = { ...s };
      else {
        if (s.first < t.first) t.first = s.first;
        if (s.last > t.last) { t.last = s.last; t.lastFromMe = s.lastFromMe; }
      }
    }
    return { ...r, first_at: t?.first ?? null, last_at: t?.last ?? null, last_from_me: t ? (t.lastFromMe ? 1 : 0) : null };
  });

  let excludedNonSponsorship = 0;
  const deals: Record<string, DealRef> = {};
  const list: DealRef[] = [];
  let extracted = 0, classified = 0, pendingExtraction = 0;
  for (const r of rows) {
    if (!SPONSORSHIP_TYPES.has(r.deal_type ?? null)) { excludedNonSponsorship++; continue; }
    if (r.fields_extracted_at) extracted++;
    if (r.deal_type) classified++;
    if (r.fields_dirty === 1 || !r.fields_extracted_at) pendingExtraction++;
    const info = stages.get(r.stage ?? "");
    const group: StageGroup = info?.group ?? "new";
    const lastMs = r.last_at ? Date.parse(r.last_at) : NaN;
    const waitingOn: DealRef["waitingOn"] = r.last_at ? (r.last_from_me === 1 ? "them" : "jake") : null;
    const brand = brandForDeal(r.id) ?? r.brand_name ?? null;
    const email = r.client_email ?? "";
    const ref: DealRef = {
      id: r.id,
      name: r.project_name || brand || r.client_name || email || "(unnamed deal)",
      client: r.client_name ?? "",
      email,
      stage: r.stage ?? "",
      group,
      dealType: r.deal_type ?? null,
      agreedPrice: typeof r.agreed_price === "number" ? r.agreed_price : null,
      slotMonth: r.slot_month ?? null,
      lostReason: r.lost_reason ?? null,
      wonAt: r.won_at ?? null,
      lostAt: r.lost_at ?? null,
      firstEmailAt: r.first_at ?? null,
      lastEmailAt: r.last_at ?? null,
      waitingOn,
      daysWaiting: Number.isFinite(lastMs) ? Math.max(0, Math.floor((nowMs - lastMs) / DAY)) : null,
      sender: senderKind(r.sender_domain || (email.split("@")[1] ?? null), brand ?? r.client_name),
      brand,
      url: `${DEALS_APP_BASE}/deals/${r.id}`,
      threadId: r.source_thread_id ?? null,
    };
    deals[r.id] = ref;
    list.push(ref);
  }

  const won = list.filter((d) => WON_GROUPS.has(d.group));
  const lost = list.filter((d) => d.group === "lost");
  const open = list.filter((d) => OPEN_GROUPS.has(d.group));
  const listPrice = (d: DealRef) => (d.dealType === "shorts" ? GOALS.listPriceShortUsd : GOALS.listPriceDedicatedUsd);
  const valueOf = (d: DealRef) => d.agreedPrice ?? listPrice(d);

  /* ── months (revenue by slot month) ── */
  const monthKeys = Array.from({ length: 6 }, (_, i) => addMonthKey(curMonth, i - 4));
  const months = monthKeys.map((mk) => {
    const inMonth = won.filter((d) => d.slotMonth === mk);
    const priced = inMonth.filter((d) => d.agreedPrice !== null);
    const dedicated = inMonth.filter((d) => d.dealType === "dedicated");
    return {
      month: mk, label: monthLabel(mk), isFuture: mk > curMonth,
      revenueUsd: priced.reduce((s, d) => s + (d.agreedPrice ?? 0), 0),
      pricedDealIds: priced.map((d) => d.id),
      unpricedDealIds: inMonth.filter((d) => d.agreedPrice === null).map((d) => d.id),
      dedicatedWon: dedicated.length,
      dedicatedDealIds: dedicated.map((d) => d.id),
      shortsWon: inMonth.filter((d) => d.dealType === "shorts").length,
      untypedWon: inMonth.filter((d) => !d.dealType).length,
    };
  });
  const cur = months.find((m) => m.month === curMonth)!;

  /* ── slots: the agent's own math (computeAvailability) ── */
  const avail = computeAvailability(now);
  const rowById = new Map<string, any>(rows.map((r) => [r.id, r]));
  // The agent's labels start with "<project or client> (<email>)" — map them back to deal ids.
  const labelToId = (label: string): string | null => {
    for (const d of won) {
      const r = rowById.get(d.id);
      if (label.startsWith(`${r?.project_name || r?.client_name || "?"} (${r?.client_email || "?"})`)) return d.id;
    }
    return null;
  };
  const slots = avail.months.slice(0, 2).map((m) => ({
    month: m.key, label: m.name, booked: m.booked.length, capacity: avail.capacityPerMonth, free: m.free,
    dealIds: m.booked.map(labelToId).filter((x): x is string => !!x),
    labels: m.booked,
  }));

  /* ── open pipeline (list price until agreed prices exist) ── */
  const isActive = (d: DealRef) => {
    const ref = d.lastEmailAt ?? rowById.get(d.id)?.created_at;
    const ms = ref ? Date.parse(ref) : NaN;
    return Number.isFinite(ms) && nowMs - ms <= GOALS.staleAfterDays * DAY;
  };
  const activeOpen = open.filter(isActive);
  const staleOpen = open.filter((d) => !isActive(d));
  const sum = (ds: DealRef[]) => ds.reduce((s, d) => s + valueOf(d), 0);

  /* ── replies owed / follow-up debt ── */
  const owedScope = list.filter((d) => OPEN_GROUPS.has(d.group) || d.group === "production");
  const owedMs = (d: DealRef) => (d.lastEmailAt ? nowMs - Date.parse(d.lastEmailAt) : 0);
  const owed = owedScope.filter((d) => d.waitingOn === "jake" && owedMs(d) > DAY).sort((a, b) => owedMs(b) - owedMs(a));
  const mkBuckets = (defs: Array<[string, string, number, number | null]>, ds: DealRef[]): Bucket[] =>
    defs.map(([key, label, min, max]) => {
      const inB = ds.filter((d) => (d.daysWaiting ?? 0) >= min && (max === null || (d.daysWaiting ?? 0) < max));
      return { key, label, minDays: min, maxDays: max, count: inB.length, dealIds: inB.map((d) => d.id) };
    });
  const waitingThem = open.filter((d) => d.waitingOn === "them").sort((a, b) => (a.daysWaiting ?? 0) - (b.daysWaiting ?? 0));
  const fresh = waitingThem.filter((d) => (d.daysWaiting ?? 0) < 3);

  /* ── reply time (every sponsor-inbox thread) ── */
  const pairsByMonth = new Map<string, number[]>();
  const allPairs: number[] = [];
  let curThread = "";
  let pending: number | null = null;
  for (const e of emailRows) {
    if (e.thread_id !== curThread) { curThread = e.thread_id; pending = null; }
    const ms = Date.parse(e.date_iso);
    if (!Number.isFinite(ms)) continue;
    if (e.is_from_me === 1) {
      if (pending !== null) {
        const h = (ms - pending) / 3_600_000;
        if (h >= 0 && h < 24 * 60) {
          const mk = bkkMonthKey(ms);
          (pairsByMonth.get(mk) ?? pairsByMonth.set(mk, []).get(mk)!).push(h);
          allPairs.push(h);
        }
        pending = null;
      }
    } else if (pending === null) pending = ms;
  }
  const replyMonths = Array.from({ length: 6 }, (_, i) => addMonthKey(curMonth, i - 5)).map((mk) => {
    const xs = pairsByMonth.get(mk) ?? [];
    const s = [...xs].sort((a, b) => a - b);
    // Fewer than 5 replies (e.g. a month missing from the import) is noise, not a median.
    const enough = xs.length >= 5;
    return { month: mk, label: monthLabel(mk), medianHours: enough ? round1(median(xs)) : null, p75Hours: enough ? round1(s[Math.floor(s.length * 0.75)]) : null, pairs: xs.length };
  });

  /* ── conversion ── */
  const realLost = lost.filter((d) => !NOT_REAL_LOSS.has(d.lostReason ?? ""));
  const rate = (w: number, l: number) => (w + l > 0 ? Math.round((w / (w + l)) * 1000) / 10 : null);
  const since90 = nowMs - 90 * DAY;
  const won90 = won.filter((d) => d.wonAt && Date.parse(d.wonAt) >= since90).length;
  const lost90 = realLost.filter((d) => d.lostAt && Date.parse(d.lostAt) >= since90).length;
  const closeDays: number[] = [];
  const closeIds: string[] = [];
  for (const d of won) {
    if (!d.wonAt || !d.firstEmailAt) continue;
    const days = (Date.parse(d.wonAt) - Date.parse(d.firstEmailAt)) / DAY;
    if (Number.isFinite(days) && days >= 0) { closeDays.push(days); closeIds.push(d.id); }
  }
  const reasonCounts = new Map<string, string[]>();
  for (const d of lost) {
    const k = d.lostReason ?? "unknown";
    (reasonCounts.get(k) ?? reasonCounts.set(k, []).get(k)!).push(d.id);
  }
  const lostReasons = [...reasonCounts.entries()]
    .map(([reason, ids]) => ({
      reason,
      label: reason === "unknown" ? "Not known yet" : (LOST_REASON_LABELS as Record<string, string>)[reason] ?? reason,
      count: ids.length, dealIds: ids, countsAsLoss: !NOT_REAL_LOSS.has(reason),
    }))
    .sort((a, b) => (a.reason === "unknown" ? 1 : 0) - (b.reason === "unknown" ? 1 : 0) || b.count - a.count);
  const SENDER_LABELS = { direct: "Brand directly", agency: "Agency / third party", unknown: "Personal email / unknown" } as const;
  const senders = (["direct", "agency", "unknown"] as const).map((kind) => {
    const ds = list.filter((d) => d.sender === kind);
    const w = ds.filter((d) => WON_GROUPS.has(d.group));
    const l = ds.filter((d) => d.group === "lost" && !NOT_REAL_LOSS.has(d.lostReason ?? ""));
    const priced = w.filter((d) => d.agreedPrice !== null);
    return {
      kind, label: SENDER_LABELS[kind], count: ds.length, won: w.length, lost: l.length, winRate: rate(w.length, l.length),
      avgAgreedPriceUsd: priced.length ? Math.round(priced.reduce((s, d) => s + (d.agreedPrice ?? 0), 0) / priced.length) : null,
      priced: priced.length, dealIds: ds.map((d) => d.id),
    };
  });

  /* ── pipeline by stage group ── */
  const pipeline = GROUP_ORDER.map((g) => {
    const ds = list.filter((d) => d.group === g);
    const stageCounts = new Map<string, number>();
    for (const d of ds) stageCounts.set(d.stage, (stageCounts.get(d.stage) ?? 0) + 1);
    const priced = ds.filter((d) => d.agreedPrice !== null).length;
    return {
      group: g, label: GROUP_LABELS[g], count: ds.length,
      valueUsd: g === "lost" ? 0 : sum(ds),
      valueBasis: g === "lost" ? "none" : priced === ds.length && ds.length ? "agreed" : priced ? `mixed (${priced} agreed, ${ds.length - priced} at list)` : "list",
      stages: [...stageCounts.entries()].map(([name, count]) => ({ name, count }))
        .sort((a, b) => (stages.get(a.name)?.sortOrder ?? 0) - (stages.get(b.name)?.sortOrder ?? 0)),
      dealIds: ds.map((d) => d.id),
    };
  });

  /* ── coverage ── */
  const wonWithPrice = won.filter((d) => d.agreedPrice !== null).length;
  const wonWithSlot = won.filter((d) => d.slotMonth).length;
  const lostWithReason = lost.filter((d) => d.lostReason).length;
  const noThread = list.filter((d) => !d.lastEmailAt);
  const lastRun = db.prepare(`SELECT MAX(fields_extracted_at) AS at FROM deals_deals`).get() as { at: string | null };
  const notes = [
    `Agreed price known for ${wonWithPrice} of ${won.length} won deals.`,
    `Publish month known for ${wonWithSlot} of ${won.length} won deals.`,
    `Lost reason known for ${lostWithReason} of ${lost.length} lost deals.`,
    `Deal type classified for ${classified} of ${list.length} deals${excludedNonSponsorship ? ` (${excludedNonSponsorship} non-sponsorship deals left out)` : ""}.`,
    ...(noThread.length ? [`${noThread.length} deals have no synced email thread.`] : []),
    ...(pendingExtraction ? [`${pendingExtraction} deals are waiting for the AI to read their thread (runs with the twice-daily sync).`] : []),
  ];

  const note = db.prepare(`SELECT week, note, created_at FROM deals_analytics_notes ORDER BY created_at DESC LIMIT 1`).get() as any;

  return {
    kind: "deal-organizer-analytics",
    version: 2,
    generatedAt: now.toISOString(),
    computeMs: Date.now() - t0,
    currentMonth: curMonth,
    definitions: {
      scope: "Non-archived, non-merged deals whose type is a sponsorship (dedicated video or Shorts; not yet classified counts too). Service vendors and other non-sponsorship deals are left out.",
      won: "Deal sits in a production stage (contract signed by both sides onward, incl. published).",
      lost: "Deal sits in a lost stage (Rejected / Poor Fit). Duplicates and non-sponsorships are left out of the win rate.",
      open: "New, following up, negotiating, contract/invoice stages.",
      revenue: "Sum of AGREED prices of won deals, counted in the deal's publish/slot month. Shorts count toward revenue. Deals with no agreed price are listed as unpriced, never estimated.",
      slots: "Dedicated slots come from the agent's availability math (computeAvailability): production deals by deadline month, max 3 dedicated per month; Shorts never take a slot.",
      pipelineValue: `Open deals at LIST price ($${GOALS.listPriceDedicatedUsd} per dedicated video, $${GOALS.listPriceShortUsd} for a Shorts deal) unless an agreed price exists. Active = an email in the last ${GOALS.staleAfterDays} days.`,
      repliesOwed: "Open or in-production deals whose thread's last message is from the brand and older than 24 hours.",
      followUp: "Open deals where Jake sent the last email, by days since it (3/7/14/30+). Under 3 days is 'fresh'.",
      replyTime: "Every inbound → Jake reply pair in the sponsor inbox, bucketed by the reply's month (Bangkok time). Median hours; a month with fewer than 5 replies shows no median.",
      timeToClose: "Days from the thread's first email to won_at.",
      sender: "Agency vs direct: the brand compared with the sender's company domain, and whether that domain pitches several brands (shared matcher).",
    },
    goals: GOALS,
    thisMonth: {
      month: curMonth,
      label: monthLabel(curMonth),
      bookedRevenueUsd: cur.revenueUsd,
      goalUsd: GOALS.monthlyRevenueUsd,
      progressPct: Math.round((cur.revenueUsd / GOALS.monthlyRevenueUsd) * 1000) / 10,
      pricedDealIds: cur.pricedDealIds,
      unpricedDealIds: cur.unpricedDealIds,
      slots,
      pendingSignature: avail.pending,
      openPipeline: {
        active: { count: activeOpen.length, listValueUsd: sum(activeOpen), dealIds: activeOpen.map((d) => d.id) },
        stale: { count: staleOpen.length, listValueUsd: sum(staleOpen), dealIds: staleOpen.map((d) => d.id) },
        agreedPriceCount: open.filter((d) => d.agreedPrice !== null).length,
      },
      repliesOwed: { count: owed.length, dealIds: owed.map((d) => d.id) },
    },
    months,
    pipeline,
    followUp: {
      waitingOnThem: mkBuckets([["3d", "3–6 days", 3, 7], ["7d", "7–13 days", 7, 14], ["14d", "14–29 days", 14, 30], ["30d", "30+ days", 30, null]], waitingThem),
      waitingOnJake: mkBuckets([["1d", "1–2 days", 1, 3], ["3d", "3–6 days", 3, 7], ["7d", "7–29 days", 7, 30], ["30d", "30+ days", 30, null]], owed),
      fresh: { count: fresh.length, dealIds: fresh.map((d) => d.id) },
      noThread: { count: noThread.length, dealIds: noThread.map((d) => d.id) },
      // Newest first: the replies still worth sending (the full list, oldest first, is in waitingOnJake / repliesOwed).
      topWaitingOnJake: [...owed].reverse().slice(0, 10).map((d) => d.id),
      // Most recent first among those ≥3 days: the ones still worth a nudge.
      topWaitingOnThem: waitingThem.filter((d) => (d.daysWaiting ?? 0) >= 3).slice(0, 10).map((d) => d.id),
    },
    replyTime: replyMonths,
    replyTimeOverall: { medianHours: round1(median(allPairs)), pairs: allPairs.length },
    conversion: {
      won: won.length, lost: realLost.length, winRate: rate(won.length, realLost.length),
      wonIds: won.map((d) => d.id), lostIds: realLost.map((d) => d.id),
      last90d: { won: won90, lost: lost90, winRate: rate(won90, lost90) },
      timeToClose: { medianDays: round1(median(closeDays)), n: closeDays.length, dealIds: closeIds },
      lostReasons,
      senders,
    },
    coverage: {
      sponsorshipDeals: list.length,
      excludedArchived,
      excludedNonSponsorship,
      classified,
      extracted,
      won: won.length, wonWithPrice, wonWithSlotMonth: wonWithSlot,
      lost: lost.length, lostWithReason,
      noThread: noThread.length,
      lastExtractionAt: lastRun.at,
      pendingExtraction,
      notes,
    },
    deals,
    weeklyNote: note ? { week: note.week, note: note.note, createdAt: note.created_at } : null,
  };
}

/** A compact text summary (for the weekly note prompt and the chat assistant). */
export function metricsSummaryText(m: AnalyticsMetrics): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const lines = [
    `Month ${m.thisMonth.label}: booked ${usd(m.thisMonth.bookedRevenueUsd)} of ${usd(m.thisMonth.goalUsd)} goal (${m.thisMonth.progressPct}%), ${m.thisMonth.unpricedDealIds.length} won deals without an agreed price.`,
    `Dedicated slots: ${m.thisMonth.slots.map((s) => `${s.label} ${s.booked}/${s.capacity}`).join(", ")}.`,
    `Open pipeline: ${m.thisMonth.openPipeline.active.count} active (${usd(m.thisMonth.openPipeline.active.listValueUsd)} at list), ${m.thisMonth.openPipeline.stale.count} stale.`,
    `Replies owed (brand wrote last >24h): ${m.thisMonth.repliesOwed.count}.`,
    `Revenue by slot month: ${m.months.map((x) => `${x.label} ${usd(x.revenueUsd)} (${x.dedicatedWon} dedicated)`).join("; ")}.`,
    `Win rate ${m.conversion.winRate ?? "n/a"}% (${m.conversion.won} won / ${m.conversion.lost} lost); last 90 days ${m.conversion.last90d.winRate ?? "n/a"}%. Median time to close ${m.conversion.timeToClose.medianDays ?? "n/a"} days.`,
    `Lost reasons: ${m.conversion.lostReasons.map((r) => `${r.label} ${r.count}`).join(", ")}.`,
    `Median reply time: ${m.replyTime.map((r) => `${r.label} ${r.medianHours === null ? "n/a" : `${r.medianHours}h`}`).join(", ")}.`,
    `Pipeline: ${m.pipeline.map((p) => `${p.label} ${p.count}`).join(", ")}.`,
    `Coverage: ${m.coverage.notes.join(" ")}`,
  ];
  return lines.join("\n");
}
