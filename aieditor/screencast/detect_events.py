"""Screencast → events.json, from the PICTURE alone (Jake 2026-10-14: a Lab web tool that takes an editor's
timeline and "detects screencasts … and zooms them … exactly based on our motion/design system"). A screencast
the editor recorded has no recorder log, so this reads what camera.py needs from the video itself:

    nav     the page changed (most of the frame changed at once)          → camera.page_states (reset / xfade)
    scroll  the page slid vertically (phase correlation of the frame)      → zoom out before / keep framing
    type    small changes marching along one text line                     → typing at ×1.00 (K1), box = the field
    click   a local change after a still moment, on its own                → a camera target (abox = what changed)

Runs inside the aieditor-screencast image (numpy + cv2 + ffmpeg):

    python3 detect_events.py <video> <out events.json> [--from S --to S] [--fps 10]

The output has the shape record.mjs writes ({capture, events, end, cursor: []}) with times on the CLIP clock
(0 = --from), so camera.plan_offline() plans it unchanged. Boxes are in SOURCE pixels.
"""
import json
import subprocess
import sys

import cv2
import numpy as np

ANALYSIS_W = 960            # frames are read at this width (speed); boxes are scaled back to source pixels
NAV_FRAC = 0.32             # changed share of the frame that means a new page
SCROLL_MIN_PX = 6           # (analysis px) a vertical shift this big, correlated, is a scroll
LOCAL_MIN_AREA = 0.00025    # a change smaller than this share of the frame is noise / the cursor
CURSOR_MAX_AREA = 0.0015    # a lone change this small that MOVES is the cursor, never a target
STILL_S = 0.35              # a click target follows at least this much stillness
TYPE_GAP_S = 0.9            # changes on one line no further apart than this belong to one typing run
TYPE_MIN_STEPS = 3          # …and at least this many of them


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate", "-of", "json", path], capture_output=True, text=True, check=True)
    s = json.loads(out.stdout)["streams"][0]
    num, den = (int(x) for x in s["r_frame_rate"].split("/"))
    return int(s["width"]), int(s["height"]), num / den


def frames(path, t0, t1, fps, w, h):
    """Gray frames (ANALYSIS_W wide) at `fps` between t0 and t1 — one ffmpeg pipe, nothing on disk."""
    aw = ANALYSIS_W
    ah = int(round(h * aw / w / 2)) * 2
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}"] + (["-t", f"{t1 - t0:.3f}"] if t1 else []) + [
        "-i", path, "-vf", f"fps={fps},scale={aw}:{ah}:flags=area,format=gray", "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = aw * ah
    i = 0
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield i / fps, np.frombuffer(buf, np.uint8).reshape(ah, aw)
        i += 1
    p.wait()


def boxes_of(mask, min_area):
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = []
    for k in range(1, n):
        x, y, bw, bh, a = stats[k]
        if a >= min_area:
            out.append((int(x), int(y), int(bw), int(bh), int(a)))
    return out


def union(bs):
    x0 = min(b[0] for b in bs); y0 = min(b[1] for b in bs)
    x1 = max(b[0] + b[2] for b in bs); y1 = max(b[1] + b[3] for b in bs)
    return (x0, y0, x1 - x0, y1 - y0)


def detect(path, t0=0.0, t1=None, fps=10.0):
    W, H, src_fps = probe(path)
    k = W / ANALYSIS_W
    prev = None
    still_since = 0.0
    raw = []                       # per step: (t, kind, box_analysis, frac)
    last_t = 0.0
    for t, g in frames(path, t0, t1, fps, W, H):
        last_t = t
        g = cv2.GaussianBlur(g, (3, 3), 0)
        if prev is None:
            prev = g
            continue
        d = cv2.absdiff(g, prev)
        _, m = cv2.threshold(d, 22, 255, cv2.THRESH_BINARY)
        frac = float(np.count_nonzero(m)) / m.size
        area = m.size
        if frac < LOCAL_MIN_AREA:
            prev = g
            continue
        if frac >= NAV_FRAC:
            # a whole-page slide is a scroll, not a new page
            (dx, dy), resp = cv2.phaseCorrelate(prev.astype(np.float32), g.astype(np.float32))
            if resp > 0.25 and abs(dy) >= SCROLL_MIN_PX and abs(dx) < 3:
                raw.append((t, "scroll", None, frac, dy))
            else:
                raw.append((t, "nav", None, frac, 0))
            still_since = t
            prev = g
            continue
        m = cv2.dilate(m, np.ones((5, 9), np.uint8))
        bs = [b for b in boxes_of(m, LOCAL_MIN_AREA * area)]
        if bs:
            # a scroll of part of the page (a chat column) also shows as a big vertical slide inside a box
            big = max(bs, key=lambda b: b[4])
            if big[4] > 0.08 * area:
                x, y, bw, bh, _ = big
                a_, b_ = prev[y:y + bh, x:x + bw].astype(np.float32), g[y:y + bh, x:x + bw].astype(np.float32)
                if bw > 32 and bh > 32:
                    (dx, dy), resp = cv2.phaseCorrelate(a_, b_)
                    if resp > 0.3 and abs(dy) >= SCROLL_MIN_PX and abs(dx) < 3:
                        raw.append((t, "scroll", big[:4], frac, dy))
                        still_since = t
                        prev = g
                        continue
            small = [b for b in bs if b[4] <= CURSOR_MAX_AREA * area]
            other = [b for b in bs if b[4] > CURSOR_MAX_AREA * area]
            if other:
                raw.append((t, "local", union(other), frac, t - still_since))
                still_since = t
            elif small:
                raw.append((t, "tiny", union(small), frac, 0))
        prev = g
    return W, H, src_fps, k, raw, last_t


