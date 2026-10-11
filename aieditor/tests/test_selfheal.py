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

print(f"test_selfheal: {N} checks passed")
