#!/usr/bin/env python3
"""Generate an ORIGINAL creator character-reference sheet (apimart GPT Image 2).

Pure text-to-image of an invented persona (NOT derived from any real person) — a single
multi-view sheet used as the reusable creator reference for the English tutorial reels.

    .venv/bin/python scripts/make_creator_sheet.py
"""

from __future__ import annotations

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
OUT = ".media/tutorial/refs/creator_sheet.png"

PROMPT = (
    "Character reference sheet of ONE original fictional female content creator, an "
    "invented Chinese woman in her early twenties (East Asian, Chinese features; not "
    "resembling any real celebrity or influencer). Friendly, approachable, casual-cozy "
    "vibe. Dark black-brown hair pulled BACK away from the face and tied back, with just "
    "a small section on ONE side left loose and falling forward to frame that cheek "
    "(face fully visible). Soft natural-glam makeup: neatly defined brows, subtle "
    "eyeliner, softly blushed cheeks, glowy dewy skin, rosy-nude glossy lips. Wearing a "
    "comfy cream knit sweater. Consistent identity, same hairstyle, same makeup and same "
    "lighting across the whole sheet. Show FIVE views of the SAME person on one image, "
    "evenly arranged on a clean light-grey background: (1) front headshot neutral, (2) "
    "front upper-body smiling, (3) three-quarter view, (4) left side profile, (5) "
    "mid-gesture talking to camera. LIGHTING: warm, soft, flattering cozy-indoor light "
    "with gentle soft shadows and a slightly warm tone (like a bright living room), "
    "identical in every view. Photoreal, sharp, consistent face, hair and makeup in "
    "every view. No text, no labels, no watermark."
)


def _key() -> str:
    for line in open(".env", encoding="utf-8"):
        if line.startswith("APIMART_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("APIMART_API_KEY not in .env")


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
    key = _key()
    body = {"model": "gpt-image-2", "prompt": PROMPT, "size": "1:1", "resolution": "2k"}
    req = urllib.request.Request(API + "/v1/images/generations",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data=json.dumps(body).encode())
    print("generating original creator sheet (GPT Image 2) …", flush=True)
    resp = json.loads(urllib.request.urlopen(req, timeout=120, context=_CTX).read().decode())
    data = resp.get("data", resp)
    tid = (data[0] if isinstance(data, list) else data).get("task_id")
    deadline = time.time() + 300
    url = None
    cost = 0.0
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
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh, urllib.request.urlopen(url, timeout=300, context=_CTX) as r:
        fh.write(r.read())
    print(f"  -> {OUT}   (GPT Image 2 cost ${cost:.4f})")


if __name__ == "__main__":
    main()
