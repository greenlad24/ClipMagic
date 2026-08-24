#!/usr/bin/env python3
"""Normalize meme GIFs into short, render-ready MP4 clips so the overlay pass is fast
and can NEVER stall: capped duration, even dimensions, standard fps + pixel format.
Any GIF that fails or times out is skipped (logged), never left to hang a render.

    .venv/bin/python scripts/prep_memes.py
"""

from __future__ import annotations

import glob
import os
import subprocess

SRC = ".media/tutorial/memes"
DST = ".media/tutorial/memes_ready"
MAXDUR = 1.8       # hard cap — a meme beat is ~1.6s
FPS = 24
WIDTH = 360


def _dur(p):
    o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip()
    try:
        return float(o)
    except ValueError:
        return 0.0


def prep_one(src, out):
    cmd = ["ffmpeg", "-y", "-t", str(MAXDUR), "-i", src,
           "-vf", f"scale={WIDTH}:-2:flags=lanczos,fps={FPS}",
           "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return False, "timeout"
    if r.returncode != 0 or _dur(out) <= 0:
        if os.path.exists(out):
            os.remove(out)
        return False, (r.stderr or "")[-160:]
    return True, f"{_dur(out):.2f}s"


def main():
    os.makedirs(DST, exist_ok=True)
    ok = 0
    for f in sorted(glob.glob(os.path.join(SRC, "*.gif"))):
        name = os.path.splitext(os.path.basename(f))[0]
        out = os.path.join(DST, name + ".mp4")
        good, info = prep_one(f, out)
        print(("  ready: " if good else "  SKIP:  ") + name + ".mp4  " + info, flush=True)
        ok += 1 if good else 0
    print(f"normalized {ok} meme(s) -> {DST}/")


if __name__ == "__main__":
    main()
