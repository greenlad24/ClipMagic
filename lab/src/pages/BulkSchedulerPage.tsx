import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from 'zite-auth-sdk';
import {
  getBulkSchedulerStatus,
  previewBulkSchedule,
  runBulkSchedule,
  getServiceStatus,
  listStorage,
  type GetBulkSchedulerStatusOutputType,
  type BulkChannel,
  type BulkProvider,
  type BulkPreviewPost,
  type PreviewBulkScheduleOutputType,
  type RunBulkScheduleOutputType,
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
interface SelectedFile {
  fileId: string;
  source: FileSource;
  label: string;
  brief: string;
  thumbUrl?: string;
}

// Editable preview row (a copy of a BulkPreviewPost the user can tweak). The
// local-only `override` lets the user opt past a Growth Guardrails block.
type EditablePost = BulkPreviewPost & { override?: boolean };

/** True when a Growth result has a measured, failing `required` check. */
function isGrowthBlocked(growth: Growth | undefined): boolean {
  return !!growth?.checks.some((c) => c.severity === 'required' && c.pass === false);
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

export default function BulkSchedulerPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<GetBulkSchedulerStatusOutputType | null>(null);
  const [postizUrl, setPostizUrl] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
  const [intent, setIntent] = useState<'none' | 'commute' | 'lunch' | 'evening'>('none');

  // Step 2
  const [posts, setPosts] = useState<EditablePost[]>([]);
  const [previewing, setPreviewing] = useState(false);

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

  // Auto-select all connected channels once loaded.
  useEffect(() => {
    if (connectedChannels.length && selectedChannelIds.length === 0) {
      setSelectedChannelIds(connectedChannels.map((c) => c.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedChannels]);

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

  // ── Step transitions ──────────────────────────────────────────────────────
  const goPreview = async () => {
    if (selected.length === 0) {
      toast.info('Select at least one video first.');
      return;
    }
    if (selectedChannelIds.length === 0) {
      toast.info('Select at least one channel.');
      return;
    }
    setPreviewing(true);
    try {
      const res: PreviewBulkScheduleOutputType = await previewBulkSchedule({
        files: selected.map((f) => ({ source: f.source, brief: f.brief, fileId: f.fileId, label: f.label })),
        channelIds: selectedChannelIds,
        intent: intent === 'none' ? undefined : intent,
      });
      setPosts(res.posts);
      if (res.skippedChannels.length) {
        toast.info(`${res.skippedChannels.length} channel(s) skipped (not connected).`);
      }
      setStep(2);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build the plan');
    } finally {
      setPreviewing(false);
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to schedule');
    } finally {
      setScheduling(false);
    }
  };

  const retryFailures = async () => {
    if (!results) return;
    const failedKeys = new Set(results.results.filter((r) => !r.ok).map((r) => `${r.fileId}|${r.channelId}`));
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
            selected={selected}
            setSelected={setSelected}
            selectedChannelIds={selectedChannelIds}
            setSelectedChannelIds={setSelectedChannelIds}
            intent={intent}
            setIntent={setIntent}
            onNext={goPreview}
            previewing={previewing}
          />
        )}

        {step === 2 && (
          <StepReview
            posts={posts}
            setPosts={setPosts}
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
  selected,
  setSelected,
  selectedChannelIds,
  setSelectedChannelIds,
  intent,
  setIntent,
  onNext,
  previewing,
}: {
  channels: BulkChannel[];
  selected: SelectedFile[];
  setSelected: React.Dispatch<React.SetStateAction<SelectedFile[]>>;
  selectedChannelIds: string[];
  setSelectedChannelIds: React.Dispatch<React.SetStateAction<string[]>>;
  intent: 'none' | 'commute' | 'lunch' | 'evening';
  setIntent: (v: 'none' | 'commute' | 'lunch' | 'evening') => void;
  onNext: () => void;
  previewing: boolean;
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
        <TabsContent value="cloud">
          <CloudTab onAdd={(f) => setSelected((prev) => [...prev, f])} />
        </TabsContent>
      </Tabs>

      {/* Selected files + briefs */}
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Selected videos {selected.length > 0 && <span className="text-muted-foreground">({selected.length})</span>}
        </h2>
        {selected.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing selected yet. Pick renders, upload a file, or paste a cloud link above.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {selected.map((f) => (
              <div key={f.fileId} className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
                {f.thumbUrl ? (
                  <video
                    src={f.thumbUrl}
                    className="h-16 w-10 shrink-0 rounded-md object-cover bg-muted"
                    muted
                    preload="metadata"
                  />
                ) : (
                  <div className="flex h-16 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Film className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground" title={f.label}>
                      {f.label}
                    </p>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {f.source.kind}
                    </Badge>
                  </div>
                  <Textarea
                    value={f.brief}
                    onChange={(e) => setBrief(f.fileId, e.target.value)}
                    placeholder="Brief / topic — what's this video about? (auto-seeded from project metadata when available)"
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

        <div className="mt-5 max-w-xs">
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
      </section>

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={previewing || selected.length === 0}>
          {previewing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Building plan…
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
  useEffect(() => {
    listStorage({})
      .then((res: any) => setRenders((res.outputs ?? []).filter((o: any) => /\.mp4$/i.test(o.name))))
      .catch(() => setRenders([]));
  }, []);

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
  return (
    <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
      {renders.map((r) => {
        const fileId = `render:${r.name}`;
        const on = isSelected(fileId);
        return (
          <button
            key={r.name}
            type="button"
            onClick={() =>
              onToggle({
                fileId,
                source: { kind: 'render', ref: r.name },
                label: r.name,
                brief: '',
                thumbUrl: r.url,
              })
            }
            className={`group relative aspect-[9/16] overflow-hidden rounded-lg border-2 transition-colors ${
              on ? 'border-primary' : 'border-transparent hover:border-border'
            }`}
          >
            {r.url ? (
              <video src={r.url} className="h-full w-full object-cover bg-muted" muted preload="metadata" />
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
              {r.name}
            </span>
          </button>
        );
      })}
    </div>
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
        Full Dropbox/Drive pickers (browse &amp; pick) are coming in a later phase.
      </p>
    </div>
  );
}

// ── Step 2: Review & optimize ────────────────────────────────────────────────
function StepReview({
  posts,
  setPosts,
  onBack,
  onNext,
}: {
  posts: EditablePost[];
  setPosts: React.Dispatch<React.SetStateAction<EditablePost[]>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const update = (i: number, patch: Partial<EditablePost>) =>
    setPosts((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

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

  return (
    <div className="space-y-6">
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
      {byFile.map(([fileId, rows]) => (
        <section key={fileId} className="rounded-xl border border-border bg-card p-5">
          <h2 className="truncate text-sm font-semibold text-foreground" title={fileId}>
            {fileId.replace(/^(render|upload|cloud):/, '')}
          </h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {rows.map(({ post, index }) => (
              <PostCard key={`${post.fileId}-${post.channelId}`} post={post} onChange={(patch) => update(index, patch)} />
            ))}
          </div>
        </section>
      ))}

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
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {results.failed} post(s) failed. Hover the status for the error, then retry just the failures.
        </p>
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
