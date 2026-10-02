/** Section 2 — six months by PUBLISH/SLOT month: revenue vs the $20k goal, dedicated videos vs 3. */
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from '@/deals/ui/charts';
import type { AnalyticsMetrics } from '@/deals/apiAnalytics';
import { Card, ChartTip, useDrill, usd, usdShort } from './shared';

type Month = AnalyticsMetrics['months'][number];

function RevenueTip({ active, payload }: { active?: boolean; payload?: any[] }) {
  const d: Month | undefined = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <ChartTip active label={`${d.label}${d.isFuture ? ' (booked ahead)' : ''}`} lines={[
      ['Agreed revenue', usd(d.revenueUsd)],
      ['Priced deals', d.pricedDealIds.length],
      ...(d.unpricedDealIds.length ? [['Won, no price yet', d.unpricedDealIds.length] as [string, number]] : []),
    ]} />
  );
}

function CountTip({ active, payload }: { active?: boolean; payload?: any[] }) {
  const d: Month | undefined = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <ChartTip active label={d.label} lines={[
      ['Dedicated videos', d.dedicatedWon],
      ...(d.shortsWon ? [['Shorts-only deals', d.shortsWon] as [string, number]] : []),
      ...(d.untypedWon ? [['Type not known yet', d.untypedWon] as [string, number]] : []),
    ]} />
  );
}

export default function MonthlyCharts({ m }: { m: AnalyticsMetrics }) {
  const { open } = useDrill();
  const goal = m.goals.monthlyRevenueUsd;
  const cap = m.goals.dedicatedSlotsPerMonth;
  // Short axis labels ("Jun") so six months fit at phone width; the tooltip keeps "Jun 2026".
  const data = m.months.map((d) => ({ ...d, short: d.label.slice(0, 3) }));
  const maxCount = Math.max(cap + 1, ...data.map((d) => d.dedicatedWon));
  const tick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
  const barFill = (d: Month) => (d.isFuture ? 'hsl(var(--primary) / 0.45)' : 'hsl(var(--primary))');
  const total = data.reduce((s, d) => s + d.revenueUsd, 0);
  const unpriced = data.reduce((s, d) => s + d.unpricedDealIds.length, 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <Card
        title="Revenue by publish month"
        info={`${m.definitions.revenue} Dashed line = the ${usdShort(goal)} monthly goal. The lighter bar is next month (booked ahead). Click a bar for its deals.`}
        action={<span className="text-xs text-muted-foreground tabular-nums">{usdShort(total)} in 6 months</span>}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={data} margin={{ top: 16, right: 4, bottom: 0, left: 0 }} maxBarSize={40}
            ariaLabel="Agreed revenue per publish month with the monthly goal"
            onClickIndex={(_, d) => open({
              title: `${d.label} · revenue`,
              ids: [...d.pricedDealIds, ...d.unpricedDealIds],
              note: `${usd(d.revenueUsd)} agreed${d.unpricedDealIds.length ? ` · ${d.unpricedDealIds.length} won without a price (not counted)` : ''}.`,
            })}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="short" tick={tick} />
            <YAxis width={40} tick={tick} tickFormatter={(v) => usdShort(v)} />
            <Tooltip content={<RevenueTip />} />
            <ReferenceLine y={goal} label={`${usdShort(goal)} goal`} />
            <Bar dataKey="revenueUsd" name="Revenue" radius={[4, 4, 0, 0]}>
              {data.map((d) => <Cell key={d.month} fill={barFill(d)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {unpriced > 0 && (
          <p className="text-[11px] text-muted-foreground mt-2">{unpriced} won deal{unpriced === 1 ? '' : 's'} in these months {unpriced === 1 ? 'has' : 'have'} no agreed price yet and {unpriced === 1 ? 'is' : 'are'} not in the bars.</p>
        )}
      </Card>

      <Card
        title="Dedicated videos won per month"
        info={`Won deals of type "dedicated" by publish month. Dashed line = ${cap} slots a month. Shorts never take a slot. Click a bar for its deals.`}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={data} margin={{ top: 16, right: 4, bottom: 0, left: 0 }} maxBarSize={40}
            ariaLabel="Dedicated videos won per publish month against 3 slots"
            onClickIndex={(_, d) => open({ title: `${d.label} · dedicated videos`, ids: d.dedicatedDealIds, note: `${d.dedicatedWon} of ${cap} slots.` })}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="short" tick={tick} />
            <YAxis width={28} tick={tick} domain={[0, maxCount]} tickFormatter={(v) => (Number.isInteger(v) ? String(v) : '')} />
            <Tooltip content={<CountTip />} />
            <ReferenceLine y={cap} label={`${cap} slots`} />
            <Bar dataKey="dedicatedWon" name="Dedicated videos" radius={[4, 4, 0, 0]}>
              {data.map((d) => <Cell key={d.month} fill={d.dedicatedWon > cap ? 'var(--pill-red-text)' : 'var(--pill-purple-text)'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
