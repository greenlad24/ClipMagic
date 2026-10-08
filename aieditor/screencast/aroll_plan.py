"""A-ROLL MOTION PLAN — the per-video, word-timed camera plan for the full-screen presenter.

Jake 2026-10-08 on the creative test: "the test only have text animations and nothing else (zooms,
screencast etc.)" — its one A-roll block [0, 964 s] got ONE push that capped after ~6 s: a still
frame for 16 minutes. This module turns the A-roll blocks + the narration words (+ the jump cuts
found in the picture + the overlay moments) into explicit shots that aroll_camera.py renders.

MEASURED on Jake's references (refs 2–5 = kwysV2smgfY, 3Jq-L6uLd28, Geg9TyNoi3w, AZxFgIVgHjg;
2026-10-08, ORB + RANSAC similarity scale on every 2nd non-screencast frame at 640×360, 9 006
presenter frames; script + numbers in REF_MEASURE below):
  · AR01 push: every presenter stretch starts at ×1.00 and pushes LINEARLY — rate over the first 3 s
    p50 1.98 / 2.55 / 2.62 / 1.85 %/s (r2/r3/r4/r5), capping at p50 ×1.12 / 1.14 / 1.13 / 1.10 (stretches ≥ 6 s)
    and holding there; the camera is moving 77 / 80 / 84 / 78 % of presenter time.
  · Jump cuts inside a presenter stretch do NOT change the framing: scale ratio across 106 presenter →
    presenter cuts p10–p90 0.97–1.01; only 3 cuts changed it ≥ 8 % (0–0.5 per presenter-minute). The
    push simply continues across them. (TECHNIQUES CUT07's "punch-in alternation every 2nd–3rd cut" is
    NOT supported by this measurement — ruling A2 in RULEBOOK.md.)
  · The push RESETS to ×1.00 where a presenter stretch begins again (after a screencast / full-screen
    graphic): non-screencast blocks p50 5.1–6.5 s, p75 7.6–8.6 s, p90 9.6–14.4 s (techniques.json
    pacing) — so a 2.25 %/s push is still moving at almost every frame of a reference block.
  · TR07 opening: identical preset in all 4 refs — frame 0 ≈ ×1.5, eased out to ×1.00 in ~1 s
    (frame-pair ratios 0.918, 0.906, 0.950, 0.966, 0.973 … at t = 0.13, 0.20, 0.27 … s).
  · AR02 outro punch: ×1.22–1.23 held while the social icons are on (r3 13:11, r4 13:17, r5 15:01),
    32 f bezier(.317,.093,.238,1) in (kwys-text-cta §4).

THE PLAN for a long A-roll stretch (where the reference would have cut to a screencast/graphic but
this video has none): the stretch is split into REFERENCE-LENGTH blocks at sentence starts (a real
jump cut in the picture near the sentence start is preferred, else the first word of the sentence on
a pause ≥ 0.25 s), each block a fresh AR01 push from ×1.00 — the cut back to ×1.00 on a new sentence
reads as the reference's A-roll re-entry, and the picture is never still longer than ~3 s (Jake's
rule 2 / RULEBOOK P1). Blocks: ≥ MIN_BLOCK_S, cut once the push has capped + HOLD_AFTER_CAP_S.

    plan(blocks, words, cuts=(), overlays=(), duration=None) -> {"shots": [...], "beats": [...], "stats": {...}}
    zoom_at(t, plan) -> scale at output time t (opening ease included)
"""
import math

RULES = {
    "rate_per_s": 0.0225,        # AR01 — refs p50 1.98 / 2.55 / 2.62 / 1.85 %/s → mean 2.25
    "cap": 1.13,                 # AR01 — refs p50 caps 1.12 / 1.14 / 1.13 / 1.10
    "min_block_s": 4.0,          # never a reset sooner (refs block p25 2.6–4.2 s, but a reset needs a sentence)
    "hold_after_cap_s": 1.5,     # cap reached at (cap-1)/rate ≈ 5.8 s; reset ≤ 1.5 s later → moving ≈ 80 % (refs 77–84 %), block ≈ 7.3 s (refs p75 7.6–8.6)
    "target_after_cap_s": 0.3,   # preferred reset ≈ 6.1 s into a push (refs block p50 5.1–6.5 s)
    "max_block_s": 10.0,         # hard limit — refs block p90 9.6–14.4 s; forced on the nearest word start
    "cut_snap_s": 0.6,           # a picture jump cut within this of a sentence start is used as the reset point
    "open_zoom": 1.548, "open_frames": 31, "open_ease": (0.089, 0.443, 0.126, 0.834),   # TR07
    "outro_zoom": 1.22, "outro_frames": 32, "outro_ease": (0.317, 0.093, 0.238, 1.0),     # AR02
}
REF_MEASURE = ("2026-10-08 motion/reference-specs/aroll/{measure,summarize}.py → summary.txt (run in aieditor-screencast:0.1 on "
               "/opt/aieditor-work/reference/<id>/video.mp4; screencast spans from reference/work/sc5/<id>/analysis.json)")
REF_FPS = 30000 / 1001


def bezier(x1, y1, x2, y2):
    """CSS cubic-bezier easing (same as camera.bezier, duplicated so this module stays pure-python)."""
    def f(x):
        if x <= 0:
            return 0.0
        if x >= 1:
            return 1.0
        lo, hi = 0.0, 1.0
        for _ in range(40):
            u = (lo + hi) / 2
            bx = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3
            if bx < x:
                lo = u
            else:
                hi = u
        u = (lo + hi) / 2
        return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3
    return f


def _word(w, k):
    return w.get(k, w.get({"start": "s", "end": "e", "word": "w"}[k]))


