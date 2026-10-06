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
import {
  answeredAfter,
  readComments,
  waiting,
  type CommentRead,
  type SkoolComment,
} from "./comments.js";
import { readChannels, readMessages, needingReply, sendDm, type DmChannel, type DmMessage } from "./dms.js";
import { readFeed, type SkoolPost } from "./community.js";
import { draftReply, firstNameOf, type ReplyRequest } from "./engageGen.js";
import { ensureAccessFresh, entitlementFor, type Entitlement } from "./access.js";
import { replyToComment, type IntroChip, type ReplyResult } from "./engageActions.js";
import { commentOnMemberPost } from "./postComment.js";
import {
  findConnection,
  placeIntro,
  renderIntro,
  recordIntroduction,
  markIntroduction,
  readStoredIntro,
  introMember,
  refreshProfiles,
  type Connection,
  type StoredIntro,
} from "./connections.js";
import { screenMember, declineLine, MINOR_RESTRICTIONS, type SafetyVerdict } from "./safety.js";
import { checkOutgoing, linksIn, repairInstruction } from "./outgoing.js";

/**
 * `comment` answers a comment under one of Jake's posts; `post` comments under
 * a post a MEMBER wrote; `dm` answers a direct message.
 */
export type ReplySurface = "comment" | "dm" | "post";
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
  /**
   * Comment under posts MEMBERS write, not just answer comments on Jake's own.
   * Jake, 2026-09-19: "it should also comment on members posts".
   *
   * ⚠️ ITS OWN SWITCH, OFF UNTIL ARMED. Starting a conversation under somebody
   * else's post is a different act from answering one under your own.
   */
  memberPosts: boolean;
  /**
   * How old a member's post may be and still get a first comment. Much shorter
   * than `maxAgeDays`: a reply to a question weeks old is late but welcome, a
   * first comment on a stale post reads as a bot working through a backlog.
   */
  memberPostMaxAgeDays: number;
  /**
   * Point a member at one other member who has done the thing they are asking
   * about — learned from DMs, never repeating them. See `connections.ts`.
   */
  introductions: boolean;
  /** DM threads distilled into experience per sweep, when introductions are on. */
  profilesPerSweep: number;
  /**
   * Ask a member who has just thanked you to review the community.
   * Jake, 2026-09-20. See `reviewNudgeState`.
   *
   * ⚠️ DEFAULTS ON, WHICH IS THE OPPOSITE OF `memberPosts` AND `introductions`
   * ABOVE — DELIBERATELY. Those two default off because a database that
   * upgrades into a NEW outbound behaviour must not start doing it unasked.
   * This behaviour was asked for and shipped live before the switch existed, so
   * defaulting it off would silently turn off a working feature on deploy. The
   * switch is here to stop it, not to arm it. (Jake's call, same day.)
   */
  reviewNudge: boolean;
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
  // ⚠️ BOTH OFF, so a database that upgrades into them changes nothing until a
  // human arms them — the same rule as `enabled` and `dryRun` above.
  memberPosts: false,
  memberPostMaxAgeDays: 3,
  introductions: false,
  profilesPerSweep: 5,
  // ⚠️ ON — see the field's comment. It is already live; this switch turns it
  // OFF, and a default of false would disable it the moment this ships.
  reviewNudge: true,
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
  next.memberPostMaxAgeDays = Math.max(1, Math.min(30, Math.floor(next.memberPostMaxAgeDays)));
  next.profilesPerSweep = Math.max(0, Math.min(40, Math.floor(next.profilesPerSweep)));
  next.memberPosts = !!next.memberPosts;
  next.introductions = !!next.introductions;
  next.reviewNudge = next.reviewNudge !== false;
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
  /** The member this reply introduces them to, if any. */
  intro: StoredIntro | null;
  createdAt: number;
  updatedAt: number;
}

/** Same rule as the slot table: every text column is NOT NULL DEFAULT ''. */
const text = (v: unknown): string => (v == null ? "" : String(v));

