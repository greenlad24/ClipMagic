/**
 * The reply agent: answer comments on Jake's posts, and DMs from members.
 *
 * ⚠️⚠️ THIS IS THE SECOND AUTONOMOUS WRITER IN THIS COMMUNITY AND IT IS THE
 * LESS RECOVERABLE ONE. The poster writes one thing that 65 people may read; a
 * reply is addressed to a named member, and a DM lands in a private inbox with
 * no post to delete afterwards. So every safety here is structural rather than
 * a line in a prompt — the same bargain `engageSchedule.ts` made, for the same
 * reason: nothing reads the output before the member does.
 *
 * The four that matter, in the order they were learned elsewhere in this file's
 * neighbourhood:
 *
 * 1. **DEFAULTS ARE OFF AND DRY-RUN**, and comments and DMs arm separately.
 *    Answering under your own post and messaging someone privately are not the
 *    same act and must not be one switch.
 * 2. **THE LEDGER IS WRITTEN BEFORE THE SEND, NOT AFTER.** The poster's rule is
 *    the opposite ("write the row when the post lands") and it is right there,
 *    because a post that fails to publish must not burn its subject. Here the
 *    asymmetry runs the other way: answering a member twice cannot be undone,
 *    and failing to answer them is visible in this table. See `skool_reply_log`.
 * 3. **THE FILTERS ARE THE SAFETY, NOT THE PROMPT** — `answerable()` and
 *    `needingReply()` decide what the drafter is even shown. A drafter asked
 *    "should I reply to this?" will sometimes say yes to its own reply.
 * 4. **CAPS ON A SWEEP AND ON A DAY.** The first run against a community with
 *    167 threads is exactly when a bug is worth the least and costs the most.
 */
import { db } from "../db/index.js";
import { getSkoolSettings } from "../db/skool.js";
import { getSettings as getEngageSettings } from "../engage/db.js";
import { readComments, answerable, type SkoolComment } from "./comments.js";
import { readChannels, readMessages, needingReply, sendDm, type DmChannel, type DmMessage } from "./dms.js";
import { readFeed, type SkoolPost } from "./community.js";
import { draftReply, firstNameOf } from "./engageGen.js";
import { ensureAccessFresh, entitlementFor, type Entitlement } from "./access.js";
import { replyToComment } from "./engageActions.js";

export type ReplySurface = "comment" | "dm";
export type ReplyState = "drafted" | "sent" | "unconfirmed" | "skipped" | "failed";

/* ────────────────────────── settings ────────────────────────── */

export interface ReplyConfig {
  /** The master switch. Off means the sweep does not even read. */
  enabled: boolean;
  /**
   * Draft and prove the write path, stopping one click short.
   *
   * ⚠️ IT IS NOT A SIMULATION on either surface: `replyToComment` opens the real
   * editor on the real comment and pastes the real text, and `sendDm` types into
   * the real thread. Only the submit is withheld. That is how the poster was
   * proven and it is the only way to learn whether the join works without a
   * member seeing the answer.
   */
  dryRun: boolean;
  /** Answer comments on posts. */
  comments: boolean;
  /**
   * Answer direct messages.
   *
   * ⚠️ SEPARATE FROM `comments` ON PURPOSE, AND THE RISKIER OF THE TWO. A
   * comment reply is public and correctable in the open; a DM is private, and
   * Skool's composer SENDS ON ENTER — there is no button to withhold.
   */
  dms: boolean;
  /** Minutes between sweeps. The tick runs every 10; this throttles the work. */
  everyMinutes: number;
  /** Most replies one sweep may write. */
  maxPerSweep: number;
  /** Most replies in any rolling 24 hours, across both surfaces. */
  maxPerDay: number;
  /** How old a member's message may be and still get an answer. */
  maxAgeDays: number;
  /** How many recent posts to look for comments under. */
  postsToScan: number;
  /**
   * How many times one message's reply may be attempted before a human is
   * needed.
   *
   * ⚠️ THIS IS WHAT MAKES A FAILURE SELF-HEALING RATHER THAN PERMANENT. Driving
   * somebody else's SPA through a headless browser fails sometimes — that is not
   * a bug to be finally fixed, it is the medium. Before this existed an
   * `unconfirmed` row was never touched again, which was SAFE (no double
   * answers) and also meant "it did not work" was the final state for that
   * member. See `reconcileUnfinished`: the retry is only safe because the
   * re-read is exact.
   */
  maxSendAttempts: number;
}

const DEFAULTS: ReplyConfig = {
  // ⚠️ OFF AND DRY-RUN, and it stays that way until a human has read what this
  // writes. Same rule and same wording as the poster's schedule: arming is two
  // deliberate acts, not one.
  enabled: false,
  dryRun: true,
  comments: true,
  dms: true,
  // ⚠️ NOT EVERY TICK. The tick fires every 10 minutes; a sweep is a feed read
  // plus a post read per commented post plus the DM channel list — call it five
  // navigations, which at 10-minute intervals is 720 a day against one shared
  // browser that the poster also needs. Hourly is still far faster than a
  // member expects an answer.
  everyMinutes: 60,
  maxPerSweep: 3,
  maxPerDay: 10,
  maxAgeDays: 30,
  postsToScan: 5,
  maxSendAttempts: 3,
};

function readJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getReplyConfig(): ReplyConfig {
  const row = db
    .prepare("SELECT engage_replies_json AS j FROM skool_settings WHERE id = 1")
    .get() as { j?: string } | undefined;
  // An absent or unparseable blob means OFF, never "the defaults minus enabled":
  // a database that upgrades into this column must not start messaging people.
  return { ...DEFAULTS, ...readJson<Partial<ReplyConfig>>(row?.j, {}) };
}

