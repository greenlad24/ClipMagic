import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from 'zite-auth-sdk';
import {
  getBulkSchedulerStatus,
  previewBulkSchedule,
  startBulkPreview,
  getBulkPreviewRun,
  cancelBulkPreview,
  fillBulkCaptions,
  refreshBulkPlanCaptions,
  bulkTranscriptGaps,
  bulkVoiceGaps,
  bulkScheduledPairs,
  type BulkPreviewRun,
  runBulkSchedule,
  getHiddenRenders,
  bulkFinishedRenders,
  setRenderHidden,
  randomizeBulkOrder,
  listCloudFolder,
  getServiceStatus,
  listStorage,
  type GetBulkSchedulerStatusOutputType,
  type BulkChannel,
  type BulkProvider,
  type BulkPreviewPost,
  type BulkCadenceMode,
  type PreviewBulkScheduleOutputType,
  type RunBulkScheduleOutputType,
  type CloudProvider,
  type CloudFolderItem,
} from 'zite-endpoints-sdk';
import { uploadFiles } from '@/lib/clipmagicClient';
import { resolvePostizUrl } from '@/config/tools';
import { toast } from 'sonner';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CalendarClock,
  KeyRound,
  Link2,
  Upload,
  Film,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Shuffle,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  Gauge,
  AlertTriangle,
  HelpCircle,
  ChevronDown,
  ShieldCheck,
  Cloud,
  HardDrive,
  Play,
  Maximize2,
  X,
  Eye,
  EyeOff,
  Search,
  FileText,
  CheckSquare,
  Square,
  Dices,
} from 'lucide-react';
import type { Growth, GrowthCheck } from 'zite-endpoints-sdk';

/**
 * Bulk Scheduler — bulk-select rendered Shorts and schedule SEO-optimized,
 * per-platform posts through TWO providers:
 *   - Postiz (self-hosted) for TikTok / Instagram Reels / YouTube Shorts;
 *   - PostPeer (pre-approved TikTok Direct Post API) for TikTok.
 *
 * Three steps: (1) pick files + brief, (2) review & edit the AI plan, (3) push.
 * The whole tool is gated behind "at least one provider configured + ≥1
 * connected channel" with a friendly empty state pointing to the settings page.
 */

// ── Local types mirroring the source bridge (server: postiz/fileSources.ts) ──
type FileSource = { kind: 'render' | 'upload' | 'cloud'; ref: string };

/**
 * Client-side twin of the server's groupKeyForFilename (postiz/dropSequencing):
 * derive a video's visual "look" from its filename by stripping the extension and
 * a trailing numeric batch suffix, so the picker can badge looks before previewing.
 * Keep in sync with the server so the badge matches the actual grouping.
 */
function lookKeyForName(name: string): string {
  const raw = (name ?? '').trim();
  if (!raw) return '';
  const noExt = raw.replace(/\.[a-z0-9]{2,4}$/i, '');
  const stripped = noExt.replace(/\s*\(\d+\)\s*$/, '').replace(/[\s._-]+\d+\s*$/, '');
  return (stripped.trim() || noExt.trim() || raw).toLowerCase();
}

