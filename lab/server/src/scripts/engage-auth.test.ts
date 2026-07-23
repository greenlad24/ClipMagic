/**
 * Unit checks for the Google Sign-In gate primitives (auth/session +
 * auth/google.isAllowedEmail). PURE — no network.
 *
 * Env must be set BEFORE importing config, so this file sets it at the very top
 * and then dynamic-imports the modules under test.
 *
 * Run: cd lab/server && npx tsx src/scripts/engage-auth.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = "test-secret-please-change-0123456789";
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.ALLOWED_EMAILS = "jakedawsonbusiness@gmail.com, Keith.Graham244@gmail.com";
process.env.SESSION_TTL_DAYS = "7";

const { signSession, verifySession, readCookie } = await import("../auth/session.js");
const { isAllowedEmail } = await import("../auth/google.js");
const { authConfigured } = await import("../config.js");

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

check("authConfigured() true when creds + secret present", () => {
  assert.equal(authConfigured(), true);
});

check("valid session round-trips and returns the email + name", () => {
  const token = signSession("jakedawsonbusiness@gmail.com", "Jake");
  const s = verifySession(token);
  assert.ok(s);
  assert.equal(s!.email, "jakedawsonbusiness@gmail.com");
  assert.equal(s!.name, "Jake");
  assert.ok(s!.exp > Date.now());
});

check("tampered payload is rejected", () => {
  const token = signSession("jakedawsonbusiness@gmail.com");
  const [p1, sig] = token.split(".");
  // Flip a byte in the payload; signature no longer matches.
  const badP1 = p1.slice(0, -1) + (p1.endsWith("A") ? "B" : "A");
  assert.equal(verifySession(`${badP1}.${sig}`), null);
});

check("tampered signature is rejected", () => {
  const token = signSession("jakedawsonbusiness@gmail.com");
  const [p1] = token.split(".");
  assert.equal(verifySession(`${p1}.deadbeef`), null);
});

check("malformed tokens are rejected (no throw)", () => {
  assert.equal(verifySession(undefined), null);
  assert.equal(verifySession(""), null);
  assert.equal(verifySession("nodot"), null);
  assert.equal(verifySession(".onlysig"), null);
});

check("expired but correctly-signed session is rejected", () => {
  // Forge a token with the real secret but a past exp — must still be rejected.
  const past = { email: "jakedawsonbusiness@gmail.com", iat: 1, exp: Date.now() - 1000 };
  const p1 = Buffer.from(JSON.stringify(past), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(p1)
    .digest()
    .toString("base64url");
  assert.equal(verifySession(`${p1}.${sig}`), null);
});

check("isAllowedEmail matches the two operators, case-insensitively, trimmed", () => {
  assert.equal(isAllowedEmail("jakedawsonbusiness@gmail.com"), true);
  assert.equal(isAllowedEmail("JAKEDAWSONBUSINESS@GMAIL.COM"), true);
  assert.equal(isAllowedEmail("  keith.graham244@gmail.com  "), true);
  assert.equal(isAllowedEmail("keith.graham244@gmail.com"), true);
});

check("isAllowedEmail rejects everyone else", () => {
  assert.equal(isAllowedEmail("attacker@gmail.com"), false);
  assert.equal(isAllowedEmail("jakedawsonbusiness@gmail.com.evil.com"), false);
  assert.equal(isAllowedEmail(""), false);
  assert.equal(isAllowedEmail("jake@dawson.com"), false);
});

check("readCookie parses the target cookie out of a header", () => {
  assert.equal(readCookie("a=1; cm_session=abc.def; b=2", "cm_session"), "abc.def");
  assert.equal(readCookie("cm_session=xyz", "cm_session"), "xyz");
  assert.equal(readCookie("other=1", "cm_session"), undefined);
  assert.equal(readCookie(undefined, "cm_session"), undefined);
});

console.log(`\n${passed} checks passed`);
