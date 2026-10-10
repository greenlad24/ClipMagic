import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Trash2,
  Ban,
  RotateCcw,
  Undo2,
  Save,
  Scissors,
  Film,
  Plus,
  HardDrive,
  ChevronDown,
  ChevronRight,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  autoEditorStatus,
  autoEditorJobs,
  autoEditorJob,
  autoEditorCreate,
  autoEditorSaveEdits,
  autoEditorResetEdits,
  autoEditorContinue,
  autoEditorCancel,
  autoEditorDelete,
  autoEditorRenderVideo,
  autoEditorRenderFinal,
  autoEditorBuildEdit,
  type AutoJobSummary,
  type AutoJobDetail,
  type AutoVideoPlan,
  type AutoWorkflow,
  type AutoRunOn,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import { CutEditor } from '@/components/autoeditor/CutEditor';
import { JobProgress } from '@/components/autoeditor/JobProgress';
import { FactoryPanel } from '@/components/autoeditor/FactoryPanel';
import { NewEditFlow } from '@/components/autoeditor/NewEditFlow';
import { StoredFiles } from '@/components/autoeditor/StoredFiles';
import { HeldPanel } from '@/components/autoeditor/HeldPanel';
import { HandoffShare } from '@/components/autoeditor/HandoffShare';
import { JobMusic } from '@/components/autoeditor/MusicPicker';
import { OverlayCatalog, overlayName, overlayTemplate } from '@/components/autoeditor/overlayTemplates';

/**
 * Auto Editor — raw narration in, clean edit out.
 *
 * Stage 1 (live): a Descript link to the RAW recording → Groq word transcript →
 * every word re-timed against the audio → Claude picks the best take of every line
 * (Jake's own cleanup rules) → frame-exact cut → 1080p previews. Jake reviews every
 * removed sentence here and can restore any of them.
 *
 * ⚠️ THE PAGE DOES NOT RUN ANYTHING. It writes job files that the aieditor-worker
 * service on the host picks up, and polls — closing the tab stops nothing.
 */

