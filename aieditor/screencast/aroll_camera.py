"""A-roll camera, sub-pixel (cv2 warp) — driven by the per-video MOTION PLAN of aroll_plan.py:

  · TR07: the video OPENS zoomed ×1.548 and eases out to 1.0 over 31 f, bezier(.089,.443,.126,.834)
    on log scale (all 4 refs: the same preset);
  · AR01: every A-roll block — and every reference-length piece of a long A-roll stretch, cut at a
    sentence start — pushes in linearly 2.25 %/s from ×1.00, capped at ×1.13 (refs 2–5 measured,
    see aroll_plan.py); jump cuts inside a piece keep the framing (refs: scale ratio 0.97–1.01);
  · AR02: ×1.22 punch while the social icons are on;
  · the last 30 f fade to black.
ffmpeg's zoompan rounds the crop to whole pixels and judders on a slow push, so this warps each
frame with cv2 (INTER_CUBIC) instead.

    python3 aroll_camera.py <in.mp4> <out.mp4> <blocks.json> [--anchor x,y]
blocks.json = {"blocks": [[t0, t1], ...] (A-roll spans, output seconds), "fps": 29.97,
               "words": [{word,start,end}, ...] (output times), "overlays": [{template,t0,t1}, ...]}
→ <out.mp4>.cuts.json (picture jump cuts found) + <out.mp4>.plan.json (the motion plan rendered)
"""
import json
import subprocess
import sys

import cv2
import numpy as np

from camera import bezier  # noqa: F401  (kept for callers)
import aroll_plan

FADE_FRAMES = 30
REF_FPS = 30000 / 1001


def zoom_at(t, plan):
    return aroll_plan.zoom_at(t, plan)


def find_cuts(src, blocks, fps):
    """Jump cuts (take changes) inside the A-roll blocks: a grey 64×36 thumbnail that changes far more than
    its neighbours (≥ 3× the local median and ≥ 2.5 grey levels)."""
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"],
                           stdout=subprocess.PIPE)
    prev, diffs = None, []
    while True:
        buf = dec.stdout.read(64 * 36)
        if len(buf) < 64 * 36:
            break
        g = np.frombuffer(buf, np.uint8).astype(np.int16)
        diffs.append(0.0 if prev is None else float(np.abs(g - prev).mean()))
        prev = g
    dec.wait()
    cuts = []
    for i, d in enumerate(diffs):
        t = i / fps
        if not any(a + 0.1 < t < b - 0.05 for a, b in blocks):
            continue
        loc = sorted(diffs[max(0, i - 8):i] + diffs[i + 1:i + 9])
        med = loc[len(loc) // 2] if loc else 0
        if d >= 2.5 and d >= 3 * max(med, 0.4):   # round 3: a same-framing take change measured 4.9 (32.83 s)
            if not cuts or t - cuts[-1] > 0.3:            # one take change = one cut
                cuts.append(round(t, 3))
    return cuts


def main(src, dst, blocks_path, anchor=None):
    spec = json.load(open(blocks_path))
    blocks, fps = spec["blocks"], spec["fps"]
    w, h = (int(v) for v in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height", "-of", "csv=p=0", src], capture_output=True, text=True).stdout.strip().split(","))
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                               capture_output=True, text=True).stdout)
    ax, ay = anchor or (w / 2, h / 2)
    cuts = find_cuts(src, blocks, fps)
    json.dump({"cuts": cuts}, open(dst + ".cuts.json", "w"))
    plan = aroll_plan.plan(blocks, spec.get("words") or [], cuts, spec.get("overlays") or [], dur)
    json.dump(plan, open(dst + ".plan.json", "w"), indent=1)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps:.6f}",
                            "-i", "-", "-i", src, "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", "-preset", "veryfast",
                            "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", dst], stdin=subprocess.PIPE)
    n_total = int(round(dur * fps))
    fade_from = n_total - FADE_FRAMES * fps / REF_FPS
    fb = w * h * 3
    n = 0
    while True:
        buf = dec.stdout.read(fb)
        if len(buf) < fb:
            break
        img = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        t = n / fps
        z = zoom_at(t, plan)
        if z > 1.0005:
            # zoom about the anchor (the presenter), kept inside the frame
            M = np.array([[z, 0, ax - z * ax], [0, z, ay - z * ay]], np.float32)
            tx = min(0.0, max(w - z * w, M[0, 2]))
            ty = min(0.0, max(h - z * h, M[1, 2]))
            M[0, 2], M[1, 2] = tx, ty
            img = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        if n >= fade_from:
            k = max(0.0, 1 - (n - fade_from) / (FADE_FRAMES * fps / REF_FPS))
            img = (img.astype(np.float32) * k).astype(np.uint8)
        enc.stdin.write(img.tobytes())
        n += 1
    enc.stdin.close()
    enc.wait()
    dec.wait()


if __name__ == "__main__":
    a = sys.argv[1:]
    anc = tuple(float(v) for v in a[a.index("--anchor") + 1].split(",")) if "--anchor" in a else None
    main(a[0], a[1], a[2], anc)
