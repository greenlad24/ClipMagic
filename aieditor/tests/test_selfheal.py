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
# re-run 16: ChatGPT's suggestion chips ROTATE per load — the group is accepted by its count, not 3 fixed texts
from aieditor import drift as DR  # noqa: E402
rs = ["popup / suggestion list on screen ('Prep me for my next') — S3", "4 popup/menu/suggestion list open (S3)"]
pt = DR.to_patch({"verdict": "resting_ui", "resting_texts": ["Summarize recent Notion updates across my workspace."],
                  "reasons": ["The 4 detected popups are one list container plus 3 suggestion chips."]}, rs)
check(pt["verdict"] == "resting_ui" and pt["allow"].get("resting_popups") == 4 and "reasons" not in pt["allow"]
      and any("matches none" in str(x) for x in pt["refused"]), f"count from the cluster, prose reasons refused: {pt}")
facts = {"dom": {"popups": 4, "popup_texts": ["Prep me for my next meeting.", "Find emails I can unsubscribe from",
                                              "Summarize recent Notion updates across my workspace."]}}
check(FF.allowed(rs[0], pt["allow"], facts) == "resting_popups" and FF.allowed(rs[1], pt["allow"], facts) == "resting_popups",
      "another chip text on the next load is accepted within the proven count")
facts5 = {"dom": {"popups": 5, "popup_texts": []}}
check(FF.allowed(rs[0], pt["allow"], facts5) is None, "one popup more than the resting group (an open menu) still fails")
check(FF.allowed(rs[0], pt["allow"], {"dom": {"popups": 2, "popup_texts": ["Copy", "Share"]}}) is None,
      "a menu with none of the group's texts still fails")


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


# ── 4. THE PREFLIGHT: rehearse off camera, cluster, a systematic drift → the repair agent → data → proven on 2 ──
pins("A-new-popup", "A-moved-control", "A-real-problem")
from aieditor import drift, preflight  # noqa: E402

NEW_COMPOSER = "#composer-2026"


class DriftPage(Page):
    """The app after a UI change: new resting suggestions / a new banner / a moved composer / a challenge."""

    def __init__(self, popup_texts=(), banner=False, moved=False, wall=None):
        super().__init__(popup_texts=popup_texts, banner=banner, wall=wall)
        self.moved, self.banner_always = moved, banner

    def send(self, m):
        if m.get("cmd") == "open" and self.banner_always:
            self.banner = True                          # the banner is back on every fresh load
        if m.get("cmd") == "act" and m["action"].get("type") == "type" and self.moved \
                and m["action"].get("selector") != NEW_COMPOSER:
            self.sent.append(m)
            return {"ok": False, "error": "no element for the target"}
        if m.get("cmd") == "observe":
            return {"ok": True, "url": self.url, "items": [{"ref": "r1", "tag": "div", "text": "Find the latest docs",
                                                             "box": [400, 600, 300, 40]}], "shot": None}
        if m.get("cmd") == "find":
            return {"ok": True, "found": {t: [] for t in m.get("texts", [])}}
        return super().send(m)


def plan_segs(n=3, prompt=True):
    out = []
    for i in range(n):
        t0 = 1.0 + i * 1.0
        bts = [{"id": f"s{i}b0", "word_id": 1, "t_word": t0 + 0.1, "word": "first", "action": "camera", "subject": "screen"}]
        if prompt:
            bts.append({"id": f"s{i}b1", "word_id": 3, "t_word": t0 + 0.5, "word": "paste", "action": "paste_prompt",
                        "params": {"text": f"make a poster number {i} for my hot sauce stall"}})
        out.append({"t0": t0, "t1": t0 + 0.9, "url": "https://chatgpt.com/", "app": "chatgpt", "session": "logged_in",
                    "beats": bts})
    return out


W2 = [{"i": i, "word": w, "start": 1.0 + i * 0.2, "end": 1.15 + i * 0.2} for i, w in
      enumerate("so first I paste it here and then the next one and the last one now ok".split())]


def fake_agent(turns):
    seq = list(turns)
    calls = []

    def f(model, system, content, max_tokens, **kw):
        calls.append(kw.get("purpose"))
        t = seq.pop(0) if seq else {"do": "decide", "note": "give up", "decision": json.dumps({"verdict": "real_problem"})}
        return {"text": json.dumps(t), "usd": 0.04}
    f.calls = calls
    return f


def run_pf(page, turns, reonboard=None, pb=None):
    saved = {}
    pf = preflight.RecordingPreflight(TMP / f"pf{len(os.listdir(TMP))}", plan_segs(), {"chatgpt": copy.deepcopy(pb or PBX)},
                                      {"assets": []}, W2, lambda app, kind, fresh: page,
                                      repairer=drift.Repairer(call=fake_agent(turns), log=lambda *a: None),
                                      reonboard=reonboard, save_pb=lambda app, p_: saved.update({app: p_}),
                                      log=lambda *a: None, pixels=False)
    return pf.run(), saved


# (a) resting UI: the new home suggestions fail all 3 screencasts → ONE systematic cluster → allowance → proven
pg = DriftPage(popup_texts=["Find the latest docs Summarize recent emails"])
rep, saved = run_pf(pg, [{"do": "observe", "note": "look"},
                         {"do": "decide", "note": "chips under the composer are the new resting home page",
                          "decision": json.dumps({"verdict": "resting_ui", "resting_texts": ["Find the latest docs"],
                                                  "why": "home-page suggestion chips"})}])
cl = rep["clusters"][0]
check(cl["systematic"] and cl["cls"] == "A" and len(cl["segments"]) == 3, f"one systematic A cluster on 3 screencasts: {cl}")
check(rep["repairs"][0]["accepted"] and rep["repairs"][0]["verdict"] == "resting_ui", f"repair accepted: {rep['repairs']}")
check(len(rep["repairs"][0]["proofs"]) == 2 and all(p_["ok"] for p_ in rep["repairs"][0]["proofs"]), "proven on 2 screencasts")
check(saved["chatgpt"]["start_state"]["allow"]["resting_texts"] == ["Find the latest docs"]
      and saved["chatgpt"]["start_state"]["allow"]["learned"], "the fix is DATA in this video's playbook (with its trail)")
check(not rep["failed"], f"after the repair every screencast rehearses clean: {rep['failed']}")
check("allow" not in PBX["start_state"], "the shared playbook is untouched")
# (b) a new banner → dismiss steps (data), refused if it would press something unsafe
pg = DriftPage(banner=True)
rep, saved = run_pf(pg, [{"do": "act", "note": "close it", "action": json.dumps({"type": "click", "target": "Not now"})},
                         {"do": "decide", "note": "a banner", "decision": json.dumps(
                             {"verdict": "dismiss", "dismiss": [{"type": "click", "target": "Not now"},
                                                                {"type": "click", "target": "Upgrade plan"},
                                                                {"type": "key", "key": "Enter"}]})}])
