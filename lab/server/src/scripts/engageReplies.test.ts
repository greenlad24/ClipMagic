/**
 * Unit checks for the reply agent (skool/engageReplies):
 *   - the fresh-database migration   the settings columns exist on a NEW db
 *   - getReplyConfig()               a database that has never been configured is OFF
 *   - setReplyConfig()               clamps, and persists across a reopen
 *   - the ledger                     keyed on the MESSAGE, and one row per message
 *   - runReplySweep()                refuses, and SAYS WHY, without touching the browser
 *   - sendDraftedReply()             only a draft can be sent
 *   - forgetReply()                  the one way out of "engaged with, in any state"
 *
 * ⚠️⚠️ EVERY ASSERTION HERE IS ABOUT SOMETHING THAT WRITES TO A REAL PERSON. The
 * poster's failures were public and correctable; this agent answers a named
 * member and, on the DM surface, does it in a private inbox that Skool sends on
 * Enter. So the tests worth having are the ones that prove it declines: off is
 * off, a cap is a cap, and a message that has been engaged with is never offered
 * twice.
 *
 * ⚠️ IT MUST STAY OFFLINE, AND THAT IS A PROPERTY OF THE CODE, NOT THE TEST.
 * `runReplySweep` checks the kill switch, the surfaces, the cadence and the
 * daily cap BEFORE it reads anything — so every path exercised here returns
 * without launching Chromium. If a future edit moves a browser read above those
 * guards, this file will hang rather than pass, which is the right alarm.
 *
 *   cd lab && docker build -f Dockerfile --target server -t X . &&
 *   docker run --rm -w /build/server X node dist/scripts/engageReplies.test.js
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-engage-replies-"));
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const mod = await import("../skool/engageReplies.js");
  const { db } = await import("../db/index.js");
  const {
    getReplyConfig, setReplyConfig, replyAgentStatus, runReplySweep,
    sendDraftedReply, forgetReply, listReplies, getReply,
  } = mod;

  /* ── the migration, on a database that has never existed ── */

  await check("the reply columns exist on a FRESH database, not just a migrated one", () => {
    // ⚠️ THIS IS THE `engage_schedule_json` BUG, PRE-EMPTED. The ALTER blocks in
    // db/index.ts run BEFORE the CREATE TABLE, so on a new database
    // PRAGMA table_info returns nothing, the migration correctly declines, and
    // the CREATE is the only thing that can supply the column. Listing a new
    // column in only one of the two places is invisible on every live database
    // and fatal on every fresh one.
    const cols = (db.prepare("PRAGMA table_info(skool_settings)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("engage_replies_json"), `engage_replies_json missing from ${cols.join(", ")}`);
    assert.ok(cols.includes("engage_replies_tick_json"), "engage_replies_tick_json missing");
    // And the ledger itself.
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skool_reply_log'").get();
    assert.ok(t, "skool_reply_log was not created");
  });

  /* ── off is off ── */

  await check("a database that has never been configured is OFF and DRY-RUN", () => {
    const c = getReplyConfig();
    // Both, and separately: `enabled` off means nothing is read; `dryRun` on
    // means nothing is sent even once it is. Arming is two deliberate acts.
    assert.equal(c.enabled, false);
    assert.equal(c.dryRun, true);
  });

  await check("an unparseable settings blob still reads as OFF", () => {
    // A corrupt blob must not fall through to "the defaults", because the
    // defaults of everything else here are permissive.
    db.prepare("UPDATE skool_settings SET engage_replies_json = 'not json' WHERE id = 1").run();
    assert.equal(getReplyConfig().enabled, false);
    assert.equal(getReplyConfig().dryRun, true);
  });

  await check("setReplyConfig clamps the caps rather than trusting the caller", () => {
    const c = setReplyConfig({ maxPerSweep: 999, maxPerDay: 0, everyMinutes: 1, maxAgeDays: 100000, postsToScan: 900 });
    assert.equal(c.maxPerSweep, 20);
    assert.equal(c.maxPerDay, 1);
    // A one-minute cadence against one shared browser would starve the poster.
    assert.equal(c.everyMinutes, 5);
    assert.equal(c.maxAgeDays, 365);
    assert.equal(c.postsToScan, 25);
  });

  /* ── the sweep refuses, and says why ── */

  await check("a switched-off agent refuses and NAMES the switch", async () => {
    setReplyConfig({ enabled: false });
    const r = await runReplySweep("https://www.skool.com/whatever");
    assert.equal(r.ran, false);
    assert.match(String(r.skipped), /switched off/i);
    // Nothing was read: a silent no-op and a refusal must not look alike.
    assert.equal(r.scanned.posts, 0);
  });

  await check("on, but with neither surface armed, is its own refusal", async () => {
    setReplyConfig({ enabled: true, comments: false, dms: false });
    const r = await runReplySweep("https://www.skool.com/whatever");
    assert.equal(r.ran, false);
    assert.match(String(r.skipped), /neither comments nor DMs/i);
  });

  await check("the daily cap refuses BEFORE any reading, and counts only what was sent", async () => {
    setReplyConfig({ enabled: true, comments: true, dms: true, maxPerDay: 2 });
    const now = Date.now();
    const add = (id: string, state: string, at: number) =>
      db.prepare(
        `INSERT INTO skool_reply_log (id, surface, target_id, state, created_at, updated_at)
         VALUES (?, 'comment', ?, ?, ?, ?)`,
      ).run(id, id, state, at, at);
    add("comment:a", "sent", now);
    add("comment:b", "sent", now);
    // Neither of these is a reply anyone received, so neither may count.
    add("comment:c", "skipped", now);
    add("comment:d", "failed", now);
    add("comment:e", "sent", now - 48 * 3600_000); // yesterday's yesterday
    const r = await runReplySweep("https://www.skool.com/whatever");
    assert.equal(r.ran, false);
    assert.match(String(r.skipped), /Daily cap reached \(2 of 2/);
  });

  await check("the cadence throttles a sweep, and `force` overrides it — but not the cap", async () => {
    // The previous check wrote a heartbeat, so an unforced sweep is now early.
    setReplyConfig({ everyMinutes: 60 });
    const soon = await runReplySweep("https://www.skool.com/whatever");
    assert.match(String(soon.skipped), /next in \d+ min/);
    // Forced, it gets past the cadence and straight into the cap — which is the
    // point: "Sweep now" must not be a way around a cap.
    const forced = await runReplySweep("https://www.skool.com/whatever", { force: true });
    assert.match(String(forced.skipped), /Daily cap reached/);
  });

  /* ── the ledger ── */

  await check("the ledger is keyed on the MESSAGE, so a thread can be answered twice", () => {
    // ⚠️ THE KEY IS `<surface>:<their last message id>`. Keying on the channel
    // would mean a member who asks a second question is never answered again;
    // keying on the member would mean once, ever.
    const now = Date.now();
    db.prepare(
      `INSERT INTO skool_reply_log (id, surface, target_id, channel_id, member_name, state, created_at, updated_at)
       VALUES ('dm:msg-1', 'dm', 'msg-1', 'chan-1', 'Jason', 'sent', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO skool_reply_log (id, surface, target_id, channel_id, member_name, state, created_at, updated_at)
       VALUES ('dm:msg-2', 'dm', 'msg-2', 'chan-1', 'Jason', 'drafted', ?, ?)`,
    ).run(now, now);
    const rows = listReplies(50).filter((r) => r.channelId === "chan-1");
    assert.equal(rows.length, 2, "the same thread must be able to hold two answered messages");
    // And the same message cannot be recorded twice: the id is the primary key.
    assert.throws(() =>
      db.prepare(
        `INSERT INTO skool_reply_log (id, surface, target_id, state, created_at, updated_at)
         VALUES ('dm:msg-1', 'dm', 'msg-1', 'drafted', 0, 0)`,
      ).run(),
    );
  });

  await check("only a DRAFT can be sent", async () => {
    const sent = await sendDraftedReply("https://www.skool.com/whatever", "dm:msg-1");
    assert.equal(sent.ok, false);
    assert.match(sent.detail, /"sent", not a draft/);
    const missing = await sendDraftedReply("https://www.skool.com/whatever", "dm:nope");
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /No reply with id/);
    // A draft with no text is refused too — reaching the browser to type
    // nothing is worse than saying so here.
    assert.equal(getReply("dm:msg-2")?.replyText, "");
    const empty = await sendDraftedReply("https://www.skool.com/whatever", "dm:msg-2");
    assert.equal(empty.ok, false);
    assert.match(empty.detail, /no text to send/);
  });

  await check("forget releases a message, and is not an unsend", () => {
    assert.equal(forgetReply("dm:msg-2"), true);
    assert.equal(getReply("dm:msg-2"), null);
    // The sent one is still on the record — forgetting it would not unsend it,
    // it would only let the agent write to that person about it again.
    assert.ok(getReply("dm:msg-1"));
    assert.equal(forgetReply("dm:nothing-here"), false);
  });

  await check("status counts by STATE, because two of them need a person", () => {
    const s = replyAgentStatus();
    // 'unconfirmed' and 'failed' are the ones a total would hide.
    assert.equal(s.counts.failed, 1);
    assert.equal(s.counts.skipped, 1);
    assert.ok(s.counts.sent >= 3);
    assert.equal(s.config.enabled, true);
    assert.ok(s.health.lastSweepAt, "a sweep that refused still leaves a heartbeat");
  });

  /* ── what web search leaves behind ── */

  await check("stripSearchMarkup removes citation tags and keeps the sentence", async () => {
    const { stripSearchMarkup } = await import("../skool/engageGen.js");
    // ⚠️ THE REAL LINE FROM THE FIRST SEARCH-BACKED DRAFT. It would have been
    // posted to a member exactly like this: the JSON parsed, the length was
    // right, the links were real, and nothing else in the pipeline looks at
    // prose.
    const real =
      'look at <cite index="3-0">Synthesia — it turns text into video content with AI avatars</cite>. ' +
      '<cite index="1-0">HeyGen is the other big one</cite>, so good if you want your own face.';
    const out = stripSearchMarkup(real);
    assert.ok(!out.includes("<cite"), out);
    assert.ok(!out.includes("</cite>"), out);
    // The inner text is the sentence, not decoration — it must survive.
    assert.match(out, /Synthesia — it turns text into video content with AI avatars/);
    assert.match(out, /HeyGen is the other big one/);
    // And the strip must not leave a space sitting before the full stop.
    assert.ok(!/ \./.test(out), out);
  });

  await check("stripSearchMarkup leaves a markdown link and a real bracket alone", async () => {
    const { stripSearchMarkup } = await import("../skool/engageGen.js");
    // A bare [1] is a reference marker; [label](url) is a link, and eating its
    // label would silently mangle the one thing members click.
    assert.equal(stripSearchMarkup("see [the docs](https://x.dev) [1]"), "see [the docs](https://x.dev)");
    assert.equal(stripSearchMarkup("costs $29 [2, 3] a month"), "costs $29 a month");
    // Nothing to strip must come back unchanged, trimmed.
    assert.equal(stripSearchMarkup("Hey Jason, this one's clean"), "Hey Jason, this one's clean");
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
