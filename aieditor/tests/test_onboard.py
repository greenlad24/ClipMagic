"""Jake's 5-point pre-production (RULEBOOK R14, 2026-10-10) — offline, with fake transports / adapters / model calls:
nothing is sent anywhere, no browser, no generation.

  (1) the test-v2 job's 43 needs_primitive holds are routed by group (A action / B asset / C feature / D gate),
      and needs_primitive never holds by itself any more
  (2) P2: this video's playbook lives in the JOB (preprod/playbook-<app>.json), never written to the skill; a
      missing action (the markup box drag) is explored by the agent loop, proposed, proven 3/3 from fresh sessions
  (3) the onboarding guard: no delete / billing / log out, never an existing chat, no generating press unless needed
  (4) the budget: every onboarding call goes through llm.messages (ledger + job cap); the per-app per-video cap
      ($9.50) stops onboarding; the creative job cap is $17.50
  (5) P3: an asset is retried (spaced >= 45 s) and re-routed to the other producer, never silently dropped
  (6) P4: a feature verified absent → a motion beat in the app's kit with a REAL produced result; an app with no kit
      → a kit capture is scheduled first; a feature that IS there → onboarded as an action; never a hold
  (7) P5 numbers (rules.json "pace" + structure), the camera's move frames and the holds after beats
  (8) D: a share near-miss, a too-short beat span and an uncovered screen reference are fixed by code
  (9) the whole route on a small plan: onboard + motion + new asset + D → a routed plan with nothing held

Run: python3 tests/test_onboard.py
"""
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="r14-onboard-"))
os.environ["AIEDITOR_WORK"] = str(TMP / "work")
os.environ["AIEDITOR_ENV"] = str(TMP / ".env")
for k in ("AIEDITOR_API_LEDGER", "AIEDITOR_API_JOB_CAP_USD", "AIEDITOR_API_DAILY_CAP_USD", "AIEDITOR_API_PRIOR_24H_USD",
          "AIEDITOR_API_PRIOR_JOB_USD", "AIEDITOR_API_PRIOR_AT", "ANTHROPIC_API_KEY"):
    os.environ.pop(k, None)
(TMP / "work").mkdir()
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import apiledger, beatscript, director, llm, onboard, planfit, playbook, preprod, skill  # noqa: E402

N = 0
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


# ── a fake ChatGPT page (agent_rec.mjs protocol) ──
class Page:
    """One fresh browser session. The image viewer, Markup mode and a markup box; '/newbg' never shows a menu."""
    log = []

    def __init__(self, has_newbg=False):
        self.s = {"url": None, "viewer": False, "markup": False, "box": False}
        self.has_newbg = has_newbg

    def send(self, m):
        Page.log.append(m)
        c = m.get("cmd")
        if c == "open":
            self.s.update(url=m["url"], viewer=False, markup=False, box=False)
            return {"ok": True, "url": m["url"]}
        if c == "act":
            a = m["action"]
            t, sel, tgt = a.get("type"), str(a.get("selector") or ""), str(a.get("target") or "")
            if t == "click" and "generated-image-preview" in sel:
                self.s["viewer"] = True
            elif t == "click" and tgt == "Markup":
                if not self.s["viewer"]:
                    return {"ok": False, "error": "no element"}
                self.s["markup"] = True
            elif t == "drag":
                if not (self.s["markup"] and a.get("rel_from") and a.get("selector")):
                    return {"ok": False, "error": "drag needs from/to"}
                self.s["box"] = True
            return {"ok": True, "url": self.s["url"]}
        if c == "count":
            sel = m["selector"]
            n = {'button[aria-label="Close viewer"]': self.s["viewer"], 'button[aria-label="Cancel markup"]': self.s["markup"],
                 "[data-markup-box]": self.s["box"], '[contenteditable="true"]': True, 'button[aria-label="Show sidebar"]': True,
                 '[data-testid="generated-image-preview"]': True}.get(sel, False)
            return {"ok": True, "n": int(bool(n))}
        if c == "text":
            return {"ok": True, "text": "Jake Dawson\nPlus\nAsk anything", "draft": "", "url": self.s["url"]}
        if c == "observe":
            return {"ok": True, "lum": 20.0, "items": [{"ref": "r1", "tag": "img", "text": "", "box": [400, 100, 500, 500]}],
                    "shot": None, "url": self.s["url"]}
        if c == "state":
            return {"ok": True, "account": "Jake Dawson"}
        if c == "find":
            found = {t: [] for t in m.get("texts", [])}
            if self.has_newbg and "newbg" in found:
                found["newbg"] = [{"tag": "div", "text": "newbg — Change background", "selector": 'div[role="option"]'}]
            if "Markup" in found and self.s["viewer"]:
                found["Markup"] = [{"tag": "button", "text": "Markup", "selector": 'button[aria-label="Markup"]'}]
            return {"ok": True, "found": found}
        return {"ok": True}

    def close(self):
        pass


