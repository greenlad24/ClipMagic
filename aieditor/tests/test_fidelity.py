"""ASSET FIDELITY of the pre-production producer (Jake 2026-10-10, TEST v3 live catches), offline with fakes:
nothing is sent anywhere, no browser, no generation.

  (1) the request is what the PERSON types — never the planner's internal description
  (2) a tool result ("Remove BG result") RUNS the app's tool on the source picture, in the chat where it was made;
      no typed text; the check sees the source
  (3) a different-subject check → the next route is the tool / an edit on the source, never a fresh generation
  (4) the hero subject: a new photo of the same product is an EDIT of the first photo (source_inputs)
  (5) a tool step this video's playbook lacks is onboarded FIRST, then used
  (6) the look: real / impressive / faithful wording; an on-screen prompt verbatim; a wrong-look miss → a reworded try
  (7) narrated details kept ("rustic kitchen" never becomes "modern kitchen")
  (8) P4: the Sketch canvas narration → ui_state, no generation; /newbg → image
  (9) a camera move ("Close on the label", camera.zoom) → D, no generation
  (10) strokes: draw / box needs onboard ONE stroke tool per surface; the shapes / regions are data
  (11) no UI chrome / captions / collages; an input+result description becomes two pictures
  (12) a stored row is reused only if it passes today's checks

Run: python3 tests/test_fidelity.py
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_producer as tp  # noqa: E402  (sets the temp work dir + env first)
from aieditor import director, genledger, onboard, producer  # noqa: E402

N = 0
PNG = tp.PNG
SEL = tp.RESULT


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


class ToolPage(tp.FakePage):
    """The fake app plus its image viewer: open the nth picture of a chat, Remove BG / Erase / an onboarded brush and
    submit — a tool press makes a new picture IN THE SAME CHAT."""

    def send(self, m):
        c = m.get("cmd")
        if c == "open":
            r = super().send(m)
            self.s.update(viewer=False, erase=False, brushed=False)
            return r
        if c == "act":
            a = m["action"]
            t, sel, tgt = a.get("type"), str(a.get("selector") or ""), str(a.get("target") or "")
            ch = self._chat()
            if t == "click" and sel == SEL and ch and ch["images"] > int(a.get("nth") or 0):
                self.s["viewer"] = True
                self.w.opened_nth = int(a.get("nth") or 0)
                return {"ok": True, "url": self.s["url"]}
            if t == "click" and tgt in ("Remove BG", "Erase", "Brush", "Apply erase"):
                if not self.s.get("viewer"):
                    return {"ok": False, "error": "no element"}
                self.w.tool_clicks.append(tgt)
                if tgt == "Erase":
                    self.s["erase"] = True
                elif tgt == "Brush":
                    self.s["brushed"] = True
                else:
                    self.w.sends.append({"prompt": "", "mode": False, "att": [], "url": self.s["url"], "t": self.w.clock(),
                                         "tool": tgt})
                    ch.update(out={"kind": "image"}, polls=0, base=ch["images"])
                return {"ok": True, "url": self.s["url"]}
        if c == "count":
            if m["selector"] == 'button[aria-label="Close viewer"]':
                return {"ok": True, "n": int(bool(self.s.get("viewer")))}
            ch = self._chat()
            if m["selector"] == SEL and ch and "base" in ch:
                ch["polls"] += 1
                if ch["polls"] > 1:
                    ch["images"] = ch["base"] + 1
                return {"ok": True, "n": ch["images"]}
        if c == "text" and self.s.get("erase"):
            r = super().send(m)
            r["text"] += "\nBrush over what you want to remove"
            return r
        return super().send(m)


def make(name, behave=None, check_fn=None, llm=None):
    behave = behave or {"answer": lambda s, p, k: {"kind": "image"}}
    ctx, world, clk, logs, status = tp.make(name, behave, check_fn=check_fn, llm=llm)
    world.tool_clicks, world.opened_nth = [], None
    n = {"k": 0}

    def factory():
        n["k"] += 1
        return ToolPage(world, Path(ctx.out) / "w" / f"t{n['k']}")
    ctx.transport_factory = factory
    if llm is not None:
        ctx.llm = llm
    return ctx, world, clk, logs


def seed_source(ctx, world, aid="phone_photo", desc="a casual phone photo of a hot sauce bottle on a kitchen counter"):
    """A picture this job's producer made earlier, in chat src-1 (one image there)."""
    f = Path(ctx.out) / "assets" / f"{aid}.png"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(PNG)
    world.chats["src-1"] = {"prompt": "Create an image: a bottle", "out": {"kind": "done"}, "polls": 0, "images": 1}
    onboard._remember(ctx, aid, {"file": str(f), "desc": desc, "source": {"chat_url": "https://chatgpt.com/c/src-1", "nth": 0}})
    return str(f)


