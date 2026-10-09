import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Film,
  Link2,
  Loader2,
  RectangleHorizontal,
  RectangleVertical,
  Scissors,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  autoEditorCreate,
  autoEditorLabEdits,
  type AutoLabEdit,
  type AutoRunOn,
  type AutoSourceInput,
  type AutoWorkflow,
} from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import { getFactory, type FactoryState } from './FactoryPanel';
import { fmtBytes, useSourceUpload, VIDEO_EXTS, type SourceUploadState } from './useSourceUpload';

/**
 * New edit — a guided, one-question-per-screen flow (Jake 2026-10-08: "a consumer app like
 * onboarding process for each workflow"). It sends EXACTLY the payload the old form sent:
 * autoEditorCreate({ url, workflow, format, sponsored, script (cut only), title, sites (long
 * only), runOn }) — control.ts createJob validates the same fields.
 *
 * Steps: workflow → [source: creative only] → link | labedit | upload → format → sponsored →
 * [script: cut only] → [sites: long only] → review.
 * Creative edits may start from a Descript link, a finished Lab edit of workflow 1, or a file
 * uploaded from the computer (Jake 2026-10-08) — request.json "source", see control.ts.
 * The upload runs in the background while the remaining questions are answered; Start
 * waits for it.
 * Card answers advance on click; text steps advance on Enter (Ctrl/⌘+Enter in a textarea).
 * Sponsored is never pre-filled (Jake: "important you know if it's sponsored or not").
 */

// the server's own check (control.ts SHARE_RE)
const SHARE_RE = /^https:\/\/share\.descript\.com\/view\/[A-Za-z0-9_-]{6,64}\/?$/;

const LS = {
  hint: (wf: AutoWorkflow) => `autoEditor.hintSeen.${wf}`,
  format: 'autoEditor.lastFormat',
  runOn: 'autoEditor.lastRunOn',
};
const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* per-browser convenience only */
  }
};

const WORKFLOWS: {
  id: AutoWorkflow;
  icon: typeof Scissors;
  title: string;
  promise: string;
  gets: string[];
  hint: string[];
}[] = [
  {
    id: 'cut',
    icon: Scissors,
    title: 'Cut an unedited narration',
    promise: 'Drop in the raw recording. Get back a clean, frame-exact cut.',
    gets: ['Best take of every line', 'Junk and fillers cut', 'Sound check in minutes'],
    hint: [
      'Publish the RAW recording in Descript (download allowed) and paste its share link.',
      'Every word is transcribed and re-timed; Claude keeps the best take of each line and cuts crew talk, false starts and fillers.',
      'You review every removed sentence with its reason and restore anything in one click — then render the video and the 4K final.',
    ],
  },
  {
    id: 'creative',
    icon: Sparkles,
    title: 'Creative edit an edited narration',
    // (not "Nothing is cut": a Lab edit may itself be an automatic cut — the picker says so)
    promise: 'Already edited? No new cuts — it goes straight to the creative edit.',
    gets: ['Pre-production plan', 'Screencasts + graphics', 'The 4K final'],
    hint: [
      'Start from the narration you already edited: a Descript share link, a finished Lab edit, or a video file from your computer.',
      'It is transcribed and re-timed, the timeline is kept exactly as it is, then pre-production plans the visuals.',
      'Screencasts, graphics and music are added and you render the final.',
    ],
  },
];

/**
 * The third creative option (Jake 2026-10-09): the whole creative edit WITHOUT screencasts, as a hand-off package
 * for his editor (Premiere Pro / DaVinci Resolve), who records only the screencasts. It is workflow "creative" +
 * request.json "handoff" (control.ts → aieditor/handoff.py), long-form only.
 */
const HANDOFF_OPTION: (typeof WORKFLOWS)[number] = {
  id: 'creative',
  icon: Film,
  title: 'Graphics only — editor adds screencasts',
  promise: 'Everything except the screencasts, packed for your editor in Premiere Pro or DaVinci Resolve.',
  gets: ['A-roll + motion graphics', 'Premiere XML + FCPXML', 'A brief for every screencast'],
  hint: [
    'Start from the narration you already edited: a Descript share link, a finished Lab edit, or a video file.',
    'The edit is planned and built — camera moves, overlays, facecam bubble, music, sound effects — but no screen is recorded.',
    'You get one zip: timelines for Premiere and Resolve, every graphic with transparency, audio stems, a brief per screencast slot and a preview.',
  ],
};
const handoffPlanned = (stages: string[]) => [...stages.slice(0, 5), 'Plan the edit (no browser)', 'Render the overlays', 'Build the hand-off package'];

