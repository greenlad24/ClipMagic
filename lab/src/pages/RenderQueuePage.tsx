import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Trash2,
  Download,
  FileText,
  Ban,
  RotateCcw,
  KeyRound,
  Copy,
  Link2,
  HardDrive,
  Film,
  Inbox,
  BookOpen,
  Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  hyperframesStatus,
  hyperframesJobs,
  hyperframesJob,
  hyperframesInbox,
  hyperframesCreateJob,
  hyperframesCancelJob,
  hyperframesRetryJob,
  hyperframesDeleteJob,
  hyperframesDeleteJobs,
  hyperframesApiKey,
  hyperframesUploads,
  hyperframesDeleteUpload,
  type HyperframesJob,
  type HyperframesInboxEntry,
  type HyperframesUpload,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';

/**
 * The render queue dashboard.
 *
 * ⚠️ IT POLLS AND COSTS NOTHING. Every number here comes from a status file the
 * worker writes to disk — no model call, no API credit — which is why refreshing
 * every few seconds is fine and why leaving this tab open all afternoon is fine.
 *
 * ⚠️ THE FRESHNESS INDICATOR IS THE POINT, NOT DECORATION. A progress bar frozen
 * at 62% looks identical whether the render is working or wedged. The worker
 * touches `updated_at` at least every 30 seconds even when the renderer is
 * silent, so "updated 4s ago" is the actual health signal and a stale one is
 * shown as a warning rather than left to be noticed.
 */

const STALE_AFTER_MS = 90_000;

