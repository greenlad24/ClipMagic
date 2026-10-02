/**
 * Deep Dive — the editor (/news-gatherer/deep-dive/:id), inside the NewsShell.
 *
 *   header: title · status · Generate/Regenerate · Present · Open screen
 *   run log (streamed generation, or the saved progress if it runs elsewhere)
 *   sections: thumbnail · kind · eyebrow + heading · script · video · order
 *   sources the research used
 *
 * Edits save on blur. Regenerate replaces every section (and every edit) —
 * it asks first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ExternalLink, Loader2, MonitorPlay, Play,
  RefreshCw, Telescope, Trash2, Video, VideoOff, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import NewsShell from '../shell/NewsShell';
import { useAuth } from '../auth';
import RunLog, { type LogEntry } from '../daily/RunLog';
import {
  getDeepDive, generateDeepDive, recordDeepDiveDemo, attachDeepDiveDemo, getDeepDiveMedia, type DemoJobInfo, type MediaChoices, updateDeepDive, updateSection, deleteSection, reorderSections, setSectionVideo,
  presenterPath, stagePath, DEEP_DIVE_PATH, KIND_LABEL, secondsFor, wordCount, fmtDuration, sectionMedia,
  NO_VISUAL, visualStill, type DeepDive, type Section, type Visual,
} from './api';
import { Scene, SceneThumb, StageFrame, useDeepDiveFont } from './Scene';
import { STATUS_BADGE } from './DeepDiveListPage';
import { ChapterCardV2, PreviewV2 } from './v2/EditorV2';
import { sectionsToChapters } from './v2/adapt';

export default function DeepDiveEditorPage() {
  return (
    <NewsShell title="Deep Dive">
      <Editor />
    </NewsShell>
  );
}

function Editor() {
  useDeepDiveFont();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();

  const [dive, setDive] = useState<DeepDive | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [demoJob, setDemoJob] = useState<DemoJobInfo | null>(null);
  const [choices, setChoices] = useState<MediaChoices | null>(null);
  const chaptersV2 = useMemo(() => sectionsToChapters(sections), [sections]);
  const [serverRunning, setServerRunning] = useState(false);
  const [notFound, setNotFound] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [showSources, setShowSources] = useState(false);
  const autoStarted = useRef(false);

  const addLog = useCallback((message: string, percent: number, isError = false) =>
    setLogs((prev) => [...prev, { id: prev.length, ts: new Date(), message, percent, isError }]), []);

  const load = useCallback(async () => {
    try {
      const r = await getDeepDive(id);
      setDive(r.deepDive);
      setDemoJob(r.demoJob ?? null);
      if (r.deepDive.format === 'v2' && r.sections.length) getDeepDiveMedia(id).then(setChoices).catch(() => {});
      setSections(r.sections);
      setServerRunning(r.running);
      return r;
    } catch (e) {
      setNotFound(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id]);

  useEffect(() => { if (user && id) void load(); }, [user, id, load]);

  const generate = useCallback(async (fresh = false) => {
    if (streaming) return;
    setStreaming(true);
    setLogs([]);
    setLogOpen(true);
    setDive((d) => (d ? { ...d, status: 'generating', error: '' } : d));
    try {
      const stream = generateDeepDive(id, fresh);
      for await (const chunk of stream) {
        try {
          const { message, percent } = JSON.parse(chunk);
          addLog(String(message), Number(percent) || 0);
        } catch { addLog(chunk, 0); }
      }
      const r = await stream.result;
      toast.success(`Deep dive ready: ${r.sections} sections`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(msg, 100, true);
      toast.error(msg);
    } finally {
      setStreaming(false);
      await load();
    }
  }, [id, streaming, addLog, load]);

  // Arrived from "Create & generate": start once, then drop the flag so a
  // reload doesn't start a second (paid) run.
  useEffect(() => {
    if (!dive || autoStarted.current || params.get('generate') !== '1') return;
    autoStarted.current = true;
    const p = new URLSearchParams(params); p.delete('generate'); setParams(p, { replace: true });
    if (dive.status !== 'generating' && dive.status !== 'ready') void generate();
  }, [dive, params, setParams, generate]);

  // Generating somewhere this tab isn't streaming (a reload, another tab):
  // follow the progress the server saves on the row.
  useEffect(() => {
    if (streaming || !(serverRunning || dive?.status === 'generating')) return;
    const t = setInterval(async () => {
      const r = await load();
      if (r?.deepDive.progressMessage) {
        setLogs((prev) => (prev[prev.length - 1]?.message === r.deepDive.progressMessage ? prev
          : [...prev, { id: prev.length, ts: new Date(), message: r.deepDive.progressMessage, percent: r.deepDive.progressPercent }]));
      }
    }, 2500);
    return () => clearInterval(t);
  }, [streaming, serverRunning, dive?.status, load]);

  const regenerate = (fresh: boolean) => {
    const what = fresh ? 'searches the web again and REPLACES' : 'rewrites the outline and script from the saved research and REPLACES';
    if (sections.length && !window.confirm(`Regenerate? This ${what} all sections, including any edits you made.`)) return;
    void generate(fresh);
  };

  const patchSection = (s: Section) => setSections((list) => list.map((x) => (x.id === s.id ? s : x)));

  const saveSection = async (sectionId: string, patch: { heading?: string; eyebrow?: string; script?: string }) => {
    try { patchSection((await updateSection({ sectionId, ...patch })).section); }
    catch (e) { toast.error(`Not saved: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const move = async (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    setSections(next);
    try { await reorderSections(next.map((s) => s.id)); } catch (e) { toast.error(String(e)); void load(); }
  };

  const remove = async (s: Section) => {
    if (!window.confirm(`Delete section "${s.heading || KIND_LABEL[s.kind]}"?`)) return;
    setSections((list) => list.filter((x) => x.id !== s.id));
    try { await deleteSection(s.id); } catch (e) { toast.error(String(e)); void load(); }
  };

  const saveMeta = async (patch: { title?: string; topic?: string; angle?: string }) => {
    try { await updateDeepDive({ id, ...patch }); setDive((d) => (d ? { ...d, ...patch } : d)); }
    catch (e) { toast.error(String(e)); }
  };

  if (notFound) {
    return (
      <div className="px-5 py-10 text-center text-sm text-muted-foreground">
        {notFound} <Link to={DEEP_DIVE_PATH} className="text-primary hover:underline">Back to deep dives</Link>
      </div>
    );
  }
  if (!dive) return <div className="flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  const busy = streaming || serverRunning || dive.status === 'generating';
  const totalSecs = sections.reduce((a, s) => a + secondsFor(s.script), 0);
  const totalWords = sections.reduce((a, s) => a + wordCount(s.script), 0);
  const badge = STATUS_BADGE[busy ? 'generating' : dive.status] ?? STATUS_BADGE.draft;
  const title = dive.title || dive.topic;
  const isV2 = dive.format === 'v2';

  return (
    <div className="mx-auto max-w-6xl px-3 pb-16 pt-4 sm:px-5">
      <Link to={DEEP_DIVE_PATH} className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> All deep dives
      </Link>

      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
            {sections.length > 0 && (
              <span className="text-xs text-muted-foreground">{sections.length} sections · {totalWords} words · about {fmtDuration(totalSecs)} out loud</span>
            )}
          </div>
          <Input
            key={`t:${dive.title}`}
            defaultValue={title}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== dive.title) void saveMeta({ title: v }); }}
            className="h-auto border-transparent bg-transparent px-0 text-xl font-semibold shadow-none focus-visible:border-border focus-visible:px-2"
            aria-label="Title"
          />
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Topic & angle <span className="opacity-60">(used when you generate)</span></summary>
            <div className="mt-2 grid gap-2">
              <Input key={`p:${dive.topic}`} defaultValue={dive.topic} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== dive.topic) void saveMeta({ topic: v }); }} />
              <Textarea key={`a:${dive.angle}`} defaultValue={dive.angle} rows={2} placeholder="Angle (optional)"
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== dive.angle) void saveMeta({ angle: v }); }} />
            </div>
          </details>
          {isV2 && <DemoAgentSwitch dive={dive} job={demoJob} onRecord={async () => { try { await recordDeepDiveDemo(id); toast.success('The demo agent is recording — it shows up as a chapter when it finishes.'); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } }} onAttach={async () => { try { const r = await attachDeepDiveDemo(id); if (r.attached) toast.success('The agent recording is in the show (chapter 2).'); else toast.error(`Not added: ${r.reason}`); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } }} onChange={(patch) => { setDive({ ...dive, ...patch }); void updateDeepDive({ id, ...patch }).catch((e) => toast.error(String(e?.message ?? e))); }} />}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {sections.length > 0 && !busy && (
            <Button variant="ghost" size="sm" onClick={() => regenerate(true)} className="text-xs text-muted-foreground" title="Search the web again for newer facts, then rebuild">
              Research again
            </Button>
          )}
          <Button variant={sections.length ? 'outline' : 'default'} onClick={() => (sections.length ? regenerate(false) : void generate())} disabled={busy} className="gap-1.5"
            title={sections.length ? 'Rebuild the outline and script (reuses the research from the last 12 hours)' : undefined}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : sections.length ? <RefreshCw className="h-4 w-4" /> : <Telescope className="h-4 w-4" />}
            {busy ? 'Generating…' : sections.length ? 'Regenerate' : 'Generate'}
          </Button>
          <Button variant="outline" disabled={!sections.length} className="gap-1.5" onClick={() => window.open(stagePath(id), 'dd-stage')}>
            <MonitorPlay className="h-4 w-4" /> Open screen
          </Button>
          <Button disabled={!sections.length} className="gap-1.5" onClick={() => navigate(presenterPath(id))}>
            <Play className="h-4 w-4" /> Present
          </Button>
        </div>
      </div>

      {dive.status === 'error' && !busy && dive.error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Generation failed: {dive.error}{sections.length ? ' The previous sections are still here.' : ''}</span>
        </div>
      )}

      {(busy || logs.length > 0) && (
        <div className="mb-4">
          <RunLog title="Generation" logs={logs} running={busy} open={logOpen} onToggle={() => setLogOpen((v) => !v)} onClear={() => setLogs([])}
            emptyHint={busy ? (dive.progressMessage || 'Working…') : 'Nothing yet.'} />
        </div>
      )}

      {/* Sections */}
      {sections.length === 0 ? (
        !busy && (
          <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
            <Telescope className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No sections yet. Press <span className="font-medium text-foreground">Generate</span> to research the topic and build the presentation.</p>
          </div>
        )
      ) : (
        isV2 ? (
          <ol className="grid grid-cols-1 gap-3">
            {chaptersV2.map((c, i) => (
              <ChapterCardV2 key={c.id} chapters={chaptersV2} index={i} diveId={id} choices={choices} onMaterial={patchSection}
                onPreview={() => setPreview(i)}
                onSave={(patch) => saveSection(c.id, patch)}
                onMove={(dir) => move(i, dir)}
                onDelete={() => remove(sections[i])} />
            ))}
          </ol>
        ) : (
        <ol className="grid grid-cols-1 gap-3">
          {sections.map((s, i) => (
            <SectionCard
              key={s.id}
              section={s}
              index={i}
              total={sections.length}
              title={title}
              onPreview={() => setPreview(i)}
              onSave={(patch) => saveSection(s.id, patch)}
              onMove={(dir) => move(i, dir)}
              onDelete={() => remove(s)}
              onVideo={patchSection}
              pool={dive.visuals ?? []}
            />
          ))}
        </ol>
        )
      )}

      {/* Sources */}
      {dive.sources.length > 0 && (
        <div className="mt-6 rounded-lg border border-border bg-card/40 p-3">
          <button onClick={() => setShowSources((v) => !v)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
            {showSources ? '▾' : '▸'} Sources the research used ({dive.sources.length})
          </button>
          {showSources && (
            <ul className="mt-2 space-y-1">
              {dive.sources.map((src, i) => (
                <li key={i}>
                  <a href={src.url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2 text-xs text-muted-foreground hover:text-foreground">
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                    <span><span className="font-medium text-foreground">{src.outlet || new URL(src.url).hostname}</span>{src.official ? ' (official)' : ''} — {src.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isV2
        ? <PreviewV2 chapters={chaptersV2} diveId={id} chapter={preview} onClose={() => setPreview(null)} />
        : <PreviewDialog sections={sections} title={title} index={preview} onIndex={setPreview} />}
    </div>
  );
}

function SectionCard({ section: s, index, total, title, onPreview, onSave, onMove, onDelete, onVideo, pool }: {
  section: Section; index: number; total: number; title: string; pool: Visual[];
  onPreview: () => void;
  onSave: (patch: { heading?: string; eyebrow?: string; script?: string }) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onVideo: (s: Section) => void;
}) {
  const [script, setScript] = useState(s.script);
  useEffect(() => setScript(s.script), [s.script]);
  const [videoInput, setVideoInput] = useState('');
  const [videoBusy, setVideoBusy] = useState(false);

  const setVideo = async (value: string | null) => {
    setVideoBusy(true);
    try {
      const r = await setSectionVideo(s.id, value);
      if (r.section) onVideo(r.section);
      setVideoInput('');
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setVideoBusy(false); }
  };

  const hasVideo = !!sectionMedia(s);

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 p-3 md:flex-row">
        <div className="w-full shrink-0 md:w-[300px]">
          <button onClick={onPreview} className="block w-full" title="Preview with animation">
            <SceneThumb section={s} index={index} total={total} title={title} className="transition-shadow hover:ring-2 hover:ring-primary/50" />
          </button>
          <div className="mt-2 flex items-center gap-1">
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">#{index + 1} · {KIND_LABEL[s.kind]}</span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onMove(-1)} disabled={index === 0} title="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onMove(1)} disabled={index === total - 1} title="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={onDelete} title="Delete section"><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
            <Input key={`e:${s.eyebrow}`} defaultValue={s.eyebrow} placeholder="Label" className="h-8 text-xs uppercase tracking-wide"
              onBlur={(e) => { if (e.target.value !== s.eyebrow) onSave({ eyebrow: e.target.value }); }} />
            <Input key={`h:${s.heading}`} defaultValue={s.heading} placeholder="Heading on screen" className="h-8 text-sm font-semibold"
              onBlur={(e) => { if (e.target.value !== s.heading) onSave({ heading: e.target.value }); }} />
          </div>
          <div>
            <Textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              onBlur={() => { if (script !== s.script) onSave({ script }); }}
              rows={Math.min(14, Math.max(4, Math.ceil(script.length / 95)))}
              className="text-sm leading-relaxed"
              placeholder="What you say on this section"
            />
            <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">{wordCount(script)} words · ~{fmtDuration(secondsFor(script))}</p>
          </div>

          {!NO_VISUAL.has(s.kind) && <VisualPicker section={s} pool={pool} onChange={onVideo} />}

          {s.kind === 'media' && (
            <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {hasVideo ? <Video className="h-3.5 w-3.5 text-primary" /> : <VideoOff className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">
                  {hasVideo
                    ? <><span className="font-medium text-foreground">{s.videoTitle || 'Video'}</span>{s.videoChannel ? ` · ${s.videoChannel}` : ''}</>
                    : <span className="text-muted-foreground">No video — the screen shows the article instead.{s.videoReason ? ` (${s.videoReason})` : ''}</span>}
                </span>
                {hasVideo && s.videoId && (
                  <a href={`https://www.youtube.com/watch?v=${s.videoId}`} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" title="Open on YouTube">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {hasVideo && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={videoBusy} onClick={() => setVideo(null)}>Remove</Button>}
              </div>
              <div className="mt-2 flex gap-2">
                <Input value={videoInput} onChange={(e) => setVideoInput(e.target.value)} placeholder="Paste a YouTube link to use a different video" className="h-7 text-xs"
                  onKeyDown={(e) => { if (e.key === 'Enter' && videoInput.trim()) void setVideo(videoInput.trim()); }} />
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={videoBusy || !videoInput.trim()} onClick={() => setVideo(videoInput.trim())}>
                  {videoBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Use'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** A still of any visual — a video file shows its first second. */
function Still({ v, className }: { v: Visual; className: string }) {
  return v.kind === 'video'
    ? <video src={`${v.src}#t=1`} preload="metadata" muted playsInline className={className} />
    : <img src={visualStill(v)} alt="" className={className} />;
}

const VIS_LABEL: Record<Visual['kind'], string> = { image: 'Screenshot', gif: 'GIF', video: 'Video file', clip: 'Clip of the company video' };

/** The section's screenshot / GIF / clip, and a picker over the dive's pool. */
function VisualPicker({ section: s, pool, onChange }: { section: Section; pool: Visual[]; onChange: (s: Section) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pick = async (visualId: string) => {
    setBusy(true);
    try { onChange((await updateSection({ sectionId: s.id, visualId })).section); setOpen(false); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const v = s.visual;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
      <div className="flex items-center gap-2">
        {v ? <Still v={v} className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">none</span>}
        <span className="min-w-0 flex-1">
          {v ? <><span className="font-medium text-foreground">{VIS_LABEL[v.kind]}</span> · {v.description} <span className="text-muted-foreground">({v.credit})</span></>
            : <span className="text-muted-foreground">No screenshot, GIF or clip on this section.</span>}
        </span>
        {pool.length > 0 && <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Change'}</Button>}
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button disabled={busy} onClick={() => pick('')}
            className={`flex aspect-video items-center justify-center rounded border text-[11px] text-muted-foreground hover:border-primary/60 ${!v ? 'border-primary' : 'border-border'}`}>None</button>
          {pool.map((p) => (
            <button key={p.id} disabled={busy} onClick={() => pick(p.id)} title={`${VIS_LABEL[p.kind]}: ${p.description}`}
              className={`group relative aspect-video overflow-hidden rounded border hover:border-primary/60 ${v?.id === p.id ? 'border-primary ring-1 ring-primary' : 'border-border'}`}>
              <Still v={p} className="h-full w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-left text-[10px] text-white">{VIS_LABEL[p.kind]} · {p.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Large animated preview; ←/→ step through sections (re-keyed so each one replays its build). */
function PreviewDialog({ sections, title, index, onIndex }: {
  sections: Section[]; title: string; index: number | null; onIndex: (i: number | null) => void;
}) {
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < sections.length - 1) { e.preventDefault(); onIndex(index + 1); }
      if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onIndex(index - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, sections.length, onIndex]);

  const s = index !== null ? sections[index] : null;
  return (
    <Dialog open={index !== null} onOpenChange={(o) => !o && onIndex(null)}>
      <DialogContent className="max-w-5xl gap-3 p-3">
        <DialogTitle className="text-sm">{s ? `#${(index ?? 0) + 1} · ${s.heading || KIND_LABEL[s.kind]}` : ''}</DialogTitle>
        {s && index !== null && (
          <>
            <div className="relative aspect-video overflow-hidden rounded-md bg-black">
              <StageFrame index={index} total={sections.length}>
                {/* active={false}: the preview shows a media section's thumbnail, not a player */}
                <Scene key={`${s.id}:${replay}`} section={s} index={index} total={sections.length} title={title} active={false} />
              </StageFrame>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onIndex(index - 1)} disabled={index === 0}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="outline" size="sm" onClick={() => onIndex(index + 1)} disabled={index >= sections.length - 1}><ChevronRight className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => setReplay((r) => r + 1)} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> Replay</Button>
              <span className="ml-auto text-xs text-muted-foreground">← → to step</span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * v2: the demo agent (Jake, 2026-10-02: "a real agent that shows a live demo,
 * with a toggle on or off"). On = while building, an AI agent uses the real
 * product in the Lab's browser and the recording becomes a demo chapter; the
 * stage can also run it live.
 */
function DemoAgentSwitch({ dive, job, onChange, onRecord, onAttach }: { dive: DeepDive; job: DemoJobInfo | null; onChange: (patch: { demoAgent?: boolean; demoUrl?: string }) => void; onRecord: () => void; onAttach: () => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
      <button type="button" role="switch" aria-checked={!!dive.demoAgent} onClick={() => onChange({ demoAgent: !dive.demoAgent })}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${dive.demoAgent ? 'bg-primary' : 'bg-muted-foreground/30'}`}
        title="Demo agent on/off">
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-all ${dive.demoAgent ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      <span className="font-medium text-foreground">Demo agent</span>
      <span className="text-muted-foreground">{dive.demoAgent ? 'An AI agent uses the real product while building and records it.' : 'Off — the demos use screenshots and the official video.'}</span>
      {dive.demoAgent && (
        <Input key={`u:${dive.demoUrl}`} defaultValue={dive.demoUrl} placeholder="Product URL (optional, e.g. https://chatgpt.com)" className="h-7 max-w-xs text-xs"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (dive.demoUrl ?? '')) onChange({ demoUrl: v }); }} />
      )}
      {dive.demoAgent && (
        <span className="flex items-center gap-2">
          {job && <span className={job.status === 'done' ? 'text-emerald-400' : job.status === 'failed' || job.status === 'cancelled' ? 'text-rose-400' : 'text-amber-400'}>
            Recording: {job.status}{job.error ? ` — ${job.error}` : ''}
          </span>}
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRecord} disabled={!dive.demoUrl || job?.status === 'queued' || job?.status === 'running'}
            title={dive.demoUrl ? 'Run the agent on the product now' : 'Add the product URL first'}>{job ? 'Record again' : 'Record now'}</Button>
          {job?.status === 'done' && <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onAttach}>Add recording to the show</Button>}
        </span>
      )}
    </div>
  );
}
