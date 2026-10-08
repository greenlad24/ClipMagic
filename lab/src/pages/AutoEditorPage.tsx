import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import { CutEditor } from '@/components/autoeditor/CutEditor';
import { JobProgress } from '@/components/autoeditor/JobProgress';

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

function NewEdit({ onCreated }: { onCreated: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [workflow, setWorkflow] = useState<AutoWorkflow | null>(null);
  const [format, setFormat] = useState<'short' | 'long' | null>(null);
  const [sponsored, setSponsored] = useState<boolean | null>(null);
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [sites, setSites] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = url.trim() && workflow && format && sponsored !== null;
  const creative = workflow === 'creative';

  const submit = async () => {
    if (!workflow || !format || sponsored === null) return;
    setBusy(true);
    try {
      const r = await autoEditorCreate({ url: url.trim(), workflow, format, sponsored,
        script: creative ? undefined : script, title: title.trim() || undefined,
        sites: format === 'long' ? sites : undefined });
      toast.success('Queued — the worker picks it up in a few seconds.');
      setUrl('');
      setTitle('');
      setScript('');
      setSites('');
      setFormat(null);
      setSponsored(null);
      setWorkflow(null);
      onCreated(r.id);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-medium text-foreground">New edit</h2>
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Workflow</label>
        <div className="grid gap-1.5">
          {([
            { value: 'cut', label: '1. Cut an unedited narration',
              hint: 'Raw recording → best takes picked, junk cut, frame-exact — then graphics and screencasts.' },
            { value: 'creative', label: '2. Creative edit an edited narration',
              hint: 'Already edited → nothing is cut. Straight to pre-production, screencasts, graphics and the final.' },
          ] as const).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setWorkflow(o.value)}
              className={cn(
                'rounded-md border px-2 py-1.5 text-left transition-colors',
                workflow === o.value ? 'border-primary bg-primary/15' : 'border-border hover:bg-muted/40',
              )}
            >
              <span className={cn('block text-xs', workflow === o.value ? 'text-foreground' : 'text-muted-foreground')}>{o.label}</span>
              <span className="block text-[10px] leading-snug text-muted-foreground">{o.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">
          Descript share link to the {creative ? 'EDITED narration' : 'RAW recording'}
        </label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://share.descript.com/view/…" />
      </div>
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Format</label>
        <Choice<'short' | 'long'>
          value={format}
          onChange={setFormat}
          options={[
            { value: 'short', label: 'Shorts (9:16)' },
            { value: 'long', label: 'Long-form (16:9)' },
          ]}
        />
      </div>
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Is this video sponsored?</label>
        <Choice<boolean>
          value={sponsored}
          onChange={setSponsored}
          options={[
            { value: true, label: 'Sponsored' },
            { value: false, label: 'Not sponsored' },
          ]}
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          {sponsored === true
            ? 'Every good line stays — only retakes, slips, crew talk and fillers come out.'
            : sponsored === false
              ? 'Retakes and junk come out, and sentences that just repeat a point may be cut too.'
              : 'Required — it decides whether repeated points may be cut.'}
        </p>
      </div>
      {format === 'long' && (
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Websites to show in screencasts (optional, one per line)</label>
          <Textarea value={sites} onChange={(e) => setSites(e.target.value)} rows={2} className="text-xs"
            placeholder={'linearity.io — the tool this video is about'} />
          <p className="text-[10px] leading-snug text-muted-foreground">
            The editor records these sites itself, timed to what you say. Public pages only for now.
          </p>
        </div>
      )}
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Name (optional)</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Cowork tutorial" />
      </div>
      {creative ? null : showScript ? (
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Script (optional — helps match takes to lines)</label>
          <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={6} className="text-xs" />
        </div>
      ) : (
        <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setShowScript(true)}>
          + Add the script (optional)
        </button>
      )}
      <Button className="w-full gap-1.5" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : creative ? <Film className="h-4 w-4" /> : <Scissors className="h-4 w-4" />}
        {creative ? 'Start the creative edit' : 'Clean up the narration'}
      </Button>
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
          {running && preview && (
            <p className="rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-400">
              A new version is rendering — this is the previous one until it lands.
            </p>
          )}
          {(listen || preview) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Choice<'listen' | 'video' | 'edit'>
                value={shownFile === listen ? 'listen' : shownFile === edit && edit ? 'edit' : 'video'}
                onChange={setMode}
                options={[
                  ...(listen ? [{ value: 'listen' as const, label: 'Sound check' }] : []),
                  ...(preview ? [{ value: 'video' as const, label: videoStale ? 'Video (older)' : 'Video' }] : []),
                  ...(edit ? [{ value: 'edit' as const, label: 'With graphics' }] : []),
                ]}
              />
              {rendering ? (
                <Button size="sm" variant="ghost" className="gap-1.5 text-red-400 hover:text-red-300" onClick={() => void cancelRender()}>
                  <Ban className="h-3.5 w-3.5" /> Cancel render
                </Button>
              ) : (
                <Button size="sm" variant="ghost" className="gap-1.5" disabled={running} onClick={() => void renderVideo()}>
                  <Film className="h-3.5 w-3.5" /> Render video
                </Button>
              )}
              {((job.request.format === 'short' && edit) || (job.request.format === 'long' && !!job.edlAt)) && (
                <Button size="sm" variant="ghost" className="gap-1.5" disabled={running} onClick={() => void renderFinal()}>
                  <Film className="h-3.5 w-3.5" /> Render final (4K)
                </Button>
              )}
            </div>
          )}
          {rendering && (
            <p className="rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-400">
              {job.status.message || 'Rendering…'}
              {typeof job.status.progress === 'number' && job.status.progress > 0 ? ` ${Math.round(job.status.progress * 100)}%` : ''}
            </p>
          )}
          {shownFile === listen && listen && (
            <p className="text-[11px] text-muted-foreground">
              The current cut's exact sound over the first frame — judge the cuts by ear here.
            </p>
          )}
          {shownFile === preview && videoStale && (
            <p className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400">
              This video is from before your latest edits — its timings differ from the cut list. Render video to update it.
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
          {job.request.format === 'long' && !!job.edlAt && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <p className="text-[11px] font-medium">Full edit — screencasts, facecam, titles, music</p>
              <Textarea value={sitesText} onChange={(e) => setSitesText(e.target.value)} rows={2} className="text-xs"
                placeholder={'Websites to show, one per line — e.g. linearity.io — the tool this video is about'} />
              <Button size="sm" variant="secondary" className="gap-1.5" disabled={running} onClick={() => void buildEdit()}>
                <Film className="h-3.5 w-3.5" /> {edit ? 'Rebuild the edit' : 'Build the edit'}
              </Button>
              <p className="text-[10px] leading-snug text-muted-foreground">
                Claude plans where screencasts and graphics go, records the websites timed to your words, and puts it all
                together. Watch it under "With graphics"; Render final (4K) then renders this edit.
              </p>
            </div>
          )}
          {finalFile && (
            <p className="rounded bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-400">
              {finalStale ? 'Older final, from before your latest edits' : 'Final ready'} ({(finalFile.bytes / 1e6).toFixed(0)} MB) —{' '}
              <a className="underline" href={`/api/aieditor/files/${job.id}/${finalFile.name}`} download>
                download {finalFile.name}
              </a>
            </p>
          )}
          {shownFile === edit && edit && gfx.length > 0 && (
            <div className="space-y-1 rounded-md border border-border p-2">
              <p className="text-[11px] font-medium">Graphics ({gfx.length}) — click to jump</p>
              {gfx.map((g, i) => (
                <button
                  key={i}
                  type="button"
                  title={g.why}
                  onClick={() => {
                    if (player.current) player.current.currentTime = g.t0;
                  }}
                  className="block w-full truncate text-left text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {mmss(g.t0)} {g.template}:{' '}
                  {Object.values(g.fields ?? {})
                    .filter((x) => typeof x === 'string' || typeof x === 'number')
                    .join(' · ')}
                </button>
              ))}
            </div>
          )}
          {info && (
            <p className="text-[11px] text-muted-foreground">
              {mmss(info.duration)} · {info.cuts} cuts · {info.words} words
              {preview && (
                <>
                  {' · '}
                  <a className="text-primary hover:underline" href={`/api/aieditor/files/${job.id}/${preview.name}`} download>
                    Download
                  </a>
                </>
              )}
            </p>
          )}
          {(video?.warnings ?? []).map((w, k) => (
            <p key={k} className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400">
              {w}
            </p>
          ))}
        </div>

        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {creative
                ? 'Creative edit — the narration is kept exactly as edited (no cuts). The transcript is here for reference.'
                : 'Kept lines in white, removed lines struck through with the reason. Click a word to cut or restore it.'}
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
          {review.notes && <p className="text-[11px] text-muted-foreground">Claude: {review.notes}</p>}
        </div>
      </div>

      {!creative && info && (info.joins?.length ?? 0) > 0 && (
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-foreground">
              {job.request.title || job.source?.title || job.id}
            </h2>
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', badge.cls)}>{badge.text}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {WORKFLOW_LABEL[(job.workflow ?? job.request.workflow ?? 'cut') as AutoWorkflow]} ·{' '}
            {job.request.format === 'short' ? 'Shorts' : 'Long-form'} ·{' '}
            {job.request.sponsored ? 'Sponsored' : 'Not sponsored'}
            {job.source?.duration ? ` · raw ${mmss(job.source.duration)}` : ''}
            {job.source?.width ? ` · ${job.source.width}×${job.source.height}` : ''}
            {(() => {
              const c = job.status.cost_live_usd ?? job.status.cost_usd;
              return typeof c === 'number' && c > 0 ? ` · $${c.toFixed(2)} so far` : '';
            })()}
          </p>
          {state === 'queued' && job.busyWith && (
            <p className="mt-1 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-400">
              Saved and queued — the editor runs one job at a time and is finishing “{job.busyWith.title || job.busyWith.id}”
              {job.busyWith.message ? ` (${job.busyWith.message})` : ''}. Your changes start right after it.
            </p>
          )}
        </div>
        <div className="flex gap-1.5">
          {live ? (
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void act(() => autoEditorCancel({ id }), 'Cancelling…')}>
              <Ban className="h-3.5 w-3.5" /> Cancel
            </Button>
          ) : (
            (state === 'failed' || state === 'cancelled' || state === 'interrupted') && (
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void act(() => autoEditorContinue({ id }), 'Continuing — finished steps are reused.')}>
                <RotateCcw className="h-3.5 w-3.5" /> Continue
              </Button>
            )
          )}
          {!live && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-red-400"
              onClick={() => {
                if (!confirm('Delete this edit and all its files from the server?')) return;
                void autoEditorDelete({ id }).then(onDeleted).catch((e) => toast.error(errText(e)));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </div>
      </div>

      {state === 'failed' && job.status.message && (
        <p className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">{job.status.message}</p>
      )}
      <JobProgress job={job} live={live} />

      {job.review ? (
        <Review job={job} onSaved={() => void load()} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {(job.workflow ?? job.request.workflow) === 'creative'
            ? 'The transcript and the videos appear here once the narration is transcribed and re-timed.'
            : 'The review appears here once Claude has picked the takes. A 15-minute raw recording takes about 10 minutes; a 45-minute one about 30.'}
        </p>
      )}

      {job.log && (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">Raw worker log (log.txt, last 8 KB)</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-3 text-[10px] text-muted-foreground">{job.log}</pre>
        </details>
      )}
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-5 text-sm text-muted-foreground">
      <h2 className="text-base font-medium text-foreground">Two workflows</h2>
      <p className="text-xs">
        <span className="text-foreground">1. Cut an unedited narration</span> — the steps below.{' '}
        <span className="text-foreground">2. Creative edit an edited narration</span> — the narration is already edited, so
        nothing is cut: it is transcribed and re-timed, then goes straight to pre-production, screencasts, graphics and
        the final. Every step shows its own progress bar, timing, cost and full live log.
      </p>
      <h2 className="text-base font-medium text-foreground">1. Raw narration → clean edit</h2>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Publish the RAW recording in Descript (download allowed) and paste the share link.</li>
        <li>The worker transcribes it word by word and re-times every word against the audio.</li>
        <li>Claude picks the best take of every line, cuts crew talk, false starts, "uh"s and stacked "so"s, and caps every pause at 0.35 s — your Descript routine.</li>
        <li>You get a sound check of each video in minutes (the exact cut, first frame held), then the frame-exact video preview. Every removed sentence is listed with the reason — restore anything with one click.</li>
        <li>Any single cut can be nudged a few ms either way under Cuts and heard instantly — no re-render.</li>
      </ol>
      <p className="text-xs">One recording can hold several shorts — each script becomes its own video.</p>
    </div>
  );
}

export default function AutoEditorPage() {
  const { id: selected } = useParams<{ id: string }>();
  const navigate = useNavigate();
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
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="sm" className="gap-1.5">
                <ArrowLeft className="h-4 w-4" />
                Tools
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Auto Editor</h1>
              <p className="text-xs text-muted-foreground">
                Raw narration in — best takes picked, junk cut, frame-exact. Graphics, screencasts and music come next.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'text-xs',
                workerAlive === null ? 'text-muted-foreground' : workerAlive ? 'text-green-400' : 'text-red-400',
              )}
            >
              {workerAlive === null ? 'Worker …' : workerAlive ? '● Worker running' : '● Worker not responding'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void refresh()} className="gap-1.5">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-4">
            <NewEdit
              onCreated={(id) => {
                void refresh();
                navigate(`/auto-editor/${id}`);
              }}
            />
            <div className="rounded-lg border border-border">
              <div className="border-b border-border px-3 py-2.5">
                <h2 className="text-sm font-medium text-foreground">Edits</h2>
              </div>
              {!loaded ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>
              ) : jobs.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">No edits yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {jobs.map((j) => {
                    const b = STATE_BADGE[j.state] ?? STATE_BADGE.queued;
                    return (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() => navigate(`/auto-editor/${j.id}`)}
                        className={cn(
                          'block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/40',
                          selected === j.id && 'bg-muted/60',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm text-foreground">{j.title}</span>
                          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', b.cls)}>{b.text}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
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
              <JobDetail
                key={selected}
                id={selected}
                onChanged={refresh}
                onDeleted={() => {
                  void refresh();
                  navigate('/auto-editor');
                }}
              />
            ) : (
              <HowItWorks />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
