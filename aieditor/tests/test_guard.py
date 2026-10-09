"""Mac-Chrome recorder + challenge guard (Jake 2026-10-08): offline checks."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import agentrec, cloud, config  # noqa: E402

n = 0


def check(cond, what):
    global n
    assert cond, what
    n += 1


e = agentrec.WallError({"kind": "challenge", "why": "Just a moment...", "url": "https://chatgpt.com/"})
check(isinstance(e, RuntimeError), "a wall is a RuntimeError (the caller's retry path catches it)")
check("human check" in agentrec.wall_message("chatgpt", e.wall), "challenge message")
check("login page" in agentrec.wall_message("chatgpt", {"kind": "login"}), "login message")
check(agentrec.wall_message("chatgpt", {}).startswith("ChatGPT"), "app name in the job log")
check(config.SC_IMAGE in cloud.IMAGES, "the recorder image is baked into the factory snapshot")
check(cloud.EGRESS.startswith("http://10.104."), "egress proxy is a VPC address")
mc = (ROOT / "screencast" / "macchrome.mjs").read_text()
for needle in ("AutomationControlled", '"MacIntel"', 'platform: "macOS"', '"Google Chrome"', "Asia/Bangkok",
               "__amhb", "--proxy-server", "verify you are human", "just a moment"):
    check(needle.lower() in mc.lower(), f"macchrome.mjs has {needle}")
fonts = (ROOT / "screencast" / "image" / "fonts-mac.conf").read_text()
for fam in ("-apple-system", "BlinkMacSystemFont", "system-ui", "SF Pro", "Helvetica Neue", "SF Mono"):
    check(re.search(rf"<family>{re.escape(fam)}</family>", fonts), f"font alias for {fam}")
for f in ("agent_rec.mjs", "vrecord.mjs", "inventory.mjs"):
    src = (ROOT / "screencast" / f).read_text()
    check("macchrome.mjs" in src and "/usr/bin/chromium" not in src, f"{f} launches through macchrome.mjs")
qa = (ROOT / "screencast" / "qa_content.py").read_text()
check("no_challenge" in qa, "QA rejects a recorded challenge page")

# overlay frames named by a float (render.mjs before 2026-10-09) are repaired before compose
import tempfile  # noqa: E402
from aieditor import graphics_long  # noqa: E402
with tempfile.TemporaryDirectory() as td:
    ev = Path(td) / "ev-03"
    ev.mkdir()
    for i in range(3):
        (ev / f"f{1920.0000000000002 + i}.png").write_text("x")
    (ev / "f02048.png").write_text("x")
    k = graphics_long.repair_frame_names(td, [{"frames_dir": "ev-03"}, {"frames_dir": "missing"}, {}])
    names = sorted(p.name for p in ev.iterdir())
    check(k == 3 and names == ["f01920.png", "f01921.png", "f01922.png", "f02048.png"], f"frame names repaired: {names}")
rj = (ROOT / "motion" / "render.mjs").read_text()
check("Math.round(first)" in rj and "outFirst != null" in rj, "render.mjs names frames by integer output frame")

# the frame guard (OCR) patterns
sys.path.insert(0, str(ROOT / "screencast"))
try:
    import qa_frames  # noqa: E402  (needs cv2: present in the screencast image only)
except ImportError:
    qa_frames = None
if qa_frames:
    check(qa_frames.CHALLENGE.search("Unusual activity has been detected from your device. Try again later."), "OCR: block")
    check(qa_frames.ERROR.search("Message delivery timed out. Please try again."), "OCR: error")
    check(qa_frames.GREET.search("Hey, Keith. Ready to dive in?").group(1) == "Keith", "OCR: greeting")
le = (ROOT / "aieditor" / "longedit.py").read_text()
check("frame_guard(" in le and "screen_pieces(" in le and "gates.salvage(" in le,
      "compose salvages the clean footage around what the frame guard flags (never a prefix-cut + A-roll)")
check("GUARD_EVERY_S = gates.GUARD_EVERY_S" in le and "--expect" in le, "the guard runs every 0.5 s with the beat expectations")
ar = (ROOT / "screencast" / "agent_rec.mjs").read_text()
check('execCommand("selectAll")' in ar, "typing clears a leftover draft first (C3)")
# the extended guard's pure rules (gap list G4.2): idle tail, empty canvas, garbled text, red-text margin
if qa_frames:
    sp = qa_frames.hit_spans([{"t": 10.0, "kind": "challenge", "why": "x"}, {"t": 10.5, "kind": "challenge", "why": "x"}], 0.5, 60)
    check(sp == [{"t0": 9.5, "t1": 11.0, "kind": "challenge", "why": "x"}], f"a run of hits widened by one interval: {sp}")
    stills = [(t / 2, 0.5 if t < 20 else 0.0) for t in range(0, 120)]          # moves for 10 s, then frozen
    idle = qa_frames.idle_spans(stills, [{"type": "click", "t": 4.0}], 60.0, 0.5)
    check(len(idle) == 1 and idle[0]["kind"] == "idle_tail" and idle[0]["t0"] <= 10.0, f"idle tail: {idle}")
    idle = qa_frames.idle_spans(stills, [{"type": "click", "t": 30.0, "end": 30.2}], 60.0, 0.5)
    check(idle and idle[0]["t0"] >= 30.0, "an agent event inside a freeze: only what follows it is idle")
    short = [(t / 2, 0.0 if 10 <= t < 14 else 0.5) for t in range(0, 40)]     # 2 s still: allowed
    check(qa_frames.idle_spans(short, [], 20.0, 0.5) == [], "a still under 3 s is fine")
    win = qa_frames.content_windows([{"at": 5.0, "content": True}, {"at": 9.0, "content": False}], 20.0)
    check(win == [(5.0, 9.0)], f"content windows: {win}")
    em = qa_frames.empty_spans([(4.5, 0.95), (5.0, 0.95), (5.5, 0.95), (9.5, 0.95), (6.0, 0.3)], win, 0.5)
    check(len(em) == 1 and em[0]["t0"] == 5.0 and em[0]["kind"] == "empty", f"empty canvas only where a result is due: {em}")
    ev = [{"type": "type", "t": 2.0, "end": 3.0, "text": "Create a shallow depth of field effect",
           "value": "Colorize this black and white photoCreate a shallow depth of field effect"}]
    texts = [(t / 2, "Colorize this black and white photo Create a shallow") for t in range(4, 20)]
    gb = qa_frames.garbled_spans(ev, texts, 0.5, 30.0)
    check(gb and gb[0]["kind"] == "garbled" and gb[0]["t1"] >= 9.5, f"garbled field text while the OCR reads it: {gb}")
    ok = [{"type": "type", "t": 2.0, "text": "Remove the man", "value": "Remove the man"}]
    check(qa_frames.garbled_spans(ok, texts, 0.5, 30.0) == [], "a field holding exactly the typed text is fine")
    m = qa_frames.merge_kind([{"t0": 1, "t1": 3, "kind": "garbled"}, {"t0": 2, "t1": 5, "kind": "garbled"},
                              {"t0": 2, "t1": 4, "kind": "idle"}])
    check(len(m) == 2 and m[0]["t1"] == 5, "same-kind spans merge, different kinds stay")
# ───────────── G3 / p7: the scripted recorder — set-dressed opening, compiled beats, retake on failure ─────────────
# (gap list G3 #20-#41; RULEBOOK §S S3/S4/S7, §1 C1-C5; BASELINE: no foreign page / popup / loading in frame 1
#  (CUT05 r3 1:29.85), press on its word, no still > 3 s). Agents never act on camera (recommendation §6).
import json as _json  # noqa: E402
import os  # noqa: E402
import shutil as _sh  # noqa: E402
import subprocess as _sp  # noqa: E402
import tempfile as _tf  # noqa: E402

os.environ["AIEDITOR_HUMAN_PACE"] = "0"
from aieditor import beatscript, playbook as _pbm, recorder  # noqa: E402

UNUSUAL = "Unusual activity has been detected from your device. Try again later."
CHALLENGE_RX = re.compile(r"unusual activity has been detected[^.\n]*", re.I)   # = macchrome.mjs wall()
check("unusual activity has been detected" in mc.lower(), "macchrome.mjs wall() flags 'Unusual activity'")


class FakeSess:
    """agent_rec.mjs stand-in: a clean set-dressed ChatGPT page that can fail on cue."""

    def __init__(self, workdir, fail_wait=False, inject_at=None):
        self.workdir, self.account, self.name = Path(workdir), "Jake", None
        self.fail_wait, self.inject_at, self.n_act = fail_wait, inject_at, 0
        self.body, self.out, self.sent, self.composer = "How can I help, Jake?", None, [], ""

    def _wall(self):
        m = CHALLENGE_RX.search(self.body)
        return {"kind": "challenge", "why": m.group(0)} if m else None

    def send(self, m):
        self.sent.append(m)
        c = m.get("cmd")
        if c == "state":
            return {"ok": True, "account": "Jake", "h1": ["How can I help, Jake?"], "sidebar": False, "draft": "",
                    "attachments": 0, "popups": 0, "tooltips": 0, "mode": "chat", "loading": False, "blank": False,
                    "dark": True, "text": self.body, "wall": self._wall(), "shot": None, "fp": "0f0f0f0f0f0f0f0f"}
        if c == "segment":
            self.out = self.workdir / m["out"]
            self.out.mkdir(parents=True, exist_ok=True)
            (self.out / "raw.mp4").write_bytes(b"x")
            return {"ok": True}
        if c == "abort":
            if self.out:
                _sh.rmtree(self.out, ignore_errors=True)
            self.out = None
            return {"ok": True, "aborted": True}
        if c == "end":
            (self.out / "events.json").write_text(_json.dumps({"events": []}))
            return {"ok": True}
        if c in ("guard", "reload", "open"):
            return {"ok": True, "wall": self._wall()}
        if c == "assert":
            w = self._wall()
            fail = [f"{w['kind']}: {w['why']}"] if w else []
            if m.get("field_equals") is not None and m["field_equals"] != self.composer:
                fail.append("field != script")
            return {"ok": not fail, "fail": fail, "wall": w}
        if c == "act":
            a = m["action"]
            self.n_act += 1 if self.out else 0
            if self.inject_at is not None and self.n_act >= self.inject_at:
                self.body += "\n" + UNUSUAL
            if a.get("type") == "type":
                self.composer = a.get("text", "")
            if a.get("type") == "wait_for" and self.fail_wait:
                return {"ok": False, "error": "did not appear in 300 s"}
            return {"ok": True, "wall": self._wall()}
        return {"ok": True}

    def close(self):
        pass


def _no_events(td, rel):
    return not (Path(td) / rel / "events.json").exists()


PBK = _pbm.playbook_copy("chatgpt")
for _a in PBK["actions"].values():
    _a["proven"] = True
VW = [{"i": i, "word": w, "start": 10.0 + i * 0.5, "end": 10.3 + i * 0.5}
      for i, w in enumerate("so I type it in and then I hit send right now".split())]
SEG = {"t0": 10.0, "t1": 20.0, "url": "https://chatgpt.com/", "app": "chatgpt", "session": "logged_in",
       "beats": [{"id": "b0", "word_id": 2, "t_word": 11.0, "word": "type", "action": "paste_prompt", "params": {"text": "hello there"}},
                 {"id": "b1", "word_id": 8, "t_word": 14.0, "word": "hit", "action": "close_menus"}]}
SCRIPT = beatscript.compile_segment(SEG, VW, PBK, 0)
LIVE = _json.loads(_json.dumps(SCRIPT))
LIVE["steps"].append({"type": "wait_for", "selector": '[data-testid="generated-image-preview"]', "timeout": 300, "until": 6.0,
                      "at": 4.0, "live": True, "beat_id": "b1"})
LIVE["beats"][1]["steps"].append(len(LIVE["steps"]) - 1)
with _tf.TemporaryDirectory() as td:
    # 1. a failed wait_for (the live beat) -> retake, no events.json
    s1 = FakeSess(td, fail_wait=True)
    r = recorder.record_take(s1, PBK, SEG, LIVE, "seg-00/rec", pixels=False)
    check(r["status"] == "retake" and "wait_for" in r["why"] and _no_events(td, "seg-00/rec"), f"failed wait_for -> retake ({r})")
    check(any(m.get("cmd") == "abort" for m in s1.sent), "the take is aborted in the recorder")
    first_state = next(k for k, m in enumerate(s1.sent) if m.get("cmd") == "state")
    check(first_state < next(k for k, m in enumerate(s1.sent) if m.get("cmd") == "segment"),
          "the opening state is dressed + checked BEFORE recording starts (never on camera, gap #39)")
    dressing = [m["action"] for m in s1.sent[:first_state] if m.get("cmd") == "act"]
    check(any(a.get("target") == "Chat" for a in dressing) and any("Hide sidebar" in _json.dumps(a) for a in dressing),
          "set-dressing from the playbook: Chat mode + sidebar hidden before the first frame")
    # 2. 'Unusual activity has been detected' appears mid-take -> retake, wall reported, no events.json
    s2 = FakeSess(td, inject_at=1)
    r = recorder.record_take(s2, PBK, SEG, SCRIPT, "seg-01/rec", pixels=False)
    check(r["status"] == "retake" and (r.get("wall") or {}).get("kind") == "challenge" and _no_events(td, "seg-01/rec"),
          f"'Unusual activity' -> retake with the wall ({r})")
    # 3. step exhaustion -> retake, no events.json
    big = _json.loads(_json.dumps(SCRIPT))
    big["steps"] = big["steps"] * 300
    big["beats"][0]["steps"] = list(range(len(big["steps"])))
    r = recorder.record_take(FakeSess(td), PBK, SEG, big, "seg-02/rec", pixels=False)
    check(r["status"] == "retake" and "exhaustion" in r["why"] and _no_events(td, "seg-02/rec"), f"step exhaustion -> retake ({r})")
    # 4. holds clamped to 3 s
    hs = _json.loads(_json.dumps(SCRIPT))
    hs["steps"].insert(0, {"type": "hold", "s": 9, "beat_id": "b0", "at": 0.2})
    for b in hs["beats"]:
        b["steps"] = [i for i, x in enumerate(hs["steps"]) if x.get("beat_id") == b["id"]]
    s4 = FakeSess(td)
    r = recorder.record_take(s4, PBK, SEG, hs, "seg-03/rec", pixels=False)
    holds = [m["action"]["s"] for m in s4.sent if m.get("cmd") == "act" and m["action"].get("type") == "hold"]
    check(r["status"] == "ok" and holds == [3.0], f"a hold > 3 s is clamped to 3 s ({holds})")
    check(not _no_events(td, "seg-03/rec"), "a clean take is kept")

# the first-frame gate refuses a dirty opening (DOM facts), and never records
ff = recorder._first_frame()
clean_dom = {"account": "Jake", "h1": ["How can I help, Jake?"], "sidebar": False, "draft": "", "attachments": 0, "popups": 0,
             "tooltips": 0, "mode": "chat", "loading": False, "blank": False, "dark": True}
check(ff.verdict({"dom": clean_dom}, "Jake")[0], "clean DOM state passes")
for k, v, why in (("account", "Keith", "account"), ("h1", ["Hey, Keith. Ready to dive in?"], "Keith"), ("sidebar", True, "sidebar"),
                  ("mode", "work", "Work"), ("draft", "Remove the man", "composer"), ("popups", 1, "popup"),
                  ("tooltips", 1, "tooltip"), ("loading", True, "loading"), ("dark", False, "light"), ("attachments", 1, "attachment")):
    ok, why_l = ff.verdict({"dom": {**clean_dom, k: v}}, "Jake")
    check(not ok and any(why.lower() in w.lower() for w in why_l), f"first-frame gate fails on {k}={v!r}: {why_l}")
ss = PBK["start_state"]
check(ff.account_of(ss) == "Jake", "the account comes from the playbook start_state")
ok, why_l = ff.verdict_for({"dom": {**clean_dom, "text": "What should we work on? Recents"}}, ss)
check(not ok and any("What should we work on?" in w and "start state" in w for w in why_l),
      f"the playbook start_state asserts are checked: {why_l}")
# the sidebar hidden leaves an icon rail whose 'Recents' label is page text: that alone is NOT an open sidebar
# (the start state asks for no 'Hide sidebar' button instead — proving run 2026-10-09)
check(ff.verdict_for({"dom": {**clean_dom, "text": "New chat Search Recents Library How can I help, Jake?"}}, ss)[0],
      "the collapsed rail's 'Recents' passes")
check(ff.verdict_for({"dom": {**clean_dom, "text": "How can I help, Jake?"}}, ss)[0], "a clean start state passes")

# the first-frame gate on real frames from the rejected job (pixels: cv2 + tesseract, screencast image)
FF = ROOT / "tests" / "fixtures" / "firstframe"
WANT = {"work_mode.jpg": False, "keith.jpg": False, "sidebar_open.jpg": False, "black_spinner.jpg": False, "clean.jpg": True}
res = None
try:
    import cv2  # noqa: F401
    res = {f: ff.verdict(ff.facts_of(FF / f), "Jake")[0] for f in WANT}
except ImportError:
    if os.environ.get("AIEDITOR_SKIP_DOCKER") != "1" and _sh.which("docker"):
        try:
            o = _sp.run(["docker", "run", "--rm", "--network", "none", "-v", f"{ROOT / 'screencast'}:/s:ro", "-v", f"{FF}:/f:ro",
                         "-w", "/f", "--entrypoint", "python3", config.SC_IMAGE, "/s/first_frame.py", *WANT],
                        capture_output=True, text=True, timeout=600)
            res = {f: v["ok"] for f, v in _json.loads(o.stdout).items()}
        except (OSError, ValueError, _sp.TimeoutExpired):
            res = None
if res is None:
    print("test_guard: first-frame pixel fixtures SKIPPED (no cv2 and no screencast image)")
else:
    for f, want in WANT.items():
        check(res[f] is want, f"first-frame gate on {f}: {'PASS' if want else 'FAIL'} expected, got {res[f]}")

# static: no system prompt / model call in a recorded take; the recorder's commands exist
src = (ROOT / "aieditor" / "agentrec.py").read_text()
rsrc = (ROOT / "aieditor" / "recorder.py").read_text()
check("SYSTEM" not in re.sub(r'""".*?"""', "", src, flags=re.S) and "_call(" not in src and "llm.messages(" not in src,
      "agentrec.py carries no system prompt and makes no model call (no on-camera agent)")
check(not hasattr(agentrec, "_agent_take") and not hasattr(agentrec, "record_segment") and not hasattr(agentrec, "prepare"),
      "the on-camera agent take is gone")
play = rsrc.split("def play_script")[1].split("\ndef ")[0]
check("llm." not in play and "repair_beat" not in play, "play_script (the recorded take) never calls a model")
check("AGENT_ACCOUNT" in src and "AGENT_ACCOUNT" in ar, "the recorded account is pinned (no 'Hey, Keith', gap #37)")
for cmd in ('m.cmd === "abort"', 'm.cmd === "state"', 'm.cmd === "assert"', 'm.cmd === "fp"', 'case "drag"', 'case "draw"',
            'case "upload"', 'case "reveal"'):
    check(cmd in ar, f"agent_rec.mjs has {cmd}")
check("set-up only" not in ar.split('case "drag"')[1][:300], "drag is recordable on its word (not set-up only)")
check('ty === "reveal" ? { type: "goto", url: a.url }' in ar and 'ty === "drag" ? { ...a, type: "click" }' in ar,
      "the click guard sees a drag's press point and a reveal's address")

print(f"test_guard: {n} checks passed")
