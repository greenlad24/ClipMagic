/**
 * Unit checks for the FREEMIUM half of the reply agent (skool/access,
 * skool/engageReplies):
 *   - freeTierCourseSlugs()   both gates, because one of them lies on its own
 *   - entitlementFor()        a member nobody knows is FREE, and says so
 *   - allowedCourseSlugs()    null and [] mean opposite things
 *   - splitAtLastReply()      three messages in a row are ONE question
 *
 * ⚠️⚠️ WHAT THESE GUARD IS A LINK A MEMBER CANNOT OPEN. Jake, 2026-08-27: the
 * community is freemium and only *Free AI Starter Pack* is open to free
 * members. Every failure in this file looks like a perfectly good reply — the
 * grounding is real, the URL resolves, the prose is right — and lands the
 * person on a paywall they were just told held their answer.
 *
 * ⚠️ THE TWO-GATE TEST IS NOT THEORETICAL. Measured on this community the same
 * day: *Make Videos with AI* and *Automation For Beginners* are `minTier: 1`
 * and `minAccessLevel: 9`. Read the tier alone and three courses look free when
 * exactly one is, so the mistake is a wrong answer, not a crash.
 *
 * Runs against a throwaway DATA_DIR, so nothing here touches real lab data, and
 * every function under test reads the database rather than Skool — no browser,
 * no network. Run:
 *   cd lab && docker build -f Dockerfile --target server -t X . &&
 *   docker run --rm -w /build/server X node dist/scripts/skoolFreemium.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-skool-freemium-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const { cachedAccess, courseGates, entitlementFor, allowedCourseSlugs, freeTierCourseSlugs } =
    await import("../skool/access.js");
  const { splitAtLastReply, asksAboutUpgrading, plansNudgeState } = await import("../skool/engageReplies.js");
  const { db } = await import("../db/index.js");

  const now = Date.now();
  const gate = (slug: string, title: string, minTier: number, minLevel: number) =>
    db
      .prepare(
        `INSERT INTO skool_course_gate (slug, course_id, title, min_tier, min_access_level, read_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(slug, `id-${slug}`, title, minTier, minLevel, now);
  const member = (userId: string, name: string, tier: number, paid: number, level: number) =>
    db
      .prepare(
        `INSERT INTO skool_member_access (user_id, handle, display_name, tier, paid, level, plan, renews_at, role, read_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 0, 'member', ?)`,
      )
      .run(userId, name.toLowerCase().replace(/\s+/g, "-"), name, tier, paid, level, now);

  /* ── the tables the whole gate rests on ── */

  await check("the freemium tables exist on a FRESH database, not just a migrated one", () => {
    // The migration for a live database is a separate code path; a new install
    // gets these from the CREATE TABLE block, and only this notices if one of
    // the two is ever added to just one of them.
    assert.equal(courseGates().length, 0);
    assert.equal(cachedAccess("nobody"), null);
    const cols = (db.prepare("PRAGMA table_info(skool_reply_log)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("member_tier"), "skool_reply_log needs member_tier");
    assert.ok(cols.includes("member_level"), "skool_reply_log needs member_level");
  });

  /* ── which courses are actually open to everyone ── */

  await check("⚠️ a free-tier course still shut behind a LEVEL is not open to free members", () => {
    gate("999f28e8", "Free AI Starter Pack", 1, 1);
    gate("39633a7c", "Make Videos with AI", 1, 9);
    gate("ed03b880", "Automation For Beginners", 1, 9);
    gate("20abb1f4", "AI for Beginners", 2, 6);
    // The measured trap: three courses say minTier 1, one of them is open.
    assert.deepEqual(freeTierCourseSlugs(), ["999f28e8"]);
  });

  /* ── who a member is ── */

  await check("a member nobody has read is FREE, and is marked unknown rather than free", () => {
    const ent = entitlementFor("never-seen", "Someone New");
    assert.equal(ent.member.tier, 1);
    assert.equal(ent.member.paid, false);
    // ⚠️ THE DISTINCTION THE LEDGER AND THE BADGE BOTH RELY ON. "Free" is a
    // fact about a member; "unknown" is a fact about the read, and a run of
    // them is a members page that has stopped working — not a free community.
    assert.equal(ent.member.unknown, true);
    assert.equal(ent.member.displayName, "Someone New");
  });

  await check("a paying member is tier 2, and a free one is tier 1", () => {
    member("u-paid", "Renato Battaglia", 2, 1, 3);
    member("u-free", "Lam Tran", 1, 0, 2);
    assert.equal(entitlementFor("u-paid").member.paid, true);
    assert.equal(entitlementFor("u-paid").member.unknown, false);
    assert.equal(entitlementFor("u-free").member.paid, false);
    assert.equal(entitlementFor("u-free").member.unknown, false);
  });

  /* ── what they may be pointed at ── */

  await check("⚠️ a paying member's LEVEL does not shut a course — Jake, 2026-08-27", () => {
    // 12 of the 16 paid courses are minAccessLevel 9. Read the two gates as a
    // conjunction and a paying member at level 3 can open almost nothing —
    // which is not what he sells, and not what `openCourses` should report.
    member("u-lowlevel", "Scott Yates", 2, 1, 1);
    assert.equal(entitlementFor("u-lowlevel").openCourses.length, courseGates().length);
    assert.deepEqual(entitlementFor("u-lowlevel").lockedCourses, []);
  });

  await check("a paying member is not restricted at all — null, not a list of everything", () => {
    // ⚠️ null IS THE CONTRACT WITH `retrieve`. A list containing every slug
    // would work today and would silently stop containing a course added
    // tomorrow, which is a paying member quietly losing half the classroom.
    assert.equal(allowedCourseSlugs(entitlementFor("u-paid")), null);
  });

  await check("a free member may be pointed at the free course and nothing else", () => {
    assert.deepEqual(allowedCourseSlugs(entitlementFor("u-free")), ["999f28e8"]);
  });

  await check("a free member at level 9 unlocks what the LEVEL gate opens, and no paid course", () => {
    // Jake's own landing page promises exactly this ("At Level 6 — unlock 5
    // paid courses for free"), so the level half of the gate has to move.
    member("u-high", "Marc Russel", 1, 0, 9);
    const open = allowedCourseSlugs(entitlementFor("u-high")) ?? [];
    assert.deepEqual(open.sort(), ["39633a7c", "999f28e8", "ed03b880"]);
  });

  await check("a free member whose gates were never read gets an empty list, never the paid classroom", () => {
    db.prepare("DELETE FROM skool_course_gate").run();
    // [] starves the drafter of lessons. The alternative — falling back to "no
    // restriction" when the gates are missing — hands a free member the paid
    // classroom precisely when the system knows least.
    assert.deepEqual(allowedCourseSlugs(entitlementFor("u-free")), []);
    assert.equal(allowedCourseSlugs(entitlementFor("u-paid")), null);
    gate("999f28e8", "Free AI Starter Pack", 1, 1);
  });

  /* ── the nudge towards the plans page ── */

  const PLANS = "https://www.skool.com/ai-for-beginners/plans";

  await check("asksAboutUpgrading: the real question, in the ways people ask it", () => {
    assert.ok(asksAboutUpgrading("where can I upgrade?"));
    assert.ok(asksAboutUpgrading("how do I upgrade"));
    assert.ok(asksAboutUpgrading("how do i join the paid community"));
    assert.ok(asksAboutUpgrading("how much is the membership per month"));
    assert.ok(asksAboutUpgrading("what's on the paid plan"));
  });

  await check("⚠️ asksAboutUpgrading: a TOOL question is not an upgrade question", () => {
    // The commonest question in a beginners' AI community, and answering it
    // with a link to Jake's plans page is the salesman behaviour this whole
    // feature is written to avoid.
    assert.equal(asksAboutUpgrading("should I upgrade to ChatGPT Plus?"), false);
    assert.equal(asksAboutUpgrading("is it worth upgrading claude to pro"), false);
    assert.equal(asksAboutUpgrading("how much does heygen cost"), false);
    assert.equal(asksAboutUpgrading("I'm new to all this, where do I start?"), false);
  });

  await check("asksAboutUpgrading: one sentence about a tool does not silence the next", () => {
    assert.ok(asksAboutUpgrading("I upgraded ChatGPT already. Where do I upgrade here?"));
  });

  await check("plansNudgeState: a fresh conversation gets exactly one", () => {
    const first = plansNudgeState("chan-1", "how do I make a video?", "", PLANS);
    assert.equal(first.allowed, true);
    assert.equal(first.asked, false);
    assert.equal(first.seen, 0);
  });

  await check("⚠️ plansNudgeState: a link already in the THREAD counts, even if we did not send it", () => {
    // Jake answers his own DMs. A link he sent by hand an hour ago is still a
    // link this person has just been given.
    const after = plansNudgeState("chan-1", "and what about images?", `Jake: have a look at ${PLANS}`, PLANS);
    assert.equal(after.allowed, false);
    assert.match(after.why, /already come up/);
  });

  await check("plansNudgeState: a reply we already sent in this channel counts", () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO skool_reply_log
         (id, surface, target_id, post_slug, channel_id, member_id, member_name, their_text,
          state, reply_text, skip_reason, cited_json, reply_id, tokens, attempts, last_error, steps, created_at, updated_at)
       VALUES ('r1', 'dm', 't1', '', 'chan-2', 'u-free', 'Lam Tran', 'hi', 'sent', ?, '', '[]', '', 0, 0, '', '', ?, ?)`,
    ).run(`have a look at ${PLANS} when you get a minute`, now, now);
    const again = plansNudgeState("chan-2", "thanks! and how do I do images?", "", PLANS);
    assert.equal(again.allowed, false);
    assert.equal(again.seen, 1);
  });

  await check("plansNudgeState: asking outright buys a SECOND mention, and only a second", () => {
    // "You can do it twice only if the member is asking specifically for
    // 'where can I upgrade'" — the link is the answer to that question, so
    // refusing it because it came up once would be unhelpful, not restrained.
    const asked = plansNudgeState("chan-2", "ok so where can I upgrade?", "", PLANS);
    assert.equal(asked.asked, true);
    assert.equal(asked.allowed, true);

    const thrice = plansNudgeState("chan-2", "and where can I upgrade?", `Jake: ${PLANS}`, PLANS);
    assert.equal(thrice.seen, 2);
    assert.equal(thrice.allowed, false, "twice is the limit even when they keep asking");
  });

  await check("plansNudgeState: a channel it has never been mentioned in is unaffected by another", () => {
    assert.equal(plansNudgeState("chan-3", "hello", "", PLANS).allowed, true);
  });

  /* ── the conversation, not the message ── */

  const them = "Denise";
  const say = (body: string) => ({ body, byMe: false });
  const jake = (body: string) => ({ body, byMe: true });

  await check("three messages in a row are ONE question, and the history stops before them", () => {
    const { transcript, unanswered } = splitAtLastReply(
      [
        say("hey jake"),
        jake("hey! what are you building?"),
        say("i tried the make.com thing"),
        say("it errors on the webhook step"),
        say("does it work with google sheets?"),
      ],
      them,
    );
    // All three, in order — not just the last line, which is the one the
    // channel list carries and the one the agent used to answer alone.
    assert.deepEqual(unanswered, [
      "i tried the make.com thing",
      "it errors on the webhook step",
      "does it work with google sheets?",
    ]);
    // ⚠️ AND THE RUN IS NOT ALSO IN THE HISTORY. Shown twice, it invites a
    // reply that answers it twice.
    assert.equal(transcript, "Denise: hey jake\nJake: hey! what are you building?");
  });

  await check("a thread nobody has answered yet is all question and no history", () => {
    const { transcript, unanswered } = splitAtLastReply([say("hi"), say("can you help with n8n?")], them);
    assert.deepEqual(unanswered, ["hi", "can you help with n8n?"]);
    assert.equal(transcript, "");
  });

  await check("the ordinary single message still reads as one question", () => {
    const { transcript, unanswered } = splitAtLastReply(
      [say("morning"), jake("morning!"), say("which tool for thumbnails?")],
      them,
    );
    assert.deepEqual(unanswered, ["which tool for thumbnails?"]);
    assert.equal(transcript, "Denise: morning\nJake: morning!");
  });

  await check("Jake's own last word leaves nothing to answer, rather than re-answering the thread", () => {
    // Reachable: `needingReply` runs off the channel list, and the thread can
    // move between that read and this one. The caller keeps the message it
    // collected instead of drafting against an empty question.
    const { transcript, unanswered } = splitAtLastReply([say("thanks!"), jake("any time")], them);
    assert.deepEqual(unanswered, []);
    assert.equal(transcript, "Denise: thanks!\nJake: any time");
  });

  await check("an empty message is dropped from the run, and never becomes a blank question", () => {
    const { unanswered } = splitAtLastReply([jake("hi"), say("  "), say("still stuck")], them);
    assert.deepEqual(unanswered, ["still stuck"]);
  });

  await check("the history is bounded, but the run never is", () => {
    const long = [
      ...Array.from({ length: 30 }, (_, i) => (i % 2 ? jake(`a${i}`) : say(`q${i}`))),
      ...Array.from({ length: 5 }, (_, i) => say(`new${i}`)),
    ];
    const { transcript, unanswered } = splitAtLastReply(long, them, 12);
    assert.equal(unanswered.length, 5, "every unanswered message is the question");
    assert.equal(transcript.split("\n").length, 12, "the history is the last 12 lines");
    assert.ok(transcript.endsWith("Jake: a29"), "and it is the LAST 12, not the first");
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
