"""Click guard (architecture recommendation §3.7): the hard rules live in the code that clicks.
Offline: the shared case table, a replay of the failed job's recorded steps, and static checks that
every recorder calls the guard and that no action vocabulary has a log-out action."""
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import clickguard  # noqa: E402

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


# (1) the shared table (tests/clickguard_test.mjs runs the same cases through clickguard.mjs)
cases = json.loads((ROOT / "tests" / "fixtures" / "clickguard_cases.json").read_text())["cases"]
for c in cases:
    r = clickguard.check(c["action"], c["target"], c["session"])
    check(r["ok"] == c["ok"], f"{c['why']}: {r}")
    if not c["ok"]:
        check(r.get("refused") == c["refused"], f"{c['why']}: refused {r.get('refused')} != {c['refused']}")
check(len(cases) >= 30, "case table is substantial")

# the acceptance list, spelled out
deny = lambda a, t=None, s="logged_in": not clickguard.check(a, t, s)["ok"]   # noqa: E731
for label in ("Log out", "Sign out", "Upgrade plan", "Manage subscription", "Delete chat", "Share", "Publish"):
    check(deny({"type": "click"}, {"text": label}), f"click '{label}' is refused")
check(deny({"type": "goto", "url": "https://chatgpt.com/#pricing"}), "goto chatgpt.com/#pricing logged in")
for label in ("Sketch", "Send", "Remove background"):
    check(not deny({"type": "click"}, {"text": label}), f"click '{label}' is allowed")
check(not deny({"type": "goto", "url": "https://chatgpt.com/pricing"}, None, "outside"), "pricing in the outside view")
check(deny({"type": "click"}, {"text": "Log in"}, "outside"), "login refused outside")
check(deny({"type": "click"}, {"text": "Buy"}, "outside"), "buy refused outside")

# (2) replay a SCRATCH COPY of the failed job's seg-00 steps: the logged-in goto /pricing at t 30.63
JOB = Path("/opt/aieditor-work/jobs/factory-end-to-end-test-mac-rec-10082332-63de/edit-01/seg-00/rec/agent-steps.json")
src = JOB if JOB.exists() else ROOT / "tests" / "fixtures" / "failed-job-seg00-agent-steps.json"
with tempfile.TemporaryDirectory() as td:
    scratch = Path(td) / "agent-steps.json"
    shutil.copyfile(src, scratch)                       # the stored job is read only
    steps = json.loads(scratch.read_text())
refused = clickguard.replay(steps, "logged_in")
check(len(refused) == 1, f"exactly the pricing goto is refused: {refused}")
check(abs(refused[0]["t"] - 30.63) < 0.01 and refused[0]["refused"] == "deny:/pricing",
      f"refused at t 30.63: {refused[0]}")
check(refused[0]["action"]["url"].endswith("/pricing"), "it is the /pricing goto")
check(clickguard.replay(steps, "outside") == [], "the same steps are fine in an outside view (no login/buy there)")

# (3) static: every recorder calls the guard; no log-out action exists in any vocabulary
SC = ROOT / "screencast"
ar = (SC / "agent_rec.mjs").read_text()
check("from \"./clickguard.mjs\"" in ar and re.search(r"async function act\(a\) \{\n\s+const g = await guard\(a\)", ar),
      "agent_rec.mjs act() asks the guard first")
check(re.search(r'm\.cmd === "open"\) \{ const g = await guard\(', ar), "agent_rec open is guarded")
check(re.search(r'm\.cmd === "reload"\) \{ const g = await guard\(', ar), "agent_rec reload is guarded")
for f in ("vrecord.mjs", "record.mjs"):
    src_f = (SC / f).read_text()
    check("from \"./clickguard.mjs\"" in src_f and src_f.count("guard(") >= 3, f"{f} guards goto/click/type")
VOCAB = re.compile(r"log[\s_-]?out|sign[\s_-]?out", re.I)
case_types = re.findall(r'case "([^"]+)"', ar)
check(case_types and not [c for c in case_types if VOCAB.search(c)], "agent_rec.mjs has no log-out action type")
check(not re.search(r'type\s*===\s*"(log|sign)[_-]?out"', ar), "no log-out type test in agent_rec.mjs")
for f in ("vrecord.mjs", "record.mjs"):
    keys = set(re.findall(r"\bs\.([a-zA-Z_]+)", (SC / f).read_text()))
    check(keys and not [k for k in keys if VOCAB.search(k)], f"{f}: no log-out step key ({sorted(keys)[:6]}…)")
for schema in ROOT.glob(".claude/skills/*/schemas/playbook.schema.json"):
    check(not VOCAB.search(schema.read_text()), f"{schema.name}: no log-out action")
rules = clickguard.rules()
check(set(rules["deny_labels"]) >= {"delete", "remove", "buy", "purchase", "upgrade", "subscribe", "checkout", "pay",
                                    "publish", "share", "invite", "billing", "manage subscription", "cancel plan",
                                    "add account", "log out", "sign out"}, "deny list as specified")
check(set(rules["deny_urls_logged_in"]) >= {"/pricing", "#pricing", "/billing", "/settings/billing", "/account/billing",
                                            "/checkout", "/upgrade", "/logout", "/signout", "/auth/logout"},
      "logged-in URL deny list as specified")
# the Python and JS guards read the SAME rules file
check(clickguard.RULES_PATH == SC / "clickguard.rules.json", "one rules file")
check('new URL("./clickguard.rules.json", import.meta.url)' in (SC / "clickguard.mjs").read_text(), "JS reads it too")
print(f"test_clickguard: {n} checks passed")