type SourceKind = 'descript' | 'job' | 'upload';

const SOURCE_STAGE: Record<SourceKind, string> = {
  descript: 'Download from Descript',
  job: 'Use the Lab edit',
  upload: 'Use the uploaded file',
};

/** The stages the worker will run — mirrors control.ts stagesFor(). */
function plannedStages(wf: AutoWorkflow, format: 'short' | 'long', source: SourceKind): string[] {
  const head = [SOURCE_STAGE[source], 'Extract audio', 'Transcribe', 'Re-time every word'];
  const mid = wf === 'cut' ? ['Pick the best takes', 'Build the cut', 'Sound check'] : ['Keep the edited timeline', 'Pre-production'];
  const tail =
    format === 'long'
      ? ['Render video preview', 'Screencasts + overlays', 'Compose the full edit']
      : ['Plan + render graphics', 'Render video preview', 'Composite graphics + captions'];
  return [...head, ...mid, ...tail];
}

type StepId = 'workflow' | 'source' | 'link' | 'labedit' | 'upload' | 'format' | 'sponsored' | 'script' | 'sites' | 'review';
const SUB_STEP: Record<SourceKind, StepId> = { descript: 'link', job: 'labedit', upload: 'upload' };

type LabPick = { edit: AutoLabEdit; video: AutoLabEdit['videos'][number] };

/**
 * control.ts REVIEW GATE (Jake 2026-10-09: "it also did cuts inside the narration that I
 * didn't ask for"): a Lab edit whose cut nobody reviewed is an "Unreviewed automatic cut" —
 * usable only with an explicit tick, and the words it removed are counted on screen.
 */
function isUnreviewed(v: AutoLabEdit['videos'][number] | undefined): boolean {
  return v?.review === 'unreviewed';
}

function removedText(v: AutoLabEdit['videos'][number]): string {
  return v.removedWords ? `${v.removedWords} spoken word${v.removedWords === 1 ? '' : 's'} removed` : 'words may have been removed';
}

