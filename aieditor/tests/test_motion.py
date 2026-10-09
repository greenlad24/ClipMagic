"""Reference camera (screencast/camera.py, gap list G5) and A-roll motion (screencast/aroll_plan.py, G6).

Pure python (the planners need no numpy/cv2). The G5/G6 acceptance runs OFFLINE on a compacted copy of the
failed factory job's edit-01 (tests/fixtures/p3/e2e_edit01.json.gz: events.json per screencast, the edl
words, blocks.json, aroll.cuts.json, overlays.json + the old camera.json summaries) — no video job, no
recording, nothing written outside a temp dir.

Run: python3 tests/test_motion.py
"""
import gzip
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "screencast"))
import aroll_plan as A  # noqa: E402
import camera as C  # noqa: E402

N = 0
FIX = ROOT / "tests" / "fixtures" / "p3" / "e2e_edit01.json.gz"


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def narration(dur, sent_every=7):
    ws, t, k = [], 0.2, 0
    while t < dur - 0.5:
        end = (k % sent_every) == sent_every - 1
        ws.append({"word": "word." if end else "word", "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += 0.42 + (0.35 if end else 0)
        k += 1
    return ws


# ── camera: synthetic cases ─────────────────────────────────────────────────────────────────────
W, H, FPS = 2560, 1440, 30.0
CAP = {"w": W, "h": H, "fps": FPS}
P = C.params()
E = C.make_eases(P)


def plan(evs, end, words=None, url="https://chatgpt.com/", why=None):
    ev = {"capture": CAP, "events": [{"t": 0, "type": "begin"}] + evs, "end": end, "url": url}
    return ev, C.plan_moves(ev, FPS, 0, int(end * FPS) + 1, P, words=words, span_end=end, why=why)


def w(word, t):
    return {"word": word, "start": t, "end": t + 0.3}


def said(word, t):
    """A clause that names `word` at t (the words before it run on, so the clause starts ~1 s earlier)."""
    return [w(x, round(t - 0.3 * (3 - k), 3)) for k, x in enumerate(("look", "at", "the"))] + [w(word, t)]


def zoom_at_s(mv, t):
    return C.camera_at(mv, t * FPS, P, E, W, H)[0]


def camera_cases():
    # G5 step 1: no release / drift; one inward ZM10 push per long hold, never outward
    talk = [w("now", 0.6), w("click", 0.9), w("on", 1.2), w("the", 1.5), w("templates", 1.8)]
    ev, mv = plan([{"t": 1.0, "type": "click", "box": [800, 400, 900, 600], "abox": [800, 400, 900, 600],
                    "text": "Templates", "press": 2.0, "end": 2.2}], 20.0, talk)
    kinds = [m[4] for m in mv]
    check("release" not in kinds and "drift" not in kinds, f"no release/drift: {kinds}")
    pushes = [m for m in mv if m[4] == "push"]
    check(len(pushes) == 1 and pushes[0][3][0] > pushes[0][2][0], f"one inward push: {pushes}")
    check(1.06 - 1e-6 <= pushes[0][3][0] / pushes[0][2][0] <= 1.26 + 1e-6 and 24 <= pushes[0][1] * C.REF_FPS / FPS <= 46 + 1e-6,
          "push inside ZM10 (×1.06–1.26 over 24–46 f)")
    check(not any(m[1] > 0 and m[3][0] < m[2][0] - 1e-6 and m[4] not in ("cut", "xfade") for m in mv), "no outward move without a target")
    # G5 step 2 / M1: the word-timed move starts 0.5–0.9 s before the word and lands by word + 0.3 s
    mi = next(m for m in mv if m[4] == "in")
    s0, s1 = mi[0] / FPS, (mi[0] + mi[1]) / FPS
    check(1.8 - 0.9 - 1e-6 <= s0 <= 1.8 - 0.5 + 1e-6 and s1 <= 1.8 + 0.3 + 1e-6, f"word-timed in-move {s0:.2f}–{s1:.2f} vs word 1.80")
    check(34 - 0.5 <= mi[1] * C.REF_FPS / FPS <= 48 + 0.5, f"in-move 34–48 f: {mi[1]}")
    check(1.19 - 1e-9 <= mi[3][0] <= 1.30 + 1e-9, f"a result/panel lands at ×1.19–1.30: {mi[3][0]}")
    # step 4: a cursor point, a read and a hover are never camera targets; a small box grows to its container
    check(C.camera_box({"type": "click", "abox": [1398, 646, 3, 3]}, W, H) is None, "a 3×3 cursor point is not a target")
    check(C.camera_box({"type": "read", "box": [900, 500, 600, 300]}, W, H) is None, "a read is not a target")
    check(C.camera_box({"type": "hover", "box": [900, 500, 600, 300], "abox": [900, 500, 600, 300]}, W, H) is None, "a hover is not a target")
    b = C.camera_box({"type": "click", "abox": [25, 105, 73, 73]}, W, H)
    check(b and max(b[2], b[3]) >= 120, f"a 73 px thumbnail grows to its container: {b}")
    tb = C.camera_box({"type": "read", "target_box": [800, 400, 500, 300]}, W, H)
    check(tb == [800, 400, 500, 300], "a compiled beat's target_box wins (p7), whatever the event type")
    ev, mv = plan([{"t": 1.0, "type": "read", "box": [1000, 600, 400, 200], "text": "Templates", "end": 4.0}], 8.0, said("templates", 1.2))
    check(not any(len(m) > 5 and m[5] == [1000, 600, 400, 200] for m in mv), "a named read still never moves the camera")
    # F3 classes and the cap; F4 off-page
    check(C.classify([0, 0, 1200, 600], W, H) == "result" and C.classify([0, 0, 900, 80], W, H) == "text"
          and C.classify([0, 0, 600, 60], W, H) == "row" and C.classify([0, 0, 130, 120], W, H) == "control", "F3 classes")
    for box in ([1200, 650, 130, 120], [600, 300, 900, 80], [400, 300, 1200, 700], [2300, 1300, 200, 120]):
        v = C.frame_target(box, W, H, P)
        check(v[0] <= 1.65 + 1e-9 and C.black_share(None, v, W, H) <= 0.05 + 1e-9, f"cap + F4 for {box}: {v}")
        dx, dy = C.landing_offset(box, v, W, H)
        check((dx <= 0.06 + 1e-6 and dy <= 0.08 + 1e-6) or C.edge_limited(box, v, W, H), f"F1 centred (or edge-limited) {box}: {dx:.3f},{dy:.3f}")
    lo, hi = C.REF["bands"]["control"]
    check(lo - 1e-9 <= C.frame_target([1200, 650, 130, 120], W, H, P)[0] <= hi + 1e-9, "a small control lands in 1.50–1.65")
    # K1: typing / pasting is shown at ×1.00 (a held zoom opens out as the typing starts)
    ev, mv = plan([{"t": 1.0, "type": "click", "box": [1000, 600, 400, 200], "abox": [1000, 600, 400, 200], "text": "Logo",
                    "press": 1.6, "end": 1.8},
                   {"t": 6.0, "type": "type", "box": [800, 1200, 900, 120], "abox": [800, 1200, 900, 120], "text": "a prompt", "end": 8.0}],
                  10.0, said("logo", 1.5))
    check(any(m[4] == "in" for m in mv), "the named click zooms in")
    check(abs(zoom_at_s(mv, 6.02) - 1.0) < 1e-6 and abs(zoom_at_s(mv, 7.5) - 1.0) < 1e-6, "typing at ×1.00 (K1)")
    outs = [m for m in mv if m[4] == "out"]
    check(outs and 34 - 0.5 <= outs[0][1] * C.REF_FPS / FPS <= 40 + 0.5 and outs[0][5], "the open-out is 34–40 f with a target (the page)")
    # M6: no time for an eased move → a cut that lands framed
    ev, mv = plan([{"t": 0.6, "type": "click", "box": [300, 200, 400, 200], "abox": [300, 200, 400, 200], "text": "Images", "press": 1.0, "end": 1.1},
                   {"t": 1.1, "type": "click", "box": [1800, 1000, 400, 200], "abox": [1800, 1000, 400, 200], "text": "Logo", "press": 1.6, "end": 1.7}],
                  8.0, [w("images", 0.9), w("and", 1.2)] + said("logo", 1.5)[2:])
    lg = [m for m in mv if len(m) > 5 and m[5] == [1800, 1000, 400, 200]]
    check(lg and (lg[0][4] == "cut" or lg[0][1] * C.REF_FPS / FPS >= 26 - 0.5), f"too little time → M6 cut (or a measured pan): {lg}")
    # T8: two camera cuts closer than 6 f are one; no cut pair x1.0→x1.4→x1.0 inside one page state
    mv2 = C._no_flash([(30, 0, None, (1.4, 1, 1), "cut", None), (33, 0, None, (1.0, 1, 1), "cut", None)], FPS, 0)
    check(len(mv2) == 1, "a 3 f cut-in/cut-out flash is one cut")
    # T1/T2/T4: same-site goto = hard cut with the zoom carried; another site = a dissolve
    ev, mv = plan([{"t": 3.0, "type": "nav", "url": "https://chatgpt.com/library"}], 6.0)
    check(not any(m[4] == "xfade" for m in mv), "a same-site goto/reload is a hard cut")
    ev, mv = plan([{"t": 3.0, "type": "nav", "url": "https://www.linearity.io/"}], 6.0)
    check(any(m[4] == "xfade" and m[6] == P["xfade_frames"] for m in mv), "a new site dissolves")
    ev, mv = plan([{"t": 0.2, "type": "nav", "url": "https://chatgpt.com/"}, {"t": 0.2, "type": "nav", "url": "https://chatgpt.com/", "cut": True},
                   {"t": 0.3, "type": "cut", "why": "click"}], 6.0)
    check(not any(m[0] < 0.5 * FPS and m[4] in ("cut", "xfade") for m in mv) and C.lead_skip(ev, P) >= 0.3 - 1e-9,
          "≤ 1 transition in a span's first 0.5 s (the entry): the opening changes are skipped")
    # T5/CUT04: spans end still zoomed — no move back to ×1.00 in the last 0.3 s
    ev, mv = plan([{"t": 1.0, "type": "click", "box": [1000, 600, 400, 200], "abox": [1000, 600, 400, 200], "text": "Logo", "press": 1.6, "end": 1.8},
                   {"t": 7.85, "type": "type", "box": [800, 1200, 900, 120], "abox": [800, 1200, 900, 120], "text": "x", "end": 8.0}], 8.0, said("logo", 1.5))
    check(not any(m[3] is not None and m[3][0] <= 1.0 + 1e-6 and m[0] >= (8.0 - 0.5) * FPS for m in mv), "no reset to ×1.00 at the span end")
    # B2: the bubble hides only when the ACTED box meets the disc + 24 px
    evb = {"capture": {**CAP, "scale": 1.0}, "events": [
        {"t": 1.0, "type": "click", "box": [2150, 280, 120, 60], "abox": [2150, 280, 120, 60], "press": 1.5, "end": 1.6},
        {"t": 3.0, "type": "click", "box": [200, 900, 120, 60], "abox": [200, 900, 120, 60], "press": 3.5, "end": 3.6},
        {"t": 5.0, "type": "click", "box": [1404, 186, 1154, 1154], "abox": [1404, 186, 1154, 1154], "press": 5.5, "end": 5.6}],
        "cursor": [[0, 100, 100], [5.4, 300, 1300], [5.6, 300, 1300]]}
    dec = C.bubble_decisions(evb, [], FPS, 0, P, E)
    hides = [dec[id(e)] for e in evb["events"]]
    check(hides == [True, False, False], f"B2: under the disc hides, far away does not, a big photo clicked far from the disc does not: {hides}")


# ── camera: the failed job, offline (G5 acceptance) ─────────────────────────────────────────────
def clip_words(words, t0, t1):
    return [{"word": x["word"], "start": round(x["start"] - t0, 3), "end": round(x["end"] - t0, 3)}
            for x in words if t0 - 1.0 <= x["start"] <= t1 + 1.0]


def job_camera(fx):
    tot = {"release": 0, "outward": 0, "cut_pairs": 0, "bad_len": [], "typed_zoom": [], "over": [], "small": [], "black": [],
           "land": [], "matched": [], "epm": {}, "hides": {}, "xf": {}, "entry": {}, "end_reset": {}, "sc09_f209": []}
    for i, seg in enumerate(fx["segments"]):
        ev, t0, t1 = seg["events"], seg["t0"], seg["t1"]
        span, fps = t1 - t0, ev["capture"]["fps"]
        Wc, Hc = ev["capture"]["w"], ev["capture"]["h"]
        cw = clip_words(fx["words"], t0, t1)
        why = []
        mv = C.plan_offline(ev, P, cw, span, why=why)
        whyd = {id(e): r for e, r in why}
        states, skip = C.page_states(ev, P)
        st_f = [s["t"] * fps for s in states]
        tot["release"] += sum(1 for m in mv if m[4] in ("release", "drift"))
        tot["outward"] += sum(1 for m in mv if m[4] not in ("cut", "xfade") and m[1] > 0 and m[3][0] < m[2][0] - 1e-6 and not (len(m) > 5 and m[5]))
        cuts = [m for m in mv if m[4] == "cut"]
        tot["cut_pairs"] += sum(1 for a, b in zip(cuts, cuts[1:]) if not any(a[0] < s < b[0] for s in st_f)
                                and a[3][0] > a[2][0] * 1.05 and abs(b[3][0] - a[2][0]) < 0.05)
        for m in mv:
            if m[4] in ("in", "out") and m[1] > 0 and not 34 - 0.01 <= m[1] * C.REF_FPS / fps <= 58 + 0.01:
                tot["bad_len"].append((i, m[0] / fps, m[1]))
            if m[3] is not None and m[3][0] > 1.65 + 1e-6:
                tot["over"].append((i, m[3][0]))
            if len(m) > 5 and m[5] and m[4] in ("in", "out", "pan", "cut") and m[3][0] > 1.0 and max(m[5][2], m[5][3]) < 120:
                tot["small"].append((i, m[5]))
            if m[3] is not None and m[4] != "xfade" and C.black_share(None, m[3], Wc, Hc) > 0.05 + 1e-9:
                tot["black"].append((i, m[3]))
            if m[4] == "cut" and abs(m[0] - 209) <= 3 and i == 9:
                tot["sc09_f209"].append(m)
        for e in ev["events"]:
            if e["type"] == "type" and e["t"] > skip and C.camera_at(mv, (e["t"] + 0.02) * fps, P, E, Wc, Hc)[0] > 1.0 + 1e-3:
                tot["typed_zoom"].append((i, t0 + e["t"]))
        tot["land"] += C.landings(mv, ev, fps, 0, P)
        for tg in C.camera_targets(ev, P, cw):
            if not tg["matched"] or tg["typing"]:
                continue
            mm = next((m for m in mv if len(m) > 5 and m[5] == tg["box"] and abs(m[0] / fps - tg["t_word"]) < 3.0), None)
            r = whyd.get(id(tg["e"]))
            if mm is not None:
                tot["matched"].append((i, round(t0 + tg["t_word"], 2), round(mm[0] / fps - tg["t_word"], 2),
                                       round((mm[0] + mm[1]) / fps - tg["t_word"], 2), mm[4]))
            else:
                tot["matched"].append((i, round(t0 + tg["t_word"], 2), None, None, r))
        tot["epm"][i] = round(len(C.motion_events(mv, ev, fps, 0, span, P)) / (span / 60), 1)
        tot["hides"][i] = C.bubble_hide_spans(ev, mv, fps, 0, P, E, 0, int(span * 29.97), 29.97)
        tot["xf"][i] = [round(m[0] / fps, 3) for m in mv if m[4] == "xfade"]
        tot["entry"][i] = sum(1 for m in mv if m[4] in ("cut", "xfade") and m[0] / fps < 0.5)
        tot["end_reset"][i] = [m for m in mv if m[3] is not None and m[3][0] <= 1.0 + 1e-6 and m[4] in ("cut", "out")
                               and m[0] / fps >= span - 0.5]
    return tot


def camera_job_cases():
    if not FIX.exists():
        print("  (camera job fixture missing — skipped)")
        return
    fx = json.load(gzip.open(FIX, "rt"))
    t = job_camera(fx)
    check(t["release"] == 0, "G5: 0 release/drift moves (old: dozens in sc-00/01/03/05/06/08/10/11)")
    check(t["outward"] == 0, "G5: 0 outward non-cut moves without a new target")
    check(t["cut_pairs"] == 0, "G5: 0 cut pairs ×1.0→×1.4→×1.0 inside one page state")
    check(not t["bad_len"], f"G5: every in/out move 34–58 f: {t['bad_len']}")
    check(not t["typed_zoom"], f"G5: 0 type/paste events above ×1.00: {t['typed_zoom']}")
    check(not t["over"], f"G5: 0 landings above ×1.65: {t['over']}")
    check(not t["small"], f"G5: 0 targets under 120 px: {t['small']}")
    check(not t["black"], f"G5: 0 landings with > 5 % off-page: {t['black']}")
    land = t["land"]
    ok = [x for x in land if x["centred"] or x["edge_limited"]]
    check(len(ok) >= 0.9 * len(land), f"G5: ≥ 90 % of landings centred within 0.06 W / 0.08 H (or as close as the page edge allows): {len(ok)}/{len(land)}")
    m = t["matched"]
    on_time = [x for x in m if x[2] is not None and -0.9 - 1e-6 <= x[2] <= 0.0 + 1e-6 and x[3] <= 0.3 + 1e-6]
    held = [x for x in m if x[2] is None and x[4] in ("already framed", "typing follows")]
    check(m and len(on_time) + len(held) >= 0.8 * len(m) and not [x for x in m if x[2] is not None and x[3] > 0.3 + 1e-6],
          f"G5: ≥ 80 % of the word-matched camera targets move −0.9..0 s before their word and land ≤ +0.3 s "
          f"(the rest already framed or held at ×1.00 for typing, K1): {len(on_time)} + {len(held)} of {len(m)}: {m}")
    tpl = next((x for x in m if abs(x[1] - 506.89) < 0.05), None)
    check(tpl and tpl[2] is not None and -0.9 <= tpl[2] <= 0 and tpl[3] <= 0.3, f"'templates' 506.89 on its word: {tpl}")
    check(all(v <= 30 for v in t["epm"].values()), f"G5/P2: no screencast above 30 motion events per minute: {t['epm']}")
    check(17 <= t["epm"][0] <= 25, f"G5/P2: sc-00 17–25 motion events per minute (was ~40): {t['epm'][0]}")
    old = {i: s["old"] for i, s in enumerate(fx["segments"])}

    def gone(i, a):
        return not any(abs(h[0] - a) < 0.3 for h in t["hides"][i])
    check(gone(3, 22.89) and gone(3, 25.659) and gone(5, 9.71) and gone(6, 21.355), f"G5/B2: the unjustified bubble hides are gone: {t['hides']}")
    check(any(h[0] <= 29.0 and h[1] >= 28.73 for h in t["hides"][5]), "G5/B2: sc-05 310–315 (a type under the disc) stays")
    # sc-05 25.29: the comment-pin click's PRESS POINT sits under the disc in the new ×1.00 framing → B2 keeps it
    ev5 = fx["segments"][5]["events"]
    pin = next(e for e in ev5["events"] if e["type"] == "click" and abs(e["t"] - 25.56) < 0.05)
    mv5 = C.plan_offline(ev5, P, clip_words(fx["words"], fx["segments"][5]["t0"], fx["segments"][5]["t1"]),
                         fx["segments"][5]["t1"] - fx["segments"][5]["t0"])
    gap = C.disc_gap(C.acted_box(pin, ev5), C.camera_at(mv5, pin["press"] * ev5["capture"]["fps"] - 1, P, E, 2560, 1440), 2560, 1440)
    check(gap <= C.REF["bubble_margin_px"], f"sc-05 25.29 hide is B2-justified now (press point {gap:.0f} px from the disc rim)")
    check(old[1]["xfades"] and not any(abs(x - 3.97) < 0.1 or abs(x - 9.71) < 0.1 for x in t["xf"][1]),
          f"G5/T1: sc-01 75.04/80.78 same-app dissolves are hard cuts now: {t['xf'][1]}")
    check(not any(abs(x - 18.952) < 0.1 for x in t["xf"][11]), "G5/T1: sc-11 18.95 reload is a hard cut")
    check(len(old[0]["xfades"]) == 3 and t["entry"][0] == 0, "G5/T8: the sc-00 entry has 1 transition (the span's own entry), not 3 dissolves")
    check(209 in old[9]["cuts_f"] and not t["sc09_f209"] and not t["end_reset"][9], "G5/T5: the sc-09 end reset at f209 is gone")
    check(not any(t["end_reset"].values()), f"G5/T5: no span ends with a move back to ×1.00: {t['end_reset']}")
    print(f"  camera job: {len(land)} landings ({len([x for x in land if x['centred']])} centred, the rest edge-limited), "
          f"{len(on_time)} on-word moves + {len(held)} held of {len(m)} word-matched; events/min {t['epm']}")


# ── A-roll (G6) ─────────────────────────────────────────────────────────────────────────────────
def aroll_cases():
    R = A.RULES
    check(0.01 <= R["rate_per_s"] <= 0.03 and 1.12 <= R["cap"] <= 1.16, "A1 numbers inside the band")
    check(1.3 <= R["punch_zoom"] <= 1.5 and R["cut07"] is True, "A2 CUT07 on, punch ×1.3–1.5")
    # one push per block, held at the cap: never a reset on continuous footage (old: sentence starts)
    ws = narration(120.0)
    p = A.plan([[0.0, 2.0], [10.0, 120.0]], ws)
    shots = [s for s in p["shots"] if s["t0"] >= 10.0]
    check(len(shots) == 1 and shots[0]["z0"] == 1.0, f"a 110 s block without cuts is ONE shot: {shots}")
    check(abs(A.zoom_at(100.0, p) - R["cap"]) < 1e-9 and abs(A.zoom_at(60.0, p) - R["cap"]) < 1e-9, "the push holds at the cap")
    check(A.plan([[0.0, 2.0], [10.0, 120.0]], ws, rules={"max_block_s": 3.0})["stats"]["resets"] == 0, "max_block_s alone creates no reset")
    # CUT07: alternation on real cuts; the cut list is returned unchanged; no reset without a cut
    cuts = [15.0, 21.0, 21.8, 30.0, 38.5, 45.0, 52.0, 52.9, 60.0, 71.0, 80.0, 95.5, 96.4, 110.0]
    p = A.plan([[0.0, 2.0], [10.0, 120.0]], ws, cuts=cuts)
    check(p["cuts"] == cuts, "the output cut list equals the input")
    resets = [s["t0"] for s in p["shots"] if s["technique"] == "CUT07"]
    check(all(any(abs(r - c) <= 0.1 for c in cuts) for r in resets), "every reset sits on a real picture cut")
    st = p["stats"]
    check(0.4 <= st["masked_share"] <= 0.6 and st["unmasked_close_pairs"] == 0, f"40–60 % masked, no unmasked pair < 1.5 s: {st}")
    for s in p["shots"]:
        check(0.01 <= s["rate"] <= 0.03 and s["z_end"] <= 1.16 + 1e-9, f"push 1–3 %/s, z_end ≤ 1.16: {s}")
        check(s["z0"] == 1.0 or 1.3 <= s["z0"] <= 1.5 or s.get("ease_frames"), f"framing ×1.00 or the punch: {s}")
    for c in cuts:
        a_, b_ = A.zoom_at(c - 0.01, p), A.zoom_at(c + 0.01, p)
        masked = abs(math.log(b_ / a_)) > math.log(1.2)
        same = abs(b_ - a_) < 0.002
        check(masked or same, f"a cut either punches/returns (masked) or keeps the framing: {c} {a_:.3f}→{b_:.3f}")
    one = A.plan([[0.0, 2.0], [10.0, 40.0]], narration(40.0), cuts=[25.0], rules={"cut07": False})
    check(len([s for s in one["shots"] if s["t0"] >= 10]) == 1 and abs(A.zoom_at(25.01, one) - A.zoom_at(24.99, one)) < 0.002,
          "cut07 off (M1): the push runs on across a cut")
    edge = A.plan([[0.0, 2.0], [10.0, 40.0]], narration(40.0), cuts=[10.6, 39.5])
    check(edge["stats"]["unmasked"] == 0, "A2: no identical-framing jump cut within 1 s of a block edge")
    # TR07 opening on the first shot
    p = A.plan([[0.0, 30.0]], narration(30.0))
    s0 = p["shots"][0]
    check(1.36 <= s0["z0"] <= 1.55 and 29 <= s0["ease_frames"] <= 33 and s0["ease"] == [0.089, 0.443, 0.126, 0.834], f"TR07 first shot: {s0}")
    check(abs(A.zoom_at(0.0, p) - s0["z0"]) < 1e-9 and abs(A.zoom_at(31 / 29.97 + 0.01, p) - (1 + R["rate_per_s"] * (31 / 29.97 + 0.01))) < 0.01,
          "the opening eases into the push")
    # AR02 + block-end hold
    ov = [{"template": "socials", "t0": 20.0, "t1": 24.0}, {"template": "keyword", "t0": 5.0, "t1": 7.0}]
    p = A.plan([[0.0, 30.0]], narration(30.0), overlays=ov)
    check(len(p["beats"]) == 1 and p["beats"][0]["technique"] == "AR02", f"one AR02 beat: {p['beats']}")
    check(abs(A.zoom_at(22.0, p) / R["cap"] - 1.22) < 0.01, "×1.22 while the icons are on")
    p = A.plan([[0.0, 5.0], [9.0, 14.0]], narration(14.0))
    check(abs(A.zoom_at(5.1, p) - A.zoom_at(4.999, p)) < 0.002 and A.zoom_at(9.0, p) == 1.0,
          "the block's last framing holds into the screencast; the next block enters at ×1.00 (no pop)")


def aroll_job_cases():
    if not FIX.exists():
        return
    fx = json.load(gzip.open(FIX, "rt"))
    cuts = list(fx["cuts"])
    p = A.plan(fx["blocks"], fx["words"], cuts, [{"template": o["template"], "t0": o["t0"], "t1": o["t1"]} for o in fx["overlays"]])
    check(p["cuts"] == cuts and len(cuts) == 63, "G6: the plan's cut list equals aroll.cuts.json (63, none added)")
    resets = [s["t0"] for s in p["shots"] if s["technique"] == "CUT07"]
    check(all(any(abs(r - c) <= 0.1 for c in cuts) for r in resets), "G6: 0 resets without a picture cut at their time (old: 48)")
    for t in (7.226, 12.108, 58.262, 64.022, 716.17, 777.1):
        check(not any(abs(s["t0"] - t) < 0.1 for s in p["shots"]), f"G6 pinned: no reset at {t}")
    # 267.2 IS a real cut in aroll.cuts.json: CUT07 may reframe it (a masked take change, not a pop)
    check(267.2 in cuts, "267.2 is a picture cut (find_cuts), so a reset there is a CUT07 reframe")
    st = p["stats"]
    check(0.4 <= st["masked_share"] <= 0.6, f"G6: 40–60 % of the real in-block cuts carry the punch: {st}")
    check(st["unmasked_close_pairs"] == 0, "G6: 0 unmasked cut pairs closer than 1.5 s (686.09/686.72/687.22, 714.18/714.91, 730.80/731.26)")
    for s in p["shots"]:
        check(0.01 <= s["rate"] <= 0.03 and s["z_end"] <= 1.16 + 1e-9, f"G6: push 1–3 %/s and z_end ≤ 1.16: {s}")
        if s["z0"] == 1.0:
            check(s["why"] == "block entry" or s["technique"] == "CUT07", "×1.00 shots only at block entries or as the unpunched side")
    s0 = p["shots"][0]
    check(1.36 <= s0["z0"] <= 1.55 and 29 <= s0["ease_frames"] <= 33 and s0["ease"] == [0.089, 0.443, 0.126, 0.834], "G6: TR07 first shot")
    print(f"  A-roll job: {st}")


def main():
    camera_cases()
    camera_job_cases()
    aroll_cases()
    aroll_job_cases()
    print(f"test_motion: {N} checks passed")


if __name__ == "__main__":
    main()