def sentence_starts(words, min_gap=0.25):
    """Output times where a sentence (or a breath-separated phrase) begins: after a word ending in
    . ! ? or after a pause ≥ min_gap."""
    out = []
    for k, w in enumerate(words):
        if k == 0:
            out.append(float(_word(w, "start")))
            continue
        p = words[k - 1]
        txt = str(_word(p, "word")).strip()
        gap = float(_word(w, "start")) - float(_word(p, "end"))
        if txt.endswith((".", "!", "?")) or gap >= min_gap:
            out.append(float(_word(w, "start")))
    return out


def _split(a, b, starts, cuts, word_starts, R):
    """Reset points inside one A-roll block [a, b): a new push whenever the current one has capped
    and held for up to hold_after_cap_s, on a sentence start (a jump cut near it preferred)."""
    resets = []
    cap_t = (R["cap"] - 1) / R["rate_per_s"]
    t = a
    while b - t > cap_t + R["hold_after_cap_s"]:
        lo, hi = t + R["min_block_s"], t + cap_t + R["hold_after_cap_s"]
        target = t + cap_t + R["target_after_cap_s"]          # the push has just capped: refs block p50 5.1–6.5 s
        cand = [s for s in starts if lo <= s <= hi and s <= b - R["min_block_s"] * 0.5]
        if cand:
            # a sentence start with a real picture jump cut close to it is the best reset point;
            # otherwise the sentence start nearest the target length
            snapped = sorted((abs(c - target), c) for s in cand for c in cuts if abs(c - s) <= R["cut_snap_s"])
            pick = snapped[0][1] if snapped else min(cand, key=lambda s: abs(s - target))
        else:
            lim = min(t + R["max_block_s"], b - R["min_block_s"] * 0.5)
            later = [s for s in starts if hi < s <= lim]
            ws = [s for s in word_starts if hi <= s <= lim]
            pick = later[0] if later else (ws[0] if ws else lim)
        if pick <= t + 1.0 or pick >= b - 1.0:
            break
        resets.append(round(pick, 3))
        t = pick
    return resets


def plan(blocks, words, cuts=(), overlays=(), duration=None, rules=None):
    R = {**RULES, **(rules or {})}
    words = sorted(words or [], key=lambda w: float(_word(w, "start")))
    starts = sentence_starts(words)
    word_starts = [float(_word(w, "start")) for w in words]
    shots, n_reset = [], 0
    for a, b in blocks:
        if b - a <= 0.05:
            continue
        bc = [c for c in cuts if a + 0.3 < c < b - 0.3]
        resets = _split(a, b, starts, bc, word_starts, R)
        edges = [a] + resets + [b]
        for k in range(len(edges) - 1):
            shots.append({"t0": round(edges[k], 3), "t1": round(edges[k + 1], 3), "z0": 1.0,
                          "rate": R["rate_per_s"], "cap": R["cap"],
                          "why": "block entry" if k == 0 else
                          ("reset on a jump cut at a sentence start" if any(abs(edges[k] - c) < 0.05 for c in bc)
                           else "reset on a sentence start"),
                          "technique": "AR01"})
        n_reset += len(resets)
    beats = []
    for ov in overlays or []:
        if ov.get("template") == "socials":
            t0, t1 = float(ov["t0"]), float(ov["t1"])
            if any(s["t0"] - 0.05 <= t0 and t1 <= s["t1"] + 0.3 for s in shots):
                beats.append({"t0": t0, "t1": t1, "z": R["outro_zoom"], "frames": R["outro_frames"],
                              "ease": list(R["outro_ease"]), "technique": "AR02", "why": "social icons on screen"})
    a_time = sum(s["t1"] - s["t0"] for s in shots)
    cap_t = (R["cap"] - 1) / R["rate_per_s"]
    moving = sum(min(s["t1"] - s["t0"], cap_t) for s in shots)
    return {"shots": shots, "beats": beats, "open": {"zoom": R["open_zoom"], "frames": R["open_frames"],
                                                      "ease": list(R["open_ease"]), "technique": "TR07"},
            "rules": R, "measured": REF_MEASURE,
            "stats": {"aroll_s": round(a_time, 2), "shots": len(shots), "resets": n_reset,
                      "moves_per_min": round(len(shots) / max(a_time, 1e-6) * 60, 2),
                      "moving_frac": round(moving / max(a_time, 1e-6), 3),
                      "longest_still_s": round(max([max(0.0, (s["t1"] - s["t0"]) - cap_t) for s in shots] or [0]), 2)}}


def zoom_at(t, p, fps=REF_FPS):
    """Scale at output time t: TR07 opening × AR01 push of the shot × AR02 beat."""
    z = 1.0
    o = p.get("open")
    if o and t * REF_FPS < o["frames"]:
        u = bezier(*o["ease"])(t * REF_FPS / o["frames"])
        z = o["zoom"] ** (1 - u)                    # log-scale ease to 1.0
    cur = next((s for s in p["shots"] if s["t0"] <= t < s["t1"]), None)
    if cur is None:
        # the block's last framing holds through the screencast's dissolve-in (no snap to 1.0, review N09)
        cur = next((s for s in p["shots"] if s["t1"] <= t < s["t1"] + 0.3), None)
    if cur is not None:
        tt = min(t, cur["t1"]) - cur["t0"]
        z *= min(cur["cap"], cur["z0"] * (1 + cur["rate"] * tt))
    for bt in p.get("beats", []):
        if bt["t0"] <= t < bt["t1"] + bt["frames"] / REF_FPS:
            d = bt["frames"] / REF_FPS
            e = bezier(*bt["ease"])
            u = e(min(1.0, (t - bt["t0"]) / d)) if t < bt["t1"] else 1 - e(min(1.0, (t - bt["t1"]) / d))
            z *= math.exp(math.log(bt["z"]) * u)
    return z
