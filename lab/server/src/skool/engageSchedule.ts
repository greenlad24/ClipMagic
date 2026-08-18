/**
 * The autonomous poster: a schedule, a queue, and the guards around them.
 *
 * Jake asked for an agent that posts to the community on its own. Nothing reads
 * what it writes before the members do, so every protection here is structural
 * rather than a review step: a kill switch, a weekly cap, one row per slot so a
 * retry cannot double-post, a dry-run default, and a staleness limit so a post
 * promised for Tuesday never lands on Thursday.
 *
 * ⚠️ THE SCHEDULE IS SUNDAY, TUESDAY AND FRIDAY (Jake, 2026-08-05), in
 * America/New_York — NOT the box's UTC and NOT his own Asia/Bangkok. Tuesday
 * and Friday are not arbitrary: the pinned "Start here!" post already promises
 * members "Every Tuesday – New Automation… Every Friday…", so those two days
 * are a promise the community can already read. Sunday is the addition. This is
 * why the days are settings rather than constants — but also why changing them
 * away from Tue/Fri means editing that pinned post, which belongs to the OTHER
 * "Jake Dawson" account and may not be editable from this session at all.
 *
 * ⚠️⚠️ THE RETRY QUEUE IS THE WHOLE POINT OF THE `pending` STATE, AND IT EXISTS
 * BECAUSE OF A MEASURED FAILURE, NOT A HYPOTHETICAL. Drafting spends the Claude
 * Max 5-hour window, which is SHARED with Jake's own Claude Code sessions
 * (`ai/config.ts` says so in as many words). Twice on 2026-08-05 the window was
 * exhausted by a building session and every draft failed with "Max subscription
 * rate limit reached". A scheduler that treated that as an error would silently
 * skip a promised post. So a rate-limited slot stays QUEUED and comes back on a
 * backoff — the failure it is designed around is the one that actually happened.
 */
import { aiConfig } from "../ai/config.js";
import { db } from "../db/index.js";
import {
  chooseMcpSubject,
  draftPost,
  styleExamplesFrom,
  type Attachment,
  type Draft,
  type PostKind,
} from "./engageGen.js";
import { createPost } from "./engageActions.js";
import { readFeed, SKOOL_CATEGORIES } from "./community.js";
import { allLessons } from "./knowledge.js";
import { nextVideoToAnnounce, recordAnnounced, videoSubject } from "./videoPosts.js";
import { videosForSubject } from "./channelVideos.js";
import { writeLessonForNewVideo } from "./videoLessons.js";
import { getSettings as getEngageSettings } from "../engage/db.js";

/** Weekday keys as `Intl` reports them, lowercased. */
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface EngageSchedule {
  /** The kill switch. OFF by default — an autonomous poster must be turned on. */
  enabled: boolean;
  /**
   * Draft and queue, but never publish.
   *
   * ⚠️ DEFAULTS TO TRUE, and stays true until a human has read what this thing
   * writes. `createPost` has never published anything (2026-08-05); turning the
   * schedule on with dryRun off would make an unread draft the first thing the
   * community sees from it.
   */
  dryRun: boolean;
  days: Weekday[];
  /** Local hour in `timezone`, 0–23. The slot opens at the top of this hour. */
  hour: number;
  timezone: string;
  /** Hard ceiling on posts in any rolling 7 days, counted from what we published. */
  maxPostsPerWeek: number;
  /** Attempts before a slot is abandoned. Each attempt is one backoff apart. */
  maxAttempts: number;
  /** Minutes between attempts on a queued slot. */
  retryMinutes: number;
  /**
   * How old a slot may get before it is abandoned rather than published.
   *
   * ⚠️ A LATE POST IS NOT A FREE WIN. The days are advertised to members, so a
   * Tuesday post that finally drafts on Thursday morning arrives as a Thursday
   * post nobody was promised — and lands next to Friday's. Abandoning is the
   * honest outcome, and it is recorded with its reason rather than dropped.
   */
  maxSlotAgeHours: number;
  /**
   * Turn on "Send email to all members" — for ONE post a week, not every post.
   *
   * ⚠️ THIS IS THE ONE SETTING THAT REACHES PEOPLE WHO ARE NOT LOOKING. A post
   * sits in the feed until someone visits; an email arrives. It lives in config
   * so it can be turned off in one call, without a rebuild, the moment that
   * looks wrong.
   *
   * ⚠️⚠️ AND SKOOL WILL NOT ALLOW THREE A WEEK ANYWAY — MEASURED 2026-08-12.
   * The composer's switch carries `disabled` for days after an email goes out,
   * and `currentGroup.metadata.lastNotifyAll` is the timestamp it is counting
   * from (Sun 9 Aug 22:11 UTC, still disabled 60 hours later). So "email every
   * post" was never a thing that could happen: two of the three slots were
   * always going to find the switch dead.
   *
   * ⚠️ WHICH MADE THE CHOICE OF *WHICH* POST GETS THE EMAIL AN ACCIDENT — the
   * first slot to fall outside Skool's cooldown took it, and that drifts week
   * to week. Jake, 2026-08-12: one emailed post a week. So it is now the FIRST
   * posting day of the week that carries it (see `emailDayFor`), deliberately
   * and predictably, and the other two never touch the switch.
   */
  emailNotify: boolean;
}

const DEFAULTS: EngageSchedule = {
  enabled: false,
  dryRun: true,
  days: ["sun", "tue", "fri"],
  hour: 9,
  timezone: "America/New_York",
  maxPostsPerWeek: 3,
  // Jake, 2026-08-07: "when you post I want to notify everyone by email."
  emailNotify: true,
  // 12 attempts × 30 min = 6 hours of trying, which outlasts one 5-hour Max
  // window. Fewer would give up inside the very outage this queue exists for.
  maxAttempts: 12,
  retryMinutes: 30,
  maxSlotAgeHours: 12,
};

/* ────────────────────────── settings ────────────────────────── */

function readJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getSchedule(): EngageSchedule {
  const row = db
    .prepare("SELECT engage_schedule_json AS j FROM skool_settings WHERE id = 1")
    .get() as { j?: string } | undefined;
  const stored = readJson<Partial<EngageSchedule>>(row?.j, {});
  const days = Array.isArray(stored.days)
    ? stored.days.filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d))
    : DEFAULTS.days;
  return {
    ...DEFAULTS,
    ...stored,
    // A settings blob with an empty or unparseable day list must not silently
    // mean "every day" or "never" — fall back to the agreed schedule.
    days: days.length ? days : DEFAULTS.days,
  };
}

export function setSchedule(patch: Partial<EngageSchedule>): EngageSchedule {
  const next = { ...getSchedule(), ...patch };
  // Validate the timezone HERE rather than at tick time: an unknown zone throws
  // inside Intl, and a scheduler that throws on every tick is a scheduler that
  // has quietly stopped.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next.timezone }).format(new Date());
  } catch {
    throw new Error(`"${next.timezone}" is not a timezone this system knows.`);
  }
  next.hour = Math.min(23, Math.max(0, Math.floor(next.hour)));
  db
    .prepare("UPDATE skool_settings SET engage_schedule_json = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next), Date.now());
  return next;
}

/* ────────────────────────── local time ────────────────────────── */

interface LocalNow {
  /** YYYY-MM-DD in the configured zone — this is the slot key. */
  date: string;
  weekday: Weekday;
  hour: number;
}

/**
 * What day and hour it is where the schedule lives.
 *
 * Uses `Intl` with the zone rather than a fixed offset, so the 9am slot is 9am
 * through a DST change instead of drifting an hour twice a year. Verified in
 * this container: 13:00 UTC reads as 09:00 in August and 08:00 in January.
 */
export function localNow(timezone: string, at = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  // `hour12: false` renders midnight as "24" in some ICU versions — normalise.
  const hour = Number(get("hour")) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday").toLowerCase().slice(0, 3) as Weekday,
    hour,
  };
}

/* ────────────────────────── the queue ────────────────────────── */

export type SlotState = "pending" | "posted" | "abandoned" | "drafted";

export interface Slot {
  slotKey: string;
  state: SlotState;
  subject: string;
  title: string | null;
  body: string | null;
  category: string | null;
  citedJson: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  slug: string | null;
  /** The upload this slot announces, when it is a new-video post. */
  videoId: string | null;
  /** The video or poll to attach, as stored JSON. */
  attachmentJson: string;
  /** Which post this is: the classroom lesson, or Tuesday's MCP automation. */
  kind: PostKind;
  /** The publisher's step log, kept on success as well as failure. */
  steps: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A stored attachment, or nothing.
 *
 * Anything unparseable becomes null rather than throwing: a slot whose
 * attachment blob is corrupt should still publish its words.
 */
function parseAttachment(raw: string): Attachment | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    if (a?.kind === "video" && typeof a.url === "string" && typeof a.videoId === "string") return a as Attachment;
    if (a?.kind === "poll" && Array.isArray(a.options) && a.options.length >= 2) return a as Attachment;
    return null;
  } catch {
    return null;
  }
}

