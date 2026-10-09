"""Long-form full edit: director validation, blank trimming, camera framing, bubble fades."""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "screencast"))
from aieditor import compose_long, director  # noqa: E402

N = 0


def check(name, cond):
    global N
    N += 1
    if not cond:
        raise SystemExit(f"FAIL: {name}")


def words(text, t0=0.0, step=0.4):
    return [{"i": 100 + k, "word": w, "start": round(t0 + k * step, 3), "end": round(t0 + k * step + 0.3, 3)}
            for k, w in enumerate(text.split())]


ws = words("This tool is great . the link to it is waiting for you down in the description so you can follow "
           "along and here is how it works you give it your website and it builds a brand kit for you fast")
video = {"title": "t", "duration": ws[-1]["end"] + 1, "words": ws}
sites = [{"url": "https://www.linearity.io/", "note": ""}]
by = {w["word"]: w["i"] for w in ws}
raw = {"segments": [{"start": 100, "end": ws[-1]["i"], "url": "https://www.linearity.io/pricing", "intent": "x"}],
       "overlays": [{"template": "link", "start": by["link"], "end": by["description"], "fields": {}}]}
p = director.validate(raw, video, sites)
link_w = next(w for w in ws if w["word"] == "link")
check("a screencast never covers the spoken link line", all(not (s["t0"] < link_w["end"] + 1.2 and link_w["start"] - 0.6 < s["t1"]) for s in p["segments"]))
check("the link overlay survives", any(o["template"] == "link" for o in p["overlays"]))
check("the screencast is kept AFTER the moment, not dropped", len(p["segments"]) == 1)

raw2 = {"segments": [{"start": 100, "end": 105, "url": "https://evil.example.com/", "intent": "x"}], "overlays": []}
check("a site not in the job is refused", not director.validate(raw2, video, sites)["segments"])

raw3 = {"segments": [], "overlays": [{"template": "keyword", "start": by["link"], "end": by["it"], "fields": {"line1": "a", "line2": "b"}},
                                     {"template": "link", "start": by["link"], "end": by["description"], "fields": {}}]}
p3 = director.validate(raw3, video, sites)
check("link wins over a keyword on the same moment", [o["template"] for o in p3["overlays"]] == ["link"])

seg = {"t0": 10.0, "t1": 30.0, "clip": "x"}
check("no blank → untouched", compose_long.trim_blank(seg, {"blank": []}) == seg)
check("blank after a scroll → cut at the scroll", compose_long.trim_blank(seg, {"blank": [[8.4, 12.0]], "scrolls": [7.6]})["t1"] == 17.6)
check("short blank ignored", compose_long.trim_blank(seg, {"blank": [[8.4, 9.0]]}) == seg)
check("blank at the start after a scroll → dropped", compose_long.trim_blank(seg, {"blank": [[1.0, 5.0]], "scrolls": [0.5]}) is None)
check("a blank with no scroll before it (an app loading) is kept", compose_long.trim_blank(seg, {"blank": [[3.0, 6.0]], "scrolls": []}) == seg)

expr = compose_long._vis_expr([(5.0, 7.0)], 0.23, 0.37)
check("bubble visibility expression names the span", "5.000" in expr and "7.000" in expr)
check("no spans → always visible", compose_long._vis_expr([], 0.2, 0.3) == "1")

# ── screencast camera (gap list G5: the reference camera; the planner is pure python — the full G5 cases
# and the offline acceptance on the failed job live in tests/test_motion.py) ──
import camera  # noqa: E402

P = camera.params()
W, H = 2560, 1440
cap = {"w": W, "h": H, "fps": 30.0}


def _said(word, t):
    return [{"word": x, "start": round(t - 0.3 * (3 - k), 3), "end": round(t - 0.3 * (3 - k) + 0.28, 3)}
            for k, x in enumerate(("look", "at", "the", word))]


check("a whole-page target is not a zoom", camera.framing_for([0, 0, 2560, 42543], W, H, P) == (1.0, 1280, 720))
check("G5/F3: nothing past ×1.65 (zoom_deep 2.0 retired)", P["zoom_deep"] <= 1.65 and P["zoom_cap"] <= 1.65
      and camera.framing_for([1200, 600, 60, 30], W, H, P, deep=True)[0] <= 1.65)
