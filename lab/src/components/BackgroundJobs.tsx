/**
 * Global Background Jobs panel.
 *
 * A floating trigger (bottom-right) shows a live count of active jobs; clicking
 * it opens a right-side drawer listing every queued / running / paused job plus
 * a "recent" section of finished ones. Each render-queue job can be Paused,
 * Resumed or Canceled; cutter analyze jobs are shown read-only.
 *
 * Mounted once at the app root so it's present on every product surface
 * (short-form, bulk, cutter, meme) regardless of each page's own chrome.
 *
 * Polling: only while open OR while there is known active work, every ~1.8s, so
 * an idle app makes no noise. Controls are optimistic and reconciled on the next
 * poll; failures surface inline (and as a toast) — never silently.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { listJobs, pauseJob, resumeJob, cancelJob } from 'zite-endpoints-sdk';
import { useTransfers, type Transfer } from '@/lib/uploadTracker';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Layers,
  X,
  Pause,
  Play,
  Ban,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';

type JobStatus = 'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'canceled';

interface PanelJob {
  id: string;
  source: 'render' | 'analyze' | 'upload';
  type: string;
  title: string;
  status: JobStatus;
  stage: string;
  progress: number;
  error: string | null;
  outputUrl: string | null;
  controllable: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ListJobsResult {
  active: PanelJob[];
  recent: PanelJob[];
  activeCount: number;
}

const POLL_MS = 1800;

function isTerminal(s: JobStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'canceled';
}

/** Map a client-side upload transfer into the same shape the panel renders. */
function transferToJob(t: Transfer): PanelJob {
  const status: JobStatus =
    t.status === 'uploading' ? 'active'
    : t.status === 'done' ? 'completed'
    : t.status === 'failed' ? 'failed'
    : 'canceled';
  return {
    id: t.id,
    source: 'upload',
    type: 'Upload',
    title: t.title,
    status,
    stage: 'Uploading to server',
    progress: t.progress,
    error: t.error ?? null,
    outputUrl: null,
    controllable: false,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function statusPill(status: JobStatus): { label: string; className: string; icon: React.ReactNode } {
  switch (status) {
    case 'active':
      return {
        label: 'Running',
        className: 'bg-primary/15 text-primary border-primary/30',
        icon: <Loader2 className="w-3 h-3 animate-spin" />,
      };
    case 'queued':
      return {
        label: 'Queued',
        className: 'bg-muted text-muted-foreground border-border',
        icon: <Clock className="w-3 h-3" />,
      };
    case 'paused':
      return {
        label: 'Paused',
        className: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
        icon: <Pause className="w-3 h-3" />,
      };
    case 'completed':
      return {
        label: 'Done',
        className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
        icon: <CheckCircle2 className="w-3 h-3" />,
      };
    case 'failed':
      return {
        label: 'Failed',
        className: 'bg-destructive/15 text-destructive border-destructive/30',
        icon: <XCircle className="w-3 h-3" />,
      };
    case 'canceled':
      return {
        label: 'Canceled',
        className: 'bg-muted text-muted-foreground border-border',
        icon: <Ban className="w-3 h-3" />,
      };
  }
}

export default function BackgroundJobs() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ListJobsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Optimistic status overrides keyed by jobId, cleared when a poll confirms.
  const [optimistic, setOptimistic] = useState<Record<string, JobStatus>>({});
  const [confirmCancel, setConfirmCancel] = useState<PanelJob | null>(null);

  // Client-side uploads (not server jobs) — shown live alongside real jobs.
  const transfers = useTransfers();
  const uploadJobs = transfers.map(transferToJob);
  const uploadActive = uploadJobs.filter((j) => !isTerminal(j.status));
  const uploadRecent = uploadJobs.filter((j) => isTerminal(j.status));

  const activeCount = (data?.activeCount ?? 0) + uploadActive.length;
  const hasActive = activeCount > 0;

  const poll = useCallback(async () => {
    try {
      const res = (await listJobs({})) as ListJobsResult;
      setData(res);
      setError(null);
      // Drop optimistic overrides the server now agrees with (or that are gone).
      setOptimistic((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const all = [...res.active, ...res.recent];
        const next: Record<string, JobStatus> = {};
        for (const [id, st] of Object.entries(prev)) {
          const job = all.find((j) => j.id === id);
          if (job && job.status !== st) next[id] = st; // keep until server catches up
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load jobs.');
    }
  }, []);

  // Poll while open, or while there is active work (so the badge stays live and
  // a long render finishing re-collapses the trigger). Idle + closed = silent.
  useEffect(() => {
    if (!open && !hasActive) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await poll();
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, hasActive, poll]);

  // One initial poll on mount so the badge can appear without opening the panel.
  useEffect(() => {
    void poll();
  }, [poll]);

  const withBusy = useCallback(
    async (id: string, optimisticStatus: JobStatus, fn: () => Promise<unknown>, failMsg: string) => {
      setBusy((b) => new Set(b).add(id));
      setOptimistic((o) => ({ ...o, [id]: optimisticStatus }));
      try {
        await fn();
        await poll();
      } catch (e) {
        setOptimistic((o) => {
          const next = { ...o };
          delete next[id];
          return next;
        });
        toast.error(failMsg + (e instanceof Error ? `: ${e.message}` : ''));
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        });
      }
    },
    [poll],
  );

  const onPause = (j: PanelJob) =>
    withBusy(j.id, 'paused', () => pauseJob({ jobId: j.id }), 'Could not pause job');
  const onResume = (j: PanelJob) =>
    withBusy(j.id, j.status === 'paused' ? 'queued' : 'active', () => resumeJob({ jobId: j.id }), 'Could not resume job');
  const doCancel = (j: PanelJob) =>
    withBusy(j.id, 'canceled', () => cancelJob({ jobId: j.id }), 'Could not cancel job');

  const effectiveStatus = (j: PanelJob): JobStatus => optimistic[j.id] ?? j.status;

  // Uploads first (they're the most immediate), then server jobs.
  const active = [...uploadActive, ...(data?.active ?? [])];
  const recent = [...uploadRecent, ...(data?.recent ?? [])];

  return (
    <>
      {/* Floating trigger */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Background jobs${hasActive ? ` (${activeCount} active)` : ''}`}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 shadow-lg transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <Layers className="w-4 h-4 text-foreground" />
        <span className="text-sm font-medium text-foreground hidden sm:inline">Jobs</span>
        {hasActive && (
          <span className="flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
            {activeCount}
          </span>
        )}
      </button>

      {/* Drawer */}
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Background jobs">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute right-0 top-0 h-full w-full sm:w-[420px] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
            <header className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" />
                <h2 className="font-semibold text-foreground">Background jobs</h2>
                {hasActive && (
                  <span className="flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                    {activeCount}
                  </span>
                )}
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close panel">
                <X className="w-4 h-4" />
              </Button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              {/* Active / queued / paused */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                  Active
                </h3>
                {active.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                    <Layers className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No jobs running right now.</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      Renders, cuts and meme runs will appear here.
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {active.map((j) => (
                      <JobRow
                        key={j.id}
                        job={j}
                        status={effectiveStatus(j)}
                        busy={busy.has(j.id)}
                        onPause={() => onPause(j)}
                        onResume={() => onResume(j)}
                        onCancel={() => setConfirmCancel(j)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* Recent */}
              {recent.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                    Recent
                  </h3>
                  <ul className="space-y-3">
                    {recent.map((j) => (
                      <JobRow key={j.id} job={j} status={effectiveStatus(j)} busy={false} recent />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Cancel confirmation */}
      <AlertDialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this job?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCancel
                ? `"${confirmCancel.title}" will stop immediately and its partial output discarded. This can't be undone.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmCancel) void doCancel(confirmCancel);
                setConfirmCancel(null);
              }}
            >
              Cancel job
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function JobRow({
  job,
  status,
  busy,
  recent,
  onPause,
  onResume,
  onCancel,
}: {
  job: PanelJob;
  status: JobStatus;
  busy: boolean;
  recent?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}) {
  const pill = statusPill(status);
  const terminal = isTerminal(status);
  const pct = Math.round((job.progress ?? 0) * 100);

  const canPause = job.controllable && (status === 'active' || status === 'queued');
  const canResume = job.controllable && status === 'paused';
  const canCancel = job.controllable && !terminal;

  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate" title={job.title}>
            {job.title}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{job.type}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1 shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${pill.className}`}
        >
          {pill.icon}
          {pill.label}
        </span>
      </div>

      {/* Progress + stage for non-terminal work */}
      {!terminal && (
        <div className="mt-3 space-y-1.5">
          <Progress value={pct} className={status === 'paused' ? 'opacity-60' : undefined} />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{job.stage}</span>
            <span>{pct}%</span>
          </div>
        </div>
      )}

      {/* Outcome line for terminal jobs */}
      {terminal && (status === 'failed' || status === 'canceled') && job.error && (
        <p className="mt-2 text-xs text-muted-foreground line-clamp-2" title={job.error}>
          {job.error}
        </p>
      )}

      {/* Controls */}
      {!recent && (canPause || canResume || canCancel) && (
        <div className="mt-3 flex items-center gap-2">
          {canPause && (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={onPause}>
              <Pause className="w-3 h-3 mr-1" />
              Pause
            </Button>
          )}
          {canResume && (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={onResume}>
              <Play className="w-3 h-3 mr-1" />
              Resume
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={busy}
              onClick={onCancel}
            >
              <Ban className="w-3 h-3 mr-1" />
              Cancel
            </Button>
          )}
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
        </div>
      )}

      {/* Read-only note for analyze jobs */}
      {!recent && !job.controllable && !terminal && job.source === 'analyze' && (
        <p className="mt-2 text-xs text-muted-foreground/70">Read-only · runs to completion</p>
      )}
    </li>
  );
}