check(rep["repairs"][0]["accepted"] and saved["chatgpt"]["start_state"]["dismiss"] == [{"type": "click", "target": "Not now"}],
      f"the dismiss step is data; 'Upgrade plan' and Enter are refused: {saved.get('chatgpt', {}).get('start_state', {}).get('dismiss')}")
kept, refused = drift.safe_dismiss([{"type": "click", "target": "Log out"}, {"type": "click", "target": "Delete chat"},
                                    {"type": "click", "selector": "button.close"}])
check(len(kept) == 1 and len(refused) == 2, f"log out / delete never become dismiss steps: {refused}")
# (c) a moved control: every paste fails 'no element' → moved_control → re-onboarded (fake) → proven
pg = DriftPage(moved=True)


def reon(app, ro, pb):
    new = copy.deepcopy(pb)
    new["actions"]["paste_prompt"]["selectors"] = [NEW_COMPOSER]
    reon.need = ro["need"]
    return new


rep, saved = run_pf(pg, [{"do": "count", "note": "composer?", "texts": ['[contenteditable="true"]']},
                         {"do": "decide", "note": "moved", "decision": json.dumps(
                             {"verdict": "moved_control", "action_id": "paste_prompt",
                              "need": "type the prompt into the message box"})}], reonboard=reon)
check(rep["clusters"][0]["stage"] == "beat" and rep["repairs"][0]["accepted"]
      and saved["chatgpt"]["actions"]["paste_prompt"]["selectors"] == [NEW_COMPOSER],
      f"the moved composer is re-onboarded for this video and proven: {rep['repairs']}")
# (d) a real problem: a challenge on every screencast — never accepted, even if the agent says 'resting_ui'
pg = DriftPage(wall={"kind": "challenge", "why": "Verify you are human"})
rep, saved = run_pf(pg, [{"do": "decide", "note": "accept it", "decision": json.dumps(
    {"verdict": "resting_ui", "reasons": [".*"], "walls": ["challenge"]})}])
check(not rep["repairs"][0]["accepted"] and rep["repairs"][0]["verdict"] == "real_problem" and not saved,
      f"a challenge is never allowed away: {rep['repairs']}")
check(sorted(rep["systematic_unrepaired"]) == [0, 1, 2], "its screencasts go to the fallback, listed")
# a fix that does not hold on 2 screencasts is reverted
pg = DriftPage(popup_texts=["Find the latest docs"])
rep, saved = run_pf(pg, [{"do": "decide", "note": "wrong text", "decision": json.dumps(
    {"verdict": "resting_ui", "resting_texts": ["something else entirely"]})}])
check(not rep["repairs"][0]["accepted"] and not saved and "reverted" in rep["repairs"][0]["why"], "unproven → reverted")
# clustering + classes
cls = preflight.cluster([{"seg": 0, "stage": "first_frame", "reason": "popup / suggestion list on screen ('a b') — S3"},
                         {"seg": 1, "stage": "first_frame", "reason": "popup / suggestion list on screen ('c') — S3"},
                         {"seg": 2, "stage": "beat", "reason": "type failed: no element"}])
check(cls[0]["systematic"] and len(cls[0]["segments"]) == 2 and not cls[1]["systematic"],
      "the same reason with other quoted texts is one cluster; a single failure is a segment problem")
check(preflight.classify("needs_asset: x", "assets") == "B" and preflight.classify("API cap: daily") == "D"
      and preflight.classify("drag needs from/to [x, y]") == "C", "classes")


# ── 5. NO SILENT DROPS: a screencast still not recorded → an approved motion template (+ the real result), listed ──
pins("D-silent-drop")
from aieditor import motiontemplates as MT  # noqa: E402
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
(TMP / "res.png").write_bytes(PNG)
VID = {"words": W2, "duration": 30.0}
segs = plan_segs(3)
segs[1]["beats"].append({"id": "s1b2", "word_id": 5, "t_word": 2.8, "word": "and", "action": "reveal_result",
                         "params": {"asset": "poster"}})
segs[2]["beats"] = segs[2]["beats"][:1]                         # a camera-only step: no prompt, no result
assets = {"assets": [{"id": "poster", "status": "ready", "file": str(TMP / "res.png"), "desc": "the poster"}]}
recs = {0: {"status": "held", "why": "beat failed 3 takes"}, 1: {"status": "preflight", "why": "systematic drift"},
        2: {"status": "needs_primitive", "why": "x"}}
evs, rows = preflight.fallbacks(segs, recs, assets, VID, out_dir=TMP / "fb", log=lambda *a: None)
check(len(rows) == 3 and all(r["why"] for r in rows), f"every screencast that was not recorded is listed: {rows}")
t = {r["screencast"]: r["template"] for r in rows}
if MT.is_on("prompt_result"):
    check(t[2] == "prompt_result" and any(e["params"].get("result") for e in evs if e["template"] == "prompt_result"),
          f"a step with a real result → prompt → result with the REAL picture: {t}")
check(t[1] in ("prompt_highlight", "long_prompt_scroll") or not MT.is_on("prompt_highlight"),
      f"a typed step → the app's prompt box (MO06/MO07): {t}")
check(t[3] is None and "presenter" in rows[2]["fallback"], "no template fits → the presenter, logged as such (never silent)")
check(json.loads((TMP / "fb" / "fallbacks.json").read_text())["fallbacks"] == rows, "fallbacks.json")
check(all(e.get("fallback") and e["t1"] > e["t0"] for e in evs), "each fallback event is marked and timed")
import importlib.machinery, importlib.util  # noqa: E402
_ld = importlib.machinery.SourceFileLoader("aieditor_worker", str(ROOT / "bin" / "aieditor-worker"))
_spec = importlib.util.spec_from_loader("aieditor_worker", _ld)
WK = importlib.util.module_from_spec(_spec)
_ld.exec_module(WK)
(TMP / "job" / "edit-01").mkdir(parents=True)
(TMP / "job" / "edit-01" / "fallbacks.json").write_text(json.dumps({"fallbacks": rows}))
pins("D-finish-mode")
check(WK.finish_mode({"finish_video": True}) and not WK.finish_mode({}), "finish mode is request.json finish_video")
check(len(WK.fallback_rows(TMP / "job")) == 3 and WK.fallback_rows(TMP / "job")[0]["edit"] == "edit-01",
      "the worker lists every fallback in the job's warnings")


# ── 6. B: the asset audit — by code, before reuse; an unfit picture is set aside and made again ──
pins("B-verbatim", "B-object-list", "B-one-line", "B-merge-sources", "B-collage", "B-tool-not-tool", "B-wrong-tool")
SP = ["Use this exact bottle. Put it on a rustic kitchen counter beside fresh chillies, morning light through a window."]
TOOLS = PB.playbook_copy("chatgpt")["produce"]["tools"]


def tool_of(d):
    pr_ = producer.Producer.__new__(producer.Producer)
    pr_.spec = {"tools": TOOLS}
    return pr_.tool_of(d)