check("G5 step 8: same-site gotos are hard cuts in the system", P["xfade_same_site"] is False)
evs = [{"t": 0, "type": "begin"}]
for k in range(12):                                  # the agent 'read' a spot every 0.8 s
    evs.append({"t": 1.0 + 0.8 * k, "type": "read", "box": [200 + 150 * k, 300 + 60 * (k % 5), 120, 40], "end": 1.6 + 0.8 * k})
evs.append({"t": 12.6, "type": "cut", "why": "click"})
mv = camera.plan_moves({"capture": cap, "events": evs, "end": 20}, 30.0, 0, 600, P)
check("G5 step 4: reads never move the camera (only ZM10 pushes fill the holds)", all(m[4] == "push" for m in mv))
check("G5 step 1: one inward push per hold, never a release", all(m[3][0] > m[2][0] for m in mv) and len(mv) <= 2)
# M2: the next named target at about the same zoom → a PAN, not out-and-in
evs3 = [{"t": 0, "type": "begin"},
        {"t": 1.0, "type": "click", "box": [700, 1000, 500, 160], "abox": [700, 1000, 500, 160], "text": "Alpha", "press": 1.9, "end": 2.0},
        {"t": 4.5, "type": "click", "box": [200, 100, 400, 120], "abox": [200, 100, 400, 120], "text": "Beta", "press": 5.4, "end": 5.5}]
mv3 = camera.plan_moves({"capture": cap, "events": evs3, "end": 9}, 30.0, 0, 270, P, words=_said("alpha", 1.6) + _said("beta", 5.1))
pans = [m for m in mv3 if m[4] == "pan"]
check("next target at the same zoom → a PAN, not out-and-in", len(pans) == 1 and not any(m[4] == "out" for m in mv3))
check("...the pan keeps the zoom", abs(pans[0][2][0] - pans[0][3][0]) < 0.06 and pans[0][3][0] > 1.05)
check("...26–56 f", 26 - 0.5 <= pans[0][1] * camera.REF_FPS / 30.0 <= 56 + 0.5)
ease = camera.make_eases(P)["pan"]
check("pan ease: eased in and out, monotonic", ease(0.1) < 0.1 and ease(0.9) > 0.9
      and all(ease(i / 20) <= ease((i + 1) / 20) + 1e-9 for i in range(20)))
# T4: another site dissolves (5 f), the framing held through it; T1/T2: a click navigation is a hard cut
evs4 = [{"t": 0, "type": "begin"}, {"t": 5.0, "type": "nav", "url": "https://x.io/other"}]
mv4 = camera.plan_moves({"capture": cap, "events": evs4, "end": 10, "url": "https://chatgpt.com/"}, 30.0, 0, 300, P)
xf = [m for m in mv4 if m[4] == "xfade"]
check("a goto to another site DISSOLVES (5 f), framing held through it", len(xf) == 1 and xf[0][6] == P["xfade_frames"] and xf[0][2] == xf[0][3])
check("a click navigation stays a HARD cut", [s_["kind"] for s_ in camera.page_states(
    {"events": [{"t": 5.0, "type": "cut", "why": "click"}], "url": "https://chatgpt.com/"}, P)[0]] == ["cut"])
evs7 = [{"t": 0, "type": "begin"}, {"t": 3.0, "type": "nav", "url": "https://www.linearity.io/pricing"}]
mv7 = camera.plan_moves({"capture": cap, "events": evs7, "end": 6, "url": "https://www.linearity.io/"}, 30.0, 0, 180, P)
check("G5 step 8: a goto inside the same site is a 1 f hard cut (was: a dissolve)", not any(m[4] == "xfade" for m in mv7))
# K1: typing a prompt is shown at ×1.00 — a held zoom opens out as typing starts
evt = [{"t": 0, "type": "begin"},
       {"t": 0.8, "type": "click", "box": [1000, 600, 400, 200], "abox": [1000, 600, 400, 200], "text": "Logo", "press": 1.5, "end": 1.6},
       {"t": 6.5, "type": "type", "box": [800, 900, 900, 150], "abox": [800, 900, 900, 150], "text": "a fall promo", "end": 9.0}]
