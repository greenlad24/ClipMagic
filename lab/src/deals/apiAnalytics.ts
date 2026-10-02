/**
 * Deal Organizer — Analytics client (analytics redesign, 2026-09-30).
 * `getAnalytics` now returns the metrics object built by
 * server/src/deals/metrics.ts (pure SQL, no AI on load). Types mirror it.
 */
import { call } from './api';

export type StageGroup = 'new' | 'following_up' | 'negotiating' | 'contract' | 'production' | 'completed' | 'lost';

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
  waitingOn: 'jake' | 'them' | null;
  daysWaiting: number | null;
  sender: 'direct' | 'agency' | 'unknown';
  brand: string | null;
  url: string;
  threadId: string | null;
}

export interface AgingBucket { key: string; label: string; minDays: number; maxDays: number | null; count: number; dealIds: string[] }

export interface AnalyticsMetrics {
  kind: 'deal-organizer-analytics';
  version: 2;
  generatedAt: string;
  computeMs: number;
  currentMonth: string;
  definitions: Record<string, string>;
  goals: { monthlyRevenueUsd: number; dedicatedSlotsPerMonth: number; listPriceDedicatedUsd: number; listPriceShortUsd: number; staleAfterDays: number };
  thisMonth: {
    month: string; label: string;
    bookedRevenueUsd: number; goalUsd: number; progressPct: number;
    pricedDealIds: string[]; unpricedDealIds: string[];
    slots: Array<{ month: string; label: string; booked: number; capacity: number; free: number; dealIds: string[]; labels: string[] }>;
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
    waitingOnThem: AgingBucket[];
    waitingOnJake: AgingBucket[];
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
    senders: Array<{ kind: 'direct' | 'agency' | 'unknown'; label: string; count: number; won: number; lost: number; winRate: number | null; avgAgreedPriceUsd: number | null; priced: number; dealIds: string[] }>;
  };
  coverage: {
    sponsorshipDeals: number; excludedArchived: number; excludedNonSponsorship: number;
    classified: number; extracted: number;
    won: number; wonWithPrice: number; wonWithSlotMonth: number;
    lost: number; lostWithReason: number;
    noThread: number; lastExtractionAt: string | null; pendingExtraction: number;
    notes: string[];
  };
  deals: Record<string, DealRef>;
  weeklyNote: { week: string; note: string; createdAt: string } | null;
  summary: string;
}

export const getAnalyticsMetrics = () => call<AnalyticsMetrics>('getAnalytics', {});

/* ── the deal workspace's analytics fields ──────────────────────────────── */

export type FieldSource = 'ai' | 'human';
export interface DealFields {
  agreed_price: number | null;
  slot_month: string | null;
  lost_reason: string | null;
  deal_type: string | null;
  won_at: string | null;
  lost_at: string | null;
  fields_source: Record<string, FieldSource>;
  fields_extracted_at: string | null;
  fields_evidence: string | null;
}
export const getDealFields = (id: string) => call<{ id: string; fields: DealFields }>('getDealFields', { id });
export const getStageEvents = (id: string) =>
  call<{ events: Array<{ fromStage: string | null; toStage: string | null; at: string; source: string | null }> }>('getStageEvents', { id });

export const LOST_REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'price_below_4k', label: 'Price (offer below $4k)' },
  { value: 'budget', label: 'Budget' },
  { value: 'no_fit', label: 'Not a fit' },
  { value: 'ghosted', label: 'Went silent' },
  { value: 'timing_capacity', label: 'Timing / capacity' },
  { value: 'format_not_sold', label: "Format we don't sell" },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'not_a_sponsorship', label: 'Not a sponsorship' },
  { value: 'other', label: 'Other' },
];
export const DEAL_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'dedicated', label: 'Dedicated video' },
  { value: 'shorts', label: 'Shorts only' },
  { value: 'service_vendor', label: 'Service / vendor' },
  { value: 'other', label: 'Other (not a sponsorship)' },
];
