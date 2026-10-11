"""LIVE UPDATE — fixed code reaches a RUNNING factory job without a server restart (Jake 2026-10-11: "I want to
create a mode where you can fix the code, agent and everything else while the new server is running without
restarting").

Before this, a fix reached a job only through cancel + re-dispatch: ~8 min of boot, a 1.3 GB copy, and the stage in
flight was lost. Now:

  THE BOX (cloud.run_remote's poll loop → Pusher.tick, at most once a minute; bin/aieditor-update forces it)
    1. versions(): a content hash of the code tree (config.CODE) — every change, committed or not, is a new version.
    2. the tree is copied to a frozen SNAPSHOT (WORK/liveupdate/snap/<key>) and the fast Python test suite runs there
       (`for t in tests/test_*.py; do python3 $t || exit 1; done`, ~3-5 min, in the background). The result is cached
       per tree hash; a red suite is never pushed (logged once per version).
    3. green → push(): the snapshot is rsynced to the droplet's STAGING dir <root>/trees/<v>.partial (hard links to the
       running tree for unchanged files), renamed to <root>/trees/<v> (atomic), and only then <root>/code-version names
       it (written to a .tmp + rename: atomic). A half-copied tree is never named, so it is never imported.

  THE DROPLET (the running worker, bin/aieditor-worker --once)
    4. boundary(where) is called at SAFE BOUNDARIES only — between pictures (P3) and between route groups
       (P3 → P4 → P2) in pre-production, between screencasts in the recorder, before each big stage. It does nothing
       inside a unit (unit() — a picture being made, a screencast being rehearsed/recorded), while frames are being
       captured (llm.recording()), when the job is cancelled, or when no newer version is named.
    5. a newer version: the new tree is IMPORT-CHECKED in a subprocess first. If it does not import, the worker keeps
       running the OLD code, code-version is rolled back to the running tree (kept on disk), the version is marked
       rejected (never retried) and the log says why.
    6. it imports: boundary() raises Restart (a BaseException: no `except Exception` on the way swallows it), the stack
       unwinds through every finally (browser sessions closed, assets.json written), the worker flushes its status and
       re-execs itself — os.execve of the SAME worker, same job, same action, from the new tree — same server, same pid
       (remote.pid stays valid), same job folder, ledgers, browser-profile copies and caps.json. The account lock is
       held by the BOX (cloud.run_remote) for the whole dispatch, so the re-exec never releases it.
    7. the new process resumes like Continue: every stage is idempotent (done_if, reuse_plan, <id>.produced.json,
       recording.json + skip_done). Units that SETTLED in this run before the update (settle()/settled(): a stage
       done, a picture that failed all its tries, a screencast that ended not-ok) are kept as they were — not redone,
       so an update never re-pays for a generation. Only units not reached yet run on the new code.

Files on the droplet: <root>/code-version {version, tree, pushed_at}, <root>/current → trees/<v>, <root>/running (the
tree + version the worker runs), <root>/rejected/<v>. In the job: liveupdate.json (one row per update),
liveupdate-settled.jsonl (settled units, per run). status.json: code_version, code_updated_at, code_update.
Tests: tests/test_liveupdate.py (fakes only)."""
import contextlib
import hashlib
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import config

ENV_ON = "AIEDITOR_LIVE_UPDATE"            # "1": this worker takes live updates (cloud.run_remote sets it)
ENV_ROOT = "AIEDITOR_LIVE_ROOT"            # the droplet's live-update dir (default DEFAULT_ROOT)
ENV_VERSION = "AIEDITOR_CODE_VERSION"      # the version of the tree this process runs
ENV_RUN = "AIEDITOR_LIVE_RUN"              # one id per dispatch: survives every re-exec of that run
ENV_RESUMED = "AIEDITOR_LIVE_RESUMED"      # set by the re-exec: this process continues a run after an update
DEFAULT_ROOT = Path("/opt/aieditor-live")
EXCLUDE_DIRS = {"__pycache__", "node_modules", ".git", ".pytest_cache"}
NOT_PUSHED = ("tests",)                    # the droplet never gets the tests (as at dispatch)
TEST_CMD = "for t in tests/test_*.py; do python3 $t || { echo \"FAILED: $t\"; exit 1; }; done"
TEST_TIMEOUT_S = 1800
EVERY_S = 60                               # the box looks for a new version at most once a minute
KEEP_TREES = 3
IMPORT_TIMEOUT_S = 180
WORKER = Path("bin") / "aieditor-worker"


