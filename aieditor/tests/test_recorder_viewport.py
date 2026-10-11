"""agent_rec.mjs: the off-camera frames show the WHOLE recording viewport (re-run 17, 2026-10-11).

Re-run 17: the observation frames showed only the TOP-LEFT quarter of ChatGPT and live.jpg the page TILED 2×2.
Cause (reproduced in aieditor-screencast:0.2): puppeteer's setViewport put the device metrics on puppeteer's session
only; every Page.captureScreenshot went through a second CDP session with NO metrics, and Chrome re-applies the
capturing session's metrics for a shot — devicePixelRatio fell to 1, the layout viewport read a capture's size, and a
shot overlapping the 4 s live shot ran on the other's half-applied metrics (page laid out 2560 wide → cropped / tiled).

  · always: source pins (both sessions get the metrics; the live view shoots through the same session; one shot at a time)
  · AIEDITOR_DOCKER_TESTS=1: a local static page (network none, no profile, no account) observed 36× back to back in
    the screencast image: every frame 1280×720 with all four corner markers, DPR = SCALE, the viewport never drifted,
    live.jpg whole and not tiled, and a click at the button's centre taken from the downscaled shot lands on it

Run: python3 tests/test_recorder_viewport.py        (AIEDITOR_DOCKER_TESTS=1 for the docker part, ~1 min)
"""
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import config  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


SRC = (ROOT / "screencast" / "agent_rec.mjs").read_text()

PAGE = """<html><head><style>
body{margin:0;background:#202020;font:16px sans-serif;color:#ddd}
.c{position:fixed;width:120px;height:80px}
#tl{left:0;top:0;background:#0f0}#tr{right:0;top:0;background:#00f}#bl{left:0;bottom:0;background:#ff0}#br{right:0;bottom:0;background:#f00}
#btn{position:fixed;left:1100px;top:600px;width:140px;height:60px;background:#f0f;border:0}
.g{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;padding:100px 140px}.g div{background:#333;height:40px}
</style></head><body>
<div class=c id=tl></div><div class=c id=tr></div><div class=c id=bl></div><div class=c id=br></div>
<button id=btn onclick="document.title='clicked '+(++window.n||(window.n=1))">Target</button><div class=g></div>
<script>const g=document.querySelector('.g');for(let i=0;i<300;i++){const d=document.createElement('div');d.textContent='cell '+i;g.appendChild(d)}
setInterval(()=>{document.querySelectorAll('.g div')[Math.floor(Math.random()*300)].style.background='#'+Math.floor(Math.random()*0x444+0x222).toString(16)},50)</script>
</body></html>"""

# corner markers + 2×2 tiling, read inside the image (cv2 lives there, not on the host)
ANALYSE = r"""
import cv2, sys, json, numpy as np
res = {}
for p in sys.argv[1:]:
    g = cv2.imread(p)
    h, w = g.shape[:2]
    def col(y, x):
        b, gr, r = [int(v) for v in g[y, x]]
        return 'R' if r > 180 and gr < 80 and b < 80 else 'G' if gr > 180 and r < 80 and b < 80 else \
               'B' if b > 180 and r < 80 and gr < 80 else 'Y' if r > 180 and gr > 180 and b < 80 else '.'
    a = g[:h // 2, :w // 2].astype(int); bb = g[:h // 2, w // 2:w // 2 * 2].astype(int)
    res[p] = {"size": [w, h], "corners": col(8, 8) + col(8, w - 8) + col(h - 8, 8) + col(h - 8, w - 8),
              "tiled": bool(np.abs(a - bb).mean() < 3 and a.std() > 15)}
print(json.dumps(res))
"""


def test_source_pins():
    check('session.send("Emulation.setDeviceMetricsOverride"' in SRC and "async function setVp(" in SRC,
          "the shots' session holds the recording metrics too")
    check("page.setViewport({ width: CSS_W" not in SRC and "p.setViewport({ width: CSS_W" not in SRC,
          "every viewport is applied through setVp (both sessions)")
    check("page.screenshot(" not in SRC, "the live view shoots through the same session as every other shot")
    check(SRC.count('cdp.send("Page.captureScreenshot"') == 2, "shots go through shoot() (+ the live view's one)")
    check("scale: scale * CSS_W / w / SCALE" in SRC, "the session DSF is divided out of clip.scale")


