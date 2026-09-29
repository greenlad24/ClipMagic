/**
 * A streamed run log (collection or deck build): a one-line status header that
 * is always visible, expanding into the timestamped lines + a progress bar.
 */
import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Trash2, Loader2, CheckCircle2, Terminal, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface LogEntry {
  id: number;
  ts: Date;
  message: string;
  percent: number;
  isError?: boolean;
}

interface Props {
  title: string;
  logs: LogEntry[];
  running: boolean;
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  emptyHint: string;
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function RunLog({ title, logs, running, open, onToggle, onClear, emptyHint }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the newest line (scroll the log box only, never the page).
  useEffect(() => {
    const el = scrollRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [logs.length, open]);

  const last = logs[logs.length - 1];
  const pct = last?.percent ?? 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/60"
      >
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-foreground">{title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {last ? last.message : `${logs.length} lines`}
        </span>
        {running && (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="font-mono text-xs text-primary">{pct}%</span>
          </span>
        )}
        {!running && logs.length > 0 && (
          last?.isError
            ? <span className="flex items-center gap-1 font-mono text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" />error</span>
            : <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />done</span>
        )}
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>

      {running && (
        <div className="h-0.5 bg-muted">
          <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}

      {open && (
        <div className="border-t border-border bg-background/60">
          <div className="flex items-center justify-between px-3 pt-1.5">
            <span className="text-[11px] text-muted-foreground">{logs.length} lines</span>
            <Button variant="ghost" size="sm" onClick={onClear} className="h-6 gap-1 px-2 text-xs text-muted-foreground">
              <Trash2 className="h-3 w-3" /> Clear
            </Button>
          </div>
          <div ref={scrollRef} className="space-y-0.5 overflow-y-auto px-3 pb-3" style={{ maxHeight: 240 }}>
            {logs.length === 0 ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground">{emptyHint}</p>
            ) : (
              logs.map(entry => (
                <div key={entry.id} className="flex items-start gap-2 py-0.5 font-mono text-xs">
                  <span className="shrink-0 select-none text-muted-foreground/60">{fmtTime(entry.ts)}</span>
                  <span className={`w-8 shrink-0 text-right tabular-nums ${
                    entry.percent === 100 ? 'text-emerald-400' : entry.percent >= 60 ? 'text-primary' : 'text-muted-foreground'
                  }`}>{entry.percent}%</span>
                  <span className={`flex-1 leading-relaxed ${entry.isError ? 'text-destructive' : 'text-foreground'}`}>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