class Restart(BaseException):
    """Raised at a safe boundary when a newer, importable tree is named: unwinds the job (finally blocks run) up to
    bin/aieditor-worker once(), which re-execs. A BaseException so no `except Exception` in a stage swallows it."""

    def __init__(self, doc, where, stage=None):
        super().__init__(f"live update to {doc.get('version')} at {where}")
        self.doc, self.where, self.stage = doc, where, stage


# ══════════════════════════════ the droplet side (the worker) ══════════════════════════════

_ctx = {"job": None, "cancelled": None, "log": None, "save": None, "stage": None}
_busy = []
_lock = threading.Lock()


def enabled():
    return os.environ.get(ENV_ON) == "1"


def root():
    return Path(os.environ.get(ENV_ROOT) or DEFAULT_ROOT)


def running_tree():
    return Path(__file__).resolve().parent.parent


def running_version():
    return os.environ.get(ENV_VERSION) or ""


def run_id():
    return os.environ.get(ENV_RUN) or ""


def resumed():
    return bool(os.environ.get(ENV_RESUMED))


def _jload(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def _jdump(p, obj):
    p = Path(p)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, p)


def attach(job_dir, cancelled=lambda: False, log=None, save=None, stage=None):
    """The worker's --once hands its job over: boundary()/settle() act only for an attached job (never on the box)."""
    _ctx.update(job=Path(job_dir), cancelled=cancelled, log=log or (lambda m: None), save=save or (lambda **k: None),
                stage=stage or (lambda: None))
    del _busy[:]
    if not run_id():
        os.environ[ENV_RUN] = f"{int(time.time())}-{os.getpid()}"
    if enabled():
        try:
            root().mkdir(parents=True, exist_ok=True)
            (root() / "running").write_text(f"{running_tree()}\n{running_version()}\n{os.getpid()}\n")
        except OSError:
            pass


def detach():
    _ctx.update(job=None)
    del _busy[:]


@contextlib.contextmanager
def unit(name):
    """One unit of work that must finish before any re-exec (a picture being made, a screencast being rehearsed and
    recorded): boundary() inside it is refused."""
    with _lock:
        _busy.append(str(name))
    try:
        yield
    finally:
        with _lock:
            if _busy:
                _busy.pop()


def busy():
    return list(_busy)


def pending():
    """The newer version named by <root>/code-version, or None (same version / rejected / incomplete tree)."""
    doc = _jload(root() / "code-version")
    if not isinstance(doc, dict) or not doc.get("version") or not doc.get("tree"):
        return None
    v = str(doc["version"])
    if v == running_version() or (root() / "rejected" / v).exists():
        return None
    tree = Path(doc["tree"])
    if not (tree / WORKER).is_file():
        return None
    try:
        if tree.resolve() == running_tree():
            return None
    except OSError:
        return None
    return doc


CHECK = r"""
import importlib, os, pkgutil, runpy, sys
tree = sys.argv[1]
sys.path.insert(0, tree)
for m in pkgutil.iter_modules([os.path.join(tree, "aieditor")]):
    importlib.import_module("aieditor." + m.name)
runpy.run_path(os.path.join(tree, "bin", "aieditor-worker"), run_name="aieditor_worker_import_check")
print("ok")
"""