class Reply(dict):
    @property
    def text(self):
        return self["text"]


def scripted_llm(turns, usd=0.05):
    """A fake ctx.llm: the explorer's turns in order, the P4 plain-words call by its purpose."""
    seq = list(turns)
    calls = []

    def f(model, system, content, max_tokens, **kw):
        calls.append({"model": model, "purpose": kw.get("purpose"), "stage": kw.get("stage")})
        if "plain-words" in str(kw.get("purpose")):
            return Reply(text=json.dumps({"prompt": "Replace the background of this photo with a rustic kitchen",
                                          "expect": "the same bottle photo, now in a rustic kitchen"}), usd=0.01)
        return Reply(text=json.dumps(seq.pop(0) if seq else {"do": "give_up", "note": "no more turns"}), usd=usd)
    f.calls = calls
    return f


MARKUP_TURNS = [
    {"do": "find", "note": "where is Markup", "texts": ["Markup"]},
    {"do": "act", "note": "open the viewer", "action": {"type": "click", "selector": '[data-testid="generated-image-preview"]'}},
    {"do": "act", "note": "markup mode", "action": {"type": "click", "target": "Markup"}},
    {"do": "act", "note": "drag a box", "action": {"type": "drag", "selector": '[data-testid="generated-image-preview"]',
                                                   "rel_from": [0.3, 0.4], "rel_to": [0.6, 0.7]}},
    {"do": "propose", "note": "a box appears", "proposal": {
        "id": "markup_box_drag", "kind": "drag", "label": "Drag a markup box over the image",
        "selectors": ['[data-testid="generated-image-preview"]'], "rel_from": [0.3, 0.4], "rel_to": [0.6, 0.7],
        "requires": ["open_image_viewer", "viewer_markup"], "start": "chat_with_image",
        "post": [{"kind": "selector", "selector": "[data-markup-box]"}], "intents": ["\\bdrag a box\\b"]}},
]


def make_ctx(out, llm_call, budget=None, page=Page, image_api=None, in_app=None, check_fn=None, kit_capture=None,
             kit_app=None, clock=None):
    out.mkdir(parents=True, exist_ok=True)
    pb = onboard.job_playbook(out, "chatgpt")
    clk = clock or FakeClock()
    sp = preprod.Spacer(45, clock=clk, sleep=clk.sleep)
    return onboard.Ctx(out, "chatgpt", "https://chatgpt.com/", pb, transport_factory=page, llm_call=llm_call,
                       image_api=image_api or (lambda prompt, dst, q: (Path(dst).write_bytes(PNG), 0.06)[1]),
                       in_app=in_app, check=check_fn or (lambda a, f, objs: {"matches": True, "missing_objects": [], "usd": 0.02}),
                       spacer=sp, kit_capture=kit_capture, budget=budget or onboard.Budget(9.5),
                       image_chat="https://chatgpt.com/c/job-made-chat-1", kit_app=kit_app)


