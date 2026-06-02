import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { uploadFile } from 'zite-file-upload-sdk';
import {
  getPromoVideos,
  savePromoVideo,
  deletePromoVideo,
  updatePromoVideo,
  indexPromoVideo,
  importPromoIndex,
  reindexAllPromos,
  getReindexProgress,
  getPromoIndex,
  exportPromoIndexes,
} from 'zite-endpoints-sdk';
import { GetPromoVideosOutputType } from 'zite-endpoints-sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Trash2, Film, Upload, Loader2, Play, Pause, Video,
  Sparkles, Pencil, X, Check, Clock, RefreshCw, Database, Eye, Download,
} from 'lucide-react';

type PromoVideo = GetPromoVideosOutputType['videos'][0];

interface UploadItem {
  file: File;
  status: 'queued' | 'trimming' | 'uploading' | 'generating' | 'done' | 'error';
  errorMsg?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

// ─── Video thumbnail ─────────────────────────────────────────────────────────
function VideoThumbnail({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const toggle = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); }
    else { videoRef.current.play(); setPlaying(true); }
  };

  return (
    <div
      className="relative w-12 h-12 rounded-lg overflow-hidden bg-muted cursor-pointer shrink-0 group"
      onClick={toggle}
    >
      {url ? (
        <>
          <video
            ref={videoRef}
            src={url}
            className="w-full h-full object-cover"
            muted loop playsInline
            onLoadedData={() => setLoaded(true)}
            onEnded={() => setPlaying(false)}
          />
          {loaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
              {playing
                ? <Pause className="w-3 h-3 text-white" />
                : <Play className="w-3 h-3 text-white" />}
            </div>
          )}
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Video className="w-5 h-5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

// ─── Video card ───────────────────────────────────────────────────────────────
function IndexBadge({ status, segmentCount }: { status?: string; segmentCount?: number }) {
  if (!status || status === 'Pending') return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60 bg-muted rounded px-1.5 py-0.5">
      <Clock className="w-2.5 h-2.5" /> Not indexed
    </span>
  );
  if (status === 'Indexing') return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-primary bg-primary/10 rounded px-1.5 py-0.5">
      <Loader2 className="w-2.5 h-2.5 animate-spin" /> Indexing…
    </span>
  );
  if (status === 'Indexed') return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 bg-green-500/10 rounded px-1.5 py-0.5">
      <Database className="w-2.5 h-2.5" /> {segmentCount ?? '?'} segments
    </span>
  );
  if (status === 'Fallback') return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 bg-amber-500/10 rounded px-1.5 py-0.5">
      <Database className="w-2.5 h-2.5" /> Fallback ({segmentCount ?? '?'})
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-destructive bg-destructive/10 rounded px-1.5 py-0.5">
      <X className="w-2.5 h-2.5" /> Error
    </span>
  );
}

