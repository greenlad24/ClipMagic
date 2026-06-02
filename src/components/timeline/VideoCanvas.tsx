import { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, SkipBack, Volume2, VolumeX, Loader2, AlertCircle, RefreshCw, Download, Bug } from 'lucide-react';
import { TimelineShot, SubtitleEvent, CameraKeyframe } from './types';

const fmt = (s: number) =>
  `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function lerpKfs(kfs: CameraKeyframe[], t: number) {
  if (!kfs.length) return { zoom: 1, panX: 0, panY: 0 };
  if (t <= kfs[0].t) return kfs[0];
  for (let i = 1; i < kfs.length; i++) {
    if (t <= kfs[i].t) {
      const r = (t - kfs[i - 1].t) / (kfs[i].t - kfs[i - 1].t);
      const a = kfs[i - 1], b = kfs[i];
      return { zoom: a.zoom + r * (b.zoom - a.zoom), panX: a.panX + r * (b.panX - a.panX), panY: a.panY + r * (b.panY - a.panY) };
    }
  }
  return kfs[kfs.length - 1];
}

/** Returns true if the URL points to a raster/static image (including base64 data URLs). */
function isImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  const clean = url.split('?')[0].toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif|avif|bmp|svg)$/.test(clean);
}

/** Returns true if the URL is a YouTube watch/shorts URL. */
function isYouTubeUrl(url: string): boolean {
  return /youtube\.com|youtu\.be/i.test(url);
}

/** Convert a YouTube watch/shorts URL to a high-quality thumbnail URL. */
function getYouTubeThumbnailUrl(url: string): string {
  const m = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : '';
}

interface Props {
  narrationUrl?: string;
  videoChunksJson?: string;
  shots: TimelineShot[];
  subtitles: SubtitleEvent[];
  playhead: number;
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (t: number) => void;
  onTimeUpdate: (t: number) => void;
  /** Background music track URL (played under the narration in the preview). */
  musicUrl?: string;
  /** 0–1 music gain. */
  musicVolume?: number;
  /** When true, the music bed is silenced in the preview. */
  musicMuted?: boolean;
  /** Subtitle template name (drives the preview caption look). */
  subtitleTemplate?: string;
}

type LoadState = 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

// Preview styles per subtitle template — kept in EXACT sync with the server's
// SUBTITLE_TEMPLATES (server/src/render/manifest.ts). fontPx is the render font
// size on the 1080-wide canvas; the preview scales it by the canvas ratio so
// what you see matches the final render.
// Preview styles for the 4 approved subtitle templates — kept in EXACT sync
// with the server's SUBTITLE_TEMPLATES. line=base color, emph=active-word color,
// font/emphFont are CSS font stacks (the bundled fonts are loaded via @font-face
// in index.css), box=rounded background, boxColor when boxed.
const RENDER_WIDTH = 1080;
const SUBTITLE_PREVIEW_STYLES: Record<string, {
  line: string; emph: string; fontPx: number; italic?: boolean; allCaps?: boolean;
  font: string; emphFont: string; weight: number; emphWeight: number;
  shadow?: boolean; box?: boolean; boxColor?: string; highlightWord?: boolean;
}> = {
  'yellow-mont':     { line: '#FEDA03', emph: '#FFFFFF', fontPx: 96, italic: true,  font: 'Montserrat, sans-serif', emphFont: 'Montserrat, sans-serif', weight: 600, emphWeight: 800, shadow: true, highlightWord: true },
  'white-mont':      { line: '#FFFFFF', emph: '#FEDA03', fontPx: 96, italic: false, font: 'Montserrat, sans-serif', emphFont: 'Montserrat, sans-serif', weight: 800, emphWeight: 800, shadow: true, highlightWord: true },
  'yellow-box':      { line: '#F9FC26', emph: '#FFFFFF', fontPx: 108, italic: false, font: 'Alexandria, sans-serif', emphFont: 'Alexandria, sans-serif', weight: 700, emphWeight: 700, box: true, boxColor: '#000000' },
  'black-on-yellow': { line: '#050000', emph: '#FFFFFF', fontPx: 88, italic: false, allCaps: true, font: 'Montserrat, sans-serif', emphFont: 'Montserrat, sans-serif', weight: 900, emphWeight: 900, box: true, boxColor: '#F7BD05' },
};

export default function VideoCanvas({ narrationUrl, videoChunksJson, shots, subtitles, playhead, duration, isPlaying, onPlayPause, onSeek, onTimeUpdate, musicUrl, musicVolume = 0.08, musicMuted = false, subtitleTemplate = 'yellow-mont' }: Props) {
  const vidRef = useRef<HTMLVideoElement>(null);
  const overlayVidRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number>(0);

  const [muted, setMuted] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [downloadLabel, setDownloadLabel] = useState('');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState(0);

  const prevOverlayUrl = useRef<string | null>(null);

  // Overlay visibility — MUST mirror the server render exactly (build.ts):
  // the overlay is shown from (startTime + overlayDelaySeconds) until endTime.
  // The render does NOT implement a narrator-return phase, so the preview must
  // not either — otherwise preview and final render would disagree.
  const overlayCandidate = shots.find(s => s.shotType !== 'Talking Head' && s.clipUrl && playhead >= (s.startTime ?? 0) && playhead < (s.endTime ?? 0));

  type OverlayPhase = 'narrator-first' | 'overlay-visible';
  let currentPhase: OverlayPhase | null = null;

  const activeOverlay = (() => {
    if (!overlayCandidate) return undefined;
    let overlayDelay = 0;
    try {
      if (overlayCandidate.uiLabelsJson) {
        const lbl = JSON.parse(overlayCandidate.uiLabelsJson);
        // The render applies overlayDelaySeconds regardless of showNarratorFirst
        // (it shifts the overlay start by exactly this amount), so mirror that.
        if (typeof lbl.overlayDelaySeconds === 'number') overlayDelay = lbl.overlayDelaySeconds;
      }
    } catch { /* */ }
    const elapsed = playhead - (overlayCandidate.startTime ?? 0);
    if (elapsed < overlayDelay) { currentPhase = 'narrator-first'; return undefined; }
    currentPhase = 'overlay-visible';
    return overlayCandidate;
  })();
  const activeTH = shots.find(s => s.shotType === 'Talking Head' && playhead >= (s.startTime ?? 0) && playhead < (s.endTime ?? 0));
  const activeSub = subtitles.find(s => playhead >= s.start && playhead <= s.end);

  const overlayClipUrl = activeOverlay?.clipUrl ?? null;
  // YouTube URLs → show as thumbnail image (browsers can't load them as <video src>)
  const overlayIsYouTube = overlayClipUrl ? isYouTubeUrl(overlayClipUrl) : false;
  const overlayDisplayUrl = overlayIsYouTube && overlayClipUrl
    ? getYouTubeThumbnailUrl(overlayClipUrl)
    : overlayClipUrl;
  // Prefer the stored mediaType when the pipeline set one (stock/promo/generated
  // clips are always video) — URL-extension sniffing is only a fallback. This is
  // what stops a Pexels .mp4 with an odd URL from being mis-rendered as an image.
  const overlayMediaType: string | undefined = (() => {
    try { return activeOverlay?.uiLabelsJson ? JSON.parse(activeOverlay.uiLabelsJson).mediaType : undefined; }
    catch { return undefined; }
  })();
  const overlayIsImage = overlayMediaType === 'video'
    ? false
    : overlayMediaType === 'image'
    ? true
    : overlayDisplayUrl ? (overlayIsYouTube || isImageUrl(overlayDisplayUrl)) : false;

  // Camera keyframe transform
  let camTransform = 'scale(1)';
  if (activeTH?.uiLabelsJson) {
    try {
      const kfs: CameraKeyframe[] = JSON.parse(activeTH.uiLabelsJson).cameraKeyframes ?? [];
      if (kfs.length) {
        const dur = Math.max((activeTH.endTime ?? 1) - (activeTH.startTime ?? 0), 0.01);
        const t = Math.min(1, (playhead - (activeTH.startTime ?? 0)) / dur);
        const { zoom, panX, panY } = lerpKfs(kfs, t);
        camTransform = `scale(${zoom.toFixed(4)}) translate(${(panX * 50).toFixed(2)}%, ${(panY * 50).toFixed(2)}%)`;
      }
    } catch { /* */ }
  }

  // Download chunks → assemble blob URL, or fall back to direct URL
  useEffect(() => {
    let cancelled = false;
    let localBlobUrl: string | null = null;

    const run = async () => {
      let chunks: string[] = [];
      try { if (videoChunksJson) chunks = JSON.parse(videoChunksJson); } catch { /* */ }

      if (!chunks.length) {
        setBlobUrl(null);
        if (narrationUrl) setLoadState('loading');
        else setLoadState('idle');
        return;
      }

      setLoadState('downloading');
      setDownloadLabel(`Downloading 1 / ${chunks.length}…`);

      try {
        const buffers: ArrayBuffer[] = [];
        for (let i = 0; i < chunks.length; i++) {
          if (cancelled) return;
          setDownloadLabel(`Downloading ${i + 1} / ${chunks.length}…`);
          const res = await fetch(chunks[i]);
          if (!res.ok) throw new Error(`Chunk ${i + 1} failed (${res.status})`);
          buffers.push(await res.arrayBuffer());
        }
        if (cancelled) return;
        const blob = new Blob(buffers, { type: 'video/mp4' });
        localBlobUrl = URL.createObjectURL(blob);
        setBlobUrl(localBlobUrl);
        setLoadState('loading');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    };

    run();

    return () => {
      cancelled = true;
      if (localBlobUrl) {
        URL.revokeObjectURL(localBlobUrl);
        setBlobUrl(null);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoChunksJson, narrationUrl, srcKey]);

  const handleRetry = useCallback(() => setSrcKey(k => k + 1), []);

  const effectiveSrc = blobUrl ?? narrationUrl;

  // Play/pause RAF
  useEffect(() => {
    const vid = vidRef.current;
    if (!vid || loadState !== 'ready') return;
    if (isPlaying) {
      vid.play().catch(() => {});
      const tick = () => { onTimeUpdate(vid.currentTime); rafRef.current = requestAnimationFrame(tick); };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      vid.pause();
      cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, onTimeUpdate, loadState]);

  // Seek when scrubbing
  useEffect(() => {
    const vid = vidRef.current;
    if (vid && loadState === 'ready' && !isPlaying && Math.abs(vid.currentTime - playhead) > 0.1) {
      vid.currentTime = playhead;
    }
  }, [playhead, isPlaying, loadState]);

  // Music bed: volume follows the slider; muted by the timeline toggle or the
  // canvas mute button. The narration audio lives on the narration <video>, so
  // music is an independent <audio> element mixed by the browser. We apply
  // volume/mute imperatively (also on mount + loadedmetadata) because the
  // <audio> element only appears once musicUrl resolves — an effect keyed on
  // volume alone would miss that first mount and leave it at full volume.
  const applyMusicGain = useCallback(() => {
    const a = musicRef.current;
    if (!a) return;
    a.volume = Math.max(0, Math.min(1, musicVolume));
    a.muted = musicMuted || muted;
  }, [musicVolume, musicMuted, muted]);

  useEffect(() => { applyMusicGain(); }, [applyMusicGain, musicUrl]);

  // Music play/pause + keep it roughly in sync with the playhead. Driven by the
  // narration video so they stay locked; does NOT gate on the narration's load
  // state so the bed still plays even if the narration is a blob/chunked load.
  useEffect(() => {
    const a = musicRef.current;
    if (!a || !musicUrl) return;
    applyMusicGain();
    if (isPlaying) {
      if (Math.abs(a.currentTime - playhead) > 0.3) a.currentTime = playhead;
      a.play().catch((e) => console.warn('[music] play blocked:', e?.message));
    } else {
      a.pause();
      if (Math.abs(a.currentTime - playhead) > 0.1) a.currentTime = playhead;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playhead, musicUrl]);

  // Overlay crossfade
  useEffect(() => {
    if (overlayClipUrl !== prevOverlayUrl.current) {
      prevOverlayUrl.current = overlayClipUrl;
      if (overlayClipUrl) { setOverlayVisible(false); setTimeout(() => setOverlayVisible(true), 50); }
      else { setOverlayVisible(false); }
    }
  }, [overlayClipUrl]);

  // Sync overlay video (only for non-image clips — skip YouTube thumbnails)
  // Also clamp at clipEndOffset if present
  useEffect(() => {
    const vid = overlayVidRef.current;
    if (!vid || !activeOverlay || overlayIsImage) return;
    let clipStartOffset = 0;
    let clipEndOffset: number | undefined;
    let overlayDelaySec = 0;
    try {
      if (activeOverlay.uiLabelsJson) {
        const lbl = JSON.parse(activeOverlay.uiLabelsJson);
        clipStartOffset = lbl.clipStartOffset ?? 0;
        clipEndOffset = typeof lbl.clipEndOffset === 'number' ? lbl.clipEndOffset : undefined;
        // Mirror the render: the overlay starts playing at (startTime + delay),
        // beginning at clipStartOffset within the source clip. Delay always
        // applies (not gated on showNarratorFirst) to match build.ts.
        if (typeof lbl.overlayDelaySeconds === 'number') overlayDelaySec = lbl.overlayDelaySeconds;
      }
    } catch { /* */ }
    const offset = clipStartOffset + (playhead - (activeOverlay.startTime ?? 0) - overlayDelaySec);
    // Clamp: if we've passed clipEndOffset, pause the overlay at the end
    if (clipEndOffset !== undefined && offset >= clipEndOffset - clipStartOffset) {
      vid.currentTime = Math.max(0, clipEndOffset);
      vid.pause();
      return;
    }
    if (Math.abs(vid.currentTime - offset) > 0.2) vid.currentTime = Math.max(0, offset);
    if (isPlaying) vid.play().catch(() => {}); else vid.pause();
  }, [playhead, isPlaying, activeOverlay, overlayIsImage]);

  const pct = Math.min(100, (playhead / Math.max(duration, 1)) * 100);

  return (
    <div className="flex flex-col items-center gap-3" style={{ width: 172 }}>
      <div className="relative w-full rounded-xl overflow-hidden bg-black border border-border" style={{ aspectRatio: '9/16' }}>

        {/* Downloading chunks */}
        {loadState === 'downloading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black z-10 px-3">
            <Download className="w-5 h-5 text-primary animate-bounce" />
            <p className="text-[10px] text-muted-foreground text-center leading-snug">{downloadLabel}</p>
          </div>
        )}

        {/* Loading video */}
        {loadState === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black z-10">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
            <p className="text-[10px] text-muted-foreground">Loading…</p>
          </div>
        )}

        {/* Error state */}
        {loadState === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black z-10 px-3 text-center">
            <AlertCircle className="w-5 h-5 text-destructive" />
            <p className="text-[10px] text-muted-foreground leading-snug">Failed to load video</p>
            <button
              onClick={handleRetry}
              className="flex items-center gap-1 text-[10px] text-primary hover:underline mt-1"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}

        {/* Idle / no URL */}
        {loadState === 'idle' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[10px] text-muted-foreground text-center px-3">No narration video</p>
          </div>
        )}

        {/* Narration video */}
        {effectiveSrc && (
          <video
            key={`${effectiveSrc}-${srcKey}`}
            ref={vidRef}
            src={effectiveSrc}
            playsInline
            muted={muted}
            preload="auto"
            onLoadedData={() => setLoadState('ready')}
            onError={() => setLoadState('error')}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-75 will-change-transform"
            style={{ transform: camTransform, opacity: loadState === 'ready' ? 1 : 0 }}
          />
        )}

        {/* Background music bed (hidden) — mixed under the narration in preview */}
        {musicUrl && (
          <audio
            ref={musicRef}
            src={musicUrl}
            preload="auto"
            loop
            crossOrigin="anonymous"
            className="hidden"
            onLoadedMetadata={applyMusicGain}
            onCanPlay={applyMusicGain}
            onError={() => console.warn('[music] failed to load', musicUrl)}
          />
        )}

        {/* Overlay — IMAGE clip (including YouTube thumbnails) */}
        {overlayDisplayUrl && overlayIsImage && (
          <img
            key={overlayDisplayUrl}
            src={overlayDisplayUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300 pointer-events-none"
            style={{ opacity: overlayVisible ? 1 : 0 }}
          />
        )}

        {/* Overlay — VIDEO clip */}
        {overlayDisplayUrl && !overlayIsImage && (
          <video
            key={overlayDisplayUrl}
            ref={overlayVidRef}
            src={overlayDisplayUrl}
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
            style={{ opacity: overlayVisible ? 1 : 0 }}
          />
        )}

        {/* Debug HUD */}
        {showDebug && loadState === 'ready' && (() => {
          const currentShot = shots.find(s => playhead >= (s.startTime ?? 0) && playhead < (s.endTime ?? 0) && s.shotType !== 'Talking Head') || activeTH;
          let dbgType = currentShot?.shotType ?? '—';
          let dbgDelay = 0;
          let dbgNarrFirst = false;
          let dbgConfidence: number | undefined;
          let dbgIntent = '';
          let dbgIsTactical = false;
          let dbgIsRequired = false;
          try {
            if (currentShot?.uiLabelsJson) {
              const lbl = JSON.parse(currentShot.uiLabelsJson);
              dbgNarrFirst = lbl.showNarratorFirst === true;
              dbgDelay = lbl.overlayDelaySeconds ?? 0;
              dbgConfidence = typeof lbl.retrievalConfidence === 'number' ? lbl.retrievalConfidence : undefined;
              dbgIntent = lbl.visualIntent ?? currentShot?.visualIntent ?? '';
              dbgIsTactical = lbl.brollMode === 'tactical_broll';
              dbgIsRequired = lbl.isRequiredTacticalBroll === true || lbl.isRequiredTacticalSlot === true;
            }
          } catch { /* */ }
          if (dbgIsTactical) dbgType = 'Tactical B-Roll';
          const elapsed = playhead - (currentShot?.startTime ?? 0);
          const overlayActive = !!activeOverlay;
          return (
            <div className="absolute top-1 left-1 right-1 z-20 pointer-events-none">
              <div className="bg-black/70 rounded px-1.5 py-1 space-y-0.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                    dbgType === 'Talking Head' ? 'bg-primary/30 text-primary' :
                    dbgType === 'Screencast' ? 'bg-blue-500/30 text-blue-300' :
                    dbgIsTactical ? 'bg-orange-500/30 text-orange-300' :
                    'bg-accent/30 text-accent-foreground'
                  }`}>{dbgType}</span>
                  {dbgIntent && <span className="text-[8px] text-white/60">{dbgIntent}</span>}
                </div>
                <div className="flex items-center gap-2 text-[7px] text-white/50 font-mono flex-wrap">
                  {dbgIsRequired && <span className="text-orange-300 font-bold">⚡REQ</span>}
                  {currentPhase ? (
                    <span className={
                      currentPhase === 'narrator-first' ? 'text-blue-300' : 'text-emerald-300'
                    }>
                      {currentPhase === 'narrator-first' ? `👤 narr ${dbgDelay.toFixed(1)}s` : '🎬 overlay'}
                    </span>
                  ) : (
                    <span>{overlayActive ? '🎬 overlay' : '👤 narrator'}</span>
                  )}
                  {dbgConfidence !== undefined && (
                    <span className={dbgConfidence >= 0.7 ? 'text-emerald-300' : dbgConfidence >= 0.5 ? 'text-amber-300' : 'text-red-300'}>
                      {(dbgConfidence * 100).toFixed(0)}%
                    </span>
                  )}
                  <span>{elapsed.toFixed(1)}s</span>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Subtitles ALWAYS center-screen, karaoke-highlighted to mirror the
            ASS render: the CURRENTLY-SPOKEN word pops in the accent color. */}
        {activeSub && (() => {
          const tpl = SUBTITLE_PREVIEW_STYLES[subtitleTemplate] ?? SUBTITLE_PREVIEW_STYLES['yellow-mont'];
          const scale = 172 / RENDER_WIDTH;
          const words = activeSub.words;
          const phraseText = words.map(w => w.text).join(' ');
          const maxW = 172 * 0.86;
          const estW = phraseText.length * tpl.fontPx * 0.6 * scale;
          const fitPx = estW > maxW ? tpl.fontPx * (maxW / estW) : tpl.fontPx;
          const baseFont = Math.max(9, Math.round(fitPx * scale));
          // Active word = the one whose [start,nextStart) window contains the playhead.
          let activeIdx = words.findIndex((w, i) => {
            const ws = w.start;
            const we = i + 1 < words.length ? words[i + 1].start : (activeSub.end ?? w.end);
            return playhead >= ws && playhead < we;
          });
          if (activeIdx < 0) activeIdx = 0;
          const wordEls = words.map((w, i) => {
            // Highlight (color/weight change) the active word only for styles
            // 1 & 2. No size animation for any style.
            const isActive = !!tpl.highlightWord && i === activeIdx;
            return (
              <span
                key={i}
                style={{
                  color: isActive ? tpl.emph : tpl.line,
                  fontFamily: isActive ? tpl.emphFont : tpl.font,
                  fontWeight: isActive ? tpl.emphWeight : tpl.weight,
                  fontStyle: tpl.italic ? 'italic' : 'normal',
                  fontSize: `${baseFont}px`,
                  letterSpacing: '-0.02em',
                  // inline-block collapses the trailing whitespace, so add an
                  // explicit gap to keep a normal space between words.
                  marginRight: i < words.length - 1 ? `${Math.max(2, baseFont * 0.28)}px` : 0,
                  display: 'inline-block',
                }}
              >
                {w.text}
              </span>
            );
          });
          // Mirror the render: while a promo overlay is on screen, captions
          // move to the bottom band so they don't cover the footage.
          const promoShowing = !!activeOverlay && currentPhase === 'overlay-visible';
          return (
            <div
              className="absolute left-1 right-1 text-center pointer-events-none"
              style={promoShowing
                ? { top: '80%', transform: 'translateY(-50%)' }
                : { top: '50%', transform: 'translateY(-50%)' }}
            >
              <p
                style={{
                  textTransform: tpl.allCaps ? 'uppercase' : 'none',
                  lineHeight: 1.1,
                  margin: 0,
                  padding: tpl.box ? `${baseFont * 0.16}px ${baseFont * 0.16}px` : 0,
                  display: 'inline-block',
                  background: tpl.box ? tpl.boxColor : 'transparent',
                  borderRadius: tpl.box ? baseFont * 0.4 : 0,
                  textShadow: tpl.box ? 'none' : (tpl.shadow ? '-1px 2px 4px rgba(0,0,0,0.75)' : 'none'),
                }}
              >
                {wordEls}
              </p>
            </div>
          );
        })()}

        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40 cursor-pointer"
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek((e.clientX - r.left) / r.width * duration); }}>
          <div className="h-full bg-primary transition-[width] duration-75" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button onClick={() => onSeek(0)} className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Go to start">
          <SkipBack className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onPlayPause}
          disabled={loadState !== 'ready'}
          className="p-1.5 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <span className="text-[10px] font-mono text-muted-foreground min-w-[52px]">{fmt(playhead)}</span>
        <button onClick={() => setMuted(m => !m)} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
          {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
        </button>
        <button onClick={() => setShowDebug(d => !d)} className={`p-1 transition-colors ${showDebug ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`} title="Toggle debug HUD">
          <Bug className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
