import { Volume2, VolumeX } from 'lucide-react';

const SECTION_LABELS: Record<string, string> = {
  intro_end: 'Intro End',
  build_start: 'Build',
  drop: 'Drop',
  climax_start: 'Climax',
  outro_start: 'Outro',
};

interface Props {
  label: string;
  peaks: number[] | null;
  totalWidth: number;
  labelWidth: number;
  duration: number;
  zoom: number;
  musicVolume: number;
  onVolumeChange: (v: number) => void;
  musicMuted: boolean;
  onMutedChange: (m: boolean) => void;
  beatGrid: number[];
  downbeats: number[];
  sectionMarkers: Record<string, number>;
  showBeatGrid: boolean;
}

const TRACK_H = 52;

export default function WaveformTrack({
  label, peaks, totalWidth, labelWidth, duration, zoom,
  musicVolume, onVolumeChange, musicMuted, onMutedChange,
  beatGrid, downbeats, sectionMarkers, showBeatGrid,
}: Props) {
  const volPct = Math.round(musicVolume * 100);
  const downbeatSet = new Set(downbeats.map(t => t.toFixed(3)));

  return (
    <div className="flex border-b border-border/40" style={{ height: TRACK_H }}>
      <div className="shrink-0 flex flex-col items-end justify-center pr-2 border-r border-border/30 gap-0.5" style={{ width: labelWidth }}>
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Music</span>
        {/* Mute toggle */}
        <button
          onClick={() => onMutedChange(!musicMuted)}
          className="p-0.5 rounded hover:bg-muted transition-colors"
          title={musicMuted ? 'Unmute music' : 'Mute music'}
        >
          {musicMuted
            ? <VolumeX className="w-3 h-3 text-destructive/70" />
            : <Volume2 className="w-3 h-3 text-muted-foreground" />}
        </button>
      </div>
      <div className="relative overflow-hidden" style={{ width: totalWidth, height: TRACK_H, opacity: musicMuted ? 0.35 : 1 }}>
        {/* Track name */}
        <span className="absolute top-1 left-2 text-[9px] text-muted-foreground/70 z-10 select-none leading-none pointer-events-none">
          {label}
        </span>

        {/* Waveform bars */}
        {peaks && peaks.length > 0 ? (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            preserveAspectRatio="none"
            viewBox={`0 0 ${peaks.length} 100`}
            style={{ opacity: 0.5 }}
          >
            {peaks.map((p, i) => {
              const barH = Math.max(3, p * 76);
              return (
                <rect
                  key={i}
                  x={i} y={(100 - barH) / 2}
                  width={0.85} height={barH}
                  className="fill-primary/45"
                />
              );
            })}
          </svg>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-[9px] text-muted-foreground/40">Generating waveform…</span>
          </div>
        )}

        {/* Beat grid tick marks inside waveform track */}
        {showBeatGrid && beatGrid.length > 0 && (
          <>
            {beatGrid.filter(t => t <= duration).map((t, i) => {
              const isDownbeat = downbeatSet.has(t.toFixed(3));
              return (
                <div
                  key={i}
                  className="absolute bottom-0 pointer-events-none"
                  style={{
                    left: t * zoom,
                    width: isDownbeat ? 1.5 : 0.5,
                    height: isDownbeat ? 10 : 5,
                    backgroundColor: isDownbeat
                      ? 'hsl(var(--primary) / 0.55)'
                      : 'hsl(var(--primary) / 0.18)',
                  }}
                />
              );
            })}
          </>
        )}

        {/* Section markers inside waveform track */}
        {showBeatGrid && Object.entries(sectionMarkers).map(([key, t]) => (
          t <= duration ? (
            <div key={key} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: t * zoom }}>
              <div className="w-px h-full" style={{ backgroundColor: 'hsl(var(--accent) / 0.5)' }} />
              <span className="absolute bottom-0.5 left-1 text-[6px] font-bold uppercase tracking-wide whitespace-nowrap"
                style={{ color: 'hsl(var(--accent-foreground) / 0.6)' }}>
                {SECTION_LABELS[key] ?? key}
              </span>
            </div>
          ) : null
        ))}

        {/* Volume control — right side overlay */}
        <div
          className="absolute top-0 right-0 h-full flex items-center gap-1.5 px-2 z-20"
          style={{ background: 'linear-gradient(to left, var(--card) 60%, transparent)' }}
          onClick={e => e.stopPropagation()}
        >
          <Volume2 className="w-2.5 h-2.5 text-muted-foreground/60 shrink-0" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={volPct}
            onChange={e => onVolumeChange(Number(e.target.value) / 100)}
            className="w-16 h-0.5 cursor-pointer appearance-none bg-muted rounded-full accent-primary"
            title={`Music volume: ${volPct}%`}
          />
          <span className="text-[9px] font-mono text-muted-foreground w-5 text-right tabular-nums select-none">
            {volPct}%
          </span>
        </div>
      </div>
    </div>
  );
}