class FakeClock:
    def __init__(self):
        self.t, self.slept = 1000.0, []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


# ─────────────────────────── (1) the 43 holds, by group ───────────────────────────
def test_groups():
    rows = [{"why": r["detail"]} for r in json.load(open(ROOT / "tests/fixtures/r14/held-test-v2.json"))["reasons"]]
    check(len(rows) == 43, "43 needs_primitive in the test-v2 job")
    rep = onboard.needs_report(rows)
    n = {g: len(v) for g, v in rep.items()}
    check(sum(n.values()) == 43 and all(n[g] for g in "ABCD"), f"every hold has a group: {n}")
    g = {r["why"]: r["group"] for v in rep.values() for r in v}
    check(g["No markup box-drag action."] == "A" and g["No comment-pin placement action."] == "A", "markup / pins → A")
    check(g["phone_photo asset is missing; upload_photo needs the file."] == "B"
          and g["No colorized great-grandma picture among the produced assets"] == "B", "photos → B")
    check(g["The '/' menu has no background skill (slash_newbg missing)"] == "C"
          and g["No 'Updated' badge exists; the chat framing just holds."] == "C", "missing features → C")
    check(all(r["group"] == "D" for r in rep["D"]) and any("structure share" in r["why"] for r in rep["D"])
          and any("not on screen after the span structure" in r["why"] for r in rep["D"]), "gate near-misses → D")
    # structured rows (the R14 plan) route by kind / code
    check(onboard.classify({"kind": "action"}) == "A" and onboard.classify({"code": "new_asset"}) == "B"
          and onboard.classify({"code": "feature"}) == "C" and onboard.classify({"code": "screen_ref"}) == "D", "codes")
    # never a hold for needs_primitive by itself
    check(preprod.held_items({"needs_primitive": rows}, {"assets": []}) == [], "needs_primitive never holds (R14)")
    print(f"  the 43 holds: {n}")
    return n


# ─────────────────────────── (2) P2: per-video playbook + onboarding ───────────────────────────
def test_onboarding():
    shared = skill.playbook_path("chatgpt")
    before = sha(shared)
    out = TMP / "job1" / "preprod"
    f = scripted_llm(MARKUP_TURNS)
    ctx = make_ctx(out, f)
    check((out / "playbook-chatgpt.json").exists(), "this video's playbook is in the job")
    row = onboard.onboard_action(ctx, "in Markup mode drag a box over the bottle's label")
    check(row["status"] == "proven" and row["replays"] == "3/3", f"onboarded + proven 3/3: {row}")
    pb = json.loads((out / "playbook-chatgpt.json").read_text())
    a = pb["actions"].get(row["action_id"])
    check(a and a["proven"] and a["kind"] == "drag" and a["video_proof"]["ok"] == 3, f"written to the JOB playbook: {a}")
    check(a["start_url"] == "{chat_url}" and all(r["ok"] for r in a["replays"]) and len(a["replays"]) == 3, "3 fresh sessions")
    check(sha(shared) == before and row["action_id"] not in json.loads(shared.read_text())["actions"],
          "the shared skill playbook is never written")
    opens = [m for m in Page.log if m.get("cmd") == "open"]
    check(all("job-made-chat-1" in m["url"] or m["url"] == "https://chatgpt.com/" for m in opens),
          "only the start page or a chat this job made is opened")
    st = playbook.resolve(pb, row["action_id"], {"chat_url": "x"})
    check(st[0]["type"] == "drag" and st[0]["rel_from"] == [0.3, 0.4] and "selector" in st[0], f"element-relative drag: {st}")
    check(onboard.playbook_path(out, "chatgpt").parent == out, "the per-video playbook path is inside the job")
    check(all(c["stage"] == "preprod.onboard.chatgpt" for c in f.calls), "every onboarding call is staged for the ledger")
    # a failing proposal is fed back and fixed (fix round)
    Page.log.clear()
    turns_bad = MARKUP_TURNS[:4] + [{"do": "propose", "note": "no requires", "proposal": {**MARKUP_TURNS[4]["proposal"],
                                                                                      "id": "markup_drag2", "requires": []}}] + MARKUP_TURNS[4:]
    ctx2 = make_ctx(TMP / "job2" / "preprod", scripted_llm(turns_bad))
    r2 = onboard.onboard_action(ctx2, "drag a markup box")
    check(r2["status"] == "proven" and len(r2["attempts"]) == 2 and "drag needs" in str(r2["attempts"][0].get("replays")),
          f"a failed proof is fed back, the fix is proven: {r2['status']} {len(r2['attempts'])}")
    # absent → reported (P4 then)
    r3 = onboard.onboard_action(make_ctx(TMP / "job3" / "preprod", scripted_llm([{"do": "absent", "note": "no '/newbg' "
                                                                                 "anywhere: '/' menu, '+' menu"}])), "/newbg")
    check(r3["status"] == "absent", "an absent control is reported as absent")


