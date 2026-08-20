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
  AlertTriangle, Check, Clock, ExternalLink, Loader2, PauseCircle, PlayCircle,
  RefreshCw, Send, Sparkles, X,
} from 'lucide-react';
import {
  skoolStatus,
  skoolEngageStatus,
  skoolEngageConfigure,
  skoolEngageTick,
  skoolEngagePublish,
  skoolEngageSubject,
  skoolDraftPost,
  skoolPublishPost,
  type SkoolEngageSchedule,
  type SkoolSlot,
  type SkoolSlotState,
  type SkoolWeekday,
  type SkoolDraft,
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

  useEffect(() => {
    void skoolStatus()
      .then((s) => setCommunityUrl(s.settings.communityUrl || null))
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
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }, [dirty]);

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
            Writes community posts on a schedule, grounded in your 15 rebuilt courses — the lesson pages and what
            you actually say in the videos. It runs unattended, so everything it writes lands here first.
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

            <SchedulePanel
              schedule={schedule}
              now={now}
              busy={busy}
              onEdit={(patch) => {
                setSchedule({ ...schedule, ...patch });
                setDirty(true);
              }}
              dirty={dirty}
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

function SchedulePanel({
  schedule, now, busy, dirty, onEdit, onSave, onTick, onRefresh,
}: {
  schedule: SkoolEngageSchedule;
  now: { date: string; weekday: SkoolWeekday; hour: number } | null;
  busy: string | null;
  dirty: boolean;
  onEdit: (patch: Partial<SkoolEngageSchedule>) => void;
  onSave: () => void;
  onTick: () => void;
  onRefresh: () => void;
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
        <Field label="Most scheduled posts in a week">
          <input
            type="number" min={1} max={14}
            value={schedule.maxPostsPerWeek}
            onChange={(e) => onEdit({ maxPostsPerWeek: Number(e.target.value) })}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          />
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
          </div>

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
  const [kind, setKind] = useState<'lesson' | 'mcp'>('lesson');
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
              const out = await skoolEngageSubject();
              if (out.subject) setSubject(out.subject);
              if (out.error) setProblem(out.error);
            })
          }
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy === 'subject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          What would it pick?
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border text-xs">
          {(['lesson', 'mcp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-2.5 py-1 ${kind === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {k === 'lesson' ? 'From a lesson' : 'MCP / tooling'}
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
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{draft.body}</div>
          </div>
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
