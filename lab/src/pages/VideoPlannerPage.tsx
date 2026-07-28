import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  plannerStatus,
  startPlan,
  planJobStatus,
  getPlanRun,
  listPlanRuns,
  deletePlanRun,
  type PlanRunResult,
  type PlanRunListItem,
  type PlanJobSnapshot,
} from 'zite-endpoints-sdk';
import { ArrowLeft, Clapperboard, Copy, Loader2, Trash2, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Colour the element name so a long plan can be scanned at a glance. */
function lineTone(instruction: string): string {
  const h = instruction.toLowerCase();
  if (h.startsWith('screencast')) return 'text-[hsl(var(--chart-2))]';
  if (h.startsWith('talking head')) return 'text-[hsl(var(--chart-3))]';
  if (h.startsWith('stock')) return 'text-[hsl(var(--chart-5))]';
  if (h.startsWith('text (')) return 'text-[hsl(var(--chart-4))]';
  return 'text-muted-foreground';
}

export default function VideoPlannerPage() {
  const [status, setStatus] = useState<{ anthropicConfigured: boolean; groqConfigured: boolean; model: string } | null>(null);
  const [source, setSource] = useState('');
  const [productUrls, setProductUrls] = useState('');
  const [title, setTitle] = useState('');
  const [skipResearch, setSkipResearch] = useState(false);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<PlanJobSnapshot | null>(null);
  const [run, setRun] = useState<PlanRunResult | null>(null);
  const [runs, setRuns] = useState<PlanRunListItem[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns((await listPlanRuns({})).runs);
    } catch { /* list is non-critical */ }
  }, []);

  useEffect(() => {
    plannerStatus({}).then(setStatus).catch(() => setStatus(null));
    void refreshRuns();
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [refreshRuns]);

  const watch = useCallback((runId: string) => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const snap = await planJobStatus({ runId });
        setJob(snap);
        if (snap.status === 'completed' || snap.status === 'failed') {
          if (poll.current) clearInterval(poll.current);
          poll.current = null;
          setRun(await getPlanRun({ runId }));
          void refreshRuns();
          if (snap.status === 'failed') toast.error(snap.error || 'Planning failed');
        }
      } catch {
        if (poll.current) clearInterval(poll.current);
        poll.current = null;
      }
    }, 2500);
  }, [refreshRuns]);

  const onStart = async () => {
    if (!source.trim()) { toast.error('Paste a Descript share link first'); return; }
    setStarting(true); setRun(null); setJob(null);
    try {
      const { runId } = await startPlan({
        source: source.trim(),
        sourceKind: 'descript',
        productUrls: productUrls.split('\n').map((s) => s.trim()).filter(Boolean),
        skipResearch,
        title: title.trim() || undefined,
      });
      setJob({ runId, status: 'ingesting', stage: 'Starting', progress: 0.01, error: null });
      watch(runId);
    } catch (e: any) {
      toast.error(e?.message || 'Could not start');
    } finally {
      setStarting(false);
    }
  };

  const open = async (runId: string) => {
    try {
      const r = await getPlanRun({ runId });
      setRun(r);
      setJob(null);
      if (r.status !== 'completed' && r.status !== 'failed') watch(runId);
    } catch (e: any) { toast.error(e?.message || 'Could not open run'); }
  };

  const remove = async (runId: string) => {
    try { await deletePlanRun({ runId }); if (run?.runId === runId) setRun(null); void refreshRuns(); }
    catch (e: any) { toast.error(e?.message || 'Could not delete'); }
  };

  const copyPlan = () => {
    if (!run?.plan) return;
    navigator.clipboard.writeText(run.plan);
    toast.success('Plan copied');
  };

  const m = run?.measure;
  const busy = Boolean(job && job.status !== 'completed' && job.status !== 'failed');

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <Link to="/" className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All tools
        </Link>

        <div className="mb-8 flex items-start gap-3">
          <div className="rounded-lg bg-[hsl(var(--chart-2))]/10 p-2">
            <Clapperboard className="h-6 w-6 text-[hsl(var(--chart-2))]" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Video Planner</h1>
            <p className="text-sm text-muted-foreground">
              Drop an edited narration and get the second-by-second visual plan — which screencast, which title,
              which stock shot, and exactly when.
            </p>
          </div>
        </div>

        {status && !status.anthropicConfigured && (
          <div className="mb-6 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
            <span>
              The Anthropic key isn&apos;t set, so planning will fail.{' '}
              <Link to="/settings/postiz" className="underline">Configure it</Link>.
            </span>
          </div>
        )}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-6">
            {/* ── input ─────────────────────────────────────────────────── */}
            <div className="space-y-4 rounded-lg border p-5">
              <div>
                <Label htmlFor="src">Descript share link</Label>
                <Input
                  id="src" value={source} onChange={(e) => setSource(e.target.value)}
                  placeholder="https://share.descript.com/view/..." className="mt-1.5" disabled={busy}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The edited narration — you talking to camera, already cut for pace.
                </p>
              </div>

              <div>
                <Label htmlFor="title">Title (optional)</Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder="Expertise — turn Claude skills into products" className="mt-1.5" disabled={busy} />
              </div>

              <div>
                <Label htmlFor="urls">Product URLs (optional, one per line)</Label>
                <textarea
                  id="urls" value={productUrls} onChange={(e) => setProductUrls(e.target.value)}
                  rows={3} disabled={busy}
                  placeholder={'https://expertise.ai\nhttps://claude.ai'}
                  className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The planner verifies each product&apos;s real UI before writing screencast instructions, so the
                  operator isn&apos;t sent to a screen that doesn&apos;t exist. Naming the URLs makes that more accurate.
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={skipResearch} disabled={busy}
                  onChange={(e) => setSkipResearch(e.target.checked)} />
                Skip UI research (faster, but screencast instructions will be unverified)
              </label>

              <Button onClick={onStart} disabled={busy || starting} className="w-full">
                {busy || starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {busy ? 'Planning…' : 'Plan this video'}
              </Button>
            </div>

            {/* ── progress ──────────────────────────────────────────────── */}
            {job && busy && (
              <div className="rounded-lg border p-5">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span>{job.stage || job.status}</span>
                  <span className="text-muted-foreground">{Math.round(job.progress * 100)}%</span>
                </div>
                <Progress value={job.progress * 100} />
                <p className="mt-3 text-xs text-muted-foreground">
                  Ingest, then pauses and emphasis from the waveform, then UI research, then the plan — which is
                  measured against your published videos and revised if it drifts. A 14-minute narration takes
                  several minutes.
                </p>
              </div>
            )}

            {/* ── result ────────────────────────────────────────────────── */}
            {run?.status === 'failed' && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 text-sm">
                <div className="mb-1 flex items-center gap-2 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" /> Planning failed
                </div>
                <p className="text-muted-foreground">{run.error}</p>
              </div>
            )}

            {run?.status === 'completed' && run.plan && (
              <div className="space-y-4">
                {m && (
                  <div className="rounded-lg border p-5">
                    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                      <CheckCircle2 className="h-4 w-4 text-[hsl(var(--chart-3))]" />
                      Matches your editing
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      <Stat label="Screencast" value={`${m.screencastPct}%`} target="70.6%" />
                      <Stat label="Talking head" value={`${m.talkingHeadPct}%`} target="28.6%" />
                      <Stat label="Titles/min" value={String(m.titlesPerMin)} target="1.3" />
                      <Stat label="Alternation" value={`${m.altPct}%`} target="77%" />
                    </div>
                    <div className="mt-4 border-t pt-4">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        Cutting pace — the hook runs faster, the body settles
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-sm">
                        <Stat
                          label="Hook (first 1:30)"
                          value={m.openingShotsPerMin === null ? "—" : `${m.openingShotsPerMin}/min`}
                          target="9.0/min"
                        />
                        <Stat
                          label="Body (rest)"
                          value={m.bodyShotsPerMin === null ? "—" : `${m.bodyShotsPerMin}/min`}
                          target="4.7/min"
                        />
                        <Stat
                          label="Hook ÷ body"
                          value={m.hookBodyRatio === null ? "—" : `${m.hookBodyRatio}x`}
                          target="1.9x"
                        />
                      </div>
                    </div>
                    {(m.gaps.length > 0 || m.overlaps.length > 0) && (
                      <p className="mt-3 text-xs text-destructive">
                        {m.gaps.length} gap(s), {m.overlaps.length} overlap(s) — the plan does not fully tile.
                      </p>
                    )}
                    {run.rounds.length > 1 && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Revised {run.rounds.length - 1}×: penalty {run.rounds[0].penalty} → {m ? run.rounds[run.rounds.length - 1].penalty : '?'}.
                      </p>
                    )}
                  </div>
                )}

                {!run.research && !run.input.skipResearch && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                    <Info className="mt-0.5 h-4 w-4 text-amber-500" />
                    <span>UI research didn&apos;t complete, so screencast instructions are unverified — check each screen before recording.</span>
                  </div>
                )}

                <div className="rounded-lg border">
                  <div className="flex items-center justify-between border-b px-5 py-3">
                    <div className="text-sm font-medium">
                      The plan
                      <span className="ml-2 text-muted-foreground">
                        {run.parsed.length} lines · {run.durationSec ? mmss(run.durationSec) : ''}
                      </span>
                    </div>
                    <Button size="sm" variant="outline" onClick={copyPlan}>
                      <Copy className="mr-2 h-3.5 w-3.5" /> Copy
                    </Button>
                  </div>
                  <div className="max-h-[32rem] overflow-auto px-5 py-4">
                    {run.plan.split('\n').filter((l) => l.trim()).map((line, i) => {
                      const m2 = /^\[(\d+:\d{2})\s+to\s+(\d+:\d{2})\]\s*[-–]\s*(.+)$/.exec(line.trim());
                      if (!m2) return <p key={i} className="text-sm text-muted-foreground">{line}</p>;
                      return (
                        <p key={i} className="border-b py-2 text-sm last:border-0">
                          <span className="mr-2 font-mono text-xs text-muted-foreground">
                            [{m2[1]} to {m2[2]}]
                          </span>
                          <span className={lineTone(m2[3])}>{m2[3]}</span>
                        </p>
                      );
                    })}
                  </div>
                </div>

                {run.research && (
                  <details className="rounded-lg border p-5">
                    <summary className="cursor-pointer text-sm font-medium">
                      Verified UI fact sheet — what the screencast instructions are grounded in
                    </summary>
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                      {run.research}
                    </pre>
                  </details>
                )}

                <p className="text-xs text-muted-foreground">
                  Cost ${run.costUsd.toFixed(2)}. This is a draft for the editor, not a finished edit — measured
                  against four published videos it matches your style, but it will not always pick the same second
                  you would.
                </p>
              </div>
            )}
          </div>

          {/* ── history ───────────────────────────────────────────────── */}
          <div>
            <h2 className="mb-3 text-sm font-medium">Recent</h2>
            <div className="space-y-2">
              {runs.length === 0 && <p className="text-sm text-muted-foreground">No plans yet.</p>}
              {runs.map((r) => (
                <div key={r.runId} className="group flex items-start justify-between gap-2 rounded-md border p-3">
                  <button className="min-w-0 flex-1 text-left" onClick={() => open(r.runId)}>
                    <div className="truncate text-sm">{r.title}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant={r.status === 'completed' ? 'secondary' : 'outline'} className="text-[10px]">
                        {r.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {r.lines} lines{r.durationSec ? ` · ${mmss(r.durationSec)}` : ''}
                      </span>
                    </div>
                  </button>
                  <button onClick={() => remove(r.runId)} className="opacity-0 transition group-hover:opacity-100">
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, target }: { label: string; value: string; target: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-lg font-medium">{value}</div>
      <div className="text-[11px] text-muted-foreground">yours {target}</div>
    </div>
  );
}