# ─────────────────────────── (3) the guard ───────────────────────────
def test_guard():
    g = onboard.Guarded(Page(), playbook.load("chatgpt"), allowed_chats=["https://chatgpt.com/c/mine"])
    check(g.send({"cmd": "act", "action": {"type": "click", "target": "Delete chat"}}).get("refused"), "no delete")
    check(g.send({"cmd": "act", "action": {"type": "click", "target": "Log out"}}).get("refused"), "no log out")
    check(g.send({"cmd": "act", "action": {"type": "click", "target": "Upgrade plan"}}).get("refused"), "no upgrade")
    check(g.send({"cmd": "open", "url": "https://chatgpt.com/c/jakes-old-chat"}).get("refused"), "never an existing chat")
    check(not g.send({"cmd": "open", "url": "https://chatgpt.com/c/mine"}).get("refused"), "a chat this job made is fine")
    check(g.send({"cmd": "act", "action": {"type": "click", "target": "Send"}}).get("refused"), "no generating press")
    check(g.send({"cmd": "act", "action": {"type": "key", "key": "Enter"}}).get("refused"), "no Enter (send)")
    clk = FakeClock()
    g2 = onboard.Guarded(Page(), playbook.load("chatgpt"), allow_generate=True, spacer=preprod.Spacer(45, clock=clk, sleep=clk.sleep))
    g2.send({"cmd": "act", "action": {"type": "click", "target": "Send"}})
    g2.send({"cmd": "act", "action": {"type": "click", "target": "Send"}})
    check(g2.generations == 2 and clk.slept and min(clk.slept) >= 45 - 1e-9, f"generations spaced >= 45 s: {clk.slept}")


# ─────────────────────────── (4) the budget ───────────────────────────
class FakeAPI:
    def __init__(self):
        self.n = 0

    def __call__(self, body, stream, timeout):
        self.n += 1
        return {"content": [{"type": "text", "text": json.dumps({"do": "observe", "note": "looking"})}],
                "usage": {"input_tokens": 40000, "output_tokens": 2000}, "stop_reason": "end_turn"}


def test_budget():
    llm.TRANSPORT = FakeAPI()
    llm.set_context(job="r14-budget", stage="preprod", workflow="creative")
    try:
        ctx = make_ctx(TMP / "job4" / "preprod", llm.messages, budget=onboard.Budget(1.0))
        row = onboard.onboard_action(ctx, "drag a markup box")
        check(row["status"] == "failed" and row.get("budget") and "onboarding budget" in row["why"], f"the app cap stops it: {row}")
        check(ctx.budget.spent <= 1.0 + 1e-9, f"never over the per-app cap: {ctx.budget.spent}")
        rows = [r for r in apiledger.rows() if r.get("job") == "r14-budget"]
        check(rows and all(r["stage"] == "preprod.onboard.chatgpt" for r in rows), "every call is in the API ledger")
        check(abs(sum(r["usd"] for r in rows) - ctx.budget.spent) < 1e-6, "the budget = the ledger")
    finally:
        llm.clear_context()
    check(apiledger.caps("creative")[0] == 17.5 and onboard.app_cap() == 9.5, "creative job cap $17.50, onboarding $9.50 per app")