def test_docker():
    if os.environ.get("AIEDITOR_DOCKER_TESTS") != "1" or not shutil.which("docker"):
        print("test_recorder_viewport: docker part skipped (AIEDITOR_DOCKER_TESTS=1 runs it)")
        return
    work = Path(tempfile.mkdtemp(prefix="vp-docker-"))
    name = f"aieditor-vptest-{os.getpid()}"
    try:
        (work / "p.html").write_text(PAGE)
        p = subprocess.Popen(["docker", "run", "-i", "--rm", "--name", name, "--network", "none", "--shm-size", "1g",
                              "-e", "AGENT_DARK=1", "-v", f"{ROOT / 'screencast'}:/app/screencast:ro",
                              "-v", f"{ROOT / 'motion'}:/app/motion:ro", "-v", f"{work}:/w", config.SC_IMAGE,
                              "node", "/app/screencast/agent_rec.mjs", "/w"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

        def send(m):
            p.stdin.write(json.dumps(m) + "\n")
            p.stdin.flush()
            r, _, _ = select.select([p.stdout], [], [], 180)
            line = p.stdout.readline() if r else ""
            if not line:
                raise RuntimeError("recorder did not answer")
            return json.loads(line)

        check(send({"cmd": "open", "url": "file:///w/p.html", "settle": 1}).get("ok"), "the fixture page opened")
        shots, vps, lives, seen = [], [], [], None
        for i in range(36):
            r = send({"cmd": "state"} if i % 3 == 2 else {"cmd": "observe"})
            shots.append(r["shot"])
            vps.append(r.get("vp") or {})
            lv = work / "live.jpg"
            if lv.exists() and lv.stat().st_mtime_ns != seen:
                seen = lv.stat().st_mtime_ns
                shutil.copy(lv, work / f"live-{i:03d}.jpg")
                lives.append(f"/w/live-{i:03d}.jpg")
        # the button's centre in CSS px (1170, 630) → screenshot px ÷ SHOT_F (1536/1280)
        before = send({"cmd": "observe"})
        shots.append(before["shot"])
        act = send({"cmd": "act", "action": {"type": "click", "x": 975, "y": 525}})
        after = send({"cmd": "observe"})
        send({"cmd": "quit"})
        p.wait(timeout=60)
        check(act.get("ok") and after.get("title") == "clicked 1", f"a click from the downscaled shot hit the button: {act} {after.get('title')}")
        for vp in vps:
            check(vp.get("w") == 1536 and vp.get("h") == 864 and abs((vp.get("dpr") or 0) - 2560 / 1536) < 0.01,
                  f"the viewport and DPR held: {vp}")
        check(max(vp.get("fixes", 0) for vp in vps) == 0, f"the viewport never drifted: {vps[-1]}")
        check(lives, "the live view was written")
        a = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{work}:/w", "--entrypoint", "python3",
                            config.SC_IMAGE, "-c", ANALYSE, *shots, *sorted(set(lives))],
                           capture_output=True, text=True, timeout=180)
        res = json.loads(a.stdout or "{}")
        check(len(res) == len(shots) + len(set(lives)), f"every frame analysed: {a.stderr[-300:]}")
        for s in shots:
            check(res[s]["size"] == [1280, 720] and res[s]["corners"] == "GBYR" and not res[s]["tiled"],
                  f"observation {s} shows the whole viewport: {res[s]}")
        for s in set(lives):
            check(res[s]["size"] == [2560, 1440] and res[s]["corners"] == "GBYR" and not res[s]["tiled"],
                  f"live view {s} shows the whole viewport, untiled: {res[s]}")
        # the button sits where the shot says: centre (975, 525) inside its magenta box
        b = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{work}:/w", "--entrypoint", "python3",
                            config.SC_IMAGE, "-c", "import cv2,sys;g=cv2.imread(sys.argv[1]);print(*g[525,975][::-1])",
                            before["shot"]], capture_output=True, text=True, timeout=120)
        r_, g_, b_ = (list(map(int, b.stdout.split())) + [0, 0, 0])[:3]
        check(r_ > 140 and g_ < 60 and b_ > 140, f"the shot shows the button at the clicked shot point: {b.stdout}")
        print(f"  docker: {len(shots)} observations + {len(set(lives))} live views whole; click landed")
    finally:
        subprocess.run(["docker", "kill", name], capture_output=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    test_source_pins()
    test_docker()
    print(f"test_recorder_viewport: {N} checks passed")
