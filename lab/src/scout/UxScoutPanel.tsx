/**
 * UX Scout — the Script Generator's button and live progress view.
 *
 * "Run UX Scout" queues a job; the runner on the server starts Claude Code
 * (Jake's Max plan) which uses the tool like a first-timer toward the goal and
 * writes the UX report. While it runs this panel shows, live: the status, the
 * elapsed time, how many steps it has taken, the browser's latest screenshot
 * and its log. When it finishes, the report is attached to this run and its key
 * screenshots are added to the run's screenshots (Stage 0.4 reads them too).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronRight, Compass, KeyRound, Loader2, Paperclip, Square, X } from 'lucide-react';
import type { ScreenshotRef } from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import ScoutLoginDialog from './ScoutLoginDialog';
import { attachToRun, cancelJob, createJob, getJob, listJobs, listTools, type ScoutEvent, type ScoutJobView, type ScoutTool } from './api';

interface Props {
  runId: string;
  /** Pre-fills the goal (the working title / core topic). */
  defaultGoal: string;
  /** Title + brief, handed to the Scout as context. */
  context: string;
  /** Called once when a Scout finishes: its key screenshots, to add to the run's screenshots. */
  onKeyShots: (shots: ScreenshotRef[]) => void;
  /** Sponsored run: pick the tool whose name matches the sponsor, when Jake has logged into it. */
  preferTool?: string;
  /** Lets the page hold the Write buttons while a Scout is running. */
  onActiveChange?: (active: boolean) => void;
  /** Whether a finished report is attached to this run (the script is built on it). */
  onReportChange?: (attached: boolean) => void;
  disabled?: boolean;
}

const ACTIVE = new Set(['queued', 'running']);

