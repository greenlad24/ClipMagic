/**
 * Unit checks for reading a post's comments (skool/comments.ts):
 *   - plainBody()        the API's text turned into what the PAGE shows
 *   - threadsOf()        a thread is flat, and belongs to its root
 *   - waiting()          who is actually waiting for an answer
 *   - answeredAfter()    the last door before a member is answered twice
 *   - replyParentOf()    where a reply will be filed, which is not the target
 *
 * ⚠️⚠️ THIS FILE IS THE FIX FOR "IT DOESN'T COMMENT ON A COMMENT" (Jake,
 * 2026-09-26) AND IT IS ALL PURE FUNCTIONS ON PURPOSE. The bug was never in the
 * browser: the reply agent could open the editor on a nested comment all along.
 * It was a one-line filter — `depth === 0 && !byMe && !answeredByMe` — deciding
 * that a member answering Jake under his own comment was not a comment at all.
 * A filter that silently returns nothing is exactly the kind of thing that
 * "works" in production for a month, so it gets tests with real threads in them.
 *
 * ⚠️ THE FIXTURES ARE MEASURED, NOT INVENTED. Every shape here was read off the
 * live community on 2026-09-26 (`/start-here`, `/introduction-2`,
 * `/which-ai-do-you-actually-open-every-day`) — including the two Jake accounts
 * that both render as "Jake Dawson", which is the reason `usIds` exists.
 *
 *   cd lab && docker build -f Dockerfile --target server -t X . &&
 *   docker run --rm -w /build/server X node dist/scripts/skoolComments.test.js
 */
import assert from "node:assert/strict";
import {
  answerable,
  answeredAfter,
  plainBody,
  replyParentOf,
  threadsOf,
  waiting,
  type SkoolComment,
} from "../skool/comments.js";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

/** The signed-in account, and Jake's other admin account. */
const ME = "86f055a8b54c4602895291fda601f43e";
const OTHER_JAKE = "dfdf64d9fe21457d81f293cc7afeead4";

let seq = 0;
function comment(over: Partial<SkoolComment> & { body: string }): SkoolComment {
  seq += 1;
  const authorId = over.authorId ?? "member-1";
  const body = over.body;
  return {
    id: over.id ?? `c${seq}`,
    parentId: over.parentId ?? null,
    depth: over.depth ?? (over.parentId ? 1 : 0),
    authorId,
    authorName: over.authorName ?? "A Member",
    authorHandle: over.authorHandle ?? "a-member",
    body,
    plain: over.plain ?? plainBody(body),
    createdAt: over.createdAt ?? `2026-09-${String(10 + seq).padStart(2, "0")}T10:00:00.000000Z`,
    byMe: over.byMe ?? authorId === ME,
    answeredByMe: over.answeredByMe ?? false,
  };
}

