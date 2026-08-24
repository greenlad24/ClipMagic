#!/usr/bin/env python3
"""Generate the creator's ROOM/set plate (apimart GPT Image 2) — an original cozy home.

A vertical 9:16 empty home-interior background where the talking-head tutorial is
"filmed", matching the creator's warm cozy vibe + lighting. Used as the room reference
for the talking-head composites (creator + room -> start frame).

    .venv/bin/python scripts/make_room_frame.py
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
OUT = ".media/tutorial/refs/room.png"

PROMPT = (
    "Vertical 9:16 photo of a cozy, warm home interior — a bright living-room corner "
    "where a content creator films talking-head videos. Soft neutral cream and warm "
    "beige tones, a comfy homey feel: a leafy potted plant, one or two framed pieces of "
    "wall art, a soft throw, a hint of a wooden staircase or shelf to the side. Warm, "
    "soft, flattering indoor light with gentle soft shadows and a slightly warm tone, "
    "as if from a bright window. Inviting and lived-in but tidy. EMPTY — no people. "
    "Photoreal, natural, slight shallow depth of field, shot on a phone. No text, no "
    "watermark."
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
    body = {"model": "gpt-image-2", "prompt": PROMPT, "size": "9:16", "resolution": "2k"}
    req = urllib.request.Request(API + "/v1/images/generations",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data=json.dumps(body).encode())
    print("generating creator room plate (GPT Image 2) …", flush=True)
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
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh, urllib.request.urlopen(url, timeout=300, context=_CTX) as r:
        fh.write(r.read())
    print(f"  -> {OUT}   (GPT Image 2 cost ${cost:.4f})")


if __name__ == "__main__":
    main()
