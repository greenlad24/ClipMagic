import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Trash2,
  Play,
  Ban,
  RotateCcw,
  CheckCircle2,
  Circle,
  AlertTriangle,
  Clock,
  Sparkles,
  FileText,
  Clapperboard,
  Film,
  ShieldCheck,
  ExternalLink,
  Hourglass,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  hfpEditorStatus,
  hfpEditorRuns,
  hfpEditorRun,
  hfpEditorArtifact,
  hfpEditorCreate,
  hfpEditorSettings,
  hfpEditorContinue,
  hfpEditorAskModel,
  hfpEditorApproveRender,
  hfpEditorCancel,
  hfpEditorDelete,
  hfpEditorSubmitAnswer,
  hfpEditorDiscardAnswer,
  hfpEditorChooseComposition,
  hfpEditorHandoffTasks,
  hfpEditorAttest,
  type HfpRunSummary,
  type HfpRunDetail,
  type HfpStage,
  type HfpPending,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';

/**
 * The Video Editor — the JakeDawson Hyperframes skill, run as software.
 *
 * One Descript share link goes in; the pipeline (`hfp`, on the host) walks the
 * skill's twenty stages in order and stops wherever it needs a person: an
 * editorial answer, a screencast brief, the render approval, the review with
 * sound. This page shows where a run is and asks for exactly that.
 *
 * ⚠️ THE PAGE DOES NOT RUN ANYTHING. It writes requests the hfp-worker service
 * picks up, and it polls files — so leaving it open costs nothing, and closing
 * it stops nothing.
 *
 * ⚠️ THE RENDER GATE IS NOT THIS PAGE'S TO KEEP. The worker stops every run
 * after S11 until "Approve render" sets the flag — unless the edit runs
 * unattended, the default since Jake asked for no human intervention.
 */