mvt = camera.plan_moves({"capture": cap, "events": evt, "end": 10}, 30.0, 0, 300, P, words=_said("logo", 1.3))
check("#10/K1 typing never zooms in on the box", not any(m[4] in ("in", "cut") and len(m) > 5 and m[5] == [800, 900, 900, 150] for m in mvt))
check("#10/K1 a held zoom opens out as typing starts", any(m[4] == "out" and abs(m[0] + m[1] - 6.5 * 30) < 1 for m in mvt))
# bubble: hidden only for ACTIONS under it
evb = {"events": [{"t": 1.0, "type": "read", "box": [2200, 100, 200, 100], "end": 3.0},
                  {"t": 4.0, "type": "click", "box": [2200, 100, 200, 100], "press": 4.8, "end": 5.1}]}
check("bubble: a read under it does not hide it", not camera.action_targets(evb, 2.0))
check("bubble: a click under it does, from when the cursor sets off", camera.action_targets(evb, 4.0)
      and camera.action_targets(evb, 4.6) and not camera.action_targets(evb, 3.5))
check("bubble: back right after the action", not camera.action_targets(evb, 5.5))

# ── screen ↔ face transitions (gap list G6 step 3, RULEBOOK T5) ──
F4 = 4 / 29.97
check("G6: AROLL_SCREEN_F = 4 (Jake T5), the bubble envelope stays 4 f", compose_long.AROLL_SCREEN_F == 4 and compose_long.AROLL_BUBBLE_F == 4)
check("the A-roll dissolve is 4 f", abs(compose_long.aroll_tail_s() - F4) < 0.002)
sg = {"t0": 10.0, "t1": 20.0, "aroll_in": True, "aroll_out": True, "tail": compose_long.aroll_tail_s()}
a_, b_ = compose_long.screen_window(sg)
check("G6: exit — the screen is gone 0.1 s BEFORE the sentence start (picture ahead)", abs(b_ - 19.9) < 1e-6)
check("G6: entry mirrored — the screen dissolves in over [t0 − 0.1 − 4 f, t0 − 0.1]", abs(a_ - (10.0 - 0.1 - F4)) < 1e-3)
env = compose_long.bubble_env_expr([sg])
check("#5 the bubble fades in after the screen has dissolved in, and out before it dissolves out",
      "clip((T-9.9000" in env and f"(1-clip((T-{19.9 - 2 * F4:.4f}" in env)
gs = compose_long.gradient_spans([{"template": "lower_title", "start_frame": 300, "n_frames": 90, "t1": 13},
                                  {"template": "lower_title", "start_frame": 400, "n_frames": 60, "t1": 15.3},
                                  {"template": "subscribe", "start_frame": 600, "n_frames": 90, "t1": 23}], 30.0)
check("#6 gradient spans: text overlays only, back-to-back titles merged", gs == [[10.0, 15.333333333333334]])
check("compose: the screencast→screencast dissolve is ~5 ref frames", abs(compose_long.xfade_s() - 5 / 29.97) < 0.002)


def offline_filter(segs, events, out_dir):
    """compose_long.composite with every docker / ffprobe call stubbed: only the filter graph is written."""
    import tempfile  # noqa: F401
    saved = (compose_long.bubble_assets, compose_long._run, compose_long.media.probe, compose_long.gradient_png)
    compose_long.bubble_assets = lambda job, W_, H_: (Path(out_dir), 358)
    compose_long._run = lambda *a_, **k_: ""
    compose_long.media.probe = lambda p: {"duration": 880.212667}
    compose_long.gradient_png = lambda job, W_, H_: "textgrad-1920.png"
    try:
        (Path(out_dir) / "edit-01.part.mp4").write_bytes(b"")
        compose_long.composite(out_dir, "base-cam-1920.mp4", segs, events, None, "edit-01", (1920, 1080), 30000 / 1001,
                               [0.4, 0.2, 0.2, 0.3], bubble_src="plain-1920.mp4")
    finally:
        (compose_long.bubble_assets, compose_long._run, compose_long.media.probe, compose_long.gradient_png) = saved
    return (Path(out_dir) / "edit-01.filter.txt").read_text()


