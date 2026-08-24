#!/usr/bin/env python3
"""Generate designed overlay ELEMENTS via GPT Image 2 (apimart) — sticker/badge/frame
graphics with NO text; crisp text is laid on top later by the overlay engine.

Builds a reusable element library so the reels look designed (not flat CSS). Screenshots
stay real; only these decorative element graphics are generated.

    .venv/bin/python scripts/make_element.py --name sticker_yellow \
        --prompt "hand-drawn marker highlight sticker, bright yellow, rough torn edges"
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.request

try:
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl._create_unverified_context()

API = "https://api.apimart.ai"
OUTDIR = ".media/tutorial/elements"


def _key():
    for line in open(".env", encoding="utf-8"):
        if line.startswith("APIMART_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("APIMART_API_KEY not in .env")


def _first_img(o):
    if isinstance(o, str) and o.startswith("http") and any(x in o for x in (".png", ".jpg", ".webp")):
        return o
    if isinstance(o, dict):
        for v in o.values():
            u = _first_img(v)
            if u:
                return u
    if isinstance(o, list):
        for v in o:
            u = _first_img(v)
            if u:
                return u
    return None


def generate(name, prompt, size="1:1"):
    key = _key()
    full = (prompt + ". Isolated graphic element on a FULLY TRANSPARENT background, "
            "centered, no text, no letters, no words, no watermark, high-res, crisp edges.")
    body = {"model": "gpt-image-2", "prompt": full, "size": size, "resolution": "2k",
            "background": "transparent"}
    req = urllib.request.Request(API + "/v1/images/generations",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data=json.dumps(body).encode())
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
            url = _first_img(node.get("result") or node); cost = float(node.get("price") or 0.0392); break
        if st in ("failed", "error"):
            sys.exit(f"failed: {json.dumps(node)[:300]}")
        time.sleep(6)
    if not url:
        sys.exit("timed out / no url")
    os.makedirs(OUTDIR, exist_ok=True)
    out = os.path.join(OUTDIR, name + ".png")
    with open(out, "wb") as fh, urllib.request.urlopen(url, timeout=300, context=_CTX) as r:
        fh.write(r.read())
    print(f"  -> {out}  (${cost:.4f})")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--size", default="1:1")
    args = ap.parse_args()
    generate(args.name, args.prompt, args.size)


if __name__ == "__main__":
    main()
