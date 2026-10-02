import { useState, useMemo, useRef, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/deals/ui/sheet';
import { Badge } from '@/deals/ui/badge';
import { Button } from '@/deals/ui/button';
import { Input } from '@/deals/ui/input';
import { ScrollArea } from '@/deals/ui/scroll-area';
import { ScanGmailOutputType } from '@/deals/api';
import {
  CheckCircle2, XCircle, AlertTriangle, Info,
  Search, Download, Trash2, ChevronDown, ChevronUp,
  Terminal, Clock,
} from 'lucide-react';

type LogEntry = ScanGmailOutputType['logs'][number];
type LogLevel = LogEntry['level'];

const LEVEL_CONFIG: Record<LogLevel, { icon: typeof Info; color: string; bg: string; label: string }> = {
  info:    { icon: Info,          color: 'text-blue-400',   bg: 'bg-blue-500/10',   label: 'INFO'    },
  success: { icon: CheckCircle2,  color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'OK'    },
  warn:    { icon: AlertTriangle, color: 'text-amber-400',  bg: 'bg-amber-500/10',  label: 'WARN'    },
  error:   { icon: XCircle,       color: 'text-red-400',    bg: 'bg-red-500/10',    label: 'ERROR'   },
};

const STEP_COLORS: Record<string, string> = {
  preflight:   'text-purple-400',
  config:      'text-slate-400',
  gmail:       'text-sky-400',
  groups:      'text-indigo-400',
  ai:          'text-violet-400',
  database:    'text-teal-400',
  attachments: 'text-orange-400',
  urls:        'text-cyan-400',
  summary:     'text-emerald-400',
};

const ALL_LEVELS: LogLevel[] = ['info', 'success', 'warn', 'error'];
const ALL_STEPS = ['preflight', 'config', 'gmail', 'groups', 'ai', 'database', 'attachments', 'urls', 'summary'];

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions); // ES2021 option; the Lab's tsconfig lib is ES2020
  } catch { return iso; }
}

interface LogsPanelProps {
  open: boolean;
  onClose: () => void;
  logs: LogEntry[];
  scanMeta?: { scanned: number; created: number; updated: number; nonDeals: number; errored: number; runAt: number } | null;
  onClear: () => void;
}