def rules(row):
    return [x["rule"] for x in preflight.audit_asset({"status": "ready", **row}, SP, tool_of, TOOLS)]


check(rules({"desc": "result", "source": {"prompt": "Use this exact bottle in a single-line prompt naming all objects: "
                                                    "bottle, glass, wood"}}) == ["verbatim"], "his words rewritten → verbatim")
check(rules({"desc": "result", "source": {"prompt": "use this exact bottle, put it on a rustic kitchen counter besides "
                                                    "fresh chili, morning light through the window"}}) == [],
      "a spoken variant of his words is not a rewrite")
check(rules({"desc": "x", "source": {"prompt": "Turn this into a photo, with a wood clearly visible, with a glass clearly "
                                               "visible, with a label clearly visible"}}) == ["object_list"],
      "the manifest's object list typed → object_list (TEST v3 re-run 3)")
check(rules({"desc": "x", "source": {"prompt": "in-app result: phone-photo bottle on a rustic kitchen counter"}}) == ["internal"],
      "internal words typed (rerun_a, found by the audit on TEST v3's stored assets)")
check(rules({"desc": "x", "source": {"prompt": "a bottle\non a table"}}) == ["one_line"], "a newline in a typed prompt")
check(rules({"desc": "Three source photos and the merged result", "made_from": ["phone_photo"],
             "source": {"prompt": "Merge these three photos"}}) == ["merge_sources"], "a merge with one source")
check(rules({"desc": "x", "source": {"prompt": "A composite view showing three source photos side by side within a clean "
                                               "app interface layout"}}) == ["collage"], "a fake collage asked (re-run 8)")
check(rules({"desc": "x", "source": {"prompt": "A photo of a bottle. No text, captions, borders or collage panels."}}) == [],
      "'No … collage panels' is not a collage request")
check(rules({"desc": "Markup result: chili on the label", "made_from": [], "source": {
    "prompt": "Add a chili", "via": "agent", "recipe": "plain_chat", "tool": "markup"}}) == ["tool_not_tool"],
      "a markup result made as a new picture → tool_not_tool (markup_pepper)")
check(rules({"desc": "Comment result", "made_from": ["sketch_photo"], "source": {
    "prompt": "Drop this sun lower", "via": "fallback", "recipe": "produce_edit", "tool": "comment",
    "fallback": "described edit"}}) == ["tool_not_tool"], "a described edit → tool_not_tool (comment_result)")
check(rules({"desc": "Resize result: same bottle cutout", "made_from": ["bg_cutout"], "source": {
    "prompt": "", "via": "tool", "recipe": "produce_edit:remove_bg", "tool": "remove_bg"}}) == ["wrong_tool"],
      "'Resize result' made with Remove BG → wrong_tool (re-run 13)")
check(rules({"desc": "Resize result: tall story", "made_from": ["bg_cutout"], "source": {
    "prompt": "", "via": "tool", "recipe": "produce_edit:resize", "tool": "resize"}}) == [], "a real tool result passes")
out_ = TMP / "aud" / "preprod"
(out_ / "assets").mkdir(parents=True)
(out_ / "assets" / "rerun_a.produced.json").write_text("{}")
(out_ / "assets" / "rerun_a.png").write_bytes(PNG)
found = preflight.audit_assets(out_, {"assets": [{"id": "rerun_a", "status": "ready", "desc": "x", "source": {
    "prompt": "in-app result: x"}}]}, log=lambda *a: None)
check(found and not (out_ / "assets" / "rerun_a.produced.json").exists()
      and len(list((out_ / "assets").glob("rerun_a.*.set-aside-*"))) == 2 and not list((out_ / "assets").glob("*.produced.json")), "set aside: kept (renamed), never deleted")
# reuse_ok runs the audit first: a stored row that fails it is never reused
ctx_r = _Ctx(out_, PBX)
ctx_r.script = 'THE PROMPT: "Use this exact bottle. Put it on a rustic kitchen counter beside fresh chillies."'
ctx_r.producer, ctx_r.check = None, None
check(onboard.reuse_ok(ctx_r, "rerun_b", {"status": "ready", "desc": "x", "source": {"prompt": "in-app result: x"},
                                          "fidelity": {"v": 99, "look_ok": True, "clean": True}}) is False,
      "a stored row that fails the audit is not reused, even with a good fidelity record")


# ── 7. C: onboarding / proof gaps (fake transports) ──
pins("C-points-text", "C-undeclared-points", "C-strokes", "C-chained-requires", "C-confirm-presence", "C-no-such-step",
     "C-guessed-flow", "C-requires-param", "A-chat-wont-load", "A-library", "B-overlay-hidden", "B-duplicate-asset",
     "D-camera-as-feature")
d_ = onboard.norm_points({"rel_from": "0.3, 0.4", "rel_to": "[0.6,0.7]", "at": {"x": 1, "y": 2}})
check(d_ == {"rel_from": [0.3, 0.4], "rel_to": [0.6, 0.7], "at": [1.0, 2.0]}, f"points written as text → numbers: {d_}")
pbd = PB.playbook_copy("chatgpt")
pbd["actions"]["ob_box"] = {"kind": "drag", "label": "box", "selectors": ["img.big"], "proven": True, "source": "t",
                            "params": {"chat_url": {"type": "string"}}, "rel_from": [0.1, 0.2], "rel_to": [0.5, 0.6]}
st_ = PB.resolve(pbd, "ob_box", {})
check(st_[0]["rel_from"] == [0.1, 0.2] and st_[0]["rel_to"] == [0.5, 0.6], "a drag's points on the action itself replay")
st_ = PB.resolve(pbd, "ob_box", {"rel_from": [0.3, 0.3], "rel_to": [0.4, 0.4]})
check(st_[0]["rel_from"] == [0.3, 0.3], "undeclared located points (data) win over the action's")
pbd["actions"]["ob_box"].pop("rel_from"), pbd["actions"]["ob_box"].pop("rel_to")
st_ = PB.resolve(pbd, "ob_box", {})
check(st_[0]["rel_from"] == [0.38, 0.42] and st_[0]["rel_to"] == [0.62, 0.58], "no points anywhere → the neutral centre box")
pbd["actions"]["ob_pen"] = {"kind": "draw", "label": "pen", "selectors": ["canvas"], "proven": True, "source": "t"}
st_ = PB.resolve(pbd, "ob_pen", {"strokes": [[[1, 2], [3, 4]]]})
check(st_[0]["strokes"] == [[[1, 2], [3, 4]]], "stroke data (undeclared) passes the replay")
pins("C-draw-no-strokes")
st_ = PB.resolve(pbd, "ob_pen", {})
check(st_[0]["strokes"] and len(st_[0]["strokes"][0]) >= 2, "no strokes anywhere → one sample stroke, never 'draw needs strokes'")
# a mode / toggle step whose post already holds is not pressed again (re-run 15: Markup already on)
pins("C-idempotent-mode")


