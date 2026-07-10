import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  scriptGenStatus,
  startScript,
  continueScript,
  scriptJobStatus,
  getScriptRun,
  listScriptRuns,
  deleteScriptRun,
  type ScriptInput,
  type ScriptSetup,
  type ScriptRunResult,
  type ScriptRunListItem,
  type ScriptJobSnapshot,
  type ScriptVideoType,
  type ScriptSection,
  type SponsorshipMode,
  type Sponsorship,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  PenLine,
  KeyRound,
  Settings,
  AlertTriangle,
  Loader2,
  Sparkles,
  Copy,
  Download,
  Trash2,
  Plus,
  History,
  ChevronRight,
  ArrowLeft,
  CheckCircle2,
  ListChecks,
  FlaskConical,
  Megaphone,
} from 'lucide-react';

/**
 * Jake Dawson Script Generator (LAB tool).
 *
 * Turn a raw video idea into a full YouTube script written in Jake Dawson's
 * voice on Opus 4.8. The flow has a human checkpoint: Stage 0 classifies the
 * idea and proposes titles, you confirm/tweak the setup, then a long background
 * job researches, outlines, writes all four hook formulas and a section-by-
 * section script. Long runs are polled (MemePage idiom); saved runs live in the
 * history sidebar. Nothing here is charted — it's all text output.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Trigger a client-side download of `text` as a file (no server round-trip). */
function triggerBlobDownload(filename: string, text: string, mime = 'text/markdown') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Slugify a title into a safe .md filename base. */
function safeFilename(title: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'script';
  return `${base}.md`;
}

const VIDEO_TYPES: ScriptVideoType[] = [
  'Tutorial',
  'List/Roundup',
  'Tool Review',
  'Business Guide',
  'Opinion',
];

const SPONSOR_OPTIONS: { value: SponsorshipMode; label: string }[] = [
  { value: 'organic', label: 'Organic (no sponsor)' },
  { value: 'whole-video', label: 'Whole-video sponsored' },
  { value: 'mid-roll', label: 'Mid-roll segment' },
];

/** Status → small badge styling for the history rows + headers. */
function statusMeta(status: ScriptRunResult['status']): { label: string; hue: number } {
  switch (status) {
    case 'awaiting_confirmation':
      return { label: 'Checkpoint', hue: 1 };
    case 'classifying':
      return { label: 'Classifying', hue: 1 };
    case 'running':
      return { label: 'Running', hue: 2 };
    case 'completed':
      return { label: 'Done', hue: 3 };
    case 'failed':
      return { label: 'Failed', hue: 5 };
    default:
      return { label: status, hue: 4 };
  }
}

const HUE_TINT: Record<number, string> = {
  1: 'bg-[hsl(var(--chart-1))]/10 text-[hsl(var(--chart-1))]',
  2: 'bg-[hsl(var(--chart-2))]/10 text-[hsl(var(--chart-2))]',
  3: 'bg-[hsl(var(--chart-3))]/10 text-[hsl(var(--chart-3))]',
  4: 'bg-[hsl(var(--chart-4))]/10 text-[hsl(var(--chart-4))]',
  5: 'bg-[hsl(var(--chart-5))]/10 text-[hsl(var(--chart-5))]',
};

// ── Collapsible stage panel ──────────────────────────────────────────────────
function StagePanel({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {hint && <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>}
      </button>
      {open && <div className="border-t border-border px-4 py-3">{children}</div>}
    </div>
  );
}

/** Monospace, line-break-preserving text block for stage output. */
function TextBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

