"""THE REHEARSAL AGENT (aieditor/rehearse.py) offline: a fake page (agent_rec.mjs protocol) and a fake model — nothing
is sent anywhere, no browser, no generation.

  1. an agent run → a valid script: stable selectors / exact labels, beat anchors on the words, his words verbatim,
     the generating press dry + the K2 reveal; the dead end (a menu opened and closed) is NOT in the script
  2. the guard refuses a forbidden click (Delete), an old chat, a rewritten prompt, an edit key — in code
  3. the caps: turns, $ per segment, escalation to the bigger model when stuck
  4. distill: a log with dead ends → the clean path; a clean path that fails its FRESH replay → distilled again
  5. the recording diverges → the agent repairs from the divergence point → recorded again
  6. 2 failures → a non-ok status → preflight.fallbacks lists the segment
  7. the switch off → the playbook path (no agent call); the preflight checks start states only in agent mode

Run: python3 tests/test_rehearse.py
"""
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="rehearse-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_API_LEDGER"] = str(TMP / "api.jsonl")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
os.environ["AIEDITOR_HUMAN_PACE"] = "0"
os.environ["AIEDITOR_REHEARSAL_HINTS"] = str(TMP / "hints.jsonl")
os.environ["AIEDITOR_GEN_LEDGER"] = str(TMP / "gen.jsonl")
for k in ("AIEDITOR_REHEARSAL", "AIEDITOR_GEN_PRIOR", "ANTHROPIC_API_KEY", "AIEDITOR_API_JOB_CAP_USD",
          "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD", "AIEDITOR_API_PRIOR_JOB_USD"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import beatscript as B, llm, playbook as PB, preflight, recorder as R, rehearse as RH  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


R.RETAKE_COOLDOWN_S = 0
R.WALL_COOLDOWN_S = 0
PROMPT = "a red bottle on a picnic table, golden hour"
CHAT = "https://chatgpt.com/c/job1"
WORDS = [{"i": i, "word": w, "start": round(10.0 + i * 0.5, 3), "end": round(10.3 + i * 0.5, 3)}
         for i, w in enumerate("so first I paste the prompt then I send it and open markup here to draw on it right now okay".split())]
VIDEO = {"words": WORDS, "duration": 30.0}
PBX = PB.playbook_copy("chatgpt")
for _a in PBX["actions"].values():
    _a["proven"] = True


def wt(word):
    return next(w for w in WORDS if w["word"] == word)


def beat(bid, word, action, **kw):
    w = wt(word)
    return {"id": bid, "word_id": w["i"], "t_word": w["start"], "word": word, "action": action, **kw}


SEG = {"t0": 10.0, "t1": 20.0, "url": "https://chatgpt.com/", "app": "chatgpt", "session": "logged_in",
       "beats": [beat("b1", "paste", "paste_prompt", typed_text=PROMPT, params={"text": PROMPT}),
                 beat("b2", "send", "send"),
                 beat("b3", "markup", "viewer_markup")]}


def assets():
    return {"assets": [{"id": "bottle", "kind": "app_generation", "status": "ready",
                        "source": {"chat_url": CHAT, "prompt": PROMPT}}]}


class Page:
    """agent_rec.mjs stand-in: a ChatGPT-like page. Refs: r1 composer, r2 Send, r3 Delete chat, r4 an OLD chat link,
    r5 More actions (opens a menu — the dead end), r6 the generated image (on the job's chat; opens the viewer),
    r7 the viewer toolbar's Markup (only while the viewer is open; Markup mode → 'Cancel markup')."""

    def __init__(self, workdir, fail_markup_rec=0):
        self.workdir = Path(workdir)
        self.account, self.name = "Jake", None
        self.url, self.composer, self.viewer, self.markup, self.menu = "about:blank", "", False, False, False
        self.fail_markup_rec = fail_markup_rec
        self.acts, self.rec, self._recording, self.t = [], None, False, 0.0
        self.pressed = []

    @property
    def recording(self):
        return self._recording

    @recording.setter
    def recording(self, on):
        self._recording = bool(on)
        llm.set_recording(self, self._recording)

    def els(self):
        out = [{"ref": "r1", "tag": "div", "text": "Ask anything", "sel": "#prompt-textarea", "box": [400, 600, 500, 40]},
               {"ref": "r2", "tag": "button", "text": "Send", "sel": 'button[aria-label="Send"]', "box": [910, 600, 30, 30]},
               {"ref": "r3", "tag": "button", "text": "Delete chat", "sel": 'button[aria-label="Delete chat"]', "box": [10, 10, 80, 20]},
               {"ref": "r4", "tag": "a", "text": "Old chat", "sel": 'a[href="/c/old123"]', "href": "https://chatgpt.com/c/old123",
                "box": [10, 100, 120, 20]},
               {"ref": "r5", "tag": "button", "text": "More actions", "sel": 'button[aria-label="More actions"]', "box": [1200, 10, 30, 30]}]
        if "/c/job1" in self.url:
            out.append({"ref": "r6", "tag": "img", "text": "Generated image", "sel": '[data-testid="generated-image-preview"]',
                        "box": [300, 150, 400, 400]})
        if self.viewer:
            out.append({"ref": "r7", "tag": "button", "text": "Markup", "sel": None, "box": [600, 40, 60, 24]})
        if self.menu:
            out.append({"ref": "r8", "tag": "div", "text": "Menu item", "sel": None, "box": [1100, 50, 100, 20]})
        return out

    def body(self):
        return ("How can I help, Jake? " + self.composer + (" Cancel markup" if self.markup else "")
                + (" Menu item" if self.menu else ""))

    def _fp(self):
        return hashlib.sha1(f"{self.url}|{self.composer}|{self.viewer}|{self.markup}|{self.menu}".encode()).hexdigest()[:16]

    def _find(self, a):
        els = self.els()
        if a.get("ref"):
            return next((e for e in els if e["ref"] == a["ref"]), None)
        if a.get("target"):
            t = a["target"].lower()
            return next((e for e in els if e["text"].lower() == t), None) or \
                (None if a.get("exact") else next((e for e in els if t in e["text"].lower()), None))
        if a.get("selector"):
            sel = a["selector"]
            if sel in ('[contenteditable="true"]', "textarea"):
                sel = "#prompt-textarea"
            return next((e for e in els if e["sel"] == sel), None)
        if a.get("x") is not None:
            x, y = a["x"] * 1.5, a["y"] * 1.5
            return next((e for e in els if e["box"][0] <= x <= e["box"][0] + e["box"][2] and e["box"][1] <= y <= e["box"][1] + e["box"][3]), None)
        return None

    def _goto(self, url):
        self.url, self.composer, self.viewer, self.markup, self.menu = url, "", False, False, False

    def send(self, m):
        c = m.get("cmd")
        if c == "open":
            self._goto(m["url"])
            return {"ok": True, "url": self.url}
        if c == "state":
            return {"ok": True, "account": "Jake", "h1": ["How can I help, Jake?"], "sidebar": False, "draft": self.composer,
                    "attachments": 0, "popups": 0, "tooltips": 0, "mode": "chat", "loading": False, "blank": False,
                    "dark": True, "text": self.body(), "wall": None, "shot": None, "url": self.url}
        if c == "fp":
            return {"ok": True, "fp": self._fp()}
        if c == "observe":
            return {"ok": True, "url": self.url, "f": 1.5, "shot": "",
                    "items": [{k: e[k] for k in ("ref", "tag", "text", "box")} for e in self.els()]}
        if c == "find":
            found = {}
            for t in m.get("texts") or []:
                hits = [e for e in self.els() if (e["text"].lower() == t.lower() if m.get("exact") else t.lower() in e["text"].lower())]
                found[t] = [{"tag": e["tag"], "text": e["text"], "box": e["box"],
                             "selector": e["sel"] or f'{e["tag"]}:has-text("{e["text"]}")'} for e in hits]
            return {"ok": True, "found": found}
        if c == "count":
            sel = m["selector"]
            if sel in ('[contenteditable="true"]',):
                return {"ok": True, "n": 1}
            return {"ok": True, "n": sum(1 for e in self.els() if e["sel"] == sel)}
        if c == "assert":
            fail = []
            for tx in m.get("present", []):
                if tx.lower() not in self.body().lower():
                    fail.append(f'missing "{tx}"')
            for tx in m.get("absent", []):
                if tx.lower() in self.body().lower():
                    fail.append(f'unexpected "{tx}"')
            if m.get("field_equals") is not None and self.composer != m["field_equals"]:
                fail.append(f"field {self.composer!r} != script")
            if m.get("field_empty") and self.composer:
                fail.append("field not empty")
            return {"ok": not fail, "fail": fail, "wall": None, "url": self.url}
        if c == "segment":
            self.rec = self.workdir / m["out"]
            self.rec.mkdir(parents=True, exist_ok=True)
            (self.rec / "raw.mp4").write_bytes(b"x")
            self.t0 = self.t = float(m.get("t0", 0.0))
            self.events = []
            self.recording = True
            return {"ok": True}
        if c == "abort":
            if self.rec:
                shutil.rmtree(self.rec, ignore_errors=True)
            self.rec = None
            self.recording = False
            return {"ok": True}
        if c == "end":
            if self.rec:
                (self.rec / "events.json").write_text(json.dumps({"t0": self.t0, "events": self.events, "walls": [],
                                                                  "cursor": [], "capture": {"fps": B.FPS}}))
                (self.rec / "privacy.json").write_text("[]")
            self.rec = None
            self.recording = False
            return {"ok": True}
        if c in ("guard", "reload"):
            return {"ok": True, "wall": None, "url": self.url}
        if c == "act":
            return self.act(m["action"])
        return {"ok": True}

    def act(self, a):
        self.acts.append((self.recording, dict(a)))
        ty = a.get("type")
        if self.recording and a.get("at") is not None:
            self.t = max(self.t, float(a["at"]))
            self.events.append({"t": self.t, "type": ty, "beat_id": a.get("beat_id"), "press": self.t})
        if ty in ("goto", "reveal"):
            self._goto(a.get("url") or self.url)
            return {"ok": True, "url": self.url}
        if ty == "key":
            if a.get("key") == "Escape":
                self.menu = False
            return {"ok": True, "url": self.url}
        if ty in ("wait_for", "read", "hold", "scroll"):
            return {"ok": True, "url": self.url}
        e = self._find(a)
        if ty == "type":
            if e is None or e["ref"] != "r1":
                return {"ok": False, "error": "no element for the field"}
            self.composer = a.get("text", "")
            return {"ok": True, "url": self.url, "resolved": {"hint": "#prompt-textarea", "label": "Ask anything"}}
        if ty == "click":
            if e is None:
                return {"ok": False, "error": f"no element for {a.get('target') or a.get('selector')}"}
            if self.recording and e["ref"] == "r7" and self.fail_markup_rec > 0:
                self.fail_markup_rec -= 1
                return {"ok": False, "error": "no element for Markup (a page glitch)"}
            self.pressed.append((e["text"], a.get("press", True)))
            if e["ref"] == "r5":
                self.menu = True
            elif e["ref"] == "r6":
                self.viewer = True
            elif e["ref"] == "r7":
                self.markup = True
            return {"ok": True, "url": self.url, "resolved": {"hint": e["sel"], "label": e["text"]}}
        return {"ok": True, "url": self.url}

    def close(self):
        pass


def act(*actions, note=""):
    return {"do": "act", "note": note, "actions": json.dumps(list(actions))}


def done(proof=None):
    return {"do": "beat_done", "note": "done", **({"proof_text": proof} if proof else {})}


FULL = [act({"type": "click", "ref": "r3"}, note="try delete"),                     # refused (guard)
        act({"type": "type", "ref": "r1", "text": "a blue bottle"}),               # refused (not verbatim)
        act({"type": "type", "ref": "r1"}),                                        # ok: code types his words
        done(),
        act({"type": "click", "ref": "r2"}), done(),                               # Send: a dry generating press
        act({"type": "click", "ref": "r6"}),                                       # open the image (needed)
        act({"type": "click", "ref": "r5"}),                                       # DEAD END: a menu
        act({"type": "key", "key": "Escape"}),                                     # … closed again
        act({"type": "click", "ref": "r7"}),                                       # the toolbar Markup
        done("Cancel markup")]


class Model:
    """The fake Claude: agent turns in order, distill answers in order (picked by step label)."""

    def __init__(self, turns, distills=None):
        self.turns, self.distills = list(turns), list(distills or [])
        self.calls, self.models, self.distill_inputs = 0, [], []

    def __call__(self, model, system, content, max_tokens, **kw):
        self.calls += 1
        self.models.append(model)
        if system == RH.DISTILL:
            self.distill_inputs.append(content)
            pick = self.distills.pop(0) if self.distills else None
            if pick is None:
                return {"text": "not json", "usd": 0.001}
            idx = []
            for line in content.split("TRIAL LOG:\n")[1].split("\n\n")[0].splitlines():
                i, _, rest = line.partition(": ")
                if any(p in rest for p in pick) and "FAILED" not in rest:
                    idx.append({"i": int(i), "why": "needed"})
            return {"text": json.dumps({"keep": idx, "note": "clean path"}), "usd": 0.002}
        t = self.turns.pop(0) if self.turns else {"do": "observe", "note": "nothing left"}
        return {"text": json.dumps(t), "usd": 0.01}


CLEAN = ["prompt-textarea", 'aria-label="Send"', "generated-image-preview", "text=Markup"]


def run(w, page, model, **kw):
    pages = page if isinstance(page, list) else [page]

    def new_session(app, kind, fresh):
        return pages.pop(0) if len(pages) > 1 else pages[0]
    return R.record_all({"segments": [copy.deepcopy(SEG)]}, {"chatgpt": copy.deepcopy(PBX)}, kw.pop("assets", None) or assets(),
                        w=w, video=VIDEO, new_session=new_session, log=lambda *a: None, sleep=lambda s: None,
                        pixels=False, rehearsal=kw.pop("rehearsal", "agent"), rehearse_call=model, **kw)


# ── 1+2+4. an agent run → a valid, clean script (guard refusals, verbatim, dead end distilled away) ──
w1 = TMP / "e1"
p1 = Page(w1)
m1 = Model(FULL, [CLEAN])
out = run(w1, p1, m1)
doc = out["segments"][0]
check(doc["status"] == "ok", f"the agent's script is recorded: {doc}")
sc = json.loads((w1 / "seg-00" / "script.compiled.json").read_text())
steps = [s for s in sc["steps"] if not s.get("camera_only")]
types = [s for s in steps if s["type"] == "type"]
check(len(types) == 1 and types[0]["text"] == PROMPT and types[0].get("selector") == "#prompt-textarea"
      and types[0]["paste"] and types[0]["clear"], f"his words typed verbatim, once, into a stable field selector: {types}")
send = [s for s in steps if s["type"] == "click" and s.get("selector") == 'button[aria-label="Send"]']
check(len(send) == 1 and send[0].get("press") is False and send[0].get("generates"), f"Send is a DRY press by its aria-label: {send}")
check(any(s["type"] == "reveal" and s.get("url") == CHAT for s in steps), "the result made off camera is revealed (K2)")
mk = [s for s in steps if s["type"] == "click" and s.get("target") == "Markup"]
check(len(mk) == 1 and mk[0].get("exact") is True and mk[0].get("x") is None, f"Markup by its EXACT label, never coordinates: {mk}")
img = [s for s in steps if s["type"] == "click" and s.get("selector") == '[data-testid="generated-image-preview"]']
check(len(img) == 1, "the needed 'open the image' step is kept by its data-testid")
check(not any("More actions" in json.dumps(s) or s.get("key") == "Escape" and s.get("beat") for s in steps),
      "the dead end (a menu opened and closed with Escape) is NOT in the recorded script")
agent_steps = [s for s in steps if ":ag_" in str(s.get("playbook")) and s["type"] != "reveal"]
check(len(agent_steps) == 4 and sorted(int(str(s["playbook"]).rsplit("_", 1)[1]) for s in agent_steps) == sorted(sc["rehearsal"]["kept"]),
      f"the script holds exactly the distilled steps the fresh replay needs — no more: {[s.get('playbook') for s in agent_steps]}")
for bid, word in (("b1", "paste"), ("b2", "send"), ("b3", "markup")):
    st = next(s for s in steps if s.get("beat_id") == bid and s.get("beat"))
    check(abs(st["word_t"] - (wt(word)["start"] - 10.0)) < 1e-6 and -0.15 <= st["at"] - st["word_t"] <= 0.0,
          f"beat {bid} anchored on its word '{word}': at {st['at']} word {st['word_t']}")
pre = [s for s in steps if s.get("beat_id") == "b3p0"]
rev = next(s for s in steps if s["type"] == "reveal")
check(pre and pre[0]["at"] > rev["at"], "a step of the next beat never goes before the previous result is revealed")
check(not any(t == "Delete chat" for t, _ in p1.pressed) and not any("Delete" in json.dumps(a) for _, a in p1.acts),
      "the guard refused Delete in code — it never reached the page")
log = json.loads((w1 / "seg-00" / "rehearsal-log.json").read_text())["passes"][0]["steps"]
check(any(s.get("refused", "").startswith("click guard") or "forbidden" in s.get("refused", "") for s in log),
      "the refused Delete is in the trial log (audit trail)")
check(any("VERBATIM" in s.get("refused", "") for s in log), "a rewritten prompt is refused (verbatim rule)")
check(any("More actions" in json.dumps(s["action"]) for s in log), "the dead end stays in the trial log")
check(m1.calls >= 12 and not any(a[0] and llm.recording() for a in p1.acts), "the agent works off camera only")
rec_acts = [a for r_, a in p1.acts if r_]
check(rec_acts and not any("More actions" in json.dumps(a) for a in rec_acts), "nothing of the dead end was recorded")
kept = json.loads((w1 / "seg-00" / "rehearsal-distill-1.json").read_text())
check(kept["replay"] == "ok" and kept["why"], "the distilled path proved itself in a fresh replay, each step with its reason")
hints = RH.hints_for("chatgpt")
check(any(any("More actions" in x["target"] for x in h.get("avoid") or []) for h in hints),
      f"the trial log becomes hints for the next video (what not to do): {hints}")

# the guard alone (code): an old chat, a Library page, pricing in a logged-in browser, an edit key, Enter, a private field
g = RH.Guard(PBX, "logged_in", [CHAT])
check(g.check({"type": "click", "ref": "r4"}, {"text": "Old chat", "href": "https://chatgpt.com/c/old123"}) is not None,
      "an old chat link is refused")
check(g.check({"type": "goto", "url": CHAT}) is None, "a chat this job created is allowed")
check(g.check({"type": "goto", "url": "https://chatgpt.com/library"}) is not None, "Jake's Library is refused")
check(g.check({"type": "goto", "url": "https://chatgpt.com/pricing"}) is not None, "pricing never in the logged-in browser")
check(RH.Guard(PBX, "outside").check({"type": "goto", "url": "https://chatgpt.com/pricing"}) is None, "pricing in the outside view")
check(g.check({"type": "key", "key": "Meta+a"}) and g.check({"type": "key", "key": "Enter"}), "edit keys and Enter are refused")
check(g.check({"type": "click", "target": "Upgrade plan"}) and g.check({"type": "click", "target": "Share"}), "deny words refused")
check(g.check({"type": "type", "ref": "r1"}, typed=None) is not None, "no typing in a beat without his words")
check(g.check({"type": "click", "selector": 'input[type="password"]'}) is not None, "a private field is refused")

# ── 3. the caps ──
os.environ["AIEDITOR_REHEARSAL_HINTS"] = str(TMP / "hints2.jsonl")
_rules = RH.rules


def patched(**kw):
    RH.rules = lambda: {**_rules(), **kw}


patched(max_turns_per_segment=3)
w3 = TMP / "e3"
m3 = Model([{"do": "observe"}] * 10)
d3 = run(w3, Page(w3), m3)["segments"][0]
check(d3["status"] == "rehearsal_failed" and "turn cap" in d3["why"] and m3.calls == 3,
      f"at most N turns per segment, then a non-ok status: {d3['status']} {d3['why']} calls={m3.calls}")
patched(segment_usd=0.0001)
w4 = TMP / "e4"
m4 = Model(FULL, [CLEAN])
d4 = run(w4, Page(w4), m4)["segments"][0]
check(d4["status"] == "rehearsal_capped" and m4.calls == 0, f"the $ cap per segment refuses before sending: {d4}")
patched(stuck_after=2)
w5 = TMP / "e5"
m5 = Model([act({"type": "click", "ref": "r3"}), act({"type": "click", "ref": "r99"})] + FULL[2:], [CLEAN])
d5 = run(w5, Page(w5), m5)["segments"][0]
check(d5["status"] == "ok" and m5.models[0] == "claude-sonnet-5-5" and "claude-opus-5-5" in m5.models,
      f"the cheaper model first, the bigger one only once stuck: {m5.models[:5]}")
RH.rules = _rules
b = RH.Budget(None, seg_cap=1.0, video_cap=1.5)
b.charge(0, 0.9)
b.charge(1, 0.5)
check(abs(b.room(1) - 0.1) < 1e-9 and abs(b.room(2) - 0.1) < 1e-9, "the per-video cap bounds every segment's room")

# ── 4. a clean path that fails its FRESH replay is distilled again with the failure (never the junk) ──
w6 = TMP / "e6"
m6 = Model(FULL, [["prompt-textarea", 'aria-label="Send"', "text=Markup"], CLEAN])
d6 = run(w6, Page(w6), m6)["segments"][0]
check(d6["status"] == "ok" and len(m6.distill_inputs) == 2 and "FAILED A FRESH REPLAY" in m6.distill_inputs[1],
      f"the replay caught a path that relied on a step it dropped → distilled again: {d6['status']}")
sc6 = json.loads((w6 / "seg-00" / "script.compiled.json").read_text())
check(not any("More actions" in json.dumps(s) for s in sc6["steps"]), "the re-distilled script still has no dead end")
check((w6 / "seg-00" / "rehearsal-distill-1.json").exists() and
      json.loads((w6 / "seg-00" / "rehearsal-distill-1.json").read_text())["replay"] != "ok", "the failed pick is kept as audit")
# the code rules alone (no usable distill answer): abandoned attempts and failed steps never enter the script
fake_run = {"steps": [{"i": 0, "beat": "b1", "action": {"type": "click", "selector": "#a"}, "ok": True},
                      {"i": 1, "beat": "b1", "action": {"type": "type", "selector": "#a", "text": "x"}, "ok": True},
                      {"i": 2, "beat": "b2", "action": {"type": "click", "target": "X"}, "ok": False, "error": "no element"},
                      {"i": 3, "beat": "b2", "action": {"type": "click", "target": "Y"}, "ok": True, "abandoned": True},
                      {"i": 4, "beat": "b2", "action": {"type": "click", "target": "Z"}, "ok": True}],
            "main": {"b1": 1, "b2": 4}}
k = RH.distill(fake_run, [{"id": "b1"}, {"id": "b2"}], call=lambda *a, **kw: {"text": "?", "usd": 0})
check(k["keep"] == [1, 4], f"code rules: no failed / abandoned step, no focus click before typing into the same field: {k}")
k2 = RH.distill(fake_run, [{"id": "b1"}, {"id": "b2"}],
                call=lambda *a, **kw: {"text": json.dumps({"keep": [{"i": 2}, {"i": 3}, {"i": 99}]}), "usd": 0})
check(k2["keep"] == [1, 4] and set(k2["forced"]) == {1, 4}, f"the model can keep only steps that worked; mains stay: {k2}")

# ── 5. the recording diverges → the agent repairs the script from that beat → recorded again ──
w7 = TMP / "e7"
p7 = Page(w7, fail_markup_rec=3)                        # the whole take + both single-beat retakes fail on Markup
m7 = Model(FULL + [act({"type": "click", "ref": "r6"}), act({"type": "click", "ref": "r7"}), done("Cancel markup")],
           [CLEAN, ["generated-image-preview", "text=Markup"]])
d7 = run(w7, p7, m7)["segments"][0]
check(d7["status"] == "ok" and d7["rehearsal"]["history"] and d7["rehearsal"]["history"][0]["stage"] == "record",
      f"a diverging recording → repaired off camera → recorded again: {d7.get('status')} {d7.get('rehearsal')}")
passes = json.loads((w7 / "seg-00" / "rehearsal-log.json").read_text())["passes"]
check(len(passes) == 2 and passes[1]["from_beat"] == "b3" and "diverged" in passes[1]["feedback"],
      f"the second agent pass starts at the divergence point: {[(p['from_beat'], p['feedback']) for p in passes]}")

# ── 6. 2 failures → a non-ok status → the approved fallback takes over (never a silent drop, never a crash) ──
w8 = TMP / "e8"
p8 = Page(w8, fail_markup_rec=99)
m8 = Model(FULL + [act({"type": "click", "ref": "r6"}), act({"type": "click", "ref": "r7"}), done("Cancel markup")] * 3,
           [CLEAN, ["generated-image-preview", "text=Markup"]] * 2)
o8 = run(w8, p8, m8)
d8 = o8["segments"][0]
check(d8["status"] not in ("ok", "crashed") and o8["held"], f"2 failures → non-ok, held with a reason: {d8['status']}")
check(len(d8["rehearsal"]["history"]) == 2, f"exactly 2 attempts: {d8['rehearsal']['history']}")
evs, rows = preflight.fallbacks([SEG], {0: d8}, assets(), VIDEO, out_dir=w8, log=lambda *a: None)
check(rows and rows[0]["screencast"] == 1 and rows[0]["fallback"], f"the segment falls back, logged: {rows}")

# ── 7. the switch: off → the playbook path, no agent call; mode() reads env / rules ──
w9 = TMP / "e9"
m9 = Model(FULL, [CLEAN])
seg_pb = copy.deepcopy(SEG)
seg_pb["beats"] = [SEG["beats"][0]]
d9 = R.record_all({"segments": [seg_pb]}, {"chatgpt": copy.deepcopy(PBX)}, assets(), w=w9, video=VIDEO,
                  new_session=lambda *a: Page(w9), log=lambda *a: None, sleep=lambda s: None, pixels=False,
                  rehearsal="playbook", rehearse_call=m9)
check(d9["segments"][0]["status"] == "ok" and m9.calls == 0 and not (w9 / "seg-00" / "rehearsal-log.json").exists(),
      f"the switch off: the compiled playbook path, no agent: {d9['segments'][0]}")
os.environ["AIEDITOR_REHEARSAL"] = "playbook"
check(RH.mode() == "playbook", "env playbook → the old path")
os.environ["AIEDITOR_REHEARSAL"] = "agent"
check(RH.mode() == "agent", "env agent → the agent")
os.environ.pop("AIEDITOR_REHEARSAL")
check(RH.mode() == "agent", "default (rules.json rehearsal.mode) → the agent")
src = (ROOT / "aieditor" / "longedit.py").read_text()
check("rehearsal=rehearse.mode()" in src and src.count("rehearse.mode()") >= 2,
      "the factory path (longedit) passes the switch to the recorder AND the preflight")

# the preflight in agent mode: the start state only, never the beats twice
wp = TMP / "pf"
pp = Page(wp)
pf = preflight.RecordingPreflight(wp, [copy.deepcopy(SEG)], {"chatgpt": copy.deepcopy(PBX)}, assets(), WORDS,
                                  lambda *a: pp, log=lambda *a: None, pixels=False, rehearsal="agent")
rep = pf.run()
check(rep["segments"]["0"]["ok"] and rep["segments"]["0"]["stage"] == "first_frame"
      and not any(a.get("beat_id") for _, a in pp.acts), f"agent mode: the preflight proves the start state only: {rep['segments']}")

# run 20: 33 screencasts on the same opening screen → ONE check in agent mode, the rest share its verdict; progress shown
wp2 = TMP / "pf2"
pp2 = Page(wp2)
_checked, _prog = [], []
pf2 = preflight.RecordingPreflight(wp2, [copy.deepcopy(SEG) for _ in range(5)], {"chatgpt": copy.deepcopy(PBX)}, assets(),
                                   WORDS, lambda *a: pp2, log=lambda *a: None, pixels=False, rehearsal="agent")
_orig_cs = pf2._check_start
pf2._check_start = lambda i, seg, pb: (_checked.append(i), _orig_cs(i, seg, pb))[1]
pf2.progress = _prog.append
rep2 = pf2.run()
check(_checked == [0] and all(rep2["segments"][str(i)]["ok"] for i in range(5)) and _prog,
      f"agent mode: one opening-screen check per distinct start state, shared by the rest: {_checked} {_prog}")

# a crash in one segment never ends the video (record_all's wrapper holds; the agent path raises nothing else)
w10 = TMP / "e10"


class Boom(Page):
    def send(self, m):
        if m.get("cmd") == "observe":
            raise BrokenPipeError(32, "Broken pipe")
        return super().send(m)


o10 = run(w10, Boom(w10), Model(FULL, [CLEAN]))
check(o10["segments"][0]["status"] == "crashed" and o10["held"], "an exception in the agent path → crashed + fallback")

# run 20: a brush stroke over the viewer picture is not refused for words in the panel around it ('Share', the hint)
from aieditor import playbook as _pbm  # noqa: E402
_g20 = RH.Guard(_pbm.load("chatgpt"), "logged_in", [])
check(_g20.check({"type": "drag", "ref": "r40", "from": [1, 1], "to": [2, 2]},
                 {"text": "53% Share Brush over what you want to remove Send", "tag": "div"}) is None,
      "a drag over a surface is judged on what it names, not the panel's text")
check(_g20.check({"type": "click", "ref": "r9"}, {"text": "Share", "tag": "button"}) is not None, "a click on Share is still refused")
# run 20: two pictures share the label "Generated image 1" — LIVE the agent's own element (ref) is pressed, and an
# ambiguous label is never the script's stable target
_src_rh = (ROOT / "aieditor" / "rehearse.py").read_text()
check('wire["ref"] = a["ref"]' in _src_rh and "len(hits) <= 1" in _src_rh,
      "live presses use the agent's ref; a label is a stable target only when unique")
# run 20: a screencast that continues on a picture the video already made OPENS on that picture's job chat
_as = {"assets": [{"id": "pic", "status": "ready", "source": {"chat_url": "https://chatgpt.com/c/job-pic"}}]}
_pbs = {"start_state": {"url": "https://chatgpt.com/", "asserts": []}, "set_dressing": ["new_chat", "chat_mode", "hide_sidebar"]}
_seg_pic = {"app": "chatgpt", "session": "logged_in", "beats": [
    {"t_word": 1.0, "action": "camera.zoom", "asset_id": "pic"}, {"t_word": 2.0, "action": "open_image_viewer", "asset_id": "pic"}]}
_ss = B.start_state_for(_seg_pic, _pbs, _as)
check(_ss["url"] == "https://chatgpt.com/c/job-pic" and "new_chat" not in _ss["set_dressing"]
      and "hide_sidebar" in _ss["set_dressing"], f"a picture's segment opens on its job chat, never 'new chat': {_ss}")
_seg_type = {"app": "chatgpt", "session": "logged_in", "beats": [
    {"t_word": 1.0, "action": "paste_prompt", "params": {"text": "a bottle"}}, {"t_word": 2.0, "action": "x", "asset_id": "pic"}]}
check(B.start_state_for(_seg_type, _pbs, _as)["url"] == "https://chatgpt.com/", "a segment that types first starts on home")
# run 20: a mode chip in the composer is not draft text, and key presses during recording tick the clock
_src_ar = (ROOT / "screencast" / "agent_rec.mjs").read_text()
check('[contenteditable="false"], button, [role="button"]' in _src_ar and "async function keyTicking" in _src_ar
      and "await keyTicking(() => pressCombo(combo))" in _src_ar, "chip-aware field text + ticking key presses on camera")
print(f"test_rehearse: {N} checks passed")