class ModePage:
    polls = False

    def __init__(self, markup_on):
        self.markup, self.presses, self.notes = markup_on, [], []
        self.t = self

    def send(self, m):
        c = m.get("cmd")
        if c == "count":
            sel = m["selector"]
            return {"n": int(("Cancel markup" in sel and self.markup) or "generated-image-preview" in sel
                             or "Close viewer" in sel or "contenteditable" in sel)}
        if c == "act":
            self.presses.append(m["action"].get("target") or m["action"].get("selector"))
            if m["action"].get("target") == "Markup":
                self.markup = not self.markup               # a toggle
            return {"ok": True}
        if c == "text":
            return {"text": "Jake Dawson", "draft": ""}
        if c == "state":
            return {"account": "Jake Dawson"}
        if c == "observe":
            return {"lum": 10}
        return {"ok": True}

    def check(self, a):
        return PB.RecorderSession.check(self, a)

    def act(self, st):
        return PB.RecorderSession.act(self, st)

    def open(self, url):
        return True, None


pbm = PB.playbook_copy("chatgpt")
pbm["start_state"]["asserts"] = []
vm = pbm["actions"]["viewer_markup"]
pbm["actions"]["ob_mark_box"] = {"kind": "drag", "label": "box", "selectors": ['[data-testid="generated-image-preview"]'],
                                 "proven": True, "source": "t", "requires": ["viewer_markup"], "pre": [], "post": []}
mp = ModePage(markup_on=True)
okm, whym = PB._run_once(mp, pbm, "ob_mark_box", {})
check(okm and "Markup" not in [x for x in mp.presses if x] and mp.markup and any("already reached" in n for n in mp.notes),
      f"Markup already on: not pressed again (no toggle-off), logged: {whym} {mp.presses} {mp.notes} post={vm.get('post')}")
mp2 = ModePage(markup_on=False)
okm2, _ = PB._run_once(mp2, pbm, "ob_mark_box", {})
check(okm2 and mp2.markup, "Markup off: pressed once as before")
# a mode action replayed twice in a row stays ON (Markup and Comment — re-run 15 09:11, Comment toggled off)


class CommentPage(ModePage):
    def send(self, m):
        c = m.get("cmd")
        if c == "count" and "Image comment surface" in m["selector"]:
            return {"n": int(self.markup)}
        if c == "act" and (m["action"].get("selector") == 'button[aria-label="Comment"]' or m["action"].get("target") == "Comment"):
            self.presses.append("Comment")
            self.markup = not self.markup
            return {"ok": True}
        return super().send(m)


pbm["actions"]["ob_pin"] = {"kind": "click", "label": "pin", "selectors": ['[data-testid="generated-image-preview"]'],
                            "proven": True, "source": "t", "requires": ["viewer_comment"], "pre": [], "post": []}
for page_, aid_, name_ in ((ModePage(markup_on=False), "ob_mark_box", "Markup"), (CommentPage(markup_on=False), "ob_pin", "Comment")):
    r1_ = PB._run_once(page_, pbm, aid_, {})
    r2_ = PB._run_once(page_, pbm, aid_, {})
    check(r1_[0] and r2_[0] and page_.markup and page_.presses.count(name_) == 1,
          f"{name_} mode replayed twice stays ON (pressed once): {r1_} {r2_} {page_.presses}")
aud = {(f["action"], f["rule"]) for f in preflight.audit_playbook(pbd)}
check(("ob_box", "drag_points_data") in aud and ("ob_pen", "draw_strokes_data") in aud, f"audit_playbook names data drags/draws: {aud}")
check(("send", "requires_unbuildable") in aud, "audit_playbook: 'send' requires paste_prompt whose 'text' is data — named, "
      "never a crash (re-run 14)")
logo_steps = PB.playbook_copy("chatgpt")["produce"]["tools"]["logo_template"]["steps"]
check(sum(1 for x in logo_steps if x.get("need")) >= 3 and not any(x.get("action") == "send" for x in logo_steps),
      "the Logo flow is learned live (needs), never a guessed paste + send")
check(not [f for f in preflight.audit_playbook(PB.playbook_copy("chatgpt")) if f["rule"] == "need_folds_send"],
      "no shared tool need folds a Send into its step")


class FakeT:
    def __init__(self):
        self.sent = []

    def send(self, m):
        self.sent.append(m)
        return {"ok": True, "url": "https://chatgpt.com/", "n": 1}

    def close(self):
        pass


def ob_ctx(name, image_chat="https://chatgpt.com/c/job-a"):
    out = TMP / name / "preprod"
    out.mkdir(parents=True, exist_ok=True)
    c = onboard.Ctx(out, "chatgpt", "https://chatgpt.com/", onboard.job_playbook(out, "chatgpt"), transport_factory=FakeT,
                    llm_call=lambda *a, **k: {"text": "{}", "usd": 0.0}, budget=onboard.Budget(9.5), image_chat=image_chat,
                    allowed_chats=["https://chatgpt.com/c/job-a", "https://chatgpt.com/c/job-b"], log=lambda *a: None)
    return c


