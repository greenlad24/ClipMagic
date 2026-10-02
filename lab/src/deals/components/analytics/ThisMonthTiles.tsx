/** Section 1 — "This month": revenue vs goal, dedicated slots, open pipeline, replies owed. */
import type { AnalyticsMetrics } from '@/deals/apiAnalytics';
import { DrillButton, InfoTip, usd, usdShort } from './shared';

function Tile({ label, info, children }: { label: string; info?: string; children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-xl p-4 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {info && <InfoTip text={info} />}
      </div>
      {children}
    </div>
  );
}

function Meter({ value, max, over }: { value: number; max: number; over?: boolean }) {
  const w = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted))' }} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: over ? 'var(--pill-red-text)' : 'hsl(var(--primary))' }} />
    </div>
  );
}

export default function ThisMonthTiles({ m }: { m: AnalyticsMetrics }) {
  const t = m.thisMonth;
  const owedRecent = m.deals ? t.repliesOwed.dealIds.filter((id) => (m.deals[id]?.daysWaiting ?? 99) < 30).length : 0;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {/* Revenue vs goal */}
      <Tile label={`Booked revenue · ${t.label}`} info={m.definitions.revenue}>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <DrillButton req={{ title: `Revenue booked for ${t.label}`, ids: t.pricedDealIds, note: 'Won deals publishing this month with an agreed price.' }} className="text-2xl font-bold tracking-tight text-foreground tabular-nums">
            {usd(t.bookedRevenueUsd)}
          </DrillButton>
          <span className="text-sm text-muted-foreground">of {usdShort(t.goalUsd)}</span>
        </div>
        <Meter value={t.bookedRevenueUsd} max={t.goalUsd} />
        <p className="text-xs text-muted-foreground">
          {t.progressPct}% of goal
          {t.unpricedDealIds.length > 0 && (
            <> · <DrillButton req={{ title: `Won, no agreed price yet · ${t.label}`, ids: t.unpricedDealIds, note: 'Not counted in the revenue until a price is known.' }}>
              {t.unpricedDealIds.length} unpriced
            </DrillButton></>
          )}
        </p>
      </Tile>

      {/* Dedicated slots */}
      <Tile label="Dedicated slots filled" info={m.definitions.slots}>
        <div className="grid grid-cols-2 gap-3">
          {t.slots.map((s) => (
            <div key={s.month} className="min-w-0">
              <p className="text-[11px] text-muted-foreground truncate">{s.label}</p>
              <DrillButton
                req={{ title: `Booked · ${s.label}`, ids: s.dealIds, note: `${s.booked} of ${s.capacity} dedicated slots, the same count the agent uses.`, extra: s.labels }}
                className="text-2xl font-bold tracking-tight text-foreground tabular-nums"
              >
                {s.booked}<span className="text-base text-muted-foreground font-medium">/{s.capacity}</span>
              </DrillButton>
              <div className="mt-1.5"><Meter value={s.booked} max={s.capacity} over={s.booked > s.capacity} /></div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t.slots[1] && t.slots[1].free > 0 ? `${t.slots[1].free} free next month` : 'Next month is full'}
          {t.pendingSignature.length > 0 && (
            <> · <DrillButton req={{ title: 'Not signed yet (may take a slot)', ids: [], extra: t.pendingSignature }}>{t.pendingSignature.length} awaiting signature</DrillButton></>
          )}
        </p>
      </Tile>

      {/* Open pipeline */}
      <Tile label="Open pipeline" info={m.definitions.pipelineValue}>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <DrillButton req={{ title: 'Active open deals', ids: t.openPipeline.active.dealIds, note: `An email in the last ${m.goals.staleAfterDays} days.` }} className="text-2xl font-bold tracking-tight text-foreground tabular-nums">
            {t.openPipeline.active.count}
          </DrillButton>
          <span className="text-sm text-muted-foreground">active · {usdShort(t.openPipeline.active.listValueUsd)} at list</span>
        </div>
        <p className="text-xs text-muted-foreground">
          <DrillButton req={{ title: 'Stale open deals', ids: t.openPipeline.stale.dealIds, note: `No email in ${m.goals.staleAfterDays}+ days.` }}>
            +{t.openPipeline.stale.count} stale
          </DrillButton>{' '}
          ({usdShort(t.openPipeline.stale.listValueUsd)} at list)
        </p>
        <p className="text-[11px] text-muted-foreground/80">
          {t.openPipeline.agreedPriceCount
            ? `${t.openPipeline.agreedPriceCount} valued at their agreed price, the rest at list`
            : `List price: ${usdShort(m.goals.listPriceDedicatedUsd)} per dedicated video until prices are agreed`}
        </p>
      </Tile>

      {/* Replies owed */}
      <Tile label="Replies owed" info={m.definitions.repliesOwed}>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <DrillButton req={{ title: 'Replies owed', ids: t.repliesOwed.dealIds, note: 'The brand wrote last, more than 24 hours ago. Oldest first.' }} className="text-2xl font-bold tracking-tight tabular-nums" >
            <span style={{ color: t.repliesOwed.count ? 'var(--pill-red-text)' : undefined }}>{t.repliesOwed.count}</span>
          </DrillButton>
          <span className="text-sm text-muted-foreground">threads where they wrote last</span>
        </div>
        <p className="text-xs text-muted-foreground">
          <DrillButton req={{ title: 'Replies owed · last 30 days', ids: t.repliesOwed.dealIds.filter((id) => (m.deals[id]?.daysWaiting ?? 99) < 30), note: 'The brand wrote in the last 30 days.' }}>
            {owedRecent} from the last 30 days
          </DrillButton>
          {' · '}{t.repliesOwed.count - owedRecent} older
        </p>
      </Tile>
    </div>
  );
}