function elapsed(from: string | null, to?: string | null): string {
  if (!from) return '';
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const readFile = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

export default function UxScoutPanel({ runId, defaultGoal, context, onKeyShots, onActiveChange, onReportChange, disabled, preferTool }: Props) {
  const [tools, setTools] = useState<ScoutTool[]>([]);
  const [toolSlug, setToolSlug] = useState('');
  const [goal, setGoal] = useState(defaultGoal);
  const [files, setFiles] = useState<File[]>([]);
  const [view, setView] = useState<ScoutJobView | null>(null);
  const [events, setEvents] = useState<ScoutEvent[]>([]);
  const [starting, setStarting] = useState(false);
  const [loginsOpen, setLoginsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [, tick] = useState(0);
  const lastSeq = useRef(0);
  const deliveredFor = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const job = view?.job ?? null;
  const active = !!job && ACTIVE.has(job.status);

  useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);
  const reportReady = job?.status === 'done';
  useEffect(() => { onReportChange?.(reportReady); }, [reportReady, onReportChange]);

  const loadTools = useCallback(async () => {
    try {
      const r = await listTools();
      setTools(r.tools);
      if (!toolSlug && r.tools.length) {
        const want = (preferTool ?? '').toLowerCase().trim();
        const sponsorTool = want ? r.tools.find((t) => t.name.toLowerCase().includes(want) || want.includes(t.name.toLowerCase())) : undefined;
        setToolSlug((sponsorTool ?? r.tools.find((t) => t.loggedInAt) ?? r.tools[0]).slug);
      }
    }
    catch { /* panel still usable after the dialog */ }
  }, [toolSlug]);

  // The latest Scout of this run, so a reload resumes the live view.
  useEffect(() => {
    void loadTools();
    listJobs(runId).then((r) => { const j = r.jobs[0]; if (j) void open(j.id); }).catch(() => {});
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id: string) => {
    lastSeq.current = 0;
    const v = await getJob(id);
    setView(v);
    setEvents(v.events);
    lastSeq.current = v.events[v.events.length - 1]?.seq ?? 0;
  };

  // Live polling while it runs (and a 1s clock for the timer).
  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    const poll = setInterval(async () => {
      try {
        const v = await getJob(job.id, lastSeq.current);
        if (v.events.length) { lastSeq.current = v.events[v.events.length - 1].seq; setEvents((prev) => [...prev, ...v.events].slice(-600)); }
        setView((prev) => (prev ? { ...v, events: [] } : v));
      } catch { /* keep polling */ }
    }, 3000);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [events.length]);

  // Done: hand the key screenshots to the run once.
  useEffect(() => {
    if (job?.status !== 'done' || deliveredFor.current === job.id) return;
    deliveredFor.current = job.id;
    const refs = job.keyShots.map((k) => k.ref).filter((r): r is ScreenshotRef => !!r);
    if (refs.length) onKeyShots(refs);
  }, [job?.status, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!toolSlug) { toast.error('Pick a tool (log in to it first)'); return; }
    setStarting(true);
    try {
      const assets = await Promise.all(files.map(async (f) => ({ name: f.name, dataBase64: await readFile(f) })));
      const v = await createJob({ toolSlug, goal: goal.trim(), context, runId, assets });
      deliveredFor.current = null;
      setView(v); setEvents(v.events); lastSeq.current = v.events[v.events.length - 1]?.seq ?? 0; setFiles([]);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start the Scout'); }
    finally { setStarting(false); }
  };

  const stop = async () => {
    if (!job) return;
    try { const r = await cancelJob(job.id); setView((v) => (v ? { ...v, job: { ...v.job, ...r.job } } : v)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not stop it'); }
  };

  const detach = async () => {
    if (!job) return;
    try { await attachToRun(runId, null); toast.success('Report removed from this script'); setView(null); setEvents([]); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not remove it'); }
  };

  const shownLog = useMemo(() => events.filter((e) => e.kind !== 'shot'), [events]);
  const tool = tools.find((t) => t.slug === toolSlug) ?? null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-2">
        <Compass className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">UX Scout</p>
          <p className="text-[11px] text-muted-foreground">
            Uses the tool for real, like a first-timer, all the way to a finished result — then writes the easiest path, every friction point and the plain-English way to explain it. The script is built on that. Runs on Claude Code with your Max plan; spends whatever credits the tool needs, never buys anything.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setLoginsOpen(true)}><KeyRound className="mr-1 h-3.5 w-3.5" /> Tool logins</Button>
      </div>

      {(!job || job.status === 'failed' || job.status === 'cancelled') && (
        <div className="space-y-2">
          {job && (
            <p className="flex items-start gap-1.5 text-xs text-destructive"><X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {job.status === 'cancelled' ? 'The last Scout was stopped.' : `The last Scout failed: ${job.error ?? 'unknown error'}`}</p>
          )}
          <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
            <div className="space-y-1">
              <Label className="text-xs">Tool</Label>
              <select value={toolSlug} onChange={(e) => setToolSlug(e.target.value)} disabled={disabled}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                {tools.length === 0 && <option value="">— add a tool first —</option>}
                {tools.map((t) => <option key={t.slug} value={t.slug}>{t.name}{t.loggedInAt ? '' : ' (not logged in)'}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Goal — what should an everyday person make with it in this video?</Label>
              <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} disabled={disabled} placeholder="Make a 30-second product ad from one product photo" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground', disabled && 'pointer-events-none opacity-50')}>
              <Paperclip className="h-3.5 w-3.5" /> {files.length ? `${files.length} file${files.length > 1 ? 's' : ''} for it to use` : 'Files it may need (a product photo, a logo…)'}
              <input type="file" multiple className="hidden" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} />
            </label>
            {tool && !tool.loggedInAt && <span className="text-[11px] text-[hsl(var(--chart-4))]">Log in to {tool.name} first (Tool logins).</span>}
            <Button size="sm" className="ml-auto" onClick={() => void start()} disabled={disabled || starting || !toolSlug || goal.trim().length < 8}>
              {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Compass className="mr-1 h-3.5 w-3.5" />} Run UX Scout
            </Button>
          </div>
        </div>
      )}

      {job && active && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {job.status === 'queued' ? 'Waiting for the runner…' : job.cancelRequested ? 'Stopping…' : `Using ${view?.tool?.name ?? 'the tool'}`}</span>
            {job.startedAt && <span className="text-muted-foreground">{elapsed(job.startedAt)}</span>}
            <span className="text-muted-foreground">{view?.steps ?? 0} steps</span>
            <span className="text-muted-foreground">{job.keyShots.length} key shots</span>
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void stop()} disabled={job.cancelRequested}><Square className="mr-1 h-3 w-3" /> Stop</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Goal: {job.goal}</p>
          <div className="grid gap-2 lg:grid-cols-[3fr_2fr]">
            <div className="overflow-hidden rounded-md border border-border bg-black">
              {view?.latestShotUrl
                ? <img src={view.latestShotUrl} alt="What the Scout sees now" className="block w-full" />
                : <div className="flex aspect-[1280/900] items-center justify-center text-xs text-muted-foreground">The browser’s view appears here</div>}
            </div>
            <div ref={logRef} className="max-h-[360px] space-y-1 overflow-y-auto rounded-md border border-border p-2 text-[11px]">
              {shownLog.map((e) => (
                <p key={e.seq} className={cn(
                  e.kind === 'note' && 'text-foreground',
                  e.kind === 'action' && 'text-muted-foreground',
                  e.kind === 'error' && 'text-destructive',
                  e.kind === 'status' && 'font-medium text-primary',
                  e.kind === 'key_shot' && 'text-emerald-500',
                )}>
                  <span className="mr-1.5 tabular-nums text-muted-foreground/70">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  {e.kind === 'key_shot' ? `★ ${e.text}` : e.text}
                </p>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">You can leave this page — the Scout keeps going and this view picks up where it is. Writing the script waits until it finishes (or Stop it).</p>
        </div>
      )}

      {job?.status === 'done' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-500"><Check className="h-3.5 w-3.5" /> Report ready and attached to this script</span>
            <span className="text-muted-foreground">{view?.tool?.name} · {elapsed(job.startedAt, job.finishedAt)} · {view?.steps ?? 0} steps · {job.keyShots.length} key shots added to the screenshots</span>
            <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => void detach()}>Don’t use it</Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => { setView(null); setEvents([]); }}>Run again</Button>
          </div>
          {job.summary && <p className="text-xs text-foreground">{job.summary}</p>}
          {job.keyShots.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {job.keyShots.map((k, i) => (
                <a key={k.file} href={k.url ?? '#'} target="_blank" rel="noreferrer" className="w-40 shrink-0" title={k.caption}>
                  {k.url && <img src={k.url} alt={k.caption} className="w-40 rounded border border-border" />}
                  <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">K{i + 1} · {k.caption}</p>
                </a>
              ))}
            </div>
          )}
          <button onClick={() => setReportOpen((o) => !o)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {reportOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Read the full report
          </button>
          {reportOpen && <pre className="max-h-[480px] overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-sans text-xs leading-relaxed text-foreground">{job.report}</pre>}
        </div>
      )}

      <ScoutLoginDialog open={loginsOpen} onOpenChange={(o) => { setLoginsOpen(o); if (!o) void loadTools(); }} onToolsChanged={setTools} initialSlug={null} />
    </div>
  );
}
