import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  engageStatus,
  engageListThreads,
  engageKillSwitch,
  engageRefreshStats,
  type EngageStatus,
  type EngagePlatform,
  type EngageInboxKind,
  type EngageThreadSort,
  type ChannelStats,
  type InboxItem,
  type InboxThread,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import { cn } from '@/lib/utils';
import {
  MessagesSquare,
  Youtube,
  Instagram,
  Facebook,
  Music2,
  Send,
  Users,
  MessageSquare,
  Heart,
  Bot,
  Clock,
  Check,
  Pencil,
  ExternalLink,
  RefreshCw,
  KeyRound,
  Settings,
  AlertTriangle,
  ArrowDownUp,
  ChevronDown,
} from 'lucide-react';

/**
 * Engagement Manager (LAB tool) — a simplified channel-column monitor.
 *
 * A minimal top bar + a horizontal board of channel columns (one per surface).
 * Phase 1 is LIVE for YouTube comments only: comments + audience/engagement
 * stats are polled every 2s, and a single Bot Active/Paused control (the
 * kill-switch, inverted) sits top-right. YouTube is MONITOR-ONLY here — our tool
 * does not send YouTube replies (make.com does), so live YouTube cards never show
 * a fake bot reply. The bot-reply bubble + inline reply editor are built as real
 * components but only appear on the phase-gated preview columns (Instagram /
 * Facebook / TikTok), exactly like the other coming-soon pieces.
 */

