"""Browser plumbing for screencasts in a LOGGED-IN app (or the separate outside-view Chrome): the UX Scout
profile lookup, the account's own page history, and Session — one screencast/agent_rec.mjs process on a COPY of
the Scout profile.

No model acts on camera here any more (architecture recommendation §6 "replace"): the per-step AI loop that
chose each action while frames were captured (record_segment / prepare / the SYSTEM prompt) is removed. What is
shown and when is compiled by aieditor/beatscript.py from the plan's playbook beats and played by
aieditor/recorder.py; models decide off camera only (llm.OnCameraCall while Session.recording is set).
"""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import uuid
from pathlib import Path

from . import config, events, llm

SC_IMAGE = config.SC_IMAGE
LAB_DATA = Path("/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data")
SCOUT_PROFILES = LAB_DATA / "scout" / "profiles"
ACCOUNT = os.environ.get("AIEDITOR_ACCOUNT", "Jake")     # the ONLY account a recording may show (C4; 'Hey, Keith')


def _domain(url):
    host = re.sub(r"^https?://", "", url).split("/")[0].lower()
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def scout_for(url):
    """The UX Scout tool whose site is this domain: (slug, profile dir, latest report)."""
    try:
        db = sqlite3.connect(f"file:{LAB_DATA / 'db' / 'clipmagic.db'}?mode=ro", uri=True, timeout=10)
        tools = db.execute("SELECT slug, home_url, logged_in_at FROM scout_tools").fetchall()
        for slug, home, logged in tools:
            if home and _domain(home) == _domain(url) and (SCOUT_PROFILES / slug).is_dir():
                row = db.execute("SELECT report FROM scout_jobs WHERE tool_slug=? AND status='done' AND report IS NOT NULL "
                                 "ORDER BY finished_at DESC LIMIT 1", (slug,)).fetchone()
                return {"slug": slug, "profile": str(SCOUT_PROFILES / slug), "report": row[0] if row else "",
                        "logged_in_at": logged}
    except sqlite3.Error:
        return None
    return None


def known_pages(profile, limit=25):
    """Pages this account has already been to, from the profile's own browser history: the
    finished result of an earlier session has a direct address, so set-up can go straight there."""
    hist = Path(profile) / "Default" / "History"
    if not hist.exists():
        return []
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="aieditor-hist-")) / "history-read.db"   # never write beside a Scout profile
    try:
        shutil.copyfile(hist, tmp)             # the live file may be locked by the browser
        rows = sqlite3.connect(tmp).execute(
            "SELECT url, title, visit_count FROM urls WHERE title != '' ORDER BY visit_count DESC, last_visit_time DESC").fetchall()
    except sqlite3.Error:
        return []
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)
    seen, out = set(), []
    for url, title, _ in rows:
        base = url.split("?")[0].split("#")[0].rstrip("/")
        if (base in seen or re.search(r"//(auth|accounts|login|oauth)\.|/oauth2?/|/(login|logout|register|signup|new)\b", base)
                or re.search(r"\b(40[34]|forbidden|not be found|error)\b", title, re.I)):
            continue
        seen.add(base)
        out.append((base, title[:90]))
        if len(out) >= limit:
            break
    return out


# what may never be in a recording: a bot check / "unusual activity" block, ANOTHER account than the
# Scout's (a ChatGPT profile can hold two: "Hey, Keith" was recorded 2026-10-09), an app error banner
DROP_KINDS = ("challenge", "account", "error")


class WallError(RuntimeError):
    """The app showed a bot check (Cloudflare "Verify you are human", a captcha) or a login wall where the
    session should be logged in — the segment must not be recorded (Jake 2026-10-08)."""

    def __init__(self, wall):
        self.wall = wall or {}
        super().__init__(f"{self.wall.get('kind', 'wall')}: {self.wall.get('why', '')} at {self.wall.get('url', '')}")


