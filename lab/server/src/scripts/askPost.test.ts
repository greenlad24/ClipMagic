/**
 * Unit checks for the weekly ASK post — the fourth post of the week, which asks
 * the community a question and opens by @mentioning whoever joined that week
 * (skool/engageSchedule, skool/engageGen, skool/members):
 *   - kindForSlot()          the ask day beats a pin and a video, and only on that day
 *   - getSchedule()          an ask day that is not a posting day READS as off
 *   - setSchedule()          …while writing that same combination is refused loudly
 *   - openingForMentions()   a leading "- " is a bullet, not a dash
 *   - voiceGuideBlock()      the voice guide wins on tone and NEVER on facts
 *   - the welcome ledger     records on publish, and never greets anyone twice
 *
 * ⚠️ THREE OF THESE GUARD FAILURES THAT ARE INVISIBLE FROM THE OUTSIDE. An ask
 * day that never opens, a greeting that renders as a bullet on its own line, and
 * a member welcomed for the second time all produce a post that goes out looking
 * fine — nothing errors, nothing retries, and the only witness is the community.
 *
 * Runs against a throwaway DATA_DIR, so importing these modules (which open the
 * sqlite db via db/index) never touches real lab data, and the schedule in a
 * fresh database is OFF — which is what keeps this away from the network and the
 * browser. Run:
 *   cd lab/server && npx tsx src/scripts/askPost.test.ts
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-ask-post-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const { kindForSlot, getSchedule, setSchedule } = await import("../skool/engageSchedule.js");
  const { openingForMentions, voiceGuideBlock } = await import("../skool/engageGen.js");
  const { welcomedUserIds, recordWelcomed } = await import("../skool/members.js");
  const { db } = await import("../db/index.js");

  /* ── which shape a slot is written as ── */

  await check("kindForSlot: the ask day is an ask post", () => {
    assert.equal(kindForSlot("thu", false, false, false, "thu"), "ask");
  });

  await check("kindForSlot: the ask day beats a pin and a video", () => {
    // ⚠️ THE OPPOSITE OF EVERY OTHER PRECEDENCE RULE HERE, AND DELIBERATE. Both
    // of those override the LESSON INDEX. This day is not the index's — losing
    // it to a video would skip that week's welcome permanently, because the
    // ledger only records greetings that actually went out and the members drop
    // out of the seven-day window unmet.
    assert.equal(kindForSlot("thu", true, false, false, "thu"), "ask");
    assert.equal(kindForSlot("thu", false, true, false, "thu"), "ask");
  });

  await check("kindForSlot: no ask day configured leaves every day as it was", () => {
    assert.equal(kindForSlot("thu", false, false, false, null), "lesson");
    // Tuesday's MCP post is untouched by any of this.
    assert.equal(kindForSlot("tue", false, false, true, "thu"), "mcp");
    assert.equal(kindForSlot("tue", false, false, false, "thu"), "lesson");
  });

  await check("kindForSlot: a pin and a video still win on every other day", () => {
    assert.equal(kindForSlot("tue", true, false, true, "thu"), "lesson");
    assert.equal(kindForSlot("fri", false, true, false, "thu"), "lesson");
  });

  /* ── the ask day has to be a posting day ── */

  await check("setSchedule: an ask day outside the posting days is refused", () => {
    // Writing this combination is an operator mistake and gets said out loud —
    // the day would simply never open and every slot would be a lesson.
    assert.throws(
      () => setSchedule({ days: ["sun", "tue", "fri"], askDay: "thu" }),
      /never run/,
    );
  });

  await check("setSchedule: null turns the ask post off without losing the day", () => {
    const s = setSchedule({ days: ["sun", "tue", "thu", "fri"], askDay: null });
    assert.equal(s.askDay, null);
    assert.deepEqual(s.days, ["sun", "tue", "thu", "fri"]);
  });

  await check("getSchedule: an unreachable ask day reads as off, not as configured", () => {
    // ⚠️ THE CASE setSchedule CANNOT REACH. The stored blob is merged OVER the
    // defaults, so the day this feature shipped every existing install acquired
    // askDay:"thu" from the new default while its stored days were still
    // sun/tue/fri. Nothing wrote an invalid value; the merge produced one.
    // Reporting it as configured would be a lie the screen repeats.
    db.prepare("UPDATE skool_settings SET engage_schedule_json = ? WHERE id = 1").run(
      JSON.stringify({ days: ["sun", "tue", "fri"], askDay: "thu" }),
    );
    assert.equal(getSchedule().askDay, null);
    assert.deepEqual(getSchedule().days, ["sun", "tue", "fri"]);
  });

  await check("setSchedule: the ask day comes back once its day is a posting day", () => {
    const s = setSchedule({ days: ["sun", "tue", "thu", "fri"], askDay: "thu" });
    assert.equal(s.askDay, "thu");
    assert.equal(getSchedule().askDay, "thu");
  });

  /* ── the opening line, which sits behind the mention chips ── */

  await check("openingForMentions: a leading list marker becomes an em dash", () => {
    // The very first ask draft ever written opened `- welcome in, glad you made
    // it here.` — exactly what the prompt asked for, and a BULLET once rendered,
    // which puts the greeting on its own line below the chips instead of after
    // them. The sentence keeps its opening beat rather than losing the dash.
    assert.equal(openingForMentions("- welcome in, glad you made it here.\n\nrest"),
      "— welcome in, glad you made it here.\n\nrest");
    assert.equal(openingForMentions("* welcome in"), "— welcome in");
    assert.equal(openingForMentions("+ welcome in"), "— welcome in");
  });

  await check("openingForMentions: an em dash or plain prose is left alone", () => {
    assert.equal(openingForMentions("— welcome in"), "— welcome in");
    assert.equal(openingForMentions("welcome in, glad you made it"), "welcome in, glad you made it");
  });

  await check("openingForMentions: a real list further down is untouched", () => {
    // Only the FIRST line is behind the chips. A bulleted list in the body is
    // the author's choice and rewriting it would be a different bug.
    const body = "— welcome in.\n\nThree things:\n- one\n- two\n- three";
    assert.equal(openingForMentions(body), body);
  });

  await check("openingForMentions: a hyphenated first WORD is not a marker", () => {
    // "-" only starts a list when whitespace follows it. Without this the post
    // would open on a mangled word.
    assert.equal(openingForMentions("-welcome in"), "-welcome in");
  });

  /* ── the voice guide, and what it must never be allowed to replace ── */

  await check("voiceGuideBlock: no guide stored changes nothing at all", () => {
    // An empty setting must add no text whatsoever — not a heading, not an empty
    // section. A prompt that says "THE VOICE:" and then nothing invites the
    // model to fill the gap itself.
    assert.equal(voiceGuideBlock(""), "");
    assert.equal(voiceGuideBlock("   \n  "), "");
  });

  await check("voiceGuideBlock: the guide is carried verbatim", () => {
    const guide = "# Bar-Jake\n\nShort sentences. No hype.";
    assert.ok(voiceGuideBlock(guide).includes(guide));
  });

  await check("voiceGuideBlock: it is told it outranks TONE", () => {
    // The whole point of storing it: it must beat the borrowed YouTube
    // comment-box rules on how things SOUND, which are the last word otherwise.
    const out = voiceGuideBlock("anything").toLowerCase();
    assert.ok(out.includes("outranks every other description of tone"));
    assert.ok(out.includes("capitalisation"));
  });

  await check("⚠️ voiceGuideBlock: it is told it does NOT outrank the safety rules", () => {
    // ⚠️⚠️ THE ONE THAT MATTERS. A voice guide has no opinion on inventing a
    // price or on refusing a refund question — so a guide allowed to REPLACE the
    // prompt would drop every rule that keeps this agent from hurting a member,
    // and the result would read better than ever. If this assertion is ever
    // deleted, the failure it guards is invisible in the output.
    const out = voiceGuideBlock("anything").toLowerCase();
    assert.ok(out.includes("does not outrank"));
    for (const rule of ["price", "url", "refund", "spam", "earnings"]) {
      assert.ok(out.includes(rule), `the guide block must still restate: ${rule}`);
    }
  });

  /* ── the welcome ledger ── */

  await check("the ledger: a welcomed member is not offered again", () => {
    assert.equal(welcomedUserIds().size, 0);
    recordWelcomed(
      [
        { userId: "u1", handle: "claudia-garcia-3172", firstName: "Claudia", displayName: "Claudia Garcia", joinedAt: 1 },
        { userId: "u2", handle: "denise-ferguson-7626", firstName: "Denise", displayName: "Denise Ferguson", joinedAt: 2 },
      ],
      "2026-08-27",
    );
    const ids = welcomedUserIds();
    assert.equal(ids.size, 2);
    assert.ok(ids.has("u1") && ids.has("u2"));
  });

  await check("the ledger: welcoming the same member twice is a no-op, not a crash", () => {
    // The publish path can genuinely run twice on one member — a retry after an
    // ambiguous failure. Throwing here would fail a post that had already gone
    // out, which is the worst available outcome.
    recordWelcomed(
      [{ userId: "u1", handle: "claudia-garcia-3172", firstName: "Claudia", displayName: "Claudia Garcia", joinedAt: 1 }],
      "2026-09-03",
    );
    assert.equal(welcomedUserIds().size, 2);
    // The FIRST greeting is the one kept — the row records when they were met.
    const row = db.prepare("SELECT slot_key FROM skool_welcomed_members WHERE user_id = 'u1'").get() as { slot_key: string };
    assert.equal(row.slot_key, "2026-08-27");
  });

  await check("the ledger: an empty greeting writes nothing", () => {
    recordWelcomed([], "2026-09-10");
    assert.equal(welcomedUserIds().size, 2);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
