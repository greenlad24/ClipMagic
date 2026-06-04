import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, UploadCloud, Loader2, Download, CheckCircle2, XCircle, Sticker, Play, Eye, HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { uploadBlobToZite } from '@/utils/videoUtils';
import { createMeme, getMemeRun } from 'zite-endpoints-sdk';
import StoragePickerDialog, { type StoredFile } from '@/components/StoragePickerDialog';

/** A queued source: either a local file to upload, or a stored file to reuse. */
type QueueItem =
  | { kind: 'file'; file: File; title: string }
  | { kind: 'stored'; sourceUrl: string; title: string };

interface MemeItem {
  memeId: string;
  title: string;
  status: 'Queued' | 'Transcribing' | 'Planning' | 'Generating' | 'Rendering' | 'Complete' | 'Error';
  outputUrl: string | null;
  error: string | null;
  momentsPlanned: number | null;
  stickers: number | null;
  captionsOnly: boolean;
  subtitleTemplate: string | null;
  skipReason: string | null;
  // Live progress mirrored from the server pipeline.
  stageLabel: string;
  progress: number;
  stageDetail: { current: number; total: number } | null;
  momentResults: Array<{ phrase?: string; ok: boolean; reason?: string }>;
}
interface MemeRun {
  id: string;
  running: boolean;
  total: number;
  doneCount: number;
  items: MemeItem[];
}

const STATUS_STYLE: Record<MemeItem['status'], string> = {
  Queued: 'text-muted-foreground',
  Transcribing: 'text-blue-400',
  Planning: 'text-blue-400',
  Generating: 'text-purple-400',
  Rendering: 'text-amber-400',
  Complete: 'text-emerald-400',
  Error: 'text-destructive',
};

const STATUS_LABEL: Record<MemeItem['status'], string> = {
  Queued: 'Queued',
  Transcribing: 'Transcribing narration',
  Planning: 'Picking emphasis moments',
  Generating: 'Finding & reviewing stickers',
  Rendering: 'Rendering video',
  Complete: 'Complete',
  Error: 'Error',
};

