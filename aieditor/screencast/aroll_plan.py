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
  · Jump cuts inside a presenter stretch: the live copy's measurement note M1 (2026-10-08: scale ratio across
    106 presenter → presenter cuts p10–p90 0.97–1.01; only 3 cuts changed it ≥ 8 %) DISAGREES with the loop
    RULEBOOK A2 (the copy that wins): "a take change inside an A-roll block that keeps the same framing gets a
    punch-in alternation of ×1.3–1.5 about the face (CUT07, refs 3–5); no jump cut with identical framing
    within 1 s of a transition" — BASELINE §7 measured CUT07 on about half of the r3–r5 jump cuts. So CUT07 is
    implemented and ON by default, behind the rules switch RULES["cut07"] (off = M1: the push simply
    continues across every cut).
  · The push RESETS to ×1.00 where a presenter stretch begins again (after a screencast / full-screen
    graphic): non-screencast blocks p50 5.1–6.5 s, p75 7.6–8.6 s, p90 9.6–14.4 s (techniques.json pacing).
  · TR07 opening: identical preset in all 4 refs — frame 0 ≈ ×1.5, eased out to ×1.00 in ~1 s
    (frame-pair ratios 0.918, 0.906, 0.950, 0.966, 0.973 … at t = 0.13, 0.20, 0.27 … s).
  · AR02 outro punch: ×1.22–1.23 held while the social icons are on (r3 13:11, r4 13:17, r5 15:01),
    32 f bezier(.317,.093,.238,1) in (kwys-text-cta §4).

THE PLAN (gap list G6, RULEBOOK §10 A1–A3, §5 T6/T8):
  · one AR01 push per A-roll block: ×1.00 at the block entry, linear 1–3 %/s, capped at ×1.12–1.16 and then
    HELD — never a reset on continuous footage (the old sentence-start splitting popped ×1.13 → ×1.00 48 times
    on the creative test); max_block_s no longer splits anything;
  · the push resets only at the block entry and at REAL picture cuts (aroll.cuts.json) that CUT07 reframes:
    about half of the in-block cuts alternate the framing ×1.00 ↔ ×1.40 about the face; two cuts less than
    1.5 s apart are never both left unmasked, nor is a cut within 1 s of the block's edges (A2); a cut that
    is left unmasked keeps the framing and the push runs on across it;
  · the plan never adds a cut: its "cuts" list is the input list, unchanged — the narration EDL and its
    pauses are not this module's business;
  · the first shot opens at ×1.548 and eases to the push over 31 f on (0.089,0.443,0.126,0.834) (TR07).

    plan(blocks, words, cuts=(), overlays=(), duration=None) -> {"shots": [...], "beats": [...], "stats": {...}}
    zoom_at(t, plan) -> scale at output time t (opening ease included)
