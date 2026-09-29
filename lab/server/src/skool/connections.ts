/**
 * Introductions: "you should talk with @X about it".
 *
 * Jake, 2026-09-19: "it can connect people also based on things it knows from
 * the DMs — but it should never tell what another person told me. Just say
 * 'you should talk with about it...' — do that only if you're certain you can
 * connect these two people."
 *
 * ⚠️⚠️ THE PRIVACY RULE IS STRUCTURAL, NOT A LINE IN A PROMPT. Three walls, each
 * enough on its own to stop the obvious leak:
 *
 * 1. **THE DRAFTER NEVER LEARNS ANYTHING ABOUT THE PERSON IT INTRODUCES.** Not
 *    their name, not their profile, not why. It is told only that somebody
 *    worth talking to exists, and writes `{{connect}}` where the name goes. A
 *    model cannot repeat what it was never shown — which is the only version of
 *    "never tell what another person told me" that does not rely on the model
 *    choosing to obey.
 * 2. **THE INTRO SENTENCE MAY ONLY USE THE ASKER'S OWN WORDS.** `introSentenceOk`
 *    refuses any content word in it that did not come from the message being
 *    answered (or a tiny fixed vocabulary of "you should talk with … about"),
 *    and any word that describes the person (who, has, built, told, also…).
 *    The drafter cannot invent a description either.
 * 3. **THE PROFILE STORE HOLDS EXPERIENCE, NEVER STRUGGLES.** What a member is
 *    stuck on, their money, health, age, clients or anything they asked to keep
 *    private is never extracted — so even the matcher cannot point somebody at
 *    a member BECAUSE of something private.
 *
 * ⚠️⚠️ "ONLY IF YOU'RE CERTAIN" IS TWO GATES THAT BOTH HAVE TO PASS. A lexical
 * prefilter (a specific shared term between what they asked and what the other
 * member has actually done) decides whether the matcher is even asked; the
 * matcher then has to answer `certain: true` for one candidate. The default,
 * and the common answer, is no introduction at all.
 */
import { db } from "../db/index.js";
import { aiConfig } from "../ai/config.js";
import { claudeJSONForPurposeWithUsage } from "../ai/claude.js";
import { terms } from "./knowledge.js";
import { memberFlags, flagMember, screenInbound } from "./safety.js";
import { readChannels, readMessages, type DmChannel } from "./dms.js";
import type { SkoolMember } from "./members.js";

/** Where the drafter writes the introduced member's name. */
export const CONNECT_TOKEN = "{{connect}}";

/* ────────────────────────── profiles ────────────────────────── */

export interface Experience {
  topic: string;
  /** demonstrated = described doing it, with specifics. Only these are matched. */
  strength: "demonstrated" | "claimed";
}

export interface MemberProfile {
  memberId: string;
  memberName: string;
  channelId: string;
  lastMessageId: string;
  status: "ok" | "thin" | "excluded" | "failed";
  experience: Experience[];
  noIntro: boolean;
  note: string;
  tokens: number;
  readAt: number;
}

const readJson = <T>(raw: unknown, fallback: T): T => {
  try {
    return raw ? (JSON.parse(String(raw)) as T) : fallback;
  } catch {
    return fallback;
  }
};

const rowToProfile = (r: any): MemberProfile => ({
  memberId: String(r.member_id),
  memberName: String(r.member_name ?? ""),
  channelId: String(r.channel_id ?? ""),
  lastMessageId: String(r.last_message_id ?? ""),
  status: (["ok", "thin", "excluded", "failed"] as const).includes(r.status) ? r.status : "failed",
  experience: readJson<Experience[]>(r.experience_json, []),
  noIntro: Number(r.no_intro ?? 0) === 1,
  note: String(r.note ?? ""),
  tokens: Number(r.tokens ?? 0),
  readAt: Number(r.read_at ?? 0),
});

export function listProfiles(): MemberProfile[] {
  return (db.prepare("SELECT * FROM skool_member_profiles ORDER BY read_at DESC").all() as any[]).map(rowToProfile);
}