_run, _prove, _pres = onboard.Explorer.run, onboard.prove, onboard.presence
proved, presenced = [], []
try:
    onboard.Explorer.run = lambda self, need, start, tr, feedback=None, allow_generate=False: {
        "status": "proposed", "action_id": "ob_name", "turns": 2, "log": [],
        "action": {"kind": "paste", "label": "name", "selectors": ["#name"], "params": {}, "requires": [], "pre": [],
                   "post": [], "proven": False, "source": "R14 P2 onboarding (per video): name"}}
    onboard.prove = lambda ctx, aid, params=None, n=None: proved.append(copy.deepcopy(ctx.pb["actions"][aid])) or \
        {"proven": True, "ok": 3, "n": 3, "replays": [{"ok": True}] * 3}
    c1 = ob_ctx("chain")
    row = onboard.onboard_action(c1, "enter the brand name", chain=["open_images_page", "images_templates_tab"])
    check(row["status"] == "proven" and proved[-1]["requires"][:2] == ["open_images_page", "images_templates_tab"],
          f"a tool's later step requires its earlier steps, so its proof replays them first: {proved[-1].get('requires')}")
    onboard.presence = lambda ctx, aid, params=None: presenced.append(aid) or (True, None)
    stat = []
    c1s = ob_ctx("status")
    c1s.status = stat.append
    onboard.onboard_action(c1s, "enter the slogan")
    check(any(x.startswith("Learning: enter the slogan (round 1/") for x in stat), f"the status line follows P2: {stat}")
    pins("D-status-line")
    c2 = ob_ctx("confirm")
    row = onboard.onboard_action(c2, "press the check mark on the sketch", presence_only=True)
    check(row["status"] == "proven" and presenced, "a confirm right after a stroke is proven by presence, never pressed")
    # the start chat no longer loads → the next round starts from ANOTHER chat this job created (never Jake's)
    onboard.prove = lambda ctx, aid, params=None, n=None: {"proven": False, "ok": 0, "n": 3, "replays": [
        {"ok": False, "why": "start_state: no element [contenteditable] (Could not load this conversation)"}] * 3}
    c3 = ob_ctx("rotate", image_chat="https://chatgpt.com/c/job-a")
    onboard.onboard_action(c3, "click the comment pin")
    check(c3.image_chat == "https://chatgpt.com/c/job-b", f"rotated to another job chat: {c3.image_chat}")
    # every proof fails inside the SAME required step (its post drifted) → that step is re-proven / re-onboarded for
    # this video, then the proof runs again (re-run 15: viewer_markup's 'Cancel markup' post)
    pins("A-required-step-drift")
    calls_p, rep_ids = [], []

    def prove2(ctx, aid, params=None, n=None):
        calls_p.append(aid)
        if len(calls_p) == 1:
            return {"proven": False, "ok": 0, "n": 3, "replays": [
                {"ok": False, "why": "requires viewer_markup: post: no element button[aria-label=\"Cancel markup\"]"}] * 3}
        return {"proven": True, "ok": 3, "n": 3, "replays": [{"ok": True}] * 3}
    onboard.prove = prove2
    _rep = onboard.reprove_existing
    onboard.reprove_existing = lambda ctx, ids, params=None: rep_ids.extend(ids) or {i: {"ok": True} for i in ids}
    try:
        c4 = ob_ctx("reqdrift")
        row = onboard.onboard_action(c4, "drag a box in markup mode", chain=["open_image_viewer", "viewer_markup"])
    finally:
        onboard.reprove_existing = _rep
    check(rep_ids == ["viewer_markup"] and row["status"] == "proven" and len(calls_p) == 2,
          f"the drifted required step is re-proven, then the proof passes: {rep_ids} {row.get('status')} {calls_p}")
    # a prerequisite that stays broken after its one self-repair: dependents are skipped, no rounds spent
    pins("D-prereq-failed")
    onboard.prove = lambda ctx, aid, params=None, n=None: calls_p.append(aid) or {"proven": False, "ok": 0, "n": 3, "replays": [
        {"ok": False, "why": "requires viewer_markup: post: no element button[aria-label=\"Cancel markup\"]"}] * 3}
    onboard.reprove_existing = lambda ctx, ids, params=None: {i: {"ok": False} for i in ids}
    explored = []
    _run2 = onboard.Explorer.run
    onboard.Explorer.run = lambda self, *a, **k: explored.append(a[0]) or _run2(self, *a, **k)
    try:
        c5 = ob_ctx("prereq")
        calls_p.clear()
        r1 = onboard.onboard_action(c5, "drag a box in markup mode", chain=["open_image_viewer", "viewer_markup"])
        n_after_first = len(calls_p)
        r2 = onboard.onboard_action(c5, "type the note into the box after the markup drag",
                                    chain=["open_image_viewer", "viewer_markup"])
    finally:
        onboard.reprove_existing = _rep
        onboard.Explorer.run = _run2
    check(r1.get("prereq_failed") == "viewer_markup" and "skipped: prerequisite viewer_markup failed" in r1["why"],
          f"the first step records the broken prerequisite: {r1.get('why')}")
    check(r2.get("prereq_failed") == "viewer_markup" and len(calls_p) == n_after_first and len(explored) == 1,
          f"the dependent step spends no rounds (no explore, no proof): {r2.get('why')} {len(explored)}")
finally:
    onboard.Explorer.run, onboard.prove, onboard.presence = _run, _prove, _pres
# proof rounds never leak into each other: teardown (data) + the generic reset of the onboarding session
pins("C-round-leak")


class LeakT(FakeT):
    def __init__(self):
        super().__init__()
        self.chips = 1                                  # a 'Markup' chip a previous round left in the draft

    def send(self, m):
        self.sent.append(m)
        if m.get("cmd") == "count" and "Remove " in m.get("selector", ""):
            return {"ok": True, "n": self.chips}
        if m.get("cmd") == "act" and "Remove " in str(m["action"].get("selector")):
            self.chips -= 1
        return {"ok": True, "url": "https://chatgpt.com/c/job-a", "n": 1}


lt = LeakT()
pbr = PB.playbook_copy("chatgpt")
pbr["actions"]["viewer_markup"]["teardown"] = [{"type": "click", "selector": 'button[aria-label="Cancel markup"]'}]
sr = onboard.Session(onboard.Guarded(lt, pbr, allowed_chats=["https://chatgpt.com/c/job-a"]), pbr)
sr.open("https://chatgpt.com/c/job-a")
check(lt.chips == 0 and any(m.get("cmd") == "act" and m["action"].get("key") == "Escape" for m in lt.sent),
      "a fresh round starts with Escape and the leftover draft chip removed")
lt.sent.clear()
PB.teardown(sr, pbr, "ob_mark_box" if "ob_mark_box" in pbr["actions"] else "viewer_markup", {})
check(any(m.get("cmd") == "act" and "Cancel markup" in str(m["action"].get("selector")) for m in lt.sent),
      "after a round the action's teardown steps (data) run")
# Jake's Library is never opened by an agent (data: playbook private_urls)
g = onboard.Guarded(FakeT(), PB.playbook_copy("chatgpt"))
check(g.send({"cmd": "open", "url": "https://chatgpt.com/library?tab=images"}).get("refused")
      and g.check_act({"type": "goto", "url": "https://chatgpt.com/library"}), "the Library is refused (open and goto)")
src_pp = (ROOT / "aieditor" / "preprod.py").read_text()
check('"https://chatgpt.com/library?tab=images"' in src_pp and 'AIEDITOR_READINESS_LIBRARY") == "1":\n            p.send' in src_pp,
      "readiness opens the Library only when explicitly switched on")
# a tool text step the app does not have → the app's prompt action (Markup has no note box)
pbn = copy.deepcopy(PBX)
ctx_n = _Ctx(TMP / "j1" / "preprod", pbn)
prn = producer.Producer.__new__(producer.Producer)
prn.ctx, prn.spec, prn.cur = ctx_n, {"tools": {"markup": {"steps": []}}, "roles": {"prompt": "paste_prompt"}}, {"source": {}}
onboard.onboard_action = lambda *a, **k: {"status": "absent", "why": "no note box"}
try:
    aid_n, why_n = prn.ensure_tool_action("markup", 3, {"need": "type the note into the box", "text": True}, {"prompt": "x"})
finally:
    onboard.onboard_action = _real
check(aid_n == "paste_prompt" and not why_n, "no note box → the text goes in the app's prompt action")
# Remove BG ran in the viewer overlay: the overlay is closed after the press (data: produce.overlay_close)
check(PB.playbook_copy("chatgpt")["produce"].get("overlay_close") == ['button[aria-label="Close viewer"]'],
      "overlay_close is data in the app's playbook")