class Reply(dict):
    @property
    def text(self):
        return self["text"]


def llm_by_purpose(table, calls=None):
    def f(model, system, content, max_tokens, **kw):
        pur = str(kw.get("purpose"))
        if calls is not None:
            calls.append({"purpose": pur, "msgs": kw.get("msgs")})
        for k, v in table.items():
            if k in pur:
                return Reply(text=json.dumps(v(kw) if callable(v) else v), usd=0.001)
        return Reply(text="{}", usd=0.001)
    return f


# ─────────────────────────── (1) wording ───────────────────────────
def test_wording_never_internal():
    tp.fresh_ledger()
    desc = "in-app colorize result: same bottle photo with a warm vintage colour grade"
    # the model echoes the internal description back — code refuses it
    llm = llm_by_purpose({"person request": {"typed": desc, "on_screen": False, "narrated": "", "as_words": desc,
                                             "look": "impressive", "expect": "the bottle, warm vintage colours", "params": []}})
    ctx, world, clk, logs = make("wording", llm=llm)
    seed_source(ctx, world)
    row = onboard.produce_asset(ctx, "warm", desc, made_from=["phone_photo"], sentence="Let's give it a warm vintage look.")
    sent = [s["prompt"] for s in world.sends]
    check(row["status"] == "ready" and sent, f"made: {row.get('why')}")
    check(all(p.strip().lower() != desc.lower() and not re.search(r"\bin-app\b|\bresult\b", p, re.I) for p in sent),
          f"never the internal description: {sent}")
    # no model at all: the plain-words fallback, still not the description
    req = onboard.person_request(type("C", (), {"llm": None, "pb": ctx.pb, "app": "chatgpt"})(), desc, "x")
    check(req["as_words"].lower() != desc.lower() and "in-app" not in req["as_words"] and "result" not in req["as_words"],
          f"no-model fallback: {req['as_words']}")
    print(f"  wording: {sent[0][:80]}")


# ─────────────────────────── (2) a tool result runs the tool ───────────────────────────
def test_tool_on_source():
    tp.fresh_ledger()
    seen = []

    def vision(a, f, objs):
        seen.append(dict(a))
        return {"matches": True, "missing_objects": [], "same_subject": True, "look_ok": True, "clean": True, "usd": 0.01}
    ctx, world, clk, logs = make("tool", check_fn=vision)
    src = seed_source(ctx, world)
    row = onboard.produce_asset(ctx, "bg_removed", "the in-app Remove BG result: the same bottle on plain white",
                                made_from=["phone_photo"])
    check(row["status"] == "ready" and row.get("tool") == "remove_bg", f"made by the tool: {row.get('why')} {row.get('tries')}")
    check(world.tool_clicks == ["Remove BG"] and world.opened[-1].endswith("/c/src-1") and world.opened_nth == 0,
          f"the source opened in its own chat, the tool clicked: {world.tool_clicks} {world.opened}")
    check(len(world.sends) == 1 and world.sends[0]["prompt"] == "" and not world.sends[0]["att"],
          "no typed text, no upload: just the tool's click")
    check(seen and seen[-1].get("source_files") == [src] and seen[-1].get("look") == "faithful",
          f"the check sees the source, faithful look: {seen[-1]}")
    check(row["source"]["chat_url"].endswith("/c/src-1") and row["source"]["nth"] == 1, f"its chat + index: {row['source']}")
    check(len(genledger.used("chatgpt", clk())) == 1, "the tool press is a counted generation")
    print(f"  tool: {row['source']['route']} in {row['source']['chat_url'][-8:]}")


