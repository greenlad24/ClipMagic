/**
 * Unit checks for the PURE TikTok comment → InboxItem mapper
 * (engage/tiktok.parseTikTokComments). No network / no Apify token.
 *
 * Run (host has no node/tsx; use the container recipe from the lab-testing memo):
 *   sed 's/\.js"/.ts"/g' on the relative specifiers, then
 *   node --experimental-strip-types src/scripts/engage-tiktok.test.ts
 */
import assert from "node:assert/strict";
import { parseTikTokComments } from "../engage/tiktok.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

// A captured-shape Apify dataset (scrapeforge/tiktok-comments-extractor): one
// top-level comment with a nested reply, and a second bare top-level comment.
const DATASET = [
  {
    commentId: "C1",
    text: "First!",
    diggCount: 12,
    createTime: 1_753_000_000, // unix SECONDS
    videoId: "7300000000000000001",
    videoUrl: "https://www.tiktok.com/@creator/video/7300000000000000001",
    user: { nickname: "Alice", uniqueId: "alice", uid: "111" },
    replies: [
      {
        commentId: "R1",
        text: "Agreed",
        createTimeISO: "2026-07-20T11:00:00Z",
        videoId: "7300000000000000001",
        videoUrl: "https://www.tiktok.com/@creator/video/7300000000000000001",
        user: { nickname: "Bob", uniqueId: "@bob", uid: "222" },
      },
    ],
  },
  {
    commentId: "C2",
    text: "Second thread",
    createTimeISO: "2026-07-21T09:00:00Z",
    videoUrl: "https://www.tiktok.com/@creator/video/7300000000000000002",
    user: { nickname: "Carol", uniqueId: "carol" },
  },
];

check("maps top-level comments + nested replies into inbox items", () => {
  const items = parseTikTokComments(DATASET);
  assert.equal(items.length, 3, "expected 3 items (2 top-level + 1 reply)");
});

check("top-level: dedupKey=id, threadId=id, parentId=null, unix-seconds→ms", () => {
  const [top] = parseTikTokComments(DATASET);
  assert.equal(top.dedupKey, "C1");
  assert.equal(top.threadId, "C1");
  assert.equal(top.parentId, null);
  assert.equal(top.kind, "comment");
  assert.equal(top.platform, "tiktok");
  assert.equal(top.source, "api");
  assert.equal(top.channelId, ""); // stamped by the monitor
  assert.equal(top.targetRef, "7300000000000000001");
  assert.equal(top.text, "First!");
  assert.equal(top.authorName, "Alice");
  assert.equal(top.authorHandle, "@alice"); // prefixed
  assert.equal(top.authorId, "111");
  assert.equal(top.postedAt, 1_753_000_000_000); // seconds → ms
  assert.ok(top.permalink && top.permalink.includes("comment_id=C1"));
});

check("reply: threadId + parentId point at the top-level id; keeps its own dedupKey", () => {
  const reply = parseTikTokComments(DATASET).find((i) => i.dedupKey === "R1");
  assert.ok(reply, "reply present");
  assert.equal(reply!.threadId, "C1");
  assert.equal(reply!.parentId, "C1");
  assert.equal(reply!.text, "Agreed");
  assert.equal(reply!.authorHandle, "@bob"); // already prefixed → not double-prefixed
  assert.equal(reply!.postedAt, Date.parse("2026-07-20T11:00:00Z")); // ISO
});

check("parses videoId out of the url when not given; tolerates missing author id", () => {
  const carol = parseTikTokComments(DATASET).find((i) => i.dedupKey === "C2");
  assert.ok(carol);
  assert.equal(carol!.targetRef, "7300000000000000002"); // parsed from /video/{id}
  assert.equal(carol!.authorId, null);
  assert.equal(carol!.parentId, null);
});

check("skips items with no id or no text; tolerates empty / non-array input", () => {
  assert.equal(parseTikTokComments([]).length, 0);
  assert.equal(parseTikTokComments(null).length, 0);
  assert.equal(parseTikTokComments({}).length, 0);
  assert.equal(parseTikTokComments([{ text: "no id" }]).length, 0);
  assert.equal(parseTikTokComments([{ commentId: "X" }]).length, 0); // no text
  // wrapper shape { items: [...] } is also accepted
  assert.equal(parseTikTokComments({ items: [{ commentId: "Y", text: "hi" }] }).length, 1);
});

console.log(`\n${passed} checks passed`);