src_pr = (ROOT / "aieditor" / "producer.py").read_text()
check('for oc in (self.spec.get("overlay_close") or [])' in src_pr, "the producer closes the overlay after a tool press")
# every checked picture an earlier run made is known to the source step (never made again under a new name)
src_ob = (ROOT / "aieditor" / "onboard.py").read_text()
check('glob("*.produced.json")' in src_ob and "_remember(ctx, side.name.split" in src_ob,
      "earlier runs' pictures are remembered by the source step")
# a camera / framing line is D — never a missing feature or a motion graphic (re-run 15, 'Close on the bottle's label')
row_c = {"code": "ui_state", "why": "beat at 855.5 s on 'label': 'Close on the bottle's label' describes a UI step but "
                                   "the beat only frames (camera.zoom)"}
check(onboard.classify(row_c) == "D" and onboard.is_camera_need(row_c), "a beat that only frames is the edit's camera (D)")
check(onboard.classify({"code": "feature", "why": "No 'Updated' badge exists"}) == "C", "a real missing feature stays C")
check("if is_camera_need(r):" in src_ob.split("def handle_c")[1][:300], "the P4 route checks it again before handle_c acts")


# the observation frame covers the WHOLE recording viewport (re-run 15: the explorer saw only the top-left)
pins("A-cropped-observation")
check(preflight.viewport_problem({"w": 2560, "h": 1440, "want": [1536, 864, 1.6667]}).startswith("viewport 2560x1440"),
      "a layout viewport that is not the recording's is named")
check(preflight.viewport_problem({"w": 1536, "h": 864, "fixed": True, "want": [1536, 864, 1.6667]}) is None,
      "a restored viewport passes")
FF_vp = R.first_frame_check(type("VP", (), {"send": lambda self, m: {**Page().send(m), "vp": {"w": 2560, "h": 1440,
                            "want": [1536, 864, 1.6667]}} if m.get("cmd") == "state" else Page().send(m), "name": None,
                            "workdir": None})(), {"asserts": []}, "Jake", pixels=False)
check(not FF_vp[0] and any("viewport" in w for w in FF_vp[1]), "a cropped frame is never a clean first frame")
src_ar = (ROOT / "screencast" / "agent_rec.mjs").read_text()
check("async function ensureViewport()" in src_ar and "width: w, height: h, scale: scale * CSS_W / w" in src_ar,
      "agent_rec proves the viewport and clips the whole of it")
if os.environ.get("AIEDITOR_SKIP_DOCKER") != "1":
    import subprocess  # noqa: E402
    vpd = TMP / "vp"
    vpd.mkdir()
    (vpd / "p.html").write_text('<html><body style="margin:0;background:#222"><div style="position:fixed;right:0;bottom:0;'
                                'width:200px;height:100px;background:#f00"></div></body></html>')
    cmds = "\n".join(json.dumps(x) for x in ({"cmd": "open", "url": "file:///w/p.html", "settle": 1}, {"cmd": "observe"},
                                              {"cmd": "quit"})) + "\n"
    r_ = subprocess.run(["docker", "run", "-i", "--rm", "--network", "none", "-v", f"{ROOT / 'screencast'}:/app/screencast:ro",
                         "-v", f"{ROOT / 'motion'}:/app/motion:ro", "-v", f"{vpd}:/w", "aieditor-screencast:0.2", "node",
                         "/app/screencast/agent_rec.mjs", "/w"], input=cmds, capture_output=True, text=True, timeout=240)
    obs_ = next((json.loads(x) for x in r_.stdout.splitlines() if '"shot"' in x), {})
    check(obs_.get("vp", {}).get("w") == 1536 and not preflight.viewport_problem(obs_.get("vp")), f"live observe vp: {obs_.get('vp')}")
    chk_ = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{vpd}:/w", "--entrypoint", "python3",
                           "aieditor-screencast:0.2", "-c", "import cv2;g=cv2.imread('/w/obs-0001.jpg');h,w=g.shape[:2];"
                           "b,gr,r=g[h-20,w-20];print(w,h,int(r),int(gr))"], capture_output=True, text=True, timeout=120)
    w_, h_, r_c, g_c = (list(map(int, chk_.stdout.split())) + [0, 0, 0, 0])[:4]
    check(w_ == 1280 and h_ == 720 and r_c > 180 and g_c < 80, f"the observation shows the bottom-right corner: {chk_.stdout} {chk_.stderr[-200:]}")

# a post check whose element was renamed (UI drift, re-run 15: 'Image comment surface' gone, Comment mode visibly ON):
# re-derived from the live page, proven absent-before / present-after, re-proven 3/3, written back with repaired_from
pins("A-post-assert-drift")


class CommentNew:
    def __init__(self):
        self.on, self.sent = False, []

    def send(self, m):
        self.sent.append(m)
        c = m.get("cmd")
        if c == "open":
            self.on = False
            return {"ok": True, "url": m["url"]}
        if c == "act":
            a = m["action"]
            if a.get("selector") == 'button[aria-label="Comment"]' or a.get("target") == "Comment":
                self.on = True
            return {"ok": True, "url": "https://chatgpt.com/c/job-a"}
        if c == "count":
            sel = m["selector"]
            n = {'button[aria-label="Close viewer"]': 1, '[contenteditable="true"]': 1,
                 'div[role="toolbar"][aria-label="Comment mode"]': int(self.on)}.get(sel, 0)
            return {"ok": True, "n": n}
        if c == "observe":
            return {"ok": True, "lum": 12, "shot": None, "items": [{"tag": "div", "text": "Click on the image to add comments"
                                                                      if self.on else "", "box": [600, 800, 400, 40]}]}
        if c == "text":
            return {"ok": True, "text": "Jake Dawson " + ("Click on the image to add comments" if self.on else ""), "draft": ""}
        if c == "state":
            return {"ok": True, "account": "Jake Dawson"}
        return {"ok": True}

    def close(self):
        pass


out_c = TMP / "postdrift" / "preprod"
out_c.mkdir(parents=True)
ctx_c = onboard.Ctx(out_c, "chatgpt", "https://chatgpt.com/", onboard.job_playbook(out_c, "chatgpt"), transport_factory=CommentNew,
                    llm_call=lambda *a, **k: {"text": json.dumps({"visible": True, "kind": "selector", "selector":
                                              'div[role="toolbar"][aria-label="Comment mode"]', "why": "the comment bar"}),
                                              "usd": 0.02},
                    budget=onboard.Budget(9.5), image_chat="https://chatgpt.com/c/job-a",
                    allowed_chats=["https://chatgpt.com/c/job-a"], log=lambda *a: None)
ctx_c.pb["actions"]["viewer_comment"]["video_proof"] = None
res_c = onboard.reprove_existing(ctx_c, ["viewer_comment"])
vc = ctx_c.pb["actions"]["viewer_comment"]
check(res_c["viewer_comment"]["ok"] and vc["post"] == [{"kind": "selector", "selector": 'div[role="toolbar"][aria-label="Comment mode"]'}]
      and vc.get("repaired_from", {}).get("post") and vc["repaired_from"]["proof"] == "3/3",
      f"the drifted post check is re-derived, replayed 3/3 and kept as data: {res_c} {vc.get('post')} {vc.get('repaired_from')}")