# ─────────────────────────── (3) a different subject → the edit / tool on the source ───────────────────────────
def test_different_subject_edit_route():
    tp.fresh_ledger()
    n = {"k": 0}

    def vision(a, f, objs):
        n["k"] += 1
        return {"matches": True, "missing_objects": [], "same_subject": n["k"] > 1, "subject_diff": "a square bottle, not round",
                "look_ok": True, "clean": True, "usd": 0.01}
    ctx, world, clk, logs = make("subject", check_fn=vision)
    seed_source(ctx, world)
    row = onboard.produce_asset(ctx, "warm", "a colorized version of the bottle photo with warm tones", made_from=["phone_photo"])
    t = row["tries"]
    check(row["status"] == "ready" and t[0]["class"] == "different_subject", f"its own failure class: {t}")
    check(all(s["att"] or s.get("tool") or "/c/src-1" in s["url"] for s in world.sends),
          f"every try works on the source (upload / its chat), never a fresh generation: {world.sends}")
    check(any("same subject" in x["route"] or "again" in x["route"] for x in t[1:]), f"the next route keeps the subject: {t}")
    # the planner may not pick a fresh generation either
    pr = ctx.producer
    check(pr.validate({"start": "home", "steps": [{"action": "paste_prompt"}, {"action": "send"}]}) is not None,
          "a fresh generation is refused for a picture made from a source")
    # a TOOL result that comes back as a different bottle → the tool again, then a logged described edit
    tp.fresh_ledger()
    box = {}
    ctx2, world2, clk2, logs2 = make("subject-tool", check_fn=lambda a, f, o: {
        "matches": True, "missing_objects": [], "same_subject": len(box["w"].sends) >= 3, "look_ok": True, "clean": True,
        "usd": 0.01})
    box["w"] = world2
    seed_source(ctx2, world2)
    row2 = onboard.produce_asset(ctx2, "bg2", "the Remove BG result: the bottle on white", made_from=["phone_photo"])
    routes = [x["route"] for x in row2["tries"]]
    check(row2["status"] == "ready" and "again" in routes[1] and "described edit" in routes[2], f"tool, tool again, described: {routes}")
    check(any("falling back to a described edit" in x for x in logs2), "the fallback is logged")
    print(f"  different subject → {t[1]['route']}")


# ─────────────────────────── (4) the hero subject ───────────────────────────
def test_hero_subject_reused():
    tp.fresh_ledger()
    calls = []

    def src(kw):
        txt = json.dumps(kw.get("msgs"))
        if "desk" in txt and "phone_photo" in txt:
            return {"needs_inputs": True, "inputs": [{"id": "phone_photo", "desc": "the bottle photo"}],
                    "instruction": "Put this exact bottle on a wooden desk", "same_as": ""}
        return {"needs_inputs": False, "inputs": [], "instruction": "", "same_as": ""}
    llm = llm_by_purpose({"source pictures": src, "person request": {
        "typed": "Put this exact bottle on a wooden desk", "on_screen": False, "narrated": "", "as_words": "",
        "look": "real", "expect": "the same bottle on a desk", "params": []}}, calls)
    ctx, world, clk, logs = make("hero", llm=llm)
    seed_source(ctx, world)
    row = onboard.produce_asset(ctx, "desk_photo", "a phone photo of the same hot sauce bottle on a desk")
    check(row["status"] == "ready" and row["made_from"] == ["phone_photo"], f"an edit of the hero photo: {row.get('made_from')}")
    check(len(world.sends) == 1 and world.sends[0]["att"] and "exact bottle" in world.sends[0]["prompt"],
          f"one generation, the hero photo attached: {world.sends}")
    check(any("phone_photo: a casual phone photo" in json.dumps(c["msgs"]) for c in calls if "source" in c["purpose"]),
          "the source picker sees the available pictures' descriptions")
    # the very same picture again → reused, no generation
    llm2 = llm_by_purpose({"source pictures": {"needs_inputs": False, "inputs": [], "instruction": "", "same_as": "phone_photo"}})
    ctx.llm = llm2
    n0 = len(world.sends)
    row2 = onboard.produce_asset(ctx, "counter_photo", "phone photo of a hot sauce bottle on a kitchen counter, bad light")
    check(row2["status"] == "ready" and len(world.sends) == n0 and row2["source"]["reused"] == "phone_photo",
          "the same picture is reused, not generated again")
    print("  hero: desk_photo = edit of phone_photo; counter_photo = phone_photo")


