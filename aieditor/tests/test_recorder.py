"""The scripted recorder (aieditor/recorder.py): rehearsal, open_clean, per-beat asserts, single-beat retakes, the
capped off-camera repair agent, needs_primitive -> held, the elastic assembler on frames — with a FAKE page
(agent_rec.mjs stand-in) and fake media. No video job, no live account, no Lab job, no factory server; the only
containers are the short-lived screencast-image runs of part 7 (AIEDITOR_SKIP_DOCKER=1 skips them).

Run: python3 tests/test_recorder.py
"""
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="p7-recorder-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")                 # never the live /opt/aieditor-work
os.environ["AIEDITOR_API_LEDGER"] = str(TMP / "api.jsonl")      # the repair agent's ledger lines go here
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
os.environ["AIEDITOR_HUMAN_PACE"] = "0"
for k in ("AIEDITOR_API_JOB_CAP_USD", "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD", "AIEDITOR_API_PRIOR_JOB_USD"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import agentrec, apiledger, config, llm, recorder as R  # noqa: E402
from aieditor import beatscript as B  # noqa: E402
from aieditor import playbook as PB  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


R.RETAKE_COOLDOWN_S = 0
R.WALL_COOLDOWN_S = 0
UNUSUAL = "Unusual activity has been detected from your device. Try again later."


class FakePage:
    """agent_rec.mjs stand-in: a set-dressable ChatGPT page with a composer, a recording clock and failure cues.
      fail_beats   {beat_id: n}  the beat's action fails n times while RECORDING
      dry_fail     {beat_id: why}  the beat's action fails in the dry run until 'close_menus' ran (a popup)
      inject_at    after this many recorded actions 'Unusual activity' appears
      fail_wait    a wait_for returns ok:false"""

    def __init__(self, workdir, fail_beats=None, dry_fail=None, inject_at=None, fail_wait=False, sidebar_stuck=False):
        self.workdir = Path(workdir)
        self.account, self.name = "Jake", None
        self.fail_beats = dict(fail_beats or {})
        self.dry_fail = dict(dry_fail or {})
        self.inject_at, self.fail_wait, self.sidebar_stuck = inject_at, fail_wait, sidebar_stuck
        self.url, self.composer, self.attachments, self.sidebar, self.popup = "about:blank", "", 0, True, False
        self.body_extra = ""
        self.rec = None
        self.t = 0.0
        self.sent, self.played = [], []
        self._recording = False
        self.llm_on_camera = []

    @property
    def recording(self):
        return self._recording

    @recording.setter
    def recording(self, on):
        self._recording = bool(on)
        llm.set_recording(self, self._recording)

    def _wall(self):
        return {"kind": "challenge", "why": "Unusual activity has been detected"} if "Unusual activity" in self.body_extra else None

    def _fp(self):
        h = hashlib.sha1(f"{self.url}|{self.composer}|{self.attachments}|{self.popup}".encode()).hexdigest()
        return h[:16]

    def body(self):
        return f"How can I help, Jake? {self.composer} {self.body_extra}" + (" Recents" if self.sidebar else "")

    def send(self, m):
        self.sent.append(m)
        c = m.get("cmd")
        if c == "open":
            self.url, self.composer = m["url"], ""
            return {"ok": True, "url": self.url, "wall": self._wall()}
        if c == "state":
            return {"ok": True, "account": "Jake", "h1": ["How can I help, Jake?"], "sidebar": self.sidebar, "draft": self.composer,
                    "attachments": self.attachments, "popups": 0, "tooltips": 0, "mode": "chat", "loading": False, "blank": False,
                    "dark": True, "text": self.body(), "wall": self._wall(), "shot": None, "fp": self._fp(), "private": []}
        if c == "fp":
            return {"ok": True, "fp": self._fp()}
        if c == "segment":
            self.rec = self.workdir / m["out"]
            self.rec.mkdir(parents=True, exist_ok=True)
            (self.rec / "raw.mp4").write_bytes(b"x")
            self.t = float(m.get("t0", 0.0))
            self.t0 = self.t
            self.events = []
            self.recording = True
            return {"ok": True}
        if c == "abort":
            if self.rec:
                shutil.rmtree(self.rec, ignore_errors=True)
            self.rec = None
            self.recording = False
            return {"ok": True, "aborted": True}
        if c == "end":
            if self.rec:
                self.t = max(self.t, float(m.get("until", self.t)))
                (self.rec / "events.json").write_text(json.dumps({"t0": self.t0, "events": self.events, "walls": [],
                                                                  "cursor": [[round(self.t0 + i / 30, 4), 10, 10] for i in range(5)],
                                                                  "capture": {"fps": B.FPS}}))
                (self.rec / "privacy.json").write_text("[]")
            self.rec = None
            self.recording = False
            return {"ok": True}
        if c in ("guard", "reload"):
            return {"ok": True, "wall": self._wall()}
        if c == "find":
            return {"ok": True, "found": {}}
        if c == "observe":
            return {"ok": True, "url": self.url, "items": [{"tag": "button", "text": "Escape menu", "box": [0, 0, 1, 1]}], "shot": ""}
        if c == "assert":
            fail = []
            for tx in m.get("present", []):
                if tx.lower() not in self.body().lower():
                    fail.append(f"missing {tx}")
            for tx in m.get("absent", []):
                if tx.lower() in self.body().lower():
                    fail.append(f"unexpected {tx}")
            if m.get("field_equals") is not None and self.composer != m["field_equals"]:
                fail.append(f"field {self.composer!r} != {m['field_equals']!r}")
            if m.get("field_empty") and self.composer:
                fail.append("field not empty")
            if self._wall():
                fail.append("challenge: Unusual activity has been detected")
            return {"ok": not fail, "fail": fail, "wall": self._wall()}
        if c == "act":
            a = m["action"]
            if self.recording:
                self.llm_on_camera.append(llm.recording())
                if self.inject_at is not None and sum(1 for p in self.played if p[0]) + 1 >= self.inject_at:
                    self.body_extra = UNUSUAL
            bid = a.get("beat_id")
            self.played.append((self.recording, bid, a.get("type"), a.get("text")))
            if self.recording and bid in self.fail_beats and self.fail_beats[bid] > 0:
                self.fail_beats[bid] -= 1
                return {"ok": False, "error": "no element for the target (a page glitch)"}
            if not self.recording and bid in self.dry_fail and not self.popup_closed():
                return {"ok": False, "error": self.dry_fail[bid]}
            ty = a.get("type")
            if ty == "type":
                self.composer = a.get("text", "") if a.get("clear", True) else self.composer + a.get("text", "")
            elif ty in ("goto", "reveal"):
                self.url = a.get("url") or self.url
                if ty == "goto":
                    self.composer = ""
            elif ty == "upload":
                self.attachments += 1
            elif ty == "click" and "Hide sidebar" in json.dumps(a) and not self.sidebar_stuck:
                self.sidebar = False
            elif ty == "click" and a.get("selector", "").startswith('button[aria-label^="Remove "]'):
                if not self.attachments:
                    return {"ok": False, "error": "no element"}
                self.attachments -= 1
            elif ty == "key" and a.get("key") == "Escape":
                self.popup = False
                self.closed = True
            elif ty == "wait_for" and self.fail_wait:
                return {"ok": False, "error": "did not appear in 300 s"}
            if self.recording:
                at = a.get("at")
                if at is not None:
                    self.t = max(self.t, float(at))
                e = {"t": round(self.t, 4), "type": ty, "beat_id": bid}
                if a.get("word_t") is not None:
                    e["word_t"] = a["word_t"]
                if ty in ("click", "type", "drag", "draw", "upload", "key"):
                    e["press"] = round(self.t, 4)
                    e["beat"] = a.get("beat", False)
                if ty == "reveal":
                    e.update(type="nav", k2={"frames": 6})
                self.events.append(e)
                if ty == "hold":
                    self.holds = getattr(self, "holds", []) + [a.get("s")]
                self.t += 0.05
            return {"ok": True, "t": round(self.t, 4), "wall": self._wall()}
        return {"ok": True}

    def popup_closed(self):
        return getattr(self, "closed_for_repair", False)

    def close(self):
        pass


class FakeMedia:
    def __init__(self):
        self.concats = []

    def concat(self, rec, pieces):
        self.concats.append([p["name"] for p in pieces])
        (Path(rec) / "raw.mp4").write_bytes(b"x")

    def motion(self, rec, src="raw.take.mp4"):
        ev = json.loads((Path(rec) / "events.json").read_text())
        n = int(math.ceil((ev.get("end") or 20) * B.FPS)) + 30
        return [None] + [0.0] * n

    def render(self, rec, frames, src="raw.take.mp4"):
        (Path(rec) / "raw.mp4").write_bytes(b"y")
        self.frames = frames


PBX = PB.playbook_copy("chatgpt")
for _a in PBX["actions"].values():
    _a["proven"] = True
WORDS = [{"i": i, "word": w, "start": round(10.0 + i * 0.5, 3), "end": round(10.3 + i * 0.5, 3)}
         for i, w in enumerate(("so first I paste the one then the two and the three right here and we are done "
                                "with all of it now okay").split())]


def wid(word, n=0):
    return [w for w in WORDS if w["word"] == word][n]


def beat(bid, word, action, **kw):
    w = wid(word)
    return {"id": bid, "word_id": w["i"], "t_word": w["start"], "word": word, "action": action, **kw}


SEG = {"t0": 10.0, "t1": 22.0, "url": "https://chatgpt.com/", "app": "chatgpt", "session": "logged_in",
       "beats": [beat("b1", "first", "camera", subject="screen"),
                 beat("b2", "one", "paste_prompt", params={"text": "one prompt"}),
                 beat("b3", "two", "paste_prompt", params={"text": "two prompt"}),
                 beat("b4", "three", "paste_prompt", params={"text": "three prompt"})]}
VIDEO = {"words": WORDS, "duration": 30.0}


def rec(w, page, verdict=None, media=None, plan_segs=None, playbooks=None, call=None, assets=None):
    pages = [page] if not isinstance(page, list) else page
    made = []

    def new_session(app, kind, fresh):
        made.append(fresh)
        return pages.pop(0) if len(pages) > 1 else pages[0]
    out = R.record_all({"segments": plan_segs or [SEG]}, playbooks or {"chatgpt": PBX}, assets or {"assets": []}, w=w,
                       video=VIDEO, new_session=new_session, verdict=verdict, media=media, log=lambda *a: None,
                       sleep=lambda s: None, pixels=False, repair_call=call)
    return out, made


# ── 1. a clean run: rehearsal off camera, then one recorded take; every beat once on camera ──
w1 = TMP / "e1"
p1 = FakePage(w1)
out, _ = rec(w1, p1, media=FakeMedia())
doc = out["segments"][0]
check(doc["status"] == "ok" and not out["held"], f"clean run recorded: {doc}")
dry = [p for p in p1.played if not p[0]]
cam = [p for p in p1.played if p[0]]
check(dry and cam, "a dry run off camera, then the take")
first_cam = p1.sent.index(next(m for m in p1.sent if m.get("cmd") == "segment"))
check(any(m.get("cmd") == "state" for m in p1.sent[:first_cam]), "the first-frame gate runs BEFORE recording starts (gap #39)")
check([p[3] for p in cam if p[2] == "type" and p[1]] == ["one prompt", "two prompt", "three prompt"],
      "on camera: each prompt pasted once, in order (no retype, no append)")
sc = json.loads((w1 / "seg-00" / "script.compiled.json").read_text())
check(all(b["end_state"]["fingerprint"] for b in sc["beats"]), "the rehearsal captured every beat's end-state fingerprint")
check(sc["start_state"]["fingerprint"], "and the start state's")
ev = json.loads((w1 / "seg-00" / "rec" / "events.json").read_text())
check(ev.get("retime") and ev["retime"]["ok"], "the elastic assembler ran on the take")
check(all(x is True for x in p1.llm_on_camera), "llm.recording() is set for every recorded action")
check(not llm.recording(), "and cleared after the take")

# ── 2. (g) single-beat retake: beat 3 fails once while recording -> only beat 3 is re-recorded ──
w2 = TMP / "e2"
p2 = FakePage(w2, fail_beats={"b3": 2})                       # its selector AND the playbook fallback fail once
med = FakeMedia()
out, _ = rec(w2, p2, media=med)
doc = out["segments"][0]
check(doc["status"] == "ok", f"recorded after one beat retake: {doc}")
cam = [p for p in p2.played if p[0]]
count = {b: sum(1 for p in cam if p[1] == b and p[2] == "type") for b in ("b2", "b3", "b4")}
count["b1"] = sum(1 for p in cam if p[1] == "b1" and p[2] == "read" and p[0]) and \
    sum(1 for m in p2.sent if m.get("cmd") == "act" and m["action"].get("beat_id") == "b1" and m["action"].get("beat"))
check(count["b1"] == 1 and count["b2"] == 1, f"beats 1-2 kept from the first take (recorded once): {count}")
check(sum(1 for p in cam if p[1] == "b3") == 3, "beat 3: the failed press (selector + playbook fallback) + its retake")
check(count["b4"] == 1, "beat 4 recorded once (in the piece after the retake)")
st = json.loads((w2 / "seg-00" / "gate.json").read_text())
check(st["beat_retakes"] == {"b3": 1} and len(st["beat_log"]) == 1, f"events show ONE beat retake: {st}")
ev = json.loads((w2 / "seg-00" / "rec" / "events.take.json").read_text())
names = [p["name"] for p in ev["pieces"]]
check(names == ["take-1", "beats/b3-t2"], f"pieces: the first take up to beat 3, then beat 3's retake: {names}")
check(ev["pieces"][0]["t1"] == ev["pieces"][1]["t0"], "the pieces meet at beat 3's window start")
check({e.get("beat_id") for e in ev["events"] if e.get("piece") == "take-1" and e.get("beat_id")} <= {"b1", "b2"}
      and {e.get("beat_id") for e in ev["events"] if e.get("piece") == "beats/b3-t2"} >= {"b3", "b4"},
      "merged events: beats 1-2 from the take, beat 3 on from the retake")
check((w2 / "seg-00" / "rec" / "take-1" / "events.json").exists(), "the kept part of the first take is on disk")

# post-take verdict: beat 2 fails the frame guard once -> beat 2's window alone is re-recorded and spliced in
w2b = TMP / "e2b"
p2b = FakePage(w2b)
calls = []


def verdict(w, i, sc):
    calls.append(i)
    if len(calls) == 1:
        win = dict((b, (a, z)) for b, a, z in R.beat_windows(sc, sc["t1"] - sc["t0"]))
        t = (win["b2"][0] + win["b2"][1]) / 2
        return {"ok": False, "reasons": ["popup"], "problems": [{"kind": "garbled", "problem": "wrong_content", "t0": t, "t1": t + 0.5}]}
    return {"ok": True, "reasons": [], "problems": []}
out, _ = rec(w2b, p2b, verdict=verdict, media=FakeMedia())
ev = json.loads((w2b / "seg-00" / "rec" / "events.take.json").read_text())
names = [p["name"] for p in ev["pieces"]]
check(names == ["take-1", "beats/b2-t2", "take-1"], f"beat 2 alone spliced into the take: {names}")
check(ev["pieces"][1]["beats"] == ["b2"], "the retake piece holds beat 2 only")
check(len(calls) == 2, "the verdict runs again after the retake")
cam = [p for p in p2b.played if p[0]]
check(sum(1 for p in cam if p[1] == "b3") == 1 and sum(1 for p in cam if p[1] == "b2" and p[2] == "type") == 2,
      "only beat 2 recorded twice")
check(json.loads((w2b / "seg-00" / "gate.json").read_text())["remedies_by_beat"] == {"b2": ["rerecord_beat"]},
      "remedy table: rerecord_beat for wrong content")

# ── 3. G3 fake-page failures: retake with NO events.json; holds clamped ──
SC = B.compile_segment(SEG, WORDS, PBX, 0)
for name, page in (("wait_for ok:false", FakePage(TMP / "g1", fail_wait=True)),
                   ("Unusual activity", FakePage(TMP / "g2", inject_at=2)),
                   ("a failed action", FakePage(TMP / "g3", fail_beats={"b2": 9}))):
    sc = json.loads(json.dumps(SC))
    if name.startswith("wait_for"):
        sc["steps"].append({"type": "wait_for", "selector": "img", "timeout": 5, "at": 5.0, "beat_id": "b4", "live": True})
        sc["beats"][-1]["steps"].append(len(sc["steps"]) - 1)
    r = R.record_take(page, PBX, SEG, sc, "seg-00/rec/take-1", log=lambda *a: None, pixels=False)
    check(r["status"] == "retake" and not (page.workdir / "seg-00/rec/take-1/events.json").exists(),
          f"{name} -> retake, no events.json ({r})")
    check(any(m.get("cmd") == "abort" for m in page.sent), f"{name}: the take is aborted in the recorder")
check(R.record_take(FakePage(TMP / "g2b", inject_at=2), PBX, SEG, json.loads(json.dumps(SC)), "x/rec", pixels=False)
      ["wall"]["kind"] == "challenge", "'Unusual activity has been detected' is reported as a wall (fresh session + cooldown)")
long = json.loads(json.dumps(SC))
long["steps"] = long["steps"] * 120
long["beats"][0]["steps"] = list(range(len(long["steps"])))
r = R.record_take(FakePage(TMP / "g4"), PBX, SEG, long, "seg-00/rec/take-1", pixels=False)
check(r["status"] == "retake" and "step exhaustion" in r["why"] and not (TMP / "g4/seg-00/rec/take-1/events.json").exists(),
      f"step exhaustion -> retake, no events.json ({r})")
late = json.loads(json.dumps(SC))
late["steps"][late["beats"][1]["steps"][-1]]["at"] = 40.0              # a beat that would play after the segment end
r = R.record_take(FakePage(TMP / "g5"), PBX, SEG, late, "seg-00/rec/take-1", pixels=False)
check(r["status"] == "retake" and "step exhaustion" in r["why"], f"the take ran past the segment end -> retake ({r})")
hold = json.loads(json.dumps(SC))
hold["steps"].insert(1, {"type": "hold", "s": 9, "beat_id": "b1", "at": 0.5})
for b in hold["beats"]:
    b["steps"] = [i for i, s in enumerate(hold["steps"]) if s.get("beat_id") == b["id"]]
pg = FakePage(TMP / "g6")
R.record_take(pg, PBX, SEG, hold, "seg-00/rec/take-1", pixels=False)
check(pg.holds == [3.0], f"a hold > 3 s is clamped to 3 s ({pg.holds})")
# whole-segment retakes: a first beat that keeps failing -> held after 2 retakes, never A-roll, no events.json
w3 = TMP / "e3"
out, _ = rec(w3, FakePage(w3, fail_beats={"b1": 9}), media=FakeMedia())
doc = out["segments"][0]
check(doc["status"] == "held" and out["held"] and out["held"][0]["reason"] == "beat failed", f"held after the retakes: {doc}")
check("aroll" not in json.dumps(doc).lower().replace("a-roll", "aroll"), "never an A-roll stand-in")
check(not list((w3 / "seg-00").rglob("events.json")), "no events.json of a failed take survives")
# a wall -> a FRESH session after a cooldown
w3b = TMP / "e3b"
pa, pb_ = FakePage(w3b, inject_at=1), FakePage(w3b)
out, made = rec(w3b, [pa, pb_], media=FakeMedia())
check(out["segments"][0]["status"] == "ok" and made == [False, True], f"first wall -> a fresh session ({made})")

# the first-frame gate refuses a dirty opening and never records it
w3c = TMP / "e3c"
pc = FakePage(w3c, sidebar_stuck=True)
out, _ = rec(w3c, pc, media=FakeMedia())
check(out["segments"][0]["status"] == "held" and "sidebar" in out["segments"][0]["why"].lower(),
      f"an opening that never gets clean is held: {out['segments'][0]}")
check(not any(m.get("cmd") == "segment" for m in pc.sent), "nothing was recorded")
check(sum(1 for m in pc.sent if m.get("cmd") == "state") == 3, "the set-up was redone (3 tries)")

# ── 4. (d) no model acts on camera ──
src_a = (ROOT / "aieditor" / "agentrec.py").read_text()
src_r = (ROOT / "aieditor" / "recorder.py").read_text()
check(not hasattr(agentrec, "_agent_take") and "_agent_take" not in src_a + src_r, "_agent_take does not exist")
check(not hasattr(agentrec, "record_segment") and not hasattr(agentrec, "SYSTEM") and "llm.messages(" not in src_a,
      "agentrec.py is browser plumbing only (no prompt, no model call)")
real_messages = llm.messages
seen = []


def guarded(*a, **k):
    seen.append(llm.recording())
    if llm.recording():
        raise AssertionError("a model call while recording")
    return real_messages(*a, **k)


llm.messages = guarded
try:
    w4 = TMP / "e4"
    out, _ = rec(w4, FakePage(w4, fail_beats={"b4": 1}), media=FakeMedia())
    check(out["segments"][0]["status"] == "ok", "a full fake-session record_all succeeds with llm.messages refusing on camera")
    check(not seen, "and no model call was made at all")
finally:
    llm.messages = real_messages
s = agentrec.Session.__new__(agentrec.Session)
s._recording = False
s.recording = True
try:
    llm.messages("claude-sonnet-5-5", "s", "x", 10, job="j", purpose="on camera")
    check(False, "a call while recording goes through")
except llm.OnCameraCall:
    check(True, "")
s.recording = False

# ── 5. (e) the capped OFF-CAMERA repair agent ──
sent = []


def transport(usd_in_tokens):
    def t(body, stream, timeout):
        sent.append(body)
        return {"content": [{"type": "text", "text": '{"tool": "observe"}'}], "stop_reason": "end_turn",
                "usage": {"input_tokens": usd_in_tokens, "output_tokens": 0}}
    return t


llm.set_context(job="p7-job", workflow="creative", stage="graphics")
llm.TRANSPORT = transport(300_000)                    # Sonnet 5.5 $2/M in: $0.60 for one call
bud = R.RepairBudget(TMP / "budget.json")
sc = B.compile_segment(SEG, WORDS, PBX, 0)
pg = FakePage(TMP / "rp")
rp = R.repair_beat(pg, PBX, sc, sc["beats"][2], "assertion failed", bud, call=llm.messages)
check(not rp["ok"] and rp["capped"] == "beat" and len(sent) == 1, f"usage over $0.50 stops the repair of that beat: {rp}")
rows = [r for r in apiledger.rows() if str(r.get("purpose", "")).startswith("beat repair")]
check(rows and abs(rows[-1]["usd"] - 0.6) < 1e-6 and rows[-1]["job"] == "p7-job", f"charged to the API ledger: {rows}")
check(abs(bud.spent("b3") - 0.6) < 1e-6 and json.loads((TMP / "budget.json").read_text())["video_usd"] == 0.6, "and to the repair budget")
again = R.repair_beat(pg, PBX, sc, sc["beats"][2], "assertion failed", bud, call=llm.messages)
check(not again["ok"] and len(sent) == 1, "no further call for a beat over its cap")
bud2 = R.RepairBudget(beat_cap=0.5, video_cap=3.0)
for k in range(6):
    bud2.charge(f"x{k}", 0.5)
rp2 = R.repair_beat(pg, PBX, sc, sc["beats"][1], "failed", bud2, call=llm.messages)
check(not rp2["ok"] and rp2["capped"] == "video" and len(sent) == 1, f"the $3/video cap stops further repairs: {rp2}")
# a proposal: typed tools only, generation blocked, recompiled and passing the dry run
llm.TRANSPORT = None
replies = iter(['{"tool": "observe"}', '{"tool": "invent_selector", "params": {}}',
                '{"tool": "close_menus", "params": {}}',
                '{"propose": [{"action": "close_menus"}, {"action": "paste_prompt", "params": {"text": "two prompt"}}], "why": "a menu covered the box"}'])
asked = []


def fake_call(model, system, content, max_tokens, **k):
    asked.append(content)
    txt = next(replies)
    if '"close_menus"' in txt and "propose" not in txt:
        pages_[0].closed_for_repair = True
    return {"text": txt, "usd": 0.01}


w5 = TMP / "e5"
pages_ = [FakePage(w5, dry_fail={"b3": "a menu covers the message box"})]
out, _ = rec(w5, pages_[0], media=FakeMedia(), call=fake_call)
doc = out["segments"][0]
check(doc["status"] == "ok", f"repaired off camera, then recorded: {doc}")
rj = json.loads((w5 / "seg-00" / "repair.json").read_text())
check(rj["ok"] and rj["proposal"][-1]["action"] == "paste_prompt" and rj["beat"] == "b3", f"the proposal: {rj}")
check(any("refused: 'invent_selector'" in c for c in asked), "an action outside the playbook is refused (typed tools only)")
sc5 = json.loads((w5 / "seg-00" / "script.compiled.json").read_text())
check([b["id"] for b in sc5["beats"]][:4] == ["b1", "b2", "b3r0", "b3"] and sc5["beats"][2]["action"] == "close_menus",
      "the proposal was recompiled into the script (a close_menus beat before beat 3)")
cam = [p for p in pages_[0].played if p[0]]
check(any(p[1] == "b3r0" for p in cam), "the repaired step is part of the recorded take (code, not the agent)")
check(json.loads((w5 / "repair-budget.json").read_text())["video_usd"] == 0.04, "repair spend recorded per video")
# a repair that does not pass the dry run -> needs_primitive, held
w6 = TMP / "e6"
replies = iter(['{"give_up": "no playbook action opens that menu"}'])
out, _ = rec(w6, FakePage(w6, dry_fail={"b3": "no element"}), media=FakeMedia(), call=fake_call)
doc = out["segments"][0]
check(doc["status"] == "needs_primitive" and out["held"][0]["reason"] == "needs_primitive", f"repair failed -> held: {doc}")
check(not (w6 / "seg-00" / "rec").exists(), "nothing recorded for a beat that never passed rehearsal (never silently dropped)")

# ── 6. (f) an action not in the playbook -> needs_primitive, held, no A-roll stand-in ──
w7 = TMP / "e7"
bad = dict(SEG, beats=SEG["beats"][:2] + [beat("b3", "two", "type_slash_background")])
p7 = FakePage(w7)
out, _ = rec(w7, p7, plan_segs=[bad], media=FakeMedia())
doc = out["segments"][0]
check(doc["status"] == "needs_primitive" and doc["beats"][0]["beat"] == "b3" and doc["beats"][0]["status"] == "missing",
      f"needs_primitive: {doc}")
check(out["held"] and out["held"][0]["reason"] == "needs_primitive", "the job is held")
check(not p7.sent, "no browser action at all (compile refuses before the browser)")
check(not (w7 / "seg-00" / "rec").exists() and not (w7 / "blocks.json").exists(), "no recording, no A-roll block replaces it")
check("a-roll" not in json.dumps(doc).lower() and "aroll" not in json.dumps(doc).lower(), "the held doc names no A-roll fallback")
unproven = PB.playbook_copy("chatgpt")
out, _ = rec(TMP / "e8", FakePage(TMP / "e8"), playbooks={"chatgpt": unproven}, media=FakeMedia())
check(out["segments"][0]["status"] == "needs_primitive" and "replayed" in out["segments"][0]["why"],
      "an unproven playbook action (proven: false) is needs_primitive too")
# results not made off camera -> needs_asset, held (never generated live instead)
gen = dict(SEG, beats=SEG["beats"][:2] + [beat("b3", "two", "send")])
out, _ = rec(TMP / "e9", FakePage(TMP / "e9"), plan_segs=[gen], media=FakeMedia())
check(out["segments"][0]["status"] == "needs_asset" and out["held"][0]["reason"] == "needs_asset", f"needs_asset: {out['segments'][0]}")
assets = {"assets": [{"id": "seg00-b3-result", "kind": "app_generation", "status": "ready",
                      "source": {"chat_url": "https://chatgpt.com/c/abc"}}]}
w10 = TMP / "e10"
p10 = FakePage(w10)
out, _ = rec(w10, p10, plan_segs=[gen], media=FakeMedia(), assets=assets)
check(out["segments"][0]["status"] == "ok", f"with the result made off camera it records: {out['segments'][0]}")
cam = [p for p in p10.played if p[0]]
check(any(p[2] == "reveal" for p in cam), "the result is revealed (K2) in the take")
send_cam = [m["action"] for m in p10.sent if m.get("cmd") == "act" and m["action"].get("beat_id") == "b3" and m["action"]["type"] == "click"]
check(send_cam and all(a.get("press") is False for a in send_cam), "the send is a dry press (no generation on camera)")

# ── 7. the elastic assembler on frames (short-lived screencast-image containers) ──
IMAGE = config.SC_IMAGE


def docker_ok():
    if os.environ.get("AIEDITOR_SKIP_DOCKER") == "1" or not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0


def run_asm(d, *args):
    r = subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", "2", "--memory", "2g",
                        "-v", f"{ROOT / 'screencast'}:/s:ro", "-v", f"{d}:/d", "--entrypoint", "python3", IMAGE,
                        "/s/assemble.py", *args], capture_output=True, text=True, timeout=900)
    if r.returncode:
        raise RuntimeError(r.stderr[-600:])
    return r.stdout


