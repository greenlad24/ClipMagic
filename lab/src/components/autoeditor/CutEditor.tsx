import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Play, Save, Crosshair, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { autoEditorSaveNudges, type AutoJoin } from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';

/**
 * Cut editor — Jake's Descript-style fix for a cut the algorithm got wrong ("a way to
 * divert the cut a few milliseconds forward or backwards ... instead of rerender").
 *
 * Every cut has two edges in the ORIGINAL recording: where the left piece ends (b) and
 * where the right piece starts (a). Jake nudges either one and hears the join at once:
 * the browser fetches a few seconds of the original 48 kHz audio around each edge
 * (/api/aieditor/audio) and plays left-up-to-b then right-from-a with the renderer's
 * own 12 ms fades and room-tone spans muted — what the render will play. Saving writes
 * the nudges; the worker rebuilds the cut and the sound check, never the video.
 */

const FADE = 0.012;
const LEAD = 1.5; // seconds heard either side of the cut
const WIN_OUT = 1.8; // seconds fetched on the kept side of an edge
const WIN_IN = 0.6; // seconds fetched on the cut-away side (room to nudge into)
const MAX_NUDGE_MS = 500;

const keyB = (j: AutoJoin) => `b:${j.left_id}`;
const keyA = (j: AutoJoin) => `a:${j.right_id}`;