# ─────────────────────────── (5) P3 assets ───────────────────────────
def test_assets():
    """Jake 2026-10-10: assets are made IN THE APP (no image API). The simple path (no producer agent): spaced,
    retried, checked; a genuine failure is named. The agent itself is covered by tests/test_producer.py."""
    fails = {"n": 0}
    prompts = []

    def flaky(a, dst, files):
        fails["n"] += 1
        prompts.append(a["prompt"])
        if fails["n"] <= 2:
            raise RuntimeError("no image")
        Path(dst).write_bytes(PNG)
        return {"chat_url": "https://chatgpt.com/c/job-gen"}
    clk = FakeClock()
    ctx = make_ctx(TMP / "job5" / "preprod", scripted_llm([]), in_app=flaky, clock=clk)
    ctx.llm = None
    row = onboard.produce_asset(ctx, "blurry_photo", "the photo: a blurry phone photo of a hot sauce bottle, uh, on a desk")
    check(row["status"] == "ready" and row["kind"] == "app_generation" and len(row["attempts"]) == 2, f"retried: {row['attempts']}")
    check(len(clk.slept) >= 2 and min(clk.slept) >= 45 - 1e-9, "spaced >= 45 s")
    check(prompts[0].startswith("Create an image: ") and " uh" not in prompts[0] and "the photo:" not in prompts[0],
          f"a clean image request, never the raw narration (TEST v3): {prompts[0][:120]}")
    again = onboard.produce_asset(ctx, "blurry_photo", "the photo: a blurry phone photo of a hot sauce bottle, uh, on a desk")
    check(again["status"] == "ready" and fails["n"] == 3, "an asset made and checked by an earlier run is reused (no new try)")
    checks = {"n": 0}

    def ok_app(a, dst, files):
        Path(dst).write_bytes(PNG)
        return {"chat_url": "https://chatgpt.com/c/job-gen"}

    def picky(a, f, objs):
        checks["n"] += 1
        return {"matches": False, "missing_objects": ["the bottle"], "usd": 0.02}
    ctx2 = make_ctx(TMP / "job6" / "preprod", scripted_llm([]), in_app=ok_app, check_fn=picky)
    ctx2.llm = None
    row2 = onboard.produce_asset(ctx2, "desk_photo", "a phone photo of the bottle on a desk")
    check(row2["status"] == "needs_asset" and checks["n"] == 10 and "every try failed" in row2["why"],
          f"10 checked tries, then a named failure: {row2.get('why')}")
    ctx3 = make_ctx(TMP / "job7" / "preprod", scripted_llm([]))
    row3 = onboard.produce_asset(ctx3, "face_photo", "a photo with a face")
    check(row3["status"] == "needs_asset" and "no app session" in row3["why"], "no app session: named, never an image API")
    check(onboard.asset_kind("the colorized result") == "app_generation" and onboard.asset_kind("his phone photo") == "photo",
          "inputs vs results still told apart (the phone style is only for an input photo)")


