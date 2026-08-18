/**
 * Engagement Manager — autonomous reply worker (Phase 3).
 *
 * One loop, two phases, run every minute:
 *   DRAFT    — for each browser-driven platform, take the newest un-decided
 *              inbox items on channels whose reply_mode isn't 'off', ask Claude
 *              for a reply (engage/replyGen.ts), and record the decision. In
 *              'suggest' mode the row lands as a `draft` awaiting a human; in
 *              'auto' mode it lands as `pending` with a randomized send time.
 *   DISPATCH — take replies that are due, re-check the throttle AT SEND TIME,
 *              and deliver them (engage/senders.ts): Meta's Graph API first,
 *              headless browser only as a fallback, TikTok browser-only.
 *
 * THREE INDEPENDENT SAFETY KEYS, all of which must be turned before a single
 * reply reaches a platform:
 *   1. killSwitch OFF   — the master switch, armed by default. While armed this
 *                         loop does nothing at all: no generation, no spend.
 *   2. globalAutoreply ON — checked at dispatch; drafts still accumulate.
 *   3. reply_mode 'auto' on the channel (and a non-zero cap for the platform).
 * Plus ENGAGE_REPLY_DRY_RUN, which defaults ON and stops the sender one step
 * short of posting.
 *
 * The loop NEVER throws: it is started at boot alongside the monitor and must
 * not be able to take the server down.
 */
import { BROWSER_PLATFORMS, type BrowserPlatform } from "./browser.js";
import {
  createReply,
  dueReplies,
  getChannel,
  getInboxItem,
  getSettings,
  getThread,
  replyCandidates,
  sentInWindow,
  setInboxReplyState,
  updateReply,
} from "./db.js";
import { generateReply, replyGenReady } from "./replyGen.js";
import { dryRunEnabled, sendReply } from "./senders.js";
import { canSend, capsFor, humanDelayMs, recordSend, scheduleAt, windowStart } from "./throttle.js";
import type { EngageSettings, InboxItem, Platform } from "./types.js";

/** How often the loop runs. */
function intervalMs(): number {
  const n = Number.parseInt(process.env.ENGAGE_REPLY_INTERVAL_MS || "", 10);
  return Number.isFinite(n) && n >= 15_000 ? n : 60_000;
}

/** Hard ceiling on drafts per platform per cycle (cost control). */
const MAX_DRAFTS_PER_PLATFORM = 3;
/** Hard ceiling on dispatches per cycle — pacing does the rest. */
const MAX_DISPATCH_PER_CYCLE = 2;
/** Attempts before a reply is marked failed for good. */
const MAX_ATTEMPTS = 3;

interface WorkerState {
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  drafted: number;
  sent: number;
}

const state: WorkerState = { running: false, lastRunAt: null, lastError: null, drafted: 0, sent: 0 };

export function replyWorkerState(): Readonly<WorkerState> {
  return state;
}

let timer: NodeJS.Timeout | null = null;

/** Start the background reply loop (idempotent). */
export function startReplyWorker(): void {
  if (timer) return;
  const interval = intervalMs();
  console.log(
    `[engage/reply] worker started — every ${Math.round(interval / 1000)}s, dry-run=${dryRunEnabled() ? "ON" : "OFF"}`,
  );
  // Offset from the monitor's startup kick so they don't contend on boot.
  setTimeout(() => void runReplyCycle("startup"), 45_000);
  timer = setInterval(() => void runReplyCycle("interval"), interval);
  if (typeof timer.unref === "function") timer.unref();
}

/** Run one cycle on demand. Returns false when one is already in flight. */
export function replyCycleNow(): { started: boolean } {
  if (state.running) return { started: false };
  void runReplyCycle("on-demand");
  return { started: true };
}

/** One full cycle. NEVER throws. */
async function runReplyCycle(trigger: string): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const settings = getSettings();

    // Key 1: the master switch. Armed = the whole reply path is inert, including
    // generation — so a paused bot costs nothing and decides nothing.
    if (settings.killSwitch) {
      state.lastError = null;
      return;
    }

    let drafted = 0;
    for (const platform of BROWSER_PLATFORMS) {
      drafted += await draftForPlatform(platform, settings);
    }

    const sent = await dispatchDue(settings);

    state.drafted += drafted;
    state.sent += sent;
    state.lastRunAt = Date.now();
    state.lastError = null;
    if (drafted > 0 || sent > 0) {
      console.log(`[engage/reply] cycle (${trigger}): drafted ${drafted}, dispatched ${sent}`);
    }
  } catch (e) {
    state.lastError = errMsg(e);
    console.warn(`[engage/reply] cycle error: ${errMsg(e)}`);
  } finally {
    state.running = false;
  }
}

// ── DRAFT phase ───────────────────────────────────────────────────────────────

/**
 * How many drafts are worth writing for a platform right now. Bounded by what
 * could actually still be SENT today — there is no point paying Opus to draft
 * replies that the daily cap guarantees will never go out.
 */
function draftBudget(settings: EngageSettings, platform: Platform): number {
  const caps = capsFor(settings, platform);
  if (caps.day <= 0) return 0;
  const usedToday = sentInWindow(platform, "day", windowStart("day"));
  const remaining = Math.max(0, caps.day - usedToday);
  return Math.min(MAX_DRAFTS_PER_PLATFORM, remaining);
}

