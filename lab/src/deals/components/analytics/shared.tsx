/**
 * Analytics page — shared bits: money/number formatting, the card shell, the
 * clickable number, and the drill-down context (any number → the deals behind it).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/deals/ui/tooltip';
import type { DealRef } from '@/deals/apiAnalytics';

export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
export const usdShort = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `$${Math.round(n / 100) / 10}k`.replace('.0k', 'k') : `$${Math.round(n)}`;
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);

export const GROUP_COLOR: Record<string, string> = {
  new: 'var(--pill-blue-text)',
  following_up: 'var(--pill-gray-text)',
  negotiating: 'hsl(var(--primary))',
  contract: 'var(--pill-orange-text)',
  production: 'var(--pill-purple-text)',
  completed: 'var(--pill-green-text)',
  lost: 'var(--pill-red-text)',
};

/* ── drill-down ───────────────────────────────────────────────────────────── */

export interface DrillRequest {
  title: string;
  ids: string[];
  /** One line under the title: what these deals have in common / how it was counted. */
  note?: string;
  /** Extra free-text rows (e.g. the agent's booked-slot labels). */
  extra?: string[];
}
type DrillFn = (req: DrillRequest) => void;
export const DrillContext = createContext<{ open: DrillFn; deals: Record<string, DealRef> }>({ open: () => {}, deals: {} });
export const useDrill = () => useContext(DrillContext);

/** A number (or anything) that opens the deals behind it. Renders plain text when there are none. */
export function DrillButton({ req, children, className = '', title }: { req: DrillRequest; children: ReactNode; className?: string; title?: string }) {
  const { open } = useDrill();
  if (!req.ids.length && !req.extra?.length) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); open(req); }}
      title={title ?? `Show the ${req.ids.length} deal${req.ids.length === 1 ? '' : 's'}`}
      className={`underline decoration-dotted decoration-1 underline-offset-4 hover:decoration-solid hover:text-primary transition-colors text-left ${className}`}
    >
      {children}
    </button>
  );
}

/* ── card shell ───────────────────────────────────────────────────────────── */

export function Card({ title, info, action, children, className = '' }: {
  title: string; info?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`glass-card rounded-xl p-4 sm:p-5 min-w-0 ${className}`}>
      <header className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {info && <InfoTip text={info} />}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="How this is counted" className="text-muted-foreground/60 hover:text-muted-foreground flex-shrink-0">
          <Info size={12} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

export function SectionTitle({ n, children, sub }: { n: number; children: ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <span className="text-[11px] font-semibold text-muted-foreground tabular-nums">{n}</span>
      <h2 className="text-base font-semibold text-foreground tracking-tight">{children}</h2>
      {sub && <span className="text-xs text-muted-foreground hidden sm:inline">{sub}</span>}
    </div>
  );
}

/** A chart tooltip body in theme tokens. */
export function ChartTip({ active, label, lines }: { active?: boolean; label?: ReactNode; lines: Array<[string, ReactNode]> }) {
  if (!active) return null;
  return (
    <div className="bg-popover border border-border rounded-lg px-2.5 py-2 text-xs shadow-lg min-w-[140px]">
      {label !== undefined && <p className="font-semibold text-foreground mb-1">{label}</p>}
      {lines.map(([k, v], i) => (
        <p key={i} className="text-muted-foreground flex justify-between gap-3">
          <span>{k}</span><span className="text-foreground tabular-nums">{v}</span>
        </p>
      ))}
    </div>
  );
}