# ─────────────────────────── (6) P4 ───────────────────────────
def test_p4():
    ctx = make_ctx(TMP / "job8" / "preprod", scripted_llm([]))
    v = onboard.verify_feature(ctx, "/newbg skill", "/newbg rustic kitchen")
    check(v["absent"] and any("typed '/newbg'" in s for s in v["searched"]) and any("'+' menu" in s for s in v["searched"]),
          f"absence verified in the '/' and '+' menus: {v['searched']}")
    ctx_b = make_ctx(TMP / "job9" / "preprod", scripted_llm([]), page=lambda: Page(has_newbg=True))
    check(not onboard.verify_feature(ctx_b, "/newbg skill", "/newbg rustic kitchen")["absent"], "a feature that is there is found")
    k = onboard.ensure_kit(ctx)
    check(k["status"] == "copied" and (TMP / "job8/preprod/ui-kits/chatgpt/kit.json").exists(), f"this video's kit (copied hint): {k}")
    called = []

    def capture(app, dst, url):
        called.append(app)
        return None                                      # a capture that makes nothing
    ctx2 = make_ctx(TMP / "job10" / "preprod", scripted_llm([]), kit_capture=capture, kit_app="newapp")
    k2 = onboard.ensure_kit(ctx2)
    check(called == ["newapp"] and k2["status"] == "neutral", f"no kit → a capture is scheduled first, then neutral: {k2}")

    def capture_ok(app, dst, url):
        dst.mkdir(parents=True, exist_ok=True)
        kit = json.loads((skill.ROOT / "ui-kits/chatgpt/kit.json").read_text())
        kit.update(app=app, name=app)
        (dst / "kit.json").write_text(json.dumps(kit))
        return dst / "kit.json"
    k3 = onboard.ensure_kit(make_ctx(TMP / "job11" / "preprod", scripted_llm([]), kit_capture=capture_ok, kit_app="newapp2"))
    check(k3["status"] == "captured", f"a captured kit is used: {k3}")


# ─────────────────────────── (7) P5 numbers ───────────────────────────
def test_p5():
    r = skill.rules()
    st, pc = r["structure"], r["pace"]
    check("Jake R14 P5" in st["src"] and "Jake R14 P5" in pc["src"], "documented with 'Jake R14 P5'")
    check(st["span_p50_s"] == [12.0, 21.5] and st["span_max_s"] == 36.0 and st["min_span_s"] == 3.0
          and st["screencast_share"] == [0.75, 0.8], "spans x1.2, share 0.75-0.80, min span 3 s")
    check(planfit.SPAN_MAX == 36.0 and planfit.MIN_SPAN == 3.0 and planfit.SHARE == (0.75, 0.8), "planfit reads them")
    check(1.15 <= pc["scale"] <= 1.25 and abs(beatscript.PACE_AFTER["click"] - 0.36) < 1e-9
          and abs(beatscript.PACE_AFTER["type"] - 0.48) < 1e-9, "holds after each beat +20 %")
    sys.path.insert(0, str(ROOT / "screencast"))
    import camera as CAM
    base = dict(CAM.DEFAULTS)
    p = CAM.apply_pace(dict(base))
    check(abs(p["zoom_in_frames"] - base["zoom_in_frames"] * 1.2) < 0.01 and p["zoom_in_ease"] == base["zoom_in_ease"]
          and p["hold_max_s"] == base["hold_max_s"], "camera moves x1.2 inside the reference easing; no still over 3 s")
    check(CAM.params()["pace"] == 1.2, "the camera reads the pace")


# ─────────────────────────── (8) D: near-misses fixed by code ───────────────────────────
def _units(spec):
    """[(dur, label, extra)] → planfit units."""
    U, t = [], 0.0
    for k, (d, lab, ex) in enumerate(spec):
        U.append({"k": k, "t0": t, "t1": t + d - 0.2, "next_t0": t + d, "dur": d, "label": lab, "hard": False,
                  "seg": 0 if lab == "S" else None, "sentence_start": True, "ids": [k], "text": "x", **ex})
        t += d
    return U


