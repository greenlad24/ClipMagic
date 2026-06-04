import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, UploadCloud, Loader2, Download, CheckCircle2, XCircle, Scissors, Play, Eye, SlidersHorizontal, HardDrive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { uploadBlobToZite } from '@/utils/videoUtils';
import { createBulkCut, getCutRun } from 'zite-endpoints-sdk';
import TimelineEditor from '@/components/cutter/TimelineEditor';
import StoragePickerDialog, { type StoredFile } from '@/components/StoragePickerDialog';

/** A queued source: either a local file to upload, or a stored file to reuse. */
type QueueItem =
  | { kind: 'file'; file: File; title: string }
  | { kind: 'stored'; sourceUrl: string; title: string };

interface CutStats {
  originalDuration: number;
  keptDuration: number;
  removedDuration: number;
  silenceCuts: number;
  fillerCuts: number;
  stutterCuts: number;
  takesRemoved: number;
}
interface CutItem {
  cutId: string;
  title: string;
  status: 'Queued' | 'Transcribing' | 'Analyzing' | 'Rendering' | 'Complete' | 'Error';
  outputUrl: string | null;
  error: string | null;
  stats: CutStats | null;
}
interface CutRun {
  id: string;
  running: boolean;
  total: number;
  doneCount: number;
  items: CutItem[];
}

type Aggressiveness = 'gentle' | 'balanced' | 'aggressive';
const AGGRESSION: { value: Aggressiveness; label: string; hint: string }[] = [
  { value: 'gentle', label: 'Gentle', hint: 'Only obvious dead air' },
  { value: 'balanced', label: 'Balanced', hint: 'Recommended' },
  { value: 'aggressive', label: 'Aggressive', hint: 'Tightest, cuts more pauses' },
];

const STATUS_STYLE: Record<CutItem['status'], string> = {
  Queued: 'text-muted-foreground',
  Transcribing: 'text-blue-400',
  Analyzing: 'text-blue-400',
  Rendering: 'text-amber-400',
  Complete: 'text-emerald-400',
  Error: 'text-destructive',
};

function fmtDur(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0s';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export default function CutterPage() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [run, setRun] = useState<CutRun | null>(null);
  const [aggressiveness, setAggressiveness] = useState<Aggressiveness>('balanced');
  const [isDragging, setIsDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editor, setEditor] = useState<{ sourceUrl: string; title: string } | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startPolling = useCallback(() => {
    if (poll.current) return;
    const tick = async () => {
      try {
        const { run: r } = await getCutRun({});
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
        const { run: r } = await getCutRun({});
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
          // Already on the server — feed its URL straight in.
          items.push({ sourceUrl: it.sourceUrl, title });
          continue;
        }
        setUploadMsg(`Uploading ${i + 1}/${files.length}: ${it.file.name}`);
        const sourceUrl = await uploadBlobToZite(it.file, it.file.name);
        items.push({ sourceUrl, title });
      }
      setUploadMsg('Starting cut run…');
      const res = await createBulkCut({ items, aggressiveness });
      if (res.started === false) toast.info(res.message ?? 'A cut run is already in progress.');
      else toast.success(`Cutting ${items.length} video${items.length !== 1 ? 's' : ''}.`);
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

  // Open the interactive timeline editor for a SINGLE clip: upload the first
  // queued file, then hand off to the Descript-style editor.
  const openEditor = async () => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const it = files[0];
      const title = it.title.replace(/\.[^.]+$/, '');
      let sourceUrl: string;
      if (it.kind === 'stored') {
        sourceUrl = it.sourceUrl;
      } else {
        setUploadMsg(`Uploading ${it.file.name}…`);
        sourceUrl = await uploadBlobToZite(it.file, it.file.name);
      }
      setEditor({ sourceUrl, title });
      setFiles((prev) => prev.slice(1));
    } catch (e: any) {
      toast.error('Upload failed — ' + (e?.message?.slice(0, 100) ?? 'unknown error'));
    } finally {
      setUploading(false);
      setUploadMsg('');
    }
  };

  const completed = run?.items.filter((i) => i.status === 'Complete').length ?? 0;
  const failed = run?.items.filter((i) => i.status === 'Error').length ?? 0;

  if (editor) {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2.5 sticky top-0 bg-background z-10">
          <button onClick={() => setEditor(null)} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted" title="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Scissors className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Timeline Editor</span>
        </div>
        <div className="max-w-5xl mx-auto px-4 py-6">
          <TimelineEditor sourceUrl={editor.sourceUrl} title={editor.title} onClose={() => setEditor(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2.5 sticky top-0 bg-background z-10">
        <button onClick={() => navigate('/')} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted" title="Home">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Scissors className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Narration Cutter</span>
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
          <p className="text-sm font-medium">Drop raw footage — or click to choose</p>
          <p className="text-xs text-muted-foreground mt-1">
            <span className="text-foreground font-medium">Edit on timeline</span> for full control — set the silence
            threshold, delete takes, and preview the exact result before rendering. Or <span className="text-foreground font-medium">auto-cut</span> a
            batch: removes long silences, fillers, stutters and duplicate takes automatically.
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

        {/* Cut strength — how much non-speech to remove (the user's call). */}
        <div className="rounded-xl border border-border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Cut strength</span>
            <span className="text-[11px] text-muted-foreground">
              {AGGRESSION.find((a) => a.value === aggressiveness)?.hint}
            </span>
          </div>
          <div role="radiogroup" aria-label="Cut strength" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
            {AGGRESSION.map((a) => (
              <button
                key={a.value}
                role="radio"
                aria-checked={aggressiveness === a.value}
                disabled={uploading}
                onClick={() => setAggressiveness(a.value)}
                title={a.hint}
                className={`h-8 rounded-md text-xs font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  aggressiveness === a.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* Queued files (pre-upload) */}
        {files.length > 0 && (
          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{files.length} file{files.length !== 1 ? 's' : ''} ready</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={uploading} onClick={() => setFiles([])}>Clear</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" disabled={uploading} onClick={openEditor}
                  title="Open the first clip in the interactive timeline editor — set the cuts and preview before rendering">
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Edit on timeline
                </Button>
                <Button size="sm" className="h-7 text-xs gap-1.5" disabled={uploading} onClick={start}>
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {uploading ? 'Uploading…' : `Auto-cut ${files.length}`}
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
                {run.running ? 'Cutting…' : 'Batch complete'}
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
                <div key={it.cutId} className="px-4 py-2.5 flex items-center gap-3 hover:bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{it.title}</p>
                    <p className={`text-[11px] ${STATUS_STYLE[it.status]}`}>
                      {it.status === 'Complete' && it.stats
                        ? `✓ Removed ${fmtDur(it.stats.removedDuration)} · ${fmtDur(it.stats.keptDuration)} kept · ${it.stats.silenceCuts} silences, ${it.stats.fillerCuts} fillers${it.stats.stutterCuts ? `, ${it.stats.stutterCuts} stutter${it.stats.stutterCuts !== 1 ? 's' : ''}` : ''}${it.stats.takesRemoved ? `, ${it.stats.takesRemoved} dup take${it.stats.takesRemoved !== 1 ? 's' : ''}` : ''}`
                        : it.status === 'Error' ? `✗ ${it.error ?? 'Failed'}`
                        : it.status + '…'}
                    </p>
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
              ))}
            </div>
          </div>
        )}
      </div>

      <StoragePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={addStored}
        description="Reuse footage you already uploaded — it goes straight to the queue, no re-upload."
      />
    </div>
  );
}