/** A stable, legible badge color for a look key (hashed hue). */
function lookColor(key: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue} 70% 90%)`, fg: `hsl(${hue} 65% 30%)` };
}

/** Short, human label for a look key (title-cased-ish, capped). */
function lookLabel(key: string): string {
  if (!key) return 'ungrouped';
  return key.length > 22 ? `${key.slice(0, 21)}…` : key;
}
interface SelectedFile {
  fileId: string;
  source: FileSource;
  label: string;
  brief: string;
  /**
   * A URL the browser can stream/show for preview. For render/upload this is the
   * lab-served media URL (<video> plays it). For cloud (Drive) it's the
   * thumbnail image, if any.
   */
  thumbUrl?: string;
  /**
   * Direct media URL for a cloud clip (the source ref). Used as the
   * click-to-play target; cloud previews open this rather than streaming inline
   * (cross-origin direct links may not allow <video> streaming).
   */
  cloudUrl?: string;
}

/** Larger preview player for the review step — streams renders/uploads inline. */
function ReviewPreview({ file }: { file: SelectedFile }) {
  const frame = 'h-28 w-[63px] shrink-0 overflow-hidden rounded-lg border border-border bg-muted';
  // render / upload → a real controllable player (lazy, metadata only, no autoplay).
  if (file.source.kind !== 'cloud' && file.thumbUrl) {
    return <video src={file.thumbUrl} className={`${frame} object-cover`} controls preload="metadata" />;
  }
  // cloud (Drive thumb / Dropbox placeholder) → click-to-play the direct URL.
  if (file.source.kind === 'cloud' && file.cloudUrl) {
    return (
      <a
        href={file.cloudUrl}
        target="_blank"
        rel="noreferrer"
        className={`group relative block ${frame}`}
        title={`Play ${file.label}`}
      >
        {file.thumbUrl ? (
          <img src={file.thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Film className="h-6 w-6" />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-80 transition-opacity group-hover:opacity-100">
          <Play className="h-6 w-6 text-white" />
        </span>
      </a>
    );
  }
  return (
    <div className={`flex items-center justify-center ${frame}`}>
      <Film className="h-6 w-6 text-muted-foreground" />
    </div>
  );
}

/**
 * Larger, click-to-play preview for the SELECT-files screen. render/upload clips
 * stream inline with native controls (the first frame shows as the poster and it
 * plays on click — metadata-only until then). Cloud clips open their direct URL
 * in a new tab (cross-origin direct links can't reliably stream inline).
 */
function SelectPreview({ file }: { file: SelectedFile }) {
  const frame = 'h-44 w-[99px] shrink-0 overflow-hidden rounded-lg border border-border bg-black';
  if (file.source.kind !== 'cloud' && file.thumbUrl) {
    return <video src={file.thumbUrl} className={`${frame} object-contain`} controls preload="metadata" />;
  }
  if (file.source.kind === 'cloud' && file.cloudUrl) {
    return (
      <a
        href={file.cloudUrl}
        target="_blank"
        rel="noreferrer"
        className={`group relative block ${frame}`}
        title={`Play ${file.label}`}
      >
        {file.thumbUrl ? (
          <img src={file.thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Film className="h-7 w-7" />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-90 transition-opacity group-hover:opacity-100">
          <Play className="h-7 w-7 text-white" />
        </span>
      </a>
    );
  }
  return (
    <div className={`flex items-center justify-center ${frame}`}>
      <Film className="h-7 w-7 text-muted-foreground" />
    </div>
  );
}

/**
 * Mirror of the server's WARM_UP_RAMP (postiz/dropSequencing.ts): 3 drops a week
 * for 4 weeks, then 1/day for 4 weeks, then 2/day from week 9. Duplicated here —
 * like lookKeyForName — only so step 1 can say what a warm-up plan costs in days
 * BEFORE paying to build one. The server stays the authority on the real plan.
 */
function warmUpCapacityOnDay(day: number): number {
  // 3/week lands on days 0, 2 and 4 of each week; the rest are rest days.
  if (day < 28) return day % 7 === 0 || day % 7 === 2 || day % 7 === 4 ? 1 : 0;
  if (day < 56) return 1;
  return 2;
}

/** How many days the warm-up ramp needs to release `count` videos. */
function warmUpDaysToClear(count: number): number {
  let left = count;
  let day = 0;
  while (left > 0 && day < 3650) {
    left -= warmUpCapacityOnDay(day);
    day++;
  }
  return day;
}

// Editable preview row (a copy of a BulkPreviewPost the user can tweak).
type EditablePost = BulkPreviewPost & { override?: boolean };

/**
 * Growth Guardrails are ADVISORY: the score + checklist are shown for guidance,
 * but a post is NEVER blocked from scheduling. This always returns false so no
 * banner, destructive styling, override prompt, or disabled button ever appears.
 * (The caption generator already auto-satisfies the required checks anyway.)
 */
function isGrowthBlocked(_growth: Growth | undefined): boolean {
  return false;
}

/**
 * The server parks a render in the picker's Hidden list once every post for it
 * has gone out, so a published clip stops being offered. Say so, otherwise the
 * clip just silently vanishes from the grid on the way back to step 1.
 *
 * Nothing is moved to Hidden any more — Hidden is the operator's own drawer —
 * so this reports the filtering instead, and stays quiet when the server has
 * nothing to report.
 */
function announceAutoHidden(res: RunBulkScheduleOutputType): void {
  const n = res.autoHidden?.length ?? 0;
  if (n === 0) return;
  toast.info(`${n} clip${n === 1 ? '' : 's'} finished — no longer offered in the picker.`);
}

const PLATFORM_BADGE: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Reels',
  youtube: 'Shorts',
};

/** Title-case a channel identifier for display (e.g. "facebook" → "Facebook"). */
function prettyIdentifier(identifier: string): string {
  return identifier ? identifier.charAt(0).toUpperCase() + identifier.slice(1) : identifier;
}

/**
 * Badge label for a channel/post: TikTok via PostPeer is called out distinctly;
 * a tuned short platform shows its native name; everything else (generic /
 * null-platform channels, e.g. a Facebook Page) badges by its identifier.
 */
function channelBadge(provider: BulkProvider, platform: string | null, identifier: string): string {
  if (provider === 'postpeer') return 'TikTok · PostPeer';
  return PLATFORM_BADGE[platform ?? ''] ?? prettyIdentifier(identifier);
}

/** TikTok privacy levels PostPeer exposes (TikTok's own enum). */
const TIKTOK_PRIVACY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'PUBLIC_TO_EVERYONE', label: 'Public' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends' },
  { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' },
  { value: 'SELF_ONLY', label: 'Private (only me)' },
];

/**
 * Poll a background plan build until it finishes, reporting progress as it goes.
 *
 * Polling — rather than one long request — is the whole point: each call is a
 * couple of hundred milliseconds, so nothing in the network path sees a
 * connection sitting silent for half an hour, and a refresh mid-build rejoins
 * the same run instead of starting a second one.
 */
const PLAN_POLL_MS = 3000;

/** Files per caption-fix request. Matches the server's own per-call cap. */
const BULK_FIX_BATCH = 40;

/**
 * Remove (file × channel) posts this tool has already scheduled.
 *
 * A plan is a snapshot of what was proposed; the ledger is the record of what
 * actually went out. A plan built before a partial send keeps listing the posts
 * that are already live — "908 posts across 4 channels" while 90 were already
 * scheduled (2026-08-24). The review step should describe the work that is
 * LEFT, so those are dropped on load. The saved plan is untouched.
 */
async function dropAlreadyScheduled(
  posts: BulkPreviewPost[],
): Promise<{ posts: BulkPreviewPost[]; removed: number }> {
  try {
    const { pairs } = await bulkScheduledPairs({});
    if (!pairs.length) return { posts, removed: 0 };
    const done = new Set(pairs);
    const left = posts.filter((p) => !done.has(`${p.fileId}|${p.channelId}`));
    return { posts: left, removed: posts.length - left.length };
  } catch {
    // The ledger is an optimisation here, not a safety net — the SERVER refuses
    // duplicates regardless, so a failed read must not block the plan.
    return { posts, removed: 0 };
  }
}

/** Render filenames with nothing left to post. Empty set if the call fails. */
async function finishedRenderNames(): Promise<Set<string>> {
  try {
    const { names } = await bulkFinishedRenders({});
    return new Set(names ?? []);
  } catch {
    return new Set();
  }
}

async function waitForPlan(
  id: string,
  onTick: (run: BulkPreviewRun) => void,
): Promise<PreviewBulkScheduleOutputType> {
  // A poll that fails is NOT a plan that failed. Transcribing a big batch spikes
  // the box hard enough that a single poll can come back 502 while the build is
  // perfectly healthy; giving up there stranded a finished 227-video plan
  // (2026-08-24). Only a long unbroken run of failures means anything.
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 20; // ~1 minute of silence before we quit
  for (;;) {
    let run: BulkPreviewRun | null = null;
    try {
      ({ run } = await getBulkPreviewRun({ id }));
      consecutiveFailures = 0;
    } catch (e) {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error('Lost contact with the server while the plan was building. Reload to rejoin it.');
      }
      await new Promise((r) => setTimeout(r, PLAN_POLL_MS));
      continue;
    }
    if (!run) throw new Error('That plan build is no longer on the server.');
    onTick(run);
    if (run.status === 'done') {
      if (!run.result) throw new Error('The plan finished but came back empty.');
      return run.result;
    }
    if (run.status === 'failed') throw new Error(run.error || 'Building the plan failed.');
    if (run.status === 'cancelled') throw new Error('Plan build cancelled.');
    await new Promise((r) => setTimeout(r, PLAN_POLL_MS));
  }
}


/**
 * Live progress for a plan being built.
 *
 * The build runs server-side (a dropped connection must not lose it), but from
 * the button onwards it should feel like one continuous action — so this shows
 * exactly where it is: which stage, how many videos are done, how many cost
 * nothing because their captions were already written, and how long is left.
 * Without it the wait is a spinner with no information, which is how a 31-minute
 * build once looked identical to a hung one.
 */
function PlanProgress({
  run,
  startedAt,
  onCancel,
}: {
  run: BulkPreviewRun | null;
  startedAt: number | null;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const total = run?.totalCount ?? 0;
  const done = run?.doneCount ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const elapsedSec = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;

  // Rate is measured over THIS run rather than assumed: a batch of already-
  // captioned videos flies through, a cold one does not.
  const remaining = Math.max(0, total - done);
  const etaSec = done > 0 && elapsedSec > 2 ? Math.round((elapsedSec / done) * remaining) : null;
  const fmt = (sec: number) =>
    sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Building your plan
          {total > 0 && (
            <span className="tabular-nums text-muted-foreground">
              {done} of {total}
            </span>
          )}
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {fmt(elapsedSec)} elapsed
          {etaSec !== null && remaining > 0 && <> · about {fmt(etaSec)} left</>}
        </div>
      </div>

      <Progress value={pct} />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {run?.stage || 'starting…'}
          {(run?.cachedCount ?? 0) > 0 && (
            <> · {run!.cachedCount} reused an existing caption (free)</>
          )}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Cancel
        </button>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        This runs on the server — you can close the tab and come back; the plan will be
        waiting. Captions already written are kept even if you cancel.
      </p>
    </div>
  );
}

export default function BulkSchedulerPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<GetBulkSchedulerStatusOutputType | null>(null);
  const [postizUrl, setPostizUrl] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [intent, setIntent] = useState<'none' | 'commute' | 'lunch' | 'evening'>('none');
  // How many videos ("drops") release per day — each goes to every account in the
  // same 24h. Same-look videos are spaced ≥ minGapDays apart; `seed` shuffles the
  // mix (Reshuffle bumps it for a fresh arrangement).
  const [videosPerDay, setVideosPerDay] = useState(2);
  // Warm-up mode replaces the flat rate with a ramp for a brand-new account:
  // 3 drops a week for 4 weeks, 1/day for 4 more, then 2/day. `videosPerDay` is
  // ignored while it's on, so the slider is disabled rather than silently unused.
  const [cadenceMode, setCadenceMode] = useState<BulkCadenceMode>('steady');
  const [minGapDays, setMinGapDays] = useState(3);
  const [seed, setSeed] = useState(1);
  // Randomize: the server arranges the picked videos so two clips shot in the
  // SAME position never sit next to each other, and we keep that exact order to
  // hand back to the planner — the user must get the mix they were shown, not a
  // second one. It only counts while the selection still matches (see mixIsLive).
  const [mixOrder, setMixOrder] = useState<string[] | null>(null);
  const [positionByFile, setPositionByFile] = useState<Record<string, string>>({});
  const [randomizing, setRandomizing] = useState(false);

  // Step 2
  const [posts, setPosts] = useState<EditablePost[]>([]);
  // Per-file transcript the captions were grounded in (null = used the brief).
  const [transcriptByFile, setTranscriptByFile] = useState<Map<string, string | null>>(new Map());
  // (file × channel) pairs dropped because they're already in the ledger.
  const [skippedPosts, setSkippedPosts] = useState<PreviewBulkScheduleOutputType['skippedPosts']>([]);
  // Per-channel "continuing your queue from <day>" hints.
  const [continuedFrom, setContinuedFrom] = useState<PreviewBulkScheduleOutputType['continuedFrom']>([]);
  // Per-file drop day ("YYYY-MM-DD") from the plan — drives the schedule map.
  const [dropDateByFile, setDropDateByFile] = useState<Map<string, string | null>>(new Map());
  const [lookCount, setLookCount] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  /** The background plan build, when one is in flight (or left over from a reload). */
  const [previewRun, setPreviewRun] = useState<BulkPreviewRun | null>(null);
  /** When the current build started, for elapsed time and ETA. */
  const [previewStartedAt, setPreviewStartedAt] = useState<number | null>(null);

  // Step 3
  const [scheduling, setScheduling] = useState(false);
  const [results, setResults] = useState<RunBulkScheduleOutputType | null>(null);

  const loadStatus = useCallback(() => {
    getBulkSchedulerStatus({})
      .then(setStatus)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load Bulk Scheduler status'));
    getServiceStatus({})
      .then((s) => setPostizUrl(resolvePostizUrl(s)))
      .catch(() => setPostizUrl(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    loadStatus();
  }, [user, loadStatus]);

  // Every connected channel is schedulable: a tuned short platform posts with its
  // tuned rules; a null-platform channel (e.g. a Facebook Page) posts as generic.
  const connectedChannels = useMemo(() => status?.channels ?? [], [status]);

  // Selected files keyed by id, so the review step can show a preview per file.
  const filesById = useMemo(() => new Map(selected.map((f) => [f.fileId, f])), [selected]);

  // Auto-select all connected channels once loaded.
  useEffect(() => {
    if (connectedChannels.length && selectedChannelIds.length === 0) {
      setSelectedChannelIds(connectedChannels.map((c) => c.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedChannels]);

  // NOTE: this must stay ABOVE the early returns below. Hooks run in order
  // and unconditionally; placed after a `return`, this one is skipped on the
  // renders that bail out early and then appears when they stop bailing,
  // which React rejects outright ("rendered more hooks than during the
  // previous render") and the page goes blank.
  // A refresh mid-build must not orphan the run: rejoin whatever is still
  // going on the server and pick up its result, rather than starting a second
  // build of the same plan (which would pay for it twice).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { run } = await getBulkPreviewRun({});
        if (cancelled || !run) return;
        // Only a run from the last few hours is worth restoring; anything older
        // is history, not an interrupted session.
        const fresh = Date.now() - run.updatedAt < 6 * 60 * 60 * 1000;
        if (!fresh) return;
        if (run.status !== 'running' && run.status !== 'done') return;

        // Whichever state it is in, put the files back FIRST. The plan is keyed
        // by fileId and scheduling resolves each post's source through this
        // list, so a plan restored without it looks fine and cannot be sent.
        const restored = (run.input as { files?: Array<{ fileId: string; source: FileSource; label?: string; brief?: string }> } | null)?.files;
        if (Array.isArray(restored) && restored.length) {
          // Drop the ones with nothing left to post. A plan's input is the list
          // as it was when the plan was BUILT, so restoring it verbatim put all
          // 227 videos back in the selection after every one had been scheduled
          // (2026-08-24). Selection means "still to do".
          const done = await finishedRenderNames();
          const left = restored.filter((f) => !done.has(f.fileId.replace(/^render:/, '')));
          setSelected((cur) =>
            cur.length
              ? cur
              : left.map((f) => ({
                  fileId: f.fileId,
                  source: f.source,
                  label: f.label ?? f.fileId,
                  brief: f.brief ?? '',
                })),
          );
        }

        let res: PreviewBulkScheduleOutputType;
        if (run.status === 'done') {
          // It finished while the page was away (or while its poll was dead).
          if (!run.result) return;
          res = run.result;
          // Pull in any captions written since the plan was saved — a rewrite
          // from an earlier session lives in the caption store, and without this
          // the page would ask you to pay for it a second time. Free, so it runs
          // every time the plan is restored.
          try {
            const refreshed = await refreshBulkPlanCaptions({ id: run.id });
            if (refreshed.refreshed > 0 && refreshed.run?.result) {
              res = refreshed.run.result;
              toast.success(
                `Picked up your plan — ${refreshed.refreshed} caption${refreshed.refreshed === 1 ? '' : 's'} restored from your last rewrite.`,
              );
            } else {
              toast.success('Picked up the plan that finished while you were away.');
            }
          } catch {
            toast.success('Picked up the plan that finished while you were away.');
          }
        } else {
          setPreviewing(true);
          setPreviewRun(run);
          setPreviewStartedAt(run.createdAt || Date.now());
          toast.info('Reconnected to the plan that was still building.');
          res = await waitForPlan(run.id, setPreviewRun);
        }
        if (cancelled) return;
        if (typeof res.seed === 'number') setSeed(res.seed);
        {
          const { posts: left, removed } = await dropAlreadyScheduled(res.posts);
          setPosts(left);
          if (removed) {
            toast.info(`${removed} post${removed === 1 ? '' : 's'} in this plan are already scheduled — removed.`);
          }
        }
        setTranscriptByFile(new Map((res.files ?? []).map((f) => [f.fileId, f.transcript])));
        setDropDateByFile(new Map((res.files ?? []).map((f) => [f.fileId, f.dropDate])));
        setLookCount(res.lookCount ?? 0);
        setSkippedPosts(res.skippedPosts ?? []);
        setContinuedFrom(res.continuedFrom ?? []);
        if ((res.posts ?? []).length) setStep(2);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to rejoin the plan.');
      } finally {
        if (!cancelled) {
          setPreviewing(false);
          setPreviewRun(null);
          setPreviewStartedAt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount: this is recovery, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Gating ──────────────────────────────────────────────────────────────────
  if (!status) {
    return (
      <Layout breadcrumb="Bulk Scheduler">
        <div className="max-w-5xl mx-auto px-6 py-10 space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </Layout>
    );
  }

  if (!status.apiKeyConfigured || connectedChannels.length === 0) {
    return (
      <Layout breadcrumb="Bulk Scheduler">
        <EmptyState
          channelCount={status.channelCount}
          providers={status.providers}
          error={status.error}
          postizUrl={postizUrl}
          onRetry={loadStatus}
        />
      </Layout>
    );
  }

  /**
   * A randomized order only survives while the selection is unchanged — add or
   * drop a video and the arrangement no longer covers what's picked, so we fall
   * back to the planner's own mix rather than post a stale order.
   */
  const mixIsLive =
    !!mixOrder && mixOrder.length === selected.length && selected.every((f) => mixOrder.includes(f.fileId));

  /**
   * Randomize the drop order. The SERVER arranges it (same interleave the planner
   * uses) so the order shown here is exactly the order that will post; we reorder
   * the selected list in place so the mix is visible, not just promised.
   */
  const randomizeSelection = async () => {
    if (selected.length < 2) {
      toast.info('Pick at least two videos first.');
      return;
    }
    const nextSeed = (seed % 1000000) + 7919;
    setRandomizing(true);
    try {
      const res = await randomizeBulkOrder({ fileIds: selected.map((f) => f.fileId), seed: nextSeed });
      const rank = new Map(res.fileIds.map((id, i) => [id, i]));
      setSelected((prev) =>
        prev
          .slice()
          .sort((a, b) => (rank.get(a.fileId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.fileId) ?? Number.MAX_SAFE_INTEGER)),
      );
      setMixOrder(res.fileIds);
      setPositionByFile(res.positions ?? {});
      setSeed(nextSeed);
      const spots = res.positionCount ?? 0;
      // Say when a repeat was forced: one position holding more than half the
      // pile has to touch itself somewhere, and silently "guaranteeing" it would
      // be a lie.
      toast.success(
        `Randomized ${selected.length} videos across ${spots} position${spots === 1 ? '' : 's'}.` +
          (res.adjacentRepeats
            ? ` ${res.adjacentRepeats} same-position pair${res.adjacentRepeats === 1 ? '' : 's'} were unavoidable — one position dominates the pile.`
            : ' No two from the same position land back-to-back.'),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not randomize the order');
    } finally {
      setRandomizing(false);
    }
  };

  /** Stop following AND stop the run; captions already written are kept. */
  const cancelPlan = async () => {
    const id = previewRun?.id;
    if (!id) return;
    try {
      await cancelBulkPreview({ id });
      toast.info('Plan build cancelled — the captions it already wrote are saved.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel.');
    }
  };

  // ── Step transitions ──────────────────────────────────────────────────────
  // `seedOverride` lets "Reshuffle" build a fresh mix without changing the other
  // controls; it's persisted so scheduling posts the plan the user actually saw.
  // `ignoreMix` is what makes Reshuffle mean something after a Randomize: it drops
  // the pinned order so the planner mixes afresh (still position-aware).
  const goPreview = async (seedOverride?: number, opts?: { ignoreMix?: boolean }) => {
    if (selected.length === 0) {
      toast.info('Select at least one video first.');
      return;
    }
    if (selectedChannelIds.length === 0) {
      toast.info('Select at least one channel.');
      return;
    }
    const useSeed = seedOverride ?? seed;
    setPreviewing(true);
    try {
      // The plan is built in the BACKGROUND: a large one is minutes of AI work,
      // and holding a request open that long is what lost the last 227-video
      // plan. We start it, then poll — a reload can rejoin the same run.
      const started = await startBulkPreview({
        files: selected.map((f) => ({ source: f.source, brief: f.brief, fileId: f.fileId, label: f.label })),
        channelIds: selectedChannelIds,
        intent: intent === 'none' ? undefined : intent,
        videosPerDay,
        cadenceMode,
        minGapDays,
        seed: useSeed,
        fileOrder: !opts?.ignoreMix && mixIsLive ? selected.map((f) => f.fileId) : undefined,
      });
      setPreviewRun(started.run);
      setPreviewStartedAt(started.run.createdAt || Date.now());
      const res = await waitForPlan(started.run.id, setPreviewRun);
      if (typeof res.seed === 'number') setSeed(res.seed);
      {
        const { posts: left, removed } = await dropAlreadyScheduled(res.posts);
        setPosts(left);
        if (removed) {
          toast.info(`${removed} post${removed === 1 ? '' : 's'} were already scheduled — not included.`);
        }
      }
      setTranscriptByFile(new Map((res.files ?? []).map((f) => [f.fileId, f.transcript])));
      setDropDateByFile(new Map((res.files ?? []).map((f) => [f.fileId, f.dropDate])));
      setLookCount(res.lookCount ?? 0);
      setSkippedPosts(res.skippedPosts ?? []);
      setContinuedFrom(res.continuedFrom ?? []);
      if (res.skippedChannels.length) {
        toast.info(`${res.skippedChannels.length} channel(s) skipped (not connected).`);
      }
      if ((res.skippedPosts ?? []).length) {
        toast.info(`${res.skippedPosts.length} post(s) already scheduled — skipped.`);
      }
      if ((res.posts ?? []).length === 0) {
        toast.info('Everything selected is already scheduled to those channels.');
        return;
      }
      setStep(2);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build the plan');
    } finally {
      setPreviewing(false);
      setPreviewRun(null);
      setPreviewStartedAt(null);
    }
  };

  const doSchedule = async () => {
    setScheduling(true);
    try {
      const sourceByFile = new Map(selected.map((f) => [f.fileId, f.source]));
      const res = await runBulkSchedule({
        posts: posts.map((p) => ({
          fileId: p.fileId,
          source: sourceByFile.get(p.fileId)!,
          channelId: p.channelId,
          provider: p.provider,
          identifier: p.identifier,
          caption: p.caption,
          hashtags: p.hashtags,
          firstLineHook: p.firstLineHook,
          scheduledAt: p.scheduledAt,
          ...(p.tiktok ? { tiktok: p.tiktok } : {}),
          ...(p.override ? { override: true } : {}),
        })),
      });
      setResults(res);
      if (res.failed === 0) toast.success(`Scheduled all ${res.scheduled} posts.`);
      else toast.warning(`${res.scheduled} scheduled, ${res.failed} failed — retry the failures below.`);
      announceAutoHidden(res);
      await dropFinishedFromSelection();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to schedule');
    } finally {
      setScheduling(false);
    }
  };

  /**
   * Take finished videos out of the selection. Selection means "still to do",
   * so a video posted to every channel has no business sitting there — it would
   * be swept into the next plan and refused as a duplicate.
   */
  const dropFinishedFromSelection = async () => {
    const done = await finishedRenderNames();
    if (!done.size) return;
    setSelected((cur) => cur.filter((f) => !done.has(f.fileId.replace(/^render:/, ''))));
  };

  const retryFailures = async () => {
    if (!results) return;
    // `duplicate` items are already live on that channel — retrying them would
    // post the same video twice, which is the one outcome a retry must never
    // produce. Only genuine failures are re-sent.
    const failedKeys = new Set(
      results.results.filter((r) => !r.ok && !r.duplicate).map((r) => `${r.fileId}|${r.channelId}`),
    );
    const sourceByFile = new Map(selected.map((f) => [f.fileId, f.source]));
    setScheduling(true);
    try {
      const retryPosts = posts.filter((p) => failedKeys.has(`${p.fileId}|${p.channelId}`));
      const res = await runBulkSchedule({
        posts: retryPosts.map((p) => ({
          fileId: p.fileId,
          source: sourceByFile.get(p.fileId)!,
          channelId: p.channelId,
          provider: p.provider,
          identifier: p.identifier,
          caption: p.caption,
          hashtags: p.hashtags,
          firstLineHook: p.firstLineHook,
          scheduledAt: p.scheduledAt,
          ...(p.tiktok ? { tiktok: p.tiktok } : {}),
          ...(p.override ? { override: true } : {}),
        })),
      });
      // Merge retry results over the prior results.
      setResults((prev) => {
        if (!prev) return res;
        const merged = new Map(prev.results.map((r) => [`${r.fileId}|${r.channelId}`, r]));
        for (const r of res.results) merged.set(`${r.fileId}|${r.channelId}`, r);
        const all = Array.from(merged.values());
        const scheduled = all.filter((r) => r.ok).length;
        return { results: all, scheduled, failed: all.length - scheduled };
      });
      if (res.failed === 0) toast.success('Retried failures scheduled.');
      announceAutoHidden(res);
      await dropFinishedFromSelection();
    } finally {
      setScheduling(false);
    }
  };

  return (
    <Layout breadcrumb="Bulk Scheduler">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <CalendarClock className="h-6 w-6 text-[hsl(var(--chart-3))]" />
              Bulk Scheduler
            </h1>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              Pick finished videos, let AI write distinct SEO captions per platform, and schedule
              them into Postiz at each platform&apos;s best times.
            </p>
          </div>
          {postizUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={postizUrl} target="_blank" rel="noreferrer">
                Open Postiz <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
        </header>

        <Stepper step={step} />

        {step === 1 && (
          <StepSelect
            channels={connectedChannels}
            cloudProviders={status.cloudProviders}
            selected={selected}
            setSelected={setSelected}
            selectedChannelIds={selectedChannelIds}
            setSelectedChannelIds={setSelectedChannelIds}
            intent={intent}
            setIntent={setIntent}
            videosPerDay={videosPerDay}
            setVideosPerDay={setVideosPerDay}
            cadenceMode={cadenceMode}
            setCadenceMode={setCadenceMode}
            minGapDays={minGapDays}
            setMinGapDays={setMinGapDays}
            onRandomize={randomizeSelection}
            randomizing={randomizing}
            mixIsLive={mixIsLive}
            positionByFile={positionByFile}
            onNext={() => goPreview()}
            previewing={previewing}
            previewRun={previewRun}
            previewStartedAt={previewStartedAt}
            onCancelPlan={cancelPlan}
          />
        )}

        {step === 2 && (
          <StepReview
            posts={posts}
            setPosts={setPosts}
            ctaKeyword={status.ctaKeyword || 'PROMPTS'}
            filesById={filesById}
            transcriptByFile={transcriptByFile}
            skippedPosts={skippedPosts}
            continuedFrom={continuedFrom}
            dropDateByFile={dropDateByFile}
            lookCount={lookCount}
            cadenceMode={cadenceMode}
            reshuffling={previewing}
            onReshuffle={() => {
              setMixOrder(null);
              goPreview((seed % 1000000) + 7919, { ignoreMix: true });
            }}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && (
          <StepSchedule
            posts={posts}
            channels={connectedChannels}
            results={results}
            scheduling={scheduling}
            postizUrl={postizUrl}
            onBack={() => setStep(2)}
            onSchedule={doSchedule}
            onRetry={retryFailures}
          />
        )}
      </div>
    </Layout>
  );
}

// ── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const steps = ['Select files', 'Review & optimize', 'Schedule'];
  return (
    <ol className="mb-8 flex items-center gap-2 text-sm">
      {steps.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : done
                  ? 'bg-[hsl(var(--chart-3))]/20 text-[hsl(var(--chart-3))]'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
            </span>
            <span className={active ? 'text-foreground font-medium' : 'text-muted-foreground'}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-8 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

// ── Empty / gating state ───────────────────────────────────────────────────
function EmptyState({
  channelCount,
  providers,
  error,
  postizUrl,
  onRetry,
}: {
  channelCount: number;
  providers: GetBulkSchedulerStatusOutputType['providers'];
  error?: string;
  postizUrl: string | null;
  onRetry: () => void;
}) {
  const anyConfigured = providers.postiz.configured || providers.postpeer.configured;
  return (
    <div className="max-w-2xl mx-auto px-6 py-16 text-center">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[hsl(var(--chart-3))]/10">
        <CalendarClock className="h-7 w-7 text-[hsl(var(--chart-3))]" />
      </div>
      <h1 className="text-2xl font-bold text-foreground">Bulk Scheduler</h1>
      <p className="mt-2 text-muted-foreground leading-relaxed">
        Schedule SEO-optimized, per-platform posts through Postiz and/or PostPeer. Configure at least
        one provider and connect a channel to get started:
      </p>

      <div className="mt-6 space-y-3 text-left">
        <GateRow
          done={providers.postiz.configured}
          icon={<KeyRound className="h-4 w-4" />}
          title="Postiz — TikTok / Instagram / YouTube"
          body={
            <>
              Set <strong className="text-foreground">POSTIZ_API_KEY</strong>: create it in Postiz under
              {' '}<strong className="text-foreground">Settings → Developers → Public API</strong>, then
              paste it into the suite&apos;s Postiz settings (Bulk Scheduler group) and connect a
              TikTok / Instagram / YouTube channel inside Postiz. Stored write-only, never shown again.
            </>
          }
        />
        <GateRow
          done={providers.postpeer.configured}
          icon={<KeyRound className="h-4 w-4" />}
          title="PostPeer — TikTok (Direct Post)"
          body={
            <>
              Set <strong className="text-foreground">POSTPEER_API_KEY</strong> (same Bulk Scheduler
              settings group) and connect a TikTok account in your PostPeer dashboard — no TikTok app
              review needed. Posting your renders also needs{' '}
              <strong className="text-foreground">PUBLIC_BASE_URL</strong> set so PostPeer can fetch the
              video.
            </>
          }
        />
        <GateRow
          done={anyConfigured && channelCount > 0}
          icon={<Link2 className="h-4 w-4" />}
          title="At least one connected channel"
          body={
            anyConfigured ? (
              <>
                {channelCount === 0
                  ? 'No connected channels found yet. Connect a channel in Postiz, or a TikTok account in PostPeer.'
                  : `${channelCount} channel(s) connected.`}
              </>
            ) : (
              <>Connect a channel in Postiz, or a TikTok account in PostPeer.</>
            )
          }
        />
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Couldn&apos;t reach a posting provider: {error}
        </p>
      )}

      <div className="mt-7 flex items-center justify-center gap-2">
        <Button asChild>
          <a href="/settings/postiz">
            <KeyRound className="h-4 w-4" /> Set API keys
          </a>
        </Button>
        {postizUrl && (
          <Button variant="outline" asChild>
            <a href={postizUrl} target="_blank" rel="noreferrer">
              Open Postiz <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        )}
        <Button variant="ghost" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Recheck
        </Button>
      </div>
    </div>
  );
}

function GateRow({
  done,
  icon,
  title,
  body,
}: {
  done: boolean;
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
          done ? 'bg-[hsl(var(--chart-3))]/15 text-[hsl(var(--chart-3))]' : 'bg-muted text-muted-foreground'
        }`}
      >
        {done ? <CheckCircle2 className="h-4 w-4" /> : icon}
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

