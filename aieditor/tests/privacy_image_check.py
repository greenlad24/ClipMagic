"""The image half of tests/test_privacy.py — runs INSIDE aieditor-screencast (tesseract, cv2, ffmpeg):

    python3 /a/tests/privacy_image_check.py /tmp/work      -> one JSON line of facts on stdout

1. OCR detection on the PIL-rendered fixtures (light + dark): email, sk-ant key, phone, card; never the name.
2. The blur pass on a 2 s recording of the fixture: OCR on raw.blur.mp4 finds 0 hits.
3. A 10 s synthetic 2560x1440 recording with an email card: privacy.py, then camera.py with a x1.4 move onto
   the card; OCR on the camera output finds 0 hits (and DOES find the email when the camera reads the
   unblurred recording, so the check is not vacuous).
"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

A = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(A / "screencast"))
import privacy as P  # noqa: E402
import cv2  # noqa: E402

FX = A / "tests" / "fixtures" / "privacy"
WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/privacy-check")
WORK.mkdir(parents=True, exist_ok=True)
FPS = 30000 / 1001
facts = {}


def video_from(png, out, seconds, size=None):
    vf = ["-vf", f"scale={size}"] if size else []
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-framerate", f"{FPS:.6f}", "-i", str(png), "-t", str(seconds),
                    *vf, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", "-r", f"{FPS:.6f}",
                    str(out)], check=True)


def events(recdir, w, h, evs, end):
    (recdir / "events.json").write_text(json.dumps({
        "capture": {"w": w, "h": h, "fps": FPS, "scale": 1.6667, "css": [1536, 864]}, "virtual_time": True, "pre_frames": 0,
        "end": end, "failed": None, "cursor": [[0, w * 0.6, h * 0.6], [end, w * 0.6, h * 0.6]], "events": evs, "walls": []}))


# 1 ── detection on the fixtures
for name in ("secrets_light", "secrets_dark", "name_only"):
    hits = P.frame_hits(cv2.imread(str(FX / f"{name}.png")))
    facts[name] = {"kinds": sorted({h["kind"] for h in hits}),
                   "name_row_hit": any(h["box"][1] < 230 for h in hits),     # "Jake Dawson" sits at y 170-215
                   "masked": all("example" not in h["text"] and "4242 4242" not in h["text"] for h in hits)}

hits = P.legible([FX / "secrets_dark.png"], frames_dir=WORK / "frames", label="fx")
facts["frames_saved"] = sorted(p.name for p in (WORK / "frames").glob("*.jpg"))
facts["legible_png_kinds"] = sorted({h["kind"] for h in hits})

# 2 ── the blur pass on a recording of the fixture
rd = WORK / "fx" / "rec"
rd.mkdir(parents=True, exist_ok=True)
video_from(FX / "secrets_light.png", rd / "raw.mp4", 2.0)
events(rd, 1920, 1080, [{"t": 0, "type": "begin"}], 2.0)
doc = P.run(rd, every=0.5)
facts["fixture_blur"] = {"ocr_kinds": sorted({h["kind"] for h in doc["ocr_hits"]}), "windows": len(doc["windows"]),
                         "after": [h["kind"] for h in P.legible(rd / "raw.blur.mp4", every=0.5)],
                         "ok": doc["ok"], "held": doc["held"]}

# 3 ── 10 s synthetic recording -> privacy.py -> camera.py (x1.4 onto the card) -> legible
sd = WORK / "syn" / "rec"
sd.mkdir(parents=True, exist_ok=True)
video_from(FX / "email_card.png", sd / "raw.mp4", 10.0)
card = [700, 560, 1134, 300]
events(sd, 2560, 1440, [{"t": 0, "type": "begin"},
                        # a compiled beat's target (p3's reference camera: plain reads never move the camera)
                        {"t": 3.0, "type": "read", "box": card, "target_box": card, "beat": "email-card",
                         "text": "Email address", "end": 8.0}], 10.0)
t0 = time.time()
r = subprocess.run([sys.executable, str(A / "screencast" / "privacy.py"), "blur", str(sd), "--every", "0.5"],
                   capture_output=True, text=True)
facts["syn_privacy_rc"] = r.returncode
facts["syn_privacy_err"] = r.stderr[-400:]
facts["syn_privacy_s"] = round(time.time() - t0, 2)
pdoc = json.loads((sd / "privacy.blur.json").read_text())
facts["syn_ocr_kinds"] = sorted({h["kind"] for h in pdoc["ocr_hits"]})


def camera(raw_name, out):
    cam_in = WORK / f"in-{raw_name}"
    if cam_in.exists():
        shutil.rmtree(cam_in)
    cam_in.mkdir()
    shutil.copy(sd / "events.json", cam_in / "events.json")
    shutil.copy(sd / raw_name, cam_in / "raw.mp4")        # what longedit's read-only mount does
    rr = subprocess.run([sys.executable, str(A / "screencast" / "camera.py"), str(cam_in), str(out), "--size", "1920x1080",
                         "--from", "0", "--to", "10", "--fps", f"{FPS:.8f}"], capture_output=True, text=True)
    if rr.returncode:
        raise SystemExit(f"camera.py failed: {rr.stderr[-600:]}")
    cam = json.loads(Path(str(out) + ".camera.json").read_text())
    return max(float(m[3][0]) for m in cam["moves"]) if cam["moves"] else 1.0   # move = (start, dur, view_a, view_b, kind)


facts["cam_zoom_max"] = round(camera("raw.blur.mp4", WORK / "cam-blur.mp4"), 3)
facts["cam_blur_hits"] = [(h["t"], h["kind"]) for h in P.legible(WORK / "cam-blur.mp4", every=0.5)]
camera("raw.mp4", WORK / "cam-raw.mp4")
facts["cam_raw_hits"] = len(P.legible(WORK / "cam-raw.mp4", every=0.5))
print(json.dumps(facts))