# ─────────────────────────── (5) a missing tool step is onboarded first ───────────────────────────
def test_missing_tool_action_onboarded():
    tp.fresh_ledger()
    ctx, world, clk, logs = make("onboard-tool")
    seed_source(ctx, world)
    order = []
    real = onboard.onboard_action

    def fake_onboard(c, need, params=None, generates=False, generating=False):
        order.append(("onboard", need[:30], generating, len(world.sends)))
        aid = "ob_apply_erase" if generating else "ob_brush"
        c.pb["actions"][aid] = {"kind": "click", "label": aid, "selectors": ["text=" + ("Apply erase" if generating else "Brush")],
                                "requires": ["open_image_viewer", "viewer_erase"], "generates": bool(generating), "proven": True, "source": "test fake"}
        return {"status": "proven", "action_id": aid}
    onboard.onboard_action = fake_onboard
    try:
        row = onboard.produce_asset(ctx, "erase_result", "ChatGPT's Erase result: the napkin only partly removed",
                                    made_from=["phone_photo"], sentence="highlight the napkin")
        n_on = len(order)
        row_b = onboard.produce_asset(ctx, "erase_two", "the Erase result again on the same photo", made_from=["phone_photo"])
    finally:
        onboard.onboard_action = real
    check(row["status"] == "ready" and row.get("tool") == "erase", f"made by the erase tool: {row.get('why')} {row.get('tries')}")
    check(n_on == 2 and all(o[3] == 0 for o in order) and order[1][2] is True,
          f"both missing steps onboarded BEFORE any generation, the submit as a generating step: {order}")
    check(world.tool_clicks[:3] == ["Erase", "Brush", "Apply erase"], f"then used: {world.tool_clicks}")
    pb = json.loads((Path(ctx.out) / "playbook-chatgpt.json").read_text())
    check(set((pb.get("produce") or {}).get("tool_actions", {}).values()) == {"ob_brush", "ob_apply_erase"},
          "remembered in this video's playbook")
    check(row_b["status"] == "ready" and len(order) == n_on, "the next erase reuses them (no second onboarding)")
    print(f"  missing tool step: onboarded {n_on}, then {world.tool_clicks[:3]}")