function getProfile(memberId: string): MemberProfile | null {
  const r = db.prepare("SELECT * FROM skool_member_profiles WHERE member_id = ?").get(memberId);
  return r ? rowToProfile(r) : null;
}

function saveProfile(p: Omit<MemberProfile, "noIntro" | "readAt">): void {
  // ⚠️ `no_intro` IS NOT OVERWRITTEN. It is a human's decision about this member
  // and a re-read of their thread must not quietly reverse it.
  db.prepare(
    `INSERT INTO skool_member_profiles
       (member_id, member_name, channel_id, last_message_id, status, experience_json, note, tokens, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       member_name = excluded.member_name, channel_id = excluded.channel_id,
       last_message_id = excluded.last_message_id, status = excluded.status,
       experience_json = excluded.experience_json, note = excluded.note,
       tokens = excluded.tokens, read_at = excluded.read_at`,
  ).run(
    p.memberId, p.memberName || "", p.channelId || "", p.lastMessageId || "", p.status,
    JSON.stringify(p.experience ?? []), p.note || "", Number(p.tokens ?? 0), Date.now(),
  );
}

/** A human's switch: never introduce this member to anybody. */
export function setNoIntro(memberId: string, noIntro: boolean): boolean {
  const r = db.prepare("UPDATE skool_member_profiles SET no_intro = ? WHERE member_id = ?").run(noIntro ? 1 : 0, memberId);
  return r.changes > 0;
}

/**
 * Anything from their own messages suggesting they want it kept between them
 * and Jake. The whole thread is then treated as private: no profile at all.
 */
