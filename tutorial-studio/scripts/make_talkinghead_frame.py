#!/usr/bin/env python3
"""Per-video talking-head START FRAME (apimart GPT Image 2).

Each tutorial video gets a FRESH start frame: SAME creator (face, hair, makeup, identity)
and SAME warm lighting + SAME framing/mic/gesture, but a NEW outfit and a NEW background
(a different corner of the same cozy home). Feeds Wan 3.0 (which animates + speaks).
Saves the PNG and the hosted URL (Wan needs an http URL, not base64).

    .venv/bin/python scripts/make_talkinghead_frame.py \
        --outfit "a soft dusty-blue oversized hoodie" \
        --scene "a cozy home-office nook with a wooden desk and bookshelf behind her" \
        --out start_v2.png
"""

from __future__ import annotations

import base64
import glob
import json
import os
import ssl
import sys
import time
import urllib.request

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

try:
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl._create_unverified_context()

API = "https://api.apimart.ai"
REFS = ".media/tutorial/refs"

# Defaults keep the original look; override per video with --outfit / --scene.
DEFAULT_OUTFIT = "a comfy cream knit sweater"
DEFAULT_SCENE = ("a cozy living-room corner with a leafy plant, framed botanical wall "
                 "art and a warm lamp")


DEFAULT_ENVIRONMENT = "warm cozy home"


def build_prompt(outfit: str, scene: str, environment: str = DEFAULT_ENVIRONMENT) -> str:
    return (
        "Vertical 9:16 close-up talking-head photo for an Instagram tutorial reel. Use "
        "the reference image as the creator: keep her FACE, hairstyle (pulled back with "
        "soft face-framing pieces), makeup and identity EXACTLY 1:1 — the same person "
        f"every time. She now wears {outfit}. She is seated in {scene} — a different "
        f"corner of the SAME {environment}, which must be recognisably the same place in "
        "every video; the background is softly OUT OF FOCUS behind "
        "her (shallow depth of field). KEEP THE SAME warm, soft, flattering cozy-indoor "
        "lighting ON THE CHARACTER (identical lighting on her face and skin every time), "
        "gentle soft shadows, slightly warm tone. FRAMING (identical every video): a "
        "medium-tight close-up — her head in the upper portion with a little headroom, "
        "cropped around the upper chest, centered, looking straight at the camera as if "
        "talking. In ONE hand, raised to about chest level, she holds a small white "
        "wireless clip-on microphone with a fuzzy windscreen (a DJI-style mini mic), as "
        "if speaking into it; her OTHER hand is up mid-gesture, expressive. Authentic "
        "front-facing phone-camera realism, natural skin texture. Keep the lower third "
        "relatively clear for captions. NO on-screen text, captions, stickers or "
        "watermark."
    )


def _key() -> str:
    for line in open(".env", encoding="utf-8"):
        if line.startswith("APIMART_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("APIMART_API_KEY not in .env")


def _ref_file(path: str) -> str:
    """Data URI for an uploaded avatar image (identity reference)."""
    if not os.path.exists(path):
        sys.exit(f"reference image not found: {path}")
    ext = os.path.splitext(path)[1].lstrip(".").lower().replace("jpg", "jpeg") or "png"
    b = base64.b64encode(open(path, "rb").read()).decode()
    return f"data:image/{ext};base64,{b}"


def _ref(name: str) -> str:
    hits = glob.glob(os.path.join(REFS, name + ".*"))
    if not hits:
        sys.exit(f"missing reference {REFS}/{name}.*")
    ext = os.path.splitext(hits[0])[1].lstrip(".").lower().replace("jpg", "jpeg")
    b = base64.b64encode(open(hits[0], "rb").read()).decode()
    return f"data:image/{ext};base64,{b}"


def _first_img(obj):
    if isinstance(obj, str) and obj.startswith("http") and any(x in obj for x in (".png", ".jpg", ".webp")):
        return obj
    if isinstance(obj, dict):
        for v in obj.values():
            u = _first_img(v)
            if u:
                return u
    if isinstance(obj, list):
        for v in obj:
            u = _first_img(v)
            if u:
                return u
    return None


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--outfit", default=DEFAULT_OUTFIT, help="what she wears this video")
    ap.add_argument("--scene", default=DEFAULT_SCENE, help="background: another corner of the same home")
    ap.add_argument("--out", default="start.png", help="output filename under shots_in/")
    ap.add_argument("--ref-image", default="", help="uploaded avatar image to use as the identity "
                                                    "reference instead of the packaged creator sheet")
    ap.add_argument("--environment", default=DEFAULT_ENVIRONMENT,
                    help="the ONE place every video is shot in; each video gets a different corner of it")
    args = ap.parse_args()

    out_png = os.path.join(".media/tutorial/shots_in", args.out)
    out_url = os.path.splitext(out_png)[0] + "_url.txt"

    key = _key()
    # Identity reference: an uploaded avatar when the caller supplied one, else the
    # packaged creator sheet. Either way it fixes the face only — outfit and the
    # corner of the room still vary per video.
    creator = _ref_file(args.ref_image) if args.ref_image else _ref("creator_sheet")
    body = {
        "model": "gpt-image-2", "prompt": build_prompt(args.outfit, args.scene, args.environment),
        "size": "9:16", "resolution": "2k", "image_urls": [creator],
    }
    print(f"start frame — outfit: {args.outfit} | scene: {args.scene} | "
          f"environment: {args.environment}"
          + (f" | avatar: {os.path.basename(args.ref_image)}" if args.ref_image else ""), flush=True)
    req = urllib.request.Request(API + "/v1/images/generations",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data=json.dumps(body).encode())
    print("compositing talking-head start frame (GPT Image 2) …", flush=True)
    resp = json.loads(urllib.request.urlopen(req, timeout=120, context=_CTX).read().decode())
    data = resp.get("data", resp)
    tid = (data[0] if isinstance(data, list) else data).get("task_id")
    deadline = time.time() + 300
    url, cost = None, 0.0
    while time.time() < deadline:
        d = json.loads(urllib.request.urlopen(
            urllib.request.Request(API + f"/v1/tasks/{tid}",
                                   headers={"Authorization": f"Bearer {key}"}),
            timeout=60, context=_CTX).read().decode())
        node = d.get("data", d)
        st = node.get("status")
        if st in ("completed", "succeeded", "success"):
            url = _first_img(node.get("result") or node)
            cost = float(node.get("price") or 0.0392)
            break
        if st in ("failed", "error"):
            sys.exit(f"failed: {json.dumps(node)[:300]}")
        time.sleep(6)
    if not url:
        sys.exit("timed out / no url")
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    with open(out_png, "wb") as fh, urllib.request.urlopen(url, timeout=300, context=_CTX) as r:
        fh.write(r.read())
    open(out_url, "w").write(url)
    print(f"  -> {out_png}   (hosted url saved to {out_url})   cost ${cost:.4f}")


if __name__ == "__main__":
    main()
