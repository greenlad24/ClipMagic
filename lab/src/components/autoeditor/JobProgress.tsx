import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Circle, HardDrive, Loader2, MinusCircle, RotateCcw, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  autoEditorEvents,
  type AutoEvent,
  type AutoJobDetail,
  type AutoRunner,
  type AutoStageState,
  type AutoStageStatus,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import type { AutoPred } from 'zite-endpoints-sdk';
import { blendLive, etaText, sumPreds } from './etaLive';

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

/**
 * Where this job runs — the Video factory (one DigitalOcean server per job, deleted after)
 * or the main box. runner.json is written by the host worker; it describes the current run,
 * or the last one when the job is idle.
 */
const RUNNER_PHASE: Record<string, { text: string; frac: number }> = {
  'copying-image': { text: 'copying the server image…', frac: 0.05 },
  creating: { text: 'creating…', frac: 0.1 },
  sending: { text: 'sending job', frac: 0.25 },
  running: { text: 'running', frac: 0.5 },
  pulling: { text: 'results back', frac: 0.9 },
  done: { text: 'done', frac: 1 },
  failed: { text: 'failed', frac: 1 },
};

function runnerStageState(r: AutoRunner | null | undefined): AutoStageState {
  if (!r?.state) return 'pending';
  if (r.state === 'done') return 'done';
  if (r.state === 'failed') return 'failed';
  return 'running';
}

function RunnerBadge({ runner, runOn, jobState, now }: {
  runner: AutoRunner | null | undefined; runOn?: string; jobState: string; now: number;
}) {
  const active = jobState === 'running';
  if (!runner || !runner.kind) {
    // never routed yet: say what was asked for
    const asked = runOn === 'factory' ? 'Factory server (requested)' : runOn === 'box' ? 'Main box' : null;
    if (!asked) return null;
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        {runOn === 'factory' ? <Server className="h-3 w-3" /> : <HardDrive className="h-3 w-3" />}
        {asked}
      </span>
    );
  }
  if (runner.kind === 'box') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        <HardDrive className="h-3 w-3" />
        Main box{active ? '' : ' · last run'}
      </span>
    );
  }
  const st = runner.state ?? 'creating';
  const live = st !== 'done' && st !== 'failed';
  const start = runner.started ?? null;
  const secs = start ? (live ? now : runner.ended ?? now) - start : null;
  const usdNow = live && secs !== null ? (secs / 3600) * (runner.price_hourly ?? 1) : runner.usd ?? 0;
  const runSecs = runner.running_since ? (live ? now : runner.ended ?? now) - runner.running_since : null;
  let text: string;
  if (st === 'running' && runSecs !== null) text = `running ${dur(runSecs)}`;
  else if (st === 'done') text = runner.destroyed === false ? 'results back · DELETE NOT CONFIRMED' : 'results back · server deleted';
  else if (st === 'failed') text = runner.destroyed === false ? 'failed · DELETE NOT CONFIRMED' : 'failed · server deleted';
  else text = (st === 'copying-image' && runner.note) || (RUNNER_PHASE[st]?.text ?? st);
  if (st === 'failed' && active) text += ' → running on the main box';
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-x-1.5 rounded px-2 py-0.5 text-[11px]',
        live ? 'bg-blue-500/15 text-blue-300' : st === 'failed' || runner.destroyed === false ? 'bg-red-500/10 text-red-300' : 'bg-muted text-muted-foreground',
      )}
      title={runner.droplet ? `DigitalOcean droplet #${runner.droplet}${runner.region ? ` in ${runner.region}` : ''}` : undefined}
    >
      {live ? <Loader2 className="h-3 w-3 animate-spin" /> : <Server className="h-3 w-3" />}
      Factory server {runner.size ?? ''}{runner.region ? ` · ${runner.region}` : ''} · {text}
      {usdNow > 0 && <span className="tabular-nums text-emerald-400">· ${usdNow.toFixed(2)}</span>}
      {!live && !active && <span className="text-muted-foreground/70">(last run)</span>}
    </span>
  );
}

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
  /** the timing model's prior for this stage (server aieditor/eta.ts) */
  pred: AutoPred | null;
  /** running: the live-corrected remaining time (etaLive.blendLive) */
  live: AutoPred | null;
  cost: number | null;
}