check(json.loads((out_c / "playbook-chatgpt.json").read_text())["actions"]["viewer_comment"].get("repaired_from"),
      "written to this video's playbook")
# vision alone never passes: a proposed check that is not on the page is refused, the old one kept
out_d = TMP / "postdrift2" / "preprod"
out_d.mkdir(parents=True)
ctx_d = onboard.Ctx(out_d, "chatgpt", "https://chatgpt.com/", onboard.job_playbook(out_d, "chatgpt"), transport_factory=CommentNew,
                    llm_call=lambda *a, **k: {"text": json.dumps({"visible": True, "kind": "selector", "selector": "#made-up"}),
                                              "usd": 0.02}, budget=onboard.Budget(9.5), image_chat="https://chatgpt.com/c/job-a",
                    allowed_chats=["https://chatgpt.com/c/job-a"], log=lambda *a: None)
ok_d, why_d = onboard.repair_post_assert(ctx_d, "viewer_comment")
check(not ok_d and "not on the page" in why_d and ctx_d.pb["actions"]["viewer_comment"]["post"][0]["selector"]
      == 'button[aria-label="Image comment surface"]', f"never accepted on vision alone: {why_d}")

# ── 8. D: run control ──
pins("D-cap-mid-route", "D-cap-mid-assets", "D-playbook-crash", "D-assets-kept")
from aieditor import apiledger, llm, preprod  # noqa: E402
os.environ["AIEDITOR_API_JOB_CAP_USD"], os.environ["AIEDITOR_API_DAILY_CAP_USD"] = "1.0", "100"
try:
    preflight.headroom("job-x", 20, per_need_usd=0.25)
    check(False, "headroom must refuse")
except apiledger.BudgetExceeded as e:
    check(e.which == "job", "routing that cannot fit the job cap is refused BEFORE it starts (held 'API cap')")
check(preflight.headroom("job-x", 2, per_need_usd=0.25) == 0.5, "routing that fits goes on")
os.environ.pop("AIEDITOR_API_JOB_CAP_USD"), os.environ.pop("AIEDITOR_API_DAILY_CAP_USD")


class _Job:
    def __init__(self, d):
        self.dir, self.request, self.sites = d, {}, []


out8 = TMP / "j8" / "preprod"
out8.mkdir(parents=True)
for f, doc in (("readiness.json", {"checks": []}), ("assets.json", {"assets": [{"id": "a1", "status": "ready"}]}),
               ("plan.json", {"plan": {"answer": {"segments": []}, "needs_primitive": []}})):
    (out8 / f).write_text(json.dumps(doc))


class _App:
    site = "https://chatgpt.com/"


_rn = preprod.route_needs


def _route_refused(job, out, app, readiness, assets, pdoc, **kw):
    assets["assets"].append({"id": "made_before_the_cap", "status": "ready"})
    llm._refusals.append("API cap: $45.00 spent on the Claude API in the last 24 h of the $45.00 daily cap")
    return {"usd": 0.0}


preprod.route_needs = _route_refused
try:
    preprod._flow(_Job(TMP / "j8"), out8, [], _App(), steps=["route"])
    check(False, "a refused route must raise")
except apiledger.BudgetExceeded as e:
    check(e.which == "daily", "the cap during routing ends as the cap (daily → the job waits), never needs_primitive")
finally:
    preprod.route_needs = _rn
    llm._refusals.clear()
check(any(a["id"] == "made_before_the_cap" for a in json.loads((out8 / "assets.json").read_text())["assets"]),
      "assets.json keeps what routing made before it stopped")


def _route_crash(*a, **k):
    a[4]["assets"].append({"id": "made_before_the_crash", "status": "ready"})
    raise RuntimeError("boom")


preprod.route_needs = _route_crash
try:
    preprod._flow(_Job(TMP / "j8"), out8, [], _App(), steps=["route"])
except RuntimeError:
    pass
finally:
    preprod.route_needs = _rn
check(any(a["id"] == "made_before_the_crash" for a in json.loads((out8 / "assets.json").read_text())["assets"]),
      "assets.json is kept even when routing crashes")
src_pp_run = src_pp.split("def run(job_dir")[1]
check("except (InterruptedError, genledger.QuotaWait, apiledger.BudgetExceeded):\n            # cancelled" in src_pp_run
      and "raise" in src_pp_run.split("apiledger.BudgetExceeded):")[1][:400],
      "pre-production re-raises the cap (the job waits / is held), never records half-done")
# a PlaybookError in a step's requires is a failed try, never a crash of pre-production (re-run 14)
pr8 = producer.Producer.__new__(producer.Producer)
pr8.ctx, pr8.spec, pr8.cur = _Ctx(TMP / "j1" / "preprod", copy.deepcopy(PBX)), {"roles": {}}, {"source": {}}


class _S:
    polls = False

    def act(self, st):
        return True, None


bad = pr8._step(_S(), FakeT(), {"action": "send"}, {"prompt": "x", "files": []}, set())
check(bad and bad["class"] == "ui_step_failed" and "requires paste_prompt" in bad["why"],
      f"'param text is required' in a requires → a failed step: {bad}")


# ── 10. THE WEEKLY CANARY: one example of each class, a report, the ledger refreshed — offline with fakes ──
pins("canary")
from aieditor import canary, genledger  # noqa: E402
jobs_c = TMP / "cjobs"
dq = canary.enqueue("chatgpt", jobs=jobs_c, now=1_800_000_000)
rq = json.loads((dq / "request.json").read_text())
check(rq["canary"] and rq["sites"][0]["url"] == "https://chatgpt.com/" and json.loads((dq / "queue.json").read_text())
      == {"action": "edit"} and dq.name.startswith("canary-chatgpt-"), "enqueue: a factory job the worker sends out")
src_w = (ROOT / "bin" / "aieditor-worker").read_text()
check('if job.req.get("canary"):' in src_w and "canary.run(job.d" in src_w, "the worker runs the canary instead of an edit")
check("OnCalendar=" in (ROOT / "bin" / "aieditor-canary.timer").read_text()
      and not Path("/etc/systemd/system/aieditor-canary.timer").exists(), "the timer is shipped, not installed (disabled)")
(TMP / "proven.jsonl").write_text(json.dumps({"ts": __import__("time").time() - 3600, "app": "chatgpt", "need": "drag a markup box",
                                              "key": "drag a markup box", "aid": "ob_box2",
                                              "action": {"kind": "click", "label": "x", "selectors": ["#x"], "proven": True,
                                                         "source": "t", "requires": [], "pre": [], "post": []}}) + "\n")


class CCtx:
    def __init__(self):
        self.pb = copy.deepcopy(PBX)
        self.producer, self.image_chat, self.app, self.out = None, None, "chatgpt", TMP / "cjobs"
        self.logs = []

    def log(self, m):
        self.logs.append(m)


