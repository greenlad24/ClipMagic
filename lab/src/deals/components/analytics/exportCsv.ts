/** CSV export of every deal the Analytics page counts (one row per deal) + the monthly summary. */
import type { AnalyticsMetrics } from '@/deals/apiAnalytics';

const GROUP_LABEL: Record<string, string> = {
  new: 'New', following_up: 'Following up', negotiating: 'Negotiating', contract: 'Contract / invoice',
  production: 'In production', completed: 'Published', lost: 'Lost',
};

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formulas; quote when needed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const row = (xs: unknown[]) => xs.map(cell).join(',');

export function analyticsCsv(m: AnalyticsMetrics): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const deals = Object.values(m.deals).sort((a, b) => (b.lastEmailAt ?? '').localeCompare(a.lastEmailAt ?? ''));
  const lines = [
    row(['deal', 'contact', 'email', 'stage', 'group', 'deal_type', 'agreed_price_usd', 'slot_month', 'won_at', 'lost_at', 'lost_reason',
      'first_email', 'last_email', 'waiting_on', 'days_since_last_email', 'sender', 'brand', 'link']),
    ...deals.map((d) => row([
      d.name, d.client, d.email, d.stage, GROUP_LABEL[d.group] ?? d.group, d.dealType, d.agreedPrice, d.slotMonth,
      d.wonAt?.slice(0, 10), d.lostAt?.slice(0, 10), d.lostReason, d.firstEmailAt?.slice(0, 10), d.lastEmailAt?.slice(0, 10),
      d.waitingOn, d.daysWaiting, d.sender, d.brand, `${origin}${d.url}`,
    ])),
    '',
    row(['month', 'agreed_revenue_usd', 'goal_usd', 'priced_deals', 'won_without_price', 'dedicated_videos', 'shorts_deals']),
    ...m.months.map((x) => row([x.month, x.revenueUsd, m.goals.monthlyRevenueUsd, x.pricedDealIds.length, x.unpricedDealIds.length, x.dedicatedWon, x.shortsWon])),
  ];
  return lines.join('\r\n');
}

export function downloadAnalyticsCsv(m: AnalyticsMetrics): void {
  const blob = new Blob(['﻿' + analyticsCsv(m)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deal-organizer-analytics-${m.generatedAt.slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
