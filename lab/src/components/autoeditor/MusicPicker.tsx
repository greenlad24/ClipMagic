import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Music, Pause, Play, Star, Trash2, Upload, VolumeX, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Background music for long-form edits (Jake 2026-10-09: "I also want to be able to change the background
 * music"). The library is the worker's music folder (server aieditor/music.ts → /api/aieditor/music):
 * every track with its length, loudness and a play button; upload (mp3 / wav / m4a), "Set as default",
 * delete (asked in place, refused while a running job uses the track).
 *
 *   MusicPicker   the choice: Auto (the library default) / a track / No music + the level (±6 LU around
 *                 the default bed, which sits ~23 LU under the voice). New edit → More options.
 *   JobMusic      "Change music" on a finished job: saves the choice and queues "remusic" — only the
 *                 sound of the finished videos (and the hand-off's music stem) is rebuilt.
 */

export interface MusicChoice { track: string | null; gain_lu: number }
export interface MusicTrack {
  id: string; title: string; duration: number | null; lufs: number | null; bytes: number; origin: string;
  isDefault: boolean; usedBy: { id: string; title: string }[];
}
interface Library { tracks: MusicTrack[]; default: string | null; gainRange: [number, number]; underVoiceLu: number }

const API = '/api/aieditor/music';

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

const mmss = (s: number | null) => (s === null ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

export function musicLabel(c: MusicChoice | null | undefined, lib?: Library | null): string {
  const g = c?.gain_lu ? ` · ${c.gain_lu > 0 ? '+' : ''}${c.gain_lu} LU` : '';
  if (!c || c.track === null) {
    const d = lib?.tracks.find((t) => t.isDefault);
    return `Auto${d ? ` (${d.title})` : ''}${g}`;
  }
  if (c.track === 'none') return 'No music';
  return `${lib?.tracks.find((t) => t.id === c.track)?.title ?? c.track}${g}`;
}

export function useMusicLibrary() {
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setLib(await call<Library>(API));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { lib, error, reload };
}

export function MusicPicker({ value, onChange, lib, reload }: {
  value: MusicChoice;
  onChange: (v: MusicChoice) => void;
  lib: Library | null;
  reload: () => Promise<void>;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => audio.current?.pause(), []);
  const play = (id: string) => {
    if (playing === id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const a = new Audio(`${API}/${encodeURIComponent(id)}/audio`);
    a.onended = () => setPlaying(null);
    audio.current = a;
    void a.play().catch(() => setPlaying(null));
    setPlaying(id);
  };
  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      toast.success(ok);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };
  const upload = async (f: File) => {
    setUploading(true);
    try {
      const t = await call<{ id: string; title: string }>(`${API}/upload?name=${encodeURIComponent(f.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f,
      });
      toast.success(`Added “${t.title}”`);
      await reload();
      onChange({ ...value, track: t.id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const [lo, hi] = lib?.gainRange ?? [-6, 6];
  const option = (key: string, selected: boolean, onSelect: () => void, body: ReactNode, extra?: ReactNode) => (
    <div
      key={key}
      className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs',
        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/30')}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50')}>
          {selected && <Check className="h-2.5 w-2.5" />}
        </span>
        {body}
      </button>
      {extra}
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {option('auto', value.track === null, () => onChange({ ...value, track: null }),
          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
            <Wand2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">Auto — the default track{lib?.default ? ` (${lib.tracks.find((t) => t.isDefault)?.title})` : ''}</span>
          </span>)}
        {(lib?.tracks ?? []).map((t) => option(t.id, value.track === t.id, () => onChange({ ...value, track: t.id }),
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-foreground">{t.title}</span>
            {t.isDefault && <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-400">default</span>}
            <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
              {mmss(t.duration)}{t.lufs !== null ? ` · ${t.lufs.toFixed(1)} LUFS` : ''}
            </span>
          </span>,
          confirm === t.id ? (
            <span className="flex shrink-0 items-center gap-1">
              <span className="text-[10.5px] text-red-300">Delete?</span>
              <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" disabled={busy === t.id}
                onClick={() => void act(t.id, () => call(`${API}/${encodeURIComponent(t.id)}`, { method: 'DELETE' }), `Deleted “${t.title}”`)
                  .then(() => { if (value.track === t.id) onChange({ ...value, track: null }); })}>
                {busy === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Delete'}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setConfirm(null)}>Keep</Button>
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-0.5">
              <Button size="icon" variant="ghost" className="h-6 w-6" title={playing === t.id ? 'Stop' : 'Play'} onClick={() => play(t.id)}>
                {playing === t.id ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              {!t.isDefault && (
                <Button size="icon" variant="ghost" className="h-6 w-6" title="Set as default" disabled={busy === t.id}
                  onClick={() => void act(t.id, () => call(`${API}/${encodeURIComponent(t.id)}/default`, { method: 'POST' }), `“${t.title}” is the default now`)}>
                  <Star className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-red-400"
                title={t.usedBy.length ? `In use by ${t.usedBy.map((u) => u.title).join(', ')}` : 'Delete'}
                disabled={t.usedBy.length > 0} onClick={() => setConfirm(t.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          )))}
        {option('none', value.track === 'none', () => onChange({ ...value, track: 'none' }),
          <span className="flex items-center gap-1.5 text-foreground"><VolumeX className="h-3.5 w-3.5 text-muted-foreground" /> No music</span>)}
      </div>
      <div className="flex items-center gap-2">
        <input ref={fileInput} type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {uploading ? 'Uploading…' : 'Upload a track (mp3, wav, m4a)'}
        </Button>
      </div>
      {value.track !== 'none' && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Music level</span>
            <span className="text-foreground">
              {value.gain_lu === 0 ? `Default (~${lib?.underVoiceLu ?? 23} LU under the voice)` : `${value.gain_lu > 0 ? '+' : ''}${value.gain_lu} LU`}
            </span>
          </div>
          <input type="range" min={lo} max={hi} step={0.5} value={value.gain_lu} aria-label="Music level"
            onChange={(e) => onChange({ ...value, gain_lu: Number(e.target.value) })} className="w-full accent-primary" />
          <div className="flex justify-between text-[10px] text-muted-foreground"><span>quieter</span><span>louder</span></div>
        </div>
      )}
    </div>
  );
}

interface JobMusicInfo {
  choice: MusicChoice; hasField: boolean; outputs: string[]; canChange: boolean; why: string | null; running: boolean;
  applied: { track: string | null; title: string | null; gain_lu: number; none: boolean; outputs: string[]; skipped: string[]; at: number } | null;
}

/** "Change music" on a job: what it has now, the picker, and Apply (queues "remusic"). */
export function JobMusic({ jobId, live, progress, onChanged }: {
  jobId: string; live: boolean; progress: { message?: string | null; frac?: number | null } | null; onChanged: () => void;
}) {
  const { lib, reload } = useMusicLibrary();
  const [info, setInfo] = useState<JobMusicInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<MusicChoice>({ track: null, gain_lu: 0 });
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const i = await call<JobMusicInfo>(`${API}/job/${jobId}`);
      setInfo(i);
      setValue((v) => (open ? v : i.choice));
    } catch {
      setInfo(null);
    }
  }, [jobId, open]);
  useEffect(() => {
    void load();
  }, [load, live]);
  if (!info) return null;
  const current = info.applied
    ? info.applied.none ? 'No music' : `${info.applied.title ?? info.applied.track}${info.applied.gain_lu ? ` · ${info.applied.gain_lu > 0 ? '+' : ''}${info.applied.gain_lu} LU` : ''}`
    : musicLabel(info.choice, lib);
  const apply = async () => {
    setBusy(true);
    try {
      await call(`${API}/job/${jobId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, apply: true }),
      });
      toast.success('Changing the music — only the sound is rebuilt, the picture stays. A few minutes.');
      setOpen(false);
      onChanged();
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
        <Music className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-foreground">Music</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{current}</span>
        {info.running ? (
          <span className="flex items-center gap-1.5 text-blue-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress?.message || 'Changing the music…'}
            {typeof progress?.frac === 'number' && progress.frac > 0 ? ` ${Math.round(progress.frac * 100)}%` : ''}
          </span>
        ) : (
          <Button size="sm" variant={open ? 'ghost' : 'secondary'} className="h-7 text-xs" disabled={!info.canChange && !open}
            title={info.why ?? undefined} onClick={() => { setValue(info.choice); setOpen(!open); }}>
            {open ? 'Close' : 'Change music'}
          </Button>
        )}
      </div>
      {!open && !info.running && info.why && info.outputs.length === 0 && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">{info.why}</p>
      )}
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-3">
          <MusicPicker value={value} onChange={setValue} lib={lib} reload={reload} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="gap-1.5" disabled={busy || !info.canChange} onClick={() => void apply()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Music className="h-3.5 w-3.5" />} Apply to this edit
            </Button>
            <p className="min-w-0 flex-1 text-[10.5px] leading-snug text-muted-foreground">
              {info.why ?? `Rebuilds only the sound of ${info.outputs.join(', ')} — the picture is kept as it is; nothing is re-recorded, re-planned or re-cut.`}
            </p>
          </div>
        </div>
      )}
      {!open && info.applied && info.applied.skipped.length > 0 && (
        <p className="px-3 pb-2 text-[11px] text-amber-400">Not changed: {info.applied.skipped.join('; ')}</p>
      )}
    </div>
  );
}