const rowToReply = (r: any): ReplyRow => ({
  id: String(r.id),
  surface: r.surface === "dm" ? "dm" : r.surface === "post" ? "post" : "comment",
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
  intro: readStoredIntro(String(r.connect_json ?? "")),
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

/**
 * Are they thanking this account for actually helping them?
 *
 * Jake, 2026-09-20: *"if a member in a DM say 'thank you for your help' or
 * showing appreciation nudge them into giving a positive review."*
 *
 * ⚠️⚠️ NARROW ON PURPOSE, AND A MISS IS THE SAFE DIRECTION — the same rule as
 * `asksAboutUpgrading`. There is exactly ONE review ask per member for the life
 * of the relationship, so a false positive spends it on somebody who was being
 * polite about something else, and there is no second chance to ask the person
 * who really meant it. A miss costs nothing: they thank you again next time.
 *
 * ⚠️ AND "THANKS" IS NOT ALWAYS THANKS. "No thanks", "thanks but it still
 * doesn't work" and "thanks for nothing" all contain the word and none of them
 * is a moment to ask for a five-star review. A sentence carrying a complaint,
 * a refusal or a "but" is dropped before anything else is tested.
 */
export function showsAppreciation(text: string): boolean {
  const SOUR =
    /\b(?:but|however|still (?:not|does ?n.t|isn.t|won.t)|does ?n.t work|did ?n.t work|not working|no thanks|nothing|useless|wrong|confus(?:ed|ing)|unfortunately|sadly|anyway)\b/;
  // Gratitude aimed at a PERSON for something done, not "thanks" as a sign-off
  // on a request ("send it over, thanks").
  const THANKS =
    // ⚠️ NO BARE "ty". It is a real abbreviation for thank-you and it is also a
    // name, and "my nephew Ty uses AI" is not a member thanking anybody — the
    // test carries that exact line. With one ask per member to spend, an
    // abbreviation this short is not worth the person it misfires on.
    /\b(?:thank you|thanks|thankyou|thx|cheers|much appreciated|appreciate (?:it|that|you|your)|grateful)\b/;
  const PRAISE =
    /\b(?:this (?:really )?help(?:ed|s)|that (?:really )?help(?:ed|s)|you(?:'| a)?re (?:a )?(?:legend|star|the best|amazing|awesome|brilliant|great)|so helpful|really helpful|life ?saver|exactly what i needed|worked (?:perfectly|great|a treat)|sorted(?: it)?|nailed it|love (?:this|the) (?:community|group|classroom))\b/;

  // ⚠️ A QUESTION ANYWHERE IN THE MESSAGE CANCELS IT, NOT MERELY IN THE SAME
  // SENTENCE. "Thanks, that worked! Is there a course on this?" is help still in
  // progress, and answering it with a request for a favour interrupts somebody
  // mid-conversation. They thank you again when it is actually finished, which
  // is the whole reason a miss here is cheap.
  const whole = String(text ?? "").toLowerCase();
  const STILL_ASKING =
    /\?|\b(?:can you|could you|would you|how do i|how can i|what about|one more|another question)\b/;
  if (STILL_ASKING.test(whole)) return false;

  for (const raw of whole.split(/[.!\n]+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (SOUR.test(sentence)) continue;
    if (THANKS.test(sentence) || PRAISE.test(sentence)) return true;
  }
  return false;
}

/**
 * Whether this DM may ask them to review the community, and why.
 *
 * ⚠️⚠️ COUNTED, NOT REQUESTED — the identical lesson to `plansNudgeState`, and
 * it bites harder here. The drafter has never seen its own previous replies, so
 * "ask for a review only once" written in a prompt means "ask every time they
 * say thanks", and a member who thanks you three weeks running gets asked three
 * times. That is not a nudge, it is nagging the friendliest people in the
 * community.
 *
 * ⚠️ ONCE PER MEMBER, EVER — not once per conversation like the plans page. A
 * review is a thing somebody does once; a second ask can only annoy someone who
 * already decided. So the ledger is searched across the WHOLE channel history
 * and the thread is searched too, because Jake asks people himself.
 */
export function reviewNudgeState(
  communityUrl: string,
  channelId: string,
  theirText: string,
  transcript: string,
): { allowed: boolean; thanked: boolean; seen: number; url: string; why: string } {
  const url = `${communityUrl.replace(/\/+$/, "")}/about`;
  // ⚠️ THE COMMUNITY'S OWN /about, NOT THE STRING "/about". Jake's YouTube
  // channel link ends in /about too, and matching that would silently retire the
  // review ask for anyone he had ever sent to his channel.
  const needle = `${new URL(url).pathname.replace(/\/+$/, "")}`;
  const thanked = showsAppreciation(theirText);

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

  const allowed = thanked && seen === 0;
  return {
    allowed,
    thanked,
    seen,
    url,
    why: !thanked
      ? "They have not said anything that reads as thanks, so there is nothing to follow."
      : seen > 0
        ? `The about page has already come up in this conversation (${seen}), so they have been asked once and that is the limit.`
        : "They thanked this account and have never been asked, so one review nudge is allowed.",
  };
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
  intro?: StoredIntro | null;
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
            connect_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?, '', ?, ?, ?)`,
      )
      .run(
        id, row.surface, row.targetId, text(row.postSlug), text(row.channelId), text(row.memberId),
        text(row.memberName), text(row.memberTier), Number(row.memberLevel ?? 0),
        text(row.theirText), row.state, text(row.replyText), text(row.skipReason),
        JSON.stringify(row.cited ?? []), Number(row.tokens ?? 0), text(row.lastError),
        row.intro ? JSON.stringify(row.intro) : "", now, now,
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
  // An introduction that never went out must stop counting against the pair
  // and the limits, or forgetting the reply would still block the next one.
  markIntroduction(id, "dropped");
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
   * Links this account has already sent in this conversation — DMs only.
   *
   * Empty on a comment, which has no history to repeat itself across, and empty
   * until `dmThread` fills it in below.
   */
  alreadySentUrls: string[];
  /**
   * How many of their messages this reply answers — an unanswered run.
   *
   * 1 for the ordinary single comment or DM. Higher when somebody sent two or
   * three in a row before anyone got to them, which is the case this exists
   * for: they get ONE reply and it has to cover all of it.
   */
  unansweredCount: number;
  /**
   * The comment thread so far, oldest first, when this reply continues one.
   *
   * ⚠️ EMPTY ON A FIRST ANSWER, AND THAT IS THE DIFFERENCE THAT MATTERS. A
   * follow-up under Jake's own comment has to be answered as a CONVERSATION —
   * the drafter has never seen what it already told this person, and "Cheers
   * man!" answered as if it were a fresh question is how a thread starts
   * repeating itself. A DM carries the same history in `context`; a comment
   * keeps them apart because it has a post to sit under as well.
   */
  thread: string;
  createdAt: string;
}

export interface Collected {
  targets: ReplyTarget[];
  /** What was looked at, so "nothing to answer" and "nothing was read" differ. */
  scanned: {
    posts: number;
    postsWithComments: number;
    comments: number;
    dmThreads: number;
    dmTheySpokeLast: number;
    /** Recent posts by members, looked at for a first comment. */
    memberPosts: number;
  };
  notes: string[];
  error: string | null;
}

/**
 * Members who are Jake — his two admin accounts both read "Jake Dawson" — or
 * anyone else Skool marks as an admin. Never commented on as if a member.
 */
export function adminIds(): Set<string> {
  return new Set(
    (db.prepare("SELECT user_id FROM skool_member_access WHERE role != 'member'").all() as { user_id: string }[]).map(
      (r) => r.user_id,
    ),
  );
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
    scanned: { posts: 0, postsWithComments: 0, comments: 0, dmThreads: 0, dmTheySpokeLast: 0, memberPosts: 0 },
    notes: [],
    error: null,
  };
  const engaged = engagedIds();

  // One feed read serves both surfaces that live on the feed.
  let feedPosts: SkoolPost[] = [];
  if (cfg.comments || cfg.memberPosts) {
    const feed = await readFeed(communityUrl, 1);
    if (feed.error) {
      out.error = `Could not read the feed: ${feed.error}`;
      return out;
    }
    out.scanned.posts = feed.posts.length;
    feedPosts = feed.posts;
  }

  // ⚠️ ONE READ PER POST, SHARED BY BOTH BRANCHES BELOW. Both of them open a
  // member's post for a different reason — "has anybody answered in here?" and
  // "have we commented on this at all?" — and that is the same navigation
  // twice, against the one browser the poster also needs. The read is a page
  // load plus an API call and nothing about it writes, so memoising it for the
  // length of one sweep is free.
  const reads = new Map<string, CommentRead>();
  const readFor = async (slug: string): Promise<CommentRead> => {
    const had = reads.get(slug);
    if (had) return had;
    const read = await readComments(communityUrl, slug);
    reads.set(slug, read);
    return read;
  };

  if (cfg.comments) {
    // ⚠️ BOTH OF JAKE'S ACCOUNTS COUNT AS ANSWERING. They are both called "Jake
    // Dawson" and only one is signed in, so a thread the other one answered
    // reads as unanswered from here — and "always answer" must not turn into
    // "answer twice, once per account". See `AnswerOptions.usIds`.
    const admins = adminIds();
    // ⚠️⚠️ MEMBERS' POSTS ARE SCANNED FOR COMMENTS TOO, AND THAT IS THE FIX.
    // Jake, 2026-09-26: *"we have a post that someone else wrote, Jake wrote a
    // comment, then that person wrote a comment, then Jake never answered — I
    // want Jake to always answer."* This filter was `p.byMe`, so the post that
    // conversation happens on was never opened by this branch at all, and the
    // `memberPosts` branch below opens it only to decide NOT to comment twice.
    // Between them the follow-up had nowhere to be found.
    //
    // ⚠️ AND ON A MEMBER'S POST IT IS FOLLOW-UPS ONLY — `followUpsOnly`.
    // Finishing a conversation Jake started under somebody's post is what he
    // asked for; walking into a thread between two other members is a new
    // outbound behaviour, and `memberPosts` is the switch that decides whether
    // this agent speaks under a member's post at all.
    //
    // ⚠️ ONLY POSTS THAT ACTUALLY HAVE COMMENTS, AND THE FEED ALREADY SAYS SO.
    // `commentCount` comes free with the feed read, so opening a post with none
    // is a browser navigation spent to learn what we were already told. Feed
    // order is kept rather than sorted by date: Skool bumps a post when someone
    // comments, which puts the threads with something new in them first — which
    // is exactly what `postsToScan` should be spent on.
    //
    // ⚠️⚠️ "HIS OWN POST" MEANS EITHER ACCOUNT, AND `byMe` ALONE GETS THE MOST
    // IMPORTANT POST IN THE COMMUNITY WRONG. `/start-here` — 47 comments, the
    // first thing every new member reads — was written by Jake's OTHER admin
    // account, so `byMe` is false on it. That put it in the members' half here
    // AND excluded it from the `memberPosts` branch below (which correctly skips
    // anything an admin wrote), so nothing in this file ever answered a comment
    // on it. Live proof, 2026-09-26: a member's introduction from 2026-09-01 sat
    // there with no reply at all, inside every window this agent works to.
    const own = (p: SkoolPost): boolean => p.byMe || (!!p.authorId && admins.has(p.authorId));
    const withComments = (mine: boolean) =>
      feedPosts.filter((p) => own(p) === mine && p.commentCount > 0 && p.slug).slice(0, cfg.postsToScan);
    const scan = [
      ...withComments(true).map((post) => ({ post, followUpsOnly: false })),
      ...withComments(false).map((post) => ({ post, followUpsOnly: true })),
    ];
    out.scanned.postsWithComments = scan.length;
    for (const { post, followUpsOnly } of scan) {
      const read = await readFor(post.slug);
      if (read.error) {
        out.notes.push(`${post.slug}: ${read.error}`);
        continue;
      }
      out.scanned.comments += read.comments.length;
      // ⚠️ SHORT-READ IS NOT A CLEAN READ. `readComments` reports when it saw
      // fewer than Skool declared; an unanswered comment past the cut is
      // invisible here and saying so is the only honest option.
      if (read.short) out.notes.push(`${post.slug}: read ${read.comments.length} of ${read.declared} comments.`);
      for (const w of waiting(read.comments, { usIds: admins, followUpsOnly })) {
        const c = w.comment;
        // ⚠️⚠️ KEYED ON THE WHOLE UNANSWERED RUN, NOT ON THE COMMENT. A member
        // who adds a second comment while the first one's reply is still
        // drafted moves the target to the newer id — and answering both is two
        // replies to one conversation, which reads worse than answering
        // neither. Anything already engaged with inside the run parks it; the
        // comments BEFORE the run are deliberately not tested, because the one
        // we answered last time is in there and would park the thread forever.
        if (w.run.some((r) => engaged.has(keyFor("comment", r.id)))) continue;
        if (olderThan(c.createdAt, cfg.maxAgeDays)) continue;
        const them = firstNameOf(c.authorName) || c.authorName || "them";
        out.targets.push({
          surface: "comment",
          targetId: c.id,
          postSlug: post.slug,
          postTitle: post.title,
          channelId: "",
          memberId: c.authorId,
          memberName: c.authorName,
          memberFirstName: firstNameOf(c.authorName),
          // ⚠️ `plain`, NOT `body`, ALL THE WAY THROUGH. The drafter should read
          // what the member reads, and the raw form of "@Jake thanks!" is
          // `[@Jake Dawson](obj://user/86f055a8…) thanks!` — a user id in front
          // of every quoted line. The write path needs the same text to find the
          // card on the page, and this is the value the ledger row keeps.
          theirText: w.run.map((r) => r.plain).filter(Boolean).join("\n\n"),
          context: `${post.title}\n\n${post.body}`.trim(),
          // The thread above the run, in the same shape a DM transcript uses.
          // ⚠️ THE EMPTY ONES GO BEFORE THE LABEL IS ATTACHED, not after. Judging
          // a rendered line by its length has to know how long the name in front
          // of it is, and gets "Jake: ok" wrong the moment the member's name is
          // longer than the reply — which is a real comment, thrown away.
          thread: w.before
            .filter((x) => x.plain.trim().length > 0)
            .map((x) => `${x.byMe || admins.has(x.authorId) ? "Jake" : them}: ${x.plain}`)
            .join("\n"),
          // ⚠️ A COMMENT THREAD DOES HAVE A HISTORY NOW, so the "same link
          // twice in one thread" rule finally has something to work from here —
          // it was written for DMs because a comment had no history to repeat
          // itself across, and a follow-up is precisely where it would.
          // `linksIn` reads the RAW body: `plain` has thrown the URL away and
          // kept the label.
          alreadySentUrls: w.before
            .filter((x) => x.byMe || admins.has(x.authorId))
            .flatMap((x) => linksIn(x.body).map((l) => l.url)),
          unansweredCount: Math.max(w.run.length, 1),
          createdAt: c.createdAt,
        });
      }
    }
  }

  if (cfg.memberPosts) {
    const admins = adminIds();
    // Its own `admins` because this branch runs whether `comments` is on or not.
    // ⚠️ THE FILTER IS THE SAFETY — the same rule as `answerable()`. Jake's own
    // posts (either account), pinned announcements, anything too old for a
    // first comment to read as anything but a backlog, and anything already
    // engaged with never reach the drafter.
    const theirs = feedPosts
      .filter(
        (p) =>
          !p.byMe &&
          !p.pinned &&
          p.slug &&
          p.authorId &&
          !admins.has(p.authorId) &&
          !engaged.has(keyFor("post", p.id)) &&
          !olderThan(p.createdAt, cfg.memberPostMaxAgeDays),
      )
      .slice(0, cfg.postsToScan);
    out.scanned.memberPosts = theirs.length;
    for (const post of theirs) {
      // ⚠️ ALREADY COMMENTED ON BY THIS ACCOUNT — Jake by hand, most likely — is
      // checked on Skool, not in the ledger. A post with no comments needs no
      // navigation to know that.
      if (post.commentCount > 0) {
        const read = await readFor(post.slug);
        if (read.error) {
          out.notes.push(`${post.slug}: ${read.error}`);
          continue;
        }
        // ⚠️ EITHER JAKE, NOT JUST THE SIGNED-IN ONE — the same correction as in
        // the comments branch. A post his other admin account greeted is a post
        // that has been greeted, and a second welcome under it from "Jake
        // Dawson" is the most visible way this agent could look like a bot.
        if (read.comments.some((c) => c.depth === 0 && (c.byMe || admins.has(c.authorId)))) continue;
      }
      const words = `${post.title}\n\n${post.body}`.trim();
      // ⚠️ A ONE-WORD POST IS STILL ANSWERED (Jake, 2026-10-05) — only a post
      // with no words at all (emoji, punctuation) is passed over.
      if (!/[\p{L}\p{N}]/u.test(words)) continue;
      out.targets.push({
        surface: "post",
        targetId: post.id,
        postSlug: post.slug,
        postTitle: post.title,
        channelId: "",
        memberId: post.authorId,
        memberName: post.authorName ?? "",
        memberFirstName: firstNameOf(post.authorName ?? ""),
        theirText: words,
        // Their post IS the message; there is nothing it sits under.
        context: "",
        // And nothing said before it — this is the first word on the post.
        thread: "",
        alreadySentUrls: [],
        unansweredCount: 1,
        createdAt: post.createdAt,
      });
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
          // A DM's history goes in `context` once the thread is read, because a
          // DM has no post to sit under — see `ReplyTarget.thread`.
          thread: "",
          alreadySentUrls: [],
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
  /**
   * Every URL this account has already sent in this conversation.
   *
   * ⚠️ THE WHOLE THREAD, NOT THE `keep` WINDOW THE TRANSCRIPT USES. The
   * transcript is bounded because old exchanges are context nobody needs; this
   * is a fact about what the member has already been handed, and it does not
   * stop being true because it scrolled out of the prompt. Jake, 2026-09-12:
   * "I don't want to include the same links twice in a thread."
   *
   * ⚠️ AND IT IS TAKEN FROM `byMe`, NOT FROM THE TRANSCRIPT TEXT. A multi-line
   * message only gets the "Jake:" prefix on its FIRST line, so attributing a URL
   * by reading the transcript back would credit Jake with links the member sent
   * — and a member who pastes a link deserves to be sent it back if it answers
   * them. Only this account's own links count.
   */
  sentUrls: string[];
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
  if (!channel) return { transcript: "", unanswered: [], sentUrls: [] };
  const { messages, error } = await readMessages(communityUrl, channel);
  if (error || !messages.length) return { transcript: "", unanswered: [], sentUrls: [] };
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
    // Every link this account has sent, over the whole thread — see `sentUrls`.
    sentUrls: messages
      .filter((m) => m.byMe)
      .flatMap((m) => linksIn(m.body).map((l) => l.url)),
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
  introductions = false,
  // ⚠️ DEFAULTS TRUE, matching `ReplyConfig.reviewNudge` — see its comment. The
  // manual draft bench calls this without the flag, and a default of false
  // there would quietly write a different reply than the sweep does.
  reviewNudge = true,
): Promise<{ id: string | null; detail: string }> {
  const base0 = {
    surface: target.surface,
    targetId: target.targetId,
    postSlug: target.postSlug,
    channelId: target.channelId,
    memberId: target.memberId,
    memberName: target.memberName,
    memberTier: access.member.unknown ? "unknown" : access.member.paid ? "paid" : "free",
    memberLevel: access.member.level,
    theirText: target.theirText,
    tokens: 0,
    cited: [] as { title: string; url: string }[],
  };

  // ⚠️⚠️ THE SCREEN COMES BEFORE THE DRAFTER, AND BEFORE THE MONEY. Jake,
  // 2026-08-28: "if someone ask, comment, or write something is a controversy —
  // avoid that controversy at all costs and if you are unsure don't respond".
  // Reading the answer afterwards cannot do this job: the failure shape here is
  // a fluent, well-grounded, perfectly-voiced reply about something Jake would
  // never put in writing, and nothing in the text looks wrong.
  //
  // It reads the THREAD, not the message. On 2026-08-27 this member's last
  // message was "dont know how" and her age was four messages earlier.
  const verdict: SafetyVerdict = screenMember({
    memberId: target.memberId,
    memberName: target.memberName,
    text: target.theirText,
    context: target.context,
  });

  if (verdict.action === "escalate") {
    // Jake answers this one. Recorded, never silent — a skipped row is the
    // escalation queue, and the reason names what was seen.
    insertReply({ ...base0, state: "skipped", skipReason: `NEEDS JAKE (${verdict.categories.join(", ")}) — ${verdict.reason}` });
    return { id: null, detail: `${target.memberName}: skipped — needs Jake (${verdict.categories.join(", ")})` };
  }

  if (verdict.action === "decline") {
    // ⚠️ A FIXED LINE, NOT A DRAFT, AND IT IS STILL A REAL REPLY. Jake, asked
    // what to do when the agent is unsure: "say that there are things you
    // rather not talk about". Silence would be safer still and he did not
    // choose silence — a member who asks something off-limits gets an answer,
    // it just is not about the subject.
    const id = insertReply({
      ...base0,
      state: "drafted",
      replyText: declineLine(),
    });
    return { id, detail: `${target.memberName}: declining politely (${verdict.categories.join(", ")})` };
  }

  const restrictions = verdict.categories.includes("minor") ? MINOR_RESTRICTIONS : [];

  // ⚠️ COMPUTED PER TARGET, NOT PER SWEEP. Two members can be at opposite ends
  // of this: one has never heard of the plans page and one was sent it an hour
  // ago by Jake himself.
  const nudge =
    // ⚠️ NO UPGRADE NUDGE AT A MINOR, EVER. The nudge is REQUIRED on a free
    // member's first DM by an earlier decision of Jake's; this one is later and
    // narrower, and selling to a 16-year-old is the thing being prevented. The
    // suppression is here as well as in the prompt because a prompt rule and a
    // computed `allowed: true` disagreeing is exactly how the lowercase leak
    // happened.
    restrictions.length === 0 && target.surface === "dm" && !access.member.paid && !access.member.unknown
      ? plansNudgeState(
          target.channelId,
          target.theirText,
          target.context,
          `${communityUrl.replace(/\/+$/, "")}/plans`,
        )
      : null;

  // ⚠️ SAME GATE AS THE UPGRADE NUDGE, AND FOR THE SAME REASON. Never at a minor
  // and never on anything the screen did not wave through: a member who is angry
  // enough to have been escalated is the last person to invite to review the
  // community, and a restricted conversation is not a satisfied customer.
  const review =
    reviewNudge && restrictions.length === 0 && verdict.action === "answer" && target.surface === "dm"
      ? reviewNudgeState(communityUrl, target.channelId, target.theirText, target.context)
      : null;

  // ⚠️⚠️ NEVER BOTH IN ONE MESSAGE. "Thanks for your help!" answered with the
  // plans page AND a request for a five-star review is the salesy stack Jake
  // ruled out for the plans page on its own. The review wins the moment they are
  // grateful, and the plans nudge loses nothing by waiting: it is counted from
  // what was actually SENT, so it is still available next time.
  const nudgeToUse = review?.allowed ? null : nudge;

  // ⚠️⚠️ AN INTRODUCTION ONLY FOR A PLAIN ANSWER. Anything the screen restricted
  // (a minor above all), declined or escalated is not a conversation to bring a
  // second member into. `findConnection` has its own exclusions on top.
  let connection: Connection | null = null;
  let connectTokens = 0;
  if (introductions && verdict.action === "answer" && restrictions.length === 0) {
    const found = await findConnection({ id: target.memberId, name: target.memberName, text: target.theirText });
    connection = found.connection;
    connectTokens = found.tokens;
  }

  // Held as a value rather than passed inline: a refused draft is re-asked for
  // with the refusal attached, and the second ask has to be the same request.
  const request: ReplyRequest = {
    communityUrl,
    voicePrompt,
    surface: target.surface,
    authorName: target.memberName,
    authorFirstName: target.memberFirstName,
    text: target.theirText,
    context: target.context,
    // The comment thread this answer lands in, when it continues one — see
    // `ReplyRequest.thread`.
    thread: target.thread,
    unansweredCount: target.unansweredCount,
      // Jake, 2026-08-27: the bar-Jake voice goes into anything the Skool agent
    // does — the replies as much as the posts.
    voiceGuide: getSkoolSettings().voiceGuideMd,
    // ⚠️ THE FREEMIUM GATE, AND IT IS NEVER OMITTED HERE. `entitlementFor`
    // always returns something — an unrecognised member comes back as free —
    // so a missing entitlement on this path would be a bug, not a member the
    // rule does not apply to.
    access,
    nudge: nudgeToUse ? { allowed: nudgeToUse.allowed, asked: nudgeToUse.asked } : null,
    // Whether, and where to send them — see `ReplyRequest.review`.
    review: review?.allowed ? { url: review.url } : null,
    posts: posts.map((p) => ({ id: p.id, slug: p.slug, title: p.title, body: p.body, createdAt: p.createdAt })),
    restrictions,
    // See OVERRIDE 7 — told, not left to be noticed in the transcript.
    alreadySentUrls: target.alreadySentUrls,
    // Whether, never who — see `ReplyRequest.connect`.
    connect: connection !== null,
  };
  const { reply, error } = await draftReply(request);
  if (error || !reply) {
    // ⚠️ NOT RECORDED. See above — a rate-limited window is the common case
    // here and it is not a decision about this member's message.
    return { id: null, detail: `${target.memberName}: not drafted — ${error ?? "no draft came back"}` };
  }
  // The same row shape the screen above already built, now carrying what the
  // draft cost and what it cited. `memberTier` is stored rather than looked up
  // later: a member who upgrades tomorrow must not make today's answer look
  // like a mistake.
  const base = { ...base0, tokens: (reply.tokens ?? 0) + connectTokens, cited: reply.cited };
  if (reply.skip) {
    // ⚠️ A SKIP IS RECORDED, WITH ITS REASON. The drafter is told to skip
    // anything needing Jake himself — money, refunds, complaints, anything
    // legal or personal — and those are precisely the messages a human needs to
    // see. A silent skip would hide them.
    insertReply({ ...base, state: "skipped", skipReason: reply.skip });
    return { id: null, detail: `${target.memberName}: skipped — ${reply.skip}` };
  }
  // ⚠️⚠️ THE LAST READ BEFORE A MEMBER SEES IT. `sendOne` runs this too, from
  // inside the write path where nothing can go round it — but here the
  // grounding set still exists, so a link the drafter was never shown can be
  // caught exactly rather than guessed at.
  //
  // ⚠️⚠️ A REFUSAL REPAIRS ITSELF NOW. It used to be RECORDED and left — "the
  // words would be identical next sweep, and the row is how Jake finds out" —
  // which made the check a way of handing the message back to him. Jake,
  // 2026-09-02: "I'm not checking the skool agent everyday — I want it to work
  // automatically and never 'left for you'." Both refusals that ever happened
  // were repairable in a sentence: one demonstrated a prompt containing
  // `[your city]`, and one cited a classroom link nobody had shown it.
  //
  // So the words are not replayed — the drafter is told exactly what was wrong
  // and writes them again, ONCE. A second refusal after being told is a message
  // this agent is not going to get right, and that one is still recorded.
  // ⚠️ SHOWN, THEN CITED. The link rule refuses a community URL that was not in
  // what the drafter was SHOWN, and `cited` is only what it declared — a
  // grounded lesson link written into the body and left out of the JSON array
  // used to be refused as if it had been invented. Both lists are entitlement-
  // filtered before retrieval, so this widens bookkeeping, not permission.
  //
  // ⚠️ THE INTRODUCTION IS SHAPED BEFORE THE GATE, SO THE GATE READS WHAT A
  // MEMBER WILL. `placeIntro` pulls the `{{connect}}` sentence out, refuses it
  // if it describes the other person or strays from the asker's own words, and
  // puts it last; a refused one is DROPPED and the answer goes without it —
  // never repaired, because a second attempt at describing somebody is not
  // what is wanted either.
  const shape = (draftText: string): { text: string; intro: StoredIntro | null; note: string } => {
    if (!connection) return { text: draftText, intro: null, note: "" };
    const placed = placeIntro(draftText, target.theirText);
    if (!placed.sentence) {
      return { text: placed.body, intro: null, note: placed.dropped || "The drafter did not write the introduction." };
    }
    const m = connection.member;
    // A DM is plain text and cannot carry a chip; a comment's is typed on send.
    const marker = target.surface === "dm" ? m.displayName : `@${m.displayName}`;
    return {
      text: renderIntro(placed.body, placed.sentence, marker),
      intro: {
        userId: m.userId,
        handle: m.handle,
        displayName: m.displayName,
        firstName: m.firstName,
        marker,
        withoutIntro: placed.body,
      },
      note: "",
    };
  };
  const gateFor = (d: { text: string; cited: { url: string }[]; shownUrls: string[] }, intro: StoredIntro | null) =>
    checkOutgoing(d.text, {
      // A comment under a member's post is a comment, as far as what it may say.
      surface: target.surface === "dm" ? "dm" : "comment",
      communityUrl,
      allowedUrls: [
        ...d.shownUrls,
        ...d.cited.map((c) => c.url),
        `${communityUrl.replace(/\/+$/, "")}/plans`,
      ],
      allowedMentions: [
        target.memberFirstName,
        target.memberName,
        ...(intro ? [intro.displayName, intro.firstName] : []),
      ].filter(Boolean),
      // ⚠️ THE SAME LINK TWICE IN ONE THREAD, AND THE OPENING THAT HANDS THEM
      // BACK THEIR OWN POINT. Jake, 2026-09-12, on a real DM thread: "in a DM
      // thread I don't want the bot to repeat the idea that the other person
      // said in the first paragraph or at all in the next message, just
      // continue the conversation like normal people would do. Also I don't
      // want to include the same links twice in a thread." Both are ADVISORY —
      // one repair pass, then the reply goes out regardless.
      alreadySentUrls: target.alreadySentUrls,
      theirText: target.theirText,
    });

  let shaped = shape(reply.text);
  let text = shaped.text;
  let intro = shaped.intro;
  let cited = reply.cited;
  let tokens = (reply.tokens ?? 0) + connectTokens;
  let gate = gateFor({ ...reply, text }, intro);
  if (!gate.ok) {
    console.warn(`[skool:replies] ${target.memberName}: refused, repairing once — ${gate.detail}`);
    const second = await draftReply({ ...request, repair: repairInstruction(gate) });
    // A repair that comes back as a skip is the drafter deciding, on second
    // look, that this one is not for it to answer — respected, not overridden.
    if (second.reply && !second.reply.skip && second.reply.text.trim()) {
      tokens += second.reply.tokens ?? 0;
      const reshaped = shape(second.reply.text);
      const regate = gateFor({ ...second.reply, text: reshaped.text }, reshaped.intro);
      gate = regate;
      // Taken whenever it is no longer BLOCKED — a repair that removed the
      // invented link and left one banned word behind has fixed the thing that
      // mattered, and the first draft still has the link in it.
      if (!regate.blocked) {
        shaped = reshaped;
        text = reshaped.text;
        intro = reshaped.intro;
        cited = second.reply.cited;
      }
    }
  }
  if (connection && !intro) {
    console.warn(`[skool:replies] ${target.memberName}: introduction to ${connection.member.displayName} dropped — ${shaped.note}`);
  }
  // `base` was built from the first draft; the repaired one costs more tokens
  // and may cite different pages, and the row has to say what was actually written.
  const finalBase = { ...base, tokens, cited };
  // ⚠️⚠️ `blocked`, NOT `ok`, AND THIS IS THE WHOLE POINT OF THE SPLIT. This
  // branch writes `state: "skipped"`, which the UI renders as "Left for you" —
  // a member waiting on a person who, by Jake's own account, is not checking.
  // That is the right answer for an invented price and the wrong one for the
  // word "genuinely" or a lesson link they were already sent. A voice finding
  // has had its repair pass by here; it does not get to park the message.
  if (gate.blocked) {
    insertReply({ ...finalBase, state: "skipped", skipReason: gate.detail, replyText: text });
    return { id: null, detail: `${target.memberName}: skipped — refused twice — ${gate.detail}` };
  }
  if (!gate.ok) {
    console.warn(`[skool:replies] ${target.memberName}: sending with voice findings — ${gate.detail}`);
  }

  const id = insertReply({ ...finalBase, state: "drafted", replyText: text, intro });
  if (intro && connection) {
    recordIntroduction({
      replyId: id,
      surface: target.surface,
      askerId: target.memberId,
      askerName: target.memberName,
      introducedId: intro.userId,
      introducedName: intro.displayName,
      why: connection.why,
    });
  }
  const introNote = intro
    ? ` — introducing ${intro.displayName}`
    : connection
      ? ` — introduction dropped (${shaped.note})`
      : "";
  return { id, detail: `${target.memberName}: drafted ${text.length} chars${introNote}` };
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
  if (row.surface === "comment" || row.surface === "post") {
    const write = (text: string, intro: IntroChip | null): Promise<ReplyResult> =>
      row.surface === "post"
        ? commentOnMemberPost({ communityUrl, slug: row.postSlug, text, intro, dryRun })
        : replyToComment({
            communityUrl,
            slug: row.postSlug,
            commentId: row.targetId,
            // The row's copy, kept only as a fallback: the write path re-reads
            // the comment and joins on what the page shows today.
            commentBody: row.theirText,
            text,
            intro,
            dryRun,
            // ⚠️ SO THE LAST-SECOND "already answered" CHECK SEES BOTH OF JAKE'S
            // ACCOUNTS. Without them a thread he answered by hand from his other
            // account gets a second answer from this one.
            usIds: [...adminIds()],
          });
    let r = await write(row.replyText, row.intro ? { member: introMember(row.intro), marker: row.intro.marker } : null);
    // ⚠️ A CHIP THAT WOULD NOT TYPE MEANS NOTHING WAS SUBMITTED — the editor was
    // emptied before returning — so the reply goes again at once WITHOUT the
    // introduction. The member still gets their answer; the introduction is
    // the part that is optional. The row is rewritten first so a crash between
    // the two cannot send the introduction later from a stale row.
    if (!r.ok && r.introFailed && row.intro) {
      const note = r.detail;
      updateReply(row.id, { reply_text: row.intro.withoutIntro, connect_json: "" });
      markIntroduction(row.id, "dropped");
      r = await write(row.intro.withoutIntro, null);
      r = { ...r, detail: `Introduction dropped (${note}) · ${r.detail}` };
    }
    if (dryRun) return { state: "drafted", detail: r.detail };
    if (r.ok && r.replyId) {
      updateReply(row.id, { state: "sent", reply_id: r.replyId, steps: r.detail, last_error: "" });
      markIntroduction(row.id, "sent");
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
    markIntroduction(row.id, "sent");
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
  if (row.surface === "comment" || row.surface === "post") {
    const read = await readComments(communityUrl, row.postSlug);
    if (read.error) return { landed: false, replyId: "", error: read.error };
    // On a member's post, ANY top-level comment from this account is the answer.
    //
    // ⚠️⚠️ ON A COMMENT IT IS THE THREAD THAT ANSWERS THIS, NOT THE COMMENT'S
    // CHILDREN. A reply to a reply is filed as a SIBLING (see `CommentThread`),
    // so `parentId === row.targetId` finds nothing after a reply that landed
    // perfectly — and this function's whole job is to stop that becoming a
    // second reply to the same member. `answeredAfter` asks the question by
    // position instead, and counts either of Jake's accounts.
    const mine =
      row.surface === "post"
        ? read.comments.find((c) => c.depth === 0 && (c.byMe || adminIds().has(c.authorId)))
        : answeredAfter(read.comments, row.targetId, { usIds: adminIds() });
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
      markIntroduction(row.id, "sent");
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
    scanned: { posts: 0, postsWithComments: 0, comments: 0, dmThreads: 0, dmTheySpokeLast: 0, memberPosts: 0 },
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
  if (!cfg.comments && !cfg.dms && !cfg.memberPosts) {
    out.skipped = "Neither comments, members' posts nor DMs are switched on, so there is nothing to sweep.";
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
        // ⚠️ EMPTY MEANS "NOTHING KNOWN", NOT "NOTHING SENT", and that is the
        // safe direction here: a thread that could not be re-read loses the
        // repeat-link check for this one reply rather than refusing every link
        // in it. The rule is advisory anyway — the prompt still carries it.
        sentUrls: [] as string[],
      }));
      withContext = {
        ...target,
        context: thread.transcript,
        alreadySentUrls: thread.sentUrls,
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
      cfg.introductions,
      cfg.reviewNudge,
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

  // ⚠️ AFTER THE ANSWERS, NEVER BEFORE THEM. Learning who knows what is
  // background work; a member waiting on a reply is not. A few threads a sweep,
  // and only the ones that have changed — see `refreshProfiles`.
  if (cfg.introductions && cfg.profilesPerSweep > 0) {
    try {
      const pr = await refreshProfiles(communityUrl, { max: cfg.profilesPerSweep });
      if (pr.read) {
        out.notes.push(
          `Introductions: read ${pr.read} DM thread(s) — ${pr.ok} with a profile, ${pr.thin} too short, ` +
            `${pr.excluded} excluded, ${pr.failed} failed; ${pr.remaining} still to read.`,
        );
      }
      out.notes.push(...pr.notes);
    } catch (e) {
      out.notes.push(`Introductions: profiles could not be refreshed — ${e instanceof Error ? e.message : String(e)}`);
    }
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
