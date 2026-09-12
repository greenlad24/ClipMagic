#!/usr/bin/env python3
"""English tutorial-reel script generator (Qwen via apimart) — standalone.

Writes ONE continuous ~30s spoken script (fed to Wan 3.0, which voices it) plus the
title (two parts) and CTA. Talking-head only; hook (first 3s) -> 2-3 steps -> CTA.

    .venv/bin/python scripts/make_tutorial_script.py "how to <thing> with <tool>"

Reads APIMART_API_KEY and STUDIO_PLAN_MODEL from .env. Writes
.media/tutorial/script.json (+ script.txt fed verbatim to Wan).
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.request

try:
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl._create_unverified_context()

API = "https://api.apimart.ai/v1/chat/completions"
OUT = ".media/tutorial/script.json"
# The clip the script is written for. 30s is the reel format Wan 3.0 renders;
# --seconds lowers it when a shorter model is doing the talking (MiniMax H3 caps
# a clip at 15s, and 30s of words on a 15s clip is a sentence cut in half).
TARGET_SECONDS = 30
WORDS_PER_SECOND = 2.6


def _env(key, default=""):
    if os.path.exists(".env"):
        for line in open(".env", encoding="utf-8"):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    return os.environ.get(key, default)


def build_system(seconds: int) -> str:
    words = int(seconds * WORDS_PER_SECOND)
    return (
        "You are a top English short-form UGC scriptwriter for talking-head tutorial reels. "
        f"Write ONE continuous first-person spoken script for a single ~{seconds}s clip "
        f"(about {words} words) that teaches the topic. It will be SPOKEN by an AI avatar, so "
        "write only natural spoken words — no stage directions, emojis, or special characters.\n"
        "STRUCTURE: 1) HOOK (first ~3s): open on the punch, no greeting. 2) VALUE: 2-3 concrete "
        "steps. 3) CTA (last ~3s): one clear ask (comment a keyword / save / follow).\n"
        "Also produce a TWO-PART TITLE: a short lead-in (title_small, e.g. 'how to make') and "
        "the main title (title_main, e.g. 'carousels with Claude'), plus a short CTA line.\n"
        'OUTPUT: STRICT JSON only: {"title_small":"...","title_main":"...","script":"...",'
        '"cta":"...","keyword":"<one word to comment, else empty>"}'
    )


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("topic", nargs="?",
                    default="how to turn Claude into a design machine for Instagram carousels")
    ap.add_argument("--seconds", type=int, default=TARGET_SECONDS,
                    help="length of the clip this script will be spoken over")
    args = ap.parse_args()
    topic, seconds = args.topic, max(4, args.seconds)
    key = _env("APIMART_API_KEY")
    if not key:
        sys.exit("APIMART_API_KEY not set (.env or env)")
    model = _env("STUDIO_PLAN_MODEL", "qwen3.8-max")
    body = {"model": model, "stream": False, "max_tokens": 5000, "messages": [
        {"role": "system", "content": build_system(seconds)},
        {"role": "user", "content": f"Topic: {topic}\nReturn the script JSON now."}]}
    req = urllib.request.Request(API, headers={"Authorization": f"Bearer {key}",
        "Content-Type": "application/json"}, data=json.dumps(body).encode())
    print(f"Qwen ({model}): writing tutorial script — {topic} …", flush=True)
    resp = json.loads(urllib.request.urlopen(req, timeout=180, context=_CTX).read().decode())
    text = resp["choices"][0]["message"]["content"]
    s, e = text.find("{"), text.rfind("}")
    try:
        obj = json.loads(text[s:e + 1])
    except (ValueError, TypeError):
        sys.exit("could not parse script JSON:\n" + text[:500])

    obj["topic"] = topic
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
    with open(".media/tutorial/script.txt", "w", encoding="utf-8") as fh:
        fh.write(obj.get("script", ""))

    wc = len(obj.get("script", "").split())
    print("===== TUTORIAL SCRIPT =====")
    print(f"title:  {obj.get('title_small')} / {obj.get('title_main')}")
    print(f"CTA:    {obj.get('cta')}   (keyword: {obj.get('keyword') or '-'})")
    print(f"~words: {wc} (~{wc / WORDS_PER_SECOND:.0f}s of a {seconds}s clip)")
    print("\n--- SCRIPT (fed to the video model) ---\n" + obj.get("script", ""))
    print(f"\nwrote {OUT} + .media/tutorial/script.txt")


if __name__ == "__main__":
    main()