def wall_message(slug, wall):
    """The job-log line for a wall. The screencast is NOT replaced by A-roll: it is retried, then held."""
    name = {"chatgpt": "ChatGPT", "linearity": "Linearity"}.get(slug, slug)
    kind = (wall or {}).get("kind")
    if kind == "login":
        return f"{name} showed a login page — screencast not recorded, the job is held"
    if kind == "account":
        return f"{name} opened another account ({(wall or {}).get('why', '')}) — screencast not recorded, the job is held"
    if kind == "error":
        return f"{name} showed an error ({(wall or {}).get('why', '')}) — screencast not recorded, the job is held"
    return f"{name} asked for a human check — screencast not recorded, the job is held"


class Session:
    """The agent_rec.mjs process (one per video)."""

    def __init__(self, workdir, profile_src, cancelled=lambda: False, dark=False, profile_name="profile",
                 account=ACCOUNT, env=None):
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.profile = self.workdir / profile_name          # one copy per app when a video shows several
        if profile_src and not self.profile.exists():
            # a COPY: the Scout's own session is never written to by a recording
            shutil.copytree(profile_src, self.profile, symlinks=True,
                            ignore=shutil.ignore_patterns("Singleton*", "*.lock"))
        # a browser killed mid-run leaves its lock files: Chromium then refuses the profile
        for lock in self.profile.glob("Singleton*"):
            lock.unlink(missing_ok=True)
        self.cancelled = cancelled
        self.account = account
        self._recording = False
        env = dict(env or {})
        tz = env.pop("TZ", "Asia/Bangkok")                  # Jake's timezone; the outside view runs on a US one
        self.name = f"aieditor-agent-{uuid.uuid4().hex[:8]}"
        cmd = ["docker", "run", "-i", "--rm", "--name", self.name, "--cpuset-cpus", config.CPUSET, "--shm-size", "1g",
               "--memory", config.MEMORY, "-e", "AGENT_WEBGL=1", "-e", f"AGENT_DARK={'1' if dark else '0'}",   # app canvases (Linearity's editor) need WebGL
               "-e", f"TZ={tz}", "-e", f"AGENT_PROXY={env.pop('AGENT_PROXY', config.EGRESS_PROXY)}",   # factory egress via the main box
               # the account is PINNED (G3 #37): the recorder no longer adopts whichever name it sees first
               *(["-e", f"AGENT_ACCOUNT={account}"] if account and profile_src else []),
               *[x for k, v in env.items() if k != "AGENT_PROFILE_DIR" for x in ("-e", f"{k}={v}")],
               "-v", f"{config.CODE / 'screencast'}:/app/screencast", "-v", f"{config.CODE / 'motion'}:/app/motion:ro",
               "-v", f"{self.workdir}:/w"]
        if profile_src:
            # clickguard.mjs: a logged-in session never opens pricing/billing and never logs out
            cmd += ["-v", f"{self.profile}:/prof", "-e", "AGENT_SESSION=logged_in"]
        cmd += [SC_IMAGE, "node", "/app/screencast/agent_rec.mjs", "/w"] + (["/prof"] if profile_src else [])
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, bufsize=1)
        events.emit("proc", f"recorder browser {self.name} — started", proc=self.name, phase="start")

    # RECORDING: frames are being captured. No model call may happen meanwhile (llm.OnCameraCall) —
    # defence in depth behind config.RECORDER["on_camera_agent"] = False.
    @property
    def recording(self):
        return self._recording

    @recording.setter
    def recording(self, on):
        self._recording = bool(on)
        llm.set_recording(self, self._recording)

    def send(self, msg):
        cmd = msg.get("cmd")
        if cmd == "segment":
            self.recording = True
        elif cmd in ("end", "quit", "abort"):
            self.recording = False
        if self.cancelled():
            self.close()
            raise InterruptedError()
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        # never wait forever on a stuck browser (2026-10-06: a renderer killed under memory
        # pressure left the worker waiting 2.5 h)
        import select
        r, _, _ = select.select([self.p.stdout], [], [], 900)
        if not r:
            self.close()
            raise RuntimeError("the agent recorder did not answer for 15 minutes")
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("the agent recorder stopped")
        return json.loads(line)

    def close(self):
        self.recording = False
        try:
            self.p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
            self.p.stdin.flush()
            self.p.wait(timeout=60)
        except Exception:  # noqa: BLE001
            subprocess.run(["docker", "kill", self.name], capture_output=True)
