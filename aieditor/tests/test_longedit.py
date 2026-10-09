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
    # loop round 1 (RULEBOOK M1/M6, ruling R1): moves are word-timed — a beat that comes too soon is a
    # framed CUT, so the old "hold_min_s between moves" floor is gone; moves still never overlap
    check("moves from a framed view never overlap", all(g >= -0.05 for g in gaps))
    navz = [m for m in mv if len(m) > 5 and m[5] == [30, 120, 300, 40]]
    check("#11 a navigation click gets a quick zoom that lands on its press, then the cut",
          not navz or (navz[0][1] <= P["nav_click_frames"] * 1.01 and abs(navz[0][0] + navz[0][1] - 12.5 * 30) < 2))
    check("a settle cut resets the camera with a hard cut", any(m[4] == "cut" and abs(m[0] - 12.6 * 30) < 1 for m in mv))
    check("every zoom-in stays <= the cap (drifts: RULEBOOK F3 ×1.65)",
          all(m[3][0] <= (1.65 if m[4] == "drift" else P["zoom_cap"]) + 1e-6 for m in mv))
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
            {"t": 4.0, "type": "read", "box": [200, 100, 400, 120], "end": 9.0}]   # (no ZM10 drift between them)
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
    # loop round 2 (D5, RULEBOOK K2/T4): the dissolve arrives at the result, framed at once
    check("a skipped generation: dissolve, then the result framed at once", any(m[4] == "xfade" for m in mv6)
          and any(m[4] in ("pan", "cut", "in", "out") and m[0] <= 8.4 * 30 and m[5] == [200, 100, 400, 120] for m in mv6 if len(m) > 5))
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
    # loop round 1 (review v12 #21): hidden from when the cursor sets off for the click, not 0.35 s before the press
    check("bubble: a click under it does, from when the cursor sets off", camera.action_targets(evb, 4.0)
          and camera.action_targets(evb, 4.6) and not camera.action_targets(evb, 3.5))
    check("bubble: back right after the action", not camera.action_targets(evb, 5.5))
    # 5 / 6 compose: bubble-first A-roll transitions, the text gradient
    env = compose_long.bubble_env_expr([{"t0": 10.0, "t1": 20.0, "aroll_in": True, "aroll_out": True, "tail": compose_long.aroll_tail_s()}])
    check("#5 the bubble env fades in after the screencast and out before it", "clip((T-10.1" in env and "(1-clip((T-19.86" in env)
    # loop round 1 (review v12 #13, RULEBOOK T5): Jake's "so fast it isn't noticed" — 4 f bubble, then a 5 f screen dissolve
    check("#5 the A-roll dissolve is 5 f", abs(compose_long.aroll_tail_s() - 5 / 29.97) < 0.002)
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

print(f"test_longedit: {N} checks passed" + ("" if ok_cam else " (camera checks skipped: no cv2 here)"))
