"""THE SELF-HEALING LAYER (aieditor/preflight.py + aieditor/drift.py + the data-driven first-frame allowances), offline:
fake pages (agent_rec.mjs protocol), fake model calls — nothing is sent anywhere, no browser, no generation.

Every failure of the 2026-10-10/11 test runs is pinned here (or in the test named by preflight.COVERAGE) with a fake
transport: the coverage table (docs/SELF-HEALING.md) lists failure → class → detector → repair → test.

Run: python3 tests/test_selfheal.py
"""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="selfheal-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
os.environ["AIEDITOR_API_LEDGER"] = str(TMP / "api.jsonl")
os.environ["AIEDITOR_HUMAN_PACE"] = "0"
os.environ["AIEDITOR_PROVEN_LIB"] = str(TMP / "proven.jsonl")          # never the real recent-proofs ledger
for k in ("AIEDITOR_GEN_LEDGER", "AIEDITOR_GEN_PRIOR", "ANTHROPIC_API_KEY", "AIEDITOR_API_JOB_CAP_USD",
          "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD", "AIEDITOR_API_PRIOR_JOB_USD"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import onboard, playbook as PB, producer  # noqa: E402

N = 0
PINNED = set()                       # coverage ids this file pins (checked against preflight.COVERAGE at the end)


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def pins(*ids):
    PINNED.update(ids)


# ── 1. a tool step's target is the OBJECT only; a proven step is reused (re-run 15, erase brush + "click send") ──
pins("B-target-clause")
for txt, want in [("highlight the napkin, and click the send button so it is highlighted as the selection", "the napkin"),
                  ("the blank front of the label", "the blank front of the label"),
                  ("brush over the napkin so it is highlighted", "the napkin"),
                  ("the napkin and click send", "the napkin"),
                  ("drag a box over the label then type the note", "the label"),
                  ("the coffee cup and the spoon", "the coffee cup and the spoon")]:
    got = onboard.object_phrase(txt)
    check(got == want, f"object_phrase({txt!r}) = {got!r}, want {want!r}")
ERASE = {"label": "Erase", "params": {"target": {"from": "narration"}},
         "steps": [{"action": "open_image_viewer"}, {"action": "viewer_erase"},
                   {"need": "in the image viewer's Erase mode, brush over {target} so it is highlighted as the selection",
                    "per_param": "target"}]}
cp = onboard.clean_tool_params(ERASE, {"target": "highlight the napkin, and click the send button so it is highlighted",
                                       "shape": "Square 1:1"})
check(cp == {"target": "the napkin", "shape": "Square 1:1"}, f"only narration params are cleaned: {cp}")


class _Ctx:
    def __init__(self, out, pb):
        self.out, self.app, self.pb = Path(out), "chatgpt", pb
        self.logs, self.image_chat, self.allowed_chats = [], None, set()

    def log(self, m):
        self.logs.append(m)

    def status(self, m):
        pass


pb0 = PB.playbook_copy("chatgpt")
pb0.setdefault("produce", {}).setdefault("tools", {})["erase"] = ERASE
pb0["actions"]["ob_viewer_erase_brush_napkin"] = {
    "kind": "drag", "label": "brush the napkin", "selectors": ["img"], "params": {}, "requires": [], "pre": [], "post": [],
    "intents": [], "typical_latency_s": 1.0, "generates": False, "proven": False,
    "source": "R14 P2 onboarding (per video): in the image viewer's Erase mode, brush over the napkin so it is highlighted "
              "as the selection", "video_proof": {"mode": "onboarded", "ok": 3, "n": 3}}
(TMP / "j1" / "preprod").mkdir(parents=True)
ctx = _Ctx(TMP / "j1" / "preprod", pb0)
pr = producer.Producer.__new__(producer.Producer)
pr.ctx, pr.spec = ctx, {"tools": {"erase": ERASE}}
pr.cur = {"source": {"chat": "https://chatgpt.com/c/job-made"}}
asked = []
_real = onboard.onboard_action
onboard.onboard_action = lambda *a, **k: asked.append(a[1]) or {"status": "failed", "why": "should not be asked"}
try:
    aid, why = pr.ensure_tool_action("erase", 2, ERASE["steps"][2],
                                     {"target": "highlight the napkin, and click the send button so it is highlighted as the selection"})
finally:
    onboard.onboard_action = _real
check(aid == "ob_viewer_erase_brush_napkin" and not why and not asked,
      f"the proven brush step is reused, nothing onboarded (no 'click send' need): {aid} {why} {asked}")
check(ctx.pb["produce"]["tool_actions"].get("erase.2.the_napkin") == "ob_viewer_erase_brush_napkin"
      or any(v == "ob_viewer_erase_brush_napkin" for v in ctx.pb["produce"]["tool_actions"].values()),
      "and remembered in this video's playbook")
# a new object for a DRAG step: the same proven brush serves it (its points are data at use time)
asked.clear()
onboard.onboard_action = lambda *a, **k: asked.append(a[1]) or {"status": "failed", "why": "x"}
try:
    aid2, _ = pr.ensure_tool_action("erase", 2, ERASE["steps"][2], {"target": "the spoon, then press send"})
finally:
    onboard.onboard_action = _real
check(aid2 == "ob_viewer_erase_brush_napkin" and not asked, "a drag step proven for this tool serves another object")
# a step that is NOT proven yet is onboarded with the OBJECT only in its need
pb1 = copy.deepcopy(pb0)
pb1["actions"].pop("ob_viewer_erase_brush_napkin")
pb1["produce"].pop("tool_actions", None)
ctx1 = _Ctx(TMP / "j1" / "preprod", pb1)
pr.ctx = ctx1
onboard.onboard_action = lambda *a, **k: asked.append(a[1]) or {"status": "failed", "why": "x"}
try:
    pr.ensure_tool_action("erase", 2, ERASE["steps"][2], {"target": "highlight the napkin, and click the send button"})
finally:
    onboard.onboard_action = _real
check(asked and "napkin" in asked[-1] and "send" not in asked[-1].lower().replace("selection", ""),
      f"the onboarded need names the object only: {asked[-1:]}")


# ── 2. first-frame allowances are DATA in the playbook (A: home-page suggestions, the logged-out view) ──
pins("A-home-suggestions", "A-outside-login-view", "A-safe-rules")
from aieditor import beatscript as B, recorder as R  # noqa: E402
FF = R._first_frame()
facts = {"text": "How can I help, Jake? Find the latest docs  Summarize recent emails",
         "dom": {"account": "Jake", "popups": 1, "popup_texts": ["Find the latest docs Summarize recent emails"], "dark": True}}
ok, why = FF.verdict_for(facts, {"asserts": []}, "Jake")
check(not ok and any("popup" in w for w in why), f"without data the suggestions fail the frame: {why}")
acc = []
ok, why = FF.verdict_for(facts, {"asserts": [], "allow": {"resting_texts": ["find the latest docs", "summarize recent"]}},
                         "Jake", accepted=acc)
check(ok and len(acc) == 2, f"with the playbook's resting_texts the same frame passes, both reasons logged: {why} {acc}")
check(FF.allowed("wall: login: Log in / Sign up", {"walls": ["login"]}) == "walls", "a login wall is the outside view")
for bad in ["account Keith, not Jake (C4)", "greeting to Keith, not Jake (C4: only Jake's own account)",
            "Work mode ('what should we work on') — RULEBOOK S7: Chat mode from the start", "composer not empty: 'x' (C3)",
            "history sidebar open (DOM)", "wall: challenge: Unusual activity", "1 attachment(s) left in the composer (S3)"]:
    check(FF.allowed(bad, {"reasons": [".*"], "resting_popups": 3, "walls": ["challenge", "login"]}) is None,
          f"a rule that protects Jake is never allowed away: {bad}")
check(FF.allowed("2 popup/menu/suggestion list open (S3)", {"resting_popups": 1}) is None
      and FF.allowed("1 popup/menu/suggestion list open (S3)", {"resting_popups": 1}) == "resting_popups",
      "resting_popups counts")


class Page:
    """A minimal agent_rec stand-in for the first frame + dismiss + the outside view."""

    def __init__(self, popup_texts=(), banner=False, wall=None, account="Jake"):
        self.popup_texts, self.banner, self.wall, self.account = list(popup_texts), banner, wall, account
        self.sent, self.url, self.name, self.workdir = [], "about:blank", None, None

    def send(self, m):
        self.sent.append(m)
        c = m.get("cmd")
        if c == "open":
            self.url = m["url"]
            return {"ok": True, "url": self.url, "wall": None}
        if c == "state":
            pops = list(self.popup_texts) + (["Try our new Pulse! Not now"] if self.banner else [])
            rest = m.get("resting") or []
            if "[data-testid=home-chips]" in rest:
                pops = [p for p in pops if "latest docs" not in p.lower()]
            return {"ok": True, "account": self.account, "h1": ["How can I help, Jake?"], "sidebar": False, "draft": "",
                    "attachments": 0, "popups": len(pops), "popup_texts": pops, "tooltips": 0, "mode": "chat",
                    "loading": False, "blank": False, "dark": True, "text": "How can I help, Jake? " + " ".join(pops),
                    "wall": self.wall, "shot": None, "fp": "f" * 16}
        if c == "act":
            a = m["action"]
            if a.get("type") == "click" and "Not now" in str(a.get("target") or a.get("selector") or ""):
                self.banner = False
            return {"ok": True}
        if c == "count":
            return {"ok": True, "n": 1}
        if c == "assert":
            return {"ok": True, "fail": []}
        return {"ok": True}

    def close(self):
        pass


PBX = PB.playbook_copy("chatgpt")
for _a in PBX["actions"].values():
    _a["proven"] = True
pg = Page(popup_texts=["Find the latest docs"], banner=True)
ss = {**copy.deepcopy(PBX["start_state"]), "asserts": [],
      "allow": {"resting_selectors": ["[data-testid=home-chips]"]},
      "dismiss": [{"type": "click", "target": "Not now"}]}
st = R.open_clean(pg, PBX, {"url": "https://chatgpt.com/"}, ss, log=lambda *a: None, pixels=False, tries=1)
check(st.get("popups") == 0 and not pg.banner, f"dismiss steps (data) close the new banner; resting selectors are not popups: {st.get('popups')}")
check(any(m.get("cmd") == "state" and m.get("resting") == ["[data-testid=home-chips]"] for m in pg.sent),
      "the resting selectors reach the page's state command")
# the compiled start state carries the playbook's allowances; the outside view always allows the login 'wall'
pbo = copy.deepcopy(PBX)
pbo["start_state"]["allow"] = {"resting_texts": ["find the latest docs"]}
pbo["start_state"]["dismiss"] = [{"type": "key", "key": "Escape"}]
W = [{"i": i, "word": w, "start": 1.0 + i * 0.5, "end": 1.3 + i * 0.5} for i, w in enumerate("so first I paste it now ok".split())]
segl = {"t0": 1.0, "t1": 5.0, "url": "https://chatgpt.com/", "app": "chatgpt", "session": "logged_in",
        "beats": [{"id": "b1", "word_id": 1, "t_word": 1.5, "word": "first", "action": "camera", "subject": "screen"}]}
sc = B.compile_segment(segl, W, pbo, 0)
check(sc["start_state"].get("allow", {}).get("resting_texts") == ["find the latest docs"]
      and sc["start_state"].get("dismiss"), f"compile carries allow + dismiss: {sc['start_state']}")
sco = B.compile_segment({**segl, "session": "outside", "url": "https://chatgpt.com/pricing"}, W, pbo, 0)
check("login" in (sco["start_state"].get("allow") or {}).get("walls", []), "the outside view allows the login view")
pgo = Page(wall={"kind": "login", "why": "Log in / Sign up"}, account="")
st = R.open_clean(pgo, pbo, {"url": "https://chatgpt.com/pricing"}, sco["start_state"], log=lambda *a: None, pixels=False,
                  tries=1, session="outside")
check(st is not None, "the logged-out pricing page is the view, not a login wall")


# ── 3. a control produced by the app's own reply waits for it (after_reply, data); then_skip (re-run 15, Logo) ──
pins("C-after-reply", "C-then-skip")


class SlowCard:
    """The Logo flow: after 'Try it' the app streams a reply; the brand-name card appears after a few checks."""
    polls = True

    def __init__(self, appear_after=3, busy=True):
        self.n, self.appear_after, self.busy_on, self.acts = 0, appear_after, busy, []
        self.t = self

    def send(self, m):
        c = m.get("cmd")
        if c == "count":
            if "placeholder" in m["selector"]:
                self.n += 1
                return {"n": 1 if self.n > self.appear_after else 0}
            return {"n": 1 if self.busy_on and "Stop" in m["selector"] and self.n <= self.appear_after else 0}
        if c == "text":
            return {"text": ""}
        if c == "open":
            return {"ok": True}
        if c == "act":
            self.acts.append(m["action"])
            ok = "Skip" not in str(m["action"].get("target")) or len(self.acts) < 3
            return {"ok": True} if ok else {"ok": False, "error": "no element"}
        return {"ok": True}

    def check(self, a):
        return PB.RecorderSession.check(self, a)

    def act(self, st):
        return PB.RecorderSession.act(self, st)

    def open(self, url):
        return True, None


pbl = PB.playbook_copy("chatgpt")
pbl["start_state"]["asserts"] = []
pbl["actions"]["ob_try_logo"] = {"kind": "click", "label": "Try it", "selectors": ["text=Try it"], "proven": True,
                                 "source": "test", "requires": [], "pre": [], "post": []}
pbl["actions"]["ob_logo_name"] = {"kind": "paste", "label": "brand name", "selectors": ['[placeholder^="Brand name"]'],
                                  "proven": False, "source": "test", "requires": ["ob_try_logo"],
                                  "pre": [{"kind": "selector", "selector": '[placeholder^="Brand name"]'}], "post": [],
                                  "params": {"text": {"type": "string", "default": "Ember"}}}
PB.AFTER_REPLY_S = 6.0
sess = SlowCard(appear_after=10)
ok, why = PB._run_once(sess, pbl, "ob_logo_name", {})
check(ok and pbl["actions"]["ob_logo_name"].get("after_reply"),
      f"the card appears after the reply: the pre check waited while the app was busy, and learned after_reply: {why}")
sess2 = SlowCard(appear_after=10, busy=False)
pbl["actions"]["ob_logo_name"].pop("after_reply")
ok2, why2 = PB._run_once(sess2, pbl, "ob_logo_name", {})
check(not ok2 and "pre: no element" in str(why2), "an idle page without the control still fails (no endless wait)")
pbl["actions"]["ob_logo_name"]["after_reply"] = True
sess3 = SlowCard(appear_after=10, busy=False)
ok3, _ = PB._run_once(sess3, pbl, "ob_logo_name", {})
check(ok3, "an action marked after_reply (data) waits for its control even when nothing looks busy")
pbl["actions"]["ob_logo_name"]["then_skip"] = {"texts": ["Skip"], "max": 2}
steps = PB.resolve(pbl, "ob_logo_name", {"text": "Ember"})
check([s_["type"] for s_ in steps] == ["type", "click", "click"] and all(s_.get("optional_step") for s_ in steps[1:]),
      f"then_skip adds optional Skip clicks after the name: {steps}")
sess4 = SlowCard()
check(all(PB.RecorderSession.act(sess4, s_)[0] for s_ in steps), "a Skip that is not there any more is not a failure")
check(not any("optional_step" in a for a in sess4.acts), "optional_step never reaches the page")
rest = PB.resolve(pbl, "ob_logo_name", {"text": "x"})
check(R.wire(rest[1], record=False).get("optional_step") is None, "nor the recorder's wire")
# onboarding: a chained step whose proofs all fail 'pre: no element' is proven again with the after-reply wait
pz = onboard.normalize_proposal({"kind": "paste", "label": "name", "selectors": ['[placeholder^="Brand name"]'],
                                 "after_reply": True, "then_skip": {"texts": ["Skip"], "max": 2, "evil": 1}}, pbl, "enter name")
check(pz[1].get("after_reply") is True and pz[1].get("then_skip") == {"texts": ["Skip"], "max": 2},
      "a proposal may carry after_reply / then_skip (data)")
logo = PB.playbook_copy("chatgpt")["produce"]["tools"]["logo_template"]["steps"][2]
check(logo.get("after_reply") and logo.get("then_skip"), "the shared Logo hint carries after_reply + then_skip")

print(f"test_selfheal: {N} checks passed")
