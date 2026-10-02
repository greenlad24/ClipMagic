/**
 * The Slack answer watcher (Jake, 2026-10-01: "respond on slack immediately
 * when a message comes back … do the actions also immediately — wait till 10
 * minutes after the last message … and only act on the most updated message").
 *
 * Every ~60s it reads the threads of the agent's live Slack questions AND flags
 * (conversations.replies only — the same allow-listed read the run used):
 *
 *   1. a new human reply burst → ONE short acknowledgement in the thread
 *      ("Got it: … I'll act at 14:32 Bangkok time …"). Later edits/additions
 *      before acting only move the act time ("Updated — acting at 14:35").
 *   2. 10 minutes after the LATEST human activity (reply ts or edited.ts) it
 *      records the CURRENT text of every human reply as the answer
 *      (answerQuestion + learnFromAnswer), runs the normal per-thread pipeline
 *      for that one thread (run.ts reprocessAnsweredThread), and posts the
 *      outcome into the thread.
 *   3. Jake writes again after that → same cycle: acknowledge, wait, act again
 *      with the full latest conversation (a new draft next to the old one —
 *      the Gmail allow-list cannot update or delete drafts; Slack says so).
 *
 * State lives in deals_agent_questions (watch_* columns, store.ts), written
 * BEFORE anything is posted — a restart never acknowledges twice and still
 * acts after the wait. The scheduled run skips everything the watcher owns.
 *
 * Quiet by design: no log line per tick, polls slow down for older threads,
 * backs off on errors and honours Slack's Retry-After. Skips while Slack isn't
 * configured or the agent is disabled. Respects the live switches: nothing is
 * posted when postToSlack is off; Gmail writes follow saveToGmail.
 *
 * Not started here — the integrator calls startSlackAnswerWatcher().
 */
import { db } from "../../db/index.js";
import { slackPost, slackThreadReplies, slackStatus } from "../integrations/slack.js";
import { gmailSlackThreadUrl } from "../integrations/gmail.js";
import { getSettings } from "./settings.js";
import { answerQuestion, toQ, type QuestionRow } from "./store.js";
import { learnFromAnswer, setWatcherOwnsReplies } from "./slackLoop.js";
import { reprocessAnsweredThread, isRunning, type AnsweredThreadResult } from "./run.js";
import { aiJSON, triageModel, bangkokParts, clip, errMsg } from "./util.js";

export const QUIET_MS = 10 * 60_000;
const TICK_MS = 60_000;
const MAX_POLLS_PER_TICK = 25;
const TAG = "[deals-slack-watch]";

/* ── the timing rules (pure — unit-tested in scripts/slackWatcher.test.ts) ── */

export interface WatchReply { ts: string; editedTs?: string | null; text: string; bot: boolean }
export interface WatchState {
  /** NULL = the watcher has never touched this row. */
  state: string | null;
  seen: number | null;
  acted: number | null;
  actAt: number | null; // ms
  /** The row already has an answer (from the old twice-a-day collection, or an earlier action). */
  answered: boolean;
}
export type WatchPlan =
  | { kind: "none" }
  /** Old row answered before the watcher existed: remember its replies as already handled. */
  | { kind: "baseline"; activity: number }
  /** The pending replies were deleted: drop the pending action silently. */
  | { kind: "cancel" }
  | { kind: "wait"; activity: number; actAt: number; ack: "new" | "update" | null; fresh: WatchReply[] }
  | { kind: "act"; activity: number; answer: string; followUp: boolean; fresh: WatchReply[] };

const num = (ts: string | null | undefined) => (ts ? Number(ts) || 0 : 0);
const activityOf = (r: WatchReply) => Math.max(num(r.ts), num(r.editedTs));

export function planWatch(replies: WatchReply[], st: WatchState, nowMs: number, quietMs = QUIET_MS): WatchPlan {
  const human = replies.filter((r) => !r.bot && r.text.trim());
  const activity = human.reduce((m, r) => Math.max(m, activityOf(r)), 0);
  if (st.state === null && st.answered) return { kind: "baseline", activity };
  const acted = st.acted ?? 0;
  const answer = human.map((r) => r.text.trim()).join("\n");
  const fresh = human.filter((r) => activityOf(r) > acted);
  // Interrupted mid-action (restart): finish it.
  if (st.state === "acting") return { kind: "act", activity: Math.max(activity, st.seen ?? 0), answer, followUp: acted > 0, fresh };
  if (activity <= acted) return st.actAt != null ? { kind: "cancel" } : { kind: "none" };
  const newBurst = st.seen == null || st.seen <= acted;
  // A deleted reply can lower `activity`; the act time never moves earlier than what was announced.
  const eff = newBurst ? activity : Math.max(activity, st.seen!);
  const actAt = Math.round(eff * 1000) + quietMs;
  if (nowMs >= actAt) return { kind: "act", activity: eff, answer, followUp: acted > 0, fresh };
  const ack = newBurst ? "new" : activity > st.seen! ? "update" : null;
  return { kind: "wait", activity: eff, actAt, ack, fresh };
}

