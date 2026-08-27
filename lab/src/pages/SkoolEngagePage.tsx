/**
 * The Skool engagement agent — the operator's view of an autonomous poster.
 *
 * This page exists because of one asymmetry: everything else in the Lab is a
 * tool a human drives, and this is a thing that acts on its own schedule while
 * nobody is watching. So the screen is not really "compose a post" — it is
 * ARMING, WATCHING and INTERVENING, in that order:
 *
 *   1. Is it on, and would it publish or only draft?     (the two-act arm)
 *   2. What is queued, what did it write, what failed?   (the slot table)
 *   3. Publish this one, now that I have read it.        (the human gate)
 *
 * ⚠️ THE DEFAULTS ARE OFF AND DRY-RUN, AND THIS PAGE MUST NOT MAKE THEM EASY
 * TO CLEAR IN ONE MOTION. Turning the schedule on is one switch; letting it
 * publish is a second, separate one — because as of the day this was written
 * `createPost` had never published anything, so clearing both at once would
 * make an unread draft the first thing 139 posts' worth of members see.
 *
 * The fourth panel is a manual bench for drafting off-schedule. That is the
 * only way to answer "what does this thing actually sound like?" without
 * waiting for a Tuesday.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Clock, ExternalLink, Loader2, MessageSquare, PauseCircle, PlayCircle,
  RefreshCw, Send, Sparkles, Trash2, X,
} from 'lucide-react';
import {
  skoolStatus,
  skoolSaveSettings,
  skoolEngageStatus,
  skoolEngageConfigure,
  skoolEngageTick,
  skoolEngagePublish,
  skoolEngageSubject,
  skoolEngageNewMembers,
  skoolDraftPost,
  skoolPublishPost,
  type SkoolEngageSchedule,
  type SkoolSlot,
  type SkoolSlotState,
  type SkoolWeekday,
  type SkoolDraft,
  type SkoolNewMember,
  skoolRepliesStatus,
  skoolRepliesConfigure,
  skoolRepliesSweep,
  skoolRepliesSend,
  skoolRepliesRetry,
  skoolRepliesForget,
  type SkoolReplyConfig,
  type SkoolReplyRow,
  type SkoolReplyState,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';

const WEEKDAYS: SkoolWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABEL: Record<SkoolWeekday, string> = {
  sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat',
};

/**
 * The community's categories, in the order Skool lists them. Hardcoded from a
 * live probe and duplicated from the server on purpose — the feed payload does
 * NOT carry the category list (`currentGroup.labels` was a wrong guess and
 * returns nothing), so there is nothing to fetch.
 */
const CATEGORIES = [
  'Intro', 'YouTube Resources', 'Announcements', 'General Discussion',
  'Dev Discussion', 'Your Journey', 'Hiring/For Hire', 'Community Resources',
];

/**
 * A rate-limit refusal is a NORMAL state for this agent, not a crash.
 *
 * Rendering it in the same red box as "Skool logged us out" would train the
 * operator to read a working safety feature as a broken tool. What it MEANS,
 * though, depends on which credential is drafting (`aiAuth` from the status
 * endpoint), so the copy is picked per credential rather than hardcoded:
 *
 *   subscription — the Max window is shut. Nothing was billed, and it has been
 *                  observed shut for a day or more, so the retry may not win.
 *   api          — an ordinary per-minute rate limit. It clears in seconds and
 *                  the retry almost always succeeds.
 *
 * Neither is the out-of-credit case, which arrives as a plain error and is
 * correctly shown in the destructive box: retrying does not fix a zero balance.
 */
function isRateLimited(msg: string | null | undefined): boolean {
  return !!msg && /rate limit|Max subscription/i.test(msg);
}

/** How to describe a rate-limit refusal for the credential actually in use. */
function rateLimitCopy(aiAuth: string | null | undefined): { headline: string; detail: string } {
  return aiAuth === 'subscription'
    ? {
        headline: 'The Max window is shut.',
        detail: 'Nothing was billed. The window has been seen shut for a day at a time, so this may not clear before the slot goes stale.',
      }
    : {
        headline: 'Anthropic rate-limited the request.',
        detail: 'This is the per-minute API limit, not a spending problem — it normally clears within seconds.',
      };
}