def to_events(W, H, k, raw, end):
    """The raw change steps → nav / scroll / type / click events (source pixels, clip clock)."""
    ev = [{"t": 0, "type": "begin"}]
    S = lambda b: [int(round(b[0] * k)), int(round(b[1] * k)), max(3, int(round(b[2] * k))), max(3, int(round(b[3] * k)))]
    i = 0
    locals_ = [r for r in raw if r[1] == "local"]
    used = set()
    # typing: runs of local changes on one line (similar y and height), each step near the last, rightward-ish
    for a, r in enumerate(locals_):
        if a in used:
            continue
        run = [r]
        for b in range(a + 1, len(locals_)):
            q = locals_[b]
            last = run[-1]
            if q[0] - last[0] > TYPE_GAP_S:
                break
            ly, lh = last[2][1], last[2][3]
            qy, qh = q[2][1], q[2][3]
            same_line = abs((qy + qh / 2) - (ly + lh / 2)) < max(lh, qh) * 0.8 and qh < 0.12 * (H / k)
            if same_line:
                run.append(q)
                used.add(b)
        if len(run) >= TYPE_MIN_STEPS:
            used.add(a)
            box = union([x[2] for x in run])
            ev.append({"t": round(run[0][0], 3), "type": "type", "box": S(box), "abox": S(box),
                       "end": round(run[-1][0], 3), "text": "", "vis": "", "detected": True})
    for a, r in enumerate(locals_):
        if a in used:
            continue
        t, _, box, frac, still = r
        if still < STILL_S:
            continue                                   # part of something already moving
        ev.append({"t": round(max(0.0, t - 0.15), 3), "type": "click", "box": S(box), "abox": S(box), "text": "",
                   "vis": "", "at": round(t, 3), "end": round(t + 0.3, 3), "detected": True})
    for t, kind, box, frac, dy in raw:
        if kind == "nav":
            if any(e["type"] == "nav" and abs(e["t"] - t) < 1.0 for e in ev):
                continue
            ev.append({"t": round(t, 3), "type": "nav", "url": "", "fade": False, "vis": "", "detected": True})
        elif kind == "scroll":
            if any(e["type"] == "scroll" and t - e["t"] < 0.8 for e in ev):
                continue
            ev.append({"t": round(t, 3), "type": "scroll", "dy": round(float(dy) * k, 1), "detected": True,
                       **({"box": S(box)} if box else {})})
    ev.sort(key=lambda e: e["t"])
    return ev


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path, out = argv[0], argv[1]
    opt = {argv[i]: argv[i + 1] for i in range(2, len(argv) - 1, 2)}
    t0 = float(opt.get("--from", 0) or 0)
    t1 = float(opt["--to"]) if "--to" in opt else None
    fps = float(opt.get("--fps", 10))
    W, H, src_fps, k, raw, last_t = detect(path, t0, t1, fps)
    end = (t1 - t0) if t1 else last_t
    ev = to_events(W, H, k, raw, end)
    doc = {"capture": {"w": W, "h": H, "fps": src_fps, "scale": 1.0, "css": [W, H]}, "virtual_time": False,
           "pre_frames": 0, "url": "", "end": round(end, 3), "failed": None, "cursor": [], "events": ev, "walls": [],
           "detected_from_video": True}
    with open(out, "w") as f:
        json.dump(doc, f, indent=1)
    counts = {}
    for e in ev:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    print(json.dumps({"w": W, "h": H, "end": round(end, 2), "events": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
