"""Screencast camera: events.json (record.mjs) → a zoom/pan path → rendered clip.

Runs inside the aieditor-screencast image (numpy + cv2 + ffmpeg):
    python3 camera.py <recdir> <out.mp4> [--size 3840x2160] [--from S --to S] [--fps F] [--words words.json]

--words (or <recdir>/words.json): the narration words on the CLIP clock ({word, start, end}) — a camera
target whose text is spoken in its clause is timed from that word (gap list G5 step 2).

The camera is a list of KEYS (frame, zoom, cx, cy) in capture pixels; between keys it
eases with the measured curve. Motion constants come from motion/keyframes.json
["screencast"] (reference 2, kwysV2smgfY) when present, else the DEFAULTS below.
Design (cursor sprite, highlight colour) is STYLE, kept apart from motion like the
rest of the motion library (Jake: "save mostly the animation keyframes").
"""
import json
import math
import re
import subprocess
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError:          # the planner (plan_moves) is pure python; the render needs the screencast image
    cv2 = np = None

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    # reference 2 (kwysV2smgfY) screen camera — kwys-screencast.json, 29.97 fps frames.
    # The SYSTEM values (motion/screencast_system.json ["camera"], SYSTEM.md) override these.
    "zoom_in_ease": [0.31, 0.10, 0.22, 1.0],      # on LOG zoom, rms 0.001–0.004 (15/17)
    "zoom_in_frames": 43, "zoom_in_frames_big": 56, "big_zoom": 1.45,
    "zoom_out_ease": [0.345, 0.0, 0.33, 0.91], "zoom_out_frames": 50,
    # zoom-in levels: reference median 1.37 (IQR 1.31–1.46), > 1.6 in 1 of 22 moves (a table row)
    "zoom_min": 1.25, "zoom_max": 1.45, "zoom_cap": 1.65, "zoom_deep": 1.65,   # F3: nothing past ×1.65
    "entry_zoom": 1.36, "entry_delay_frames": 1.5, "entry_frames": 40,
    "fit": 0.62,                  # the target fills at most this much of the view
    "readable_px": 34,            # a target already this tall on screen needs no zoom
    "lead_s": 0.6,                # the move starts this long before its event
    "hold_min_s": 3.0,            # never re-frame sooner (reference holds: median 13.7 s, p25 6.6 s, 2 of 27 < 1.5 s)
    "moves_per_min_max": 6.0,     # rolling 60 s move budget (reference 3.1–4.1 moves / min of screencast)
    "cluster_s": 6.0,             # one framing covers the targets of the next few seconds when it can
    "idle_out_s": 14.0,           # no target for this long → zoom back out
    "nav_resets": True,           # a page change is a hard cut back to the full frame
    "nav_click_window_s": 2.5,    # a click followed by a page change this soon is a NAVIGATION click: not a zoom target
    "blank_std": 7.0, "blank_content": 0.025,     # a loading/blank source frame → hold the last good frame
    "cursor_smooth_s": 0.0,       # the reference cursor is native, unsmoothed
    "cursor_scale": 1.0,
    # yellow marker wipe (kwys-annotations-layouts.json)
    "hl_ease": [0.264, 0.139, 0.361, 0.897], "hl_lead_frames": 2.0,
    "hl_dur": [13.3, 0.071, 18, 35],              # clamp(13.3 + 0.071·width_px@1080p, 18, 35)
    "hl_out_ease": [0.358, -0.04, 0.287, 0.854], "hl_out_frames": 19.5,
    "hl_height": 0.74, "hl_pad_px": 3,
    # facecam: hide while the target is under the bubble (top-right of the OUTPUT frame)
    "bubble_zone": [1480 / 1920, 0, 1.0, 470 / 1080],
    "empty_min": 0.03,            # a read/hover framing with less non-background than this is skipped
    # reference 2 zooms out before a scroll (SYSTEM.md §3) — but out-then-in again on a target
    # right after it cost 2 of v9's 13 moves. When a target follows within this many seconds,
    # the page scrolls under the held framing and ONE move goes to that target. (v10)
    "scroll_direct_s": 3.0,
    # ── refs 2–5 (2026-10-07, SYSTEM.md §3b/§3c, reference-specs/sc4-*.json) ──
    # MOVES INSIDE A ZOOM: when the camera is zoomed and the next target wants about the same
    # zoom, it PANS there at constant zoom (refs: zoom ratio 0.95–1.01 across a pan) instead of
    # pulling out and pushing back in. Curve = the per-ref median free fit (ref 2 .331/.031/.275/.96,
    # ref 3 .329/.007/.262/1.0, ref 4 .355/−.053/.298/.943, ref 5 .328/.032/.26/.929);
    # D (ref frames) ≈ 24 + 0.035·distance(output px @1080p), refs median 32–38 f.
    "pan_ease": [0.33, 0.02, 0.27, 0.96],
    "pan_frames_base": 24.0, "pan_frames_per_px": 0.035, "pan_frames_minmax": [26, 56],
    "pan_zoom_tol": 1.15,         # a framing within ×/÷ this of the held zoom keeps the zoom and pans
    "pan_max_screen": 0.55,       # farther than this (share of the output width) → a normal move
    # SCREEN-TO-SCREEN DISSOLVE: a change of WORLD (goto another page/app, a skipped generation or
    # submit = time skip) is a linear opacity dissolve, the framing HELD through it; then the camera
    # zooms out / moves on. Refs: 3–8 f, medians 3 (ref 2), 6 (ref 3), 5 (ref 4), 4 (ref 5).
    # Same-page state changes and click navigations inside one app stay HARD cuts.
    "xfade_frames": 5,
    "xfade_kinds": ["nav", "wait", "enter"],
    "xfade_target_s": 3.0,        # a target this soon after a dissolve: go straight to it (no out-and-in)
    "xfade_same_site": False,     # G5 step 8 (T1/T2): a same-app goto/reload is a 1 f hard cut with the zoom carried
                                  # — a goto the agent marks "cut": true is a hard cut (Jake #7: landing → CUT to the pricing card)
    # ── Jake's review of v11 (2026-10-07, SYSTEM.md §0) ──
    # #1 every move ENDS with the subject CENTRE-MIDDLE: centre on the target, clamp only where the
    # page ends. The old "frame left of / below the facecam" shift (avoid_bubble/clear_bubble) is OFF:
    # the bubble never moves and the subject is never pushed aside for it.
    "avoid_bubble": False,
    "overscan_max": 0.25,         # max share of the view past a FLAT canvas edge (centre a design at the edge)
    # #2 constant motion: refs 2–5 camera-static holds (no move, no cut, no dissolve) p50 1.0 s,
    # p75 3.07 s, p90 6.04 s, p95 8.9 s (854 holds, sc4 measure 2026-10-07). A hold that would run
    # past hold_max_s gets a slow drift (a centred push, or a pull-back when already deep) starting
    # hold_target_s after the last motion — Jake's "move → hold ~3 s → pan → move".
    "hold_target_s": 3.0, "hold_max_s": 6.0,
    "drift_frames": 54, "drift_zoom": 1.08, "drift_ease": [0.33, 0.02, 0.27, 0.96],
    # #11 a zoom starts ON the word that names the target (not lead_s before it); the entry push-in
    # only heads for a target named in the first entry_target_s, else it is a centred push
    "word_lead_s": 0.8, "entry_target_s": 1.0,   # G5 step 2 / M1: moves start 0.5–0.9 s before the word (REF)
    # #10 typing a prompt is shown zoomed OUT (no zoom-in on a type target; a held zoom opens out)
    "type_zoom": False,
    "nav_click_zoom": True, "nav_click_frames": 24,   # a click that navigates gets a quick zoom landing on the press
    # bubble (Jake 2026-10-07): exact position + size on every screencast frame; it fades out
    # (7 f) ONLY while a click / type / drag acts on something under it, and back in (11 f) after
    "bubble_hide_actions": ["click", "dblclick", "type", "drag", "select"],
    "push_ease": [0.25, 0.25, 0.75, 0.75],        # M5 / ZM10 slow centred push (gap filler)
}
STYLE = {
    "highlight_rgba": (255, 214, 10, 0.42),       # reads #99831C on blue, text #F7F26C — multiply-like
    "cursor": "arrow",
}
REF_FPS = 30000 / 1001


def params():
    p = dict(DEFAULTS)
    for src in (HERE.parent / "motion" / "keyframes.json", HERE.parent / "motion" / "screencast_system.json"):
        try:
            d = json.loads(src.read_text())
            sc = (d.get("screencast") or {}).get("camera", {}) if "screencast" in d else d.get("camera", {})
            p.update({k: v for k, v in sc.items() if k in DEFAULTS})
        except Exception:  # noqa: BLE001
            pass
    return p


# ── easing ───────────────────────────────────────────────────────────────────
def make_eases(p):
    """in / out (zoom) and pan curves — one dict for the render and qa.py."""
    return {"in": bezier(*p["zoom_in_ease"]), "out": bezier(*p["zoom_out_ease"]), "release": bezier(*p["zoom_out_ease"]), "pan": bezier(*p["pan_ease"]),
            "drift": bezier(*p.get("drift_ease", p["pan_ease"])),
            # M5 / ZM10 gap-filler push (camera.json files from before G5 name it "drift"/"release")
            "push": bezier(*p.get("push_ease", [0.25, 0.25, 0.75, 0.75])),
            # TECHNIQUES TR07 opening punch-out: 1.55 → 1.0 over ~31 f, strong ease-out (kwys C1)
            "open": bezier(*p.get("open_ease", [0.089, 0.443, 0.126, 0.834]))}


def bezier(p1x, p1y, p2x, p2y):
    def f(x):
        if x <= 0:
            return 0.0
        if x >= 1:
            return 1.0
        lo, hi = 0.0, 1.0
        for _ in range(40):
            u = (lo + hi) / 2
            bx = 3 * (1 - u) ** 2 * u * p1x + 3 * (1 - u) * u * u * p2x + u ** 3
            lo, hi = (u, hi) if bx < x else (lo, u)
        u = (lo + hi) / 2
        return 3 * (1 - u) ** 2 * u * p1y + 3 * (1 - u) * u * u * p2y + u ** 3
    return f


