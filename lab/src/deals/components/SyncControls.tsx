/**
 * The shared Gmail-sync controls (see context/SyncContext.tsx):
 *   <SyncNowButton/>  — starts the one server sync, spins while any run is going
 *   <SyncIndicator/>  — "Last synced 14:02 · next 20:00 (Bangkok)"
 * Times are shown in Jake's timezone (Asia/Bangkok) — the server runs on UTC.
 */
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { useSync } from '@/deals/context/SyncContext';
import { syncSteps } from '@/deals/api';
import { cn } from '@/deals/ui/utils';

const TZ = 'Asia/Bangkok';

function dayKey(d: Date) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function fmtTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  if (dayKey(d) === dayKey(new Date())) return time;
  const tomorrow = new Date(Date.now() + 86400000);
  if (dayKey(d) === dayKey(tomorrow)) return `tomorrow ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })} ${time}`;
}

export function SyncIndicator({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const { available, status, running, progress } = useSync();
  if (available === false || (!status && !running)) return null;

  if (running) {
    // A run we didn't start (schedule / another tab): show its latest step.
    const cur = syncSteps(status?.current).slice(-1)[0];
    const label = progress ?? (cur ? `${cur.step}${cur.message ? `: ${cur.message}` : ''}` : null);
    return (
      <span className={cn('inline-flex items-center gap-1 text-[11px] text-muted-foreground min-w-0', className)} style={style}
        title={label ?? 'Gmail sync in progress'}>
        <Loader2 size={10} className="animate-spin flex-shrink-0" />
        <span className="truncate">{label ? `Syncing — ${label}` : 'Syncing Gmail…'}</span>
      </span>
    );
  }

  const last = status?.last;
  const lastAt = fmtTime(last?.finishedAt ?? last?.startedAt);
  const nextAt = fmtTime(status?.nextRunAt);
  const failed = last && last.ok === false;
  const parts = [
    lastAt ? `${failed ? 'Last sync failed' : 'Last synced'} ${lastAt}` : 'Not synced yet',
    nextAt ? `next ${nextAt}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] min-w-0', failed ? 'text-destructive' : 'text-muted-foreground', className)} style={style}
      title={last?.summary || undefined}>
      {failed && <AlertTriangle size={10} className="flex-shrink-0" />}
      <span className="truncate">{parts} (Bangkok)</span>
    </span>
  );
}

export function SyncNowButton({ className, label = 'Sync now', compact = false }: { className?: string; label?: string; compact?: boolean }) {
  const { running, runSync, progress } = useSync();
  return (
    <button
      type="button"
      onClick={() => { void runSync(); }}
      disabled={running}
      title={running ? (progress ?? 'Gmail sync in progress') : 'Sync Gmail now: new threads, emails, brands and deals'}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[8px] font-semibold transition-colors disabled:opacity-70 disabled:cursor-wait',
        'bg-primary text-primary-foreground hover:bg-primary/90',
        compact ? 'h-8 px-2.5 text-xs' : 'h-9 px-3 sm:px-[18px] text-[14px]',
        className,
      )}
    >
      {running ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      <span className={compact ? '' : 'hidden sm:inline'}>{running ? 'Syncing…' : label}</span>
    </button>
  );
}