export function setReplyConfig(patch: Partial<ReplyConfig>): ReplyConfig {
  const next = { ...getReplyConfig(), ...patch };
  next.everyMinutes = Math.max(5, Math.floor(next.everyMinutes));
  next.maxPerSweep = Math.max(1, Math.min(20, Math.floor(next.maxPerSweep)));
  next.maxPerDay = Math.max(1, Math.min(100, Math.floor(next.maxPerDay)));
  next.maxAgeDays = Math.max(1, Math.min(365, Math.floor(next.maxAgeDays)));
  next.postsToScan = Math.max(1, Math.min(25, Math.floor(next.postsToScan)));
  next.maxSendAttempts = Math.max(1, Math.min(10, Math.floor(next.maxSendAttempts)));
  db
    .prepare("UPDATE skool_settings SET engage_replies_json = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next), Date.now());
  return next;
}

/* ────────────────────────── the ledger ────────────────────────── */

export interface ReplyRow {
  id: string;
  surface: ReplySurface;
  targetId: string;
  postSlug: string;
  channelId: string;
  memberId: string;
  memberName: string;
  /**
   * What the agent believed the member was PAYING when it wrote: 'free',
   * 'paid', or 'unknown' (nothing was known, so free was applied). Empty on
   * rows written before the community went freemium.
   */
  memberTier: string;
  memberLevel: number;
  theirText: string;
  state: ReplyState;
  replyText: string;
  skipReason: string;
  cited: { title: string; url: string }[];
  replyId: string;
  tokens: number;
  attempts: number;
  lastError: string;
  steps: string;
  createdAt: number;
  updatedAt: number;
}

/** Same rule as the slot table: every text column is NOT NULL DEFAULT ''. */
const text = (v: unknown): string => (v == null ? "" : String(v));

const rowToReply = (r: any): ReplyRow => ({
  id: String(r.id),
  surface: r.surface === "dm" ? "dm" : "comment",
  targetId: String(r.target_id),
  postSlug: String(r.post_slug ?? ""),
  channelId: String(r.channel_id ?? ""),
  memberId: String(r.member_id ?? ""),
  memberName: String(r.member_name ?? ""),
  memberTier: String(r.member_tier ?? ""),
  memberLevel: Number(r.member_level ?? 0),
  theirText: String(r.their_text ?? ""),
  state: (["drafted", "sent", "unconfirmed", "skipped", "failed"] as const).includes(r.state) ? r.state : "failed",
  replyText: String(r.reply_text ?? ""),
  skipReason: String(r.skip_reason ?? ""),
  cited: readJson<{ title: string; url: string }[]>(r.cited_json, []),
  replyId: String(r.reply_id ?? ""),
  tokens: Number(r.tokens ?? 0),
  attempts: Number(r.attempts ?? 0),
  lastError: String(r.last_error ?? ""),
  steps: String(r.steps ?? ""),
  createdAt: Number(r.created_at ?? 0),
  updatedAt: Number(r.updated_at ?? 0),
});

const keyFor = (surface: ReplySurface, targetId: string): string => `${surface}:${targetId}`;

export function listReplies(limit = 40): ReplyRow[] {
  return (
    db.prepare("SELECT * FROM skool_reply_log ORDER BY created_at DESC LIMIT ?").all(limit) as any[]
  ).map(rowToReply);
}

export function getReply(id: string): ReplyRow | null {
  const r = db.prepare("SELECT * FROM skool_reply_log WHERE id = ?").get(id) as any;
  return r ? rowToReply(r) : null;
}

/**
 * Every message that has already been engaged with, in any state.
 *
 * ⚠️ IN ANY STATE IS THE POINT — see the table comment. A row that ended
 * 'failed' or 'unconfirmed' still means something was spent on that message and
 * possibly typed into a live thread, so the collector must not offer it again.
 * Clearing one is a human act, which is why `forget()` exists and the sweep
 * never calls it.
 */
function engagedIds(): Set<string> {
  return new Set(
    (db.prepare("SELECT id FROM skool_reply_log").all() as { id: string }[]).map((r) => r.id),
  );
}

function sentLastDay(): number {
  const since = Date.now() - 24 * 3600_000;
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM skool_reply_log WHERE state = 'sent' AND updated_at >= ?")
    .get(since) as { n: number };
  return r.n;
}

/**
 * Whether this DM may carry a nudge towards the plans page, and why.
 *
 * Jake, 2026-08-27: a free member should be helped, "but in a non-salsy way
 * nudge them to take a look at [the plans page] to upgrade to get a specific
 * course or something more from this community - only do it once per whole
 * conversation so it doesn't sound salesy. You can do it twice only if the
 * member is asking specifically for 'where can I upgrade'."
 *
 * ⚠️⚠️ "ONCE PER CONVERSATION" IS A FACT ABOUT THE THREAD, SO IT IS COUNTED,
 * NOT REQUESTED. A prompt cannot know what the drafter said last Tuesday: every
 * reply is written from scratch by a model that has never seen its own previous
 * output, so "mention this only once" asked in the prompt means "mention it
 * every single time" in practice — a free member gets the same link in four
 * consecutive answers, which is the exact thing being avoided.
 *
 * TWO PLACES ARE COUNTED, because either one alone would miss a real nudge:
 *   • THE LEDGER, keyed on the channel. This is our own record of what was
 *     written to this person, and it is checked in every state that reached
 *     them or is about to — a draft waiting for review has not been seen yet,
 *     but sending it would be the second nudge if this reply carried one too.
 *   • THE THREAD ITSELF. Jake answers his own DMs, and a link he sent by hand
 *     an hour ago is still a link this person has just been given.
 */
export function plansNudgeState(
  channelId: string,
  theirText: string,
  transcript: string,
  plansUrl: string,
): { allowed: boolean; asked: boolean; seen: number; why: string } {
  const asked = asksAboutUpgrading(theirText);
  // The path, not the whole URL: it survives a trailing slash, a query string
  // and the difference between www.skool.com and skool.com.
  const needle = "/plans";

  let seen = 0;
  if (channelId) {
    const rows = db
      .prepare(
        `SELECT reply_text FROM skool_reply_log
          WHERE surface = 'dm' AND channel_id = ?
            AND state IN ('sent', 'unconfirmed', 'drafted')`,
      )
      .all(channelId) as { reply_text: string }[];
    seen += rows.filter((r) => String(r.reply_text ?? "").includes(needle)).length;
  }
  if (transcript.includes(needle)) seen += 1;

  // Asked outright, the link IS the answer — so a second one is allowed and a
  // third is not. Unasked, one per conversation, ever.
  const allowance = asked ? 2 : 1;
  const allowed = seen < allowance;
  return {
    allowed,
    asked,
    seen,
    why: allowed
      ? asked
        ? `They asked how to upgrade and the plans page has come up ${seen} time(s), so the link is the answer.`
        : `The plans page has not come up in this conversation, so one plain mention is allowed.`
      : asked
        ? `The plans page has already come up ${seen} times in this conversation, which is the limit even when asked.`
        : `The plans page has already come up in this conversation (${seen}), so it must not come up again.`,
  };
}

/**
 * Are they actually asking how to pay for this community?
 *
 * ⚠️ DELIBERATELY NARROW, AND A MISS IS THE SAFE DIRECTION. Reading "how much
 * does HeyGen cost" as an upgrade question would spend a second nudge on
 * somebody who asked about a video tool. Missing a real one costs nothing worse
 * than the ordinary single mention every free member's conversation allows.
 */
export function asksAboutUpgrading(text: string): boolean {
  // ⚠️⚠️ SENTENCE BY SENTENCE, AND THE WORD "UPGRADE" ALONE IS NOT ENOUGH.
  // "Should I upgrade to ChatGPT Plus?" is the commonest question in a
  // beginners' community about AI tools, and reading it as "where do I upgrade
  // my membership" would answer a tool question with a link to Jake's plans
  // page — the precise thing that makes an agent feel like a salesman. So a
  // sentence naming a TOOL never counts, and "I upgraded ChatGPT. Where do I
  // upgrade here?" is two sentences for exactly this reason.
  const TOOL =
    /\b(chatgpt|gpt-?[0-9]|claude|gemini|copilot|perplexity|midjourney|heygen|synthesia|canva|veed|make\.com|zapier|n8n|notion|figma|runway|sora|elevenlabs)\b/;

  for (const sentence of String(text ?? "").toLowerCase().split(/[.?!\n]+/)) {
    if (!sentence.trim()) continue;
    const aboutATool = TOOL.test(sentence);
    if (!aboutATool && /\bupgrad(e|ing)\b/.test(sentence)) return true;
    if (!aboutATool && /\b(plans page|paid (plan|member|membership|tier)|premium member)\b/.test(sentence)) return true;
    // "how do I join the paid side", "where do I subscribe to the community".
    // No tool test here: the object of the verb is already this community.
    if (/\b(join|subscribe|sign\s?up|pay for|get access to)\b[^,]{0,40}\b(community|membership|classroom|courses?|inside)\b/.test(sentence)) {
      return true;
    }
    if (!aboutATool && /\bhow much\b[^,]{0,30}\b(community|membership|month|monthly)\b/.test(sentence)) return true;
  }
  return false;
}

function insertReply(row: {
  surface: ReplySurface;
  targetId: string;
  postSlug?: string;
  channelId?: string;
  memberId?: string;
  memberName?: string;
  memberTier?: string;
  memberLevel?: number;
  theirText?: string;
  state: ReplyState;
  replyText?: string;
  skipReason?: string;
  cited?: { title: string; url: string }[];
  tokens?: number;
  lastError?: string;
}): string {
  const id = keyFor(row.surface, row.targetId);
  const now = Date.now();
  // A plain INSERT, and only a genuine duplicate key tolerated — the poster's
  // `INSERT OR IGNORE` lesson, where OR IGNORE swallowed a NOT NULL violation
  // and reported having queued something it had not.
  try {
    db
      .prepare(
        `INSERT INTO skool_reply_log
           (id, surface, target_id, post_slug, channel_id, member_id, member_name, member_tier, member_level,
            their_text, state, reply_text, skip_reason, cited_json, reply_id, tokens, attempts, last_error, steps,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?, '', ?, ?)`,
      )
      .run(
        id, row.surface, row.targetId, text(row.postSlug), text(row.channelId), text(row.memberId),
        text(row.memberName), text(row.memberTier), Number(row.memberLevel ?? 0),
        text(row.theirText), row.state, text(row.replyText), text(row.skipReason),
        JSON.stringify(row.cited ?? []), Number(row.tokens ?? 0), text(row.lastError), now, now,
      );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE constraint/i.test(msg)) throw e;
  }
  return id;
}

