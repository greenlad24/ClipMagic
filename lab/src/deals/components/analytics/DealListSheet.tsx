/**
 * The drill-down panel: the deals behind any number on the Analytics page,
 * each linking to its workspace (/deal-organizer/deals/:id).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/deals/ui/sheet';
import type { DealRef } from '@/deals/apiAnalytics';
import { GROUP_COLOR, usd, type DrillRequest } from './shared';

const TYPE_LABEL: Record<string, string> = { dedicated: 'Dedicated', shorts: 'Shorts', service_vendor: 'Vendor', other: 'Other' };

function monthName(key: string | null) {
  if (!key) return null;
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export default function DealListSheet({ req, deals, onClose }: { req: DrillRequest | null; deals: Record<string, DealRef>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const list = (req?.ids ?? []).map((id) => deals[id]).filter(Boolean) as DealRef[];
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((d) => `${d.name} ${d.client} ${d.email} ${d.stage}`.toLowerCase().includes(needle)) : list;
  }, [req, deals, q]);

  return (
    <Sheet open={!!req} onOpenChange={(o) => { if (!o) { onClose(); setQ(''); } }}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border text-left">
          <SheetTitle className="text-base pr-6">{req?.title} <span className="text-muted-foreground font-normal">· {req?.ids.length ?? 0}</span></SheetTitle>
          {req?.note && <SheetDescription className="text-xs">{req.note}</SheetDescription>}
          {(req?.ids.length ?? 0) > 8 && (
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…"
              className="mt-2 w-full h-8 rounded-md border border-border bg-transparent px-2.5 text-sm outline-none focus:ring-1 focus:ring-primary/50"
            />
          )}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {req?.extra?.length ? (
            <ul className="px-3 pb-3 space-y-1.5">
              {req.extra.map((x, i) => <li key={i} className="text-xs text-muted-foreground leading-relaxed">{x}</li>)}
            </ul>
          ) : null}
          {rows.length === 0 && !req?.extra?.length && <p className="text-sm text-muted-foreground px-3 py-6 text-center">No deals.</p>}
          {rows.map((d) => (
            <Link
              key={d.id}
              to={d.url}
              className="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/60 transition-colors group"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{d.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {d.client || d.email}{d.client && d.email ? ` · ${d.email}` : ''}
                </p>
                <p className="text-[11px] mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: GROUP_COLOR[d.group] }} />
                    {d.stage || '—'}
                  </span>
                  {d.dealType && <span>{TYPE_LABEL[d.dealType] ?? d.dealType}</span>}
                  {d.slotMonth && <span>publishes {monthName(d.slotMonth)}</span>}
                  {d.waitingOn && d.daysWaiting !== null && (
                    <span>{d.waitingOn === 'jake' ? 'they wrote' : 'you wrote'} {d.daysWaiting}d ago</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0 pt-0.5">
                {d.agreedPrice !== null && <span className="text-xs font-medium text-foreground tabular-nums">{usd(d.agreedPrice)}</span>}
                <ArrowUpRight size={13} className="text-muted-foreground/40 group-hover:text-primary transition-colors" />
              </div>
            </Link>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
