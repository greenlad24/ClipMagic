"""Agent-driven screencasts inside a LOGGED-IN app (Jake 2026-10-06: "use the login in the UX
scout and be logged in to show everything the narration is talking about").

One browser (screencast/agent_rec.mjs) on a COPY of the UX Scout's profile for the tool stays
open for the whole video. For each screencast segment Claude sees the live screen + its
elements + the narration with times, and returns ONE action at a time with the clip second
of the word that describes it. The page clock is frozen between actions (thinking time and
long AI generations never show). The Scout's report for the tool is the map of the app.
"""
import base64
import json
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

from . import config

SC_IMAGE = "aieditor-screencast:0.1"
LAB_DATA = Path("/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data")
SCOUT_PROFILES = LAB_DATA / "scout" / "profiles"
MAX_STEPS = 45


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


class Session:
    """The agent_rec.mjs process (one per video)."""

    def __init__(self, workdir, profile_src, cancelled=lambda: False):
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.profile = self.workdir / "profile"
        if profile_src and not self.profile.exists():
            # a COPY: the Scout's own session is never written to by a recording
            shutil.copytree(profile_src, self.profile, symlinks=True,
                            ignore=shutil.ignore_patterns("Singleton*", "*.lock"))
        # a browser killed mid-run leaves its lock files: Chromium then refuses the profile
        for lock in self.profile.glob("Singleton*"):
            lock.unlink(missing_ok=True)
        self.cancelled = cancelled
        self.name = f"aieditor-agent-{uuid.uuid4().hex[:8]}"
        cmd = ["docker", "run", "-i", "--rm", "--name", self.name, "--cpuset-cpus", config.CPUSET, "--shm-size", "1g",
               "--memory", config.MEMORY, "-e", "AGENT_WEBGL=1",   # app canvases (Linearity's editor) need WebGL
               "-v", f"{config.CODE / 'screencast'}:/app/screencast", "-v", f"{config.CODE / 'motion'}:/app/motion:ro",
               "-v", f"{self.workdir}:/w"]
        if profile_src:
            cmd += ["-v", f"{self.profile}:/prof"]
        cmd += [SC_IMAGE, "node", "/app/screencast/agent_rec.mjs", "/w"] + (["/prof"] if profile_src else [])
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, bufsize=1)

    def send(self, msg):
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
        try:
            self.p.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
            self.p.stdin.flush()
            self.p.wait(timeout=60)
        except Exception:  # noqa: BLE001
            subprocess.run(["docker", "kill", self.name], capture_output=True)


SYSTEM = """You operate a real, logged-in web app to record a screencast for Jake Dawson's YouTube
tutorial. The voice-over is already recorded; you make the screen SHOW exactly what it says, when
it says it. You act ONE step at a time and see the result before the next step.

TIMING: every action has "at" = the clip second (from the narration times you are given) of the
word that describes it — the click lands on "click", the brand name appears as he names it. Never
earlier than the current time. The page's clock is frozen between your steps, so think freely.

SHOT GRAMMAR (Jake's own reference tutorial — follow it, it is how the result is judged):
- ONE BEAT PER IDEA. Each narration idea gets one calm screen: act once, then let it sit. Give a
  read/hover at least 2.5 s ("ms": 2500+). Do NOT hop between several small targets within a few
  seconds — the camera can only move about once every 4–10 s and ignores the rest.
- WHAT THE CAMERA DOES: it zooms (1.25–1.5×) to the element you click/type/read/highlight and holds
  there. So read/highlight targets must be MEANINGFUL BLOCKS the viewer should look at: a card, a
  panel, a form, a design, a row of swatches — never a lone word, an icon, an empty area or bare
  canvas. Give "deep": true only for a small detail he reads out (a table row, one price); it
  zooms to 2×. Prefer the main content area; elements tucked in a corner (a logo, a sidebar link)
  make a poor shot to hold on.
- NAVIGATION IS A CUT: when a click opens another page or a big panel, the recorder cuts straight
  to the loaded result (loading never shows). So just click; do not "hold" for a load. Never
  show a spinner, a blank canvas or an empty page.
- RESULT FIRST, BIG: when he talks about a result (designs, a campaign, a generated output), that
  result is on screen from his first word — open the existing document. The camera frames it (it
  pushes in on what you read), so do NOT fiddle with the app's own zoom: change it only when the
  designs are small (thumbnails you can't read), ONCE and OFF CAMERA (in the set-up): scroll with
  {"type":"scroll","zoom":"in","steps":1,"x":..,"y":..} at the centre of the designs he talks about
  (1 step ≈ 2× closer). REQUIRED whenever a canvas shows its designs as small thumbnails (together
  less than ~60 % of the screen, labels unreadable) — also on camera right after a canvas opens:
  the zoom is instant and reads as a cut. Then leave the canvas alone (no zooming back and forth).
- TYPING is shown live (cps 16–20), into the real field, then the result after a cut.
- SCROLL only to reveal the thing he names, and never into empty/dark sections of a marketing page.
- When the narration describes a step we cannot show for real (e.g. a sign-up while logged in),
  show the closest honest thing (hover the button he names) — never wander.

SAFETY: never delete anything, never buy/upgrade/checkout, never publish, share, invite, email or
post, never change account, billing or security settings. Creating a brand, running an AI
generation, opening documents, resizing, editing text/fonts/colours in a design are fine — the
account owner allows it ("it spends what it needs").

PREFER WHAT EXISTS: when the narration SHOWS a result ("look at this", "here are the designs"),
open a finished document that already exists instead of making a new one. Make something new only
when the narration walks through making it. Long AI work: start it, then {"type":"wait_for",
"text":"<text that appears when done>","show":1,"timeout":240} — the wait is cut out of the video.

ACTION FIELDS (exactly these):
  click | dblclick | hover | move | read | highlight: {"ref": "r12"} (from the element list; or
      {"x": 640, "y": 300} for a spot on a canvas — SCREENSHOT pixels, 1280×720); read/highlight also
      take "ms" (how long to hold) and optional "deep": true. For a spot on a canvas ALSO give
      "box": [x, y, w, h] = the whole design/artboard it belongs to (screenshot px), so the camera
      frames the design, not bare canvas
  type: {"ref": "r5", "text": "what to type", "cps": 18, "enter": false}
  key: {"key": "Escape" | "Enter" | "Tab" | "ArrowDown" | "Shift+1" ...}
  scroll: {"by": 400}   (px, + = down). Canvas zoom: {"type":"scroll","zoom":"in","steps":1,"x":..,"y":..}
      = ctrl+wheel at that spot, 1 step ≈ 2× — to make designs big on a canvas (off camera)
  wait_for: {"text": "text that appears when done", "show": 1, "timeout": 240, "gone": false}
  hold: {"s": 1.5}      goto: {"url": "..."}   (a goto is a cut too)
Reply with ONE JSON object and nothing else:
{"action": {"type": "...", "at": 3.4, ...fields above...}, "why": "<8 words>"}
or {"done": true, "why": "..."} when the segment's narration is fully shown."""


