import { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { TimelineShot, SubtitleEvent } from './types';
import ShotBlock, { DragMode } from './ShotBlock';
import TrackRow from './TrackRow';
import WaveformTrack from './WaveformTrack';

type DragState = {
  shotId: string; type: DragMode; startX: number;
  originalStart: number; originalEnd: number;
  currentStart: number; currentEnd: number;
};

const INTENSITY_COLORS: Record<string, string> = {
  peak: 'bg-primary', massive: 'bg-primary/80', major: 'bg-primary/55',
  minor: 'bg-primary/28', baseline: 'bg-muted',
};

const LABEL_W = 80;
const TRACK_H = 40;

function TimeRuler({ duration, zoom }: { duration: number; zoom: number }) {
  const step = zoom >= 80 ? 5 : zoom >= 40 ? 10 : 20;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + step; t += step) ticks.push(t);
  return (
    <div className="relative h-6 select-none">
      {ticks.map(t => (
        <div key={t} className="absolute top-0 flex flex-col items-center" style={{ left: t * zoom }}>
          <span className="text-[9px] font-mono text-muted-foreground leading-none">
            {Math.floor(t / 60)}:{String(t % 60).padStart(2, '0')}
          </span>
          <div className="w-px h-2 bg-border/60 mt-0.5" />
        </div>
      ))}
    </div>
  );
}

/** Section marker label names */
const SECTION_LABELS: Record<string, string> = {
  intro_end: 'Intro End',
  build_start: 'Build',
  drop: 'Drop',
  climax_start: 'Climax',
  outro_start: 'Outro',
};

interface Props {
  shots: TimelineShot[];
  duration: number;
  playhead: number;
  zoom: number;
  waveformPeaks: number[] | null;
  animationMap: Array<{ second: number; intensity: string }>;
  subtitles: SubtitleEvent[];
  musicInfo: { bpm?: number; trackName?: string } | null;
  musicVolume: number;
  onMusicVolumeChange: (v: number) => void;
  musicMuted: boolean;
  onMusicMutedChange: (m: boolean) => void;
  beatGrid: number[];
  downbeats: number[];
  sectionMarkers: Record<string, number>;
  showBeatGrid: boolean;
  onShowBeatGridChange: (v: boolean) => void;
  selectedShotId: string | null;
  onShotSelect: (id: string | null) => void;
  onShotUpdate: (shotId: string, startTime: number, endTime: number) => void;
  onPlayheadChange: (t: number) => void;
  onZoomChange: (z: number) => void;
  isSelectMode?: boolean;
  selectedIds?: Set<string>;
  onShotToggle?: (id: string) => void;
}