def import_check(tree, timeout=IMPORT_TIMEOUT_S, run=subprocess.run):
    """Does the new tree import (every aieditor module + the worker's own top level)? In a SUBPROCESS: a broken tree
    never touches this process. → (ok, error tail)."""
    try:
        r = run([sys.executable, "-c", CHECK, str(tree)], cwd=str(tree), capture_output=True, text=True,
                timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"{type(e).__name__}: {e}"[-600:]
    if r.returncode != 0 or "ok" not in (r.stdout or ""):
        return False, ((r.stderr or "") + (r.stdout or "")).strip()[-600:] or f"exit {r.returncode}"
    return True, ""


def rollback(doc, err):
    """The new tree does not import: keep running the OLD code. code-version + current point back at the running tree
    (kept on disk), the version is marked rejected (never retried at the next boundary), one log line says why."""
    v = str(doc.get("version"))
    R = root()
    try:
        (R / "rejected").mkdir(parents=True, exist_ok=True)
        _jdump(R / "rejected" / v, {"version": v, "tree": doc.get("tree"), "error": err, "at": time.time()})
        _jdump(R / "code-version", {"version": running_version(), "tree": str(running_tree()), "rolled_back_from": v,
                                    "at": time.time()})
        tmp = R / "current.tmp"
        if tmp.is_symlink() or tmp.exists():
            tmp.unlink()
        os.symlink(str(running_tree()), tmp)
        os.replace(tmp, R / "current")
    except OSError:
        pass
    last = (err or "").strip().splitlines()[-1:] or ["?"]
    _ctx["log"](f"live update: the new code {v} does NOT import — rolled back, still running {running_version() or 'the dispatched code'}"
                f" ({last[0][:300]})")
    try:
        _ctx["save"](code_update_error={"version": v, "error": (err or "")[-600:], "at": time.time()})
    except Exception:  # noqa: BLE001 — a status hiccup never stops the job
        pass


def boundary(where, stage=None, check=None):
    """A SAFE BOUNDARY: nothing is half done here. When a newer importable version is named, raises Restart (the
    caller unwinds to the worker, which re-execs). Otherwise returns False at once — never raises anything else."""
    if not enabled() or _ctx["job"] is None or _busy:
        return False
    try:
        from . import llm
        if llm.recording():                  # frames are being captured: never
            return False
        if _ctx["cancelled"]():              # a cancel wins: the normal cancel path ends the job
            return False
        doc = pending()
    except Exception:  # noqa: BLE001 — a live-update hiccup never breaks a job
        return False
    if not doc:
        return False
    ok, err = (check or import_check)(doc["tree"])
    if not ok:
        rollback(doc, err)
        return False
    if _ctx["cancelled"]():
        return False
    raise Restart(doc, where, stage or _safe_stage())


def _safe_stage():
    try:
        return _ctx["stage"]()
    except Exception:  # noqa: BLE001
        return None


def settle(key, status, **info):
    """A unit of THIS run reached its end (ok or not): after a live update the run keeps it as it was (settled())."""
    if _ctx["job"] is None or not run_id():
        return
    try:
        with open(_ctx["job"] / "liveupdate-settled.jsonl", "a") as f:
            f.write(json.dumps({"run": run_id(), "key": str(key), "status": status, "at": round(time.time(), 3),
                                **info}, default=str) + "\n")
    except OSError:
        pass


def settled(key):
    """The unit's settle row from THIS run (before a live update), or None. A new dispatch is a new run: None."""
    if _ctx["job"] is None or not run_id():
        return None
    found = None
    try:
        for line in (_ctx["job"] / "liveupdate-settled.jsonl").read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("run") == run_id() and row.get("key") == str(key):
                found = row
    except OSError:
        return None
    return found


def announce():
    """The first thing a (re-exec'd) worker does: status code_version; after an update one log line with the version
    and the status line "Updated to the new code — continuing from <stage>"."""
    v = running_version() or None
    if not resumed():
        _ctx["save"](code_version=v)
        return None
    last = (_jload(_ctx["job"] / "liveupdate.json", {}) or {}).get("last") or {}
    stage = last.get("stage") or "where it was"
    _ctx["log"](f"live update: now running code {v} (was {last.get('from') or 'the dispatched code'}) — re-exec at "
                f"{last.get('where')}, continuing from {stage}, same server")
    _ctx["save"](message=f"Updated to the new code — continuing from {stage}", code_version=v,
                 code_updated_at=time.time(), code_update=last)
    return last


def stop_browsers(run=subprocess.run):
    """Defence in depth before the exec: every browser was closed by its finally on the way up, but a recorder
    container that outlived its process would hold the profile copy. Factory server only (one job per server)."""
    if not config.FACTORY_SERVER:
        return 0
    try:
        ids = run(["docker", "ps", "-q", "--filter", "name=aieditor-agent-"], capture_output=True, text=True,
                  timeout=30).stdout.split()
        if ids:
            run(["docker", "kill", *ids], capture_output=True, timeout=60)
        return len(ids)
    except (OSError, subprocess.TimeoutExpired):
        return 0


_execve = os.execve


def reexec(job_id, action, r):
    """After Restart unwound the job: record the update, flush, and exec the same worker from the new tree. Returns
    only when both execs failed (the caller then fails the job with that message)."""
    doc = r.doc
    tree, v = Path(doc["tree"]), str(doc["version"])
    rec = {"from": running_version() or None, "to": v, "where": r.where, "stage": r.stage, "at": round(time.time(), 3),
           "tree": str(tree)}
    try:
        hist = _jload(_ctx["job"] / "liveupdate.json", {}) or {}
        hist.setdefault("updates", []).append(rec)
        hist["last"] = rec
        _jdump(_ctx["job"] / "liveupdate.json", hist)
    except OSError:
        pass
    try:
        _ctx["save"](message=f"Updating to the new code ({v[:12]}) — continuing from {r.stage or 'where it was'}…")
    except Exception:  # noqa: BLE001
        pass
    stop_browsers()
    for s in (sys.stdout, sys.stderr):
        try:
            s.flush()
        except Exception:  # noqa: BLE001
            pass
    env = dict(os.environ, **{ENV_VERSION: v, ENV_RESUMED: "1", ENV_RUN: run_id()})
    for t, ver in ((tree, v), (running_tree(), running_version())):
        argv = [sys.executable, str(t / WORKER), "--once", job_id, action]
        try:
            os.chdir(t)
            _execve(sys.executable, argv, {**env, ENV_VERSION: ver})
            return None                       # (a test's fake exec returns)
        except OSError as e:
            _ctx["log"](f"live update: could not start the worker from {t} ({e})"
                        + (" — continuing on the old code" if t == tree else ""))
    return "live update: the worker could not be restarted"


# ══════════════════════════════ the box side (the dispatcher) ══════════════════════════════

def state_dir():
    return config.WORK / "liveupdate"


def versions(code=None):
    """→ (version, test_key): a content hash of what the droplet gets (tests excluded), and of the whole tree the
    tests run on (tests included). 12 hex chars each."""
    code = Path(code or config.CODE)
    pushed, whole = hashlib.sha1(), hashlib.sha1()
    for dp, dns, fns in os.walk(code):
        dns[:] = sorted(d for d in dns if d not in EXCLUDE_DIRS)
        for fn in sorted(fns):
            if fn.endswith((".pyc", ".tmp")):
                continue
            p = Path(dp) / fn
            rel = p.relative_to(code).as_posix()
            try:
                data = (b"link:" + os.readlink(p).encode()) if p.is_symlink() else p.read_bytes()
            except OSError:
                continue
            h = hashlib.sha1(data).hexdigest()
            line = f"{rel}\0{h}\n".encode()
            whole.update(line)
            if rel.split("/", 1)[0] not in NOT_PUSHED:
                pushed.update(line)
    return pushed.hexdigest()[:12], whole.hexdigest()[:12]


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def test_status(key):
    """None (never run) | "running" | "green" | "red" — the cached suite result of the tree with this test key."""
    d = state_dir() / "tests"
    rc = d / f"{key}.rc"
    if rc.exists():
        return "green" if rc.read_text().strip() == "0" else "red"
    run = d / f"{key}.running"
    if run.exists() and _alive((run.read_text().split() or ["0"])[0]):
        return "running"
    return None


def test_reason(key):
    """The red suite's first failing test (or the log's tail)."""
    try:
        lines = (state_dir() / "tests" / f"{key}.log").read_text().splitlines()
    except OSError:
        return ""
    bad = [ln for ln in lines if ln.startswith("FAILED: ")]
    return bad[-1][len("FAILED: "):] if bad else " | ".join(lines[-3:])[-300:]


def snapshot(code=None):
    """A frozen copy of the code tree (tests included) → (version, key, dir); None when the tree changed while it
    was copied (the next tick tries again). The suite runs on it and exactly it is pushed."""
    code = Path(code or config.CODE)
    v, key = versions(code)
    snap = state_dir() / "snap" / key
    if snap.is_dir() and versions(snap) == (v, key):
        return v, key, snap
    tmp = state_dir() / "snap" / f"{key}.partial"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.parent.mkdir(parents=True, exist_ok=True)
    ign = shutil.ignore_patterns(*EXCLUDE_DIRS, "*.pyc", "*.tmp")
    shutil.copytree(code, tmp, symlinks=True, ignore=ign)
    if versions(tmp) != (v, key):
        shutil.rmtree(tmp, ignore_errors=True)
        return None
    shutil.rmtree(snap, ignore_errors=True)
    os.replace(tmp, snap)
    _prune_snaps(keep=snap)
    return v, key, snap


def _prune_snaps(keep, n=4):
    d = state_dir() / "snap"
    olds = sorted((p for p in d.iterdir() if p.is_dir() and p != keep and not p.name.endswith(".partial")),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for p in olds[n - 1:]:
        shutil.rmtree(p, ignore_errors=True)


def start_tests(key, snap, popen=subprocess.Popen, cmd=None):
    """The fast suite on the snapshot, in the background (its own session: a box worker restart does not kill it);
    the shell writes <key>.rc at the end. Only one run per key (the .running file)."""
    d = state_dir() / "tests"
    d.mkdir(parents=True, exist_ok=True)
    if test_status(key) in ("running", "green", "red"):
        return False
    run = d / f"{key}.running"
    run.unlink(missing_ok=True)                       # (a stale one: its pid is gone)
    try:
        fd = os.open(run, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)    # one run per key, even with 2 jobs ticking
    except FileExistsError:
        return False
    os.write(fd, f"{os.getpid()}\n".encode())
    os.close(fd)
    script = (f"cd {shlex.quote(str(snap))} && timeout {TEST_TIMEOUT_S} bash -c {shlex.quote(cmd or TEST_CMD)} "
              f"> {shlex.quote(str(d / (key + '.log')))} 2>&1; rc=$?; "
              f"echo $rc > {shlex.quote(str(d / (key + '.rc.tmp')))} && mv -f {shlex.quote(str(d / (key + '.rc.tmp')))} "
              f"{shlex.quote(str(d / (key + '.rc')))}; rm -f {shlex.quote(str(d / (key + '.running')))}")
    env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "LC_ALL", "TZ") if k in os.environ}
    p = popen(["bash", "-c", script], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL, start_new_session=True)
    (d / f"{key}.running").write_text(f"{p.pid}\n{time.time():.0f}\n")
    return True