/** HH:MM in Bangkok. */
export function bangkokHHMM(ms: number): string {
  const p = bangkokParts(new Date(ms));
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/** How often a row is read: pending rows every tick, quieter threads less often, stale ones never. */
export function pollEveryMs(row: { watch_state: string | null; asked_at: string; watch_acted_at: string | null; answer: string | null }, nowMs: number): number | null {
  if (row.watch_state === "waiting" || row.watch_state === "acting") return TICK_MS;
  const last = Math.max(Date.parse(row.asked_at) || 0, Date.parse(row.watch_acted_at ?? "") || 0);
  const age = nowMs - last;
  if (age < 48 * 3600_000) return TICK_MS;
  if (age < 7 * 86_400_000) return 5 * 60_000;
  if (age < 21 * 86_400_000) return 30 * 60_000;
  return null;
}

/* ── state (deals_agent_questions.watch_*) ──────────────────────────────── */

function watchedRows(): any[] {
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
  return db.prepare(
    `SELECT * FROM deals_agent_questions WHERE preview = 0 AND slack_ts IS NOT NULL AND slack_channel IS NOT NULL
       AND (asked_at >= ? OR watch_acted_at >= ? OR watch_state IN ('waiting', 'acting')) ORDER BY asked_at`,
  ).all(since, since) as any[];
}

function setWatch(id: string, patch: Record<string, string | number | null>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE deals_agent_questions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
}

function stateOf(row: any): WatchState {
  return {
    state: row.watch_state ?? null,
    seen: row.watch_seen ?? null,
    acted: row.watch_acted ?? null,
    actAt: row.watch_act_at ? Date.parse(row.watch_act_at) : null,
    answered: row.answer != null,
  };
}

/* ── the loop ─────────────────────────────────────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let pausedUntil = 0;
let errorStreak = 0;
const lastPolled = new Map<string, number>();
const rowErrors = new Map<string, number>();
const rowPausedUntil = new Map<string, number>();
const acting = new Set<string>();

async function say(q: QuestionRow, text: string): Promise<void> {
  if (!getSettings().postToSlack) return; // live switch: nothing is posted to Slack
  try {
    await slackPost(text, q.slackTs!, q.slackChannel!);
  } catch (e) {
    console.warn(`${TAG} could not post in the thread for "${clip(q.subject, 60)}": ${errMsg(e)}`);
  }
}

async function paraphrase(q: QuestionRow, fresh: WatchReply[]): Promise<string> {
  const text = fresh.map((r) => r.text.trim()).join("\n");
  try {
    const r = await aiJSON<{ paraphrase?: string }>({
      model: triageModel(),
      purpose: "deals-agent-slack",
      system: "Restate Jake's Slack reply to his email agent as ONE short line (max 18 words) saying what he wants done. Plain words, no quotes, no preamble, no trailing period.",
      user: `Agent's ${q.kind === "flag" ? "flag" : "question"} (email: ${clip(q.subject, 120)}): ${clip(q.question, 600)}\n\nJake's reply:\n${clip(text, 1500)}\n\nReturn JSON: {"paraphrase": string}`,
    });
    const p = String(r?.paraphrase ?? "").trim().replace(/\.$/, "");
    if (p) return clip(p, 200);
  } catch { /* fall back to his own words */ }
  return clip(text.replace(/\s+/g, " "), 160);
}

function outcomeText(q: QuestionRow, r: AnsweredThreadResult): string {
  const link = `<${gmailSlackThreadUrl(q.threadId)}|Open the thread in Gmail>`;
  if (r.skipped) return `Nothing done: ${r.skipped}. ${link}`;
  const it = r.item;
  if (!it) return `I couldn't load that email thread, so nothing was done. ${link}`;
  const lines: string[] = [];
  const reason = clip(it.reason, 600);
  if (it.decision === "draft" || (it.decision === "flag" && it.draftText && it.gmailDraftId)) {
    if (it.gmailDraftId) lines.push(`:white_check_mark: Draft saved in Gmail (not sent). ${link}`, `_${reason}_`);
  }
  if (!lines.length) {
    if ((it.decision === "draft" || it.decision === "flag") && it.draftText && !r.live.gmail) {
      lines.push(`Draft written but NOT saved to Gmail — "Save drafts to Gmail" is off. ${link}`, "```" + clip(it.draftText, 1800) + "```");
    } else if (it.decision === "ask") {
      lines.push(`I still need your call before I draft. ${link}`);
    } else if (it.decision === "skip") {
      lines.push(`No draft written: ${reason} ${link}`);
    } else if (it.decision === "spam") {
      lines.push(`${r.live.gmail ? "Marked as spam" : "Would mark as spam (Gmail writes are off)"}: ${reason} ${link}`);
    } else {
      lines.push(`No draft saved: ${reason} ${link}`);
    }
  }
  for (const n of r.slackNotes) {
    lines.push(`*${n.kind === "flag" ? "Flag" : "Question"}${n.rule ? ` (${n.rule})` : ""}:* ${clip(n.question, 800)}`);
    if (n.proposal) lines.push(`*What I propose:* ${clip(n.proposal, 1500)}`);
  }
  if (r.slackNotes.length || it.decision === "ask") lines.push("_Reply here — I'll act 10 minutes after your last message._");
  if (r.ownDraftLeftBehind) lines.push(":warning: My earlier draft is still in that Gmail thread — please delete the OLD one (I can create drafts but can't edit or delete them).");
  return lines.join("\n");
}