// ── Step 1: Select files ─────────────────────────────────────────────────────
function StepSelect({
  channels,
  cloudProviders,
  selected,
  setSelected,
  selectedChannelIds,
  setSelectedChannelIds,
  intent,
  setIntent,
  videosPerDay,
  setVideosPerDay,
  cadenceMode,
  setCadenceMode,
  minGapDays,
  setMinGapDays,
  onRandomize,
  randomizing,
  mixIsLive,
  positionByFile,
  onNext,
  previewing,
  previewRun,
  previewStartedAt,
  onCancelPlan,
}: {
  channels: BulkChannel[];
  cloudProviders: GetBulkSchedulerStatusOutputType['cloudProviders'];
  selected: SelectedFile[];
  setSelected: React.Dispatch<React.SetStateAction<SelectedFile[]>>;
  selectedChannelIds: string[];
  setSelectedChannelIds: React.Dispatch<React.SetStateAction<string[]>>;
  intent: 'none' | 'commute' | 'lunch' | 'evening';
  setIntent: (v: 'none' | 'commute' | 'lunch' | 'evening') => void;
  videosPerDay: number;
  setVideosPerDay: (v: number) => void;
  cadenceMode: BulkCadenceMode;
  setCadenceMode: (v: BulkCadenceMode) => void;
  minGapDays: number;
  setMinGapDays: (v: number) => void;
  onRandomize: () => void;
  randomizing: boolean;
  mixIsLive: boolean;
  positionByFile: Record<string, string>;
  onNext: () => void;
  previewing: boolean;
  /** Live progress of the background plan build, when one is running. */
  previewRun: BulkPreviewRun | null;
  previewStartedAt: number | null;
  onCancelPlan: () => void;
}) {
  const toggleFile = (file: SelectedFile) => {
    setSelected((prev) => {
      const exists = prev.find((f) => f.fileId === file.fileId);
      return exists ? prev.filter((f) => f.fileId !== file.fileId) : [...prev, file];
    });
  };
  const isSelected = (fileId: string) => selected.some((f) => f.fileId === fileId);
  const setBrief = (fileId: string, brief: string) =>
    setSelected((prev) => prev.map((f) => (f.fileId === fileId ? { ...f, brief } : f)));

  return (
    <div className="space-y-6">
      <Tabs defaultValue="renders">
        <TabsList>
          <TabsTrigger value="renders">
            <Film className="h-4 w-4" /> Server renders
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="h-4 w-4" /> Upload
          </TabsTrigger>
          <TabsTrigger value="gdrive">
            <HardDrive className="h-4 w-4" /> Google Drive
          </TabsTrigger>
          <TabsTrigger value="dropbox">
            <Cloud className="h-4 w-4" /> Dropbox
          </TabsTrigger>
          <TabsTrigger value="cloud">
            <Link2 className="h-4 w-4" /> Cloud link
          </TabsTrigger>
        </TabsList>

        <TabsContent value="renders">
          <RendersTab isSelected={isSelected} onToggle={toggleFile} />
        </TabsContent>
        <TabsContent value="upload">
          <UploadTab
            isSelected={isSelected}
            onAdd={(f) => setSelected((prev) => [...prev, f])}
          />
        </TabsContent>
        <TabsContent value="gdrive">
          <CloudFolderTab
            provider="gdrive"
            configured={cloudProviders.gdrive}
            isSelected={isSelected}
            onToggle={toggleFile}
          />
        </TabsContent>
        <TabsContent value="dropbox">
          <CloudFolderTab
            provider="dropbox"
            configured={cloudProviders.dropbox}
            isSelected={isSelected}
            onToggle={toggleFile}
          />
        </TabsContent>
        <TabsContent value="cloud">
          <CloudTab onAdd={(f) => setSelected((prev) => [...prev, f])} />
        </TabsContent>
      </Tabs>

      {/* Selected files + briefs */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            Selected videos {selected.length > 0 && <span className="text-muted-foreground">({selected.length})</span>}
            {mixIsLive && (
              <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                Randomized — this is the drop order
              </span>
            )}
          </h2>
          {selected.length > 1 && (
            <Button variant="outline" size="sm" onClick={onRandomize} disabled={randomizing}>
              {randomizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Dices className="h-4 w-4" />}
              {randomizing ? 'Randomizing…' : 'Randomize order'}
            </Button>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          Randomize shuffles the drop order so two clips shot in the same position never post
          back-to-back. The list below is the order they go out in.
        </p>
        {selected.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing selected yet. Pick renders, upload a file, or paste a cloud link above.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {selected.map((f) => (
              <div key={f.fileId} className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
                <SelectPreview file={f} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground" title={f.label}>
                      {f.label}
                    </p>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {f.source.kind}
                    </Badge>
                    {(() => {
                      // A render's filename is a nanoid, so the filename-derived
                      // "look" is meaningless for it — show the real shooting
                      // position whenever Randomize has resolved one.
                      const pos = positionByFile[f.fileId];
                      const key = pos || lookKeyForName(f.label);
                      const c = lookColor(key);
                      const known = pos && pos !== 'no-position';
                      return (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{ backgroundColor: c.bg, color: c.fg }}
                          title={known ? `Position ${pos.toUpperCase()}` : `Look: ${key || 'ungrouped'}`}
                        >
                          {known ? pos.toUpperCase() : lookLabel(key)}
                        </span>
                      );
                    })()}
                  </div>
                  <Textarea
                    value={f.brief}
                    onChange={(e) => setBrief(f.fileId, e.target.value)}
                    placeholder="Brief / topic (optional) — we transcribe the video and write captions from what's actually said; add a brief only for extra context the audio doesn't cover."
                    className="mt-2 min-h-[52px] text-sm"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${f.label}`}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setSelected((prev) => prev.filter((x) => x.fileId !== f.fileId))}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Channels + intent */}
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Channels</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Connected Postiz channels (TikTok / Instagram / YouTube) and PostPeer TikTok accounts
          appear here.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {channels.map((c) => {
            const on = selectedChannelIds.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  setSelectedChannelIds((prev) =>
                    on ? prev.filter((id) => id !== c.id) : [...prev, c.id],
                  )
                }
                aria-pressed={on}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                }`}
              >
                {c.picture ? (
                  <img src={c.picture} alt="" className="h-5 w-5 rounded-full object-cover" />
                ) : (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px]">
                    {c.name.slice(0, 1)}
                  </span>
                )}
                <span className="truncate max-w-32">{c.name}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {channelBadge(c.provider, c.platform, c.identifier)}
                </Badge>
              </button>
            );
          })}
        </div>

        <div className="mt-5 grid max-w-2xl gap-5 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Timing intent (optional)</label>
            <Select value={intent} onValueChange={(v) => setIntent(v as typeof intent)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Best per-platform windows</SelectItem>
                <SelectItem value="commute">Weekday commute (7–9am ET)</SelectItem>
                <SelectItem value="lunch">Lunch break (12–1pm ET)</SelectItem>
                <SelectItem value="evening">Evening scroll (7–9pm)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Campaign pace</label>
            <Select value={cadenceMode} onValueChange={(v) => setCadenceMode(v as BulkCadenceMode)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="steady">Steady — the same rate every day</SelectItem>
                <SelectItem value="warmup">Warm up — ramp up a new account</SelectItem>
              </SelectContent>
            </Select>

            {cadenceMode === 'steady' ? (
              <>
                <label
                  htmlFor="videos-per-day"
                  className="mt-3 flex items-center justify-between text-xs font-medium text-muted-foreground"
                >
                  <span>Videos per day</span>
                  <span className="tabular-nums text-foreground">{videosPerDay}/day</span>
                </label>
                <input
                  id="videos-per-day"
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={videosPerDay}
                  onChange={(e) => setVideosPerDay(Math.min(8, Math.max(1, Math.round(Number(e.target.value)))))}
                  className="mt-2 w-full accent-primary"
                />
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  How many videos drop each day. Each one posts to <em>all</em> selected accounts within the same 24h.
                  {selected.length > 0 && (
                    <> ~{Math.ceil(selected.length / Math.max(1, videosPerDay))} days to clear {selected.length} videos.</>
                  )}
                </p>
              </>
            ) : (
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-snug text-muted-foreground">
                <div className="mb-2 font-medium text-foreground">Ramps up from a standing start</div>
                <ul className="space-y-1">
                  <li>
                    <span className="tabular-nums text-foreground">Weeks 1–4</span> — 3 videos a week, on the same
                    days each week
                  </li>
                  <li>
                    <span className="tabular-nums text-foreground">Weeks 5–8</span> — 1 a day
                  </li>
                  <li>
                    <span className="tabular-nums text-foreground">Week 9 on</span> — 2 a day
                  </li>
                </ul>
                <p className="mt-2">
                  Every drop still posts to <em>all</em> selected accounts within the same 24h, so weeks 1–4 are 3
                  videos a week <em>per account</em>. The videos-per-day slider doesn&apos;t apply.
                </p>
                <p className="mt-2">
                  <span className="text-foreground">No call to action for the first 8 weeks</span>, then one post in
                  three asks for the comment keyword. The rest are pure value.
                </p>
                {selected.length > 0 && (
                  <p className="mt-2 text-foreground">
                    ~{warmUpDaysToClear(selected.length)} days to clear {selected.length} videos
                    {selected.length > 40 ? <> — only 40 of them land in the first 8 weeks.</> : <>.</>}
                  </p>
                )}
              </div>
            )}
          </div>
          <div>
            <label htmlFor="gap-days" className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>Min days between the same look</span>
              <span className="tabular-nums text-foreground">{minGapDays === 0 ? 'off' : `${minGapDays}d`}</span>
            </label>
            <input
              id="gap-days"
              type="range"
              min={0}
              max={14}
              step={1}
              value={minGapDays}
              onChange={(e) => setMinGapDays(Math.min(14, Math.max(0, Math.round(Number(e.target.value)))))}
              className="mt-2 w-full accent-primary"
            />
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Back-to-back clips are kept to different <em>shooting positions</em> automatically. This
              slider is the separate rule for <em>named looks</em>: two videos whose filenames share a
              look repeat no sooner than this many days apart.
            </p>
          </div>
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-[11px] leading-snug text-muted-foreground">
            The plan is <strong>shuffled</strong> so two clips from the same position never post
            back-to-back. <strong>Randomize order</strong> above pins an arrangement you can see;
            <strong> Reshuffle</strong> on the review step drops it for a fresh mix. We continue after
            each channel&apos;s existing queue and never schedule the same video to a channel twice.
            {selected.length > 0 && (() => {
              const known = selected.map((f) => positionByFile[f.fileId]).filter((p) => p && p !== 'no-position');
              const spots = new Set(known).size;
              return (
                <div className="mt-1 text-foreground">
                  {selected.length} videos
                  {spots > 0 && <> · {spots} position{spots === 1 ? '' : 's'} detected</>}
                </div>
              );
            })()}
          </div>
        </div>
      </section>

      {previewing && (
        <PlanProgress run={previewRun} startedAt={previewStartedAt} onCancel={onCancelPlan} />
      )}

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={previewing || selected.length === 0}>
          {previewing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {previewRun && previewRun.totalCount > 0
                ? `Building plan… ${previewRun.doneCount}/${previewRun.totalCount}`
                : 'Building plan…'}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> Generate plan <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function RendersTab({
  isSelected,
  onToggle,
}: {
  isSelected: (id: string) => boolean;
  onToggle: (f: SelectedFile) => void;
}) {
  const [renders, setRenders] = useState<Array<{ name: string; url?: string }> | null>(null);
  // Which tile is playing inline (one at a time), and which clip — if any — is
  // open in the popup player. Both are keyed by render name.
  const [inlineName, setInlineName] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ name: string; url: string } | null>(null);
  // Renders parked as "not posting this" (server-persisted, by filename), and
  // whether the collapsed drawer holding them is open.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  /** Renders already scheduled to every channel — filtered out, never hidden. */
  const [finished, setFinished] = useState<Set<string>>(new Set());
  useEffect(() => {
    listStorage({})
      .then((res: any) => {
        // Rendered videos now live in the "renderOutputs" storage area
        // (registry-driven areas replaced the old flat `outputs` list).
        const area = Array.isArray(res?.areas)
          ? res.areas.find((a: any) => a?.key === 'renderOutputs')
          : null;
        setRenders((area?.items ?? []).filter((o: any) => /\.mp4$/i.test(o.name)));
      })
      .catch(() => setRenders([]));
    // A failed load just means nothing is hidden — never block the picker on it.
    getHiddenRenders({})
      .then((res) => setHidden(new Set(res.names ?? [])))
      .catch(() => setHidden(new Set()));
    // Videos with nothing left to post. Kept SEPARATE from `hidden`: Hidden is
    // the operator's own "not posting this" drawer and must stay theirs, while
    // this is simply work that is done.
    bulkFinishedRenders({})
      .then((res) => setFinished(new Set(res.names ?? [])))
      .catch(() => setFinished(new Set()));
  }, []);

  /**
   * Hide or restore renders. The grid updates optimistically and the server's
   * authoritative list replaces it on success; a failure rolls back so the UI
   * never claims a clip is parked when the data dir refused the write.
   */
  const applyHidden = (names: string[], hide: boolean) => {
    if (names.length === 0) return;
    const before = hidden;
    const next = new Set(before);
    for (const n of names) (hide ? next.add(n) : next.delete(n));
    setHidden(next);
    if (hide) setInlineName((cur) => (cur && names.includes(cur) ? null : cur));
    setRenderHidden({ names, hidden: hide })
      .then((res) => setHidden(new Set(res.names ?? [])))
      .catch((e) => {
        setHidden(before);
        toast.error(e instanceof Error ? e.message : 'Failed to save the hidden list');
      });
  };

  /** Hiding a render also drops it from the selection, so it can't reach a plan. */
  const hideRender = (r: { name: string; url?: string }) => {
    const fileId = `render:${r.name}`;
    if (isSelected(fileId)) {
      onToggle({ fileId, source: { kind: 'render', ref: r.name }, label: r.name, brief: '', thumbUrl: r.url });
    }
    applyHidden([r.name], true);
  };

  if (!renders) {
    return (
      <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[9/16] rounded-lg" />
        ))}
      </div>
    );
  }
  if (renders.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        No rendered videos found. Create a Short first, then come back to schedule it.
      </p>
    );
  }
  const visible = renders.filter((r) => !hidden.has(r.name) && !finished.has(r.name));
  const hiddenRenders = renders.filter((r) => hidden.has(r.name));
  const finishedCount = renders.filter((r) => finished.has(r.name) && !hidden.has(r.name)).length;

  const asFile = (r: { name: string; url?: string }): SelectedFile => ({
    fileId: `render:${r.name}`,
    source: { kind: 'render', ref: r.name },
    label: r.name,
    brief: '',
    thumbUrl: r.url,
  });

  /**
   * Bulk select/deselect. It only ever touches the VISIBLE grid — a hidden
   * render is parked as "not posting this", so no bulk pick may sweep it into a
   * plan. Once everything visible is selected the same button clears them.
   */
  const unselected = visible.filter((r) => !isSelected(`render:${r.name}`));
  const allSelected = visible.length > 0 && unselected.length === 0;
  const toggleAllVisible = () => {
    for (const r of allSelected ? visible : unselected) onToggle(asFile(r));
  };

  return (
    <>
      {visible.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          {finishedCount > 0
            ? `Nothing left to schedule — all ${finishedCount} render${finishedCount === 1 ? ' is' : 's are'} already posted to every channel.`
            : 'Every render is hidden. Open the list below to bring one back.'}
        </p>
      ) : (
        <>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {finishedCount > 0 && <>{finishedCount} already scheduled — not offered here</>}
            {finishedCount > 0 && hiddenRenders.length > 0 && <> · </>}
            {hiddenRenders.length > 0 && <>{hiddenRenders.length} hidden — not offered here</>}
          </span>
          <Button variant="outline" size="sm" onClick={toggleAllVisible}>
            {allSelected ? <Square className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
            {allSelected
              ? `Deselect all (${visible.length} video${visible.length === 1 ? '' : 's'})`
              : `Select all (${visible.length} video${visible.length === 1 ? '' : 's'})`}
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
          {visible.map((r) => {
            const fileId = `render:${r.name}`;
            return (
              <RenderCard
                key={r.name}
                name={r.name}
                url={r.url}
                selected={isSelected(fileId)}
                playing={inlineName === r.name}
                onToggle={() => onToggle(asFile(r))}
                onPlay={() => setInlineName(r.name)}
                onStop={() => setInlineName((cur) => (cur === r.name ? null : cur))}
                onExpand={() => r.url && setLightbox({ name: r.name, url: r.url })}
                onHide={() => hideRender(r)}
              />
            );
          })}
        </div>
        </>
      )}

      {hiddenRenders.length > 0 && (
        <section className="mt-4 rounded-xl border border-border bg-muted/20">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              aria-expanded={showHidden}
              className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showHidden ? '' : '-rotate-90'}`}
              />
              <EyeOff className="h-4 w-4" />
              <span className="font-medium">Hidden ({hiddenRenders.length})</span>
              <span className="text-xs">— not offered for posting</span>
            </button>
            {showHidden && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => applyHidden(hiddenRenders.map((r) => r.name), false)}
              >
                <Eye className="h-4 w-4" /> Restore all
              </Button>
            )}
          </div>
          {showHidden && (
            <div className="grid grid-cols-3 gap-3 px-3 pb-3 sm:grid-cols-4 md:grid-cols-6">
              {hiddenRenders.map((r) => (
                <div
                  key={r.name}
                  className="group relative aspect-[9/16] overflow-hidden rounded-lg border border-border opacity-60 transition-opacity hover:opacity-100"
                >
                  {r.url ? (
                    <video src={r.url} className="h-full w-full bg-muted object-cover" muted preload="metadata" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-muted">
                      <Film className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/30 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <TileAction label={`Restore ${r.name}`} onClick={() => applyHidden([r.name], false)}>
                      <Eye className="h-4 w-4" />
                    </TileAction>
                    {r.url && (
                      <TileAction
                        label={`Open ${r.name} in the popup player`}
                        onClick={() => setLightbox({ name: r.name, url: r.url! })}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </TileAction>
                    )}
                  </div>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-left text-[10px] text-white">
                    {r.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {lightbox && (
        <VideoLightbox
          name={lightbox.name}
          url={lightbox.url}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

/** A small circular overlay control that floats above a grid tile. */
function TileAction({
  label,
  onClick,
  className = '',
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`pointer-events-auto z-10 rounded-full bg-black/65 p-1.5 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/90 focus:outline-none focus:ring-2 focus:ring-white/70 ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * One render in the picker grid. Clicking anywhere on the tile still toggles
 * selection; hovering reveals two controls:
 *   - Play  → plays the clip inline, with sound and native controls, right here
 *             in the grid (the parent keeps this to one tile at a time);
 *   - Expand → hands the clip to the popup player;
 *   - Hide   → parks the clip in the collapsed "Hidden" list so it stops being
 *             offered for posting (reversible; the file is never touched).
 * While a tile plays inline the whole-tile select target is disabled so the
 * video's own controls (scrub, volume, fullscreen) stay clickable.
 */
function RenderCard({
  name,
  url,
  selected,
  playing,
  onToggle,
  onPlay,
  onStop,
  onExpand,
  onHide,
}: {
  name: string;
  url?: string;
  selected: boolean;
  playing: boolean;
  onToggle: () => void;
  onPlay: () => void;
  onStop: () => void;
  onExpand: () => void;
  onHide: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Playback follows the parent's "which tile is playing" state, so starting one
  // clip rewinds and silences whichever was playing before.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.muted = false;
      // The click that set `playing` is the user gesture; if a browser still
      // refuses audible playback, fall back to a muted play rather than nothing.
      v.play().catch(() => {
        v.muted = true;
        v.play().catch(() => {});
      });
    } else {
      v.pause();
      v.muted = true;
      try {
        v.currentTime = 0;
      } catch {
        /* not seekable yet — nothing to rewind */
      }
    }
  }, [playing]);

  return (
    <div
      className={`group relative aspect-[9/16] overflow-hidden rounded-lg border-2 transition-colors ${
        selected ? 'border-primary' : 'border-transparent hover:border-border'
      }`}
    >
      {url ? (
        <video
          ref={videoRef}
          src={url}
          className={`h-full w-full bg-muted ${playing ? 'object-contain' : 'object-cover'}`}
          muted
          playsInline
          preload="metadata"
          controls={playing}
          onEnded={onStop}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted">
          <Film className="h-6 w-6 text-muted-foreground" />
        </div>
      )}

      {/* Whole-tile select target, sitting under the overlay controls. */}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={`${selected ? 'Deselect' : 'Select'} ${name}`}
        className={`absolute inset-0 ${playing ? 'pointer-events-none' : ''}`}
      />

      {selected && (
        <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-primary p-0.5 text-primary-foreground">
          <CheckCircle2 className="h-4 w-4" />
        </span>
      )}

      {!playing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/25 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {url && (
            <>
              <TileAction label={`Play ${name} here`} onClick={onPlay}>
                <Play className="h-4 w-4" />
              </TileAction>
              <TileAction label={`Open ${name} in the popup player`} onClick={onExpand}>
                <Maximize2 className="h-4 w-4" />
              </TileAction>
            </>
          )}
          <TileAction label={`Hide ${name} — don't post this one`} onClick={onHide}>
            <EyeOff className="h-4 w-4" />
          </TileAction>
        </div>
      )}

      {playing && (
        <TileAction
          label={`Stop playing ${name}`}
          onClick={onStop}
          className="absolute left-1.5 top-1.5"
        >
          <X className="h-4 w-4" />
        </TileAction>
      )}

      {!playing && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-left text-[10px] text-white">
          {name}
        </span>
      )}
    </div>
  );
}

