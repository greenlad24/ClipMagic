import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from 'zite-auth-sdk';
import { getProject, getShots, updateShot, getDownloadUrl, getWaveform, completeProject, captureShots, updateProjectSettings, deleteShots, getMusicTracks } from 'zite-endpoints-sdk';
import { GetProjectOutputType, GetShotsOutputType } from 'zite-endpoints-sdk';
import { Loader2, ArrowLeft, Undo2, Redo2, Download, FileJson, FileUp, Film, MonitorPlay, Sparkles, CheckSquare, Trash2, Square, Video, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useDebouncedCallback } from 'use-debounce';
import { uploadFile } from 'zite-file-upload-sdk';
import { useUndoRedo } from '@/hooks/useUndoRedo';
import { renderInBrowser, RenderProgress, RenderDiagnostics, ClipDiagnostic, formatLabel, fileExtension, preflightValidation } from '@/utils/browserRenderer';
import FinalRenderPanel from '@/components/FinalRenderPanel';
import VideoCanvas from '@/components/timeline/VideoCanvas';
import TimelinePanel from '@/components/timeline/TimelinePanel';
import PropertyPanel from '@/components/timeline/PropertyPanel';
import TemplateDialog from '@/components/timeline/TemplateDialog';
import PromoVideosDialog from '@/components/PromoVideosDialog';
import { TimelineShot, SubtitleEvent, TimelineTemplate } from '@/components/timeline/types';

type Project = GetProjectOutputType['project'];
type ApiShot = GetShotsOutputType['shots'][0];

const toTimelineShot = (s: ApiShot): TimelineShot => ({
  id: s.id, caption: s.caption ?? undefined, shotType: s.shotType ?? undefined,
  beat: s.beat ?? undefined, beatCount: s.beatCount ?? undefined,
  startTime: s.startTime ?? undefined, endTime: s.endTime ?? undefined,
  targetUrl: s.targetUrl ?? undefined, targetSelector: s.targetSelector ?? undefined,
  transitionIn: s.transitionIn ?? undefined, sfxIn: s.sfxIn ?? undefined,
  clipUrl: s.clipUrl ?? undefined, captureStatus: s.captureStatus ?? undefined,
  uiLabelsJson: s.uiLabelsJson ?? undefined,
  visualIntent: (() => { try { const l = s.uiLabelsJson ? JSON.parse(s.uiLabelsJson) : {}; return l.visualIntent ?? undefined; } catch { return undefined; } })(),
});