function mmss(sec: number | null | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function dims(w: number | null, h: number | null): string {
  if (!w || !h) return '';
  const short = Math.min(w, h);
  return short >= 2160 ? `${w}×${h} (4K)` : `${w}×${h}`;
}
function dateOf(t: number | null): string {
  if (!t) return '';
  return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function BigChoice({
  selected,
  onClick,
  icon: Icon,
  title,
  sub,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: typeof Scissors;
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-all',
        selected ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground/40 hover:bg-muted/30',
      )}
    >
      {Icon && (
        <span
          className={cn(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            selected ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground group-hover:text-foreground',
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {sub && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{sub}</span>}
        {children}
      </span>
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
      >
        {selected && <Check className="h-3 w-3" />}
      </span>
    </button>
  );
}

function Question({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">{children}</h2>
      {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function NewEditFlow({ onCreated }: { onCreated: (id: string) => void }) {
  const [step, setStep] = useState<StepId>('workflow');
  const [workflow, setWorkflow] = useState<AutoWorkflow | null>(null);
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [format, setFormat] = useState<'short' | 'long' | null>(() => {
    const v = lsGet(LS.format);
    return v === 'short' || v === 'long' ? v : null;
  });
  const [sponsored, setSponsored] = useState<boolean | null>(null);
  const [script, setScript] = useState('');
  const [sites, setSites] = useState('');
  const [title, setTitle] = useState('');
  const [runOn, setRunOn] = useState<AutoRunOn>(() => {
    const v = lsGet(LS.runOn);
    return v === 'factory' || v === 'box' ? v : 'auto';
  });
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [factory, setFactory] = useState<FactoryState | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null); // nothing pre-selected
  const [labEdits, setLabEdits] = useState<AutoLabEdit[] | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [pick, setPick] = useState<LabPick | null>(null);
  const [allowUnreviewed, setAllowUnreviewed] = useState(false);
  const [handoff, setHandoff] = useState(false); // HANDOFF_OPTION picked
  const up = useSourceUpload();

  useEffect(() => {
    getFactory().then(setFactory).catch(() => setFactory(null));
  }, []);

  const creative = workflow === 'creative';
  // the cut workflow starts from a Descript link only
  const kind: SourceKind = creative ? (sourceKind ?? 'descript') : 'descript';
  const steps: StepId[] = useMemo(() => {
    const s: StepId[] = creative ? ['workflow', 'source', SUB_STEP[kind], 'format', 'sponsored'] : ['workflow', 'link', 'format', 'sponsored'];
    if (!creative) s.push('script');
    if (format === 'long') s.push('sites');
    s.push('review');
    return s;
  }, [creative, format, kind]);
  const idx = Math.max(0, steps.indexOf(step));
  const urlOk = SHARE_RE.test(url.trim());
  const uploadDone = up.state.status === 'done' && !!up.state.uploadId;
  const pickOk = !!pick && (!isUnreviewed(pick.video) || allowUnreviewed);
  const sourceOk = kind === 'descript' ? urlOk : kind === 'job' ? pickOk : uploadDone;

  // the Lab edits, loaded once when that screen is first opened
  useEffect(() => {
    if (step !== 'labedit' || labEdits) return;
    autoEditorLabEdits({})
      .then((r) => setLabEdits(r.edits))
      .catch((e) => setLabError(e instanceof Error ? e.message : String(e)));
  }, [step, labEdits]);

  const canNext: Record<StepId, boolean> = {
    workflow: !!workflow,
    source: true,
    link: urlOk,
    labedit: pickOk,
    // the questions after it can be answered while the file uploads
    upload: up.state.status === 'uploading' || uploadDone,
    format: !!format,
    sponsored: sponsored !== null,
    script: true,
    sites: true,
    review: !!(workflow && sourceOk && format && sponsored !== null),
  };

  const go = (to: StepId) => setStep(to);
  const next = () => {
    if (!canNext[step]) {
      if (step === 'link') setTouched(true);
      return;
    }
    const n = steps[idx + 1];
    if (n) go(n);
  };
  const back = () => {
    const p = steps[idx - 1];
    if (p) go(p);
  };

  const pickWorkflow = (wf: AutoWorkflow) => {
    setWorkflow(wf);
    // shown once per browser: marked seen the moment it is shown
    const first = lsGet(LS.hint(wf)) !== '1';
    setHintOpen(first);
    if (first) lsSet(LS.hint(wf), '1');
    go(wf === 'creative' ? 'source' : 'link');
  };
  const pickSource = (k: SourceKind) => {
    setSourceKind(k);
    setHintOpen(false);
    go(SUB_STEP[k]);
  };
  const pickLabVideo = (edit: AutoLabEdit, video: AutoLabEdit['videos'][number]) => {
    setPick({ edit, video });
    setAllowUnreviewed(false);
    // a Shorts edit stays 9:16, a long-form one 16:9
    if (edit.format === 'short' || edit.format === 'long') setFormat(edit.format);
    // an unreviewed automatic cut stays on this screen: Jake decides with the tick below
    if (!isUnreviewed(video)) go('format');
  };
  const dismissHint = () => {
    if (workflow) lsSet(LS.hint(workflow), '1');
    setHintOpen(false);
  };

  const submit = async () => {
    if (!workflow || !format || sponsored === null || !sourceOk) return;
    const source: AutoSourceInput | undefined =
      kind === 'job' && pick
        ? { kind: 'job', job: pick.edit.id, file: pick.video.file }
        : kind === 'upload' && up.state.uploadId
          ? { kind: 'upload', upload: up.state.uploadId }
          : undefined;
    setBusy(true);
    try {
      const r = await autoEditorCreate({
        url: kind === 'descript' ? url.trim() : undefined,
        source,
        workflow,
        format,
        sponsored,
        script: creative ? undefined : script,
        title: title.trim() || undefined,
        sites: format === 'long' ? sites : undefined,
        runOn,
        allowUnreviewed: kind === 'job' && isUnreviewed(pick?.video) ? allowUnreviewed : undefined,
        handoff: handoff && creative ? true : undefined,
      });
      lsSet(LS.format, format);
      lsSet(LS.runOn, runOn);
      if (workflow) lsSet(LS.hint(workflow), '1');
      if (kind === 'upload') up.consumed();
      toast.success('Started — the worker picks it up in a few seconds.');
      onCreated(r.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Enter continues (Ctrl/⌘+Enter inside a textarea; Enter on the review screen starts)
  const root = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const inTextarea = (e.target as HTMLElement).tagName === 'TEXTAREA';
    if (inTextarea && !(e.metaKey || e.ctrlKey)) return;
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    if (step === 'review') void submit();
    else if (step !== 'source') next();
  };
  // focus the step's field so Enter works straight away
  useEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('[data-autofocus]');
    el?.focus();
  }, [step]);

  // ── estimate from the factory's own numbers ──
  const runs = (factory?.history ?? []).filter((r) => r.action === 'run' && r.ok);
  const medMin = median(runs.map((r) => Number(r.minutes)));
  const medUsd = median(runs.map((r) => Number(r.usd)));
  const factoryOn = !!factory?.settings.enabled;
  const size = factory?.sizes.find((z) => z.id === factory.settings.size);
  const resolvedRunOn =
    runOn === 'box' ? 'Main box' : runOn === 'factory' || factoryOn ? `Factory server${size ? ` (${size.id}, ${size.vcpu} vCPU)` : ''}` : 'Main box';
  const onFactory = runOn === 'factory' || (runOn === 'auto' && factoryOn);

  const wfDef = handoff && workflow === 'creative' ? HANDOFF_OPTION : WORKFLOWS.find((w) => w.id === workflow);
  const total = steps.length;

  return (
    <div ref={root} onKeyDown={onKeyDown} className="mx-auto w-full max-w-xl">
      {/* progress */}
      <div className="mb-6 space-y-2">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{step === 'workflow' ? 'New edit' : wfDef?.title}</span>
          <span className="tabular-nums">
            {idx + 1} / {total}
          </span>
        </div>
        <div className="flex gap-1">
          {steps.map((s, k) => (
            <div key={s} className={cn('h-1 flex-1 rounded-full transition-colors', k <= idx ? 'bg-primary' : 'bg-muted')} />
          ))}
        </div>
      </div>

      <div className="space-y-5">
        {step === 'workflow' && (
          <>
            <Question sub="Pick what you're starting from.">What are we editing today?</Question>
            <div className="grid gap-3">
              {WORKFLOWS.map((w) => (
                <BigChoice key={w.id} selected={workflow === w.id && !handoff} onClick={() => { setHandoff(false); pickWorkflow(w.id); }} icon={w.icon} title={w.title} sub={w.promise}>
                  <span className="mt-2.5 flex flex-wrap gap-1.5">
                    {w.gets.map((g) => (
                      <span key={g} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {g}
                      </span>
                    ))}
                  </span>
                </BigChoice>
              ))}
              <BigChoice
                selected={handoff && workflow === 'creative'}
                onClick={() => {
                  pickWorkflow('creative');
                  setHandoff(true);
                  setFormat('long'); // the hand-off is long-form only
                }}
                icon={HANDOFF_OPTION.icon}
                title={HANDOFF_OPTION.title}
                sub={HANDOFF_OPTION.promise}
              >
                <span className="mt-2.5 flex flex-wrap gap-1.5">
                  {HANDOFF_OPTION.gets.map((g) => (
                    <span key={g} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {g}
                    </span>
                  ))}
                </span>
              </BigChoice>
            </div>
          </>
        )}

        {(step === 'link' || step === 'source') && hintOpen && wfDef && (step === 'source' || !creative) && (
          <div className="relative rounded-xl border border-primary/30 bg-primary/5 p-4 pr-9">
            <button
              type="button"
              onClick={dismissHint}
              className="absolute right-2.5 top-2.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <p className="mb-2 text-xs font-medium text-foreground">How this works</p>
            <ol className="space-y-1.5">
              {wfDef.hint.map((h, k) => (
                <li key={k} className="flex gap-2 text-xs leading-snug text-muted-foreground">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] text-primary">
                    {k + 1}
                  </span>
                  {h}
                </li>
              ))}
            </ol>
            <button type="button" onClick={dismissHint} className="mt-3 text-xs text-primary hover:underline">
              Got it
            </button>
          </div>
        )}

        {step === 'source' && (
          <>
            <Question sub="The narration you already edited.">Where is the video?</Question>
            <div className="grid gap-3">
              <BigChoice
                selected={sourceKind === 'descript'}
                onClick={() => pickSource('descript')}
                icon={Link2}
                title="Descript share link"
                sub="Published from Descript with download allowed."
              />
              <BigChoice
                selected={sourceKind === 'job'}
                onClick={() => pickSource('job')}
                icon={Film}
                title="A finished Lab edit"
                sub="A video made here with “Cut an unedited narration”."
              />
              <BigChoice
                selected={sourceKind === 'upload'}
                onClick={() => pickSource('upload')}
                icon={Upload}
                title="Upload from your computer"
                sub={`${VIDEO_EXTS.join(' ').replace(/\./g, '').toUpperCase()} · up to 20 GB · keeps uploading while you answer the rest`}
              />
            </div>
          </>
        )}

        {step === 'labedit' && (
          <>
            <Question sub="The full-resolution final is used when there is one.">Which Lab edit?</Question>
            <LabEditPicker edits={labEdits} error={labError} pick={pick} onPick={pickLabVideo} />
            {pick && isUnreviewed(pick.video) && (
              <div className="space-y-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm">
                <p className="font-medium text-red-300">Unreviewed automatic cut — {removedText(pick.video)}</p>
                <p className="text-xs text-muted-foreground">
                  Nobody has reviewed this cut: the words Claude removed (fillers, “So”, asides, whole sentences) are
                  gone from the narration the creative edit starts from. Review it in the Lab first, or use it anyway.
                </p>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={allowUnreviewed}
                    onChange={(e) => setAllowUnreviewed(e.target.checked)}
                    className="h-4 w-4 accent-red-400"
                  />
                  Use it anyway — I accept the removed words
                </label>
              </div>
            )}
          </>
        )}

        {step === 'upload' && (
          <>
            <Question sub="The edited narration, straight from your computer.">Upload the video</Question>
            <UploadBox
              state={up.state}
              onFile={(f) => void up.start(f)}
              onCancel={up.cancel}
              onRetry={up.canRetry ? up.retry : undefined}
            />
          </>
        )}

        {step === 'link' && (
          <>
            <Question sub={creative ? 'The narration you already edited, published from Descript.' : 'The RAW recording, published from Descript with download allowed.'}>
              Paste the Descript share link
            </Question>
            <div className="space-y-1.5">
              <Input
                data-autofocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="https://share.descript.com/view/…"
                className={cn('h-11 text-sm', touched && url.trim() && !urlOk && 'border-red-500/60 focus-visible:ring-red-500/40')}
              />
              {url.trim() && urlOk ? (
                <p className="flex items-center gap-1 text-xs text-green-400">
                  <Check className="h-3.5 w-3.5" /> Looks good
                </p>
              ) : touched && url.trim() ? (
                <p className="text-xs text-red-400">That isn't a Descript share link — it looks like https://share.descript.com/view/AbC123xyz</p>
              ) : null}
            </div>
          </>
        )}

        {step === 'format' && (
          <>
            <Question>What are you making?</Question>
            <div className="grid gap-3 sm:grid-cols-2">
              <BigChoice
                selected={format === 'short'}
                onClick={() => {
                  setFormat('short');
                  go('sponsored');
                }}
                icon={RectangleVertical}
                title="Shorts"
                sub="9:16 · one recording can hold several shorts"
              />
              <BigChoice
                selected={format === 'long'}
                onClick={() => {
                  setFormat('long');
                  go('sponsored');
                }}
                icon={RectangleHorizontal}
                title="Long-form"
                sub="16:9 · with screencasts of the sites you mention"
              />
            </div>
          </>
        )}

        {step === 'sponsored' && (
          <>
            <Question sub="It decides whether lines that repeat a point may be cut.">Is this video sponsored?</Question>
            <div className="grid gap-3 sm:grid-cols-2">
              <BigChoice
                selected={sponsored === true}
                onClick={() => {
                  setSponsored(true);
                  go(steps[idx + 1]);
                }}
                title="Sponsored"
                sub="Every good line stays — only retakes, slips, crew talk and fillers go."
              />
              <BigChoice
                selected={sponsored === false}
                onClick={() => {
                  setSponsored(false);
                  go(steps[idx + 1]);
                }}
                title="Not sponsored"
                sub="Retakes and junk go, and lines that only repeat a point may go too."
              />
            </div>
          </>
        )}

        {step === 'script' && (
          <>
            <Question sub="Optional — it helps match takes to lines. Skip if you don't have it.">Got the script?</Question>
            <Textarea
              data-autofocus
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={8}
              className="text-sm"
              placeholder="Paste the script here…"
            />
          </>
        )}

        {step === 'sites' && (
          <>
            <Question sub="Optional — the editor records these itself, timed to what you say. Public pages only, one per line.">
              Which websites should it screencast?
            </Question>
            <Textarea
              data-autofocus
              value={sites}
              onChange={(e) => setSites(e.target.value)}
              rows={4}
              className="text-sm"
              placeholder={'linearity.io — the tool this video is about'}
            />
          </>
        )}

        {step === 'review' && workflow && format && sponsored !== null && (
          <>
            <Question>Here's what will happen</Question>
            <div className="divide-y divide-border rounded-xl border border-border text-sm">
              {(
                [
                  ['Workflow', wfDef?.title ?? '', 'workflow'],
                  sourceRow(kind, url, pick, up.state),
                  ['Format', format === 'short' ? 'Shorts (9:16)' : 'Long-form (16:9)', 'format'],
                  ['Sponsored', sponsored ? 'Sponsored' : 'Not sponsored', 'sponsored'],
                  ...(!creative ? [['Script', script.trim() ? `${script.trim().split(/\s+/).length} words` : 'None', 'script']] : []),
                  ...(format === 'long'
                    ? [['Screencasts', sites.trim() ? `${sites.trim().split('\n').filter(Boolean).length} site(s)` : 'None', 'sites']]
                    : []),
                ] as [string, string, StepId][]
              ).map(([k, v, s]) => (
                <button key={k} type="button" onClick={() => go(s)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-muted/30">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{k}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{v}</span>
                  <span className="text-[11px] text-primary">Edit</span>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">It runs these steps, live on the next screen</p>
              <ol className="flex flex-wrap gap-1.5">
                {(handoff && creative ? handoffPlanned(plannedStages(workflow, format, kind)) : plannedStages(workflow, format, kind)).map((s, k) => (
                  <li key={s} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                    {k + 1}. {s}
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted-foreground">
                {onFactory && medMin !== null
                  ? `Typically ~${Math.round(medMin)} min on a factory server (~$${(medUsd ?? 0).toFixed(2)}, last ${runs.length} run${runs.length === 1 ? '' : 's'})`
                  : 'Roughly 10 min per 15 min of recording on the main box'}
                {' '}+ AI calls (about 2¢ per recorded minute). Exact time and cost show live.
              </p>
            </div>

            <div className="rounded-xl border border-border">
              <button
                type="button"
                onClick={() => setMore(!more)}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                {more ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                More options
                <span className="ml-auto truncate">
                  {title.trim() ? `${title.trim()} · ` : ''}
                  {resolvedRunOn}
                </span>
              </button>
              {more && (
                <div className="space-y-3 border-t border-border px-3.5 py-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-muted-foreground">Name (optional)</label>
                    <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Cowork tutorial" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-muted-foreground">Run on</label>
                    <div className="flex gap-1.5">
                      {(
                        [
                          ['auto', 'Auto'],
                          ['factory', 'Factory server'],
                          ['box', 'Main box'],
                        ] as [AutoRunOn, string][]
                      ).map(([v, l]) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setRunOn(v)}
                          className={cn(
                            'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
                            runOn === v ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/40',
                          )}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {runOn === 'auto'
                        ? `A factory server when the Video factory is on (it is ${factoryOn ? 'on' : 'off'}), else the main box.`
                        : runOn === 'factory'
                          ? 'Its own server even while the factory is off — deleted when the job ends.'
                          : 'Never leaves the main box (slower, no server cost).'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <Button size="lg" className="h-12 w-full gap-2 text-base" disabled={busy || !canNext.review} onClick={() => void submit()}>
              {busy || (kind === 'upload' && up.state.status === 'uploading') ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : creative ? (
                <Film className="h-5 w-5" />
              ) : (
                <Scissors className="h-5 w-5" />
              )}
              {kind === 'upload' && up.state.status === 'uploading'
                ? `Waiting for the upload… ${pct(up.state)}%`
                : creative
                  ? 'Start the creative edit'
                  : 'Start cutting'}
            </Button>
            {kind === 'upload' && up.state.status !== 'uploading' && !uploadDone && (
              <p className="text-center text-xs text-red-400">The upload did not finish — open “Source” above to retry.</p>
            )}
          </>
        )}
      </div>

      {/* nav */}
      {step !== 'workflow' && (
        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={back}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step !== 'review' && step !== 'source' && (
            <div className="flex items-center gap-3">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                {step === 'script' || step === 'sites' ? 'Ctrl + Enter ↵' : 'Enter ↵'}
              </span>
              <Button
                size="sm"
                className="gap-1.5"
                variant={(step === 'script' && !script.trim()) || (step === 'sites' && !sites.trim()) ? 'secondary' : 'default'}
                disabled={!canNext[step]}
                onClick={next}
              >
                {(step === 'script' && !script.trim()) || (step === 'sites' && !sites.trim()) ? 'Skip' : 'Continue'}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function pct(s: SourceUploadState): number {
  return s.size ? Math.floor((s.received / s.size) * 100) : 0;
}

/** The review screen's source row: [label, value, step to edit it]. */
function sourceRow(kind: SourceKind, url: string, pick: LabPick | null, up: SourceUploadState): [string, string, StepId] {
  if (kind === 'job') {
    const v = pick?.video;
    const value = pick && v
      ? `Lab edit: ${pick.edit.title} · ${v.file}${v.width ? ` · ${v.width}×${v.height}` : ''} · ${mmss(v.duration)}${v.quality === 'preview' ? ' (preview quality)' : ''}${isUnreviewed(v) ? ` · UNREVIEWED automatic cut (${removedText(v)})` : ''}`
      : 'Choose a Lab edit';
    return ['Source', value, 'labedit'];
  }
  if (kind === 'upload') {
    const value = up.status === 'done'
      ? `Uploaded: ${up.name} · ${fmtBytes(up.size)}`
      : up.status === 'uploading'
        ? `Uploading ${up.name} — ${pct(up)}%`
        : up.name ? `${up.name} — not uploaded` : 'Choose a file';
    return ['Source', value, 'upload'];
  }
  return ['Recording', url.trim().replace('https://', ''), 'link'];
}

function LabEditPicker({
  edits,
  error,
  pick,
  onPick,
}: {
  edits: AutoLabEdit[] | null;
  error: string | null;
  pick: LabPick | null;
  onPick: (edit: AutoLabEdit, video: AutoLabEdit['videos'][number]) => void;
}) {
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!edits) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your edits…
      </p>
    );
  }
  if (!edits.length) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        No finished Lab edits yet — make one with “Cut an unedited narration” first, or go back and choose another source.
      </p>
    );
  }
  return (
    <div className="max-h-[26rem] space-y-3 overflow-y-auto pr-1">
      {edits.map((e) => (
        <div key={e.id} className="space-y-1.5">
          {e.videos.length > 1 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{e.title}</span> · {e.videos.length} videos · {dateOf(e.createdAt)}
            </p>
          )}
          {e.videos.map((v) => {
            const selected = pick?.edit.id === e.id && pick.video.file === v.file;
            const vertical = (v.height ?? 0) > (v.width ?? 0);
            return (
              <button
                key={v.file}
                type="button"
                onClick={() => onPick(e, v)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-all',
                  selected ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground/40 hover:bg-muted/30',
                )}
              >
                <span
                  className={cn(
                    'flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted',
                    vertical ? 'h-16 w-9' : 'h-12 w-20 sm:h-14 sm:w-24',
                  )}
                >
                  <video
                    src={`/api/aieditor/files/${e.id}/${v.file}#t=2`}
                    preload="metadata"
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {e.videos.length > 1 ? v.title || `Video ${v.k}` : e.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {[e.videos.length > 1 ? null : dateOf(e.createdAt), mmss(v.duration), dims(v.width, v.height), v.file]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {v.quality === 'preview' && (
                    <span className="mt-1 inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">
                      preview quality (1080p) — no final rendered yet
                    </span>
                  )}
                  {isUnreviewed(v) ? (
                    <span className="ml-1 mt-1 inline-block rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-300">
                      {v.reviewLabel || 'Unreviewed automatic cut'} · {removedText(v)}
                    </span>
                  ) : v.review && v.review !== 'final' ? (
                    <span className="ml-1 mt-1 inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                      {v.reviewLabel}
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                >
                  {selected && <Check className="h-3 w-3" />}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function UploadBox({
  state,
  onFile,
  onCancel,
  onRetry,
}: {
  state: SourceUploadState;
  onFile: (f: File) => void;
  onCancel: () => void;
  onRetry?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const choose = () => input.current?.click();
  const fileInput = (
    <input
      ref={input}
      type="file"
      accept={`video/*,${VIDEO_EXTS.join(',')}`}
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onFile(f);
        e.target.value = '';
      }}
    />
  );

  if (state.status === 'uploading' || state.status === 'done') {
    const p = pct(state);
    const eta = state.etaSec;
    return (
      <div className="space-y-3 rounded-xl border border-border p-4">
        {fileInput}
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              state.status === 'done' ? 'bg-green-500/15 text-green-400' : 'bg-primary/15 text-primary',
            )}
          >
            {state.status === 'done' ? <Check className="h-[18px] w-[18px]" /> : <Upload className="h-[18px] w-[18px]" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{state.name}</p>
            <p className="text-xs text-muted-foreground">
              {state.status === 'done'
                ? `Uploaded · ${fmtBytes(state.size)}`
                : `${fmtBytes(state.received)} of ${fmtBytes(state.size)}`}
            </p>
          </div>
          <span className="text-sm font-medium tabular-nums text-foreground">{p}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-[width] duration-300', state.status === 'done' ? 'bg-green-500' : 'bg-primary')}
            style={{ width: `${p}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {state.status === 'done'
              ? 'Ready — continue with the next questions.'
              : state.retry
                ? `Connection hiccup — retrying (${state.retry} of 3)…`
                : [
                    state.rate ? `${(state.rate / 1024 ** 2).toFixed(1)} MB/s` : 'Starting…',
                    eta !== null && state.rate ? `${fmtEta(eta)} left` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
          </span>
          <span className="flex gap-3">
            {state.status === 'done' && (
              <button type="button" onClick={choose} className="text-primary hover:underline">
                Choose another file
              </button>
            )}
            <button type="button" onClick={onCancel} className="hover:text-foreground hover:underline">
              {state.status === 'done' ? 'Remove' : 'Cancel'}
            </button>
          </span>
        </div>
        {state.status === 'uploading' && (
          <p className="text-[11px] text-muted-foreground">You can continue with the next questions — keep this tab open.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {fileInput}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={choose}
        role="button"
        tabIndex={0}
        data-autofocus
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            choose();
          }
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors',
          over ? 'border-primary bg-primary/10' : 'border-border hover:border-muted-foreground/50 hover:bg-muted/20',
        )}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Upload className="h-5 w-5" />
        </span>
        <p className="text-sm text-foreground">
          Drop the video here or <span className="text-primary underline-offset-2 hover:underline">choose a file</span>
        </p>
        <p className="text-xs text-muted-foreground">MP4, MOV, M4V, MKV or WebM · up to 20 GB</p>
      </div>
      {state.status === 'interrupted' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <span className="text-amber-200">
            {state.name} stopped at {pct(state)}% — choose the same file to continue where it left off.
          </span>
          <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground hover:underline">
            Discard
          </button>
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
          <span className="text-red-300">
            {state.name ? `${state.name}: ` : ''}
            {state.error}
          </span>
          {state.uploadId && onRetry ? (
            <button type="button" onClick={onRetry} className="text-primary hover:underline">
              Retry
            </button>
          ) : state.uploadId ? (
            <span className="text-muted-foreground">Choose the same file again to continue.</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function fmtEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
