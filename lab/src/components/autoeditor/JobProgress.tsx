import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, MinusCircle } from 'lucide-react';
import {
  autoEditorEvents,
  type AutoEvent,
  type AutoJobDetail,
  type AutoStageState,
  type AutoStageStatus,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';

/**
 * Jake 2026-10-08: "Be transparent about each part of the process in the UI — show a
 * progress bar and a full log of each process."
 *
 * One overall bar for the job, then one row per stage of THIS job's workflow (name, state,
 * bar, %, elapsed, ETA, cost so far, warnings/errors) that opens into that stage's FULL
 * live log — sub-processes (each screencast, the recorder agent's steps, renders, every
 * paid API call with model + $) included. The log is the worker's events.jsonl, polled
 * incrementally (only the new bytes each time); older jobs fall back to log.txt.
 */

const FALLBACK_STAGES: { id: string; title: string }[] = [
  { id: 'download', title: 'Download from Descript' },
  { id: 'audio', title: 'Extract audio' },
  { id: 'transcribe', title: 'Transcribe (word level)' },
  { id: 'align', title: 'Re-time every word' },
  { id: 'takes', title: 'Pick the best takes' },
  { id: 'cut', title: 'Build the cut' },
  { id: 'listen', title: 'Sound check' },
  { id: 'preview', title: 'Render video preview' },
  { id: 'final', title: 'Final render (full resolution)' },
];

const MAX_EVENTS = 20000;

// Static classes only — Tailwind has no safelist here.
const ICON: Record<string, { icon: typeof Circle; cls: string; label: string }> = {
  pending: { icon: Circle, cls: 'text-muted-foreground/50', label: 'Waiting' },
  running: { icon: Loader2, cls: 'text-blue-400 animate-spin', label: 'Running' },
  done: { icon: CheckCircle2, cls: 'text-green-400', label: 'Done' },
  skipped: { icon: MinusCircle, cls: 'text-muted-foreground', label: 'Skipped' },
  failed: { icon: AlertTriangle, cls: 'text-red-400', label: 'Failed' },
  interrupted: { icon: AlertTriangle, cls: 'text-amber-400', label: 'Stopped' },
};

const BAR: Record<string, string> = {
  pending: 'bg-muted-foreground/30',
  running: 'bg-blue-500',
  done: 'bg-green-500',
  skipped: 'bg-muted-foreground/30',
  failed: 'bg-red-500',
  interrupted: 'bg-amber-500',
};

const KIND_TAG: Record<string, { text: string; cls: string }> = {
  api: { text: 'API', cls: 'bg-emerald-500/15 text-emerald-400' },
  proc: { text: 'PROC', cls: 'bg-violet-500/15 text-violet-300' },
  step: { text: 'STEP', cls: 'bg-sky-500/15 text-sky-300' },
  stage: { text: 'STAGE', cls: 'bg-muted text-foreground' },
  progress: { text: 'PROG', cls: 'bg-blue-500/10 text-blue-300' },
  log: { text: 'LOG', cls: 'bg-muted text-muted-foreground' },
};

export function dur(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function clock(t: number): string {
  const d = new Date(t * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

const money = (usd: number | null | undefined) =>
  usd === null || usd === undefined ? '' : usd >= 0.995 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;

interface StageView {
  id: string;
  title: string;
  st: AutoStageStatus | undefined;
  state: AutoStageState;
  frac: number;
  elapsed: number | null;
  eta: number | null;
  etaGuess: boolean;
  expect: number | null;
  cost: number | null;
}

function stageView(
  s: { id: string; title: string },
  st: AutoStageStatus | undefined,
  expect: number | null,
  now: number,
): StageView {
  const state = (st?.state ?? 'pending') as AutoStageState;
  const elapsed =
    st?.started_at && (state === 'running' || st.finished_at)
      ? Math.max(0, (state === 'running' ? now : st.finished_at!) - st.started_at)
      : null;
  const p = typeof st?.progress === 'number' ? Math.max(0, Math.min(1, st.progress)) : 0;
  const frac = state === 'done' || state === 'skipped' ? 1 : p;
  let eta: number | null = null;
  let etaGuess = false;
  if (state === 'running' && elapsed !== null) {
    if (p >= 0.02 && elapsed >= 5) eta = (elapsed * (1 - p)) / p;
    else if (expect !== null) {
      eta = Math.max(0, expect - elapsed);
      etaGuess = true;
    }
  }
  const cost = typeof st?.cost_usd === 'number' ? st.cost_usd : typeof st?.api_usd === 'number' ? st.api_usd : null;
  return { id: s.id, title: s.title, st, state, frac, elapsed, eta, etaGuess, expect, cost };
}

function Bar({ frac, state, thin }: { frac: number; state: string; thin?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded bg-muted', thin ? 'h-1' : 'h-2')}>
      <div
        className={cn('h-full transition-all duration-500', BAR[state] ?? BAR.pending, state === 'running' && frac < 0.01 && 'animate-pulse')}
        style={{ width: `${Math.max(state === 'running' ? 2 : 0, Math.round(frac * 100))}%` }}
      />
    </div>
  );
}

/** A scrolling log that follows new lines while you are at the bottom, and stays put when you scroll up. */
function LogView({ events, showStage, maxH = 'max-h-80' }: { events: AutoEvent[]; showStage?: boolean; maxH?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  if (events.length === 0) return <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Nothing logged yet.</p>;
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn('overflow-auto rounded border border-border bg-black/30 font-mono text-[10.5px] leading-relaxed', maxH)}
    >
      {events.map((e, i) => {
        const tag = KIND_TAG[e.kind] ?? KIND_TAG.log;
        return (
          <div
            key={i}
            className={cn(
              'flex gap-2 px-2 py-px',
              e.level === 'error' ? 'bg-red-500/10 text-red-300' : e.level === 'warn' ? 'bg-amber-500/10 text-amber-300' : 'text-muted-foreground',
            )}
          >
            <span className="shrink-0 text-muted-foreground/70">{clock(e.t)}</span>
            <span className={cn('shrink-0 rounded px-1 text-[9px] leading-[16px]', tag.cls)}>{tag.text}</span>
            {showStage && <span className="shrink-0 text-foreground/70">{e.stage}</span>}
            {e.sub && <span className="shrink-0 rounded bg-sky-500/10 px-1 text-[9px] leading-[16px] text-sky-300">{e.sub}</span>}
            <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', e.kind === 'stage' && e.level === 'info' && 'text-foreground')}>
              {e.msg}
              {e.kind === 'progress' && typeof e.frac === 'number' && e.frac > 0 ? ` (${Math.round(e.frac * 100)}%)` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StageLog({ events }: { events: AutoEvent[] }) {
  const subs = useMemo(() => {
    const seen: string[] = [];
    for (const e of events) if (e.sub && !seen.includes(e.sub)) seen.push(e.sub);
    return seen;
  }, [events]);
  const [sub, setSub] = useState<string | null>(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const shown = events.filter((e) => (!sub || e.sub === sub) && (!onlyIssues || e.level !== 'info'));
  const api = events.filter((e) => e.kind === 'api');
  const apiUsd = api.reduce((a, e) => a + (e.usd ?? 0), 0);
  const models = [...new Set(api.map((e) => e.model).filter(Boolean))];
  const issues = events.filter((e) => e.level !== 'info').length;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {subs.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setSub(null)}
              className={cn('rounded border px-1.5 py-0.5', sub === null ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground')}
            >
              All parts
            </button>
            {subs.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSub(sub === s ? null : s)}
                className={cn('rounded border px-1.5 py-0.5', sub === s ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground')}
              >
                {s}
              </button>
            ))}
          </>
        )}
        {issues > 0 && (
          <button
            type="button"
            onClick={() => setOnlyIssues(!onlyIssues)}
            className={cn('rounded border px-1.5 py-0.5', onlyIssues ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-border text-muted-foreground')}
          >
            Warnings + errors only ({issues})
          </button>
        )}
        {api.length > 0 && (
          <span className="text-muted-foreground">
            {api.length} API call{api.length === 1 ? '' : 's'}
            {models.length ? ` (${models.join(', ')})` : ''}
            {apiUsd > 0 ? ` · ${money(apiUsd)}` : ''}
          </span>
        )}
      </div>
      <LogView events={shown} />
    </div>
  );
}

export function JobProgress({ job, live }: { job: AutoJobDetail; live: boolean }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) {
      setNow(Date.now() / 1000);
      return;
    }
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [live]);

  // ── the structured log, polled from the byte offset we already have ──
  const [events, setEvents] = useState<AutoEvent[]>([]);
  const [logNote, setLogNote] = useState<string | null>(null);
  const offset = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    offset.current = 0;
    setEvents([]);
  }, [job.id]);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await autoEditorEvents({ id: job.id, after: offset.current });
        if (stop) return;
        offset.current = r.next;
        setLogNote(
          r.legacy ? 'This job ran before the structured log existed — showing its plain worker log.'
            : r.truncated ? 'Long log — showing its most recent part.' : null,
        );
        if (r.replace) setEvents(r.events.slice(-MAX_EVENTS));
        else if (r.events.length) setEvents((prev) => [...prev, ...r.events].slice(-MAX_EVENTS));
      } catch {
        /* the next poll tries again */
      } finally {
        busy.current = false;
      }
    };
    void pull();
    const t = setInterval(() => void pull(), live ? 2000 : 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [job.id, live]);

  const byStage = useMemo(() => {
    const m = new Map<string, AutoEvent[]>();
    for (const e of events) {
      const k = e.stage || 'job';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [events]);

  const list = job.stageList?.length ? job.stageList : FALLBACK_STAGES;
  const views = list.map((s) => stageView(s, job.status.stages?.[s.id], job.expect?.[s.id] ?? null, now));
  // stages the status knows that the list does not (an older job's extra stage): still shown
  for (const id of Object.keys(job.status.stages ?? {})) {
    if (!list.some((s) => s.id === id)) views.push(stageView({ id, title: id }, job.status.stages?.[id], null, now));
  }

  // ── overall: weighted by each stage's typical duration; "final" counts once it is asked for ──
  const counted = views.filter((v) => v.state !== 'skipped' && !(v.id === 'final' && v.state === 'pending'));
  const known = counted.map((v) => v.expect).filter((x): x is number => x !== null && x > 0).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 60;
  const weight = (v: StageView) => Math.max(1, v.expect ?? v.elapsed ?? typical);
  const total = counted.reduce((a, v) => a + weight(v), 0);
  const overall = total ? counted.reduce((a, v) => a + weight(v) * v.frac, 0) / total : 0;
  let remaining = 0;
  let unknown = false;
  for (const v of counted) {
    if (v.state === 'running') {
      if (v.eta !== null) remaining += v.eta;
      else unknown = true;
    } else if (v.state === 'pending' || v.state === 'interrupted' || v.state === 'failed') {
      if (v.expect !== null) remaining += v.expect;
      else unknown = true;
    }
  }
  const state = job.status.state ?? 'queued';
  const runStart = job.status.started_at;
  const runElapsed = runStart ? (state === 'running' ? now : job.status.updated_at ?? now) - runStart : null;
  const cost = job.status.cost_live_usd ?? job.status.cost_usd ?? 0;
  const running = views.find((v) => v.state === 'running');

  // the running stage opens by itself (once — closing it stays closed)
  const [open, setOpen] = useState<Set<string>>(new Set());
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (running && autoOpened.current !== running.id) {
      autoOpened.current = running.id;
      setOpen((o) => new Set(o).add(running.id));
    }
  }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const [showAll, setShowAll] = useState(false);
  const jobEvents = byStage.get('job') ?? [];
  const totalIssues = events.filter((e) => e.level !== 'info').length;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
          <span className="font-medium text-foreground">
            Overall {Math.round(overall * 100)}%
            {running && <span className="font-normal text-muted-foreground"> — {running.title}</span>}
          </span>
          <span className="text-muted-foreground">
            {runElapsed !== null && state === 'running' && <>this run {dur(runElapsed)} · </>}
            {live && (remaining > 0 || unknown) && (
              <>
                ETA {unknown ? '≥ ' : '~'}
                {dur(remaining)} ·{' '}
              </>
            )}
            {money(cost)} so far
          </span>
        </div>
        <Bar frac={overall} state={state === 'failed' ? 'failed' : state === 'running' ? 'running' : overall >= 1 ? 'done' : 'pending'} />
      </div>

      <div className="divide-y divide-border/60 rounded-md border border-border">
        {views.map((v) => {
          const I = ICON[v.state] ?? ICON.pending;
          const Icon = I.icon;
          const evs = byStage.get(v.id) ?? [];
          const isOpen = open.has(v.id);
          const warn = v.st?.warnings ?? evs.filter((e) => e.level === 'warn').length;
          const err = v.st?.errors ?? evs.filter((e) => e.level === 'error').length;
          return (
            <div key={v.id}>
              <button
                type="button"
                onClick={() => toggle(v.id)}
                className="grid w-full grid-cols-[14px_14px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left hover:bg-muted/30 sm:grid-cols-[14px_14px_minmax(0,14rem)_minmax(0,1fr)_auto]"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                <Icon className={cn('h-3.5 w-3.5', I.cls)} />
                <span className="truncate text-xs text-foreground">{v.title}</span>
                <div className="col-span-3 sm:col-span-1">
                  <Bar frac={v.frac} state={v.state} thin />
                </div>
                <span className="col-span-3 flex flex-wrap items-center gap-x-2 text-[10.5px] tabular-nums text-muted-foreground sm:col-span-1 sm:justify-end">
                  <span className={cn(v.state === 'failed' && 'text-red-400', v.state === 'interrupted' && 'text-amber-400')}>
                    {v.state === 'running' ? `${Math.round(v.frac * 100)}%` : I.label}
                  </span>
                  {v.elapsed !== null && <span>{dur(v.elapsed)}</span>}
                  {v.state === 'running' && v.eta !== null && (
                    <span>
                      ETA {v.etaGuess ? '~' : ''}
                      {dur(v.eta)}
                    </span>
                  )}
                  {v.state === 'pending' && v.expect !== null && <span>~{dur(v.expect)}</span>}
                  {v.cost !== null && v.cost > 0 && <span className="text-emerald-400">{money(v.cost)}</span>}
                  {warn > 0 && <span className="rounded bg-amber-500/15 px-1 text-amber-300">⚠ {warn}</span>}
                  {err > 0 && <span className="rounded bg-red-500/15 px-1 text-red-300">✖ {err}</span>}
                </span>
              </button>
              {(v.state === 'running' ? v.st?.message : v.st?.note) && (
                <p
                  className={cn(
                    'truncate px-2 pb-1.5 pl-[46px] text-[10.5px]',
                    v.state === 'failed' ? 'text-red-400' : v.state === 'running' ? 'text-blue-300' : 'text-muted-foreground',
                  )}
                  title={(v.state === 'running' ? v.st?.message : v.st?.note) ?? ''}
                >
                  {v.state === 'running' ? v.st?.message : v.st?.note}
                </p>
              )}
              {isOpen && (
                <div className="px-2 pb-2 pl-[46px]">
                  <StageLog events={evs} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {jobEvents.length > 0 && (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-muted-foreground">
            Job events (claims, restarts, failures outside a stage) — {jobEvents.length}
          </summary>
          <div className="px-2 pb-2">
            <LogView events={jobEvents} maxH="max-h-48" />
          </div>
        </details>
      )}
      <div className="space-y-1.5">
        <button type="button" onClick={() => setShowAll(!showAll)} className="text-[11px] text-primary hover:underline">
          {showAll ? 'Hide the full log' : `Show the full log, every stage (${events.length} lines${totalIssues ? `, ${totalIssues} warnings/errors` : ''})`}
        </button>
        {logNote && <p className="text-[10.5px] text-muted-foreground">{logNote}</p>}
        {showAll && <LogView events={events} showStage maxH="max-h-[32rem]" />}
      </div>
    </div>
  );
}