const PRIVATE_ASK =
  /\b(?:keep (?:this|it|that) (?:between us|private|to yourself|confidential)|between (?:you and me|us)|don'?t (?:tell|share (?:this|it))|confidential|off the record)\b/i;

const EXTRACT_SYSTEM = [
  "You read ONE member's private direct-message thread with Jake Dawson, who runs a Skool community",
  "about using AI tools. Your only job is to list what THIS MEMBER has told Jake they have actually",
  "DONE or DO FOR WORK — first-hand experience another member could learn from if the two talked.",
  "",
  "Lines starting 'Member:' are theirs. Lines starting 'Jake:' are Jake's and are context only —",
  "advice Jake gave is NOT the member's experience.",
  "",
  "For each item give a short, generic TOPIC (3-10 words), e.g. 'building Make.com automations for",
  "real-estate lead follow-up', 'editing short-form video in CapCut for clients', 'selling AI voice",
  "agents to dental clinics'. Mark it:",
  '- "demonstrated": they describe having built, run, sold, shipped or used it for real, with at',
  "  least one concrete specific.",
  '- "claimed": they say they are experienced but give nothing concrete.',
  "",
  "NEVER EXTRACT, in any wording:",
  "- anything they are struggling with, stuck on, afraid of, learning, or want to do but have not;",
  "- money: income, prices they charge, debts, what they paid;",
  "- health, family, age, where they live, religion, politics, relationships, personal circumstances;",
  "- names of their clients, employer, business or any other person;",
  "- anything they asked Jake to keep private.",
  "If a skill can only be described by including one of those, leave it out.",
  "",
  "Most threads contain NO first-hand experience — questions and thanks only. An empty list is the",
  "normal, correct answer. Never guess, never infer a skill from a question, at most 6 items.",
  "",
  'Return JSON only: {"experience":[{"topic":"...","strength":"demonstrated"|"claimed"}]}',
].join("\n");

/** Their side of the thread, and Jake's lines as context. Bounded from the END. */
function threadForExtraction(messages: { body: string; byMe: boolean }[], max = 9000): { text: string; theirChars: number } {
  const lines = messages.map((m) => `${m.byMe ? "Jake" : "Member"}: ${m.body.replace(/\s+/g, " ").trim()}`);
  let text = lines.join("\n");
  if (text.length > max) text = `…\n${text.slice(text.length - max)}`;
  const theirChars = messages.filter((m) => !m.byMe).reduce((n, m) => n + m.body.trim().length, 0);
  return { text, theirChars };
}

/** Below this much said, there is nothing to know about someone. */
const MIN_THEIR_CHARS = 120;

async function extractExperience(thread: string): Promise<{ experience: Experience[]; tokens: number; error: string | null }> {
  try {
    const { json, usage } = await claudeJSONForPurposeWithUsage({
      tier: "director",
      purpose: "skool-connect",
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: thread }],
      auth: aiConfig.skoolEngageAuth,
    });
    const parsed = readJson<{ experience?: unknown }>(json, {});
    const list = Array.isArray(parsed.experience) ? parsed.experience : [];
    const experience = list
      .map((e: any) => ({
        topic: String(e?.topic ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        strength: e?.strength === "demonstrated" ? ("demonstrated" as const) : ("claimed" as const),
      }))
      .filter((e) => e.topic.length >= 6)
      .slice(0, 6);
    const tokens = Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0);
    return { experience, tokens, error: null };
  } catch (e) {
    return { experience: [], tokens: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ProfileRefresh {
  threads: number;
  read: number;
  ok: number;
  thin: number;
  excluded: number;
  failed: number;
  /** Threads with new messages that this run left for the next one. */
  remaining: number;
  notes: string[];
}

/**
 * Bring the profiles up to date with the DM threads, a few at a time.
 *
 * ⚠️ ONLY THREADS THAT CHANGED. A profile remembers the last message id it was
 * built from; the same id means nothing new was said and the model is not asked
 * again. `max` bounds the spend per call — the sweep passes a handful, the
 * backfill endpoint more.
 */
export async function refreshProfiles(
  communityUrl: string,
  opts: { max?: number; channels?: DmChannel[] } = {},
): Promise<ProfileRefresh> {
  const out: ProfileRefresh = { threads: 0, read: 0, ok: 0, thin: 0, excluded: 0, failed: 0, remaining: 0, notes: [] };
  let channels = opts.channels;
  if (!channels) {
    const read = await readChannels(communityUrl);
    if (read.error) {
      out.notes.push(`Could not read the DM list: ${read.error}`);
      return out;
    }
    channels = read.channels;
  }
  out.threads = channels.length;

  const stale = channels.filter((c) => {
    if (!c.memberId || !c.lastMessageId) return false;
    const have = getProfile(c.memberId);
    // A failed read is retried; anything else is current until the thread moves.
    return !have || have.status === "failed" || have.lastMessageId !== c.lastMessageId;
  });
  const max = Math.max(0, opts.max ?? 5);
  const todo = stale.slice(0, max);
  out.remaining = stale.length - todo.length;

  for (const ch of todo) {
    out.read++;
    const base = { memberId: ch.memberId, memberName: ch.memberName, channelId: ch.id, lastMessageId: ch.lastMessageId };

    // ⚠️ A FLAGGED MEMBER IS NEVER PROFILED — above all a minor, who must not be
    // pointed at adults or have adults pointed at them.
    if (memberFlags(ch.memberId).length) {
      saveProfile({ ...base, status: "excluded", experience: [], note: "Flagged member — never introduced.", tokens: 0 });
      out.excluded++;
      continue;
    }

    const { messages, error } = await readMessages(communityUrl, ch);
    if (error) {
      saveProfile({ ...base, status: "failed", experience: [], note: error.slice(0, 200), tokens: 0 });
      out.failed++;
      continue;
    }
    const theirs = messages.filter((m) => !m.byMe).map((m) => m.body).join("\n");

    // The safety screen reads the whole of their side, so an age mentioned once
    // months ago still counts. It also writes the flag, which the reply agent
    // then honours on its own.
    const screen = screenInbound({ text: theirs });
    if (screen.categories.includes("minor")) {
      flagMember({ memberId: ch.memberId, memberName: ch.memberName, flag: "minor", reason: `From their DM thread: ${screen.reason}` });
      saveProfile({ ...base, status: "excluded", experience: [], note: "Said something suggesting they are under 18.", tokens: 0 });
      out.excluded++;
      continue;
    }
    if (PRIVATE_ASK.test(theirs)) {
      saveProfile({ ...base, status: "excluded", experience: [], note: "Asked for something to stay private — thread not used.", tokens: 0 });
      out.excluded++;
      continue;
    }

    const { text, theirChars } = threadForExtraction(messages);
    if (theirChars < MIN_THEIR_CHARS) {
      saveProfile({ ...base, status: "thin", experience: [], note: `Only ${theirChars} characters from them.`, tokens: 0 });
      out.thin++;
      continue;
    }

    const got = await extractExperience(text);
    if (got.error) {
      // Not recorded as known-empty: a shut rate window is not a fact about them.
      saveProfile({ ...base, status: "failed", experience: [], note: got.error.slice(0, 200), tokens: 0 });
      out.failed++;
      continue;
    }
    saveProfile({ ...base, status: "ok", experience: got.experience, note: "", tokens: got.tokens });
    out.ok++;
  }
  return out;
}

/* ────────────────────────── the introduction ledger ────────────────────────── */

export interface Introduction {
  id: number;
  replyId: string;
  surface: string;
  askerId: string;
  askerName: string;
  introducedId: string;
  introducedName: string;
  why: string;
  state: "drafted" | "sent" | "dropped";
  createdAt: number;
}

export function listIntroductions(limit = 40): Introduction[] {
  return (db.prepare("SELECT * FROM skool_introductions ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({
    id: Number(r.id),
    replyId: String(r.reply_id ?? ""),
    surface: String(r.surface ?? ""),
    askerId: String(r.asker_id ?? ""),
    askerName: String(r.asker_name ?? ""),
    introducedId: String(r.introduced_id ?? ""),
    introducedName: String(r.introduced_name ?? ""),
    why: String(r.why ?? ""),
    state: r.state === "sent" ? "sent" : r.state === "dropped" ? "dropped" : "drafted",
    createdAt: Number(r.created_at ?? 0),
  }));
}

export function recordIntroduction(input: {
  replyId: string;
  surface: string;
  askerId: string;
  askerName: string;
  introducedId: string;
  introducedName: string;
  why: string;
}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO skool_introductions
       (reply_id, surface, asker_id, asker_name, introduced_id, introduced_name, why, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?)`,
  ).run(
    input.replyId, input.surface, input.askerId, input.askerName || "", input.introducedId,
    input.introducedName || "", input.why || "", now, now,
  );
}

export function markIntroduction(replyId: string, state: "sent" | "dropped"): void {
  db.prepare("UPDATE skool_introductions SET state = ?, updated_at = ? WHERE reply_id = ? AND state = 'drafted'").run(
    state,
    Date.now(),
    replyId,
  );
}

/** Introductions that count — anything that reached a member or is about to. */
const LIVE = "state IN ('drafted','sent')";

/** How often one member may be pointed at, and one asker introduced. */
export const INTRO_LIMITS = {
  /** Most times one member is suggested to others in 14 days. */
  perIntroducedPer14Days: 2,
  /** Most introductions one asker gets in 7 days. */
  perAskerPer7Days: 1,
  /** Most introductions across the whole community in 24 hours. */
  perDay: 3,
};

function introCount(where: string, ...args: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM skool_introductions WHERE ${LIVE} AND ${where}`).get(...args) as { n: number }).n;
}

