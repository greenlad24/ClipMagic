/**
 * UX Scout findings for ONE script run, in a fixed panel that slides in from
 * the right (Jake 2026-10-02): the report the script was built on, and every
 * step of the test — each screenshot with what the Scout did to get there and
 * what it said about it.
 *
 * Built from the job's event log (scout_events): an `action` is followed by the
 * `shot` it produced; `note`s are the Scout's running commentary and belong to
 * the screenshot it had just taken; a `key_shot` marks a screenshot as one the
 * report cites (K1, K2…).
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ClipboardList, ExternalLink, Image as ImageIcon, Loader2, MessageSquareText, MousePointerClick, PanelRightClose, PanelRightOpen, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/deals/ui/markdown';
import { getJob, listJobs, type ScoutEvent, type ScoutJobView } from './api';

/** The Scout's browser viewport — click coordinates are in these pixels. */
const VIEW_W = 1280;
const VIEW_H = 900;

export interface ScoutStep {
  seq: number;
  at: string;
  file: string;
  url: string | null;
  title: string;
  actions: string[];
  click: { x: number; y: number } | null;
  notes: string[];
  keyCaption: string | null;
  keyNo: number | null;
}

/** "Click at 68,108 — OK" → plain words, and the click point when there is one. */
export function describeAction(raw: string): { text: string; click: { x: number; y: number } | null } {
  const [head, result = ''] = raw.split(/\s+—\s+/, 2);
  const at = /(?:^Click at|at)\s+(\d+),(\d+)/.exec(raw);
  const click = at ? { x: Number(at[1]), y: Number(at[2]) } : null;
  const failed = result && !/^(?:OK|Clicked|Waited|Zoomed|Typed|Opened)/i.test(result) ? ` (${result})` : '';
  let text = head;
  if (/^Click (?:at|ref_)/.test(head)) text = 'Clicked here';
  else if (/^Hover/.test(head)) text = 'Hovered here';
  else if (/^Type /.test(head)) text = `Typed ${head.slice(5)}`;
  else if (/^Press /.test(head)) text = `Pressed ${head.slice(6)}`;
  else if (/^Wait /.test(head)) text = `Waited ${head.slice(5)}`;
  else if (/^Scroll /.test(head)) text = `Scrolled ${head.slice(7)}`;
  else if (/^Open /.test(head)) text = `Opened ${head.slice(5)}`;
  else if (head === 'Screenshot') text = 'Looked at the screen';
  else if (head === 'Read the page') text = "Read the page's text";
  else if (head === 'Zoom') text = 'Zoomed in for a closer look';
  else if (head === 'Text') text = 'Read the text on screen';
  return { text: text + failed, click };
}

/** Events → one step per screenshot. */
export function buildSteps(events: ScoutEvent[], keyFiles: string[]): ScoutStep[] {
  const steps: ScoutStep[] = [];
  let pending: string[] = [];
  let click: ScoutStep['click'] = null;
  const intro: string[] = [];
  for (const e of events) {
    if (e.kind === 'action') {
      const d = describeAction(e.text);
      pending.push(d.text);
      if (d.click) click = d.click;
    } else if (e.kind === 'shot' && e.file) {
      steps.push({ seq: e.seq, at: e.at, file: e.file, url: e.url, title: e.text, actions: pending, click, notes: [], keyCaption: null, keyNo: null });
      pending = [];
      click = null;
    } else if (e.kind === 'key_shot' && e.file) {
      const s = [...steps].reverse().find((x) => x.file === e.file);
      if (s) {
        s.keyCaption = e.text;
        const k = keyFiles.indexOf(e.file);
        s.keyNo = k === -1 ? null : k + 1;
      }
    } else if (e.kind === 'note' || e.kind === 'error') {
      const text = e.kind === 'error' ? `Problem: ${e.text}` : e.text;
      if (steps.length) steps[steps.length - 1].notes.push(text);
      else intro.push(text);
    }
  }
  if (intro.length && steps.length) steps[0].notes.unshift(...intro);
  return steps;
}

async function loadAll(jobId: string): Promise<{ view: ScoutJobView; events: ScoutEvent[] }> {
  let view = await getJob(jobId, 0);
  const events = [...view.events];
  // The route pages at 400 events; a long test has more.
  while (view.events.length >= 400) {
    view = await getJob(jobId, events[events.length - 1].seq);
    events.push(...view.events);
  }
  return { view, events };
}