// Jake 2026-10-08: "there are 2 workflows: 1. Cut an unedited narration 2. Creative Edit an
// edited narration." Picked when the job is created; the worker branches on it.
const WORKFLOW_LABEL: Record<AutoWorkflow, string> = {
  cut: 'Cut',
  creative: 'Creative edit',
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function ago(ts: number | null | undefined): string {
  if (!ts) return '';
  if (ts > 1e12) ts /= 1000; // some request.json created_at were written in ms
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function mmss(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Static classes only — Tailwind has no safelist here.
const STATE_BADGE: Record<string, { text: string; cls: string }> = {
  queued: { text: 'Queued', cls: 'bg-muted text-muted-foreground' },
  running: { text: 'Running', cls: 'bg-blue-500/15 text-blue-400' },
  done: { text: 'Ready', cls: 'bg-green-500/15 text-green-400' },
  failed: { text: 'Failed', cls: 'bg-red-500/15 text-red-400' },
  // failed the ship rule / a quality gate: never shipped, never a finished edit (architecture §4)
  held: { text: 'Held', cls: 'bg-amber-500/15 text-amber-400' },
  cancelled: { text: 'Cancelled', cls: 'bg-muted text-muted-foreground' },
  interrupted: { text: 'Interrupted', cls: 'bg-amber-500/15 text-amber-400' },
};

function Choice<T extends string | boolean>({
  value,
  options,
  onChange,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
            value === o.value
              ? 'border-primary bg-primary/15 text-foreground'
              : 'border-border text-muted-foreground hover:bg-muted/40',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Lowercased words without punctuation. */
function normWords(ws: { w: string }[]): string[] {
  return ws.map((w) => w.w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean);
}

/**
 * How alike two sentences are as TAKES of the same line, 0..1: the best of word-bigram
 * overlap (Dice) and containment (a partial take — "because the text, the shapes…" is
 * inside the full line). Jake 2026-10-05: switch a kept sentence for another take of it.
 */
function takeSimilarity(a: string[], b: string[]): number {
  if (a.length < 3 || b.length < 3) return 0;
  const grams = (x: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i < x.length - 1; i++) m.set(x[i] + ' ' + x[i + 1], (m.get(x[i] + ' ' + x[i + 1]) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let common = 0;
  for (const [k, n] of ga) common += Math.min(n, gb.get(k) ?? 0);
  const dice = (2 * common) / Math.max(1, a.length - 1 + b.length - 1);
  const contain = common / Math.max(1, Math.min(a.length, b.length) - 1);
  return Math.max(dice, Math.min(a.length, b.length) >= 4 ? contain * 0.9 : 0);
}

/** Play a stretch of the ORIGINAL recording (the authed audio-slice route, ≤ 12 s). */
let takePlayer: HTMLAudioElement | null = null;
function playRecording(jobId: string, from: number, to: number) {
  takePlayer?.pause();
  const end = Math.min(to + 0.25, from + 12);
  takePlayer = new Audio(`/api/aieditor/audio/${jobId}?from=${Math.max(0, from - 0.15).toFixed(3)}&to=${end.toFixed(3)}`);
  void takePlayer.play();
}

/** Insert sentence `s` into a video's segments at its recording-time position. */
function insertByTime(
  segs: { s: number; drop: number[] }[],
  s: number,
  start: (n: number) => number,
): { s: number; drop: number[] }[] {
  const t = start(s);
  let at = segs.length;
  for (let k = 0; k < segs.length; k++) {
    if (start(segs[k].s) > t) {
      at = k;
      break;
    }
  }
  return [...segs.slice(0, at), { s, drop: [] }, ...segs.slice(at)];
}

function Review({ job, onSaved }: { job: AutoJobDetail; onSaved: () => void }) {
  const review = job.review!;
  const [plan, setPlan] = useState<AutoVideoPlan[]>(review.videos);
  const [tab, setTab] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => setPlan(review.videos), [review.videos]);
  const dirty = JSON.stringify(plan) !== JSON.stringify(review.videos);
  const running = job.status.state === 'running' || job.status.state === 'queued';
  // workflow 2: the narration was already edited — the transcript is for reference, not for cutting
  const creative = (job.workflow ?? job.request.workflow) === 'creative';

  const sentence = useMemo(() => new Map(review.sentences.map((s) => [s.s, s])), [review.sentences]);
  const startOf = useCallback((n: number) => sentence.get(n)?.start ?? 0, [sentence]);
  const owner = useMemo(() => {
    const m = new Map<number, number>();
    plan.forEach((v, k) => v.segments.forEach((seg) => m.set(seg.s, k)));
    return m;
  }, [plan]);

  const video = plan[tab];
  // The recording span this video draws from: its kept sentences, plus every removed
  // sentence that lies between them (or right around them) — the candidates to restore.
  const rows = useMemo(() => {
    if (!video || video.segments.length === 0) return [];
    const kept = video.segments.map((g) => g.s);
    const times = kept.map(startOf);
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    const removed = review.sentences
      .filter((s) => !owner.has(s.s) && s.start >= lo - 20 && s.start <= hi + 20)
      .map((s) => s.s);
    // nearest video wins a removed sentence on shorts with several videos
    const mine = removed.filter((n) => {
      let best = tab;
      let dist = Infinity;
      plan.forEach((v, k) => {
        for (const g of v.segments) {
          const d = Math.abs(startOf(g.s) - startOf(n));
          if (d < dist) {
            dist = d;
            best = k;
          }
        }
      });
      return best === tab;
    });
    return [...kept.map((s) => ({ s, kept: true })), ...mine.map((s) => ({ s, kept: false }))].sort(
      (a, b) => startOf(a.s) - startOf(b.s),
    );
  }, [video, review.sentences, owner, plan, tab, startOf]);

  // other takes of every sentence (any sentence, anywhere in the recording, not used
  // in another place of the cut): the candidates for "Use this take"
  const normed = useMemo(() => new Map(review.sentences.map((x) => [x.s, normWords(x.words)])), [review.sentences]);
  const altsOf = useCallback(
    (s: number) => {
      const a = normed.get(s) ?? [];
      const out: { s: number; score: number }[] = [];
      for (const x of review.sentences) {
        if (x.s === s || owner.has(x.s)) continue;
        const score = takeSimilarity(a, normed.get(x.s) ?? []);
        if (score >= 0.6) out.push({ s: x.s, score });
      }
      return out.sort((p, q) => q.score - p.score).slice(0, 6);
    },
    [normed, review.sentences, owner],
  );
  const [openTakes, setOpenTakes] = useState<number | null>(null);

  const setVideo = (fn: (v: AutoVideoPlan) => AutoVideoPlan) =>
    setPlan((p) => p.map((v, k) => (k === tab ? fn(v) : v)));
  // swap a kept sentence for another take of it, IN PLACE (same position in the cut)
  const useTake = (s: number, alt: number) => {
    setVideo((v) => ({ ...v, segments: v.segments.map((g) => (g.s === s ? { s: alt, drop: [] } : g)) }));
    setOpenTakes(alt);
    toast.success('Take switched — press Save to rebuild the cut.');
  };
  const toggleSentence = (s: number, keep: boolean) =>
    setVideo((v) => ({
      ...v,
      segments: keep ? insertByTime(v.segments, s, startOf) : v.segments.filter((g) => g.s !== s),
    }));
  const toggleWord = (s: number, i: number) =>
    setVideo((v) => ({
      ...v,
      segments: v.segments.map((g) =>
        g.s !== s ? g : { ...g, drop: g.drop.includes(i) ? g.drop.filter((x) => x !== i) : [...g.drop, i].sort((a, b) => a - b) },
      ),
    }));

  const save = async () => {
    setSaving(true);
    try {
      await autoEditorSaveEdits({ id: job.id, videos: plan });
      toast.success('Saved — rebuilding the cut and the sound check (a few minutes, no video render).');
      onSaved();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    try {
      await autoEditorResetEdits({ id: job.id });
      toast.success("Back to Claude's cut — rebuilding the sound check.");
      onSaved();
    } catch (err) {
      toast.error(errText(err));
    }
  };

  const preview = job.previews[tab];
  const listen = job.listens?.[tab];
  const info = job.videos[tab];
  const vertical = (job.source?.height ?? 0) > (job.source?.width ?? 0);
  // The sound check is the CURRENT cut (fast, first frame held); the video preview only
  // changes when Jake presses Render video, so after an edit it is older than the cut.
  const videoStale = !!preview && !!job.edlAt && preview.modifiedAt * 1000 < job.edlAt - 1000;
  const edit = job.edits?.[tab];
  const gfx = job.graphics?.[tab] ?? [];
  const [mode, setMode] = useState<'listen' | 'video' | 'edit'>('listen');
  const shownFile =
    mode === 'edit' ? edit ?? preview ?? listen : mode === 'listen' ? listen ?? preview : preview ?? listen;
  const player = useRef<HTMLVideoElement>(null);
  const [playerTime, setPlayerTime] = useState(0);
  // Jake: "I need to be able to cancel the render job from the UI" — right next to the
  // button that starts it (the job-level Cancel sits far away in the header)
  const rendering =
    job.status.state === 'running' &&
    (['render', 'final'].includes(String((job.status as { action?: string }).action ?? '')) ||
      ['preview', 'graphics', 'compose', 'final'].includes(String(job.status.stage ?? '')));
  const cancelRender = async () => {
    try {
      await autoEditorCancel({ id: job.id });
      toast.success('Cancelling the render — the previous video stays.');
      onSaved();
    } catch (err) {
      toast.error(errText(err));
    }
  };
  const renderVideo = async () => {
    try {
      await autoEditorRenderVideo({ id: job.id });
      toast.success('Rendering the video preview of the current cut (~35 min for a long-form).');
      onSaved();
    } catch (err) {
      toast.error(errText(err));
    }
  };

  const finalFile = job.finals?.[tab];
  const canFinal = !job.request.handoff && job.status.state !== 'held' &&
    ((job.request.format === 'short' && !!edit) || (job.request.format === 'long' && !!job.edlAt));
  // a final made before the latest cut edits is not the cut on screen any more
  const finalStale = !!finalFile && !!job.edlAt && finalFile.modifiedAt * 1000 < job.edlAt - 1000;
  const [sitesText, setSitesText] = useState(() =>
    (job.request.sites ?? []).map((x) => (x.note ? `${x.url} — ${x.note}` : x.url)).join('\n'));
  const buildEdit = async () => {
    try {
      await autoEditorBuildEdit({ id: job.id, sites: sitesText });
      toast.success('Building the full edit: screencasts, graphics, music. Recording runs frame by frame — allow a while.');
      onSaved();
    } catch (err) {
      toast.error(errText(err));
    }
  };
  const renderFinal = async () => {
    try {
      await autoEditorRenderFinal({ id: job.id });
      toast.success(
        job.request.format === 'long'
          ? (edit ? 'Rendering the full edit in 4K. A long video takes a few hours — you can leave this page.'
            : 'Rendering the final cut in 4K. A long video takes a few hours — you can leave this page.')
          : 'Rendering the final videos at full resolution with graphics, captions and sound effects.',
      );
      onSaved();
    } catch (err) {
      toast.error(errText(err));
    }
  };

  return (
    <div className="space-y-4">
      {plan.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {plan.map((v, k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                tab === k ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/40',
              )}
            >
              {k + 1}. {v.title}
            </button>
          ))}
        </div>
      )}

      <div className={cn('grid gap-4', vertical ? 'md:grid-cols-[280px_minmax(0,1fr)]' : 'grid-cols-1')}>
        <div className="space-y-2">
          {(listen || preview) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="w-full sm:w-auto sm:min-w-[16rem]">
                <Choice<'listen' | 'video' | 'edit'>
                  value={shownFile === listen ? 'listen' : shownFile === edit && edit ? 'edit' : 'video'}
                  onChange={setMode}
                  options={[
                    ...(listen ? [{ value: 'listen' as const, label: 'Sound check' }] : []),
                    ...(preview ? [{ value: 'video' as const, label: videoStale ? 'Video (older)' : 'Video' }] : []),
                    ...(edit ? [{ value: 'edit' as const, label: 'With graphics' }] : []),
                  ]}
                />
              </div>
              <div className="ml-auto flex flex-wrap gap-1.5">
                {rendering ? (
                  <Button size="sm" variant="ghost" className="gap-1.5 text-red-400 hover:text-red-300" onClick={() => void cancelRender()}>
                    <Ban className="h-3.5 w-3.5" /> Cancel render
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="gap-1.5" disabled={running} onClick={() => void renderVideo()}>
                    <Film className="h-3.5 w-3.5" /> Render video
                  </Button>
                )}
                {canFinal && (
                  <Button
                    size="sm"
                    variant={finalFile && !finalStale ? 'ghost' : 'default'}
                    className="gap-1.5"
                    disabled={running}
                    onClick={() => void renderFinal()}
                  >
                    <Film className="h-3.5 w-3.5" /> {finalFile ? 'Re-render final (4K)' : 'Render final (4K)'}
                  </Button>
                )}
              </div>
            </div>
          )}
          {finalFile && (
            <div
              className={cn(
                'flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-xs',
                finalStale ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400',
              )}
            >
              <span className="min-w-0 flex-1">
                {finalStale ? 'Older final — made before your latest edits' : 'Final ready'} · {(finalFile.bytes / 1e6).toFixed(0)} MB
              </span>
              <Button asChild size="sm" variant={finalStale ? 'ghost' : 'default'} className="h-7 gap-1.5 text-xs">
                <a href={`/api/aieditor/files/${job.id}/${finalFile.name}`} download>
                  <Download className="h-3.5 w-3.5" /> Download {finalFile.name}
                </a>
              </Button>
            </div>
          )}
          {/* "Graphics only — editor adds screencasts": the package for the editor (aieditor/handoff.py) */}
          {(job.handoff ?? []).map((p) => (
            <HandoffShare key={`${p.zip}-${p.modifiedAt}`} jobId={job.id} pkg={p} />
          ))}
          {rendering && (
            <p className="rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-400">
              {job.status.message || 'Rendering…'}
              {typeof job.status.progress === 'number' && job.status.progress > 0 ? ` ${Math.round(job.status.progress * 100)}%` : ''}
              {preview ? ' — showing the previous version until it lands.' : ''}
            </p>
          )}
          {running && !rendering && preview && (
            <p className="rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-400">
              A new version is on its way — this is the previous one until it lands.
            </p>
          )}
          {shownFile === preview && videoStale && (
            <p className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400">
              This video is from before your latest edits — press Render video to update it.
            </p>
          )}
          {shownFile ? (
            <video
              ref={player}
              key={`${shownFile.name}-${shownFile.modifiedAt}`}
              controls
              preload="metadata"
              onTimeUpdate={(e) => setPlayerTime(e.currentTarget.currentTime)}
              className={cn('w-full rounded-md bg-black', vertical ? 'aspect-[9/16]' : 'aspect-video')}
              src={`/api/aieditor/files/${job.id}/${shownFile.name}?v=${Math.round(shownFile.modifiedAt)}`}
            />
          ) : (
            <div className={cn('flex w-full items-center justify-center rounded-md bg-muted/40 text-xs text-muted-foreground', vertical ? 'aspect-[9/16]' : 'aspect-video')}>
              {running ? 'Rendering…' : 'No preview yet'}
            </div>
          )}
          {info && (
            <p className="text-[11px] text-muted-foreground">
              {mmss(info.duration)} · {info.cuts} cuts · {info.words} words
              {shownFile === listen && listen && ' · sound check: the exact cut over the first frame'}
              {preview && (
                <>
                  {' · '}
                  <a className="text-primary hover:underline" href={`/api/aieditor/files/${job.id}/${preview.name}`} download>
                    Download preview
                  </a>
                </>
              )}
            </p>
          )}
          {job.request.format === 'long' && !!job.edlAt && !job.request.handoff && (
            <details className="group rounded-md border border-border" open={!!sitesText.trim() && !edit}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="text-foreground">Full edit</span>
                <span className="truncate text-muted-foreground">
                  {edit ? 'built — watch it under “With graphics”' : 'screencasts, facecam, titles, music'}
                </span>
              </summary>
              <div className="space-y-1.5 px-3 pb-3">
                <Textarea value={sitesText} onChange={(e) => setSitesText(e.target.value)} rows={2} className="text-xs"
                  placeholder={'Websites to show, one per line — e.g. linearity.io — the tool this video is about'} />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" className="gap-1.5" disabled={running} onClick={() => void buildEdit()}>
                    <Film className="h-3.5 w-3.5" /> {edit ? 'Rebuild the edit' : 'Build the edit'}
                  </Button>
                  <p className="text-[10.5px] leading-snug text-muted-foreground">
                    Claude places screencasts + graphics and records the sites timed to your words. Render final (4K) then renders this edit.
                  </p>
                </div>
              </div>
            </details>
          )}
          {shownFile === edit && edit && gfx.length > 0 && (
            <details className="group rounded-md border border-border">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                Graphics ({gfx.length}) <span className="text-muted-foreground">— click to jump</span>
              </summary>
              <div className="space-y-1 px-3 pb-2">
                {gfx.map((g, i) => (
                  <button
                    key={i}
                    type="button"
                    title={[overlayTemplate(g.template)?.description, g.why].filter(Boolean).join('\n\n') || undefined}
                    onClick={() => {
                      if (player.current) player.current.currentTime = g.t0;
                    }}
                    className="block w-full truncate text-left text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {mmss(g.t0)} <span className="text-foreground/80">{overlayName(g.template)}</span>
                    {overlayTemplate(g.template)?.zone && ` (zone: ${overlayTemplate(g.template)!.zone})`}:{' '}
                    {Object.values(g.fields ?? {})
                      .filter((x) => typeof x === 'string' || typeof x === 'number')
                      .join(' · ')}
                  </button>
                ))}
              </div>
            </details>
          )}
          <OverlayCatalog />
          {(video?.warnings ?? []).length > 0 && (
            <details className="group rounded-md border border-amber-500/30 bg-amber-500/5" open>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-amber-400">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                {video.warnings!.length} thing{video.warnings!.length === 1 ? '' : 's'} to check
              </summary>
              <ul className="space-y-1.5 px-3 pb-2.5 pl-8">
                {video.warnings!.map((w, k) => (
                  <li key={k} className="list-disc text-[11px] leading-snug text-amber-300/90">
                    {w}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {creative
                ? 'Transcript (for reference — nothing is cut in a creative edit)'
                : 'Click a word to cut or restore it. Struck-through lines show why they went.'}
            </p>
            {!creative && (
            <div className="flex gap-1.5">
              {review.edited && (
                <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void reset()} disabled={running}>
                  <Undo2 className="h-3.5 w-3.5" /> Claude's cut
                </Button>
              )}
              <Button size="sm" className="gap-1.5" disabled={!dirty || saving || running} onClick={() => void save()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save
              </Button>
            </div>
            )}
          </div>
          <div className="max-h-[70vh] space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {rows.map(({ s, kept }) => {
              const sen = sentence.get(s);
              if (!sen) return null;
              const seg = video.segments.find((g) => g.s === s);
              const why = review.reasons[String(s)] ?? 'removed by you';
              const alts = kept && !creative ? altsOf(s) : [];
              return (
                <div key={s}>
                <div
                  className={cn('group flex items-start gap-2 rounded px-1.5 py-1', kept ? 'hover:bg-muted/30' : 'opacity-60 hover:opacity-90')}
                >
                  <span className="mt-0.5 w-12 shrink-0 font-mono text-[10px] text-muted-foreground">{mmss(sen.start)}</span>
                  <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
                    {sen.words.map((w) => {
                      const dropped = !kept || (seg?.drop ?? []).includes(w.i);
                      return (
                        <span
                          key={w.i}
                          onClick={kept && !creative ? () => toggleWord(s, w.i) : undefined}
                          className={cn(
                            kept && !creative && 'cursor-pointer rounded hover:bg-primary/20',
                            dropped ? 'text-muted-foreground line-through' : 'text-foreground',
                          )}
                        >
                          {w.w}{' '}
                        </span>
                      );
                    })}
                    {!kept && <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{why}</span>}
                  </div>
                  {kept && alts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setOpenTakes(openTakes === s ? null : s)}
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] hover:bg-muted',
                        openTakes === s ? 'bg-primary/15 text-foreground' : 'text-primary',
                      )}
                      title="Other recorded takes of this line"
                    >
                      Takes ({alts.length + 1})
                    </button>
                  )}
                  {!creative && (
                  <button
                    type="button"
                    onClick={() => toggleSentence(s, !kept)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
                  >
                    {kept ? 'Remove' : 'Restore'}
                  </button>
                  )}
                </div>
                {kept && openTakes === s && alts.length > 0 && (
                  <div className="mb-1 ml-14 space-y-1 rounded-md border border-primary/30 bg-primary/5 p-2">
                    <div className="flex items-start gap-2 text-[12px]">
                      <button
                        type="button"
                        onClick={() => playRecording(job.id, sen.start, sen.end)}
                        className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70"
                      >
                        ▶ play
                      </button>
                      <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground">{mmss(sen.start)}</span>
                      <span className="min-w-0 flex-1">
                        {sen.words.map((w) => w.w).join(' ')}{' '}
                        <span className="rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-400">in the cut</span>
                      </span>
                    </div>
                    {alts.map(({ s: a }) => {
                      const alt = sentence.get(a);
                      if (!alt) return null;
                      return (
                        <div key={a} className="flex items-start gap-2 text-[12px]">
                          <button
                            type="button"
                            onClick={() => playRecording(job.id, alt.start, alt.end)}
                            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70"
                          >
                            ▶ play
                          </button>
                          <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground">{mmss(alt.start)}</span>
                          <span className="min-w-0 flex-1 text-muted-foreground">
                            {alt.words.map((w) => w.w).join(' ')}{' '}
                            <span className="rounded bg-muted px-1 text-[10px]">{review.reasons[String(a)] ?? 'removed by you'}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => useTake(s, a)}
                            className="shrink-0 rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/15"
                          >
                            Use this take
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                </div>
              );
            })}
          </div>
          {review.notes && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" /> Claude's notes on this cut
              </summary>
              <p className="mt-1 pl-[18px] text-[11px] leading-relaxed text-muted-foreground">{review.notes}</p>
            </details>
          )}
        </div>
      </div>

      {!creative && info && (info.joins?.length ?? 0) > 0 && (
        <details className="group rounded-lg border border-border" open={!!job.nudgesPending}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="text-foreground">Fine-tune cuts</span>
            <span className="text-muted-foreground">
              {info.joins.length} cuts · nudge any join a few ms and hear it instantly
              {job.nudgesPending ? ' · unapplied changes' : ''}
            </span>
          </summary>
          <div className="px-3 pb-3">
        <CutEditor
          jobId={job.id}
          joins={info.joins}
          saved={job.nudges ?? {}}
          pending={!!job.nudgesPending}
          playerTime={playerTime}
          onSeek={(t) => {
            const v = player.current;
            if (v) {
              v.currentTime = t;
              void v.play();
            }
          }}
          disabled={running}
          onSaved={onSaved}
        />
          </div>
        </details>
      )}
    </div>
  );
}

function JobDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [job, setJob] = useState<AutoJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJob(await autoEditorJob({ id }));
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [id]);

  const state = job?.status.state;
  const live = state === 'running' || state === 'queued';
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), live ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, live]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!job) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const badge = STATE_BADGE[state ?? 'queued'] ?? STATE_BADGE.queued;
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      void load();
      onChanged();
    } catch (err) {
      toast.error(errText(err));
    }
  };

  const stageStates = Object.values(job.status.stages ?? {}).map((x) => x?.state);
  const stoppedInStage = stageStates.some((x) => x === 'failed' || x === 'interrupted');
  const canContinue = state === 'failed' || state === 'cancelled' || state === 'interrupted' || state === 'held';
  const doContinue = () => void act(() => autoEditorContinue({ id }), 'Continuing — finished steps are reused.');
  const creative = (job.workflow ?? job.request.workflow) === 'creative';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-foreground">
              {job.request.title || job.source?.title || job.id}
            </h2>
            <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', badge.cls)}>{badge.text}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {job.chain?.isChain ? 'Full edit · cut' : WORKFLOW_LABEL[(job.workflow ?? job.request.workflow ?? 'cut') as AutoWorkflow]} ·{' '}
            {job.request.format === 'short' ? 'Shorts' : 'Long-form'} ·{' '}
            {job.request.sponsored ? 'Sponsored' : 'Not sponsored'}
            {job.request.source?.kind === 'job'
              ? ` · from the Lab edit ${job.request.source.title || job.request.source.job} (${job.request.source.file})`
              : job.request.source?.kind === 'upload' || job.request.source?.kind === 'job_source'
                ? ` · uploaded ${job.request.source.name}`
                : ''}
            {job.source?.duration ? ` · raw ${mmss(job.source.duration)}` : ''}
            {job.source?.width ? ` · ${job.source.width}×${job.source.height}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {live && (
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void act(() => autoEditorCancel({ id }), 'Cancelling…')}>
              <Ban className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          {canContinue && (
            <Button size="sm" className="gap-1.5" onClick={doContinue}>
              <RotateCcw className="h-3.5 w-3.5" /> Continue
            </Button>
          )}
          {!live && (
            <Button
              size="icon"
              variant="ghost"
              title="Delete this edit"
              className="h-8 w-8 text-muted-foreground hover:text-red-400"
              onClick={() => {
                if (!confirm('Delete this edit and all its files from the server?')) return;
                void autoEditorDelete({ id }).then(onDeleted).catch((e) => toast.error(errText(e)));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {state === 'queued' && job.busyWith && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          Queued behind “{job.busyWith.title || job.busyWith.id}”{job.busyWith.message ? ` (${job.busyWith.message})` : ''} — the editor
          runs one job at a time. Yours starts right after.
        </p>
      )}
      {(state === 'failed' || state === 'interrupted') && job.status.message && !stoppedInStage && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-red-300">{job.status.message}</p>
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={doContinue}>
            <RotateCcw className="h-3.5 w-3.5" /> Continue
          </Button>
        </div>
      )}
      {job.deleted && job.deleted.length > 0 && (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Deleted from the server:{' '}
          {job.deleted.map((d) => `${d.files.join(', ')} (${new Date(d.at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})`).join(' · ')}
        </p>
      )}
      {job.chain && <ChainLinks chain={job.chain} />}
      {state === 'held' && job.held && <HeldPanel held={job.held} />}
      <JobProgress job={job} live={live} onContinue={canContinue ? doContinue : undefined} />
      {/* background music: the job's choice + "Change music" (sound only, worker action "remusic") */}
      {job.request.format === 'long' && (
        <JobMusic jobId={job.id} live={live}
          progress={{ message: job.status.stages?.music?.message ?? job.status.message, frac: job.status.stages?.music?.progress ?? null }}
          onChanged={() => { void load(); onChanged(); }} />
      )}

      {job.review ? (
        <Review job={job} onSaved={() => void load()} />
      ) : (
        live && (
          <p className="text-xs text-muted-foreground">
            {creative
              ? 'The transcript and videos appear here as soon as they are ready.'
              : 'Your review appears here once Claude has picked the takes (~10 min per 15 min of recording).'}
          </p>
        )
      )}

      {job.log && (
        <details className="rounded-md border border-border/60">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-muted-foreground">Raw worker log (log.txt, last 8 KB)</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-3 text-[10px] text-muted-foreground">{job.log}</pre>
        </details>
      )}
    </div>
  );
}

const CHAIN_STEP: Record<string, string> = {
  final: 'waiting for the final cut',
  recut: 're-cutting (the word check failed once)',
  held: 'stopped — the cut is held',
};

/**
 * The cut → creative chain of a Full edit (aieditor/chain.py): where this job goes next and where it
 * started from, as links. Informational only — nothing here waits for Jake.
 */
function ChainLinks({ chain }: { chain: NonNullable<AutoJobDetail['chain']> }) {
  const stateText = (s: string | null) => (s === 'done' ? 'finished' : s ?? 'queued');
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
      {chain.from && (
        <span className="text-muted-foreground">
          Started from:{' '}
          <Link to={`/auto-editor/${chain.from.id}`} className="text-primary hover:underline">
            {chain.from.title}
          </Link>{' '}
          (the cut)
        </span>
      )}
      {chain.isChain && (
        <span className="text-muted-foreground">
          Next: creative edit{' '}
          {chain.next ? (
            <>
              <Link to={`/auto-editor/${chain.next.id}`} className="text-primary hover:underline">
                {chain.next.title}
              </Link>{' '}
              ({stateText(chain.next.state)})
            </>
          ) : (
            <>({CHAIN_STEP[chain.step ?? ''] ?? 'starts by itself when the cut is final'})</>
          )}
        </span>
      )}
    </div>
  );
}

export default function AutoEditorPage() {
  const { id: selected } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // /auto-editor?view=files — what the edits keep on the factory volume (StoredFiles.tsx)
  const [search] = useSearchParams();
  const filesView = !selected && search.get('view') === 'files';
  const [jobs, setJobs] = useState<AutoJobSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [j, s] = await Promise.all([autoEditorJobs({}), autoEditorStatus({})]);
      setJobs(j.jobs);
      setWorkerAlive(s.workerAlive);
      setLoaded(true);
    } catch (err) {
      toast.error(errText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="gap-1.5 px-2">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Tools</span>
              </Button>
            </Link>
            <h1 className="truncate text-lg font-semibold text-foreground">Auto Editor</h1>
            <span
              title={workerAlive === null ? 'Checking the worker…' : workerAlive ? 'Worker running' : 'Worker not responding'}
              className={cn(
                'flex items-center gap-1.5 text-[11px]',
                workerAlive === null ? 'text-muted-foreground' : workerAlive ? 'text-green-400' : 'text-red-400',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', workerAlive === null ? 'bg-muted-foreground' : workerAlive ? 'bg-green-400' : 'bg-red-400 animate-pulse')} />
              <span className={cn(workerAlive ? 'hidden sm:inline' : '')}>{workerAlive === false ? 'Worker not responding' : 'Worker online'}</span>
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void refresh()} title="Refresh" className="h-8 w-8">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        <div className="mb-5">
          <FactoryPanel />
        </div>

        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* sidebar: on a phone it only shows on the start screen, below the flow */}
          <div className={cn('space-y-3', selected || filesView ? 'hidden lg:block' : 'order-2 lg:order-none')}>
            <Button
              variant={selected ? 'secondary' : 'outline'}
              className="hidden w-full gap-1.5 lg:flex"
              onClick={() => navigate('/auto-editor')}
              disabled={!selected && !filesView}
            >
              <Plus className="h-4 w-4" /> New edit
            </Button>
            <Button
              variant={filesView ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-1.5 text-muted-foreground"
              onClick={() => navigate('/auto-editor?view=files')}
            >
              <HardDrive className="h-4 w-4" /> Stored files
            </Button>
            <div>
              <h2 className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Edits</h2>
              {!loaded ? (
                <p className="px-1 py-4 text-xs text-muted-foreground">Loading…</p>
              ) : jobs.length === 0 ? (
                <p className="px-1 py-4 text-xs text-muted-foreground">No edits yet.</p>
              ) : (
                <div className="space-y-0.5">
                  {jobs.map((j) => {
                    const b = STATE_BADGE[j.state] ?? STATE_BADGE.queued;
                    const busy = j.state === 'running' || j.state === 'queued';
                    return (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() => navigate(`/auto-editor/${j.id}`)}
                        className={cn(
                          'block w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/40',
                          selected === j.id && 'bg-muted/60',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[13px] text-foreground">{j.title}</span>
                          {j.state === 'done' ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" title={b.text} />
                          ) : (
                            <span className={cn('flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium', b.cls)}>
                              {busy && j.state === 'running' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                              {b.text}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {WORKFLOW_LABEL[j.workflow ?? 'cut']} · {j.format === 'short' ? 'Shorts' : 'Long-form'} ·{' '}
                          {j.sponsored ? 'Sponsored' : 'Not sponsored'} · {ago(j.createdAt)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0">
            {selected ? (
              <>
                <Link to="/auto-editor" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground lg:hidden">
                  <ArrowLeft className="h-3.5 w-3.5" /> All edits
                </Link>
                <JobDetail
                  key={selected}
                  id={selected}
                  onChanged={refresh}
                  onDeleted={() => {
                    void refresh();
                    navigate('/auto-editor');
                  }}
                />
              </>
            ) : filesView ? (
              <>
                <Link to="/auto-editor" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground lg:hidden">
                  <ArrowLeft className="h-3.5 w-3.5" /> New edit
                </Link>
                <StoredFiles />
              </>
            ) : (
              <div className="py-2 sm:rounded-xl sm:border sm:border-border sm:px-8 sm:py-10">
                <NewEditFlow
                  onCreated={(id) => {
                    void refresh();
                    navigate(`/auto-editor/${id}`);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
