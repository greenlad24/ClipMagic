import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Loader2, Play, Pause, Scissors, Trash2, Undo2, RotateCcw, Film, Download,
  ZoomIn, ZoomOut, Eye, EyeOff, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { analyzeCut, renderManualCut, getCutJob } from 'zite-endpoints-sdk';
import {
  computeKeepSegments, previewDuration, sourceToEdited,
  DEFAULT_SETTINGS, type CutSettings, type Take, type Seg,
} from '@/lib/cutSegments';

interface AnalyzeResult {
  sourceUrl: string;
  duration: number;
  hasAudio: boolean;
  envelope: { db: number[]; hop: number; floorDb: number };
  words: { word: string; start: number; end: number }[];
  takes: Take[];
  defaults: CutSettings;
}

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function TimelineEditor({
  sourceUrl, title, onClose,
}: { sourceUrl: string; title: string; onClose: () => void }) {
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Edit state (the user's decisions) ──────────────────────────────────────
  const [settings, setSettings] = useState<CutSettings>(DEFAULT_SETTINGS);
  const [deleted, setDeleted] = useState<string[]>([]);
  const [history, setHistory] = useState<string[][]>([]); // for undo
  const [selected, setSelected] = useState<string | null>(null);

  // ── Playback / preview ─────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [edited, setEdited] = useState(true); // edited vs original playback
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0); // source time
  const [zoom, setZoom] = useState(1);
  const [pxPerSec, setPxPerSec] = useState(40);

  // ── Render state ───────────────────────────────────────────────────────────
  const [rendering, setRendering] = useState(false);
  const [renderPct, setRenderPct] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);

  const env = useMemo(
    () => analysis ? { db: analysis.envelope.db, hop: analysis.envelope.hop, duration: analysis.duration } : null,
    [analysis],
  );

  // Live recompute — the single source of truth, identical to the server math.
  const { takes, keep, gap } = useMemo(() => {
    if (!env || !analysis) return { takes: [] as Take[], keep: [] as Seg[], gap: settings.gap };
    return computeKeepSegments(env, analysis.words, settings, deleted);
  }, [env, analysis, settings, deleted]);

  const editedDuration = useMemo(() => previewDuration(keep, gap), [keep, gap]);

  // ── Load analysis ──────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setLoadError(null);
      try {
        const res = await analyzeCut({ sourceUrl }) as AnalyzeResult;
        if (!alive) return;
        setAnalysis(res);
        setSettings(res.defaults ?? DEFAULT_SETTINGS);
      } catch (e: any) {
        if (alive) setLoadError(e?.message?.slice(0, 160) ?? 'Analysis failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [sourceUrl]);

  // ── Take delete / undo / restore ───────────────────────────────────────────
  const pushHistory = useCallback(() => setHistory((h) => [...h, deleted]), [deleted]);
  const deleteTake = useCallback((id: string) => {
    pushHistory();
    setDeleted((d) => d.includes(id) ? d : [...d, id]);
    setSelected(null);
  }, [pushHistory]);
  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setDeleted(prev);
      return h.slice(0, -1);
    });
  }, []);
  const restoreAll = useCallback(() => { pushHistory(); setDeleted([]); }, [pushHistory]);

  // Keyboard: Delete removes selected take, Cmd/Ctrl+Z undoes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault(); deleteTake(selected);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault(); undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteTake, undo]);

  // ── Skip-playback preview ──────────────────────────────────────────────────
  // In edited mode the video element plays the source but jumps past every
  // removed span; at a take boundary it pauses for `gap` seconds (the inter-take
  // pause the render inserts) before seeking to the next kept span. So the
  // preview duration == the render duration.
  const keepRef = useRef(keep); keepRef.current = keep;
  const gapRef = useRef(gap); gapRef.current = gap;
  const editedRef = useRef(edited); editedRef.current = edited;
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGapTimer = () => { if (gapTimer.current) { clearTimeout(gapTimer.current); gapTimer.current = null; } };

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    setPlayhead(v.currentTime);
    if (!editedRef.current || gapTimer.current) return;
    const ks = keepRef.current;
    if (ks.length === 0) return;
    const t = v.currentTime;
    // Which kept segment are we in (or before)?
    let inSeg = -1, nextSeg = -1;
    for (let i = 0; i < ks.length; i++) {
      if (t >= ks[i].start - 0.02 && t < ks[i].end) { inSeg = i; break; }
      if (t < ks[i].start) { nextSeg = i; break; }
    }
    if (inSeg >= 0) {
      // Approaching the end of this kept segment → pause for the gap, then seek.
      if (t >= ks[inSeg].end - 0.04) {
        const next = ks[inSeg + 1];
        if (!next) { v.pause(); setPlaying(false); v.currentTime = ks[ks.length - 1].end; return; }
        v.pause();
        gapTimer.current = setTimeout(() => {
          gapTimer.current = null;
          if (videoRef.current && editedRef.current) {
            videoRef.current.currentTime = next.start;
            void videoRef.current.play().catch(() => {});
          }
        }, gapRef.current * 1000);
      }
    } else if (nextSeg >= 0) {
      // We're in a removed span before the next kept segment → jump to it.
      v.currentTime = ks[nextSeg].start;
    } else {
      // Past the last kept segment.
      v.pause(); setPlaying(false);
    }
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (playing) { v.pause(); clearGapTimer(); setPlaying(false); return; }
    if (edited && keep.length > 0) {
      // Snap into the nearest kept span before playing.
      const t = v.currentTime;
      const inSome = keep.some((k) => t >= k.start && t < k.end);
      if (!inSome) {
        const next = keep.find((k) => k.start >= t) ?? keep[0];
        v.currentTime = next.start;
      }
    }
    void v.play().then(() => setPlaying(true)).catch(() => {});
  }, [playing, edited, keep]);

  // Toggling edited mode while playing: cancel any pending gap pause.
  useEffect(() => { if (!edited) clearGapTimer(); }, [edited]);
  useEffect(() => () => clearGapTimer(), []);

  // ── Waveform canvas ────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineWidth = (analysis?.duration ?? 0) * pxPerSec * zoom;

  useEffect(() => {
    const cv = canvasRef.current; const a = analysis; if (!cv || !a) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(timelineWidth));
    const h = 96;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const fg = `hsl(${css.getPropertyValue('--muted-foreground').trim() || '0 0% 60%'})`;
    const primary = `hsl(${css.getPropertyValue('--primary').trim() || '160 80% 45%'})`;

    const db = a.envelope.db; const floor = a.envelope.floorDb;
    const n = db.length;
    if (n === 0) return;
    const mid = h / 2;
    // Removed spans (current threshold) drawn as muted; kept as primary.
    const removedSet: Array<[number, number]> = [];
    {
      // derive removed spans = complement of keep over [0,duration]
      let cursor = 0;
      for (const k of keep) { if (k.start > cursor) removedSet.push([cursor, k.start]); cursor = k.end; }
      if (cursor < a.duration) removedSet.push([cursor, a.duration]);
    }
    const isRemoved = (t: number) => removedSet.some(([s, e]) => t >= s && t < e);

    for (let x = 0; x < w; x++) {
      const t = (x / pxPerSec) / zoom;
      const idx = Math.min(n - 1, Math.floor(t / a.envelope.hop));
      const dbv = db[idx] ?? floor;
      const norm = Math.max(0, Math.min(1, (dbv - floor) / (0 - floor))); // 0..1
      const amp = norm * (mid - 2);
      ctx.strokeStyle = isRemoved(t) ? fg : primary;
      ctx.globalAlpha = isRemoved(t) ? 0.28 : 0.9;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - amp);
      ctx.lineTo(x + 0.5, mid + amp);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [analysis, keep, pxPerSec, zoom, timelineWidth]);

  // ── Render (== preview) ────────────────────────────────────────────────────
  const startRender = useCallback(async () => {
    if (keep.length === 0) { toast.error('Nothing left to render — restore a take.'); return; }
    setRendering(true); setRenderPct(0); setOutputUrl(null);
    try {
      const { jobId, expectedDuration } = await renderManualCut({
        sourceUrl, title, segments: keep, gap,
      }) as { jobId: string; expectedDuration: number };
      // Poll the single job.
      const poll = async (): Promise<void> => {
        const r = await getCutJob({ jobId }) as { status: string; progress: number; outputUrl: string | null; error: string | null };
        setRenderPct(Math.round((r.progress ?? 0) * 100));
        if (r.status === 'completed' && r.outputUrl) {
          setOutputUrl(r.outputUrl); setRendering(false);
          toast.success(`Rendered ${fmt(expectedDuration)} — exactly what you previewed.`);
          return;
        }
        if (r.status === 'failed' || r.status === 'canceled' || r.status === 'missing') {
          throw new Error(r.error ?? 'Render failed');
        }
        setTimeout(poll, 1500);
      };
      await poll();
    } catch (e: any) {
      setRendering(false);
      toast.error('Render failed — ' + (e?.message?.slice(0, 120) ?? 'unknown'));
    }
  }, [keep, gap, sourceUrl, title]);

  // ── Render states ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
        <p className="text-sm">Analyzing narration — transcribing + reading audio energy…</p>
      </div>
    );
  }
  if (loadError || !analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <X className="w-6 h-6 text-destructive" />
        <p className="text-sm text-destructive">{loadError ?? 'Could not analyze this clip.'}</p>
        <Button variant="outline" size="sm" onClick={onClose}>Back</Button>
      </div>
    );
  }

  const removedCount = analysis.takes.length === 0 ? 0 : (analysis.takes.length - takes.length) + deleted.length;
  const playheadX = playhead * pxPerSec * zoom;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate flex items-center gap-2">
            <Scissors className="w-4 h-4 text-primary shrink-0" /> {title}
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {fmt(analysis.duration)} original → <span className="text-foreground font-medium">{fmt(editedDuration)}</span> edited ·{' '}
            {takes.length} take{takes.length !== 1 ? 's' : ''} kept
            {deleted.length > 0 && <> · {deleted.length} deleted</>}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={onClose}>
          <X className="w-3.5 h-3.5 mr-1" /> Close
        </Button>
      </div>

      {/* Video preview */}
      <div className="rounded-xl border border-border overflow-hidden bg-black/40">
        <video
          ref={videoRef}
          src={sourceUrl}
          className="w-full max-h-[42vh] bg-black object-contain"
          onTimeUpdate={onTimeUpdate}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); clearGapTimer(); }}
          onClick={togglePlay}
          playsInline
        />
        <div className="flex items-center gap-3 px-3 py-2 bg-card/60 border-t border-border">
          <button onClick={togglePlay} className="p-1.5 rounded text-foreground hover:bg-muted" aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
            {fmt(playhead)} / {fmt(edited ? editedDuration : analysis.duration)}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setEdited((e) => !e)}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors ${
              edited ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
            title="Toggle between the edited preview (cuts skipped) and the original"
          >
            {edited ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {edited ? 'Edited preview' : 'Original'}
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-border p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <RangeControl
          label="Silence floor" value={settings.silenceDb} min={-60} max={-20} step={1} unit=" dB"
          hint="Complete-silence only — breaths stay"
          onChange={(v) => setSettings((s) => ({ ...s, silenceDb: v }))}
        />
        <RangeControl
          label="Only cut silences over" value={settings.minSilence} min={0.1} max={1.5} step={0.05} unit="s"
          hint="Shorter pauses are kept"
          onChange={(v) => setSettings((s) => ({ ...s, minSilence: round2(v) }))}
        />
        <RangeControl
          label="Collapse gap to" value={settings.gap} min={0} max={1} step={0.05} unit="s"
          hint="Dead air left between takes"
          onChange={(v) => setSettings((s) => ({ ...s, gap: round2(v) }))}
        />
        <RangeControl
          label="Min take length" value={settings.minTake} min={0.1} max={2} step={0.05} unit="s"
          hint="Shorter blips are dropped"
          onChange={(v) => setSettings((s) => ({ ...s, minTake: round2(v) }))}
        />
      </div>

      {/* Edit actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5"
          disabled={!selected} onClick={() => selected && deleteTake(selected)}>
          <Trash2 className="w-3.5 h-3.5" /> Delete take
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-1.5"
          disabled={history.length === 0} onClick={undo}>
          <Undo2 className="w-3.5 h-3.5" /> Undo
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-1.5"
          disabled={deleted.length === 0} onClick={restoreAll}>
          <RotateCcw className="w-3.5 h-3.5" /> Restore all
        </Button>
        <div className="flex-1" />
        <button onClick={() => setZoom((z) => Math.max(0.5, z / 1.5))} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted" aria-label="Zoom out"><ZoomOut className="w-4 h-4" /></button>
        <button onClick={() => setZoom((z) => Math.min(8, z * 1.5))} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted" aria-label="Zoom in"><ZoomIn className="w-4 h-4" /></button>
      </div>

      {/* Timeline: waveform + take blocks */}
      <div className="rounded-xl border border-border bg-card/30 p-3 space-y-2">
        <div className="relative overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
          <div className="relative" style={{ width: Math.max(timelineWidth, 320) }}>
            {/* Waveform */}
            <div
              className="relative cursor-pointer"
              onClick={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const t = ((e.clientX - rect.left) / (pxPerSec * zoom));
                if (videoRef.current) { videoRef.current.currentTime = Math.max(0, Math.min(analysis.duration, t)); setPlayhead(t); }
              }}
            >
              <canvas ref={canvasRef} className="block" />
              {/* Playhead */}
              <div className="absolute top-0 bottom-0 w-px bg-primary pointer-events-none" style={{ left: playheadX }} />
            </div>

            {/* Take blocks */}
            <div className="relative mt-2 h-16">
              {takes.map((t) => {
                const left = t.start * pxPerSec * zoom;
                const width = Math.max(8, (t.end - t.start) * pxPerSec * zoom);
                const isSel = selected === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelected(isSel ? null : t.id)}
                    onDoubleClick={() => deleteTake(t.id)}
                    title={t.text || `Take ${fmt(t.start)}–${fmt(t.end)}`}
                    className={`absolute top-0 h-full rounded-md border px-1.5 py-1 text-left overflow-hidden transition-colors ${
                      isSel
                        ? 'border-primary bg-primary/20 ring-1 ring-primary'
                        : 'border-border bg-muted/60 hover:bg-muted'
                    }`}
                    style={{ left, width }}
                  >
                    <span className="block text-[10px] font-mono text-muted-foreground leading-tight">{fmt(t.start)}</span>
                    <span className="block text-[11px] text-foreground leading-snug line-clamp-2">{t.text || '—'}</span>
                  </button>
                );
              })}
              {takes.length === 0 && (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No takes at these settings — lower the silence floor or min-silence.
                </p>
              )}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Click a take to select; press <kbd className="px-1 rounded bg-muted">Delete</kbd> or double-click to remove it.
          Cuts and the {settings.gap.toFixed(2)}s gaps recompute live and render exactly as previewed.
        </p>
      </div>

      {/* Render */}
      <div className="rounded-xl border border-border p-3 flex items-center gap-3 flex-wrap">
        <Button size="sm" className="h-9 text-xs gap-1.5" disabled={rendering || keep.length === 0} onClick={startRender}>
          {rendering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />}
          {rendering ? `Rendering ${renderPct}%…` : `Render edit (${fmt(editedDuration)})`}
        </Button>
        {rendering && (
          <div className="flex-1 min-w-[120px] h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${renderPct}%` }} />
          </div>
        )}
        {outputUrl && (
          <div className="flex items-center gap-3">
            <a href={outputUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline"><Eye className="w-3.5 h-3.5" /> View</a>
            <a href={outputUrl} target="_blank" rel="noreferrer" download className="flex items-center gap-1 text-xs text-primary hover:underline"><Download className="w-3.5 h-3.5" /> Download</a>
          </div>
        )}
        <span className="text-[11px] text-muted-foreground ml-auto">
          {removedCount > 0 ? `${removedCount} region${removedCount !== 1 ? 's' : ''} removed` : 'No cuts yet'}
        </span>
      </div>
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function RangeControl({
  label, value, min, max, step, unit, hint, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string; hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-foreground">{label}</label>
        <span className="text-xs font-mono text-primary tabular-nums">{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 cursor-pointer appearance-none bg-muted rounded-full accent-primary"
        aria-label={label}
      />
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}
