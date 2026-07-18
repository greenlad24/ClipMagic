/**
 * Unit checks for the Postiz write GUARD (postiz/postizGuard). PURE — no IO.
 * Verifies: create/upload allowed; ALL edit/delete refused; the protected
 * @jake.dawson channel is refused for anything but a new post.
 *
 * Run: cd lab/server && npx tsx src/scripts/bulk-postiz-guard.test.ts
 */
import assert from "node:assert/strict";
import {
  assertPostizWriteAllowed,
  isProtectedChannel,
  PostizGuardError,
  PROTECTED_YT_IDS,
} from "../postiz/postizGuard.js";

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

const PROT_ID = "cmrq626ks0001kk6xyg215pee"; // @jake.dawson default
function blocked(fn: () => void): boolean {
  try { fn(); return false; } catch (e) { return e instanceof PostizGuardError; }
}

check("default protected set includes @jake.dawson id", () => {
  assert.ok(PROTECTED_YT_IDS.has(PROT_ID));
});

check("isProtectedChannel matches by id and by handle (with/without @)", () => {
  assert.equal(isProtectedChannel({ id: PROT_ID }), true);
  assert.equal(isProtectedChannel({ profile: "@jake.dawson" }), true);
  assert.equal(isProtectedChannel({ profile: "jake.dawson" }), true);
  assert.equal(isProtectedChannel({ profile: "JAKE.DAWSON" }), true);
  assert.equal(isProtectedChannel({ id: "cmq2vzibz0001kk6pwpcd8pgk", profile: "@jakedawsonshorts" }), false);
  assert.equal(isProtectedChannel({}), false);
});

check("allowed writes pass: GET, POST /upload, /upload-from-url, /posts", () => {
  assertPostizWriteAllowed("GET", "/integrations");
  assertPostizWriteAllowed("GET", `/analytics/${PROT_ID}`); // reads on protected channel OK
  assertPostizWriteAllowed("POST", "/upload");
  assertPostizWriteAllowed("POST", "/upload-from-url");
  assertPostizWriteAllowed("POST", "/posts", { posts: [{ integration: { id: "someChannel" } }] });
});

check("ALL edit/delete verbs are refused (any channel)", () => {
  assert.ok(blocked(() => assertPostizWriteAllowed("PUT", "/posts/abc")));
  assert.ok(blocked(() => assertPostizWriteAllowed("PATCH", "/posts/abc")));
  assert.ok(blocked(() => assertPostizWriteAllowed("DELETE", "/posts/abc")));
  // delete-by-post-id that does NOT carry the channel id → still blocked by the allowlist.
  assert.ok(blocked(() => assertPostizWriteAllowed("DELETE", "/posts/plain-post-id-123")));
});

check("unknown POST paths are refused", () => {
  assert.ok(blocked(() => assertPostizWriteAllowed("POST", "/posts/abc/publish")));
  assert.ok(blocked(() => assertPostizWriteAllowed("POST", "/integrations/disconnect")));
});

check("protected channel: create (POST /posts) is allowed even when it names the channel", () => {
  assertPostizWriteAllowed("POST", "/posts", { posts: [{ integration: { id: PROT_ID }, settings: { __type: "youtube" } }] });
});

check("protected channel: any edit/delete referencing it (id OR handle) is refused", () => {
  assert.ok(blocked(() => assertPostizWriteAllowed("DELETE", `/posts/${PROT_ID}`)));
  assert.ok(blocked(() => assertPostizWriteAllowed("PUT", "/posts/xyz", { integration: { id: PROT_ID } })));
  assert.ok(blocked(() => assertPostizWriteAllowed("PATCH", "/posts/xyz", { channel: "@jake.dawson" })));
});

check("guard errors are PostizGuardError with an actionable message", () => {
  try {
    assertPostizWriteAllowed("DELETE", "/posts/abc");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof PostizGuardError);
    assert.match((e as Error).message, /Edit\/delete|jake\.dawson/i);
  }
});

console.log(`\n${passed} checks passed`);