function updateReply(id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).concat("updated_at = ?");
  const vals = keys.map((k) => (typeof patch[k] === "number" ? patch[k] : text(patch[k]))).concat(Date.now());
  db.prepare(`UPDATE skool_reply_log SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

/**
 * Forget one message, so it can be offered again.
 *
 * ⚠️ A HUMAN ACT, NEVER THE SWEEP'S. It is the only way out of the "engaged
 * with, in any state" rule, and it exists because that rule is deliberately
 * strict enough to strand a message a crash interrupted.
 */
export function forgetReply(id: string): boolean {
  return db.prepare("DELETE FROM skool_reply_log WHERE id = ?").run(id).changes > 0;
}

/* ────────────────────────── collecting what to answer ────────────────────────── */

export interface ReplyTarget {
  surface: ReplySurface;
  targetId: string;
  postSlug: string;
  postTitle: string;
  channelId: string;
  memberId: string;
  memberName: string;
  /** For the greeting. Skool gives DMs a real one; comments get the fallback. */
  memberFirstName: string;
  theirText: string;
  /** What the reply has to make sense inside: the post, or the conversation. */
  context: string;
  /**
   * How many of their messages this reply answers — a DM run, unanswered.
   *
   * 1 for a comment and for the ordinary one-message DM. Higher when somebody
   * sent two or three in a row before anyone got to them, which is the case
   * this exists for: they get ONE reply and it has to cover all of it.
   */
  unansweredCount: number;
  createdAt: string;
}

export interface Collected {
  targets: ReplyTarget[];
  /** What was looked at, so "nothing to answer" and "nothing was read" differ. */
  scanned: { posts: number; postsWithComments: number; comments: number; dmThreads: number; dmTheySpokeLast: number };
  notes: string[];
  error: string | null;
}

const olderThan = (iso: string, days: number): boolean => {
  const at = Date.parse(iso);
  // An unparseable date is treated as too old rather than as fresh — the safe
  // default for "should I message this person" is no. Same rule as
  // `needingReply`, restated here because this filter is a second gate.
  if (!Number.isFinite(at)) return true;
  return at < Date.now() - days * 24 * 3600_000;
};

/**
 * Everything waiting for an answer, newest first, minus anything already
 * engaged with.
 *
 * ⚠️ IT REPORTS WHAT IT SCANNED, NOT JUST WHAT IT FOUND. "No comments to
 * answer" and "the feed did not load" are the same empty list otherwise, and
 * this project has already shipped one silent-empty read that briefly proved
 * the wrong thing (`skoolReadFeed`'s payload is `{feed:{posts}}`, and reading
 * `j.posts` made a failed read look like an empty community).
 */
export async function collectTargets(communityUrl: string, cfg: ReplyConfig): Promise<Collected> {
  const out: Collected = {
    targets: [],
    scanned: { posts: 0, postsWithComments: 0, comments: 0, dmThreads: 0, dmTheySpokeLast: 0 },
    notes: [],
    error: null,
  };
  const engaged = engagedIds();

  if (cfg.comments) {
    const feed = await readFeed(communityUrl, 1);
    if (feed.error) {
      out.error = `Could not read the feed: ${feed.error}`;
      return out;
    }
    out.scanned.posts = feed.posts.length;
    // ⚠️ ONLY POSTS THAT ACTUALLY HAVE COMMENTS, AND THE FEED ALREADY SAYS SO.
    // `commentCount` comes free with the feed read, so opening a post with none
    // is a browser navigation spent to learn what we were already told.
    const mine = feed.posts
      .filter((p) => p.byMe && p.commentCount > 0 && p.slug)
      .slice(0, cfg.postsToScan);
    out.scanned.postsWithComments = mine.length;
    for (const post of mine) {
      const read = await readComments(communityUrl, post.slug);
      if (read.error) {
        out.notes.push(`${post.slug}: ${read.error}`);
        continue;
      }
      out.scanned.comments += read.comments.length;
      // ⚠️ SHORT-READ IS NOT A CLEAN READ. `readComments` reports when it saw
      // fewer than Skool declared; an unanswered comment past the cut is
      // invisible here and saying so is the only honest option.
      if (read.short) out.notes.push(`${post.slug}: read ${read.comments.length} of ${read.declared} comments.`);
      for (const c of answerable(read.comments)) {
        if (engaged.has(keyFor("comment", c.id))) continue;
        if (olderThan(c.createdAt, cfg.maxAgeDays)) continue;
        out.targets.push({
          surface: "comment",
          targetId: c.id,
          postSlug: post.slug,
          postTitle: post.title,
          channelId: "",
          memberId: c.authorId,
          memberName: c.authorName,
          memberFirstName: firstNameOf(c.authorName),
          theirText: c.body,
          context: `${post.title}\n\n${post.body}`.trim(),
          unansweredCount: 1,
          createdAt: c.createdAt,
        });
      }
    }
  }

  if (cfg.dms) {
    const read = await readChannels(communityUrl);
    if (read.error) {
      // A DM read that fails must not discard comments already collected, so
      // this is a note rather than the whole sweep's error.
      out.notes.push(`Could not read DMs: ${read.error}`);
    } else {
      out.scanned.dmThreads = read.channels.length;
      out.scanned.dmTheySpokeLast = read.channels.filter((c) => c.lastFromThem).length;
      for (const ch of needingReply(read.channels, { maxAgeDays: cfg.maxAgeDays })) {
        // ⚠️ KEYED ON THEIR LAST MESSAGE, NOT THE THREAD. A member who asks a
        // second question weeks later is a new target; the same question read
        // twice is not.
        if (engaged.has(keyFor("dm", ch.lastMessageId))) continue;
        out.targets.push({
          surface: "dm",
          targetId: ch.lastMessageId,
          postSlug: "",
          postTitle: "",
          channelId: ch.id,
          memberId: ch.memberId,
          memberName: ch.memberName,
          // Skool's own field, not a split — see `firstNameOf`.
          memberFirstName: ch.memberFirstName || firstNameOf(ch.memberName),
          // Their LAST message only, and replaced by the whole unanswered run
          // once the thread itself is read — see `dmThread`. The channel list
          // carries one line per thread and no history, so this is the most
          // that is known at collection time.
          theirText: ch.lastMessageBody,
          context: "",
          unansweredCount: 1,
          createdAt: ch.lastMessageAt,
        });
      }
    }
  }

  out.targets.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

interface DmThread {
  /** The exchange BEFORE the unanswered run, oldest first, as speaker lines. */
  transcript: string;
  /** Their messages since Jake last spoke — in order, oldest first. */
  unanswered: string[];
}

/**
 * The conversation so far, split at the point Jake last spoke.
 *
 * Read only for a thread we are about to answer, never for all 168 — it is one
 * navigation per thread and the sweep is capped at a handful.
 *
 * ⚠️⚠️ THE SPLIT IS THE POINT. Jake, 2026-08-27: a member "just replied in the
 * DM at skool with 3 messages one after the other" and the reply has to answer
 * the thread rather than the last line. The channel list only carries
 * `lastMessageBody`, so before this the drafter was handed message three as the
 * question and one through two as scenery — and the earlier messages are
 * routinely where the actual question is ("I tried that", "here's my error",
 * "does it work with Sheets?").
 *
 * ⚠️ AND THE TRANSCRIPT EXCLUDES THE RUN RATHER THAN REPEATING IT. Showing the
 * same three messages twice — once as history, once as the question — invites a
 * reply that answers them twice, which is the failure this whole change is
 * about.
 */
async function dmThread(communityUrl: string, channelId: string, channels: DmChannel[]): Promise<DmThread> {
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) return { transcript: "", unanswered: [] };
  const { messages, error } = await readMessages(communityUrl, channel);
  if (error || !messages.length) return { transcript: "", unanswered: [] };
  return splitAtLastReply(messages, channel.memberFirstName || channel.memberName);
}

/**
 * The split itself, with no browser in it — see `dmThread`.
 *
 * Exported for the tests, because this is the part that can be wrong quietly:
 * a mis-drawn line puts a message the agent has already answered back in front
 * of it as a new question, or drops the one it was supposed to answer.
 *
 * `keep` bounds the history, not the run. Every unanswered message is returned
 * however many there are — they are the question — while the exchange before
 * them is the last `keep` lines, because a two-year-old thread is context no
 * answer needs and 35 messages of it is most of the prompt.
 */
export function splitAtLastReply(
  messages: Pick<DmMessage, "body" | "byMe">[],
  them: string,
  keep = 12,
): DmThread {
  // Walk back over the trailing messages that are theirs. `needingReply` has
  // already established they spoke last, so this run is never empty in practice
  // — but a thread that has moved on between the two reads returns no run and
  // the caller keeps the message it collected, rather than an empty question.
  let cut = messages.length;
  while (cut > 0 && !messages[cut - 1].byMe) cut--;

  return {
    unanswered: messages.slice(cut).map((m) => m.body.trim()).filter(Boolean),
    transcript: messages
      .slice(0, cut)
      .slice(-keep)
      .map((m) => `${m.byMe ? "Jake" : them}: ${m.body}`)
      .join("\n"),
  };
}

/* ────────────────────────── answering ────────────────────────── */

export interface SweepResult {
  ran: boolean;
  /** Why not, when `ran` is false — never a silent no-op. */
  skipped: string | null;
  scanned: Collected["scanned"];
  notes: string[];
  handled: string[];
  drafted: number;
  sent: number;
  skippedByDrafter: number;
  failed: number;
}

/**
 * Draft one reply and write the ledger row for it.
 *
 * Returns the row id, or null when nothing was even drafted — in which case
 * NOTHING was recorded, deliberately: a target the model could not be asked
 * about (a shut rate-limit window) must come back on the next sweep, and the
 * "engaged with, in any state" rule would otherwise bury it forever.
 */
async function draftOne(
  communityUrl: string,
  target: ReplyTarget,
  voicePrompt: string,
  access: Entitlement,
  posts: SkoolPost[],
): Promise<{ id: string | null; detail: string }> {
  // ⚠️ COMPUTED PER TARGET, NOT PER SWEEP. Two members can be at opposite ends
  // of this: one has never heard of the plans page and one was sent it an hour
  // ago by Jake himself.
  const nudge =
    target.surface === "dm" && !access.member.paid && !access.member.unknown
      ? plansNudgeState(
          target.channelId,
          target.theirText,
          target.context,
          `${communityUrl.replace(/\/+$/, "")}/plans`,
        )
      : null;

  const { reply, error } = await draftReply({
    communityUrl,
    voicePrompt,
    surface: target.surface,
    authorName: target.memberName,
    authorFirstName: target.memberFirstName,
    text: target.theirText,
    context: target.context,
    unansweredCount: target.unansweredCount,
      // Jake, 2026-08-27: the bar-Jake voice goes into anything the Skool agent
    // does — the replies as much as the posts.
    voiceGuide: getSkoolSettings().voiceGuideMd,
    // ⚠️ THE FREEMIUM GATE, AND IT IS NEVER OMITTED HERE. `entitlementFor`
    // always returns something — an unrecognised member comes back as free —
    // so a missing entitlement on this path would be a bug, not a member the
    // rule does not apply to.
    access,
    nudge: nudge ? { allowed: nudge.allowed, asked: nudge.asked } : null,
    posts: posts.map((p) => ({ id: p.id, slug: p.slug, title: p.title, body: p.body, createdAt: p.createdAt })),
  });
  if (error || !reply) {
    // ⚠️ NOT RECORDED. See above — a rate-limited window is the common case
    // here and it is not a decision about this member's message.
    return { id: null, detail: `${target.memberName}: not drafted — ${error ?? "no draft came back"}` };
  }
  const base = {
    surface: target.surface,
    targetId: target.targetId,
    postSlug: target.postSlug,
    channelId: target.channelId,
    memberId: target.memberId,
    memberName: target.memberName,
    // Stored per reply, not looked up later: see the column comment. A member
    // who upgrades tomorrow must not make today's answer look like a mistake.
    memberTier: access.member.unknown ? "unknown" : access.member.paid ? "paid" : "free",
    memberLevel: access.member.level,
    theirText: target.theirText,
    tokens: reply.tokens ?? 0,
    cited: reply.cited,
  };
  if (reply.skip) {
    // ⚠️ A SKIP IS RECORDED, WITH ITS REASON. The drafter is told to skip
    // anything needing Jake himself — money, refunds, complaints, anything
    // legal or personal — and those are precisely the messages a human needs to
    // see. A silent skip would hide them.
    insertReply({ ...base, state: "skipped", skipReason: reply.skip });
    return { id: null, detail: `${target.memberName}: skipped — ${reply.skip}` };
  }
  const id = insertReply({ ...base, state: "drafted", replyText: reply.text });
  return { id, detail: `${target.memberName}: drafted ${reply.text.length} chars` };
}

/**
 * Send a reply that has already been drafted and recorded.
 *
 * ⚠️ THE ROW EXISTS BEFORE THIS IS CALLED, ALWAYS. That is what makes a crash
 * inside it safe: the message is already marked engaged-with, so the next sweep
 * passes over it and a human decides what happened.
 */
async function sendOne(communityUrl: string, row: ReplyRow, dryRun: boolean): Promise<{ state: ReplyState; detail: string }> {
  updateReply(row.id, { attempts: row.attempts + 1 });
  if (row.surface === "comment") {
    const r = await replyToComment({
      communityUrl,
      slug: row.postSlug,
      commentId: row.targetId,
      commentBody: row.theirText,
      text: row.replyText,
      dryRun,
    });
    if (dryRun) return { state: "drafted", detail: r.detail };
    if (r.ok && r.replyId) {
      updateReply(row.id, { state: "sent", reply_id: r.replyId, steps: r.detail, last_error: "" });
      return { state: "sent", detail: r.detail };
    }
    // ⚠️ "Submitted and not found" IS `unconfirmed`, NOT `failed`, AND THE
    // DIFFERENCE IS WHETHER A RETRY IS SAFE. `replyToComment` says so itself:
    // one that landed late would duplicate.
    const unconfirmed = /UNCONFIRMED|Every click worked/i.test(r.detail);
    updateReply(row.id, { state: unconfirmed ? "unconfirmed" : "failed", last_error: r.detail, steps: r.detail });
    return { state: unconfirmed ? "unconfirmed" : "failed", detail: r.detail };
  }

  const channels = await readChannels(communityUrl);
  if (channels.error) {
    updateReply(row.id, { state: "failed", last_error: channels.error });
    return { state: "failed", detail: `Could not read the DM list: ${channels.error}` };
  }
  const channel = channels.channels.find((c) => c.id === row.channelId);
  if (!channel) {
    updateReply(row.id, { state: "failed", last_error: `No DM thread with id ${row.channelId}.` });
    return { state: "failed", detail: `No DM thread with id ${row.channelId} is on this account any more.` };
  }
  // ⚠️ THE THREAD MUST STILL END ON THEIR MESSAGE. Between the draft and the
  // send the member may have written again, or Jake may have answered by hand
  // from his phone — and either makes this reply the wrong thing to send.
  if (channel.lastMessageId !== row.targetId) {
    updateReply(row.id, {
      state: "skipped",
      skip_reason: "The conversation moved on between drafting and sending, so this answer was not sent.",
    });
    return { state: "skipped", detail: `${row.memberName}: the thread moved on — not sent.` };
  }
  const r = await sendDm({ communityUrl, channel, text: row.replyText, dryRun });
  if (dryRun) return { state: "drafted", detail: r.detail };
  if (r.ok && r.messageId) {
    updateReply(row.id, { state: "sent", reply_id: r.messageId, steps: r.detail, last_error: "" });
    return { state: "sent", detail: r.detail };
  }
  const unconfirmed = /UNCONFIRMED/i.test(r.detail);
  updateReply(row.id, { state: unconfirmed ? "unconfirmed" : "failed", last_error: r.detail, steps: r.detail });
  return { state: unconfirmed ? "unconfirmed" : "failed", detail: r.detail };
}

/**
 * Has our reply actually landed, whatever the click said?
 *
 * ⚠️⚠️ THIS IS THE EXACT CHECK, AND ITS EXACTNESS IS WHAT MAKES A RETRY SAFE.
 * "Every click worked and nothing appeared" is indistinguishable from "it
 * landed a second after we looked" — the two need opposite responses, and only
 * the thread itself can tell them apart. `replyToComment` says so in its own
 * failure message; this is that instruction, automated.
 *
 * ⚠️ ANY reply from this account counts, not just one this agent wrote. If Jake
 * answered from his phone in the meantime, the member is answered — which is
 * the outcome, and posting a second reply underneath would be the failure.
 */
async function findLanded(
  communityUrl: string,
  row: ReplyRow,
): Promise<{ landed: boolean; replyId: string; error: string | null }> {
  if (row.surface === "comment") {
    const read = await readComments(communityUrl, row.postSlug);
    if (read.error) return { landed: false, replyId: "", error: read.error };
    const mine = read.comments.find((c) => c.parentId === row.targetId && c.byMe);
    return { landed: Boolean(mine), replyId: mine?.id ?? "", error: null };
  }
  const channels = await readChannels(communityUrl);
  if (channels.error) return { landed: false, replyId: "", error: channels.error };
  const channel = channels.channels.find((c) => c.id === row.channelId);
  if (!channel) return { landed: false, replyId: "", error: `No DM thread with id ${row.channelId}.` };
  // ⚠️ THE THREAD NO LONGER ENDING ON THEIR MESSAGE IS ITSELF THE ANSWER. The
  // channel list carries the last message and who sent it, so the common case
  // costs no extra navigation.
  if (channel.lastMessageId !== row.targetId && !channel.lastFromThem) {
    return { landed: true, replyId: channel.lastMessageId, error: null };
  }
  const { messages, error } = await readMessages(communityUrl, channel);
  if (error) return { landed: false, replyId: "", error };
  const idx = messages.findIndex((m) => m.id === row.targetId);
  const after = idx < 0 ? messages : messages.slice(idx + 1);
  const mine = after.find((m) => m.byMe);
  return { landed: Boolean(mine), replyId: mine?.id ?? "", error: null };
}

/**
 * Finish what an earlier sweep started: look at everything left `unconfirmed`
 * or `failed`, and either record that it landed or try again.
 *
 * ⚠️⚠️ IT LOOKS BEFORE IT RETRIES, ALWAYS, AND THAT ORDER IS THE WHOLE SAFETY.
 * Retrying first would answer some members twice, which is the one failure here
 * that cannot be walked back. Looking first turns "unconfirmed" into a fact.
 *
 * ⚠️ AND IT GIVES UP OUT LOUD. After `maxSendAttempts` the row becomes `failed`
 * with a reason and is left for a person — a queue that retries forever would
 * spend a browser cycle on the same broken thread every sweep, and hide it.
 */
async function reconcileUnfinished(
  communityUrl: string,
  cfg: ReplyConfig,
  out: SweepResult,
  room: () => number,
): Promise<void> {
  const rows = (
    db
      .prepare("SELECT * FROM skool_reply_log WHERE state IN ('unconfirmed','failed') ORDER BY created_at ASC")
      .all() as any[]
  ).map(rowToReply);
  for (const row of rows) {
    if (room() <= 0) break;
    const check = await findLanded(communityUrl, row).catch((e) => ({
      landed: false,
      replyId: "",
      error: e instanceof Error ? e.message : String(e),
    }));
    if (check.error) {
      // A read that failed is not evidence of anything. Leave the row exactly
      // as it is and say so — treating it as "not landed" would retry on no
      // information at all.
      out.notes.push(`${row.memberName}: could not check whether the reply landed — ${check.error}`);
      continue;
    }
    if (check.landed) {
      updateReply(row.id, { state: "sent", reply_id: check.replyId, last_error: "" });
      out.handled.push(`${row.memberName} (${row.surface}): it had landed after all — recorded as sent.`);
      out.sent++;
      continue;
    }
    if (row.attempts >= cfg.maxSendAttempts) {
      if (row.state !== "failed") {
        updateReply(row.id, {
          state: "failed",
          last_error:
            `Gave up after ${row.attempts} attempts — the reply never appeared under the message. ` +
            `Nothing was sent. ${row.lastError}`.trim(),
        });
      }
      continue;
    }
    if (cfg.dryRun) continue;
    const sent = await sendOne(communityUrl, row, false).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      updateReply(row.id, { state: "failed", last_error: msg });
      return { state: "failed" as ReplyState, detail: msg };
    });
    if (sent.state === "sent") out.sent++;
    else out.failed++;
    out.handled.push(`${row.memberName} (${row.surface}, retry ${row.attempts + 1}/${cfg.maxSendAttempts}): ${sent.detail}`);
  }
}

/**
 * One sweep: read, filter, draft, and (unless dry-run) answer.
 *
 * `force` is the "Run now" button — it ignores the cadence but NOT the kill
 * switch, and not the caps. A button that could bypass the caps would make the
 * caps advisory.
 */
export async function runReplySweep(
  communityUrl: string,
  opts: { force?: boolean; trigger?: string } = {},
): Promise<SweepResult> {
  const cfg = getReplyConfig();
  const out: SweepResult = {
    ran: false,
    skipped: null,
    scanned: { posts: 0, postsWithComments: 0, comments: 0, dmThreads: 0, dmTheySpokeLast: 0 },
    notes: [],
    handled: [],
    drafted: 0,
    sent: 0,
    skippedByDrafter: 0,
    failed: 0,
  };
  if (!cfg.enabled) {
    out.skipped = "The reply agent is switched off.";
    return out;
  }
  if (!cfg.comments && !cfg.dms) {
    out.skipped = "Neither comments nor DMs are switched on, so there is nothing to sweep.";
    return out;
  }
  const health = readReplyHealth();
  if (!opts.force && health.lastSweepAt && Date.now() - health.lastSweepAt < cfg.everyMinutes * 60_000) {
    const mins = Math.ceil((cfg.everyMinutes * 60_000 - (Date.now() - health.lastSweepAt)) / 60_000);
    out.skipped = `Swept ${Math.round((Date.now() - health.lastSweepAt) / 60_000)} min ago; next in ${mins} min.`;
    return out;
  }
  const already = sentLastDay();
  if (already >= cfg.maxPerDay) {
    out.skipped = `Daily cap reached (${already} of ${cfg.maxPerDay} replies in the last 24h).`;
    writeReplyHealth({ lastSweepAt: Date.now(), lastOutcome: out.skipped });
    return out;
  }

  const voicePrompt = getEngageSettings().replyPromptMd ?? "";
  if (!voicePrompt.trim()) {
    // The drafter refuses without it and says so; refusing here as well means
    // the browser work is not spent to reach a refusal.
    out.skipped = "No voice prompt is stored, so nothing would be drafted.";
    writeReplyHealth({ lastSweepAt: Date.now(), lastOutcome: out.skipped });
    return out;
  }

  out.ran = true;

  // ⚠️⚠️ WHO IS PAYING, BEFORE ANYTHING IS DRAFTED. Jake, 2026-08-27: the
  // community is freemium, so "before answering a person on a DM, first
  // understand if he or she is a paid or free user". Once per sweep, not once
  // per reply — both reads are browser navigations, and every target in a sweep
  // is judged against the same snapshot.
  //
  // A failure here is a NOTE, not a stop: `entitlementFor` falls back to the
  // free entitlement for everyone, which is the safe direction (a paying member
  // gets offered a free lesson) and is recorded on every row it touches.
  const access = await ensureAccessFresh(communityUrl).catch((e) => ({
    notes: [`Member tiers/course gates could not be re-read: ${String(e?.message ?? e)}`],
    membersReadAt: 0,
    gatesReadAt: 0,
  }));
  out.notes.push(...access.notes);
  if (!access.gatesReadAt) {
    // Worth saying out loud: with no gates, every free member's grounding is
    // empty and their replies will carry no classroom link at all.
    out.notes.push("⚠️ No course gates are cached, so free members can be pointed at no classroom page this sweep.");
  }

  // ⚠️ UNFINISHED WORK BEFORE NEW WORK. A member already half-answered is ahead
  // of a member not answered at all, and the cap is shared — spending the whole
  // sweep on new targets would starve the retries forever.
  let spent = 0;
  await reconcileUnfinished(communityUrl, cfg, out, () => Math.min(cfg.maxPerSweep, cfg.maxPerDay - already) - spent++);

  const collected = await collectTargets(communityUrl, cfg);
  out.scanned = collected.scanned;
  // ⚠️ PUSHED, NOT ASSIGNED. The access refresh above already wrote notes onto
  // this sweep, and assigning here threw them away — including the one that
  // says nobody's tier could be read.
  out.notes.push(...collected.notes);
  if (collected.error) {
    out.skipped = collected.error;
    writeReplyHealth({ lastSweepAt: Date.now(), lastOutcome: collected.error });
    return out;
  }

  const room = Math.max(0, Math.min(cfg.maxPerSweep, cfg.maxPerDay - already) - out.sent - out.failed);
  const todo = collected.targets.slice(0, room);
  // ⚠️ SAY WHAT WAS LEFT BEHIND. A cap that silently truncates reads as "that
  // was everything" — the same rule the workflow guidance states and the same
  // one `readComments` follows when it is short.
  if (collected.targets.length > todo.length) {
    out.notes.push(`${collected.targets.length - todo.length} more waiting; capped at ${room} this sweep.`);
  }

  // Read the DM list once for context, and only if a DM is actually being
  // answered — 168 threads is not something to fetch on a comment-only sweep.
  const dmChannels = todo.some((t) => t.surface === "dm")
    ? (await readChannels(communityUrl).catch(() => ({ channels: [] as DmChannel[], error: "" }))).channels
    : [];

  // One entitlement per target, from the caches refreshed above. Cheap — no
  // browser, no network — so it is resolved for every target rather than
  // guessed from the surface.
  const entitlements = new Map(todo.map((t) => [t.targetId, entitlementFor(t.memberId, t.memberName)]));
  const free = todo.filter((t) => !entitlements.get(t.targetId)?.member.paid);
  if (free.length) {
    out.notes.push(
      `${free.length} of ${todo.length} to answer are free members: ${free.map((t) => t.memberName).join(", ")}.`,
    );
  }

  // ⚠️ THE FEED IS READ ONLY WHEN A FREE MEMBER IS ACTUALLY BEING ANSWERED, and
  // it is the other half of what they may be pointed at ("a page from the first
  // class or a past post in the community"). Two pages is ~60 posts and two
  // navigations; a sweep of paying members pays for neither.
  let recentPosts: SkoolPost[] = [];
  if (free.length) {
    const feed = await readFeed(communityUrl, 2).catch(() => ({ posts: [] as SkoolPost[], error: "read failed" }));
    recentPosts = feed.posts ?? [];
    if (!recentPosts.length) {
      out.notes.push("⚠️ No past posts could be read, so free members get lesson links only.");
    }
  }

  for (const target of todo) {
    let withContext = target;
    if (target.surface === "dm") {
      const thread = await dmThread(communityUrl, target.channelId, dmChannels).catch(() => ({
        transcript: "",
        unanswered: [] as string[],
      }));
      withContext = {
        ...target,
        context: thread.transcript,
        // ⚠️ ALL OF THE RUN, NOT ITS LAST LINE — and it goes in `theirText`, so
        // the ledger and the review card show what was actually answered too.
        // Falls back to the collected message when the thread could not be
        // re-read: a worse question is still a question, an empty one is not.
        theirText: thread.unanswered.length ? thread.unanswered.join("\n\n") : target.theirText,
        unansweredCount: Math.max(thread.unanswered.length, 1),
      };
    }
    const entitlement = entitlements.get(target.targetId) ?? entitlementFor(target.memberId, target.memberName);
    const { id, detail } = await draftOne(
      communityUrl,
      withContext,
      voicePrompt,
      entitlement,
      // Offered to paying members too when they were read at all — "if he's
      // paid you can recommend anything" includes a post. Empty on a sweep with
      // no free member in it, because the feed was never read.
      recentPosts,
    );
    if (!id) {
      out.handled.push(detail);
      if (/skipped —/.test(detail)) out.skippedByDrafter++;
      continue;
    }
    out.drafted++;
    const row = getReply(id);
    if (!row) continue;
    const sent = await sendOne(communityUrl, row, cfg.dryRun).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      updateReply(id, { state: "failed", last_error: msg });
      return { state: "failed" as ReplyState, detail: msg };
    });
    if (sent.state === "sent") out.sent++;
    else if (sent.state === "failed" || sent.state === "unconfirmed") out.failed++;
    out.handled.push(`${target.memberName} (${target.surface}): ${sent.detail}`);
  }

  const outcome = out.handled.length
    ? `${out.drafted} drafted, ${out.sent} sent, ${out.skippedByDrafter} skipped, ${out.failed} failed`
    : "Nothing to answer.";
  writeReplyHealth({ lastSweepAt: Date.now(), lastOutcome: outcome, lastTrigger: opts.trigger ?? "" });
  return out;
}

/**
 * Send one drafted reply on a human's say-so — the gate that makes dry-run
 * useful rather than merely safe.
 */
export async function sendDraftedReply(communityUrl: string, id: string): Promise<{ ok: boolean; detail: string }> {
  const row = getReply(id);
  if (!row) return { ok: false, detail: `No reply with id ${id}.` };
  if (row.state !== "drafted") {
    return { ok: false, detail: `That reply is "${row.state}", not a draft. Only a draft can be sent.` };
  }
  if (!row.replyText.trim()) return { ok: false, detail: "That row has no text to send." };
  const r = await sendOne(communityUrl, row, false);
  return { ok: r.state === "sent", detail: r.detail };
}

/**
 * Check one message and finish it — the per-row version of the sweep's
 * reconcile, for an operator looking at a row that did not go.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE `unconfirmed` WAS A DEAD END ON THE SCREEN. "Send
 * this" is offered only on a draft — correctly, since a blind resend is how a
 * member gets answered twice — so a row that failed its read-back showed only
 * "Forget", which throws the reviewed reply away. The row was visible, wrong,
 * and had no button that would fix it. Jake, 2026-08-20: "the comment is stuck
 * in the lab now."
 *
 * ⚠️ IT LOOKS FIRST, exactly like the sweep. That is what makes a retry button
 * safe to put in front of somebody: pressing it twice cannot answer a member
 * twice, because the second press finds the first one's reply and records it.
 *
 * ⚠️ AND IT DELIBERATELY IGNORES `maxSendAttempts`. That budget stops an
 * unattended loop from burning browser cycles on a broken thread; a person
 * pressing a button is not an unattended loop, and refusing them the one action
 * that fixes the row would be the dead end all over again. It says so in the
 * result rather than silently overriding.
 */
export async function retryReply(communityUrl: string, id: string): Promise<{ ok: boolean; detail: string }> {
  const row = getReply(id);
  if (!row) return { ok: false, detail: `No reply with id ${id}.` };
  if (row.state === "sent") return { ok: true, detail: "That one is already sent — nothing to do." };
  if (row.state === "skipped") {
    return {
      ok: false,
      detail:
        "That message was deliberately left for you, with a reason. Forget it if you want the agent to write to them after all.",
    };
  }
  if (!row.replyText.trim()) return { ok: false, detail: "That row has no text to send." };

  const check = await findLanded(communityUrl, row).catch((e) => ({
    landed: false,
    replyId: "",
    error: e instanceof Error ? e.message : String(e),
  }));
  if (check.error) {
    // Not evidence of anything. Retrying on a failed read is how a thread gets
    // two answers because the network hiccuped.
    return { ok: false, detail: `Could not check whether it landed, so nothing was retried: ${check.error}` };
  }
  if (check.landed) {
    updateReply(row.id, { state: "sent", reply_id: check.replyId, last_error: "" });
    return { ok: true, detail: "It had landed after all — recorded as sent. Nothing was sent twice." };
  }
  const over = row.attempts >= getReplyConfig().maxSendAttempts;
  const sent = await sendOne(communityUrl, row, false);
  const note = over ? " (past the automatic retry budget — sent because you asked)" : "";
  return { ok: sent.state === "sent", detail: sent.detail + note };
}

/* ────────────────────────── the heartbeat ────────────────────────── */

export interface ReplyHealth {
  lastSweepAt: number | null;
  lastOutcome: string;
  lastTrigger: string;
}

function readReplyHealth(): ReplyHealth {
  const row = db
    .prepare("SELECT engage_replies_tick_json AS j FROM skool_settings WHERE id = 1")
    .get() as { j?: string } | undefined;
  const stored = readJson<Partial<ReplyHealth>>(row?.j, {});
  return {
    lastSweepAt: typeof stored.lastSweepAt === "number" ? stored.lastSweepAt : null,
    lastOutcome: stored.lastOutcome ?? "",
    lastTrigger: stored.lastTrigger ?? "",
  };
}

function writeReplyHealth(patch: Partial<ReplyHealth>): void {
  try {
    const next = { ...readReplyHealth(), ...patch };
    db
      .prepare("UPDATE skool_settings SET engage_replies_tick_json = ? WHERE id = 1")
      .run(JSON.stringify(next));
  } catch {
    // Swallowed for the same reason the poster's heartbeat swallows: this runs
    // at the end of a cycle, and a throw here would become an unhandled
    // rejection that kills the loop it exists to watch.
  }
}

export function replyAgentStatus(): {
  config: ReplyConfig;
  health: ReplyHealth;
  counts: { drafted: number; sent: number; unconfirmed: number; skipped: number; failed: number; sentLastDay: number };
  recent: ReplyRow[];
} {
  const counts = { drafted: 0, sent: 0, unconfirmed: 0, skipped: 0, failed: 0, sentLastDay: sentLastDay() };
  for (const r of db.prepare("SELECT state, COUNT(*) AS n FROM skool_reply_log GROUP BY state").all() as any[]) {
    if (r.state in counts) (counts as any)[r.state] = Number(r.n);
  }
  return { config: getReplyConfig(), health: readReplyHealth(), counts, recent: listReplies(25) };
}