function ShotCard({ step, index }: { step: ScoutStep; index: number }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Only a full-viewport shot can carry the click marker (a zoom is a crop).
  const showClick = step.click && natural && natural.w === VIEW_W && natural.h === VIEW_H;
  return (
    <li className={`rounded-lg border p-3 ${step.keyNo ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">Step {index + 1}</span>
        {step.keyNo && (
          <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
            <Star className="h-3 w-3" /> K{step.keyNo}
          </span>
        )}
        <span className="truncate text-muted-foreground" title={step.title}>{step.title}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      </div>
      {step.url && (
        <a href={step.url} target="_blank" rel="noopener noreferrer" className="relative mb-2 block overflow-hidden rounded-md border border-border bg-muted" title="Open full size">
          <img
            src={step.url}
            alt={step.keyCaption ?? step.title}
            loading="lazy"
            className="block h-auto w-full"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {showClick && (
            <span
              className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-red-500 bg-red-500/30 shadow-[0_0_0_3px_rgba(255,255,255,0.7)]"
              style={{ left: `${(step.click!.x / VIEW_W) * 100}%`, top: `${(step.click!.y / VIEW_H) * 100}%` }}
            />
          )}
        </a>
      )}
      {step.actions.length > 0 && (
        <ul className="space-y-0.5 text-sm text-foreground">
          {step.actions.map((a, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="break-words">{a}</span>
            </li>
          ))}
        </ul>
      )}
      {step.keyCaption && <p className="mb-2 text-xs font-medium text-primary">{step.keyCaption}</p>}
      {step.notes.map((n, i) => (
        <p key={i} className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-xs leading-relaxed text-foreground">
          <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="whitespace-pre-wrap break-words">{n}</span>
        </p>
      ))}
    </li>
  );
}

const MD =
  'text-sm leading-relaxed text-foreground [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mb-1.5 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold ' +
  '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 ' +
  '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-xs [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-1.5 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:p-1.5 [&_td]:align-top [&_a]:text-primary [&_a]:underline';

/** Width of the open drawer. It opens OVER the page (Jake 2026-10-02: "on top of the UI, not pushing it"). */
export const UX_DRAWER_WIDTH = 520;
const OPEN_KEY = 'scriptgen.uxDrawerOpen';

export default function UxFindingsDrawer({
  runId,
  jobId,
}: {
  runId: string;
  jobId?: string | null;
}) {
  // Open or minimized, remembered across scripts and visits.
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      /* private mode */
    }
  };
  const [tab, setTab] = useState<'findings' | 'steps'>('steps');
  const [keyOnly, setKeyOnly] = useState(false);
  const [resolvedJob, setResolvedJob] = useState<string | null>(jobId ?? null);
  const [data, setData] = useState<{ view: ScoutJobView; events: ScoutEvent[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which test belongs to this script: the one attached to the run, else the
  // newest finished one started from it.
  useEffect(() => {
    setData(null);
    setError(null);
    if (jobId) {
      setResolvedJob(jobId);
      return;
    }
    setResolvedJob(null);
    let cancelled = false;
    listJobs(runId)
      .then((r) => {
        if (cancelled) return;
        const done = r.jobs.filter((j) => j.status === 'done').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
        setResolvedJob(done[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId, jobId]);

  useEffect(() => {
    if (!open || !resolvedJob || data) return;
    let cancelled = false;
    setLoading(true);
    loadAll(resolvedJob)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load the UX test'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, resolvedJob, data]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const steps = useMemo(
    () => (data ? buildSteps(data.events, data.view.job.keyShots.map((k) => k.file)) : []),
    [data],
  );
  const shown = keyOnly ? steps.filter((s) => s.keyNo || s.notes.length) : steps;

  if (!resolvedJob) return null;
  const job = data?.view.job;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-0 top-24 z-40 flex items-center gap-2 rounded-l-lg border border-r-0 border-border bg-card px-2 py-4 text-xs font-semibold text-foreground shadow-lg hover:bg-muted [writing-mode:vertical-rl]"
          title="Open the UX test this script was built on"
        >
          <PanelRightOpen className="h-4 w-4 rotate-90" /> UX test findings
        </button>
      )}
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'pointer-events-none translate-x-full'}`}
        style={{ maxWidth: UX_DRAWER_WIDTH }}
        aria-hidden={!open}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ClipboardList className="h-4 w-4 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">UX test findings</p>
            <p className="truncate text-xs text-muted-foreground">
              {data ? `${data.view.tool?.name ?? job?.toolSlug} · ${steps.length} screenshots · ${job?.finishedAt ? new Date(job.finishedAt).toLocaleString() : job?.status}` : 'For this script only'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="Minimize" title="Minimize (Esc)">
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1 border-b border-border px-4 py-2">
          {(['steps', 'findings'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {t === 'findings' ? 'Findings' : `Steps & screenshots${steps.length ? ` (${steps.length})` : ''}`}
            </button>
          ))}
          {tab === 'steps' && (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={keyOnly} onChange={(e) => setKeyOnly(e.target.checked)} />
              Key moments only
            </label>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the test…
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data && tab === 'findings' && (
            <div>
              <div className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                <p><span className="font-medium text-foreground">Goal:</span> {job?.goal}</p>
                {job?.summary && <p className="mt-1"><span className="font-medium text-foreground">In short:</span> {job.summary}</p>}
              </div>
              {job && job.keyShots.length > 0 && (
                <>
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground"><ImageIcon className="h-4 w-4" /> Key screenshots</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {job.keyShots.map((k, i) => (
                      <a key={k.file} href={k.url ?? undefined} target="_blank" rel="noopener noreferrer" className="group block rounded-md border border-border p-1 hover:border-primary">
                        {k.url && <img src={k.url} alt={k.caption} loading="lazy" className="w-full rounded" />}
                        <span className="mt-1 block text-[11px] leading-snug text-muted-foreground"><span className="font-semibold text-primary">K{i + 1}</span> {k.caption}</span>
                      </a>
                    ))}
                  </div>
                  <div className="mb-6" />
                </>
              )}
              {job?.report ? <Markdown className={MD}>{job.report}</Markdown> : <p className="text-sm text-muted-foreground">This test has no report.</p>}
              <button type="button" onClick={() => setTab('steps')} className="mt-5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                See every step it took <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {data && tab === 'steps' && (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Each card is one screenshot, with what the tester did right before it (a red ring marks where it clicked) and what it noted. Click a screenshot to open it full size <ExternalLink className="inline h-3 w-3" />.
              </p>
              <ol className="space-y-3">
                {shown.map((s) => (
                  <ShotCard key={s.seq} step={s} index={steps.indexOf(s)} />
                ))}
              </ol>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