# ── sync ─────────────────────────────────────────────────────────────────────
def marker_frame(raw, w, h):
    """First frame after the white→black marker (record.mjs) = event time 0."""
    cmd = ["ffmpeg", "-v", "error", "-i", str(raw), "-t", "6", "-vf", "scale=64:36", "-f", "rawvideo",
           "-pix_fmt", "gray", "-"]
    buf = subprocess.run(cmd, capture_output=True, check=True).stdout
    fr = np.frombuffer(buf, np.uint8).reshape(-1, 36, 64).mean(axis=(1, 2))
    seen_white = False
    for i, v in enumerate(fr):
        if v > 200:
            seen_white = True
        elif seen_white and v < 40:
            return i
    raise RuntimeError("sync marker not found in the first 6 s")


# ── planning ─────────────────────────────────────────────────────────────────
def clamp(z, cx, cy, W, H, room=None):
    """Keep the view inside the capture. `room` = (left, right, top, bottom) shares of the VIEW
    the camera may run past that edge (overscan onto flat canvas background, Jake #1)."""
    hw, hh = W / z / 2, H / z / 2
    l, r, t, b = room or (0, 0, 0, 0)
    return z, min(max(cx, hw - 2 * hw * l), W - hw + 2 * hw * r), min(max(cy, hh - 2 * hh * t), H - hh + 2 * hh * b)


def overscan_of(view, W, H):
    """(left, right, top, bottom) share of the view that lies past each capture edge."""
    z, cx, cy = view
    vw, vh = W / z, H / z
    return (max(0.0, (vw / 2 - cx) / vw), max(0.0, (cx + vw / 2 - W) / vw),
            max(0.0, (vh / 2 - cy) / vh), max(0.0, (cy + vh / 2 - H) / vh))


def edge_room(sm, p):
    """Jake #1 (subject centre-middle) against a design sitting at the canvas edge: the camera may
    run past an edge whose outer band is FLAT background (a design canvas), filled with that
    colour, by up to overscan_max of the view. Never past real UI (a sidebar, a header)."""
    mx = p.get("overscan_max", 0)
    if sm is None or not mx:
        return None
    h, w = sm.shape[:2]
    bw, bh = max(2, int(w * 0.04)), max(2, int(h * 0.04))
    out = []
    for band in (sm[:, :bw], sm[:, w - bw:], sm[:bh, :], sm[h - bh:, :]):
        q = band.reshape(-1, 3).astype(int)
        med = np.median(q, axis=0)
        flat = (np.abs(q - med).max(axis=1) <= 10).mean() >= 0.97
        out.append(mx if flat else 0.0)
    return tuple(out)


def framing_for(box, W, H, p, deep=False, room=None):
    """(zoom, cx, cy) for a target: the reference's levels (1.25–1.5, 1.6 cap; 2.0 only for a
    small detail the narration reads out = `deep`), centred on it, clamped into the frame."""
    x, y, bw, bh = box
    # a POINT target (the agent framed a spot on a canvas) means "this design here", not a
    # 2-px box to zoom to the 2× cap: give it a design-sized area around the point
    mw, mh = W * 0.24, H * 0.30
    if bw < mw and bh < mh and bw * bh < 400:
        x, y, bw, bh = x + bw / 2 - mw / 2, y + bh / 2 - mh / 2, mw, mh
    cap = p["zoom_deep"] if deep else p["zoom_cap"]
    z = min(cap, p["fit"] * W / max(bw, 1), p["fit"] * H / max(bh, 1))
    if z < p["zoom_min"] * 0.9:
        # a target this big (a whole section / the page) is not a zoom target: full frame
        return (1.0, W / 2, H / 2)
    # the v5 defect: every small target went straight to the 2.0 cap (69 % of zoom-ins);
    # the reference sits at 1.31–1.46 and goes past 1.6 once in 11 minutes
    z = min(max(z, p["zoom_min"]), cap if deep else p["zoom_max"])
    return clamp(z, x + bw / 2, y + bh / 2, W, H, room)


def union(boxes):
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    return [x0, y0, x1 - x0, y1 - y0]


def avoid_bubble(view, box, W, H, p):
    """Keep the target out from under the facecam (top-right): shift the view right/up so
    the target's on-screen box ends left of / below the bubble zone, when the frame allows."""
    z, cx, cy = view
    vw, vh = W / z, H / z
    x, y, bw, bh = box
    zx0, zy0, zx1, zy1 = p["bubble_zone"]
    sx1 = (x + bw - (cx - vw / 2)) / vw          # target right edge on screen (0..1)
    sy0 = (y - (cy - vh / 2)) / vh               # target top on screen
    if sx1 <= zx0 - 0.01 or sy0 >= zy1:
        return view
    # move the view right so the right edge lands just left of the zone
    need = (sx1 - (zx0 - 0.02)) * vw
    z2, cx2, cy2 = clamp(z, cx + need, cy, W, H)
    if (x + bw - (cx2 - vw / 2)) / vw <= zx0:
        return (z2, cx2, cy2)
    return view


BUBBLE_DISC = (1701.9 / 1920, 253.7 / 1080, 179.3 / 1920)     # facecam centre + outer radius (output 0..1, r in widths)
_DISC_PTS = None


