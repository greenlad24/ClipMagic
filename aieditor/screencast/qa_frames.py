"""FRAME GUARD (Jake 2026-10-08/09): what the recorder's live checks miss must still never reach an edit.

Reads the RECORDED pixels (OCR, tesseract) of every screencast segment and flags:
  * challenge — Cloudflare "Verify you are human" / "Just a moment", captchas, ChatGPT's
                "Unusual activity has been detected from your device", "too many requests"
  * error     — an error line the viewer would read ("Message delivery timed out",
                "Something went wrong", "Unable to load …")
  * account   — a greeting to ANOTHER person than the session's ("Hey, Keith" while every other
                greeting says Jake; a Scout profile can hold two accounts)

    python3 qa_frames.py <edit-dir> [--every 1.5] > frames.json

Output: {"segments": {"03": [{"t": 41.5, "kind": "challenge", "why": "..."}]}, "account": "Jake"}
Runs inside aieditor-screencast (tesseract + opencv); decodes each raw.mp4 in this one process.
"""
import argparse
import collections
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2

CHALLENGE = re.compile(r"verify you are human|just a moment\W|attention required|are you a robot|"
                       r"performing security verification|unusual activity has been detected|"
                       r"activity has been detected from your device|too many requests|complete the captcha", re.I)
ERROR = re.compile(r"message delivery timed out|something went wrong|unable to load [a-z ]{0,20}files|"
                   r"network error|an error occurred", re.I)
GREET = re.compile(r"\b(?:Hey|Hi|Hello|Welcome back|How can I help|Good (?:morning|afternoon|evening))[,!]?\s+"
                   r"([A-Z][a-z]{2,})\b")


def ocr(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if g.mean() < 110:                       # dark theme: tesseract reads dark-on-light far better
        g = 255 - g
    h, w = g.shape
    if w > 1920:
        g = cv2.resize(g, (1920, int(h * 1920 / w)), interpolation=cv2.INTER_AREA)
    ok, png = cv2.imencode(".png", g)
    r = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11", "-l", "eng"], input=png.tobytes(),
                       capture_output=True, timeout=120)
    return r.stdout.decode("utf-8", "replace")


def frames(video, every):
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 29.97
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    step = max(1, int(round(every * fps)))
    out = []
    for f in range(0, max(n, 1), step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, img = cap.read()
        if not ok:
            break
        out.append((round(f / fps, 2), img))
    cap.release()
    return out


def scan(seg_dir, every):
    v = Path(seg_dir) / "rec" / "raw.mp4"
    if not v.exists():
        return []
    hits = []
    shots = frames(v, every)
    with ThreadPoolExecutor(max_workers=4) as ex:
        texts = list(ex.map(lambda x: ocr(x[1]), shots))
    for (t, _), txt in zip(shots, texts):
        flat = " ".join(txt.split())
        m = CHALLENGE.search(flat)
        if m:
            hits.append({"t": t, "kind": "challenge", "why": m.group(0)})
            continue
        m = ERROR.search(flat)
        if m:
            hits.append({"t": t, "kind": "error", "why": m.group(0)})
        for g in GREET.finditer(flat):
            hits.append({"t": t, "kind": "greeting", "who": g.group(1)})
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("edit_dir")
    ap.add_argument("--every", type=float, default=1.5)
    ap.add_argument("--out", default=None, help="write the JSON here (not stdout)")
    ap.add_argument("--account", default=None, help="the session's first name (recorder events.json 'account')")
    a = ap.parse_args()
    segs = sorted(p for p in Path(a.edit_dir).glob("seg-*") if (p / "rec" / "raw.mp4").exists())
    res = {s.name.split("-")[1]: scan(s, a.every) for s in segs}
    # the session's account: given, else the name greeted in the MOST SEGMENTS (not frames: one long
    # segment on the wrong account out-counted the right one, 2026-10-09)
    names = collections.Counter(n for hs in res.values() for n in {h["who"] for h in hs if h["kind"] == "greeting"})
    account = a.account or (names.most_common(1)[0][0] if names else None)
    out = {}
    for k, hs in res.items():
        keep = [h for h in hs if h["kind"] != "greeting"]
        keep += [{"t": h["t"], "kind": "account", "why": f"greeting to {h['who']}, not {account}"}
                 for h in hs if h["kind"] == "greeting" and account and h["who"] != account]
        out[k] = sorted(keep, key=lambda h: h["t"])
    res = {"segments": out, "account": account, "every_s": a.every}
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))
    else:
        json.dump(res, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
