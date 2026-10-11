"""THE ASSET AGENT (aieditor/assetagent.py) offline: a fake app page (agent_rec.mjs protocol behind onboard.Guarded),
a fake model and a fake verifier — nothing is sent anywhere, no browser, no real generation.

  1. his on-screen prompt is typed VERBATIM by code (a rewrite is refused; the field is checked)
  2. the verifier rejects a picture (a collage) → the reason goes back to the agent → another try → accepted
  3. the cap: every try rejected → needs_asset after max tries; the $ cap stops before sending
  4. reuse: a picture an earlier run made and checked is reused unchanged (the agent is never called)
  5. a tool result (Remove BG) made by a plain generation is rejected; made with the tool it is accepted
  6. never a temporary chat / Delete; the app's limit message → QuotaWait (the job waits)
  7. the switch: agent mode → preprod.make_ctx installs the asset agent; off → the producer

Run: python3 tests/test_assetagent.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="assetagent-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_API_LEDGER"] = str(TMP / "api.jsonl")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
os.environ["AIEDITOR_GEN_LEDGER"] = str(TMP / "gen.jsonl")
os.environ["AIEDITOR_REHEARSAL_HINTS"] = str(TMP / "hints.jsonl")
os.environ["AIEDITOR_PROVEN_LIB"] = str(TMP / "proven.jsonl")
for k in ("AIEDITOR_REHEARSAL", "AIEDITOR_GEN_PRIOR", "ANTHROPIC_API_KEY", "AIEDITOR_API_JOB_CAP_USD",
          "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD", "AIEDITOR_API_PRIOR_JOB_USD"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import assetagent as AA, genledger, onboard, producer, rehearse  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


PROMPT = "a jar of homemade chili sauce on a rustic wooden table, morning light"
SRC_CHAT = "https://chatgpt.com/c/job-src"


class App:
    """A ChatGPT-like page. r1 composer, r2 Send, r3 Temporary chat, r4 Delete chat; on a chat with a picture: r5 the
    picture (opens the viewer), r6 Remove BG (in the viewer). A press of Send / Remove BG makes one more picture."""

    log = []

    def __init__(self, limit=False):
        self.workdir = TMP / f"t{len(App.log)}"
        self.workdir.mkdir(parents=True, exist_ok=True)
        App.log.append(self)
        self.url, self.composer, self.n, self.viewer, self.limit = "about:blank", "", 0, False, limit
        self.acts, self.pressed, self.uploaded = [], [], []

    def els(self):
        out = [{"ref": "r1", "tag": "div", "text": "Ask anything", "box": [400, 600, 500, 40]},
               {"ref": "r2", "tag": "button", "text": "Send", "box": [910, 600, 30, 30]},
               {"ref": "r3", "tag": "button", "text": "Temporary chat", "box": [1100, 10, 120, 30]},
               {"ref": "r4", "tag": "button", "text": "Delete chat", "box": [10, 10, 80, 20]}]
        if "/c/" in self.url:
            out.append({"ref": "r5", "tag": "img", "text": "Generated image", "box": [300, 150, 400, 400]})
        if self.viewer:
            out.append({"ref": "r6", "tag": "button", "text": "Remove BG", "box": [600, 40, 80, 24]})
        return out

    def send(self, m):
        c = m.get("cmd")
        if c == "open":
            self.url, self.composer, self.viewer = m["url"], "", False
            self.n = 1 if "/c/" in self.url else 0
            return {"ok": True, "url": self.url}
        if c == "observe":
            return {"ok": True, "url": self.url, "items": self.els(), "shot": "", "f": 1.5}
        if c == "count":
            return {"ok": True, "n": self.n if "generated-image" in m["selector"] else 0}
        if c == "text":
            return {"ok": True, "url": self.url, "draft": self.composer,
                    "text": "ChatGPT " + self.composer + (" You've reached your image limit. Try again later." if self.limit and self.gen else "")}
        if c == "assert":
            ok = m.get("field_equals") is None or self.composer == m["field_equals"]
            return {"ok": ok, "fail": [] if ok else ["field differs"]}
        if c == "grab":
            f = self.workdir / Path(m["out"]).name
            f.write_bytes(b"\x89PNG fake")
            return {"ok": True, "file": m["out"]}
        if c in ("guard", "state", "find"):
            return {"ok": True, "url": self.url, "found": {}}
        if c == "act":
            a = m["action"]
            self.acts.append(a)
            ty = a.get("type")
            e = next((x for x in self.els() if x["ref"] == a.get("ref")), None) if a.get("ref") else None
            if ty == "type":
                self.composer = a.get("text", "")
            elif ty == "upload":
                self.uploaded += a.get("files") or []
            elif ty == "click" and e:
                self.pressed.append(e["text"])
                if e["text"] in ("Send", "Remove BG"):
                    self.gen = True
                    if not self.limit:
                        self.n += 1
                    if "/c/" not in self.url:
                        self.url = "https://chatgpt.com/c/job-new"
                elif e["text"] == "Generated image":
                    self.viewer = True
            elif ty == "click" and a.get("selector") and "Remove " in a["selector"]:
                return {"ok": False, "error": "no element"}
            return {"ok": True, "url": self.url}
        return {"ok": True, "url": self.url}

    gen = False

    def close(self):
        pass


class Model:
    def __init__(self, turns):
        self.turns, self.calls, self.statics = list(turns), 0, []

    def __call__(self, model, system, content, max_tokens, **kw):
        self.calls += 1
        self.statics.append(kw["msgs"][0]["content"][0]["text"])
        t = self.turns.pop(0) if self.turns else {"do": "give_up", "note": "nothing left"}
        return {"text": json.dumps(t), "usd": 0.01}


def act(*a):
    return {"do": "act", "note": "", "actions": json.dumps(list(a))}


def ctx_for(name, model, check, limit=False, script=""):
    out = TMP / name / "preprod"
    out.mkdir(parents=True, exist_ok=True)
    c = onboard.Ctx(out, "chatgpt", "https://chatgpt.com/", onboard.job_playbook(out, "chatgpt"),
                    transport_factory=lambda: App(limit=limit), llm_call=model, check=check, budget=onboard.Budget(9.5),
                    allowed_chats=[SRC_CHAT], log=lambda *a: None)
    c.script = script
    c.producer = AA.AssetAgent(c, sleep=lambda s: None, call=model)
    c.producer.poll = 0.0
    return c


def ok_check(a, f, objs):
    return {"matches": True, "missing_objects": [], "usd": 0.002, "same_subject": True, "look_ok": True, "clean": True}


# ── 1. verbatim: a rewrite is refused; code types his words exactly ──
m1 = Model([act({"type": "type", "ref": "r1", "text": "a nice jar of sauce"}), act({"type": "type", "ref": "r1"}),
            act({"type": "click", "ref": "r2"})])
c1 = ctx_for("v", m1, ok_check, script=f'THE PROMPT: "{PROMPT}"')
row = c1.producer.produce("sauce", "a jar of chili sauce on a table", c1.out / "assets" / "sauce.png", prompt=PROMPT,
                          verbatim=True, look="impressive")
typed = [a["text"] for t in App.log for a in t.acts if a.get("type") == "type"]
check(row["status"] == "ready" and typed == [PROMPT] and row["prompt"] == PROMPT and row["source"]["prompt"] == PROMPT,
      f"his words typed verbatim, once, by code: {typed} {row.get('status')} {row.get('why')}")
log = json.loads((c1.out / "producer" / "agent-sauce.json").read_text())["log"]
check(any("VERBATIM" in x for x in log), "the rewrite was refused in code (trial log)")
check(Path(row["file"]).exists() and row["fidelity"]["v"] == producer.FIDELITY_V, "saved + marked checked (reusable)")
check(len(genledger.used("chatgpt")) == 1, "the generation is in the generation ledger (spacing / daily cap)")

# ── 2. the verifier rejects → the reason goes back → another try ──
seq = [{"matches": True, "clean": False, "chrome": "a before/after collage", "usd": 0.002}, ok_check(None, None, None)]
m2 = Model([act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"}), act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"})])
c2 = ctx_for("rej", m2, lambda a, f, o: seq.pop(0))
row2 = c2.producer.produce("sauce2", "a jar of chili sauce", c2.out / "assets" / "sauce2.png", prompt=PROMPT, verbatim=True)
check(row2["status"] == "ready" and len(row2["tries"]) == 2 and row2["tries"][0].get("rejected") == ["not_clean"],
      f"a collage is rejected, the next try is accepted: {row2['tries']}")
check(any("REJECTED" in s and "collage" in s for s in m2.statics), "the verifier's reason reached the agent")

# ── run 18: an empty / unusable answer is asked again, never a give-up ──
m9 = Model([{"note": "hmm"}, act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"})])
c9 = ctx_for("empty", m9, ok_check)
row9 = c9.producer.produce("sauce9", "a jar of chili sauce", c9.out / "assets" / "sauce9.png", prompt=PROMPT, verbatim=True)
check(row9["status"] == "ready" and m9.calls >= 2, f"an answer without 'do' is retried, not 'gave up': {row9.get('why')}")
# ── run 18: a drag given as fractions of an element reaches the browser as screenshot points ──
class _Tr:
    def __init__(self):
        self.sent = []
    def send(self, m):
        self.sent.append(m)
        return {"ok": True}
class _G:
    def check(self, *a, **k):
        return None
c10 = ctx_for("drag", Model([]), ok_check)
tr10 = _Tr()
obs10 = {"f": 2.0, "items": [{"ref": "r48", "tag": "img", "text": "Generated image 1", "box": [100, 200, 400, 300]}]}
out10 = c10.producer._act(tr10, _G(), {"type": "drag", "ref": "r48", "rel_from": [0.25, 0.5], "rel_to": [0.75, 1.0]},
                          obs10, "", [], "markup", [], {"tool_pressed": False, "generated": False}, "x", 1)
w10 = tr10.sent[-1]["action"]
check(w10.get("from") == [100.0, 175.0] and w10.get("to") == [200.0, 250.0],
      f"element fractions → screenshot points for the drag: {w10}")
# ── run 18: the picture was still generating when the wait ended → the next try waits for it, no agent ──
m11 = Model([act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"})])
c11 = ctx_for("slow", m11, ok_check)
_calls11 = []
def _wait11(tr, sel, n0, text0, prompt, deadline, wd, aid, n):
    _calls11.append(n)
    if len(_calls11) == 1:
        return {"diag": {"class": "still_generating", "why": "no finished image after 241 s"}}
    f = Path(wd) / "slow.png"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(b"\x89PNG fake")
    return {"file": str(f)}
c11.producer._wait = _wait11
row11 = c11.producer.produce("slow", "a jar of chili sauce", c11.out / "assets" / "slow.png", prompt=PROMPT, verbatim=True)
check(row11["status"] == "ready" and _calls11 == [1, 2] and m11.calls == 1,
      f"a slow generation is collected on the next try without the agent: {_calls11} calls={m11.calls} {row11.get('why')}")
# ── run 20: the wait never saw the finished picture → the newest one in that chat is taken, the verifier decides ──
m12 = Model([act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"})])
c12 = ctx_for("missed", m12, ok_check)
c12.producer._wait = lambda *a, **k: {"diag": {"class": "still_generating", "why": "no finished image after 241 s"}}
row12 = c12.producer.produce("missed", "a jar of chili sauce", c12.out / "assets" / "missed.png", prompt=PROMPT, verbatim=True)
check(row12["status"] == "ready" and m12.calls == 1,
      f"a finished picture the wait missed is collected from that chat: {row12.get('status')} {row12.get('attempts')}")
# ── 3. the cap → needs_asset ──
m3 = Model([act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"})] * 10)
c3 = ctx_for("cap", m3, lambda a, f, o: {"matches": False, "missing_objects": ["the jar"], "usd": 0.002})
row3 = c3.producer.produce("sauce3", "a jar of chili sauce", c3.out / "assets" / "sauce3.png", prompt=PROMPT, verbatim=True)
check(row3["status"] == "needs_asset" and len(row3["tries"]) == AA.rules()["max_tries"] and row3["why"],
      f"every try rejected → needs_asset after {AA.rules()['max_tries']} tries: {row3['status']} {len(row3['tries'])}")
check(all(t.endswith(PROMPT) or PROMPT in t for t in [a["text"] for t_ in App.log[-4:] for a in t_.acts if a.get("type") == "type"]),
      "a miss only ever ADDS what must be shown after his verbatim words")
m3b = Model([act({"type": "type", "ref": "r1"}, {"type": "click", "ref": "r2"})])
c3b = ctx_for("usd", m3b, ok_check)
c3b.producer.asset_usd = 0.00001
row3b = c3b.producer.produce("sauce4", "a jar", c3b.out / "assets" / "sauce4.png", prompt=PROMPT, verbatim=True)
check(row3b["status"] == "needs_asset" and m3b.calls == 0, "the per-asset $ cap refuses before sending")

# ── 4. reuse: an asset made and checked by an earlier run is reused unchanged ──
m4 = Model([])
c4 = ctx_for("reuse", m4, ok_check)
dst = c4.out / "assets" / "jar.png"
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_bytes(b"\x89PNG old")
old = {"id": "jar", "kind": "app_generation", "desc": "a jar of chili sauce", "status": "ready", "file": str(dst),
       "source": {"type": "in-app generation (off camera, asset agent)", "prompt": PROMPT, "via": "generation"},
       "fidelity": {"v": producer.FIDELITY_V, "look_ok": True, "clean": True}}
dst.with_suffix(".produced.json").write_text(json.dumps(old))
row4 = onboard.produce_asset(c4, "jar", "a jar of chili sauce")
check(row4["file"] == str(dst) and dst.read_bytes() == b"\x89PNG old" and m4.calls == 0, "reused unchanged, no agent call")

# ── 5. a tool result made by a plain generation is rejected; with the tool it is accepted ──
m5 = Model([act({"type": "click", "ref": "r2"}),                                       # try 1: plain Send
            act({"type": "click", "ref": "r5"}), act({"type": "click", "ref": "r6"})])  # try 2: the image → Remove BG
c5 = ctx_for("tool", m5, ok_check)
row5 = c5.producer.produce("cutout", "the Remove BG result of the jar photo", c5.out / "assets" / "cutout.png",
                           tool="remove_bg", source={"id": "jar", "chat": SRC_CHAT, "nth": 0, "file": str(dst)}, look="faithful")
check(row5["status"] == "ready" and "tool_not_tool" in (row5["tries"][0].get("rejected") or [])
      and row5["source"]["via"] == "tool" and row5["source"]["recipe"] == "produce_edit:remove_bg",
      f"a Remove BG result made by Send is rejected; by the tool accepted: {row5['tries']}")
check(not any(a.get("type") == "type" for t in App.log[-2:] for a in t.acts), "a tool with no text: nothing typed")

# ── 6. never a temporary chat / Delete; a limit message → QuotaWait ──
m6 = Model([act({"type": "click", "ref": "r3"}), act({"type": "click", "ref": "r4"}), act({"type": "type", "ref": "r1"}),
            act({"type": "click", "ref": "r2"})])
c6 = ctx_for("lim", m6, ok_check, limit=True)
try:
    c6.producer.produce("sauce6", "a jar", c6.out / "assets" / "sauce6.png", prompt=PROMPT, verbatim=True)
    check(False, "a limit message must stop the job (QuotaWait)")
except genledger.QuotaWait:
    pass
t6 = App.log[-1]
check("Temporary chat" not in t6.pressed and "Delete chat" not in t6.pressed, f"refused in code: {t6.pressed}")
check(genledger.blocked("chatgpt") is not None, "the limit blocks every generation of the app")

# ── 7. the switch ──
src = (ROOT / "aieditor" / "preprod.py").read_text()
check("assetagent.AssetAgent(ctx)" in src and 'rehearse.mode() == "agent"' in src, "make_ctx installs the asset agent in agent mode")
os.environ["AIEDITOR_REHEARSAL"] = "playbook"
check(rehearse.mode() == "playbook", "off → the producer's routes (the fallback)")
os.environ.pop("AIEDITOR_REHEARSAL")
check(issubclass(AA.AssetAgent, producer.Producer) and not any(k in (ROOT / "aieditor" / "assetagent.py").read_text()
                                                               for k in ("gen_photo", "OPENAI", "image_api")),
      "no image API anywhere in the asset agent")

print(f"test_assetagent: {N} checks passed")
