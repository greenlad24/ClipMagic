import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Trash2, HardDrive, Loader2, AlertTriangle, Download, Eraser,
  // area icons (resolved by name from the server registry)
  Video, Music, AudioLines, Film, Clapperboard, MonitorPlay, Image as ImageIcon, Type, Sticker,
  Database, FolderClock, UserSquare, Palette, Scissors, Sparkles, Chrome,
  FileVideo, Images, MessageSquare, GraduationCap, HelpCircle,
  // "outside The Lab" bucket icons
  Layers, Hammer, Boxes, Container,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { listStorage, deleteStorageFiles, deleteStorageArea, pruneSystemStorage } from 'zite-endpoints-sdk';

// Server-driven model — every card the UI renders comes from `areas` (see
// server/src/zite/storage.ts). The client never hard-codes the list of areas,
// so a new data/cache type shows up here automatically once it's registered.
interface StorageItem {
  category: string;
  name: string;
  id?: string;
  original?: string;
  mime?: string;
  size: number;
  mtime: number;
  url?: string;
  kind?: string;
}
interface StorageArea {
  key: string;
  category: string;
  label: string;
  hint: string;
  icon: string;
  group: 'content' | 'cache' | 'system';
  cache: boolean;
  danger: boolean;
  folderOnly: boolean;
  size: number;
  count: number;
  items: StorageItem[];
}
// One line of "what's on the disk that isn't ours" — Docker images, build cache,
// other services' volumes (see server/src/zite/systemStorage.ts).
interface SystemBucket {
  key: string;
  label: string;
  hint: string;
  icon: string;
  size: number;
  count: number;
  reclaimable: number;
  prune?: 'buildCache' | 'danglingImages';
}
interface StorageData {
  disk: { total: number; free: number; used: number } | null;
  totals: {
    all: number;              // The Lab's data volume
    cache: number;            // reclaimable inside it
    outside: number;          // disk used that isn't the data volume
    systemReclaimable: number;// prunable share of `outside`
    unattributed: number;     // outside, minus what Docker could account for
  };
  system: { available: boolean; reason?: string; buckets: SystemBucket[] };
  areas: StorageArea[];
}

// lucide icon lookup by the name the server sends; HardDrive is the fallback.
const ICONS: Record<string, LucideIcon> = {
  Video, Music, AudioLines, Film, Clapperboard, MonitorPlay, Image: ImageIcon, Type, Sticker,
  Database, FolderClock, UserSquare, Palette, Scissors, Sparkles, Chrome, HardDrive,
  FileVideo, Images, MessageSquare, GraduationCap, HelpCircle,
  Layers, Hammer, Boxes, Container,
};
const iconOf = (name: string): LucideIcon => ICONS[name] ?? HardDrive;

const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleString();
const keyOf = (it: StorageItem) => `${it.category}/${it.name}`;

const GROUPS: { group: 'content' | 'cache' | 'system'; title: string; blurb: string }[] = [
  { group: 'content', title: 'Your media', blurb: 'Uploads, ingests and finished renders. Deleting is per-file and permanent.' },
  { group: 'cache', title: 'Regenerable cache', blurb: 'Everything here is rebuilt on demand — safe to clear to reclaim space.' },
  { group: 'system', title: 'Counted, not deletable', blurb: 'Shown so the totals add up to the volume exactly. Nothing here can be removed from this page.' },
];