export default function SkoolEngagePage() {
  const [schedule, setSchedule] = useState<SkoolEngageSchedule | null>(null);
  const [now, setNow] = useState<{ date: string; weekday: SkoolWeekday; hour: number } | null>(null);
  const [slots, setSlots] = useState<SkoolSlot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /**
   * Needed only to link a posted slot back to Skool. A slot stores the BARE
   * slug, and the post lives at `<communityUrl>/<slug>` — so without this the
   * link would point at skool.com/<slug>, which is a 404 rather than the post.
   */
  const [communityUrl, setCommunityUrl] = useState<string | null>(null);
  /**
   * Which credential the drafter spends (`SKOOL_AI_AUTH`, server-side). It only
   * decides copy — but the wrong copy here is actively misleading, because a
   * rate-limit refusal means "free, and possibly shut all day" on the
   * subscription and "billed, back in seconds" on API credits.
   */
  const [aiAuth, setAiAuth] = useState<string | null>(null);
  /**
   * Whether the composer flow was taught, or is the built-in map of guessed
   * selectors. Shown because recording one is otherwise an act of faith — the
   * teach console is on a different page, and getting the action's name slightly
   * wrong looks exactly like getting it right until a post fails to appear.
   */
  const [postRecipe, setPostRecipe] = useState<PostRecipeInfo | null>(null);
  /**
   * The reply agent, which is a SEPARATE agent sharing this screen — its own
   * switches, its own cadence, its own log. It is deliberately not folded into
   * `schedule`: turning the weekly posts off must not stop answering members,
   * and one blob would make that one edit away.
   */
  const [replyConfig, setReplyConfig] = useState<SkoolReplyConfig | null>(null);
  const [replyCounts, setReplyCounts] = useState({ drafted: 0, sent: 0, unconfirmed: 0, skipped: 0, failed: 0, sentLastDay: 0 });
  const [replyHealth, setReplyHealth] = useState<{ lastSweepAt: number | null; lastOutcome: string; lastTrigger: string }>({
    lastSweepAt: null, lastOutcome: '', lastTrigger: '',
  });
  const [replyRows, setReplyRows] = useState<SkoolReplyRow[]>([]);
  const [replyDirty, setReplyDirty] = useState(false);
  // The welcome message every new member already gets. Read once at mount and
  // never re-polled: it is a textarea the operator types into, and the ask
  // panel below is the only thing that reads it.
  const [welcome, setWelcome] = useState('');
  // Jake's own voice guide. Read once at mount, like the welcome message — it is
  // a long document he pastes in, not something to re-poll under his cursor.
  const [voice, setVoice] = useState('');

  useEffect(() => {
    void skoolStatus()
      .then((s) => {
        setCommunityUrl(s.settings.communityUrl || null);
        setWelcome(s.settings.welcomeMessageMd ?? '');
        setVoice(s.settings.voiceGuideMd ?? '');
      })
      .catch(() => undefined); // non-fatal — the queue just shows no link
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await skoolEngageStatus();
      setNow(s.now);
      setSlots(s.slots);
      setAiAuth(s.aiAuth ?? null);
      setPostRecipe(s.postRecipe ?? null);
      // Don't clobber edits in progress: the settings form is the one part of
      // this page the operator types into, and a poll landing mid-edit that
      // reset the day chips would be indistinguishable from the save failing.
      setSchedule((prev) => (dirty && prev ? prev : s.schedule));
      // The reply agent's status is its own call — it is a different agent, and
      // a failure to read it must not blank the poster's queue.
      try {
        const r = await skoolRepliesStatus();
        setReplyCounts(r.counts);
        setReplyHealth(r.health);
        setReplyRows(r.recent);
        setReplyConfig((prev) => (replyDirty && prev ? prev : r.config));
      } catch {
        /* non-fatal — the reply panel simply does not render */
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }, [dirty, replyDirty]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  /** Patch the schedule server-side and take its answer as the truth. */
  const configure = (patch: Partial<SkoolEngageSchedule>, label: string, then?: string) =>
    run(label, async () => {
      const { schedule: next } = await skoolEngageConfigure(patch);
      setSchedule(next);
      setDirty(false);
      if (then) setNote(then);
    });

  /** Same shape as `configure`, for the other agent on this page. */
  const configureReplies = (patch: Partial<SkoolReplyConfig>, label: string, then?: string) =>
    run(label, async () => {
      const { config: next } = await skoolRepliesConfigure(patch);
      setReplyConfig(next);
      setReplyDirty(false);
      if (then) setNote(then);
    });

  const hasEverPosted = slots.some((s) => s.state === 'posted');

  return (
    <Layout breadcrumb="Skool Agent">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" />
            Skool Agent
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Writes community posts on a schedule and answers your members, grounded in your 15 rebuilt courses — the
            lesson pages and what you actually say in the videos. Both run unattended, so everything they write lands
            here first.
          </p>
        </header>

        {err && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{err}</span>
          </div>
        )}
        {note && (
          <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--chart-3))]/40 bg-[hsl(var(--chart-3))]/10 p-3 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--chart-3))]" />
            <span>{note}</span>
          </div>
        )}

        {!schedule ? (
          <div className="grid h-32 place-items-center text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Reading the schedule…</span>
          </div>
        ) : (
          <>
            <ArmPanel
              schedule={schedule}
              busy={busy}
              hasEverPosted={hasEverPosted}
              onToggleEnabled={(v) =>
                configure({ enabled: v }, 'enabled', v ? 'Schedule is on.' : 'Schedule is off — nothing will run.')
              }
              onToggleDryRun={(v) =>
                configure(
                  { dryRun: v },
                  'dryrun',
                  v ? 'Back to drafting only.' : 'Live — it can now publish without asking.',
                )
              }
            />

            <VoicePanel
              voice={voice}
              onVoice={setVoice}
              busy={busy}
              onSave={() =>
                run('voice', async () => {
                  const out = await skoolSaveSettings({ voiceGuideMd: voice });
                  setVoice(out.settings.voiceGuideMd ?? '');
                  setNote('Saved the voice guide.');
                })
              }
            />

            <SchedulePanel
              schedule={schedule}
              now={now}
              busy={busy}
              onEdit={(patch) => {
                setSchedule({ ...schedule, ...patch });
                setDirty(true);
              }}
              dirty={dirty}
              welcome={welcome}
              onWelcome={setWelcome}
              onSaveWelcome={() =>
                run('welcome', async () => {
                  const out = await skoolSaveSettings({ welcomeMessageMd: welcome });
                  setWelcome(out.settings.welcomeMessageMd ?? '');
                  setNote('Saved the welcome message.');
                })
              }
              onSave={() => configure(schedule, 'save', 'Saved.')}
              onTick={() =>
                run('tick', async () => {
                  const out = await skoolEngageTick();
                  if (!out.started) {
                    setNote(out.detail ?? 'A cycle is already running.');
                  } else {
                    const r = out.result;
                    // Report all three outcomes. "Skipped" with a reason is the
                    // common one (wrong day, wrong hour, kill switch) and it is
                    // exactly what a silent no-op would hide.
                    const bits = [
                      r?.enqueued ? `queued ${r.enqueued}` : null,
                      r?.processed?.length ? `worked on ${r.processed.join(', ')}` : null,
                      r?.skipped ? `skipped — ${r.skipped}` : null,
                    ].filter(Boolean);
                    setNote(bits.length ? `Cycle ran: ${bits.join(' · ')}.` : 'Cycle ran — nothing to do.');
                  }
                  await load();
                })
              }
              onRefresh={() => run('refresh', load)}
            />

            <QueuePanel
              slots={slots}
              busy={busy}
              communityUrl={communityUrl}
              dryRun={schedule.dryRun}
              aiAuth={aiAuth}
              onPublish={(slotKey) =>
                run(`pub:${slotKey}`, async () => {
                  const out = await skoolEngagePublish({ slotKey });
                  if (out.ok) setNote(out.detail);
                  else setErr(out.detail);
                  await load();
                })
              }
            />

            <HowItPosts info={postRecipe} />

            <DraftBench busy={busy} setBusy={setBusy} aiAuth={aiAuth} onPosted={() => void load()} />

            {replyConfig ? (
              <RepliesPanel
                config={replyConfig}
                counts={replyCounts}
                health={replyHealth}
                rows={replyRows}
                busy={busy}
                communityUrl={communityUrl}
                dirty={replyDirty}
                onToggle={(patch, key) => configureReplies(patch, key)}
                onEdit={(patch) => { setReplyDirty(true); setReplyConfig((p) => (p ? { ...p, ...patch } : p)); }}
                onSave={() => {
                  const { enabled, dryRun, comments, dms, ...rest } = replyConfig;
                  return configureReplies(rest, 'r-save', 'Saved.');
                }}
                onSweep={() =>
                  run('r-sweep', async () => {
                    const r = await skoolRepliesSweep();
                    // ⚠️ SAY WHY IT DID NOTHING. "Ran and found nobody" and
                    // "refused because of a cap" are the same empty result
                    // otherwise, and the second is the one worth knowing.
                    if (r.skipped) setNote(`Sweep skipped — ${r.skipped}`);
                    else if (!r.handled.length) {
                      setNote(
                        `Sweep ran — nothing to answer. Read ${r.scanned.postsWithComments} post(s) with comments ` +
                        `and ${r.scanned.dmThreads} DM thread(s).`,
                      );
                    } else {
                      setNote(`Sweep ran: ${r.drafted} drafted, ${r.sent} sent, ${r.skippedByDrafter} left for you, ${r.failed} failed.`);
                    }
                    if (r.notes.length) setNote((n) => `${n ?? ''} ${r.notes.join(' · ')}`.trim());
                    await load();
                  })
                }
                onSend={(id) =>
                  run(`r-send:${id}`, async () => {
                    const out = await skoolRepliesSend({ id });
                    if (out.ok) setNote(out.detail);
                    else setErr(out.detail);
                    await load();
                  })
                }
                onRetry={(id) =>
                  run(`r-retry:${id}`, async () => {
                    const out = await skoolRepliesRetry({ id });
                    if (out.ok) setNote(out.detail);
                    else setErr(out.detail);
                    await load();
                  })
                }
                onForget={(id) =>
                  run(`r-forget:${id}`, async () => {
                    await skoolRepliesForget({ id });
                    setNote('Forgotten — it may be offered again on the next sweep. Nothing was unsent.');
                    await load();
                  })
                }
              />
            ) : null}
          </>
        )}
      </div>
    </Layout>
  );
}

