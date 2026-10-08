"""Screencast QA — how close a rendered edit's screencasts are to reference 2 (kwysV2smgfY).

Runs inside the aieditor-screencast image (numpy + cv2 + ffmpeg):

    python3 qa.py edit <edit-NN dir> <edit-NN.mp4> [--out qa.json]   score a full edit
    python3 qa.py ref [--out ref.json]                                 re-measure the reference's frame metrics

Every metric is measured the SAME way on both sides where a video is involved (frame-level
blank / sparse screens), or read from the camera plan where the reference was measured
frame by frame (moves, zoom levels, holds — kwys-screencast.json). The reference values and
the tolerance bands live in motion/screencast_system.json ["qa"] (SYSTEM.md explains them).

Score per metric: 100 inside the band, then exp decay with the metric's `scale` outside it;
the total is the weighted mean. Content correctness (does the screen show what he says?) is
NOT measurable here — that is the frame review in SYSTEM.md §7.
"""
import json
import math
import statistics as st
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import camera  # noqa: E402

SYSTEM = HERE.parent / "motion" / "screencast_system.json"
REF_VIDEO = Path("/opt/aieditor-work/reference/kwysV2smgfY/video.mp4")


def system():
    return json.loads(SYSTEM.read_text())


# ── frame-level metrics (same code for the reference and for an edit) ─────────────────────
def _frames(video, spans, fps_sample=2.0, w=160, h=90):
    """Yield (t, rgb small frame) for samples inside spans [(t0, t1)] of a video."""
    for t0, t1 in spans:
        if t1 - t0 < 0.3:
            continue
        cmd = ["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", str(video),
               "-vf", f"fps={fps_sample},scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        buf = subprocess.run(cmd, capture_output=True, check=True).stdout
        n = len(buf) // (w * h * 3)
        arr = np.frombuffer(buf[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)
        for i in range(n):
            yield t0 + i / fps_sample, arr[i]


def content_share(img, bubble=(0.75, 0.0, 1.0, 0.46)):
    """Share of the frame (bubble zone masked) that differs from its dominant flat colour."""
    h, w = img.shape[:2]
    q = (img // 8).reshape(-1, 3).astype(np.int32)
    key = q[:, 0] * 1024 + q[:, 1] * 32 + q[:, 2]
    vals, cnt = np.unique(key, return_counts=True)
    bg = vals[cnt.argmax()]
    bgc = np.array([bg // 1024, (bg // 32) % 32, bg % 32]) * 8 + 4
    diff = np.abs(img.astype(np.int32) - bgc).max(axis=2) > 10
    mask = np.ones((h, w), bool)
    mask[int(bubble[1] * h):int(bubble[3] * h), int(bubble[0] * w):int(bubble[2] * w)] = False
    return float(diff[mask].mean())


def frame_metrics(video, spans):
    shares, n = [], 0
    for _, img in _frames(video, spans):
        shares.append(content_share(img))
        n += 1
    if not shares:
        return {"blank_pct": 0.0, "sparse_pct": 0.0, "samples": 0}
    sy = system()["qa"]["frame"]
    return {"blank_pct": round(100 * sum(s < sy["blank_share"] for s in shares) / n, 2),
            "sparse_pct": round(100 * sum(s < sy["sparse_share"] for s in shares) / n, 2),
            "content_median": round(st.median(shares), 3), "samples": n}


# ── camera-plan metrics of an edit ─────────────────────────────────────────────────────────
def _camera_series(cam, ev, dur, fps):
    """Per-output-frame zoom of one clip from its camera.json (same evaluator as the render)."""
    p = camera.params()
    p.update({k: v for k, v in cam.get("params", {}).items() if k in p})
    eases = camera.make_eases(p)
    W, H = ev["capture"]["w"], ev["capture"]["h"]
    cfps = ev["capture"]["fps"]
    f0 = cam.get("f0", 0)
    moves = [tuple(m) for m in cam["moves"]]
    out = []
    for o in range(int(dur * fps)):
        f = f0 + o / fps * cfps
        out.append(camera.camera_at(moves, f, p, eases, W, H)[0])
    return out


def target_fit(m, W, H, p):
    """A framed target (move end view + its box) is fully in view and clear of the facecam zone
    (SYSTEM.md §3a). None when the move has no target box."""
    if len(m) < 6 or not m[5] or m[3][0] <= 1.0:
        return None
    z, cx, cy = m[3]
    vw, vh = W / z, H / z
    l, t = cx - vw / 2, cy - vh / 2
    x, y, bw, bh = m[5]
    inside = x >= l - 0.01 * vw and x + bw <= l + 1.01 * vw and y >= t - 0.01 * vh and y + bh <= t + 1.01 * vh
    # the facecam zone no longer counts (Jake 2026-10-07: the bubble stays put, the subject is
    # centred even if part of it runs under the bubble)
    return bool(inside)


def subject_offset(m, W, H):
    """Distance of a framed target's centre from the frame centre after the move, in frame units
    (hypot(dx/W, dy/H) of the output) — Jake #1 centre-middle. None without a target box."""
    if len(m) < 6 or not m[5] or m[3][0] <= 1.0:
        return None
    z, cx, cy = m[3]
    x, y, bw, bh = m[5]
    return math.hypot((x + bw / 2 - cx) * z / W, (y + bh / 2 - cy) * z / H)


def centre_excess(m, W, H):
    """How much further from the centre the target ended than the page edge forced: 0 = centred as
    well as the capture allows (a sidebar item or a top-bar button cannot reach the middle without
    showing past the page). Measures the camera's compliance with Jake #1, not the page layout."""
    o = subject_offset(m, W, H)
    if o is None:
        return None
    z = m[3][0]
    x, y, bw, bh = m[5]
    _, icx, icy = camera.clamp(z, x + bw / 2, y + bh / 2, W, H)
    best = math.hypot((x + bw / 2 - icx) * z / W, (y + bh / 2 - icy) * z / H)
    return max(0.0, o - best)


# ── frame checks shared with the references (sc6 measurement scripts) ──────────────────────
RING = (1701.9, 253.7, 175.6)          # facecam ring centre + radius at 1080p (compose_long FACECAM)


def _decode(video, t0, n, w, h, fmt="rgb24"):
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{max(0, t0):.3f}", "-i", str(video), "-frames:v", str(n),
           "-vf", f"scale={w}:{h}:flags=area", "-f", "rawvideo", "-pix_fmt", fmt, "-"]
    buf = subprocess.run(cmd, capture_output=True, check=True).stdout
    c = 3 if fmt == "rgb24" else 1
    k = len(buf) // (w * h * c)
    return np.frombuffer(buf[: k * w * h * c], np.uint8).reshape((k, h, w, c) if c == 3 else (k, h, w))


def ring_blue(img):
    """Share of the ring's circle that shows the ring's blue (pass1.py's test, RGB order)."""
    h, w = img.shape[:2]
    s = w / 1920
    ang = np.linspace(0, 2 * np.pi, 360, endpoint=False)
    xs = np.clip((RING[0] + RING[2] * np.cos(ang)) * s, 0, w - 1).astype(int)
    ys = np.clip((RING[1] + RING[2] * np.sin(ang)) * s, 0, h - 1).astype(int)
    px = img[ys, xs].astype(np.int16)
    return float((((px[:, 2] - px[:, 1]) > 60) & (px[:, 2] > 100)).mean())


def _bubble_mask(w, h):
    yy, xx = np.mgrid[0:h, 0:w]
    return np.hypot(xx - RING[0] * w / 1920, yy - RING[1] * h / 1080) > (185 * w / 1920 + 2)


def edge_centroid(g):
    """Edge-weighted content centroid of a 160x90 grey frame (bubble masked) → distance from the
    centre in frame units — the same measure as the references' 0.10 median."""
    im = g.astype(np.float32)
    gx = np.abs(np.diff(im, axis=1))[:-1, :]
    gy = np.abs(np.diff(im, axis=0))[:, :-1]
    e = gx + gy
    e[~_bubble_mask(160, 90)[:-1, :-1]] = 0
    e[e < 12] = 0
    if e.sum() < 10:
        return None
    Y, X = np.mgrid[0:89, 0:159]
    return math.hypot((e * X).sum() / e.sum() / 159 - 0.5, (e * Y).sum() / e.sum() / 89 - 0.5)


def transition_shape(video, t, kind, fps):
    """Bubble opacity and screen blend weight per frame across a screencast ↔ A-roll boundary.
    ok = the bubble fade is short (≤ 6 f) and comes FIRST on exit / LAST on entry, and the screen
    change is a dissolve of 4–20 f (Jake #5) — a 1-frame cut of both is 'hard'."""
    n0 = 14
    rgb = _decode(video, t - n0 / fps, 2 * n0 + 1, 960, 540)
    if len(rgb) < 10:
        return None
    grey = np.array([np.dot(f[::6, ::6, :3], [0.299, 0.587, 0.114]) for f in rgb])
    m = _bubble_mask(grey.shape[2], grey.shape[1])
    A, B = grey[0], grey[-1]
    D = B - A
    den = max(float((D[m] ** 2).sum()), 1.0)
    w = [float(((g - A)[m] * D[m]).sum() / den) for g in grey]
    rb = [ring_blue(f) for f in rgb]
    side = rb[:6] if kind == "out" else rb[-6:]          # the bubble's own plateau (screencast side)
    plat = float(np.median(side)) or max(rb) or 1.0
    ring = [min(1.0, r / plat) for r in rb]

    def first(xs, pred):
        return next((i for i, v in enumerate(xs) if pred(v)), None)
    ss, se = first(w, lambda v: v > 0.06), first(w, lambda v: v > 0.94)
    if kind == "out":
        rs, rg = first(ring, lambda v: v < 0.93), first(ring, lambda v: v <= 0.07)
    else:
        rs, rg = first(ring, lambda v: v > 0.07), first(ring, lambda v: v >= 0.93)
    res = {"t": round(t, 2), "kind": kind, "ring": [round(v, 2) for v in ring], "w": [round(v, 2) for v in w]}
    if None in (ss, se, rs, rg):
        res["ok"] = False
        return res
    res.update(bubble_frames=rg - rs, screen_frames=se - ss)
    if kind == "out":
        w_at_gone = w[rg]
        res["bubble_first"] = w_at_gone <= 0.6
    else:
        res["bubble_first"] = w[rs] >= 0.4           # entry: the screencast is in before the bubble
    res["max_step"] = round(max(b - a for a, b in zip(w, w[1:])), 2)
    # loop round 1: the screen dissolve is 4 f (TR05 order; CUT04/CUT05 ≈ 99 % hard in refs 2–5; review v12 #13
    # — 10 f ghosted the face), which the 0.06→0.94 test reads as ~3 f → band 2–8 f
    res["ok"] = bool(1 <= res["bubble_frames"] <= 6 and 2 <= res["screen_frames"] <= 8 and res["bubble_first"]
                     and res["max_step"] <= 0.5)
    return res


def edit_metrics(edit_dir, video):
    edit_dir = Path(edit_dir)
    plan = json.loads((edit_dir / "direct.json").read_text())["plan"]
    blocks = json.loads((edit_dir / "blocks.json").read_text())
    fps = blocks.get("fps", 30000 / 1001)
    total = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                                 capture_output=True, text=True).stdout.strip() or 0)
    # screencast spans = complement of the A-roll blocks
    spans, t = [], 0.0
    for a, b in blocks["blocks"]:
        if a > t + 0.05:
            spans.append((t, a))
        t = b
    if total > t + 0.05:
        spans.append((t, total))
    sc_dur = sum(b - a for a, b in spans)
    zin, holds, cuts, n_moves, zoom_series, deep = [], [], 0, 0, [], 0
    offs, move_end_t, n_events, hide_spans, excess = [], [], 0, [], []
    pans, pan_frames, pan_peaks, n_xf, xf_frames, hard_page, fits = 0, [], [], 0, [], 0, []
    cp = camera.params()
    for i, seg in enumerate(plan["segments"]):
        cam_p = edit_dir / f"sc-{i:02d}-1920.mp4.camera.json"
        ev_p = edit_dir / f"seg-{i:02d}" / "rec" / "events.json"
        if not cam_p.exists() or not ev_p.exists():
            continue
        cam, ev = json.loads(cam_p.read_text()), json.loads(ev_p.read_text())
        span = next(((a, b) for a, b in spans if abs(a - seg["t0"]) < 0.6), None)
        if span is None:
            continue
        dur = span[1] - span[0]
        cfps = ev["capture"]["fps"]
        f0 = cam.get("f0", 0)
        ms = [m for m in cam["moves"] if (m[0] - f0) / cfps < dur]
        times = []
        for m in ms:
            if m[1] <= 0:                                   # a hard cut (page change): the reference's
                continue                                    # holds run across its in-span jump cuts
            n_moves += 1
            z0, z1 = m[2][0], m[3][0]
            # a pan = a move at constant zoom (older plans labelled them "in")
            if m[4] == "pan" or (z0 > 1.05 and abs(math.log(z1 / z0)) < 0.03
                                 and math.hypot(m[3][1] - m[2][1], m[3][2] - m[2][2]) > 1):
                pans += 1
                pan_frames.append(m[1] / cfps * camera.REF_FPS)
                # peak screen speed of the eased pan (output px @1080p per second)
                W_, H_ = ev["capture"]["w"], ev["capture"]["h"]
                dist = math.hypot(m[3][1] - m[2][1], m[3][2] - m[2][2]) * z0 * 1080 / H_
                ease = camera.bezier(*cp["pan_ease"])
                us = [ease(j / 200) for j in range(201)]
                vmax = max(b - a for a, b in zip(us, us[1:])) * 200 / (m[1] / cfps)
                pan_peaks.append(dist * vmax)
            if z1 > z0 + 0.02 and m[4] != "drift":
                zin.append(z1)
                deep += z1 > 1.6 + 1e-6
            times.append(((m[0] - f0) / cfps, m[1] / cfps))
        cuts += sum(1 for e in ev["events"] if e["type"] in ("cut", "nav") and 0.05 < e["t"] < dur)
        xfs = [x for x in cam.get("xfades", []) if 0 <= x[0] < dur]
        n_xf += len(xfs)
        xf_frames += [x[1] for x in xfs]
        xf_t = [x[0] for x in xfs]
        # full-screen changes that stayed HARD cuts (page changes without a dissolve)
        hard_page += sum(1 for t_ in camera.page_changes(ev) if 0.05 < t_ < dur and not any(abs(t_ - x) < 0.05 for x in xf_t))
        W_, H_ = ev["capture"]["w"], ev["capture"]["h"]
        for m in ms:
            f_ = target_fit(m, W_, H_, cp)
            if f_ is not None:
                fits.append(f_)
            o_ = subject_offset(m, W_, H_)
            if o_ is not None:
                offs.append(o_)
                excess.append(centre_excess(m, W_, H_))
                move_end_t.append(span[0] + (m[0] + max(m[1], 0) - f0) / cfps + 0.15)
        # STATIC holds (Jake #2): screencast time with no camera move, no cut, no dissolve, no scroll /
        # canvas pan / live typing — the same events the references' 854 holds were cut at
        busy = sorted(((a_ - f0) / cfps, (b_ - f0) / cfps) for a_, b_ in camera.busy_spans([tuple(m) for m in cam["moves"]], ev, cfps, f0, cp))
        cur = 0.0
        for a_, b_ in busy:
            if a_ >= dur:
                break
            if a_ > cur:
                holds.append(a_ - cur)
            cur = max(cur, b_)
        if dur > cur:
            holds.append(dur - cur)
        n_events += sum(1 for m in ms if m[1] > 0 or m[4] in ("cut", "xfade"))
        n_events += sum(1 for e in ev["events"] if e["type"] in ("cut", "nav") and 0.05 < e["t"] < dur)
        hide_spans += [(span[0] + a_, span[0] + b_) for a_, b_ in cam.get("bubble_hide", [])]
        zoom_series += _camera_series(cam, ev, dur, fps)
    mins = sc_dur / 60 if sc_dur else 1
    m = {
        "screencast_share_pct": round(100 * sc_dur / total, 1) if total else 0,
        "span_median_s": round(st.median([b - a for a, b in spans]), 1) if spans else 0,
        "moves_per_min": round(n_moves / mins, 2),
        "zoom_in_median": round(st.median(zin), 3) if zin else 1.0,
        "deep_zoom_pct": round(100 * deep / len(zin), 1) if zin else 0.0,
        "time_zoomed_pct": round(100 * sum(z > 1.05 for z in zoom_series) / len(zoom_series), 1) if zoom_series else 0,
        "mean_zoom": round(sum(zoom_series) / len(zoom_series), 3) if zoom_series else 1.0,
        "static_hold_p50_s": round(_q(holds, 50), 2) if holds else 0.0,
        "static_hold_p90_s": round(_q(holds, 90), 2) if holds else 0.0,
        "static_hold_max_s": round(max(holds), 2) if holds else 0.0,
        "motion_events_per_min": round(n_events / mins, 2),
        "subject_centre_median": round(st.median(offs), 3) if offs else 0.0,
        "subject_centre_p75": round(_q(offs, 75), 3) if offs else 0.0,
        "centre_excess_p90": round(_q(excess, 90), 3) if excess else 0.0,
        "cuts_per_min": round(cuts / mins, 2),
        "pans_per_min": round(pans / mins, 2),
        "pan_frames_median": round(st.median(pan_frames), 1) if pan_frames else 0.0,
        "pan_peak_px_s": round(st.median(pan_peaks)) if pan_peaks else 0,
        "dissolve_share_pct": round(100 * n_xf / (n_xf + hard_page), 1) if n_xf + hard_page else 0.0,
        "dissolve_frames_median": round(st.median(xf_frames), 1) if xf_frames else 0.0,
        "target_fit_pct": round(100 * sum(fits) / len(fits), 1) if fits else 100.0,
    }
    # a curve/length metric only means something when the edit has that event at all
    for k_, n_ in (("pan_frames_median", pans), ("pan_peak_px_s", pans), ("dissolve_frames_median", n_xf)):
        if not n_:
            m.pop(k_)
    m.update(frame_metrics(video, spans))
    m.update(rule_frame_metrics(edit_dir, video, spans, move_end_t, hide_spans, fps, total))
    return m


def _q(xs, pct):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * pct / 100))]