/**
 * Popup player: a big, near-full-screen video over the picker that autoplays
 * with sound. Closes on the X, Esc, or a click outside (Radix Dialog handles the
 * last two); the native controls still offer real browser fullscreen.
 */
function VideoLightbox({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    // Opening the popup came from a click, so audible autoplay is normally
    // allowed; degrade to muted playback instead of failing silently.
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => {});
    });
  }, [url]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="w-auto max-w-[min(94vw,calc(86vh*9/16))] gap-0 border-0 bg-black p-0 sm:rounded-xl [&>button]:right-2 [&>button]:top-2 [&>button]:rounded-full [&>button]:bg-black/65 [&>button]:p-1.5 [&>button]:text-white [&>button]:opacity-90 [&>button]:hover:bg-black/90"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <video
          ref={videoRef}
          src={url}
          controls
          autoPlay
          playsInline
          className="max-h-[86vh] w-full bg-black object-contain"
        />
        <DialogTitle className="truncate px-3 py-2 text-left text-xs font-medium text-white/80">
          {name}
        </DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

function UploadTab({
  isSelected,
  onAdd,
}: {
  isSelected: (id: string) => boolean;
  onAdd: (f: SelectedFile) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const uploaded = await uploadFiles(Array.from(files));
      for (const u of uploaded) {
        const fileId = `upload:${u.id}`;
        if (isSelected(fileId)) continue;
        onAdd({
          fileId,
          source: { kind: 'upload', ref: u.id },
          label: u.original,
          brief: '',
          thumbUrl: u.url,
        });
      }
      toast.success(`Added ${uploaded.length} file(s).`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="mt-4">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-muted/20 p-10 text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
        <span className="text-sm font-medium">{busy ? 'Uploading…' : 'Click to upload videos'}</span>
        <span className="text-xs">MP4, no size cap. Added to your selection below.</span>
      </button>
    </div>
  );
}

function CloudTab({ onAdd }: { onAdd: (f: SelectedFile) => void }) {
  const [link, setLink] = useState('');
  const add = () => {
    const v = link.trim();
    if (!v) return;
    onAdd({
      fileId: `cloud:${v}`,
      source: { kind: 'cloud', ref: v },
      label: v.length > 48 ? `${v.slice(0, 48)}…` : v,
      brief: '',
    });
    setLink('');
    toast.success('Cloud link added.');
  };
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">
        Paste a public Dropbox or Google Drive share link. We convert it to a direct download URL and
        let Postiz pull the file.
      </p>
      <div className="flex gap-2">
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="https://drive.google.com/file/d/… or https://www.dropbox.com/s/…"
        />
        <Button onClick={add} disabled={!link.trim()}>
          <Link2 className="h-4 w-4" /> Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Prefer to browse? Use the <span className="font-medium text-foreground">Google Drive</span> or{' '}
        <span className="font-medium text-foreground">Dropbox</span> tabs to pick from a whole folder.
      </p>
    </div>
  );
}