import gzip as _gz  # noqa: E402
import json as _json  # noqa: E402
import re as _re  # noqa: E402
import tempfile as _tf  # noqa: E402

_FIX = Path(__file__).resolve().parent / "fixtures" / "p3" / "e2e_edit01.json.gz"
if _FIX.exists():
    # G6 acceptance: regenerate the filter OFFLINE for the failed job's screencast spans (a scratch temp dir only)
    fx = _json.load(_gz.open(_FIX, "rt"))
    segs = []
    sp = [(s_["t0"], s_["t1"]) for s_ in fx["segments"]]
    for i, (t0, t1) in enumerate(sp):
        into_next = i + 1 < len(sp) and abs(sp[i + 1][0] - t1) < 0.05
        sg = {"t0": t0, "t1": t1, "clip": f"sc-{i:02d}-1920.mp4", "bubble": True, "bubble_hide": [],
              "tail": compose_long.xfade_s() if into_next else compose_long.aroll_tail_s()}
        if not into_next:
            sg["aroll_out"] = True
        if segs and segs[-1].get("tail") and not segs[-1].get("aroll_out") and abs(segs[-1]["t1"] - t0) < 0.05:
            sg["fade_in"] = segs[-1]["tail"]
        elif t0 > 0.05:
            sg["aroll_in"] = True
        segs.append(sg)
    with _tf.TemporaryDirectory() as td:
        txt = offline_filter(segs, [], td)
    wins = [(float(a_), float(b_)) for a_, b_ in _re.findall(r"\[sc\d+\]overlay=eof_action=pass(?::format=auto)?:enable='between\(t,([\d.]+),([\d.]+)\)'", txt)]
    check(f"filter: one enable window per screencast ({len(wins)})", len(wins) == len(segs))
    outs = [(sg, w_) for sg, w_ in zip(segs, wins) if sg.get("aroll_out")]
    check("G6: every screencast → A-roll window ends ≤ t1 − 0.1 s + 4 f (was t1 + 0.1668 s)",
          outs and all(w_[1] <= sg["t1"] - 0.1 + F4 + 1e-3 for sg, w_ in outs))
    ins_ = [(sg, w_) for sg, w_ in zip(segs, wins) if sg.get("aroll_in")]
    check("G6: every A-roll → screencast window opens 0.1 s + 4 f ahead of its sentence (mirrored)",
          ins_ and all(abs(w_[0] - (sg["t0"] - 0.1 - F4)) < 2e-3 for sg, w_ in ins_))
    fades = [float(x) for x in _re.findall(r"fade=t=(?:in|out):st=[\d.]+:d=([\d.]+):alpha=1", txt)]
    xf_in = [sg["fade_in"] for sg in segs if sg.get("fade_in")]
    check("G6: the screen ↔ face dissolves are 4 f", all(abs(d_ - F4) < 2e-3 or any(abs(d_ - x) < 2e-3 for x in xf_in) for d_ in fades)
          and sum(1 for d_ in fades if abs(d_ - F4) < 2e-3) >= len(outs))
    print(f"  compose (offline filter, failed job): {len(outs)} exits / {len(ins_)} entries, windows end ≤ t1 − 0.1 + 4 f")

try:
    import numpy as np  # the frame helpers need numpy + cv2 (the aieditor-screencast image)
    white = np.full((1440, 2560, 3), 250, np.uint8)
    check("a white loading frame is blank", camera.is_blank(white, P))
    page = white.copy()
    for y in range(200, 1200, 40):
        page[y:y + 14, 300:2200] = 30                    # lines of text
    check("a page with text is not blank", not camera.is_blank(page, P))
    sm = np.full((360, 640, 3), 250, np.uint8)
    sm[120:150, 300:600] = 30
    sm[190:250, 200:270] = 90
    tgt = [800, 760, 280, 240]
    v0 = (1.45, 1300, 820)
    v1 = camera.clear_bubble(v0, tgt, sm, W, H, P)
    check("clear_bubble: less content under the bubble", camera.bubble_cover(sm, v1, W, H) < camera.bubble_cover(sm, v0, W, H) - 0.05)
    flat = np.full((360, 640, 3), 245, np.uint8)
    ui = flat.copy()
    ui[:, :20] = 40
    check("#1 flat canvas edges allow overscan, a UI strip none", min(camera.edge_room(flat, P)) > 0 and camera.edge_room(ui, P)[0] == 0)
    import qa
    check("target fit: in view", qa.target_fit((0, 30, (1.0, 1280, 720), (1.3, 1000, 800), "in", [800, 700, 300, 150]), W, H, P))
    ideal = {k: (v["band"][0] + v["band"][1]) / 2 for k, v in qa.system()["qa"]["metrics"].items()}
    check("QA: a video inside every band scores 100", qa.score(ideal)["score"] == 100.0)
    check("QA: v5-like camera (2x, 16 moves/min) scores low",
          qa.score({**ideal, "zoom_in_median": 2.0, "moves_per_min": 15.7, "deep_zoom_pct": 69})["score"] < 90)
    ok_cam = True