function stageView(
  s: { id: string; title: string },
  st: AutoStageStatus | undefined,
  pred: AutoPred | null,
  now: number,
  reachedAt: number | null = null,
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
  let live: AutoPred | null = null;
  if (state === 'running' && elapsed !== null) {
    // the prior, pulled toward the observed rate as the stage reports progress
    live = blendLive(pred, elapsed, p > 0 ? p : null, reachedAt ?? elapsed);
    if (live) {
      eta = live.sec;
      etaGuess = !live.confident;
    }
  }
  const expect = pred ? pred.sec : null;
  const cost = typeof st?.cost_usd === 'number' ? st.cost_usd : typeof st?.api_usd === 'number' ? st.api_usd : null;
  return { id: s.id, title: s.title, st, state, frac, elapsed, eta, etaGuess, expect, pred, live, cost };
}

/** seconds after the stage started at which it FIRST reported its current fraction (its events) */
function reachedAtOf(st: AutoStageStatus | undefined, evs: AutoEvent[]): number | null {
  if (!st?.started_at || st.state !== 'running' || typeof st.progress !== 'number' || st.progress <= 0) return null;
  const p = st.progress;
  for (const e of evs) {
    if (e.t >= st.started_at && typeof e.frac === 'number' && e.frac >= p - 0.0005) return Math.max(0, e.t - st.started_at);
  }
  return null;
}

