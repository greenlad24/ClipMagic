/**
 * Unit checks for the YouTube Shorts-only gate (postiz/youtubeGate). PURE — no
 * IO, no AI — so it runs under node --experimental-strip-types.
 *
 * Run: cd lab/server && npx tsx src/scripts/bulk-youtube-gate.test.ts
 */
import assert from "node:assert/strict";
import { isYouTubePost, youtubeShortsGate } from "../postiz/youtubeGate.js";

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

const yt = { identifier: "youtube" };

check("isYouTubePost: only Postiz-routed youtube counts", () => {
  assert.equal(isYouTubePost({ identifier: "youtube" }), true);
  assert.equal(isYouTubePost({ identifier: "YouTube" }), true); // case-insensitive
  assert.equal(isYouTubePost({ identifier: "youtube", provider: "postiz" }), true);
  assert.equal(isYouTubePost({ identifier: "youtube", provider: "postpeer" }), false);
  assert.equal(isYouTubePost({ identifier: "tiktok" }), false);
  assert.equal(isYouTubePost({ identifier: "instagram" }), false);
});

check("confirmed vertical → allowed (no block)", () => {
  assert.equal(youtubeShortsGate(yt, true), null);
});

check("measured non-vertical → blocked with a required check", () => {
  const block = youtubeShortsGate(yt, false);
  assert.ok(block, "expected a block");
  assert.equal(block!.check.id, "youtube-shorts-vertical");
  assert.equal(block!.check.severity, "required");
  assert.equal(block!.check.pass, false);
  assert.match(block!.error, /not vertical/);
});

check("unverifiable (null) → ALLOWED (fail-open: never block on unknown aspect)", () => {
  assert.equal(youtubeShortsGate(yt, null), null);
});

check("override:true bypasses the gate even when non-vertical", () => {
  assert.equal(youtubeShortsGate({ identifier: "youtube", override: true }, false), null);
  assert.equal(youtubeShortsGate({ identifier: "youtube", override: true }, null), null);
});

check("non-YouTube posts are never gated, regardless of aspect", () => {
  for (const identifier of ["tiktok", "instagram", "facebook", ""]) {
    assert.equal(youtubeShortsGate({ identifier }, false), null, `${identifier} must not be gated`);
    assert.equal(youtubeShortsGate({ identifier }, null), null, `${identifier} must not be gated`);
  }
  // PostPeer-routed youtube (TikTok path never carries youtube, but be safe):
  assert.equal(youtubeShortsGate({ identifier: "youtube", provider: "postpeer" }, false), null);
});

console.log(`\n${passed} checks passed`);