interface PostRecipeInfo {
  taught: boolean;
  name: string;
  steps: number;
  placeholders: string[];
  missing: string[];
  fragileSteps: number;
  unclickableFields: string[];
}

/**
 * How the post actually gets typed in — taught, or guessed.
 *
 * ⚠️ THIS PANEL EXISTS BECAUSE THE TWO PATHS FAIL DIFFERENTLY. The built-in map
 * finds the submit button by looking for something whose text is "Post", which
 * is ambiguous on a page that says "Post" in more than one place; a taught
 * action names the element itself. An operator debugging a post that never
 * appeared needs to know which of those was running, and nothing else on this
 * screen would tell them.
 *
 * `{{category}}` missing is a note, not a warning: Skool publishes without one.
 * `{{title}}` or `{{body}}` missing is a refusal, and says so here rather than
 * at the moment of publishing.
 */
function HowItPosts({ info }: { info: PostRecipeInfo | null }) {
  if (!info) return null;
  const broken = info.missing.filter((m) => m !== 'category');
  return (
    <section className="rounded-lg border p-5">
      <div className="mb-1 text-sm font-semibold">How it types the post in</div>
      {info.taught ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            Replaying the <span className="font-mono text-foreground">{info.name}</span> action you taught —{' '}
            {info.steps} step{info.steps === 1 ? '' : 's'}
            {info.placeholders.length > 0 && (
              <> · fills in {info.placeholders.map((p) => `{{${p}}}`).join(', ')}</>
            )}
            .
          </div>
          {info.unclickableFields.length > 0 && (
            <div className="text-destructive">
              It clicks {info.unclickableFields.map((f) => `{{${f}}}`).join(' and ')}, which cannot resolve — a
              placeholder on a click means "the element labelled with this value", and those are typed into a field
              that is empty when you click it. Mark them on the typing step instead. Only the category is picked by
              clicking its label. Publishing will refuse until this is re-recorded.
            </div>
          )}
          {broken.length > 0 && (
            <div className="text-destructive">
              It has no {broken.map((m) => `{{${m}}}`).join(' or ')} step, so publishing will refuse rather than post
              whatever was typed when you recorded it. Re-record it with the placeholder buttons.
            </div>
          )}
          {broken.length === 0 && info.missing.includes('category') && (
            <div>No {'{{category}}'} step, so posts will be uncategorised. Skool allows that.</div>
          )}
          {info.fragileSteps > 0 && (
            <div>
              {info.fragileSteps} step{info.fragileSteps === 1 ? '' : 's'} can only be found by a styling class or a tag
              position — those break on Skool's next redeploy. Worth re-recording before you rely on it.
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Nothing taught yet, so it uses the built-in map of the composer. That works, but it finds the submit button by
          looking for something that says "Post" — teach a <span className="font-mono">{info.name}</span> action in the
          Skool Manager's console to name the exact button instead.
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── 1. armed? ─────────────────────────── */

/**
 * The state sentence is the point of this panel.
 *
 * "enabled" and "dryRun" are two booleans, and their four combinations mean
 * very different things to a member reading the feed. A pair of checkboxes
 * would make the operator do that reasoning themselves every visit, so the
 * panel says which of the three real states it is in, in words.
 */
function ArmPanel({
  schedule, busy, hasEverPosted, onToggleEnabled, onToggleDryRun,
}: {
  schedule: SkoolEngageSchedule;
  busy: string | null;
  hasEverPosted: boolean;
  onToggleEnabled: (v: boolean) => void;
  onToggleDryRun: (v: boolean) => void;
}) {
  // Going live is the one irreversible-ish switch on this page, so it asks
  // twice — and asks harder when nothing it wrote has ever been published.
  const [confirmLive, setConfirmLive] = useState(false);
  const live = schedule.enabled && !schedule.dryRun;

  return (
    <section
      className={`rounded-lg border p-5 ${live ? 'border-[hsl(var(--chart-1))]/50 bg-[hsl(var(--chart-1))]/5' : ''}`}
    >
      <div className="flex items-start gap-3">
        {live ? (
          <PlayCircle className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--chart-1))]" />
        ) : schedule.enabled ? (
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        ) : (
          <PauseCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {live
              ? 'Live — it publishes on its own'
              : schedule.enabled
                ? 'Running, drafting only'
                : 'Off'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {live
              ? 'On a posting day it writes a post and puts it straight in the community. Nobody reads it first.'
              : schedule.enabled
                ? 'On a posting day it writes a post and holds it below for you. Nothing reaches the community until you publish it.'
                : 'Nothing runs. The schedule is ignored entirely, and no drafts are written.'}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => onToggleEnabled(!schedule.enabled)}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy === 'enabled' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {schedule.enabled ? 'Turn the schedule off' : 'Turn the schedule on'}
        </button>

        {schedule.dryRun ? (
          confirmLive ? (
            <span className="inline-flex items-center gap-2">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setConfirmLive(false);
                  onToggleDryRun(false);
                }}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
              >
                {busy === 'dryrun' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {hasEverPosted ? 'Yes, let it publish' : 'Yes — publish something nobody has read'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmLive(false)}
                className="rounded-md border px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => setConfirmLive(true)}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Let it publish without asking
            </button>
          )
        ) : (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => onToggleDryRun(true)}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {busy === 'dryrun' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Back to drafting only
          </button>
        )}
      </div>

      {!hasEverPosted && (
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This agent has never published anything. Draft one below and read it before you take the safety off.
        </p>
      )}
    </section>
  );
}

/* ─────────────────────────── 2. when ─────────────────────────── */

/**
 * Jake's own voice guide — the authority on how everything here SOUNDS.
 *
 * ⚠️ ITS OWN PANEL, ABOVE THE SCHEDULE, BECAUSE IT IS NOT A POSTING SETTING. It
 * reaches every post AND every reply the Skool agent writes, which is a wider
 * blast radius than anything else on this screen, and burying it inside "When it
 * posts" would say the opposite.
 */
function VoicePanel({
  voice, onVoice, busy, onSave,
}: {
  voice: string;
  onVoice: (v: string) => void;
  busy: string | null;
  onSave: () => void;
}) {
  return (
    <section className="rounded-lg border p-5">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-semibold">The voice</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs ${voice.trim() ? 'bg-[hsl(var(--chart-3))]/15 text-[hsl(var(--chart-3))]' : 'bg-muted text-muted-foreground'}`}>
          {voice.trim() ? `${voice.trim().length.toLocaleString()} characters` : 'not set'}
        </span>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        How everything here sounds — every post and every reply the Skool agent writes. It overrides the tone
        rules the agent inherited from the YouTube comment box, which is what it wrote in before.
      </p>
      <textarea
        value={voice}
        onChange={(e) => onVoice(e.target.value)}
        rows={10}
        placeholder="Paste the voice guide…"
        className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!!busy}
          onClick={onSave}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
        >
          {busy === 'voice' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save the voice
        </button>
        {/* ⚠️ SAID ON THE SCREEN, NOT ONLY IN THE PROMPT. Someone pasting a voice
            document here would reasonably assume it replaces the instructions —
            and if it did, the rules that stop the agent inventing a price or
            answering a refund question would go with them. */}
        <span className="text-xs text-muted-foreground">
          Voice only. What the agent is allowed to claim — no invented prices or links, and skipping anything
          about money, refunds or legal — is set separately and this does not change it.
        </span>
      </div>
    </section>
  );
}

function SchedulePanel({
  schedule, now, busy, dirty, onEdit, onSave, onTick, onRefresh, welcome, onWelcome, onSaveWelcome,
}: {
  schedule: SkoolEngageSchedule;
  now: { date: string; weekday: SkoolWeekday; hour: number } | null;
  busy: string | null;
  dirty: boolean;
  onEdit: (patch: Partial<SkoolEngageSchedule>) => void;
  onSave: () => void;
  onTick: () => void;
  onRefresh: () => void;
  /** The welcome message every new member already gets. */
  welcome: string;
  onWelcome: (v: string) => void;
  onSaveWelcome: () => void;
}) {
  const toggleDay = (d: SkoolWeekday) => {
    const has = schedule.days.includes(d);
    // Keep the stored order canonical (sun→sat) rather than click order, so two
    // operators who pick the same days end up with the same settings row.
    const next = has ? schedule.days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || schedule.days.includes(x));
    onEdit({ days: next });
  };

  const isPostingDay = !!now && schedule.days.includes(now.weekday);

  return (
    <section className="rounded-lg border p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">When it posts</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
        >
          {busy === 'refresh' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </button>
      </div>

      {/* The clock, in the schedule's own zone. Three timezones are in play —
          this server is UTC, you are in Bangkok, the schedule is New York — so
          showing "9:00" alone would be telling nobody anything. */}
      {now && (
        <p className="mb-4 text-xs text-muted-foreground">
          It is <span className="font-medium text-foreground">{DAY_LABEL[now.weekday]} {String(now.hour).padStart(2, '0')}:00</span>{' '}
          in {schedule.timezone} right now ({now.date}).{' '}
          {isPostingDay
            ? now.hour < schedule.hour
              ? `Today is a posting day — the slot opens at ${String(schedule.hour).padStart(2, '0')}:00.`
              : 'Today is a posting day and the slot has opened.'
            : 'Not a posting day.'}
        </p>
      )}

      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Days</label>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {WEEKDAYS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => toggleDay(d)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              schedule.days.includes(d) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
          >
            {DAY_LABEL[d]}
          </button>
        ))}
      </div>

      {/* ⚠️ THE ASK DAY IS A DAY, NOT A SWITCH, AND IT HAS TO BE ONE OF THE DAYS
          ABOVE — the server refuses otherwise, because an ask day that is not a
          posting day is an ask post that silently never runs. "None" keeps the
          day and writes a lesson on it, which is a different decision from
          dropping the day and should look like one. */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Field label="Ask the community (and greet new members) on">
          <select
            value={schedule.askDay ?? ''}
            onChange={(e) => onEdit({ askDay: e.target.value ? (e.target.value as SkoolWeekday) : null })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">None — every day writes a lesson</option>
            {schedule.days.map((d) => (
              <option key={d} value={d}>{DAY_LABEL[d]}</option>
            ))}
          </select>
        </Field>
        <Field label="@mention members who joined in the last (days)">
          <input
            type="number" min={1} max={90}
            value={schedule.askNewMemberDays}
            onChange={(e) => onEdit({ askNewMemberDays: Number(e.target.value) })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </Field>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {schedule.askDay ? (
          <>
            On {DAY_LABEL[schedule.askDay]} it asks one question instead of teaching a lesson, opening by
            @mentioning up to {schedule.askMaxMentions} members who joined in the last {schedule.askNewMemberDays} days.
            Nobody is greeted twice, and a week with no new members still gets the question.
            {' '}A pinned subject and a new-video announcement both step aside on that day and take the next one.
          </>
        ) : (
          <>No ask post — every posting day writes a lesson, and new members are not greeted.</>
        )}
      </p>

      {/* ⚠️ THIS IS NOT DECORATION AND IT IS NOT A TEMPLATE THIS APP SENDS. It is
          the message Skool already delivers to every joiner, pasted in so the
          drafter can see it — and it does two jobs nothing else can do. It is
          the register the greeting should match (how Jake greets a PERSON, not
          how he writes a post), and it is a question those exact members have
          already been asked privately, which the post must therefore not ask
          again. Left empty, Thursday can put the same question to the same five
          people twice in a week and nothing would notice but the members. */}
      {schedule.askDay && (
        <div className="mb-4">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            The welcome message new members already get
          </label>
          <textarea
            value={welcome}
            onChange={(e) => onWelcome(e.target.value)}
            rows={6}
            placeholder="Paste the automatic welcome message Skool sends when someone joins…"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!!busy}
              onClick={onSaveWelcome}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
            >
              {busy === 'welcome' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save the welcome message
            </button>
            <span className="text-xs text-muted-foreground">
              {welcome.trim()
                ? 'The ask post matches its tone and will not repeat the question it asks.'
                : 'Empty — the ask post may repeat whatever this already asks them.'}
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Hour (local to the timezone below)">
          <select
            value={schedule.hour}
            onChange={(e) => onEdit({ hour: Number(e.target.value) })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </Field>
        <Field label="Timezone">
          <input
            value={schedule.timezone}
            onChange={(e) => onEdit({ timezone: e.target.value })}
            placeholder="America/New_York"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </Field>
        {/* ⚠️ NEVER SMALLER THAN THE NUMBER OF DAYS ABOVE. A cap equal to the day
            count already closed a Tuesday once (2026-08-18): three posting days
            against a cap of three could never open the third. The cap guards
            against a day list nobody meant to widen — it is not a second
            schedule. */}
        <Field label="Most scheduled posts in a week">
          <input
            type="number" min={1} max={14}
            value={schedule.maxPostsPerWeek}
            onChange={(e) => onEdit({ maxPostsPerWeek: Number(e.target.value) })}
            className={`w-full rounded-md border bg-background px-2 py-1.5 text-sm ${
              schedule.maxPostsPerWeek < schedule.days.length ? 'border-amber-500' : ''
            }`}
          />
          {schedule.maxPostsPerWeek < schedule.days.length && (
            <p className="mt-1 text-xs text-amber-600">
              Lower than the {schedule.days.length} posting days — {schedule.days.length - schedule.maxPostsPerWeek}{' '}
              of them will close themselves each week.
            </p>
          )}
        </Field>
        <Field label="Give up after this many tries">
          <input
            type="number" min={1} max={48}
            value={schedule.maxAttempts}
            onChange={(e) => onEdit({ maxAttempts: Number(e.target.value) })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="Minutes between tries">
          <input
            type="number" min={1} max={720}
            value={schedule.retryMinutes}
            onChange={(e) => onEdit({ retryMinutes: Number(e.target.value) })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </Field>
        {/* Staleness matters more than it looks: the posting days are ADVERTISED
            to members in the pinned post, so a Tuesday post that finally drafts
            on Thursday is a broken promise, not a late delivery. */}
        <Field label="Abandon a slot older than (hours)">
          <input
            type="number" min={1} max={72}
            value={schedule.maxSlotAgeHours}
            onChange={(e) => onEdit({ maxSlotAgeHours: Number(e.target.value) })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!!busy || !dirty}
          onClick={onSave}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </button>
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        <button
          type="button"
          disabled={!!busy}
          onClick={onTick}
          className="ml-auto inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy === 'tick' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
          Run a cycle now
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        "Run a cycle now" does exactly what the timer does, including the day and hour checks — so on a non-posting
        day it will tell you it skipped, rather than posting early.
      </p>
    </section>
  );
}

/**
 * The members a slot will greet, out of its stored blob.
 *
 * Tolerates anything: this is display-only, and a slot with a corrupt mentions
 * blob still publishes its question — the server parses the same field again,
 * field by field, before typing any of it into a live composer.
 */
function mentionsOf(slot: SkoolSlot): SkoolNewMember[] {
  try {
    const list = JSON.parse(slot.mentionsJson || '[]');
    return Array.isArray(list) ? list.filter((m: any) => m?.displayName) : [];
  } catch {
    return [];
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

/* ─────────────────────────── 3. the queue ─────────────────────────── */

const STATE_STYLE: Record<SkoolSlotState, string> = {
  pending: 'bg-muted text-muted-foreground',
  drafted: 'bg-primary/15 text-primary',
  posted: 'bg-[hsl(var(--chart-3))]/15 text-[hsl(var(--chart-3))]',
  abandoned: 'bg-destructive/15 text-destructive',
};

const STATE_LABEL: Record<SkoolSlotState, string> = {
  pending: 'Queued',
  drafted: 'Written — waiting for you',
  posted: 'Posted',
  abandoned: 'Given up',
};

function QueuePanel({
  slots, busy, dryRun, communityUrl, aiAuth, onPublish,
}: {
  slots: SkoolSlot[];
  busy: string | null;
  dryRun: boolean;
  communityUrl: string | null;
  aiAuth: string | null;
  onPublish: (slotKey: string) => void;
}) {
  return (
    <section className="rounded-lg border p-5">
      <h2 className="mb-3 text-sm font-semibold">The queue</h2>
      {slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing queued. A slot appears on each posting day — or immediately, if you run a cycle on one.
        </p>
      ) : (
        <ul className="space-y-3">
          {slots.map((s) => (
            <SlotRow key={s.slotKey} slot={s} busy={busy} dryRun={dryRun} communityUrl={communityUrl} aiAuth={aiAuth} onPublish={onPublish} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SlotRow({
  slot, busy, dryRun, communityUrl, aiAuth, onPublish,
}: {
  slot: SkoolSlot;
  busy: string | null;
  dryRun: boolean;
  communityUrl: string | null;
  aiAuth: string | null;
  onPublish: (slotKey: string) => void;
}) {
  const [open, setOpen] = useState(slot.state === 'drafted');
  const [confirm, setConfirm] = useState(false);
  const cited: { title: string; url: string }[] = (() => {
    try {
      return JSON.parse(slot.citedJson || '[]');
    } catch {
      return [];
    }
  })();

  return (
    <li className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <span className="font-mono text-xs text-muted-foreground">{slot.slotKey}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLE[slot.state]}`}>
          {STATE_LABEL[slot.state]}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{slot.title || slot.subject}</span>
        {slot.attempts > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {slot.attempts} {slot.attempts === 1 ? 'try' : 'tries'}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t p-3">
          <div className="text-xs text-muted-foreground">
            Subject: <span className="text-foreground">{slot.subject}</span>
            {slot.category && <> · Category: <span className="text-foreground">{slot.category}</span></>}
            {' · '}Written as{' '}
            <span className="text-foreground">
              {slot.kind === 'mcp' ? 'an automation tutorial' : slot.kind === 'ask' ? 'a question to the community' : 'a lesson post'}
            </span>
          </div>

          {/* ⚠️ THE MENTIONS ARE NOT IN THE BODY BELOW AND NEVER WILL BE. They
              are typed into the composer as real Skool chips ahead of the pasted
              text — which is why a draft that opens mid-sentence is correct. The
              step log records any that could not be written. */}
          {slot.kind === 'ask' && (
            <div className="text-xs text-muted-foreground">
              {mentionsOf(slot).length ? (
                <>
                  Opens by mentioning{' '}
                  <span className="text-foreground">{mentionsOf(slot).map((m) => `@${m.displayName}`).join(', ')}</span>
                  {' — added to the composer as real mentions, ahead of the body.'}
                </>
              ) : (
                <>Nobody new to greet — it opens straight on the question.</>
              )}
            </div>
          )}

          {/* A queued slot is nearly always waiting on a rate limit, so say
              which it is rather than showing a bare error string. */}
          {slot.lastError && (
            <div
              className={`rounded-md border p-2 text-xs ${
                isRateLimited(slot.lastError)
                  ? 'border-border bg-muted/50 text-muted-foreground'
                  : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              {isRateLimited(slot.lastError) ? (
                <>
                  {rateLimitCopy(aiAuth).headline} Nothing was written. It keeps retrying on its own.
                </>
              ) : (
                slot.lastError
              )}
            </div>
          )}

          {slot.body ? (
            <>
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="mb-1.5 text-sm font-semibold">{slot.title}</div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed">{slot.body}</div>
              </div>
              <Cited cited={cited} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing written yet.</p>
          )}

          {/* A post lives at `<communityUrl>/<slug>`, and the slot stores the
              bare slug — so with no community URL there is no link to build.
              The slug is still shown: a dead link would be worse than none. */}
          {slot.state === 'posted' && slot.slug && (
            communityUrl ? (
              <a
                href={`${communityUrl.replace(/\/+$/, '')}/${slot.slug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs underline"
              >
                See it in the community <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <div className="text-xs text-muted-foreground">Posted as <span className="font-mono">{slot.slug}</span></div>
            )
          )}

          {slot.state === 'drafted' && (
            <div className="flex flex-wrap items-center gap-2">
              {confirm ? (
                <>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      setConfirm(false);
                      onPublish(slot.slotKey);
                    }}
                    className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                  >
                    {busy === `pub:${slot.slotKey}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Yes, post this to the community
                  </button>
                  <button type="button" onClick={() => setConfirm(false)} className="rounded-md border px-3 py-1.5 text-xs">
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setConfirm(true)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  Publish this
                </button>
              )}
              {dryRun && (
                <span className="text-xs text-muted-foreground">
                  Drafting only is on, so this is the only way it goes out.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The lessons a draft was grounded in — the audit trail, and the read-back. */

/* ────────────────────────── the reply agent ────────────────────────── */

const REPLY_STATE_STYLE: Record<SkoolReplyState, string> = {
  drafted: 'border-primary/40 text-primary',
  sent: 'border-[hsl(var(--chart-1))]/50 text-[hsl(var(--chart-1))]',
  unconfirmed: 'border-amber-500/50 text-amber-600',
  skipped: 'border-muted-foreground/30 text-muted-foreground',
  failed: 'border-destructive/50 text-destructive',
};

/**
 * What the agent believed the member could open when it wrote — see
 * `skool/access.ts`.
 *
 * ⚠️ 'unknown' IS NOT 'free', AND THE UI HAS TO SHOW WHICH. Both got the free
 * treatment, but one of them is a member the tier read never found — three of
 * those in a row is a members-page read that has quietly stopped working, and
 * a badge that said "free" would hide exactly that.
 */
const REPLY_TIER_STYLE: Record<string, string> = {
  paid: 'border-[hsl(var(--chart-1))]/50 text-[hsl(var(--chart-1))]',
  free: 'border-amber-500/50 text-amber-600',
  unknown: 'border-muted-foreground/30 text-muted-foreground',
};

const REPLY_TIER_LABEL: Record<string, string> = {
  paid: 'paying',
  free: 'free member',
  unknown: 'tier unknown — answered as free',
};

const REPLY_STATE_LABEL: Record<SkoolReplyState, string> = {
  drafted: 'Waiting for you',
  sent: 'Sent',
  unconfirmed: 'Unconfirmed',
  skipped: 'Left for you',
  failed: 'Failed',
};

/**
 * The reply agent: two switches, the caps, and the log.
 *
 * ⚠️ COMMENTS AND DMs ARE SEPARATE SWITCHES ON THIS SCREEN because they are
 * separate acts. Answering under Jake's own post is public and correctable in
 * the open; a DM lands in somebody's private inbox and Skool's composer sends on
 * Enter, so there is no button to withhold and nothing to delete afterwards.
 * One switch for both would make the safer of the two arm the riskier.
 */
function RepliesPanel({
  config, counts, health, rows, busy, communityUrl,
  onToggle, onEdit, onSave, onSweep, onSend, onRetry, onForget, dirty,
}: {
  config: SkoolReplyConfig;
  counts: { drafted: number; sent: number; unconfirmed: number; skipped: number; failed: number; sentLastDay: number };
  health: { lastSweepAt: number | null; lastOutcome: string; lastTrigger: string };
  rows: SkoolReplyRow[];
  busy: string | null;
  communityUrl: string | null;
  dirty: boolean;
  onToggle: (patch: Partial<SkoolReplyConfig>, key: string) => void;
  onEdit: (patch: Partial<SkoolReplyConfig>) => void;
  onSave: () => void;
  onSweep: () => void;
  onSend: (id: string) => void;
  onRetry: (id: string) => void;
  onForget: (id: string) => void;
}) {
  const [confirmLive, setConfirmLive] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const live = config.enabled && !config.dryRun;
  const surfaces = [config.comments ? 'comments' : null, config.dms ? 'DMs' : null].filter(Boolean).join(' and ');
  /**
   * ⚠️ A SENT ROW IS AN ARCHIVE, NOT A QUEUE ITEM, AND MIXING THEM MADE DONE
   * WORK LOOK OUTSTANDING. Jake, 2026-08-20: "if the DM worked why is it still
   * in the lab? ... remove it from the queue."
   *
   * ⚠️ IT IS NOT DELETED, AND MUST NOT BE. The ledger row is exactly what stops
   * the collector offering that message again — drop it and the member gets a
   * second answer to something already answered. So `sent` moves out of the
   * list and behind a count, where it still answers "did that go?".
   */
  const needsYou = rows.filter((r) => r.state !== 'sent');
  const sent = rows.filter((r) => r.state === 'sent');

  return (
    <section className={`rounded-lg border p-5 ${live ? 'border-[hsl(var(--chart-1))]/50 bg-[hsl(var(--chart-1))]/5' : ''}`}>
      <div className="flex items-start gap-3">
        <MessageSquare className={`mt-0.5 h-5 w-5 shrink-0 ${live ? 'text-[hsl(var(--chart-1))]' : 'text-muted-foreground'}`} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            {!config.enabled
              ? 'Replies — off'
              : !surfaces
                ? 'Replies — on, but nothing is switched on to answer'
                : live
                  ? `Replies — answering ${surfaces} on its own`
                  : `Replies — drafting ${surfaces} for you`}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {!config.enabled
              ? 'Nothing is read and nothing is written. Members are not answered.'
              : live
                ? `Every ${config.everyMinutes} min it reads ${surfaces}, writes an answer and sends it. Nobody reads it first.`
                : `Every ${config.everyMinutes} min it reads ${surfaces} and writes an answer, then stops. Nothing reaches a member until you send it below.`}
          </p>
          {/* ⚠️ A DM IS THE LESS RECOVERABLE OF THE TWO AND THE SCREEN SAYS SO
              WHERE THE DECISION IS MADE, not in a doc nobody opens. */}
          {live && config.dms ? (
            <p className="mt-1 text-xs text-amber-600">
              DMs are private and Skool sends on Enter — a sent message cannot be deleted from here.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button" disabled={!!busy}
          onClick={() => onToggle({ enabled: !config.enabled }, 'r-enabled')}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy === 'r-enabled' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {config.enabled ? 'Turn replies off' : 'Turn replies on'}
        </button>

        {config.enabled ? (
          <>
            <button
              type="button" disabled={!!busy}
              onClick={() => onToggle({ comments: !config.comments }, 'r-comments')}
              className={`rounded-md border px-3 py-1.5 text-xs disabled:opacity-50 ${config.comments ? 'border-primary text-primary' : 'text-muted-foreground'}`}
            >
              {config.comments ? '✓ ' : ''}Comments
            </button>
            <button
              type="button" disabled={!!busy}
              onClick={() => onToggle({ dms: !config.dms }, 'r-dms')}
              className={`rounded-md border px-3 py-1.5 text-xs disabled:opacity-50 ${config.dms ? 'border-primary text-primary' : 'text-muted-foreground'}`}
            >
              {config.dms ? '✓ ' : ''}DMs
            </button>

            {config.dryRun ? (
              confirmLive ? (
                <span className="inline-flex items-center gap-2 rounded-md border border-destructive/50 px-2 py-1 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  {counts.sent === 0
                    ? 'It has never sent anything to a member. Answer people for real?'
                    : 'Answer people without you reading it first?'}
                  <button type="button" className="rounded border border-destructive/50 px-2 py-0.5 text-destructive"
                    onClick={() => { setConfirmLive(false); onToggle({ dryRun: false }, 'r-dry'); }}>
                    Yes, go live
                  </button>
                  <button type="button" className="rounded border px-2 py-0.5" onClick={() => setConfirmLive(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" disabled={!!busy} onClick={() => setConfirmLive(true)}
                  className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50">
                  Go live
                </button>
              )
            ) : (
              <button type="button" disabled={!!busy} onClick={() => onToggle({ dryRun: true }, 'r-dry')}
                className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50">
                Back to drafting only
              </button>
            )}

            <button
              type="button" disabled={!!busy}
              onClick={onSweep}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {busy === 'r-sweep' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sweep now
            </button>
          </>
        ) : null}
      </div>

      {config.enabled ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Field label="Sweep every (min)">
              <input type="number" min={5} max={1440} value={config.everyMinutes}
                onChange={(e) => onEdit({ everyMinutes: Number(e.target.value) })}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </Field>
            <Field label="Most per sweep">
              <input type="number" min={1} max={20} value={config.maxPerSweep}
                onChange={(e) => onEdit({ maxPerSweep: Number(e.target.value) })}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </Field>
            <Field label="Most per 24h">
              <input type="number" min={1} max={100} value={config.maxPerDay}
                onChange={(e) => onEdit({ maxPerDay: Number(e.target.value) })}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </Field>
            <Field label="Ignore older than (days)">
              <input type="number" min={1} max={365} value={config.maxAgeDays}
                onChange={(e) => onEdit({ maxAgeDays: Number(e.target.value) })}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </Field>
            <Field label="Posts to scan">
              <input type="number" min={1} max={25} value={config.postsToScan}
                onChange={(e) => onEdit({ postsToScan: Number(e.target.value) })}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm" />
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {/* Counts by state, not a total: `unconfirmed` and `failed` are the
                  two that need a person, and a total hides both. */}
              {counts.sent} sent ({counts.sentLastDay} in 24h) · {counts.drafted} waiting · {counts.skipped} left for you
              {counts.unconfirmed ? ` · ${counts.unconfirmed} unconfirmed` : ''}
              {counts.failed ? ` · ${counts.failed} failed` : ''}
            </span>
            <span>
              {health.lastSweepAt
                ? `Last swept ${new Date(health.lastSweepAt).toLocaleString()} — ${health.lastOutcome || 'no outcome recorded'}`
                : 'Never swept.'}
            </span>
          </div>

          {dirty ? (
            <button type="button" disabled={!!busy} onClick={onSave}
              className="mt-3 inline-flex items-center gap-2 rounded-md border border-primary px-3 py-1.5 text-xs text-primary disabled:opacity-50">
              {busy === 'r-save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save these settings
            </button>
          ) : null}
        </>
      ) : null}

      <div className="mt-5 space-y-3">
        {needsYou.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {sent.length
              ? 'Nothing waiting. Everything it has picked up has been answered.'
              : 'Nothing yet. Any member message it picks up appears here until it is answered.'}
          </p>
        ) : (
          needsYou.map((r) => (
            <ReplyRowCard key={r.id} row={r} busy={busy} communityUrl={communityUrl} onSend={onSend} onRetry={onRetry} onForget={onForget} />
          ))
        )}

        {sent.length ? (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowSent((v) => !v)}
              className="text-xs text-muted-foreground underline underline-offset-2"
            >
              {showSent ? 'Hide' : 'Show'} {sent.length} already answered
            </button>
            {/* Kept reachable rather than hidden: "did that actually go?" is the
                question this record exists to answer, and the reply's own id is
                the only proof there is. */}
            {showSent ? (
              <div className="mt-3 space-y-3 opacity-70">
                {sent.map((r) => (
                  <ReplyRowCard key={r.id} row={r} busy={busy} communityUrl={communityUrl} onSend={onSend} onRetry={onRetry} onForget={onForget} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReplyRowCard({
  row, busy, communityUrl, onSend, onRetry, onForget,
}: {
  row: SkoolReplyRow;
  busy: string | null;
  communityUrl: string | null;
  onSend: (id: string) => void;
  onRetry: (id: string) => void;
  onForget: (id: string) => void;
}) {
  // A comment links to its post; a DM has no URL at all — Skool's chat is a
  // panel, not a page (`skool.com/chat` redirects to the group), so there is
  // deliberately no link rather than a broken one.
  const link = row.surface === 'comment' && communityUrl && row.postSlug
    ? `${communityUrl.replace(/\/+$/, '')}/${row.postSlug}`
    : null;

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${REPLY_STATE_STYLE[row.state]}`}>
          {REPLY_STATE_LABEL[row.state]}
        </span>
        <span className="text-xs font-medium">{row.memberName || 'Unknown member'}</span>
        {/* Empty on every row written before the community went freemium, and a
            badge reading "free" on those would be a claim nothing made. */}
        {row.memberTier ? (
          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${REPLY_TIER_STYLE[row.memberTier] ?? REPLY_TIER_STYLE.unknown}`}>
            {REPLY_TIER_LABEL[row.memberTier] ?? row.memberTier}
            {row.memberTier === 'free' && row.memberLevel ? ` · level ${row.memberLevel}` : ''}
          </span>
        ) : null}
        <span className="text-[11px] text-muted-foreground">
          {row.surface === 'dm' ? 'direct message' : 'comment'} · {new Date(row.createdAt).toLocaleString()}
        </span>
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-primary">
            open <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">“{row.theirText.slice(0, 400)}”</p>

      {row.skipReason ? (
        <p className="mt-2 text-xs">
          {/* A skip is a decision with a reason, never a silent nothing — and
              the reasons it is told to skip on (money, legal, personal) are
              exactly the messages a person needs to see. */}
          <span className="text-muted-foreground">Left for you: </span>{row.skipReason}
        </p>
      ) : null}

      {row.replyText ? (
        <p className="mt-2 whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">{row.replyText}</p>
      ) : null}

      {row.cited.length ? <Cited cited={row.cited} /> : null}

      {row.lastError ? (
        <p className="mt-2 text-xs text-destructive">{row.lastError}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.state === 'drafted' ? (
          <button type="button" disabled={!!busy} onClick={() => onSend(row.id)}
            className="inline-flex items-center gap-2 rounded-md border border-primary px-2 py-1 text-[11px] text-primary disabled:opacity-50">
            {busy === `r-send:${row.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Send this
          </button>
        ) : null}
        {/* ⚠️ THE ROW THAT HAD NO USABLE BUTTON. "Send this" is offered only on
            a draft — correctly, since a blind resend is how somebody gets
            answered twice — which left an unconfirmed row with nothing but
            Forget, and forgetting throws the reviewed reply away. This one
            re-reads the thread FIRST, so pressing it twice cannot double-answer. */}
        {row.state === 'unconfirmed' || row.state === 'failed' ? (
          <button type="button" disabled={!!busy} onClick={() => onRetry(row.id)}
            className="inline-flex items-center gap-2 rounded-md border border-primary px-2 py-1 text-[11px] text-primary disabled:opacity-50">
            {busy === `r-retry:${row.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check and send again
          </button>
        ) : null}
        {/* ⚠️ FORGET IS NOT UNSEND, AND THE LABEL HAS TO SAY SO. It releases the
            message back to the queue so the agent may write to that person
            again — which is the wrong thing to click on a row that says Sent. */}
        {row.state !== 'sent' ? (
          <button type="button" disabled={!!busy} onClick={() => onForget(row.id)}
            className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] text-muted-foreground disabled:opacity-50">
            {busy === `r-forget:${row.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Forget (let it try again)
          </button>
        ) : null}
        {row.tokens ? <span className="text-[11px] text-muted-foreground">{row.tokens.toLocaleString()} tokens</span> : null}
      </div>
    </div>
  );
}

function Cited({ cited }: { cited: { title: string; url: string }[] }) {
  if (!cited.length) return null;
  return (
    <div className="text-xs text-muted-foreground">
      <span className="font-medium">Grounded in:</span>{' '}
      {cited.map((c, i) => (
        <span key={c.url + i}>
          {i > 0 && ' · '}
          <a href={c.url} target="_blank" rel="noreferrer" className="underline">{c.title}</a>
        </span>
      ))}
    </div>
  );
}

/* ─────────────────────────── 4. the bench ─────────────────────────── */

/**
 * Draft off-schedule.
 *
 * The scheduler only writes on posting days, which makes "what does this thing
 * sound like?" a question you would otherwise have to wait until Tuesday to
 * answer. This runs the same drafter with a subject you choose, and can publish
 * the result — but drafting and publishing stay two separate calls, so a failed
 * publish can never quietly re-draft into something other than what was read.
 */
function DraftBench({
  busy, setBusy, aiAuth, onPosted,
}: {
  busy: string | null;
  setBusy: (v: string | null) => void;
  aiAuth: string | null;
  onPosted: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [kind, setKind] = useState<'lesson' | 'mcp' | 'ask'>('lesson');
  // The members an "ask" draft would greet, as the server read them. Kept beside
  // the draft rather than inside it: the chips are typed into the composer, not
  // written into the body, so the body alone cannot show the real opening line.
  const [greeting, setGreeting] = useState<SkoolNewMember[]>([]);
  const [category, setCategory] = useState('');
  const [draft, setDraft] = useState<SkoolDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function go(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setProblem(null);
    setResult(null);
    try {
      await fn();
    } catch (e: any) {
      setProblem(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border p-5">
      <h2 className="mb-1 text-sm font-semibold">Write one now</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Same writer the schedule uses, on a subject you pick. Nothing here reaches the community until you publish it.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="What should the post be about?"
          className="min-w-[16rem] flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          disabled={!!busy}
          onClick={() =>
            go('subject', async () => {
              // ⚠️ THE LESSON PICKER IS THE WRONG SOURCE FOR AN ASK POST — it
              // returns a thing to TEACH, and fed one the drafter writes a
              // lesson with a question stapled on. For "ask" this asks the
              // server who would be greeted instead, and leaves the question
              // itself to the drafter, which is where it is chosen on a real
              // Thursday too.
              if (kind === 'ask') {
                const who = await skoolEngageNewMembers();
                setGreeting(who.members);
                setResult(
                  who.error
                    ? `Could not read the members list: ${who.error}`
                    : who.members.length
                      ? `Would greet ${who.members.map((m) => `@${m.displayName}`).join(', ')}. ${who.detail}`
                      : `Nobody new to greet — the post would open straight on the question. ${who.detail}`,
                );
                return;
              }
              const out = await skoolEngageSubject();
              if (out.subject) setSubject(out.subject);
              if (out.error) setProblem(out.error);
            })
          }
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy === 'subject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {kind === 'ask' ? 'Who would it greet?' : 'What would it pick?'}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border text-xs">
          {(['lesson', 'mcp', 'ask'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-2.5 py-1 ${kind === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {k === 'lesson' ? 'From a lesson' : k === 'mcp' ? 'MCP / tooling' : 'Ask the community'}
            </button>
          ))}
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border bg-background px-2 py-1.5 text-xs"
        >
          <option value="">Let it choose the category</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          type="button"
          disabled={!!busy || !subject.trim()}
          onClick={() =>
            go('draft', async () => {
              const out = await skoolDraftPost({
                kind,
                subject: subject.trim(),
                ...(category ? { category } : {}),
              });
              setDraft(out.draft);
              setGreeting(out.newMembers ?? []);
              if (out.error) setProblem(out.error);
            })
          }
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === 'draft' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Write a draft
        </button>
      </div>

      {problem && (
        <div
          className={`mb-3 rounded-md border p-3 text-xs ${
            isRateLimited(problem) ? 'border-border bg-muted/50 text-muted-foreground' : 'border-destructive/40 bg-destructive/10'
          }`}
        >
          {isRateLimited(problem) ? (
            <>
              <span className="font-medium text-foreground">{rateLimitCopy(aiAuth).headline}</span>{' '}
              Nothing was written. {rateLimitCopy(aiAuth).detail}
            </>
          ) : (
            problem
          )}
        </div>
      )}

      {result && (
        <div className="mb-3 rounded-md border border-[hsl(var(--chart-3))]/40 bg-[hsl(var(--chart-3))]/10 p-3 text-xs">
          {result}
        </div>
      )}

      {draft && (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1.5 text-sm font-semibold">{draft.title}</div>
            {/* Shown INLINE with the body, because that is where they land: the
                chips are typed into the composer first and the body is pasted
                straight after them, on the same line. Rendering them separately
                would hide the one thing worth checking — whether the first
                sentence reads properly after a row of names. */}
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {kind === 'ask' && greeting.length > 0 && (
                <span className="font-medium text-[hsl(var(--chart-1))]">
                  {greeting.map((m) => `@${m.displayName}`).join(' ')}{' '}
                </span>
              )}
              {draft.body}
            </div>
          </div>
          {kind === 'ask' && greeting.length > 0 && (
            <p className="text-xs text-muted-foreground">
              The coloured names are not part of the text — they are typed into the composer as real Skool
              mentions when this is published, which is the only way they notify anybody.
            </p>
          )}
          <Cited cited={draft.cited} />
          {/* Which model wrote it, stated plainly — a draft in the wrong voice
              does not verify the thing that needs verifying. */}
          <div className="text-xs text-muted-foreground">
            {draft.category ? <>Category: <span className="text-foreground">{draft.category}</span> · </> : null}
            Written by <span className="font-mono text-foreground">{draft.model}</span>
            {draft.tokens != null && (
              <> · {draft.tokens.toLocaleString()} tokens{aiAuth === 'subscription' ? ' of the Max window' : ' on API credits'}</>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {confirm ? (
              <>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setConfirm(false);
                    void go('publish', async () => {
                      const out = await skoolPublishPost({
                        title: draft.title,
                        body: draft.body,
                        category: draft.category,
                        // ⚠️ WITHOUT THIS THE BENCH PUBLISHES A FRAGMENT. An ask
                        // draft's first sentence is written to follow a row of
                        // names; posted without them it opens mid-thought, and
                        // the members it was written for are never notified.
                        ...(kind === 'ask' && greeting.length ? { mentions: greeting } : {}),
                      });
                      if (out.ok) {
                        setResult(out.detail);
                        setDraft(null);
                        onPosted();
                      } else {
                        setProblem(out.detail);
                      }
                    });
                  }}
                  className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                >
                  {busy === 'publish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Yes, post this to the community
                </button>
                <button type="button" onClick={() => setConfirm(false)} className="rounded-md border px-3 py-1.5 text-xs">
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setConfirm(true)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                Publish this
              </button>
            )}
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border px-3 py-1.5 text-xs"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
