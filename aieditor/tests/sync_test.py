"""A/V sync regression test for render.py — must report 0 ms at every cut.

Builds a synthetic source that flashes white on frame 0 of every second and beeps at
the same instant, cuts it into 30 random pieces exactly as a real edit would, renders
through render.render(), and measures beep-minus-flash for every flash that survived.
Run: python3 tests/sync_test.py   (needs Docker + hyperframes-runner:0.8.30)
"""
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aieditor import config, edl, render  # noqa: E402

# --ntsc: 30000/1001 (Jake's Linearity source is 29.97) — a flash every 30 frames is
# then every 1.001 s, so the beep runs on the same period
NTSC = "--ntsc" in sys.argv
FPS = 30000 / 1001 if NTSC else 30.0


def ff(job, *args, entry="ffmpeg"):
    return subprocess.run(["docker", "run", "--rm", "-v", f"{job}:/job", "--entrypoint", entry,
                           config.FFMPEG_IMAGE, *args], capture_output=True, text=True, check=True)


def main():
    job = Path(tempfile.mkdtemp(prefix="aieditor-sync-"))
    try:
        ff(job, "-v", "error", "-y",
           "-f", "lavfi", "-i", f"color=c=black:s=640x360:r={'30000/1001' if NTSC else 30}:d=100,format=yuv420p,"
                                "geq=lum='if(eq(mod(N,30),0),235,16)':cb=128:cr=128",
           "-f", "lavfi", "-i", f"aevalsrc=if(lt(mod(t\\,{1.001 if NTSC else 1})\\,0.05)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=100",
           "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", "-shortest", "/job/source.mp4")
        ff(job, "-v", "error", "-y", "-i", "/job/source.mp4", "-vn", "-ac", "2", "-ar", "48000",
           "-c:a", "pcm_s16le", "/job/full48k.wav")
        random.seed(7)
        t, rng = 0.3, []
        for _ in range(30):
            a = t + random.uniform(0.05, 0.9)
            b = a + random.uniform(1.2, 2.6)
            rng.append((a, b, [], [])); t = b
        pieces, frames = edl.pieces_for(rng, FPS)
        # exercise the click-mute path too: silence a 0.2 s span early in a few pieces
        # (well before any beep, which sits on whole seconds of the source)
        for p in pieces[::5]:
            p["tone"] = [[0.0, 0.02], [0.03, 0.05]]
        # and held frames: widen a few pieces with held edge frames (picture + room tone);
        # the held frames shift picture and sound together, so sync must stay at 0 ms
        rng2 = [(a, b, w, [], 0.2 if k % 4 == 1 else 0.0, 0.1 if k % 4 == 2 else 0.0)
                for k, (a, b, w, _) in enumerate(rng)]
        pieces, frames = edl.pieces_for(rng2, FPS)
        for p in pieces[::5]:
            p["tone"] = p["tone"] + [[0.0, 0.02]]
        # --direct: the long-form final path (pieces encoded once, joined by stream copy)
        direct = "--direct" in sys.argv
        render.render(job, {"pieces": pieces}, FPS, "out", "640:360", direct=direct,
                      progress=(lambda f: None) if direct else None)
        n = ff(job, "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
               "stream=nb_read_frames", "-of", "csv=p=0", "/job/out.mp4", entry="ffprobe").stdout.strip()
        if int(n) != sum(p["frames"] for p in pieces):
            print("SYNC TEST FAILED: frame count", n, "!=", sum(p["frames"] for p in pieces))
            sys.exit(1)
        fl = ff(job, "-v", "error", "-f", "lavfi", "-i", "movie=/job/out.mp4,signalstats",
                "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0",
                entry="ffprobe").stdout.split()
        lit = [(float(x.strip(",").split(",")[0]), float(x.strip(",").split(",")[1]) > 100) for x in fl]
        # only the FIRST frame of a lit run: a held edge frame that happens to be a flash
        # repeats it (seen at 29.97, where piece edges land on flash frames)
        flashes = [t for k, (t, on) in enumerate(lit) if on and not (k and lit[k - 1][1])]
        sd = subprocess.run(["docker", "run", "--rm", "-v", f"{job}:/job", "--entrypoint", "ffmpeg",
                             config.FFMPEG_IMAGE, "-i", "/job/out.mp4", "-vn", "-af",
                             "silencedetect=n=-30dB:d=0.02", "-f", "null", "-"], capture_output=True, text=True).stderr
        beeps = [float(l.split("silence_end: ")[1].split()[0]) for l in sd.splitlines() if "silence_end" in l]
        offs = [round((min(beeps, key=lambda b: abs(b - f)) - f) * 1000) for f in flashes
                if beeps and abs(min(beeps, key=lambda b: abs(b - f)) - f) < 0.5]
        worst = max(abs(o) for o in offs) if offs else None
        print(json.dumps({"flashes": len(flashes), "matched": len(offs), "worst_ms": worst}))
        if not offs or len(offs) < len(flashes) - 1 or worst > 5:
            print("SYNC TEST FAILED", offs)
            sys.exit(1)
        print("sync_test: passed — every cut within", worst, "ms")
    finally:
        shutil.rmtree(job, ignore_errors=True)


if __name__ == "__main__":
    main()