// ── One script section, with a draft ↔ final toggle ──────────────────────────
function SectionPanel({ section, index }: { section: ScriptSection; index: number }) {
  const [showDraft, setShowDraft] = useState(false);
  const hasDraft = !!section.draft && section.draft !== section.final;
  const body = showDraft ? section.draft : section.final;
  return (
    <StagePanel title={`Section ${index + 1}: ${section.name}`} defaultOpen={false}>
      {hasDraft && (
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            onClick={() => setShowDraft(false)}
            className={cn(
              'px-2.5 py-1 text-xs font-medium transition-colors',
              !showDraft ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Final
          </button>
          <button
            type="button"
            onClick={() => setShowDraft(true)}
            className={cn(
              'px-2.5 py-1 text-xs font-medium transition-colors',
              showDraft ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Draft
          </button>
        </div>
      )}
      <TextBlock text={body || '—'} />
    </StagePanel>
  );
}

export default function ScriptGeneratorPage() {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [anthropicConfigured, setAnthropicConfigured] = useState(false);
  const [model, setModel] = useState('');

  // Input form.
  const [idea, setIdea] = useState('');
  const [brief, setBrief] = useState('');
  const [sponsorMode, setSponsorMode] = useState<SponsorshipMode>('organic');
  const [sponsorName, setSponsorName] = useState('');
  const [targetLength, setTargetLength] = useState('');
  const [starting, setStarting] = useState(false);

  // Active run + long-job.
  const [run, setRun] = useState<ScriptRunResult | null>(null);
  const [job, setJob] = useState<ScriptJobSnapshot | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);

  // Checkpoint editable fields (seeded from stage0 on entry).
  const [cpVideoType, setCpVideoType] = useState<ScriptVideoType>('Tutorial');
  const [cpTitle, setCpTitle] = useState('');
  const [cpCoreTopic, setCpCoreTopic] = useState('');
  const [cpSpecificFocus, setCpSpecificFocus] = useState('');

  // History.
  const [runs, setRuns] = useState<ScriptRunListItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false); // mobile drawer

  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const seededRef = useRef<string | null>(null); // runId whose checkpoint has been seeded

  const refreshRuns = useCallback(() => {
    listScriptRuns({})
      .then((r) => setRuns(r.runs ?? []))
      .catch(() => {
        /* history is non-critical */
      });
  }, []);

  const stopPolling = useCallback(() => {
    if (poll.current) {
      clearInterval(poll.current);
      poll.current = null;
    }
  }, []);

  useEffect(() => {
    scriptGenStatus({})
      .then((s) => {
        setAnthropicConfigured(!!s.anthropicConfigured);
        setModel(s.model || '');
      })
      .catch(() => {
        setAnthropicConfigured(false);
      })
      .finally(() => setLoadingStatus(false));
    refreshRuns();
    return () => stopPolling();
  }, [refreshRuns, stopPolling]);

  // Seed the checkpoint fields once whenever we enter awaiting_confirmation for
  // a run we haven't seeded yet (covers both startScript and history resume).
  useEffect(() => {
    if (!run || run.status !== 'awaiting_confirmation' || !run.stage0) return;
    if (seededRef.current === run.runId) return;
    seededRef.current = run.runId;
    const s = run.stage0;
    const setup = run.setup;
    setCpVideoType(setup?.videoType ?? s.videoType);
    setCpTitle(setup?.title ?? s.recommendedTitle);
    setCpCoreTopic(setup?.coreTopic ?? s.coreTopic);
    setCpSpecificFocus(setup?.specificFocus ?? s.specificFocus);
  }, [run]);

  // ── Polling ────────────────────────────────────────────────────────────────
  // Fresh runs return a jobId → poll scriptJobStatus (gives phase + percent).
  const startJobPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const snap = await scriptJobStatus({ jobId });
          setJob(snap);
          if (snap.status !== 'running' && snap.status !== 'classifying') {
            stopPolling();
            try {
              const full = await getScriptRun({ runId: snap.runId });
              setRun(full);
            } catch {
              /* keep the last snapshot */
            }
            if (snap.status === 'failed') {
              toast.error(snap.error || 'Script generation failed');
            }
            refreshRuns();
          }
        } catch {
          /* transient — keep polling */
        }
      };
      poll.current = setInterval(tick, 2500);
      tick();
    },
    [refreshRuns, stopPolling],
  );

  // Resuming a running run from history: no jobId, so poll the run directly.
  const startRunPolling = useCallback(
    (runId: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const full = await getScriptRun({ runId });
          setRun(full);
          if (full.status !== 'running' && full.status !== 'classifying') {
            stopPolling();
            if (full.status === 'failed') toast.error(full.error || 'Script generation failed');
            refreshRuns();
          }
        } catch {
          /* transient — keep polling */
        }
      };
      poll.current = setInterval(tick, 2500);
      tick();
    },
    [refreshRuns, stopPolling],
  );

  // ── Actions ──────────────────────────────────────────────────────────────────
  function buildSponsorship(): Sponsorship {
    if (sponsorMode === 'organic') return { mode: 'organic', sponsorName: null };
    return { mode: sponsorMode, sponsorName: sponsorName.trim() || null };
  }

  const generate = async () => {
    const trimmed = idea.trim();
    if (!trimmed) {
      toast.error('Describe the video idea first');
      return;
    }
    const input: ScriptInput = { idea: trimmed, sponsorship: buildSponsorship() };
    if (brief.trim()) input.brief = brief.trim();
    if (targetLength.trim()) input.targetLength = targetLength.trim();

    setStarting(true);
    setJob(null);
    try {
      const { runId } = await startScript(input);
      seededRef.current = null; // force reseed for the new run
      const full = await getScriptRun({ runId });
      setRun(full);
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the script');
    } finally {
      setStarting(false);
    }
  };

  const confirmSetup = async () => {
    if (!run) return;
    const title = cpTitle.trim();
    if (!title) {
      toast.error('Give the video a title');
      return;
    }
    const setup: ScriptSetup = {
      videoType: cpVideoType,
      title,
      coreTopic: cpCoreTopic.trim(),
      specificFocus: cpSpecificFocus.trim(),
      sponsorship: run.input.sponsorship ?? { mode: 'organic', sponsorName: null },
      targetLength: run.input.targetLength ?? '',
    };
    setContinuing(true);
    try {
      const { jobId } = await continueScript({ runId: run.runId, setup });
      // Optimistically flip into the running view, then poll the job.
      setRun((prev) => (prev ? { ...prev, status: 'running', setup } : prev));
      startJobPolling(jobId);
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start generation');
    } finally {
      setContinuing(false);
    }
  };

  const loadRun = async (runId: string) => {
    stopPolling();
    setLoadingRun(true);
    setJob(null);
    setHistoryOpen(false);
    try {
      const full = await getScriptRun({ runId });
      seededRef.current = null; // allow checkpoint reseed for this run
      setRun(full);
      if (full.status === 'running' || full.status === 'classifying') {
        startRunPolling(runId);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open run');
    } finally {
      setLoadingRun(false);
    }
  };

  const removeRun = async (runId: string) => {
    setDeletingId(runId);
    try {
      await deleteScriptRun({ runId });
      if (run?.runId === runId) {
        stopPolling();
        setRun(null);
        setJob(null);
      }
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete run');
    } finally {
      setDeletingId(null);
    }
  };

  const newScript = () => {
    stopPolling();
    setRun(null);
    setJob(null);
    setHistoryOpen(false);
    seededRef.current = null;
  };

  const copyDocument = async () => {
    if (!run?.finalDocument) return;
    try {
      await navigator.clipboard.writeText(run.finalDocument);
      toast.success('Script copied to clipboard');
    } catch {
      toast.error('Could not copy — select and copy manually');
    }
  };

  const exportDocument = () => {
    if (!run?.finalDocument) return;
    triggerBlobDownload(safeFilename(run.title || 'script'), run.finalDocument);
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  const status = run?.status;
  const isRunning = status === 'running' || status === 'classifying';
  const phase = job?.phase || (status === 'classifying' ? 'Classifying the idea' : 'Working…');
  const percent = job?.percent ?? null;

  return (
    <Layout breadcrumb="Script Generator">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        <header className="mb-5 flex flex-wrap items-center gap-2">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <PenLine className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Jake Dawson Script Generator
            </h1>
            <p className="text-xs text-muted-foreground">
              Turn a video idea into a full YouTube script — research, outline, all four hook
              formulas and a section-by-section draft.
            </p>
          </div>
          {!loadingStatus && anthropicConfigured && model && (
            <Badge variant="secondary" className="ml-auto gap-1">
              <Sparkles className="h-3 w-3" />
              Running on {model}
            </Badge>
          )}
        </header>

        {loadingStatus ? (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-2/3" />
          </div>
        ) : !anthropicConfigured ? (
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-[hsl(var(--chart-5))]/10 p-2 text-[hsl(var(--chart-5))]">
                <KeyRound className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-foreground">
                  This tool runs on Opus 4.8 — add your Anthropic key
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The Script Generator writes in Jake Dawson's voice on Anthropic's Opus 4.8. Add
                  your Anthropic key — the same one the other AI tools use — to start. It's stored
                  write-only on the server.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Anthropic not set
                  </Badge>
                  <Button asChild variant="outline" size="sm" className="ml-auto">
                    <Link to="/settings/postiz">
                      <Settings className="h-4 w-4" />
                      Configure key
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* Mobile-only History toggle (sidebar is always visible on lg+). */}
            <div className="mb-4 lg:hidden">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setHistoryOpen((o) => !o)}
              >
                <History className="h-4 w-4" />
                History
                <span className="text-muted-foreground">({runs.length})</span>
              </Button>
            </div>

            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              {/* ── History sidebar ───────────────────────────────────────────── */}
              <aside className={cn('lg:block lg:w-72 lg:shrink-0', historyOpen ? 'block' : 'hidden')}>
                <div className="rounded-xl border border-border bg-card lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <History className="h-4 w-4 text-muted-foreground" />
                      History
                      <span className="text-xs font-normal text-muted-foreground">({runs.length})</span>
                    </h3>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={newScript}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New script
                    </Button>
                  </div>

                  {runs.length === 0 ? (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      No scripts yet — generate one to see it here.
                    </p>
                  ) : (
                    <div className="py-1">
                      {runs.map((r) => {
                        const meta = statusMeta(r.status);
                        const isOpen = run?.runId === r.id;
                        return (
                          <div
                            key={r.id}
                            className={cn(
                              'group relative flex items-start gap-1.5 px-3 py-2 hover:bg-muted/40',
                              isOpen && 'bg-muted/50',
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => loadRun(r.id)}
                              className="block min-w-0 flex-1 text-left"
                            >
                              <span className="block truncate text-sm font-medium text-foreground">
                                {r.title || 'Untitled script'}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                <span
                                  className={cn(
                                    'rounded px-1.5 py-0.5 text-[10px] font-medium',
                                    HUE_TINT[meta.hue],
                                  )}
                                >
                                  {meta.label}
                                </span>
                                {r.videoType && <span>{r.videoType}</span>}
                                <span>· {relTime(r.createdAt)}</span>
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeRun(r.id)}
                              disabled={deletingId === r.id}
                              title="Delete script"
                              className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-within:opacity-100 group-hover:opacity-100"
                            >
                              {deletingId === r.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </aside>

              {/* ── Main column ───────────────────────────────────────────────── */}
              <div className="min-w-0 flex-1 space-y-6">
                {loadingRun ? (
                  <div className="space-y-3">
                    <Skeleton className="h-32 w-full" />
                    <Skeleton className="h-24 w-2/3" />
                  </div>
                ) : !run ? (
                  /* ── View 1: Input ─────────────────────────────────────────── */
                  <section className="rounded-xl border border-border bg-card p-4 space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="sg-idea">Video idea</Label>
                      <Textarea
                        id="sg-idea"
                        value={idea}
                        onChange={(e) => setIdea(e.target.value)}
                        placeholder="e.g. How to build a lead magnet that actually converts, for coaches"
                        rows={3}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        A sentence or two is plenty — Stage 0 classifies it and proposes titles.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="sg-brief">Brief (optional)</Label>
                      <Textarea
                        id="sg-brief"
                        value={brief}
                        onChange={(e) => setBrief(e.target.value)}
                        placeholder="Angle, must-hit points, audience, tone, examples to include…"
                        rows={3}
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Sponsorship</Label>
                        <Select
                          value={sponsorMode}
                          onValueChange={(v) => setSponsorMode(v as SponsorshipMode)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SPONSOR_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {sponsorMode !== 'organic' && (
                          <Input
                            value={sponsorName}
                            onChange={(e) => setSponsorName(e.target.value)}
                            placeholder="Sponsor name"
                            className="mt-1.5"
                          />
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="sg-length">Target length (optional)</Label>
                        <Input
                          id="sg-length"
                          value={targetLength}
                          onChange={(e) => setTargetLength(e.target.value)}
                          placeholder="10–12 minutes minimum"
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <Button onClick={generate} disabled={starting || !idea.trim()}>
                        {starting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        Generate script
                      </Button>
                      {starting && (
                        <span className="text-xs text-muted-foreground">
                          Classifying &amp; proposing titles — about 15 seconds…
                        </span>
                      )}
                    </div>
                  </section>
                ) : status === 'awaiting_confirmation' ? (
                  /* ── View 2: Checkpoint ────────────────────────────────────── */
                  <section className="rounded-xl border border-border bg-card p-4 space-y-4">
                    <div className="flex items-center gap-2">
                      <div className="rounded-md bg-[hsl(var(--chart-1))]/10 p-1.5 text-[hsl(var(--chart-1))]">
                        <CheckCircle2 className="h-4 w-4" />
                      </div>
                      <div>
                        <h2 className="text-sm font-semibold text-foreground">Confirm the setup</h2>
                        <p className="text-[11px] text-muted-foreground">
                          Tweak anything before we write the full script.
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto gap-1.5 text-muted-foreground"
                        onClick={newScript}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Start over
                      </Button>
                    </div>

                    {run.stage0?.videoTypeDetailed && (
                      <p className="text-xs text-muted-foreground">
                        Detected:{' '}
                        <span className="font-medium text-foreground">
                          {run.stage0.videoTypeDetailed}
                        </span>
                      </p>
                    )}

                    <div className="space-y-1.5">
                      <Label>Video type</Label>
                      <Select
                        value={cpVideoType}
                        onValueChange={(v) => setCpVideoType(v as ScriptVideoType)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {VIDEO_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label>Title</Label>
                      {(run.stage0?.titleOptions ?? []).length > 0 && (
                        <div className="space-y-1">
                          {run.stage0!.titleOptions.map((t, i) => {
                            const selected = cpTitle === t;
                            return (
                              <button
                                key={i}
                                type="button"
                                onClick={() => setCpTitle(t)}
                                className={cn(
                                  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                                  selected
                                    ? 'border-primary bg-primary/5 text-foreground'
                                    : 'border-border text-muted-foreground hover:text-foreground',
                                )}
                              >
                                <span
                                  className={cn(
                                    'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border',
                                    selected ? 'border-primary bg-primary' : 'border-muted-foreground',
                                  )}
                                />
                                <span className="min-w-0 flex-1">{t}</span>
                                {run.stage0?.recommendedTitle === t && (
                                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                                    Recommended
                                  </Badge>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <Input
                        value={cpTitle}
                        onChange={(e) => setCpTitle(e.target.value)}
                        placeholder="Or write your own title"
                        className="mt-1.5"
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="sg-core">Core topic</Label>
                        <Textarea
                          id="sg-core"
                          value={cpCoreTopic}
                          onChange={(e) => setCpCoreTopic(e.target.value)}
                          rows={3}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="sg-focus">Specific focus</Label>
                        <Textarea
                          id="sg-focus"
                          value={cpSpecificFocus}
                          onChange={(e) => setCpSpecificFocus(e.target.value)}
                          rows={3}
                        />
                      </div>
                    </div>

                    <Button onClick={confirmSetup} disabled={continuing || !cpTitle.trim()}>
                      {continuing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      Generate full script
                    </Button>
                  </section>
                ) : isRunning ? (
                  /* ── View 3a: Running ──────────────────────────────────────── */
                  <section className="rounded-xl border border-border bg-card p-6">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-5 w-5 animate-spin text-[hsl(var(--chart-2))]" />
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold text-foreground">
                          {run.title || 'Writing your script…'}
                        </h2>
                        <p className="text-xs text-muted-foreground">{phase}</p>
                      </div>
                      {percent != null && (
                        <span className="ml-auto text-sm font-semibold tabular-nums text-foreground">
                          {Math.round(percent)}%
                        </span>
                      )}
                    </div>
                    <div className="mt-4">
                      {percent != null ? (
                        <Progress value={Math.max(2, Math.min(100, percent))} />
                      ) : (
                        <Progress value={8} className="animate-pulse" />
                      )}
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      This runs in the background — you can leave and reopen it from History.
                    </p>
                  </section>
                ) : status === 'failed' ? (
                  /* ── View 3b: Failed ───────────────────────────────────────── */
                  <section className="rounded-xl border border-destructive/40 bg-card p-5">
                    <div className="flex items-start gap-3">
                      <div className="rounded-md bg-destructive/10 p-2 text-destructive">
                        <AlertTriangle className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h2 className="font-semibold text-foreground">Script generation failed</h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {run.error || 'Something went wrong. Try again.'}
                        </p>
                        <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={newScript}>
                          <Plus className="h-4 w-4" />
                          New script
                        </Button>
                      </div>
                    </div>
                  </section>
                ) : (
                  /* ── View 3c: Result (completed) ───────────────────────────── */
                  <div className="space-y-4">
                    <section className="rounded-xl border border-border bg-card">
                      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-semibold text-foreground">
                            {run.title || 'Final script'}
                          </h2>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            {run.setup?.videoType && (
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', HUE_TINT[3])}>
                                {run.setup.videoType}
                              </span>
                            )}
                            <span>Updated {relTime(run.updatedAt)}</span>
                          </div>
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => void copyDocument()}
                            disabled={!run.finalDocument}
                          >
                            <Copy className="h-4 w-4" />
                            Copy
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={exportDocument}
                            disabled={!run.finalDocument}
                          >
                            <Download className="h-4 w-4" />
                            Export .md
                          </Button>
                        </div>
                      </div>
                      <div className="max-h-[70vh] overflow-y-auto px-4 py-4">
                        {run.finalDocument ? (
                          <TextBlock text={run.finalDocument} />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No final document was produced for this run.
                          </p>
                        )}
                      </div>
                    </section>

                    {/* Stage-by-stage breakdown */}
                    <div className="space-y-2">
                      <p className="flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        <FlaskConical className="h-3.5 w-3.5" />
                        Behind the script
                      </p>

                      {run.stages.hooks && (
                        <StagePanel title="Hooks — all four formulas" defaultOpen>
                          <TextBlock text={run.stages.hooks} />
                        </StagePanel>
                      )}
                      {run.stages.claimAudit && (
                        <StagePanel
                          title="Claim audit"
                          hint={`${run.stages.claimAudit.numbersChecked} numbers checked`}
                        >
                          {run.stages.claimAudit.unsupportedNumbers.length === 0 &&
                          run.stages.claimAudit.fencedTopicsMentioned.length === 0 &&
                          run.stages.claimAudit.experienceClaims.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              Every number in the script traces back to the fact sheet.
                            </p>
                          ) : (
                            <div className="space-y-3">
                              {run.stages.claimAudit.unsupportedNumbers.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                                    Numbers with no source
                                  </p>
                                  <p className="text-sm text-foreground">
                                    {run.stages.claimAudit.unsupportedNumbers.join(", ")}
                                  </p>
                                </div>
                              )}
                              {run.stages.claimAudit.experienceClaims.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                                    Claims Jake never made — invented experience
                                  </p>
                                  <ul className="space-y-1">
                                    {run.stages.claimAudit.experienceClaims.map((c, i) => (
                                      <li key={i} className="text-sm text-foreground">“{c}”</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {run.stages.claimAudit.fencedTopicsMentioned.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    Fenced topics mentioned — check, may be a rebuttal
                                  </p>
                                  <p className="text-sm text-foreground">
                                    {run.stages.claimAudit.fencedTopicsMentioned.join(", ")}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </StagePanel>
                      )}

                      {run.stages.quality && (
                        <StagePanel title="Script quality" hint={`${run.stages.quality.words} words`}>
                          <ul className="space-y-1.5 text-sm text-foreground">
                            <li>
                              Sentence rhythm: {run.stages.quality.meanSentenceWords} words on average, burstiness{" "}
                              {run.stages.quality.burstiness}{" "}
                              <span className="text-muted-foreground">(higher is more human; ~0.65 reads as speech)</span>
                            </li>
                            <li>
                              Repeated phrases: {run.stages.quality.repeatedPhraseCount}
                              {run.stages.quality.worstPhrase && (
                                <>
                                  {" "}— worst is “{run.stages.quality.worstPhrase}” ×{run.stages.quality.worstPhraseRepeats}
                                </>
                              )}
                            </li>
                            <li className="text-muted-foreground">
                              {run.stages.quality.discourseMarkerOpenings} sentences open with “Now/So/Alright” — natural
                              speech, not a defect
                            </li>
                          </ul>
                        </StagePanel>
                      )}

                      {run.stages.reviewChecklist && (
                        <StagePanel
                          title="Voice checklist"
                          hint={`${Object.values(run.stages.reviewChecklist).filter(Boolean).length}/8`}
                        >
                          <ul className="grid grid-cols-2 gap-1.5">
                            {Object.entries(run.stages.reviewChecklist).map(([k, ok]) => (
                              <li key={k} className="flex items-center gap-2 text-sm">
                                <span className={ok ? "text-[hsl(var(--chart-2))]" : "text-destructive"}>
                                  {ok ? "✓" : "✗"}
                                </span>
                                <span className={ok ? "text-muted-foreground" : "text-foreground"}>
                                  {k.replace(/([A-Z])/g, " $1").toLowerCase()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </StagePanel>
                      )}

                      {run.stages.sources.length > 0 && (
                        <StagePanel title="Sources" hint={`${run.stages.sources.length}`}>
                          <ul className="space-y-1.5">
                            {run.stages.sources.map((s, i) => (
                              <li key={i} className="text-sm">
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[hsl(var(--chart-4))] hover:underline"
                                >
                                  {s.title}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </StagePanel>
                      )}

                      {run.stages.factSheet && (
                        <StagePanel title="Fact sheet" hint="checkable details">
                          <TextBlock text={run.stages.factSheet} />
                        </StagePanel>
                      )}
                      {run.stages.research && (
                        <StagePanel title="Research">
                          <TextBlock text={run.stages.research} />
                        </StagePanel>
                      )}
                      {run.stages.outline && (
                        <StagePanel title="Outline">
                          <TextBlock text={run.stages.outline} />
                        </StagePanel>
                      )}
                      {run.stages.sponsorSegment && (
                        <StagePanel
                          title="Sponsor segment"
                          hint={run.setup?.sponsorship.sponsorName ?? undefined}
                        >
                          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Megaphone className="h-3.5 w-3.5" />
                            {run.setup?.sponsorship.mode === 'whole-video'
                              ? 'Whole-video sponsorship'
                              : 'Mid-roll segment'}
                          </div>
                          <TextBlock text={run.stages.sponsorSegment} />
                        </StagePanel>
                      )}

                      {run.stages.sections.map((s, i) => (
                        <SectionPanel key={i} section={s} index={i} />
                      ))}

                      {run.stages.outro && (
                        <StagePanel title="Outro">
                          <TextBlock text={run.stages.outro} />
                        </StagePanel>
                      )}

                      {run.stages.ctaNotes.length > 0 && (
                        <StagePanel title="CTA placement" hint={`${run.stages.ctaNotes.length}`}>
                          <ul className="space-y-1.5">
                            {run.stages.ctaNotes.map((note, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                                <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--chart-4))]" />
                                <span>{note}</span>
                              </li>
                            ))}
                          </ul>
                        </StagePanel>
                      )}

                      {run.stages.briefCheck && (
                        <StagePanel title="Brief adherence" hint={`${run.stages.briefCheck.score}/100`}>
                          <p className="mb-3 text-sm text-foreground">{run.stages.briefCheck.verdict}</p>
                          {[
                            { label: 'Fixed', items: run.stages.briefCheck.editsApplied },
                            { label: 'Not fixed', items: run.stages.briefCheck.gaps },
                            { label: 'Discarded', items: run.stages.briefCheck.editsSkipped },
                          ]
                            .filter((g) => g.items.length > 0)
                            .map((g) => (
                              <div key={g.label} className="mb-3 last:mb-0">
                                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  {g.label}
                                </p>
                                <ul className="space-y-1.5">
                                  {g.items.map((item, i) => (
                                    <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                                      <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--chart-4))]" />
                                      <span>{item}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                        </StagePanel>
                      )}

                      {run.stages.reviewNotes.length > 0 && (
                        <StagePanel title="Review notes" hint={`${run.stages.reviewNotes.length}`}>
                          <ul className="space-y-1.5">
                            {run.stages.reviewNotes.map((note, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                                <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--chart-4))]" />
                                <span>{note}</span>
                              </li>
                            ))}
                          </ul>
                        </StagePanel>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