export default function TimelinePanel({
  shots, duration, playhead, zoom, waveformPeaks, animationMap, subtitles,
  musicInfo, musicVolume, onMusicVolumeChange,
  musicMuted, onMusicMutedChange,
  beatGrid, downbeats, sectionMarkers, showBeatGrid, onShowBeatGridChange,
  selectedShotId, onShotSelect, onShotUpdate, onPlayheadChange, onZoomChange,
  isSelectMode, selectedIds, onShotToggle,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const zoomRef = useRef(zoom);
  const durationRef = useRef(duration);
  const onShotUpdateRef = useRef(onShotUpdate);
  const [localShots, setLocalShots] = useState(shots);
  const totalW = Math.max(duration * zoom, 600);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { onShotUpdateRef.current = onShotUpdate; }, [onShotUpdate]);
  useEffect(() => { if (!dragRef.current) setLocalShots(shots); }, [shots]);

  // Global drag handlers
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dt = (e.clientX - d.startX) / zoomRef.current;
      const snap = (v: number) => Math.round(v * 10) / 10;
      let s = d.originalStart, en = d.originalEnd;
      if (d.type === 'move') {
        s = snap(Math.max(0, d.originalStart + dt));
        en = snap(s + (d.originalEnd - d.originalStart));
      } else if (d.type === 'resize-left') {
        s = snap(Math.max(0, Math.min(d.originalEnd - 0.5, d.originalStart + dt)));
      } else {
        en = snap(Math.max(d.originalStart + 0.5, Math.min(durationRef.current, d.originalEnd + dt)));
      }
      dragRef.current = { ...d, currentStart: s, currentEnd: en };
      setLocalShots(prev => prev.map(sh => sh.id === d.shotId ? { ...sh, startTime: s, endTime: en } : sh));
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      onShotUpdateRef.current(d.shotId, d.currentStart, d.currentEnd);
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Auto-scroll to keep playhead visible
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const px = LABEL_W + playhead * zoom;
    if (px < el.scrollLeft + 40 || px > el.scrollLeft + el.clientWidth - 40) {
      el.scrollTo({ left: Math.max(0, px - el.clientWidth / 2), behavior: 'smooth' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(playhead), zoom]);

  const handleDragStart = (e: React.MouseEvent, shotId: string, type: DragMode) => {
    const shot = localShots.find(s => s.id === shotId);
    if (!shot) return;
    const start = shot.startTime ?? 0, end = shot.endTime ?? 1;
    dragRef.current = { shotId, type, startX: e.clientX, originalStart: start, originalEnd: end, currentStart: start, currentEnd: end };
  };

  const tracks = [
    { label: 'Narration', type: 'Talking Head' },
    { label: 'B-Roll',    type: 'B-Roll' },
    { label: 'Screencast', type: 'Screencast' },
  ];

  // Downbeat set for fast lookup
  const downbeatSet = new Set(downbeats.map(t => t.toFixed(3)));

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Zoom bar */}
      <div className="flex items-center justify-between gap-1 px-3 py-1.5 border-b border-border shrink-0 bg-background/80">
        {/* Left: music info */}
        <div className="flex items-center gap-2 min-w-0">
          {musicInfo?.bpm && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              ♩ {musicInfo.bpm} BPM
            </span>
          )}
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showBeatGrid}
              onChange={e => onShowBeatGridChange(e.target.checked)}
              className="w-3 h-3 rounded border-border accent-primary"
            />
            <span className="text-[10px] text-muted-foreground">Beat grid</span>
          </label>
        </div>
        {/* Right: zoom */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground mr-1">{zoom}px/s</span>
          <button onClick={() => onZoomChange(Math.max(20, zoom - 15))} className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors" title="Zoom out"><ZoomOut className="w-3.5 h-3.5" /></button>
          <button onClick={() => onZoomChange(Math.min(220, zoom + 15))} className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors" title="Zoom in"><ZoomIn className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Scrollable timeline */}
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-auto" style={{ userSelect: 'none' }}>
        <div style={{ width: totalW + LABEL_W + 32, minHeight: '100%' }}>
          {/* Sticky time ruler */}
          <div className="flex sticky top-0 z-20 bg-background border-b border-border shadow-sm">
            <div style={{ width: LABEL_W }} className="shrink-0 border-r border-border/30" />
            <div className="relative flex-1" style={{ width: totalW }}
              onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onPlayheadChange(Math.max(0, (e.clientX - r.left) / zoom)); }}>
              <TimeRuler duration={duration} zoom={zoom} />
            </div>
          </div>

          {/* Track rows */}
          <div className="relative">
            {/* Beat grid lines — vertical across all tracks */}
            {showBeatGrid && beatGrid.length > 0 && (
              <div className="absolute inset-0 pointer-events-none z-[5]" style={{ left: LABEL_W }}>
                {beatGrid.filter(t => t <= duration).map((t, i) => {
                  const isDownbeat = downbeatSet.has(t.toFixed(3));
                  return (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0"
                      style={{
                        left: t * zoom,
                        width: isDownbeat ? 1 : 0.5,
                        backgroundColor: isDownbeat
                          ? 'hsl(var(--primary) / 0.25)'
                          : 'hsl(var(--primary) / 0.08)',
                      }}
                    />
                  );
                })}
              </div>
            )}

            {/* Section markers — floating labels across all tracks */}
            {showBeatGrid && Object.entries(sectionMarkers).map(([key, t]) => (
              t <= duration ? (
                <div
                  key={key}
                  className="absolute top-0 bottom-0 z-[6] pointer-events-none"
                  style={{ left: LABEL_W + t * zoom, width: 1, backgroundColor: 'hsl(var(--accent) / 0.3)' }}
                >
                  <span className="absolute top-0 left-1 text-[7px] font-semibold whitespace-nowrap px-1 py-0 rounded-b"
                    style={{ color: 'hsl(var(--accent-foreground) / 0.7)', backgroundColor: 'hsl(var(--accent) / 0.25)' }}>
                    {SECTION_LABELS[key] ?? key}
                  </span>
                </div>
              ) : null
            ))}

            {/* Playhead vertical line */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-primary z-30 pointer-events-none shadow-[0_0_4px_var(--primary)]"
              style={{ left: LABEL_W + playhead * zoom }} />

            {/* Main shot tracks */}
            {tracks.map(({ label, type }) => (
              <TrackRow key={label} label={label} totalWidth={totalW} labelWidth={LABEL_W} height={TRACK_H} onClick={() => onShotSelect(null)}>
                {localShots.filter(s => s.shotType === type).map(s => (
                  <ShotBlock
                    key={s.id} shot={s}
                    left={(s.startTime ?? 0) * zoom}
                    width={((s.endTime ?? 1) - (s.startTime ?? 0)) * zoom}
                    height={TRACK_H - 10}
                    isSelected={selectedShotId === s.id}
                    onClick={() => onShotSelect(s.id)}
                    onDragStart={(e, mode) => handleDragStart(e, s.id, mode)}
                    isSelectMode={isSelectMode}
                    isChecked={selectedIds?.has(s.id)}
                    onToggle={() => onShotToggle?.(s.id)}
                  />
                ))}
              </TrackRow>
            ))}

            {/* Subtitles track */}
            <div className="flex border-b border-border/40" style={{ height: 26 }}>
              <div className="shrink-0 flex items-center justify-end pr-2 border-r border-border/30" style={{ width: LABEL_W }}>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Subs</span>
              </div>
              <div className="relative flex-1 bg-muted/5" style={{ width: totalW }}>
                {subtitles.slice(0, 60).map((ev, i) => (
                  <div key={i} className="absolute top-1 bottom-1 bg-muted/50 border-l border-primary/20 overflow-hidden flex items-center px-0.5 rounded-sm"
                    style={{ left: ev.start * zoom, width: Math.max(6, (ev.end - ev.start) * zoom - 1) }}>
                    <span className="text-[7px] text-muted-foreground truncate leading-none">{ev.words.map(w => w.text).join(' ')}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Music waveform */}
            <WaveformTrack
              label={musicInfo ? `${musicInfo.trackName ?? 'Track'} · ${musicInfo.bpm ?? '?'} BPM` : 'No music track'}
              peaks={waveformPeaks}
              totalWidth={totalW}
              labelWidth={LABEL_W}
              duration={duration}
              zoom={zoom}
              musicVolume={musicVolume}
              onVolumeChange={onMusicVolumeChange}
              musicMuted={musicMuted}
              onMutedChange={onMusicMutedChange}
              beatGrid={beatGrid}
              downbeats={downbeats}
              sectionMarkers={sectionMarkers}
              showBeatGrid={showBeatGrid}
            />

            {/* Intensity heatmap */}
            <div className="flex" style={{ height: 22 }}>
              <div className="shrink-0 flex items-center justify-end pr-2 border-r border-border/30" style={{ width: LABEL_W }}>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Energy</span>
              </div>
              <div className="flex gap-px items-center px-0.5" style={{ width: totalW }}>
                {animationMap.slice(0, Math.ceil(duration) + 1).map((e, i) => (
                  <div key={i} className={`rounded-sm flex-none ${INTENSITY_COLORS[e.intensity] ?? 'bg-muted'}`}
                    style={{ width: Math.max(2, zoom - 1), height: 14 }}
                    title={`${e.second}s: ${e.intensity}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
