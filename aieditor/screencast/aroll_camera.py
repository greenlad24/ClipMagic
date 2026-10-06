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
PUSH_PER_S, PUSH_CAP = 0.018, 1.124
FADE_FRAMES = 30
REF_FPS = 30000 / 1001


def zoom_at(t, blocks, fps):
    ease = bezier(*OPEN_EASE)
    z = 1.0
    if t * REF_FPS < OPEN_FRAMES:
        u = ease(t * REF_FPS / OPEN_FRAMES)
        z = OPEN_ZOOM ** (1 - u)                         # log-scale ease from 1.548 to 1
    for a, b in blocks:
        if a <= t < b:
            z *= min(PUSH_CAP, 1 + PUSH_PER_S * (t - a))
            break
    return z


def main(src, dst, blocks_path, anchor=None):
    spec = json.load(open(blocks_path))
    blocks, fps = spec["blocks"], spec["fps"]
    w, h = (int(v) for v in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=width,height", "-of", "csv=p=0", src], capture_output=True, text=True).stdout.strip().split(","))
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
                               capture_output=True, text=True).stdout)
    ax, ay = anchor or (w / 2, h / 2)
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
        z = zoom_at(t, blocks, fps)
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
