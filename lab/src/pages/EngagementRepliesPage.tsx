import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  engageReplyStatus,
  engageListReplies,
  engageGetReplyPrompt,
  engageUpdateSettings,
  engageApproveReply,
  engageRejectReply,
  engageReplyCycleNow,
  engageBrowserOpen,
  engageBrowserFrame,
  engageBrowserClick,
  engageBrowserType,
  engageBrowserKey,
  engageBrowserScroll,
  engageBrowserDrag,
  engageBrowserNavigate,
  engageBrowserVerify,
  engageBrowserClose,
  type EngagePlatform,
  type EngageReplyStatus,
  type EngageReplyStatusOutput,
  type EngageReplyQueueEntry,
  type EngageBrowserFrame,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import { cn } from '@/lib/utils';
import {
  Instagram,
  Facebook,
  Music2,
  Bot,
  Check,
  X,
  Send,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Clock,
  ExternalLink,
  Loader2,
  ArrowLeft,
  Monitor,
  KeyRound,
} from 'lucide-react';

/** The three platforms replies can be sent on. YouTube is monitor-only. */
const BROWSER_PLATFORMS: EngagePlatform[] = ['instagram', 'facebook', 'tiktok'];

const PLATFORM_META: Record<string, { label: string; Icon: typeof Instagram; color: string }> = {
  instagram: { label: 'Instagram', Icon: Instagram, color: '#E1306C' },
  facebook: { label: 'Facebook', Icon: Facebook, color: '#1877F2' },
  tiktok: { label: 'TikTok', Icon: Music2, color: '#111827' },
};

/** Each platform's dedicated login page, for the console's shortcut button. */
const LOGIN_URL: Record<string, string> = {
  instagram: 'https://www.instagram.com/accounts/login/',
  facebook: 'https://www.facebook.com/login/',
  tiktok: 'https://www.tiktok.com/login/phone-or-email/email',
};

const STATUS_TABS: Array<{ key: EngageReplyStatus; label: string }> = [
  { key: 'draft', label: 'Needs review' },
  { key: 'pending', label: 'Queued' },
  { key: 'sent', label: 'Sent' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
];

function timeAgo(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function whenLabel(ts: number): string {
  const delta = ts - Date.now();
  if (delta <= 0) return 'now';
  const m = Math.round(delta / 60000);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}

/** One of the safety keys, rendered as a chip. */
function SafetyChip({
  on,
  onLabel,
  offLabel,
  good,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  /** Which state is the SAFE one — drives the colour, not the on/off value. */
  good: 'on' | 'off';
}) {
  const isGood = good === 'on' ? on : !on;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        isGood
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      )}
    >
      {isGood ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
      {on ? onLabel : offLabel}
    </span>
  );
}

