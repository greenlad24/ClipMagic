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
    zx0, zy0, zx1, zy1 = p["bubble_zone"]
    ax0, ay0, ax1, ay1 = (x - l) / vw, (y - t) / vh, (x + bw - l) / vw, (y + bh - t) / vh
    ov = max(0.0, min(ax1, zx1) - max(ax0, zx0)) * max(0.0, min(ay1, zy1) - max(ay0, zy0))
    clear = ov / max(1e-6, (ax1 - ax0) * (ay1 - ay0)) < 0.08
    return bool(inside and clear)


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
            if z1 > z0 + 0.02:
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
        for m in ms:
            f_ = target_fit(m, ev["capture"]["w"], ev["capture"]["h"], cp)
            if f_ is not None:
                fits.append(f_)
        # holds: from the end of a move to the start of the next move/cut (or the span end)
        times.sort()
        for (s0, d0), (s1, _) in zip(times, times[1:] + [(dur, 0)]):
            holds.append(max(0.0, s1 - (s0 + d0)))
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
        "hold_median_s": round(st.median(holds), 2) if holds else 0.0,
        "short_holds_pct": round(100 * sum(h < 1.5 for h in holds) / len(holds), 1) if holds else 0.0,
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
    return m


# ── scoring ────────────────────────────────────────────────────────────────────────────────
def score(metrics):
    q = system()["qa"]
    rows, wsum, ssum = [], 0.0, 0.0
    for name, spec in q["metrics"].items():
        if name not in metrics:
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
    txt = json.dumps(res, indent=1)
    if out:
        Path(out).write_text(txt)
    print(txt)


if __name__ == "__main__":
    main(sys.argv[1:])
