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
import { draftPost, styleExamplesFrom, type Draft } from "./engageGen.js";
import { createPost } from "./engageActions.js";
import { readFeed, SKOOL_CATEGORIES } from "./community.js";
import { allLessons } from "./knowledge.js";
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
}

const DEFAULTS: EngageSchedule = {
  enabled: false,
  dryRun: true,
  days: ["sun", "tue", "fri"],
  hour: 9,
  timezone: "America/New_York",
  maxPostsPerWeek: 3,
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
  createdAt: number;
  updatedAt: number;
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
      const { subject, error } = pinned
        ? { subject: pinned.subject, error: null as string | null }
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
        insertSlot(local.date, subject, "pending", null);
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

function insertSlot(slotKey: string, subject: string, state: SlotState, error: string | null): void {
  const now = Date.now();
  try {
    db
      .prepare(
        `INSERT INTO skool_engage_slots
           (slot_key, state, subject, cited_json, attempts, next_attempt_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, '[]', 0, ?, ?, ?, ?)`,
      )
      .run(slotKey, state, subject, now, text(error), now, now);
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
      ? { title: slot.title, body: slot.body, category: slot.category, cited: [], tokens: null, model: "" }
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
      kind: "lesson",
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
  }).catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e), post: null }));

  if (!posted.ok) {
    updateSlot(slot.slotKey, { attempts, next_attempt_at: backoff, last_error: posted.detail });
    return `Publish failed (attempt ${attempts}/${cfg.maxAttempts}): ${posted.detail}`;
  }

  updateSlot(slot.slotKey, {
    state: "posted",
    slug: posted.post?.slug ?? null,
    last_error: null,
  });
  markPinnedPosted(slot.slotKey);
  console.log(`[skool] (${trigger}) published "${draft.title}" for slot ${slot.slotKey}`);
  return `Published: ${posted.detail}`;
}

/* ────────────────────────── the loop ────────────────────────── */

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

function tickIntervalMs(): number {
  const raw = Number(process.env.SKOOL_ENGAGE_TICK_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 600_000;
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
    if (inFlight) return; // Overlap guard: a tick landing mid-publish must not stack.
    inFlight = true;
    try {
      const url = readCommunityUrl();
      if (!url) return;
      const r = await runScheduleTick(url, trigger);
      for (const line of r.processed) console.log(`[skool] ${line}`);
    } catch (e) {
      console.warn(`[skool] scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  };
  setTimeout(() => void cycle("startup"), 20_000);
  timer = setInterval(() => void cycle("interval"), interval);
  if (typeof timer.unref === "function") timer.unref();
}

/** Run one cycle on demand. Returns false when one is already in flight. */
export async function tickNow(communityUrl: string): Promise<{ started: boolean; result: TickResult | null }> {
  if (inFlight) return { started: false, result: null };
  inFlight = true;
  try {
    return { started: true, result: await runScheduleTick(communityUrl, "on-demand") };
  } finally {
    inFlight = false;
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

  const posted = await createPost({
    communityUrl,
    title: slot.title,
    body: slot.body,
    category: slot.category,
  });
  if (!posted.ok) {
    updateSlot(slotKey, { last_error: posted.detail });
    return { ok: false, detail: posted.detail };
  }
  updateSlot(slotKey, { state: "posted", slug: posted.post?.slug ?? null, last_error: null });
  return { ok: true, detail: posted.detail };
}