def run_tests_now(key, snap, out=print, cmd=None):
    """The same suite in the foreground (bin/aieditor-update): → "green" | "red"."""
    st = test_status(key)
    if st in ("green", "red"):
        return st
    if st != "running":
        start_tests(key, snap, cmd=cmd)
    t0 = time.time()
    while test_status(key) == "running":
        time.sleep(5)
        if time.time() - t0 > TEST_TIMEOUT_S + 60:
            break
        if int(time.time() - t0) % 60 < 5:
            out(f"  tests running… {time.time() - t0:.0f}s")
    return test_status(key) or "red"


SWITCH = r"""set -e
R={R}; V={V}
mkdir -p "$R/trees"
if [ -e "$R/rejected/$V" ]; then echo rejected; exit 3; fi
if [ -d "$R/trees/$V.partial" ] && [ ! -d "$R/trees/$V" ]; then mv -T "$R/trees/$V.partial" "$R/trees/$V"; fi
test -f "$R/trees/$V/bin/aieditor-worker"
touch "$R/trees/$V"
cat > "$R/code-version.tmp" && mv -f "$R/code-version.tmp" "$R/code-version"
ln -sfn "$R/trees/$V" "$R/current.tmp" && mv -Tf "$R/current.tmp" "$R/current"
run=$(basename "$(head -1 "$R/running" 2>/dev/null)" 2>/dev/null || true)
cd "$R/trees" && ls -1t | grep -v '\.partial$' | tail -n +{KEEP1} | grep -vxF -e "$V" -e "${{run:-.}}" | xargs -r rm -rf
echo switched
"""