def _bg(sm):
    """The frame's flat background colour (None if it has none) — cached per frame."""
    if _BG_CACHE.get("ref") is sm:
        return _BG_CACHE["v"]
    q = (sm[::2, ::2] // 8).reshape(-1, 3)
    vals, cnt = np.unique(q, axis=0, return_counts=True)
    v = None if cnt.max() < 0.3 * len(q) else vals[cnt.argmax()].astype(int) * 8 + 4
    _BG_CACHE.update(ref=sm, v=v)
    return v


_BG_CACHE = {}


def bubble_cover(sm, view, W, H):
    """Share of the facecam disc that sits on page CONTENT (not the flat background) for this
    view — what the bubble would hide. None when the frame has no flat background."""
    global _DISC_PTS
    if _DISC_PTS is None:
        cxu, cyu, r = BUBBLE_DISC
        g = np.linspace(-1, 1, 17)
        pts = [(cxu + r * a, cyu + r * b * 16 / 9) for a in g for b in g if a * a + b * b <= 1]
        _DISC_PTS = np.array(pts)
    bg = _bg(sm)
    if bg is None:
        return None
    z, cx, cy = view
    s = sm.shape[1] / W
    xs = ((cx - W / z / 2) + _DISC_PTS[:, 0] * W / z) * s
    ys = ((cy - H / z / 2) + _DISC_PTS[:, 1] * H / z) * s
    xi = np.clip(xs.astype(int), 0, sm.shape[1] - 1)
    yi = np.clip(ys.astype(int), 0, sm.shape[0] - 1)
    px = sm[yi, xi].astype(int)
    return float((np.abs(px - bg).max(axis=1) > 8).mean())


def edge_cut(sm, view, W, H):
    """Share of the view's left/right edges that runs through content (a title cut in half by
    the frame edge is as bad as one under the bubble)."""
    bg = _bg(sm)
    if bg is None:
        return 0.0
    z, cx, cy = view
    s = sm.shape[1] / W
    v = np.linspace(0.02, 0.98, 40)
    hits = []
    for u in (0.004, 0.996):
        xs = np.full_like(v, ((cx - W / z / 2) + u * W / z) * s)
        ys = ((cy - H / z / 2) + v * H / z) * s
        xi = np.clip(xs.astype(int), 0, sm.shape[1] - 1)
        yi = np.clip(ys.astype(int), 0, sm.shape[0] - 1)
        hits.append((np.abs(sm[yi, xi].astype(int) - bg).max(axis=1) > 8).mean())
    return float(sum(hits) / 2)


def clear_bubble(view, box, sm, W, H, p):
    """Reference 2 keeps what he talks about clear of the facecam: the bubble only fades when the
    ACTION target is top-right; otherwise the subject is framed left of / below it. v9 (1:10): a
    zoom on the brand kit's Logo tile left the page's big "Jake Dawson" title running under the
    bubble. Search nearby framings (pan ±30 %, zoom ±8 %) that keep the target fully in view and
    out of the bubble zone, and take the one whose bubble covers the least content."""
    z, cx, cy = view
    if sm is None or z <= 1.01:
        return view
    base = bubble_cover(sm, view, W, H)
    if base is None or base < 0.08:
        return view
    x, y, bw, bh = box
    zx0, zy0, zx1, zy1 = p["bubble_zone"]

    def ok(v):
        z2, cx2, cy2 = v
        vw, vh = W / z2, H / z2
        l, t = cx2 - vw / 2, cy2 - vh / 2
        m = 0.01
        if x < l + m * vw or x + bw > l + (1 - m) * vw or y < t + m * vh or y + bh > t + (1 - m) * vh:
            return False
        return (x + bw - l) / vw <= zx0 - 0.01 or (y - t) / vh >= zy1
    need_clear = ok(view)

    def cost(v):
        c = bubble_cover(sm, v, W, H)
        return None if c is None else c + 0.5 * edge_cut(sm, v, W, H)
    base_s = cost(view)
    best, best_s = view, base_s
    vw, vh = W / z, H / z
    for zf in (1.0, 0.93, 1.08):
        z2 = min(max(z * zf, p["zoom_min"] * 0.98), max(z, p["zoom_max"]))
        for dx in np.linspace(-0.3, 0.3, 13):
            for dy in np.linspace(-0.35, 0.35, 15):
                v2 = clamp(z2, cx + dx * vw, cy + dy * vh, W, H)
                if need_clear and not ok(v2):
                    continue
                c = cost(v2)
                if c is None:
                    continue
                sc = c + 0.2 * (abs(v2[1] - cx) / vw + abs(v2[2] - cy) / vh) + 0.3 * abs(math.log(z2 / z))
                if sc < best_s:
                    best, best_s = v2, sc
    return best if best != view and best_s <= base_s - 0.05 else view


def in_view(box, view, W, H, out_h, p, readable=True):
    """The target is inside the current view (and, with `readable`, already readable on screen)."""
    z, cx, cy = view
    vw, vh = W / z, H / z
    x, y, bw, bh = box
    inside = x >= cx - vw / 2 and x + bw <= cx + vw / 2 and y >= cy - vh / 2 and y + bh <= cy + vh / 2
    if not readable:
        return inside
    return inside and bh * z * out_h / H >= p["readable_px"] * out_h / 1080 and z > 1.05


def framed(box, view, W, H, p, tol=0.12, room=None):
    """The target is already THE SUBJECT of this view: fully inside it, its centre within `tol` of
    the frame centre (or as close as the page edge allows), and the view about as zoomed as the
    target asks for. Merely "somewhere in view" is not enough any more (Jake #1: centre-middle)."""
    if not in_view(box, view, W, H, 1080, p, readable=False):
        return False
    want = framing_for(box, W, H, p)
    if want[0] > view[0] * 1.05:
        return False
    z, cx, cy = view
    ideal = clamp(z, box[0] + box[2] / 2, box[1] + box[3] / 2, W, H, room)
    return abs(ideal[1] - cx) * z / W <= tol and abs(ideal[2] - cy) * z / H <= tol


def content_fraction(img, view, W, H):
    """Share of the view (z, cx, cy) that is not the page's flat background — a zoom onto
    bare canvas between designs is a wasted move. None when the frame has no flat background."""
    sw = 640
    sm = cv2.medianBlur(cv2.resize(img, (sw, round(H * sw / W)), interpolation=cv2.INTER_AREA), 5)   # dot grids go
    q = (sm // 8).reshape(-1, 3)
    vals, cnt = np.unique(q, axis=0, return_counts=True)
    if cnt.max() < 0.3 * len(q):
        return None
    bg = vals[cnt.argmax()].astype(int) * 8 + 4
    z, cx, cy = view
    s = sw / W
    x0, x1 = int((cx - W / z / 2) * s), int((cx + W / z / 2) * s)
    y0, y1 = int((cy - H / z / 2) * s), int((cy + H / z / 2) * s)
    roi = sm[max(y0, 0):y1, max(x0, 0):x1].astype(int)
    if roi.size == 0:
        return None
    return float((np.abs(roi - bg).max(axis=2) > 8).mean())


def drop_empty_targets(ev, raw, f0, fps, p):
    """Mark read/hover/move targets whose framing would show (almost) only background:
    the agent picked a spot on a zoomed-out canvas that missed the design."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    cand = [e for e in ev["events"] if e.get("box") and e["type"] in ("read", "hover", "move", "click", "type", "highlight")]
    if not cand:
        return []
    cap = cv2.VideoCapture(str(raw))
    dropped = []
    for e in cand:
        # the screen while the target is held (a click: just before it acts — after it the page may change)
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(f0 + (e["t"] if e["type"] == "click" else e.get("end", e["t"])) * fps) - 1))
        ok, img = cap.read()
        if not ok:
            continue
        # kept small for the bubble-clearance search (plan_moves) — never written to camera.json
        e["_sm"] = cv2.medianBlur(cv2.resize(img, (640, round(H * 640 / W)), interpolation=cv2.INTER_AREA), 5)
        if e["type"] not in ("read", "hover", "move") or e.get("beat"):
            # (a scripted word-timed beat names its own target — a sparse form page (New Brand: a white
            # page with one field) measured "empty" and the opening framing was dropped, round 1 seg 2)
            continue
        frac = content_fraction(img, framing_for(e["box"], W, H, p), W, H)
        if frac is not None and frac < p["empty_min"]:
            e["empty"] = True
            dropped.append(round(e["t"], 2))
    cap.release()
    return dropped


def first_frame_facts(ev, raw, f0, p):
    """The span's first screen: its content centroid (edge-weighted, bubble zone masked) and its
    flat-edge room — the centred entry push centres the VISUAL MASS (Jake #1: v12b 0:00 pushed on
    the geometric centre while the big boards sat left of it)."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    cap = cv2.VideoCapture(str(raw))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(f0) + 1))
    ok, img = cap.read()
    cap.release()
    if not ok:
        return
    sm = cv2.medianBlur(cv2.resize(img, (640, round(H * 640 / W)), interpolation=cv2.INTER_AREA), 5)
    g = cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY).astype(np.float32)
    e = np.abs(np.diff(g, axis=1))[:-1, :] + np.abs(np.diff(g, axis=0))[:, :-1]
    hh, ww = e.shape
    zx0, zy0, zx1, zy1 = p["bubble_zone"]
    e[: int(zy1 * hh), int(zx0 * ww):] = 0
    e[e < 12] = 0
    if e.sum() < 50:
        return
    Y, X = np.mgrid[0:hh, 0:ww]
    ev["_centroid"] = (float((e * X).sum() / e.sum()) * W / 640, float((e * Y).sum() / e.sum()) * W / 640)
    ev["_room"] = edge_room(sm, p)


def page_changes(ev):
    """Clip seconds where the screen became a different page: navigations and the recorder's
    settle cuts (a click whose result loaded off camera = a jump cut, like the reference's)."""
    navs = [e["t"] for e in ev["events"] if e["type"] == "nav"]
    out = []
    for e in ev["events"]:
        if e["t"] <= 0.05:
            continue
        if e["type"] == "nav":
            out.append(e["t"])
        elif e["type"] == "cut" and e.get("big", True):
            # ROUND 3 (review N02): a canvas re-centring cut logged within 0.25 s after a goto is part of that
            # goto's dissolve — counted separately it hid the beat from the dissolve and the camera released
            if e.get("why") in ("late beat", "keys") and any(0 <= e["t"] - n <= 0.25 for n in navs):
                continue
            out.append(e["t"])
    return sorted(out)


def _site(url):
    host = str(url or "").split("//")[-1].split("/")[0].lower()
    return ".".join(host.split(".")[-2:])


def xfade_cues(ev, p):
    """{t: kind} of the screen changes that DISSOLVE (refs 2–5, SYSTEM.md §3b): a goto to ANOTHER
    site (a change of world), a skipped wait (a generation finishing = a time skip) and a
    submit with Enter whose result was cut to. Click navigations, same-page state changes and (Jake
    #7) a goto inside the same site stay hard cuts (the refs' jump cuts)."""
    kinds = set(p.get("xfade_kinds") or [])
    out = {}
    site = _site(ev.get("url"))
    for e in ev["events"]:
        if e["type"] == "nav":
            prev, site = site, _site(e.get("url")) or site
            if e.get("cut") and not e.get("fade"):
                continue                          # the agent asked for a hard cut (Jake #7)
            if not p.get("xfade_same_site", True) and prev and prev == site and not e.get("fade"):
                continue                          # same site = a hard cut, unless the agent asked to fade (Jake #10)
        if e["t"] <= 0.05:
            continue
        if e["type"] == "nav" and "nav" in kinds:
            out[round(e["t"], 4)] = "nav"
        elif e["type"] == "wait" and e.get("found", True) and "wait" in kinds:
            out[round(e["t"], 4)] = "wait"
        elif e["type"] == "cut" and e.get("why") == "enter" and "enter" in kinds:
            out[round(e["t"], 4)] = "enter"
    return out


def _nav_url(ev, t):
    return next((e.get("url") for e in ev["events"] if e["type"] == "nav" and abs(e["t"] - t) < 1e-3), "")


def pan_frames(dist_px_1080, p):
    lo, hi = p["pan_frames_minmax"]
    return min(max(p["pan_frames_base"] + p["pan_frames_per_px"] * dist_px_1080, lo), hi)


# ── the reference camera (gap list G5, RULEBOOK §2–§6) ─────────────────────────────────────────
# Targeted, eased moves timed from the words; no pumping (the old untargeted drift/release loop is
# gone); typing at ×1.00; the subject is the CONTAINER, centred; cuts only where the page changes.
# TODO(p2): read these numbers from the skill's rules.json through aieditor/skill.py once p2 merges;
# until then they live here with the same values (RULEBOOK §2 F1–F4, §3 M1–M7, §4 P1–P2, §5 T1–T8, §6 B2).
REF = {
    "in_frames": (34, 48), "deep_in_frames": (34, 58), "deep_zoom": 1.45,   # M1 (ZM01–ZM08), ZM02 deep 45–58
    "out_frames": (34, 40), "out_ratio": (0.76, 0.90),                      # M3 (ZM11)
    # a word-timed move has at most 0.9 + 0.3 s = 36 f between its start and its landing (M1), so the
    # nominal in-move is 35 f and a deep zoom shortens to fit (never below 34 f; below that it is M6)
    "in_nominal_f": 35, "deep_nominal_f": 45, "out_nominal_f": 36,
    "word_lead_s": (0.5, 0.9), "land_after_word_s": 0.30,                   # M1 timing vs the naming word
    "bands": {"control": (1.50, 1.65), "row": (1.40, 1.43),                 # F3 by target class
              "text": (1.30, 1.35), "result": (1.19, 1.30)},
    "zoom_cap": 1.65,                                                       # F3: nothing past ×1.65
    "min_target_px": 120,                                                   # F2: smaller → its container
    "point_px": 8,                                                          # a cursor point is never a target
    "centre_tol": (0.06, 0.08),                                             # F1 (share of W, of H)
    "black_max": 0.05,                                                      # F4: ≤ 5 % black / off-page
    "push_zoom": 1.12, "push_band": (1.06, 1.26), "push_frames": 40,        # M5 / ZM10 gap filler (24–46 f)
    "hold_max_s": 3.0, "push_after_s": 1.3,                                 # P1: one push in a hold > 3 s
    "flash_f": 6,                                                           # T8: no cut/flash shorter than 6 f
    "lead_skip_s": 0.5,                                                     # ≤ 1 transition in a span's first 0.5 s
    "end_still_s": 0.3, "end_tail_s": 0.2,                                  # spans end still zoomed (T5/CUT04)
    "bubble_margin_px": 24,                                                 # B2: disc + 24 px margin
    "events_per_min": (17, 25, 30),                                         # P2 (refs 17–25, Jake cap 30)
}
DISC_1080 = (1701.9, 253.7, 179.3)                                          # B1: centre + outer radius, output px
STOP = {"the", "and", "for", "you", "your", "this", "that", "with", "from", "into", "are", "was", "its", "it's",
        "click", "open", "here", "there", "then", "just", "now", "let", "lets", "see", "look", "all", "one", "out"}


def _toks(s):
    return [t for t in re.findall(r"[a-z0-9]+", str(s or "").lower()) if len(t) >= 3 and t not in STOP]


def _stem(t):
    return t[:-1] if len(t) > 3 and t.endswith("s") else t


def clauses(words):
    """[(t0, t1)] spoken clauses: split after , . ! ? ; : or a pause ≥ 0.25 s (the 'from' of M1)."""
    out, start = [], None
    for k, w in enumerate(words):
        s, e = float(w["start"]), float(w["end"])
        if start is None:
            start = s
        nxt = words[k + 1] if k + 1 < len(words) else None
        if nxt is None or str(w["word"]).rstrip().endswith((",", ".", "!", "?", ";", ":")) or float(nxt["start"]) - e >= 0.25:
            out.append((start, e))
            start = None
    return out


def target_label(e):
    if e.get("label"):
        return e["label"]
    if e["type"] == "type":
        return e.get("text", "")
    return e.get("text") or str(e.get("vis", "")).split("|")[0]


def word_match(e, words, cl=None):
    """(word, clause_start) when the event's target text is SPOKEN in its clause (G5 step 2), else None.
    The anchor is the agent's requested word time (at), else the press, else the event."""
    if not words:
        return None
    toks = {_stem(t) for t in _toks(target_label(e))}
    if not toks:
        return None
    anchor = e.get("at") if e.get("at") is not None else e.get("press", e["t"])
    best = None
    for w in words:
        if abs(float(w["start"]) - anchor) > 3.0:
            continue
        if any(_stem(t) in toks for t in _toks(w["word"])):
            if best is None or abs(float(w["start"]) - anchor) < abs(float(best["start"]) - anchor):
                best = w
    if best is None:
        return None
    cl = cl if cl is not None else clauses(words)
    c0 = next((a for a, b in cl if a - 1e-6 <= float(best["start"]) <= b + 1e-6), float(best["start"]))
    return best, c0


def is_point(box, p=REF):
    return box is not None and max(box[2], box[3]) <= p["point_px"]


def _component_box(box, sm, W, H):
    """The container around a small box in the frame (640 px wide): the connected region of page
    CONTENT (not the flat background) that holds it, after closing small gaps."""
    if sm is None or cv2 is None:
        return None
    bg = _bg(sm)
    if bg is None:
        return None
    s = sm.shape[1] / W
    mask = (np.abs(sm.astype(int) - bg).max(axis=2) > 8).astype(np.uint8)
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    x, y, bw, bh = box
    x0, y0 = int(max(0, x * s)), int(max(0, y * s))
    x1, y1 = int(min(sm.shape[1] - 1, (x + bw) * s)), int(min(sm.shape[0] - 1, (y + bh) * s))
    roi = lab[y0:y1 + 1, x0:x1 + 1].ravel()
    roi = roi[roi > 0]
    if roi.size == 0:
        return None
    k = np.bincount(roi).argmax()
    cx, cy, cw, ch, _ = stats[k]
    return [cx / s, cy / s, cw / s, ch / s]


def container(box, sm, W, H, p=REF):
    """RULEBOOK F2: the subject is the CONTAINER being talked about — a box under min_target_px grows to
    the content region that holds it (message box, toolbar row, image, grid); without a frame, to a
    neighbourhood of min_target_px rows around the control."""
    mp = p["min_target_px"]
    c = _component_box(box, sm, W, H)
    if c and max(c[2], c[3]) >= mp and c[2] <= 0.8 * W and c[3] <= 0.8 * H and c[2] * c[3] <= 0.35 * W * H \
            and c[0] <= box[0] + 1 and c[1] <= box[1] + 1 and c[0] + c[2] >= box[0] + box[2] - 1 and c[1] + c[3] >= box[1] + box[3] - 1:
        return [round(v, 1) for v in c]
    x, y, bw, bh = box
    nw, nh = max(bw, 2 * mp), max(bh, mp)
    nx = min(max(0.0, x + bw / 2 - nw / 2), W - nw)
    ny = min(max(0.0, y + bh / 2 - nh / 2), H - nh)
    return [round(nx, 1), round(ny, 1), round(nw, 1), round(nh, 1)]


def camera_box(e, W, H, p=None):
    """The box the camera frames for an event, or None when it is not a camera target. A compiled beat's
    target_box (p7) wins; otherwise the ACTED element (abox). Reads, hovers and cursor moves never move
    the camera (G5 step 4) — only compiled beats name what to frame."""
    if e.get("empty"):
        return None
    if e.get("target_box"):
        b = list(e["target_box"])
    elif e["type"] in ("click", "dblclick", "highlight", "drag", "select"):
        b = list(e.get("abox") or e.get("box") or []) or None
    else:
        return None
    if not b or is_point(b):
        return None
    if max(b[2], b[3]) < REF["min_target_px"]:
        b = container(b, e.get("_sm"), W, H)
    return b


def classify(box, W, H):
    """F3 target classes: 'result' (card/design/result/panel), 'text' (text block or input), 'row'
    (toolbar/list row), 'control' (one small control)."""
    fw, fh = box[2] / W, box[3] / H
    if fh >= 0.25 or (fw >= 0.35 and fh >= 0.15):
        return "result"
    if fw >= 0.25 and fh >= 0.045:
        return "text"
    if box[2] >= 3 * box[3]:
        return "row"
    return "control"


def black_share(sm, view, W, H):
    """Share of the view that lies off the captured page (F4: the black void a clamp-free framing or an
    overscan leaves). A dark-theme page is page, not void, so only the geometry counts (`sm` unused)."""
    z, cx, cy = view
    vw, vh = W / z, H / z
    x0, y0 = cx - vw / 2, cy - vh / 2
    inside = max(0.0, min(W, x0 + vw) - max(0.0, x0)) * max(0.0, min(H, y0 + vh) - max(0.0, y0))
    return max(0.0, 1 - inside / (vw * vh))


def disc_gap(box, view, W, H):
    """Output-px distance (1080p) from the facecam disc centre to the box's nearest point, minus the
    disc radius: ≤ 0 means the box sits under the bubble."""
    z, cx, cy = view
    cw, ch = W / z, H / z
    X0, X1 = (box[0] - (cx - cw / 2)) / cw * 1920, (box[0] + box[2] - (cx - cw / 2)) / cw * 1920
    Y0, Y1 = (box[1] - (cy - ch / 2)) / ch * 1080, (box[1] + box[3] - (cy - ch / 2)) / ch * 1080
    qx, qy = min(max(DISC_1080[0], X0), X1), min(max(DISC_1080[1], Y0), Y1)
    return math.hypot(qx - DISC_1080[0], qy - DISC_1080[1]) - DISC_1080[2]


def landing_offset(box, view, W, H):
    """(dx share of W, dy share of H) of the subject centre from the frame centre after a move (F1)."""
    z, cx, cy = view
    return abs(box[0] + box[2] / 2 - cx) * z / W, abs(box[1] + box[3] / 2 - cy) * z / H


def edge_limited(box, view, W, H, tol=None):
    """F1's 'as close as the page edge allows': the subject is off-centre only because the view already
    sits against the capture edge on that side (a centred view would show more than the F4 budget off-page)."""
    tol = tol or REF["centre_tol"]
    z, cx, cy = view
    hw, hh = W / z / 2, H / z / 2
    bx, by = box[0] + box[2] / 2, box[1] + box[3] / 2
    dx, dy = landing_offset(box, view, W, H)
    okx = dx <= tol[0] + 1e-6 or (bx < cx and cx - hw <= 1.0 + REF["black_max"] * hw) or (bx > cx and cx + hw >= W - 1.0 - REF["black_max"] * hw)
    oky = dy <= tol[1] + 1e-6 or (by < cy and cy - hh <= 1.0 + REF["black_max"] * hh) or (by > cy and cy + hh >= H - 1.0 - REF["black_max"] * hh)
    return okx and oky


def touches_edge(box, W, H, m=0.03):
    """F1's one exception: the subject sits on a REAL capture edge (docked sidebar, top bar)."""
    return box[0] <= m * W or box[1] <= m * H or box[0] + box[2] >= (1 - m) * W or box[1] + box[3] >= (1 - m) * H


def _room(sm, p):
    """Overscan allowed past each capture edge: only onto a FLAT canvas edge (edge_room) and never more
    than half the F4 black budget per side, so a landing never shows more than 5 % off-page."""
    r = edge_room(sm, p) if sm is not None else None
    cap = REF["black_max"] / 2
    return tuple(min(v, cap) for v in r) if r else None


def frame_target(box, W, H, p, sm=None, zoom=None, cls=None):
    """(zoom, cx, cy) for a subject box — F3 band for its class, centred (F1) as far as the page edge
    allows (a subject near an edge takes the band's higher zoom when that centres it better), never more
    than 5 % off-page (F4), and kept clear of the bubble disc when a zoom inside the band allows it
    (G5 step 5; F5: the bubble never forces the framing past the band)."""
    full = (1.0, W / 2, H / 2)
    cls = cls or classify(box, W, H)
    lo, hi = REF["bands"][cls]
    fit = min(0.95 * W / max(box[2], 1), 0.95 * H / max(box[3], 1), REF["zoom_cap"])
    if zoom is not None:
        z = min(float(zoom), REF["zoom_cap"])
    else:
        z = min(max(p.get("fit", 0.62) * min(W / max(box[2], 1), H / max(box[3], 1)), lo), hi)
    z = min(z, fit)
    if z < REF["push_band"][0]:
        return full
    room = _room(sm, p)
    tcx, tcy = box[0] + box[2] / 2, box[1] + box[3] / 2

    def off(v):
        dx, dy = landing_offset(box, v, W, H)
        return max(dx / REF["centre_tol"][0], dy / REF["centre_tol"][1])
    view = clamp(z, tcx, tcy, W, H, room)
    if off(view) > 1 and zoom is None:
        # edge-limited: a deeper zoom inside the band brings the subject closer to the centre
        zz = z
        while zz + 0.02 <= min(hi, fit) + 1e-9 and off(view) > 1:
            zz = round(zz + 0.02, 4)
            v2 = clamp(zz, tcx, tcy, W, H, room)
            if off(v2) < off(view) - 1e-3:
                view = v2
    z = view[0]
    if disc_gap(box, view, W, H) <= 0:
        zz = z
        while zz - 0.02 >= max(lo, REF["push_band"][0]) - 1e-9:
            zz = round(zz - 0.02, 4)
            v2 = clamp(zz, tcx, tcy, W, H, room)
            if disc_gap(box, v2, W, H) > 0 and black_share(sm, v2, W, H) <= REF["black_max"]:
                return v2
    return view


def page_states(ev, p):
    """[{t, kind: 'cut'|'xfade', n}] — where the recorded picture changes state, in clip seconds. A change
    of WORLD (another site) or a TIME SKIP (a generation finishing, a submit's result) dissolves (T4);
    every same-app change — a goto/reload inside the site, a click's new state — is a 1 f hard cut with
    the zoom carried (T1/T2). Changes closer than 6 f are one change (T8), and the first lead_skip_s of
    a span shows the state after its opening changes (≤ 1 transition there: the span's own entry)."""
    xn = p.get("xfade_frames", 5)
    out, raw = [], []
    site = _site(ev.get("url"))
    for e in ev["events"]:
        kind = None
        if e["type"] == "nav":
            prev, site = site, _site(e.get("url")) or site
            kind = "xfade" if (prev and site and prev != site and not e.get("cut")) else "cut"
        elif e["type"] == "wait" and e.get("found", True):
            kind = "xfade"
        elif e["type"] == "cut":
            kind = "xfade" if e.get("why") == "enter" else "cut"
        if kind is None:
            continue
        t = float(e["t"])
        raw.append(t)
        if out and t - out[-1]["t"] < REF["flash_f"] / REF_FPS:
            if kind == "xfade":
                out[-1]["kind"] = "xfade"
            continue
        out.append({"t": t, "kind": kind, "n": xn if kind == "xfade" else 0})
    skip = max([t for t in raw if t <= REF["lead_skip_s"]], default=0.0)
    return [s for s in out if s["t"] > REF["lead_skip_s"]], skip


def lead_skip(ev, p):
    """Clip seconds the render jumps past at the span start (the state changes inside its first 0.5 s)."""
    return page_states(ev, p)[1]


def camera_targets(ev, p, words=None):
    """The events the camera frames, each with the word that names it: [{e, box, t_word, t_from, matched, typing}]."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    words = sorted(words or [], key=lambda w: float(w["start"]))
    cl = clauses(words)
    out = []
    for e in ev["events"]:
        typing = e["type"] == "type"
        box = camera_box(e, W, H, p) if not typing else (e.get("abox") or e.get("box"))
        if box is None and not typing:
            continue
        m = word_match(e, words, cl) if (not typing and words) else None
        if m is not None:
            wt, c0, matched = float(m[0]["start"]), m[1], True
        else:
            wt = e.get("at") if e.get("at") is not None else (e["press"] - 0.35 if e.get("press") is not None else e["t"])
            c0, matched = e.get("from"), bool(e.get("beat"))
        out.append({"e": e, "box": box, "t_word": float(wt), "t_from": c0, "matched": matched, "typing": typing})
    return sorted(out, key=lambda x: (x["e"]["t"] if x["typing"] else x["t_word"]))


def _near(a, b, W, H):
    return abs(math.log(a[0] / b[0])) < 0.04 and abs(a[1] - b[1]) * a[0] / W < 0.02 and abs(a[2] - b[2]) * a[0] / H < 0.02


def plan_moves(ev, fps, f0, n_frames, p, words=None, span_end=None, why=None):
    """[(start_frame, frames, view_from, view_to, kind, box[, xfade_frames])] — the reference camera:

      · a camera target is a compiled beat's target_box or the acted element (abox, grown to its container
        under 120 px); reads, hovers and cursor points never move the camera;
      · each target's move is timed from the word that names it (its text spoken in the clause, a beat, or
        the agent's 'at'): it starts 0.5–0.9 s before the word, never before the clause, never before the
        page state that shows it, and lands by word + 0.3 s; 34–48 f in (45–58 deep), 34–40 f out, a pan
        at the same zoom (M2); with less than its minimum it is a cut that lands framed (M6), on the page
        change when there is one;
      · zoom by class (F3), centred (F1), ≤ ×1.65, ≤ 5 % black (F4), clear of the bubble when the band allows;
      · typing/paste at ×1.00 (K1); same-app page changes keep the zoom (T1/T2); dissolves only for a new
        site or a time skip (T4); no cut/flash under 6 f; spans end still zoomed (no move to ×1.00 in the
        last 0.3 s before the A-roll);
      · a camera-still hold longer than 3 s gets ONE inward ZM10 push (M5) — never outward, never a release.

    why: an optional list that receives (event, reason) for every camera target that got no move."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    k = fps / REF_FPS
    full = (1.0, W / 2, H / 2)
    states, skip = page_states(ev, p)
    st_t = [s["t"] for s in states]
    end_s = span_end if span_end is not None else float(ev.get("end") or (n_frames - f0) / fps)
    moves = []
    view, free = full, float(skip)                 # (seconds) the camera is free from here
    for s in states:
        if s["kind"] == "xfade":
            moves.append((f0 + s["t"] * fps, 0, None, None, "xfade", None, s["n"]))

    def state_start(t):
        return max([x for x in st_t if x <= t + 1e-6], default=skip)

    def boundary_in(a, b):
        return next((x for x in st_t if a - 1e-6 <= x <= b + 1e-6), None)

    type_t = sorted(float(e["t"]) for e in ev["events"] if e["type"] == "type")
    big = page_changes(ev)                         # navigations + the recorder's big settle cuts

    def nav_click(e):
        if e["type"] not in ("click", "dblclick") or e.get("target_box"):
            return False
        a = float(e.get("press", e["t"]))
        return any(a - 0.05 <= x <= float(e.get("end", a)) + 1.0 for x in big)

    def add(s0, dur, v_to, kind, box):
        nonlocal view, free
        moves.append((f0 + s0 * fps, dur * fps, view, v_to, kind, box))
        view, free = v_to, s0 + dur

    def no_move(e, reason):
        if why is not None:
            why.append((e, reason))

    for tg in camera_targets(ev, p, words):
        e, box = tg["e"], tg["box"]
        if tg["typing"]:
            # K1: typing / pasting is shown at ×1.00 — a held zoom opens out to land as the typing starts
            # (the move's target is the whole page the prompt appears on)
            if view[0] <= 1.0 + 1e-6:
                continue
            box = list(box) if box else [0, 0, W, H]
            land = max(float(e["t"]), skip)
            lo_f, hi_f = REF["out_frames"]
            s0 = max(land - REF["out_nominal_f"] / REF_FPS, free)
            if land - s0 >= lo_f / REF_FPS - 1e-6:
                add(s0, land - s0, full, "out", box)
            else:
                bt = boundary_in(free, land)
                add(bt if bt is not None else max(free, land - 0.05), 0.0, full, "cut", box)
            continue
        if nav_click(e) and not tg["matched"]:
            no_move(e, "unnamed navigation click")      # T2: the page change itself is the cut
            continue
        tgt = frame_target(box, W, H, p, e.get("_sm"), zoom=e.get("zoom"))
        if tgt[0] <= 1.0:
            no_move(e, "subject fills the frame")
            continue
        if _near(tgt, view, W, H):
            no_move(e, "already framed")
            continue
        wt = tg["t_word"]
        nt = next((t for t in type_t if t >= wt - 1e-6), None)
        if nt is not None and nt - (wt + REF["land_after_word_s"]) < (REF["in_frames"][0] + REF["out_frames"][0]) / REF_FPS:
            no_move(e, "typing follows")
            continue                                 # typing right after: no in-and-straight-out (pumping, K1)
        lead_lo, lead_hi = REF["word_lead_s"]
        start_lo = max(wt - lead_hi, free, state_start(float(e["t"])))
        if tg["t_from"] is not None:
            start_lo = max(start_lo, float(tg["t_from"]))
        land_hi = wt + REF["land_after_word_s"]
        if view[0] > 1.05 and max(tgt[0] / view[0], view[0] / tgt[0]) <= p.get("pan_zoom_tol", 1.15):
            pz = clamp(view[0], tgt[1], tgt[2], W, H, _room(e.get("_sm"), p))
            d1080 = math.hypot(pz[1] - view[1], pz[2] - view[2]) * view[0] * 1080 / H
            if d1080 / 1920 <= p.get("pan_max_screen", 0.55):
                if d1080 < 12:
                    no_move(e, "already framed")
                    continue
                # M2: a pan keeps the zoom; when the new subject asks for a different level within ±15 %
                # the pan lands on that level (a combined move, still eased on the pan curve)
                kind, nominal, dmin, dmax = "pan", pan_frames(d1080, p), p["pan_frames_minmax"][0], p["pan_frames_minmax"][1]
                tgt = clamp(tgt[0], tgt[1], tgt[2], W, H) if abs(tgt[0] / view[0] - 1) > 0.03 else pz
            else:
                kind = None
        else:
            kind = None
        if kind is None:
            if tgt[0] >= view[0]:
                deep = tgt[0] > REF["deep_zoom"]
                band = REF["deep_in_frames"] if deep else REF["in_frames"]
                kind, nominal = "in", REF["deep_nominal_f"] if deep else REF["in_nominal_f"]
            else:
                band = REF["out_frames"]
                kind, nominal = "out", REF["out_nominal_f"]
                # M3 / ZM11: a zoom-out pulls back by a ratio of 0.76–0.90 — a subject that still fits a
                # shallower pull-back takes it (refs never drop from ×1.65 straight to ×1.18 in one move)
                zr = round(view[0] * REF["out_ratio"][0], 4)
                if tgt[0] < zr and box[2] <= 0.95 * W / zr and box[3] <= 0.95 * H / zr:
                    tgt = frame_target(box, W, H, p, e.get("_sm"), zoom=zr)
            dmin, dmax = band
        # M1: start 0.5–0.9 s before the word (never before the clause or the page state), land by word + 0.3
        avail = land_hi - start_lo
        if avail * REF_FPS >= dmin - 1e-6:
            dur = min(max(nominal, dmin), dmax, avail * REF_FPS) / REF_FPS
            s0 = max(start_lo, min(wt - lead_lo, land_hi - dur))
            dur = min(dur, land_hi - s0) if land_hi - s0 >= dmin / REF_FPS - 1e-6 else dur
            add(s0, dur, tgt, kind, box)
            continue
        if not tg["matched"] and e.get("at") is None:
            no_move(e, "no time and no naming word")
            continue                                 # an unnamed action never earns a cut
        # M6: too little time — a cut that lands already framed, on the page change when one is near
        sst = state_start(float(e["t"]))
        if sst >= free - 1e-6 and sst >= wt - lead_hi - 1e-6:
            ct = sst                                 # on the page change that brings the subject
        else:
            ct = max(free, wt - 0.1)
        add(ct, 0.0, tgt, "cut", box)
    moves = _no_flash(moves, fps, f0)
    moves = _end_still(moves, fps, f0, end_s)
    moves = _chain(moves, full)
    return add_pushes(moves, ev, fps, f0, end_s, p, words)