function human(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)}${units[i]}`;
}

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function duration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Static classes only — Tailwind has no safelist here, so a template-built
// class name simply never gets generated.
const STATE_STYLE: Record<string, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-500/15 text-blue-400',
  done: 'bg-green-500/15 text-green-400',
  failed: 'bg-red-500/15 text-red-400',
  cancelled: 'bg-amber-500/15 text-amber-400',
  unknown: 'bg-muted text-muted-foreground',
};

export default function RenderQueuePage() {
  const [jobs, setJobs] = useState<HyperframesJob[]>([]);
  const [inbox, setInbox] = useState<HyperframesInboxEntry[]>([]);
  const [uploads, setUploads] = useState<HyperframesUpload[]>([]);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof hyperframesStatus>> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // ⚠️ SEPARATE FROM `selected`, WHICH OPENS A LOG. Ticking a row and reading a
  // row are different intentions, and sharing one piece of state would mean
  // opening a log to delete something.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [j, s, i, u] = await Promise.all([
        hyperframesJobs({}),
        hyperframesStatus({}),
        hyperframesInbox({}),
        hyperframesUploads({}),
      ]);
      setJobs(j.jobs);
      // ⚠️ A TICK MUST NOT OUTLIVE ITS ROW. Jobs also disappear from under this
      // page — the API deletes them, another tab does — and a stale id left in
      // the set would make "12 selected" mean eleven rows and one ghost.
      setCheckedIds((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(j.jobs.map((x) => x.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setStatus(s);
      setInbox(i.entries);
      setUploads(u.uploads);
      setLoaded(true);
    } catch (err) {
      console.error('[render queue] refresh failed', err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // The log is only fetched for the job you opened, and only while it is open —
  // tailing every job's log on a 5s timer would be pointless traffic.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const pull = async () => {
      try {
        const { log: text } = await hyperframesJob({ id: selected, logBytes: 24000 });
        if (alive) setLog(text);
      } catch {
        if (alive) setLog('');
      }
    };
    void pull();
    const t = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selected]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const act = async (id: string, what: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast.error(`${what} failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const queue = (entry: HyperframesInboxEntry) =>
    act(entry.name, 'Queue', async () => {
      const name = (names[entry.name] || entry.name).trim();
      await hyperframesCreateJob({ name, source: entry.name });
      toast.success(`Queued “${name}”`);
    });

  const dropUpload = (upload: HyperframesUpload) =>
    act(upload.id, 'Delete upload', async () => {
      const { freedBytes } = await hyperframesDeleteUpload({ id: upload.id });
      toast.success(`Deleted “${upload.name}”`, { description: `Freed ${human(freedBytes)}` });
    });

  const toggleCheck = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allChecked = jobs.length > 0 && jobs.every((j) => checkedIds.has(j.id));
  /**
   * The ticked jobs IN THE ORDER THEY WERE TICKED — Jake, 2026-09-20: "I want it
   * to write the links in the order I selected".
   *
   * ⚠️ IT IS THE SET THAT REMEMBERS, NOT A SEPARATE LIST. A JS Set iterates in
   * insertion order, so the order is already here for free — but only as long as
   * it is read from `checkedIds`. Filtering `jobs` (the obvious way to write
   * this) silently re-imposes the order of the table, which is what it did
   * before. Everything downstream reads this one value so there is no second,
   * unordered version to pick by accident.
   *
   * Unticking and re-ticking moves a row to the end, which is the honest answer
   * to "when did you select it". Select-all has no user order to preserve, so it
   * takes the table's.
   */
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const checkedJobs = [...checkedIds]
    .map((id) => byId.get(id))
    .filter((j): j is HyperframesJob => j !== undefined);
  /** Where a row sits in that order, 1-based; 0 when it is not selected. */
  const pickOrder = (id: string) => checkedJobs.findIndex((j) => j.id === id) + 1;
  const checkedBytes = checkedJobs.reduce((n, j) => n + (j.bytes ?? 0), 0);

  const toggleAll = () =>
    setCheckedIds(allChecked ? new Set() : new Set(jobs.map((j) => j.id)));

  /**
   * Delete everything ticked.
   *
   * ⚠️ THE SERVER DELETES THEM, NOT A LOOP IN HERE. One request per row would
   * half-finish on a dropped connection or a closed tab, and would report
   * whichever call happened to fail rather than what is actually left on disk.
   * The endpoint attempts every id, verifies each directory is gone, and returns
   * three lists — so this function's only job is to say the truth out loud.
   */
  /**
   * Every ticked render's MP4 address, one per line, on the clipboard.
   *
   * ⚠️ BARE URLS, NOTHING ELSE ON THE LINE. These get pasted into a chat, a
   * script or a download list, and a name or a bullet in front of each one
   * means whatever reads them next has to strip it back off.
   *
   * ⚠️ FINISHED RENDERS ONLY, AND THE REST ARE COUNTED OUT LOUD. A partial or a
   * queued job has no address worth handing anyone, and quietly dropping it
   * would hand over nine links for twelve ticks with nothing saying so.
   */
  const copyCheckedLinks = () => {
    const ready = checkedJobs.filter((j) => j.state === 'done' && j.output);
    const text = ready
      .map((j) => `${window.location.origin}${fileUrl(j, `output/${j.output}`)}`)
      .join('\n');
    const short = checkedJobs.length - ready.length;
    const note = short > 0 ? `${short} of them has no finished video yet.` : undefined;
    if (ready.length === 0) {
      toast.error('Nothing to copy', {
        description: 'None of the selected renders has finished yet.',
      });
      return;
    }
    const clip = navigator.clipboard;
    if (!clip) {
      toast.message('Copy them from here', { description: text, duration: 60_000 });
      return;
    }
    void clip.writeText(text).then(
      () =>
        toast.success(`Copied ${ready.length} link${ready.length === 1 ? '' : 's'} in the order you selected`, {
          // The finished MP4s are public (see isPublicRenderOutput) — worth
          // saying, because these get pasted where a sign-in wall would break
          // them, and because it means the link is as shareable as it looks.
          description: [note, 'Render links open without signing in.'].filter(Boolean).join(' '),
        }),
      () => toast.message('Copy them from here', { description: text, duration: 60_000 }),
    );
  };

  const removeChecked = async () => {
    const ids = checkedJobs.map((j) => j.id);
    if (ids.length === 0) return;
    const names = checkedJobs.slice(0, 8).map((j) => `• ${j.name || j.id}`).join('\n');
    const more = ids.length > 8 ? `\n…and ${ids.length - 8} more` : '';
    if (
      !window.confirm(
        `Delete ${ids.length} render${ids.length === 1 ? '' : 's'} completely?\n\n${names}${more}\n\n` +
          `This frees about ${human(checkedBytes)} and removes each project, its footage, its frame ` +
          `cache, the finished video and the log. There is no other copy.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    try {
      const r = await hyperframesDeleteJobs({ ids });
      // Whatever went is no longer a row, so it is no longer a tick. Anything
      // still cancelling or failed KEEPS its tick — it is the selection you
      // still have to do something about.
      setCheckedIds(new Set([...r.cancelling, ...r.failed.map((f) => f.id)]));
      if (selected && r.deleted.includes(selected)) setSelected(null);
      if (r.deleted.length > 0) {
        toast.success(`Deleted ${r.deleted.length} render${r.deleted.length === 1 ? '' : 's'}`, {
          description: `Freed ${human(r.freedBytes)}.`,
        });
      }
      if (r.cancelling.length > 0) {
        toast.info(`${r.cancelling.length} still rendering — cancelling`, {
          description: 'They are stopping now. Delete them again in a moment.',
        });
      }
      if (r.failed.length > 0) {
        toast.error(`${r.failed.length} could not be deleted`, {
          description: r.failed.map((f) => `${f.id}: ${f.error}`).join('\n'),
          duration: 15000,
        });
      }
      if (r.deleted.length === 0 && r.cancelling.length === 0 && r.failed.length === 0) {
        toast.info('Nothing was deleted — those jobs were already gone.');
      }
    } catch (err) {
      toast.error('Delete failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBulkBusy(false);
      await refresh();
    }
  };

  const remove = (job: HyperframesJob, keepOutput: boolean) =>
    act(job.id, 'Delete', async () => {
      const { freedBytes } = await hyperframesDeleteJob({ id: job.id, keepOutput });
      if (selected === job.id) setSelected(null);
      toast.success(keepOutput ? 'Footage and cache removed' : 'Deleted', {
        description: `Freed ${human(freedBytes)}.`,
      });
    });

  const showKey = async () => {
    try {
      const { key } = await hyperframesApiKey({});
      setApiKey(key);
    } catch (err) {
      toast.error('Could not read the API key', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const fileUrl = (job: HyperframesJob, rel: string) => `/api/hyperframes/files/${job.id}/${rel}`;

  /**
   * The MP4 button downloads the file; often what is actually wanted is its
   * ADDRESS — to paste into a chat, open in a player, or hand back to ChatGPT.
   * Same URL, made absolute so it still means something outside this tab.
   *
   * ⚠️ It is behind the Google sign-in (`/api/hyperframes/files` sits after
   * `auth`), so it opens for a signed-in browser and nowhere else. That is said
   * in the toast rather than left to be discovered by a 401.
   */
  const copyLink = (job: HyperframesJob, rel: string) => {
    const url = `${window.location.origin}${fileUrl(job, rel)}`;
    const clip = navigator.clipboard;
    if (!clip) {
      toast.message('Copy it from here', { description: url, duration: 30_000 });
      return;
    }
    void clip.writeText(url).then(
      () => toast.success('Link copied — opens in a signed-in browser', { description: url }),
      () => toast.message('Copy it from here', { description: url, duration: 30_000 }),
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="sm" className="gap-1.5">
                <ArrowLeft className="h-4 w-4" />
                Tools
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Render queue</h1>
              <p className="text-xs text-muted-foreground">
                Hyperframes renders that keep going after you close this tab.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        {/* Service health */}
        <div className="mb-6 grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Worker</p>
            <p
              className={cn(
                'mt-1 text-sm font-medium',
                status?.workerHealthy ? 'text-green-400' : 'text-red-400',
              )}
            >
              {!loaded ? '…' : status?.workerHealthy ? 'Healthy' : 'Not responding'}
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Running</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {status?.running ?? 0} of 1 · {status?.queued ?? 0} queued
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Jobs on disk</p>
            {/* ⚠️ THE REAL FOOTPRINT IS THE HEADLINE, and the sum of the job
                sizes is the footnote — not the other way round. Shared sources
                are hard-linked into every job that uses them, so adding the
                directories up counted one 4.9GB master sixteen times and read
                as 95GB on a disk with 54GB free. That is a number someone
                deletes finished work over. */}
            <p className="mt-1 text-sm font-medium text-foreground">
              {human((status?.workBytes ?? 0) - (status?.sharedSavingBytes ?? 0))}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {status?.sharedSavingBytes
                ? `${human(status.workBytes)} counted per job — ${human(
                    status.sharedSavingBytes,
                  )} of that is ${status.cacheFiles} shared source${
                    status.cacheFiles === 1 ? '' : 's'
                  } re-counted, downloaded once`
                : status?.cacheFiles
                  ? `incl. ${human(status.cacheBytes)} of shared footage, downloaded once`
                  : 'no shared footage cached yet'}
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Free space</p>
            <p
              className={cn(
                'mt-1 text-sm font-medium',
                (status?.diskFreeBytes ?? 0) < 10 * 1024 ** 3 ? 'text-amber-400' : 'text-foreground',
              )}
            >
              {human(status?.diskFreeBytes)}
            </p>
          </div>
        </div>

        {/* Inbox */}
        <div className="mb-6 rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">Inbox</h2>
            <span className="text-xs text-muted-foreground">
              rsync a project into <code className="font-mono">/opt/hyperframes-work/inbox/</code>
            </span>
          </div>
          {inbox.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">
              Nothing waiting. Projects up to a few gigabytes belong here rather than in a browser
              upload — <code className="font-mono">rsync -avP ./project/ root@server:/opt/hyperframes-work/inbox/</code>{' '}
              resumes if the connection drops. ChatGPT submits go straight to the API instead.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {inbox.map((entry) => (
                <div key={entry.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{entry.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.kind} · {human(entry.bytes)} · {ago(entry.modifiedAt)}
                    </p>
                  </div>
                  <Input
                    value={names[entry.name] ?? ''}
                    onChange={(e) => setNames((n) => ({ ...n, [entry.name]: e.target.value }))}
                    placeholder="Name this render"
                    className="h-8 w-56"
                  />
                  <Button
                    size="sm"
                    disabled={busy === entry.name}
                    onClick={() => void queue(entry)}
                    className="gap-1.5"
                  >
                    {busy === entry.name ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Film className="h-4 w-4" />
                    )}
                    Queue render
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Uploads */}
        {uploads.length > 0 && (
          <div className="mb-6 rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Package className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-foreground">Uploaded assets</h2>
              <span className="text-xs text-muted-foreground">
                fonts, images and clips ChatGPT sent directly — kept for 24h so revisions reuse them
              </span>
            </div>
            <div className="divide-y divide-border">
              {uploads.map((upload) => (
                <div key={upload.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{upload.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <code className="font-mono">{upload.id}</code> · {upload.files.length} file
                      {upload.files.length === 1 ? '' : 's'} · {human(upload.bytes)} ·{' '}
                      {ago(upload.createdAt)}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground/70">
                      {upload.files.map((f) => f.path).join(', ')}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === upload.id}
                    onClick={() => void dropUpload(upload)}
                    className="gap-1.5 text-red-400 hover:text-red-300"
                  >
                    {busy === upload.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Jobs */}
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2.5">
              {jobs.length > 0 && (
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                  title="Select every render"
                >
                  <input
                    type="checkbox"
                    checked={allChecked}
                    // Some-but-not-all has to LOOK different from none, or the
                    // box reads as "nothing is selected" while twelve rows are.
                    ref={(el) => {
                      if (el) el.indeterminate = checkedIds.size > 0 && !allChecked;
                    }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 cursor-pointer accent-[hsl(var(--primary))]"
                  />
                  All
                </label>
              )}
              <h2 className="text-sm font-medium text-foreground">Jobs</h2>
            </div>
            <div className="flex items-center gap-1">
              <a href="/api/hyperframes/docs" target="_blank" rel="noreferrer">
                <Button variant="ghost" size="sm" className="gap-1.5">
                  <BookOpen className="h-4 w-4" />
                  API docs
                </Button>
              </a>
              <a href="/api/hyperframes/docs?download" download="hyperframes-render-api.md">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  title="Download the contract as a .md file to upload into ChatGPT"
                >
                  <Download className="h-4 w-4" />
                  .md
                </Button>
              </a>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void showKey()}>
                <KeyRound className="h-4 w-4" />
                API key
              </Button>
            </div>
          </div>

          {checkedIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {checkedIds.size} selected
                </span>{' '}
                · {human(checkedBytes)} on disk
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={() => setCheckedIds(new Set())}
                >
                  Clear
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  disabled={bulkBusy}
                  title="Copy the MP4 link of every selected render, one per line"
                  onClick={() => copyCheckedLinks()}
                >
                  <Link2 className="h-4 w-4" />
                  Copy links
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkBusy}
                  className="gap-1.5 text-red-400 hover:text-red-300"
                  onClick={() => void removeChecked()}
                >
                  {bulkBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  {bulkBusy ? 'Deleting…' : 'Delete selected'}
                </Button>
              </div>
            </div>
          )}

          {apiKey && (
            <div className="border-b border-border bg-muted/30 px-4 py-3">
              <p className="mb-1.5 text-xs text-muted-foreground">
                For ChatGPT's connector. Send it as <code className="font-mono">Authorization: Bearer …</code>{' '}
                or <code className="font-mono">X-API-KEY</code> against{' '}
                <code className="font-mono">/api/hyperframes/v1</code>. Rotating it on the server
                takes effect immediately and the old key stops working at once.{' '}
                <a
                  href="/api/hyperframes/docs"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  Read the API contract
                </a>{' '}
                for the four calls ChatGPT needs and what a project must contain, or{' '}
                <a
                  href="/api/hyperframes/docs?download"
                  download="hyperframes-render-api.md"
                  className="underline hover:text-foreground"
                >
                  download it as .md
                </a>{' '}
                to upload into ChatGPT alongside this key.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                  {apiKey}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    void navigator.clipboard?.writeText(apiKey);
                    toast.success('Copied');
                  }}
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setApiKey(null)}>
                  Hide
                </Button>
              </div>
            </div>
          )}

          {!loaded ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : jobs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No renders yet. Queue one from the inbox, or have ChatGPT submit to the API.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {jobs.map((job) => {
                const stale =
                  job.state === 'running' &&
                  job.updatedAt !== null &&
                  Date.now() - job.updatedAt > STALE_AFTER_MS;
                return (
                  <div key={job.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="mt-1 flex shrink-0 items-center gap-1">
                        <input
                          type="checkbox"
                          checked={checkedIds.has(job.id)}
                          onChange={() => toggleCheck(job.id)}
                          disabled={bulkBusy}
                          title="Select this render"
                          className="h-3.5 w-3.5 cursor-pointer accent-[hsl(var(--primary))]"
                        />
                        {/* The copied links come out in this order, so it is
                            shown rather than left to be trusted. Only past one
                            tick — a lone "1" is noise. */}
                        {checkedIds.size > 1 && checkedIds.has(job.id) && (
                          <span
                            className="w-4 text-[10px] tabular-nums text-muted-foreground"
                            title="Where this sits in the order you selected"
                          >
                            {pickOrder(job.id)}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                              STATE_STYLE[job.state] ?? STATE_STYLE.unknown,
                            )}
                          >
                            {job.state}
                          </span>
                          <p className="truncate text-sm text-foreground">{job.name}</p>
                          {job.clientRef && (
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {job.clientRef}
                            </span>
                          )}
                        </div>

                        <p className="mt-1 text-xs text-muted-foreground">
                          {job.step || job.phase || '—'}
                          {job.totalFrames
                            ? ` · ${job.framesCompleted ?? 0}/${job.totalFrames} frames`
                            : ''}
                          {job.estimatedMinutesRemaining
                            ? ` · ~${job.estimatedMinutesRemaining} min left`
                            : ''}
                          {' · '}
                          {duration(job.elapsedSeconds)} elapsed · {human(job.bytes)}
                          {job.attempt > 1 ? ` · attempt ${job.attempt}` : ''}
                        </p>

                        {job.state === 'running' && (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-muted">
                            <div
                              className="h-full rounded bg-blue-500 transition-all"
                              style={{ width: `${Math.max(2, job.percent ?? 0)}%` }}
                            />
                          </div>
                        )}

                        <p
                          className={cn(
                            'mt-1 text-[11px]',
                            stale ? 'text-amber-400' : 'text-muted-foreground',
                          )}
                        >
                          {stale
                            ? `No progress for ${ago(job.updatedAt)} — it may be stuck.`
                            : `Updated ${ago(job.updatedAt)}`}
                        </p>

                        {job.message && (
                          <p className="mt-1 text-[11px] text-red-400">{job.message}</p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* A render that stopped early still has real finished
                            minutes in it — before chunking they were thrown away. */}
                        {job.state !== 'done' && job.partialOutput && (
                          <a href={fileUrl(job, `output/${job.partialOutput}`)} download>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              title={`The ${job.partialChunks} chunk(s) that finished, joined — watchable from the start`}
                            >
                              <Download className="h-4 w-4" />
                              Partial MP4 ({job.partialSeconds ? `${Math.round(job.partialSeconds)}s` : '—'})
                            </Button>
                          </a>
                        )}
                        {job.state !== 'done' && job.partialOutput && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1.5"
                            title="Copy the link to the partial MP4"
                            onClick={() => copyLink(job, `output/${job.partialOutput}`)}
                          >
                            <Link2 className="h-4 w-4" />
                            Copy link
                          </Button>
                        )}
                        {job.state === 'done' && job.output && (
                          <a href={fileUrl(job, `output/${job.output}`)} download>
                            <Button size="sm" variant="outline" className="gap-1.5">
                              <Download className="h-4 w-4" />
                              MP4 ({human(job.outputBytes)})
                            </Button>
                          </a>
                        )}
                        {job.state === 'done' && job.output && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1.5"
                            title="Copy the link to this render instead of downloading it"
                            onClick={() => copyLink(job, `output/${job.output}`)}
                          >
                            <Link2 className="h-4 w-4" />
                            Copy link
                          </Button>
                        )}
                        <a href={`/api/hyperframes/project/${job.id}.tar.gz`} download>
                          <Button size="sm" variant="ghost" className="gap-1.5">
                            <Download className="h-4 w-4" />
                            Project
                          </Button>
                        </a>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5"
                          onClick={() => setSelected(selected === job.id ? null : job.id)}
                        >
                          <FileText className="h-4 w-4" />
                          Log
                        </Button>
                        {job.state === 'running' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === job.id}
                            className="gap-1.5"
                            onClick={() =>
                              void act(job.id, 'Cancel', async () => {
                                await hyperframesCancelJob({ id: job.id });
                                toast.info('Cancelling…');
                              })
                            }
                          >
                            <Ban className="h-4 w-4" />
                            Cancel
                          </Button>
                        )}
                        {(job.state === 'failed' || job.state === 'cancelled') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === job.id}
                            className="gap-1.5"
                            onClick={() =>
                              void act(job.id, 'Retry', async () => {
                                await hyperframesRetryJob({ id: job.id });
                                toast.success('Back in the queue');
                              })
                            }
                          >
                            <RotateCcw className="h-4 w-4" />
                            Retry
                          </Button>
                        )}
                        {job.state === 'done' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === job.id}
                            className="gap-1.5"
                            title="Delete the footage and frame cache, keep the finished MP4"
                            onClick={() => void remove(job, true)}
                          >
                            <HardDrive className="h-4 w-4" />
                            Free space
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === job.id}
                          className="gap-1.5 text-red-400 hover:text-red-300"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete “${job.name}” completely?\n\nThis removes the project, the footage, the frame cache, the finished video and the log. There is no other copy.`,
                              )
                            ) {
                              void remove(job, false);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    </div>

                    {selected === job.id && (
                      <pre
                        ref={logRef}
                        className="mt-3 max-h-72 overflow-auto rounded bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
                      >
                        {log || 'No log yet.'}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
