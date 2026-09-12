/**
 * Density check — read a Hyperframes edit's element density BEFORE the render.
 *
 * ⚠️ WHAT THIS PAGE COSTS: nothing. It reads one JSON file off the shared work
 * mount and slices a word list. No model call, no credit, no render. It is the
 * cheap thing you do before the ~14 hour, 4K, real-money thing.
 *
 * ⚠️ THE KEY SIGNAL IS THE TOP LINE AND IT IS THE FAILURE. A 14.7-minute film
 * shipped visually dead: zero hard resets against a target of five, 76 push-ins
 * against an accepted 31–52, eleven graphics against a floor of thirteen, one
 * screencast block running 126.8s when nothing in 107 measured reference
 * minutes exceeds 80s. Every one of those was knowable before the render. So
 * the first thing on the screen is "NOT READY TO RENDER", not a dashboard.
 *
 * ⚠️ THIS PAGE COMPUTES NOTHING AND DEFAULTS NOTHING. Every threshold, every
 * band, every target and every finding string arrives inside density.json,
 * which `hfp density` produced from hfp/density.py — the same module that
 * actually rejects a cue sheet. There is no fallback constant here, no `?? 0`
 * standing in for a count, and no empty-array default that would render as
 * "0 of 13". A defaulted number is the same lie as a defaulted threshold: if
 * the file is missing the page shows the command to produce it and NOTHING
 * else — no chart, no zeros, no skeleton that resolves into a green anything.
 *
 * ⚠️ THERE IS NO SUBMIT BUTTON HERE AND THERE MUST NEVER BE ONE. Renders are
 * queued from the Render queue. A second money-spending door on the page whose
 * whole job is to say "not yet" would be a gate that advertises coverage it
 * does not have — the machine-facing render API bypasses this page entirely.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Gauge,
  Link2,
  Loader2,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  hyperframesDensityIndex,
  hyperframesDensityReport,
  hyperframesDensityNarration,
  type DensityFinding,
  type DensityIndexRow,
  type DensityReport,
  type DensityScorecard,
  type NarrationSlice,
} from 'zite-endpoints-sdk';
import { BandChart, DENSITY_VIZ_STYLE, FilmStrip, PushStrip, human, mmss } from './densityCharts';

/**
 * The narration endpoint refuses a window longer than this. It is a transport
 * limit from the API contract, not a density rule — clicking the 11m48s push
 * run has to ask for something the server will answer, and the page says so
 * rather than silently showing a shorter slice than the mark implies.
 */
const WINDOW_CAP_SECONDS = 600;

// Static classes only — Tailwind has no safelist here, so a template-built
// class name simply never gets generated.
const PILL: Record<string, string> = {
  pass: 'bg-green-500/15 text-green-400',
  warn: 'bg-amber-500/15 text-amber-400',
  fail: 'bg-red-500/15 text-red-400',
  none: 'bg-muted text-muted-foreground',
};

/** finding.subject → the id of the section it belongs to. */
const SUBJECT_SECTION: Record<string, string> = {
  element: 'elements',
  graphics: 'graphics',
  movement: 'movement',
  screencast: 'screencast',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function copy(text: string, what: string) {
  const clip = navigator.clipboard;
  if (!clip) {
    toast.message('Copy it from here', { description: text, duration: 30_000 });
    return;
  }
  void clip.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.message('Copy it from here', { description: text, duration: 30_000 }),
  );
}

/* ── small shared pieces ─────────────────────────────────────────────────── */

