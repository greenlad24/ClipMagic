// The click guard in the browser-side code (screencast/clickguard.mjs) — the same case table as
// tests/test_clickguard.py, so the two guards cannot drift apart, plus macchrome's outside profile rule.
// run (the EXISTING recorder image, nothing built or tagged):
//   docker run --rm -v <worktree>/aieditor:/a:ro --entrypoint node aieditor-screencast:0.2 /a/tests/clickguard_test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { check, matchUrl, RULES } = await import(new URL("../screencast/clickguard.mjs", import.meta.url));
let n = 0, bad = 0;
const ok = (cond, what) => { n++; if (!cond) { bad++; console.log("FAIL", what); } };

const { cases } = JSON.parse(fs.readFileSync(new URL("./fixtures/clickguard_cases.json", import.meta.url), "utf8"));
for (const c of cases) {
  const r = check(c.action, c.target, c.session);
  ok(r.ok === c.ok, `${c.why}: ${JSON.stringify(r)}`);
  if (!c.ok) ok(r.refused === c.refused, `${c.why}: refused ${r.refused} != ${c.refused}`);
}
for (const label of ["Log out", "Sign out", "Upgrade plan", "Manage subscription", "Delete chat", "Share", "Publish"])
  ok(!check({ type: "click" }, { text: label }, "logged_in").ok, `click ${label} refused`);
ok(!check({ type: "goto", url: "https://chatgpt.com/#pricing" }, null, "logged_in").ok, "#pricing logged in");
for (const label of ["Sketch", "Send", "Remove background"]) ok(check({ type: "click" }, { text: label }, "logged_in").ok, `click ${label} allowed`);
ok(check({ type: "goto", url: "https://chatgpt.com/pricing" }, null, "outside").ok, "pricing outside");
ok(!check({ type: "click" }, { text: "Log in" }, "outside").ok && !check({ type: "click" }, { text: "Buy Plus" }, "outside").ok,
   "login + buy refused outside");
ok(matchUrl("https://chatgpt.com/c/abc", RULES.deny_urls_logged_in) === null, "a chat page is fine");

// the failed job's recorded steps (redacted fixture): the logged-in goto /pricing at t 30.63 is refused
const steps = JSON.parse(fs.readFileSync(new URL("./fixtures/failed-job-seg00-agent-steps.json", import.meta.url), "utf8"));
const refused = steps.filter((s) => !check(s.action, null, "logged_in").ok);
ok(refused.length === 1 && Math.abs(refused[0].t - 30.63) < 0.01, `replay refuses only the t 30.63 pricing goto (${refused.length})`);

// macchrome: the outside view refuses a Scout profile and a profile that already holds data
process.env.AGENT_PROXY = "http://203.0.113.7:8899";
const { profileFor } = await import(new URL("../screencast/macchrome.mjs", import.meta.url));
const throws = (f) => { try { f(); return false; } catch { return true; } };
ok(throws(() => profileFor("outside", "/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data/scout/profiles/chatgpt")),
   "outside refuses a Scout profile");
const used = fs.mkdtempSync(path.join(os.tmpdir(), "used-"));
fs.writeFileSync(path.join(used, "Cookies"), "x");
ok(throws(() => profileFor("outside", used)), "outside refuses a non-empty profile");
const fresh = path.join(os.tmpdir(), `fresh-${process.pid}`);
ok(profileFor("outside", fresh) === fresh && fs.readdirSync(fresh).length === 0, "outside accepts a fresh empty dir");
ok(fs.readdirSync(profileFor("outside")).length === 0, "outside makes its own fresh dir");
ok(profileFor("any", used) === used, "a logged-in recording keeps its profile copy");

console.log(`clickguard_test: ${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