function rowToSlot(r: any): Slot {
  return {
    slotKey: r.slot_key,
    state: r.state,
    subject: r.subject,
    title: r.title || null,
    body: r.body || null,
    category: r.category || null,
    citedJson: r.cited_json || "[]",
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error || null,
    slug: r.slug || null,
    videoId: r.video_id || null,
    attachmentJson: r.attachment_json || "",
    // Anything unrecognised reads as a lesson, which is the format with no
    // fixed shape to violate — an unknown value must not silently impose the
    // MCP structure on a post that was never meant to have it.
    kind: r.kind === "mcp" ? "mcp" : "lesson",
    steps: r.steps || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listSlots(limit = 30): Slot[] {
  return (
    db
      .prepare("SELECT * FROM skool_engage_slots ORDER BY created_at DESC LIMIT ?")
      .all(limit) as any[]
  ).map(rowToSlot);
}

export function getSlot(slotKey: string): Slot | null {
  const r = db.prepare("SELECT * FROM skool_engage_slots WHERE slot_key = ?").get(slotKey) as any;
  return r ? rowToSlot(r) : null;
}

/** Posts actually published in the last 7 days — the cap counts reality, not intent. */
export interface PinnedSubject {
  id: string;
  subject: string;
  state: string;
  slotKey: string;
  createdAt: number;
}

const rowToPin = (r: any): PinnedSubject => ({
  id: String(r.id),
  subject: String(r.subject),
  state: String(r.state),
  slotKey: String(r.slot_key ?? ""),
  createdAt: Number(r.created_at),
});

export function listPinnedSubjects(): PinnedSubject[] {
  return (
    db.prepare("SELECT * FROM skool_engage_pinned ORDER BY created_at ASC").all() as any[]
  ).map(rowToPin);
}

/** Add a subject to the front of the queue. Returns what was stored. */
export function pinSubject(subject: string): PinnedSubject {
  const clean = subject.replace(/\s+/g, " ").trim();
  if (clean.length < 10) throw new Error("A pinned subject needs to say what the post is about.");
  const id = `pin_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  db.prepare("INSERT INTO skool_engage_pinned (id, subject, state, slot_key, created_at) VALUES (?, ?, 'queued', '', ?)").run(
    id,
    clean,
    Date.now(),
  );
  return { id, subject: clean, state: "queued", slotKey: "", createdAt: Date.now() };
}

export function unpinSubject(id: string): boolean {
  return db.prepare("DELETE FROM skool_engage_pinned WHERE id = ?").run(id).changes > 0;
}

/** Reserve the oldest queued pin for a slot. Null when there is none. */
function takePinnedSubject(slotKey: string): PinnedSubject | null {
  const row = db
    .prepare("SELECT * FROM skool_engage_pinned WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get() as any;
  if (!row) return null;
  db.prepare("UPDATE skool_engage_pinned SET state = 'used', slot_key = ? WHERE id = ?").run(slotKey, row.id);
  return rowToPin({ ...row, state: "used", slot_key: slotKey });
}

/**
 * Hand a reserved pin back when its slot dies.
 *
 * ⚠️ WITHOUT THIS, ASKING FOR A POST AND NOT GETTING ONE WOULD BE SILENT. A slot
 * abandoned on staleness or attempts is exactly the case where the operator most
 * needs their subject to survive into the next posting day.
 */
function releasePinnedSubject(slotKey: string): void {
  db.prepare("UPDATE skool_engage_pinned SET state = 'queued', slot_key = '' WHERE slot_key = ? AND state = 'used'").run(
    slotKey,
  );
}

/** Mark a pin as delivered, once its slot actually published. */
function markPinnedPosted(slotKey: string): void {
  db.prepare("UPDATE skool_engage_pinned SET state = 'posted' WHERE slot_key = ? AND state = 'used'").run(slotKey);
}

/**
 * Every subject ever chosen, verbatim.
 *
 * ⚠️ RAW, NOT REDUCED TO A LESSON TITLE. `chooseSubject` maps these through
 * `subjectLessonTitle` because it is matching against the lesson index; an
 * automation subject is not a lesson and has no title to reduce to, so it is
 * offered to the proposer whole and the model does the "is this the same idea?"
 * judgement that no string compare can make here.
 */
function usedSubjectStrings(): string[] {
  return (db.prepare("SELECT subject FROM skool_engage_slots WHERE subject != ''").all() as { subject: string }[])
    .map((r) => r.subject)
    .slice(-40);
}

function postedThisWeek(): number {
  const since = Date.now() - 7 * 24 * 3600_000;
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM skool_engage_slots WHERE state = 'posted' AND updated_at >= ?")
    .get(since) as { n: number };
  return r.n;
}

/* ────────────────────────── choosing what to write about ────────────────────────── */

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "that", "this",
  "your", "you", "how", "what", "why", "is", "are", "it", "its", "at", "by", "from",
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Pick the subject for a slot: a lesson the community has not just been told
 * about.
 *
 * ⚠️ THE CANDIDATES ARE THE INDEXED LESSONS ONLY — the 15 rebuilt courses.
 * `allLessons` already enforces that (Jake, 2026-08-05: "index only the new
 * course and existing course - no old courses"), so this inherits the rule
 * rather than restating it, and an empty index is an ERROR below rather than a
 * scheduler that quietly writes from the model's own general knowledge.
 *
 * ⚠️ DEDUPE IS AGAINST WHAT IS ON THE FEED, NOT AGAINST OUR OWN LOG. A slot
 * that published and then failed its read-back, or a post Jake wrote by hand,
 * are both invisible to this table and both make a subject stale.
 */
/**
 * The lesson title out of a stored subject string.
 *
 * Subjects are written as `Title (from the course "Course")`, so the course
 * suffix is stripped back off to compare against the index. Lowercased because
 * this is an identity check, not a display value.
 */
function subjectLessonTitle(subject: string): string {
  return String(subject).split(' (from the course "')[0].trim().toLowerCase();
}

export async function chooseSubject(communityUrl: string): Promise<{ subject: string; error: string | null }> {
  const { lessons } = allLessons(communityUrl);
  if (!lessons.length) {
    return {
      subject: "",
      error:
        "The lesson index is empty, so there is nothing grounded to write about. " +
        "Refusing to pick a subject — an unindexed classroom would send the drafter to its own general knowledge.",
    };
  }

  // ⚠️⚠️ WHAT WE ALREADY CHOSE IS RECORDED, AND UNTIL NOW WAS NOT CONSULTED.
  // The staleness check below compares a LESSON title against recent POST
  // titles — but the drafter invents its own headline, so the two need not share
  // a word. "Finding Your First AI Win" published as "Stop Learning AI and Go
  // Get a Result" scores zero overlap against its own lesson, and the very same
  // lesson gets picked again on the next posting day: two posts, one subject,
  // and the duplicate-title guard in `createPost` cannot see it either because
  // the second headline is different too.
  //
  // The slot table has the exact subject string that was chosen. That is not a
  // heuristic, so it is checked first.
  const usedSubjects = new Set(
    (db.prepare("SELECT subject FROM skool_engage_slots WHERE subject != ''").all() as { subject: string }[]).map((r) =>
      subjectLessonTitle(r.subject),
    ),
  );

  const feed = await readFeed(communityUrl, 2);
  // A feed that will not load is not a reason to write about anything at all:
  // without it the staleness check is blind, and repeating last week's subject
  // is exactly the failure a member notices.
  if (feed.error) return { subject: "", error: `Could not read the feed to check what is already covered: ${feed.error}` };

  const recent = feed.posts.slice(0, 25).map((p) => new Set(words(p.title)));
  let best: { title: string; course: string; penalty: number } | null = null;
  // Everything already written about, so a second pass over the index does not
  // repeat the first. When every lesson has been used the set is ignored rather
  // than obeyed — an exhausted index should mean "pick the stalest", not
  // "refuse to post". At 3 a week, 143 lessons is about eleven months away.
  const unusedExists = lessons.some((l) => !usedSubjects.has(l.title.trim().toLowerCase()));

  for (const lesson of lessons) {
    if (unusedExists && usedSubjects.has(lesson.title.trim().toLowerCase())) continue;
    const w = words(`${lesson.title} ${lesson.courseTitle}`);
    if (!w.length) continue;
    // How strongly this lesson's title echoes any recent post title.
    let penalty = 0;
    for (const r of recent) {
      const overlap = w.filter((x) => r.has(x)).length / w.length;
      penalty = Math.max(penalty, overlap);
    }
    if (!best || penalty < best.penalty) best = { title: lesson.title, course: lesson.courseTitle, penalty };
    if (penalty === 0) break; // Nothing beats untouched; stop looking.
  }
  if (!best) return { subject: "", error: "No lesson in the index produced a usable subject." };
  return { subject: `${best.title} (from the course "${best.course}")`, error: null };
}

/* ────────────────────────── the tick ────────────────────────── */

/**
 * Is this a rate-limit refusal rather than a real failure?
 *
 * ⚠️ IT MEANS TWO DIFFERENT THINGS DEPENDING ON `SKOOL_AI_AUTH`, AND ONLY ONE
 * OF THEM IS PATIENT. On `subscription` it is the Max window being shut, which
 * has been observed to last a day or more — a retry queue is the right answer
 * but may still run out of attempts. On `api` it is an ordinary per-minute rate
 * limit that clears in seconds, so a retry almost always succeeds.
 *
 * Either way this is NOT the out-of-credit case: an exhausted API balance comes
 * back as an `invalid_request_error` about the credit balance, does not match
 * here, and is correctly reported as a hard failure — which is what it is,
 * since no amount of retrying fixes it.
 */
function isRateLimited(message: string): boolean {
  return /rate limit reached|rate_limit|Max subscription/i.test(message);
}

/** What to call the credential in operator-facing text. */
function credentialLabel(): string {
  return aiConfig.skoolEngageAuth === "subscription" ? "Max window shut" : "Rate limited";
}

export interface TickResult {
  enqueued: string | null;
  processed: string[];
  skipped: string | null;
}

/**
 * One scheduler cycle. NEVER throws — a background loop that throws is a
 * background loop that has stopped, and nothing would say so.
 */
export async function runScheduleTick(communityUrl: string, trigger: string): Promise<TickResult> {
  const out: TickResult = { enqueued: null, processed: [], skipped: null };
  const cfg = getSchedule();
  if (!cfg.enabled) {
    out.skipped = "The schedule is switched off.";
    return out;
  }

  const now = Date.now();
  const local = localNow(cfg.timezone, new Date(now));

  // 1. Open today's slot, if today is a posting day and the hour has come.
  //    The slot key is the LOCAL date and the table's primary key, so a tick
  //    every 10 minutes cannot open the same day twice.
  if (cfg.days.includes(local.weekday) && local.hour >= cfg.hour && !getSlot(local.date)) {
    if (postedThisWeek() >= cfg.maxPostsPerWeek) {
      out.skipped = `Weekly cap reached (${cfg.maxPostsPerWeek} posts in the last 7 days) — no slot opened for ${local.date}.`;
    } else {
      // ⚠️ A PINNED SUBJECT WINS OVER THE AGENT'S OWN CHOICE. The index-driven
      // picker is right for the standing rhythm and cannot express "say this
      // specific thing on the next posting day" — the subject may not be a
      // lesson at all. Reserved rather than deleted here; see the table comment.
      const pinned = takePinnedSubject(local.date);

      // ⚠️ A NEW VIDEO OUTRANKS THE LESSON INDEX, AND NOTHING ELSE. Jake,
      // 2026-08-07: "at least one post per week should be about a new video I
      // posted... and if there's no new video posted don't post about it." So
      // this is asked EVERY posting day rather than once a week: it answers
      // "yes" only while an upload is both recent and unannounced, which is
      // self-limiting — the ledger is written when the post lands, so the same
      // video can never claim a second slot.
      //
      // It sits BELOW a pin because a pin is a human saying "say this next",
      // and above the index because an announcement has a shelf life that a
      // lesson does not. With three slots a week, a pin taking one still leaves
      // the video the next posting day.
      const video = pinned ? null : await nextVideoToAnnounce().catch(() => null);

      // ⚠️ TUESDAY NEEDS A SUBJECT ITS OWN SHAPE CAN CARRY. The lesson index is
      // the wrong source for an automation tutorial — see `chooseMcpSubject`.
      // Asked only when nothing outranks the index, because a pin and a video
      // already force `kind: "lesson"` and would waste the call.
      const wantsMcp = !pinned && !video && local.weekday === "tue";
      const mcp = wantsMcp
        ? await chooseMcpSubject({ communityUrl, usedSubjects: usedSubjectStrings() }).catch((e) => ({
            subject: "",
            error: e instanceof Error ? e.message : String(e),
          }))
        : null;
      // ⚠️ A FAILED MCP SUBJECT FALLS BACK TO A LESSON, IT DOES NOT LOSE THE DAY.
      // The community was promised a post on Tuesday, not an MCP post
      // specifically, and a lesson is the shape with no fixed structure to break.
      if (mcp?.error) console.log(`[skool] no automation subject (${mcp.error}) — Tuesday falls back to a lesson`);

      const { subject, error } = pinned
        ? { subject: pinned.subject, error: null as string | null }
        : video
          ? { subject: videoSubject(video), error: null as string | null }
          : mcp?.subject
            ? { subject: mcp.subject, error: null as string | null }
            : await chooseSubject(communityUrl).catch((e) => ({
                subject: "",
                error: e instanceof Error ? e.message : String(e),
              }));
      if (error || !subject) {
        // Record the abandoned slot rather than trying again in ten minutes:
        // an empty index or a dead feed will not fix itself within the hour,
        // and a silent no-op is indistinguishable from "not a posting day".
        insertSlot(local.date, "", "abandoned", error ?? "No subject could be chosen.");
        out.skipped = error ?? "No subject could be chosen.";
      } else {
        insertSlot(
          local.date,
          subject,
          "pending",
          null,
          video?.videoId ?? "",
          // Decided HERE, against the weekday the slot was opened for, and
          // stored — not recomputed at draft time. A slot that retries past
          // midnight would otherwise change shape between attempts.
          kindForSlot(local.weekday, Boolean(pinned), Boolean(video), Boolean(mcp?.subject)),
        );
        out.enqueued = local.date;
      }
    }
  }

  // 2. Work the queue: every slot that is due, oldest first.
  //
  // ⚠️ RE-READ THE CLOCK RATHER THAN REUSING THE TICK'S `now`. A slot opened a
  // few lines above is stamped with a later timestamp than the one this tick
  // started with, so the tick-start value would never select it — "run now"
  // would open a slot and then decline to work on it for another ten minutes,
  // which reads as the scheduler ignoring the button.
  const due = (
    db
      .prepare("SELECT * FROM skool_engage_slots WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC")
      .all(Date.now()) as any[]
  ).map(rowToSlot);

  for (const slot of due) {
    const detail = await attemptSlot(communityUrl, slot, cfg, trigger);
    out.processed.push(`${slot.slotKey}: ${detail}`);
  }

  // 3. A classroom page for a new upload — but ONLY on a tick that opened a
  //    slot, which is what `out.enqueued` means.
  //
  // ⚠️⚠️ NOT ON EVERY TICK, AND THE REASON IS MONEY. This runs every ten
  // minutes. `transcriptForVideo` falls back to Apify when free captions are
  // unavailable, and Apify is the one thing in this feature that bills — so a
  // video whose captions are off would buy a transcript 144 times a day, and
  // the failure that repeats is exactly the one that reaches the paid path.
  //
  // Tying it to a slot opening bounds it to three attempts a week, which is
  // still several chances inside the upload's 7-day window, and puts it on the
  // same rhythm as everything else here.
  //
  // ⚠️ AFTER THE POST, NEVER BEFORE. Writing a page navigates the shared
  // browser away to a course and back; doing that first would move the page out
  // from under a composer the publisher is partway through. And a page that
  // fails must not cost the community its post — so this is awaited for its log
  // and its failure is not the tick's.
  if (out.enqueued && !cfg.dryRun) {
    try {
      const lesson = await writeLessonForNewVideo(communityUrl, {});
      if (lesson.wrote || lesson.videoId) out.processed.push(`classroom page: ${lesson.detail}`);
    } catch (e) {
      out.processed.push(`classroom page failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * Every text column on the slot table is NOT NULL DEFAULT '', so "no error" and
 * "no slug" are the empty string, never SQL NULL.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE THE FIRST VERSION LOST A SLOT WITHOUT SAYING SO. It
 * inserted `last_error = null` into a NOT NULL column under INSERT OR IGNORE —
 * and OR IGNORE suppresses constraint violations, not just duplicate keys. The
 * tick returned `enqueued: "2026-08-05"` and the table stayed empty. A queue
 * that reports having queued something it did not is worse than one that
 * crashes, which is why the INSERT below is now plain and only a genuine
 * duplicate key is tolerated.
 */
const text = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Which of the two post shapes this slot should be written as.
 *
 * ⚠️ THIS WAS HARDCODED TO "lesson" UNTIL 2026-08-08, WHICH MEANT THE TUESDAY
 * MCP POST HAD NEVER ONCE BEEN WRITTEN BY THE SCHEDULER. `mechanics()` only
 * reaches for MCP_NOTE when the kind says so, so every autonomous post came out
 * as a classroom lesson regardless of the day it landed on.
 *
 * The two overrides are the point of having a function rather than a weekday
 * check inline:
 *   • a PINNED subject is a human saying "say this next", and there is nothing
 *     in a pin that says it is an automation idea — forcing Tuesday's four-part
 *     shape onto it would rewrite what was asked for;
 *   • a NEW-VIDEO announcement is about an upload, and the MCP shape demands a
 *     step-by-step tutorial for a service integration it does not have.
 * Both fall back to "lesson", the shape with no fixed structure to break.
 */
export function kindForSlot(
  weekday: Weekday,
  pinned: boolean,
  video: boolean,
  haveMcpSubject: boolean,
): PostKind {
  if (pinned || video) return "lesson";
  // ⚠️ THE THIRD OVERRIDE, ADDED 2026-08-09: NO AUTOMATION SUBJECT, NO MCP SHAPE.
  // Tuesday used to become "mcp" on the weekday alone, while its subject came
  // from the LESSON index — a shape demanding a four-part service tutorial
  // stapled to a subject that is not an automation. The drafter resolved that
  // by dropping the shape, so the flag said "mcp" and the post was a lesson.
  // The kind now follows the SUBJECT, which is the thing the shape has to fit.
  return weekday === "tue" && haveMcpSubject ? "mcp" : "lesson";
}

/**
 * Which posting day carries the week's one email — the earliest configured day.
 *
 * ⚠️ THE WEEK STARTS ON SUNDAY HERE BECAUSE `WEEKDAYS` DOES, and because the
 * configured days are sun/tue/fri, which makes Sunday the natural opener rather
 * than a tie-break nobody would remember. Derived from the configured days
 * rather than stored, so re-configuring the schedule cannot leave the email
 * pinned to a day that no longer posts — the failure mode where the setting
 * silently stops applying to anything.
 *
 * Pure and exported for the same reason `describeLockHold` is: the alternative
 * is proving it by waiting for a Sunday.
 */
export function emailDayFor(days: readonly Weekday[]): Weekday | null {
  for (const d of WEEKDAYS) if (days.includes(d)) return d;
  return null;
}

/**
 * Whether this slot is the one that emails the community.
 *
 * ⚠️ A KEY THAT IS NOT A CALENDAR DATE ANSWERS NO. Slots published by hand are
 * recorded as `2026-08-12-manual` so the subject picker and the weekly cap can
 * see them, and a parse that quietly accepted the prefix would hand the week's
 * only email to a row written after the fact. Not-a-posting-day is the safe
 * answer for anything unrecognised: it fails toward not emailing 65 people.
 */
export function isEmailSlot(slotKey: string, days: readonly Weekday[]): boolean {
  const target = emailDayFor(days);
  if (!target) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slotKey);
  if (!m) return false;
  // A bare calendar date has one weekday whatever zone reads it, so UTC is not
  // an assumption here — it is the only way to avoid importing one.
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(at.getTime())) return false;
  return WEEKDAYS[at.getUTCDay()] === target;
}

function insertSlot(
  slotKey: string,
  subject: string,
  state: SlotState,
  error: string | null,
  videoId = "",
  kind: PostKind = "lesson",
): void {
  const now = Date.now();
  try {
    db
      .prepare(
        `INSERT INTO skool_engage_slots
           (slot_key, state, subject, cited_json, attempts, next_attempt_at, last_error, video_id, kind, created_at, updated_at)
         VALUES (?, ?, ?, '[]', 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(slotKey, state, subject, now, text(error), videoId, kind, now, now);
  } catch (e) {
    // A duplicate slot key is the one benign failure: the day is already open,
    // which is exactly what the primary key is for. Anything else is a bug and
    // must be heard.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE constraint/i.test(msg)) throw e;
  }
}

function updateSlot(slotKey: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  // Same rule as the insert: nulls become empty strings, or the UPDATE throws
  // against the NOT NULL columns and a completed publish fails to record.
  const values = keys.map((k) => {
    const v = patch[k];
    return typeof v === "number" ? v : text(v);
  });
  db
    .prepare(`UPDATE skool_engage_slots SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE slot_key = ?`)
    .run(...values, Date.now(), slotKey);
}

/**
 * One attempt at one slot: draft it, then publish it unless this is a dry run.
 *
 * The three outcomes are deliberately not collapsed into ok/failed:
 *   • published — read back from the feed by `createPost`, which is the only
 *     evidence that counts;
 *   • still queued — the Max window was shut, so this is not a failure and the
 *     slot keeps its place;
 *   • abandoned — attempts or the staleness limit ran out, recorded with why.
 */
async function attemptSlot(
  communityUrl: string,
  slot: Slot,
  cfg: EngageSchedule,
  trigger: string,
): Promise<string> {
  const ageHours = (Date.now() - slot.createdAt) / 3600_000;
  if (ageHours > cfg.maxSlotAgeHours) {
    const why =
      `Abandoned after ${ageHours.toFixed(1)}h — past the ${cfg.maxSlotAgeHours}h limit. ` +
      `The day this was promised for has effectively passed; posting it now would arrive as a post nobody was expecting.`;
    updateSlot(slot.slotKey, { state: "abandoned", last_error: why });
    releasePinnedSubject(slot.slotKey);
    return why;
  }
  if (slot.attempts >= cfg.maxAttempts) {
    const why = `Abandoned after ${slot.attempts} attempts. Last error: ${slot.lastError ?? "unknown"}`;
    updateSlot(slot.slotKey, { state: "abandoned", last_error: why });
    releasePinnedSubject(slot.slotKey);
    return why;
  }

  const attempts = slot.attempts + 1;
  const backoff = Date.now() + cfg.retryMinutes * 60_000;

  // Draft, unless a previous attempt already produced one. Re-drafting a slot
  // that failed only at the publish step would spend the window again AND put
  // different words on the community than the ones that were reviewed.
  let draft: Draft | null =
    slot.title && slot.body
      ? {
          title: slot.title,
          body: slot.body,
          category: slot.category,
          // ⚠️ REPLAYED, NOT RE-CHOSEN. The stored words are reused on a retry
          // precisely so the community gets what was already settled on; the
          // attachment is part of that and must not be picked again.
          attachment: parseAttachment(slot.attachmentJson),
          cited: [],
          tokens: null,
          model: "",
        }
      : null;

  if (!draft) {
    const feed = await readFeed(communityUrl, 1).catch(() => null);
    const res = await draftPost({
      communityUrl,
      // ⚠️ THE SAME VOICE PROMPT THE MANUAL ENDPOINTS USE, AND FOR THE SAME
      // REASON THE DRAFTER REFUSES WITHOUT ONE: a post signed "Jake Dawson"
      // written in nobody's voice is worse than no post. Passing "" here is
      // what the first version did, and the drafter correctly refused.
      //
      // ⚠️ NOTE THE COUPLING: this is the Engagement Manager's reply prompt,
      // borrowed. It was written for YouTube/IG comment replies, not for a
      // Skool community post, so it is the right VOICE against the wrong
      // SURFACE. `styleExamples` below is what closes that gap in practice —
      // his own posts show the surface far better than a prompt could describe
      // it — but the prompt itself is still the comment box's.
      voicePrompt: getEngageSettings().replyPromptMd ?? "",
      // From the slot, decided when it opened. See `kindForSlot`.
      kind: slot.kind,
      subject: slot.subject,
      recentTitles: (feed?.posts ?? []).filter((p) => p.byMe).slice(0, 12).map((p) => p.title).filter(Boolean),
      // From the SAME read as recentTitles. If the feed read failed there are no
      // examples, and the draft falls back to the comment-box register — which
      // is a worse draft, not a wrong one, so it is not worth failing over.
      styleExamples: styleExamplesFrom(feed?.posts ?? []),
      // ⚠️ AN EMPTY LIST HERE MEANS AN UNCATEGORISED POST, AND THE FEED'S LIST
      // IS ALWAYS EMPTY. The manual endpoint has always fallen back to the known
      // categories; the scheduler passed `[]` instead, so the drafter had
      // nothing to choose from and every autonomous post would have landed with
      // no category at all. Caught by rehearsing a real tick and finding
      // `category: null` on the drafted slot.
      categories: feed?.categories?.length ? feed.categories : SKOOL_CATEGORIES,
      preferredCategory: null,
      // ⚠️ SWITCHED BACK ON 2026-08-08, AFTER THE ATTACH WAS ACTUALLY FIXED.
      // These were emptied on 2026-08-07 because attaching appeared not to
      // work; it did work, and the code was pressing Enter — which closes the
      // link panel WITHOUT committing — before clicking the button that does
      // the attaching. The confirmation was also unsatisfiable: it looked for
      // the video id in the composer's DOM, and Skool never puts it there.
      //
      // The reason they were emptied still stands as a rule: if attaching ever
      // stops working, empty this list again rather than letting a draft write
      // "watch it below" over a post with no video.
      videoCandidates: await videosForSubject(slot.subject).catch(() => []),
    }).catch((e) => ({ draft: null, error: e instanceof Error ? e.message : String(e) }));

    if (res.error || !res.draft) {
      const msg = res.error ?? "The drafter returned nothing.";
      // ⚠️ THE WINDOW BEING SHUT IS NOT A FAILURE — IT IS THE CASE THIS QUEUE
      // WAS BUILT FOR. Stay pending and come back on the backoff.
      updateSlot(slot.slotKey, { attempts, next_attempt_at: backoff, last_error: msg });
      return isRateLimited(msg)
        ? `${credentialLabel()} — still queued, attempt ${attempts}/${cfg.maxAttempts}, retrying in ${cfg.retryMinutes} min.`
        : `Draft failed (attempt ${attempts}/${cfg.maxAttempts}): ${msg}`;
    }
    draft = res.draft;
    updateSlot(slot.slotKey, {
      title: draft.title,
      body: draft.body,
      category: draft.category,
      cited_json: JSON.stringify(draft.cited ?? []),
      attachment_json: draft.attachment ? JSON.stringify(draft.attachment) : "",
      attempts,
      next_attempt_at: backoff,
    });
  }

  if (cfg.dryRun) {
    updateSlot(slot.slotKey, { state: "drafted", last_error: null });
    // ⚠️ A DRAFTED SLOT NEVER PUBLISHES, SO ITS PINNED SUBJECT WAS NOT
    // DELIVERED. `drafted` is neither `posted` nor `abandoned`, so without this
    // the pin would sit reserved against a slot that is finished — never sent,
    // never returned to the queue, and never mentioned again. The operator
    // would simply not get the post they asked for, and nothing would say so.
    releasePinnedSubject(slot.slotKey);
    return `Drafted "${draft.title}" and STOPPED — dry run is on, so nothing was published.`;
  }

  const posted = await createPost({
    communityUrl,
    title: draft.title,
    body: draft.body,
    category: draft.category,
    // One email a week, on the week's first posting day — see `emailNotify` in
    // the config above. Skool would refuse the other two anyway; deciding it
    // here is what makes WHICH post gets it a choice instead of a race.
    emailNotify: cfg.emailNotify && isEmailSlot(slot.slotKey, cfg.days),
    attachment: draft.attachment,
  }).catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e), post: null }));

  if (!posted.ok) {
    updateSlot(slot.slotKey, { attempts, next_attempt_at: backoff, last_error: posted.detail, steps: posted.detail });
    return `Publish failed (attempt ${attempts}/${cfg.maxAttempts}): ${posted.detail}`;
  }

  updateSlot(slot.slotKey, {
    state: "posted",
    slug: posted.post?.slug ?? null,
    last_error: null,
    // ⚠️ KEPT ON SUCCESS TOO, which is the whole point. The publisher's log is
    // where "⚠ Attachment SKIPPED — …" appears, and an attachment never blocks
    // a post — so a post whose video did not attach is a SUCCESS by every other
    // stored measure. Clearing this alongside `last_error` is how that goes
    // unnoticed.
    steps: posted.detail,
  });
  markPinnedPosted(slot.slotKey);
  // ⚠️ THE VIDEO IS BURNED HERE AND NOWHERE EARLIER. Recording it at draft time
  // would mean a slot that drafted and then failed to publish had "used up" the
  // video: the retry would find it already announced, fall through to a lesson,
  // and that upload would never get the post it was owed — silently, since
  // nothing distinguishes "already announced" from "announced by us, today".
  if (slot.videoId) recordAnnounced(slot.videoId, draft.title, slot.slotKey);
  console.log(`[skool] (${trigger}) published "${draft.title}" for slot ${slot.slotKey}`);
  return `Published: ${posted.detail}`;
}

/* ────────────────────────── the loop ────────────────────────── */

let timer: NodeJS.Timeout | null = null;

/**
 * When the in-flight cycle started, or null when idle. This is the overlap
 * guard, and it is a TIMESTAMP rather than a boolean so that "a cycle is
 * running" and "a cycle has been running for four hours" are distinguishable.
 * As a boolean the second case is invisible, and it is the one that matters.
 */
let inFlightSince: number | null = null;
/** Rate-limit for the wedge warning, so it shouts hourly rather than per tick. */
let wedgeLoggedAt = 0;

function tickIntervalMs(): number {
  const raw = Number(process.env.SKOOL_ENGAGE_TICK_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 600_000;
}

/**
 * How long a cycle may run before it is treated as wedged rather than busy.
 *
 * Generous on purpose. A real cycle drafts a post (a Claude call), publishes it
 * through the browser, and may then write a classroom page — which is a second
 * Claude call plus a transcript fetch. Several minutes is normal. Fifteen is
 * not, and nothing here has a timeout of its own: `browser.ts` sets none, so a
 * navigation that never settles never returns.
 */
export const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Read the held lock: is this a cycle that is busy, or one that is never coming
 * back?
 *
 * Pure, and separate from the loop, because it is the judgement worth testing
 * and the hardest one to reach by waiting — provoking it for real means holding
 * a lock for a quarter of an hour inside a hung browser call.
 */
export function describeLockHold(heldForMs: number): { wedged: boolean; detail: string } {
  if (heldForMs > STUCK_AFTER_MS) {
    return {
      wedged: true,
      detail:
        `⚠️ The scheduler is WEDGED — a cycle has held the lock for ${Math.round(heldForMs / 60_000)} min ` +
        `(limit ${STUCK_AFTER_MS / 60_000} min) and nothing can post until the lab is restarted.`,
    };
  }
  return { wedged: false, detail: `A cycle has been running for ${Math.round(heldForMs / 1000)}s.` };
}

/* ── the heartbeat ── */

export interface TickHealth {
  /** Whether the loop was ever started in this process. */
  armed: boolean;
  intervalMs: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  /** One line about the last completed cycle: what it did, or how it failed. */
  lastOutcome: string;
  /** Set while a cycle is in flight. */
  runningSinceMs: number | null;
  /** True once the in-flight cycle passes STUCK_AFTER_MS. */
  stuck: boolean;
}

function readHealth(): Partial<TickHealth> {
  const row = db
    .prepare("SELECT engage_tick_json AS j FROM skool_settings WHERE id = 1")
    .get() as { j?: string } | undefined;
  return readJson<Partial<TickHealth>>(row?.j, {});
}

/**
 * ⚠️ SWALLOWS ITS OWN ERRORS, AND MUST. This is called from the cycle's
 * `finally`, where a throw becomes an unhandled rejection out of a `void
 * cycle()` — so a heartbeat that failed to write would take down the scheduler
 * it exists to watch, turning a monitoring feature into the outage. A missing
 * heartbeat already reads as "something is wrong", which is the right answer
 * when writing it is what broke.
 */
function writeHealth(patch: Partial<TickHealth>): void {
  try {
    const next = { ...readHealth(), ...patch };
    db
      .prepare("UPDATE skool_settings SET engage_tick_json = ? WHERE id = 1")
      .run(JSON.stringify(next));
  } catch (e) {
    console.warn(`[skool] could not write the scheduler heartbeat: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * What the operator needs to tell a healthy silence from a dead one.
 *
 * ⚠️ THE INTERESTING FIELD IS `stuck`, AND IT EXISTS BECAUSE THE FAILURE IT
 * REPORTS CANNOT BE SEEN ANY OTHER WAY. If a cycle hangs inside the browser,
 * the overlap guard does exactly what it was built to do and every later tick
 * returns immediately — forever, without a log line, with the container still
 * reporting healthy and the HTTP API still answering. The next missed post is
 * the first symptom, and by then `maxSlotAgeHours` has abandoned the slot.
 */
export function schedulerHealth(): TickHealth {
  const stored = readHealth();
  const now = Date.now();
  return {
    armed: timer !== null,
    intervalMs: tickIntervalMs(),
    lastStartedAt: stored.lastStartedAt ?? null,
    lastFinishedAt: stored.lastFinishedAt ?? null,
    lastOutcome: stored.lastOutcome ?? "",
    runningSinceMs: inFlightSince === null ? null : now - inFlightSince,
    stuck: inFlightSince !== null && now - inFlightSince > STUCK_AFTER_MS,
  };
}

/**
 * Start the background loop (idempotent).
 *
 * The community URL is read at TICK time, not here: the lab boots before the
 * operator has set it, and a loop that captured an empty URL at startup would
 * stay broken until a restart nobody knew was needed.
 */
export function startEngageScheduler(readCommunityUrl: () => string): void {
  if (timer) return;
  const interval = tickIntervalMs();
  console.log(`[skool] engagement scheduler armed — ticking every ${Math.round(interval / 1000)}s`);
  const cycle = async (trigger: string): Promise<void> => {
    // Overlap guard: a tick landing mid-publish must not stack.
    //
    // ⚠️⚠️ A WEDGED CYCLE IS NOT RECOVERED HERE, AND THAT IS DELIBERATE. The
    // tempting fix is to race the tick against a timeout and release the guard
    // when it expires — but a timeout does not stop the hung publish, it only
    // stops waiting for it. Releasing the guard would let the next tick start a
    // second `attemptSlot` on the same pending row while the first is still
    // inside the composer, and the two would draft and publish the same day
    // twice, to 65 inboxes. Against that, a scheduler that stops is the better
    // failure — so this shouts and keeps refusing, and recovery is a restart a
    // human orders. What was unacceptable was doing it silently.
    if (inFlightSince !== null) {
      const held = describeLockHold(Date.now() - inFlightSince);
      if (held.wedged && Date.now() - wedgeLoggedAt > 3600_000) {
        wedgeLoggedAt = Date.now();
        console.error(`[skool] ${held.detail} Cycle started at ${new Date(inFlightSince).toISOString()}.`);
        writeHealth({ lastOutcome: `WEDGED since ${new Date(inFlightSince).toISOString()}` });
      }
      return;
    }
    inFlightSince = Date.now();
    writeHealth({ lastStartedAt: inFlightSince });
    let outcome = "";
    try {
      const url = readCommunityUrl();
      if (!url) {
        outcome = "No community URL set.";
        return;
      }
      const r = await runScheduleTick(url, trigger);
      for (const line of r.processed) console.log(`[skool] ${line}`);
      outcome = r.processed.length ? r.processed.join(" | ") : (r.skipped ?? "Nothing due.");
    } catch (e) {
      outcome = `tick failed: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[skool] scheduler ${outcome}`);
    } finally {
      inFlightSince = null;
      // The heartbeat is written on EVERY cycle including the empty ones. A
      // heartbeat that only marked the interesting ticks would go stale three
      // times a week by design, which is exactly the signal it has to not send.
      writeHealth({ lastFinishedAt: Date.now(), lastOutcome: outcome.slice(0, 500) });
    }
  };
  setTimeout(() => void cycle("startup"), 20_000);
  timer = setInterval(() => void cycle("interval"), interval);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Run one cycle on demand. Returns false when one is already in flight.
 *
 * ⚠️ IT SHARES THE LOOP'S GUARD, SO IT ALSO SEES THE WEDGE — and says so. The
 * "Run now" button is what an operator presses when a post has not appeared, so
 * it is the most likely place for a wedged scheduler to be discovered. A bare
 * "a cycle is already running" would send them away reassured.
 */
export async function tickNow(
  communityUrl: string,
): Promise<{ started: boolean; result: TickResult | null; detail?: string }> {
  if (inFlightSince !== null) {
    return { started: false, result: null, detail: describeLockHold(Date.now() - inFlightSince).detail };
  }
  inFlightSince = Date.now();
  writeHealth({ lastStartedAt: inFlightSince });
  try {
    return { started: true, result: await runScheduleTick(communityUrl, "on-demand") };
  } finally {
    inFlightSince = null;
    writeHealth({ lastFinishedAt: Date.now(), lastOutcome: "on-demand cycle" });
  }
}

/**
 * Publish a slot that is sitting in `drafted` — the reviewed-then-published
 * path, and the only way a post goes out while dry run is on.
 *
 * ⚠️ IT DOES NOT RE-DRAFT. The whole value of an approval step is that what
 * ships is what was read; re-drafting here would quietly publish different
 * words to the ones approved.
 */
export async function publishSlot(communityUrl: string, slotKey: string): Promise<{ ok: boolean; detail: string }> {
  const slot = getSlot(slotKey);
  if (!slot) return { ok: false, detail: `No slot "${slotKey}".` };
  if (slot.state === "posted") return { ok: false, detail: `Slot ${slotKey} is already posted (/${slot.slug ?? "?"}).` };
  if (!slot.title || !slot.body) return { ok: false, detail: `Slot ${slotKey} has no draft to publish.` };

  // Same rule as the autonomous path — a hand-published slot that emailed when
  // its scheduled twin would not have is the surprise nobody asked for, and it
  // would spend the week's one allowed email on whichever slot an operator
  // happened to press the button on.
  const cfg = getSchedule();
  const posted = await createPost({
    communityUrl,
    title: slot.title,
    body: slot.body,
    category: slot.category,
    emailNotify: cfg.emailNotify && isEmailSlot(slotKey, cfg.days),
    // The attachment the slot already settled on — same reason the words are
    // replayed rather than re-drafted.
    attachment: parseAttachment(slot.attachmentJson),
  });
  if (!posted.ok) {
    updateSlot(slotKey, { last_error: posted.detail });
    return { ok: false, detail: posted.detail };
  }
  updateSlot(slotKey, { state: "posted", slug: posted.post?.slug ?? null, last_error: null });
  return { ok: true, detail: posted.detail };
}