def test_d():
    # share 0.7133-like: 0.73 with the band at 0.75 → moved into the band at whole-unit edges
    spec = []
    for _ in range(10):
        spec += [(5.0, "S", {}), (5.0, "S", {}), (4.5, "S", {}), (2.6, "A", {}), (3.0, "A", {})]
    U = _units(spec)
    dur = sum(d for d, _, _ in spec)
    share = lambda: sum(u["dur"] for u in U if u["label"] == "S") / dur
    s0 = share()
    check(planfit.SHARE[0] - planfit.SHARE_NEAR <= s0 < planfit.SHARE[0], f"a near miss to start with: {s0:.3f}")
    n = planfit.near_miss_share(U, dur)
    check(n > 0 and planfit.SHARE[0] <= share() <= planfit.SHARE[1], f"share moved into the band: {s0:.3f} → {share():.3f}")
    # a beat span of 1.5 s is lengthened over its free neighbours, not lost
    U2 = _units([(6.0, "A", {}), (1.5, "S", {"cues": 1, "acts": 1}), (2.0, "A", {}), (6.0, "A", {"hard": True})])
    ok = planfit.grow_short(U2, [U2[1]])
    check(ok and U2[2]["label"] == "S" and U2[3]["label"] == "A", "a too-short beat span grows to the minimum (presenter kept)")
    # the uncovered screen reference: "Try typing a forward slash and pick the background skill."
    words, t = [], 0.0
    for k, w in enumerate(("Here we go. " * 6 + "Try typing a forward slash and pick the background skill. " + "So that is "
                           "the idea and it works well. " * 3).split()):
        words.append({"i": k, "word": w, "start": round(t, 2), "end": round(t + 0.3, 2)})
        t += 0.4
    video = {"words": words, "duration": t + 0.5}
    U3 = planfit.units(video)
    for u in U3:
        u.update(label="S" if u["k"] < 6 else "A", seg=0 if u["k"] < 6 else None)
    fixes = planfit.cover_screen_refs(U3, video)
    flagged = next(u for u in U3 if "forward slash" in u["text"])
    check(fixes and flagged["label"] == "S", f"the screen reference is covered by extending the adjacent span: {fixes}")
    # director: a share near miss is a warning, not an error to re-ask or hold
    check("near_miss_points" in skill.rules()["structure"], "near-miss band documented")


# ─────────────────────────── (9) the whole route on a small plan ───────────────────────────
SENTS = ["Open the photo and click Markup.", "Now drag a box over the label and type make it gold.",
         "Then type slash newbg rustic kitchen and watch the background change.",
         "Here is my phone photo of the bottle on my desk.", "That is the whole trick for today."]


def small_video():
    words, t = [], 0.0
    for s in SENTS:
        for w in s.split():
            words.append({"i": len(words), "word": w, "start": round(t, 2), "end": round(t + 0.3, 2)})
            t += 0.38
        t += 0.6
    return {"title": "r14", "duration": round(t + 0.5, 2), "words": words}


def wid(video, word, after=-1):
    return next(w["i"] for w in video["words"] if w["word"].strip(".,").lower() == word.lower() and w["i"] > after)