/* ────────────────────────── matching ────────────────────────── */

/**
 * Terms too broad in this community to mean two people do the same thing.
 * Everybody here "automates" something for their "business" with a "tool".
 */
const GENERIC = new Set(
  (
    "automation automate automated business businesses tool tools content client clients customer customers " +
    "money online app apps build built building system systems workflow workflows process help learn learning " +
    "start started beginner beginners project projects idea ideas people person someone team service services " +
    "company small side hustle job jobs free paid plan plans course courses community member members post posts " +
    "chatgpt gpt claude openai model models agent agents create creating creator creators social media"
  )
    .split(/\s+/)
    .flatMap((w) => terms(w)),
);

const specificTerms = (text: string): Set<string> => new Set(terms(text).filter((t) => !GENERIC.has(t)));

export interface Candidate {
  member: SkoolMember;
  experience: Experience[];
  /** Specific terms shared with what the asker wrote. */
  shared: string[];
}

interface AccessRow {
  user_id: string;
  handle: string;
  display_name: string;
  role: string;
}

/**
 * Everyone who could be introduced to this asker right now, best first.
 *
 * Exported for the tests: this is where every exclusion lives, and a missed one
 * is a member pointed at somebody they should never have been.
 */
export function candidatesFor(asker: { id: string; text: string }, limit = 5): Candidate[] {
  const want = specificTerms(asker.text);
  if (!want.size) return [];

  const members = new Map(
    (db.prepare("SELECT user_id, handle, display_name, role FROM skool_member_access").all() as AccessRow[]).map((r) => [
      r.user_id,
      r,
    ]),
  );

  const out: Candidate[] = [];
  for (const p of listProfiles()) {
    if (p.status !== "ok" || p.noIntro || p.memberId === asker.id) continue;
    const who = members.get(p.memberId);
    // ⚠️ ONLY A CURRENT, ORDINARY MEMBER WITH A HANDLE. Not in the members cache
    // means left, banned or never read — and without a handle there is no way
    // to tag them. An admin is Jake himself, under one of his two accounts.
    if (!who || !who.handle || who.role !== "member") continue;
    if (memberFlags(p.memberId).length) continue;
    // Never the same two people twice, in either direction.
    if (introCount("((asker_id = ? AND introduced_id = ?) OR (asker_id = ? AND introduced_id = ?))", asker.id, p.memberId, p.memberId, asker.id)) {
      continue;
    }
    if (introCount("introduced_id = ? AND created_at >= ?", p.memberId, Date.now() - 14 * 86_400_000) >= INTRO_LIMITS.perIntroducedPer14Days) {
      continue;
    }
    const demonstrated = p.experience.filter((e) => e.strength === "demonstrated");
    const shared = new Set<string>();
    for (const e of demonstrated) for (const t of specificTerms(e.topic)) if (want.has(t)) shared.add(t);
    if (!shared.size) continue;
    const display = who.display_name || p.memberName;
    out.push({
      member: {
        userId: p.memberId,
        handle: who.handle,
        firstName: display.split(/\s+/)[0] ?? display,
        displayName: display,
        joinedAt: 0,
        role: who.role,
        level: 0,
        paid: false,
        tier: 1,
        plan: "",
        renewsAt: 0,
      },
      experience: demonstrated,
      shared: [...shared],
    });
  }
  return out.sort((a, b) => b.shared.length - a.shared.length).slice(0, limit);
}