def _no_flash(moves, fps, f0):
    """T8: two camera cuts closer than 6 f are one cut (the later framing wins)."""
    out = []
    for m in sorted(moves, key=lambda m: m[0]):
        if m[4] == "cut" and out and out[-1][4] == "cut" and m[0] - out[-1][0] < REF["flash_f"] * fps / REF_FPS:
            out[-1] = (out[-1][0],) + tuple(m[1:])
            continue
        out.append(m)
    return out


def _end_still(moves, fps, f0, end_s):
    """Spans end still zoomed (T5/CUT04): no move back to ×1.00 starting in the span's last 0.3 s
    (+ the clip's tail past the cut)."""
    lim = f0 + (end_s - REF["end_still_s"] - REF["end_tail_s"]) * fps
    return [m for m in moves if not (m[4] in ("cut", "out") and m[3] is not None and m[3][0] <= 1.0 + 1e-6 and m[0] >= lim)]


def _chain(moves, full):
    """Every move starts from where the previous one left the camera (xfades hold the view)."""
    out, view = [], full
    for m in sorted(moves, key=lambda m: (m[0], m[4] != "xfade")):
        m = list(m)
        if m[4] == "xfade":
            m[2] = m[3] = view
        else:
            m[2] = view
            if m[4] == "pan" and abs(m[3][0] / max(view[0], 1e-6) - 1) > 0.15:
                m[4] = "in" if m[3][0] > view[0] else "out"
        out.append(tuple(m))
        view = m[3]
    return out


