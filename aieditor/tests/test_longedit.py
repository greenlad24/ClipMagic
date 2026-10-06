"""Long-form full edit: director validation, blank trimming, camera framing, bubble fades."""
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

try:
    import camera  # needs numpy + cv2 (the aieditor-screencast image)
    P = camera.params()
    W, H = 2560, 1440
    check("a whole-page target is not a zoom", camera.framing_for([0, 0, 2560, 42543], W, H, P) == (1.0, 1280, 720))
    z, cx, cy = camera.framing_for([1200, 600, 200, 40], W, H, P)
    check("a small target zooms within the measured band", 1.13 <= z <= 2.0)
    v = camera.avoid_bubble((1.6, 1500, 400), [1700, 200, 300, 40], W, H, P)
    sx1 = (1700 + 300 - (v[1] - W / v[0] / 2)) / (W / v[0])
    check("avoid_bubble moves the target left of the bubble when it can", sx1 <= P["bubble_zone"][0] or v[1] == W - W / v[0] / 2)
    # SYSTEM.md (reference 2): zoom levels, move budget, navigation cuts, blank frames
    zs, _, _ = camera.framing_for([1200, 600, 60, 30], W, H, P)
    check("a small target zooms to the reference band, not the 2x cap", P["zoom_min"] <= zs <= P["zoom_max"])
    check("deep: true is the only way to 2x", camera.framing_for([1200, 600, 60, 30], W, H, P, deep=True)[0] == P["zoom_deep"])
    evs = [{"t": 0, "type": "begin"}]
    for k in range(12):                                  # a target every 0.8 s for ~10 s
        evs.append({"t": 1.0 + 0.8 * k, "type": "read", "box": [200 + 150 * k, 300 + 60 * (k % 5), 120, 40], "end": 1.6 + 0.8 * k})
    evs.append({"t": 12.0, "type": "click", "box": [30, 120, 300, 40], "end": 12.5})
    evs.append({"t": 12.6, "type": "cut", "why": "click"})
    evs.append({"t": 14.0, "type": "read", "box": [900, 500, 500, 300], "end": 17.0})
    ev = {"capture": {"w": W, "h": H, "fps": 30.0}, "events": evs, "end": 20}
    mv = camera.plan_moves(ev, 30.0, 0, 600, P)
    eased = [m for m in mv if m[1] > 0]
    check("at most 3 eased moves in any 30 s", len(eased) <= 3)
    gaps = [(b[0] - (a[0] + a[1])) / 30 for a, b in zip(mv, mv[1:]) if a[1] > 0 and b[1] > 0 and a[3][0] > 1.0]
    check("holds of at least hold_min_s between moves from a framed view", all(g >= P["hold_min_s"] - 0.05 for g in gaps))
    check("the navigation click is not a zoom target", not any(m[5] == [30, 120, 300, 40] for m in mv if len(m) > 5))
    check("a settle cut resets the camera with a hard cut", any(m[4] == "cut" and abs(m[0] - 12.6 * 30) < 1 for m in mv))
    check("every zoom-in stays <= the cap", all(m[3][0] <= P["zoom_cap"] + 1e-6 for m in mv))
    import numpy as np
    white = np.full((1440, 2560, 3), 250, np.uint8)
    check("a white loading frame is blank", camera.is_blank(white, P))
    page = white.copy()
    for y in range(200, 1200, 40):
        page[y:y + 14, 300:2200] = 30                    # lines of text
    check("a page with text is not blank", not camera.is_blank(page, P))
    # v10: a big page title running under the facecam (v9 at 1:10) — the framing moves so the
    # bubble sits on background; a view whose bubble is already on background is left alone
    sm = np.full((360, 640, 3), 250, np.uint8)
    sm[120:150, 300:600] = 30                            # a title across the top right (capture 1200-2400, 480-600)
    sm[190:250, 200:270] = 90                            # the target tile (capture 800-1080, 760-1000)
    tgt = [800, 760, 280, 240]
    v0 = (1.45, 1300, 820)
    v1 = camera.clear_bubble(v0, tgt, sm, W, H, P)
    check("clear_bubble: less content under the bubble", camera.bubble_cover(sm, v1, W, H) < camera.bubble_cover(sm, v0, W, H) - 0.05)
    z1, c1x, c1y = v1
    check("clear_bubble: the target stays in view", c1x - W / z1 / 2 <= 800 and 1080 <= c1x + W / z1 / 2 and c1y - H / z1 / 2 <= 760 and 1000 <= c1y + H / z1 / 2)
    blank = np.full((360, 640, 3), 250, np.uint8)
    check("clear_bubble: nothing under the bubble = unchanged", camera.clear_bubble(v0, tgt, blank, W, H, P) == v0)
    evs2 = [{"t": 0, "type": "begin"}, {"t": 1.0, "type": "read", "box": [900, 300, 300, 100], "end": 4.0},
            {"t": 8.0, "type": "scroll", "by": 400, "end": 8.8}, {"t": 9.5, "type": "read", "box": [900, 700, 300, 100], "end": 12.0}]
    mv2 = camera.plan_moves({"capture": {"w": W, "h": H, "fps": 30.0}, "events": evs2, "end": 14}, 30.0, 0, 420, P)
    check("a scroll with a target right after it: no zoom-out first", not any(m[4] == "out" for m in mv2))
    check("...and the target lands by a jump cut at the scroll's end", any(m[4] == "cut" and m[1] == 0 and abs(m[0] - 8.8 * 30) < 1 and m[3][0] > 1 for m in mv2))
    import qa
    ideal = {k: (v["band"][0] + v["band"][1]) / 2 for k, v in qa.system()["qa"]["metrics"].items()}
    check("QA: a video inside every band scores 100", qa.score(ideal)["score"] == 100.0)
    check("QA: v5-like camera (2x, 16 moves/min) scores low",
          qa.score({**ideal, "zoom_in_median": 2.0, "moves_per_min": 15.7, "deep_zoom_pct": 69})["score"] < 80)
    ok_cam = True
except ImportError:
    ok_cam = False

print(f"test_longedit: {N} checks passed" + ("" if ok_cam else " (camera checks skipped: no cv2 here)"))