const MATCH_SYSTEM = [
  "You decide whether Jake Dawson should introduce a member of his AI-tools community to one other",
  "member. You are shown what the member just wrote, and a few other members' first-hand experience,",
  "anonymised as c1, c2, ...",
  "",
  "Pick a candidate ONLY IF you are CERTAIN that talking to them would genuinely help with the SPECIFIC",
  "thing this member is doing or asking — their experience is about that exact thing, not the same",
  "general area. 'Both use Make.com' is NOT enough; 'they have built the exact Make.com → Airtable",
  "client-onboarding flow this member is stuck on' is.",
  "",
  "Also answer NO when: the member is not trying to do anything (thanks, hello, a win, an opinion);",
  "the message is personal, emotional, about money trouble, a complaint or a dispute; or you would",
  "need to explain WHY the candidate is relevant for the introduction to make sense.",
  "",
  "The default and most common answer is no match. Unsure means no.",
  "",
  'Return JSON only: {"match":"c1"|null,"certain":true|false,"why":"one sentence, for Jake only"}',
].join("\n");

export interface Connection {
  member: SkoolMember;
  /** Why the matcher was certain. For the ledger and Jake — never a member. */
  why: string;
  tokens: number;
}

/**
 * The one member this asker should be introduced to, or null — which is the
 * usual answer.
 */