def busy_spans(moves, ev, fps, f0, p):
    """Source-frame spans where the picture is in motion: camera moves, cuts, dissolves, page
    changes, scrolls and live typing (Jake #2: "if there's no cut there must be movement")."""
    k = fps / REF_FPS
    out = []
    for m in moves:
        if m[4] == "xfade":
            out.append((m[0], m[0] + (m[6] if len(m) > 6 else 5) * k))
        else:
            out.append((m[0], m[0] + max(m[1], 1)))
    for e in ev["events"]:
        if e["type"] in ("nav", "cut") and e["t"] > 0.05:
            out.append((f0 + e["t"] * fps, f0 + e["t"] * fps + 1))
        elif e["type"] in ("scroll", "type", "pan"):
            out.append((f0 + e["t"] * fps, f0 + e.get("end", e["t"]) * fps + 1))
    return sorted(out)


def add_pushes(moves, ev, fps, f0, end_s, p, words=None):
    """M5 / ZM10: a camera-still hold longer than hold_max_s gets ONE slow centred push inward
    (×1.12 over 40 f, catalogue ×1.06–1.26 over 24–46 f) hold_target after the last motion — never
    outward, never alternating, never a release. A hold the push cannot fill stays a hold: a long
    gap is an upstream failure (the recorder's idle tail), not something the camera hides. No push
    before typing (typing is shown at ×1.00) nor where it would pass ×1.65."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    k = fps / REF_FPS
    D = REF["push_frames"] * k
    end = f0 + end_s * fps
    busy = busy_spans(moves, ev, fps, f0, p)
    gaps, cur = [], f0 + lead_skip(ev, p) * fps
    for a, b in busy:
        if a > cur:
            gaps.append((cur, a))
        cur = max(cur, b)
    if end > cur:
        gaps.append((cur, end))
    types = sorted(f0 + e["t"] * fps for e in ev["events"] if e["type"] == "type")
    zmoves = sorted(m[0] for m in moves if m[4] in ("in", "out", "pan", "cut"))
    eases = make_eases(p)
    pushes = []
    for g0, g1 in gaps:
        if g1 - g0 <= REF["hold_max_s"] * fps:
            continue
        s0 = g0 + REF["push_after_s"] * fps
        if s0 + D > g1 - 0.2 * fps:
            continue
        nt = next((t for t in types if t >= s0), None)
        nm = next((t for t in zmoves if t >= s0), None)
        if nt is not None and (nm is None or nt <= nm):
            continue                                  # typing comes before any re-framing: stay at ×1.00
        z, cx, cy = camera_at(sorted(moves + pushes, key=lambda m: m[0]), s0, p, eases, W, H)
        z2 = min(z * REF["push_zoom"], REF["zoom_cap"])
        if z2 / z < REF["push_band"][0]:
            continue
        pushes.append((s0, D, (z, cx, cy), clamp(z2, cx, cy, W, H, overscan_of((z, cx, cy), W, H)), "push", None))
    if not pushes:
        return moves
    return _chain(moves + pushes, (1.0, W / 2, H / 2))


def motion_events(moves, ev, fps, f0, end_s, p):
    """Clip seconds of every motion event (P2): camera moves, camera cuts, dissolves and the recorded
    page-state cuts — one event per change, changes closer than 6 f merged."""
    ts = [(m[0] - f0) / fps for m in moves]
    ts += [s["t"] for s in page_states(ev, p)[0] if s["kind"] == "cut"]
    out = []
    for t in sorted(ts):
        if lead_skip(ev, p) - 1e-6 <= t <= end_s and (not out or t - out[-1] >= REF["flash_f"] / REF_FPS):
            out.append(t)
    return out


def _view_between(a, b, u):
    """Zoom on LOG scale about the move's fixed point (the reference's view corners move
    in step with its width — a pure zoom about one point, then any pan)."""
    z0, x0, y0 = a
    z1, x1, y1 = b
    z = math.exp(math.log(z0) + (math.log(z1) - math.log(z0)) * u)
    if abs(z1 - z0) < 1e-6:
        return z, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
    # the fixed point P stays put on screen: (P − c0)·z0 = (P − c1)·z1
    px, py = (x0 * z0 - x1 * z1) / (z0 - z1), (y0 * z0 - y1 * z1) / (z0 - z1)
    return z, px - (px - x0) * z0 / z, py - (py - y0) * z0 / z


def camera_at(moves, f, p, eases, W, H):
    view = (1.0, W / 2, H / 2)
    for s0, dur, a, b, kind, *_ in moves:
        if f < s0:
            break
        if dur <= 0 or f >= s0 + dur:
            view = b
            continue
        u = eases.get(kind, eases["in"])((f - s0) / dur)
        oa, ob = overscan_of(a, W, H), overscan_of(b, W, H)
        view = clamp(*_view_between(a, b, u), W, H, tuple(max(x, y) for x, y in zip(oa, ob)))
        break
    return view


def acted_box(e, ev, p=REF):
    """The box an action really acts on (B2): the element, or — for a click on a big element (a photo,
    a canvas: wider than 0.25 W or taller than 0.25 H) — a small box at the cursor's press point."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    b = e.get("abox") or e.get("box")
    if not b:
        return None
    if e["type"] in ("click", "dblclick") and (b[2] > 0.25 * W or b[3] > 0.25 * H) and ev.get("cursor"):
        tp = e.get("press", e["t"])
        c = min(ev["cursor"], key=lambda r: abs(r[0] - tp))
        s = 20 * ev["capture"].get("scale", 1.0)
        return [c[1] - s / 2, c[2] - s / 2, s, s]
    return b