async function act(row: any, plan: Extract<WatchPlan, { kind: "act" }>): Promise<void> {
  const q = toQ(row);
  acting.add(q.id);
  try {
    // Claim first: a restart from here on finishes the action, never repeats the acknowledgement.
    setWatch(q.id, { watch_state: "acting", watch_seen: plan.activity, watch_act_at: null, watch_owned: 1 });
    const answer = plan.answer;
    if (!answer.trim()) { setWatch(q.id, { watch_state: "idle", watch_acted: plan.activity, watch_owned: 0 }); return; }
    answerQuestion(q.id, answer);
    const log = (m: string) => console.log(`${TAG} ${m}`);
    log(`acting on Jake's ${plan.followUp ? "follow-up" : "reply"} for "${clip(q.subject, 70)}": ${clip(answer.replace(/\s+/g, " "), 160)}`);
    const learnText = plan.followUp ? plan.fresh.map((r) => r.text.trim()).join("\n") || answer : answer;
    await learnFromAnswer({ ...q, answer }, learnText, log);
    const note = [
      q.kind === "flag" ? "You had FLAGGED this thread to Jake without drafting. Jake has now replied on Slack — treat his reply as the instruction for this thread." : "",
      plan.followUp ? "Jake wrote again on Slack AFTER your previous action on this thread. His messages are listed oldest first — the newest ones are his latest instruction and override earlier ones where they conflict. Write a fresh reply that follows them." : "",
    ].filter(Boolean).join("\n");
    let r: AnsweredThreadResult;
    try {
      r = await reprocessAnsweredThread({ threadId: q.threadId, answered: [{ ...q, answer }], note: note || undefined, progress: log });
    } catch (e) {
      // Hand the answer back to the scheduled run, which retries it (watch_owned = 0).
      setWatch(q.id, { watch_state: "idle", watch_acted: plan.activity, watch_acted_at: new Date().toISOString(), watch_owned: 0, used_at: null });
      await say(q, `I couldn't act on this yet: ${clip(errMsg(e), 300)}. Your answer is saved — the next scheduled run (08:00 / 20:00 Bangkok) will retry it.`);
      return;
    }
    if (r.skipped === "the agent is switched off") {
      setWatch(q.id, { watch_state: "waiting", watch_act_at: new Date(Date.now() + QUIET_MS).toISOString() });
      return;
    }
    if (r.item?.reason.startsWith("Agent error")) {
      // Something broke mid-thread (AI/Gmail down): nothing was written — hand the answer back to the scheduled run.
      setWatch(q.id, { watch_state: "idle", watch_acted: plan.activity, watch_acted_at: new Date().toISOString(), watch_owned: 0, used_at: null });
      await say(q, `${outcomeText(q, r)}\nYour answer is saved — the next scheduled run (08:00 / 20:00 Bangkok) will retry it.`);
      return;
    }
    const asked = r.item?.decision === "ask" || r.slackNotes.some((n) => n.kind === "question");
    setWatch(q.id, {
      watch_state: asked ? "asked" : "idle",
      watch_acted: plan.activity,
      watch_acted_at: new Date().toISOString(),
      watch_hold_msg: asked ? (r.item ? (db.prepare(`SELECT message_id FROM deals_agent_items WHERE id = ?`).get(r.item.id) as any)?.message_id ?? null : null) : null,
    });
    await say(q, outcomeText(q, r));
  } catch (e) {
    console.warn(`${TAG} action failed for "${clip(q.subject, 60)}": ${errMsg(e)}`);
    setWatch(q.id, { watch_state: "idle", watch_acted: plan.activity, watch_owned: 0, used_at: null });
  } finally {
    acting.delete(q.id);
  }
}

