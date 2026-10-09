"""ELASTIC ASSEMBLER — the frame side (architecture recommendation §3.5; aieditor/beatscript.py holds the map).

Runs inside the screencast image (cv2 + ffmpeg), one short-lived container per call. It never touches
audio: every output is a SCREEN clip written with -an (the narration is the edit's own track; R11).

  python3 assemble.py motion <raw.mp4> --out motion.json
        per frame: mean |gray - previous gray| on a 160x90 thumbnail (frame 0 = null)
  python3 assemble.py concat <out.mp4> --pieces pieces.json
        pieces [{"file", "file_t0", "t0", "t1"}] in segment seconds (a single-beat retake piece replaces
        its beat's window of the take); files relative to pieces.json
  python3 assemble.py render <src.mp4> --frames frames.json --out <out.mp4>
        frames.json {"frames": [source frame per output frame], "fps"} (beatscript.elastic_map)
  python3 assemble.py synth <out.mp4> --spec spec.json
        a synthetic recording for the tests: still screens with known motion windows and press flashes
  python3 assemble.py flashes <clip.mp4> --out flashes.json
        the first frame of every press flash in a synthetic clip (test read-back)
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

FPS = 30000 / 1001
THUMB = (160, 90)


def _cv2():
    import cv2
    return cv2


def frames_of(path):
    cv2 = _cv2()
    cap = cv2.VideoCapture(str(path))
    try:
        while True:
            ok, f = cap.read()
            if not ok:
                break
            yield f
    finally:
        cap.release()


def writer(out, w, h, fps=FPS):
    """ffmpeg reading raw BGR frames on stdin -> H.264, NO audio stream."""
    return subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                             "-r", f"{fps:.6f}", "-i", "-", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14",
                             "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)


def motion(path):
    cv2 = _cv2()
    out, prev = [], None
    for f in frames_of(path):
        g = cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), THUMB, interpolation=cv2.INTER_AREA).astype("int16")
        out.append(None if prev is None else round(float(abs(g - prev).mean()), 4))
        prev = g
    return out


def concat(out, pieces, base, fps=FPS):
    """Segment time [t0, t1) of each piece from its file (whose frame 0 is at file_t0)."""
    w = h = None
    p = None
    n = 0
    for pc in pieces:
        k0 = int(round((pc["t0"] - pc.get("file_t0", 0.0)) * fps))
        k1 = int(round((pc["t1"] - pc.get("file_t0", 0.0)) * fps))
        last, got = None, 0
        for k, f in enumerate(frames_of(Path(base) / pc["file"])):
            if k >= k1:
                break
            if k < k0:
                continue
            if p is None:
                h, w = f.shape[:2]
                p = writer(out, w, h, fps)
            p.stdin.write(f.tobytes())
            last = f
            got += 1
        # a piece shorter than its window (the take stopped early) holds its last frame (reported by the caller)
        while last is not None and got < k1 - k0:
            p.stdin.write(last.tobytes())
            got += 1
        n += got
    if p:
        p.stdin.close()
        p.wait()
    return n


def render(src, frames, out, fps=FPS):
    p, last = None, None
    want = list(frames)
    j = 0
    for k, f in enumerate(frames_of(src)):
        if p is None:
            h, w = f.shape[:2]
            p = writer(out, w, h, fps)
        while j < len(want) and want[j] == k:
            p.stdin.write(f.tobytes())
            j += 1
        if j >= len(want):
            break
        last = f
    while p is not None and last is not None and j < len(want):      # map points past the end: hold the last frame
        p.stdin.write(last.tobytes())
        j += 1
    if p:
        p.stdin.close()
        p.wait()
    return j


def synth(out, spec, fps=FPS):
    """spec: {"w", "h", "dur", "moves": [[t0, t1], ...] (a box glides), "presses": [t, ...] (a flash appears and
    stays until the next press)}: everything else is a still screen."""
    import numpy as np
    w, h = int(spec.get("w", 320)), int(spec.get("h", 180))
    n = int(round(spec["dur"] * fps))
    p = writer(out, w, h, fps)
    presses = sorted(spec.get("presses", []))
    for i in range(n):
        t = i / fps
        img = np.full((h, w, 3), 40, np.uint8)
        x = 10
        for a, b in spec.get("moves", []):
            if t >= b:
                x += int((b - a) * 120)
            elif t >= a:
                x += int((t - a) * 120)
        x = x % (w - 30)
        img[20:50, x:x + 30] = (200, 200, 200)
        k = sum(1 for q in presses if t >= q - 1e-9)
        if k:
            for j in range(k):                                    # one red mark per press so far, 16 px apart
                img[h - 50:h - 10, 10 + 30 * j:24 + 30 * j] = (0, 0, 255)
        p.stdin.write(img.tobytes())
    p.stdin.close()
    p.wait()
    return n


def flashes(path):
    """Frame indices where the count of red press marks grows (synthetic clips)."""
    out, prev = [], 0
    for i, f in enumerate(frames_of(path)):
        h = f.shape[0]
        row = f[h - 30]
        red = (row[:, 2] > 150) & (row[:, 1] < 80)
        n = 0
        on = False
        for v in red:
            if v and not on:
                n += 1
            on = bool(v)
        if n > prev:
            out.append(i)
        prev = max(prev, n)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["motion", "concat", "render", "synth", "flashes"])
    ap.add_argument("path")
    ap.add_argument("--out")
    ap.add_argument("--pieces")
    ap.add_argument("--frames")
    ap.add_argument("--spec")
    a = ap.parse_args()
    if a.cmd == "motion":
        Path(a.out).write_text(json.dumps({"fps": FPS, "thumb": THUMB, "motion": motion(a.path)}))
    elif a.cmd == "concat":
        pcs = json.loads(Path(a.pieces).read_text())
        n = concat(a.path, pcs["pieces"] if isinstance(pcs, dict) else pcs, Path(a.pieces).parent)
        print(json.dumps({"frames": n}))
    elif a.cmd == "render":
        fr = json.loads(Path(a.frames).read_text())
        n = render(a.path, fr["frames"], a.out, fr.get("fps", FPS))
        print(json.dumps({"frames": n}))
    elif a.cmd == "synth":
        print(json.dumps({"frames": synth(a.path, json.loads(Path(a.spec).read_text()))}))
    elif a.cmd == "flashes":
        Path(a.out).write_text(json.dumps({"flashes": flashes(a.path)}))


if __name__ == "__main__":
    sys.exit(main())