def bubble_decisions(ev, keys, fps, f0, p, eases):
    """{id(event): hide?} — decided ONCE per action, at its press frame, through that frame's camera view."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    out = {}
    for e_ in ev["events"]:
        if e_["type"] not in p.get("bubble_hide_actions", ()):
            continue
        b = acted_box(e_, ev)
        if not b:
            continue
        tp = e_.get("press", e_.get("end", e_["t"]) if e_["type"] == "type" else e_["t"])
        # (the frame just BEFORE the press: a navigating press shares its frame with the cut to the next page)
        view = camera_at(keys, f0 + tp * fps - 1, p, eases, W, H)
        gap = disc_gap(b, view, W, H)
        out[id(e_)] = gap <= REF["bubble_margin_px"]
        e_["_disc_dist_px"] = round(gap + DISC_1080[2], 1)
    return out


def bubble_hide_spans(ev, keys, fps, f0, p, eases, t_from, n_out, ofps, decisions=None):
    """[[a, b]] output seconds where the bubble fades out (B2): while an action whose acted box meets the
    disc acts (action_targets), merged over 0.5 s gaps; a flicker shorter than 0.3 s is not an action."""
    decisions = decisions if decisions is not None else bubble_decisions(ev, keys, fps, f0, p, eases)
    acts = [e for e in ev["events"] if decisions.get(id(e))]
    hide = []
    for o in range(n_out):
        t = t_from + o / ofps
        if any(e in acts for e in action_targets({"events": acts}, t)):
            hide.append(round(o / ofps, 3))
    spans = []
    for t_ in hide:
        if spans and t_ - spans[-1][1] < 0.5:
            spans[-1][1] = t_
        else:
            spans.append([t_, t_])
    return [s_ for s_ in spans if s_[1] - s_[0] >= 0.3]


def move_starts(moves):
    return [m[0] for m in moves if m[1] > 0]


def action_targets(ev, t):
    """Events ACTING at clip second t: a click from just before its press until it has landed, a
    type while it types (the bubble fades only for these, SYSTEM.md §0 bubble rule)."""
    out = []
    for e in ev["events"]:
        if not e.get("box") or e["type"] not in ("click", "dblclick", "type", "drag", "select"):
            continue
        # LOOP ROUND 1 (review v12 #21: "Log in" stayed under the opaque bubble; it faded only after
        # the click): the action starts when the cursor sets off for it (e["t"]), not 0.35 s before
        # the press — the bubble is gone (7 f fade) while the camera lands on the target and the
        # cursor travels there (ref 2 3:06–3:12 top-right sign-in; TECHNIQUES BB01 fade 6–15 f riding the zoom)
        a = min(e["press"] - 0.35, e["t"] - 0.2) if e.get("press") is not None else e["t"] - 0.2
        if a - 0.1 <= t <= e.get("end", e["t"]) + 0.2:
            out.append(e)
    return out


def active_targets(ev, t):
    return [e for e in ev["events"] if e.get("box") and e["type"] in ("click", "type", "read", "highlight", "move", "hover")
            and e["t"] - 0.3 <= t <= e.get("end", e["t"]) + 0.3]


def is_blank(img, p):
    """A loading / blank source frame: (almost) one flat colour (a spinner on white, an app
    canvas still drawing, a page scrolled into nothing). Reference 2 never shows one (0.3 %)."""
    h, w = img.shape[:2]
    # judged on the CENTRE (15 % margins off): an app's chrome (header bar, side toolbar) stays
    # drawn around a canvas that is still loading (2026-10-06: a grey Linearity canvas passed)
    img = img[int(h * 0.15):int(h * 0.85), int(w * 0.15):int(w * 0.85)]
    sm = cv2.resize(img, (160, 90), interpolation=cv2.INTER_AREA)
    if float(sm.std()) < p["blank_std"]:
        return True
    q = (sm // 8).reshape(-1, 3).astype(np.int32)
    key = q[:, 0] * 1024 + q[:, 1] * 32 + q[:, 2]
    vals, cnt = np.unique(key, return_counts=True)
    bg = vals[cnt.argmax()]
    bgc = np.array([bg // 1024, (bg // 32) % 32, bg % 32]) * 8 + 4
    return float((np.abs(sm.astype(np.int32) - bgc).max(axis=2) > 10).mean()) < p["blank_content"]


# ── drawing ──────────────────────────────────────────────────────────────────
def cursor_sprite(px):
    """A clean macOS-like arrow, white with a dark rim, rendered at px height, RGBA."""
    s = px / 24.0
    pts = np.array([[0, 0], [0, 17], [4.2, 13.2], [6.8, 19.4], [9.6, 18.2], [7.0, 12.2], [12.4, 12.2]], np.float32)
    pad = int(3 * s) + 2
    w, h = int(13 * s) + 2 * pad, int(21 * s) + 2 * pad
    img = np.zeros((h * 4, w * 4, 4), np.uint8)               # 4× supersampled
    P = ((pts * s + pad) * 4).astype(np.int32)
    cv2.fillPoly(img, [P], (20, 20, 20, 255), lineType=cv2.LINE_AA)
    cv2.polylines(img, [P], True, (20, 20, 20, 255), thickness=max(4, int(2.2 * s * 4)), lineType=cv2.LINE_AA)
    inner = np.array([[1.4, 3.2], [1.4, 13.6], [4.6, 10.6], [7.4, 16.9], [8.2, 16.5], [5.5, 10.4], [9.6, 10.4]], np.float32)
    cv2.fillPoly(img, [((inner * s + pad) * 4).astype(np.int32)], (255, 255, 255, 255), lineType=cv2.LINE_AA)
    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    return img, (pad, pad)                                     # hotspot


def paste(dst, rgba, x, y):
    h, w = rgba.shape[:2]
    x0, y0 = int(round(x)), int(round(y))
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(dst.shape[1], x0 + w), min(dst.shape[0], y0 + h)
    if xa >= xb or ya >= yb:
        return
    src = rgba[ya - y0:yb - y0, xa - x0:xb - x0].astype(np.float32)
    a = src[:, :, 3:4] / 255.0
    roi = dst[ya:yb, xa:xb].astype(np.float32)
    dst[ya:yb, xa:xb] = (src[:, :, :3][:, :, ::-1] * a + roi * (1 - a)).astype(np.uint8)   # RGBA→BGR


def cursor_track(ev, fps, f0, n, smooth_s):
    c = np.array(ev["cursor"], np.float64) if ev["cursor"] else np.zeros((1, 3))
    tt = f0 / fps * 0 + (np.arange(n) - f0) / fps
    x = np.interp(tt, c[:, 0], c[:, 1])
    y = np.interp(tt, c[:, 0], c[:, 2])
    k = max(1, int(round(smooth_s * fps)))
    if k > 1:
        ker = np.ones(k) / k
        x = np.convolve(np.pad(x, (k // 2, k - 1 - k // 2), mode="edge"), ker, "valid")
        y = np.convolve(np.pad(y, (k // 2, k - 1 - k // 2), mode="edge"), ker, "valid")
    return x, y


# ── main ─────────────────────────────────────────────────────────────────────
def load_words(recdir, words=None):
    """The narration words on the clip clock: a list, a path, or <recdir>/words.json; [] when none."""
    if isinstance(words, (list, tuple)):
        return list(words)
    for src in ([Path(words)] if words else []) + [Path(recdir) / "words.json"]:
        try:
            d = json.loads(src.read_text())
            return d.get("words", []) if isinstance(d, dict) else d
        except (OSError, ValueError):
            continue
    return []


def plan_offline(ev, p=None, words=None, span_end=None, fps=None, why=None):
    """plan_moves on events.json alone (no raw.mp4: no frame facts) — the offline re-run of the camera."""
    p = p or params()
    fps = fps or ev["capture"]["fps"]
    f0 = ev.get("pre_frames", 0) if ev.get("virtual_time") else 0
    end = span_end if span_end is not None else float(ev.get("end") or 0)
    return plan_moves(ev, fps, f0, f0 + int(end * fps) + 1, p, words=words, span_end=end, why=why)


def landings(moves, ev, fps, f0, p):
    """Per framing move: where it landed and how (the G5 acceptance numbers live on these)."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    out = []
    for m in moves:
        if m[4] not in ("in", "out", "pan", "cut") or len(m) < 6 or not m[5] or m[3][0] <= 1.0 + 1e-6:
            continue
        dx, dy = landing_offset(m[5], m[3], W, H)
        out.append({"t": round((m[0] + m[1] - f0) / fps, 3), "kind": m[4], "zoom": round(m[3][0], 3),
                    "frames": round(m[1] * REF_FPS / fps, 1), "box": [round(v, 1) for v in m[5]],
                    "dx": round(dx, 3), "dy": round(dy, 3), "edge": touches_edge(m[5], W, H),
                    "centred": dx <= REF["centre_tol"][0] + 1e-6 and dy <= REF["centre_tol"][1] + 1e-6,
                    "edge_limited": edge_limited(m[5], m[3], W, H)})
    return out