except ImportError:
    ok_cam = False

# ── plan fit (gap list G2): readiness, assets, beat ledger, reference structure ──
from aieditor import planfit  # noqa: E402
import random as _rnd  # noqa: E402
import statistics as _st  # noqa: E402

_r = _rnd.Random(3)
VOCAB = "the photo bottle label really works nicely here and that is what you get with this simple trick".split()
lw, t = [], 0.3
OPEN = "Now look at this on the left, a sauce bottle I drew. And on the right, what came back."
for w in OPEN.split():
    lw.append({"i": len(lw), "word": w, "start": round(t, 3), "end": round(t + 0.28, 3)})
    t += 0.36
while t < 600:
    n = _r.randint(6, 14)
    for k in range(n):
        w = _r.choice(VOCAB) + ("." if k == n - 1 else "")
        lw.append({"i": len(lw), "word": w, "start": round(t, 3), "end": round(t + 0.28, 3)})
        t += 0.36
    t += 0.25
# a spoken UI step on a missing feature, a pricing line and an instruction stretch
def say(text):
    global t
    out = []
    for w in text.split():
        lw.append({"i": len(lw), "word": w, "start": round(t, 3), "end": round(t + 0.28, 3)})
        out.append(lw[-1])
        t += 0.36
    t += 0.25
    return out
at = say("Then type at Sketch in the message box.")
free = say("It is free on every plan with a cap.")
for _ in range(20):
    say("and that is what you get with this simple trick here.")
up = say("To copy a look, upload yours and then upload the second photo as a reference, and tell it to match.")
up2 = say("Upload both and you will see it match the look of the reference photo perfectly every time.")
for _ in range(25):
    say("and that is what you get with this simple trick here.")
LV = {"title": "t", "duration": round(t + 1, 2), "words": lw}
first_after_hook = next(w for w in lw if w["start"] > 12)
before_up = next(w for w in reversed(lw) if w["end"] < up[0]["start"] - 0.1)
raw = {"segments": [
    {"start": first_after_hook["i"], "end": before_up["i"], "url": "https://chatgpt.com/",
     "intent": f"on 'type at Sketch': '@Sketch' is typed and picked from the pop-up; on 'free on every plan': cut to "
               f"https://chatgpt.com/pricing, the Free plan card; on 'the photo': the 'Bakery Image Prompt' chat"},
    {"start": up2[-1]["i"] + 1, "end": lw[-1]["i"], "url": "https://chatgpt.com/", "intent": "on 'simple trick': zoom on the napkin"}],
    "overlays": []}
RD = {"checks": [{"id": "upload", "status": "pass"}, {"id": "sketch_plus_menu", "status": "pass"}],
      "features": [{"id": "at_sketch", "exists": False, "patterns": [r"@\s?sketch", r"\bat[- ]sketch\b"],
                    "alternative": {"route": "rewrite", "how": "click '+', then 'Sketch'"}, "note": "no @ picker"},
                   {"id": "pricing_in_app", "exists": False, "patterns": [r"/pricing\b", r"\bfree plan card\b"],
                    "alternative": {"route": "public", "url": "https://chatgpt.com/pricing", "locale": "en-US",
                                    "timezone": "America/New_York"}, "note": "upgrade modal"},
                   {"id": "upload", "exists": True, "patterns": []}]}
