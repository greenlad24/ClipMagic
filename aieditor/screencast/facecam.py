"""Facecam bubble assets (reference 2: the presenter in a circle, top-right, over screencasts).

    python3 facecam.py face  <video> <out.json> [--samples 24]        → median face box
    python3 facecam.py assets <diameter> <ring_px> <ring_hex> <outdir> → mask.png + ring.png

The bubble's crop is a square around the median face box (head + shoulders), so the
presenter sits in the circle the way the reference frames him. Geometry (size, position,
ring) comes from motion/keyframes.json["screencast"]["facecam"] when measured; colours
are style.
"""
import json
import subprocess
import sys

import cv2
import numpy as np

CASCADE = "/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml"


def face_box(video, samples=24):
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                               capture_output=True, text=True).stdout)
    det = cv2.CascadeClassifier(CASCADE)
    boxes, size = [], None
    for k in range(samples):
        t = dur * (k + 0.5) / samples
        buf = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", video, "-frames:v", "1",
                              "-vf", "scale=960:-2", "-f", "image2pipe", "-vcodec", "png", "-"],
                             capture_output=True).stdout
        img = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        size = img.shape[::-1]
        found = det.detectMultiScale(img, 1.1, 6, minSize=(60, 60))
        if len(found):
            boxes.append(max(found, key=lambda b: b[2] * b[3]))
    if not boxes:
        raise RuntimeError("no face found")
    b = np.median(np.array(boxes, np.float64), axis=0)
    # back to fractions of the frame, so it applies at any resolution
    return {"face": [b[0] / size[0], b[1] / size[1], b[2] / size[0], b[3] / size[1]], "found": len(boxes),
            "samples": samples}


def bubble_crop(face, W, H, head_scale=2.6, up=0.18):
    """Square crop (x, y, side) in px around the face: head_scale × face height, the face
    slightly above centre (up × side) so shoulders show — like the reference bubble."""
    fx, fy, fw, fh = face[0] * W, face[1] * H, face[2] * W, face[3] * H
    side = min(H, fh * head_scale)
    cx, cy = fx + fw / 2, fy + fh / 2 + up * side
    x = min(max(0, cx - side / 2), W - side)
    y = min(max(0, cy - side / 2), H - side)
    return int(x) // 2 * 2, int(y) // 2 * 2, int(side) // 2 * 2


def assets(scale, outdir, video_d=344.6, outer_d=358.6, ring_l="#000357", ring_r="#4117C9",
           shadow_sigma=7.0, shadow_alpha=0.3):
    """Reference 2 bubble at 1080p × scale: mask.png (the video disc, video_d) and
    ring.png (outer_d ring with a left→right gradient + faint shadow), both on a canvas of
    side outer_d + 2·pad, centred — overlay the composite at centre − side/2."""
    ss = 4
    pad = int(np.ceil(3 * shadow_sigma * scale)) + 2
    side = int(np.ceil(outer_d * scale)) + 2 * pad
    side += side % 2
    c = side / 2
    yy, xx = np.mgrid[0:side * ss, 0:side * ss] / ss
    r = np.hypot(xx - c + 0.5 / ss, yy - c + 0.5 / ss)
    ro, ri = outer_d * scale / 2, video_d * scale / 2
    disc = cv2.resize((r <= ri).astype(np.float32), (side, side), interpolation=cv2.INTER_AREA)
    ring = cv2.resize(((r <= ro) & (r > ri)).astype(np.float32), (side, side), interpolation=cv2.INTER_AREA)
    outer = cv2.resize((r <= ro).astype(np.float32), (side, side), interpolation=cv2.INTER_AREA)
    sh = cv2.GaussianBlur(outer, (0, 0), shadow_sigma * scale) * shadow_alpha
    hexrgb = lambda h: np.array([int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], np.float32)
    u = np.clip((np.arange(side) - (c - ro)) / (2 * ro), 0, 1)[None, :, None]
    grad = hexrgb(ring_l) * (1 - u) + hexrgb(ring_r) * u                      # side × 3 (RGB)
    rgb = np.zeros((side, side, 3), np.float32) + grad * 1.0
    a_ring = ring
    a_sh = sh * (1 - outer)                                                   # shadow only outside the ring
    alpha = a_ring + a_sh * (1 - a_ring)
    col = (rgb * a_ring[..., None]) / np.maximum(alpha[..., None], 1e-6)     # shadow is black
    img = np.zeros((side, side, 4), np.uint8)
    img[..., :3] = np.clip(col[..., ::-1], 0, 255).astype(np.uint8)
    img[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    cv2.imwrite(f"{outdir}/ring.png", img)
    cv2.imwrite(f"{outdir}/mask.png", (disc * 255).astype(np.uint8))
    return side


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "face":
        n = int(a[a.index("--samples") + 1]) if "--samples" in a else 24
        json.dump(face_box(a[1], n), open(a[2], "w"))
        print(open(a[2]).read())
    elif a[0] == "assets":
        print(json.dumps({"side": assets(float(a[1]), a[2])}))