note = ""
if docker_ok():
    d = TMP / "synth"
    d.mkdir()
    words_t = [3.0, 7.0, 11.5, 16.0]
    lates = [0.4, 1.2, 2.5, 0.8]                                        # presses recorded 0.4-2.5 s late
    presses = [round(a + b, 3) for a, b in zip(words_t, lates)]
    moves = [[p - 0.6, p - 0.1] for p in presses]                       # the cursor travels just before each press
    (d / "spec.json").write_text(json.dumps({"w": 320, "h": 180, "dur": 22.0, "moves": moves, "presses": presses}))
    run_asm(d, "synth", "/d/raw.mp4", "--spec", "/d/spec.json")
    run_asm(d, "motion", "/d/raw.mp4", "--out", "/d/motion.json")
    motion = json.loads((d / "motion.json").read_text())["motion"]
    fps = B.FPS
    anchors = [{"src": int(math.ceil(p * fps - 1e-6)), "want": int(round(w_ * fps)), "kind": "press", "beat": f"b{k}"}
               for k, (p, w_) in enumerate(zip(presses, words_t))]
    em = B.elastic_map(motion, anchors, int(round(20.0 * fps)))
    check(em["ok"], f"synthetic take: every press reachable with idle frames ({em['failures']})")
    idle = B.idle_frames(motion)
    check(all(idle[i] for i in em["dropped"] + em["duplicated"]), "every removed / repeated frame is below the motion threshold")
    check(all(motion[i] is not None and motion[i] < B.MOTION_THR for i in em["dropped"] + em["duplicated"]), "(measured on the take)")
    (d / "frames.json").write_text(json.dumps({"frames": em["frames"], "fps": fps}))
    run_asm(d, "render", "/d/raw.mp4", "--frames", "/d/frames.json", "--out", "/d/out.mp4")
    run_asm(d, "flashes", "/d/out.mp4", "--out", "/d/flashes.json")
    fl = json.loads((d / "flashes.json").read_text())["flashes"]
    check(len(fl) == 4, f"four presses in the re-timed clip ({fl})")
    for f, w_ in zip(fl, words_t):
        check(abs(f - round(w_ * fps)) <= 1, f"press frame {f} on its word frame {round(w_ * fps)} +-1")
    pr = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{d}:/d", "--entrypoint", "ffprobe", IMAGE,
                         "-v", "error", "-show_streams", "-of", "json", "/d/out.mp4"], capture_output=True, text=True)
    streams = json.loads(pr.stdout)["streams"]
    check([x["codec_type"] for x in streams] == ["video"], f"no audio stream produced ({[x['codec_type'] for x in streams]})")
    check(abs(int(streams[0].get("nb_frames", len(em["frames"]))) - len(em["frames"])) <= 1, "the clip has the mapped length")
    # map-only run on a SCRATCH COPY of the failed job's seg-01 (events + raw.mp4; the job is read only)
    job = Path("/opt/aieditor-work/jobs/factory-end-to-end-test-mac-rec-10082332-63de/edit-01/seg-01/rec")
    if (job / "raw.mp4").exists():
        s1 = TMP / "seg01"
        s1.mkdir()
        shutil.copy2(job / "raw.mp4", s1 / "raw.mp4")
        shutil.copy2(job / "events.json", s1 / "events.json")
        run_asm(s1, "motion", "/d/raw.mp4", "--out", "/d/motion.json")
        m1 = json.loads((s1 / "motion.json").read_text())["motion"]
        ev1 = json.loads((s1 / "events.json").read_text())
        cur = {int(round(c[0] * fps)): (c[1], c[2]) for c in ev1.get("cursor", []) if len(c) >= 3}
        # the agent's own 'at' was the word it tied each action to: those are the anchors it should have hit
        anc = [{"src": int(round(e.get("press", e["t"]) * fps)), "want": int(round(e["at"] * fps)), "kind": "press",
                "beat": f"{e['type']}@{e['at']}"} for e in ev1.get("events", [])
               if e.get("at") is not None and e.get("type") in ("click", "dblclick", "type", "drag")]
        em1 = B.elastic_map(m1, anc, int(round(ev1.get("end", len(m1) / fps) * fps)), cursor=[cur.get(i) for i in range(len(m1))])
        check(all(B.idle_frames(m1, [cur.get(i) for i in range(len(m1))])[i] for i in em1["dropped"] + em1["duplicated"]),
              "seg-01: only motionless frames would move")
        note = (f"; failed job seg-01 map-only: {sum(1 for a in em1['anchors'] if a['ok'])}/{len(em1['anchors'])} anchors "
                f"reachable ({em1['reachable']:.0%}), {len(em1['dropped'])} idle frames dropped, {len(em1['duplicated'])} repeated, "
                f"{sum(1 for x in B.idle_frames(m1) if x)}/{len(m1)} frames idle")
        print("  " + note[2:])
else:
    note = " (assembler frame checks skipped: no docker / image)"

print(f"test_recorder: {N} checks passed{note}")
