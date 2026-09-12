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
  refineScriptParagraph,
  saveScriptEdit,
  revertScriptEdit,
  finishScriptEdit,
  scriptVersions,
  restoreScriptVersion,
  scriptLessons,
  decideScriptLesson,
  editScriptLesson,
  applyScriptRules,
  scriptDocsStatus,
  exportScriptToDocs,
  uploadScriptShots,
  attachScriptShots,
  deleteScriptShot,
  createScriptQueue,
  listScriptQueues,
  getScriptQueue,
  startScriptQueue,
  pauseScriptQueue,
  skipScriptQueueItem,
  type ScriptQueue,
  type ScriptInput,
  type ScreenshotRef,
  type ScriptSetup,
  type ScriptRunResult,
  type ScriptRunListItem,
  type ScriptJobSnapshot,
  type ScriptVideoType,
  type ScriptMode,
  type ScriptSection,
  type SponsorshipMode,
  type Sponsorship,
  type RefineMessage,
  type ScriptVersion,
  type ScriptLesson,
  type ScriptEditReview,
  type RuleApplication,
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
  Pencil,
  Save,
  FileText,
  Trash2,
  Plus,
  History,
  ChevronRight,
  ArrowLeft,
  CheckCircle2,
  ListChecks,
  FlaskConical,
  Megaphone,
  Wand2,
  ListTree,
  RotateCw,
  GraduationCap,
  Check,
  Wrench,
  X,
  Undo2,
  ImagePlus,
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
/** "1m 42s" / "45s" — generation duration for the history + detail views. */
function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

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

/**
 * Copy text to the clipboard, working outside a secure context too.
 *
 * `navigator.clipboard` only exists on HTTPS or localhost. The lab is usually
 * opened at http://<host>:9090, where it's `undefined` — so the Copy button
 * threw and reported failure. Fall back to a hidden textarea + execCommand,
 * which works over plain http. Returns whether the copy succeeded.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
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
/**
 * The script, editable, with the save you do not have to think about.
 *
 * Two things make the autosave safe rather than frightening. The edit lands in
 * its own column, so the generated script is always recoverable — "Revert" is a
 * real escape hatch, not a promise. And an empty editor reverts rather than
 * saving nothing, so a stray select-all-delete cannot quietly persist over a
 * script that cost five dollars to write.
 *
 * The debounce is deliberately long enough to cover a pause for thought, and
 * every path that could lose text — closing the tab, switching run, pressing
 * Save — flushes first.
 */
const AUTOSAVE_DEBOUNCE_MS = 1200;

/**
 * Queue several ideas and let them run one after another.
 *
 * Strictly serial, and not as a courtesy: the generator's cost accounting is
 * process-global state zeroed per run, so two scripts at once would mis-report
 * every cost and trip the spend ceiling on their combined total.
 */
function BulkQueuePanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [queue, setQueue] = useState<ScriptQueue | null>(null);
  const [busy, setBusy] = useState(false);

  // Only poll while something is actually moving.
  useEffect(() => {
    if (!queue || queue.status !== 'running') return;
    const t = setInterval(() => {
      void getScriptQueue({ queueId: queue.id })
        .then(setQueue)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [queue?.id, queue?.status]);

  // Pick up a queue left running by a previous visit, so closing the tab does
  // not hide two hours of work in progress.
  useEffect(() => {
    void listScriptQueues({})
      .then(({ queues }) => {
        const active = queues.find((q) => q.status === 'running' || q.status === 'paused');
        if (active) {
          setQueue(active);
          setOpen(true);
        }
      })
      .catch(() => {});
  }, []);

  const ideas = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const q = await createScriptQueue({ ideas: ideas.map((idea) => ({ idea })) });
      setQueue(await startScriptQueue({ queueId: q.id }));
      setText('');
      toast.success(`Queued ${ideas.length} script${ideas.length === 1 ? '' : 's'} — they'll run one at a time.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<ScriptQueue>): Promise<void> => {
    setBusy(true);
    try {
      setQueue(await fn());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const done = queue?.items.filter((i) => i.status === 'done').length ?? 0;
  const spend = queue?.items.reduce((a, i) => a + i.costUsd, 0) ?? 0;

  if (!open) {
    return (
      <div className="mb-4">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <ListTree className="h-4 w-4" />
          Queue several scripts
        </Button>
      </div>
    );
  }

  return (
    <section className="mb-4 rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Bulk scripts</h2>
          <p className="text-xs text-muted-foreground">
            One idea per line. They run one after another — never at the same time — and each one stops at
            about {'$'}12.
          </p>
        </div>
        {!queue && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        )}
      </div>

      {!queue ? (
        <>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={'How to build a lead magnet that converts, for coaches\nThe 5 AI tools I actually pay for\nWhy your email list is not growing'}
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {ideas.length === 0
                ? 'Nothing queued yet'
                : `${ideas.length} script${ideas.length === 1 ? '' : 's'} · roughly ${ideas.length * 30} minutes, about ${'$'}${(ideas.length * 5).toFixed(0)}`}
            </span>
            <Button size="sm" className="gap-1.5" disabled={ideas.length === 0 || busy} onClick={() => void create()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListTree className="h-4 w-4" />}
              Queue {ideas.length || ''}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {done}/{queue.items.length} written
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{'$'}{spend.toFixed(2)}</span>
            <span aria-hidden>·</span>
            <span>{queue.status}</span>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {queue.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{item.title || item.input.idea}</p>
                  {item.error && <p className="mt-0.5 text-xs text-destructive">{item.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.costUsd > 0 && (
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {'$'}{item.costUsd.toFixed(2)}
                    </span>
                  )}
                  <span
                    className={
                      item.status === 'failed'
                        ? 'text-xs text-destructive'
                        : item.status === 'running'
                          ? 'text-xs font-medium text-foreground'
                          : 'text-xs text-muted-foreground'
                    }
                  >
                    {item.status}
                  </span>
                  {item.runId && item.status === 'done' && (
                    <Button variant="ghost" size="sm" onClick={() => { window.location.href = `/script-generator?run=${item.runId}`; }}>
                      Open
                    </Button>
                  )}
                  {item.status === 'queued' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void skipScriptQueueItem({ itemId: item.id }).then(() =>
                          getScriptQueue({ queueId: queue.id }).then(setQueue),
                        )
                      }
                    >
                      Skip
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            {queue.status === 'running' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void act(() => pauseScriptQueue({ queueId: queue.id }))}
              >
                Pause after this script
              </Button>
            ) : queue.status !== 'done' ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act(() => startScriptQueue({ queueId: queue.id }))}
              >
                Resume
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setQueue(null)}>
              {queue.status === 'done' ? 'New queue' : 'Hide'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/* ── The edit loop: versions, and what the edits taught the generator ─────── */

/**
 * What one finished edit taught the generator, with the button that makes it
 * count.
 *
 * ⚠️⚠️ NOTHING HERE IS ACTIVE UNTIL "USE THIS" IS PRESSED. A pending rule is a
 * suggestion drawn by a model from a diff; an approved one is pasted verbatim
 * into the system prompt of every future script. That gap is the entire safety
 * of the feature, so the two states are never shown looking alike.
 */
function LessonCard({
  lesson,
  onDecide,
  onReword,
}: {
  lesson: ScriptLesson;
  onDecide: (state: ScriptLesson['state']) => void;
  onReword: (rule: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lesson.rule);
  const approved = lesson.state === 'approved';

  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-sm',
        approved ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border bg-muted/30',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {lesson.scope}
        </span>
        {approved && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            in every future script
          </span>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className="text-sm" />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onReword(draft);
                setEditing(false);
              }}
            >
              Save wording
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setDraft(lesson.rule); setEditing(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="leading-relaxed text-foreground">{lesson.rule}</p>
      )}

      {lesson.rationale && !editing && (
        <p className="mt-1.5 text-xs text-muted-foreground">{lesson.rationale}</p>
      )}

      {lesson.evidence.length > 0 && !editing && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            From your edits ({lesson.evidence.length})
          </summary>
          <div className="mt-2 space-y-2">
            {lesson.evidence.map((e, i) => (
              <div key={i} className="rounded border border-border/60 bg-background/60 p-2 text-xs">
                {e.before && (
                  <p className="text-muted-foreground line-through decoration-destructive/50">{e.before}</p>
                )}
                {e.after && <p className="mt-1 text-foreground">{e.after}</p>}
              </div>
            ))}
          </div>
        </details>
      )}

      {!editing && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {lesson.state === 'pending' && (
            <>
              <Button size="sm" className="h-7 gap-1.5" onClick={() => onDecide('approved')}>
                <Check className="h-3.5 w-3.5" />
                Use this
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => onDecide('rejected')}>
                <X className="h-3.5 w-3.5" />
                No
              </Button>
            </>
          )}
          {approved && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => onDecide('retired')}>
              <Undo2 className="h-3.5 w-3.5" />
              Stop using
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing(true)}>
            Reword
          </Button>
        </div>
      )}
    </div>
  );
}

/** The one-line summary of what the diff actually measured. */
function DiffSummary({ review }: { review: ScriptEditReview }) {
  const s = review.stats;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const thirds = [
    { label: 'opening', v: s.thirds[0] },
    { label: 'middle', v: s.thirds[1] },
    { label: 'ending', v: s.thirds[2] },
  ].sort((a, b) => b.v - a.v);
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="text-foreground">
        <span className="font-medium tabular-nums">{s.kept}</span> of{' '}
        <span className="tabular-nums">{s.generatedParagraphs}</span> paragraphs kept word for word ({pct(s.keptRatio)}).
      </p>
      <p className="mt-1 tabular-nums">
        {s.rewritten} reworded · {s.cut} cut · {s.added} written by you · {s.generatedWords.toLocaleString()} →{' '}
        {s.editedWords.toLocaleString()} words
      </p>
      {s.rewritten + s.cut + s.added > 0 && (
        <p className="mt-1">
          Most of the work was in the <span className="text-foreground">{thirds[0].label}</span> ({pct(thirds[0].v)} of
          the changes).
        </p>
      )}
    </div>
  );
}

/**
 * The panel beside the script: this edit's conclusions, the rules already in
 * force, and the version history.
 *
 * It reloads on `reviewNonce` — bumped by the editor's Done button — rather than
 * polling, because nothing here changes unless a person does something.
 */
function EditLearningPanel({
  runId,
  reviewNonce,
  review,
  busy,
  onRestore,
}: {
  runId: string;
  reviewNonce: number;
  review: ScriptEditReview | null;
  busy: boolean;
  onRestore: (text: string) => void;
}) {
  const [versions, setVersions] = useState<ScriptVersion[]>([]);
  const [stored, setStored] = useState<ScriptEditReview | null>(null);
  const [active, setActive] = useState<ScriptLesson[]>([]);
  const [pending, setPending] = useState<ScriptLesson[]>([]);
  const [showActive, setShowActive] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<RuleApplication | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const [v, l] = await Promise.all([
      scriptVersions({ runId }).catch(() => ({ versions: [], review: null })),
      scriptLessons({}).catch(() => ({ lessons: [] as ScriptLesson[] })),
    ]);
    setVersions(v.versions);
    setStored(v.review);
    setActive(l.lessons.filter((x) => x.state === 'approved'));
    setPending(l.lessons.filter((x) => x.state === 'pending'));
  }, [runId]);

  useEffect(() => {
    void reload();
  }, [reload, reviewNonce]);

  const shown = review ?? stored;
  // Pending lessons from THIS run lead; anything still pending from an earlier
  // script is listed under it rather than lost.
  const mine = pending.filter((l) => l.runId === runId);
  const others = pending.filter((l) => l.runId !== runId);

  const decide = async (id: string, state: ScriptLesson['state']): Promise<void> => {
    try {
      await decideScriptLesson({ lessonId: id, state });
      toast.success(
        state === 'approved'
          ? 'Added to the rules — every script from here on follows it.'
          : state === 'retired'
            ? 'Retired. New scripts stop following it.'
            : 'Dismissed.',
      );
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const reword = async (id: string, rule: string): Promise<void> => {
    try {
      await editScriptLesson({ lessonId: id, rule });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const applyRules = async (): Promise<void> => {
    if (
      !window.confirm(
        'Rewrite the parts of this script you have not edited, using the approved rules? Your own paragraphs are left alone and the current version is saved first.',
      )
    ) {
      return;
    }
    setApplying(true);
    try {
      const res = await applyScriptRules({ runId });
      setApplied(res);
      if (res.rewritten + res.deleted > 0) {
        onRestore(res.text);
        toast.success(`${res.rewritten + res.deleted} paragraphs brought in line with the rules.`);
      } else {
        toast.success('Nothing to change — the rest of this script already follows the rules.');
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const restore = async (versionId: string): Promise<void> => {
    if (!window.confirm('Put this version back in the editor? What is there now is saved as a version first.')) return;
    try {
      const res = await restoreScriptVersion({ runId, versionId });
      onRestore(res.text);
      toast.success('Restored.');
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <GraduationCap className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">What your edits taught it</h3>
      </div>

      {busy && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading your edits…
        </div>
      )}

      {!busy && shown && <DiffSummary review={shown} />}
      {!busy && shown?.status === 'failed' && (
        <p className="text-xs text-destructive">
          The diff was saved, but the conclusions pass failed: {shown.error}
        </p>
      )}

      {!busy && !shown && (
        <p className="text-xs text-muted-foreground">
          Edit the script, then press <span className="text-foreground">Done</span> — it compares your version with the
          one it wrote and proposes what to change for next time.
        </p>
      )}

      {mine.length > 0 && (
        <div className="space-y-2">
          {mine.map((l) => (
            <LessonCard
              key={l.id}
              lesson={l}
              onDecide={(state) => void decide(l.id, state)}
              onReword={(rule) => void reword(l.id, rule)}
            />
          ))}
        </div>
      )}

      {!busy && shown?.status === 'ready' && mine.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing new to learn from this one — the changes were specific to this video.
        </p>
      )}

      {others.length > 0 && (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {others.length} suggestion{others.length === 1 ? '' : 's'} from other scripts still waiting
          </summary>
          <div className="mt-2 space-y-2">
            {others.map((l) => (
              <div key={l.id} className="space-y-1">
                {l.runTitle && <p className="text-[11px] text-muted-foreground">from “{l.runTitle}”</p>}
                <LessonCard
                  lesson={l}
                  onDecide={(state) => void decide(l.id, state)}
                  onReword={(rule) => void reword(l.id, rule)}
                />
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setShowActive((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <span>
            Rules in force ({active.length})
          </span>
          <ChevronRight className={cn('h-4 w-4 transition-transform', showActive && 'rotate-90')} />
        </button>
        {showActive && (
          <div className="space-y-2 border-t border-border p-3">
            {active.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None yet. Approving one puts it in the prompt for every script after that.
              </p>
            ) : (
              active.map((l) => (
                <LessonCard
                  key={l.id}
                  lesson={l}
                  onDecide={(state) => void decide(l.id, state)}
                  onReword={(rule) => void reword(l.id, rule)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* ⚠️ THE BUTTON ONLY EXISTS ONCE A RULE IS APPROVED. Before that there is
          nothing to apply, and an always-visible button that explains it cannot
          run is a worse answer than not being there. */}
      {active.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            New scripts already follow {active.length === 1 ? 'this rule' : `all ${active.length} rules`}. This one was
            written before them.
          </p>
          <Button size="sm" className="w-full gap-1.5" disabled={applying} onClick={() => void applyRules()}>
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            {applying ? 'Rewriting…' : 'Apply the rules to this script'}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Rewrites only the paragraphs the generator wrote and you left alone. Your own writing is never touched, and
            the version before it is saved so you can restore it.
          </p>
          {applied && (
            <div className="rounded border border-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
              <p className="text-foreground">
                {applied.rewritten} rewritten
                {applied.deleted > 0 ? `, ${applied.deleted} cut` : ''} of {applied.offered} it could touch.
              </p>
              <p>
                {applied.locked > 0
                  ? `${applied.locked} paragraph${applied.locked === 1 ? '' : 's'} of yours left exactly as ${
                      applied.locked === 1 ? 'it was' : 'they were'
                    }.`
                  : "You haven't edited this one yet, so every paragraph in it was the generator's to fix."}
              </p>
              {applied.notes.map((n, i) => (
                <p key={i} className="mt-1">
                  {n}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <span>Version history ({versions.length})</span>
          <ChevronRight className={cn('h-4 w-4 transition-transform', showHistory && 'rotate-90')} />
        </button>
        {showHistory && (
          <div className="space-y-1.5 border-t border-border p-3">
            {versions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No versions yet — the first one is saved when you press Done.
              </p>
            ) : (
              [...versions].reverse().map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <p className="truncate text-foreground">
                      v{v.versionNo} · {v.source === 'generated' ? 'as generated' : v.note || 'edit'}
                    </p>
                    <p className="text-muted-foreground tabular-nums">
                      {new Date(v.createdAt).toLocaleString()} · {v.words.toLocaleString()} words
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => void restore(v.id)}>
                    Restore
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScriptEditor({
  runId,
  generated,
  editedInitial,
  editedAtInitial,
  onSavedChange,
}: {
  runId: string;
  generated: string;
  editedInitial: string | null;
  editedAtInitial: number | null;
  onSavedChange?: (edited: string | null) => void;
}) {
  const [text, setText] = useState(editedInitial ?? generated);
  const [state, setState] = useState<"clean" | "dirty" | "saving" | "error">("clean");
  const [savedAt, setSavedAt] = useState<number | null>(editedAtInitial);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The edit loop. `review` is this session's result; `nonce` makes the panel
  // reload the version list and the lesson bank after a Done.
  const [review, setReview] = useState<ScriptEditReview | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last value actually persisted, so a flush can skip a no-op save and the
  // unmount path knows whether it still owes the server anything.
  const lastSaved = useRef(editedInitial ?? generated);
  const pending = useRef<string | null>(null);

  const save = useCallback(
    async (value: string) => {
      if (value === lastSaved.current) {
        setState("clean");
        return;
      }
      setState("saving");
      try {
        const res = await saveScriptEdit({ runId, text: value });
        lastSaved.current = value;
        pending.current = null;
        setSavedAt(res.savedAt);
        setState("clean");
        setErr(null);
        onSavedChange?.(value.trim() ? value : null);
      } catch (e) {
        setState("error");
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [runId, onSavedChange],
  );

  const onChange = (value: string): void => {
    setText(value);
    setState("dirty");
    pending.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(value), AUTOSAVE_DEBOUNCE_MS);
  };

  // Leaving the page or switching runs must not drop what is still in the
  // debounce window.
  useEffect(() => {
    const flush = (): void => {
      if (pending.current !== null && pending.current !== lastSaved.current) {
        void saveScriptEdit({ runId, text: pending.current }).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      if (timer.current) clearTimeout(timer.current);
      flush();
    };
  }, [runId]);

  /**
   * "Done" — the only thing that triggers a diff.
   *
   * ⚠️ IT FLUSHES THE SAVE FIRST AND WAITS FOR IT. The analysis reads the edited
   * script from the database, so running it while the last keystrokes are still
   * in the 1.2-second debounce would diff a version of the script that is one
   * paragraph behind the one on screen — and draw its conclusions from the
   * difference.
   *
   * Jake, 2026-09-07: "the conclusions should only happen after I clicked the
   * done button (not while autosaving) so it does the diff once after each edit
   * is done." The autosave stays exactly as it was; it just never analyses.
   */
  const done = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    await save(text);
    setEditing(false);
    // Nothing was changed, so there is nothing to learn — and no Opus call.
    if (text.trim() === generated.trim()) return;
    setPanelOpen(true);
    setAnalysing(true);
    try {
      const res = await finishScriptEdit({ runId });
      setReview(res);
      setNonce((n) => n + 1);
      const found = res.lessons.length;
      if (res.status === 'failed') toast.error('Saved the version, but could not read the edits.');
      else if (found > 0) toast.success(`${found} thing${found === 1 ? '' : 's'} it could learn from this.`);
      else toast.success('Version saved. Nothing generalisable in this one.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalysing(false);
    }
  };

  const revert = async (): Promise<void> => {
    if (!window.confirm("Throw away your edits and go back to the generated script?")) return;
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
    setState("saving");
    try {
      await revertScriptEdit({ runId });
      setText(generated);
      lastSaved.current = generated;
      setSavedAt(null);
      setState("clean");
      onSavedChange?.(null);
    } catch (e) {
      setState("error");
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const isEdited = text !== generated;
  const status =
    state === "saving"
      ? "Saving…"
      : state === "dirty"
        ? "Unsaved changes"
        : state === "error"
          ? "Not saved"
          : savedAt
            ? `Saved ${new Date(savedAt).toLocaleTimeString()}`
            : "No edits";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={state === "error" ? "text-destructive" : undefined}>{status}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{words.toLocaleString()} words</span>
          {isEdited && (
            <>
              <span aria-hidden>·</span>
              <span>edited by hand</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setPanelOpen((v) => !v)}
              >
                <GraduationCap className="h-4 w-4" />
                {panelOpen ? 'Hide learning' : 'Learning'}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
            </>
          ) : (
            <>
              {isEdited && (
                <Button variant="ghost" size="sm" onClick={() => void revert()}>
                  Revert
                </Button>
              )}
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  if (timer.current) clearTimeout(timer.current);
                  void save(text);
                }}
                disabled={state === "saving" || state === "clean"}
              >
                <Save className="h-4 w-4" />
                Save
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void done()}>
                <GraduationCap className="h-4 w-4" />
                Done
              </Button>
            </>
          )}
        </div>
      </div>
      {err && <p className="px-4 text-xs text-destructive">{err}</p>}
      {/* The script and, once there is something to say about it, the panel
          beside it. Stacks under the script on a narrow screen rather than
          squeezing both. */}
      <div className={cn('gap-4 px-4 pb-4', panelOpen ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_22rem]' : 'block')}>
        <div className="min-w-0">
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => onChange(e.target.value)}
              spellCheck
              className="h-[70vh] w-full resize-none border-0 bg-transparent py-2 font-mono text-[13px] leading-relaxed outline-none focus-visible:ring-0"
            />
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              <TextBlock text={text} />
            </div>
          )}
        </div>
        {panelOpen && (
          <aside className="mt-4 min-w-0 lg:mt-0 lg:max-h-[70vh] lg:overflow-y-auto">
            <EditLearningPanel
              runId={runId}
              reviewNonce={nonce}
              review={review}
              busy={analysing}
              onRestore={(restored) => {
                setText(restored);
                lastSaved.current = restored;
                pending.current = null;
                setSavedAt(Date.now());
                setState('clean');
                onSavedChange?.(restored.trim() ? restored : null);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

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

// ── Paragraph refinement chat ─────────────────────────────────────────────────
/** Split a stored user turn back into its paragraph + instruction for display. */
function parseUserTurn(content: string): { paragraph: string | null; instruction: string } {
  const withPara = content.match(/^PARAGRAPH TO REWRITE:\n"""\n([\s\S]*?)\n"""\n\nWHAT TO CHANGE:\n([\s\S]*)$/);
  if (withPara) return { paragraph: withPara[1], instruction: withPara[2] };
  const bare = content.match(/^WHAT TO CHANGE:\n([\s\S]*)$/);
  if (bare) return { paragraph: null, instruction: bare[1] };
  return { paragraph: null, instruction: content };
}

/**
 * Post-generation chat: paste a paragraph from the finished script + what needs
 * changing, get back a rewrite grounded in this run's own research + fact sheet
 * and voice. The thread is persisted server-side (keyed on runId), so the parent
 * seeds it from run.refineChat and remounts per run.
 */
function RefineChat({ runId, initialMessages }: { runId: string; initialMessages: RefineMessage[] }) {
  const [messages, setMessages] = useState<RefineMessage[]>(initialMessages);
  const [paragraph, setParagraph] = useState('');
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const started = messages.length > 0;

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, sending]);

  const send = async () => {
    const instr = instruction.trim();
    if (!instr) {
      toast.error('Say what you want changed');
      return;
    }
    if (!started && !paragraph.trim()) {
      toast.error('Paste the paragraph you want rewritten');
      return;
    }
    setSending(true);
    try {
      const res = await refineScriptParagraph({
        runId,
        paragraph: paragraph.trim() || undefined,
        instruction: instr,
      });
      setMessages(res.messages);
      setParagraph('');
      setInstruction('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rewrite the paragraph');
    } finally {
      setSending(false);
    }
  };

  const copyRewrite = async (text: string, ts: number) => {
    if (await copyText(text)) {
      setCopiedAt(ts);
      window.setTimeout(() => setCopiedAt((c) => (c === ts ? null : c)), 1500);
    } else {
      toast.error('Could not copy — select and copy manually');
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="rounded-md bg-primary/10 p-1.5 text-primary">
          <Wand2 className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Refine a paragraph</h2>
          <p className="text-[11px] text-muted-foreground">
            Paste a paragraph and say what to change — it rewrites only that one, from this script&apos;s own research.
          </p>
        </div>
      </div>

      {started && (
        <div ref={threadRef} className="max-h-[46vh] space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m, i) =>
            m.role === 'user' ? (
              (() => {
                const { paragraph: p, instruction: instr } = parseUserTurn(m.content);
                return (
                  <div key={i} className="flex flex-col items-end gap-1">
                    {p && (
                      <div className="max-w-[85%] rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] italic leading-relaxed text-muted-foreground">
                        <span className="mb-0.5 block text-[10px] font-medium uppercase not-italic tracking-wide text-muted-foreground/70">
                          Paragraph
                        </span>
                        {p}
                      </div>
                    )}
                    <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground">
                      {instr}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div key={i} className="flex flex-col items-start gap-1">
                <div className="w-full rounded-lg border border-border bg-background px-3 py-2">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground">
                    {m.content}
                  </pre>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                  onClick={() => void copyRewrite(m.content, m.ts)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copiedAt === m.ts ? 'Copied' : 'Copy'}
                </Button>
              </div>
            ),
          )}
        </div>
      )}

      <div className="space-y-2 border-t border-border px-4 py-3">
        <Textarea
          value={paragraph}
          onChange={(e) => setParagraph(e.target.value)}
          rows={started ? 2 : 3}
          placeholder={
            started
              ? 'Paste a new paragraph — or leave blank to keep editing the last one'
              : 'Paste the paragraph you want rewritten'
          }
          className="resize-y font-mono text-[13px]"
          disabled={sending}
        />
        <div className="flex items-end gap-2">
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="What needs changing? (⌘/Ctrl+Enter to send)"
            className="flex-1 resize-y text-[13px]"
            disabled={sending}
          />
          <Button onClick={() => void send()} disabled={sending} className="gap-1.5">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {sending ? 'Rewriting' : 'Rewrite'}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Screenshots of the tool, taken today, uploaded with the idea.
 *
 * WHY THIS EXISTS
 * The run that prompted it opened 21 pages about a product and not one of them
 * was the product's own site: nineteen were review blogs that rewrite one
 * article for years and put the current year in the title. The script came back
 * honest but full of holes — fifteen `[VERIFY ON SCREEN: …]` markers, two of
 * them sitting on the video's central claim.
 *
 * A screenshot settles in one second what a search cannot settle at all, and it
 * matters most where the web is thinnest: a tool that launched last month, or
 * one too small for anyone to have written about accurately.
 *
 * The preview is a local object URL, not a fetch back from the server — the
 * bytes are already in the browser, and a round trip to look at a picture the
 * user just chose would be silly.
 */
function ScreenshotPicker({
  shots,
  setShots,
  limits,
  disabled,
}: {
  shots: ScreenshotRef[];
  setShots: (next: ScreenshotRef[]) => void;
  limits: { maxPerRun: number; maxBytes: number; accept: string[] } | null;
  disabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const maxPerRun = limits?.maxPerRun ?? 20;
  const accept = limits?.accept?.join(',') || 'image/png,image/jpeg,image/webp,image/gif';

  // Object URLs are a real allocation; drop them when the component goes.
  useEffect(() => {
    return () => {
      for (const url of Object.values(previews)) URL.revokeObjectURL(url);
    };
    // Intentionally on unmount only — the map is appended to, never rewritten,
    // so revoking on every change would kill the thumbnail that was just added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error(`${file.name} could not be read`));
      fr.readAsDataURL(file);
    });

  const onPick = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const picked = Array.from(list);
    const room = maxPerRun - shots.length;
    if (room <= 0) {
      toast.error(`That's already ${maxPerRun} screenshots — more than one video needs.`);
      return;
    }
    const taking = picked.slice(0, room);
    if (taking.length < picked.length) {
      toast.message(`Taking the first ${taking.length} — the limit is ${maxPerRun} per video.`);
    }
    setUploading(true);
    try {
      const files = [];
      const localUrls: Record<string, string> = {};
      for (const f of taking) {
        files.push({ name: f.name, mediaType: f.type, dataBase64: await readAsBase64(f) });
      }
      const res = await uploadScriptShots({ files });
      // The server returns refs in the order it accepted them, and it accepts in
      // the order sent — so a ref lines up with the file that produced it.
      res.shots.forEach((ref, i) => {
        const src = taking[i];
        if (src) localUrls[ref.id] = URL.createObjectURL(src);
      });
      setPreviews((p) => ({ ...p, ...localUrls }));
      setShots([...shots, ...res.shots]);
      // A rejection is per-file and never fails the batch: nine good screenshots
      // and one oversized PNG should leave you with nine screenshots.
      for (const why of res.rejected) toast.error(why);
      if (res.shots.length) {
        toast.success(`${res.shots.length} screenshot${res.shots.length === 1 ? '' : 's'} added`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (ref: ScreenshotRef) => {
    setShots(shots.filter((s) => s.id !== ref.id));
    const url = previews[ref.id];
    if (url) URL.revokeObjectURL(url);
    setPreviews((p) => {
      const next = { ...p };
      delete next[ref.id];
      return next;
    });
    // Best-effort: the ref is already out of the run, so a file left behind is
    // a few hundred KB and not a correctness problem.
    void deleteScriptShot({ id: ref.id, mediaType: ref.mediaType }).catch(() => {});
  };

  const setNote = (id: string, note: string) => {
    setShots(shots.map((s) => (s.id === id ? { ...s, note: note || undefined } : s)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Screenshots of the tool (optional)</Label>
        {shots.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {shots.length}/{maxPerRun}
          </span>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => void onPick(e.target.files)}
      />

      {shots.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shots.map((sh, i) => (
            <div key={sh.id} className="rounded-lg border border-border bg-background p-2 space-y-1.5">
              <div className="relative">
                {previews[sh.id] ? (
                  <img
                    src={previews[sh.id]}
                    alt={sh.name}
                    className="h-24 w-full rounded object-cover"
                  />
                ) : (
                  <div className="flex h-24 w-full items-center justify-center rounded bg-muted text-[11px] text-muted-foreground">
                    {sh.name}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void remove(sh)}
                  disabled={disabled}
                  className="absolute right-1 top-1 rounded bg-background/90 p-1 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${sh.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <span className="absolute left-1 top-1 rounded bg-background/90 px-1 text-[10px] font-medium text-muted-foreground">
                  S{i + 1}
                </span>
              </div>
              <Input
                value={sh.note ?? ''}
                onChange={(e) => setNote(sh.id, e.target.value)}
                placeholder="What is this? e.g. pricing page, annual toggle on"
                className="h-7 text-[11px]"
                disabled={disabled}
              />
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={disabled || uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
        {shots.length ? 'Add more' : 'Add screenshots'}
      </Button>

      <p className="text-[11px] text-muted-foreground">
        Screenshots you took today beat every other source in the run — including the vendor's own page and every
        review site. Best ones to grab: the pricing page, the main dashboard, and any screen the video walks through.
        The note is what tells it what it's looking at.
      </p>
    </div>
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
  // Screenshots of the tool, uploaded before the run exists. They survive as
  // refs on the input; the bytes are already on the server.
  const [shots, setShots] = useState<ScreenshotRef[]>([]);
  const [shotLimits, setShotLimits] =
    useState<{ maxPerRun: number; maxBytes: number; accept: string[] } | null>(null);
  // Which button is in flight, so only the one that was clicked spins.
  const [starting, setStarting] = useState<ScriptMode | null>(null);
  // What the user asked for on the way in, so the checkpoint leads with it.
  const [requestedMode, setRequestedMode] = useState<ScriptMode>('full');

  // Active run + long-job.
  const [run, setRun] = useState<ScriptRunResult | null>(null);
  const [job, setJob] = useState<ScriptJobSnapshot | null>(null);
  const [continuing, setContinuing] = useState<ScriptMode | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);

  // Checkpoint editable fields (seeded from stage0 on entry).
  // Screenshots can still be added here — Stage 0.4 reads them before the first
  // search, and the checkpoint is where the user first hears the topic is thin.
  const [cpShots, setCpShots] = useState<ScreenshotRef[]>([]);
  const [attachingShots, setAttachingShots] = useState(false);
  const [cpVideoType, setCpVideoType] = useState<ScriptVideoType>('Tutorial');
  const [cpTitle, setCpTitle] = useState('');
  const [cpCoreTopic, setCpCoreTopic] = useState('');
  const [cpSpecificFocus, setCpSpecificFocus] = useState('');

  // History.
  const [runs, setRuns] = useState<ScriptRunListItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ configured: boolean; connected: boolean; folderId: string } | null>(null);
  const [exportingDoc, setExportingDoc] = useState(false);

  // Whether the Google Docs connection exists at all. Asked once: it is a
  // settings-level fact, not something that changes while a script is read.
  useEffect(() => {
    void scriptDocsStatus({})
      .then(setDocs)
      .catch(() => setDocs(null));
  }, []);

  const exportToDocs = useCallback(async () => {
    if (!run) return;
    setExportingDoc(true);
    try {
      const res = await exportScriptToDocs({ runId: run.runId });
      // The link is the useful part — a toast that only says "done" makes you
      // go and find the doc yourself.
      toast.success(`Created "${res.name}"`, {
        action: { label: 'Open', onClick: () => window.open(res.docUrl, '_blank', 'noopener') },
        duration: 10000,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setExportingDoc(false);
    }
  }, [run]);
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
        setShotLimits(s.screenshots ?? null);
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
    // Whatever was uploaded on the way in, so the checkpoint shows it rather
    // than looking like an empty picker on a run that already has shots.
    setCpShots(run.input.screenshots ?? []);
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

  /**
   * Both entry buttons run Stage 0 — the classifier has to propose a type and a
   * title either way. The mode only decides how far the job goes after the
   * checkpoint, so it's remembered here and applied there.
   */
  const generate = async (mode: ScriptMode) => {
    const trimmed = idea.trim();
    if (!trimmed) {
      toast.error('Describe the video idea first');
      return;
    }
    const input: ScriptInput = { idea: trimmed, sponsorship: buildSponsorship() };
    if (brief.trim()) input.brief = brief.trim();
    if (targetLength.trim()) input.targetLength = targetLength.trim();
    if (shots.length) input.screenshots = shots;

    setStarting(mode);
    setRequestedMode(mode);
    setJob(null);
    try {
      const { runId } = await startScript(input);
      seededRef.current = null; // force reseed for the new run
      setShots([]); // the refs now belong to the run, not to the empty form
      const full = await getScriptRun({ runId });
      setRun(full);
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the script');
    } finally {
      setStarting(null);
    }
  };

  /**
   * The setup to generate from. At the checkpoint that's the editable fields;
   * turning a finished outline into a script reuses the setup it was built from,
   * so the script matches the outline rather than whatever is on screen.
   */
  const setupFor = (mode: ScriptMode): ScriptSetup | null => {
    if (!run) return null;
    if (run.status === 'awaiting_confirmation') {
      const title = cpTitle.trim();
      if (!title) {
        toast.error('Give the video a title');
        return null;
      }
      return {
        videoType: cpVideoType,
        title,
        coreTopic: cpCoreTopic.trim(),
        specificFocus: cpSpecificFocus.trim(),
        sponsorship: run.input.sponsorship ?? { mode: 'organic', sponsorName: null },
        targetLength: run.input.targetLength ?? '',
        mode,
      };
    }
    return run.setup ? { ...run.setup, mode } : null;
  };

  const confirmSetup = async (mode: ScriptMode) => {
    if (!run) return;
    const setup = setupFor(mode);
    if (!setup) return;
    setContinuing(mode);
    try {
      // Attach before continuing, never after: the run reads its screenshots out
      // of the stored input the moment the job starts, so a race here is a run
      // that quietly ignores the shots the user just added.
      const attached = (run.input.screenshots ?? []).length;
      if (cpShots.length !== attached) {
        setAttachingShots(true);
        try {
          await attachScriptShots({ runId: run.runId, screenshots: cpShots });
        } finally {
          setAttachingShots(false);
        }
      }
      const { jobId } = await continueScript({ runId: run.runId, setup });
      // Optimistically flip into the running view, then poll the job.
      setRun((prev) => (prev ? { ...prev, status: 'running', setup } : prev));
      startJobPolling(jobId);
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start generation');
    } finally {
      setContinuing(null);
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
      setRequestedMode(full.setup?.mode === 'outline' ? 'outline' : 'full');
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
    setRequestedMode('full');
    seededRef.current = null;
  };

  const copyDocument = async () => {
    if (!run?.finalDocument) return;
    if (await copyText(run.finalDocument)) {
      toast.success(run.setup?.mode === 'outline' ? 'Outline copied to clipboard' : 'Script copied to clipboard');
    } else {
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
  // An outline run's deliverable is the plan, so the result view says so — and
  // offers the one thing an outline is for: writing the script from it.
  const isOutlineRun = run?.setup?.mode === 'outline';
  // Resuming needs a confirmed setup to re-send; a run that died before the
  // checkpoint has nothing to carry forward and only offers a fresh start.
  const resumable = run?.status === 'failed' && Boolean(run.setup);
  const resumeSummary = (() => {
    const done = run?.stages?.sections?.length ?? 0;
    if (done > 0) return `${done} section${done === 1 ? '' : 's'} are already written.`;
    if (run?.stages?.outline) return 'The research and outline are already done.';
    if (run?.stages?.research) return 'The research is already done.';
    return 'The stages that completed are saved.';
  })();
  const phase = job?.phase || (status === 'classifying' ? 'Classifying the idea' : 'Working…');
  const percent = job?.percent ?? null;
  const costUsd = job?.costUsd ?? null;

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
              formulas and a section-by-section draft. Or stop at the outline.
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
                                {r.mode === 'outline' && (
                                  <span
                                    className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', HUE_TINT[4])}
                                  >
                                    Outline
                                  </span>
                                )}
                                {r.videoType && <span>{r.videoType}</span>}
                                <span>· {relTime(r.createdAt)}</span>
                                {r.generationMs > 0 && (
                                  <span title="Time to generate">· ⏱ {fmtDuration(r.generationMs)}</span>
                                )}
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
                  <>
                  <BulkQueuePanel />
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

                    <ScreenshotPicker
                      shots={shots}
                      setShots={setShots}
                      limits={shotLimits}
                      disabled={starting !== null}
                    />

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

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <Button onClick={() => void generate('full')} disabled={starting !== null || !idea.trim()}>
                          {starting === 'full' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Sparkles className="h-4 w-4" />
                          )}
                          Generate script
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void generate('outline')}
                          disabled={starting !== null || !idea.trim()}
                        >
                          {starting === 'outline' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ListTree className="h-4 w-4" />
                          )}
                          Generate outline
                        </Button>
                        {starting && (
                          <span className="text-xs text-muted-foreground">
                            Classifying &amp; proposing titles — about 15 seconds…
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Outline stops after the research and the outline — the plan, not the prose. You can write the
                        full script from it afterwards without paying for the research twice.
                      </p>
                    </div>
                  </section>
                  </>
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

                    {/*
                      The last moment screenshots can still be added — Stage 0.4
                      reads them before anything is searched for. Shown on every
                      run, and led with when Stage 0 judged the topic thin,
                      because that is the case where the research comes back
                      hedged and there is nothing to do about it afterwards.
                    */}
                    <div
                      className={cn(
                        'rounded-lg border p-3 space-y-2',
                        run.stage0?.coverageRisk === 'thin'
                          ? 'border-[hsl(var(--chart-4))]/40 bg-[hsl(var(--chart-4))]/5'
                          : 'border-border bg-background',
                      )}
                    >
                      {run.stage0?.coverageRisk === 'thin' && (
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-4))]" />
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium text-foreground">
                              The web won't settle this one
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {run.stage0.coverageNote ||
                                'This topic has little current, trustworthy coverage — expect prices and limits to come back second-hand.'}{' '}
                              Screenshots are the fix, and this is the last point they can be added.
                            </p>
                          </div>
                        </div>
                      )}
                      <ScreenshotPicker
                        shots={cpShots}
                        setShots={setCpShots}
                        limits={shotLimits}
                        disabled={continuing !== null || attachingShots}
                      />
                    </div>

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

                    {/* The mode asked for on the way in leads — first in the row and
                        styled as the primary. Clicking the leading button out of habit
                        should never buy a full script when an outline was asked for. */}
                    <div className="flex flex-wrap items-center gap-3">
                      {(requestedMode === 'outline'
                        ? (['outline', 'full'] as const)
                        : (['full', 'outline'] as const)
                      ).map((m) => (
                        <Button
                          key={m}
                          variant={m === requestedMode ? 'default' : 'outline'}
                          onClick={() => void confirmSetup(m)}
                          disabled={continuing !== null || !cpTitle.trim()}
                        >
                          {continuing === m ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : m === 'outline' ? (
                            <ListTree className="h-4 w-4" />
                          ) : (
                            <Sparkles className="h-4 w-4" />
                          )}
                          {m === 'outline' ? 'Generate outline' : 'Generate full script'}
                        </Button>
                      ))}
                      <span className="text-xs text-muted-foreground">
                        {requestedMode === 'outline'
                          ? 'The outline stops when the outline is done — a few minutes. The full script takes about 20.'
                          : 'The full script takes about 20 minutes; the outline alone takes a few.'}
                      </span>
                    </div>
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
                      {costUsd != null && costUsd > 0 && (
                        <span
                          className="ml-auto text-xs font-medium tabular-nums text-muted-foreground"
                          title="Spend so far on this run"
                        >
                          ${costUsd.toFixed(2)}
                        </span>
                      )}
                      {percent != null && (
                        <span
                          className={cn(
                            'text-sm font-semibold tabular-nums text-foreground',
                            costUsd == null || costUsd === 0 ? 'ml-auto' : 'ml-3',
                          )}
                        >
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
                        {/* A failed run keeps every stage it already paid for, so resuming
                            picks up at the first thing that never ran rather than buying
                            the research, outline and finished sections a second time. */}
                        {resumable && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {resumeSummary} Resuming carries on from there — nothing already written is
                            re-bought.
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {resumable && (
                            <Button
                              size="sm"
                              className="gap-1.5"
                              onClick={() => void confirmSetup(isOutlineRun ? 'outline' : 'full')}
                              disabled={continuing !== null}
                              title="Continues this run from the last stage it completed"
                            >
                              {continuing !== null ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RotateCw className="h-4 w-4" />
                              )}
                              Resume
                            </Button>
                          )}
                          <Button variant="outline" size="sm" className="gap-1.5" onClick={newScript}>
                            <Plus className="h-4 w-4" />
                            New script
                          </Button>
                        </div>
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
                            {run.title || (isOutlineRun ? 'Detailed outline' : 'Final script')}
                          </h2>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            {isOutlineRun && (
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', HUE_TINT[4])}>
                                Outline only
                              </span>
                            )}
                            {run.setup?.videoType && (
                              <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', HUE_TINT[3])}>
                                {run.setup.videoType}
                              </span>
                            )}
                            <span>Updated {relTime(run.updatedAt)}</span>
                            {run.generationMs > 0 && (
                              <span title="Time to generate this script">· ⏱ generated in {fmtDuration(run.generationMs)}</span>
                            )}
                          </div>
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          {isOutlineRun && (
                            <Button
                              size="sm"
                              className="gap-1.5"
                              onClick={() => void confirmSetup('full')}
                              disabled={continuing !== null || !run.stages.outline}
                              title="Writes the video from this outline — the research and fact sheet are reused, not bought again"
                            >
                              {continuing === 'full' ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Sparkles className="h-4 w-4" />
                              )}
                              Write the full script
                            </Button>
                          )}
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
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => void exportToDocs()}
                            disabled={!run.finalDocument || exportingDoc || !docs?.connected}
                            title={
                              !docs?.configured
                                ? "Add the Google Docs client ID and secret in Settings first"
                                : !docs?.connected
                                  ? "Connect Google Docs in Settings first"
                                  : docs.folderId
                                    ? "Creates a numbered Google Doc from what is in the editor"
                                    : "Choose the export folder in Settings first"
                            }
                          >
                            {exportingDoc ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <FileText className="h-4 w-4" />
                            )}
                            Google Doc
                          </Button>
                        </div>
                      </div>
                      {run.finalDocument ? (
                        <ScriptEditor
                          key={run.runId}
                          runId={run.runId}
                          generated={run.finalDocument}
                          editedInitial={run.editedDocument}
                          editedAtInitial={run.editedAt}
                        />
                      ) : (
                        <div className="px-4 py-4">
                          <p className="text-sm text-muted-foreground">
                            No final document was produced for this run.
                          </p>
                        </div>
                      )}
                    </section>

                    {/* Refine a paragraph — post-generation edit chat (script runs only:
                        it rewrites spoken prose, which an outline hasn't got yet). */}
                    {run.finalDocument && !isOutlineRun && (
                      <RefineChat key={run.runId} runId={run.runId} initialMessages={run.refineChat ?? []} />
                    )}

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
                          run.stages.claimAudit.experienceClaims.length === 0 &&
                          run.stages.claimAudit.excessSponsorPlugs.length === 0 &&
                          run.stages.claimAudit.bannedWords.length === 0 &&
                          run.stages.claimAudit.sourceNames.length === 0 ? (
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
                              {run.stages.claimAudit.bannedWords.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                                    Banned words / phrasings that slipped through
                                  </p>
                                  <ul className="space-y-1">
                                    {run.stages.claimAudit.bannedWords.map((c, i) => (
                                      <li key={i} className="text-sm text-foreground">{c}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {run.stages.claimAudit.excessSponsorPlugs.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                                    Over-promotion — sponsor plug repeated too often (2 allowed)
                                  </p>
                                  <ul className="space-y-1">
                                    {run.stages.claimAudit.excessSponsorPlugs.map((c, i) => (
                                      <li key={i} className="text-sm text-foreground">“{c}”</li>
                                    ))}
                                  </ul>
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
                              {run.stages.claimAudit.sourceNames.length > 0 && (
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-destructive">
                                    Presenters from the source tutorials, named in the script
                                  </p>
                                  <p className="text-sm text-foreground">
                                    {run.stages.claimAudit.sourceNames.join(", ")}
                                  </p>
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

                      {run.stages.hookRanking && run.stages.hookRanking.length > 0 && (
                        <StagePanel
                          title="Hooks ranked"
                          hint="virality judged · search measured"
                        >
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                                  <th className="py-1.5 pr-3 text-left font-medium">Hook</th>
                                  <th className="py-1.5 pr-3 text-right font-medium tabular-nums">Viral</th>
                                  <th className="py-1.5 pr-3 text-right font-medium tabular-nums">SEO</th>
                                  <th className="py-1.5 text-left font-medium">Why</th>
                                </tr>
                              </thead>
                              <tbody>
                                {run.stages.hookRanking.map((h, i) => (
                                  <tr key={h.hook} className="border-b last:border-0 align-top">
                                    <td className="py-2 pr-3">
                                      <span className={i === 0 ? "font-medium text-foreground" : "text-foreground"}>
                                        #{h.hook}
                                      </span>{" "}
                                      <span className="text-xs text-muted-foreground">{h.label}</span>
                                      {h.bestFor !== "—" && (
                                        <span className="block text-xs text-muted-foreground">
                                          best for {h.bestFor}
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2 pr-3 text-right tabular-nums text-foreground">{h.virality}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums text-foreground">{h.seo}</td>
                                    <td className="py-2 text-muted-foreground">{h.why}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            Ranked by how likely a viewer is to stay; search value breaks ties. SEO counts the
                            title and topic language the hook carries, and counts it double in the opening lines.
                          </p>
                        </StagePanel>
                      )}

                      {run.stages.openLoops && run.stages.openLoops.length > 0 && (
                        <StagePanel
                          title="Open loops"
                          hint={`${run.stages.openLoops.filter((l) => l.closed !== false).length}/${run.stages.openLoops.length} closed`}
                        >
                          <ul className="space-y-2.5">
                            {run.stages.openLoops.map((l, i) => (
                              <li key={i} className="text-sm">
                                <span className="text-foreground">{l.question}</span>
                                <span className="block text-xs text-muted-foreground">
                                  closed in section {l.closesInSection} — {l.payoff}
                                </span>
                                {l.closed === false && (
                                  <span className="mt-0.5 inline-block text-xs font-medium text-destructive">
                                    Never paid off — the hook promises this and the script does not deliver it.
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </StagePanel>
                      )}

                      {run.stages.claimFix && (
                        <StagePanel
                          title="Claim fixes applied"
                          hint={`${run.stages.claimFix.applied.length} applied`}
                        >
                          {run.stages.claimFix.applied.length > 0 && (
                            <ul className="space-y-1">
                              {run.stages.claimFix.applied.map((c, i) => (
                                <li key={i} className="text-sm text-foreground">{c}</li>
                              ))}
                            </ul>
                          )}
                          {run.stages.claimFix.skipped.length > 0 && (
                            <div className="mt-3">
                              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Left alone — fix these by hand
                              </p>
                              <ul className="space-y-1">
                                {run.stages.claimFix.skipped.map((c, i) => (
                                  <li key={i} className="text-sm text-muted-foreground">{c}</li>
                                ))}
                              </ul>
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
                          hint={`${Object.values(run.stages.reviewChecklist).filter(Boolean).length}/${Object.keys(run.stages.reviewChecklist).length}`}
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

                      {/*
                        Above the sources on purpose: what Jake photographed
                        himself outranks everything the search found, and the
                        panel order is the evidence order.
                      */}
                      {run.stages.screenshotSheet && (
                        <StagePanel
                          title="Your screenshots"
                          hint={`${(run.stages.screenshotRefs ?? []).length} shot${
                            (run.stages.screenshotRefs ?? []).length === 1 ? '' : 's'
                          } · highest authority`}
                        >
                          {(run.stages.screenshotRefs ?? []).length > 0 && (
                            <ul className="mb-2 space-y-1">
                              {run.stages.screenshotRefs!.map((sh, i) => (
                                <li key={sh.id} className="text-[11px] text-muted-foreground">
                                  <span className="font-medium text-foreground">S{i + 1}</span> {sh.name}
                                  {sh.note ? ` — ${sh.note}` : ''}
                                </li>
                              ))}
                            </ul>
                          )}
                          <TextBlock text={run.stages.screenshotSheet} />
                        </StagePanel>
                      )}

                      {run.stages.sourceAudit && run.stages.sourceAudit.total > 0 && (
                        <StagePanel
                          title="Where the research came from"
                          hint={
                            run.stages.sourceAudit.noFirstParty
                              ? 'no vendor page opened'
                              : `${run.stages.sourceAudit.firstParty} first-party`
                          }
                        >
                          {run.stages.sourceAudit.noFirstParty && (
                            <div className="mb-2 flex items-start gap-2 rounded-lg border border-[hsl(var(--chart-4))]/40 bg-[hsl(var(--chart-4))]/5 p-2.5">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-4))]" />
                              <p className="text-[11px] text-muted-foreground">
                                Nothing here came from the vendor's own site, so every price, tier and limit in this
                                script is second-hand — somebody's summary of a pricing page rather than the page.
                                A screenshot of the live pricing page settles it.
                              </p>
                            </div>
                          )}
                          <ul className="space-y-1 text-[11px] text-muted-foreground">
                            <li>
                              <span className="font-medium text-foreground">
                                {run.stages.sourceAudit.firstParty}
                              </span>{' '}
                              from the vendor itself
                              {run.stages.sourceAudit.firstPartyHosts.length
                                ? ` (${run.stages.sourceAudit.firstPartyHosts.join(', ')})`
                                : ''}
                            </li>
                            <li>
                              <span className="font-medium text-foreground">
                                {run.stages.sourceAudit.aggregator}
                              </span>{' '}
                              from review sites and software directories
                            </li>
                            <li>
                              <span className="font-medium text-foreground">
                                {run.stages.sourceAudit.community}
                              </span>{' '}
                              from forums, GitHub and video
                            </li>
                            <li>
                              <span className="font-medium text-foreground">
                                {run.stages.sourceAudit.total -
                                  run.stages.sourceAudit.firstParty -
                                  run.stages.sourceAudit.aggregator -
                                  run.stages.sourceAudit.community}
                              </span>{' '}
                              from blogs and everything else
                            </li>
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

                      {run.stages.briefCoverage && (
                        <StagePanel
                          title="Brief coverage (outline)"
                          hint={`${run.stages.briefCoverage.score}/100${
                            run.stages.briefCoverage.outlineRevised ? ' · outline revised' : ''
                          }`}
                        >
                          <p className="mb-3 text-sm text-foreground">{run.stages.briefCoverage.verdict}</p>
                          {(['added', 'gap', 'covered'] as const)
                            .map((status) => ({
                              status,
                              label:
                                status === 'added'
                                  ? 'Given a section'
                                  : status === 'gap'
                                    ? 'Deliberately left out'
                                    : 'Already covered',
                              items: run.stages.briefCoverage!.items.filter((i) => i.status === status),
                            }))
                            .filter((g) => g.items.length > 0)
                            .map((g) => (
                              <div key={g.status} className="mb-3 last:mb-0">
                                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  {g.label}
                                </p>
                                <ul className="space-y-1.5">
                                  {g.items.map((item, i) => (
                                    <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                                      <ListChecks
                                        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                                          g.status === 'gap'
                                            ? 'text-[hsl(var(--chart-5))]'
                                            : 'text-[hsl(var(--chart-4))]'
                                        }`}
                                      />
                                      <span>
                                        {item.item}
                                        <span className="text-muted-foreground"> — {item.where}</span>
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                        </StagePanel>
                      )}

                      {run.stages.briefCheck && (
                        <StagePanel title="Brief adherence (final script)" hint={`${run.stages.briefCheck.score}/100`}>
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