# ─────────────────────────── (6) the look ───────────────────────────
def test_look_wording():
    real = onboard.with_look("a professional studio shot of a hot sauce bottle, cinematic light", "real")
    check(not re.search(r"professional|cinematic|studio", real, re.I) and "phone snapshot" in real, f"real: {real}")
    imp = onboard.with_look("the bottle on a rustic counter, morning light", "impressive")
    check("rustic counter, morning light" in imp and "composition" in imp, f"impressive: {imp}")
    fa = onboard.with_look("the bottle with a stunning, beautiful partial erase", "faithful")
    check(not re.search(r"stunning|beautiful", fa, re.I) and fa.endswith("partial erase"), f"faithful: {fa}")
    check("Casual phone snapshot" in onboard.look_style("real") and onboard.look_style("faithful") == "", "new-photo cues")
    # the on-screen prompt is sent VERBATIM, no look added
    tp.fresh_ledger()
    said = "Bring me into the Grand Canyon at sunset, standing on the rim"
    llm = llm_by_purpose({"person request": {"typed": said, "on_screen": True, "narrated": said, "as_words": said,
                                             "look": "impressive", "expect": "him at the Grand Canyon", "params": []}})
    ctx, world, clk, logs = make("verbatim", llm=llm)
    row = onboard.produce_asset(ctx, "canyon", "the app's picture of him at the Grand Canyon", sentence=said)
    check(row["status"] == "ready" and world.sends[0]["prompt"] == said, f"verbatim: {world.sends[0]['prompt']}")
    # a real photo: the new-photo prompt carries the real cues, never gloss
    tp.fresh_ledger()
    llm2 = llm_by_purpose({"person request": {"typed": "", "on_screen": False, "narrated": "", "as_words": "",
                                              "look": "real", "expect": "a bottle on a counter", "params": []},
                           "image prompt": {"prompt": "a professional photo of a hot sauce bottle on a kitchen counter, crumbs"}})
    ctx2, world2, *_ = make("real", llm=llm2)
    onboard.produce_asset(ctx2, "phone_photo", "the phone photo he brings: a bottle on his counter, crumbs")
    p2 = world2.sends[0]["prompt"]
    check("Casual phone snapshot" in p2 and not re.search(r"professional|cinematic|studio", p2, re.I) and "crumbs" in p2,
          f"real look prompt: {p2}")
    # a wrong-look miss → a reworded try
    tp.fresh_ledger()
    n = {"k": 0}

    def vision(a, f, objs):
        n["k"] += 1
        return {"matches": True, "missing_objects": [], "look_ok": n["k"] > 1, "look_why": "glossy, studio-like", "clean": True,
                "usd": 0.01}
    ctx3, world3, *_ = make("wronglook", llm=llm2, check_fn=vision)
    row3 = onboard.produce_asset(ctx3, "phone_photo", "the phone photo he brings: a bottle on his counter, crumbs")
    t = row3["tries"]
    check(row3["status"] == "ready" and t[0]["class"] == "wrong_look" and world3.sends[0]["prompt"] != world3.sends[1]["prompt"]
          and onboard.LOOK_BOOST["real"].strip() in world3.sends[1]["prompt"], f"reworded: {world3.sends[1]['prompt']}")
    print("  look: real / impressive / faithful wording, verbatim on-screen prompt, wrong look → reworded")


# ─────────────────────────── (7) narrated details kept ───────────────────────────
def test_details_kept():
    calls = []
    llm = llm_by_purpose({"plain-words": {"result_kind": "image", "prompt": "Replace the background with a bright, modern kitchen",
                                          "expect": "the bottle in a kitchen", "narrated": "rustic kitchen", "look": "impressive",
                                          "uses_asset": ""}}, calls)
    ctx, world, *_ = make("details", llm=llm)
    r = onboard.plain_request(ctx, "/newbg skill", "/newbg rustic kitchen", "type slash newbg rustic kitchen")
    check(len([c for c in calls if "plain-words" in c["purpose"]]) == 2, "a dropped detail is retried once")
    check("rustic" in r["prompt"] and not onboard.missing_words("rustic kitchen", r["prompt"]), f"kept: {r['prompt']}")
    check(onboard.missing_words("rustic kitchen", "a bright, modern kitchen") == ["rustic"], "the check names the dropped word")
    check(not onboard.missing_words("give the chili pepper a little char", "Give the chili pepper a little char, charred edges"),
          "a kept word counts")
    print(f"  details kept: {r['prompt']}")


# ─────────────────────────── (8) P4: ui_state vs image ───────────────────────────
def _p4_route(name, feature, text, sentences, kind):
    import test_onboard as to
    words, t = [], 0.0
    for s in sentences:
        for w in s.split():
            words.append({"i": len(words), "word": w, "start": round(t, 2), "end": round(t + 0.3, 2)})
            t += 0.38
        t += 0.6
    video = {"title": "p4", "duration": t + 0.5, "words": words}
    w0 = next(w["i"] for w in words if feature.split()[0].strip("/").lower() in w["word"].lower())
    answer = {"segments": [{"start_word": 0, "end_word": words[-1]["i"], "app": "chatgpt", "session": "logged_in", "beats": [
        {"word_id": w0, "action": "motion.feature", "body": feature, "subject": "screen", "text": text, "url": None,
         "asset_id": None, "live": False, "wait_end_word": None, "need": feature}]}], "aroll": [], "plates": [],
        "needs_primitive": []}
    rows = [{"sentence": sentences[1], "word_ids": [w0], "why": f"{feature} — no such button", "code": "feature",
             "proposed": {"word_id": w0, "need": feature, "text": text}}]
    calls, made = [], []
    llm = llm_by_purpose({"plain-words": {"result_kind": kind, "prompt": "" if kind != "image" else
                                          "Replace the background of this photo with a rustic kitchen",
                                          "expect": "the canvas" if kind != "image" else "the bottle in a rustic kitchen",
                                          "narrated": text or "", "look": "impressive",
                                          "uses_asset": "sketch" if kind != "image" else ""}}, calls)

    def in_app(a, dst, files):
        made.append(a["id"])
        Path(dst).write_bytes(PNG)
        return {"chat_url": "https://chatgpt.com/c/job-x"}
    ctx = to.make_ctx(to.TMP / name / "preprod", llm, in_app=in_app)
    sk = Path(ctx.out) / "assets" / "sketch.png"
    sk.parent.mkdir(parents=True, exist_ok=True)
    sk.write_bytes(PNG)
    assets = {"assets": [{"id": "sketch", "kind": "sketch", "status": "ready", "file": str(sk), "desc": "his doodle"}]}
    res = onboard.route(ctx, {"plan": {"answer": answer, "needs_primitive": rows, "warnings": []}, "raw": {"overlays": []}},
                        video, [{"url": "https://chatgpt.com/"}], assets,
                        lambda a: to.planfit.Facts({"checks": [], "features": []}, a))
    win = json.dumps([c["msgs"] for c in calls if "plain-words" in c["purpose"]])
    return res, made, win


