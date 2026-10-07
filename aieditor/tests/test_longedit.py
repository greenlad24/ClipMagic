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
    eased = [m for m in mv if m[1] > 0 and m[4] != "drift"]
    check("the move budget holds (moves_per_min_max / 2 per 30 s, drifts aside)", len(eased) <= P["moves_per_min_max"] / 2)
    gaps = [(b[0] - (a[0] + a[1])) / 30 for a, b in zip(mv, mv[1:]) if a[1] > 0 and b[1] > 0 and a[3][0] > 1.0
            and b[4] != "drift" and not (len(b) > 5 and b[5] == [30, 120, 300, 40])]   # a nav click lands on its press
    check("holds of at least hold_min_s between moves from a framed view", all(g >= P["hold_min_s"] - 0.05 for g in gaps))
    navz = [m for m in mv if len(m) > 5 and m[5] == [30, 120, 300, 40]]
    check("#11 a navigation click gets a quick zoom that lands on its press, then the cut",
          not navz or (navz[0][1] <= P["nav_click_frames"] * 1.01 and abs(navz[0][0] + navz[0][1] - 12.5 * 30) < 2))
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
    # ── refs 2–5 (2026-10-07): moves inside a zoom, dissolves, target fit ──
    cap = {"w": W, "h": H, "fps": 30.0}
    evs3 = [{"t": 0, "type": "begin"}, {"t": 0.5, "type": "read", "box": [700, 1000, 500, 160], "end": 3.0},
            {"t": 6.0, "type": "read", "box": [200, 100, 400, 120], "end": 9.0}]
    mv3 = camera.plan_moves({"capture": cap, "events": evs3, "end": 9}, 30.0, 0, 270, P)
    pans = [m for m in mv3 if m[4] == "pan"]
    check("next target at the same zoom → a PAN, not out-and-in", len(pans) == 1 and not any(m[4] == "out" for m in mv3))
    check("...the pan keeps the zoom", abs(pans[0][2][0] - pans[0][3][0]) < 1e-9 and pans[0][3][0] > 1.05)
    d1080 = math.hypot(pans[0][3][1] - pans[0][2][1], pans[0][3][2] - pans[0][2][2]) * pans[0][3][0] * 1080 / H
    check("...pan length from the measured D ≈ 24 + 0.035·px (26–56 f)", abs(pans[0][1] / (30.0 / camera.REF_FPS) - camera.pan_frames(d1080, P)) < 1e-6
          and 26 <= pans[0][1] <= 56)
    ease = camera.make_eases(P)["pan"]
    check("pan ease: eased in and out, monotonic", ease(0.1) < 0.1 and ease(0.9) > 0.9
          and all(ease(i / 20) <= ease((i + 1) / 20) + 1e-9 for i in range(20)))
    evs4 = [{"t": 0, "type": "begin"}, {"t": 0.5, "type": "read", "box": [700, 500, 500, 160], "end": 3.0},
            {"t": 5.0, "type": "nav", "url": "https://x/other"}]
    mv4 = camera.plan_moves({"capture": cap, "events": evs4, "end": 10}, 30.0, 0, 300, P)
    xf = [m for m in mv4 if m[4] == "xfade"]
    check("a goto DISSOLVES (5 f), framing held through it", len(xf) == 1 and xf[0][6] == P["xfade_frames"] and xf[0][2] == xf[0][3])
    check("...then zooms out to the full frame right after", any(m[4] == "out" and abs(m[0] - (150 + P["xfade_frames"])) < 1 and m[3][0] == 1.0 for m in mv4))
    check("...and no hard cut back to full at the goto", not any(m[4] == "cut" and abs(m[0] - 150) < 1 for m in mv4))
    evs5 = [{"t": 0, "type": "begin"}, {"t": 0.5, "type": "read", "box": [700, 500, 500, 160], "end": 3.0},
            {"t": 5.0, "type": "cut", "why": "click", "big": True}]
    mv5 = camera.plan_moves({"capture": cap, "events": evs5, "end": 10}, 30.0, 0, 300, P)
    check("a click navigation stays a HARD cut", not any(m[4] == "xfade" for m in mv5) and any(m[4] == "cut" for m in mv5))
    evs6 = [{"t": 0, "type": "begin"}, {"t": 0.5, "type": "read", "box": [700, 1000, 500, 160], "end": 3.0},
            {"t": 8.0, "type": "wait", "text": "done", "found": True}, {"t": 8.3, "type": "read", "box": [200, 100, 400, 120], "end": 11.0}]
    mv6 = camera.plan_moves({"capture": cap, "events": evs6, "end": 12}, 30.0, 0, 360, P)
    check("a skipped generation: dissolve, then glide to the result at once", any(m[4] == "xfade" for m in mv6)
          and any(m[4] == "pan" and m[0] <= 8.3 * 30 for m in mv6))
    import qa
    check("target fit: in view", qa.target_fit((0, 30, (1.0, 1280, 720), (1.3, 1000, 800), "in", [800, 700, 300, 150]), W, H, P))
    check("target fit: under the facecam still counts (the bubble stays put, Jake 2026-10-07)",
          qa.target_fit((0, 30, (1.0, 1280, 720), (1.3, 1800, 500), "in", [2300, 120, 220, 120]), W, H, P))
    # ── Jake's review of v11 (2026-10-07, SYSTEM.md §0) ──
    # 1 centre-middle: a target top-right ends centred (no shift left of the bubble)
    evj = [{"t": 0, "type": "begin"}, {"t": 0.3, "type": "read", "box": [1300, 600, 300, 120], "end": 3.0}]
    mvj = camera.plan_moves({"capture": cap, "events": evj, "end": 4}, 30.0, 0, 120, P)
    fr = [m for m in mvj if len(m) > 5 and m[5]]
    check("#1 the subject ends centre-middle (no bubble dodge)", fr and qa.subject_offset(fr[0], W, H) < 0.02)
    check("#1 avoid_bubble is off in the system", not P["avoid_bubble"])
    # overscan onto a FLAT canvas edge centres a design at the edge; real UI at the edge = clamp
    flat = np.full((360, 640, 3), 245, np.uint8)
    ui = flat.copy(); ui[:, :20] = 40
    room = camera.edge_room(flat, P)
    check("#1 flat canvas edges allow overscan", room and min(room) > 0)
    check("#1 a UI strip at the left edge allows none there", camera.edge_room(ui, P)[0] == 0)
    zc, cxc, cyc = camera.framing_for([600, 500, 300, 300], W, H, P, room=room)
    check("#1 a design near the canvas edge is centred via overscan", abs(cxc - 750) < 1)
    check("#1 without room it clamps", camera.framing_for([600, 500, 300, 300], W, H, P)[1] > 900)
    # 2 constant motion: one target then 20 s of talk → drifts keep every hold ≤ hold_max
    evc = [{"t": 0, "type": "begin"}, {"t": 0.3, "type": "read", "box": [1000, 600, 400, 200], "end": 20.0}]
    mvc = camera.plan_moves({"capture": cap, "events": evc, "end": 20}, 30.0, 0, 600, P)
    busy = camera.busy_spans(mvc, {"capture": cap, "events": evc}, 30.0, 0, P)
    gaps, cur = [], 0
    for a_, b_ in busy:
        gaps.append(a_ - cur); cur = max(cur, b_)
    gaps.append(600 - cur)
    check("#2 no static hold longer than hold_max_s", max(gaps) / 30 <= P["hold_max_s"] + 0.05)
    check("#2 drifts are slow centred pushes/pulls (≤ ×1.08)", all(abs(math.log(m[3][0] / m[2][0])) <= math.log(P["drift_zoom"]) + 1e-6
                                                                 for m in mvc if m[4] == "drift") and any(m[4] == "drift" for m in mvc))
    # 11 the zoom starts on the word: a Log in hover named at 3.8 s
    evw = [{"t": 0, "type": "begin"}, {"t": 3.2, "type": "click", "box": [2140, 53, 122, 67], "press": 4.15, "end": 4.4, "at": 3.8}]
    mvw = camera.plan_moves({"capture": cap, "events": evw, "end": 8}, 30.0, 0, 240, P)
    tz = [m for m in mvw if len(m) > 5 and m[5] == [2140, 53, 122, 67]]
    check("#11 the zoom to the target starts ON its word", tz and tz[0][0] >= 3.8 * 30 - 1)
    evr = [{"t": 0, "type": "begin"}, {"t": 3.4, "type": "read", "box": [1000, 500, 400, 300], "end": 6.0, "at": 3.4}]
    mvr = camera.plan_moves({"capture": cap, "events": evr, "end": 8}, 30.0, 0, 240, P)
    check("a span opening on a result still gets the centred entry push", mvr[0][4] == "in" and mvr[0][0] < 3)
    check("#11 no zoom at all before the word (the span opens at 1.0)", all(m[0] >= 3.8 * 30 - 1 for m in mvw if m[1] > 0 and m[4] != "drift"))
    evk = [{"t": 0, "type": "begin"}, {"t": 2.0, "type": "click", "box": [600, 400, 200, 60], "press": 4.0, "end": 4.3}]
    mvk = camera.plan_moves({"capture": cap, "events": evk, "end": 8}, 30.0, 0, 240, P)
    tk = [m for m in mvk if len(m) > 5 and m[5] == [600, 400, 200, 60]]
    check("#11 a click's zoom starts at its press (−0.35 s), not with the cursor's travel", tk and tk[0][0] >= (4.0 - 0.36) * 30)
    mvl = camera.plan_moves({"capture": cap, "events": evr, "end": 8, "url": "https://www.linearity.io/"}, 30.0, 0, 240, P)
    check("#3/#7 a landing page opens unzoomed (no entry push, the logo stays in view)", not (mvl[0][4] == "in" and mvl[0][0] < 3))
    evx = [{"t": 0, "type": "begin"}, {"t": 0.3, "type": "read", "box": [600, 500, 400, 300], "end": 3.0},
           {"t": 5.0, "type": "nav", "url": "https://x.io/home"}, {"t": 5.4, "type": "type", "box": [800, 900, 900, 150], "text": "hi", "end": 7.0}]
    mvx = camera.plan_moves({"capture": cap, "events": evx, "end": 9}, 30.0, 0, 270, P)
    check("#10 typing right after a dissolve: the new screen arrives at the full frame",
          any(m[4] == "cut" and m[3][0] == 1.0 and abs(m[0] - 150) < 1 for m in mvx))
    # 10 typing a prompt: zoomed out
    evt = [{"t": 0, "type": "begin"}, {"t": 0.3, "type": "read", "box": [1000, 600, 400, 200], "end": 3.0},
           {"t": 6.5, "type": "type", "box": [800, 900, 900, 150], "text": "a fall promo", "end": 9.0}]
    mvt = camera.plan_moves({"capture": cap, "events": evt, "end": 10}, 30.0, 0, 300, P)
    check("#10 typing never zooms in on the box", not any(len(m) > 5 and m[5] == [800, 900, 900, 150] for m in mvt))
    check("#10 a held zoom opens out as typing starts", any(m[4] == "out" and abs(m[0] - 6.5 * 30) < 1 for m in mvt))
    # 7 a goto inside the same site is a hard cut; another site dissolves
    evs7 = [{"t": 0, "type": "begin"}, {"t": 3.0, "type": "nav", "url": "https://www.linearity.io/pricing"}]
    mv7 = camera.plan_moves({"capture": cap, "events": evs7, "end": 6, "url": "https://www.linearity.io/"}, 30.0, 0, 180, P)
    check("a goto inside the same site still dissolves (Jake approved v11 1:04)", any(m[4] == "xfade" for m in mv7))
    evs7c = [{"t": 0, "type": "begin"}, {"t": 3.0, "type": "nav", "url": "https://www.linearity.io/pricing", "cut": True}]
    mv7c = camera.plan_moves({"capture": cap, "events": evs7c, "end": 6, "url": "https://www.linearity.io/"}, 30.0, 0, 180, P)
    check("#7 a goto marked cut (landing → pricing) is a hard cut", not any(m[4] == "xfade" for m in mv7c))
    # bubble: hidden only for ACTIONS under it
    evb = {"events": [{"t": 1.0, "type": "read", "box": [2200, 100, 200, 100], "end": 3.0},
                      {"t": 4.0, "type": "click", "box": [2200, 100, 200, 100], "press": 4.8, "end": 5.1}]}
    check("bubble: a read under it does not hide it", not camera.action_targets(evb, 2.0))
    check("bubble: a click under it does, from just before the press", camera.action_targets(evb, 4.6) and not camera.action_targets(evb, 4.0))
    check("bubble: back right after the action", not camera.action_targets(evb, 5.5))
    # 5 / 6 compose: bubble-first A-roll transitions, the text gradient
    env = compose_long.bubble_env_expr([{"t0": 10.0, "t1": 20.0, "aroll_in": True, "aroll_out": True, "tail": compose_long.aroll_tail_s()}])
    check("#5 the bubble env fades in after the screencast and out before it", "clip((T-10.1" in env and "(1-clip((T-19.86" in env)
    check("#5 the A-roll dissolve is 10 f", abs(compose_long.aroll_tail_s() - 10 / 29.97) < 0.002)
    gs = compose_long.gradient_spans([{"template": "lower_title", "start_frame": 300, "n_frames": 90, "t1": 13},
                                      {"template": "lower_title", "start_frame": 400, "n_frames": 60, "t1": 15.3},
                                      {"template": "subscribe", "start_frame": 600, "n_frames": 90, "t1": 23}], 30.0)
    check("#6 gradient spans: text overlays only, back-to-back titles merged", gs == [[10.0, 15.333333333333334]])
    check("compose: the screencast dissolve is ~5 ref frames", abs(compose_long.xfade_s() - 5 / 29.97) < 0.002)
    ideal ={k: (v["band"][0] + v["band"][1]) / 2 for k, v in qa.system()["qa"]["metrics"].items()}
    check("QA: a video inside every band scores 100", qa.score(ideal)["score"] == 100.0)
    check("QA: v5-like camera (2x, 16 moves/min) scores low",
          qa.score({**ideal, "zoom_in_median": 2.0, "moves_per_min": 15.7, "deep_zoom_pct": 69})["score"] < 90)
    check("QA: v11-like (off-centre, no gradient, hard A-roll cuts) scores low",
          qa.score({**ideal, "subject_centre_median": 0.21, "subject_centre_p75": 0.26, "centre_excess_p90": 0.2, "aroll_transition_ok_pct": 0,
                    "text_gradient_pct": 0})["score"] < 85)
    ok_cam = True
except ImportError:
    ok_cam = False

print(f"test_longedit: {N} checks passed" + ("" if ok_cam else " (camera checks skipped: no cv2 here)"))
