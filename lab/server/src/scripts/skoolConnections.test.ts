/**
 * Unit checks for the INTRODUCTION layer (skool/connections):
 *   - introSentenceOk()   the sentence may say "talk to them" and nothing else
 *   - placeIntro()        pulled out, checked, put last — or dropped
 *   - candidatesFor()     every exclusion, because a missed one is a member
 *                         pointed at somebody they should never have been
 *
 * ⚠️⚠️ WHAT THESE GUARD IS A PRIVATE DM REPEATED IN PUBLIC. Jake, 2026-09-19:
 * "it should never tell what another person told me. Just say 'you should talk
 * with about it...'". The drafter is never shown the other person, so the
 * remaining way to leak is the sentence DESCRIBING them anyway ("who built
 * this", "she's been there") — and every such sentence reads warmly and
 * naturally, which is why it is refused on its words rather than judged.
 *
 * Runs against a throwaway DATA_DIR — no browser, no network, no model. Run:
 *   cd lab && docker build -f Dockerfile --target server -t X . &&
 *   docker run --rm -w /build/server X node dist/scripts/skoolConnections.test.js
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-skool-connect-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const { introSentenceOk, placeIntro, renderIntro, candidatesFor, recordIntroduction, setNoIntro, CONNECT_TOKEN } =
    await import("../skool/connections.js");
  const { flagMember } = await import("../skool/safety.js");
  const { db } = await import("../db/index.js");

  const ASK = "How do I get my Airtable base to trigger the Make.com scenario when a new lead comes in?";

  /* ── the sentence ── */

  await check("the plain pointer passes", () => {
    assert.equal(introSentenceOk(`You should talk with ${CONNECT_TOKEN} about it.`, ASK), null);
  });

  await check("the asker's own words for their thing pass", () => {
    assert.equal(introSentenceOk(`Worth talking with ${CONNECT_TOKEN} about the Airtable trigger side.`, ASK), null);
  });

  for (const leak of [
    `You should talk with ${CONNECT_TOKEN}, who built exactly this last month.`,
    `${CONNECT_TOKEN} has done this for real-estate agents, worth a chat.`,
    `You should talk with ${CONNECT_TOKEN} — she's been through the same thing.`,
    `Talk with ${CONNECT_TOKEN} about it, they mentioned something similar.`,
    `You should talk with ${CONNECT_TOKEN} about it, they're a pro at this.`,
    `You should talk with ${CONNECT_TOKEN} about it, he runs an agency doing exactly that.`,
  ]) {
    await check(`a sentence that describes them is refused: "${leak.slice(0, 50)}…"`, () => {
      assert.ok(introSentenceOk(leak, ASK), "must be refused");
    });
  }

  await check("a word that is not the asker's is refused — it could only have come from somewhere else", () => {
    // "dentists" appears nowhere in what they wrote.
    const why = introSentenceOk(`You should talk with ${CONNECT_TOKEN} about selling to dentists.`, ASK);
    assert.ok(why && /not the member's own/.test(why), String(why));
  });

  await check("two people, or none, is refused", () => {
    assert.ok(introSentenceOk(`Talk with ${CONNECT_TOKEN} and ${CONNECT_TOKEN} about it.`, ASK));
    assert.ok(introSentenceOk("You should talk with Sarah about it.", ASK));
  });

  /* ── placing it ── */

  await check("the introduction is moved to the end, and the body keeps its lines", () => {
    const draft = [
      "Here's the fix.",
      "",
      `1. Add a Watch Records trigger. You should talk with ${CONNECT_TOKEN} about it.`,
      "2. Map the lead fields.",
    ].join("\n");
    const placed = placeIntro(draft, ASK);
    assert.equal(placed.sentence, `You should talk with ${CONNECT_TOKEN} about it.`);
    assert.ok(!placed.body.includes(CONNECT_TOKEN));
    assert.ok(placed.body.includes("\n2. Map the lead fields."), placed.body);
    const out = renderIntro(placed.body, placed.sentence!, "@Jason Davies");
    assert.ok(out.endsWith("\n\nYou should talk with @Jason Davies about it."), out);
  });

  await check("a refused introduction is DROPPED, and the answer survives without it", () => {
    const draft = `Use a webhook instead of polling.\n\nYou should talk with ${CONNECT_TOKEN}, who built this.`;
    const placed = placeIntro(draft, ASK);
    assert.equal(placed.sentence, null);
    assert.ok(placed.dropped);
    assert.equal(placed.body, "Use a webhook instead of polling.");
  });

  await check("no token, nothing touched", () => {
    const placed = placeIntro("Just an answer.\n\n1. One\n2. Two", ASK);
    assert.equal(placed.body, "Just an answer.\n\n1. One\n2. Two");
    assert.equal(placed.sentence, null);
    assert.equal(placed.dropped, "");
  });

  /* ── who may be introduced ── */

  const now = Date.now();
  const member = (id: string, name: string, handle: string, role = "member") =>
    db
      .prepare(
        `INSERT INTO skool_member_access (user_id, handle, display_name, tier, paid, level, plan, renews_at, role, read_at)
         VALUES (?, ?, ?, 1, 0, 1, '', 0, ?, ?)`,
      )
      .run(id, handle, name, role, now);
  const profile = (id: string, name: string, topics: [string, "demonstrated" | "claimed"][], status = "ok") =>
    db
      .prepare(
        `INSERT INTO skool_member_profiles (member_id, member_name, channel_id, last_message_id, status, experience_json, read_at)
         VALUES (?, ?, 'ch', 'm', ?, ?, ?)`,
      )
      .run(id, name, status, JSON.stringify(topics.map(([topic, strength]) => ({ topic, strength }))), now);

  member("asker", "Asker Person", "asker-person-1111");
  member("ann", "Ann Expert", "ann-expert-2222");
  profile("ann", "Ann Expert", [["connecting Airtable to Make.com for lead intake", "demonstrated"]]);

  await check("a member whose demonstrated experience shares a specific term is a candidate", () => {
    const c = candidatesFor({ id: "asker", text: ASK });
    assert.deepEqual(c.map((x) => x.member.userId), ["ann"]);
    assert.equal(c[0].member.handle, "ann-expert-2222");
    assert.ok(c[0].shared.includes("airtable"));
  });

  await check("generic overlap alone is not a match", () => {
    assert.deepEqual(candidatesFor({ id: "asker", text: "How do I start an automation business with AI tools?" }), []);
  });

  await check("never the asker themselves", () => {
    assert.deepEqual(candidatesFor({ id: "ann", text: ASK }), []);
  });

  member("claimer", "Claims Things", "claims-things-3333");
  profile("claimer", "Claims Things", [["Airtable Make.com lead automations", "claimed"]]);
  await check("claimed experience is never matched — only demonstrated", () => {
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "claimer"));
  });

  member("jake2", "Jake Dawson", "jake-dawson-9790", "group-admin");
  profile("jake2", "Jake Dawson", [["Airtable and Make.com lead intake", "demonstrated"]]);
  await check("an admin (either Jake account) is never introduced", () => {
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "jake2"));
  });

  profile("gone", "Left Community", [["Airtable to Make.com lead routing", "demonstrated"]]);
  await check("somebody not in the members list (left, banned, unknown) is never introduced", () => {
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "gone"));
  });

  member("kid", "Young Member", "young-member-4444");
  profile("kid", "Young Member", [["Airtable Make.com lead forms", "demonstrated"]]);
  flagMember({ memberId: "kid", memberName: "Young Member", flag: "minor", reason: "test" });
  await check("a flagged member (a minor above all) is never introduced", () => {
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "kid"));
  });

  member("private", "Opted Out", "opted-out-5555");
  profile("private", "Opted Out", [["Airtable Make.com lead capture", "demonstrated"]]);
  setNoIntro("private", true);
  await check("a member Jake opted out is never introduced", () => {
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "private"));
  });

  await check("never the same two people twice, in either direction", () => {
    recordIntroduction({
      replyId: "post:1", surface: "post", askerId: "ann", askerName: "Ann Expert",
      introducedId: "asker", introducedName: "Asker Person", why: "test",
    });
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "ann"));
  });

  member("busy", "Busy Expert", "busy-expert-6666");
  profile("busy", "Busy Expert", [["Airtable Make.com lead pipelines", "demonstrated"]]);
  await check("one member is not pointed at more than twice in 14 days", () => {
    assert.ok(candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "busy"));
    for (const n of [1, 2]) {
      recordIntroduction({
        replyId: `dm:${n}`, surface: "dm", askerId: `other${n}`, askerName: "x",
        introducedId: "busy", introducedName: "Busy Expert", why: "test",
      });
    }
    assert.ok(!candidatesFor({ id: "asker", text: ASK }).some((c) => c.member.userId === "busy"));
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