AS = {"assets": [{"id": "phone_photo", "kind": "photo", "desc": "phone photo of a sauce bottle", "status": "ready",
                  "prompt": "a sauce bottle with a label on a kitchen counter"},
                 {"id": "doodle", "kind": "sketch", "desc": "mouse doodle of the bottle", "status": "ready"}]}
fp = director.validate(raw, LV, [{"url": "https://chatgpt.com/"}], planfit.Facts(RD, AS))
B = fp["beats"]
by_cue = {b["cue"]: b for b in B}
check("ledger: every resolved beat sits on its edl word", all(b.get("t_word") == lw[b["word_id"]]["start"]
                                                               for b in B if b.get("word_id") is not None))
check("ledger rows carry the G2 fields", all({"word_id", "t_word", "clause_start", "subject", "technique_id", "action",
                                              "must_text", "typed_text", "result_assertion"} <= set(b)
                                             for b in B if b.get("word_id") is not None))
check("@Sketch is rewritten to '+' → Sketch", by_cue["type at Sketch"]["route"] == "rewrite" and "'+'" in by_cue["type at Sketch"]["body"])
check("pricing → the public page in a never-logged-in US browser (L4)", by_cue["free on every plan"]["route"] == "public"
      and by_cue["free on every plan"]["session"]["locale"] == "en-US")
check("an invented chat is never asked for", by_cue["the photo"]["route"] != "keep")
check("a napkin no asset holds is not shown", by_cue["simple trick"]["route"] in ("aroll", "drop"))
check("public pricing is its own segment", any((s.get("session") or {}).get("kind") == "public" for s in fp["segments"]))
st = fp["structure"]
check(f"span max <= 30 s ({st['span_max']})", st["span_max"] <= planfit.SPAN_MAX)
check(f"span median 10-18 s ({st['span_p50']})", planfit.SPAN_P50[0] <= st["span_p50"] <= planfit.SPAN_P50[1])
check(f"screencast share 72-76 % ({st['share']})", planfit.SHARE[0] <= st["share"] <= planfit.SHARE[1])
check(f"3-6 boundaries per minute ({st['bounds_per_min']})", 3.0 <= st["bounds_per_min"] <= 6.0)
check(f"A-roll beats 5-7 s ({st['aroll_p50']})", planfit.AROLL_BEAT[0] <= st["aroll_p50"] <= planfit.AROLL_BEAT[1])
check("the hook points at a thing → one plate beat with the produced assets",
      len(fp["plates"]) == 1 and fp["plates"][0]["t1"] <= 40 and fp["plates"][0]["assets"]
      and fp["plates"][0]["t1"] - fp["plates"][0]["t0"] <= 0.015 * LV["duration"] + 0.01)
check("the upload stretch gets a segment or a why", fp["aroll_actions"] and all(
    x.get("segment") is not None or x.get("why") for x in fp["aroll_actions"]))
check("segments never overlap", all(a["t1"] <= b["t0"] + 1e-6 for a, b in zip(fp["segments"], fp["segments"][1:])))
nofacts = director.validate(raw, LV, [{"url": "https://chatgpt.com/"}])
check("without pre-production facts nothing is rejected", all(b["route"] in ("keep", "drop") or "span structure" in str(b["why"])
                                                              for b in nofacts["beats"]))

