/**
 * The read-only guarantee.
 *
 * The Channel Audit connects to a real YouTube channel. It must never be able
 * to change anything on it — not a title, not a description, not a thumbnail.
 * The renames it produces are text on a page for a person to act on, and that
 * is the entire extent of its involvement.
 *
 * These tests exist so that stops being a promise and becomes something that
 * fails a build. They are deliberately blunt: if someone adds an upload scope
 * or points the channel token at a mutating endpoint, one of these breaks.
 *
 *   node --experimental-strip-types src/scripts/audit-readonly.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { YT_ANALYTICS_SCOPE, assertReadOnlyScope, ScopeViolationError } from "../audit/analytics.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log("  ok ", name);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log("FAIL ", name);
    console.log("      " + String((err as Error).message).split("\n").join("\n      "));
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");

/**
 * Source with comments stripped.
 *
 * The scans below look for calls, not mentions. Without this, the comment in
 * analytics.ts explaining *why* `videos.update` is blocked trips the very test
 * that checks it is blocked — which would push someone toward deleting the
 * explanation to make the build pass.
 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// ── the scope we ask for ────────────────────────────────────────────────────

check("the requested scope is the read-only analytics one", () => {
  assert.equal(YT_ANALYTICS_SCOPE, "https://www.googleapis.com/auth/yt-analytics.readonly");
  assert.ok(YT_ANALYTICS_SCOPE.endsWith(".readonly"), "must be a readonly scope");
});

check("a grant carrying a write scope is refused", () => {
  // The scopes that would let this tool change a channel. None may ever be
  // accepted, however they arrive.
  const dangerous = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtubepartner",
  ];
  for (const scope of dangerous) {
    assert.throws(
      () => assertReadOnlyScope(`${YT_ANALYTICS_SCOPE} ${scope}`),
      ScopeViolationError,
      `${scope} must be refused`,
    );
  }
});

check("even a read scope we did not ask for is refused", () => {
  // Not because reading more is catastrophic, but because a grant that does not
  // match what we requested means something is wrong, and the safe response to
  // "something is wrong" is to store nothing.
  assert.throws(
    () => assertReadOnlyScope(`${YT_ANALYTICS_SCOPE} https://www.googleapis.com/auth/youtube.readonly`),
    ScopeViolationError,
  );
});

check("exactly the requested scope is accepted", () => {
  assert.doesNotThrow(() => assertReadOnlyScope(YT_ANALYTICS_SCOPE));
  assert.doesNotThrow(() => assertReadOnlyScope(`  ${YT_ANALYTICS_SCOPE}  `));
});

check("an absent scope field does not throw", () => {
  // Google omits `scope` on some refresh responses. That means "unchanged",
  // not "none" — throwing would break a perfectly good connection.
  assert.doesNotThrow(() => assertReadOnlyScope(undefined));
  assert.doesNotThrow(() => assertReadOnlyScope(""));
});

// ── what the code is allowed to do with the token ───────────────────────────

check("the channel token is only ever sent to the analytics reports endpoint", () => {
  const src = read("audit/analytics.ts");
  const allowed = src.match(/const ALLOWED_ENDPOINTS = \[([^\]]*)\]/s);
  assert.ok(allowed, "the endpoint allow-list must exist");
  const list = allowed![1];
  assert.ok(list.includes("youtubeanalytics.googleapis.com/v2/reports"), "reports endpoint present");
  // One entry. Anything else needs a deliberate change and a new test.
  assert.equal((list.match(/https:/g) || []).length, 1, "exactly one allowed endpoint");
});

check("no module in audit/ writes to the YouTube Data API", () => {
  // The Data API's mutating endpoints. None may appear anywhere in the tool.
  const forbidden = [
    "youtube/v3/videos?part", // update
    "videos.update",
    "thumbnails/set",
    "playlists?part",
    "youtube/v3/channels?part=brandingSettings",
  ];
  for (const file of ["audit/analytics.ts", "audit/oauthRoutes.ts", "audit/ingest.ts", "audit/run.ts", "audit/discover.ts"]) {
    const src = code(file);
    for (const f of forbidden) {
      assert.ok(!src.includes(f), `${file} must not reference ${f}`);
    }
  }
});

check("the only non-GET requests are to Google's token endpoint", () => {
  // A POST anywhere else in this tool would be a request that changes
  // something. The token exchange is the sole legitimate one.
  for (const file of ["audit/analytics.ts", "audit/oauthRoutes.ts", "audit/ingest.ts", "audit/run.ts", "audit/discover.ts", "audit/images.ts"]) {
    const src = code(file);
    const posts = src.split("\n").filter((l) => /method:\s*["']?(POST|PUT|PATCH|DELETE)/i.test(l));
    if (!posts.length) continue;
    // Every one of them must sit in a function that talks to oauth2/token.
    assert.ok(
      src.includes("https://oauth2.googleapis.com/token"),
      `${file} has a mutating request but no token endpoint — check what it is calling`,
    );
    assert.ok(posts.length <= 1, `${file} should have at most the token POST, found ${posts.length}`);
  }
});

check("the renames are proposals, never applied", () => {
  // The tool proposes titles. If it ever gained the ability to apply them, this
  // is where that would show up first.
  const run = code("audit/run.ts");
  for (const bad of ["videos.update", "applyRename", "pushTitle", "updateVideoTitle"]) {
    assert.ok(!run.includes(bad), `run.ts must not ${bad}`);
  }
});

console.log(`\n${passed} checks passed.`);
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