export async function findConnection(asker: {
  id: string;
  name: string;
  text: string;
  context?: string;
}): Promise<{ connection: Connection | null; reason: string; tokens: number }> {
  const none = (reason: string, tokens = 0) => ({ connection: null, reason, tokens });
  if (!asker.id) return none("The asker has no member id.");
  if (memberFlags(asker.id).length) return none("The asker is a flagged member — no introductions.");
  if (introCount("created_at >= ?", Date.now() - 86_400_000) >= INTRO_LIMITS.perDay) {
    return none(`Already ${INTRO_LIMITS.perDay} introductions in the last 24h.`);
  }
  if (introCount("asker_id = ? AND created_at >= ?", asker.id, Date.now() - 7 * 86_400_000) >= INTRO_LIMITS.perAskerPer7Days) {
    return none("This member was already introduced to someone this week.");
  }

  // ⚠️ THE ASKER'S OWN WORDS ONLY — not the post they commented under or the
  // older thread. The introduction has to be about what THEY are doing.
  const candidates = candidatesFor({ id: asker.id, text: asker.text });
  if (!candidates.length) return none("Nobody's experience shares a specific term with this message.");

  const refs = candidates.map((c, i) => ({ ref: `c${i + 1}`, c }));
  const user = [
    "THE MEMBER WROTE:",
    asker.text.slice(0, 3000),
    "",
    "CANDIDATES — first-hand experience only:",
    ...refs.map(({ ref, c }) => `${ref}: ${c.experience.map((e) => e.topic).join("; ")}`),
  ].join("\n");

  try {
    const { json, usage } = await claudeJSONForPurposeWithUsage({
      tier: "director",
      purpose: "skool-connect",
      system: MATCH_SYSTEM,
      messages: [{ role: "user", content: user }],
      auth: aiConfig.skoolEngageAuth,
    });
    const tokens = Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0);
    const parsed = readJson<{ match?: unknown; certain?: unknown; why?: unknown }>(json, {});
    const hit = refs.find((r) => r.ref === String(parsed.match ?? ""));
    if (!hit || parsed.certain !== true) return none(`Matcher: no certain match. ${String(parsed.why ?? "")}`.trim(), tokens);
    return {
      connection: { member: hit.c.member, why: String(parsed.why ?? "").slice(0, 300), tokens },
      reason: "",
      tokens,
    };
  } catch (e) {
    return none(`Matcher failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ────────────────────────── the sentence ────────────────────────── */

/**
 * The words an introduction may use that are not the asker's own. Anything
 * else in the sentence has to come from what they wrote.
 */
const INTRO_VOCAB = new Set(
  terms(
    "you should talk with to about it this that the one side part bit thing worth might want reach out chat " +
      "connect speak quick honestly probably definitely really maybe hit up message ping them here there too " +
      "i'd id would could get in touch conversation",
  ),
);

/** Words that describe the person being introduced. Refused outright. */
const DESCRIBES_THEM =
  /\b(?:who|whom|whose|he|she|they|him|her|his|hers|their|them|has|had|have|knows?|knew|built|builds|runs?|ran|did|does|done|went|worked|works|working|mentioned|told|tells|said|says|shared|asked|struggl\w*|dealing|also|same|similar|already|experience\w*|expert\w*|pro|specialist|figured|cracked|solved|been)\b/i;

/** Split text into sentences, keeping each sentence's own text. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Is this introduction sentence safe to send? It must name nobody but the
 * token, describe nobody, and talk only in the asker's own words.
 *
 * Returns null when it is fine, or the reason it is not.
 */
export function introSentenceOk(sentence: string, askerText: string): string | null {
  const count = sentence.split(CONNECT_TOKEN).length - 1;
  if (count !== 1) return `The introduction names ${count} people; it must name exactly one.`;
  if (sentence.length > 220) return "The introduction sentence is too long to be a plain pointer.";
  const bare = sentence.replace(CONNECT_TOKEN, " ");
  const described = DESCRIBES_THEM.exec(bare);
  if (described) return `The introduction describes the person ("${described[0]}") — it may only say to talk to them.`;
  const theirs = new Set(terms(askerText));
  const foreign = terms(bare).filter((t) => !theirs.has(t) && !INTRO_VOCAB.has(t));
  if (foreign.length) {
    return `The introduction uses words that are not the member's own (${foreign.slice(0, 4).join(", ")}) — it could be saying something about the other person.`;
  }
  return null;
}