"""
import math

# TODO(p2): read these from the skill's rules.json through aieditor/skill.py once p2 merges (same values).
RULES = {
    "rate_per_s": 0.0225,        # AR01 — refs p50 1.98 / 2.55 / 2.62 / 1.85 %/s → mean 2.25 (A1: 1–3 %/s)
    "cap": 1.13,                 # AR01 — refs p50 caps 1.12 / 1.14 / 1.13 / 1.10 (A1: ×1.12–1.16, then HOLD)
    "max_block_s": 10.0,         # (kept for old callers: no longer splits a block — G6 step 1)
    "cut07": True,               # A2 CUT07 punch-in alternation on real jump cuts (False = M1: push runs on)
    "punch_zoom": 1.40,          # A2: ×1.3–1.5 about the face
    "punch_share": 0.5,          # about half of the in-block cuts (BASELINE §7)
    "pair_s": 1.5,               # two cuts closer than this are never both unmasked (closest pair in any ref)
    "edge_s": 1.0,               # A2: no identical-framing jump cut within 1 s of a transition
    "open_zoom": 1.548, "open_frames": 31, "open_ease": (0.089, 0.443, 0.126, 0.834),   # TR07 (T6: ×1.36–1.55)
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


def masks(a, b, cuts, R):
    """{cut time: masked?} for the real cuts inside one block [a, b): CUT07 alternation (A2). A cut is
    masked when the framing changes across it (×1.00 ↔ punch). Forced: a cut within edge_s of the block's
    edges and the second of two cuts closer than pair_s when the first was left unmasked; otherwise the
    running share is kept at punch_share."""
    out, done, n_mask, prev = {}, 0, 0, None
    for c in sorted(cuts):
        force = (c - a < R["edge_s"] or b - c < R["edge_s"]
                 or (prev is not None and not out[prev] and c - prev < R["pair_s"]))
        m = force or n_mask < R["punch_share"] * (done + 1) - 1e-9
        out[c] = m
        done += 1
        n_mask += m
        prev = c
    return out


def plan(blocks, words, cuts=(), overlays=(), duration=None, rules=None):
    """blocks [[t0, t1]] A-roll spans; words (output clock); cuts = the picture's real jump cuts
    (aroll.cuts.json) — returned unchanged as plan["cuts"]: this plan reframes cuts, it never adds one."""
    R = {**RULES, **(rules or {})}
    cuts = list(cuts or [])
    shots, n_reset, masked, unmasked = [], 0, [], []
    first = True
    for a, b in blocks:
        if b - a <= 0.05:
            continue
        bc = sorted(c for c in cuts if a + 0.3 < c < b - 0.3)
        mk = masks(a, b, bc, R) if R["cut07"] else {c: False for c in bc}
        edges, z0s, punched = [a], [1.0], False
        for c in bc:
            if mk[c]:
                punched = not punched
                edges.append(c)
                z0s.append(R["punch_zoom"] if punched else 1.0)
                masked.append(c)
            else:
                unmasked.append(c)
        edges.append(b)
        for k in range(len(edges) - 1):
            sh = {"t0": round(edges[k], 3), "t1": round(edges[k + 1], 3), "z0": z0s[k],
                  "rate": R["rate_per_s"], "cap": R["cap"],
                  "why": "block entry" if k == 0 else ("CUT07 punch-in on a jump cut" if z0s[k] > 1.0
                                                       else "CUT07 back to ×1.00 on a jump cut"),
                  "technique": "AR01" if k == 0 else "CUT07",
                  "cuts_inside": [c for c in bc if edges[k] < c < edges[k + 1]]}
            dur = sh["t1"] - sh["t0"]
            sh["z_end"] = round(min(sh["cap"], 1 + sh["rate"] * dur), 4)   # the push factor reached (× z0)
            if first and k == 0:
                sh.update(z0=R["open_zoom"], ease_frames=R["open_frames"], ease=list(R["open_ease"]),
                          technique="TR07+AR01", why="video opening (TR07) then the block's push")
            shots.append(sh)
            if k:
                n_reset += 1
        first = False
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
    close = sum(1 for x, y in zip(sorted(masked + unmasked), sorted(masked + unmasked)[1:])
                if y - x < R["pair_s"] and x in unmasked and y in unmasked)
    return {"shots": shots, "beats": beats, "cuts": cuts,
            "open": {"zoom": R["open_zoom"], "frames": R["open_frames"], "ease": list(R["open_ease"]),
                     "technique": "TR07", "on": "shots[0]"},
            "rules": R, "measured": REF_MEASURE,
            "stats": {"aroll_s": round(a_time, 2), "shots": len(shots), "resets": n_reset,
                      "cuts_in_blocks": len(masked) + len(unmasked), "masked": len(masked), "unmasked": len(unmasked),
                      "masked_share": round(len(masked) / max(1, len(masked) + len(unmasked)), 3),
                      "unmasked_per_min": round(len(unmasked) / max(a_time, 1e-6) * 60, 2),
                      "unmasked_close_pairs": close,
                      "moves_per_min": round(len(shots) / max(a_time, 1e-6) * 60, 2),
                      "moving_frac": round(moving / max(a_time, 1e-6), 3),
                      "longest_still_s": round(max([max(0.0, (s["t1"] - s["t0"]) - cap_t) for s in shots] or [0]), 2)}}


def zoom_at(t, p, fps=REF_FPS):
    """Scale at output time t: the shot's framing (×1.00 or the CUT07 punch; the first shot eases out of the
    TR07 opening) × its AR01 push (held at the cap) × an AR02 beat."""
    z = 1.0
    cur = next((s for s in p["shots"] if s["t0"] <= t < s["t1"]), None)
    if cur is None:
        # the block's last framing holds through the screencast's dissolve-in (no snap to 1.0, review N09)
        cur = next((s for s in p["shots"] if s["t1"] <= t < s["t1"] + 0.3), None)
    if cur is not None:
        tt = min(t, cur["t1"]) - cur["t0"]
        z0 = cur["z0"]
        if cur.get("ease_frames"):
            u = bezier(*cur["ease"])(min(1.0, tt * REF_FPS / cur["ease_frames"]))
            z0 = z0 ** (1 - u)                       # log-scale ease to ×1.00
        z = z0 * min(cur["cap"], 1 + cur["rate"] * tt)
    for bt in p.get("beats", []):
        if bt["t0"] <= t < bt["t1"] + bt["frames"] / REF_FPS:
            d = bt["frames"] / REF_FPS
            e = bezier(*bt["ease"])
            u = e(min(1.0, (t - bt["t0"]) / d)) if t < bt["t1"] else 1 - e(min(1.0, (t - bt["t1"]) / d))
            z *= math.exp(math.log(bt["z"]) * u)
    return z