export default function MemePage() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [run, setRun] = useState<MemeRun | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startPolling = useCallback(() => {
    if (poll.current) return;
    const tick = async () => {
      try {
        const { run: r } = await getMemeRun({});
        if (r) setRun(r);
        if (r && !r.running && poll.current) { clearInterval(poll.current); poll.current = null; }
      } catch { /* keep polling */ }
    };
    poll.current = setInterval(tick, 2500);
    tick();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { run: r } = await getMemeRun({});
        if (r) { setRun(r); if (r.running) startPolling(); }
      } catch { /* */ }
    })();
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [startPolling]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const vids = Array.from(list).filter((f) => /video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
    if (vids.length === 0) { toast.error('Drop video files (MP4/MOV/WebM…)'); return; }
    setFiles((prev) => [...prev, ...vids.map((f): QueueItem => ({ kind: 'file', file: f, title: f.name }))]);
  };

  // Reuse a file already in storage — queue it pre-resolved (no re-upload).
  const addStored = (picked: StoredFile[]) => {
    setFiles((prev) => [
      ...prev,
      ...picked.map((s): QueueItem => ({ kind: 'stored', sourceUrl: s.url!, title: s.original || s.name })),
    ]);
  };

  const start = async () => {
    if (files.length === 0) return;
    setUploading(true);
    const items: Array<{ sourceUrl: string; title: string }> = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const it = files[i];
        const title = it.title.replace(/\.[^.]+$/, '');
        if (it.kind === 'stored') {
          items.push({ sourceUrl: it.sourceUrl, title });
          continue;
        }
        setUploadMsg(`Uploading ${i + 1}/${files.length}: ${it.file.name}`);
        const sourceUrl = await uploadBlobToZite(it.file, it.file.name);
        items.push({ sourceUrl, title });
      }
      setUploadMsg('Starting sticker run…');
      const res = await createMeme({ items });
      if (res.started === false) toast.info(res.message ?? 'A sticker run is already in progress.');
      else toast.success(`Adding stickers to ${items.length} video${items.length !== 1 ? 's' : ''}.`);
      setFiles([]);
      if (res.run) setRun(res.run);
      startPolling();
    } catch (e: any) {
      toast.error('Upload failed — ' + (e?.message?.slice(0, 100) ?? 'unknown error'));
    } finally {
      setUploading(false);
      setUploadMsg('');
    }
  };

  const completed = run?.items.filter((i) => i.status === 'Complete').length ?? 0;
  const failed = run?.items.filter((i) => i.status === 'Error').length ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2.5 sticky top-0 bg-background z-10">
        <button onClick={() => navigate('/')} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted" title="Home">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Sticker className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Sticker Shorts</span>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
        >
          <UploadCloud className="w-7 h-7 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium">Drop a narration — or click to choose</p>
          <p className="text-xs text-muted-foreground mt-1">
            Commentary/meme format: clean narration + popping captions, with a funny AI sticker that pops
            in below the captions every few seconds to land the point. No b-roll, no screencasts — just
            captions and stickers.
          </p>
          <input ref={inputRef} type="file" accept="video/*" multiple className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }} />
        </div>

        {/* Reuse an already-uploaded narration instead of uploading again. */}
        <div className="flex justify-center -mt-2">
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5"
            onClick={() => setPickerOpen(true)}>
            <HardDrive className="w-3.5 h-3.5" /> Choose from storage
          </Button>
        </div>

        {/* Queued files (pre-upload) */}
        {files.length > 0 && (
          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{files.length} file{files.length !== 1 ? 's' : ''} ready</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={uploading} onClick={() => setFiles([])}>Clear</Button>
                <Button size="sm" className="h-7 text-xs gap-1.5" disabled={uploading} onClick={start}>
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {uploading ? 'Uploading…' : `Add stickers to ${files.length}`}
                </Button>
              </div>
            </div>
            {uploading && <p className="text-xs text-muted-foreground">{uploadMsg}</p>}
            <div className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
              {files.map((f, i) => (
                <div key={i} className="truncate flex items-center gap-1.5">
                  {f.kind === 'stored' && <HardDrive className="w-3 h-3 shrink-0 text-primary" />}
                  <span className="truncate">{f.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Run progress */}
        {run && (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-3 bg-card/40 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold flex items-center gap-2">
                {run.running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {run.running ? 'Adding stickers…' : 'Batch complete'}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">
                {completed}/{run.total} done{failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
              </span>
            </div>
            <div className="h-2 bg-muted">
              <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${run.total ? Math.round((run.doneCount / run.total) * 100) : 0}%` }} />
            </div>
            <div className="divide-y divide-border/60">
              {run.items.map((it) => {
                const active = it.status !== 'Complete' && it.status !== 'Error' && it.status !== 'Queued';
                const pct = Math.round((it.progress ?? 0) * 100);
                // Prefer the server's live stage sentence; fall back to the static label.
                const liveLabel = it.stageLabel && it.status !== 'Complete' && it.status !== 'Error'
                  ? it.stageLabel
                  : STATUS_LABEL[it.status];
                return (
                  <div key={it.memeId} className="px-4 py-2.5 space-y-2 hover:bg-muted/30">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{it.title}</p>
                        <p className={`text-[11px] ${STATUS_STYLE[it.status]}`}>
                          {it.status === 'Complete'
                            ? it.captionsOnly
                              ? '✓ Captions-only'
                              : `✓ ${it.stickers ?? 0} sticker${it.stickers === 1 ? '' : 's'} popped in${it.momentsPlanned != null ? ` · ${it.momentsPlanned} emphasis moment${it.momentsPlanned === 1 ? '' : 's'}` : ''}`
                            : it.status === 'Error' ? `✗ ${it.error ?? 'Failed'}`
                            : it.status === 'Queued' ? 'Queued'
                            : `${liveLabel}…`}
                        </p>
                        {/* Surface WHY a render fell back to captions-only — never a silent skip. */}
                        {it.status === 'Complete' && it.captionsOnly && it.skipReason && (
                          <p className="text-[11px] text-muted-foreground">No stickers: {it.skipReason}</p>
                        )}
                      </div>
                      {it.status === 'Complete' && it.outputUrl && (
                        <div className="flex items-center gap-3 shrink-0">
                          <a href={it.outputUrl} target="_blank" rel="noreferrer"
                            className="flex items-center gap-1 text-xs text-primary hover:underline">
                            <Eye className="w-3.5 h-3.5" /> View
                          </a>
                          <a href={it.outputUrl} target="_blank" rel="noreferrer" download
                            className="flex items-center gap-1 text-xs text-primary hover:underline">
                            <Download className="w-3.5 h-3.5" /> Download
                          </a>
                        </div>
                      )}
                      {it.status === 'Complete' ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        : it.status === 'Error' ? <XCircle className="w-4 h-4 text-destructive shrink-0" />
                        : <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />}
                    </div>

                    {/* Per-item progress bar while this item is actively processing. */}
                    {active && (
                      <div className="h-1 bg-muted rounded-full overflow-hidden" role="progressbar"
                        aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${it.title} progress`}>
                        <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(4, pct)}%` }} />
                      </div>
                    )}

                    {/* Clear error block (not just a status line) when this item failed. */}
                    {it.status === 'Error' && (
                      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                        <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{it.error ?? 'This video failed to process.'}</span>
                      </div>
                    )}

                    {/* Per-moment outcomes once planning is done — every beat's result,
                        so a "captions-only" run is explained beat by beat (no silent skips). */}
                    {it.momentResults && it.momentResults.length > 0 && (it.status === 'Complete' || it.status === 'Rendering') && (
                      <div className="rounded-lg bg-muted/30 px-2.5 py-1.5 space-y-0.5">
                        {it.momentResults.map((m, i) => (
                          <p key={i} className="text-[11px] flex items-start gap-1.5">
                            {m.ok
                              ? <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />
                              : <XCircle className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />}
                            <span className={m.ok ? 'text-foreground' : 'text-muted-foreground'}>
                              {m.phrase ? `"${m.phrase}"` : `Moment ${i + 1}`}
                              {!m.ok && m.reason ? ` — ${m.reason}` : m.ok ? ' — sticker applied' : ''}
                            </span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <StoragePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={addStored}
        description="Reuse a narration you already uploaded — it goes straight to the queue, no re-upload."
      />
    </div>
  );
}
