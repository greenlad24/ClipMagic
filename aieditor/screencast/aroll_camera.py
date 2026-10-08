"""A-roll camera of reference 2 (kwys-annotations-layouts.json C_camera), sub-pixel:

  · the video OPENS zoomed 1.548× and eases out to 1.0 over 31 f, bezier(.089,.443,.126,.834)
    on log scale;
  · every A-roll BLOCK (between screencasts) pushes in linearly ~1.8 %/s from 1.0,
    capped at 1.124× (it runs across jump cuts — they are inside the block);
  · the last 30 f fade to black.
ffmpeg's zoompan rounds the crop to whole pixels and judders on a 1.8 %/s push, so this
warps each frame with cv2 (INTER_CUBIC) instead.

    python3 aroll_camera.py <in.mp4> <out.mp4> <blocks.json> [--anchor x,y]
blocks.json = {"blocks": [[t0, t1], ...] (A-roll spans, output seconds), "fps": 29.97}
"""
import json
import subprocess
import sys

import cv2
import numpy as np

from camera import bezier

OPEN_ZOOM, OPEN_FRAMES, OPEN_EASE = 1.548, 31, (0.089, 0.443, 0.126, 0.834)
# ROUND 3 (review N12, TECHNIQUES AR01): ~1–3 %/s from 1.00, capping ×1.12–1.16 (ref 3 0:08–0:13 1.00 → 1.14,
# ≈2.8 %/s; ref 2 1.8 %/s) → 2.2 %/s, cap 1.14. (Endpoint check, round 2: edit vs base at 39.0 s = ×1.119 — the
# push ran; the reviewer's frame-to-frame ORB sum under-reads a 0.06 %/frame scale.)
PUSH_PER_S, PUSH_CAP = 0.022, 1.14
# CUT07 (refs 3–5): A-roll jump cuts alternate the base medium framing and a ~1.3–1.5× close-up about the face
PUNCH = 1.32
HOLD_AFTER_S = 0.3     # N09: the block's last framing holds through the screencast's dissolve-in (no snap to 1.0)
FADE_FRAMES = 30
REF_FPS = 30000 / 1001


def zoom_at(t, blocks, fps, cuts=()):
    ease = bezier(*OPEN_EASE)
    z = 1.0
    if t * REF_FPS < OPEN_FRAMES:
        u = ease(t * REF_FPS / OPEN_FRAMES)
        z = OPEN_ZOOM ** (1 - u)                         # log-scale ease from 1.548 to 1
    for a, b in blocks:
        if a <= t < b + HOLD_AFTER_S:
            tt = min(t, b - 1e-3)
            z *= min(PUSH_CAP, 1 + PUSH_PER_S * (tt - a))
            # CUT07: every jump cut inside the block toggles medium ↔ close-up (the first shot is medium)
            n = sum(1 for c in cuts if a + 0.05 < c <= tt)
            if n % 2 == 1:
                z *= PUNCH
            break
    return z


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
        z = zoom_at(t, blocks, fps, cuts)
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