def test_route():
    video = small_video()
    W = lambda x, a=-1: wid(video, x, a)
    first, last = video["words"][0]["i"], W("desk")
    answer = {"segments": [{"start_word": first, "end_word": last, "app": "chatgpt", "session": "logged_in", "beats": [
        {"word_id": W("photo"), "action": "open_image_viewer", "body": "the image opens", "subject": "screen", "text": None,
         "url": None, "asset_id": None, "live": False, "wait_end_word": None},
        {"word_id": W("Markup"), "action": "viewer_markup", "body": "Markup mode", "subject": "ui:Markup", "text": None,
         "url": None, "asset_id": None, "live": False, "wait_end_word": None},
        {"word_id": W("drag"), "action": "onboard.action", "body": "a box is dragged over the label", "subject": "screen",
         "text": "make it gold", "url": None, "asset_id": None, "live": False, "wait_end_word": None,
         "need": "in Markup mode drag a box over the bottle's label"},
        {"word_id": W("newbg"), "action": "motion.feature", "body": "the /newbg command", "subject": "screen",
         "text": "/newbg rustic kitchen", "url": None, "asset_id": None, "live": False, "wait_end_word": None,
         "need": "/newbg skill"},
        {"word_id": W("photo", W("Here")), "action": "camera.zoom", "body": "his phone photo of the bottle", "subject":
         "asset:phone_photo", "text": None, "url": None, "asset_id": "phone_photo", "live": False, "wait_end_word": None,
         "new_asset": "his phone photo of the hot sauce bottle on a desk"}]}],
        "aroll": [], "plates": [], "needs_primitive": [
            {"sentence": SENTS[4], "word_ids": [W("trick")], "why": "structure share = 0.7133 is outside the band",
             "proposed": None, "kind": "other"}]}
    sites = [{"url": "https://chatgpt.com/"}]
    readiness = {"checks": [], "features": []}
    pbs = {"chatgpt": playbook.load("chatgpt")}
    facts = planfit.Facts(readiness, {"assets": []})
    errs, info = director.check_plan(answer, video, director.apps_for(sites, pbs), facts, sites)
    codes = sorted({e["code"] for e in errs})
    check({"onboard", "feature", "new_asset"} <= set(codes), f"the plan's needs are routed codes: {codes}")
    rows = list(answer["needs_primitive"]) + director.as_needs_primitive([e for e in errs if e["code"] in director.ROUTED_CODES])
    plan = {"answer": answer, "needs_primitive": rows, "warnings": []}
    out = TMP / "jobR" / "preprod"
    made = []

    def in_app(a, dst, files):
        made.append(a["id"])
        Path(dst).write_bytes(PNG)
        return {"chat_url": "https://chatgpt.com/c/job-gen-" + a["id"]}
    shared_before = sha(skill.playbook_path("chatgpt"))
    ctx = make_ctx(out, scripted_llm(MARKUP_TURNS), in_app=in_app)
    assets = {"assets": []}
    res = onboard.route(ctx, {"plan": plan, "raw": {"overlays": []}}, video, sites, assets,
                        lambda a: planfit.Facts(readiness, a))
    check(res["held"] == [], f"nothing held: {res['held']}")
    st = {n["route"]: n["status"] for n in res["needs"]}
    check(st.get("P2") == "onboarded + proven 3/3" and st.get("P4") == "motion graphics" and st.get("P3") == "produced"
          and "D" in st, f"each group took its route: {st}")
    beats = [b for s in res["plan"]["schema_plan"]["segments"] for b in s["beats"]]
    check(any(b["action"].startswith("ob_") for b in beats) and not any(b["action"] in director.NEED_ACTIONS for b in beats),
          "the onboarded action replaces the need; no pseudo-action is left to record")
    mo = [e for e in res["plan"]["overlays"] if e.get("p4")]
    check(len(mo) == 1 and mo[0]["template"] == "prompt_highlight" and mo[0]["fields"]["app"] == "chatgpt"
          and mo[0]["params"]["result_asset"].startswith("p4_"), f"P4: an approved motion beat in the app's kit with its result: {mo}")
    ra = next(a for a in assets["assets"] if a["id"] == mo[0]["params"]["result_asset"])
    check(ra["status"] == "ready" and ra["for"] == "R14 P4" and "rustic kitchen" in json.dumps(ra), f"the result is REAL: {ra['status']}")
    check(not any(s["t0"] < mo[0]["t1"] and mo[0]["t0"] < s["t1"] for s in res["plan"]["segments"]),
          "never a fake screencast under the motion beat")
    check(any(a["id"] == "phone_photo" and a["status"] == "ready" for a in assets["assets"]), "the new asset was produced first")
    check((out / "ui-kits" / "chatgpt" / "kit.json").exists(), "this video's UI kit")
    check(sha(skill.playbook_path("chatgpt")) == shared_before, "the shared playbook untouched")
    check(not res["plan"]["needs_primitive"] and not res["plan"]["held"], "the routed plan never holds for needs_primitive")
    print(f"  route: {res['report']} → {st}; onboarding ${res['usd']:.2f}")


def main():
    test_groups()
    test_onboarding()
    test_guard()
    test_budget()
    test_assets()
    test_p4()
    test_p5()
    test_d()
    test_route()
    print(f"test_onboard: {N} checks passed")


if __name__ == "__main__":
    main()