def push(ip, snap, version, ssh=None, rsync=None, droplet_root=None):
    """The snapshot → the droplet's STAGING dir, then the atomic switch (rename + code-version). → "switched" |
    "rejected" (the server refused this version before: it did not import). Raises cloud.DOError on transport errors."""
    from . import cloud
    ssh = ssh or cloud.ssh
    rsync = rsync or cloud.rsync
    R = Path(droplet_root or DEFAULT_ROOT)
    tree = R / "trees" / version
    out = ssh(ip, f"mkdir -p {R}/trees; [ -d {tree} ] && echo have || echo need; cat {R}/code-version 2>/dev/null; true",
              timeout=60)
    lines = out.strip().splitlines()
    cur = None
    try:
        cur = json.loads("\n".join(lines[1:])).get("tree") if len(lines) > 1 else None
    except ValueError:
        cur = None
    if not (lines and lines[0] == "have"):
        rsync(f"{snap}/", f"root@{ip}:{tree}.partial/", "--delete", *[x for d in (*NOT_PUSHED, *EXCLUDE_DIRS)
                                                                     for x in ("--exclude", d)],
              "--exclude", "*.pyc", f"--link-dest={cur or config.CODE}", timeout=900)
    doc = {"version": version, "tree": str(tree), "pushed_at": round(time.time(), 3)}
    res = ssh(ip, SWITCH.format(R=shlex.quote(str(R)), V=shlex.quote(version), KEEP1=KEEP_TREES + 1),
              input=json.dumps(doc).encode(), timeout=120, check=False)
    return "rejected" if "rejected" in res else "switched" if "switched" in res else f"failed: {res[-200:]}"


