import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Trash2, HardDrive, Film, Upload, Database, Loader2, AlertTriangle, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { listStorage, deleteStorageFiles } from 'zite-endpoints-sdk';

type Category = 'uploads' | 'outputs' | 'tmp';
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
interface StorageData {
  uploads: StorageItem[];
  narratorUploads: StorageItem[];
  musicUploads: StorageItem[];
  promoUploads: StorageItem[];
  outputs: StorageItem[];
  tmp: StorageItem[];
  totals: { uploads: number; narrator: number; music: number; promo: number; outputs: number; tmp: number; all: number };
  disk: { total: number; free: number } | null;
  counts: { uploads: number; narrator: number; music: number; promo: number; outputs: number; tmp: number };
}

const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleString();
const keyOf = (it: StorageItem) => `${it.category}/${it.name}`;

// dataKey = which array in StorageData to render; cat = delete category sent to
// the server (all upload groups delete as "uploads"); totalKey = totals field.
const SECTIONS: {
  dataKey: 'outputs' | 'narratorUploads' | 'musicUploads' | 'promoUploads' | 'tmp';
  totalKey: keyof StorageData['totals'];
  cat: Category;
  label: string;
  icon: typeof Film;
  hint: string;
  danger?: boolean;
}[] = [
  { dataKey: 'outputs', totalKey: 'outputs', cat: 'outputs', label: 'Renders', icon: Film, hint: 'Finished export videos. Safe to delete — you can re-export.' },
  { dataKey: 'narratorUploads', totalKey: 'narrator', cat: 'uploads', label: 'Narrator videos', icon: Upload, hint: 'Source narration videos you uploaded (not music or promo). Deleting one breaks any project that uses it.', danger: true },
  { dataKey: 'musicUploads', totalKey: 'music', cat: 'uploads', label: 'Background music', icon: Database, hint: 'Music tracks in your library. Deleting one removes it from projects using it.', danger: true },
  { dataKey: 'promoUploads', totalKey: 'promo', cat: 'uploads', label: 'Promo videos', icon: Film, hint: 'Promo-library videos. Deleting one removes it from the AI director\'s footage pool.', danger: true },
  { dataKey: 'tmp', totalKey: 'tmp', cat: 'tmp', label: 'Download cache', icon: Database, hint: 'Cached remote downloads. Always safe — re-fetched on demand.' },
];

export default function StoragePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<StorageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    ? [...data.outputs, ...data.narratorUploads, ...data.musicUploads, ...data.promoUploads, ...data.tmp]
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

  const diskPct = data?.disk ? Math.min(100, Math.round(((data.disk.total - data.disk.free) / data.disk.total) * 100)) : null;

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
        {/* Disk usage */}
        {data?.disk && (
          <div className="rounded-xl border border-border p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">Disk</span>
              <span className="text-muted-foreground font-mono">
                {fmtBytes(data.disk.total - data.disk.free)} used · {fmtBytes(data.disk.free)} free of {fmtBytes(data.disk.total)}
              </span>
            </div>
            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${diskPct! > 90 ? 'bg-destructive' : diskPct! > 75 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${diskPct}%` }} />
            </div>
            <div className="text-[11px] text-muted-foreground">
              ClipMagic data: {fmtBytes(data.totals.all)} ({fmtBytes(data.totals.outputs)} renders · {fmtBytes(data.totals.narrator)} narrator · {fmtBytes(data.totals.music)} music · {fmtBytes(data.totals.promo)} promo · {fmtBytes(data.totals.tmp)} cache)
            </div>
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {data && SECTIONS.map(({ dataKey, totalKey, label, icon: Icon, hint, danger }) => {
          const items = data[dataKey];
          const total = data.totals[totalKey];
          const allSel = items.length > 0 && items.every((it) => selected.has(keyOf(it)));
          return (
            <div key={dataKey} className="rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 bg-card/40 border-b border-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold">{label}</span>
                  <span className="text-[11px] text-muted-foreground">{items.length} · {fmtBytes(total)}</span>
                </div>
                {items.length > 0 && (
                  <button onClick={() => toggleCategory(items)} className="text-[11px] text-primary hover:underline shrink-0">
                    {allSel ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>
              <div className={`px-4 py-2 text-[11px] flex items-center gap-1.5 ${danger ? 'text-amber-500' : 'text-muted-foreground'}`}>
                {danger && <AlertTriangle className="w-3 h-3 shrink-0" />} {hint}
              </div>

              {items.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">No files</div>
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
      </div>

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
    </div>
  );
}
