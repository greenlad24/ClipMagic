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
    ok_cam = True
except ImportError:
    ok_cam = False

print(f"test_longedit: {N} checks passed" + ("" if ok_cam else " (camera checks skipped: no cv2 here)"))