/** There is no ui/card in this project, so pages define their own six-line one. */
function Card({
  title,
  id,
  right,
  children,
}: {
  title: string;
  id?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-6 scroll-mt-20 rounded-lg border border-border p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold', tone ?? 'text-foreground')}>{value}</p>
      {note && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * The empty / broken state. Deliberately the WHOLE body — no chart alongside
 * it, because a chart drawn from nothing is the failure mode this tool exists
 * to prevent.
 */
function CommandPanel({
  tone,
  heading,
  reason,
  command,
}: {
  tone: 'muted' | 'destructive';
  heading: string;
  reason: string;
  command: string;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-5',
        tone === 'destructive' ? 'border-red-500/40 bg-red-500/5' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <Terminal
          className={cn('h-4 w-4', tone === 'destructive' ? 'text-red-400' : 'text-muted-foreground')}
        />
        <h2
          className={cn(
            'text-sm font-medium',
            tone === 'destructive' ? 'text-red-400' : 'text-foreground',
          )}
        >
          {heading}
        </h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
      <p className="mt-3 text-xs text-muted-foreground">
        The Lab cannot produce this itself — <span className="font-mono">hfp</span> lives on the host
        and is not reachable from this container. Run it there:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground">
        {command}
      </pre>
      <Button variant="secondary" size="sm" className="mt-3 gap-1.5" onClick={() => copy(command, 'Command')}>
        <Clipboard className="h-4 w-4" />
        Copy command
      </Button>
    </div>
  );
}

/* ── the triage list, at /density ────────────────────────────────────────── */

function Triage() {
  const [rows, setRows] = useState<DensityIndexRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [commands, setCommands] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await hyperframesDensityIndex({});
      setRows(res.jobs);
      setError(null);
    } catch (err) {
      console.error('[density] index failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * A row with no scorecard expands to the command that would make one. The
   * command comes from the server rather than being assembled here, so the
   * path in it is the path the server actually looked at.
   */
  const expand = async (row: DensityIndexRow) => {
    if (open === row.id) {
      setOpen(null);
      return;
    }
    setOpen(row.id);
    if (commands[row.id]) return;
    try {
      const report = await hyperframesDensityReport({ id: row.id });
      if (report.state !== 'ok') {
        setCommands((c) => ({ ...c, [row.id]: report.command }));
      }
    } catch (err) {
      toast.error('Could not read this job', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-[hsl(var(--chart-4))]/10 p-2 text-[hsl(var(--chart-4))]">
            <Gauge className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Density check</h1>
            <p className="text-xs text-muted-foreground">
              What fires how often, checked before you spend the render.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} className="gap-1.5">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {!loaded ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border p-5">
          <p className="text-sm text-foreground">No jobs on the work mount yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            A job appears here as soon as it exists in the render queue, with or without a scorecard.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const scored = row.hasScorecard && row.state === 'ok';
            // ⚠️ STATE FIRST, hasScorecard SECOND. The server reports
            // hasScorecard:false for "unreadable" and "wrong-schema" too — there
            // is a file, it is just not usable — so testing hasScorecard before
            // state labelled a CORRUPT density.json as a benign grey "no
            // scorecard" and made the fail branch unreachable. A broken file and
            // an absent one need different pills or nobody goes and looks.
            const pill = scored
              ? row.ok
                ? { tone: 'pass', text: 'ready' }
                : { tone: 'fail', text: `${plural(row.errors ?? 0, 'problem', 'problems')}` }
              : row.state === 'absent'
                ? { tone: 'none', text: 'no scorecard' }
                : { tone: 'fail', text: row.state === 'wrong-schema' ? 'wrong shape' : 'unreadable' };
            const body = (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {row.id}
                    {row.durationSeconds ? ` · ${human(row.durationSeconds)}` : ''}
                    {row.generatedAt ? ` · scored ${row.generatedAt}` : ''}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
                    PILL[pill.tone],
                  )}
                >
                  {pill.text}
                </span>
              </div>
            );

            if (scored) {
              return (
                <Link
                  key={row.id}
                  to={`/density/${row.id}`}
                  className="block rounded-lg border border-border p-4 transition-colors hover:border-[hsl(var(--chart-4))]/50"
                >
                  {body}
                </Link>
              );
            }

            return (
              <div key={row.id} className="rounded-lg border border-border p-4">
                <button type="button" onClick={() => void expand(row)} className="w-full text-left">
                  {body}
                </button>
                {open === row.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    {commands[row.id] ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {row.state === 'absent'
                            ? 'Nothing has scored this edit yet. Run this on the host, then reload:'
                            : 'This job has a density.json the Lab cannot use. Re-run the scorer on the host, then reload:'}
                        </p>
                        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] text-foreground">
                          {commands[row.id]}
                        </pre>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-2 gap-1.5"
                          onClick={() => copy(commands[row.id], 'Command')}
                        >
                          <Clipboard className="h-4 w-4" />
                          Copy command
                        </Button>
                      </>
                    ) : (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Reading the job…
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <p className="mt-6 text-xs text-muted-foreground">
        Renders are queued from the{' '}
        <Link to="/render-queue" className="underline hover:text-foreground">
          Render queue
        </Link>
        . Nothing on this page starts one.
      </p>
    </>
  );
}

/* ── the narration slice, the detail panel ───────────────────────────────── */

interface Pick {
  start: number;
  end: number;
  label: string;
}

function DetailPanel({ id, pick, onClose }: { id: string; pick: Pick; onClose: () => void }) {
  const [slice, setSlice] = useState<NarrationSlice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requested = Math.min(pick.end, pick.start + WINDOW_CAP_SECONDS);
  const clipped = requested < pick.end - 0.01;

  useEffect(() => {
    let alive = true;
    setSlice(null);
    setError(null);
    hyperframesDensityNarration({
      id,
      start: pick.start,
      end: Math.max(pick.start + 0.5, requested),
      padSeconds: 1.5,
    }).then(
      (res) => {
        if (alive) setSlice(res);
      },
      (err: unknown) => {
        console.error('[density] narration failed', err);
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [id, pick.start, requested]);

  return (
    <div className="mb-6 rounded-lg border border-[hsl(var(--chart-4))]/40 bg-[hsl(var(--chart-4))]/5 p-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{pick.label}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {mmss(pick.start)} → {mmss(pick.end)} · {human(pick.end - pick.start)}
            {clipped ? ` · showing the first ${human(WINDOW_CAP_SECONDS)}` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5">
          <X className="h-4 w-4" />
          Close
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !slice ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">On screen</p>
              {slice.onScreen ? (
                <>
                  <p className="mt-1 text-sm text-foreground">
                    <span className="font-mono">{slice.onScreen.template}</span> · {slice.onScreen.scene}
                  </p>
                  <pre className="mt-2 max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
                    {JSON.stringify(slice.onScreen.config, null, 2)}
                  </pre>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  Nothing — no graphic covers this span.
                </p>
              )}
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Screencast</p>
              {slice.screencast ? (
                <p className="mt-1 text-sm text-foreground">
                  <span className="font-mono">{slice.screencast.id}</span> {slice.screencast.title}
                  <span className="text-muted-foreground"> · {human(slice.screencast.seconds)}</span>
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No block here.</p>
              )}
            </div>
          </div>

          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">What is said here</p>
          <p className="mt-1 max-h-64 overflow-auto text-sm leading-relaxed">
            {slice.words.length === 0 ? (
              <span className="text-muted-foreground">Nothing is spoken over this span.</span>
            ) : (
              slice.words.map((w, i) => (
                <span key={i} className={w.inSpan ? 'text-foreground' : 'text-muted-foreground'}>
                  {w.word}{' '}
                </span>
              ))
            )}
          </p>
          {slice.truncated && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Long span — only the first {slice.words.length} words are shown.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ── the findings list ───────────────────────────────────────────────────── */

function Findings({ findings }: { findings: DensityFinding[] }) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity !== 'error');

  const row = (f: DensityFinding, i: number) => {
    const section = SUBJECT_SECTION[f.subject];
    const tone = f.severity === 'error' ? PILL.fail : PILL.warn;
    return (
      <li key={`${f.code}-${i}`} className="flex items-start gap-3 border-b border-border py-2 last:border-b-0">
        <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]', tone)}>
          {f.severity === 'error' ? 'error' : 'note'}
        </span>
        <div className="min-w-0">
          {/* The enforcing code's own words, verbatim. Re-wording a finding in
              the UI is how a threshold quietly gets a second definition. */}
          <p className="text-sm text-foreground">{f.message}</p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {f.code}
            {f.element ? ` · ${f.element}` : ''}
            {f.where ? ` · ${f.where}` : ''}
          </p>
        </div>
        {section && (
          <a
            href={`#${section}`}
            className="ml-auto shrink-0 text-[11px] text-muted-foreground underline hover:text-foreground"
          >
            {f.subject}
          </a>
        )}
      </li>
    );
  };

  if (!findings.length) {
    return <p className="text-sm text-green-400">Nothing flagged. Every check passed.</p>;
  }

  return (
    <>
      {errors.length > 0 && <ul className="mb-4">{errors.map(row)}</ul>}
      {warns.length > 0 && (
        <>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Notes — not blockers
          </p>
          <ul>{warns.map(row)}</ul>
        </>
      )}
    </>
  );
}

/* ── one edit, at /density/:id ───────────────────────────────────────────── */

function fixBrief(id: string, s: DensityScorecard): string {
  const lines: string[] = [];
  lines.push(
    s.verdict.ok
      ? `DENSITY: READY — every element in range (${id})`
      : `DENSITY: NOT READY TO RENDER — ${plural(s.verdict.errors, 'problem', 'problems')}, ${plural(
          s.verdict.warnings,
          'note',
          'notes',
        )} (${id})`,
  );
  // ⚠️ A cue-sheet source carries no resolution or fps at all. Printing them
  // regardless produced "null×null · nullfps" in a brief meant to be pasted.
  const frame =
    s.edit.width !== null && s.edit.height !== null ? ` · ${s.edit.width}×${s.edit.height}` : '';
  const fps = s.edit.fps ? ` · ${s.edit.fps}fps` : '';
  lines.push(`Edit ${human(s.edit.durationSeconds)}${frame}${fps}`);
  lines.push(`Scored ${s.generatedAt} by hfp ${s.hfpVersion} from ${s.source.kind}`);
  lines.push('');
  for (const f of s.findings) {
    lines.push(`${f.severity === 'error' ? '[error]' : '[note] '} ${f.message}`);
  }
  lines.push('');
  if (s.graphics.longestGap) {
    const g = s.graphics.longestGap;
    lines.push(
      `Longest stretch with nothing on screen: ${mmss(g.start)} → ${mmss(g.end)} (${human(g.seconds)}).`,
    );
  }
  const over = s.screencast.blockList.filter((b) => b.overMax);
  for (const b of over) {
    lines.push(
      `Screencast block ${b.index} "${b.title}" runs ${human(b.seconds)} from ${mmss(b.start)} — over the ${
        s.thresholds.screencastBlockMaxSeconds
      }s limit.`,
    );
  }
  // ⚠️ "with no reset" IS A CLAIM, SO IT IS CONDITIONAL. A single-span chain has
  // nothing to reset between; asserting it anyway repeats a falsehood into a
  // brief that gets pasted to the director. Chains are sorted longest-first, so
  // on any real edit chains[0] is multi-span — which is exactly why an
  // unconditional sentence here would never be caught by looking at today's data.
  for (const c of s.movement.chains.slice(0, 1)) {
    if (c.spans > 1) {
      lines.push(
        `Longest unbroken movement run: ${c.spans} × ${c.motion} from ${mmss(c.start)} to ${mmss(
          c.end,
        )} (${human(c.seconds)}) with no reset.`,
      );
    } else {
      lines.push(
        `Longest movement span: one × ${c.motion} from ${mmss(c.start)} to ${mmss(
          c.end,
        )} (${human(c.seconds)}).`,
      );
    }
  }
  if (s.source.missing.length) {
    lines.push('');
    lines.push('Not checked:');
    for (const m of s.source.missing) lines.push(`  - ${m.check}: ${m.reason}`);
  }
  lines.push('');
  lines.push(s.promptBlock);
  return lines.join('\n');
}

function OneEdit({ id }: { id: string }) {
  const [report, setReport] = useState<DensityReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await hyperframesDensityReport({ id });
      setReport(res);
      setError(null);
    } catch (err) {
      console.error('[density] report failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [id]);

  // No poll. A scorecard only changes when somebody runs a command on the host,
  // so a 5s timer would be traffic that can never find anything.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPick = useCallback((start: number, end: number, label: string) => {
    setPick({ start, end, label });
  }, []);

  const header = (
    <div className="mb-6 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <Link to="/density">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            All edits
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-foreground">
            {report && 'name' in report ? report.name : 'Density check'}
          </h1>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{id}</p>
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => void refresh()} className="gap-1.5">
        <RefreshCw className="h-4 w-4" />
        Refresh
      </Button>
    </div>
  );

  if (!loaded) {
    return (
      <>
        {header}
        <Skeleton className="mb-4 h-28 w-full" />
        <Skeleton className="mb-4 h-44 w-full" />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (error || !report) {
    return (
      <>
        {header}
        <p className="mt-3 text-sm text-destructive">{error ?? 'No response from the server.'}</p>
      </>
    );
  }

  if (report.state === 'absent') {
    return (
      <>
        {header}
        <CommandPanel
          tone="muted"
          heading="No scorecard for this edit"
          reason={report.reason}
          command={report.command}
        />
      </>
    );
  }

  if (report.state === 'unreadable') {
    return (
      <>
        {header}
        <CommandPanel
          tone="destructive"
          heading="density.json could not be read"
          reason={report.reason}
          command={report.command}
        />
      </>
    );
  }

  if (report.state === 'wrong-schema') {
    return (
      <>
        {header}
        <CommandPanel
          tone="destructive"
          heading="density.json is the wrong shape"
          reason={`${report.reason} Found ${report.found ?? 'no schema field'}; this page reads ${
            report.expected
          }.`}
          command={report.command}
        />
      </>
    );
  }

  const s = report.scorecard;
  const mismatched = report.artifacts.filter((a) => !a.matches);
  const ok = s.verdict.ok && !report.stale;

  return (
    <>
      <style>{DENSITY_VIZ_STYLE}</style>
      {header}

      {report.stale && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm font-medium text-red-400">
            This scorecard is out of date — the edit changed after it was scored.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {mismatched.map((a) => a.name).join(', ')}{' '}
            {mismatched.length === 1 ? 'no longer matches' : 'no longer match'} the file
            <span className="font-mono"> density.json</span> was built from. Re-run{' '}
            <span className="font-mono">hfp density</span> before believing anything below.
          </p>
        </div>
      )}

      {/* THE ANSWER. First thing, biggest thing, and it is the failure. */}
      <div
        className={cn(
          'mb-6 rounded-lg border p-5',
          report.stale
            ? 'border-border opacity-60'
            : s.verdict.ok
              ? 'border-green-500/40 bg-green-500/5'
              : 'border-red-500/40 bg-red-500/5',
        )}
      >
        <p
          className={cn(
            'text-2xl font-semibold',
            report.stale ? 'text-muted-foreground' : s.verdict.ok ? 'text-green-400' : 'text-red-400',
          )}
        >
          {s.verdict.ok ? 'READY — every element in range' : 'NOT READY TO RENDER'}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {plural(s.verdict.errors, 'problem', 'problems')},{' '}
          {plural(s.verdict.warnings, 'note', 'notes')} · {s.edit.minutes.toFixed(1)} min edit
          {s.edit.width !== null && s.edit.height !== null
            ? ` · ${s.edit.width}×${s.edit.height}`
            : ''}
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Scored {s.generatedAt} by hfp {s.hfpVersion} from the {s.source.kind} artifacts ·{' '}
          {s.thresholds.referenceVideos} reference videos, {s.thresholds.referenceMinutes} measured
          minutes
          {ok ? '' : ' · fix these before you spend the render'}
        </p>
      </div>

      {/* jump links */}
      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['elements', 'Elements', `${s.elements.filter((e) => e.verdict === 'below' || e.verdict === 'above').length} out of band`],
          ['graphics', 'Graphics', `${s.graphics.actual} of ${s.graphics.floor} floor`],
          ['movement', 'Movement', `${s.movement.spanCount} spans`],
          ['screencast', 'Screencast', `${s.screencast.blocks} of ${s.screencast.wantBlocks} blocks`],
        ].map(([anchor, title, note]) => (
          <a
            key={anchor}
            href={`#${anchor}`}
            className="rounded-lg border border-border p-3 transition-colors hover:border-[hsl(var(--chart-4))]/50"
          >
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className="mt-0.5 text-sm text-foreground">{note}</p>
          </a>
        ))}
      </div>

      {pick && <DetailPanel id={id} pick={pick} onClose={() => setPick(null)} />}

      <Card
        title="The whole edit"
        right={<span className="text-[11px] text-muted-foreground">click any mark to read it</span>}
      >
        <FilmStrip scorecard={s} onPick={onPick} />
      </Card>

      <Card id="elements" title="What fires, against what was measured">
        <BandChart elements={s.elements} findings={s.findings} onPick={onPick} />
      </Card>

      <Card id="graphics" title="Graphics on screen">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="On screen"
            value={`${s.graphics.actual}`}
            note={`floor is ${s.graphics.floor}`}
            tone={s.graphics.verdict === 'below' ? 'text-red-400' : 'text-green-400'}
          />
          <Stat
            label="Longest dead stretch"
            value={s.graphics.longestGap ? human(s.graphics.longestGap.seconds) : '—'}
            note={
              s.graphics.longestGap
                ? `${mmss(s.graphics.longestGap.start)} → ${mmss(s.graphics.longestGap.end)}`
                : 'no gap'
            }
            tone="text-red-400"
          />
          <Stat label="Gaps in all" value={`${s.graphics.gaps.length}`} note="only the longest is shaded" />
        </div>
        {s.graphics.longestGap && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-3 gap-1.5"
            onClick={() =>
              onPick(
                s.graphics.longestGap!.start,
                s.graphics.longestGap!.end,
                'Nothing on screen',
              )
            }
          >
            <ArrowRight className="h-4 w-4" />
            Read what is said over the dead stretch
          </Button>
        )}
      </Card>

      <Card id="movement" title="Camera movement">
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          {/* ⚠️ null means "there is no push span to measure", which is NOT
              zero seconds and must not be drawn as a measurement. hfp emits null
              for both of these on an edit with no push motion at all. */}
          <Stat
            label="Median push"
            value={
              s.movement.pushMedianSeconds === null
                ? 'no pushes'
                : `${s.movement.pushMedianSeconds.toFixed(1)}s`
            }
            note={`want ≤ ${s.thresholds.pushSpanMedianMaxSeconds}s`}
            tone={
              s.movement.pushMedianSeconds === null
                ? 'text-muted-foreground'
                : s.movement.verdict === 'warn'
                  ? 'text-amber-400'
                  : 'text-green-400'
            }
          />
          <Stat
            label="Longest push"
            value={
              s.movement.pushMaxSeconds === null ? '—' : `${s.movement.pushMaxSeconds.toFixed(1)}s`
            }
          />
          <Stat
            label="Unbroken runs"
            value={`${s.movement.chains.length}`}
            note={
              s.movement.chains[0]
                ? `longest ${human(s.movement.chains[0].seconds)} without a reset`
                : undefined
            }
          />
        </div>
        <PushStrip scorecard={s} onPick={onPick} />
      </Card>

      <Card id="screencast" title="Screencast">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat
            label="Blocks"
            value={`${s.screencast.blocks}`}
            note={`want ${s.screencast.wantBlocks}`}
            tone={s.screencast.blocks < s.screencast.wantBlocks ? 'text-red-400' : 'text-green-400'}
          />
          {/* ⚠️ null is "no block to measure", not "0s". Rendering it through
              human() gave "0s" in green — a passing measurement for an edit that
              has no screencast at all. Neither number gets a colour it did not
              earn. */}
          <Stat
            label="Longest block"
            value={s.screencast.maxSeconds === null ? 'no blocks' : human(s.screencast.maxSeconds)}
            note={`limit ${s.thresholds.screencastBlockMaxSeconds}s`}
            tone={
              s.screencast.maxSeconds === null
                ? 'text-muted-foreground'
                : s.screencast.maxSeconds > s.thresholds.screencastBlockMaxSeconds
                  ? 'text-red-400'
                  : 'text-green-400'
            }
          />
          <Stat
            label="Median block"
            value={s.screencast.medianSeconds === null ? 'no blocks' : human(s.screencast.medianSeconds)}
            note={`want ≤ ${s.thresholds.screencastBlockMedianMaxSeconds}s`}
            tone={
              s.screencast.medianSeconds === null
                ? 'text-muted-foreground'
                : s.screencast.medianSeconds > s.thresholds.screencastBlockMedianMaxSeconds
                  ? 'text-amber-400'
                  : 'text-green-400'
            }
          />
          {/* ⚠️ SHARE IS PASSING AND IS RENDERED AS SUCH. It sits inside the
              reference range and the validator does not flag it. A red share
              number would push the director to raise it, which is the exact
              move density.py warns against. */}
          <Stat
            label="Share of the edit"
            value={`${Math.round(s.screencast.share * 100)}%`}
            note="fine, and does not need raising"
            tone={s.screencast.shareVerdict === 'ok' ? 'text-green-400' : 'text-amber-400'}
          />
        </div>
        <ul className="mt-4 space-y-1">
          {s.screencast.blockList.map((b) => (
            <li key={`${b.index}-${b.id}`}>
              <button
                type="button"
                onClick={() => onPick(b.start, b.end, `${b.id} ${b.title}`)}
                className="flex w-full items-center gap-3 rounded border border-border px-3 py-1.5 text-left text-xs hover:border-[hsl(var(--chart-4))]/50"
              >
                <span className="font-mono text-[11px] text-muted-foreground">{b.id}</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{b.title}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {mmss(b.start)}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
                    b.overMax ? PILL.fail : PILL.none,
                  )}
                >
                  {human(b.seconds)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={`What the checks say — ${plural(s.verdict.errors, 'problem', 'problems')}, ${plural(
          s.verdict.warnings,
          'note',
          'notes',
        )}`}
      >
        <Findings findings={s.findings} />
      </Card>

      <Card title="Not checked">
        {s.source.missing.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every check ran.</p>
        ) : (
          <ul className="space-y-1">
            {s.source.missing.map((m) => (
              <li key={m.check} className="flex items-start gap-3 text-sm">
                <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]', PILL.none)}>
                  not checked
                </span>
                <span className="text-muted-foreground">
                  <span className="font-mono text-foreground">{m.check}</span> — {m.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          These are grey on purpose. A check that could not run is not a check that passed.
        </p>
      </Card>

      <Card title="Provenance">
        <ul className="space-y-1 text-xs">
          {report.artifacts.map((a) => (
            <li key={a.name} className="flex items-center gap-3">
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                  a.matches ? PILL.pass : PILL.fail,
                )}
              >
                {a.present ? (a.matches ? 'matches' : 'changed') : 'missing'}
              </span>
              <span className="font-mono text-foreground">{a.name}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {(a.sha256 ?? '').slice(0, 12)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Freshness is proved by content hash, not by a timestamp — a re-written file keeps a
          plausible mtime. Read from <span className="font-mono">{report.path}</span>.
        </p>
      </Card>

      <details className="mb-6 rounded-lg border border-border p-5">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          The brief hfp writes for the editor
        </summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
          {s.promptBlock}
        </pre>
      </details>

      <div className="mb-10 flex flex-wrap items-center gap-3">
        <Button className="gap-1.5" onClick={() => copy(fixBrief(id, s), 'Fix brief')}>
          <Clipboard className="h-4 w-4" />
          Copy fix brief
        </Button>
        <Button
          variant="secondary"
          className="gap-1.5"
          onClick={() => copy(`${window.location.origin}${report.rawUrl}`, 'Link')}
        >
          <Link2 className="h-4 w-4" />
          Copy raw density.json link
        </Button>
      </div>

      {/* Where a render CTA would sit. It does not sit here. */}
      <p className="mb-10 text-xs text-muted-foreground">
        Renders are queued from the{' '}
        <Link to="/render-queue" className="underline hover:text-foreground">
          Render queue
        </Link>
        .{' '}
        {s.verdict.ok
          ? 'This edit is in range.'
          : `This edit has ${plural(s.verdict.errors, 'problem', 'problems')}.`}
      </p>
    </>
  );
}

/* ── the route ───────────────────────────────────────────────────────────── */

export default function DensityCheckPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Layout breadcrumb="Density check">
      <div className="mx-auto max-w-6xl px-4 py-6">{id ? <OneEdit id={id} /> : <Triage />}</div>
    </Layout>
  );
}