/** Folder-name shown per provider in placeholders / labels. */
const CLOUD_TAB_META: Record<CloudProvider, { name: string; folderLabel: string; placeholder: string; help: string }> = {
  gdrive: {
    name: 'Google Drive',
    folderLabel: 'folder link or id',
    placeholder: 'https://drive.google.com/drive/folders/… or a folder id',
    help: 'Paste a PUBLIC ("anyone with the link") Drive folder. We list the videos inside it; each picked clip is fetched via its own direct download URL.',
  },
  dropbox: {
    name: 'Dropbox',
    folderLabel: 'folder path',
    placeholder: '/Videos/Shorts',
    help: "Enter a folder PATH in your Dropbox (e.g. /Videos/Shorts). We list the videos inside it and mint a direct download link per clip.",
  },
};

/**
 * Browse a Google Drive / Dropbox FOLDER (no-OAuth) and multi-select videos.
 * Gated on the provider's credentials being configured (from status); shows a
 * friendly "add your keys in Settings" empty state otherwise.
 */
function CloudFolderTab({
  provider,
  configured,
  isSelected,
  onToggle,
}: {
  provider: CloudProvider;
  configured: boolean;
  isSelected: (id: string) => boolean;
  onToggle: (f: SelectedFile) => void;
}) {
  const meta = CLOUD_TAB_META[provider];
  const [folder, setFolder] = useState('');
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<CloudFolderItem[] | null>(null);

  const browse = async () => {
    const f = folder.trim();
    if (!f) return;
    setLoading(true);
    try {
      const res = await listCloudFolder({ provider, folder: f });
      setItems(res.items);
      if (res.items.length === 0) toast.info('No videos found in that folder.');
    } catch (e) {
      setItems(null);
      toast.error(e instanceof Error ? e.message : 'Failed to browse the folder');
    } finally {
      setLoading(false);
    }
  };

  if (!configured) {
    return (
      <div className="mt-4 rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {provider === 'gdrive' ? <HardDrive className="h-5 w-5" /> : <Cloud className="h-5 w-5" />}
        </div>
        <p className="text-sm font-medium text-foreground">{meta.name} isn&apos;t connected yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          {provider === 'gdrive'
            ? 'Add your Drive API key to browse a public folder.'
            : 'Add your Dropbox app key, app secret and refresh token to browse a folder.'}{' '}
          Keys are stored write-only and never shown again.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <a href="/settings/postiz">
            <KeyRound className="h-4 w-4" /> Add keys in Settings
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted-foreground">{meta.help}</p>
      <div className="flex gap-2">
        <Input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && browse()}
          placeholder={meta.placeholder}
          aria-label={`${meta.name} ${meta.folderLabel}`}
        />
        <Button onClick={browse} disabled={loading || !folder.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Browse
        </Button>
      </div>

      {loading && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[9/16] rounded-lg" />
          ))}
        </div>
      )}

      {!loading && items && items.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          No videos in that folder. Check the {meta.folderLabel} and that the folder contains video files.
        </p>
      )}

      {!loading && items && items.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
          {items.map((it) => {
            const fileId = `cloud:${it.source.ref}`;
            const on = isSelected(fileId);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() =>
                  onToggle({
                    fileId,
                    source: it.source,
                    label: it.name,
                    brief: '',
                    thumbUrl: it.thumbnailUrl,
                    cloudUrl: it.source.ref,
                  })
                }
                aria-pressed={on}
                className={`group relative aspect-[9/16] overflow-hidden rounded-lg border-2 transition-colors ${
                  on ? 'border-primary' : 'border-transparent hover:border-border'
                }`}
              >
                {it.thumbnailUrl ? (
                  <img src={it.thumbnailUrl} alt="" className="h-full w-full object-cover bg-muted" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-muted">
                    <Film className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                {on && (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <CheckCircle2 className="h-4 w-4" />
                  </span>
                )}
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-left text-[10px] text-white">
                  {it.name}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Step 2: Review & optimize ────────────────────────────────────────────────
function StepReview({
  posts,
  setPosts,
  ctaKeyword,
  filesById,
  transcriptByFile,
  skippedPosts,
  continuedFrom,
  dropDateByFile,
  lookCount,
  cadenceMode,
  reshuffling,
  onReshuffle,
  onBack,
  onNext,
}: {
  posts: EditablePost[];
  setPosts: React.Dispatch<React.SetStateAction<EditablePost[]>>;
  /** The comment keyword captions must ask for (server-configured). */
  ctaKeyword: string;
  filesById: Map<string, SelectedFile>;
  transcriptByFile: Map<string, string | null>;
  skippedPosts: PreviewBulkScheduleOutputType['skippedPosts'];
  continuedFrom: PreviewBulkScheduleOutputType['continuedFrom'];
  dropDateByFile: Map<string, string | null>;
  lookCount: number;
  cadenceMode: BulkCadenceMode;
  reshuffling: boolean;
  onReshuffle: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const update = (i: number, patch: Partial<EditablePost>) =>
    setPosts((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const [filling, setFilling] = useState(false);
  const [fillProgress, setFillProgress] = useState<{ done: number; total: number } | null>(null);

  /** Files the server says were captioned without the video's audio. */
  const [transcriptGaps, setTranscriptGaps] = useState<Set<string>>(new Set());
  /** Files captioned BEFORE the current voice — they read fine but aren't Jake. */
  const [voiceGaps, setVoiceGaps] = useState<Set<string>>(new Set());
  useEffect(() => {
    void bulkTranscriptGaps({})
      .then((r) => setTranscriptGaps(new Set(r.fileIds)))
      .catch(() => setTranscriptGaps(new Set()));
    void bulkVoiceGaps({})
      .then((r) => setVoiceGaps(new Set(r.fileIds)))
      .catch(() => setVoiceGaps(new Set()));
  }, []);

  /**
   * Every way a caption can fail the CURRENT rules. A plan is built once and
   * reviewed later, by which time the rules may have moved — captions written
   * before the comment-keyword CTA carry a community URL and no CTA at all, and
   * they are cached, so they would otherwise survive every rebuild untouched.
   */
  const captionProblem = (p: EditablePost): string | null => {
    const text = p.caption || '';
    if (!text.trim()) return 'no caption';
    // A link is dead weight on TikTok/IG/Shorts and throttles a Facebook Page.
    if (/https?:\/\/|\bwww\./i.test(text)) return 'contains a link';
    // Meta demotes posts that explicitly solicit likes/saves/shares.
    if (/\b(like (this|the post|it)|double tap|save this post|share this post)\b/i.test(text)) {
      return 'asks for likes';
    }
    // A warm-up post in weeks 1–4 ships with no ask ON PURPOSE. Flagging it here
    // would make the Fix button rewrite the CTA straight back in, undoing the
    // quiet period the campaign pace exists to create.
    if (!p.ctaSuppressed && !new RegExp(`\\b${ctaKeyword}\\b`, 'i').test(text)) {
      return `no "${ctaKeyword}" CTA`;
    }
    // Reads fine, but was written blind: transcription failed for this video, so
    // the caption is grounded in the brief instead of what she actually says.
    // Re-transcribing and re-writing it is the same repair, so it belongs here.
    if (transcriptGaps.has(p.fileId)) return 'captioned without the audio';
    // Reads fine by every rule above and yet isn't Jake: written before the
    // bar-Jake voice existed. The tell-strip already took the em-dashes off, so
    // the text LOOKS current — only the stored voice stamp knows. Last, so a
    // caption with a substantive defect reports that instead.
    if (voiceGaps.has(p.fileId)) return 'not in your voice yet';
    return null;
  };

  const needsWork = useMemo(
    () =>
      posts
        .map((p, index) => ({ p, index, problem: captionProblem(p) }))
        .filter((x) => x.problem !== null),
    // captionProblem reads ctaKeyword, transcriptGaps AND voiceGaps — both gap
    // lists arrive from the server a moment after mount, so they MUST be
    // dependencies or the memo keeps its first (gap-free) answer and those
    // videos never show up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [posts, ctaKeyword, transcriptGaps, voiceGaps],
  );

  /** Counts per problem, so the panel can say what it is about to change. */
  const problemCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of needsWork) m.set(x.problem!, (m.get(x.problem!) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [needsWork]);

  /**
   * Write captions for just the blank posts, reusing a stored caption where one
   * exists. Rebuilding the whole plan to recover a few of these would re-do all
   * the work and re-spend on every video that was already fine.
   */
  /**
   * Bring every off-guideline caption up to the current rules in one pass.
   *
   * Anything already written is REGENERATED rather than reused: the stored
   * caption is exactly the thing that is wrong (old CTA, a link, no CTA), so a
   * cache hit would hand the same text straight back. Blank posts have nothing
   * to preserve and take the normal path. Captions that already pass are left
   * completely alone — no spend, no churn on text you may have hand-edited.
   */
  /** Run a set of files through the caption writer in short batches. */
  const rewriteFiles = async (
    fileIds: string[],
    opts: { force: boolean; label: string },
  ): Promise<void> => {
    const files = fileIds
      .map((fileId) => {
        const f = filesById.get(fileId);
        if (!f) return null;
        const platforms = Array.from(
          new Set(posts.filter((p) => p.fileId === fileId).map((p) => p.platform)),
        );
        if (!platforms.length) return null;
        return { fileId, source: f.source, brief: f.brief, platforms, force: opts.force };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (!files.length) {
      toast.error('Those posts’ videos are no longer in the picker, so they cannot be rewritten.');
      return;
    }

    setFilling(true);
    setFillProgress({ done: 0, total: files.length });
    let applied = 0;
    let failed = 0;
    let firstError = '';
    try {
      for (let i = 0; i < files.length; ) {
        const batch = files.slice(i, i + BULK_FIX_BATCH);
        const res = await fillBulkCaptions({ files: batch });
        const touched = new Set(batch.map((b) => b.fileId));
        setPosts((prev) =>
          prev.map((p) => {
            if (!touched.has(p.fileId)) return p;
            const c = res.captions?.[p.fileId]?.[p.platform];
            if (!c || !c.caption.trim()) return p;
            applied++;
            return { ...p, caption: c.caption, hashtags: c.hashtags, firstLineHook: c.firstLineHook };
          }),
        );
        if (res.failures?.length) {
          failed += res.failures.length;
          firstError = firstError || res.failures[0].error;
        }
        i += batch.length;
        setFillProgress({ done: Math.min(i, files.length), total: files.length });
      }
      if (applied) toast.success(`${opts.label} — ${applied} caption${applied === 1 ? '' : 's'} updated.`);
      else toast.info('Nothing could be written — see the errors below.');
      if (failed) toast.error(`${failed} file${failed === 1 ? '' : 's'} failed: ${firstError}`);
      // The gaps may have closed now that transcription works — and a rewrite
      // stamps the current voice, so the voice gaps close too.
      void bulkTranscriptGaps({})
        .then((r) => setTranscriptGaps(new Set(r.fileIds)))
        .catch(() => {});
      void bulkVoiceGaps({})
        .then((r) => setVoiceGaps(new Set(r.fileIds)))
        .catch(() => {});
    } catch (e) {
      toast.error(
        (e instanceof Error ? e.message : 'Could not rewrite the captions.') +
          (applied ? ` ${applied} were updated before it stopped — press again to continue.` : ''),
      );
    } finally {
      setFilling(false);
      setFillProgress(null);
    }
  };

  /**
   * Bring every flagged caption up to the current rules in one pass — including
   * re-transcribing the videos whose audio never made it in (the fill path
   * transcribes when no transcript is stored, and retries once).
   *
   * `force` is always on: every reason a post is flagged means the STORED
   * caption is the thing that is wrong, so a cache hit would hand the same text
   * straight back. Captions that already pass are never touched.
   */
  const fixCaptions = () =>
    rewriteFiles(Array.from(new Set(needsWork.map(({ p }) => p.fileId))), {
      force: true,
      label: 'Rewritten to the current guidelines',
    });

  // Group rows by file for a tidy review.
  const byFile = useMemo(() => {
    const map = new Map<string, Array<{ post: EditablePost; index: number }>>();
    posts.forEach((post, index) => {
      const list = map.get(post.fileId) ?? [];
      list.push({ post, index });
      map.set(post.fileId, list);
    });
    return Array.from(map.entries());
  }, [posts]);

  // Items still blocked by Growth Guardrails (required-fail, not overridden).
  const blockedCount = useMemo(
    () => posts.filter((p) => isGrowthBlocked(p.growth) && !p.override).length,
    [posts],
  );

  // Schedule map: each drop day → the looks dropping that day (one entry per
  // distinct video). Drives the "mix" preview so the user can see looks spread out.
  const scheduleMap = useMemo(() => {
    const groupByFile = new Map<string, string>();
    for (const p of posts) if (!groupByFile.has(p.fileId)) groupByFile.set(p.fileId, p.groupId);
    const byDay = new Map<string, Array<{ fileId: string; groupId: string; label: string }>>();
    for (const [fileId, day] of dropDateByFile) {
      if (!day) continue;
      const groupId = groupByFile.get(fileId);
      if (groupId === undefined) continue; // fully de-duped file (no live post)
      const label = filesById.get(fileId)?.label ?? fileId;
      const list = byDay.get(day) ?? [];
      list.push({ fileId, groupId, label });
      byDay.set(day, list);
    }
    return Array.from(byDay.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }, [posts, dropDateByFile, filesById]);

  return (
    <div className="space-y-6">
      {needsWork.length > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {needsWork.length} caption{needsWork.length === 1 ? '' : 's'} don&apos;t match the
                current guidelines
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {problemCounts.map(([reason, n], i) => (
                  <span key={reason}>
                    {i > 0 && ' · '}
                    {n} {reason}
                  </span>
                ))}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Rewrites just these, in place — captions that already pass are left untouched,
                and nothing is re-transcribed.
              </p>
            </div>
            <Button size="sm" onClick={fixCaptions} disabled={filling}>
              {filling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {fillProgress
                    ? `Rewriting… ${fillProgress.done}/${fillProgress.total} videos`
                    : 'Rewriting…'}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Fix {needsWork.length} caption
                  {needsWork.length === 1 ? '' : 's'}
                </>
              )}
            </Button>
          </div>
        </section>
      )}

      {scheduleMap.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Drop schedule</h3>
              <p className="text-[11px] text-muted-foreground">
                {scheduleMap.reduce((n, [, v]) => n + v.length, 0)} videos · {lookCount} look{lookCount === 1 ? '' : 's'} ·
                {' '}{scheduleMap.length} day{scheduleMap.length === 1 ? '' : 's'} · {formatLocalDay(scheduleMap[0][0])} → {formatLocalDay(scheduleMap[scheduleMap.length - 1][0])}
              </p>
              {cadenceMode === 'warmup' && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  <Badge variant="outline" className="mr-1.5 align-middle text-[10px]">Warm up</Badge>
                  3 a week for 4 weeks, then 1 a day, then 2 a day. The gaps below are rest days, not missing
                  videos. No CTA for the first 8 weeks, then one post in three.
                </p>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={onReshuffle} disabled={reshuffling}>
              {reshuffling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
              Reshuffle
            </Button>
          </div>
          <div className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {scheduleMap.map(([day, vids]) => (
              <div key={day} className="flex items-start gap-3 text-xs">
                <span className="w-24 shrink-0 pt-0.5 tabular-nums text-muted-foreground">{formatLocalDay(day)}</span>
                <div className="flex flex-wrap gap-1.5">
                  {vids.map((v) => {
                    const c = lookColor(v.groupId);
                    return (
                      <span
                        key={v.fileId}
                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{ backgroundColor: c.bg, color: c.fg }}
                        title={v.label}
                      >
                        {lookLabel(v.groupId)}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {blockedCount > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {blockedCount} post{blockedCount === 1 ? '' : 's'} fail a required Growth Guardrail and can&apos;t
            be scheduled. Fix the caption/video below, or toggle{' '}
            <span className="font-medium">override</span> on the item to schedule it anyway.
          </p>
        </div>
      )}

      {continuedFrom.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" />
          <p>
            Continuing your queue: {continuedFrom.length === 1 ? (
              <>
                <span className="font-medium text-foreground">{continuedFrom[0].channelName}</span> picks up
                from <span className="font-medium text-foreground">{formatLocalDay(continuedFrom[0].fromLocalDay)}</span>.
              </>
            ) : (
              <>
                {continuedFrom.length} channels pick up after their already-scheduled posts (
                {continuedFrom.map((c) => c.channelName).join(', ')}).
              </>
            )}{' '}
            New posts are appended at up to your per-day cap.
          </p>
        </div>
      )}

      {skippedPosts.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              {skippedPosts.length} already scheduled — skipped
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              These videos are already in the queue for their channel, so they weren&apos;t added again:{' '}
              {skippedPosts
                .map((s) => `${s.fileId.replace(/^(render|upload|cloud):/, '')} → ${s.channelName}`)
                .join('; ')}
              .
            </p>
          </div>
        </div>
      )}
      {byFile.map(([fileId, rows]) => {
        const file = filesById.get(fileId);
        return (
          <section key={fileId} className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start gap-4">
              {file && <ReviewPreview file={file} />}
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={fileId}>
                {file?.label ?? fileId.replace(/^(render|upload|cloud):/, '')}
              </h2>
            </div>
            <FileTranscript transcript={transcriptByFile.get(fileId) ?? null} />
            <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {rows.map(({ post, index }) => (
                <PostCard key={`${post.fileId}-${post.channelId}`} post={post} onChange={(patch) => update(index, patch)} />
              ))}
            </div>
          </section>
        );
      })}

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={onNext} disabled={posts.length === 0 || blockedCount > 0}>
          Review schedule <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Read-only, collapsible transcript a file's captions were generated FROM. When
 * null (no speech detected / transcription unavailable) we say so — the captions
 * fell back to the brief. Display only: editing to force regen is out of scope.
 */
function FileTranscript({ transcript }: { transcript: string | null }) {
  const [open, setOpen] = useState(false);
  const hasText = Boolean(transcript && transcript.trim());

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          Transcript
          <span className={hasText ? 'text-muted-foreground' : 'text-amber-500'}>
            · {hasText ? 'captions grounded in what was said' : 'no speech detected — used your brief'}
          </span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-1.5 rounded-md border border-border bg-background p-2.5">
          {hasText ? (
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {transcript}
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              No speech was detected in this video (or transcription was unavailable), so the captions
              were written from your brief and project metadata instead.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PostCard({ post, onChange }: { post: EditablePost; onChange: (patch: Partial<EditablePost>) => void }) {
  const local = useMemo(() => formatLocal(post.scheduledAt), [post.scheduledAt]);
  const blocked = isGrowthBlocked(post.growth);
  return (
    <div className={`rounded-lg border bg-background p-3 ${blocked && !post.override ? 'border-destructive/40' : 'border-border'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Badge variant="secondary" className="text-[10px]">
            {channelBadge(post.provider, post.platform, post.identifier)}
          </Badge>
          <span className="truncate max-w-28 text-muted-foreground">{post.channelName}</span>
        </span>
        {post.growth && <GrowthScore score={post.growth.score} />}
      </div>

      {post.growth && (
        <GrowthChecklist
          growth={post.growth}
          override={!!post.override}
          onToggleOverride={(v) => onChange({ override: v })}
        />
      )}

      <label className="text-[11px] font-medium text-muted-foreground">Caption</label>
      <Textarea
        value={post.caption}
        onChange={(e) => onChange({ caption: e.target.value })}
        className="mt-1 min-h-[96px] text-sm"
      />

      <label className="mt-2 block text-[11px] font-medium text-muted-foreground">Hashtags (space-separated)</label>
      <Input
        value={post.hashtags.join(' ')}
        onChange={(e) =>
          onChange({ hashtags: e.target.value.split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean) })
        }
        className="mt-1 text-sm font-mono"
      />

      {post.tiktok && <TikTokControls tiktok={post.tiktok} onChange={(t) => onChange({ tiktok: t })} />}

      <label className="mt-2 block text-[11px] font-medium text-muted-foreground">Scheduled time (local)</label>
      <Input
        type="datetime-local"
        value={toInputLocal(post.scheduledAt)}
        onChange={(e) => onChange({ scheduledAt: fromInputLocal(e.target.value) })}
        className="mt-1 text-sm"
      />
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        {local} — {post.reason}
      </p>
    </div>
  );
}

// ── Growth Guardrails UI ─────────────────────────────────────────────────────
/** Color a 0–100 Growth Score by band (success / warning / destructive). */
function scoreTone(score: number): { text: string; bg: string; ring: string } {
  if (score >= 80) return { text: 'text-[hsl(var(--chart-3))]', bg: 'bg-[hsl(var(--chart-3))]/10', ring: 'border-[hsl(var(--chart-3))]/30' };
  if (score >= 55) return { text: 'text-amber-500', bg: 'bg-amber-500/10', ring: 'border-amber-500/30' };
  return { text: 'text-destructive', bg: 'bg-destructive/10', ring: 'border-destructive/30' };
}

function GrowthScore({ score }: { score: number }) {
  const t = scoreTone(score);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${t.ring} ${t.bg} ${t.text}`}
      title="Growth Score — caption + video best-practices"
    >
      <Gauge className="h-3 w-3" /> {score}
    </span>
  );
}

/** Expandable pass/fail checklist with per-item override for required failures. */
function GrowthChecklist({
  growth,
  override,
  onToggleOverride,
}: {
  growth: Growth;
  override: boolean;
  onToggleOverride: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const blocked = isGrowthBlocked(growth);
  const failCount = growth.checks.filter((c) => c.pass === false).length;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          Growth checklist
          {failCount > 0 && (
            <span className={blocked ? 'text-destructive' : 'text-amber-500'}>
              · {failCount} to improve
            </span>
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ul className="mt-1.5 space-y-1.5 rounded-md border border-border bg-background p-2.5">
          {growth.checks.map((c) => (
            <GrowthCheckRow key={c.id} check={c} />
          ))}
        </ul>
      )}

      {blocked && (
        <label className="mt-1.5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-foreground">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => onToggleOverride(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-[hsl(var(--destructive))]"
          />
          <span>
            <span className="font-medium text-destructive">Override &amp; schedule anyway</span> — this post
            fails a required guardrail.
          </span>
        </label>
      )}
    </div>
  );
}

function GrowthCheckRow({ check }: { check: GrowthCheck }) {
  // Icon by state: unknown → muted help; pass → success; fail → severity color.
  const Icon =
    check.pass === null ? HelpCircle : check.pass ? CheckCircle2 : check.severity === 'required' ? XCircle : AlertTriangle;
  const tone =
    check.pass === null
      ? 'text-muted-foreground'
      : check.pass
      ? 'text-[hsl(var(--chart-3))]'
      : check.severity === 'required'
      ? 'text-destructive'
      : 'text-amber-500';
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
      <span className="min-w-0">
        <span className="font-medium text-foreground">{check.label}</span>
        {check.severity !== 'required' && (
          <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {check.severity === 'unknown' ? 'n/a' : 'tip'}
          </span>
        )}
        {check.pass !== true && (
          <span className="block text-muted-foreground">{check.hint}</span>
        )}
      </span>
    </li>
  );
}

/** TikTok Direct-Post controls (PostPeer items): privacy + interaction/disclosure toggles. */
function TikTokControls({
  tiktok,
  onChange,
}: {
  tiktok: NonNullable<EditablePost['tiktok']>;
  onChange: (t: NonNullable<EditablePost['tiktok']>) => void;
}) {
  const set = (patch: Partial<NonNullable<EditablePost['tiktok']>>) => onChange({ ...tiktok, ...patch });
  const toggles: Array<{ key: 'allowComment' | 'allowDuet' | 'allowStitch'; label: string }> = [
    { key: 'allowComment', label: 'Comments' },
    { key: 'allowDuet', label: 'Duet' },
    { key: 'allowStitch', label: 'Stitch' },
  ];
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/20 p-2.5">
      <p className="text-[11px] font-semibold text-foreground">TikTok options</p>

      <label className="mt-2 block text-[11px] font-medium text-muted-foreground">Privacy</label>
      <Select value={tiktok.privacyLevel} onValueChange={(v) => set({ privacyLevel: v })}>
        <SelectTrigger className="mt-1 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIKTOK_PRIVACY_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {toggles.map((t) => {
          const on = tiktok[t.key];
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={on}
              onClick={() => set({ [t.key]: !on })}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {on ? `${t.label} on` : `${t.label} off`}
            </button>
          );
        })}
      </div>

      <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={tiktok.commercialContent}
          onChange={(e) => set({ commercialContent: e.target.checked })}
          className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
        />
        Disclose commercial / branded content
      </label>
    </div>
  );
}

// ── Step 3: Schedule ─────────────────────────────────────────────────────────
function StepSchedule({
  posts,
  channels,
  results,
  scheduling,
  postizUrl,
  onBack,
  onSchedule,
  onRetry,
}: {
  posts: EditablePost[];
  channels: BulkChannel[];
  results: RunBulkScheduleOutputType | null;
  scheduling: boolean;
  postizUrl: string | null;
  onBack: () => void;
  onSchedule: () => void;
  onRetry: () => void;
}) {
  const channelCount = new Set(posts.map((p) => p.channelId)).size;
  const range = useMemo(() => dateRange(posts.map((p) => p.scheduledAt)), [posts]);
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? id;
  const resultByKey = useMemo(
    () => new Map((results?.results ?? []).map((r) => [`${r.fileId}|${r.channelId}`, r])),
    [results],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Summary</h2>
        <p className="mt-1 text-2xl font-bold text-foreground">
          {posts.length} post{posts.length === 1 ? '' : 's'}{' '}
          <span className="text-base font-medium text-muted-foreground">
            across {channelCount} channel{channelCount === 1 ? '' : 's'}
            {range && `, ${range}`}
          </span>
        </p>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Video</th>
              <th className="px-4 py-2 font-medium">Channel</th>
              <th className="px-4 py-2 font-medium">Growth</th>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => {
              const r = resultByKey.get(`${p.fileId}|${p.channelId}`);
              return (
                <tr key={`${p.fileId}-${p.channelId}`} className="border-b border-border/60 last:border-0">
                  <td className="max-w-40 truncate px-4 py-2 text-foreground" title={p.fileId}>
                    {p.fileId.replace(/^(render|upload|cloud):/, '')}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="secondary" className="mr-1.5 text-[10px]">
                      {channelBadge(p.provider, p.platform, p.identifier)}
                    </Badge>
                    <span className="text-muted-foreground">{channelName(p.channelId)}</span>
                  </td>
                  <td className="px-4 py-2">
                    {p.growth ? (
                      <span className="inline-flex items-center gap-1.5">
                        <GrowthScore score={p.growth.score} />
                        {p.override && isGrowthBlocked(p.growth) && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-500">overridden</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{formatLocal(p.scheduledAt)}</td>
                  <td className="px-4 py-2 text-right">
                    {!results ? (
                      <span className="text-muted-foreground">Pending</span>
                    ) : r?.ok ? (
                      <span className="inline-flex items-center gap-1 text-[hsl(var(--chart-3))]">
                        <CheckCircle2 className="h-4 w-4" /> Scheduled
                      </span>
                    ) : (r?.blockedChecks?.length ?? 0) > 0 ? (
                      <span
                        className="inline-flex items-center gap-1 text-destructive"
                        title={r?.error}
                      >
                        <ShieldCheck className="h-4 w-4" /> Blocked
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-destructive" title={r?.error}>
                        <XCircle className="h-4 w-4" /> Failed
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {results && results.failed > 0 && (
        <section className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-destructive">
                {results.failed} post{results.failed === 1 ? '' : 's'} failed
                {results.scheduled > 0 && ` · ${results.scheduled} scheduled`}
                {(results.skippedDuplicates ?? 0) > 0 &&
                  ` · ${results.skippedDuplicates} already scheduled, skipped`}
              </p>
              {/* The reasons, grouped. Hovering hundreds of rows to find out they
                  all say the same thing is not a diagnosis. */}
              <ul className="mt-1 space-y-0.5 text-xs text-destructive/90">
                {Array.from(
                  results.results
                    .filter((r) => !r.ok && !r.duplicate)
                    .reduce((m, r) => {
                      const key = (r.error || 'unknown error').trim();
                      m.set(key, (m.get(key) ?? 0) + 1);
                      return m;
                    }, new Map<string, number>()),
                )
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 4)
                  .map(([reason, n]) => (
                    <li key={reason}>
                      <span className="tabular-nums font-medium">{n}×</span> {reason}
                    </li>
                  ))}
              </ul>
            </div>
            <Button variant="outline" size="sm" onClick={onRetry} disabled={scheduling}>
              <RefreshCw className={`h-4 w-4 ${scheduling ? 'animate-spin' : ''}`} />
              {scheduling ? 'Retrying…' : `Retry ${results.failed} failure${results.failed === 1 ? '' : 's'}`}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-destructive/80">
            Only the failures are re-sent — posts that already went out are recorded and skipped, so
            nothing is duplicated.
          </p>
        </section>
      )}

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack} disabled={scheduling}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="flex items-center gap-2">
          {results && results.failed > 0 && (
            <Button variant="outline" onClick={onRetry} disabled={scheduling}>
              <RefreshCw className={`h-4 w-4 ${scheduling ? 'animate-spin' : ''}`} /> Retry failures
            </Button>
          )}
          {results && results.scheduled > 0 && postizUrl && (
            <Button variant="outline" asChild>
              <a href={postizUrl} target="_blank" rel="noreferrer">
                View in Postiz <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
          {(!results || results.failed === posts.length) && (
            <Button onClick={onSchedule} disabled={scheduling || posts.length === 0}>
              {scheduling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Scheduling…
                </>
              ) : (
                <>
                  <CalendarClock className="h-4 w-4" /> Schedule all
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── date helpers ───────────────────────────────────────────────────────────
function formatLocal(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** "YYYY-MM-DD" (audience local day) → a friendly "Mon, Jun 8" label. */
function formatLocalDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  // Build a noon-local date so timezone shifts can't roll it to the prior day.
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime())
    ? day
    : dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** ISO → value for <input type="datetime-local"> in the browser's local zone. */
function toInputLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (local zone) → ISO-UTC string. */
function fromInputLocal(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

function dateRange(isos: string[]): string | null {
  const times = isos.map((i) => new Date(i).getTime()).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  const min = new Date(Math.min(...times));
  const max = new Date(Math.max(...times));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return fmt(min) === fmt(max) ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}