def test_p4_result_kind():
    res, made, win = _p4_route("p4ui", "Sketch button on the image toolbar", None, [
        "Look at the toolbar here.", "Click Sketch on the image toolbar.", "A blank canvas comes up.", "And you draw.",
        "Squat bottle, a table, a sun."], "ui_state")
    p4 = res["p4"]
    check(made == [] and p4 and p4[0]["result_kind"] == "ui_state" and p4[0]["result_asset"] is None
          and p4[0]["ui_asset"] == "sketch", f"the Sketch canvas: ui_state, NO generation, the doodle inside: {p4} {made}")
    check("A blank canvas comes up." in win and "And you draw." in win, "the call saw the narration around the feature")
    res2, made2, _ = _p4_route("p4img", "/newbg skill", "/newbg rustic kitchen", [
        "Here is my photo.", "Type /newbg rustic kitchen and hit send.", "And the background changes."], "image")
    check(made2 and res2["p4"][0]["result_kind"] == "image" and res2["p4"][0]["result_asset"], f"/newbg → an image: {made2}")
    print(f"  P4: Sketch → ui_state (0 generations); /newbg → image ({len(made2)} generation)")


# ─────────────────────────── (9) a camera move is never a generation ───────────────────────────
def test_camera_need_is_d():
    row = {"sentence": "Close on the bottle's label.", "word_ids": [5], "code": "structure", "kind": "feature",
           "why": "structure at 855.5 s: the beat 'Close on the bottle's label' needs a picture",
           "proposed": {"action": "camera.zoom", "need": "Close on the bottle's label"}}
    check(onboard.classify(row) == "D", "camera.zoom → D")
    check(onboard.classify({"kind": "action", "proposed": {"need": "zoom in close on the label of the bottle"}}) == "D",
          "a zoom need → D whatever its kind")
    check(onboard.classify({"kind": "action", "proposed": {"need": "in the image viewer click the Download button"}}) == "A",
          "a real app action stays A")
    tp.fresh_ledger()
    ctx, world, *_ = make("camera")
    r = onboard.produce_asset(ctx, "zoom", "Zoom in close on the bottle's label in this photo")
    check(r["status"] == "not_a_picture" and not world.sends and not genledger.used("chatgpt", world.clock()),
          f"the guard before any generation: {r}")
    print("  camera: Close on the label → D, 0 generations")


