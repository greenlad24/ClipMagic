/** Section 3 — pipeline by stage group (groups come from the stage table). Click a row for its deals. */
import type { AnalyticsMetrics } from '@/deals/apiAnalytics';
import { Card, GROUP_COLOR, useDrill, usdShort } from './shared';

export default function PipelineGroups({ m }: { m: AnalyticsMetrics }) {
  const { open } = useDrill();
  const max = Math.max(1, ...m.pipeline.map((g) => g.count));
  return (
    <Card
      title="Pipeline by stage"
      info={`Stage groups follow the board's stage order. Value = agreed price where known, otherwise list price (${usdShort(m.goals.listPriceDedicatedUsd)} per dedicated video, ${usdShort(m.goals.listPriceShortUsd)} for a Shorts deal). Click a row to list its deals.`}
    >
      <ul className="space-y-1">
        {m.pipeline.map((g) => (
          <li key={g.group}>
            <button
              type="button"
              disabled={!g.count}
              onClick={() => open({
                title: g.label, ids: g.dealIds,
                note: g.stages.map((s) => `${s.name} ${s.count}`).join(' · ') || undefined,
              })}
              className="w-full grid grid-cols-[minmax(92px,140px)_1fr_auto] items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-muted/50 disabled:hover:bg-transparent disabled:cursor-default transition-colors text-left"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: GROUP_COLOR[g.group] }} />
                <span className="text-sm text-foreground truncate">{g.label}</span>
              </span>
              <span className="h-2.5 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted))' }}>
                <span className="block h-full rounded-full" style={{ width: `${(g.count / max) * 100}%`, background: GROUP_COLOR[g.group], minWidth: g.count ? 4 : 0 }} />
              </span>
              <span className="text-right tabular-nums whitespace-nowrap">
                <span className="text-sm font-semibold text-foreground">{g.count}</span>
                {g.group !== 'lost' && g.count > 0 && (
                  <span className="text-xs text-muted-foreground ml-2" title={`Valued at: ${g.valueBasis}`}>{usdShort(g.valueUsd)}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground mt-3">$ = list price unless an agreed price is known. Lost deals carry no value.</p>
    </Card>
  );
}