# ── compose gates (gap list G4 + recommendation §4): salvage pieces, verdict.json, the held job ──
import importlib.machinery  # noqa: E402
import importlib.util  # noqa: E402
import json as _json  # noqa: E402
import tempfile as _tf  # noqa: E402
from aieditor import gates, longedit  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
_FX = Path(__file__).resolve().parent / "fixtures" / "g4"
_JOB = _json.loads((_FX / "failed_job.json").read_text())
_W = [{"i": n, "word": w, "start": s, "end": e} for n, (w, s, e) in enumerate(_JOB["words"])]
_QA1 = _json.loads((_FX / "frames-qa-v1.json").read_text())
with _tf.TemporaryDirectory() as td:
    job = Path(td) / "failed-job"
    w = job / "edit-01"
    for i, _ in enumerate(_JOB["segments"]):
        rec = w / f"seg-{i:02d}" / "rec"
        rec.mkdir(parents=True)
        (rec / "events.json").write_text(_json.dumps({"end": _JOB["rec_end"][f"{i:02d}"], "walls": _JOB["walls"][f"{i:02d}"],
                                                      "events": []}))
    pieces, lost = longedit.screen_pieces(w, _JOB["segments"], _QA1, _W, None)
    by = {}
    for p in pieces:
        by.setdefault(p["i"], []).append(p)
    check("compose: seg-07 is salvaged on both sides, not dropped", len(by.get(7, [])) == 2)
    check("compose: seg-02 keeps both sides", len(by.get(2, [])) == 2)
    check("compose: the foreign-account take shows nothing", 12 not in by)
    check("compose: pieces are ordered and never overlap", all(a["t1"] <= b["t0"] + 1e-6 for a, b in zip(pieces, pieces[1:])))
    check("compose: every loss is a D1 failure line", lost and all(f["dim"] == "D1" for f in lost))
    check("compose: a clean segment is kept (edges on sentences)", len(by.get(3, [])) == 1 and by[3][0]["t1"] - by[3][0]["t0"] > 70)
    check("compose: a never-recorded segment is a D1 failure", any("never recorded" in f["why"] for f in
          longedit.screen_pieces(Path(td) / "nothing", _JOB["segments"][:1], {}, _W)[1]))
    # the compose tail: verdict.json from blocks + plan + rubric (no video needed)
    (job / "request.json").write_text(_json.dumps({"workflow": "creative", "source": {"kind": "descript", "url": "x"}}))
    (w / "blocks.json").write_text(_json.dumps({"blocks": _JOB["blocks"], "words": _W, "overlays": _JOB["overlays"]}))
    plan = {"segments": _JOB["segments"], "overlays": []}
    v = longedit.edit_verdict(job, 1, w, plan, lost, _QA1)
    on_disk = _json.loads((w / "verdict.json").read_text())
    check("compose writes edit-NN/verdict.json", on_disk["held"] is True and on_disk["failures"] == v["failures"])
    check("verdict: coverage and structure failed", not on_disk["coverage"]["ok"] and not on_disk["structure"]["ok"])
    check("verdict: the rubric's code dimensions are in it", {"D2", "D7", "D9"} <= set(on_disk["dims"]))
    check("verdict: the judged dimensions are not invented", on_disk["dims"].get("D1") is None)
    # the expectations the take gate and content QA check against
    (w / "beats.json").write_text(_json.dumps({"beats": []}))
    ep = longedit.write_expect(w, {"segments": [{"t0": 0.0, "t1": 10.0, "beats": [
        {"id": "b1", "word_id": 1, "t_word": 2.0, "action": "x.open", "must_text": ["Sketch"]}]}]}, {"words": _W})
    check("write_expect: plan-schema beats", _json.loads(ep.read_text())["segments"]["0"][0]["must"] == ["Sketch"])

    # the worker: a held verdict ends the job HELD (never "done"), with held.json and no notification
    _loader = importlib.machinery.SourceFileLoader("aieditor_worker", str(ROOT / "bin" / "aieditor-worker"))
    _spec = importlib.util.spec_from_loader("aieditor_worker", _loader)
    worker = importlib.util.module_from_spec(_spec)
    _loader.exec_module(worker)
    (job / "edl.json").write_text(_json.dumps({"videos": [{"words": []}]}))
    (job / "held.json").write_text(_json.dumps({"reasons": [{"reason": "needs_scripted_recorder", "detail": "edit 1 screencast 3"}]}))
    jb = worker.Job(job)
    worker.run_job = lambda j, a: None
    worker.execute(jb, "run")
    st = _json.loads((job / "status.json").read_text())
    check("worker: the job state is 'held'", st["state"] == "held" and st["held"] is True)
    check("worker: the failure list is in status.json", st["held_failures"] and st["held_failures"][0]["dim"] == "held")
    hd = _json.loads((job / "held.json").read_text())
    check("worker: held.json keeps the other reasons and lists the failures", hd["reasons"] and hd["failures"])
    check("worker: a held job is never 'Ready to review'", "Ready" not in st["message"] and st["message"].startswith("Held"))
    # a later run whose edit ships clears it
    (w / "verdict.json").write_text(_json.dumps({"held": False, "failures": []}))
    (job / "held.json").unlink()
    jb = worker.Job(job)
    worker.execute(jb, "run")
    st = _json.loads((job / "status.json").read_text())
    check("worker: a shipping edit ends done", st["state"] == "done" and st.get("held") is False)
    check("worker: --once treats held as handled", "in (\"done\", \"held\")" in (ROOT / "bin" / "aieditor-worker").read_text())