# ─────────────────────────── (10) strokes ───────────────────────────
def test_strokes_are_data():
    needs = ["on the Sketch canvas pick the pen and start a stroke", "draw a crude squat bottle mid-canvas, as in asset 'sketch'",
             "draw a crude picnic table under the bottle, as in 'sketch'", "draw a wonky sun top right, as in 'sketch'",
             "draw a chili pepper by the bottle, as in 'sketch'"]
    keys = {onboard.stroke_need(n)["key"] for n in needs}
    check(keys == {"stroke:canvas:draw"}, f"one stroke tool for every shape: {keys}")
    sk = onboard.stroke_need(needs[1])
    check("never draw or invent a shape" in sk["onboard"] and sk["params"]["strokes"], "the explorer proves one test stroke only")
    check(onboard.stroke_need("click the check mark on the Sketch canvas to submit the drawing") is None, "a click is no stroke")
    ctx, world, *_ = make("strokes")
    shapes = [onboard.bind_stroke(ctx, {"need": n, "body": n, "subject": "screen"}, sk)["subject"] for n in needs[1:]]
    check(shapes == ["shape:bottle", "shape:table", "shape:sun", "shape:pepper"], f"each beat names its doodle shape: {shapes}")
    box = onboard.stroke_need("in Markup mode drag a box over the blank front of the label")
    er = onboard.stroke_need("in Erase mode, brush over the napkin next to the bottle so it is highlighted")
    check(box["key"] == "stroke:markup:box" and er["key"] == "stroke:erase:brush" and er["target"] == "the napkin", f"{box} {er}")
    f = Path(ctx.out) / "assets" / "photo.png"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(PNG)
    ctx.asset_files["photo"] = str(f)
    asked = []
    ctx.locate = lambda img, target: (asked.append(target), [0.6, 0.5, 0.8, 0.7])[1]
    bt = onboard.bind_stroke(ctx, {"need": "x"}, er, "photo")
    check(asked == ["the napkin"] and bt["params"] == {"rel_from": [0.6, 0.6], "rel_to": [0.8, 0.6]}, f"the region is data: {bt}")
    bt2 = onboard.bind_stroke(ctx, {"need": "x"}, box, "photo")
    check(bt2["params"] == {"rel_from": [0.6, 0.5], "rel_to": [0.8, 0.7]}, "a markup box spans the region")
    # the A loop onboards the stroke tool ONCE for all the shapes
    import test_onboard as to
    sents = ["Now I draw.", "A squat bottle.", "A picnic table.", "A wonky sun.", "A chili pepper."]
    words, t = [], 0.0
    for s in sents:
        for w in s.split():
            words.append({"i": len(words), "word": w, "start": round(t, 2), "end": round(t + 0.3, 2)})
            t += 0.38
        t += 0.6
    video = {"title": "s", "duration": t + 0.5, "words": words}
    wid = lambda x: next(w["i"] for w in words if w["word"].strip(".").lower() == x)
    beats = [{"word_id": wid(x), "action": "onboard.action", "body": n, "subject": "screen", "text": None, "url": None,
              "asset_id": None, "live": False, "wait_end_word": None, "need": n}
             for x, n in zip(("bottle", "table", "sun", "pepper"), needs[1:])]
    answer = {"segments": [{"start_word": 0, "end_word": words[-1]["i"], "app": "chatgpt", "session": "logged_in",
                            "beats": beats}], "aroll": [], "plates": [], "needs_primitive": []}
    rows = [{"sentence": sents[k + 1], "word_ids": [b["word_id"]], "why": "no such action", "code": "onboard",
             "proposed": {"word_id": b["word_id"], "need": b["need"]}} for k, b in enumerate(beats)]
    called = []
    real = onboard.onboard_action

    def fake_onboard(c, need, params=None, generates=False, generating=False):
        called.append((need, params))
        c.pb["actions"]["ob_canvas_stroke"] = {"kind": "draw", "label": "a pen stroke on the canvas",
                                               "selectors": ["canvas"], "params": {}, "requires": [], "proven": True, "source": "test fake"}
        return {"status": "proven", "action_id": "ob_canvas_stroke"}
    onboard.onboard_action = fake_onboard
    try:
        c2 = to.make_ctx(to.TMP / "strokes-route" / "preprod", llm_by_purpose({}))
        res = onboard.route(c2, {"plan": {"answer": answer, "needs_primitive": rows, "warnings": []}, "raw": {"overlays": []}},
                            video, [{"url": "https://chatgpt.com/"}], {"assets": []},
                            lambda a: to.planfit.Facts({"checks": [], "features": []}, a))
    finally:
        onboard.onboard_action = real
    check(len(called) == 1 and called[0][1]["strokes"], f"ONE onboarding for 4 shapes, with a test stroke: {len(called)}")
    subj = sorted(b["subject"] for s in res["plan"]["schema_plan"]["segments"] for b in s["beats"]
                  if b["action"] == "ob_canvas_stroke")
    check(subj == ["shape:bottle", "shape:pepper", "shape:sun", "shape:table"], f"every shape replays the one action: {subj}")
    print("  strokes: 4 shapes → 1 onboarded stroke tool; regions by vision")


