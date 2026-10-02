/**
 * Deal Organizer — Analytics (redesign, 2026-09-30).
 *
 * One call (`getAnalytics` = server/src/deals/metrics.ts, pure SQL, no AI on
 * load). Five sections, top to bottom: this month · six months · pipeline ·
 * follow-up debt & reply time · conversion. Every number that stands for a set
 * of deals opens them in a side panel with links to each deal's workspace.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, Sparkles, Database } from 'lucide-react';
import { Button } from '@/deals/ui/button';
import { Skeleton } from '@/deals/ui/skeleton';
import { TooltipProvider } from '@/deals/ui/tooltip';
import { SyncIndicator } from '@/deals/components/SyncControls';
import { useSyncRefresh } from '@/deals/context/SyncContext';
import { getAnalyticsMetrics, type AnalyticsMetrics } from '@/deals/apiAnalytics';
import { DrillContext, SectionTitle, type DrillRequest } from '@/deals/components/analytics/shared';
import DealListSheet from '@/deals/components/analytics/DealListSheet';
import ThisMonthTiles from '@/deals/components/analytics/ThisMonthTiles';
import MonthlyCharts from '@/deals/components/analytics/MonthlyCharts';
import PipelineGroups from '@/deals/components/analytics/PipelineGroups';
import FollowUpDebt from '@/deals/components/analytics/FollowUpDebt';
import Conversion from '@/deals/components/analytics/Conversion';
import { downloadAnalyticsCsv } from '@/deals/components/analytics/exportCsv';

function LoadingSkeleton() {
  return (
    <div className="px-4 sm:px-8 py-6 space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function Coverage({ m }: { m: AnalyticsMetrics }) {
  const c = m.coverage;
  return (
    <div className="rounded-xl border border-border px-4 py-3 text-xs text-muted-foreground flex gap-2.5" style={{ background: 'var(--bg-panel-alt)' }}>
      <Database size={14} className="flex-shrink-0 mt-0.5" />
      <div className="space-y-0.5 min-w-0">
        <p className="text-foreground font-medium">How complete these numbers are</p>
        <p>
          {c.notes.join(' ')}{' '}
          {c.lastExtractionAt && <>The AI last read deal threads {new Date(c.lastExtractionAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. </>}
          Counting {c.sponsorshipDeals} sponsorship deals ({c.excludedArchived} archived or merged left out). Fix any value in the deal's workspace; what you type is never overwritten.
        </p>
      </div>
    </div>
  );
}

function WeeklyNote({ m }: { m: AnalyticsMetrics }) {
  if (!m.weeklyNote) return null;
  return (
    <div className="rounded-xl px-4 py-3 text-sm flex gap-2.5" style={{ background: 'var(--ai-card-bg)', border: '1px solid var(--ai-card-border)' }}>
      <Sparkles size={14} className="flex-shrink-0 mt-1 text-primary" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground mb-1">Weekly note · {m.weeklyNote.week}</p>
        <div className="whitespace-pre-line text-foreground leading-relaxed">{m.weeklyNote.note}</div>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillRequest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAnalyticsMetrics());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load analytics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSyncRefresh(() => { load(); }); // the shared Gmail sync finished → fresh numbers

  return (
    <TooltipProvider>
      <DrillContext.Provider value={{ open: setDrill, deals: data?.deals ?? {} }}>
        <div className="flex-1 overflow-y-auto h-full" style={{ background: 'var(--bg-page)' }}>
          <div className="sticky top-0 z-20 border-b border-border" style={{ background: 'var(--bg-page)' }}>
            <div className="px-4 sm:px-8 pt-5 pb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-foreground tracking-tight">Analytics</h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data ? `${data.thisMonth.label} · goal ${'$'}${(data.goals.monthlyRevenueUsd / 1000).toFixed(0)}k/month from ${data.goals.dedicatedSlotsPerMonth} dedicated videos` : 'Sponsorship sales at a glance'}
                </p>
                <SyncIndicator className="mt-0.5" />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" onClick={load} disabled={loading} aria-label="Refresh">
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> <span className="hidden sm:inline">Refresh</span>
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" disabled={!data} onClick={() => data && downloadAnalyticsCsv(data)} aria-label="Export CSV">
                  <Download size={12} /> <span className="hidden sm:inline">Export CSV</span>
                </Button>
              </div>
            </div>
          </div>

          {loading && !data && <LoadingSkeleton />}

          {error && !loading && (
            <div className="px-4 sm:px-8 py-12 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
            </div>
          )}

          {data && (
            <div className={`px-4 sm:px-8 py-6 space-y-8 mx-auto transition-opacity ${loading ? 'opacity-60' : ''}`} style={{ maxWidth: 1400 }}>
              <WeeklyNote m={data} />
              <section>
                <SectionTitle n={1} sub={data.thisMonth.label}>This month</SectionTitle>
                <ThisMonthTiles m={data} />
              </section>
              <section>
                <SectionTitle n={2} sub="by the month each video publishes">Last six months</SectionTitle>
                <MonthlyCharts m={data} />
              </section>
              <section>
                <SectionTitle n={3}>Pipeline</SectionTitle>
                <PipelineGroups m={data} />
              </section>
              <section>
                <SectionTitle n={4}>Follow-ups & reply time</SectionTitle>
                <FollowUpDebt m={data} />
              </section>
              <section>
                <SectionTitle n={5}>Conversion</SectionTitle>
                <Conversion m={data} />
              </section>
              <Coverage m={data} />
              <div className="h-6" />
            </div>
          )}
        </div>
        <DealListSheet req={drill} deals={data?.deals ?? {}} onClose={() => setDrill(null)} />
      </DrillContext.Provider>
    </TooltipProvider>
  );
}