export interface PlacedIntro {
  /** The reply with the introduction sentence removed. */
  body: string;
  /** The introduction sentence, token included — null when there is none usable. */
  sentence: string | null;
  /** Why an introduction that was written got dropped. Empty when kept or absent. */
  dropped: string;
}

/**
 * Pull the introduction out of a draft, check it, and put it LAST.
 *
 * ⚠️ LAST, ALWAYS, BECAUSE OF HOW A CHIP IS WRITTEN. A mention chip can only be
 * typed at the caret, and after a paste the caret is at the end — so the
 * sentence carrying it has to be the end. The drafter is asked to put it there;
 * this makes sure.
 */
export function placeIntro(text: string, askerText: string): PlacedIntro {
  if (!text.includes(CONNECT_TOKEN)) return { body: text.trim(), sentence: null, dropped: "" };
  const all = sentences(text);
  const withToken = all.filter((s) => s.includes(CONNECT_TOKEN));
  // Remove every sentence carrying the token from the body, whatever happens
  // next — cut out of the original, so the rest of the reply keeps its lines.
  const body = withToken
    .reduce((t, s) => t.replace(s, ""), text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (withToken.length !== 1) {
    return { body, sentence: null, dropped: `${withToken.length} sentences carried the introduction.` };
  }
  const problem = introSentenceOk(withToken[0], askerText);
  if (problem) return { body, sentence: null, dropped: problem };
  return { body, sentence: withToken[0], dropped: "" };
}

/** What a member will read: the name where the token was. */
export function renderIntro(body: string, sentence: string, marker: string): string {
  return `${body.trimEnd()}\n\n${sentence.replace(CONNECT_TOKEN, marker)}`;
}

/**
 * What the row stores about an introduction, so the send path can type the chip
 * and a failed chip can fall back to the reply without it.
 */
export interface StoredIntro {
  userId: string;
  handle: string;
  displayName: string;
  firstName: string;
  /** Exactly what stands for the person in `reply_text`. */
  marker: string;
  /** The same reply with no introduction at all. */
  withoutIntro: string;
}

export function readStoredIntro(raw: string): StoredIntro | null {
  const v = readJson<Partial<StoredIntro> | null>(raw, null);
  if (!v || !v.userId || !v.handle || !v.marker || typeof v.withoutIntro !== "string") return null;
  return {
    userId: v.userId,
    handle: v.handle,
    displayName: String(v.displayName ?? ""),
    firstName: String(v.firstName ?? ""),
    marker: v.marker,
    withoutIntro: v.withoutIntro,
  };
}

export function introMember(i: StoredIntro): SkoolMember {
  return {
    userId: i.userId,
    handle: i.handle,
    firstName: i.firstName,
    displayName: i.displayName,
    joinedAt: 0,
    role: "member",
    level: 0,
    paid: false,
    tier: 1,
    plan: "",
    renewsAt: 0,
  };
}

/** A status for the screen. */
export function connectionsStatus(): {
  profiles: { total: number; ok: number; withExperience: number; thin: number; excluded: number; failed: number; optedOut: number };
  introductions: Introduction[];
  limits: typeof INTRO_LIMITS;
} {
  const all = listProfiles();
  return {
    profiles: {
      total: all.length,
      ok: all.filter((p) => p.status === "ok").length,
      withExperience: all.filter((p) => p.status === "ok" && p.experience.some((e) => e.strength === "demonstrated")).length,
      thin: all.filter((p) => p.status === "thin").length,
      excluded: all.filter((p) => p.status === "excluded").length,
      failed: all.filter((p) => p.status === "failed").length,
      optedOut: all.filter((p) => p.noIntro).length,
    },
    introductions: listIntroductions(25),
    limits: INTRO_LIMITS,
  };
}
