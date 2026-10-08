import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Film,
  Loader2,
  RectangleHorizontal,
  RectangleVertical,
  Scissors,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { autoEditorCreate, type AutoRunOn, type AutoWorkflow } from 'zite-endpoints-sdk';
import { cn } from '@/lib/utils';
import { getFactory, type FactoryState } from './FactoryPanel';

/**
 * New edit — a guided, one-question-per-screen flow (Jake 2026-10-08: "a consumer app like
 * onboarding process for each workflow"). It sends EXACTLY the payload the old form sent:
 * autoEditorCreate({ url, workflow, format, sponsored, script (cut only), title, sites (long
 * only), runOn }) — control.ts createJob validates the same fields.
 *
 * Steps: workflow → link → format → sponsored → [script: cut only] → [sites: long only] → review.
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
    promise: 'Already edited? Nothing is cut — it goes straight to the creative edit.',
    gets: ['Pre-production plan', 'Screencasts + graphics', 'The 4K final'],
    hint: [
      'Paste the share link of the narration you already edited in Descript.',
      'It is transcribed and re-timed, the timeline is kept exactly as it is, then pre-production plans the visuals.',
      'Screencasts, graphics and music are added and you render the final.',
    ],
  },
];

/** The stages the worker will run — mirrors control.ts stagesFor(). */
function plannedStages(wf: AutoWorkflow, format: 'short' | 'long'): string[] {
  const head = ['Download from Descript', 'Extract audio', 'Transcribe', 'Re-time every word'];
  const mid = wf === 'cut' ? ['Pick the best takes', 'Build the cut', 'Sound check'] : ['Keep the edited timeline', 'Pre-production'];
  const tail =
    format === 'long'
      ? ['Render video preview', 'Screencasts + overlays', 'Compose the full edit']
      : ['Plan + render graphics', 'Render video preview', 'Composite graphics + captions'];
  return [...head, ...mid, ...tail];
}

type StepId = 'workflow' | 'link' | 'format' | 'sponsored' | 'script' | 'sites' | 'review';

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

  useEffect(() => {
    getFactory().then(setFactory).catch(() => setFactory(null));
  }, []);

  const creative = workflow === 'creative';
  const steps: StepId[] = useMemo(() => {
    const s: StepId[] = ['workflow', 'link', 'format', 'sponsored'];
    if (!creative) s.push('script');
    if (format === 'long') s.push('sites');
    s.push('review');
    return s;
  }, [creative, format]);
  const idx = Math.max(0, steps.indexOf(step));
  const urlOk = SHARE_RE.test(url.trim());

  const canNext: Record<StepId, boolean> = {
    workflow: !!workflow,
    link: urlOk,
    format: !!format,
    sponsored: sponsored !== null,
    script: true,
    sites: true,
    review: !!(workflow && urlOk && format && sponsored !== null),
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
    go('link');
  };
  const dismissHint = () => {
    if (workflow) lsSet(LS.hint(workflow), '1');
    setHintOpen(false);
  };

  const submit = async () => {
    if (!workflow || !format || sponsored === null || !urlOk) return;
    setBusy(true);
    try {
      const r = await autoEditorCreate({
        url: url.trim(),
        workflow,
        format,
        sponsored,
        script: creative ? undefined : script,
        title: title.trim() || undefined,
        sites: format === 'long' ? sites : undefined,
        runOn,
      });
      lsSet(LS.format, format);
      lsSet(LS.runOn, runOn);
      if (workflow) lsSet(LS.hint(workflow), '1');
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
    else next();
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

  const wfDef = WORKFLOWS.find((w) => w.id === workflow);
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
                <BigChoice key={w.id} selected={workflow === w.id} onClick={() => pickWorkflow(w.id)} icon={w.icon} title={w.title} sub={w.promise}>
                  <span className="mt-2.5 flex flex-wrap gap-1.5">
                    {w.gets.map((g) => (
                      <span key={g} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {g}
                      </span>
                    ))}
                  </span>
                </BigChoice>
              ))}
            </div>
          </>
        )}

        {step === 'link' && (
          <>
            {hintOpen && wfDef && (
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
                  ['Recording', url.trim().replace('https://', ''), 'link'],
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
                {plannedStages(workflow, format).map((s, k) => (
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
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : creative ? <Film className="h-5 w-5" /> : <Scissors className="h-5 w-5" />}
              {creative ? 'Start the creative edit' : 'Start cutting'}
            </Button>
          </>
        )}
      </div>

      {/* nav */}
      {step !== 'workflow' && (
        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={back}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step !== 'review' && (
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
