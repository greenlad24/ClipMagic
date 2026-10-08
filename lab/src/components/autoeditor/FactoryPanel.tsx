import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Server, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * The VIDEO FACTORY — Jake 2026-10-08: cost effective, saves a lot of time, efficient, and
 * transparent. Each heavy Auto Editor job (the cut run, renders, the final, the full edit)
 * can run on its OWN DigitalOcean server, created from a snapshot and deleted the moment the
 * job ends (host: aieditor/cloud.py). This panel shows what is running and what it costs,
 * and owns the four settings Jake should touch. It never creates or deletes a server.
 *
 * REST (not the fn SDK): GET/POST /api/aieditor/factory, POST /api/aieditor/factory/image.
 */

export interface FactoryLive {
  droplet: number; job: string | null; title: string | null; action: string | null; role: string;
  size: string; state: string | null; created: number | null; heartbeat: number | null; stale: boolean;
  elapsedMin: number; estUsd: number; priceHourly: number;
}
export interface FactoryRun {
  job: string; title: string; action: string; droplet: number | null; size: string;
  started: number; ended: number; minutes: number; usd: number; ok: boolean; destroyed: boolean;
}
export interface FactoryState {
  settings: { enabled: boolean; size: string; maxParallel: number; maxHours: number; fallbackLocal: boolean; region: string };
  sizes: { id: string; vcpu: number; ramGb: number; usdHour: number }[];
  tokenSet: boolean;
  snapshot: { id: number | null; name: string | null; builtAt: number | null };
  image: { state: 'building' | 'done' | 'failed' | null; started: number | null; finished: number | null; error: string | null; log: string[]; requested: boolean };
  live: FactoryLive[];
  doTagged: { id: number; name: string; size: string; status: string; created: string; leftover: boolean }[] | null;
  doError: string | null;
  history: FactoryRun[];
  month: { serverUsd: number; liveUsd: number; runs: number; minutes: number; volumeUsd: number; budgetUsd: number };
  worker: { alive: boolean; seenAt: number | null; factoryJobs: number | null };
}

async function rest<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  if (res.status === 401) {
    window.location.href = '/auth/google';
    throw new Error('Sign-in required');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json as T;
}

export const getFactory = () => rest<FactoryState>('/api/aieditor/factory');
const saveFactory = (patch: Partial<{ enabled: boolean; size: string; maxParallel: number; fallbackLocal: boolean }>) =>
  rest<FactoryState>('/api/aieditor/factory', patch);
const rebuildImage = () => rest<{ requested: boolean; state: string; message: string }>('/api/aieditor/factory/image', {});

export const usd = (x: number) => `$${x.toFixed(2)}`;