def rule_frame_metrics(edit_dir, video, spans, move_end_t, hide_spans, fps, total):
    """Frame checks for Jake's review rules, measured on the rendered video:
    - frame_centroid_median: edge centroid after each framing move (refs 2–5 median 0.10);
    - bubble_constant_pct: the ring at its exact place on screencast frames (2 fps), except while an
      action under it hides it and within 0.5 s of a span edge;
    - aroll_transition_ok_pct: every screencast ↔ A-roll boundary is bubble-first + a short dissolve;
    - text_gradient_pct: every text overlay darkens the bottom band (away from the text) by > 20 %."""
    out, details = {}, {}
    cents = []
    for t in move_end_t:
        g = _decode(video, t, 1, 160, 90, "gray")
        if len(g):
            c = edge_centroid(g[0])
            if c is not None:
                cents.append(c)
    if cents:
        out["frame_centroid_median"] = round(st.median(cents), 3)
    # bubble constancy
    n = ok = 0
    for a, b in spans:
        a2, b2 = a + 0.5, b - 0.5
        if b2 - a2 < 0.5:
            continue
        ffps = 2.0
        cmd = ["ffmpeg", "-v", "error", "-ss", f"{a2:.3f}", "-t", f"{b2 - a2:.3f}", "-i", str(video),
               "-vf", f"fps={ffps},scale=960:540:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        buf = subprocess.run(cmd, capture_output=True, check=True).stdout
        k = len(buf) // (960 * 540 * 3)
        frames = np.frombuffer(buf[: k * 960 * 540 * 3], np.uint8).reshape(k, 540, 960, 3)
        for i, f in enumerate(frames):
            t = a2 + i / ffps
            if any(x - 0.5 <= t <= y + 0.6 for x, y in hide_spans):
                continue
            n += 1
            ok += ring_blue(f) >= 0.45
    if n:
        out["bubble_constant_pct"] = round(100 * ok / n, 1)
    # screencast <-> A-roll transitions
    blocks = json.loads((Path(edit_dir) / "blocks.json").read_text())["blocks"]
    trans = []
    for a, b in spans:
        if a > 0.3:
            trans.append(transition_shape(video, a, "in", fps))
        if b < total - 0.3:
            trans.append(transition_shape(video, b, "out", fps))
    trans = [x for x in trans if x]
    if trans:
        out["aroll_transition_ok_pct"] = round(100 * sum(x["ok"] for x in trans) / len(trans), 1)
        details["transitions"] = trans
    # text gradient
    ov_p = Path(edit_dir) / "overlays.json"
    grads = []
    if ov_p.exists():
        for ev in json.loads(ov_p.read_text()):
            if ev.get("template") not in ("lower_title", "link", "keyword", "list", "number"):
                continue
            nfr = len(list((Path(edit_dir) / "gfx" / ev["frames_dir"]).glob("f*.png"))) if (Path(edit_dir) / "gfx" / ev["frames_dir"]).exists() else 0
            a = ev["start_frame"] / fps
            b = a + (nfr / fps if nfr else ev["t1"] - ev["t0"])
            mid = a + 0.55 * (b - a)
            ref_t = None
            for cand in (b + 0.45, a - 0.45):
                if 0 < cand < total and any(x <= cand <= y for x, y in blocks) and not any(x <= cand <= y for x, y in spans):
                    ref_t = cand
                    break
            if ref_t is None:
                continue
            g1 = _decode(video, mid, 1, 160, 90, "gray")
            g0 = _decode(video, ref_t, 1, 160, 90, "gray")
            if not len(g1) or not len(g0):
                continue
            band = (slice(77, 90), np.r_[0:24, 136:160])
            r = float(g1[0][band].mean() + 1) / float(g0[0][band].mean() + 1)
            grads.append({"t": round(a, 2), "template": ev["template"], "ratio": round(r, 2), "ok": r < 0.8})
    if grads:
        out["text_gradient_pct"] = round(100 * sum(x["ok"] for x in grads) / len(grads), 1)
        details["gradients"] = grads
    out["_details"] = details
    return out


# ── scoring ────────────────────────────────────────────────────────────────────────────────
def score(metrics):
    q = system()["qa"]
    rows, wsum, ssum = [], 0.0, 0.0
    for name, spec in q["metrics"].items():
        if name not in metrics or not isinstance(metrics[name], (int, float)):
            continue
        v = metrics[name]
        lo, hi = spec["band"]
        dist = 0.0 if lo <= v <= hi else (lo - v if v < lo else v - hi)
        s = 100 * math.exp(-dist / spec["scale"])
        rows.append({"metric": name, "value": v, "reference": spec["ref"], "band": spec["band"], "score": round(s, 1)})
        wsum += spec["weight"]
        ssum += spec["weight"] * s
    return {"score": round(ssum / wsum, 1) if wsum else 0, "rows": rows}


def ref_frame_metrics():
    """Blank/sparse share of reference 2's screencast spans (spans = the facecam bubble shown)."""
    spans = system()["qa"]["reference_spans_s"]
    return frame_metrics(REF_VIDEO, [tuple(s) for s in spans])


def main(argv):
    out = argv[argv.index("--out") + 1] if "--out" in argv else None
    if argv[0] == "ref":
        res = ref_frame_metrics()
    else:
        m = edit_metrics(argv[1], argv[2])
        res = {"metrics": m, **score(m)}
        # ROUND 2 ruling (review round 1 root cause 7): an out-of-band metric FAILS the round — it is
        # not a soft score any more (round 1 reported pan peak 1283 px/s and 17.5 moves/min and passed)
        bad = [r["metric"] for r in res.get("rows", []) if r.get("score", 100) < 100]
        res["out_of_band"] = bad
        res["verdict"] = "PASS" if not bad else "FAIL"
    txt = json.dumps(res, indent=1)
    if out:
        Path(out).write_text(txt)
    print(txt)
    if res.get("verdict") == "FAIL":
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