export default function LogsPanel({ open, onClose, logs, scanMeta, onClear }: LogsPanelProps) {
  const [search, setSearch] = useState('');
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(new Set(ALL_LEVELS));
  const [activeSteps, setActiveSteps] = useState<Set<string>>(new Set(ALL_STEPS));
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, autoScroll, open]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return logs.filter(e =>
      activeLevels.has(e.level) &&
      activeSteps.has(e.step) &&
      (!q || e.message.toLowerCase().includes(q) || e.step.toLowerCase().includes(q))
    );
  }, [logs, activeLevels, activeSteps, search]);

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { info: 0, success: 0, warn: 0, error: 0 };
    for (const e of logs) c[e.level]++;
    return c;
  }, [logs]);

  const toggleLevel = (l: LogLevel) => {
    setActiveLevels(prev => {
      const next = new Set(prev);
      if (next.has(l)) { if (next.size > 1) next.delete(l); }
      else next.add(l);
      return next;
    });
  };

  const toggleStep = (s: string) => {
    setActiveSteps(prev => {
      const next = new Set(prev);
      if (next.has(s)) { if (next.size > 1) next.delete(s); }
      else next.add(s);
      return next;
    });
  };

  const downloadLogs = () => {
    const text = logs.map(e => `[${e.ts}] [${e.level.toUpperCase()}] [${e.step}] ${e.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scan-logs-${Date.now()}.txt`;
    a.click();
  };

  const usedSteps = useMemo(() => {
    const s = new Set(logs.map(e => e.step));
    return ALL_STEPS.filter(st => s.has(st));
  }, [logs]);

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl p-0 flex flex-col bg-[hsl(var(--card))] border-border"
      >
        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Terminal size={14} className="text-primary" />
              </div>
              <div>
                <SheetTitle className="text-sm font-semibold text-foreground">Scan Logs</SheetTitle>
                {scanMeta && (
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Clock size={9} />
                    {new Date(scanMeta.runAt).toLocaleString()} ·
                    {scanMeta.scanned} emails · {scanMeta.created} created · {scanMeta.updated} updated · {scanMeta.errored} errors
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" onClick={downloadLogs} title="Download logs">
                <Download size={13} />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" onClick={onClear} title="Clear logs">
                <Trash2 size={13} />
              </Button>
            </div>
          </div>
        </SheetHeader>

        {/* Filters */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0 space-y-2.5">
          {/* Level filters */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {ALL_LEVELS.map(level => {
              const cfg = LEVEL_CONFIG[level];
              const active = activeLevels.has(level);
              return (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold transition-all border ${
                    active
                      ? `${cfg.bg} ${cfg.color} border-current/30`
                      : 'bg-transparent text-muted-foreground/40 border-border/40'
                  }`}
                >
                  <cfg.icon size={10} />
                  {cfg.label}
                  <span className="opacity-60">({counts[level]})</span>
                </button>
              );
            })}
            <div className="ml-auto">
              <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={e => setAutoScroll(e.target.checked)}
                  className="rounded"
                />
                Auto-scroll
              </label>
            </div>
          </div>

          {/* Step filters */}
          <div className="flex items-center gap-1 flex-wrap">
            {usedSteps.map(step => {
              const active = activeSteps.has(step);
              const color = STEP_COLORS[step] ?? 'text-muted-foreground';
              return (
                <button
                  key={step}
                  onClick={() => toggleStep(step)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wide transition-all border ${
                    active
                      ? `bg-muted/60 ${color} border-current/20`
                      : 'bg-transparent text-muted-foreground/30 border-border/30'
                  }`}
                >
                  {step}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search log messages…"
              className="h-7 pl-7 text-xs bg-muted/40 border-border/60 font-mono"
            />
          </div>
        </div>

        {/* Log entries */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-2 py-2 font-mono text-[11px] space-y-0.5">
            {logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/40">
                <Terminal size={32} className="mb-3 opacity-30" />
                <p className="text-sm">No logs yet</p>
                <p className="text-xs mt-1">Run an AI scan to see detailed logs</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground/40 text-xs">
                No entries match current filters
              </div>
            ) : (
              filtered.map((entry, idx) => {
                const cfg = LEVEL_CONFIG[entry.level];
                const stepColor = STEP_COLORS[entry.step] ?? 'text-muted-foreground';
                const isExpanded = expandedIdx === idx;
                const isLong = entry.message.length > 100;
                const displayMsg = isLong && !isExpanded ? entry.message.slice(0, 100) + '…' : entry.message;

                return (
                  <div
                    key={idx}
                    className={`group flex gap-2 px-2 py-1.5 rounded transition-colors ${cfg.bg} hover:opacity-100`}
                    style={{ opacity: 0.92 }}
                  >
                    {/* Level icon */}
                    <cfg.icon size={12} className={`${cfg.color} flex-shrink-0 mt-0.5`} />

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Timestamp */}
                        <span className="text-muted-foreground/40 text-[9px] tabular-nums whitespace-nowrap">
                          {formatTs(entry.ts)}
                        </span>
                        {/* Step badge */}
                        <span className={`text-[9px] uppercase tracking-widest font-bold ${stepColor} opacity-80`}>
                          {entry.step}
                        </span>
                      </div>
                      {/* Message */}
                      <p className={`mt-0.5 leading-relaxed break-words ${cfg.color} opacity-90`}>
                        {displayMsg}
                        {isLong && (
                          <button
                            onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                            className="ml-1 text-muted-foreground/60 hover:text-muted-foreground inline-flex items-center gap-0.5"
                          >
                            {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                          </button>
                        )}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Footer */}
        {logs.length > 0 && (
          <div className="px-4 py-2.5 border-t border-border flex-shrink-0 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground font-mono">
              {filtered.length}/{logs.length} entries
            </span>
            <div className="flex items-center gap-3 text-[10px] font-mono">
              {counts.error > 0 && <span className="text-red-400">{counts.error} errors</span>}
              {counts.warn > 0 && <span className="text-amber-400">{counts.warn} warnings</span>}
              {counts.success > 0 && <span className="text-emerald-400">{counts.success} ok</span>}
              <span className="text-muted-foreground/50">{counts.info} info</span>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
