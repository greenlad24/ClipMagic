import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Trash2, HardDrive, Film, Upload, Database, Loader2,
  AlertTriangle, Download, Sticker, FolderClock, Chrome, Eraser,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { listStorage, deleteStorageFiles, deleteStorageArea } from 'zite-endpoints-sdk';

type Category = 'uploads' | 'outputs' | 'tmp' | 'stickers' | 'chunked' | 'remotionChromium';
interface StorageItem {
  category: Category;
  name: string;
  id?: string;
  original?: string;
  mime?: string;
  size: number;
  mtime: number;
  url?: string;
  kind?: 'music' | 'promo' | 'narrator';
}
interface StorageArea {
  category: Category;
  label: string;
  size: number;
  count: number;
  cache: boolean;
}
interface StorageData {
  uploads: StorageItem[];
  narratorUploads: StorageItem[];
  musicUploads: StorageItem[];
  promoUploads: StorageItem[];
  outputs: StorageItem[];
  tmp: StorageItem[];
  stickers: StorageItem[];
  chunked: StorageItem[];
  breakdown: StorageArea[];
  totals: {
    uploads: number; narrator: number; music: number; promo: number;
    outputs: number; tmp: number; stickers: number; chunked: number;
    remotionChromium: number; all: number;
  };
  disk: { total: number; free: number; used: number } | null;
  counts: Record<string, number>;
}

const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleString();
const keyOf = (it: StorageItem) => `${it.category}/${it.name}`;

// File-listing sections.
//   dataKey  = which array in StorageData to render
//   cat      = delete category sent to the server (upload groups all delete as "uploads")
//   totalKey = totals field for the header byte count
//   cache    = pure cache area → show a "Clear all" button (server: deleteStorageArea)
//   areaCat  = category passed to deleteStorageArea for the Clear action (cache only)
const SECTIONS: {
  dataKey: 'outputs' | 'narratorUploads' | 'musicUploads' | 'promoUploads' | 'tmp' | 'stickers' | 'chunked';
  totalKey: keyof StorageData['totals'];
  cat: Category;
  areaCat?: Category;
  cache?: boolean;
  label: string;
  icon: typeof Film;
  hint: string;
  danger?: boolean;
}[] = [
  { dataKey: 'outputs', totalKey: 'outputs', cat: 'outputs', label: 'Render outputs', icon: Film, hint: 'Finished export videos. Safe to delete — you can re-export.' },
  { dataKey: 'narratorUploads', totalKey: 'narrator', cat: 'uploads', label: 'Narrator videos', icon: Upload, hint: 'Source narration videos you uploaded (not music or promo). Deleting one breaks any project that uses it.', danger: true },
  { dataKey: 'musicUploads', totalKey: 'music', cat: 'uploads', label: 'Background music', icon: Database, hint: 'Music tracks in your library. Deleting one removes it from projects using it.', danger: true },
  { dataKey: 'promoUploads', totalKey: 'promo', cat: 'uploads', label: 'Promo videos', icon: Film, hint: 'Promo-library videos. Deleting one removes it from the AI director\'s footage pool.', danger: true },
  { dataKey: 'stickers', totalKey: 'stickers', cat: 'stickers', areaCat: 'stickers', cache: true, label: 'Sticker image cache', icon: Sticker, hint: 'Generated / fetched sticker images. Pure cache — regenerated on demand.' },
  { dataKey: 'tmp', totalKey: 'tmp', cat: 'tmp', areaCat: 'tmp', cache: true, label: 'Download cache', icon: Database, hint: 'Cached remote downloads. Always safe — re-fetched on demand.' },
  { dataKey: 'chunked', totalKey: 'chunked', cat: 'chunked', areaCat: 'chunked', cache: true, label: 'Chunked-upload temp', icon: FolderClock, hint: 'In-progress / abandoned resumable-upload parts. Safe to clear once uploads finish.' },
];

// The Chromium cache is folder-only (no per-file list) — surfaced as a Clear-only card.
const CHROMIUM = {
  totalKey: 'remotionChromium' as const,
  areaCat: 'remotionChromium' as Category,
  label: 'Remotion Chromium cache',
  icon: Chrome,
  hint: 'A Chromium browser Remotion may have downloaded. Not used in production (Chromium is pre-baked), so always safe to clear.',
};

