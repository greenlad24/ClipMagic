"""LIVE UPDATE (aieditor/liveupdate.py): new code reaches a running factory job at a safe boundary, no restart.
Fakes only — no droplet, no ssh: the "droplet" is a local directory, ssh is a local bash, rsync is the local rsync, the
re-exec is a fake os.execve that hands the new environment to an in-process "new worker" (the REAL bin/aieditor-worker
once() / execute(), with a fake run_job that records what ran and what was generated).

  1. a red test suite → nothing is pushed (logged once); a green one → pushed; once a minute at most
  2. the switch is atomic: while the tree is being copied nothing names it; afterwards code-version + current name it;
     old trees are pruned except the running one
  3. boundary(): only when enabled + attached, never inside a unit, never while recording, never when cancelled
  4. resume continuity: after the re-exec the completed stages / pictures are not redone
  5. a broken new tree → import check fails → rolled back, rejected, the old code carries on (one check only)
  6. cancel across an update (during the unwind, right after the exec, at the boundary)
  7. no duplicate generation: an update that arrives while a picture is being generated waits for it

Run: python3 tests/test_liveupdate.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="liveupdate-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
os.environ["AIEDITOR_API_LEDGER"] = str(TMP / "api.jsonl")
os.environ["AIEDITOR_PROVEN_LIB"] = str(TMP / "proven.jsonl")
for k in ("AIEDITOR_GEN_LEDGER", "AIEDITOR_GEN_PRIOR", "ANTHROPIC_API_KEY", "AIEDITOR_FACTORY_SERVER",
          "AIEDITOR_LIVE_UPDATE", "AIEDITOR_LIVE_ROOT", "AIEDITOR_CODE_VERSION", "AIEDITOR_LIVE_RUN",
          "AIEDITOR_LIVE_RESUMED"):
    os.environ.pop(k, None)
(TMP / "work" / "jobs").mkdir(parents=True)
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import config, llm, liveupdate as LU, onboard  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def fake_tree(path, worker="print('worker')\n", extra=None, test_rc=0):
    """A minimal code tree: aieditor/ package, bin/aieditor-worker, tests/test_a.py exiting test_rc."""
    path = Path(path)
    (path / "aieditor").mkdir(parents=True, exist_ok=True)
    (path / "bin").mkdir(exist_ok=True)
    (path / "tests").mkdir(exist_ok=True)
    (path / "aieditor" / "__init__.py").write_text("")
    (path / "aieditor" / "mod.py").write_text("X = 1\n")
    (path / "bin" / "aieditor-worker").write_text(worker)
    (path / "tests" / "test_a.py").write_text(f"import sys\nsys.exit({test_rc})\n")
    for rel, txt in (extra or {}).items():
        (path / rel).parent.mkdir(parents=True, exist_ok=True)
        (path / rel).write_text(txt)
    return path


def wait_tests(key, timeout=60):
    t0 = time.time()
    while LU.test_status(key) == "running" and time.time() - t0 < timeout:
        time.sleep(0.1)
    return LU.test_status(key)


# ── a local "droplet": ssh = bash here, rsync = local rsync (the remote prefix stripped) ──
SSH_LOG, RSYNC_HOOK = [], []


def fake_ssh(ip, cmd, timeout=600, check=True, input=None):
    SSH_LOG.append(cmd)
    r = subprocess.run(["bash", "-c", cmd], input=input, capture_output=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.decode())
    return r.stdout.decode()


def fake_rsync(src, dst, *extra, timeout=7200):
    dst = dst.split(":", 1)[1] if dst.startswith("root@") else dst
    r = subprocess.run(["rsync", "-a", *extra, src, dst], capture_output=True)
    for h in RSYNC_HOOK:
        h(dst)
    if r.returncode not in (0, 24):
        raise RuntimeError(r.stderr.decode())


# ═══ 1. red tests → no push; green → pushed; throttled ═══
code = fake_tree(TMP / "code", test_rc=1)
pushed, logs = [], []
_real_push = LU.push
LU.push = lambda ip, snap, v, droplet_root=None: pushed.append(v) or "switched"
now = [1000.0]
p = LU.Pusher("10.0.0.9", TMP / "work" / "jobs" / "j1", logs.append, sent="dispatched", clock=lambda: now[0], code=code)
check(p.tick() is None, "nothing in the first minute after the dispatch")
now[0] += 61
check(p.tick() == "testing", "a new version → its tests start (background)")
v1, key1 = LU.versions(code)
check(wait_tests(key1) == "red", "the fake suite is red")
check(p.tick() is None, "throttled: at most once a minute")
now[0] += 61
check(p.tick() == "red" and not pushed, f"red tests → NOT pushed: {pushed}")
check(any("NOT sent" in m and "tests are red" in m for m in logs), f"the red suite is logged: {logs}")
now[0] += 61
p.tick()
check(sum("NOT sent" in m for m in logs) == 1, "logged once per version, not every minute")
check(LU.test_reason(key1).endswith("tests/test_a.py"), f"the failing test is named: {LU.test_reason(key1)!r}")
# the fix: tests green → pushed (the cached result per tree hash is reused, never run twice)
(code / "tests" / "test_a.py").write_text("import sys\nsys.exit(0)\n")
(code / "aieditor" / "mod.py").write_text("X = 2\n")
now[0] += 61
check(p.tick() == "testing", "the fixed tree is a new version → tested")
v2, key2 = LU.versions(code)
check(v2 != v1 and wait_tests(key2) == "green", "green")
now[0] += 61
check(p.tick() == "pushing", "green → pushing")
p.wait(10)
check(pushed == [v2] and p.sent == v2, f"pushed exactly the green version: {pushed}")
now[0] += 61
check(p.tick() == "current", "nothing more to send")
# a test-only change is no new code version (the droplet never gets tests): no push, no re-exec
(code / "tests" / "test_b.py").write_text("pass\n")
check(LU.versions(code)[0] == v2 and LU.versions(code)[1] != key2, "tests change the test key, not the version")
now[0] += 61
check(p.tick() == "current" and pushed == [v2], "a test-only change is not pushed")
# never raises into the poll loop
_rv = LU.versions
LU.versions = lambda code=None: (_ for _ in ()).throw(OSError("disk gone"))
now[0] += 61
check(p.tick() is None and any("disk gone" in m for m in logs), "an error is logged, never raised")
LU.versions = _rv
LU.push = _real_push

# ═══ 2. the atomic switch on a (local) droplet ═══
R = TMP / "droplet-live"
from aieditor import cloud  # noqa: E402
cloud.ssh, cloud.rsync = fake_ssh, fake_rsync
init = fake_tree(TMP / "droplet-code")                     # the tree the dispatch sent (config.CODE on the droplet)
(R).mkdir()
(R / "code-version").write_text(json.dumps({"version": "v0", "tree": str(init)}))
(R / "running").write_text(f"{init}\nv0\n1\n")
os.environ[LU.ENV_ROOT] = str(R)
os.environ[LU.ENV_VERSION] = "v0"
seen = []


def during_copy(dst):
    # the tree is being copied: code-version still names the old tree, the new one exists only as .partial
    seen.append({"named": json.loads((R / "code-version").read_text())["version"], "pending": LU.pending(),
                 "final_exists": (R / "trees" / v2).exists(), "partial": dst.rstrip("/").endswith(".partial")})


RSYNC_HOOK.append(during_copy)
snap = LU.snapshot(code)
check(snap and snap[0] == v2, "snapshot of the tested tree")
res = LU.push("local", snap[2], v2, droplet_root=R)
RSYNC_HOOK.clear()
check(res == "switched", f"switched: {res}")
check(seen and seen[0] == {"named": "v0", "pending": None, "final_exists": False, "partial": True},
      f"mid-copy nothing names the new tree (never imported half-copied): {seen}")
doc = json.loads((R / "code-version").read_text())
check(doc["version"] == v2 and doc["tree"] == str(R / "trees" / v2), f"code-version names it now: {doc}")
check(os.readlink(R / "current") == str(R / "trees" / v2), "current → the new tree")
check(not (R / "trees" / f"{v2}.partial").exists() and (R / "trees" / v2 / "bin" / "aieditor-worker").exists(),
      "renamed whole")
check(not (R / "trees" / v2 / "tests").exists(), "the droplet never gets the tests")
check(not (R / "code-version.tmp").exists(), "no temp file left")
check(LU.pending() and LU.pending()["version"] == v2, "the worker now sees the newer version")
# idempotent: the same version again copies nothing
n_ssh = len(SSH_LOG)
check(LU.push("local", snap[2], v2, droplet_root=R) == "switched", "a second push of the same version is a no-op switch")
# pruning: 5 more versions — the newest KEEP_TREES stay, plus the tree the worker runs
(R / "running").write_text(f"{R / 'trees' / v2}\n{v2}\n1\n")
made = []
for n in range(5):
    (code / "aieditor" / "mod.py").write_text(f"X = {10 + n}\n")
    vv, kk, sd = LU.snapshot(code)
    made.append(vv)
    time.sleep(0.02)
    check(LU.push("local", sd, vv, droplet_root=R) == "switched", "switched")
left = sorted(p_.name for p_ in (R / "trees").iterdir())
check(set(left) == set(made[-LU.KEEP_TREES:]) | {v2}, f"kept the newest {LU.KEEP_TREES} + the running tree: {left}")
# a version the server rejected is never switched to again
(R / "rejected").mkdir(exist_ok=True)
(R / "rejected" / made[-1]).write_text("{}")
check(LU.push("local", sd, made[-1], droplet_root=R) == "rejected", "a rejected version is refused by the switch")

# ═══ 3. boundary(): only at a boundary ═══
job = TMP / "work" / "jobs" / "b1"
job.mkdir()
good = fake_tree(TMP / "good-tree")
(R / "code-version").write_text(json.dumps({"version": "vG", "tree": str(good)}))
os.environ[LU.ENV_VERSION] = "v0"
canc = [False]
LU.attach(job, cancelled=lambda: canc[0], log=lambda m: None, save=lambda **k: None)
ok = lambda t: (True, "")                                      # noqa: E731
check(LU.boundary("x", check=ok) is False, "not enabled (no AIEDITOR_LIVE_UPDATE) → never")
os.environ[LU.ENV_ON] = "1"
with LU.unit("picture p1"):
    check(LU.boundary("inside a picture", check=ok) is False, "inside a unit → never")
llm.set_recording("sess", True)
check(LU.boundary("recording", check=ok) is False, "frames being captured → never")
llm.set_recording("sess", False)
canc[0] = True
check(LU.boundary("cancelled", check=ok) is False, "cancelled → the cancel path, not an update")
canc[0] = False
try:
    LU.boundary("between pictures", stage="preprod", check=ok)
    check(False, "a safe boundary with a newer version → Restart")
except LU.Restart as r:
    check(r.doc["version"] == "vG" and r.where == "between pictures" and r.stage == "preprod", "Restart carries it")
check(isinstance(LU.Restart({}, "w"), BaseException) and not isinstance(LU.Restart({}, "w"), Exception),
      "Restart is a BaseException: no `except Exception` in a stage swallows it")
os.environ[LU.ENV_VERSION] = "vG"
check(LU.boundary("same", check=ok) is False, "already on that version → nothing")
LU.detach()
check(LU.boundary("detached", check=ok) is False, "no job attached (the box) → never")

# ═══ 4-7. the REAL worker once()/execute() with a fake run_job ═══
loader = importlib.machinery.SourceFileLoader("aieditor_worker_t", str(ROOT / "bin" / "aieditor-worker"))
spec = importlib.util.spec_from_loader("aieditor_worker_t", loader)
W = importlib.util.module_from_spec(spec)
loader.exec_module(W)

GEN = []                     # every generation that really started (the app's generation ledger, in effect)
HOOKS = {}                   # aid → callable run DURING its generation (a push arriving mid-generation)
FAIL = set()


class Ctx:
    def __init__(self, out):
        self.out = out

    def log(self, m):
        with open(self.out.parent / "log.txt", "a") as f:
            f.write("ctx: " + m + "\n")


def fake_produce_asset(ctx, aid, desc, *a, **kw):
    side = ctx.out / "assets" / f"{aid}.produced.json"
    if side.exists():                                         # the real reuse (produced.json): no generation
        return json.loads(side.read_text())
    GEN.append(aid)
    if aid in HOOKS:
        HOOKS.pop(aid)()
    if aid in FAIL:
        return {"id": aid, "status": "needs_asset", "why": "every try missed"}
    row = {"id": aid, "status": "ready", "file": str(ctx.out / "assets" / f"{aid}.png")}
    side.parent.mkdir(parents=True, exist_ok=True)
    side.write_text(json.dumps(row))
    return row


onboard.produce_asset = fake_produce_asset
PICTURES = ["p1", "p2", "p3", "p4"]


def fake_run_job(job, action):
    """The real run_job's shape: step() (as bin/aieditor-worker), pre-production's picture loop (onboard.route's B loop
    with produce_once), stages after it. ran.jsonl records every stage body that really ran."""
    d = job.d

    def ran(what):
        with open(d / "ran.jsonl", "a") as f:
            f.write(json.dumps(what) + "\n")

    def step(name, fn):                                       # == bin/aieditor-worker run_job.step (no done_if here)
        if LU.settled(f"stage/{name}") and job.st["stages"].get(name, {}).get("state") == "done":
            return
        LU.boundary(f"before the {name} stage", stage=name)
        job.stage(name, "running")
        job.progress(None, 0)
        ran(name)
        note = fn()
        job.stage(name, "done", note)
        LU.settle(f"stage/{name}", "done")

    step("audio", lambda: "ok")

    def preprod():
        ctx = Ctx(d / "preprod")
        for aid in PICTURES:
            job.progress(f"picture {aid}")                    # (raises Cancelled when the cancel file is there)
            LU.boundary("pre-production: between pictures (P3)")
            row = onboard.produce_once(ctx, aid, f"the {aid} picture")
            ran(f"{aid}:{row['status']}")
        LU.boundary("pre-production: P3 pictures → P4 features")
        return "pictures"
    step("preprod", preprod)
    step("compose", lambda: "composed")


W.run_job = fake_run_job


class Exec(BaseException):
    pass


EXECS = []


def fake_execve(path, argv, env):
    EXECS.append((argv, env))
    for f in ON_EXEC:
        f()
    raise Exec(argv, env)


LU._execve = fake_execve
ON_EXEC = []
ENV0 = dict(os.environ)


def run_worker(jid, action="run", max_execs=4):
    """One dispatch: the worker, and each re-exec as a 'new process' (its env; fresh module state via once())."""
    env = {**ENV0, LU.ENV_ON: "1", LU.ENV_VERSION: "v0", LU.ENV_ROOT: str(R)}
    env.pop(LU.ENV_RUN, None)
    env.pop(LU.ENV_RESUMED, None)
    rc = None
    for _ in range(max_execs + 1):
        os.environ.clear()
        os.environ.update(env)
        cwd = os.getcwd()
        try:
            rc = W.once(jid, action)
            break
        except Exec as e:
            env = e.args[1]
            check(e.args[0][1].endswith("bin/aieditor-worker") and e.args[0][2:] == ["--once", jid, action],
                  f"the same worker, same job + action: {e.args[0]}")
        finally:
            os.chdir(cwd)
    os.environ.clear()
    os.environ.update(ENV0)
    return rc


def new_job(jid):
    d = config.JOBS / jid
    (d / "preprod").mkdir(parents=True)
    (d / "request.json").write_text(json.dumps({"format": "long", "sponsored": False}))
    return d


def ran_list(d):
    return [json.loads(x) for x in (d / "ran.jsonl").read_text().splitlines()] if (d / "ran.jsonl").exists() else []


def name_tree(v, tree):
    (R / "code-version").write_text(json.dumps({"version": v, "tree": str(tree)}))


# the import check runs for real (a subprocess) on these fake trees
trees = {v: fake_tree(TMP / f"tree-{v}") for v in ("v1", "v2")}
broken = fake_tree(TMP / "tree-bad", extra={"aieditor/broken.py": "def oops(:\n"})

# ═══ 4 + 7. resume continuity + no duplicate generation (the push lands while p2 is being generated) ═══
name_tree("v0", init)
d = new_job("resume")
inner = []


def push_mid_generation():
    name_tree("v1", trees["v1"])                              # a push arrives while ChatGPT is generating p2
    try:
        inner.append(LU.boundary("an inner call while generating"))
    except LU.Restart:
        inner.append("RESTART")


HOOKS["p2"] = push_mid_generation
rc = run_worker("resume")
st = json.loads((d / "status.json").read_text())
check(inner == [False], f"inside the picture's generation the update is refused: {inner}")
check(len(EXECS) == 1 and EXECS[0][0][1] == str(trees["v1"] / "bin" / "aieditor-worker"), f"one re-exec into v1: {EXECS}")
check(EXECS[0][1][LU.ENV_VERSION] == "v1" and EXECS[0][1][LU.ENV_RESUMED] == "1" and EXECS[0][1][LU.ENV_RUN],
      "the new process knows its version, that it resumes, and the run id")
check(GEN == PICTURES, f"every picture generated exactly ONCE across the update (p2 finished first): {GEN}")
r_ = ran_list(d)
check(r_.count("audio") == 1 and r_.count("preprod") == 2 and r_.count("compose") == 1,
      f"audio not redone after the update, preprod continued, compose once: {r_}")
check(r_.count("p1:ready") == 2 and r_.count("p2:ready") == 2 and r_.count("p3:ready") == 1,
      f"p1/p2 reused (no generation) after the update, p3 made on the new code: {r_}")
hist = json.loads((d / "liveupdate.json").read_text())
check(hist["last"]["where"] == "pre-production: between pictures (P3)" and hist["last"]["from"] == "v0"
      and hist["last"]["to"] == "v1" and hist["last"]["stage"] == "preprod", f"the update is recorded: {hist}")
log = (d / "log.txt").read_text()
check(log.count("live update: now running code v1 (was v0)") == 1 and "continuing from preprod" in log,
      "one log line per update, with the version")
check(st["state"] == "done" and st["code_version"] == "v1" and st.get("code_updated_at") and rc == 0,
      f"status: done on v1 with code_version + code_updated_at: { {k: st.get(k) for k in ('state', 'code_version')} }")
check(st["code_update"]["to"] == "v1", "status carries the update row")

# a failed picture is not redone after an update (it settled in this run); a stage-boundary update; two updates
GEN.clear()
EXECS.clear()
name_tree("v0", init)
d = new_job("resume2")
FAIL.add("p1")
HOOKS["p1"] = lambda: name_tree("v1", trees["v1"])           # update #1 lands while p1 fails its tries
HOOKS["p4"] = lambda: name_tree("v2", trees["v2"])           # update #2 lands during p4 → the compose-stage boundary
rc = run_worker("resume2")
FAIL.clear()
r_ = ran_list(d)
check(GEN == PICTURES, f"the failed p1 is NOT generated again after the update; nothing twice: {GEN}")
check(r_.count("p1:needs_asset") == 3, f"p1 kept as it was (needs_asset) through both updates: {r_}")
check(len(EXECS) == 2 and [e[1][LU.ENV_VERSION] for e in EXECS] == ["v1", "v2"], f"two updates: {EXECS}")
hist = json.loads((d / "liveupdate.json").read_text())
check([u["where"] for u in hist["updates"]] == ["pre-production: between pictures (P3)",
                                                 "pre-production: P3 pictures → P4 features"],
      f"the second one at the route-group boundary: {hist['updates']}")
check(r_.count("compose") == 1 and r_.count("audio") == 1 and r_.count("preprod") == 3, f"stages: {r_}")
log = (d / "log.txt").read_text()
check(log.count("live update: now running code") == 2, "one log line per update")

# ═══ 5. a broken new tree → rollback, the old code carries on ═══
GEN.clear()
EXECS.clear()
name_tree("v0", init)
d = new_job("broken")
HOOKS["p2"] = lambda: name_tree("vBAD", broken)
calls = []
_real_check = LU.import_check
LU.import_check = lambda tree, **kw: calls.append(tree) or _real_check(tree, **kw)
rc = run_worker("broken")
LU.import_check = _real_check
st = json.loads((d / "status.json").read_text())
check(not EXECS, f"no re-exec into a tree that does not import: {EXECS}")
check(len(calls) == 1, f"checked ONCE, then the version is rejected (not re-checked at every boundary): {calls}")
check((R / "rejected" / "vBAD").exists() and "SyntaxError" in json.loads((R / "rejected" / "vBAD").read_text())["error"],
      "rejected, with the import error")
cv = json.loads((R / "code-version").read_text())
check(cv["version"] == "v0" and cv["rolled_back_from"] == "vBAD" and os.readlink(R / "current") == str(ROOT),
      f"code-version + current rolled back to the running tree: {cv}")
check(st["state"] == "done" and GEN == PICTURES and ran_list(d).count("compose") == 1,
      "the job finished on the old code")
log = (d / "log.txt").read_text()
check("does NOT import — rolled back" in log and log.count("live update:") == 1, f"one log line says why: {log[-400:]}")
check(st.get("code_update_error", {}).get("version") == "vBAD", "status says it too")

# ═══ 6. cancel across an update ═══
# (a) the cancel arrives while the job unwinds for the update: no exec, the job ends cancelled
GEN.clear()
EXECS.clear()
name_tree("v0", init)
d = new_job("cancel-a")
HOOKS["p2"] = lambda: name_tree("v1", trees["v1"])
_b = LU.boundary


def boundary_cancel_during_unwind(where, stage=None, check=None):
    try:
        return _b(where, stage=stage, check=check)
    except LU.Restart:
        (d / "cancel").touch()                               # …while the stack unwinds
        raise


LU.boundary = boundary_cancel_during_unwind
rc = run_worker("cancel-a")
LU.boundary = _b
st = json.loads((d / "status.json").read_text())
check(not EXECS and st["state"] == "cancelled" and rc == 1, f"cancelled, never exec'd: {st['state']} {EXECS}")
check(GEN == ["p1", "p2"] and not (d / "cancel").exists(), f"nothing after the cancel, the cancel file consumed: {GEN}")
check(st["stages"]["preprod"]["state"] == "interrupted", "the stage says interrupted")

# (b) the cancel arrives right after the exec: the new worker stops at once (its first progress)
GEN.clear()
EXECS.clear()
name_tree("v0", init)
d = new_job("cancel-b")
HOOKS["p2"] = lambda: name_tree("v1", trees["v1"])
ON_EXEC.append(lambda: (d / "cancel").touch())
rc = run_worker("cancel-b")
ON_EXEC.clear()
st = json.loads((d / "status.json").read_text())
check(len(EXECS) == 1 and st["state"] == "cancelled" and GEN == ["p1", "p2"], f"the new code cancels: {st['state']} {GEN}")

# (c) a cancel that is there at the boundary wins over the update (the cancel file survives the unwind of a restart)
GEN.clear()
EXECS.clear()
name_tree("v0", init)
d = new_job("cancel-c")


def cancel_and_push():
    name_tree("v1", trees["v1"])
    (d / "cancel").touch()


HOOKS["p2"] = cancel_and_push
rc = run_worker("cancel-c")
st = json.loads((d / "status.json").read_text())
check(not EXECS and st["state"] == "cancelled" and GEN == ["p1", "p2"], f"cancel wins: {st['state']} {EXECS} {GEN}")

# the restart path never deletes a cancel file (execute()'s finally keeps it for once())
src = (ROOT / "bin" / "aieditor-worker").read_text()
check("if not restarting:\n            (job.d / \"cancel\").unlink" in src, "execute() keeps the cancel file on a restart")

# ═══ the dispatcher wiring (static: the poll loop ticks the pusher next to push_caps) ═══
csrc = (ROOT / "aieditor" / "cloud.py").read_text()
check("pusher.tick()" in csrc and csrc.index("push_caps(ip, rjob, workflow, sent_caps)") < csrc.index("pusher.tick()"),
      "run_remote's poll loop ticks the live update next to push_caps")
check("liveupdate.ENV_ON: \"1\", liveupdate.ENV_VERSION: code_v" in csrc, "the droplet worker is started live-update enabled")

shutil.rmtree(TMP, ignore_errors=True)
print(f"test_liveupdate: {N} checks passed")