# ── plan cases (package p6): the single plan call's plan is the one the edit records ──
from aieditor import graphics_long as _gl  # noqa: E402
import os as _os  # noqa: E402

# validate carries the plan call's sessions + schema beats to the fitted pieces; an 'outside' segment records
# in the never-logged-in en-US session
_raw = {"segments": [
    {"start": LV["words"][40]["i"], "end": LV["words"][80]["i"], "url": "https://chatgpt.com/", "app": "chatgpt",
     "session_name": "logged_in", "intent": f"on '{LV['words'][50]['word']}': zoom on the photo",
     "actions": [{"id": "b001", "word_id": 50, "t_word": LV["words"][50]["start"], "action": "camera.zoom"}]},
    {"start": free[0]["i"], "end": free[-1]["i"], "url": "https://chatgpt.com/pricing", "app": "chatgpt",
     "session_name": "outside", "intent": f"on '{free[0]['word']}': the public pricing page https://chatgpt.com/pricing",
     "actions": [{"id": "b002", "word_id": free[0]["i"], "t_word": free[0]["start"], "action": "outside.goto"}]}],
    "aroll_why": [], "overlays": []}
_vp = director.validate(_raw, LV, [{"url": "https://chatgpt.com/"}], planfit.Facts(RD, AS))
_out = [x for x in _vp["segments"] if any(a["action"] == "outside.goto" for a in x.get("actions", []))]
check("validate: an 'outside' segment records in the never-logged-in en-US session",
      _out and all((x.get("session") or {}).get("locale") == "en-US" for x in _out))
check("validate: schema beats ride with the fitted pieces",
      any(a["id"] == "b001" for x in _vp["segments"] for a in x.get("actions", [])))
check("validate: the overlay budget is reported", "overlay_budget" in _vp)

# longedit reuses pre-production's plan.json (no second plan call) and holds a plan that needs a primitive
with _tf.TemporaryDirectory() as td:
    jd = Path(td)
    v0 = {"title": "t", "duration": LV["duration"], "words": LV["words"]}
    (jd / "edl.json").write_text(_json.dumps({"videos": [v0]}))
    (jd / "preprod").mkdir()
    pp = {"plan": {"segments": [], "overlays": [], "dropped": [], "needs_primitive": [
              {"sentence": "type at Sketch", "why": "no proven action types '@Sketch'"}], "held": True},
          "raw": {"segments": [], "aroll_why": [], "overlays": []}, "meta": {"usd": 0.6}, "sites": [], "held": []}
    (jd / "preprod" / "plan.json").write_text(_json.dumps(pp))
    _t = (jd / "edl.json").stat().st_mtime + 5
    _os.utime(jd / "preprod" / "plan.json", (_t, _t))
    _saved = (director.plan, _gl.render)
    try:
        director.plan = lambda *a, **k: (_ for _ in ()).throw(AssertionError("a second plan call"))
        _gl.render = lambda *a, **k: []
        note, usd = longedit.plan_and_record(jd, 1, v0, [], False, 29.97, lambda m, f: None, lambda: False, lambda m: None)
    finally:
        director.plan, _gl.render = _saved
    dj = _json.loads((jd / "edit-01" / "direct.json").read_text())
    check("longedit: the edit records pre-production's plan (no second plan call)",
          dj["meta"].get("from") == "preprod/plan.json" and usd == 0.0)
    check("longedit: a plan with needs_primitive holds the job",
          [r["reason"] for r in longedit.held_reasons(jd)] == ["needs_primitive"])

print(f"test_longedit: {N} checks passed" + ("" if ok_cam else " (camera checks skipped: no cv2 here)"))
