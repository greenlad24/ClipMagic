"""Privacy blur (RULEBOOK C7, Jake 2026-10-09 R8): screencast/privacy.py + privacy_dom.mjs + the compose hook.

Host part (no cv2/numpy needed):
  · the patterns find emails, sk-/sk-ant- keys, tokens after key/token/secret/Bearer, webhook URLs with
    key paths, phone numbers, Luhn-valid cards, street addresses, account/invoice IDs — never "Jake Dawson"
  · OCR words -> lines -> one box per hit (a phone number in 4 words = one box)
  · DOM + OCR merge by IoU, 12 px pad, +-0.5 s, interpolated between samples; an OCR hit without a stable
    box over 2 samples blurs its panel/quadrant and holds the beat ("widen_blur -> cut_beat")
  · the ffmpeg graph: crop + gblur (sigma >= 20) + overlay with enable windows, offset by pre-frames
  · the recorders sample privacy_dom.mjs (one hook each) and compose feeds raw.blur.mp4 to the camera
Image part (one short-lived `docker run` of aieditor-screencast, no network, no live account):
  · PIL-rendered fixtures: the 4 private items found, the name not; after the blur pass OCR finds 0
  · a 10 s synthetic raw.mp4 -> privacy.py -> camera.py (x1.4 onto the email card) -> 0 legible hits,
    while the same camera on the UNblurred recording does show the email (the check is not vacuous)
  · a static HTML page: privacyBoxes() returns the password and the email field (+ playbook selector)

Run: python3 tests/test_privacy.py      (AIEDITOR_SKIP_DOCKER=1 skips the image part)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "screencast"))
import privacy as P  # noqa: E402

N = 0
IMAGE = os.environ.get("AIEDITOR_SC_IMAGE", "aieditor-screencast:0.2")
KEY = "sk-ant-api03-" + "Xq7v2Lm9Pz4Rt8Kw1Bn6Hy3Jd5Fs0Gc2Va7Ue9Qo"


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def kinds(text):
    return [k for k, _, _ in P.find_private(text)]


# ── patterns ─────────────────────────────────────────────────────────────────────
check(kinds("Email jake@example.com") == ["email"], "an email is private")
check(kinds("jake©example.com") == ["email"], "an OCR'd © for @ is still an email")
check(kinds(f"API key {KEY}") == ["api_key"], "an sk-ant key is private (one hit, not key + token)")
check(kinds("sk-proj-abcdefghij0123456789") == ["api_key"], "an sk-proj key is private")
check(kinds("token: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8") == ["token"], "a 32+ char token after 'token' is private")
check(kinds("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc") == ["token"], "a bearer token is private")
check(kinds("the key to success is consistency") == [], "the word 'key' alone is not private")
check(kinds("https://hooks.slack.com/services/T0000/B0000/aBcDeFgHiJkLmNoPqRsTuVwX") == ["webhook"], "a Slack webhook")
check(kinds("https://hook.eu1.make.com/k3j4h5g6f7d8s9a0q1w2e3r4") == ["webhook"], "a Make webhook")
check(kinds("https://api.example.com/v1/data?api_key=abcd1234efgh") == ["webhook"], "a URL carrying a key")
check(kinds("https://www.linearity.io/pricing") == [], "a plain URL is not private")
check(kinds("+66 81 234 5678") == ["phone"], "an international phone number")
check(kinds("call (415) 555-0134 now") == ["phone"], "a US phone number")
check(kinds("081-234-5678") == ["phone"], "a local Thai number")
check(kinds("4242 4242 4242 4242") == ["card"], "a Luhn-valid card is a card (not a phone)")
check(kinds("4242 4242 4242 4243") == [], "a non-Luhn 16-digit number is not a card")
check(kinds("Released 2026-10-09 at 12:30, $1,299.00, v1.2.3, 1080p 29.97 fps") == [], "dates/prices/versions are not private")
check(kinds("Ship to 123 Main Street, Springfield") == ["address"], "a street address")
check(kinds("Account ID: AC-123456") == ["account_id"], "an account id")
check(kinds("Invoice #INV-2026-0042") == ["account_id"], "an invoice number")
check(kinds("Account settings") == [] and kinds("Invoice history") == [], "account/invoice words alone are not private")
check(kinds("Signed in as Jake Dawson") == [], "'Jake Dawson' is NOT private (ruled 2026-10-08)")
check(P.luhn("4242424242424242") and not P.luhn("4242424242424241") and not P.luhn("123"), "Luhn")
check(KEY[5:] not in P.mask(KEY) and "example" not in P.mask("jake@example.com"), "reports never carry the secret")


# ── OCR words -> rows -> boxes ──────────────────────────────────────────────────
def w(text, x, y, wd, h=24):
    return {"text": text, "x": x, "y": y, "w": wd, "h": h}


words = [w("Phone", 470, 448, 90), w("+66", 783, 448, 52), w("81", 845, 449, 30), w("234", 885, 448, 50),
         w("5678", 945, 448, 80), w("Signed", 470, 190, 90), w("in", 570, 190, 20), w("as", 600, 190, 30),
         w("Jake", 780, 190, 60), w("Dawson", 850, 190, 100), w("Email", 470, 268, 80), w("jake@example.com", 779, 267, 277, 29)]
hits = P.row_hits(words)
check(sorted(h["kind"] for h in hits) == ["email", "phone"], f"row hits: {hits}")
ph = next(h for h in hits if h["kind"] == "phone")
check(ph["box"] == [783, 448, 242, 25], f"a phone over 4 words is ONE box spanning them: {ph['box']}")
check(not any(h["box"][1] < 230 for h in hits), "nothing on the name's row")
check(len(P.rows([w("a", 0, 0, 10), w("b", 300, 0, 10)])) == 2, "words far apart on one baseline are separate lines")

# ── tracks ──────────────────────────────────────────────────────────────────────
W, H = 2560, 1440
dom = [{"t": round(0.25 * i, 2), "boxes": [{"x": 100 + 40 * i, "y": 300, "w": 300, "h": 40, "kind": "email"}]} for i in range(9)]
tr = P.build_tracks(P.detections(dom, []))
check(len(tr) == 1 and tr[0]["stable"], "a DOM box sampled every 0.25 s is one stable track")
wins, held = P.windows(tr, W, H, dur=10)
check(not held, "a stable track holds nothing")
check(min(x["t0"] for x in wins) == 0.0 and abs(max(x["t1"] for x in wins) - 2.5) < 1e-6,
      f"the blur runs 0.5 s past the last sample (clipped at 0): {[(x['t0'], x['t1']) for x in wins]}")


def covered(wins, t, box):
    return any(x["t0"] - 1e-6 <= t <= x["t1"] + 1e-6 and P.contains(x["box"], box, slack=0) for x in wins)


for t in (0.0, 0.1, 0.37, 0.9, 1.63, 2.0, 2.4):
    b = P.box_at(tr[0]["pts"], t)
    padded = [b[0] - 12, b[1] - 12, b[2] + 24, b[3] + 24]
    check(covered(wins, t, padded), f"the interpolated box (+12 px) is under the blur at {t}s")
check(all(x["box"][0] >= 0 and x["box"][0] + x["box"][2] <= W for x in wins), "windows stay inside the frame")

ocr = [{"t": 0.5, "hits": [{"kind": "email", "box": [110, 302, 290, 36]}]}, {"t": 1.0, "hits": [{"kind": "email", "box": [182, 302, 290, 36]}]}]
tr2 = P.build_tracks(P.detections(dom, ocr))
check(len(tr2) == 1 and tr2[0]["srcs"] == {"dom", "ocr"}, "the OCR read of the DOM box joins its track (IoU merge)")

lone = [{"t": 3.0, "hits": [{"kind": "phone", "box": [1700, 1000, 200, 30], "panel": None}]}]
tr3 = P.build_tracks(P.detections([], lone))
wins3, held3 = P.windows(tr3, W, H, dur=10)
check(len(held3) == 1 and held3[0]["remedy"] == "widen_blur -> cut_beat", "a one-sample OCR hit holds its beat")
check(wins3[0]["widened"] == "quadrant" and wins3[0]["box"] == [1268, 708, 1292, 732],
      f"... and blurs its frame quadrant: {wins3[0]}")
check(wins3[0]["t0"] <= 2.0 and wins3[0]["t1"] >= 4.0, "... for a whole sample interval either side")
lone_p = [{"t": 3.0, "hits": [{"kind": "phone", "box": [1700, 1000, 200, 30], "panel": [1600, 950, 600, 200]}]}]
w4, _ = P.windows(P.build_tracks(P.detections([], lone_p)), W, H, dur=10)
check(w4[0]["widened"] == "panel" and w4[0]["box"] == [1588, 938, 624, 224], "... or its panel when one holds it")
two = [{"t": 3.0, "hits": [{"kind": "phone", "box": [1700, 1000, 200, 30]}]},
       {"t": 3.5, "hits": [{"kind": "phone", "box": [1702, 1001, 200, 30]}]}]
_, held5 = P.windows(P.build_tracks(P.detections([], two)), W, H, dur=10)
check(not held5, "the same box in 2 samples in a row is stable: blurred, not held")

many = [{"t0": i, "t1": i + 0.5, "box": [10 * i, 0, 50, 50], "kind": "email", "widened": None} for i in range(300)]
check(len(P.cap_windows(many)) == P.MAX_WINDOWS, "the filter graph is capped")

# ── the ffmpeg graph ────────────────────────────────────────────────────────────
g = P.blur_filter([{"t0": 1.0, "t1": 2.5, "box": [101, 50, 301, 41]}], offset=0.5)
check("crop=300:40:101:50" in g, f"even crop sizes: {g}")
sig = [float(s) for s in re.findall(r"gblur=sigma=([\d.]+)", g)]
check(sig and min(sig) >= 20, "gblur sigma >= 20")
check(g.count("between(t,1.500,3.000)") == 2, "blur and overlay share the enable window, shifted by the pre-frames")
check(P.blur_filter([]) == "[0:v]null[v]", "no window: a pass-through graph")

evs = [{"t": 0, "type": "begin"}, {"t": 1.0, "type": "click", "at": 1.2}, {"t": 4.0, "type": "nav"}, {"t": 5.0, "type": "type"}]
check(P.beat_of(evs, 4.5)["i"] == 1 and P.beat_of(evs, 6)["type"] == "type", "a hit belongs to the last action before it")

# ── hooks (static) ──────────────────────────────────────────────────────────────
ar = (ROOT / "screencast" / "agent_rec.mjs").read_text()
vr = (ROOT / "screencast" / "vrecord.mjs").read_text()
check('from "./privacy_dom.mjs"' in ar and ar.count(".tick(page, t())") == 1 and ar.count("priv?.flush(") == 1,
      "agent_rec.mjs samples privacy boxes on every recorded frame and writes privacy.json at segment end")
check('from "./privacy_dom.mjs"' in vr and vr.count("priv.tick(page, written / FPS)") == 1
      and "priv.flush(path.join(outDir, \"privacy.json\"), preFrames / FPS)" in vr,
      "vrecord.mjs samples on the video clock and shifts by the pre-frames (events.json's t)")
dm = (ROOT / "screencast" / "privacy_dom.mjs").read_text()
for sel in ("input[type=password]", "input[type=email]", "[autocomplete*=email]", "cc-", "[autocomplete*=tel]"):
    check(sel in dm, f"privacy_dom covers {sel}")
le = (ROOT / "aieditor" / "longedit.py").read_text()
comp = le[le.index("def compose("):]
check(comp.index("privacy_pass(") < comp.index("def camera(job)"), "compose blurs the recordings BEFORE the camera")
check('raw.blur.mp4' in comp and '/rec/raw.mp4:ro"' in comp, "the camera reads raw.blur.mp4 (mounted over raw.mp4)")
check("privacy_qa(" in comp and "privacy-qa.json" in le, "the camera output is checked for legible private text")

# ── image part: one short-lived docker run ──────────────────────────────────────
def docker_ok():
    if os.environ.get("AIEDITOR_SKIP_DOCKER") == "1" or not shutil.which("docker"):
        return False
    r = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True)
    return r.returncode == 0


if docker_ok():
    work = tempfile.mkdtemp(prefix="privacy-test-")
    try:
        r = subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", "4", "-v", f"{ROOT}:/a:ro",
                            "-v", f"{ROOT / 'screencast'}:/app/screencast:ro", "-v", f"{ROOT / 'tests'}:/app/ptests:ro",
                            IMAGE, "sh", "-c",
                            "python3 /a/tests/privacy_image_check.py /tmp/w 2>/dev/null && "
                            "node /app/ptests/privacy_dom_check.mjs file:///app/ptests/fixtures/privacy/form.html"],
                           capture_output=True, text=True, timeout=900)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    lines = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
    check(r.returncode == 0 and len(lines) == 2, f"image checks ran: rc {r.returncode} {r.stderr[-800:]}")
    f, dmf = json.loads(lines[0]), json.loads(lines[1])
    four = ["api_key", "card", "email", "phone"]
    for name in ("secrets_light", "secrets_dark"):
        check(f[name]["kinds"] == four, f"{name}: OCR finds the email, key, phone and card: {f[name]}")
        check(not f[name]["name_row_hit"], f"{name}: 'Jake Dawson' is not flagged")
        check(f[name]["masked"], f"{name}: hit reports are masked")
    check(f["name_only"]["kinds"] == [], "a page with only the name has no private hit")
    fb = f["fixture_blur"]
    check(fb["ocr_kinds"] == four and fb["windows"] >= 4, f"the blur pass tracks all four: {fb}")
    check(fb["after"] == [] and fb["ok"] and not fb["held"], f"after the blur pass OCR finds 0 hits: {fb}")
    check(f["syn_privacy_rc"] == 0 and f["syn_ocr_kinds"] == ["email"], f"synthetic recording: the email is found {f}")
    check(1.3 <= f["cam_zoom_max"] <= 1.5, f"the camera moved x1.4 onto the card: {f['cam_zoom_max']}")
    check(f["cam_raw_hits"] > 0, "without the blur the zoomed camera output shows the email (the check is real)")
    check(f["cam_blur_hits"] == [], f"camera output of raw.blur.mp4: 0 legible private frames {f['cam_blur_hits']}")
    bx = dmf["boxes"]
    check(any(b["kind"] == "password" for b in bx) and any(b["kind"] == "email" and b["w"] > 500 for b in bx),
          f"privacyBoxes: the password and the email field: {bx}")
    check(any(b["kind"] == "playbook" for b in bx), "privacyBoxes: the playbook's private selector")
    check(any(b["kind"] == "key" for b in bx), "privacyBoxes: an sk-ant key in page text")
    nx, ny, nw, nh = dmf["name"]
    check(not any(abs(b["x"] - nx) < 2 and abs(b["y"] - ny) < 2 for b in bx), "privacyBoxes: the name field is not private")
    check(dmf["samples"] == [-0.5, -0.2333, 0, 0.2667, 0.5] and dmf["sample_boxes"] >= 4,
          f"the sampler: every 0.25 s of recorded time, shifted by the offset: {dmf['samples']}")
    note = ""
else:
    note = " (image checks skipped: no docker / image)"

print(f"test_privacy: {N} checks passed{note}")
