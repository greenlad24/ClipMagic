"""Camera framings for single-camera SHORTS — the reference's camera rhythm with one camera.

Measured on the reference (prompt-camera-sfx spec, B_camera): three LOCKED framings
(no drift, no slow push), never the same framing twice in a row, A↔B alternation with W
as the third angle; camera shot medians A 3.7 s, W 3.1 s, B 2.7 s; 61 % of cuts sit in a
pause, the next word ~0.12 s after the cut. Exactly ONE animated punch-in in 10 minutes.

Jake shoots one 4K vertical camera, so the framings are crops of it, and they change
only where the edit already cuts (every piece boundary is a cut: a framing change there
also hides the jump). Graphics live on the shirt zone of the FULL frame, so any shot a
graphic overlaps is A or W (W's 1.15× keeps the face above the zone); the 1.35× close-up
B only plays between graphics.
Framing geometry is STYLE (where Jake sits in his frame), not measured motion.
"""

# scale = zoom factor; cx = crop centre x (0..1); top = crop top as a fraction of the
# frame (0 = keep the head room the frame already has — Jake's face is at y≈0.22)
FRAMINGS = {
    "A": {"scale": 1.0, "cx": 0.5, "top": 0.0},
    "B": {"scale": 1.35, "cx": 0.5, "top": 0.0},
    "W": {"scale": 1.15, "cx": 0.46, "top": 0.0},
}
MIN_SHOT_S = 1.6             # shorter shots merge into the previous one
# the change waits for the next cut after the target, which adds ~1.2 s: targets sit
# below the measured medians (A 3.7, W 3.1, B 2.7 s) so the RESULT lands on them
TARGET_SHOT_S = {"A": 2.6, "W": 2.1, "B": 1.7}
ORDER = ["A", "B", "A", "W", "B", "A", "B", "W"]   # A↔B most, W as the third angle


def crop_filter(key, width, height):
    """ffmpeg crop for a framing of a width×height source (even sizes)."""
    f = FRAMINGS[key]
    if f["scale"] == 1.0:
        return None
    w = int(width / f["scale"]) // 2 * 2
    h = int(height / f["scale"]) // 2 * 2
    x = int(min(max(0, f["cx"] * width - w / 2), width - w)) // 2 * 2
    y = int(min(max(0, f["top"] * height), height - h)) // 2 * 2
    return f"crop={w}:{h}:{x}:{y}"


def assign(video, events, fps):
    """A framing per piece (written as piece["framing"]). Shots = runs of pieces between
    framing changes; a change happens only at a piece boundary, once the current shot has
    run its target length; shots under a graphic are A."""
    pieces = video["pieces"]
    busy = [(e["t0"] - 0.1, e["t1"] + 0.1) for e in events]

    def under_graphic(a, b):
        return any(a < y and b > x for x, y in busy)

    cur, shot_start, i_order = "A", 0.0, 0
    out = []
    for p in pieces:
        a = p["out_frame"] / fps
        b = a + p["frames"] / fps
        g = under_graphic(a, b)
        # under a graphic only A and W keep the face clear of the shirt zone (W = 1.15×
        # still ends the face above y≈0.47); B (1.35×) only between graphics
        # a NEW close-up must also survive its first MIN_SHOT_S before a graphic lands
        # (else it is forced out as a 0.4 s stub)
        allowed = ("A", "W") if g or under_graphic(a, a + MIN_SHOT_S) else ("A", "B", "W")
        if cur == "B" and not g:
            allowed = ("A", "B", "W")
        want = cur
        if cur not in allowed:
            want = "A"
        elif a - shot_start >= TARGET_SHOT_S[cur]:
            for _ in range(len(ORDER)):
                i_order = (i_order + 1) % len(ORDER)
                if ORDER[i_order] != cur and ORDER[i_order] in allowed:
                    want = ORDER[i_order]
                    break
        forced = cur not in allowed
        if want != cur:
            # never leave a stub shorter than MIN_SHOT_S behind — except that a graphic
            # always gets a framing that keeps it off the face
            if a - shot_start < MIN_SHOT_S and out and not forced:
                want = cur
            else:
                cur, shot_start = want, a
        out.append(cur)
    for p, f in zip(pieces, out):
        p["framing"] = f
    return out