export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function when(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const PHASE: Record<string, string> = {
  creating: 'creating server…',
  sending: 'sending job',
  running: 'running',
  pulling: 'results back',
  done: 'done',
  failed: 'failed',
};

const ACTION: Record<string, string> = {
  run: 'Cut run',
  render: 'Preview render',
  final: 'Final render',
  edit: 'Full edit',
  image: 'Image build',
};

const OPEN_KEY = 'autoEditor.factoryOpen';

export function FactoryPanel() {
  const [data, setData] = useState<FactoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [allRuns, setAllRuns] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const load = useCallback(async () => {
    try {
      setData(await getFactory());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const busy = !!data && (data.live.length > 0 || data.image.state === 'building' || data.image.requested);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), busy ? 5000 : 30000);
    return () => clearInterval(t);
  }, [load, busy]);
  // the live servers' clocks + $ tick between polls
  useEffect(() => {
    if (!data?.live.length) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [data?.live.length]);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  };

  const save = async (patch: Parameters<typeof saveFactory>[0]) => {
    setSaving(true);
    try {
      setData(await saveFactory(patch));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const rebuild = async () => {
    try {
      const r = await rebuildImage();
      if (r.requested) toast.success(r.message);
      else toast.info(r.message);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (!data) {
    return (
      <div className="rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        {error ? <span className="text-red-400">Video factory: {error}</span> : 'Video factory …'}
      </div>
    );
  }

  const s = data.settings;
  const size = data.sizes.find((x) => x.id === s.size);
  const liveNow = data.live.map((l) => {
    const secs = l.created ? Math.max(0, now - l.created) : l.elapsedMin * 60;
    return { ...l, secs, est: (secs / 3600) * l.priceHourly };
  });
  const liveUsd = liveNow.reduce((a, l) => a + l.est, 0);
  const total = data.month.volumeUsd + data.month.serverUsd + liveUsd;
  const leftovers = (data.doTagged ?? []).filter((d) => d.leftover);
  const stale = data.live.filter((l) => l.stale);
  const noImage = !data.snapshot.id;
  const warnings: string[] = [];
  if (!data.tokenSet) warnings.push('No DigitalOcean token — add DO_API_TOKEN under Settings → Video factory. Until then every job runs on the main box.');
  if (noImage) warnings.push('No server image yet — build one before switching the factory on.');
  for (const d of leftovers) {
    warnings.push(
      `DigitalOcean is billing a factory server with no job attached: ${d.name} (#${d.id}, ${d.size}, since ${when(Date.parse(d.created) / 1000)}). ` +
        'The host watchdog deletes it within 10 minutes — if it stays, delete it in the DigitalOcean console.',
    );
  }
  for (const l of stale) warnings.push(`Server #${l.droplet} (${l.title ?? l.job ?? '—'}) has not checked in for ${elapsed(now - (l.heartbeat ?? now))}.`);
  if (data.doError) warnings.push(`Could not ask DigitalOcean for its server list (${data.doError}) — costs below come from the host's own records.`);
  const runs = allRuns ? data.history : data.history.slice(0, 8);

  return (
    <div className={cn('rounded-lg border', open ? 'border-border bg-card' : 'border-border/60')}>
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center gap-x-2 px-3 py-1.5 text-left text-xs hover:bg-muted/30"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        <Server className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Video factory</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            s.enabled ? 'bg-green-500/15 text-green-400' : 'bg-muted text-muted-foreground',
          )}
        >
          {s.enabled ? 'On' : 'Off'}
        </span>
        <span className="hidden text-muted-foreground sm:inline">
          {s.size}
          {size ? ` · ${size.vcpu} vCPU` : ''}
        </span>
        {data.live.length > 0 && (
          <span className="flex items-center gap-1 text-blue-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
            {data.live.length} live
          </span>
        )}
        {warnings.length > 0 && <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {/* servers first: the $50 Volume is fixed, so the total alone hid what jobs cost */}
          <span className="text-foreground">{usd(data.month.serverUsd + liveUsd)}</span> servers
          <span className="hidden sm:inline"> + {usd(data.month.volumeUsd).replace('.00', '')} storage</span>
          {' · '}{usd(total)} / {usd(data.month.budgetUsd).replace('.00', '')}
          <span className="hidden sm:inline"> this month</span>
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-3 py-3">
          {warnings.length > 0 && (
            <div className="space-y-1">
              {warnings.map((w, i) => (
                <p key={i} className="flex gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          )}

          {/* ── settings ── */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <label className="flex items-start gap-2.5">
                <Switch checked={s.enabled} disabled={saving || (noImage && !s.enabled)} onCheckedChange={(v) => void save({ enabled: v })} />
                <span className="text-xs">
                  <span className="block text-foreground">Run heavy steps on a factory server</span>
                  <span className="block text-[10.5px] leading-snug text-muted-foreground">
                    Each job gets its own server, created from the image and deleted the moment the job ends. Off = everything
                    runs on the main box, one job at a time.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <Switch checked={s.fallbackLocal} disabled={saving} onCheckedChange={(v) => void save({ fallbackLocal: v })} />
                <span className="text-xs">
                  <span className="block text-foreground">If no server: run on the main box</span>
                  <span className="block text-[10.5px] leading-snug text-muted-foreground">
                    When DigitalOcean can't give a server, the job still runs (slower) instead of failing.
                  </span>
                </span>
              </label>
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">Server size</span>
                <div className="flex gap-1.5">
                  {data.sizes.map((z) => (
                    <button
                      key={z.id}
                      type="button"
                      disabled={saving}
                      onClick={() => z.id !== s.size && void save({ size: z.id })}
                      className={cn(
                        'flex-1 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                        s.size === z.id ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/40',
                      )}
                    >
                      <span className="block">
                        {z.id} · {z.vcpu} vCPU / {z.ramGb} GB
                      </span>
                      <span className="block text-[10px] text-muted-foreground">{usd(z.usdHour)}/h while it exists</span>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Measured on c-32: align 15× and preview 7× faster than the main box. A typical run costs cents.
                </p>
              </div>
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">Servers at once</span>
                <div className="flex gap-1.5">
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      type="button"
                      disabled={saving}
                      onClick={() => n !== s.maxParallel && void save({ maxParallel: n })}
                      className={cn(
                        'flex-1 rounded-md border px-2 py-1 text-xs transition-colors',
                        s.maxParallel === n ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/40',
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  More jobs run side by side; each server is capped at {s.maxHours} h.
                </p>
              </div>
            </div>
          </div>

          {/* ── live servers ── */}
          <div className="space-y-1.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">
              Live servers {data.worker.factoryJobs !== null && `· worker reports ${data.worker.factoryJobs}`}
              {data.doTagged && ` · DigitalOcean bills ${data.doTagged.length}`}
            </h3>
            {liveNow.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">None — nothing is being billed by the hour right now.</p>
            ) : (
              <div className="divide-y divide-border/60 rounded-md border border-border">
                {liveNow.map((l) => (
                  <div key={l.droplet} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1.5 text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                    {l.job ? (
                      <Link to={`/auto-editor/${l.job}`} className="min-w-0 max-w-[16rem] truncate text-foreground hover:underline">
                        {l.title ?? l.job}
                      </Link>
                    ) : (
                      <span className="text-foreground">{l.title ?? `#${l.droplet}`}</span>
                    )}
                    <span className="text-muted-foreground">{ACTION[l.action ?? ''] ?? l.action ?? '—'}</span>
                    <span className="text-blue-300">{PHASE[l.state ?? ''] ?? l.state ?? 'running'}</span>
                    <span className="ml-auto flex gap-3 tabular-nums text-muted-foreground">
                      <span>{l.size}</span>
                      <span>{elapsed(l.secs)}</span>
                      <span className="text-emerald-400">≈ ${l.est.toFixed(3)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── this month ── */}
          <div className="space-y-1">
            <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                This month: servers {usd(data.month.serverUsd)} ({data.month.runs} run{data.month.runs === 1 ? '' : 's'},{' '}
                {Math.round(data.month.minutes)} min){liveUsd > 0 ? ` + live ${usd(liveUsd)}` : ''} + storage {usd(data.month.volumeUsd)}
              </span>
              <span className="tabular-nums text-foreground">
                {usd(total)} / {usd(data.month.budgetUsd)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div
                className={cn('h-full transition-all', total > data.month.budgetUsd ? 'bg-red-500' : total > data.month.budgetUsd * 0.8 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${Math.min(100, (total / data.month.budgetUsd) * 100)}%` }}
              />
            </div>
          </div>

          {/* ── last runs ── */}
          <div className="space-y-1.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">Last runs</h3>
            {runs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No factory runs yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/30 text-left text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 font-normal">Job</th>
                      <th className="px-2 py-1 font-normal">Step</th>
                      <th className="hidden px-2 py-1 font-normal sm:table-cell">Started</th>
                      <th className="px-2 py-1 text-right font-normal">Min</th>
                      <th className="px-2 py-1 text-right font-normal">$</th>
                      <th className="px-2 py-1 font-normal">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {runs.map((r, i) => (
                      <tr key={`${r.droplet}-${i}`}>
                        <td className="max-w-[10rem] truncate px-2 py-1 text-foreground">
                          <Link to={`/auto-editor/${r.job}`} className="hover:underline">
                            {r.title}
                          </Link>
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {ACTION[r.action] ?? r.action} <span className="text-muted-foreground/60">{r.size}</span>
                        </td>
                        <td className="hidden px-2 py-1 text-muted-foreground sm:table-cell">{when(r.started)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{Number(r.minutes).toFixed(1)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-emerald-400">{Number(r.usd).toFixed(2)}</td>
                        <td className="px-2 py-1">
                          <span className={r.ok ? 'text-green-400' : 'text-red-400'}>{r.ok ? 'ok' : 'failed'}</span>
                          <span className={cn('ml-1.5', r.destroyed ? 'text-muted-foreground' : 'text-red-400')}>
                            {r.destroyed ? (
                              <Trash2 className="inline h-3 w-3" aria-label="server deleted" />
                            ) : (
                              'NOT deleted'
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.history.length > 8 && (
              <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setAllRuns(!allRuns)}>
                {allRuns ? 'Show fewer' : `Show all ${data.history.length}`}
              </button>
            )}
          </div>

          {/* ── server image ── */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="text-muted-foreground">
                Server image:{' '}
                {data.snapshot.name ? (
                  <>
                    <span className="text-foreground">{data.snapshot.name}</span> · built {when(data.snapshot.builtAt)}
                  </>
                ) : (
                  <span className="text-amber-400">none yet</span>
                )}
                {data.image.state === 'failed' && <span className="text-red-400"> · last rebuild failed</span>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                disabled={data.image.state === 'building' || data.image.requested}
                onClick={() => void rebuild()}
              >
                {data.image.state === 'building' || data.image.requested ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {data.image.state === 'building' ? 'Building…' : data.image.requested ? 'Requested — starts within 5 min' : 'Rebuild server image'}
              </Button>
            </div>
            <p className="text-[10px] leading-snug text-muted-foreground">
              The image holds the renderer, aligner, recorder and models (the code is sent fresh with every job). Rebuild it
              after those change — it uses a small builder server ($0.04/h) that is deleted when the snapshot is taken.
            </p>
            {data.image.error && data.image.state === 'failed' && (
              <p className="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-400">{data.image.error}</p>
            )}
            {data.image.log.length > 0 && (data.image.state === 'building' || data.image.state === 'failed') && (
              <pre className="max-h-40 overflow-auto rounded border border-border bg-black/30 px-2 py-1 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                {data.image.log.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
