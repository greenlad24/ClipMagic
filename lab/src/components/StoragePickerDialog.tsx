import { useState, useEffect, useCallback, useMemo } from 'react';
import { HardDrive, Loader2, Search, FolderOpen, CheckCircle2, AlertTriangle } from 'lucide-react';
import { listStorage } from 'zite-endpoints-sdk';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Mirrors the server's StorageItem shape (lab/server/src/zite/storage.ts). */
export interface StoredFile {
  category: 'uploads' | 'outputs' | 'tmp';
  name: string;
  id?: string;
  original?: string;
  mime?: string;
  size: number;
  mtime: number;
  url?: string;
  kind?: 'music' | 'promo' | 'narrator';
}

const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Whether multiple files can be picked at once. Single-select tools (Create,
   * Cutter, Meme) get a one-click "Use" row; Bulk gets checkboxes + a footer.
   */
  multiple?: boolean;
  /** Called with the chosen file(s). Each tool feeds these straight into its pipeline. */
  onSelect: (files: StoredFile[]) => void;
  title?: string;
  description?: string;
}

/**
 * Picks already-uploaded narration/source videos from server storage so a tool
 * can reuse them instead of re-uploading. Lists `narratorUploads` from
 * `listStorage` — the server already separates these from music/promo files, so
 * irrelevant categories never appear here. Selecting a file hands back its
 * existing serve URL (`/api/uploads/<id>`), which every pipeline resolves to the
 * same on-disk file a fresh upload would produce — no re-upload, no re-copy.
 */
export default function StoragePickerDialog({
  open, onClose, multiple = false, onSelect,
  title = 'Choose from storage',
  description = 'Reuse a narration video you already uploaded — no re-upload needed.',
}: Props) {
  const [items, setItems] = useState<StoredFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const keyOf = (it: StoredFile) => `${it.category}/${it.name}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res: any = await listStorage({});
      // narratorUploads = source narration videos only (not music / promo).
      const list: StoredFile[] = (res?.narratorUploads ?? []).filter((f: StoredFile) => f.url);
      setItems(list);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load your storage.');
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load fresh each time the picker opens; reset transient state on close.
  useEffect(() => {
    if (open) { load(); setPicked(new Set()); setQuery(''); }
  }, [open, load]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => (it.original || it.name).toLowerCase().includes(q));
  }, [items, query]);

  const togglePick = (it: StoredFile) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const k = keyOf(it);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  const confirmPicked = () => {
    if (!items) return;
    const chosen = items.filter((it) => picked.has(keyOf(it)));
    if (chosen.length === 0) return;
    onSelect(chosen);
    onClose();
  };

  const useOne = (it: StoredFile) => {
    onSelect([it]);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-primary" /> {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Search — only worth showing once the list is non-trivial. */}
        {items && items.length > 6 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name…"
              className="pl-8 h-9 text-sm"
            />
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
          {loading && (
            <div className="flex items-center justify-center py-14 text-muted-foreground gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading your files…
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertTriangle className="w-7 h-7 text-destructive" />
              <p className="text-sm text-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            </div>
          )}

          {!loading && !error && items && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <FolderOpen className="w-7 h-7 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No uploaded videos yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Upload a narration video first — it'll show up here for reuse next time.
              </p>
            </div>
          )}

          {!loading && !error && items && items.length > 0 && filtered.length === 0 && (
            <div className="py-12 text-center text-xs text-muted-foreground">
              No files match “{query}”.
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="divide-y divide-border/60">
              {filtered.map((it) => {
                const isPicked = picked.has(keyOf(it));
                return (
                  <div
                    key={keyOf(it)}
                    onClick={() => (multiple ? togglePick(it) : useOne(it))}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); multiple ? togglePick(it) : useOne(it); }
                    }}
                    className={`flex items-center gap-3 px-2 py-2.5 rounded-md cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isPicked ? 'bg-primary/10' : 'hover:bg-muted/40'
                    }`}
                  >
                    {multiple && (
                      <span
                        className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${
                          isPicked ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                        }`}
                        aria-hidden
                      >
                        {isPicked && <CheckCircle2 className="w-3 h-3" />}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{it.original || it.name}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">
                        {fmtBytes(it.size)} · {fmtDate(it.mtime)}
                      </p>
                    </div>
                    {!multiple && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" tabIndex={-1}>
                        Use this file
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {multiple && items && items.length > 0 && (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">
              {picked.size > 0 ? `${picked.size} selected` : 'Select one or more videos'}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" disabled={picked.size === 0} onClick={confirmPicked}>
                Add {picked.size > 0 ? picked.size : ''}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