async function main() {
  /* ── plainBody: the API's text is not what is on the screen ── */

  await check("plainBody flattens a mention to what the page renders", () => {
    // Measured: the API returns the markup, the DOM shows "@Charles Lewis Cheers man!".
    assert.equal(
      plainBody("[@Charles Lewis](obj://user/28e49e4352ac48b2add4b3c1ecf348a7) Cheers man!"),
      "@Charles Lewis Cheers man!",
    );
    // Two of them, mid-sentence, is the welcome comment's shape.
    assert.equal(
      plainBody("[@Robert Diaz](obj://user/aecf4745) and [@Ghassen Walha](obj://user/1f2e3d) welcome!"),
      "@Robert Diaz and @Ghassen Walha welcome!",
    );
  });

  await check("plainBody keeps a link's label, which is what Skool shows", () => {
    assert.equal(
      plainBody("start here: [https://www.skool.com/x/classroom/20abb1f4](https://www.skool.com/x/classroom/20abb1f4)"),
      "start here: https://www.skool.com/x/classroom/20abb1f4",
    );
    assert.equal(plainBody("read [the lesson](https://www.skool.com/x/lesson)"), "read the lesson");
  });

  await check("plainBody leaves ordinary text, brackets and prices alone", () => {
    assert.equal(plainBody("  Claude  "), "Claude");
    assert.equal(plainBody("it costs $29 [not $49] a month"), "it costs $29 [not $49] a month");
    // An empty body stays empty rather than becoming "undefined".
    assert.equal(plainBody(""), "");
    assert.equal(plainBody(undefined as unknown as string), "");
  });

  /* ── threads are flat, and a reply belongs to its root ── */

  await check("threadsOf groups replies under their own root, never by depth alone", () => {
    const rootA = comment({ id: "A", body: "first thread" });
    const rootB = comment({ id: "B", body: "second thread" });
    const inA = comment({ id: "a1", parentId: "A", body: "under A" });
    const inB = comment({ id: "b1", parentId: "B", body: "under B" });
    const threads = threadsOf([rootA, inA, rootB, inB]);
    assert.equal(threads.length, 2);
    assert.deepEqual(threads[0].replies.map((r) => r.id), ["a1"]);
    assert.deepEqual(threads[1].replies.map((r) => r.id), ["b1"]);
  });

  await check("replyParentOf: answering a REPLY files the answer under the root", () => {
    // ⚠️ THE MEASURED SKOOL FACT. Six-message thread on /start-here, every reply
    // `parent = <the top-level comment>`. Get this wrong and a reply that landed
    // perfectly is reported as never sent.
    const root = comment({ id: "root", body: "Hi everyone!" });
    const mine = comment({ id: "mine", parentId: "root", authorId: ME, body: "Love this intro" });
    const theirs = comment({ id: "theirs", parentId: "root", body: "@Jake Dawson something so simple" });
    const all = [root, mine, theirs];
    assert.equal(replyParentOf(all, "theirs"), "root");
    assert.equal(replyParentOf(all, "root"), "root");
    // A comment that is not on this post at all answers for itself rather than throwing.
    assert.equal(replyParentOf(all, "gone"), "gone");
  });

  /* ── waiting(): the bug Jake reported, in its exact shape ── */

  await check("A MEMBER'S POST, JAKE'S COMMENT, THEIR REPLY — the reply is waiting", () => {
    // This is the report verbatim: "a post that someone else wrote, Jake wrote a
    // comment, then that person wrote a comment, then Jake never answered".
    const jake = comment({ id: "jake", authorId: ME, body: "Welcome aboard, [@Charles Lewis](obj://user/28e4) — great to have you" });
    const them = comment({ id: "them", parentId: "jake", body: "[@Jake Dawson](obj://user/86f0) Thanks! Which tool should I start with?" });
    const w = waiting([jake, them], { followUpsOnly: true });
    assert.equal(w.length, 1, "the follow-up must be offered");
    assert.equal(w[0].comment.id, "them");
    assert.equal(w[0].followUp, true);
    // And the drafter is handed the thread it is continuing, not just the line.
    assert.deepEqual(w[0].before.map((c) => c.id), ["jake"]);
    // The old filter's answer, for the record: nothing at all.
    assert.equal([jake, them].filter((c) => c.depth === 0 && !c.byMe && !c.answeredByMe).length, 0);
  });

  await check("a thread where Jake had the last word is NOT waiting", () => {
    const root = comment({ id: "root", body: "Thanks a lot Jake, this is going to be nice to learn" });
    const mine = comment({ id: "mine", parentId: "root", authorId: ME, body: "[@Charles Lewis](obj://user/28e4) Cheers man!" });
    assert.deepEqual(waiting([root, mine]), []);
    assert.deepEqual(answerable([root, mine]), []);
  });

  await check("the OTHER Jake account answering also counts as answered", () => {
    // ⚠️ BOTH ADMIN ACCOUNTS RENDER AS "Jake Dawson" and only one is signed in.
    // Without `usIds` this thread looks unanswered and the member is answered
    // twice — once per account — which is the worst possible way to fix "always
    // answer".
    const root = comment({ id: "root", body: "Hello, I'm new here and eager to learn" });
    const his = comment({ id: "his", parentId: "root", authorId: OTHER_JAKE, authorName: "Jake Dawson", body: "Welcome!" });
    assert.equal(waiting([root, his]).length, 1, "without usIds it looks unanswered");
    assert.deepEqual(waiting([root, his], { usIds: [OTHER_JAKE] }), []);
  });

  await check("a run of comments from one member is ONE target, the last one", () => {
    const mine = comment({ id: "mine", authorId: ME, body: "Here's how I'd do it" });
    const one = comment({ id: "one", parentId: "mine", createdAt: "2026-09-20T10:00:00Z", body: "I tried that" });
    const two = comment({ id: "two", parentId: "mine", createdAt: "2026-09-20T10:05:00Z", body: "here's the error I get" });
    const w = waiting([mine, one, two], { followUpsOnly: true });
    assert.equal(w.length, 1, "two replies to one thread is worse than none");
    assert.equal(w[0].comment.id, "two", "the target is the LAST thing they said");
    assert.deepEqual(w[0].run.map((c) => c.id), ["one", "two"], "but the whole run has to be answered");
  });

  await check("an untouched thread still offers its top-level comment, as it always did", () => {
    const root = comment({ id: "root", body: "Which AI do you actually open every day?" });
    const other = comment({ id: "other", parentId: "root", authorId: "member-2", body: "Claude, mostly" });
    // Nobody from here has spoken: the root is the target, and the reply lands in
    // this thread — so the other member's reply is NOT a second target.
    const w = waiting([root, other]);
    assert.deepEqual(w.map((x) => x.comment.id), ["root"]);
    assert.equal(w[0].followUp, false);
    // And under a MEMBER'S post that is out of scope entirely: continuing Jake's
    // own conversation is what was asked for, walking into someone else's is not.
    assert.deepEqual(waiting([root, other], { followUpsOnly: true }), []);
  });

  await check("our own comments and empty bodies never reach the drafter", () => {
    const mine = comment({ id: "mine", authorId: ME, body: "a post of my own opening the thread" });
    const blank = comment({ id: "blank", parentId: "mine", body: "   " });
    assert.deepEqual(waiting([mine, blank], { followUpsOnly: true }), []);
  });

  await check("waiting is newest first, because a cap cuts the list short", () => {
    const oldRoot = comment({ id: "old", createdAt: "2026-01-01T00:00:00Z", body: "an old question" });
    const newRoot = comment({ id: "new", createdAt: "2026-09-25T00:00:00Z", body: "a new question" });
    assert.deepEqual(waiting([oldRoot, newRoot]).map((w) => w.comment.id), ["new", "old"]);
  });

  /* ── answeredAfter(): the last door before a second reply ── */

  await check("answeredAfter sees the SIBLING that answered a reply", () => {
    // `answeredByMe` cannot: it asks about children, and a reply's answer is its
    // sibling. Left to that flag, every retry answers the member again.
    const root = comment({ id: "root", body: "Hi everyone!" });
    const mine = comment({ id: "mine", parentId: "root", authorId: ME, body: "Love this intro" });
    const theirs = comment({ id: "theirs", parentId: "root", body: "@Jake Dawson something so simple" });
    const answer = comment({ id: "answer", parentId: "root", authorId: ME, body: "@Terassah don't be embarrassed" });
    const all = [root, mine, theirs, answer];
    assert.equal(answeredAfter(all, "theirs")?.id, "answer");
    assert.equal(theirs.answeredByMe, false, "the flag this replaces reads false here");
    // Before the answer landed, the same call says no.
    assert.equal(answeredAfter([root, mine, theirs], "theirs"), null);
    // And nothing BEFORE the comment counts as answering it.
    assert.equal(answeredAfter([root, mine, theirs], "theirs"), null);
  });

  await check("answeredAfter counts the other Jake, and a deleted comment is not answered", () => {
    const root = comment({ id: "root", body: "a question" });
    const his = comment({ id: "his", parentId: "root", authorId: OTHER_JAKE, authorName: "Jake Dawson", body: "answered by hand" });
    assert.equal(answeredAfter([root, his], "root"), null);
    assert.equal(answeredAfter([root, his], "root", { usIds: [OTHER_JAKE] })?.id, "his");
    // A comment that has gone from the post is a different failure, and the
    // caller's "no longer on that post" check is what must report it.
    assert.equal(answeredAfter([root, his], "vanished"), null);
  });

  console.log(`\n${passed} passed`);
}

void main();