function VideoCard({
  video,
  isGenerating,
  onDelete,
  onSave,
  onReindex,
  onView,
}: {
  video: PromoVideo;
  isGenerating: boolean;
  onDelete: (v: PromoVideo) => void;
  onSave: (id: string, patch: { productName: string; keywords: string; description: string }) => Promise<void>;
  onReindex: (v: PromoVideo) => void;
  onView: (v: PromoVideo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(video.productName ?? '');
  const [kw, setKw] = useState(video.keywords ?? '');
  const [desc, setDesc] = useState(video.description ?? '');

  // Sync local state if parent updates the video (e.g. after AI generation)
  useEffect(() => {
    if (!editing) {
      setName(video.productName ?? '');
      setKw(video.keywords ?? '');
      setDesc(video.description ?? '');
    }
  }, [video, editing]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(video.id, { productName: name, keywords: kw, description: desc });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setName(video.productName ?? '');
    setKw(video.keywords ?? '');
    setDesc(video.description ?? '');
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="p-3 bg-muted/60 rounded-xl border-2 border-primary/40 space-y-2">
        <div className="flex items-start gap-3">
          <VideoThumbnail url={video.videoUrl ?? ''} />
          <div className="flex-1 space-y-1.5 min-w-0">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Product / Brand name"
              className="h-7 text-sm font-medium"
              disabled={saving}
            />
            <Input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="Keywords (comma-separated)"
              className="h-7 text-xs"
              disabled={saving}
            />
            <Input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Description for AI Director"
              className="h-7 text-xs italic"
              disabled={saving}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleCancel} disabled={saving}>
            <X className="w-3 h-3 mr-1" /> Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Check className="w-3 h-3 mr-1" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 p-2.5 bg-muted/60 rounded-xl border border-border/40 group">
      <VideoThumbnail url={video.videoUrl ?? ''} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-foreground truncate">{video.productName || '(unnamed)'}</p>
          <button
            onClick={() => setEditing(true)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          >
            <Pencil className="w-3 h-3" />
          </button>
        </div>

        {isGenerating && !video.keywords ? (
          <div className="flex items-center gap-1.5 mt-1">
            <Loader2 className="w-2.5 h-2.5 animate-spin text-muted-foreground shrink-0" />
            <Skeleton className="h-3 w-40 rounded" />
          </div>
        ) : video.keywords ? (
          <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5 shrink-0 text-primary/60" />
            {video.keywords}
          </p>
        ) : null}

        {video.description && (
          <p className="text-xs text-muted-foreground/70 truncate italic">{video.description}</p>
        )}
        <div className="flex items-center gap-1.5 mt-0.5">
          <IndexBadge status={(video as any).indexStatus} segmentCount={(video as any).segmentCount} />
        </div>
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <Button
          variant="ghost" size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onView(video)}
          title="View what the AI sees each second"
        >
          <Eye className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost" size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onReindex(video)}
          title="Reindex segments"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost" size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => onDelete(video)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Upload queue item ────────────────────────────────────────────────────────
function QueueItem({ item }: { item: UploadItem }) {
  const icons: Record<UploadItem['status'], React.ReactNode> = {
    queued:     <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />,
    trimming:   <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin shrink-0" />,
    uploading:  <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />,
    generating: <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse shrink-0" />,
    done:       <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />,
    error:      <X className="w-3.5 h-3.5 text-destructive shrink-0" />,
  };
  const labels: Record<UploadItem['status'], string> = {
    queued:     'Queued',
    trimming:   'Clipping to 15 MB…',
    uploading:  'Uploading…',
    generating: 'AI generating…',
    done:       'Done',
    error:      item.errorMsg ?? 'Error',
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-muted/60 rounded-lg">
      {icons[item.status]}
      <span className="text-sm text-foreground flex-1 truncate">{item.file.name}</span>
      <span className={`text-xs shrink-0 ${item.status === 'error' ? 'text-destructive' : item.status === 'done' ? 'text-green-500' : 'text-muted-foreground'}`}>
        {labels[item.status]}
      </span>
    </div>
  );
}

// ─── Index viewer (what the AI sees each second) ───────────────────────────────
function IndexViewer({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await getPromoIndex({ videoId });
        if (alive) setData(d);
      } catch {
        if (alive) setData({ error: true });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [videoId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-card border-border max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary" />
            {data?.productName ?? 'Vision index'}
            {data?.mediaKind && (
              <span className="text-[10px] uppercase tracking-wide bg-primary/10 text-primary rounded px-1.5 py-0.5">
                {data.mediaKind.replace('_', ' ')}
              </span>
            )}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            What the AI director sees — {data?.mode === 'vision' ? 'real frame analysis' : data?.mode ?? '…'}.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {loading && <p className="text-sm text-muted-foreground py-4">Loading index…</p>}
          {!loading && data?.error && <p className="text-sm text-destructive py-4">Could not load index.</p>}

          {!loading && !data?.error && (
            <>
              {/* Segments */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">Segments ({data.segments?.length ?? 0})</h4>
                <div className="space-y-1">
                  {(data.segments ?? []).map((s: any, i: number) => (
                    <div key={i} className="text-xs bg-muted/50 rounded px-2 py-1.5">
                      <span className="font-mono text-muted-foreground">
                        {Number(s.start).toFixed(1)}–{Number(s.end).toFixed(1)}s
                      </span>{' '}
                      <span className="text-foreground">{s.summary}</span>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {s.featureLabel ? `feature: ${s.featureLabel} · ` : ''}
                        {s.visualType ? `${s.visualType} · ` : ''}
                        hero {s.heroScore ?? 0} · proof {s.proofScore ?? 0}
                        {Array.isArray(s.keywords) && s.keywords.length ? ` · ${s.keywords.slice(0, 6).join(', ')}` : ''}
                      </div>
                    </div>
                  ))}
                  {(!data.segments || data.segments.length === 0) && (
                    <p className="text-xs text-muted-foreground">No segments.</p>
                  )}
                </div>
              </div>

              {/* Per-second */}
              <div>
                <h4 className="text-xs font-semibold text-foreground mb-1.5">
                  Per-second ({data.perSecond?.length ?? 0})
                </h4>
                {data.perSecond?.length ? (
                  <div className="grid grid-cols-1 gap-0.5">
                    {data.perSecond.map((p: any, i: number) => (
                      <div key={i} className="text-xs flex gap-2 px-2 py-1 odd:bg-muted/30 rounded">
                        <span className="font-mono text-muted-foreground w-10 shrink-0">{p.t}s</span>
                        <span className="text-foreground">{p.caption}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No per-second data (this video used the fallback index — reindex it for vision detail).
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────
export default function PromoVideosDialog({ open, onClose }: Props) {
  const [videos, setVideos] = useState<PromoVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [pendingKeywords, setPendingKeywords] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [visionIndexing, setVisionIndexing] = useState(false);
  const [viewIndexId, setViewIndexId] = useState<string | null>(null);
  // Live re-index progress (polled while a bulk re-index runs).
  interface ReindexProg { running: boolean; total: number; done: number; indexed: number; failed: number; current: string | null; errors: Array<{ name: string; message: string }>; }
  const [reindexProg, setReindexProg] = useState<ReindexProg | null>(null);
  const reindexPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  // Vision-(re)index the whole library: extract 1 frame/sec from each promo and
  // have the AI describe what's on screen each second (cached per video, reused
  // on every render). Runs in the BACKGROUND on the server — this returns fast;
  // each video flips to "Indexing" then "Indexed". Re-open the dialog (or it
  // reloads) to see updated statuses.
  // Poll the backend for live re-index progress; stops itself when finished.
  const startReindexPolling = useCallback(() => {
    if (reindexPoll.current) return;
    const tick = async () => {
      try {
        const p = await getReindexProgress({});
        setReindexProg(p);
        if (!p.running) {
          if (reindexPoll.current) { clearInterval(reindexPoll.current); reindexPoll.current = null; }
          setVisionIndexing(false);
          await reload();
          if ((p.failed ?? 0) > 0) toast.warning(`Re-index finished: ${p.indexed} indexed, ${p.failed} failed.`);
          else if ((p.total ?? 0) > 0) toast.success(`Re-index complete: ${p.indexed} videos indexed.`);
          // Offer the full index JSON for review as soon as it's done.
          if ((p.total ?? 0) > 0) {
            try {
              const data = await exportPromoIndexes({});
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `promo-indexes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 10000);
              toast.success('Index JSON downloaded — paste it for review.');
            } catch { /* user can still use the Export button */ }
          }
          // Clear the bar a few seconds after completion.
          setTimeout(() => setReindexProg(null), 6000);
        }
      } catch { /* keep polling */ }
    };
    reindexPoll.current = setInterval(tick, 1500);
    tick();
  }, []);

  useEffect(() => () => { if (reindexPoll.current) clearInterval(reindexPoll.current); }, []);

  const handleVisionIndexAll = async (force = false) => {
    if (visionIndexing) return;
    // Default: index only videos that are NOT already at the latest standard
    // (and that have a video). Hold Shift / use "Force" to re-do everything.
    const ok = window.confirm(
      force
        ? 'FORCE re-index ALL promo videos (including ones already up-to-date)? Re-watches every video at 1 frame/sec — slower and uses more API.'
        : 'Index promo videos that aren\'t up-to-date yet? Videos already indexed to the latest standard are skipped. Runs in the background.'
    );
    if (!ok) return;
    setVisionIndexing(true);
    try {
      const res = await reindexAllPromos({ force });
      if (res.upToDate) {
        const extra = res.skippedNoVideo ? ` (${res.skippedNoVideo} have no video to index)` : '';
        toast.success(`All ${res.skippedCurrent ?? 0} promo videos are already indexed to the latest standard — nothing to re-index${extra}.`);
        setVisionIndexing(false);
        return;
      }
      if (res.started === false) {
        toast.info('Re-indexing is already running — showing live progress.');
      } else {
        const skipMsg = res.skippedCurrent ? ` (${res.skippedCurrent} already up-to-date, skipped)` : '';
        toast.success(`Re-indexing ${res.queued} promo video${res.queued !== 1 ? 's' : ''}${skipMsg}.`);
      }
      startReindexPolling();
    } catch (e: any) {
      toast.error('Re-indexing failed — ' + (e?.message?.slice(0, 120) ?? 'unknown error'));
      setVisionIndexing(false);
    }
  };

  // Download the FULL raw index JSON for all promos (for review).
  const [exporting, setExporting] = useState(false);
  const handleExportIndexes = async () => {
    setExporting(true);
    try {
      const data = await exportPromoIndexes({});
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `promo-indexes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast.success(`Exported ${data.count ?? 0} promo indexes.`);
    } catch (e: any) {
      toast.error('Export failed — ' + (e?.message?.slice(0, 120) ?? 'unknown error'));
    } finally {
      setExporting(false);
    }
  };

  const reload = async () => {
    setLoading(true);
    try {
      const { videos: v } = await getPromoVideos({});
      setVideos(v);
    } catch {
      toast.error('Failed to load promo videos');
    } finally {
      setLoading(false);
    }
  };

  // Bulk-import a metadata index JSON. path_lower / downloadUrl are used only to
  // match entries to videos already in the library and are NOT stored.
  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        toast.error('That file is not valid JSON');
        return;
      }
      const res = await importPromoIndex(parsed as any);
      toast.success(`Imported index — ${res.updated} updated, ${res.created} added (${res.total} entries)`);
      await reload();
    } catch (e: any) {
      toast.error('Import failed — ' + (e?.message?.slice(0, 120) ?? 'unknown error'));
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => { if (open) reload(); }, [open]);
  // If a bulk re-index is already running when the dialog opens, resume the bar.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const p = await getReindexProgress({});
        if (p.running) { setReindexProg(p); setVisionIndexing(true); startReindexPolling(); }
      } catch { /* */ }
    })();
  }, [open, startReindexPolling]);

  const CLIP_THRESHOLD_BYTES = 25 * 1024 * 1024;  // files over 25 MB get clipped
  const CHUNK_SIZE_BYTES     = 15 * 1024 * 1024;  // keep only the first 15 MB chunk

  const updateQueueItem = (index: number, patch: Partial<UploadItem>) =>
    setQueue((q) => q.map((item, i) => i === index ? { ...item, ...patch } : item));

  // Use a ref-based work list so new files added mid-flight still get processed
  const pendingFilesRef = useRef<{ file: File; index: number }[]>([]);

  const processNextInQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (pendingFilesRef.current.length > 0) {
      const next = pendingFilesRef.current.shift();
      if (!next) break;
      const { file, index } = next;

      try {
        // Files > 25 MB: clip to the first 15 MB chunk before uploading
        let uploadTarget: File = file;
        if (file.size > CLIP_THRESHOLD_BYTES) {
          updateQueueItem(index, { status: 'trimming' });
          // Yield so the UI can repaint before the synchronous slice
          await new Promise((r) => setTimeout(r, 50));
          const sliced = file.slice(0, CHUNK_SIZE_BYTES, file.type || 'video/mp4');
          uploadTarget = new File([sliced], file.name, { type: file.type || 'video/mp4' });
        }

        updateQueueItem(index, { status: 'uploading' });
        // Upload via Zite file storage SDK (handles auth + storage automatically)
        let videoUrl: string;
        try {
          const { fileUrl } = await uploadFile({ data: uploadTarget, filename: file.name });
          videoUrl = fileUrl;
        } catch (uploadErr: any) {
          const raw: string = uploadErr?.message ?? String(uploadErr) ?? 'Upload failed';
          console.error('[PromoUpload] upload failed:', raw, uploadErr);
          throw new Error(raw);
        }

        updateQueueItem(index, { status: 'generating' });
        const result = await savePromoVideo({ videoUrl, fileName: file.name });

        if (!result.keywords) {
          setPendingKeywords((prev) => new Set([...prev, result.videoId]));
        }

        updateQueueItem(index, { status: 'done' });
        await reload();
      } catch (e: any) {
        const msg: string = e?.message ?? String(e) ?? 'Upload failed';
        console.error('[PromoUpload] item failed:', msg, e);
        updateQueueItem(index, { status: 'error', errorMsg: msg });
        toast.error(`${file.name}: ${msg}`);
      }
    }

    processingRef.current = false;

    // Clear done items after a short delay
    setTimeout(() => {
      setQueue((q) => q.filter((item) => item.status !== 'done'));
    }, 2500);
  }, []);

  const addFiles = (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('video/'));
    if (arr.length === 0) { toast.error('Please select valid video files (MP4, MOV, WebM)'); return; }

    // Compute start index and new items OUTSIDE the state updater to avoid
    // React re-invoking the updater and double-pushing into pendingFilesRef.
    const startIdx = queue.length;
    const newItems: UploadItem[] = arr.map((file) => ({ file, status: 'queued' }));

    arr.forEach((file, i) => {
      pendingFilesRef.current.push({ file, index: startIdx + i });
    });

    setQueue((prev) => [...prev, ...newItems]);
    setTimeout(() => processNextInQueue(), 0);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const handleDelete = async (video: PromoVideo) => {
    try {
      await deletePromoVideo({ videoId: video.id });
      toast.success(`"${video.productName ?? 'Video'}" removed`);
      setVideos((v) => v.filter((x) => x.id !== video.id));
    } catch (e: any) {
      toast.error(e.message ?? 'Delete failed');
    }
  };

  const handleSave = async (id: string, patch: { productName: string; keywords: string; description: string }) => {
    await updatePromoVideo({ videoId: id, ...patch });
    setVideos((prev) => prev.map((v) => v.id === id ? { ...v, ...patch } : v));
    toast.success('Saved');
  };

  const handleReindex = async (video: PromoVideo) => {
    toast.info(`Reindexing "${video.productName ?? 'video'}"…`);
    setVideos((prev) => prev.map((v) => v.id === video.id ? { ...v, indexStatus: 'Indexing' } as any : v));
    try {
      const result = await indexPromoVideo({ videoId: video.id });
      toast.success(`Indexed ${result.segmentCount} segments (${result.mode})`);
      await reload();
    } catch (e: any) {
      toast.error(`Reindex failed: ${e?.message ?? 'Unknown error'}`);
      await reload();
    }
  };

  const activeUploads = queue.filter((q) => q.status === 'uploading' || q.status === 'generating' || q.status === 'queued');

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl bg-card border-border max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="w-4 h-4 text-primary" />
            Promo Video Library
            <div className="ml-auto flex items-center gap-2">
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImportFile(f);
                  e.target.value = '';
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                disabled={importing}
                onClick={() => importRef.current?.click()}
                title="Import a metadata index JSON (path_lower / downloadUrl are used only to match and are not stored)"
              >
                {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                {importing ? 'Importing…' : 'Import index'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                disabled={visionIndexing}
                onClick={(e) => handleVisionIndexAll(e.shiftKey)}
                title="Index promo videos that aren't up-to-date (videos already at the latest standard are skipped). Shift+click to FORCE re-index everything. Runs in the background; cached and reused by the AI director."
              >
                {visionIndexing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-3 h-3" />}
                {visionIndexing ? 'Indexing…' : 'Index videos'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                disabled={exporting}
                onClick={handleExportIndexes}
                title="Download the full raw index JSON for every promo video (for review)."
              >
                {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                {exporting ? 'Exporting…' : 'Export index JSON'}
              </Button>
            </div>
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Upload real product/brand videos. The AI Director selects them automatically when the product is mentioned in the script.
          </p>

          {/* Live re-index progress bar */}
          {reindexProg && (reindexProg.running || reindexProg.done > 0) && (
            <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium text-foreground flex items-center gap-1.5">
                  {reindexProg.running && <Loader2 className="w-3 h-3 animate-spin" />}
                  {reindexProg.running ? 'Re-indexing promo videos…' : 'Re-index complete'}
                </span>
                <span className="font-mono text-muted-foreground">
                  {reindexProg.done}/{reindexProg.total}
                  {reindexProg.failed > 0 && <span className="text-destructive"> · {reindexProg.failed} failed</span>}
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${reindexProg.failed > 0 ? 'bg-amber-500' : 'bg-primary'}`}
                  style={{ width: `${reindexProg.total ? Math.round((reindexProg.done / reindexProg.total) * 100) : 0}%` }}
                />
              </div>
              {reindexProg.running && reindexProg.current && (
                <p className="text-[10px] text-muted-foreground truncate">Now: {reindexProg.current}</p>
              )}
              {reindexProg.errors.length > 0 && (
                <div className="max-h-16 overflow-y-auto space-y-0.5 pt-0.5">
                  {reindexProg.errors.slice(-5).map((er, i) => (
                    <p key={i} className="text-[10px] text-destructive truncate">✗ {er.name}: {er.message}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogHeader>

        {/* Video list */}
        <div className="space-y-2 flex-1 overflow-y-auto min-h-0 pr-0.5">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && videos.length === 0 && activeUploads.length === 0 && (
            <div className="text-center py-8">
              <Film className="w-8 h-8 text-muted-foreground mx-auto mb-2 opacity-40" />
              <p className="text-sm text-muted-foreground">No promo videos yet.</p>
              <p className="text-xs text-muted-foreground">Upload your first video below.</p>
            </div>
          )}
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              isGenerating={pendingKeywords.has(v.id) && !v.keywords}
              onDelete={handleDelete}
              onSave={handleSave}
              onReindex={handleReindex}
              onView={(vid) => setViewIndexId(vid.id)}
            />
          ))}
        </div>

        {/* Upload zone */}
        <div className="border-t border-border pt-4 space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Add videos</p>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="w-3 h-3 text-primary/60" />
              Name, keywords &amp; description by AI
            </span>
          </div>

          {/* Drop zone */}
          <label
            className={`flex flex-col items-center gap-2 p-5 border-2 border-dashed rounded-xl cursor-pointer transition-colors text-center
              ${isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/40'}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <Upload className={`w-6 h-6 transition-colors ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
            <div>
              <p className="text-sm text-muted-foreground">Drop video files here or <span className="text-primary font-medium">browse</span></p>
              <p className="text-xs text-muted-foreground mt-0.5">MP4, MOV, WebM · Select multiple files</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              multiple
              className="hidden"
              onChange={handleFileInput}
            />
          </label>

          {/* Upload queue */}
          {queue.length > 0 && (
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {queue.map((item, i) => (
                <QueueItem key={i} item={item} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
      {viewIndexId && <IndexViewer videoId={viewIndexId} onClose={() => setViewIndexId(null)} />}
    </Dialog>
  );
}