async function handleRow(row: any, nowMs: number): Promise<void> {
  const q = toQ(row);
  const replies = await slackThreadReplies(q.slackChannel!, q.slackTs!);
  const plan = planWatch(replies, stateOf(row), nowMs);
  switch (plan.kind) {
    case "none":
      return;
    case "baseline":
      setWatch(q.id, { watch_state: "idle", watch_seen: plan.activity, watch_acted: plan.activity });
      return;
    case "cancel":
      setWatch(q.id, { watch_state: row.watch_acted ? "idle" : null, watch_seen: row.watch_acted ?? null, watch_act_at: null });
      return;
    case "wait": {
      const prevAt = row.watch_act_at ? Date.parse(row.watch_act_at) : null;
      // Persist BEFORE posting: a crash between the two can drop a message, never send it twice.
      setWatch(q.id, { watch_state: "waiting", watch_seen: plan.activity, watch_act_at: new Date(plan.actAt).toISOString() });
      if (plan.ack === "new") {
        const p = await paraphrase(q, plan.fresh);
        await say(q, `Got it: ${p}. I'll act at ${bangkokHHMM(plan.actAt)} Bangkok time (10 minutes after your last message). Edit or add to your message before then and I'll use the latest version.`);
      } else if (plan.ack === "update" && (prevAt == null || bangkokHHMM(prevAt) !== bangkokHHMM(plan.actAt))) {
        await say(q, `Updated — acting at ${bangkokHHMM(plan.actAt)}.`);
      }
      return;
    }
    case "act":
      if (isRunning()) return; // a scheduled/manual run is processing threads — act on the next tick
      void act(row, plan); // don't hold up the other threads' acknowledgements
      return;
  }
}

export async function watchTick(nowMs = Date.now()): Promise<void> {
  if (ticking || nowMs < pausedUntil) return;
  ticking = true;
  try {
    if (!slackStatus().configured) return;
    if (!getSettings().enabled) return;
    let polls = 0, failed = 0, lastErr: unknown = null;
    for (const row of watchedRows()) {
      if (acting.has(row.id)) continue;
      const every = pollEveryMs(row, nowMs);
      if (every == null) continue;
      if (nowMs < (rowPausedUntil.get(row.id) ?? 0)) continue;
      if (nowMs - (lastPolled.get(row.id) ?? 0) < every - 5_000) continue;
      if (polls++ >= MAX_POLLS_PER_TICK) break;
      lastPolled.set(row.id, nowMs);
      try {
        await handleRow(row, nowMs);
        if (rowErrors.delete(row.id)) rowPausedUntil.delete(row.id);
      } catch (e: any) {
        if (e?.retryAfterSec) {
          pausedUntil = Date.now() + e.retryAfterSec * 1000;
          console.warn(`${TAG} Slack rate limit — pausing ${e.retryAfterSec}s`);
          return;
        }
        // One bad thread (deleted, archived channel…) backs off on its own; it never stalls the others.
        failed++; lastErr = e;
        const n = (rowErrors.get(row.id) ?? 0) + 1;
        rowErrors.set(row.id, n);
        rowPausedUntil.set(row.id, nowMs + Math.min(6 * 3600_000, TICK_MS * 2 ** Math.min(n, 9)));
        if (n === 1) console.warn(`${TAG} could not read the Slack thread for "${clip(row.subject, 60)}": ${errMsg(e)}`);
      }
    }
    if (polls > 1 && failed === polls) throw lastErr; // everything failed (token revoked, Slack down) → global back-off
    if (errorStreak) console.log(`${TAG} recovered after ${errorStreak} failed tick(s)`);
    errorStreak = 0;
  } catch (e) {
    errorStreak++;
    const backoff = Math.min(30 * 60_000, TICK_MS * 2 ** Math.min(errorStreak, 5));
    pausedUntil = Date.now() + backoff;
    if (errorStreak === 1 || errorStreak % 10 === 0) console.warn(`${TAG} tick failed (${errorStreak}x), retrying in ${Math.round(backoff / 60_000)} min: ${errMsg(e)}`);
  } finally {
    ticking = false;
  }
}

/** Start the watcher (idempotent). The scheduled run stops collecting Slack answers itself from now on. */
export function startSlackAnswerWatcher(): void {
  if (timer) return;
  setWatcherOwnsReplies(true);
  try {
    // A Slack action interrupted by a restart: close its run row (its question row resumes on its own).
    db.prepare(`UPDATE deals_agent_runs SET status = 'failed', error = COALESCE(error, 'interrupted (server restarted mid-action)'), finished_at = ? WHERE status = 'running' AND trigger = 'slack'`)
      .run(new Date().toISOString());
  } catch { /* table may not exist yet on a fresh box */ }
  console.log(`${TAG} started — reads the agent's Slack threads every ${TICK_MS / 1000}s, acts ${QUIET_MS / 60_000} min after Jake's last message`);
  setTimeout(() => void watchTick(), 15_000).unref?.();
  timer = setInterval(() => void watchTick(), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}
