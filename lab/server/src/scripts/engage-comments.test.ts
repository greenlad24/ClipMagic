/**
 * Unit checks for the PURE YouTube comment → InboxItem mapper
 * (engage/youtube.parseCommentThreads) + the recent-uploads parser
 * (parseRecentVideos). No network / no key.
 *
 * Run (host has no node/tsx; use the container recipe from the lab-testing memo):
 *   sed 's/\.js"/.ts"/g' on the relative specifiers, then
 *   node --experimental-strip-types src/scripts/engage-comments.test.ts
 */
import assert from "node:assert/strict";
import { parseCommentThreads, parseRecentVideos } from "../engage/youtube.js";

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

// A captured-shape commentThreads.list response: one thread with the top-level
// comment + one reply, and a second thread with just a top-level comment.
const THREADS = {
  items: [
    {
      snippet: {
        topLevelComment: {
          id: "TOP1",
          snippet: {
            textDisplay: "Great video!",
            authorDisplayName: "Alice",
            authorChannelId: { value: "UC_alice" },
            publishedAt: "2026-07-20T10:00:00Z",
          },
        },
      },
      replies: {
        comments: [
          {
            id: "REPLY1",
            snippet: {
              textDisplay: "Agreed",
              authorDisplayName: "Bob",
              authorChannelId: { value: "UC_bob" },
              publishedAt: "2026-07-20T11:00:00Z",
            },
          },
        ],
      },
    },
    {
      snippet: {
        topLevelComment: {
          id: "TOP2",
          snippet: {
            textDisplay: "Second thread",
            authorDisplayName: "Carol",
            publishedAt: "2026-07-21T09:00:00Z",
          },
        },
      },
    },
  ],
};

check("maps top-level comments + replies into inbox items", () => {
  const items = parseCommentThreads(THREADS, "VID123", "My Video", "chanA");
  assert.equal(items.length, 3, "expected 3 items (2 top-level + 1 reply)");
});

check("top-level comment: dedupKey=id, threadId=id, parentId=null", () => {
  const [top] = parseCommentThreads(THREADS, "VID123", "My Video", "chanA");
  assert.equal(top.dedupKey, "TOP1");
  assert.equal(top.threadId, "TOP1");
  assert.equal(top.parentId, null);
  assert.equal(top.kind, "comment");
  assert.equal(top.platform, "youtube");
  assert.equal(top.source, "api");
  assert.equal(top.channelId, "chanA");
  assert.equal(top.targetRef, "VID123");
  assert.equal(top.targetTitle, "My Video");
  assert.equal(top.text, "Great video!");
  assert.equal(top.authorName, "Alice");
  assert.equal(top.authorId, "UC_alice");
  assert.equal(top.postedAt, Date.parse("2026-07-20T10:00:00Z"));
  assert.equal(top.permalink, "https://www.youtube.com/watch?v=VID123&lc=TOP1");
});

check("reply: parentId points at the thread's top-level id", () => {
  const reply = parseCommentThreads(THREADS, "VID123", "My Video", "chanA").find((i) => i.dedupKey === "REPLY1");
  assert.ok(reply, "reply present");
  assert.equal(reply!.threadId, "TOP1");
  assert.equal(reply!.parentId, "TOP1");
  assert.equal(reply!.text, "Agreed");
});

check("tolerates missing publishedAt (postedAt=null) + missing authorChannelId", () => {
  const carol = parseCommentThreads(THREADS, "VID123", "My Video", "chanA").find((i) => i.dedupKey === "TOP2");
  assert.ok(carol);
  assert.equal(carol!.authorId, null);
  assert.equal(typeof carol!.postedAt, "number"); // Carol HAS a date
  // A thread with no publishedAt → null
  const noDate = parseCommentThreads(
    { items: [{ snippet: { topLevelComment: { id: "X", snippet: { textDisplay: "hi" } } } }] },
    "V",
    "T",
    "c",
  );
  assert.equal(noDate[0].postedAt, null);
});

check("empty / malformed responses yield no items", () => {
  assert.equal(parseCommentThreads({}, "V", "T", "c").length, 0);
  assert.equal(parseCommentThreads({ items: [{}] }, "V", "T", "c").length, 0);
  assert.equal(parseCommentThreads({ items: [{ snippet: {} }] }, "V", "T", "c").length, 0);
});

check("parseRecentVideos reads contentDetails.videoId + publishedAt", () => {
  const vids = parseRecentVideos({
    items: [
      { contentDetails: { videoId: "v1", videoPublishedAt: "2026-01-01T00:00:00Z" }, snippet: { title: "One" } },
      { contentDetails: { videoId: "v2" }, snippet: { title: "Two", publishedAt: "2026-02-01T00:00:00Z" } },
      { snippet: { resourceId: { videoId: "v3" }, title: "Three" } },
      { snippet: { title: "no id — dropped" } },
    ],
  });
  assert.equal(vids.length, 3);
  assert.equal(vids[0].videoId, "v1");
  assert.equal(vids[0].title, "One");
  assert.equal(vids[0].publishedAt, "2026-01-01T00:00:00Z");
  assert.equal(vids[1].publishedAt, "2026-02-01T00:00:00Z"); // falls back to snippet.publishedAt
  assert.equal(vids[2].videoId, "v3"); // falls back to resourceId.videoId
});

console.log(`\n${passed} checks passed`);
