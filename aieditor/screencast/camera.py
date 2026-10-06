"""Screencast camera: events.json (record.mjs) → a zoom/pan path → rendered clip.

Runs inside the aieditor-screencast image (numpy + cv2 + ffmpeg):
    python3 camera.py <recdir> <out.mp4> [--size 3840x2160] [--from S --to S] [--plan plan.json]

The camera is a list of KEYS (frame, zoom, cx, cy) in capture pixels; between keys it
eases with the measured curve. Motion constants come from motion/keyframes.json
["screencast"] (reference 2, kwysV2smgfY) when present, else the DEFAULTS below.
Design (cursor sprite, highlight colour) is STYLE, kept apart from motion like the
rest of the motion library (Jake: "save mostly the animation keyframes").
"""
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent

DEFAULTS = {
    # reference 2 (kwysV2smgfY) screen camera — kwys-screencast.json, 29.97 fps frames.
    # The SYSTEM values (motion/screencast_system.json ["camera"], SYSTEM.md) override these.
    "zoom_in_ease": [0.31, 0.10, 0.22, 1.0],      # on LOG zoom, rms 0.001–0.004 (15/17)
    "zoom_in_frames": 43, "zoom_in_frames_big": 56, "big_zoom": 1.45,
    "zoom_out_ease": [0.345, 0.0, 0.33, 0.91], "zoom_out_frames": 50,
    # zoom-in levels: reference median 1.37 (IQR 1.31–1.46), > 1.6 in 1 of 22 moves (a table row)
    "zoom_min": 1.25, "zoom_max": 1.45, "zoom_cap": 1.6, "zoom_deep": 2.0,
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
def clamp(z, cx, cy, W, H):
    hw, hh = W / z / 2, H / z / 2
    return z, min(max(cx, hw), W - hw), min(max(cy, hh), H - hh)


def framing_for(box, W, H, p, deep=False):
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
    return clamp(z, x + bw / 2, y + bh / 2, W, H)


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
        if e["type"] not in ("read", "hover", "move"):
            continue
        frac = content_fraction(img, framing_for(e["box"], W, H, p), W, H)
        if frac is not None and frac < p["empty_min"]:
            e["empty"] = True
            dropped.append(round(e["t"], 2))
    cap.release()
    return dropped


def page_changes(ev):
    """Clip seconds where the screen became a different page: navigations and the recorder's
    settle cuts (a click whose result loaded off camera = a jump cut, like the reference's)."""
    return sorted(e["t"] for e in ev["events"] if (e["type"] == "nav" or (e["type"] == "cut" and e.get("big", True)))
                  and e["t"] > 0.05)


def plan_moves(ev, fps, f0, n_frames, p):
    """[(start_frame, frames, view_from, view_to, ease, box)] — reference 2's camera (SYSTEM.md §3):
    an entry push-in, then eased moves to the targets the narration is about, never sooner
    than hold_min_s after the last one and within a rolling per-minute budget; one framing
    covers the next few seconds of targets when it can; a page change is a hard cut back
    to the full frame (then a fresh push-in); navigation clicks are not zoom targets."""
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    k = fps / REF_FPS                        # reference frames → this clip's frames
    full = (1.0, W / 2, H / 2)
    pages = page_changes(ev)
    scrolls = [e["t"] for e in ev["events"] if e["type"] == "scroll"]

    def nav_click(e):
        return e["type"] == "click" and any(0 <= c - e["t"] <= p["nav_click_window_s"] + (e.get("end", e["t"]) - e["t"])
                                            for c in pages)
    focus = [e for e in ev["events"] if e.get("box") and not e.get("empty")
             and e["type"] in ("click", "type", "read", "highlight", "move", "hover") and not nav_click(e)]
    moves, view, last_move_end = [], full, -1e9
    starts = []                               # move start frames (the rolling budget)

    def budget_ok(s0):
        # rolling budget over a 30 s window (a 30 s clip may not spend a whole minute's moves)
        recent = [x for x in starts if s0 - 30 * fps < x <= s0]
        return len(recent) < p["moves_per_min_max"] / 2

    def framing(e, t):
        # one framing for this target and the ones right after it on the same page, when the
        # union still zooms: fewer, calmer moves (reference: one move per 13–17 s)
        nxt_page = next((c for c in pages if c > t), 1e9)
        group = [e["box"]]
        for o in focus:
            if t < o["t"] <= min(t + p["cluster_s"], nxt_page) and o is not e:
                cand = framing_for(union(group + [o["box"]]), W, H, p)
                if cand[0] < p["zoom_min"] - 1e-6:
                    break
                group.append(o["box"])
        box = union(group)
        v = avoid_bubble(framing_for(box, W, H, p, deep=bool(e.get("deep")) and len(group) == 1), box, W, H, p)
        return clear_bubble(v, box, e.get("_sm"), W, H, p), box

    first = focus[0] if focus else None
    if first is None or first["t"] > 0.4 or framing(first, first["t"])[0][0] <= 1.0:
        # entry push-in toward the first target's area (or the centre) — reference: every span
        # that starts unzoomed pushes in to ~1.36× from its 1st–2nd frame
        if first is not None and (not pages or first["t"] < pages[0]):
            tgt, box = framing(first, first["t"])
            cxy = (tgt[1], tgt[2]) if tgt[0] > 1.0 else (box[0] + box[2] / 2, box[1] + box[3] / 2)
            v = clear_bubble(clamp(p["entry_zoom"], *cxy, W, H), box, first.get("_sm"), W, H, p)
        else:
            v, box = (p["entry_zoom"], W / 2, H / 2), None
        s0 = f0 + p["entry_delay_frames"] * k
        moves.append((s0, p["entry_frames"] * k, view, v, "in", box))
        starts.append(s0)
        view, last_move_end = v, s0 + p["entry_frames"] * k
    cues = sorted([(e["t"], "focus", e) for e in focus] + [(t, "nav", None) for t in pages]
                  + [(t, "scroll", None) for t in scrolls], key=lambda c: c[0])
    last_target_end = 0.0
    scroll_cut = None                         # end of a scroll whose next target lands by a cut
    for t, kind, e in cues:
        fr = f0 + t * fps
        if kind == "scroll":
            # the page moves under the view: open back out to the full frame as it starts
            soon = any(0 < o["t"] - t <= p["scroll_direct_s"] for o in focus)
            if soon:
                # the target right after the scroll lands by a JUMP CUT at the scroll's end, already
                # framed (reference 2 re-targets by cut far more than by move; a 56-frame deep move
                # after the scroll reached the Free plan card only as the segment ended — v10)
                se = next((x for x in ev["events"] if x["type"] == "scroll" and abs(x["t"] - t) < 1e-6), {})
                scroll_cut = se.get("end", t)
            if not soon and view[0] > 1.0 and fr >= last_move_end:
                moves.append((fr, p["zoom_out_frames"] * k, view, full, "out"))
                view, last_move_end = full, fr + p["zoom_out_frames"] * k
            continue
        if kind == "nav":
            if p["nav_resets"] and view != full:
                moves.append((fr, 0, view, full, "cut"))
            view, last_move_end = full, min(last_move_end, fr)
            last_target_end = t
            continue
        end = e.get("end", t)
        if scroll_cut is not None and 0 <= t - scroll_cut <= p["scroll_direct_s"]:
            tgt, box = framing(e, t)
            if tgt[0] > 1.0:
                moves.append((f0 + scroll_cut * fps, 0, view, tgt, "cut", box))
                view, last_move_end, last_target_end = tgt, f0 + scroll_cut * fps, max(last_target_end, end)
                scroll_cut = None
                continue
        scroll_cut = None if scroll_cut is not None and t - scroll_cut > p["scroll_direct_s"] else scroll_cut
        if t - last_target_end > p["idle_out_s"] and view[0] > 1.0 and fr - last_move_end > p["zoom_out_frames"] * k:
            s0 = f0 + (last_target_end + 1.0) * fps
            moves.append((s0, p["zoom_out_frames"] * k, view, full, "out"))
            starts.append(s0)
            view, last_move_end = full, s0 + p["zoom_out_frames"] * k
        last_target_end = max(last_target_end, end)
        if view[0] > 1.05 and in_view(e["box"], view, W, H, 1080, p, readable=False):
            continue
        tgt, box = framing(e, t)
        if tgt == view or tgt[0] <= 1.0:          # a whole-page target never pulls the camera out
            continue
        dur = (p["zoom_in_frames_big"] if tgt[0] > p["big_zoom"] else p["zoom_in_frames"]) * k
        # out of a full frame (after a cut / at the start) the move may come at once; from a
        # framed view the camera holds at least hold_min_s first
        gap = 0 if view == full else p["hold_min_s"] * fps
        last_cut = max([c for c in pages if c <= t + 1e-6], default=None)
        s0 = max(fr - p["lead_s"] * fps, last_move_end + gap, f0 + p["entry_delay_frames"] * k,
                 f0 + last_cut * fps + p["entry_delay_frames"] * k if last_cut is not None else 0)
        if s0 > max(fr + 1.5 * fps, f0 + (end - 1.0) * fps):     # too late to matter: let it go
            continue
        # a push-in out of the full frame right after a page cut is that screen's ENTRY (the
        # reference opens every span this way) — it does not spend the move budget
        entry = view == full and last_cut is not None and f0 + last_cut * fps >= (starts[-1] if starts else -1e9)
        if entry and t - last_cut <= 1.5:
            # the reference re-targets by JUMP CUT more often than by a move: a new screen that
            # is about this target lands already framed, on the cut itself
            moves.append((f0 + last_cut * fps, 0, full, tgt, "cut", box))
            view, last_move_end = tgt, f0 + last_cut * fps
            continue
        if not entry and not budget_ok(s0):
            continue
        moves.append((s0, dur, view, tgt, "in" if tgt[0] >= view[0] else "out", box))
        if not entry:
            starts.append(s0)
        view, last_move_end = tgt, s0 + dur
    return moves


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
        u = eases["out" if kind == "out" else "in"]((f - s0) / dur)
        view = clamp(*_view_between(a, b, u), W, H)
        break
    return view


def move_starts(moves):
    return [m[0] for m in moves if m[1] > 0]


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
def render(recdir, out, size=(1920, 1080), t_from=None, t_to=None, crf=16, preset="veryfast", out_fps=None):
    """t_from/t_to: seconds on the recording's clock (0 = sync marker). The clip is exactly
    (t_to − t_from) long: a recording that ends early holds its last frame. out_fps: the
    edit's frame rate (frames are picked by time, so 30 → 29.97 never drifts)."""
    recdir = Path(recdir)
    ev = json.loads((recdir / "events.json").read_text())
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
    eases = {"in": bezier(*p["zoom_in_ease"]), "out": bezier(*p["zoom_out_ease"])}
    hl_in, hl_out = bezier(*p["hl_ease"]), bezier(*p["hl_out_ease"])
    drop_empty_targets(ev, raw, f0, fps, p)
    keys = plan_moves(ev, fps, f0, n_all, p)
    starts = move_starts(keys)
    kref = fps / REF_FPS
    hide = []                                  # output seconds where the bubble must fade out
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
    page_moves = sorted(e["t"] for e in ev["events"] if e["type"] in ("scroll", "nav"))

    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{a / fps:.6f}", "-i", str(raw), "-frames:v", str(b - a),
                            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{ow}x{oh}",
                            "-r", f"{ofps:.6f}", "-i", "-", "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
    fb = W * H * 3
    cur_src, frame_src, last = a - 1, None, None
    good, held_src = None, []               # last non-blank source frame; output seconds held on it
    for o in range(n_out):
        f = a + int(o / ofps * fps + 1e-6)              # source frame shown at this output frame
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
        img = cv2.warpAffine(frame, M, (ow, oh), flags=cv2.INTER_CUBIC if z > 1.01 else cv2.INTER_AREA,
                             borderMode=cv2.BORDER_REPLICATE)
        # cursor: scales with the zoom like the page under it
        px = 24 * ev["capture"]["scale"] * p["cursor_scale"] * z * ow / W
        key = round(px * 2) / 2
        if key not in sprite_cache:
            sprite_cache[key] = cursor_sprite(key)
        spr, hot = sprite_cache[key]
        # facecam: the bubble hides while a target sits under it on screen
        # the target the camera is HOLDING on counts for as long as it holds
        held = None
        for m in keys:
            if m[0] <= f:
                held = m[5] if len(m) > 5 and m[5] else None
        targets = active_targets(ev, t) + ([{"box": held}] if held else [])
        for e in targets:
            # the target's on-screen box (0..1) against the bubble's zone: hide when a real
            # share of the target sits under it (its centre alone missed a wide headline)
            bx, by, bw2, bh2 = e["box"]
            ax0, ay0 = (bx - x0) / cw, (by - y0) / ch
            ax1, ay1 = (bx + bw2 - x0) / cw, (by + bh2 - y0) / ch
            zx0, zy0, zx1, zy1 = p["bubble_zone"]
            ix = max(0.0, min(ax1, zx1) - max(ax0, zx0))
            iy = max(0.0, min(ay1, zy1) - max(ay0, zy0))
            area = max(1e-6, (ax1 - ax0) * (ay1 - ay0))
            if ix * iy / area >= 0.08 and ax1 > zx0:
                hide.append(round(o / ofps, 3))
                break
        # blank screens (a page that scrolled into an empty/black section): reported so the
        # edit can cut back to the presenter instead of showing nothing
        small = cv2.resize(img, (96, 54), interpolation=cv2.INTER_AREA)
        if float(small.std()) < 7.0:
            blank.append(round(o / ofps, 3))
        sx = (cx_t[f] - x0) * ow / cw - hot[0]
        sy = (cy_t[f] - y0) * oh / ch - hot[1]
        paste(img, spr, sx, sy)
        enc.stdin.write(img.tobytes())
    dec.stdout.close()
    enc.stdin.close()
    enc.wait()
    dec.wait()
    # hide frames → spans (output seconds), merged over 0.5 s gaps
    spans = []
    for t_ in hide:
        if spans and t_ - spans[-1][1] < 0.5:
            spans[-1][1] = t_
        else:
            spans.append([t_, t_])
    bl = []
    for t_ in blank:
        if bl and t_ - bl[-1][1] < 2.5 / ofps:
            bl[-1][1] = t_
        else:
            bl.append([t_, t_])
    scroll_t = [round(e["t"] - (t_from or 0), 3) for e in ev["events"] if e["type"] == "scroll"]
    json.dump({"f0": f0, "moves": keys, "bubble_hide": spans, "held_blank_frames": len(held_src), "blank": [b_ for b_ in bl if b_[1] - b_[0] >= 0.5],
               "scrolls": scroll_t,
               "params": p}, open(str(out) + ".camera.json", "w"), indent=1)
    return keys


if __name__ == "__main__":
    args = sys.argv[1:]
    opt = {k: args[args.index(k) + 1] for k in ("--size", "--from", "--to", "--fps") if k in args}
    size = tuple(int(v) for v in opt.get("--size", "1920x1080").split("x"))
    keys = render(args[0], args[1], size, float(opt["--from"]) if "--from" in opt else None,
                  float(opt["--to"]) if "--to" in opt else None, out_fps=float(opt["--fps"]) if "--fps" in opt else None)
    print(json.dumps({"keys": len(keys)}))
