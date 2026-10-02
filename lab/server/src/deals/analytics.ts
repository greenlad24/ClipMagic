/**
 * Deal Organizer — analytics (redesign, 2026-09-30).
 *
 * `getAnalytics` returns `analyticsMetrics()` (metrics.ts): pure SQL over the
 * local tables — no AI call, no Gmail, < 100 ms. The old version made a Gemini
 * call on every page load, bucketed months by `lastScannedAt`, counted archived
 * deals as lost and averaged the 5,500 default estimates; all of that is gone
 * (see SPEC/REDESIGN-AUDIT.md §1). The chat assistant calls the same endpoint
 * for "pipeline_summary": the output is self-describing (`definitions`,
 * `coverage.notes`, `goals`) and `summary` is a ready-made text version.
 */
import { z } from "zod";
import { parse } from "./common.js";
import { analyticsMetrics, metricsSummaryText, DEALS_APP_BASE, type AnalyticsMetrics } from "./metrics.js";

export { DEALS_APP_BASE };

export async function getAnalytics(raw: unknown): Promise<AnalyticsMetrics & { summary: string }> {
  const input = parse(z.object({ includeDeals: z.boolean().optional() }).passthrough(), raw ?? {});
  const m = analyticsMetrics();
  const out = { ...m, summary: metricsSummaryText(m) };
  // The chat can ask for the numbers without the per-deal lookup table.
  if (input.includeDeals === false) out.deals = {};
  return out;
}