/** an older job (or a server without the model): the plain typical seconds as a loose estimate */
function predOf(job: AutoJobDetail, id: string): AutoPred | null {
  const p = job.eta?.stages?.[id];
  if (p) return p;
  const x = job.expect?.[id];
  return typeof x === 'number' ? { sec: x, lo: x * 0.6, hi: x * 1.4, n: 1, confident: false, scaled: false, unit: 'fixed' } : null;
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

/**
 * One stage, drawn for its moment: the RUNNING stage is the big one (bar, %, ETA, message,
 * its live log open), a FAILED/STOPPED one is loud with Continue right beside it, DONE ones
 * are a single compact line, PENDING/SKIPPED ones are quiet text. Every number stays — the
 * bar and the full log of any stage are one click away.
 */
function StageRow({
  id, title, state, frac, elapsed, eta, etaGuess, expect, livePred, pred, cost, warn, err, msg, note, label, events, isOpen, onToggle, onContinue,
}: {
  id: string; title: string; state: AutoStageState; frac: number; elapsed: number | null; eta: number | null; etaGuess?: boolean;
  expect: number | null; livePred?: AutoPred | null; pred?: AutoPred | null; cost: number | null; warn: number; err: number; msg?: string | null; note?: string | null; label?: string;
  events: AutoEvent[]; isOpen: boolean; onToggle: () => void; onContinue?: () => void;
}) {
  const I = ICON[state] ?? ICON.pending;
  const Icon = I.icon;
  const loud = state === 'running' || state === 'failed' || state === 'interrupted';
  const quiet = state === 'pending' || state === 'skipped';
  const line = state === 'running' ? msg : note ?? (state === 'failed' || state === 'interrupted' ? msg : null);
  return (
    <div
      data-stage={id}
      className={cn(
        'rounded-md',
        state === 'running' && 'border border-blue-500/30 bg-blue-500/5',
        state === 'failed' && 'border border-red-500/40 bg-red-500/5',
        state === 'interrupted' && 'border border-amber-500/40 bg-amber-500/5',
        loud && 'my-1',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn('flex w-full items-center gap-2 px-2 text-left hover:bg-muted/30', loud ? 'pt-2 pb-1' : 'py-1')}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', I.cls)} />
        <span
          className={cn(
            'shrink-0 truncate',
            loud ? 'text-[13px] font-medium text-foreground' : quiet ? 'text-xs text-muted-foreground/70' : 'text-xs text-foreground/90',
            'max-w-[60%] sm:max-w-[45%]',
          )}
        >
          {title}
        </span>
        {!loud && line && <span className="hidden min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/70 sm:block">{line}</span>}
        <span className={cn('ml-auto flex shrink-0 items-center gap-x-2 text-[10.5px] tabular-nums', quiet ? 'text-muted-foreground/60' : 'text-muted-foreground')}>
          {state === 'running' && <span className="text-blue-300">{label ?? `${Math.round(frac * 100)}%`}</span>}
          {(state === 'failed' || state === 'interrupted') && (
            <span className={state === 'failed' ? 'text-red-400' : 'text-amber-400'}>{I.label}</span>
          )}
          {state === 'skipped' && <span>Skipped</span>}
          {elapsed !== null && state !== 'pending' && <span>{dur(elapsed)}</span>}
          {state === 'running' && eta !== null && (
            <span title={livePred?.scaled ? 'No run of this step on this server size yet — scaled from other sizes' : undefined}>
              ETA {livePred ? etaText(livePred) : `${etaGuess ? '~' : ''}${dur(eta)}`}
            </span>
          )}
          {state === 'pending' && expect !== null && (
            <span title={pred?.scaled ? 'No run of this step on this server size yet — scaled from other sizes' : pred ? `${pred.n} earlier run${pred.n === 1 ? '' : 's'}` : undefined}>
              {pred ? etaText(pred) : `~${dur(expect)}`}
            </span>
          )}
          {cost !== null && cost > 0 && <span className="text-emerald-400">{money(cost)}</span>}
          {warn > 0 && <span className="rounded bg-amber-500/15 px-1 text-amber-300">⚠ {warn}</span>}
          {err > 0 && <span className="rounded bg-red-500/15 px-1 text-red-300">✖ {err}</span>}
          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 opacity-50" />}
        </span>
      </button>
      {loud && (
        <div className="space-y-1.5 px-2 pb-2 pl-[30px]">
          <Bar frac={frac} state={state} />
          {line && (
            <div className="flex items-start gap-2">
              <p
                className={cn(
                  'min-w-0 flex-1 text-[11px] leading-snug',
                  state === 'failed' ? 'text-red-300' : state === 'interrupted' ? 'text-amber-300' : 'text-blue-300',
                )}
              >
                {line}
              </p>
            </div>
          )}
          {(state === 'failed' || state === 'interrupted') && onContinue && (
            <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={onContinue}>
              <RotateCcw className="h-3.5 w-3.5" /> Continue from here
            </Button>
          )}
        </div>
      )}
      {isOpen && (
        <div className="space-y-1.5 px-2 pb-2 pl-[30px]">
          {!loud && (
            <>
              <Bar frac={frac} state={state} thin />
              {line && <p className="text-[10.5px] text-muted-foreground">{line}</p>}
            </>
          )}
          <StageLog events={events} />
        </div>
      )}
    </div>
  );
}

export function JobProgress({ job, live, onContinue }: { job: AutoJobDetail; live: boolean; onContinue?: () => void }) {
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

  // the first stage is named after the job's source (the server already does; this covers the fallback list)
  const srcKind = job.request.source?.kind;
  const list = (job.stageList?.length ? job.stageList : FALLBACK_STAGES).map((s) =>
    s.id === 'download' && (srcKind === 'job' || srcKind === 'upload')
      ? { ...s, title: srcKind === 'job' ? 'Use the Lab edit' : 'Use the uploaded file' }
      : s,
  );
  // a stage still marked "running" in an idle job was cut off (an old run, a restart): say Stopped, not Running
  const stageOf = (id: string): AutoStageStatus | undefined => {
    const st = job.status.stages?.[id];
    return st && !live && st.state === 'running' ? { ...st, state: 'interrupted' } : st;
  };
  const views = list.map((s) => stageView(s, stageOf(s.id), predOf(job, s.id), now, reachedAtOf(stageOf(s.id), byStage.get(s.id) ?? [])));
  // stages the status knows that the list does not (an older job's extra stage): still shown
  for (const id of Object.keys(job.status.stages ?? {})) {
    if (!list.some((s) => s.id === id)) views.push(stageView({ id, title: id }, stageOf(id), null, now));
  }

  // ── overall: weighted by each stage's typical duration; "final" counts once it is asked for ──
  const counted = views.filter((v) => v.state !== 'skipped' && !(v.id === 'final' && v.state === 'pending'));
  const known = counted.map((v) => v.expect).filter((x): x is number => x !== null && x > 0).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 60;
  // done stages weigh what they took, the running one elapsed + its live remaining (so a stage that
  // says 75 % a quarter of the way in does not jump the bar), the rest their estimate
  const weight = (v: StageView) =>
    Math.max(1, v.state === 'done' && v.elapsed !== null ? v.elapsed
      : v.state === 'running' && v.elapsed !== null && v.eta !== null ? v.elapsed + v.eta
        : v.expect ?? v.elapsed ?? typical);
  const doneShare = (v: StageView) =>
    v.state === 'running' && v.elapsed !== null && v.eta !== null ? v.elapsed / Math.max(1, v.elapsed + v.eta) : v.frac;
  const total = counted.reduce((a, v) => a + weight(v), 0);
  const overall = total ? counted.reduce((a, v) => a + weight(v) * doneShare(v), 0) / total : 0;
  // the rest of the job: the running stage's live estimate + every stage still to run
  const restPreds: (AutoPred | null)[] = [];
  let unknown = false;
  for (const v of counted) {
    if (v.state === 'running') {
      if (v.live) restPreds.push(v.live);
      else unknown = true;
    } else if (v.state === 'pending' || v.state === 'interrupted' || v.state === 'failed') {
      if (v.pred) restPreds.push(v.pred);
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
  const [showJob, setShowJob] = useState(false);
  const jobEvents = byStage.get('job') ?? [];
  const totalIssues = events.filter((e) => e.level !== 'info').length;

  // the factory's own lifecycle (create → send → run → pull → delete) as a pseudo-stage on top
  const runner = job.runner;
  const factoryEvents = byStage.get('factory') ?? [];
  const showFactory = runner?.kind === 'factory' || factoryEvents.length > 0;
  const factoryState: AutoStageState = runner?.kind === 'factory' ? runnerStageState(runner) : factoryEvents.some((e) => e.level === 'error') ? 'failed' : 'done';
  const factoryFrac = runner?.kind === 'factory' ? RUNNER_PHASE[runner.state ?? '']?.frac ?? 0 : 1;
  const factoryElapsed = runner?.kind === 'factory' && runner.started
    ? (factoryState === 'running' ? now : runner.ended ?? now) - runner.started : null;
  const factoryUsd = runner?.kind === 'factory'
    ? factoryState === 'running' && factoryElapsed !== null ? (factoryElapsed / 3600) * (runner.price_hourly ?? 1) : runner.usd ?? 0
    : 0;

  const doneCount = views.filter((v) => v.state === 'done').length;
  const skippedCount = views.filter((v) => v.state === 'skipped').length;
  const failedView = ['failed', 'interrupted', 'cancelled'].includes(state)
    ? views.find((v) => v.state === 'failed' || v.state === 'interrupted')
    : undefined;
  // "final" only belongs on the list once it has been asked for
  const shown = views.filter((v) => !(v.id === 'final' && v.state === 'pending'));
  const finished = !live && !failedView;
  const pendingCount = shown.filter((v) => v.state === 'pending').length;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const isExpanded = expanded ?? !finished;
  const runningFactory = showFactory && factoryState === 'running';

  // ── waits are WAITS (Jake: "waiting for a server", never a made-up ETA) ──
  // queued: the worker holds it (no free 32-core, a cap, an account in use, the box busy);
  // copying the server image to another region; waiting for a logged-in account mid-dispatch
  const lastFactory = factoryEvents.length ? factoryEvents[factoryEvents.length - 1] : null;
  const thisRunFactory = runner?.kind === 'factory' && !!runStart && (runner.started ?? 0) >= runStart - 5;
  const waitText: string | null =
    state === 'queued'
      ? job.eta?.wait
        ? job.eta.wait.kind === 'box' ? `Waiting for the main box — ${job.eta.wait.reason}` : `Waiting for a server — ${job.eta.wait.reason}`
        : 'Waiting for a server'
      : state === 'running' && thisRunFactory && runner?.state === 'copying-image'
        ? `Waiting for a server — ${runner.note || 'copying the server image to another region'}`
        : state === 'running' && !running && lastFactory && /^waiting for the /.test(lastFactory.msg) && (!thisRunFactory || runner?.state === 'creating')
          ? `Waiting for a server — ${lastFactory.msg.replace(/^waiting for /, '')}`
          : null;
  // the factory's own time still to come: start-up → transfer → (stages) → pull + delete
  const ov = job.eta?.overhead ?? null;
  const ovRest: (AutoPred | null)[] = [];
  if (ov && state === 'running' && !waitText) {
    const rs = thisRunFactory ? runner?.state : 'creating';
    if (rs === 'creating') ovRest.push(blendLive(ov.startup, runner?.started && thisRunFactory ? Math.max(0, now - runner.started) : 0, null), ov.transfer, ov.wrapup);
    else if (rs === 'sending') ovRest.push(ov.transfer, ov.wrapup);
    else if (rs === 'running' || rs === 'pulling') ovRest.push(ov.wrapup);
  }
  const rest = waitText ? null : sumPreds([...restPreds, ...ovRest]);

  return (
    <div className="space-y-2.5 rounded-lg border border-border p-3">
      {/* summary: one line + the overall bar */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-medium text-foreground">
            {finished
              ? `${state === 'cancelled' ? 'Cancelled' : 'Done'} · ${doneCount} step${doneCount === 1 ? '' : 's'}${
                  skippedCount ? ` · ${skippedCount} skipped` : ''}${pendingCount && state === 'cancelled' ? ` · ${pendingCount} not run` : ''}`
              : state === 'queued'
                ? waitText ?? 'Waiting to start'
                : failedView
                  ? `Stopped at ${failedView.title}`
                  : `${Math.round(overall * 100)}%`}
            {running && <span className="font-normal text-muted-foreground"> · {running.title}</span>}
            {state === 'running' && waitText && <span className="font-normal text-amber-300"> · {waitText}</span>}
            {live && !waitText && job.eta?.firstRun && (
              <span className="font-normal text-amber-300/90"> · first run on this server size ({job.eta.machine.label}) — estimate</span>
            )}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-x-2 tabular-nums text-muted-foreground">
            {runElapsed !== null && (state === 'running' || finished) && <span>{dur(runElapsed)}</span>}
            {live && !waitText && rest && (
              <span title={job.eta ? `${job.eta.machine.label} · ${job.eta.runsOnMachine} earlier run${job.eta.runsOnMachine === 1 ? '' : 's'} on this size` : undefined}>
                ETA {unknown ? `≥ ${dur(rest.lo)}` : etaText(rest)}
              </span>
            )}
            {live && !waitText && !rest && unknown && <span>ETA after the first step</span>}
            <span className="text-emerald-400">{money(cost)}</span>
            <button type="button" onClick={() => setExpanded(!isExpanded)} className="text-primary hover:underline">
              {isExpanded ? 'Hide steps' : 'Show steps'}
            </button>
          </span>
        </div>
        {!finished && (
          <Bar frac={overall} state={state === 'failed' ? 'failed' : state === 'running' ? 'running' : overall >= 1 ? 'done' : 'pending'} />
        )}
        {(runner?.kind || job.request.run_on === 'factory' || job.request.run_on === 'box') &&
          (isExpanded || runningFactory) &&
          // the factory row below already tells the story — the badge stays for the box, and for a server not confirmed deleted
          (!showFactory || runner?.destroyed === false || (runner?.state === 'failed' && state === 'running')) && (
          <RunnerBadge runner={runner} runOn={job.request.run_on} jobState={state} now={now} />
        )}
      </div>

      {isExpanded && (
        <div className="space-y-px">
          {showFactory && (
            <StageRow
              id="factory"
              title={`Factory server${runner?.kind === 'factory' && runner.size ? ` ${runner.size}` : ''}`}
              state={factoryState}
              frac={factoryFrac}
              elapsed={factoryElapsed}
              eta={null}
              expect={null}
              cost={factoryUsd}
              warn={factoryEvents.filter((e) => e.level === 'warn').length}
              err={factoryEvents.filter((e) => e.level === 'error').length}
              label={runner?.kind === 'factory' ? RUNNER_PHASE[runner.state ?? '']?.text ?? runner.state : undefined}
              note={
                runner?.kind === 'factory' && (runner.state === 'done' || runner.state === 'failed')
                  ? runner.destroyed === false
                    ? 'DELETE NOT CONFIRMED — check DigitalOcean'
                    : `${runner.state === 'done' ? 'results back' : 'failed'} · server deleted${runner.droplet ? ` · droplet #${runner.droplet}` : ''}`
                  : 'create → send → run → pull → delete'
              }
              msg={runner?.kind === 'factory' ? `create → send → run → pull → delete · now: ${RUNNER_PHASE[runner.state ?? '']?.text ?? runner.state}` : null}
              events={factoryEvents}
              isOpen={open.has('factory')}
              onToggle={() => toggle('factory')}
            />
          )}
          {shown.map((v) => {
            const evs = byStage.get(v.id) ?? [];
            return (
              <StageRow
                key={v.id}
                id={v.id}
                title={v.title}
                state={v.state}
                frac={v.frac}
                elapsed={v.elapsed}
                eta={v.eta}
                etaGuess={v.etaGuess}
                expect={v.expect}
                livePred={v.live}
                pred={v.pred}
                cost={v.cost}
                warn={v.st?.warnings ?? evs.filter((e) => e.level === 'warn').length}
                err={v.st?.errors ?? evs.filter((e) => e.level === 'error').length}
                msg={v.st?.message ?? (v.state === 'failed' ? job.status.message : null)}
                note={v.st?.note}
                events={evs}
                isOpen={open.has(v.id)}
                onToggle={() => toggle(v.id)}
                onContinue={onContinue}
              />
            );
          })}
        </div>
      )}

      {(isExpanded || showAll || showJob) && !(state === 'queued' && events.length === 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[11px]">
          <button type="button" onClick={() => setShowAll(!showAll)} className="text-primary hover:underline">
            {showAll ? 'Hide the full log' : `Full log · ${events.length} lines${totalIssues ? ` · ${totalIssues} warnings/errors` : ''}`}
          </button>
          {jobEvents.length > 0 && (
            <button type="button" onClick={() => setShowJob(!showJob)} className="text-muted-foreground hover:text-foreground">
              {showJob ? 'Hide job events' : `Job events (claims, restarts, failures outside a stage) · ${jobEvents.length}`}
            </button>
          )}
          {logNote && <span className="text-[10.5px] text-muted-foreground">{logNote}</span>}
        </div>
      )}
      {showJob && <LogView events={jobEvents} maxH="max-h-48" />}
      {showAll && <LogView events={events} showStage maxH="max-h-[32rem]" />}
    </div>
  );
}