def _call(content, system_blocks, max_tokens=1500):
    key = config.env_key("ANTHROPIC_API_KEY")
    body = {"model": config.TAKES_MODEL, "max_tokens": max_tokens, "system": system_blocks,
            "output_config": {"effort": "low"}, "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                          "content-type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                res = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    text = "".join(b.get("text", "") for b in res["content"] if b["type"] == "text")
    # the FIRST complete JSON object (it sometimes sends two: "Extra data" killed a run)
    reply = {}
    i = text.find("{")
    while i != -1:
        try:
            reply, _ = json.JSONDecoder().raw_decode(text[i:])
            break
        except json.JSONDecodeError:
            i = text.find("{", i + 1)
    u = res.get("usage", {})
    usd = (u.get("input_tokens", 0) * 4e-6 + u.get("cache_read_input_tokens", 0) * 0.4e-6
           + u.get("cache_creation_input_tokens", 0) * 5e-6 + u.get("output_tokens", 0) * 20e-6)
    return reply if isinstance(reply, dict) else {}, usd


PREPARE = """OFF CAMERA, before the recording starts: get the app to the screen the segment should OPEN on, so
its first frame already shows what the first words are about (for the opening of the video: the
finished result itself, e.g. the finished campaign document — open it; a canvas opens "fit all",
which leaves designs as small thumbnails: zoom IN ONCE onto the designs he talks about
({"type":"scroll","zoom":"in","steps":1} at their centre — never "out") so they fill most of the
screen) — REQUIRED before you say ready if the designs are small thumbnails. If the
segment opens on a page the previous segment left a dropdown/menu/typed text on, clean it up. Nothing you do now is
recorded and "at" is ignored. The page runs in REAL time here: a heavy editor can take 10–20 s to
draw after goto — {"type":"hold","s":6} really waits; do not navigate away from a page that is still
loading. Reply {"ready": true} when the screen is right (also if it already is)."""


def prepare(sess, seg, said, system, log, max_steps=14):
    """Unrecorded set-up steps (Jake: the first minute shows the RESULT from the first frame)."""
    usd, history = 0.0, []
    for _ in range(max_steps):
        obs = sess.send({"cmd": "observe"})
        if "items" not in obs:
            continue
        shot = Path(sess.workdir) / Path(obs["shot"]).relative_to("/w") if str(obs.get("shot", "")).startswith("/w") else None
        content = []
        if shot and shot.exists():
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": base64.b64encode(shot.read_bytes()).decode()}})
            shot.unlink(missing_ok=True)
        items = "\n".join(f'{i["ref"]} {i["tag"]} "{i["text"]}" @{[round(v / obs.get("f", 1.5)) for v in i["box"]]}' for i in obs["items"][:200])
        hist = "\n".join(f'- {json.dumps(h["a"])[:140]} → {h["r"]}' for h in history) or "(none)"
        pages = "\n".join(f"- {u}  ({t})" for u, t in getattr(sess, "pages", [])) or "(none known)"
        content.append({"type": "text", "text": f"""{PREPARE}

PAGES THIS ACCOUNT ALREADY HAS (open one directly with goto — fastest route to an existing result):
{pages}

SEGMENT intent: {seg.get('intent', '')}
FIRST WORDS: {' '.join(said.split()[:40])}
Page: {obs.get('title', '')} — {obs.get('url', '')}
SET-UP STEPS SO FAR:
{hist}
ELEMENTS (SCREENSHOT pixels, 1280×720):
{items}
Next set-up step, or {{"ready": true}}?"""})
        reply, u = _call(content, system)
        usd += u
        if reply.get("ready") or reply.get("done") or not isinstance(reply.get("action"), dict):
            break
        a = {k: v for k, v in reply["action"].items() if k != "at"}
        res = sess.send({"cmd": "act", "action": a})
        history.append({"a": a, "r": "ok" if res.get("ok") else res.get("error", "failed")})
    if history:
        log(f"prepared off camera: {'; '.join(json.dumps(h['a'])[:60] for h in history)}")
    return usd


def record_segment(sess, seg, video, knowledge, out_rel, log=print, first=False):
    """Drive + record one segment → <workdir>/<out_rel>/{raw.mp4,events.json}. Returns usd."""
    dur = seg["t1"] - seg["t0"]
    ws = [w for w in video["words"] if seg["t0"] - 0.01 <= w["start"] <= seg["t1"]]
    said = " ".join(f'{w["word"]}@{w["start"] - seg["t0"]:.1f}' for w in ws)
    system = [{"type": "text", "text": SYSTEM},
              {"type": "text", "text": "WHAT THE APP LOOKS LIKE (the UX Scout's walkthrough of this exact account):\n"
               + (knowledge or "(no report)")[:24000], "cache_control": {"type": "ephemeral"}}]
    if not hasattr(sess, "pages"):
        sess.pages = known_pages(sess.profile)
    if first or not getattr(sess, "opened", False):
        # a fresh browser (also when a run resumes mid-video) starts on the segment's page
        sess.send({"cmd": "open", "url": seg["url"], "settle": 3})
        sess.opened = True
    usd = prepare(sess, seg, said, system, log)
    sess.send({"cmd": "segment", "out": out_rel})
    history = []
    for n in range(MAX_STEPS):
        obs = sess.send({"cmd": "observe"})
        if obs.get("t", 0) >= dur - 0.25:
            if str(obs.get("shot", "")).startswith("/w"):
                (Path(sess.workdir) / Path(obs["shot"]).relative_to("/w")).unlink(missing_ok=True)
            break
        if not obs.get("ok", True) and "items" not in obs:
            history.append({"t": obs.get("t", 0), "action": {"type": "observe"}, "result": obs.get("error", "observe failed")})
            continue
        items = "\n".join(f'{i["ref"]} {i["tag"]} "{i["text"]}" @{[round(v / obs.get("f", 1.5)) for v in i["box"]]}'
                          for i in obs.get("items", [])[:200])
        shot = Path(sess.workdir) / Path(obs["shot"]).relative_to("/w") if obs.get("shot", "").startswith("/w") else None
        content = []
        if shot and shot.exists():
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                        "data": base64.b64encode(shot.read_bytes()).decode()}})
            shot.unlink(missing_ok=True)
        hist = "\n".join(f'- t={h["t"]:.1f}: {json.dumps(h["action"])[:160]} → {h["result"]}' for h in history[-10:]) or "(none yet)"
        content.append({"type": "text", "text": f"""SEGMENT: {dur:.1f} s of screencast — about {max(2, round(dur / 5))} beats in all (one calm screen per idea).
The edit wants: {seg.get('intent', '')}
NARRATION (word@second from the segment start):
{said}

NOW: t = {obs.get('t', 0):.2f} s. Page: {obs.get('title', '')} — {obs.get('url', '')}. Cursor at {obs.get('cursor')}.
STEPS SO FAR:
{hist}

ELEMENTS ON SCREEN (ref tag "text" @[x, y, w, h] in SCREENSHOT pixels — the screenshot is 1280×720):
{items}

Next single step?"""})
        reply, u = _call(content, system)
        usd += u
        if reply.get("done"):
            break
        if not isinstance(reply.get("action"), dict):
            history.append({"t": obs.get("t", 0), "action": {}, "result": "unreadable reply — answer with ONE JSON object"})
            continue
        a = reply["action"]
        res = sess.send({"cmd": "act", "action": a})
        history.append({"t": obs.get("t", 0), "action": a, "result": "ok" if res.get("ok") else res.get("error", "failed")})
        if not res.get("ok"):
            log(f"agent step failed: {json.dumps(a)[:120]} — {res.get('error')}")
    sess.send({"cmd": "end", "until": round(dur + 0.5, 3)})
    json.dump(history, open(Path(sess.workdir) / out_rel / "agent-steps.json", "w"), indent=1)
    return usd