export default function EngagementRepliesPage() {
  const [status, setStatus] = useState<EngageReplyStatusOutput | null>(null);
  const [tab, setTab] = useState<EngageReplyStatus>('draft');
  const [entries, setEntries] = useState<EngageReplyQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [console_, setConsole] = useState<EngagePlatform | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await engageReplyStatus({}));
    } catch {
      /* transient — the poll will retry */
    }
  }, []);

  const refreshQueue = useCallback(async (which: EngageReplyStatus) => {
    try {
      const out = await engageListReplies({ status: which, limit: 50 });
      setEntries(out.entries);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not load the reply queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void engageGetReplyPrompt({})
      .then((r) => setPrompt(r.replyPromptMd))
      .catch(() => undefined);
    const t = setInterval(() => void refreshStatus(), 5000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => {
    setLoading(true);
    void refreshQueue(tab);
    const t = setInterval(() => void refreshQueue(tab), 8000);
    return () => clearInterval(t);
  }, [tab, refreshQueue]);

  const savePrompt = async () => {
    setSavingPrompt(true);
    try {
      await engageUpdateSettings({ replyPromptMd: prompt });
      setPromptDirty(false);
      toast.success('Reply voice saved.');
      void refreshStatus();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the prompt.');
    } finally {
      setSavingPrompt(false);
    }
  };

  const approve = async (replyId: string, sendNow: boolean) => {
    setBusyId(replyId);
    try {
      const out = await engageApproveReply({ replyId, text: edits[replyId], now: sendNow });
      if (out.holdReason) toast.warning(`Queued, but held: ${out.holdReason}`);
      else toast.success(sendNow ? 'Approved — sending now.' : 'Approved and queued.');
      void refreshQueue(tab);
      void refreshStatus();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not approve the reply.');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (replyId: string) => {
    setBusyId(replyId);
    try {
      await engageRejectReply({ replyId });
      toast.success('Rejected — this one will not be sent.');
      void refreshQueue(tab);
      void refreshStatus();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not reject the reply.');
    } finally {
      setBusyId(null);
    }
  };

  const runCycle = async () => {
    try {
      const out = await engageReplyCycleNow({});
      toast[out.started ? 'success' : 'warning'](out.message ?? 'Reply cycle started.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not start a reply cycle.');
    }
  };

  const counts = status?.counts;

  return (
    <Layout breadcrumb="Engagement · Replies">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              to="/engagement"
              className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" /> Back to the monitor
            </Link>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Replies</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Drafted in your voice, reviewed by you, posted on Instagram, Facebook and TikTok.
            </p>
          </div>
          <button
            onClick={runCycle}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" /> Run a cycle now
          </button>
        </div>

        {/* Safety keys */}
        {status && (
          <div className="mb-6 rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldCheck className="h-4 w-4" /> Safety
            </div>
            <div className="flex flex-wrap gap-2">
              <SafetyChip on={status.killSwitch} onLabel="Bot paused" offLabel="Bot active" good="on" />
              <SafetyChip
                on={status.globalAutoreply}
                onLabel="Autoreply on"
                offLabel="Autoreply off"
                good="off"
              />
              <SafetyChip on={status.dryRun} onLabel="Dry run" offLabel="Live posting" good="on" />
              <SafetyChip
                on={status.replyPromptSet}
                onLabel="Voice set"
                offLabel="No voice yet"
                good="on"
              />
              <SafetyChip on={status.aiConfigured} onLabel="AI ready" offLabel="No AI key" good="on" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Nothing is posted unless <b>all</b> of these line up: the bot is active, autoreply is on, the
              channel is set to <b>auto</b>, dry run is off, and the platform is under its hourly and daily
              caps. Anything set to <b>suggest</b> waits for you here.
            </p>
            <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={status.globalAutoreply}
                onChange={async (e) => {
                  try {
                    await engageUpdateSettings({ globalAutoreply: e.target.checked });
                    void refreshStatus();
                  } catch (err: any) {
                    toast.error(err?.message ?? 'Could not update the setting.');
                  }
                }}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-muted-foreground">
                Allow approved replies to dispatch automatically
              </span>
            </label>
          </div>
        )}

        {/* Voice prompt */}
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Bot className="h-4 w-4" /> Your reply voice
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Paste the prompt you use for your YouTube comment replies. Every draft is written from this —
            with no prompt stored, reply generation stays switched off entirely.
          </p>
          <textarea
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setPromptDirty(true);
            }}
            rows={10}
            spellCheck={false}
            placeholder="You are Jake Dawson replying to comments on your videos…"
            className="w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-primary"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={savePrompt}
              disabled={!promptDirty || savingPrompt}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {savingPrompt ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save voice
            </button>
            {promptDirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
          </div>
        </div>

        {/* Connected browsers */}
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="h-4 w-4" /> Signed-in accounts
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Replies are typed into the real site, so each account needs a one-time login in the built-in
            browser. Your password goes straight into the platform's own login form — it is never sent to,
            or stored by, this server.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {BROWSER_PLATFORMS.map((platform) => {
              const meta = PLATFORM_META[platform];
              const b = status?.browsers.find((x) => x.platform === platform);
              const usage = status?.usage.find((u) => u.platform === platform);
              return (
                <div key={platform} className="rounded-lg border border-border bg-background p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <meta.Icon className="h-4 w-4" style={{ color: meta.color }} />
                    <span className="text-sm font-medium text-foreground">{meta.label}</span>
                  </div>
                  <div className="mb-2 text-xs">
                    {!b?.available ? (
                      <span className="text-muted-foreground">Browser unavailable on this box</span>
                    ) : b.loggedIn === true ? (
                      <span className="text-emerald-500">Signed in</span>
                    ) : b.loggedIn === false ? (
                      <span className="text-amber-500">Signed out</span>
                    ) : (
                      <span className="text-muted-foreground">Not checked yet</span>
                    )}
                  </div>
                  {usage && (
                    <div className="mb-2 text-[11px] text-muted-foreground tabular-nums">
                      {usage.hour.used}/{usage.hour.cap} this hour · {usage.day.used}/{usage.day.cap} today
                    </div>
                  )}
                  <button
                    onClick={() => setConsole(platform)}
                    disabled={!b?.available}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40"
                  >
                    <Monitor className="h-3 w-3" />
                    {b?.loggedIn ? 'Open browser' : 'Sign in'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Queue */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                tab === t.key
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground hover:bg-muted',
              )}
            >
              {t.label}
              {counts && counts[t.key] > 0 && (
                <span className="ml-1.5 tabular-nums opacity-70">{counts[t.key]}</span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
            <p className="text-sm text-muted-foreground">Nothing here.</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              {tab === 'draft'
                ? 'Drafts appear once the bot is active, a channel is set to suggest or auto, and a comment comes in.'
                : 'Replies land here as they move through the queue.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map(({ reply, item }) => {
              const meta = PLATFORM_META[reply.platform] ?? PLATFORM_META.instagram;
              const editable = reply.status === 'draft' || reply.status === 'failed';
              const text = edits[reply.id] ?? reply.generatedText ?? '';
              return (
                <div key={reply.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <meta.Icon className="h-3.5 w-3.5" style={{ color: meta.color }} />
                    <span className="font-medium text-foreground">{meta.label}</span>
                    <span>·</span>
                    <span>{timeAgo(reply.createdAt)}</span>
                    {reply.status === 'pending' && (
                      <>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> sends {whenLabel(reply.notBefore)}
                        </span>
                      </>
                    )}
                    {reply.costUsd > 0 && (
                      <>
                        <span>·</span>
                        <span className="tabular-nums">${reply.costUsd.toFixed(4)}</span>
                      </>
                    )}
                    {item?.permalink && (
                      <a
                        href={item.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>

                  {/* The comment being answered */}
                  <div className="mb-3 rounded-lg border border-border/60 bg-background p-3">
                    <div className="mb-1 text-xs font-medium text-foreground">
                      {item?.authorName ?? item?.authorHandle ?? 'Someone'}
                      {item?.targetTitle && (
                        <span className="ml-2 font-normal text-muted-foreground">on “{item.targetTitle}”</span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {item?.text ?? '(the original item is no longer in the inbox)'}
                    </p>
                  </div>

                  {/* The draft */}
                  {reply.generatedText ? (
                    <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
                        <Bot className="h-3 w-3" /> Draft reply
                      </div>
                      {editable ? (
                        <textarea
                          value={text}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [reply.id]: e.target.value }))}
                          rows={3}
                          className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-primary"
                        />
                      ) : (
                        <p className="whitespace-pre-wrap text-sm text-foreground">{reply.generatedText}</p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">
                      No reply was written for this one.
                    </div>
                  )}

                  {reply.decideReason && (
                    <p className="mt-2 text-xs italic text-muted-foreground">{reply.decideReason}</p>
                  )}
                  {reply.error && (
                    <p className="mt-2 text-xs text-amber-500">{reply.error}</p>
                  )}

                  {editable && reply.generatedText && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => approve(reply.id, false)}
                        disabled={busyId === reply.id}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button
                        onClick={() => approve(reply.id, true)}
                        disabled={busyId === reply.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" /> Approve &amp; send now
                      </button>
                      <button
                        onClick={() => reject(reply.id)}
                        disabled={busyId === reply.id}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {console_ && (
        <BrowserConsole
          platform={console_}
          onClose={() => {
            setConsole(null);
            void refreshStatus();
          }}
        />
      )}
    </Layout>
  );
}

/**
 * The remote browser. Streams the headless page as JPEG frames and forwards
 * clicks/keys back — the only practical way to complete a login with 2FA and
 * device checkpoints on a box with no screen.
 */
function BrowserConsole({ platform, onClose }: { platform: EngagePlatform; onClose: () => void }) {
  const [frame, setFrame] = useState<EngageBrowserFrame | null>(null);
  const [busy, setBusy] = useState(true);
  const [typing, setTyping] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStart = useRef<{ xFrac: number; yFrac: number } | null>(null);
  const meta = PLATFORM_META[platform] ?? PLATFORM_META.instagram;

  const poll = useCallback(async () => {
    try {
      const out = await engageBrowserFrame({ platform });
      setFrame(out.frame);
    } catch {
      /* keep the last frame */
    }
  }, [platform]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const out = await engageBrowserOpen({ platform });
        if (alive) setFrame(out.frame);
      } catch (e: any) {
        toast.error(e?.message ?? 'Could not open the browser.');
      } finally {
        if (alive) setBusy(false);
      }
    })();
    const t = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [platform, poll]);

  const act = async (fn: () => Promise<{ frame: EngageBrowserFrame }>) => {
    setBusy(true);
    try {
      setFrame((await fn()).frame);
    } catch (e: any) {
      toast.error(e?.message ?? 'That action failed.');
    } finally {
      setBusy(false);
    }
  };

  // Positions travel as a FRACTION of the rendered image so the server can scale
  // them to the real viewport — the image is shown at whatever size fits.
  const posOf = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = imgRef.current!.getBoundingClientRect();
    return { xFrac: (e.clientX - rect.left) / rect.width, yFrac: (e.clientY - rect.top) / rect.height };
  };

  // Press-move-release is a DRAG (TikTok's slider captcha needs one); a press
  // and release in roughly the same spot is just a click.
  const onMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;
    dragStart.current = posOf(e);
  };

  const onMouseUp = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;
    const start = dragStart.current;
    dragStart.current = null;
    const end = posOf(e);
    if (!start) return;
    const moved = Math.hypot(end.xFrac - start.xFrac, end.yFrac - start.yFrac);
    // ~1.5% of the image — below that it's a click, above it's a deliberate drag.
    if (moved < 0.015) {
      void act(() => engageBrowserClick({ platform, ...end }));
      return;
    }
    void act(() =>
      engageBrowserDrag({
        platform,
        fromXFrac: start.xFrac,
        fromYFrac: start.yFrac,
        toXFrac: end.xFrac,
        toYFrac: end.yFrac,
      }),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <meta.Icon className="h-4 w-4" style={{ color: meta.color }} />
          <span className="text-sm font-semibold text-foreground">Sign in to {meta.label}</span>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <span className="ml-auto max-w-[40%] truncate text-xs text-muted-foreground">{frame?.url ?? ''}</span>
          <button
            onClick={async () => {
              try {
                const out = await engageBrowserVerify({ platform });
                toast[out.status.loggedIn ? 'success' : 'warning'](
                  out.status.loggedIn ? 'Signed in.' : 'Still signed out.',
                );
              } catch {
                toast.error('Could not verify the session.');
              }
            }}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            Check login
          </button>
          <button
            onClick={async () => {
              await engageBrowserClose({ platform }).catch(() => undefined);
              onClose();
            }}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-black/40 p-3">
          {frame?.image ? (
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${frame.image}`}
              onMouseDown={onMouseDown}
              onMouseUp={onMouseUp}
              onDragStart={(e) => e.preventDefault()}
              alt="Remote browser"
              className="mx-auto max-w-full cursor-crosshair select-none rounded-md"
            />
          ) : (
            <div className="grid h-64 place-items-center text-sm text-muted-foreground">
              {frame?.error ?? 'Waiting for the browser…'}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <input
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typing) {
                void act(() => engageBrowserType({ platform, text: typing })).then(() => setTyping(''));
              }
            }}
            placeholder="Click a field above, then type here and press Enter"
            className="min-w-[220px] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <button
            onClick={() => void act(() => engageBrowserKey({ platform, key: 'Enter' }))}
            className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
          >
            Press Enter
          </button>
          <button
            onClick={() => void act(() => engageBrowserKey({ platform, key: 'Tab' }))}
            className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
          >
            Tab
          </button>
          <button
            onClick={() => void act(() => engageBrowserScroll({ platform, dy: 400 }))}
            className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
          >
            Scroll ↓
          </button>
          <button
            onClick={() => void act(() => engageBrowserScroll({ platform, dy: -400 }))}
            className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
          >
            Scroll ↑
          </button>
          <button
            onClick={() => void act(() => engageBrowserNavigate({ platform, url: '' }))}
            className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
          >
            Home
          </button>
          <button
            onClick={() => void act(() => engageBrowserNavigate({ platform, url: LOGIN_URL[platform] }))}
            className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
          >
            Login page
          </button>
        </div>
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          Click the picture to click the page. <b>Drag</b> on it to drag — that's how you solve a slider
          captcha. Your password is typed into {meta.label}'s own login form inside this browser; The Lab
          never sees or stores it, only the resulting session cookie.
        </p>
      </div>
    </div>
  );
}
