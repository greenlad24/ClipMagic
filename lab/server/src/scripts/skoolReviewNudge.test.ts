/**
 * Unit checks for the review nudge — the DM that asks a grateful member to
 * review the community (skool/engageReplies → showsAppreciation,
 * reviewNudgeState).
 *
 * Jake, 2026-09-20: "if a member in a DM say 'thank you for your help' or
 * showing appreciation nudge them into giving a positive review."
 *
 * ⚠️ THE ASYMMETRY IS THE DESIGN, AND THESE CASES ENCODE IT. There is ONE ask
 * per member for the life of the relationship, so:
 *   - a false positive spends it on somebody who was not thanking anyone, and
 *     there is no second chance at the person who meant it;
 *   - a miss costs nothing at all — they thank you again next time.
 * So every ambiguous case below resolves to "don't ask".
 *
 * ⚠️ AND ONE OF THESE IS A REAL BUG THIS FILE CAUGHT: the word-boundary escapes
 * in these regexes were written as literal control characters, which typechecks
 * and runs and quietly matches "thanks" inside other words.
 *
 * Throwaway DATA_DIR, so importing engageReplies (which opens the sqlite db via
 * db/index) never touches real lab data, and nothing here reaches the network,
 * the model or the browser. Run:
 *   cd lab/server && npx tsx src/scripts/skoolReviewNudge.test.ts
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

const COMMUNITY = "https://www.skool.com/ai-for-beginners";
const ABOUT = `${COMMUNITY}/about`;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-review-nudge-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const { showsAppreciation, reviewNudgeState } = await import("../skool/engageReplies.js");
  const { db } = await import("../db/index.js");

  const yes = (t: string) => assert.equal(showsAppreciation(t), true, `should read as thanks: ${t}`);
  const no = (t: string) => assert.equal(showsAppreciation(t), false, `should NOT read as thanks: ${t}`);

  await check("plain thanks is thanks", () => {
    yes("thank you for your help");
    yes("Thanks so much, this really helped.");
    yes("Cheers mate, sorted it.");
    yes("You're a legend.");
    yes("I really appreciate your time.");
  });

  await check("a word-boundary escape that is not doing its job", () => {
    // ⚠️ THE REGRESSION. With the escapes broken, the pattern matched these
    // substrings and every one of them asked a member for a review.
    no("I was unthankful about the last video");
    no("the tyre shop automation is what I want to build");
    no("my nephew's name is Ty and he uses AI");
  });

  await check("thanks with a complaint attached is not thanks", () => {
    no("thanks but it still doesn't work");
    no("thanks for nothing");
    no("no thanks, I already have that one");
    no("Thanks, unfortunately that was the wrong course.");
  });

  await check("thanks with a live question is left alone", () => {
    // Help still in progress. Asking for a favour here interrupts them, and
    // they will thank you again when it is genuinely finished.
    no("Thanks! Can you also explain how to connect it to Sheets?");
    no("thank you so much. is there a course on this?");
    no("Cheers. How do I do the same for images");
  });

  await check("nothing at all is not thanks", () => {
    no("");
    no("   \n ");
    no("I want to automate my business with AI");
  });

  const insert = (channelId: string, replyText: string, state = "sent") =>
    db
      .prepare(
        `INSERT INTO skool_reply_log (id, surface, target_id, channel_id, reply_text, state, created_at, updated_at)
         VALUES (?, 'dm', ?, ?, ?, ?, ?, ?)`,
      )
      .run(`dm:${Math.random()}`, `t${Math.random()}`, channelId, replyText, state, Date.now(), Date.now());

  await check("a grateful member who has never been asked gets the nudge", () => {
    const r = reviewNudgeState(COMMUNITY, "chan-1", "thank you for your help!", "");
    assert.equal(r.allowed, true, r.why);
    assert.equal(r.thanked, true);
    assert.equal(r.url, ABOUT);
  });

  await check("no thanks, no nudge", () => {
    const r = reviewNudgeState(COMMUNITY, "chan-1", "how do I install n8n", "");
    assert.equal(r.allowed, false);
    assert.equal(r.thanked, false);
  });

  await check("asked once is asked forever — the ledger remembers", () => {
    // ⚠️ THE WHOLE POINT OF COUNTING RATHER THAN ASKING THE PROMPT. The drafter
    // has never seen its own previous replies; without this, a member who
    // thanks you three weeks running is asked three times.
    insert("chan-2", `Glad it helped. If you have a minute: ${ABOUT} — scroll down.`);
    const r = reviewNudgeState(COMMUNITY, "chan-2", "thanks again, you're a star", "");
    assert.equal(r.allowed, false, r.why);
    assert.equal(r.seen, 1);
  });

  await check("a draft that has not gone yet still counts", () => {
    // It is about to reach them; two nudges in flight is still two nudges.
    insert("chan-3", `worth a review if you fancy: ${ABOUT}`, "drafted");
    const r = reviewNudgeState(COMMUNITY, "chan-3", "thank you!", "");
    assert.equal(r.allowed, false, r.why);
  });

  await check("Jake asking by hand counts too", () => {
    const thread = `Jake: no problem at all — if you get a minute, ${ABOUT} (scroll down)\nThem: will do`;
    const r = reviewNudgeState(COMMUNITY, "chan-4", "thanks for everything", thread);
    assert.equal(r.allowed, false, r.why);
    assert.equal(r.seen, 1);
  });

  await check("some other /about link does NOT retire the ask", () => {
    // ⚠️ A LOOSE NEEDLE WOULD HAVE. Jake's own channel link ends in /about, so
    // matching the bare string would silently stop asking anyone he had ever
    // pointed at YouTube.
    const thread = "Jake: everything I make is on https://www.youtube.com/@Jake.Dawson/about";
    const r = reviewNudgeState(COMMUNITY, "chan-5", "thanks, that's really helpful", thread);
    assert.equal(r.allowed, true, r.why);
    assert.equal(r.seen, 0);
  });

  await check("the ledger is read per channel, not globally", () => {
    // chan-2 has been asked; a different member must be unaffected.
    const r = reviewNudgeState(COMMUNITY, "chan-6", "thank you so much", "");
    assert.equal(r.allowed, true, r.why);
  });

  await check("a trailing slash on the community URL does not break the link", () => {
    const r = reviewNudgeState(`${COMMUNITY}/`, "chan-7", "thanks!", "");
    assert.equal(r.url, ABOUT);
    assert.equal(r.allowed, true);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
