import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, UploadCloud, Loader2, Download, CheckCircle2, XCircle, Film, Play, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { extractAudio, uploadBlobToZite } from '@/utils/videoUtils';
import { createBulkNarration, getBulkRun } from 'zite-endpoints-sdk';

interface BulkItem {
  projectId: string;
  title: string;
  status: 'Queued' | 'Directing' | 'Capturing' | 'Reviewing' | 'Rendering' | 'Complete' | 'Error';
  outputUrl: string | null;
  error: string | null;
}
interface BulkRun {
  id: string;
  running: boolean;
  total: number;
  doneCount: number;
  items: BulkItem[];
}

const STATUS_STYLE: Record<BulkItem['status'], string> = {
  Queued: 'text-muted-foreground',
  Directing: 'text-blue-400',
  Capturing: 'text-blue-400',
  Reviewing: 'text-amber-400',
  Rendering: 'text-amber-400',
  Complete: 'text-emerald-400',
  Error: 'text-destructive',
};

export default function BulkPage() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [run, setRun] = useState<BulkRun | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Resume an in-progress run when the page opens.
  const startPolling = useCallback(() => {
    if (poll.current) return;
    const tick = async () => {
      try {
        const { run: r } = await getBulkRun({});
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
        const { run: r } = await getBulkRun({});
        if (r) { setRun(r); if (r.running) startPolling(); }
      } catch { /* */ }
    })();
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [startPolling]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const vids = Array.from(list).filter((f) => /video\/(mp4|quicktime)/.test(f.type) || /\.(mp4|mov)$/i.test(f.name));
    if (vids.length === 0) { toast.error('Drop MP4/MOV narration videos'); return; }
    setFiles((prev) => [...prev, ...vids]);
  };

  const start = async () => {
    if (files.length === 0) return;
    setUploading(true);
    const items: Array<{ narrationUrl: string; audioUrl?: string; title: string }> = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setUploadMsg(`Uploading ${i + 1}/${files.length}: ${f.name}`);
        let audioUrl: string | undefined;
        try { audioUrl = await uploadBlobToZite(await extractAudio(f), f.name.replace(/\.[^.]+$/, '') + '_audio.wav'); }
        catch { /* non-fatal — whisper falls back to the video */ }
        const narrationUrl = await uploadBlobToZite(f, f.name);
        items.push({ narrationUrl, audioUrl, title: f.name.replace(/\.[^.]+$/, '') });
      }
      setUploadMsg('Starting bulk run…');
      const res = await createBulkNarration({ items });
      if (res.started === false) toast.info(res.message ?? 'A bulk run is already in progress.');
      else toast.success(`Bulk run started for ${items.length} videos.`);
      setFiles([]);
      if (res.run) setRun(res.run);
      startPolling();
    } catch (e: any) {
      toast.error('Bulk upload failed — ' + (e?.message?.slice(0, 100) ?? 'unknown error'));
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
        <Film className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Bulk videos</span>
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
          <p className="text-sm font-medium">Drop narration videos (MP4/MOV) — or click to choose</p>
          <p className="text-xs text-muted-foreground mt-1">Each one runs the full AI pipeline and renders automatically.</p>
          <input ref={inputRef} type="file" accept="video/mp4,video/quicktime" multiple className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }} />
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
                  {uploading ? 'Uploading…' : `Process ${files.length}`}
                </Button>
              </div>
            </div>
            {uploading && <p className="text-xs text-muted-foreground">{uploadMsg}</p>}
            <div className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
              {files.map((f, i) => <div key={i} className="truncate">• {f.name}</div>)}
            </div>
          </div>
        )}

        {/* Run progress */}
        {run && (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-3 bg-card/40 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold flex items-center gap-2">
                {run.running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {run.running ? 'Processing…' : 'Batch complete'}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">
                {completed}/{run.total} done{failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
              </span>
            </div>
            <div className="h-2 bg-muted">
              <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${run.total ? Math.round((run.doneCount / run.total) * 100) : 0}%` }} />
            </div>
            <div className="divide-y divide-border/60">
              {run.items.map((it) => (
                <div key={it.projectId} className="px-4 py-2.5 flex items-center gap-3 hover:bg-muted/30">
                  <button
                    onClick={() => navigate(`/project/${it.projectId}/timeline`)}
                    className="min-w-0 flex-1 text-left"
                    title="Open this video's timeline"
                  >
                    <p className="text-sm font-medium truncate hover:text-primary transition-colors">{it.title}</p>
                    <p className={`text-[11px] ${STATUS_STYLE[it.status]}`}>
                      {it.status === 'Complete' ? '✓ Complete' : it.status === 'Error' ? `✗ ${it.error ?? 'Failed'}` : it.status + '…'}
                    </p>
                  </button>
                  {it.status === 'Complete' && it.outputUrl && (
                    <div className="flex items-center gap-3 shrink-0" onClick={(e) => e.stopPropagation()}>
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
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