export default function StoragePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<StorageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Pending "Clear whole area" confirm: the cache area to wipe.
  const [clearArea, setClearArea] = useState<StorageArea | null>(null);
  const [clearing, setClearing] = useState(false);
  // Pending Docker prune: the "outside The Lab" bucket to reclaim.
  const [pruneTarget, setPruneTarget] = useState<SystemBucket | null>(null);
  const [pruning, setPruning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listStorage({});
      setData(res as StorageData);
      setSelected(new Set());
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load storage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const areas = data?.areas ?? [];
  const allItems: StorageItem[] = areas.flatMap((a) => a.items);
  const selectedItems = allItems.filter((it) => selected.has(keyOf(it)));
  const selectedBytes = selectedItems.reduce((s, it) => s + it.size, 0);
  const selectedHasContent = selectedItems.some((it) => {
    const a = areas.find((ar) => ar.items.some((i) => keyOf(i) === keyOf(it)));
    return a && !a.cache;
  });

  const toggle = (it: StorageItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(it);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };
  const toggleArea = (items: StorageItem[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSel = items.length > 0 && items.every((it) => next.has(keyOf(it)));
      for (const it of items) { allSel ? next.delete(keyOf(it)) : next.add(keyOf(it)); }
      return next;
    });
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      const items = selectedItems.map((it) => ({ category: it.category, name: it.name }));
      const res = await deleteStorageFiles({ items });
      toast.success(`Deleted ${res.deleted} file${res.deleted !== 1 ? 's' : ''} · freed ${fmtBytes(res.freed)}`);
      if (res.errors?.length) toast.error(`${res.errors.length} could not be deleted`);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  const doClearArea = async () => {
    if (!clearArea) return;
    setClearing(true);
    try {
      const res = await deleteStorageArea({ category: clearArea.category });
      if (res.errors?.length) {
        toast.error(res.errors[0] ?? 'Clear failed');
      } else {
        toast.success(`Cleared ${clearArea.label} · freed ${fmtBytes(res.freed)}`);
      }
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? 'Clear failed');
    } finally {
      setClearing(false);
      setClearArea(null);
    }
  };

  const doPrune = async () => {
    if (!pruneTarget) return;
    setPruning(true);
    try {
      const res = await pruneSystemStorage({ target: pruneTarget.prune });
      if (res.errors?.length) {
        toast.error(res.errors[0] ?? 'Prune failed');
      } else {
        toast.success(`Reclaimed ${fmtBytes(res.freed)} from ${pruneTarget.label.toLowerCase()}`);
      }
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? 'Prune failed');
    } finally {
      setPruning(false);
      setPruneTarget(null);
    }
  };

  const diskPct = data?.disk ? Math.min(100, Math.round((data.disk.used / data.disk.total) * 100)) : null;
  // Breakdown bars: only areas that actually consume space, biggest first.
  const breakdown = [...areas].filter((a) => a.size > 0).sort((a, b) => b.size - a.size);

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-3 sticky top-0 bg-background z-10">
        <div className="flex items-center gap-2.5">
          <button onClick={() => navigate('/')} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Home">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <HardDrive className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Storage</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button
            variant="destructive" size="sm" className="h-7 text-xs gap-1.5"
            disabled={selected.size === 0 || deleting}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete{selected.size > 0 ? ` ${selected.size} (${fmtBytes(selectedBytes)})` : ''}
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Disk free-space + full breakdown overview */}
        {data && (
          <div className="rounded-xl border border-border p-4 space-y-4">
            {data.disk ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">Disk</span>
                  <span className="text-muted-foreground font-mono">
                    {fmtBytes(data.disk.free)} free of {fmtBytes(data.disk.total)} · {fmtBytes(data.disk.used)} used
                  </span>
                </div>
                {/* The used bar, split into the two halves that used to be one
                    unexplained number: The Lab's own volume vs everything else
                    on the host (Docker, the OS, other services). */}
                <div className="h-2.5 bg-muted rounded-full overflow-hidden flex">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${(data.totals.all / data.disk.total) * 100}%` }}
                    title={`The Lab data: ${fmtBytes(data.totals.all)}`}
                  />
                  <div
                    className={`h-full ${diskPct! > 90 ? 'bg-destructive' : 'bg-amber-500'}`}
                    style={{ width: `${(data.totals.outside / data.disk.total) * 100}%` }}
                    title={`Outside The Lab: ${fmtBytes(data.totals.outside)}`}
                  />
                </div>
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                    The Lab data <span className="font-mono text-foreground">{fmtBytes(data.totals.all)}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${diskPct! > 90 ? 'bg-destructive' : 'bg-amber-500'}`} />
                    Everything else on this server <span className="font-mono text-foreground">{fmtBytes(data.totals.outside)}</span>
                  </span>
                </div>
                {diskPct! > 90 && (
                  <p className="text-[11px] text-destructive flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Disk nearly full — uploads and renders may fail.
                    {data.totals.systemReclaimable > data.totals.cache
                      ? ` Most of it isn't The Lab's — see "Everything else on this server" below, where ${fmtBytes(data.totals.systemReclaimable)} can be reclaimed.`
                      : ' Clear cache or delete unused media below.'}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Disk usage unavailable on this platform.</p>
            )}

            {/* Per-area breakdown of ClipMagic's whole footprint */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>The Lab data: <span className="font-mono text-foreground">{fmtBytes(data.totals.all)}</span></span>
                <span>Reclaimable cache: <span className="font-mono">{fmtBytes(data.totals.cache)}</span></span>
              </div>
              {breakdown.map((a) => {
                const pct = data.totals.all > 0 ? Math.round((a.size / data.totals.all) * 100) : 0;
                return (
                  <div key={a.key} className="flex items-center gap-2 text-[11px]">
                    <span className="w-44 shrink-0 truncate flex items-center gap-1">
                      {a.cache && <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" title="cache (safe to clear)" />}
                      {a.label}
                    </span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${a.cache ? 'bg-teal-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right font-mono text-muted-foreground">{fmtBytes(a.size)}</span>
                    <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{a.count}</span>
                  </div>
                );
              })}
              <p className="text-[10px] text-muted-foreground pt-1 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" /> = regenerable cache (safe to clear) · others are your content
              </p>
            </div>
          </div>
        )}

        {/* What's using the disk that ISN'T The Lab. Without this the page can
            only say "193 GB used, 14 GB of it mine" and leave you guessing. */}
        {data && data.totals.outside > 0 && (
          <div className="rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Everything else on this server
              </h2>
              <span className="text-[11px] text-muted-foreground font-mono">{fmtBytes(data.totals.outside)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground/80">
              The disk is shared with Docker and the rest of the stack, so "used" above is much larger than The Lab's own data.
              This is the rest of it — none of it is your media, and the biggest part is usually reclaimable.
            </p>

            {!data.system.available ? (
              <p className="text-[11px] text-muted-foreground">{data.system.reason}</p>
            ) : (
              <div className="space-y-2">
                {data.system.buckets.map((b) => {
                  const Icon = iconOf(b.icon);
                  return (
                    <div key={b.key} className="rounded-lg border border-border/60 px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span className="text-xs font-medium truncate">{b.label}</span>
                          <span className="text-[11px] text-muted-foreground font-mono shrink-0">{fmtBytes(b.size)}</span>
                        </div>
                        {b.prune && b.reclaimable > 0 && (
                          <Button
                            variant="outline" size="sm"
                            className="h-6 text-[11px] gap-1.5 shrink-0"
                            onClick={() => setPruneTarget(b)}
                            disabled={pruning}
                          >
                            <Eraser className="w-3 h-3" /> Reclaim {fmtBytes(b.reclaimable)}
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground/80">{b.hint}</p>
                    </div>
                  );
                })}
                {data.totals.unattributed > 0 && (
                  <p className="text-[10px] text-muted-foreground/70 pt-0.5">
                    A further {fmtBytes(data.totals.unattributed)} is the OS, logs and other files outside Docker — plus some slack,
                    because Docker counts layers shared between an image and the build cache twice.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {/* Grouped area cards */}
        {data && GROUPS.map(({ group, title, blurb }) => {
          const groupAreas = areas.filter((a) => a.group === group);
          if (groupAreas.length === 0) return null;
          return (
            <div key={group} className="space-y-3">
              <div className="px-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
                <p className="text-[11px] text-muted-foreground/80">{blurb}</p>
              </div>
              {groupAreas.map((a) => {
                const Icon = iconOf(a.icon);
                const allSel = a.items.length > 0 && a.items.every((it) => selected.has(keyOf(it)));
                return (
                  <div key={a.key} className="rounded-xl border border-border overflow-hidden">
                    <div className="px-4 py-3 bg-card/40 border-b border-border flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-semibold">{a.label}</span>
                        <span className="text-[11px] text-muted-foreground">{a.count} · {fmtBytes(a.size)}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {a.items.length > 0 && (
                          <button onClick={() => toggleArea(a.items)} className="text-[11px] text-primary hover:underline">
                            {allSel ? 'Deselect all' : 'Select all'}
                          </button>
                        )}
                        {a.cache && a.size > 0 && (
                          <button
                            onClick={() => setClearArea(a)}
                            className="text-[11px] text-destructive hover:underline flex items-center gap-1"
                            title="Wipe this whole cache area"
                          >
                            <Eraser className="w-3 h-3" /> Clear all
                          </button>
                        )}
                      </div>
                    </div>
                    <div className={`px-4 py-2 text-[11px] flex items-center gap-1.5 ${a.danger ? 'text-amber-500' : 'text-muted-foreground'}`}>
                      {a.danger && <AlertTriangle className="w-3 h-3 shrink-0" />} {a.hint}
                    </div>

                    {a.items.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                        {a.size > 0 ? 'Nested files — use “Clear all” to reclaim.' : 'Empty'}
                      </div>
                    ) : (
                      <div className="divide-y divide-border/60">
                        {a.items.map((it) => (
                          <div key={keyOf(it)} className="px-4 py-2 flex items-center gap-3 hover:bg-muted/30">
                            <input
                              type="checkbox"
                              checked={selected.has(keyOf(it))}
                              onChange={() => toggle(it)}
                              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium truncate">{it.original || it.name}</p>
                              <p className="text-[10px] text-muted-foreground font-mono truncate">
                                {fmtBytes(it.size)} · {fmtDate(it.mtime)}{it.mime ? ` · ${it.mime}` : ''}
                              </p>
                            </div>
                            {it.url && (
                              <a href={it.url} target="_blank" rel="noreferrer" className="p-1 text-muted-foreground hover:text-foreground shrink-0" title="Open / download">
                                <Download className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Per-file delete confirm */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} file{selected.size !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {selected.size} file{selected.size !== 1 ? 's' : ''} ({fmtBytes(selectedBytes)}) from the server.
              {selectedHasContent && ' Some are your media — any project using them will lose that file.'}
              {' '}This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); doDelete(); }}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete {fmtBytes(selectedBytes)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear-whole-cache-area confirm */}
      <AlertDialog open={!!clearArea} onOpenChange={(o) => !o && setClearArea(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear {clearArea?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This wipes the entire {clearArea?.label.toLowerCase()} ({clearArea?.count ?? 0} file{(clearArea?.count ?? 0) !== 1 ? 's' : ''}, {fmtBytes(clearArea?.size ?? 0)}).
              {clearArea?.danger
                ? ' No projects or uploads are affected, but this profile also holds a logged-in session — you will have to sign in again before the next run.'
                : ' It is pure cache — the app regenerates it on demand, so no projects or uploads are affected.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); doClearArea(); }}
              disabled={clearing}
            >
              {clearing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Clear {fmtBytes(clearArea?.size ?? 0)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Docker prune confirm — only ever offered for the two operations that
          cannot lose work: build cache, and untagged leftover images. */}
      <AlertDialog open={!!pruneTarget} onOpenChange={(o) => !o && setPruneTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reclaim {fmtBytes(pruneTarget?.reclaimable ?? 0)} from {pruneTarget?.label.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pruneTarget?.prune === 'buildCache'
                ? 'This clears Docker’s build cache. Nothing running is affected and no data is lost — the next image build just takes longer because it starts from scratch.'
                : 'This removes untagged leftover images that no container uses. Tagged images — including your backup-pre-* and candidate-* rollback points — are left alone.'}
              {' '}It runs on the server and may take a minute.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pruning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); doPrune(); }}
              disabled={pruning}
            >
              {pruning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Reclaim {fmtBytes(pruneTarget?.reclaimable ?? 0)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