export default function TimelineEditorPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();

  const [project, setProject]   = useState<Project | null>(null);
  const [loading, setLoading]   = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom]         = useState(60);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showPromoVideos, setShowPromoVideos] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [renderDiagnostics, setRenderDiagnostics] = useState<RenderDiagnostics | null>(null);
  const [preflightErrors, setPreflightErrors] = useState<ClipDiagnostic[] | null>(null);
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);
  const [musicInfo, setMusicInfo] = useState<{ bpm?: number; trackName?: string } | null>(null);
  const [musicUrl, setMusicUrl] = useState<string | undefined>(undefined);
  const [musicVolume, setMusicVolume] = useState(0.15);
  const [musicMuted, setMusicMuted] = useState(false);
  const [subtitleTemplate, setSubtitleTemplate] = useState('bold-center');
  const [beatGrid, setBeatGrid] = useState<number[]>([]);
  const [downbeats, setDownbeats] = useState<number[]>([]);
  const [sectionMarkers, setSectionMarkers] = useState<Record<string, number>>({});
  const [showBeatGrid, setShowBeatGrid] = useState(true);

  const history = useUndoRedo<TimelineShot[]>([]);
  const shots = history.current;
  const savingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  useEffect(() => {
    if (!user || !projectId) return;
    Promise.all([getProject({ projectId }), getShots({ projectId })]).then(([{ project: p }, { shots: s }]) => {
      setProject(p);
      history.reset(s.map(toTimelineShot));
      if (p.musicVolume !== undefined && p.musicVolume !== null) setMusicVolume(p.musicVolume);
      if (p.subtitleTemplate) setSubtitleTemplate(p.subtitleTemplate);
      setLoading(false);
      const trackId = Array.isArray(p.musicTrack) ? p.musicTrack[0] : p.musicTrack;
      if (trackId) {
        getWaveform({ trackId }).then((wf) => {
          setWaveformPeaks(wf.peaks);
          setMusicInfo({ bpm: wf.bpm });
          setBeatGrid(wf.beatGrid ?? []);
          setDownbeats(wf.downbeats ?? []);
          setSectionMarkers(wf.sectionMarkers ?? {});
        }).catch(() => {});
        // Resolve the track's audio URL so the preview can play the music bed.
        getMusicTracks({}).then(({ tracks }) => {
          const track = tracks.find((t) => t.id === trackId);
          if (track?.audioUrl) setMusicUrl(track.audioUrl);
          if (track?.trackName) setMusicInfo((mi) => ({ ...(mi ?? {}), trackName: track.trackName }));
        }).catch(() => {});
      }
    }).catch(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); history.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history.undo, history.redo]);

  const saveMusicVolume = useDebouncedCallback(async (vol: number) => {
    if (!projectId) return;
    try { await updateProjectSettings({ projectId, musicVolume: vol }); } catch { /* silent */ }
  }, 500);

  const handleSubtitleTemplateChange = async (tpl: string) => {
    setSubtitleTemplate(tpl);
    if (!projectId) return;
    try { await updateProjectSettings({ projectId, subtitleTemplate: tpl }); toast.success('Subtitle style updated'); }
    catch { toast.error('Could not save subtitle style'); }
  };

  const handleMusicVolumeChange = (vol: number) => {
    setMusicVolume(vol);
    saveMusicVolume(vol);
  };

  const saveShot = useDebouncedCallback(async (shotId: string, updates: Partial<TimelineShot>) => {
    if (savingRef.current.has(shotId)) return;
    savingRef.current.add(shotId);
    try { await updateShot({ shotId, ...updates }); }
    catch { /* silent */ }
    finally { savingRef.current.delete(shotId); }
  }, 700);

  const handleShotTimingUpdate = useCallback((shotId: string, startTime: number, endTime: number) => {
    history.push(shots.map(s => s.id === shotId ? { ...s, startTime, endTime } : s));
    saveShot(shotId, { startTime, endTime });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots, history.push]);

  const handleShotChange = useCallback((updates: Partial<TimelineShot>) => {
    if (!selectedId) return;
    history.push(shots.map(s => s.id === selectedId ? { ...s, ...updates } : s));
    saveShot(selectedId, updates);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, shots, history.push]);

  const handleTemplateImport = useCallback((template: TimelineTemplate) => {
    const dur = project?.durationSeconds ?? 60;
    const next: TimelineShot[] = template.shots.map((ts, i) => {
      const match = shots.find(s => s.shotType === ts.shotType && s.beat === ts.beat) ?? shots[i];
      return match ? {
        ...match,
        shotType: ts.shotType, beat: ts.beat,
        startTime: parseFloat((ts.startRatio * dur).toFixed(3)),
        endTime: parseFloat((ts.endRatio * dur).toFixed(3)),
        transitionIn: ts.transitionIn ?? match.transitionIn,
        sfxIn: ts.sfxIn ?? match.sfxIn,
        caption: ts.captionPlaceholder ?? match.caption ?? '',
      } : {
        id: `placeholder-${i}`, shotType: ts.shotType, beat: ts.beat,
        startTime: parseFloat((ts.startRatio * dur).toFixed(3)),
        endTime: parseFloat((ts.endRatio * dur).toFixed(3)),
        transitionIn: ts.transitionIn, caption: ts.captionPlaceholder ?? '',
      };
    }).filter(s => s.id && !s.id.startsWith('placeholder'));
    history.push(next);
    next.forEach(s => saveShot(s.id, { startTime: s.startTime, endTime: s.endTime, transitionIn: s.transitionIn, sfxIn: s.sfxIn, caption: s.caption }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots, project?.durationSeconds, history.push]);

  const handleGenerateAll = async () => {
    if (!projectId) return;
    const targets = shots.filter(s => s.shotType !== 'Talking Head');
    if (targets.length === 0) {
      toast('No B-Roll or Screencast shots to generate.');
      return;
    }
    setGenerating(true);
    const progressToastId = 'generate-all-progress';
    toast.loading(
      `Generating ${targets.length} shot${targets.length !== 1 ? 's' : ''}… this may take several minutes`,
      { id: progressToastId }
    );
    try {
      const result = await captureShots({ projectId });
      toast.dismiss(progressToastId);
      const { shots: freshShots } = await getShots({ projectId });
      history.reset(freshShots.map(toTimelineShot));
      if (result.failed > 0 && result.mediaGenerated === 0) {
        toast.error(`All ${result.failed} shot${result.failed !== 1 ? 's' : ''} failed — check logs`);
      } else if (result.failed > 0) {
        toast.success(`${result.mediaGenerated} clip${result.mediaGenerated !== 1 ? 's' : ''} generated · ${result.failed} failed`);
      } else {
        toast.success(`${result.captured} shot${result.captured !== 1 ? 's' : ''} processed successfully!`);
      }
    } catch (e: any) {
      toast.dismiss(progressToastId);
      toast.error(e?.message ?? 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const toggleSelectMode = () => {
    setSelectMode(s => !s);
    setSelectedIds(new Set());
    setSelectedId(null);
  };

  const handleShotToggle = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = () => {
    const nonTH = shots.filter(s => s.shotType !== 'Talking Head').map(s => s.id);
    setSelectedIds(new Set(nonTH));
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    try {
      const ids = [...selectedIds];
      await deleteShots({ shotIds: ids });
      history.push(history.current.filter(s => !selectedIds.has(s.id)));
      setSelectedIds(new Set());
      setSelectMode(false);
      toast.success(`${ids.length} shot${ids.length !== 1 ? 's' : ''} deleted`);
    } catch (e: any) {
      toast.error(e.message ?? 'Delete failed');
    } finally {
      setDeleting(false);
      setShowBulkDeleteDialog(false);
    }
  };

  const handleDeleteShot = async (shotId: string) => {
    try {
      await deleteShots({ shotIds: [shotId] });
      history.push(history.current.filter(s => s.id !== shotId));
      setSelectedId(null);
      toast.success('Shot deleted');
    } catch (e: any) {
      toast.error(e.message ?? 'Delete failed');
    }
  };

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  // ── Export in Browser (single authoritative export path) ─────────────────────
  const handleExport = async () => {
    if (!projectId || !project?.narrationUrl) {
      toast.error('No narration video found — please re-upload the project');
      return;
    }

    setRendering(true);
    setRenderDiagnostics(null);
    setPreflightErrors(null);

    // ── Step 1: Strict preflight validation ──────────────────────────────────
    setRenderProgress({ pct: 0, label: 'Validating assets…' });

    const preflight = await preflightValidation(
      project.narrationUrl,
      shots,
      subtitles,
      duration,
      (label) => setRenderProgress({ pct: 0.01, label }),
    );

    if (!preflight.ok) {
      // Show errors as toasts
      for (const err of preflight.errors) toast.error(err);
      // Show failed clip details
      const failedClips = preflight.clipReport.filter(c => c.status !== 'ok');
      if (failedClips.length > 0) {
        setPreflightErrors(failedClips);
      }
      setRenderProgress(null);
      setRendering(false);
      return;
    }

    // Show warnings (non-blocking)
    for (const warn of preflight.warnings) toast.warning(warn);

    const okClips = preflight.clipReport.filter(c => c.status === 'ok').length;
    const totalClips = preflight.clipReport.length;
    if (totalClips > 0) {
      toast.success(`All ${okClips} overlay clips validated ✓`);
    }

    // ── Step 2: Resolve music URL ────────────────────────────────────────────
    let musicUrl: string | undefined;
    const trackId = Array.isArray(project.musicTrack) ? project.musicTrack[0] : project.musicTrack;
    if (trackId) {
      try {
        const { tracks } = await getMusicTracks({});
        const track = tracks.find(t => t.id === trackId);
        if (track?.audioUrl) musicUrl = track.audioUrl;
        else console.warn('[export] Music track not found or has no audioUrl');
      } catch (e: any) {
        console.warn('[export] Failed to resolve music track:', e?.message);
      }
    }

    // ── Step 3: Browser render ───────────────────────────────────────────────
    setRenderProgress({ pct: 0.05, label: 'Starting export…' });

    let result: { blob: Blob; diagnostics: import('@/utils/browserRenderer').RenderDiagnostics };
    try {
      result = await renderInBrowser(
        project.narrationUrl,
        musicUrl,
        shots,
        subtitles,
        duration,
        (p) => setRenderProgress(p),
        project.videoChunksJson ?? undefined,
        musicVolume,
      );
    } catch (e: any) {
      toast.error(`Export failed: ${e.message ?? 'Unknown error'}`);
      setRenderProgress(null);
      setRendering(false);
      return;
    }

    const { blob: renderedBlob, diagnostics } = result;
    setRenderDiagnostics(diagnostics);

    console.log('[export] Diagnostics:', diagnostics);

    // ── Step 4: Immediate local download ─────────────────────────────────────
    const ext = fileExtension(renderedBlob.type);
    const filename = `${project.title ?? 'video'}_${Date.now()}.${ext}`;
    triggerBlobDownload(renderedBlob, filename);
    toast.success(`${formatLabel(renderedBlob.type)} downloaded locally (${diagnostics.outputSizeMB}MB)`);

    // ── Step 5: Upload to cloud ──────────────────────────────────────────────
    let fileUrl: string | null = null;
    try {
      setRenderProgress({ pct: 0.92, label: `Uploading ${formatLabel(renderedBlob.type)}…` });
      const uploadResult = await uploadFile({ data: renderedBlob, filename });
      fileUrl = uploadResult.fileUrl;
    } catch (e: any) {
      toast.error(`Upload failed: ${e.message ?? 'Unknown error'}. You still have the local download.`);
    }

    // ── Step 6: Save to project ──────────────────────────────────────────────
    if (fileUrl) {
      try {
        setRenderProgress({ pct: 0.97, label: 'Saving…' });
        await completeProject({ projectId, outputUrl: fileUrl });
        setProject(p => p ? { ...p, outputUrl: fileUrl!, status: 'Complete' } : p);
      } catch (e: any) {
        toast.error(`Save failed: ${e.message ?? 'Unknown error'}. Upload URL: ${fileUrl}`);
      }
    }

    setRenderProgress({ pct: 1, label: 'Done!' });
    if (fileUrl) toast.success('Video exported, uploaded, and saved!');
    setTimeout(() => setRenderProgress(null), 3000);
    setRendering(false);
  };

  const handleExportJson = () => {
    const manifest = {
      projectId, title: project?.title, duration: project?.durationSeconds,
      narrationUrl: project?.narrationUrl,
      musicTrackId: Array.isArray(project?.musicTrack) ? project.musicTrack[0] : project?.musicTrack,
      shots: shots.map(s => {
        let labels = {};
        try { if (s.uiLabelsJson) labels = JSON.parse(s.uiLabelsJson); } catch { /* */ }
        return { ...s, ...labels, uiLabelsJson: undefined };
      }),
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${project?.title ?? 'composition'}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  let animationMap: Array<{ second: number; intensity: string }> = [];
  try { if (project?.animationMapJson) animationMap = JSON.parse(project.animationMapJson); } catch { /* */ }
  let subtitles: SubtitleEvent[] = [];
  try { if (project?.subtitlesJson) subtitles = JSON.parse(project.subtitlesJson); } catch { /* */ }

  const duration = project?.durationSeconds ?? 60;
  const selectedShot = shots.find(s => s.id === selectedId) ?? null;

  if (authLoading || loading) {
    return (
      <div className="h-screen bg-background flex flex-col">
        <div className="border-b border-border px-4 py-3"><Skeleton className="h-5 w-48" /></div>
        <div className="flex-1 flex gap-4 p-4"><Skeleton className="h-full w-44" /><Skeleton className="h-full flex-1" /></div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 border-b border-border px-4 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button onClick={() => navigate('/')} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Home">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-foreground truncate">{project?.title ?? 'Timeline Editor'}</span>
          <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded shrink-0">
            {shots.length} shots · {duration.toFixed(0)}s
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={history.undo} disabled={!history.canUndo} title="Undo (Ctrl+Z)"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={history.redo} disabled={!history.canRedo} title="Redo (Ctrl+Shift+Z)"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-5 bg-border mx-1" />
          <select
            value={subtitleTemplate}
            onChange={(e) => handleSubtitleTemplateChange(e.target.value)}
            title="Subtitle style (center-screen)"
            className="h-7 text-xs rounded-md border border-border bg-background px-2 text-foreground hover:bg-muted cursor-pointer"
          >
            <option value="bold-center">Subtitles: Bold</option>
            <option value="hormozi">Subtitles: Hormozi</option>
            <option value="karaoke-pop">Subtitles: Karaoke Pop</option>
            <option value="tiktok-clean">Subtitles: TikTok Clean</option>
            <option value="neon">Subtitles: Neon</option>
            <option value="minimal">Subtitles: Minimal</option>
          </select>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setShowTemplate(true)}>
            <FileUp className="w-3.5 h-3.5" />Template
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setShowPromoVideos(true)}>
            <Video className="w-3.5 h-3.5" />Promo Videos
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={handleExportJson}>
            <FileJson className="w-3.5 h-3.5" />Export JSON
          </Button>
          {project?.outputUrl && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" disabled={downloading} onClick={async () => {
              setDownloading(true);
              try {
                const { downloadUrl } = await getDownloadUrl({ fileUrl: project.outputUrl! });
                const res = await fetch(downloadUrl);
                if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
                const dlBlob = await res.blob();
                const ext = fileExtension(dlBlob.type || project.outputUrl!);
                const blobUrl = URL.createObjectURL(dlBlob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = `${project.title ?? 'video'}.${ext}`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
              } catch { toast.error('Download failed — try again'); }
              finally { setDownloading(false); }
            }}>
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {downloading ? 'Downloading…' : formatLabel(project.outputUrl ?? '')}
            </Button>
          )}
          <Button
            variant={selectMode ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={toggleSelectMode}
            disabled={generating || rendering}
            title="Toggle bulk-select mode to delete multiple shots"
          >
            {selectMode ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            {selectMode ? 'Selecting' : 'Select'}
          </Button>

          {selectMode && (
            <>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={handleSelectAll}>All</Button>
              <Button
                variant="destructive" size="sm" className="h-7 text-xs gap-1.5"
                disabled={selectedIds.size === 0 || deleting}
                onClick={() => setShowBulkDeleteDialog(true)}
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
              </Button>
            </>
          )}

          <Button
            variant="outline" size="sm" className="h-7 text-xs gap-1.5"
            onClick={handleGenerateAll}
            disabled={generating || rendering || selectMode}
            title={`Regenerate media for all B-Roll and Screencast shots (${shots.filter(s => s.shotType !== 'Talking Head').length} shots)`}
          >
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {generating ? 'Generating…' : `Generate All (${shots.filter(s => s.shotType !== 'Talking Head').length})`}
          </Button>

          <Button
            size="sm" className="h-7 text-xs gap-1.5"
            onClick={handleExport}
            disabled={rendering || generating || selectMode}
            title="Export video in your browser — validates all assets, downloads locally, and saves to project"
            variant="outline"
          >
            {rendering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MonitorPlay className="w-3.5 h-3.5" />}
            {rendering ? 'Exporting…' : 'Export in Browser'}
          </Button>

          <FinalRenderPanel
            projectId={projectId!}
            disabled={rendering || generating || selectMode}
          />
        </div>
      </div>

      {/* Editor layout */}
      <div className="flex-1 flex overflow-hidden">
        <div className="shrink-0 border-r border-border p-3 bg-card/20 flex flex-col">
          <VideoCanvas
            narrationUrl={project?.narrationUrl ?? undefined}
            videoChunksJson={project?.videoChunksJson ?? undefined}
            shots={shots} subtitles={subtitles}
            playhead={playhead} duration={duration}
            isPlaying={isPlaying}
            onPlayPause={() => setIsPlaying(p => !p)}
            onSeek={t => { setPlayhead(t); setIsPlaying(false); }}
            onTimeUpdate={setPlayhead}
            musicUrl={musicUrl} musicVolume={musicVolume} musicMuted={musicMuted}
            subtitleTemplate={subtitleTemplate}
          />
        </div>

        <TimelinePanel
          shots={shots} duration={duration} playhead={playhead}
          zoom={zoom} waveformPeaks={waveformPeaks}
          animationMap={animationMap} subtitles={subtitles}
          musicInfo={musicInfo} musicVolume={musicVolume} onMusicVolumeChange={handleMusicVolumeChange}
          musicMuted={musicMuted} onMusicMutedChange={setMusicMuted}
          beatGrid={beatGrid} downbeats={downbeats} sectionMarkers={sectionMarkers}
          showBeatGrid={showBeatGrid} onShowBeatGridChange={setShowBeatGrid}
          selectedShotId={selectedId}
          onShotSelect={setSelectedId}
          onShotUpdate={handleShotTimingUpdate}
          onPlayheadChange={t => { setPlayhead(t); setIsPlaying(false); }}
          onZoomChange={setZoom}
          isSelectMode={selectMode}
          selectedIds={selectedIds}
          onShotToggle={handleShotToggle}
        />

        <PropertyPanel shot={selectedShot} onShotChange={handleShotChange} onDeleteShot={handleDeleteShot} />
      </div>

      <TemplateDialog
        open={showTemplate} onClose={() => setShowTemplate(false)}
        shots={shots} duration={duration} onImport={handleTemplateImport}
      />

      <PromoVideosDialog open={showPromoVideos} onClose={() => setShowPromoVideos(false)} />

      {/* Bulk delete confirmation */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} shot{selectedIds.size !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {selectedIds.size} selected shot{selectedIds.size !== 1 ? 's' : ''} from the timeline and database. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteSelected}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete {selectedIds.size} shot{selectedIds.size !== 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preflight failure dialog — shows per-shot clip diagnostics */}
      <AlertDialog open={preflightErrors !== null} onOpenChange={(open) => { if (!open) setPreflightErrors(null); }}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="w-5 h-5" />
              Export blocked — {preflightErrors?.length} clip{(preflightErrors?.length ?? 0) !== 1 ? 's' : ''} failed validation
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  The following overlay shots cannot be exported. Fix them before trying again.
                </p>
                <div className="max-h-60 overflow-y-auto space-y-2">
                  {preflightErrors?.map((c) => (
                    <div key={c.shotId} className="bg-muted/50 rounded-lg p-2.5 text-xs space-y-1">
                      <div className="flex items-center gap-2">
                        {c.status === 'missing' ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                        )}
                        <span className="font-semibold text-foreground">{c.shotType}</span>
                        <span className="font-mono text-muted-foreground">{c.shotId.slice(0, 8)}</span>
                      </div>
                      {c.caption && <p className="text-muted-foreground truncate pl-5">{c.caption}</p>}
                      <p className="text-destructive font-mono pl-5">{c.detail}</p>
                      {c.clipUrl && <p className="text-muted-foreground font-mono text-[10px] truncate pl-5">{c.clipUrl}</p>}
                    </div>
                  ))}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Export progress overlay */}
      {renderProgress && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-card border border-border rounded-2xl p-8 w-[420px] shadow-xl flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                {renderProgress.pct >= 1
                  ? <CheckCircle2 className="w-5 h-5 text-primary" />
                  : <Loader2 className="w-5 h-5 text-primary animate-spin" />}
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Export in Browser</p>
                <p className="text-xs text-muted-foreground">Rendered locally · ~30fps best-effort</p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground truncate">{renderProgress.label}</span>
                <span className="text-primary font-mono shrink-0 ml-2">{(renderProgress.pct * 100).toFixed(0)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${renderProgress.pct * 100}%` }} />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Compositing video in your browser at ~30fps (best-effort). Keep this tab active.
              All overlay clips were validated before export started.
            </p>

            {/* Diagnostics panel — shows after render completes */}
            {renderDiagnostics && (
              <div className="bg-muted/60 rounded-lg p-3 space-y-1 text-[11px] font-mono text-muted-foreground">
                <div className="flex justify-between"><span>Mode</span><span className="text-foreground">{renderDiagnostics.actualMode}</span></div>
                <div className="flex justify-between"><span>Target FPS</span><span className="text-foreground">~{renderDiagnostics.targetFps} (best-effort)</span></div>
                <div className="flex justify-between"><span>Video duration</span><span className="text-foreground">{renderDiagnostics.videoDurationSeconds.toFixed(1)}s</span></div>
                <div className="flex justify-between"><span>Wall time</span><span className="text-foreground">{renderDiagnostics.wallTimeSeconds.toFixed(1)}s</span></div>
                <div className="flex justify-between"><span>Overlays</span><span className="text-foreground">{renderDiagnostics.overlaysLoaded}/{renderDiagnostics.totalOverlayShots} loaded</span></div>
                <div className="flex justify-between"><span>Output</span><span className="text-foreground">{renderDiagnostics.outputFormat} · {renderDiagnostics.outputSizeMB}MB</span></div>
                {renderDiagnostics.overlaysFailed > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-border space-y-0.5">
                    <span className="text-destructive font-semibold">Failed overlays:</span>
                    {renderDiagnostics.failedShots.map((f, i) => (
                      <div key={i} className="text-destructive">✗ {f.shotType} {f.shotId.slice(0, 8)}: {f.reason}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