function ago(tsSeconds: number | null | undefined): string {
  if (!tsSeconds) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - tsSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function mmss(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Static classes only — Tailwind has no safelist here.
const STAGE_ICON: Record<HfpStage['status'], { icon: typeof Circle; cls: string; label: string }> = {
  pending: { icon: Circle, cls: 'text-muted-foreground/50', label: 'Not run' },
  running: { icon: Loader2, cls: 'text-blue-400 animate-spin', label: 'Running' },
  done: { icon: CheckCircle2, cls: 'text-green-400', label: 'Done' },
  cached: { icon: CheckCircle2, cls: 'text-green-400/70', label: 'Done (reused)' },
  awaiting: { icon: Hourglass, cls: 'text-amber-400', label: 'Needs you' },
  blocked: { icon: AlertTriangle, cls: 'text-red-400', label: 'Stopped' },
};

function runBadge(run: HfpRunSummary): { text: string; cls: string } {
  if (run.worker === 'running') return { text: 'Running', cls: 'bg-blue-500/15 text-blue-400' };
  if (run.worker === 'queued') return { text: 'Queued', cls: 'bg-muted text-muted-foreground' };
  switch (run.waitingFor) {
    case 'model-answer':
    case 'composition':
    case 'handoff-tasks':
    case 'attestation':
      return { text: 'Needs you', cls: 'bg-amber-500/15 text-amber-400' };
    case 'render-approval':
      return { text: 'Ready to render', cls: 'bg-purple-500/15 text-purple-400' };
    case 'rendering':
      return { text: 'Rendering', cls: 'bg-blue-500/15 text-blue-400' };
    case 'rejected-answer':
    case 'blocked':
    case 'generations':
      return { text: 'Stopped', cls: 'bg-red-500/15 text-red-400' };
    case 'interrupted':
      return { text: 'Interrupted', cls: 'bg-amber-500/15 text-amber-400' };
  }
  if (run.outcome === 'complete' && run.doneStages === 20) {
    return { text: 'Delivered', cls: 'bg-green-500/15 text-green-400' };
  }
  return { text: run.outcome ?? 'New', cls: 'bg-muted text-muted-foreground' };
}

/* ─────────────────────────────── page ─────────────────────────────── */

export default function VideoEditorPage() {
  const { id: selected } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<HfpRunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([hfpEditorRuns({}), hfpEditorStatus({})]);
      setRuns(r.runs);
      setWorkerAlive(s.workerAlive);
      setLoaded(true);
    } catch (err) {
      console.error('[video editor] refresh failed', err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="sm" className="gap-1.5">
                <ArrowLeft className="h-4 w-4" />
                Tools
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Video Editor</h1>
              <p className="text-xs text-muted-foreground">
                Your Hyperframes editing skill, stage by stage — from a Descript link to a finished 4K render.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'text-xs',
                workerAlive === null ? 'text-muted-foreground' : workerAlive ? 'text-green-400' : 'text-red-400',
              )}
            >
              {workerAlive === null ? 'Worker …' : workerAlive ? '● Worker running' : '● Worker not responding'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void refresh()} className="gap-1.5">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-4">
            <NewEdit
              onCreated={(run) => {
                void refresh();
                navigate(`/video-editor/${run.id}`);
              }}
            />
            <div className="rounded-lg border border-border">
              <div className="border-b border-border px-3 py-2.5">
                <h2 className="text-sm font-medium text-foreground">Edits</h2>
              </div>
              {!loaded ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>
              ) : runs.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">No edits yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {runs.map((run) => {
                    const b = runBadge(run);
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => navigate(`/video-editor/${run.id}`)}
                        className={cn(
                          'block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
                          selected === run.id && 'bg-muted/60',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm text-foreground">{run.name}</span>
                          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', b.cls)}>
                            {b.text}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {run.doneStages}/20 stages · {mmss(run.durationSeconds)} · {ago(run.createdAt)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0">
            {selected ? (
              <RunDetail key={selected} id={selected} onChanged={refresh} onDeleted={() => {
                void refresh();
                navigate('/video-editor');
              }} />
            ) : (
              <HowItWorks />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── new edit ─────────────────────────────── */

function NewEdit({ onCreated }: { onCreated: (run: HfpRunSummary) => void }) {
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [cadence, setCadence] = useState('30');
  const [auto, setAuto] = useState(true);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const { run } = await hfpEditorCreate({
        name: name.trim() || 'Untitled edit',
        link: link.trim(),
        cadence: cadence.trim(),
        editorialMode: auto || live ? 'live' : 'offline',
        unattended: auto,
      });
      toast.success(`Started “${run.name}”`, {
        description: auto
          ? 'Runs start to finish on its own: plan, briefs, render and an automated review.'
          : 'Reading the Descript link, then the pipeline stops at the first editorial question.',
      });
      setName('');
      setLink('');
      onCreated(run);
    } catch (err) {
      toast.error('Could not start the edit', { description: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <h2 className="mb-2 text-sm font-medium text-foreground">New edit</h2>
      <div className="space-y-2">
        <Input placeholder="Name (e.g. Claude Skills tutorial)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          placeholder="https://share.descript.com/view/…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="hfp-cadence">
            Frame rate
          </label>
          <Input
            id="hfp-cadence"
            className="h-8 w-28"
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            title='The Descript page does not say. "30" or "30000/1001".'
          />
        </div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-foreground">Run everything automatically</p>
            <p className="text-[11px] text-muted-foreground">
              GPT-6 Astra plans and fixes its own rejected answers, writes the screencast briefs,
              and the render starts once preflight passes. The final review is automated and
              labelled as such.
            </p>
          </div>
          <Switch checked={auto} onCheckedChange={setAuto} />
        </div>
        {!auto && (
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-foreground">Ask GPT-6 Astra automatically</p>
              <p className="text-[11px] text-muted-foreground">
                Off: the run stops before each paid editorial call so you see the cost first.
              </p>
            </div>
            <Switch checked={live} onCheckedChange={setLive} />
          </div>
        )}
        <Button className="w-full gap-1.5" disabled={busy || !link.trim()} onClick={() => void start()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Start edit
        </Button>
        <p className="text-[11px] text-muted-foreground">
          The link must be a <em>published</em> Descript composition — its share page holds the word-level
          timings. A full 15-minute 4K render takes about 15 hours.
        </p>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps: [string, string][] = [
    ['Intake', 'Reads the Descript share page: the video, its length and every word with its measured timing.'],
    ['Editorial', 'GPT-6 Astra corrects misheard words, then chooses an approved template for each beat. Every answer is validated; a failing one is rejected, never patched.'],
    ['Build', 'Stock footage, 4K conform, screencast briefs, template instantiation, assembly and preflight.'],
    ['Render', 'Only after you approve: the project goes to the Render queue through its API and is checked once an hour.'],
    ['Review', 'Technical QA, then you watch it with sound and sign off every cue. It cannot pass itself.'],
    ['Deliver', 'Packaged into the project hub with its cost ledger.'],
  ];
  return (
    <div className="rounded-lg border border-border p-5">
      <div className="mb-3 flex items-center gap-2">
        <Clapperboard className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">How a run works</h2>
      </div>
      <ol className="space-y-3">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
              {i + 1}
            </span>
            <div>
              <p className="text-sm text-foreground">{title}</p>
              <p className="text-xs text-muted-foreground">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        Start an edit on the left, or open one from the list.
      </p>
    </div>
  );
}

/* ─────────────────────────────── run detail ─────────────────────────────── */

function RunDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [detail, setDetail] = useState<HfpRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const pull = useCallback(async () => {
    try {
      const d = await hfpEditorRun({ id, logBytes: 30000 });
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [id]);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 3000);
    return () => clearInterval(t);
  }, [pull]);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [detail?.log, showLog]);

  const act = async (key: string, what: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await pull();
      onChanged();
    } catch (err) {
      toast.error(`${what} failed`, { description: errText(err) });
    } finally {
      setBusy(null);
    }
  };

  const openArtifact = async (path: string) => {
    try {
      const a = await hfpEditorArtifact({ id, path });
      let text = a.text;
      if (path.endsWith('.json') && !a.truncated) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* show as-is */
        }
      }
      setViewing({ path, text, truncated: a.truncated });
    } catch (err) {
      toast.error('Could not open the file', { description: errText(err) });
    }
  };

  if (error && !detail) {
    return <p className="rounded-lg border border-border p-6 text-sm text-red-400">{error}</p>;
  }
  if (!detail) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border p-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { run, request, share, stages, pending, worker } = detail;
  const working = run.worker === 'running' || run.worker === 'queued';
  const b = runBadge(run);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-foreground">{run.name}</h2>
              <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', b.cls)}>{b.text}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {share?.title ? `${share.title} · ` : ''}
              {mmss(share?.duration_seconds)} · {share?.width && share?.height ? `${share.width}×${share.height} · ` : ''}
              {share?.word_count ? `${share.word_count.toLocaleString()} words · ` : ''}
              {request.cadence} fps ·{' '}
              <a href={request.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline hover:text-foreground">
                Descript <ExternalLink className="h-3 w-3" />
              </a>
            </p>
            {working && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-blue-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                {run.worker === 'queued' ? 'Waiting for the worker…' : `Working — ${worker?.action?.reason ?? 'running'}, started ${ago(worker?.started_at)}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {working ? (
              <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy === 'cancel'}
                onClick={() => void act('cancel', 'Cancel', () => hfpEditorCancel({ id }), 'Stopping')}>
                <Ban className="h-4 w-4" /> Cancel
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="gap-1.5" disabled={!!busy}
                onClick={() => void act('continue', 'Continue', () => hfpEditorContinue({ id }), 'Continuing')}>
                <Play className="h-4 w-4" /> Continue
              </Button>
            )}
            <Button variant="ghost" size="sm" className="gap-1.5" disabled={working || !!busy}
              title="Re-read the Descript share page (after you re-publish)"
              onClick={() => void act('refresh', 'Refresh from Descript', () => hfpEditorContinue({ id, refreshShare: true }), 'Re-reading Descript')}>
              <RotateCcw className="h-4 w-4" /> Re-read Descript
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5 text-red-400 hover:text-red-300" disabled={working || !!busy}
              onClick={() => {
                if (!window.confirm(`Delete “${run.name}” and all its plans and downloads? A render already in the Render queue stays there.`)) return;
                void act('delete', 'Delete', () => hfpEditorDelete({ id })).then(onDeleted);
              }}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Astra answers, briefs, render and an automated review, with nobody stepping in">
            <Switch
              checked={!!request.unattended}
              disabled={run.worker === 'running'}
              onCheckedChange={(v) => void act('auto', 'Change setting', () => hfpEditorSettings({ id, unattended: v }))}
            />
            Run everything automatically
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={request.editorial_mode === 'live'}
              disabled={run.worker === 'running'}
              onCheckedChange={(v) => void act('mode', 'Change setting', () => hfpEditorSettings({ id, editorialMode: v ? 'live' : 'offline' }))}
            />
            Ask GPT-6 Astra automatically
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Prompts over 272k tokens are billed at 2× input / 1.5× output for the whole request.">
            <Switch
              checked={request.accept_long_context_reprice}
              disabled={run.worker === 'running'}
              onCheckedChange={(v) => void act('reprice', 'Change setting', () => hfpEditorSettings({ id, acceptLongContextReprice: v }))}
            />
            Allow long-context pricing
          </label>
          <span className={cn('text-xs', request.render_approved || request.unattended ? 'text-purple-400' : 'text-muted-foreground')}>
            {request.unattended
              ? 'Renders automatically once preflight passes'
              : request.render_approved ? `Render approved ${ago(request.render_approved_at)}` : 'Render not approved — stops after preflight'}
          </span>
        </div>
      </div>

      {/* what it needs */}
      {pending && !working && (
        <PendingPanel id={id} pending={pending} busy={busy} act={act} openArtifact={openArtifact} />
      )}

      {detail.crashTraceback && !working && (
        <details className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <summary className="cursor-pointer text-xs text-red-400">A stage crashed — this is a bug in the pipeline, not in your edit. Show the traceback.</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{detail.crashTraceback}</pre>
        </details>
      )}

      {/* stages */}
      <StageList
        stages={stages}
        disabled={working || !!busy}
        onRerun={(sid) =>
          void act(`rerun-${sid}`, `Re-run ${sid}`, () => hfpEditorContinue({ id, force: [sid] }), `Re-running ${sid}`)
        }
      />

      {/* files */}
      <div className="rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">Files</h3>
          <span className="text-xs text-muted-foreground">plans, requests and outputs this run has written</span>
        </div>
        {detail.artifacts.length === 0 ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">Nothing written yet.</p>
        ) : (
          <div className="grid gap-x-4 px-4 py-2 sm:grid-cols-2">
            {detail.artifacts.map((a) => {
              const media = /\.(mp4|mov|wav|mp3|png|jpg)$/i.test(a.path);
              return (
                <div key={a.path} className="flex items-center justify-between gap-2 py-1 text-xs">
                  {media ? (
                    <a href={`/api/hfp-editor/files/${id}/${a.path}`} target="_blank" rel="noreferrer" className="truncate font-mono text-foreground underline-offset-2 hover:underline">
                      {a.path}
                    </a>
                  ) : (
                    <button type="button" onClick={() => void openArtifact(a.path)} className="truncate text-left font-mono text-foreground underline-offset-2 hover:underline">
                      {a.path}
                    </button>
                  )}
                  <span className="shrink-0 text-muted-foreground">{human(a.bytes)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* log */}
      <div className="rounded-lg border border-border">
        <button type="button" onClick={() => setShowLog((v) => !v)} className="flex w-full items-center justify-between px-4 py-2.5 text-left">
          <span className="text-sm font-medium text-foreground">Log</span>
          <span className="text-xs text-muted-foreground">{showLog ? 'Hide' : 'Show'}</span>
        </button>
        {showLog && (
          <pre ref={logRef} className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border bg-muted/20 px-4 py-3 font-mono text-[11px] text-muted-foreground">
            {detail.log || 'No output yet.'}
          </pre>
        )}
      </div>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{viewing?.path}</DialogTitle>
            {viewing?.truncated && <DialogDescription>Showing the first 2 MB.</DialogDescription>}
          </DialogHeader>
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-3 font-mono text-[11px] text-foreground">
            {viewing?.text}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StageList({ stages, disabled, onRerun }: {
  stages: HfpStage[]; disabled: boolean; onRerun: (sid: string) => void;
}) {
  const phases = useMemo(() => {
    const out: { phase: string; stages: HfpStage[] }[] = [];
    for (const s of stages) {
      const last = out[out.length - 1];
      if (last && last.phase === s.phase) last.stages.push(s);
      else out.push({ phase: s.phase, stages: [s] });
    }
    return out;
  }, [stages]);

  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-medium text-foreground">Stages</h3>
      </div>
      <div className="divide-y divide-border">
        {phases.map((p) => (
          <div key={p.phase} className="px-4 py-2">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{p.phase}</p>
            {p.stages.map((s) => {
              const st = STAGE_ICON[s.status];
              const Icon = st.icon;
              const detailText = s.reason || s.note;
              return (
                <div key={s.id} className="group flex items-start gap-2 py-1">
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', st.cls)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">{s.id}</span>
                      <span className="text-sm text-foreground">{s.title}</span>
                      {s.klass === 'model' && (
                        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground" title="A thinking model's call">AI</span>
                      )}
                      <span className="text-[11px] text-muted-foreground">{st.label}</span>
                    </div>
                    {detailText && (
                      <p className={cn('text-xs', s.reason ? 'text-red-400/90' : 'text-muted-foreground')}>{detailText}</p>
                    )}
                  </div>
                  {(s.status === 'done' || s.status === 'cached' || s.status === 'blocked') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] opacity-0 group-hover:opacity-100"
                      disabled={disabled}
                      title="Run this stage again even though it has a result (later stages follow)"
                      onClick={() => onRerun(s.id)}
                    >
                      Re-run
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── pending actions ─────────────────────────────── */

type Act = (key: string, what: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function PendingPanel({ id, pending, busy, act, openArtifact }: {
  id: string; pending: HfpPending; busy: string | null; act: Act; openArtifact: (p: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [tasks, setTasks] = useState('');
  const tone =
    pending.kind === 'blocked' || pending.kind === 'rejected-answer' || pending.kind === 'generations'
      ? 'border-red-500/30 bg-red-500/5'
      : pending.kind === 'render-approval'
        ? 'border-purple-500/30 bg-purple-500/5'
        : pending.kind === 'rendering'
          ? 'border-blue-500/30 bg-blue-500/5'
          : 'border-amber-500/30 bg-amber-500/5';

  const header = {
    'model-answer': `${pending.stage} is waiting for its editorial answer`,
    'rejected-answer': `${pending.stage}'s answer was rejected`,
    composition: 'Which composition?',
    'handoff-tasks': 'Screencast briefs needed',
    generations: 'Stock footage generation',
    attestation: 'Review the render with sound',
    'render-approval': 'Ready to render',
    rendering: 'Rendering',
    blocked: `${pending.stage ?? 'The run'} stopped`,
    interrupted: 'Interrupted',
  }[pending.kind];

  return (
    <div className={cn('rounded-lg border p-4', tone)}>
      <p className="text-sm font-medium text-foreground">{header}</p>
      <p className="mt-1 text-xs text-muted-foreground">{pending.message}</p>

      {pending.kind === 'model-answer' && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="gap-1.5" disabled={!!busy}
              onClick={() => void act('ask', 'Ask Astra', () => hfpEditorAskModel({ id }), 'Asking GPT-6 Astra')}>
              <Sparkles className="h-4 w-4" />
              Ask GPT-6 Astra{pending.estimateUsd != null ? ` (~$${pending.estimateUsd.toFixed(2)})` : ''}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {pending.inputTokens ? `${pending.inputTokens.toLocaleString()} input tokens, estimated. ` : ''}
              This turns on automatic asking for this edit.
            </span>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void openArtifact(`model/${pending.stage}-request.json`)}>
              <FileText className="h-4 w-4" /> See the question
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">…or paste an answer (JSON)</summary>
            <Textarea className="mt-2 min-h-40 font-mono text-[11px]" placeholder='{"corrections": [], …}' value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <Button size="sm" variant="secondary" className="mt-2" disabled={!!busy || !answer.trim()}
              onClick={() => void act('answer', 'Submit answer', () => hfpEditorSubmitAnswer({ id, stage: pending.stage!, content: answer }), 'Answer saved — validating')}>
              Submit answer
            </Button>
          </details>
        </div>
      )}

      {pending.kind === 'rejected-answer' && (
        <div className="mt-3 space-y-2">
          <ul className="max-h-64 space-y-1 overflow-auto">
            {(pending.findings ?? []).map((f, i) => (
              <li key={i} className="text-xs">
                <span className={cn('mr-1.5 font-mono', f.severity === 'error' ? 'text-red-400' : 'text-amber-400')}>{f.code}</span>
                <span className="text-muted-foreground">{f.message}</span>
                {f.where && <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">{f.where}</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy}
              onClick={() => void act('discard', 'Discard answer', () => hfpEditorDiscardAnswer({ id, stage: pending.stage! }), 'Discarded — the stage will ask again')}>
              Discard this answer
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void openArtifact(`model/${pending.stage}-answer.json`)}>See the answer</Button>
          </div>
        </div>
      )}

      {pending.kind === 'composition' && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(pending.candidates ?? []).map((c) => (
            <Button key={c.id} size="sm" variant="secondary" disabled={!!busy}
              onClick={() => void act('comp', 'Choose composition', () => hfpEditorChooseComposition({ id, compositionId: c.id }))}>
              {c.name ?? c.id} {c.duration_seconds ? `(${mmss(c.duration_seconds)})` : ''}
            </Button>
          ))}
        </div>
      )}

      {pending.kind === 'handoff-tasks' && (
        <div className="mt-3 space-y-2">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void openArtifact('requests/S8-clip-tasks.json')}>
            <FileText className="h-4 w-4" /> See which sections need a brief
          </Button>
          <Textarea className="min-h-40 font-mono text-[11px]" placeholder='{"SC001": {"short_action": "…", "task": "…", …}}' value={tasks} onChange={(e) => setTasks(e.target.value)} />
          <Button size="sm" variant="secondary" disabled={!!busy || !tasks.trim()}
            onClick={() => void act('tasks', 'Save briefs', () => hfpEditorHandoffTasks({ id, json: tasks }), 'Briefs saved')}>
            Save briefs and continue
          </Button>
        </div>
      )}

      {pending.kind === 'generations' && (
        <div className="mt-3">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void openArtifact('requests/S6-generations.json')}>
            <FileText className="h-4 w-4" /> See the prepared requests
            {pending.estimateUsd != null ? ` (~$${pending.estimateUsd.toFixed(2)})` : ''}
          </Button>
        </div>
      )}

      {pending.kind === 'render-approval' && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" className="gap-1.5" disabled={!!busy}
            onClick={() => {
              const hours = pending.framesEstimate ? (pending.framesEstimate * 2) / 3600 : null;
              if (!window.confirm(
                `Send this edit to the Render queue?\n\n${pending.framesEstimate?.toLocaleString() ?? '?'} frames at 4K` +
                (hours ? ` — roughly ${hours.toFixed(1)} hours at ~2s/frame.` : '.') +
                '\n\nThe render server is busy for that long.',
              )) return;
              void act('approve', 'Approve render', () => hfpEditorApproveRender({ id }), 'Render approved — submitting');
            }}>
            <Film className="h-4 w-4" /> Approve render
          </Button>
          <span className="text-xs text-muted-foreground">
            {mmss(pending.durationSeconds)} · {pending.framesEstimate?.toLocaleString() ?? '?'} frames
            {pending.preflightVerdict ? ` · preflight ${pending.preflightVerdict}` : ''}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void openArtifact('preflight.json')}>Preflight report</Button>
        </div>
      )}

      {pending.kind === 'rendering' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link to="/render-queue">
            <Button size="sm" variant="secondary" className="gap-1.5"><Film className="h-4 w-4" /> Open Render queue</Button>
          </Link>
          <Button size="sm" variant="ghost" className="gap-1.5" disabled={!!busy}
            onClick={() => void act('check', 'Check now', () => hfpEditorContinue({ id, statusRequest: true }), 'Checking')}>
            <Clock className="h-4 w-4" /> Check now
          </Button>
          {pending.nextCheckAt && (
            <span className="text-xs text-muted-foreground">
              next automatic check {new Date(pending.nextCheckAt * 1000).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {pending.kind === 'attestation' && <Attestation id={id} pending={pending} busy={busy} act={act} />}

      {(pending.kind === 'blocked' || pending.kind === 'interrupted') && pending.stage && (
        <div className="mt-3">
          <Button size="sm" variant="secondary" className="gap-1.5" disabled={!!busy}
            onClick={() => void act('retry', 'Try again', () => hfpEditorContinue({ id }), 'Trying again')}>
            <RotateCcw className="h-4 w-4" /> Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function Attestation({ id, pending, busy, act }: { id: string; pending: HfpPending; busy: string | null; act: Act }) {
  const cueIds = Object.keys(pending.attestation?.cues ?? {});
  const checks = Object.keys(pending.attestation?.subjective_checks ?? {});
  const [reviewer, setReviewer] = useState('');
  const [sound, setSound] = useState(false);
  const [rows, setRows] = useState<Record<string, { verdict: string; note: string }>>({});
  const [checkRows, setCheckRows] = useState<Record<string, { verdict: string; note: string }>>({});

  const all = [...cueIds.map((c) => rows[c]), ...checks.map((c) => checkRows[c])];
  const complete = all.every((r) => r && (r.verdict === 'pass' || r.verdict === 'fail'));
  const anyFail = all.some((r) => r?.verdict === 'fail');

  const verdictButtons = (
    value: string | undefined,
    set: (v: string) => void,
  ) => (
    <div className="flex gap-1">
      {(['pass', 'fail'] as const).map((v) => (
        <button key={v} type="button" onClick={() => set(v)}
          className={cn('rounded px-2 py-0.5 text-[11px]', value === v
            ? v === 'pass' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
            : 'bg-muted text-muted-foreground')}>
          {v}
        </button>
      ))}
    </div>
  );

  const submit = (verdict: 'pass' | 'fail') =>
    act('attest', 'Sign off', () => hfpEditorAttest({
      id,
      attestation: { reviewer, watched_with_sound: sound, cues: rows, subjective_checks: checkRows, verdict },
    }), verdict === 'pass' ? 'Signed off' : 'Recorded as failed');

  return (
    <div className="mt-3 space-y-3">
      {pending.videoUrl && (
        <video src={pending.videoUrl} controls className="w-full rounded border border-border bg-black" />
      )}
      <p className="font-mono text-[10px] text-muted-foreground">render sha256 {pending.renderSha256}</p>
      <div className="max-h-80 space-y-1 overflow-auto rounded border border-border p-2">
        {cueIds.map((c) => (
          <div key={c} className="flex items-center gap-2">
            <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{c}</span>
            {verdictButtons(rows[c]?.verdict, (v) => setRows((r) => ({ ...r, [c]: { verdict: v, note: r[c]?.note ?? '' } })))}
            <Input className="h-7 text-xs" placeholder="note" value={rows[c]?.note ?? ''}
              onChange={(e) => setRows((r) => ({ ...r, [c]: { verdict: r[c]?.verdict ?? '', note: e.target.value } }))} />
          </div>
        ))}
        {checks.map((c) => (
          <div key={c} className="flex items-center gap-2">
            <span className="w-40 shrink-0 text-[11px] text-muted-foreground">{c}</span>
            {verdictButtons(checkRows[c]?.verdict, (v) => setCheckRows((r) => ({ ...r, [c]: { verdict: v, note: r[c]?.note ?? '' } })))}
            <Input className="h-7 text-xs" placeholder="note" value={checkRows[c]?.note ?? ''}
              onChange={(e) => setCheckRows((r) => ({ ...r, [c]: { verdict: r[c]?.verdict ?? '', note: e.target.value } }))} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input className="h-8 w-48" placeholder="Your name" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={sound} onCheckedChange={setSound} /> I watched it with sound
        </label>
        <Button size="sm" className="gap-1.5" disabled={!!busy || !complete || anyFail || !reviewer.trim() || !sound}
          onClick={() => void submit('pass')}>
          <ShieldCheck className="h-4 w-4" /> Sign off
        </Button>
        <Button size="sm" variant="ghost" className="text-red-400" disabled={!!busy || !complete || !reviewer.trim() || !sound}
          onClick={() => void submit('fail')}>
          Record as failed
        </Button>
      </div>
    </div>
  );
}