class Pusher:
    """cloud.run_remote's poll loop: tick() next to push_caps. At most once per EVERY_S: a new code version → its
    snapshot + tests (background) → green: pushed (background thread). Never raises, never blocks the loop."""

    def __init__(self, ip, job_dir, log, sent=None, every=EVERY_S, clock=time.time, runner=None, code=None):
        self.ip, self.job_dir, self.log, self.code = ip, Path(job_dir), log, code
        self.sent = sent                      # the version the droplet has (dispatched / last pushed)
        self.every, self.clock = every, clock
        self.last = clock()                   # the first look one interval after the dispatch
        self.thread = None
        self.said = set()
        self.runner = runner or (lambda **kw: None)
        self.droplet_root = None              # (tests: a local dir standing in for the droplet's)

    def say(self, key, msg):
        if key not in self.said:
            self.said.add(key)
            self.log(msg)

    def tick(self, force=False):
        try:
            return self._tick(force)
        except Exception as e:  # noqa: BLE001 — never interrupts the poll loop
            self.say(f"err:{type(e).__name__}:{str(e)[:80]}", f"live update: {type(e).__name__}: {str(e)[:200]}")
            return None

    def _tick(self, force):
        if not force and self.clock() - self.last < self.every:
            return None
        self.last = self.clock()
        if self.thread is not None and self.thread.is_alive():
            return "pushing"
        v, key = versions(self.code)
        if v == self.sent:
            return "current"
        st = test_status(key)
        if st is None:
            snap = snapshot(self.code)
            if not snap:
                return "changing"
            v, key, sdir = snap
            st = test_status(key)
            if st is None:
                start_tests(key, sdir)
                self.say(f"test:{key}", f"live update: code changed ({v}) — running the tests before it goes to the server")
                self.runner(live_update={"version": v, "state": "testing", "at": time.time()})
                return "testing"
        if st == "running":
            return "testing"
        if st == "red":
            self.say(f"red:{key}", f"live update: code {v} NOT sent — the tests are red ({test_reason(key)[:200]})")
            self.runner(live_update={"version": v, "state": "tests red", "at": time.time()})
            return "red"
        sdir = state_dir() / "snap" / key
        if not sdir.is_dir():
            snap = snapshot(self.code)
            if not snap or snap[1] != key:
                return "changing"
        self.thread = threading.Thread(target=self._push, args=(v, sdir), daemon=True, name=f"liveupdate-{v}")
        self.thread.start()
        return "pushing"

    def _push(self, v, sdir):
        try:
            res = push(self.ip, sdir, v, droplet_root=self.droplet_root)
        except Exception as e:  # noqa: BLE001 — retried at the next tick
            self.say(f"pushfail:{v}:{str(e)[:60]}", f"live update: could not send code {v} ({str(e)[:200]}) — retrying")
            return
        if res == "switched":
            self.sent = v
            self.log(f"live update: code {v} sent to the factory server — the job switches to it at its next safe "
                     "boundary (between pictures / route groups / screencasts / stages), no restart")
            self.runner(live_update={"version": v, "state": "sent", "at": time.time()})
        elif res == "rejected":
            self.sent = v
            self.say(f"rej:{v}", f"live update: code {v} was rejected by the server earlier (did not import) — not sent")
        else:
            self.say(f"pushfail:{v}:{res[:40]}", f"live update: code {v} switch {res}")

    def wait(self, timeout=None):
        if self.thread is not None:
            self.thread.join(timeout)