async function draftForPlatform(platform: BrowserPlatform, settings: EngageSettings): Promise<number> {
  if (!replyGenReady(settings.replyPromptMd)) return 0;
  const budget = draftBudget(settings, platform);
  if (budget <= 0) return 0;

  const candidates = replyCandidates(platform, budget);
  let n = 0;
  for (const item of candidates) {
    try {
      if (await draftOne(item, settings)) n++;
    } catch (e) {
      // One bad item must not stop the rest of the batch.
      console.warn(`[engage/reply] draft failed for ${item.id}: ${errMsg(e)}`);
    }
  }
  return n;
}

/** Draft (or deliberately skip) a reply for one item. Returns true if drafted. */
async function draftOne(item: InboxItem, settings: EngageSettings): Promise<boolean> {
  const channel = getChannel(item.channelId);
  if (!channel || channel.replyMode === "off") return false;

  const thread = item.threadId ? getThread(item.threadId) : [];
  const draft = await generateReply({
    item,
    thread,
    channelName: channel.displayName,
    replyPromptMd: settings.replyPromptMd ?? "",
  });

  if (!draft.shouldReply || !draft.text) {
    createReply({
      inboxId: item.id,
      channelId: item.channelId,
      platform: item.platform,
      status: "skipped",
      mechanism: null,
      generatedText: null,
      decideReason: draft.reason,
      notBefore: Date.now(),
      costUsd: draft.costUsd,
    });
    setInboxReplyState(item.id, "skipped");
    return false;
  }

  // 'auto' queues for dispatch; 'suggest' waits for a human to approve.
  // forceReview overrides 'auto': the draft is fine but it broke a mechanical
  // limit (too long, or an unexpected link), so a person looks at it rather
  // than it going out or being thrown away.
  const auto = channel.replyMode === "auto" && !draft.forceReview;
  createReply({
    inboxId: item.id,
    channelId: item.channelId,
    platform: item.platform,
    status: auto ? "pending" : "draft",
    // Unknown until dispatch: the API is tried first and the browser is only
    // used if it isn't permitted, so the mechanism is recorded when it's sent.
    mechanism: null,
    generatedText: draft.text,
    decideReason: draft.reason,
    notBefore: auto ? scheduleAt(settings.pacing) : Date.now(),
    costUsd: draft.costUsd,
  });
  setInboxReplyState(item.id, "queued");
  return true;
}

// ── DISPATCH phase ────────────────────────────────────────────────────────────

async function dispatchDue(settings: EngageSettings): Promise<number> {
  const due = dueReplies(MAX_DISPATCH_PER_CYCLE, Date.now(), MAX_ATTEMPTS);
  let sent = 0;

  for (const reply of due) {
    // Key 2 + the caps + active hours, re-checked HERE rather than at draft
    // time: a reply queued an hour ago must not slip past a cap that has since
    // filled, or go out after someone armed the kill-switch.
    const verdict = canSend(settings, reply.platform, Date.now());
    if (!verdict.allowed) {
      // Not a failure — just not now. Push it out and leave attempts alone so a
      // closed window can never exhaust a reply's retries.
      updateReply(reply.id, {
        notBefore: Date.now() + Math.max(humanDelayMs(settings.pacing), 5 * 60_000),
        decideReason: reply.decideReason,
        error: verdict.reason,
      });
      continue;
    }

    const item = getInboxItem(reply.inboxId);
    if (!item) {
      updateReply(reply.id, { status: "skipped", error: "Inbox item no longer exists." });
      continue;
    }
    if (!reply.generatedText) {
      updateReply(reply.id, { status: "skipped", error: "No generated text to send." });
      setInboxReplyState(reply.inboxId, "skipped");
      continue;
    }

    const attempts = reply.attempts + 1;
    const result = await sendReply(reply.platform as BrowserPlatform, {
      permalink: item.permalink,
      text: reply.generatedText,
      channelId: reply.channelId,
      commentId: item.dedupKey,
      threadId: item.threadId,
      // A DM goes out through Meta's Send API, addressed to the sender and
      // bounded by their message's age — none of which a comment reply needs.
      kind: item.kind,
      authorId: item.authorId,
      postedAt: item.postedAt,
    });

    if (result.ok) {
      updateReply(reply.id, {
        status: "sent",
        attempts,
        mechanism: result.mechanism,
        externalReplyId: result.externalId,
        error: null,
        sentAt: Date.now(),
      });
      setInboxReplyState(reply.inboxId, "replied");
      recordSend(reply.platform);
      sent++;
      console.log(
        `[engage/reply] sent ${reply.platform} reply to ${item.authorName ?? "someone"} via ${result.mechanism}`,
      );
      continue;
    }

    if (result.dryRun) {
      // A dry run is not a failure and must not burn an attempt — it also must
      // not book against the rate caps, since nothing was posted.
      updateReply(reply.id, {
        notBefore: Date.now() + 30 * 60_000,
        error: result.error,
      });
      continue;
    }

    // Some failures never come good — a DM past Meta's 24-hour window, a missing
    // messaging scope. Retrying those twice more just delays the same answer and
    // buries it under "attempt 3 of 3", so they fail now, with their real reason.
    const exhausted = result.permanent === true || attempts >= MAX_ATTEMPTS;
    updateReply(reply.id, {
      status: exhausted ? "failed" : "pending",
      attempts,
      error: result.error,
      // Back off geometrically between attempts.
      notBefore: exhausted ? reply.notBefore : Date.now() + attempts * 10 * 60_000,
    });
    if (exhausted) {
      setInboxReplyState(reply.inboxId, "failed");
      console.warn(`[engage/reply] giving up on ${reply.id}: ${result.error}`);
    }
  }

  return sent;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
