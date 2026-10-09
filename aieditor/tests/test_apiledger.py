"""Claude API ledger + caps (llm.py / apiledger.py), the droplet key and the account lock (cloud.py,
accountlock.py). A fake transport: nothing is sent anywhere; WORK and .env are scratch folders."""
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="p1-ledger-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")                  # never the live /opt/aieditor-work
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")                    # never the live .env
for k in ("AIEDITOR_API_LEDGER", "AIEDITOR_API_JOB_CAP_USD", "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD",
          "AIEDITOR_API_PRIOR_JOB_USD", "AIEDITOR_API_PRIOR_AT", "ANTHROPIC_API_KEY", "AIEDITOR_DROPLET_ANTHROPIC_KEY"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import accountlock, agentrec, apiledger, cloud, config, director, llm, recorder, takes  # noqa: E402

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


check(str(config.API_LEDGER).startswith(str(TMP)), "the test ledger is a scratch file")
sent = []


def fake(body, stream, timeout):
    sent.append(body)
    return {"content": [{"type": "text", "text": '{"ok": true}'}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 2000,
                      "cache_creation_input_tokens": 0}}


llm.TRANSPORT = fake
lines = lambda: apiledger.rows()   # noqa: E731

# settings: the daily API cap is $30 (Jake decision 1, 2026-10-09)
s = cloud.settings()
check(s["api_daily_cap_usd"] == 30 and s["api_daily_cap_pending_jake"] is False, f"daily cap 30, decided: {s}")
check(s["api_job_cap_usd"] == {"creative": 8, "cut": 1}, "per-job caps creative 8 / cut 1")
check(s["require_droplet_key"] is False and s["us_route"]["enabled"] is False, "droplet key + US route defaults")
check(json.loads(cloud.CFG.read_text())["api_daily_cap_usd"] == 30, "written to the settings file")
check(apiledger.caps("creative") == (8.0, 30.0) and apiledger.caps("cut") == (1.0, 30.0), "caps by workflow")

# one ledger line per call, priced from the table
llm.set_context(job="job-a", workflow="creative", stage="graphics")
r = llm.messages("claude-opus-5-5", "sys", "hello", 1000, effort="low", purpose="unit")
check(r["text"] == '{"ok": true}' and len(sent) == 1, "the call went through the transport")
want = (1000 * 4 + 500 * 20 + 2000 * 0.2) / 1e6
check(abs(r["usd"] - want) < 1e-9, f"priced {r['usd']} == {want}")
L = lines()
check(len(L) == 1 and {"ts", "job", "stage", "model", "in", "out", "cache_read", "cache_write", "usd", "ok"} <= set(L[0]),
      f"one ledger line with every field: {L}")
check(L[0]["job"] == "job-a" and L[0]["stage"] == "graphics" and L[0]["ok"] is True and L[0]["cache_read"] == 2000, "fields")
sent.clear()
takes.call_claude("prompt", "system")
director.call([{"type": "text", "text": "x"}], "system")
# p7: the only agent near the recorder is the capped OFF-CAMERA beat repair (one turn here)
_pb = {"app": "x", "actions": {"a": {"kind": "click", "label": "A", "selectors": ["#a"], "proven": True}}}
_sc = {"steps": [{"type": "click", "selector": "#a", "beat_id": "b0", "at": 1.0}], "beats": []}
recorder.repair_beat(None, _pb, _sc, {"id": "b0", "steps": [0], "action": "a", "word": "w"}, "failed",
                     recorder.RepairBudget(), turns=1)
check(len(sent) == 3 and len(lines()) == 4, "takes / director / beat repair each: one call, one ledger line")
check(sent[0].get("stream") is True and sent[0]["output_config"]["effort"] == "high", "takes: streamed, high effort")
check("thinking" not in sent[2] and sent[2]["output_config"]["effort"] == "medium", "beat repair: medium effort, no thinking")
check({x["purpose"] for x in lines()[1:]} == {"Claude (high effort)", "Claude director (high effort)",
                                             "beat repair b0 (off camera)"}, "purposes named")


# a failed call still gets its ledger line (ok false), retried codes are retried
def boom(body, stream, timeout):
    sent.append(body)
    raise urllib.error.HTTPError("u", 400, "bad", {}, None)


llm.TRANSPORT = boom
try:
    llm.messages("claude-opus-5-5", "s", "x", 100, purpose="fails")
    check(False, "a 400 raises")
except urllib.error.HTTPError:
    pass
check(lines()[-1]["ok"] is False and lines()[-1]["usd"] == 0, "the failed call has its line (ok false)")
llm.TRANSPORT = fake

# the per-job cap: a call that would pass it is refused BEFORE it is sent
apiledger.record({"ts": time.time(), "job": "job-cut", "stage": "takes", "model": "claude-opus-5-5", "usd": 0.97})
llm.set_context(job="job-cut", workflow="cut", stage="takes")
sent.clear()
before = len(lines())
try:
    llm.messages("claude-opus-5-5", "s", "x" * 20000, 4000, purpose="over the job cap")
    check(False, "refused")
except apiledger.BudgetExceeded as e:
    check(e.which == "job" and e.reason == "API cap", f"job cap: {e}")
check(not sent and len(lines()) == before, "nothing sent, nothing billed")
check(llm.refusals() and "API cap" in llm.refusals()[0], "the refusal is sticky for the worker")
llm.clear_context()
check(not llm.refusals(), "a new job starts clean")
llm.messages("claude-opus-5-5", "s", "x", 100, job="job-cut-2", workflow="cut", purpose="small")
check(len(sent) == 1, "another job is not affected")

# the rolling 24 h window over a fixture ledger
fx = TMP / "fixture.jsonl"
now = time.time()
for ts, usd in ((now - 100, 5.0), (now - 3600, 7.0), (now - 86400 + 60, 1.5), (now - 90000, 100.0), (now - 200000, 50.0)):
    apiledger.record({"ts": ts, "job": "x", "usd": usd}, fx)
check(abs(apiledger.daily_total(now, fx) - 13.5) < 1e-9, f"rolling 24 h = 13.5: {apiledger.daily_total(now, fx)}")
os.environ["AIEDITOR_API_LEDGER"] = str(fx)
check(not apiledger.over_daily_cap(now), "13.5 < 30")
apiledger.record({"ts": now - 50, "job": "y", "usd": 16.6}, fx)
check(apiledger.over_daily_cap(now), "30.1 ≥ 30: the worker queues new jobs")
try:
    llm.messages("claude-haiku-4-5", "s", "x", 100, job="z", workflow="creative", purpose="daily")
    check(False, "daily cap refuses")
except apiledger.BudgetExceeded as e:
    check(e.which == "daily", "daily cap")
os.environ.pop("AIEDITOR_API_LEDGER")

# a factory server: the caps + what was spent come with the job, its own ledger merges back
os.environ.update({"AIEDITOR_API_LEDGER": str(TMP / "job" / "api-ledger.jsonl"), "AIEDITOR_API_JOB_CAP_USD": "8",
                   "AIEDITOR_API_DAILY_CAP_USD": "30", "AIEDITOR_API_PRIOR_24H_USD": "29.0",
                   "AIEDITOR_API_PRIOR_JOB_USD": "1.0", "AIEDITOR_API_PRIOR_AT": str(int(now))})
check(abs(apiledger.daily_total() - 29.0) < 1e-9 and apiledger.job_total("remote") == 1.0, "prior spend counts")
llm.messages("claude-sonnet-5-5", "s", "x", 100, job="remote", workflow="creative", purpose="on the droplet")
try:
    llm.messages("claude-opus-5-5", "s", "x" * 1000000, 8000, job="remote", workflow="creative", purpose="too much")
    check(False, "the droplet keeps the daily cap")
except apiledger.BudgetExceeded:
    pass
for k in ("AIEDITOR_API_LEDGER", "AIEDITOR_API_JOB_CAP_USD", "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD",
          "AIEDITOR_API_PRIOR_JOB_USD", "AIEDITOR_API_PRIOR_AT"):
    os.environ.pop(k)
main_before = len(lines())
check(apiledger.merge(TMP / "job" / "api-ledger.jsonl") == 1 and len(lines()) == main_before + 1, "merged back")
check(apiledger.merge(TMP / "job" / "api-ledger.jsonl") == 0, "merge is idempotent (line ids)")

# no model call while a screencast is being recorded (agentrec.Session.recording)
sess = agentrec.Session.__new__(agentrec.Session)
sess._recording = False
sess.recording = True
sent.clear()
try:
    llm.messages("claude-opus-5-5", "s", "x", 10, job="j", purpose="on camera")
    check(False, "refused while recording")
except llm.OnCameraCall:
    pass
check(not sent, "nothing sent on camera")
sess.recording = False
check(not llm.recording(), "recording cleared")

# static: api.anthropic.com is spoken only by llm.py
hits = []
for f in list((ROOT / "aieditor").glob("*.py")) + list((ROOT / "bin").glob("*")) + list((ROOT / "screencast").glob("*.*")):
    if f.is_file() and "api.anthropic.com" in f.read_text(errors="replace"):
        hits.append(f.relative_to(ROOT).as_posix())
check(hits == ["aieditor/llm.py"], f"api.anthropic.com only in llm.py: {hits}")
for f in ("takes.py", "director.py", "recorder.py"):
    check("llm.messages" in (ROOT / "aieditor" / f).read_text(), f"{f} calls through llm.py")
check("llm.messages(" not in (ROOT / "aieditor" / "agentrec.py").read_text(), "agentrec.py makes no model call (no on-camera agent)")
check("llm.API_HOST" in (ROOT / "bin" / "aieditor-factory").read_text(), "the factory smoke check reads llm.py's host")

# ── the droplet key (cloud.droplet_env) ──
cloud.SECRETS = TMP / "lab-secrets.json"     # never the live Lab secrets (Jake's real droplet key is there now)
(TMP / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-ORG-secret-0001\nGROQ_API_KEY=gsk-groq-secret-0002\n")
logs = []
env = cloud.droplet_env(logs.append, {"require_droplet_key": False})
check("ANTHROPIC_API_KEY=sk-ant-ORG-secret-0001" in env and any("WARNING" in m for m in logs),
      "no droplet key yet: warning + the org key")
check(not any(re.search(r"sk-ant|gsk-", m) for m in logs), "no key material in the log")
try:
    cloud.droplet_env(logs.append, {"require_droplet_key": True})
    check(False, "refused")
except cloud.DOError as e:
    check("sk-ant" not in str(e), "a refusal names no key")
with open(TMP / ".env", "a") as f:
    f.write("AIEDITOR_DROPLET_ANTHROPIC_KEY=sk-ant-DROPLET-secret-0003\n")
logs.clear()
env = cloud.droplet_env(logs.append, {"require_droplet_key": True})
check("ANTHROPIC_API_KEY=sk-ant-DROPLET-secret-0003" in env and "ORG" not in env, "the droplet key ships as ANTHROPIC_API_KEY")
check("GROQ_API_KEY=gsk-groq-secret-0002" in env and "AIEDITOR_DROPLET" not in env, "groq still ships; the key name does not")
check(logs and not any(re.search(r"sk-ant|gsk-|secret", m) for m in logs), f"no key material in the log: {logs}")
check("AIEDITOR_API_LEDGER" in cloud.api_env("job-x", "creative") and
      cloud.api_env("job-x", "creative")["AIEDITOR_API_JOB_CAP_USD"] == "8.0000", "the droplet gets its caps")
src = (ROOT / "aieditor" / "cloud.py").read_text()
check("env = droplet_env(log, s)" in src and "SHIP_KEYS if config.env_key(k))" not in src, "run_remote ships via droplet_env")
check('"--exclude", "api-ledger.jsonl"' in src and "merge_ledger(job_dir, log)" in src, "ledger pushed out clean, merged back")

# ── one job per logged-in account ──
a = accountlock.AccountLock(["chatgpt"], "job-1")
b = accountlock.AccountLock(["chatgpt", "linearity"], "job-2")
check(a.acquire(log=lambda m: None) is True, "first job locks chatgpt")
check(accountlock.busy("chatgpt") and accountlock.holder("chatgpt")["job"] == "job-1", "busy, held by job-1")
check(b.acquire() is False and not b.fds, "the second job for the same account reports busy (and holds nothing)")
check(not accountlock.busy("linearity"), "all-or-nothing: linearity was not kept")
check(b.acquire(wait=True, timeout=0.2, poll=0.05, log=lambda m: None) is False, "waiting times out while busy")
a.release()
check(not accountlock.busy("chatgpt") and b.acquire(log=lambda m: None) is True, "released → the waiting job gets it")
b.release()
check(accountlock.AccountLock([], "j").acquire(), "a job with no logged-in site needs no lock")
wk = (ROOT / "bin" / "aieditor-worker").read_text()
check("apiledger.over_daily_cap()" in wk and "accountlock.busy(slug)" in wk, "the worker queues on the API cap and a busy account")

# ── the worker: BudgetExceeded inside a job ends it held ("API cap"); a swallowed refusal too ──
import importlib.machinery  # noqa: E402
import importlib.util  # noqa: E402
loader = importlib.machinery.SourceFileLoader("aieditor_worker_p1", str(ROOT / "bin" / "aieditor-worker"))
spec = importlib.util.spec_from_loader("aieditor_worker_p1", loader)
W = importlib.util.module_from_spec(spec)
loader.exec_module(W)
for mode in ("raised", "swallowed"):
    jd = config.JOBS / f"held-{mode}"
    jd.mkdir(parents=True)
    (jd / "request.json").write_text(json.dumps({"id": jd.name, "format": "long", "workflow": "creative"}))
    job = W.Job(jd)

    def run_job(job, action, mode=mode):
        job.stage("graphics", "running")
        try:
            llm.messages("claude-opus-5-5", "s", "x", 100, purpose="x")
        except apiledger.BudgetExceeded:
            if mode == "raised":
                raise
    W.run_job = run_job
    os.environ.update({"AIEDITOR_API_DAILY_CAP_USD": "0.0000001", "AIEDITOR_API_JOB_CAP_USD": "8"})
    W.execute(job, "run")
    for k in ("AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_JOB_CAP_USD"):
        os.environ.pop(k)
    st = json.loads((jd / "status.json").read_text())
    check(st.get("held") is True and st["held_reasons"][0]["reason"] == "API cap" and st["message"].startswith("Held"),
          f"{mode}: the job ends held, reason API cap: {st.get('message')}")
    check(st["stages"]["graphics"]["state"] == "failed", f"{mode}: the running stage is closed")
    check(llm.context()["job"] is None and not llm.refusals(), f"{mode}: the context is cleared after the job")
print(f"test_apiledger: {n} checks passed")
