/** Section 4 — follow-up debt (who owes the next email, how long) + median reply time per month. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from '@/deals/ui/charts';
import type { AgingBucket, AnalyticsMetrics } from '@/deals/apiAnalytics';
import { Card, ChartTip, DrillButton, useDrill } from './shared';

/** One hue, darker = older (sequential). */
const AGE_SHADES = ['0.35', '0.55', '0.75', '1'];

function Buckets({ buckets, title, tone }: { buckets: AgingBucket[]; title: string; tone: string }) {
  const { open } = useDrill();
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="space-y-1">
      {buckets.map((b, i) => (
        <button
          key={b.key} type="button" disabled={!b.count}
          onClick={() => open({ title: `${title} · ${b.label}`, ids: b.dealIds })}
          className="w-full grid grid-cols-[76px_1fr_32px] items-center gap-2 px-1.5 py-1 rounded-md hover:bg-muted/50 disabled:hover:bg-transparent disabled:cursor-default text-left"
        >
          <span className="text-xs text-muted-foreground">{b.label}</span>
          <span className="h-2.5 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted))' }}>
            <span className="block h-full rounded-full" style={{ width: `${(b.count / max) * 100}%`, minWidth: b.count ? 4 : 0, background: tone, opacity: Number(AGE_SHADES[i] ?? 1) }} />
          </span>
          <span className="text-sm font-semibold text-foreground tabular-nums text-right">{b.count}</span>
        </button>
      ))}
    </div>
  );
}

function ReplyTip({ active, payload }: { active?: boolean; payload?: any[] }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return <ChartTip active label={d.label} lines={[['Median', d.medianHours === null ? '—' : `${d.medianHours} h`], ['75th percentile', d.p75Hours === null ? '—' : `${d.p75Hours} h`], ['Replies measured', d.pairs]]} />;
}

export default function FollowUpDebt({ m }: { m: AnalyticsMetrics }) {
  const [tab, setTab] = useState<'jake' | 'them'>('jake');
  const f = m.followUp;
  const top = (tab === 'jake' ? f.topWaitingOnJake : f.topWaitingOnThem).map((id) => m.deals[id]).filter(Boolean);
  const totalThem = f.waitingOnThem.reduce((s, b) => s + b.count, 0);
  const totalJake = f.waitingOnJake.reduce((s, b) => s + b.count, 0);
  const tick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
  const replyData = m.replyTime.map((r) => ({ ...r, h: r.medianHours ?? 0, short: r.label.slice(0, 3) }));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_1fr] gap-4">
      <Card title="Follow-up debt" info={`${m.definitions.followUp} "Waiting on you" = ${m.definitions.repliesOwed}`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <p className="text-xs font-medium text-foreground mb-1.5">
              Waiting on you · <DrillButton req={{ title: 'Waiting on you', ids: m.thisMonth.repliesOwed.dealIds, note: 'The brand wrote last. Oldest first.' }}>{totalJake}</DrillButton>
            </p>
            <Buckets buckets={f.waitingOnJake} title="Waiting on you" tone="var(--pill-red-text)" />
          </div>
          <div>
            <p className="text-xs font-medium text-foreground mb-1.5">
              Waiting on them · {totalThem}
              <span className="text-muted-foreground font-normal"> (+<DrillButton req={{ title: 'Fresh (under 3 days)', ids: f.fresh.dealIds }}>{f.fresh.count}</DrillButton> fresh)</span>
            </p>
            <Buckets buckets={f.waitingOnThem} title="Waiting on them" tone="hsl(var(--primary))" />
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center gap-1 mb-2" role="tablist">
            {([['jake', 'Waiting on you · newest'], ['them', 'Worth a nudge']] as const).map(([k, label]) => (
              <button
                key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)}
                className={`text-xs px-2.5 py-1 rounded-md transition-colors ${tab === k ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              >{label}</button>
            ))}
          </div>
          {top.length === 0 ? <p className="text-xs text-muted-foreground py-3">Nothing here.</p> : (
            <ol className="divide-y divide-border/60">
              {top.map((d) => (
                <li key={d.id}>
                  <Link to={d.url} className="flex items-center justify-between gap-3 py-2 px-1 hover:bg-muted/40 rounded-md">
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground truncate">{d.name}</span>
                      <span className="block text-[11px] text-muted-foreground truncate">{d.stage}{d.email ? ` · ${d.email}` : ''}</span>
                    </span>
                    <span className="text-xs tabular-nums whitespace-nowrap" style={{ color: tab === 'jake' ? 'var(--pill-red-text)' : 'hsl(var(--muted-foreground))' }}>
                      {d.daysWaiting}d
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
          {f.noThread.count > 0 && (
            <p className="text-[11px] text-muted-foreground mt-2">
              <DrillButton req={{ title: 'Deals with no synced thread', ids: f.noThread.dealIds }}>{f.noThread.count} deals</DrillButton> have no synced email thread and are not counted here.
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Your median reply time"
        info={m.definitions.replyTime}
        action={<span className="text-xs text-muted-foreground tabular-nums">{m.replyTimeOverall.medianHours ?? '—'} h overall</span>}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={replyData} maxBarSize={32} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} ariaLabel="Median hours to reply per month">
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="short" tick={tick} />
            <YAxis width={32} tick={tick} tickFormatter={(v) => `${Math.round(v)}h`} />
            <Tooltip content={<ReplyTip />} />
            <Bar dataKey="h" name="Median hours" fill="var(--pill-blue-text)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <p className="text-[11px] text-muted-foreground mt-2">
          {m.replyTime.some((r) => r.medianHours === null) ? `Too few replies synced to measure ${m.replyTime.filter((r) => r.medianHours === null).map((r) => r.label).join(', ')}. ` : ''}
          Lower is better.
        </p>
      </Card>
    </div>
  );
}
