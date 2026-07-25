/**
 * Unit checks for the PURE cookie-import parser (engage/cookies.parseCookies).
 * No network / no browser — covers the three input formats, domain filtering,
 * SameSite normalization, expiry coercion and de-duping.
 *
 * Run (host has no node/tsx; use the container recipe from the lab-testing memo):
 *   sed 's/\.js"/.ts"/g' on the relative specifiers, then
 *   node --experimental-strip-types src/scripts/engage-cookies.test.ts
 */
import assert from "node:assert/strict";
import { parseCookies } from "../engage/cookies.js";

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

// A Cookie-Editor-style JSON export: the real TikTok session cookie plus a
// cookie for a DIFFERENT site that must be dropped.
const COOKIE_EDITOR_JSON = JSON.stringify([
  {
    domain: ".tiktok.com",
    name: "sessionid",
    value: "abc123",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    expirationDate: 1893456000.5,
    session: false,
  },
  {
    domain: "www.tiktok.com",
    name: "tt_csrf_token",
    value: "xyz",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax",
  },
  {
    // Someone's unrelated Google cookie hiding in the same export — must go.
    domain: ".google.com",
    name: "NID",
    value: "leakme",
    path: "/",
    secure: true,
  },
]);

check("Cookie-Editor JSON: keeps only the platform's cookies", () => {
  const r = parseCookies(COOKIE_EDITOR_JSON, "tiktok");
  assert.equal(r.total, 3);
  assert.equal(r.kept, 2);
  assert.equal(r.cookies.length, 2);
  assert.deepEqual(
    r.cookies.map((c) => c.name).sort(),
    ["sessionid", "tt_csrf_token"],
  );
  assert.ok(!r.cookies.some((c) => c.name === "NID"), "cross-site cookie leaked in");
});

check("SameSite normalization + expiry rounding", () => {
  const r = parseCookies(COOKIE_EDITOR_JSON, "tiktok");
  const sess = r.cookies.find((c) => c.name === "sessionid")!;
  assert.equal(sess.sameSite, "None");
  assert.equal(sess.secure, true);
  assert.equal(sess.httpOnly, true);
  assert.equal(sess.expires, 1893456001); // 1893456000.5 rounded
  const csrf = r.cookies.find((c) => c.name === "tt_csrf_token")!;
  assert.equal(csrf.sameSite, "Lax");
  assert.equal(csrf.expires, undefined); // no expiry → session cookie
});

check("SameSite=None forces Secure even when export says insecure", () => {
  const json = JSON.stringify([
    { domain: ".tiktok.com", name: "s", value: "1", sameSite: "no_restriction", secure: false },
  ]);
  const r = parseCookies(json, "tiktok");
  assert.equal(r.cookies[0].secure, true);
});

check("Playwright storageState wrapper { cookies: [...] }", () => {
  const json = JSON.stringify({
    cookies: [
      { name: "sessionid", value: "p", domain: ".tiktok.com", path: "/", secure: true, sameSite: "None", expires: 1893456000 },
    ],
  });
  const r = parseCookies(json, "tiktok");
  assert.equal(r.kept, 1);
  assert.equal(r.cookies[0].sameSite, "None");
  assert.equal(r.cookies[0].expires, 1893456000);
});

check("Netscape cookies.txt (incl #HttpOnly_ prefix + comment lines)", () => {
  const txt = [
    "# Netscape HTTP Cookie File",
    "# a comment",
    "#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tsecretval",
    ".tiktok.com\tTRUE\t/\tTRUE\t0\ttt_csrf_token\tcsrfval",
    ".other.com\tTRUE\t/\tTRUE\t1893456000\tfoo\tbar",
  ].join("\n");
  const r = parseCookies(txt, "tiktok");
  assert.equal(r.kept, 2);
  const sess = r.cookies.find((c) => c.name === "sessionid")!;
  assert.equal(sess.value, "secretval");
  assert.equal(sess.httpOnly, true);
  assert.equal(sess.secure, true);
  assert.equal(sess.expires, 1893456000);
  const csrf = r.cookies.find((c) => c.name === "tt_csrf_token")!;
  assert.equal(csrf.expires, undefined); // expiry 0 → session cookie
});

check("raw Cookie header string defaults to the platform domain", () => {
  const r = parseCookies("sessionid=abc; tt_csrf_token=xyz", "tiktok");
  assert.equal(r.kept, 2);
  assert.ok(r.cookies.every((c) => c.domain === ".tiktok.com"));
  assert.equal(r.cookies.find((c) => c.name === "sessionid")!.value, "abc");
});

check("raw Cookie header with a leading 'Cookie:' label", () => {
  const r = parseCookies("Cookie: sessionid=abc; foo=bar", "tiktok");
  assert.equal(r.kept, 2);
  assert.equal(r.cookies[0].name, "sessionid");
});

check("Instagram accepts facebook.com cookies; Facebook rejects instagram.com", () => {
  const json = JSON.stringify([
    { domain: ".facebook.com", name: "c_user", value: "1", secure: true },
    { domain: ".instagram.com", name: "sessionid", value: "2", secure: true },
  ]);
  const ig = parseCookies(json, "instagram");
  assert.equal(ig.kept, 2); // IG login spans facebook.com
  const fb = parseCookies(json, "facebook");
  assert.equal(fb.kept, 1); // facebook does NOT accept instagram.com
  assert.equal(fb.cookies[0].name, "c_user");
});

check("de-dupes a cookie listed twice (name+domain+path)", () => {
  const json = JSON.stringify([
    { domain: ".tiktok.com", name: "sessionid", value: "first", path: "/", secure: true },
    { domain: ".tiktok.com", name: "sessionid", value: "second", path: "/", secure: true },
  ]);
  const r = parseCookies(json, "tiktok");
  assert.equal(r.kept, 1);
  assert.equal(r.cookies[0].value, "first"); // first wins
});

check("empty / whitespace / unusable input yields nothing, no throw", () => {
  assert.equal(parseCookies("", "tiktok").kept, 0);
  assert.equal(parseCookies("   \n  ", "tiktok").kept, 0);
  assert.equal(parseCookies("not json, not a cookie", "tiktok").kept, 0);
  assert.equal(parseCookies("[bad json", "tiktok").kept, 0);
});

check("entry with no name is skipped", () => {
  const json = JSON.stringify([
    { domain: ".tiktok.com", value: "orphan", secure: true },
    { domain: ".tiktok.com", name: "good", value: "1", secure: true },
  ]);
  const r = parseCookies(json, "tiktok");
  assert.equal(r.kept, 1);
  assert.equal(r.cookies[0].name, "good");
});

console.log(`\n${passed} passed`);
