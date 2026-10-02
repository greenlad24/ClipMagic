/** Section 5 — conversion: win rate, time to close, lost reasons, agency vs direct. */
import type { AnalyticsMetrics } from '@/deals/apiAnalytics';
import { Card, DrillButton, pct, useDrill, usd } from './shared';

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-2xl font-bold tracking-tight text-foreground tabular-nums">{children}</div>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

export default function Conversion({ m }: { m: AnalyticsMetrics }) {
  const { open } = useDrill();
  const c = m.conversion;
  const maxReason = Math.max(1, ...c.lostReasons.map((r) => r.count));
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Card title="Win rate & time to close" info={`${m.definitions.won} ${m.definitions.lost} ${m.definitions.timeToClose}`}>
        <div className="grid grid-cols-2 gap-4">
          <Stat
            label="Win rate"
            sub={<><DrillButton req={{ title: 'Won deals', ids: c.wonIds }}>{c.won} won</DrillButton> · <DrillButton req={{ title: 'Lost deals', ids: c.lostIds, note: 'Duplicates and non-sponsorships left out.' }}>{c.lost} lost</DrillButton></>}
          >{pct(c.winRate)}</Stat>
          <Stat label="Last 90 days" sub={`${c.last90d.won} won · ${c.last90d.lost} lost`}>{pct(c.last90d.winRate)}</Stat>
          <Stat
            label="Median time to close"
            sub={<>first email → won, <DrillButton req={{ title: 'Deals with a time to close', ids: c.timeToClose.dealIds }}>{c.timeToClose.n} deals</DrillButton></>}
          >{c.timeToClose.medianDays === null ? '—' : `${c.timeToClose.medianDays} d`}</Stat>
        </div>
      </Card>

      <Card title="Why deals were lost" info="From the lost reason on each lost deal (AI-filled from the thread unless you set it). Duplicates and non-sponsorships don't count against the win rate.">
        {c.lostReasons.length === 0 ? <p className="text-xs text-muted-foreground">No lost deals.</p> : (
          <ul className="space-y-1">
            {c.lostReasons.map((r) => (
              <li key={r.reason}>
                <button
                  type="button" onClick={() => open({ title: `Lost · ${r.label}`, ids: r.dealIds })}
                  className="w-full grid grid-cols-[minmax(110px,150px)_1fr_28px] items-center gap-2 px-1.5 py-1 rounded-md hover:bg-muted/50 text-left"
                >
                  <span className={`text-xs truncate ${r.reason === 'unknown' ? 'text-muted-foreground italic' : 'text-foreground'}`}>{r.label}</span>
                  <span className="h-2.5 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted))' }}>
                    <span className="block h-full rounded-full" style={{
                      width: `${(r.count / maxReason) * 100}%`, minWidth: 4,
                      background: r.reason === 'unknown' || !r.countsAsLoss ? 'var(--pill-gray-text)' : 'var(--pill-red-text)',
                    }} />
                  </span>
                  <span className="text-sm font-semibold text-foreground tabular-nums text-right">{r.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Agency vs brand direct" info={m.definitions.sender}>
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-muted-foreground text-left">
                <th className="font-medium px-1 pb-1.5">Who wrote</th>
                <th className="font-medium px-1 pb-1.5 text-right">Deals</th>
                <th className="font-medium px-1 pb-1.5 text-right">Win rate</th>
                <th className="font-medium px-1 pb-1.5 text-right">Avg price</th>
              </tr>
            </thead>
            <tbody>
              {c.senders.map((s) => (
                <tr key={s.kind} className="border-t border-border/60">
                  <td className="px-1 py-2 text-xs text-foreground">{s.label}</td>
                  <td className="px-1 py-2 text-right tabular-nums">
                    <DrillButton req={{ title: s.label, ids: s.dealIds }}>{s.count}</DrillButton>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums" title={`${s.won} won · ${s.lost} lost`}>{pct(s.winRate)}</td>
                  <td className="px-1 py-2 text-right tabular-nums text-xs" title={`${s.priced} won deals with a known price`}>
                    {s.avgAgreedPriceUsd === null ? '—' : usd(s.avgAgreedPriceUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