# ─────────────────────────── (11) clean pictures, input + result ───────────────────────────
def test_clean_and_pairs():
    tp.fresh_ledger()
    n = {"k": 0}

    def vision(a, f, objs):
        n["k"] += 1
        return {"matches": True, "missing_objects": [], "look_ok": True, "clean": n["k"] > 1,
                "chrome": "a caption 'In-App Result' and a toolbar", "usd": 0.01}
    ctx, world, *_ = make("clean", check_fn=vision)
    row = onboard.produce_asset(ctx, "phone_photo", "a phone photo of a bottle on a counter")
    check(row["status"] == "ready" and row["tries"][0]["class"] == "not_clean" and producer.CLEAN_ASK in world.sends[1]["prompt"],
          f"UI chrome / captions fail; the next try asks for one plain picture: {row['tries']}")
    from aieditor import preprod
    check(preprod.CHROME_ASKED_RX.search("a screenshot of the toolbar") and not preprod.CHROME_ASKED_RX.search("a bottle photo"),
          "chrome is allowed only when the description asks for it")
    check("clean" in preprod.FIDELITY_CHECK_SCHEMA["required"], "the vision check scores it")
    # an input and its result → two pictures, the result made FROM the input
    tp.fresh_ledger()
    ctx2, world2, *_ = make("pair")
    r = onboard.produce_asset(ctx2, "grandma", "old b/w photo of great-grandma + its colorized result, neon highlighter look")
    check(r["status"] == "ready" and r["made_from"] == ["grandma_input"] and len(world2.sends) == 2 and world2.sends[1]["att"],
          f"the input first (real), then the result from it: {r.get('made_from')} {len(world2.sends)}")
    inp = json.loads((Path(ctx2.out) / "assets" / "grandma_input.produced.json").read_text())
    check(inp["look"] == "real", f"the input is a real photo: {inp['look']}")
    print("  clean: chrome → not_clean → reworded; pair → input + result")


# ─────────────────────────── (12) reuse only what passes today's checks ───────────────────────────
def test_reuse_rechecked():
    tp.fresh_ledger()
    ctx, world, *_ = make("reuse", check_fn=lambda a, f, o: {"matches": True, "missing_objects": [], "look_ok": True,
                                                              "clean": not str(f).endswith("old.png"), "usd": 0.01})
    d = Path(ctx.out) / "assets"
    d.mkdir(parents=True, exist_ok=True)
    (d / "old.png").write_bytes(PNG)
    desc = "a phone photo of a bottle on a desk"
    (d / "old.produced.json").write_text(json.dumps({"id": "old", "desc": desc, "status": "ready", "file": str(d / "old.png")}))
    onboard.produce_asset(ctx, "old", desc)
    check(len(world.sends) >= 1, "an old row that fails today's check is made again")
    stored = json.loads((d / "old.produced.json").read_text())
    check(stored.get("fidelity", {}).get("v") == producer.FIDELITY_V, "the new row carries its fidelity record")
    n0 = len(world.sends)
    row = onboard.produce_asset(ctx, "old", desc)
    check(row["status"] == "ready" and len(world.sends) == n0, "a row with a passing fidelity record is reused")
    print("  reuse: re-checked; a failing stored row is made again")


def main():
    test_wording_never_internal()
    test_tool_on_source()
    test_different_subject_edit_route()
    test_hero_subject_reused()
    test_missing_tool_action_onboarded()
    test_look_wording()
    test_details_kept()
    test_p4_result_kind()
    test_camera_need_is_d()
    test_strokes_are_data()
    test_clean_and_pairs()
    test_reuse_rechecked()
    print(f"test_fidelity: {N} checks passed")


if __name__ == "__main__":
    main()