const POLL_MS = 2000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function relTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** 47_200 → "47.2K", 8_900_000 → "8.9M", null → null. */
function fmtNum(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** Short relative time for a card ("2m", "31m", "3h"). */
function shortTime(ms: number | null | undefined): string {
  if (ms == null) return '';
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const AVATAR_COLORS = ['#2f6f4f', '#5a4bd0', '#b0842f', '#8a5cc0', '#3f7cbf', '#b0503f'];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

// ── Column visual identity ───────────────────────────────────────────────────
const GRADIENTS: Record<EngagePlatform, string> = {
  youtube: 'linear-gradient(135deg,hsl(var(--chart-5)),#7a1533)',
  instagram: 'linear-gradient(135deg,hsl(var(--chart-5)),hsl(var(--chart-4)))',
  facebook: 'linear-gradient(135deg,hsl(var(--chart-2)),#1f5f86)',
  tiktok: 'linear-gradient(135deg,#333,#111)',
};

function PlatformGlyph({ platform, dm }: { platform: EngagePlatform; dm?: boolean }) {
  const Icon = dm
    ? Send
    : platform === 'youtube'
      ? Youtube
      : platform === 'instagram'
        ? Instagram
        : platform === 'facebook'
          ? Facebook
          : Music2;
  return (
    <div
      className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] text-white"
      style={{ background: GRADIENTS[platform] }}
    >
      <Icon className="h-[15px] w-[15px]" strokeWidth={2} />
    </div>
  );
}

// ── Stats strip ──────────────────────────────────────────────────────────────
function StatValue({ value }: { value: string | null }) {
  return value == null ? (
    <b className="font-semibold text-muted-foreground/70 tabular-nums">—</b>
  ) : (
    <b className="font-semibold text-foreground tabular-nums">{value}</b>
  );
}

function StatsStrip({
  stats,
  audienceLabel,
}: {
  stats: ChannelStats | null;
  audienceLabel: string;
}) {
  return (
    <div className="flex shrink-0 gap-3.5 border-b border-border bg-card/70 px-3.5 py-2">
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Users className="h-3 w-3 shrink-0 opacity-65" />
        <StatValue value={fmtNum(stats?.audience)} />
        <span className="opacity-70">{audienceLabel}</span>
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquare className="h-3 w-3 shrink-0 opacity-65" />
        <StatValue value={fmtNum(stats?.comments)} />
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Heart className="h-3 w-3 shrink-0 opacity-65" />
        <StatValue value={fmtNum(stats?.likes)} />
      </span>
    </div>
  );
}

// ── Bot reply bubble (preview columns only) ──────────────────────────────────
type ReplyVariant = 'replied' | 'pending' | 'edited';
interface ReplyData {
  variant: ReplyVariant;
  text: string;
  ago?: string;
}

function ReplyBubble({ reply }: { reply: ReplyData }) {
  const isPending = reply.variant === 'pending';
  const isEdited = reply.variant === 'edited';
  const accent = isPending ? 'chart-4' : isEdited ? 'chart-2' : 'chart-3';
  const HeadIcon = isPending ? Clock : isEdited ? Check : Bot;
  const head =
    reply.variant === 'pending'
      ? 'Bot is replying…'
      : reply.variant === 'edited'
        ? `You edited${reply.ago ? ` · ${reply.ago}` : ''}`
        : `Bot replied${reply.ago ? ` · ${reply.ago}` : ''}`;
  return (
    <div
      className={cn(
        'mt-2.5 rounded-r-lg border-l-2 py-2 pl-2.5 pr-2.5',
        `border-l-[hsl(var(--${accent}))]/50 bg-[hsl(var(--${accent}))]/[0.06]`,
      )}
    >
      <div
        className={cn(
          'mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold',
          `text-[hsl(var(--${accent}))]`,
        )}
      >
        <HeadIcon className="h-3 w-3" />
        {head}
      </div>
      <div className={cn('text-[12.5px] text-foreground/90', isPending && 'opacity-70')}>
        {reply.text}
      </div>
    </div>
  );
}

// ── Inline reply editor (preview columns only) ───────────────────────────────
function InlineEditor({
  initialText,
  placeholder,
  saveLabel,
  onCancel,
  onSave,
}: {
  initialText: string;
  placeholder?: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(initialText);
  return (
    <div className="mt-2.5">
      <textarea
        autoFocus
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        className="h-16 w-full resize-none rounded-lg border border-primary/50 bg-input p-2 text-[12.5px] text-foreground outline-none"
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(text)}
          className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-primary px-2.5 py-1 text-[11.5px] font-semibold text-primary-foreground"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

/** Small ghost action button used in card hover rows. */
function CardAction({
  children,
  onClick,
  primary,
  href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  href?: string;
}) {
  const className = cn(
    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors',
    primary
      ? 'border-primary/40 text-primary hover:bg-primary/10'
      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {children}
    </button>
  );
}

// ── One reply row inside a thread's transcript (nested beneath the root) ──────
function ReplyRow({ item }: { item: InboxItem }) {
  const author = item.authorName || item.authorHandle || 'Unknown';
  const handle = item.authorHandle ? `@${item.authorHandle}` : '';
  return (
    <div className="flex gap-2">
      <div
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10.5px] font-bold text-white"
        style={{ background: avatarColor(author) }}
      >
        {initial(author)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">{author}</span>
          {handle && <span className="truncate text-[10.5px] text-muted-foreground">{handle}</span>}
          <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
            {shortTime(item.postedAt)}
          </span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-foreground/90">
          {item.text}
        </p>
      </div>
    </div>
  );
}

// How many trailing replies to show before a long thread collapses.
const REPLY_COLLAPSE_AT = 3;
const REPLY_COLLAPSED_TAIL = 2;

// ── LIVE thread card (root comment + its nested reply transcript) ─────────────
// Monitor-only: real YouTube data carries no bot reply, so no reply/edit surface
// is rendered here — the ReplyBubble/InlineEditor components stay reserved for
// real reply data in later phases.
function ThreadCard({
  thread,
  reviewed,
  onReview,
  dm,
}: {
  thread: InboxThread;
  reviewed: boolean;
  onReview: () => void;
  /** DM conversation: subsequent items are messages in a transcript, not "replies". */
  dm?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { root, replies, replyCount } = thread;
  const author = root.authorName || root.authorHandle || 'Unknown';
  const handle = root.authorHandle ? `@${root.authorHandle}` : '';

  const collapsible = replies.length > REPLY_COLLAPSE_AT;
  const visibleReplies =
    collapsible && !expanded ? replies.slice(replies.length - REPLY_COLLAPSED_TAIL) : replies;

  return (
    <div
      className={cn(
        'group rounded-[11px] border border-border bg-card p-3 transition-opacity',
        reviewed && 'opacity-55',
      )}
    >
      {/* Root comment */}
      <div className="flex items-center gap-2">
        <div
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold text-white"
          style={{ background: avatarColor(author) }}
        >
          {initial(author)}
        </div>
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{author}</span>
        {handle && <span className="truncate text-[11px] text-muted-foreground">{handle}</span>}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {shortTime(root.postedAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] text-foreground">{root.text}</p>
      {root.targetTitle && (
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="shrink-0">▸</span>
          <span className="truncate">{root.targetTitle}</span>
        </div>
      )}

      {/* Reply transcript — nested beneath the root with a left rule */}
      {replyCount > 0 && (
        <div className="mt-2.5">
          <div className="mb-1.5 text-[10.5px] font-medium text-muted-foreground">
            {replyCount}{' '}
            {dm
              ? replyCount === 1
                ? 'message'
                : 'messages'
              : replyCount === 1
                ? 'reply'
                : 'replies'}
          </div>
          <div className="flex flex-col gap-2.5 border-l border-border pl-3">
            {collapsible && !expanded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="self-start text-[11px] text-[hsl(var(--chart-2))] transition-colors hover:underline"
              >
                Show all {replyCount} {dm ? 'messages' : 'replies'}
              </button>
            )}
            {visibleReplies.map((r) => (
              <ReplyRow key={r.id} item={r} />
            ))}
            {collapsible && expanded && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="self-start text-[11px] text-muted-foreground transition-colors hover:underline"
              >
                Show fewer
              </button>
            )}
          </div>
        </div>
      )}

      {/* Root actions */}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        {reviewed ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[hsl(var(--chart-3))]">
            <Check className="h-3 w-3" /> Reviewed
          </span>
        ) : (
          <span className="flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <CardAction onClick={onReview}>
              <Check className="h-3 w-3" /> Mark reviewed
            </CardAction>
          </span>
        )}
        {root.permalink && (
          <CardAction href={root.permalink}>
            Open <ExternalLink className="h-3 w-3" />
          </CardAction>
        )}
      </div>
    </div>
  );
}

// ── Per-column sort control ──────────────────────────────────────────────────
const SORT_OPTIONS: { value: EngageThreadSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'active', label: 'Most active' },
  { value: 'replies', label: 'Most replies' },
];

/** Compact muted dropdown in a live column's header — sorts that channel's threads. */
function SortControl({
  value,
  onChange,
}: {
  value: EngageThreadSort;
  onChange: (v: EngageThreadSort) => void;
}) {
  return (
    <div className="relative inline-flex items-center">
      <ArrowDownUp className="pointer-events-none absolute left-1.5 h-3 w-3 text-muted-foreground/70" />
      <select
        aria-label="Sort comments"
        value={value}
        onChange={(e) => onChange(e.target.value as EngageThreadSort)}
        className="h-6 cursor-pointer appearance-none rounded-md border border-border bg-card/60 pl-6 pr-5 text-[10.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus:border-primary/40"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 h-3 w-3 text-muted-foreground/70" />
    </div>
  );
}

// ── Column shell ─────────────────────────────────────────────────────────────
function Column({
  platform,
  name,
  kindLabel,
  dm,
  live,
  count,
  phaseTag,
  stats,
  audienceLabel,
  hideStats,
  soon,
  headerAction,
  children,
}: {
  platform: EngagePlatform;
  name: string;
  kindLabel: string;
  dm?: boolean;
  live?: boolean;
  count?: number | null;
  phaseTag?: string;
  stats: ChannelStats | null;
  audienceLabel: string;
  /** DM columns omit the audience/engagement strip to stay clean. */
  hideStats?: boolean;
  soon?: boolean;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex max-h-full w-[340px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-border bg-card/40">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-card px-3.5">
        <PlatformGlyph platform={platform} dm={dm} />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-tight text-foreground">{name}</div>
          <div className="text-[10.5px] text-muted-foreground">{kindLabel}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {headerAction}
          {count != null && (
            <span className="text-[11px] font-bold tabular-nums text-muted-foreground">{count}</span>
          )}
          {phaseTag ? (
            <span className="rounded-[5px] border border-border px-1.5 py-px text-[9.5px] text-muted-foreground">
              {phaseTag}
            </span>
          ) : (
            live && <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-[hsl(var(--chart-3))]" />
          )}
        </div>
      </div>
      {!hideStats && <StatsStrip stats={stats} audienceLabel={audienceLabel} />}
      <div
        className={cn(
          'flex flex-1 flex-col gap-2.5 overflow-y-auto p-2.5',
          soon && 'pointer-events-none opacity-45',
        )}
      >
        {children}
      </div>
    </section>
  );
}

function ConnectRow({ text }: { text: string }) {
  return <div className="px-3.5 py-3.5 text-center text-[12px] text-muted-foreground">{text}</div>;
}

// ── Platform ordering + labels ───────────────────────────────────────────────
// Connected columns render in this order (youtube, instagram, facebook, tiktok);
// the "connect" placeholders for absent platforms trail after them.
const PLATFORM_ORDER: EngagePlatform[] = ['youtube', 'instagram', 'facebook', 'tiktok'];
function platformRank(p: EngagePlatform): number {
  const i = PLATFORM_ORDER.indexOf(p);
  return i < 0 ? PLATFORM_ORDER.length : i;
}
const PLATFORM_LABEL: Record<EngagePlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};
/** YouTube counts subscribers; everything else counts followers. */
function audienceLabelFor(p: EngagePlatform): string {
  return p === 'youtube' ? 'subscribers' : 'followers';
}
/** Only Instagram and Facebook expose direct messages; YouTube/TikTok stay comments-only. */
function supportsDm(p: EngagePlatform): boolean {
  return p === 'instagram' || p === 'facebook';
}
/** Feeds & per-column sort are keyed by channel + kind so a channel's comments and DMs stay separate. */
function feedKey(channelId: string, kind: EngageInboxKind): string {
  return `${channelId}:${kind}`;
}

// ── Not-yet-connected platform columns ───────────────────────────────────────
// Structural placeholders shown ONLY for platforms with no connected channel yet
// (IG/FB/TikTok). Once a real channel for a platform exists in status.channels,
// its live column replaces the placeholder. These render an honest empty state —
// no sample cards, no fabricated stats, no fake bot replies. Stats are always
// null (rendered as "—") until the platform is actually connected.
interface PlaceholderColumn {
  platform: Exclude<EngagePlatform, 'youtube'>;
  name: string;
  phaseTag: string;
  connectText: string;
}

// Order here mirrors PLATFORM_ORDER; only platforms absent from status.channels
// are rendered (TikTok stays a placeholder until Phase 5).
const PLACEHOLDER_COLUMNS: PlaceholderColumn[] = [
  {
    platform: 'instagram',
    name: 'Instagram',
    phaseTag: 'Phase 3',
    connectText: 'Connect Instagram to start monitoring.',
  },
  {
    platform: 'facebook',
    name: 'Facebook',
    phaseTag: 'Phase 3',
    connectText: 'Connect Facebook to start monitoring.',
  },
  {
    platform: 'tiktok',
    name: 'TikTok',
    phaseTag: 'Phase 5',
    connectText: 'Connect TikTok to start monitoring.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function EngagementManagerPage() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<EngageStatus | null>(null);
  const [feeds, setFeeds] = useState<Record<string, { threads: InboxThread[]; total: number }>>({});
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [togglingBot, setTogglingBot] = useState(false);
  // Per-column sort, keyed by channelId (default 'newest'). A ref mirrors it so
  // the polling `tick` always reads the latest sort without re-arming the timer.
  const [sorts, setSorts] = useState<Record<string, EngageThreadSort>>({});
  const sortsRef = useRef<Record<string, EngageThreadSort>>({});
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(async () => {
    try {
      const s = await engageStatus({});
      setStatus(s);
      // Poll one feed per (channel, kind): comments for every connected channel,
      // plus DMs for channels whose platform supports them (Instagram / Facebook).
      const jobs: { key: string; channelId: string; kind: EngageInboxKind }[] = [];
      for (const c of s.channels) {
        jobs.push({ key: feedKey(c.id, 'comment'), channelId: c.id, kind: 'comment' });
        if (supportsDm(c.platform)) {
          jobs.push({ key: feedKey(c.id, 'dm'), channelId: c.id, kind: 'dm' });
        }
      }
      const results = await Promise.all(
        jobs.map(async (j) => {
          try {
            const sort = sortsRef.current[j.key] ?? 'newest';
            const r = await engageListThreads({ channelId: j.channelId, kind: j.kind, sort });
            return [j.key, { threads: r.threads, total: r.total }] as const;
          } catch {
            return [j.key, null] as const;
          }
        }),
      );
      setFeeds((prev) => {
        const next = { ...prev };
        for (const [key, r] of results) if (r) next[key] = r;
        return next;
      });
    } catch {
      /* transient — keep the last good snapshot */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void tick();
    // Best-effort one-shot stats refresh — a graceful no-op if the backend
    // handler isn't deployed yet (stats also arrive via engageStatus channels).
    void engageRefreshStats({}).catch(() => {});
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(() => void tick(), POLL_MS);
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [tick]);

  // Change a column's sort, then re-query immediately (the 2s poll picks it up
  // via sortsRef afterwards).
  const changeSort = useCallback(
    (key: string, sort: EngageThreadSort) => {
      sortsRef.current = { ...sortsRef.current, [key]: sort };
      setSorts((prev) => ({ ...prev, [key]: sort }));
      void tick();
    },
    [tick],
  );

  const botActive = !status?.killSwitch;

  const toggleBot = async () => {
    if (!status) return;
    const nextKill = !status.killSwitch; // active = killSwitch:false
    setTogglingBot(true);
    setStatus((prev) => (prev ? { ...prev, killSwitch: nextKill } : prev)); // optimistic
    try {
      const r = await engageKillSwitch({ killSwitch: nextKill });
      setStatus((prev) => (prev ? { ...prev, killSwitch: r.killSwitch } : prev));
      toast.success(r.killSwitch ? 'Bot paused' : 'Bot active');
    } catch (e) {
      setStatus((prev) => (prev ? { ...prev, killSwitch: !nextKill } : prev));
      toast.error(e instanceof Error ? e.message : 'Could not update the bot');
    } finally {
      setTogglingBot(false);
    }
  };

  const channels = status?.channels ?? [];
  // Live columns: one per real connected channel, ordered by platform.
  const liveChannels = [...channels].sort((a, b) => platformRank(a.platform) - platformRank(b.platform));
  const connectedPlatforms = new Set(channels.map((c) => c.platform));
  const hasYoutube = connectedPlatforms.has('youtube');
  // "Connect" placeholders only for platforms with NO connected channel yet.
  const placeholders = PLACEHOLDER_COLUMNS.filter((p) => !connectedPlatforms.has(p.platform));

  return (
    <Layout breadcrumb="Engagement">
      <div className="relative flex h-[calc(100vh-3.25rem)] flex-col overflow-hidden">
        {/* ── Minimal top bar ─────────────────────────────────────────────── */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-[18px]">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[hsl(var(--chart-2))]/[0.12] text-[hsl(var(--chart-2))]">
            <MessagesSquare className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-bold tracking-tight text-foreground">Engagement</div>
            <div className="truncate text-[11.5px] text-muted-foreground">
              Monitoring comments &amp; DMs across your channels
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[12px] text-muted-foreground sm:inline-flex">
              <RefreshCw className="h-[13px] w-[13px] opacity-70" />
              Synced {relTime(status?.lastPollAt ?? null)}
            </span>
            {/* Replies live on their own page — this board stays a clean monitor. */}
            <Link
              to="/engagement/replies"
              className="inline-flex items-center gap-1.5 rounded-[9px] border border-border bg-card px-3 py-[7px] text-[12.5px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Bot className="h-[14px] w-[14px]" />
              Replies
            </Link>
            <button
              type="button"
              onClick={() => void toggleBot()}
              disabled={togglingBot || !status}
              className={cn(
                'inline-flex items-center gap-2.5 rounded-[9px] border px-3 py-[7px] text-[12.5px] font-semibold transition-colors disabled:opacity-60',
                botActive
                  ? 'border-[hsl(var(--chart-3))]/40 bg-[hsl(var(--chart-3))]/[0.08] text-[hsl(var(--chart-3))]'
                  : 'border-primary/50 bg-primary/10 text-primary',
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  botActive ? 'animate-pulse bg-[hsl(var(--chart-3))]' : 'bg-primary',
                )}
              />
              {botActive ? 'Bot active' : 'Bot paused'}
              <span
                className={cn(
                  'relative h-[18px] w-[34px] rounded-full transition-colors',
                  botActive ? 'bg-[hsl(var(--chart-3))]/35' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all',
                    botActive ? 'left-[18px]' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          </div>
        </header>

        {/* ── Config / error banners ──────────────────────────────────────── */}
        {status?.lastError && (
          <div className="flex shrink-0 items-start gap-2 border-b border-[hsl(var(--chart-5))]/30 bg-[hsl(var(--chart-5))]/10 px-[18px] py-2 text-[12px] text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-5))]" />
            <span>
              <span className="font-medium">Last check reported an issue:</span> {status.lastError}
            </span>
          </div>
        )}
        {status && !status.youtubeConfigured && (
          <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-[18px] py-2.5 text-[12px]">
            <KeyRound className="h-4 w-4 shrink-0 text-[hsl(var(--chart-5))]" />
            <span className="min-w-0 flex-1 text-muted-foreground">
              <span className="font-medium text-foreground">Connect your YouTube Data API key</span> to
              begin monitoring comments — the same key the Thumbnail Designer and Keyword Research use.
            </span>
            <Link
              to="/settings/postiz"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings className="h-3.5 w-3.5" /> Configure key
            </Link>
          </div>
        )}

        {/* ── Board ───────────────────────────────────────────────────────── */}
        <div className="flex flex-1 gap-3.5 overflow-x-auto overflow-y-hidden p-4">
          {loading && !status ? (
            <div className="flex items-center gap-2 px-2 text-[13px] text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading channels…
            </div>
          ) : (
            <>
              {/* Live columns — comments for every channel, plus a DMs column for
                  channels whose platform supports DMs (Instagram / Facebook). */}
              {liveChannels.map((c) => {
                const name = c.displayName || c.handle || PLATFORM_LABEL[c.platform];
                const commentKey = feedKey(c.id, 'comment');
                const commentFeed = feeds[commentKey];
                const commentThreads = commentFeed?.threads ?? [];
                const dmKey = feedKey(c.id, 'dm');
                const dmFeed = feeds[dmKey];
                const dmThreads = dmFeed?.threads ?? [];
                const markReviewed = (id: string) =>
                  setReviewed((prev) => new Set(prev).add(id));
                return (
                  <Fragment key={c.id}>
                    {/* Comments column */}
                    <Column
                      platform={c.platform}
                      name={name}
                      kindLabel="Comments"
                      live
                      count={commentFeed?.total ?? commentThreads.length}
                      stats={c.stats}
                      audienceLabel={audienceLabelFor(c.platform)}
                      headerAction={
                        <SortControl
                          value={sorts[commentKey] ?? 'newest'}
                          onChange={(v) => changeSort(commentKey, v)}
                        />
                      }
                    >
                      {commentThreads.length === 0 ? (
                        <ConnectRow text="No comments yet — new ones appear here as they arrive." />
                      ) : (
                        commentThreads.map((thread) => (
                          <ThreadCard
                            key={thread.root.id}
                            thread={thread}
                            reviewed={reviewed.has(thread.root.id)}
                            onReview={() => markReviewed(thread.root.id)}
                          />
                        ))
                      )}
                    </Column>

                    {/* DMs column — Instagram / Facebook only, next to comments */}
                    {supportsDm(c.platform) && (
                      <Column
                        platform={c.platform}
                        name={name}
                        kindLabel="Direct messages"
                        dm
                        live
                        count={dmFeed?.total ?? dmThreads.length}
                        stats={c.stats}
                        audienceLabel={audienceLabelFor(c.platform)}
                        hideStats
                        headerAction={
                          <SortControl
                            value={sorts[dmKey] ?? 'newest'}
                            onChange={(v) => changeSort(dmKey, v)}
                          />
                        }
                      >
                        {dmThreads.length === 0 ? (
                          <ConnectRow text="No messages yet — new conversations appear here as they arrive." />
                        ) : (
                          dmThreads.map((thread) => (
                            <ThreadCard
                              key={thread.root.id}
                              thread={thread}
                              dm
                              reviewed={reviewed.has(thread.root.id)}
                              onReview={() => markReviewed(thread.root.id)}
                            />
                          ))
                        )}
                      </Column>
                    )}
                  </Fragment>
                );
              })}

              {/* YouTube key is set but no channel has synced yet */}
              {!hasYoutube && status?.youtubeConfigured && (
                <Column
                  platform="youtube"
                  name="YouTube"
                  kindLabel="Comments"
                  stats={null}
                  audienceLabel="subscribers"
                  soon
                >
                  <ConnectRow text="No YouTube channel connected yet." />
                </Column>
              )}

              {/* Absent platforms — honest "connect" placeholders (stats "—") */}
              {placeholders.map((col) => (
                <Column
                  key={col.platform}
                  platform={col.platform}
                  name={col.name}
                  kindLabel="Comments"
                  phaseTag={col.phaseTag}
                  stats={null}
                  audienceLabel={audienceLabelFor(col.platform)}
                  soon
                >
                  <ConnectRow text={col.connectText} />
                </Column>
              ))}
            </>
          )}
        </div>

        {/* ── Honest phase note ───────────────────────────────────────────── */}
        <div className="pointer-events-none absolute bottom-3.5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-[10px] border border-border bg-card px-3.5 py-2 text-[12px] text-muted-foreground shadow-lg">
          <MessagesSquare className="h-3.5 w-3.5" />
          <span>
            <b className="font-semibold text-foreground">YouTube live</b>; Instagram &amp; Facebook
            comments &amp; DMs monitored once connected; replies later phases.
          </span>
        </div>
      </div>
    </Layout>
  );
}
