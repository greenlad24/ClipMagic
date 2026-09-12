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
            <p className="mt-1 text-sm font-medium text-foreground">{human(status?.workBytes)}</p>
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
            <h2 className="text-sm font-medium text-foreground">Jobs</h2>
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