made_c = []


def fake_produce(ctx, aid, desc, made_from=(), **k):
    genledger.record("chatgpt", ctx_job, aid, 1, "fake")
    made_c.append(aid)
    return {"id": aid, "status": "ready", "desc": desc, "made_from": list(made_from), "file": str(TMP / "res.png"),
            "source": {"prompt": "Create an image: a bottle", "route": "Create image mode", "via": "learned",
                       "chat_url": "https://chatgpt.com/c/canary-1", **({"tool": "remove_bg", "via": "tool",
                                                                          "recipe": "produce_edit:remove_bg"} if "cutout" in aid else {})}}


dc = canary.enqueue("chatgpt", jobs=jobs_c, now=1_800_000_600)
ctx_job = dc.name
_pa, _pv = onboard.produce_asset, onboard.prove
onboard.produce_asset = fake_produce
onboard.prove = lambda ctx, aid, params=None, n=None: {"proven": True, "ok": 1, "n": 1, "replays": [{"ok": True}]}


class FakeRecorder:
    def record_segment(self, i, seg):
        return {"status": "ok", "why": ""}


try:
    rep_c = canary.run(dc, json.loads((dc / "request.json").read_text()), log=lambda *a: None,
                       ctx_factory=lambda *a: CCtx(), session_factory=lambda app, kind, fresh: DriftPage(),
                       recorder_factory=lambda *a: FakeRecorder())
finally:
    onboard.produce_asset, onboard.prove = _pa, _pv
check(made_c == ["canary_photo", "canary_edit", "canary_cutout"] and rep_c["generations"] == 3,
      f"B: Create image, an edit with an upload, Remove BG — 3 generations: {made_c} {rep_c['generations']}")
check(rep_c["classes"]["A"] == "ok" and rep_c["classes"]["B"] == "ok" and rep_c["classes"]["C"] == "ok"
      and rep_c["classes"]["D"] == "ok", f"one example of each class: {rep_c['classes']} {rep_c['checks']}")
check(any(c["check"].startswith("start state: logged-out pricing") and c["skipped"] for c in rep_c["checks"]),
      "pricing only via the US route — skipped (never through Singapore) when the job has none")
check(any("one 5-second screencast" == c["check"] and c["ok"] for c in rep_c["checks"]), "one 5-second screencast")
ledger = [json.loads(x) for x in (TMP / "proven.jsonl").read_text().splitlines()]
check(len(ledger) == 2 and ledger[-1]["aid"] == "ob_box2", "the 7-day ledger is refreshed by the replay")
check(json.loads((dc / "canary-report.json").read_text())["summary"].startswith("Canary chatgpt: A ✓ B ✓ C ✓ D ✓"),
      f"the report's status line: {rep_c['summary']}")
check(os.environ.get("AIEDITOR_API_JOB_CAP_USD") is None, "the canary's own $1.50 cap is process-local and restored")
# the cap headroom stops the canary before anything starts
de = canary.enqueue("chatgpt", jobs=jobs_c, now=1_800_001_200)
apiledger.record({"ts": __import__("time").time(), "job": de.name, "usd": 1.45, "model": "x"})
rep_e = canary.run(de, json.loads((de / "request.json").read_text()), log=lambda *a: None, ctx_factory=lambda *a: CCtx())
check(rep_e["classes"]["D"] == "fail" and rep_e["classes"]["B"] == "not run", f"no headroom → nothing runs: {rep_e['classes']}")
src_lab = (ROOT.parent / "lab" / "server" / "src" / "aieditor" / "factory.ts").read_text()
check("canary-report.json" in src_lab and "Weekly canary" in (ROOT.parent / "lab" / "src" / "components" / "autoeditor"
                                                               / "FactoryPanel.tsx").read_text(), "the Lab shows the canary line")

# ── 9. THE COVERAGE TABLE: every past failure has a class, a detector, a repair and a REAL test ──
for row in preflight.COVERAGE:
    check(row["cls"] in preflight.CLASSES and row["detector"] and row["repair"], f"coverage row complete: {row['id']}")
    f, _, tok = row["test"].partition("::")
    check((ROOT / f).is_file() and tok and tok in (ROOT / f).read_text(), f"coverage {row['id']}: test {row['test']} exists")
    if f.endswith("test_selfheal.py"):
        check(row["id"] in PINNED or tok in PINNED, f"coverage {row['id']}: pinned by a check in this file")
check(len({r["id"] for r in preflight.COVERAGE}) == len(preflight.COVERAGE), "coverage ids are unique")
doc = (ROOT / "docs" / "SELF-HEALING.md").read_text()
check(preflight.coverage_markdown() in doc, "docs/SELF-HEALING.md carries the current coverage table "
      "(regenerate: python3 -c 'from aieditor import preflight; print(preflight.coverage_markdown())')")

# re-run 16: ffmpeg died mid-render (BrokenPipe) and the WHOLE job failed — one screencast that crashes is tried once
# more, then falls back; the others are still recorded
import tempfile as _tf  # noqa: E402
from aieditor import recorder as _R  # noqa: E402
class _FakeRec:
    calls = {}
    def __init__(self, *a, **k):
        self.log = k.get("log") or print
        self.progress, self.usd, self.live_left = None, 0.0, 1
        self.budget = type("B", (), {"video_usd": 0})()
    def record_segment(self, i, seg):
        _FakeRec.calls[i] = _FakeRec.calls.get(i, 0) + 1
        if i == 0:
            raise BrokenPipeError(32, "Broken pipe")
        return {"status": "ok", "seg": i}
    def close(self):
        pass
_orig = (_R.Recorder, _R.schema_segments)
_R.Recorder = _FakeRec
_R.schema_segments = lambda plan, words, pbs, allow_intent=None: [{"t0": 0, "t1": 5, "app": "x"}, {"t0": 5, "t1": 9, "app": "x"}]
_logs = []
try:
    with _tf.TemporaryDirectory() as _w:
        res = _R.record_all({}, {}, {}, w=_w, video={"words": []}, new_session=None, log=_logs.append, allow_intent=set(),
                            skip_done=False)
finally:
    _R.Recorder, _R.schema_segments = _orig
check(_FakeRec.calls == {0: 2, 1: 1} and res["segments"][0]["status"] == "crashed" and res["segments"][1]["status"] == "ok"
      and res["held"] and res["held"][0]["reason"] == "recording crashed" and any("once more" in x for x in _logs),
      f"a crashed screencast: retried once, then held to fall back; the next one still recorded: {_FakeRec.calls} {res}")
_src = (ROOT / "screencast" / "agent_rec.mjs").read_text() if "ROOT" in globals() else ""
check(not _src or 'SESSION === "outside" && w0.kind === "login"' in _src,
      "the outside (never-logged-in) view's login header is not a wall at a beat assert (re-run 16, pricing page)")
print(f"test_selfheal: {N} checks passed")