def render(recdir, out, size=(1920, 1080), t_from=None, t_to=None, crf=16, preset="veryfast", out_fps=None, words=None):
    """t_from/t_to: seconds on the recording's clock (0 = sync marker). The clip is exactly
    (t_to − t_from) long: a recording that ends early holds its last frame. out_fps: the
    edit's frame rate (frames are picked by time, so 30 → 29.97 never drifts). words: the narration
    words on the clip clock (or <recdir>/words.json)."""
    recdir = Path(recdir)
    ev = json.loads((recdir / "events.json").read_text())
    words = load_words(recdir, words)
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    fps = ev["capture"]["fps"]
    raw = recdir / "raw.mp4"
    n_all = int(subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                                "stream=nb_read_packets", "-of", "csv=p=0", str(raw)], capture_output=True, text=True).stdout.strip())
    vw, vh = (int(v) for v in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
              "stream=width,height", "-of", "csv=p=0", str(raw)], capture_output=True, text=True).stdout.strip().split(","))
    if (vw, vh) != (W, H):
        raise RuntimeError(f"recording is {vw}x{vh}, events say {W}x{H}")
    f0 = ev["pre_frames"] if ev.get("virtual_time") else marker_frame(raw, W, H)
    p = params()
    eases = make_eases(p)
    hl_in, hl_out = bezier(*p["hl_ease"]), bezier(*p["hl_out_ease"])
    drop_empty_targets(ev, raw, f0, fps, p)
    first_frame_facts(ev, raw, f0, p)
    span_end = (t_to - (t_from or 0)) if t_to is not None else None
    keys = plan_moves(ev, fps, f0, n_all, p, words=words, span_end=span_end)
    skip_s = lead_skip(ev, p)                  # the opening state changes are skipped (≤ 1 transition, the entry)
    starts = move_starts(keys)
    kref = fps / REF_FPS
    # ROUND 3 (review N07/N03b): the bubble decision is made ONCE per action, at its PRESS frame, from the
    # ACTED element's box (abox — not the camera frame box) projected through the camera view of that frame
    # into output pixels, against the disc (1701.9, 253.7) r 179.3 @1080p. Round 2 tested every frame of
    # the cursor travel and used the frame box: "Log in" 228 px from the centre still hid the bubble.
    # G5 step 7 (B2): only when the box the action ACTS ON intersects the disc + 24 px margin. A click on a
    # big element (a photo, a canvas) acts at the cursor's press point, not on the whole element: the
    # photo clicks at sc-03 22.9/25.7, sc-05 9.7/25.3 and sc-06 21.4 hid the bubble with the cursor far away.
    hide_decision = bubble_decisions(ev, keys, fps, f0, p, eases)
    blank = []                                 # output seconds showing an (almost) empty screen
    a = f0 + round((t_from or 0) * fps)
    b_req = n_all if t_to is None else f0 + round(t_to * fps)
    b = min(n_all, b_req)
    ofps = out_fps or fps
    n_out = round((b_req - a) / fps * ofps)
    cx_t, cy_t = cursor_track(ev, fps, f0, n_all, max(p["cursor_smooth_s"], 1e-6))
    ow, oh = size
    sprite_cache = {}
    highlights = [e for e in ev["events"] if e["type"] == "highlight" and e.get("box")]
    page_moves = sorted(e["t"] for e in ev["events"] if e["type"] in ("scroll", "nav", "pan"))

    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{a / fps:.6f}", "-i", str(raw), "-frames:v", str(b - a),
                            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{ow}x{oh}",
                            "-r", f"{ofps:.6f}", "-i", "-", "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    fb = W * H * 3
    # dissolves (SYSTEM.md §3b): (source frame, length in ref frames) — the outgoing picture is the
    # last output frame before the change, held, under a linear opacity ramp of the incoming one
    xfades = [(m[0], m[6]) for m in keys if m[4] == "xfade" and len(m) > 6 and m[6] > 0]
    xf_hold, prev_img, bg_cache = {}, None, {}
    cur_src, frame_src, last = a - 1, None, None
    good, held_src = None, []               # last non-blank source frame; output seconds held on it
    for o in range(n_out):
        f = a + int(o / ofps * fps + 1e-6)              # source frame shown at this output frame
        if skip_s and f < f0 + skip_s * fps + 1:
            f = int(f0 + skip_s * fps + 1)              # the state after the opening changes (no flash, CUT05)
        while cur_src < min(f, b - 1):
            buf = dec.stdout.read(fb)
            if len(buf) < fb:
                b = cur_src + 1
                break
            frame_src = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
            cur_src += 1
            # a loading/blank frame never shows: the last good frame holds until the page
            # has drawn (reads as the reference's jump cut past a load)
            if is_blank(frame_src, p) and good is not None:
                frame_src = good
                held_src.append(cur_src)
            else:
                good = frame_src
        if frame_src is None:
            break
        f = min(f, cur_src)
        frame = frame_src.copy()
        z, cx, cy = camera_at(keys, f, p, eases, W, H)
        t = (f - f0) / fps
        # highlights: a left→right marker wipe drawn in CAPTURE space (it zooms with the
        # page); it fades when the camera's NEXT move starts (reference 2, 3/3 cases)
        for e in highlights:
            fe = f0 + e["t"] * fps
            if f < fe - p["hl_lead_frames"] * kref:
                continue
            x, y, bw, bh = e["box"]
            w1080 = bw * 1080 / H
            dur = min(max(p["hl_dur"][0] + p["hl_dur"][1] * w1080, p["hl_dur"][2]), p["hl_dur"][3]) * kref
            u = hl_in((f - (fe - p["hl_lead_frames"] * kref)) / dur)
            nxt = next((m for m in starts if m > fe + dur), None)
            alpha = 1.0
            if nxt is not None and f >= nxt:
                alpha = 1 - hl_out((f - nxt) / (p["hl_out_frames"] * kref))
            # the page scrolls or changes under it: the marker goes at once (3 f)
            gone = next((f0 + x * fps for x in page_moves if x * fps + f0 > fe), None)
            if gone is not None and f >= gone:
                alpha = min(alpha, 1 - (f - gone) / (3 * kref))
            if alpha <= 0.001:
                continue
            hh = bh * p["hl_height"] / 0.74 if bh < 60 else bh * 0.92
            pad = p["hl_pad_px"] * H / 1080
            yc = y + bh / 2
            x1 = int(x - pad + (bw + 2 * pad) * u)
            if x1 <= x - pad:
                continue
            r, g, bl, al = STYLE["highlight_rgba"]
            y0r, y1r, x0r = int(yc - hh / 2), int(yc + hh / 2), int(x - pad)
            roi = frame[y0r:y1r, x0r:x1].astype(np.float32)
            col = np.array([bl, g, r], np.float32)
            # multiply-like marker: darks stay dark, light text takes the yellow
            mixed = roi * (col / 255.0) * 0.55 + col * 0.45
            frame[y0r:y1r, x0r:x1] = (roi * (1 - al * alpha) + mixed * (al * alpha)).clip(0, 255).astype(np.uint8)
        cw, ch = W / z, H / z
        x0, y0 = cx - cw / 2, cy - ch / 2
        M = np.array([[ow / cw, 0, -x0 * ow / cw], [0, oh / ch, -y0 * oh / ch]], np.float32)
        if x0 < -0.5 or y0 < -0.5 or x0 + cw > W + 0.5 or y0 + ch > H + 0.5:
            # overscan onto a flat canvas edge: fill with that edge's colour (edge_room only allows
            # it where the outer band is one flat colour)
            if bg_cache.get("src") != cur_src:
                ring = np.concatenate([frame[::8, :8].reshape(-1, 3), frame[::8, -8:].reshape(-1, 3),
                                       frame[:8, ::8].reshape(-1, 3), frame[-8:, ::8].reshape(-1, 3)])
                bg_cache.update(src=cur_src, v=tuple(float(v) for v in np.median(ring, axis=0)))
            img = cv2.warpAffine(frame, M, (ow, oh), flags=cv2.INTER_CUBIC if z > 1.01 else cv2.INTER_AREA,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=bg_cache["v"])
        else:
            img = cv2.warpAffine(frame, M, (ow, oh), flags=cv2.INTER_CUBIC if z > 1.01 else cv2.INTER_AREA,
                                 borderMode=cv2.BORDER_REPLICATE)
        # cursor: scales with the zoom like the page under it
        px = 24 * ev["capture"]["scale"] * p["cursor_scale"] * z * ow / W
        key = round(px * 2) / 2
        if key not in sprite_cache:
            sprite_cache[key] = cursor_sprite(key)
        spr, hot = sprite_cache[key]
        # blank screens (a page that scrolled into an empty/black section): reported so the
        # edit can cut back to the presenter instead of showing nothing
        small = cv2.resize(img, (96, 54), interpolation=cv2.INTER_AREA)
        if float(small.std()) < 7.0:
            blank.append(round(o / ofps, 3))
        sx = (cx_t[f] - x0) * ow / cw - hot[0]
        sy = (cy_t[f] - y0) * oh / ch - hot[1]
        paste(img, spr, sx, sy)
        for xs0, xn in xfades:
            if xs0 <= f < xs0 + xn * kref + 1 and prev_img is not None:
                if xs0 not in xf_hold:
                    xf_hold[xs0] = prev_img
                w = min(1.0, ((f - xs0) / kref + 1) / xn)
                if w < 1.0:
                    img = cv2.addWeighted(xf_hold[xs0], 1 - w, img, w, 0)
                break
        prev_img = img
        enc.stdin.write(img.tobytes())
    dec.stdout.close()
    enc.stdin.close()
    enc.wait()
    dec.wait()
    spans = bubble_hide_spans(ev, keys, fps, f0, p, eases, t_from or 0, n_out, ofps, hide_decision)
    bl = []
    for t_ in blank:
        if bl and t_ - bl[-1][1] < 2.5 / ofps:
            bl[-1][1] = t_
        else:
            bl.append([t_, t_])
    scroll_t = [round(e["t"] - (t_from or 0), 3) for e in ev["events"] if e["type"] == "scroll"]
    end_s = span_end if span_end is not None else (n_all - f0) / fps
    json.dump({"f0": f0, "moves": keys, "bubble_hide": spans, "lead_skip": skip_s,
               "landings": landings(keys, ev, fps, f0, p),
               "motion_events": [round(t_, 3) for t_ in motion_events(keys, ev, fps, f0, end_s, p)], "held_blank_frames": len(held_src), "blank": [b_ for b_ in bl if b_[1] - b_[0] >= 0.5],
               "scrolls": scroll_t,
               "xfades": [[round((s_ - f0) / fps - (t_from or 0), 3), n_] for s_, n_ in xfades],
               "pans": sum(1 for m in keys if m[4] == "pan"),
               "params": p}, open(str(out) + ".camera.json", "w"), indent=1)
    return keys


if __name__ == "__main__":
    args = sys.argv[1:]
    opt = {k: args[args.index(k) + 1] for k in ("--size", "--from", "--to", "--fps", "--words") if k in args}
    size = tuple(int(v) for v in opt.get("--size", "1920x1080").split("x"))
    keys = render(args[0], args[1], size, float(opt["--from"]) if "--from" in opt else None,
                  float(opt["--to"]) if "--to" in opt else None, out_fps=float(opt["--fps"]) if "--fps" in opt else None,
                  words=opt.get("--words"))
    print(json.dumps({"keys": len(keys)}))
