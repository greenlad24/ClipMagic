import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  autoEditorDelete,
  autoEditorDeleteFiles,
  autoEditorStorage,
  type AutoFileKind,
  type AutoNarration,
  type AutoStoredJob,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import { fmtBytes } from './useSourceUpload';
import { freesText, NarrationLibrary } from './NarrationLibrary';

/**
 * Stored files — what the Auto Editor keeps on the 500 GB factory volume (Jake 2026-10-09: "I
 * want to be able to delete narrations and files that were stored on the volume also").
 * lab/server/src/aieditor/storage.ts: space = allocated bytes of unique inodes (the Storage
 * page's rule), and every "frees" figure counts hard links — a file shared with another edit or
 * the narration library frees nothing until its last link goes. A running or queued edit, and
 * a file an edit that has not started yet still needs, are refused by the server.
 * Every delete is confirmed in the page (never window.confirm).
 */

type Pending = { job: string; kind: AutoFileKind | 'job' } | null;

function size(n: number): string {
  return n > 0 ? fmtBytes(n) : '0 B';
}

export function StoredFiles() {
  const [data, setData] = useState<{
    volume: { total: number; used: number; free: number } | null;
    jobsBytes: number;
    jobs: AutoStoredJob[];
    uploads: AutoNarration[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await autoEditorStorage({}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const doDelete = async (job: AutoStoredJob, kind: AutoFileKind | 'job') => {
    setBusy(true);
    try {
      if (kind === 'job') {
        const r = await autoEditorDelete({ id: job.id });
        toast.success(`Deleted “${job.title}” — ${freesText(r.freed ?? 0)}.`);
      } else {
        const r = await autoEditorDeleteFiles({ id: job.id, kind });
        toast.success(`Deleted ${r.removed.length} item${r.removed.length === 1 ? '' : 's'} — ${freesText(r.freed)}.`);
      }
      setPending(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Measuring the volume…
      </p>
    );
  }
  const v = data.volume;
  // the library's deletable entries (uploads); a job's narration is that job's "Source" below
  const uploaded = data.uploads.filter((u) => u.deletable !== false);
  const pct = v && v.total ? Math.min(100, (v.used / v.total) * 100) : 0;

  const confirmRow = (job: AutoStoredJob, kind: AutoFileKind | 'job', what: string, frees: number, shared: string[]) => (
    <div className="mt-1.5 space-y-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
      <p className="text-foreground">
        Delete {what}? It {frees > 0 ? <>frees <b>{fmtBytes(frees)}</b></> : <>frees <b>0 B</b></>}
        {kind === 'final' || kind === 'preview' ? ' — the edit shows it as deleted.' : '.'}
      </p>
      {shared.length > 0 && (
        <p className="text-muted-foreground">
          Part of it is the same file on disk as {shared.join(', ')} — that part stays until they are deleted too.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={busy} onClick={() => void doDelete(job, kind)}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Delete'}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => setPending(null)}>
          Keep it
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <HardDrive className="h-4 w-4 text-muted-foreground" /> Stored files
          </h2>
          <p className="text-xs text-muted-foreground">The factory volume: narrations, edits and everything made on the way.</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void load()} title="Measure again">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {v && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
            <span className="text-foreground">
              <b>{size(v.used)}</b> used · <b>{size(v.free)}</b> free
            </span>
            <span className="text-muted-foreground">
              of {size(v.total)} · edits + narrations {size(data.jobsBytes)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Uploaded narrations ({uploaded.length})
        </h3>
        {/* a job's own narration is its "Source" under Edits below — deleted there, not here */}
        <NarrationLibrary items={uploaded} error={null} onChanged={() => void load()} />
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Edits ({data.jobs.length})</h3>
        {data.jobs.length === 0 && <p className="text-sm text-muted-foreground">No edits stored.</p>}
        <div className="space-y-2">
          {data.jobs.map((j) => {
            const isOpen = !!open[j.id];
            return (
              <div key={j.id} className="rounded-xl border border-border">
                <div className="flex items-center gap-2 p-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setOpen((o) => ({ ...o, [j.id]: !isOpen }))}
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{j.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {size(j.bytes)}
                        {j.frees !== j.bytes ? ` · ${freesText(j.frees)} if deleted` : ''}
                        {j.busy ? ` · ${j.busy}` : j.state ? ` · ${j.state}` : ''}
                      </span>
                    </span>
                  </button>
                  <Link to={`/auto-editor/${j.id}`} className="hidden text-xs text-muted-foreground hover:text-foreground sm:inline">
                    Open
                  </Link>
                  <Button
                    size="icon"
                    variant="ghost"
                    title={j.blocked ?? 'Delete this edit'}
                    disabled={!!j.blocked}
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-400"
                    onClick={() => setPending(pending?.job === j.id && pending.kind === 'job' ? null : { job: j.id, kind: 'job' })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {pending?.job === j.id && pending.kind === 'job' && (
                  <div className="px-2.5 pb-2.5">
                    {confirmRow(j, 'job', `the whole edit “${j.title}” and all its files`, j.frees,
                      [...new Set(j.kinds.flatMap((k) => k.sharedWith))])}
                  </div>
                )}
                {isOpen && (
                  <div className="border-t border-border/60 px-2.5 py-2">
                    {j.blocked && <p className="mb-1.5 text-xs text-amber-400">Can’t delete now: {j.blocked}.</p>}
                    <ul className="divide-y divide-border/40">
                      {j.kinds.map((k) => (
                        <li key={k.kind} className="py-1.5">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1">
                              <span className="text-foreground">{k.title}</span>
                              <span className="text-muted-foreground">
                                {' '}· {size(k.bytes)} · {k.files} file{k.files === 1 ? '' : 's'}
                                {k.sharedWith.length > 0 ? ` · shared with ${k.sharedWith.length === 1 ? k.sharedWith[0] : `${k.sharedWith.length} others`}` : ''}
                              </span>
                            </span>
                            {k.deletable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-red-400"
                                disabled={!!k.blocked}
                                title={k.blocked ?? undefined}
                                onClick={() => setPending(pending?.job === j.id && pending.kind === k.kind ? null : { job: j.id, kind: k.kind })}
                              >
                                Delete · {freesText(k.frees)}
                              </Button>
                            )}
                          </div>
                          {k.blocked && k.deletable && <p className="text-[11px] text-amber-400/80">{k.blocked}</p>}
                          {pending?.job === j.id && pending.kind === k.kind &&
                            confirmRow(j, k.kind, `${k.title.toLowerCase()} of “${j.title}”`, k.frees, k.sharedWith)}
                        </li>
                      ))}
                    </ul>
                    {j.deleted.length > 0 && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        Deleted earlier: {j.deleted.slice(-6).map((d) => d.files.join(', ')).join(' · ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