function mmss(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

let ctxSingleton: AudioContext | null = null;
function audioCtx() {
  if (!ctxSingleton) ctxSingleton = new AudioContext({ sampleRate: 48000 });
  return ctxSingleton;
}

interface Slice {
  from: number;
  buf: AudioBuffer;
}

async function fetchSlice(jobId: string, from: number, to: number): Promise<Slice> {
  const f = Math.max(0, from);
  const r = await fetch(`/api/aieditor/audio/${jobId}?from=${f.toFixed(3)}&to=${to.toFixed(3)}`, { credentials: 'include' });
  if (!r.ok) throw new Error(`Audio ${r.status}`);
  const buf = await audioCtx().decodeAudioData(await r.arrayBuffer());
  return { from: f, buf };
}

function Wave({
  slice,
  edge,
  auto,
  keepLeft,
  onPick,
}: {
  slice: Slice | null;
  edge: number;
  auto: number;
  keepLeft: boolean;
  onPick: (t: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    if (!slice) return;
    const { buf, from } = slice;
    const dur = buf.duration;
    const x = (t: number) => ((t - from) / dur) * w;
    const ch = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
    const per = Math.max(1, Math.floor(buf.length / w));
    const ex = x(edge);
    for (let px = 0; px < w; px++) {
      let m = 0;
      const i0 = px * per;
      for (let i = i0; i < Math.min(buf.length, i0 + per); i += 4) {
        const v = Math.abs((ch[0][i] + ch[1][i]) / 2);
        if (v > m) m = v;
      }
      const amp = Math.min(1, Math.sqrt(m) * 1.3) * (h / 2 - 2);
      const kept = keepLeft ? px <= ex : px >= ex;
      g.fillStyle = kept ? 'rgba(96,165,250,0.95)' : 'rgba(148,163,184,0.35)';
      g.fillRect(px, h / 2 - amp, 1, Math.max(1, amp * 2));
    }
    // the algorithm's own edge (dashed) and the current one (solid)
    g.strokeStyle = 'rgba(250,204,21,0.8)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(x(auto) + 0.5, 0);
    g.lineTo(x(auto) + 0.5, h);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#f43f5e';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(ex, 0);
    g.lineTo(ex, h);
    g.stroke();
  }, [slice, edge, auto, keepLeft]);
  return (
    <canvas
      ref={ref}
      className="h-20 w-full cursor-crosshair rounded bg-muted/40"
      onClick={(e) => {
        if (!slice) return;
        const r = e.currentTarget.getBoundingClientRect();
        onPick(slice.from + ((e.clientX - r.left) / r.width) * slice.buf.duration);
      }}
    />
  );
}

function Nudger({ label, ms, onStep, onReset }: { label: string; ms: number; onStep: (d: number) => void; onReset: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      <span className="w-28 text-muted-foreground">{label}</span>
      {[-20, -5].map((d) => (
        <button key={d} type="button" onClick={() => onStep(d)} className="rounded border border-border px-1.5 py-0.5 hover:bg-muted/50">
          {d} ms
        </button>
      ))}
      <span className={cn('w-16 text-center font-mono', ms ? 'text-rose-400' : 'text-muted-foreground')}>
        {ms > 0 ? `+${ms}` : ms} ms
      </span>
      {[5, 20].map((d) => (
        <button key={d} type="button" onClick={() => onStep(d)} className="rounded border border-border px-1.5 py-0.5 hover:bg-muted/50">
          +{d} ms
        </button>
      ))}
      {ms !== 0 && (
        <button type="button" onClick={onReset} className="ml-1 text-muted-foreground hover:text-foreground" title="Back to the automatic cut">
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function CutEditor({
  jobId,
  joins,
  saved,
  playerTime,
  onSeek,
  disabled,
  pending,
  onSaved,
}: {
  jobId: string;
  joins: AutoJoin[];
  saved: Record<string, number>;
  playerTime: number;
  onSeek: (t: number) => void;
  disabled: boolean;
  /** saved corrections the sound check does not contain yet */
  pending?: boolean;
  onSaved: () => void;
}) {
  const [nudges, setNudges] = useState<Record<string, number>>(saved);
  const [sel, setSel] = useState<number | null>(null);
  const [slices, setSlices] = useState<{ k: number; left: Slice; right: Slice } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [onlyEdited, setOnlyEdited] = useState(false);
  const playing = useRef<AudioBufferSourceNode[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // The page re-polls the job every few seconds and hands a NEW `saved` object each time.
  // Resetting on every poll snapped Jake's nudges back (2026-10-05): take the server's
  // version only when its CONTENT changed, and never over edits not saved yet.
  const savedKey = JSON.stringify(saved);
  const lastSaved = useRef(savedKey);
  const localRef = useRef(nudges);
  localRef.current = nudges;
  useEffect(() => {
    if (savedKey === lastSaved.current) return;
    const unsaved = JSON.stringify(localRef.current) !== lastSaved.current;
    lastSaved.current = savedKey;
    if (!unsaved) setNudges(JSON.parse(savedKey));
  }, [savedKey]);

  const dirty = JSON.stringify(nudges) !== lastSaved.current;
  const join = sel === null ? null : joins.find((j) => j.k === sel) ?? null;
  const msB = join ? nudges[keyB(join)] ?? 0 : 0;
  const msA = join ? nudges[keyA(join)] ?? 0 : 0;
  const edgeB = join ? join.auto_b + msB / 1000 : 0;
  const edgeA = join ? join.auto_a + msA / 1000 : 0;

  useEffect(() => {
    if (!join) return;
    let live = true;
    setLoading(true);
    Promise.all([
      fetchSlice(jobId, join.auto_b - WIN_OUT, join.auto_b + WIN_IN),
      fetchSlice(jobId, join.auto_a - WIN_IN, join.auto_a + WIN_OUT),
    ])
      .then(([left, right]) => live && setSlices({ k: join.k, left, right }))
      .catch((e) => toast.error(String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // the windows depend only on the automatic edges
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, join?.k, join?.auto_a, join?.auto_b]);

  const setMs = (key: string, ms: number) =>
    setNudges((n) => {
      const v = Math.max(-MAX_NUDGE_MS, Math.min(MAX_NUDGE_MS, Math.round(ms)));
      const out = { ...n };
      if (v === 0) delete out[key];
      else out[key] = v;
      return out;
    });

  const stop = () => {
    for (const s of playing.current) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    playing.current = [];
  };

  const play = useCallback(() => {
    if (!join || !slices || slices.k !== join.k) return;
    stop();
    const ctx = audioCtx();
    void ctx.resume();
    const t0 = ctx.currentTime + 0.05;
    const { left, right } = slices;
    const lStart = Math.max(left.from, edgeB - LEAD);
    const lDur = Math.max(0.02, edgeB - lStart);
    const rDur = Math.min(LEAD, right.from + right.buf.duration - edgeA);
    const part = (sl: Slice, start: number, dur: number, at: number, fadeIn: boolean, tone: [number, number][]) => {
      const src = ctx.createBufferSource();
      src.buffer = sl.buf;
      const fade = ctx.createGain();
      const mute = ctx.createGain();
      src.connect(mute).connect(fade).connect(ctx.destination);
      if (fadeIn) {
        fade.gain.setValueAtTime(0, at);
        fade.gain.linearRampToValueAtTime(1, at + FADE);
      } else {
        fade.gain.setValueAtTime(1, at + dur - FADE);
        fade.gain.linearRampToValueAtTime(0, at + dur);
      }
      // room-tone spans of the render (muted clicks, cut-away slivers): near silence
      for (const [x, y] of tone) {
        if (y <= start || x >= start + dur) continue;
        mute.gain.setValueAtTime(0.02, at + Math.max(0, x - start));
        mute.gain.setValueAtTime(1, at + Math.min(dur, y - start));
      }
      src.start(at, start - sl.from, dur);
      playing.current.push(src);
    };
    // the render's tone spans move with the edge, so only those inside the kept side count
    part(left, lStart, lDur, t0, false, join.left_tone.filter(([, y]) => y <= edgeB + 1e-3));
    part(right, edgeA, rDur, t0 + lDur, true, join.right_tone.filter(([x]) => x >= edgeA - 1e-3));
  }, [join, slices, edgeA, edgeB]);

  // replay automatically after each nudge, like scrubbing in Descript
  const autoplay = useRef(false);
  useEffect(() => {
    if (autoplay.current) {
      autoplay.current = false;
      play();
    }
  }, [play]);
  const nudge = (key: string, cur: number, d: number) => {
    autoplay.current = true;
    setMs(key, cur + d);
  };

  const pickNearPlayer = () => {
    if (!joins.length) return;
    let best = joins[0];
    for (const j of joins) if (Math.abs(j.out - playerTime) < Math.abs(best.out - playerTime)) best = j;
    setSel(best.k);
    listRef.current?.querySelector(`[data-k="${best.k}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  // set by an autosave, cleared by Rebuild: covers the gap until the next poll reports
  // `pending` from the server
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // autosave only STORES the corrections; "Rebuild sound check" applies them all at once
  // (Jake: the rebuild should happen only when he has finished all of his corrections)
  const save = useCallback(async (apply = false) => {
    const snapshot = localRef.current;
    const key = JSON.stringify(snapshot);
    setSaving(true);
    try {
      const r = await autoEditorSaveNudges({ id: jobId, nudges: snapshot, apply });
      lastSaved.current = key;
      setSavedAt(apply ? null : Date.now());
      if (apply) toast.success(`Rebuilding the cut and the sound check with ${r.count} cut fix(es) — a few minutes, no video render.`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [jobId, onSaved]);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(false), 1200);
    return () => clearTimeout(t);
  }, [nudges, dirty, save]);

  const edited = useMemo(() => new Set(joins.filter((j) => nudges[keyA(j)] || nudges[keyB(j)]).map((j) => j.k)), [joins, nudges]);
  const shown = onlyEdited ? joins.filter((j) => edited.has(j.k)) : joins;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">Cuts</h3>
          <p className="text-[11px] text-muted-foreground">
            Pick a cut, nudge either side a few ms and hear it instantly. Saving rebuilds the sound check only — the
            video renders when you press Render video.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={pickNearPlayer} disabled={!joins.length}>
            <Crosshair className="h-3.5 w-3.5" /> Cut at {mmss(playerTime)}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {saving
              ? 'Saving…'
              : dirty
                ? 'Unsaved — autosaves in a moment'
                : pending || savedAt
                  ? 'Saved — not in the sound check yet'
                  : ''}
          </span>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={saving || (!dirty && !pending && !savedAt)}
            onClick={() => void save(true)}
            title="Apply all saved cut fixes: rebuilds the cut and the sound check once"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Rebuild sound check
          </Button>
        </div>
      </div>

      {join && (
        <div className="space-y-2 rounded-md bg-muted/20 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-foreground">
              <span className="font-mono text-muted-foreground">{mmss(join.out)}</span> …{join.left_text}{' '}
              <span className="text-rose-400">|</span> {join.right_text}…
              {join.removed && <span className="ml-1 text-muted-foreground line-through">{join.removed}</span>}
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => onSeek(Math.max(0, join.out - 3))}>
                Show in player
              </Button>
              <Button size="sm" className="gap-1.5" onClick={play} disabled={loading || !slices || slices.k !== join.k}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Play cut
              </Button>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <Wave slice={slices?.k === join.k ? slices.left : null} edge={edgeB} auto={join.auto_b} keepLeft onPick={(t) => { autoplay.current = true; setMs(keyB(join), (t - join.auto_b) * 1000); }} />
              <Nudger label="End of left side" ms={msB} onStep={(d) => nudge(keyB(join), msB, d)} onReset={() => setMs(keyB(join), 0)} />
            </div>
            <div className="space-y-1">
              <Wave slice={slices?.k === join.k ? slices.right : null} edge={edgeA} auto={join.auto_a} keepLeft={false} onPick={(t) => { autoplay.current = true; setMs(keyA(join), (t - join.auto_a) * 1000); }} />
              <Nudger label="Start of right side" ms={msA} onStep={(d) => nudge(keyA(join), msA, d)} onReset={() => setMs(keyA(join), 0)} />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Blue is kept, grey is cut away. Red line = the cut, yellow dashes = where the algorithm put it. Click the
            waveform to put the cut there. − moves it earlier, + later.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{joins.length} cuts</span>
        {edited.size > 0 && (
          <button type="button" className="text-primary hover:underline" onClick={() => setOnlyEdited((v) => !v)}>
            {onlyEdited ? 'show all' : `show the ${edited.size} you changed`}
          </button>
        )}
      </div>
      <div ref={listRef} className="max-h-56 overflow-y-auto rounded-md border border-border">
        {shown.map((j) => (
          <button
            key={j.k}
            data-k={j.k}
            type="button"
            onClick={() => setSel(j.k)}
            className={cn(
              'flex w-full items-baseline gap-2 px-2 py-1 text-left text-[12px] hover:bg-muted/40',
              sel === j.k && 'bg-primary/15',
            )}
          >
            <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground">{mmss(j.out)}</span>
            <span className="min-w-0 flex-1 truncate">
              …{j.left_text} <span className="text-rose-400">|</span> {j.right_text}…
            </span>
            {edited.has(j.k) && <span className="shrink-0 rounded bg-rose-500/15 px-1 text-[10px] text-rose-400">nudged</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