export default function StoragePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<StorageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Pending "Clear whole area" confirm: the cache area + its label/size.
  const [clearArea, setClearArea] = useState<{ cat: Category; label: string; size: number; count: number } | null>(null);
  const [clearing, setClearing] = useState(false);

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

  const allItems: StorageItem[] = data
    ? [...data.outputs, ...data.narratorUploads, ...data.musicUploads, ...data.promoUploads,
       ...data.stickers, ...data.tmp, ...data.chunked]
    : [];
  const selectedItems = allItems.filter((it) => selected.has(keyOf(it)));
  const selectedBytes = selectedItems.reduce((s, it) => s + it.size, 0);

  const toggle = (it: StorageItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(it);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };
  const toggleCategory = (items: StorageItem[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSel = items.every((it) => next.has(keyOf(it)));
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
      const res = await deleteStorageArea({ category: clearArea.cat });
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

  const diskPct = data?.disk ? Math.min(100, Math.round((data.disk.used / data.disk.total) * 100)) : null;
  const cacheTotal = data ? data.totals.stickers + data.totals.tmp + data.totals.chunked + data.totals.remotionChromium : 0;

  // Color helper for the area-breakdown bars (cache = muted teal, content = primary).
  const barColor = (a: StorageArea) => (a.cache ? 'bg-teal-500' : 'bg-primary');

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
        {/* Disk free-space + breakdown overview */}
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
                <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${diskPct! > 90 ? 'bg-destructive' : diskPct! > 75 ? 'bg-amber-500' : 'bg-primary'}`}
                    style={{ width: `${diskPct}%` }}
                  />
                </div>
                {diskPct! > 90 && (
                  <p className="text-[11px] text-destructive flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> Disk nearly full — uploads and renders may fail. Clear cache or delete unused media below.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Disk usage unavailable on this platform.</p>
            )}

            {/* Per-area breakdown of ClipMagic's footprint */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>ClipMagic data: <span className="font-mono text-foreground">{fmtBytes(data.totals.all)}</span></span>
                <span>Reclaimable cache: <span className="font-mono">{fmtBytes(cacheTotal)}</span></span>
              </div>
              {data.breakdown.map((a) => {
                const pct = data.totals.all > 0 ? Math.round((a.size / data.totals.all) * 100) : 0;
                return (
                  <div key={a.category} className="flex items-center gap-2 text-[11px]">
                    <span className="w-40 shrink-0 truncate flex items-center gap-1">
                      {a.cache && <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0" title="cache (safe to clear)" />}
                      {a.label}
                    </span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barColor(a)}`} style={{ width: `${pct}%` }} />
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

        {loading && !data && (
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {data && SECTIONS.map(({ dataKey, totalKey, label, icon: Icon, hint, danger, cache, areaCat }) => {
          const items = data[dataKey];
          const total = data.totals[totalKey];
          const count = (data.counts[totalKey as string] ?? items.length);
          const allSel = items.length > 0 && items.every((it) => selected.has(keyOf(it)));
          return (
            <div key={dataKey} className="rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 bg-card/40 border-b border-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold">{label}</span>
                  <span className="text-[11px] text-muted-foreground">{count} · {fmtBytes(total)}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {items.length > 0 && (
                    <button onClick={() => toggleCategory(items)} className="text-[11px] text-primary hover:underline">
                      {allSel ? 'Deselect all' : 'Select all'}
                    </button>
                  )}
                  {cache && areaCat && total > 0 && (
                    <button
                      onClick={() => setClearArea({ cat: areaCat, label, size: total, count })}
                      className="text-[11px] text-destructive hover:underline flex items-center gap-1"
                      title="Wipe this whole cache area"
                    >
                      <Eraser className="w-3 h-3" /> Clear all
                    </button>
                  )}
                </div>
              </div>
              <div className={`px-4 py-2 text-[11px] flex items-center gap-1.5 ${danger ? 'text-amber-500' : 'text-muted-foreground'}`}>
                {danger && <AlertTriangle className="w-3 h-3 shrink-0" />} {hint}
              </div>

              {items.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {total > 0 ? 'Nested files — use “Clear all” to reclaim.' : 'Empty'}
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {items.map((it) => (
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

        {/* Remotion Chromium cache — folder only, Clear-only card */}
        {data && (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-3 bg-card/40 border-b border-border flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <CHROMIUM.icon className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-semibold">{CHROMIUM.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {data.counts.remotionChromium ?? 0} · {fmtBytes(data.totals.remotionChromium)}
                </span>
              </div>
              {data.totals.remotionChromium > 0 && (
                <button
                  onClick={() => setClearArea({ cat: CHROMIUM.areaCat, label: CHROMIUM.label, size: data.totals.remotionChromium, count: data.counts.remotionChromium ?? 0 })}
                  className="text-[11px] text-destructive hover:underline flex items-center gap-1 shrink-0"
                >
                  <Eraser className="w-3 h-3" /> Clear all
                </button>
              )}
            </div>
            <div className="px-4 py-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
              {CHROMIUM.hint}
            </div>
            {data.totals.remotionChromium === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">Empty</div>
            )}
          </div>
        )}
      </div>

      {/* Per-file delete confirm */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.size} file{selected.size !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {selected.size} file{selected.size !== 1 ? 's' : ''} ({fmtBytes(selectedBytes)}) from the server.
              {selectedItems.some((it) => it.category === 'uploads') && ' Some are uploads — any project using them will lose that media.'}
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
              {' '}It is pure cache — the app regenerates it on demand, so no projects or uploads are affected.
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
    </div>
  );
}
