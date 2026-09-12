#!/usr/bin/env python3
"""v2 talking-head tutorial: ONE continuous clip that SPEAKS the script.

The model generates the voice itself (audio ON) from the full script — no
ElevenLabs, no AI director, no 5-scene pool. Feed it a creator start-frame URL
and the script.

    .venv/bin/python scripts/make_tutorial_video.py --image-url <hosted.png> \
        --script .media/tutorial/script.txt --seconds 30
    .venv/bin/python scripts/make_tutorial_video.py --image-url <hosted.png> \
        --model MiniMax-H3 --resolution 768P --seconds 15

Two models, both on apimart, both fed the same start frame (see video_models.py):

* **Wan 3.0** (`wan3.0-video`) — the original path. Start frame in `image_urls`,
  9:16 forced with `size`, `audio: True`, up to 30s.
* **MiniMax H3** (`MiniMax-H3`) — image-to-video, so the start frame goes in
  `first_frame_image` and the aspect ratio comes from that image (any
  `aspect_ratio` is ignored in this mode). Caps a single clip at 15s.

NOTE (verify on first paid run): the exact field Wan 3.0 reads the spoken script
from may be the prompt (used here) or a dedicated 'audio_script'/'dialogue'
field. Adjust _WAN_SPEECH_FIELD once tested.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.request

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts.video_models import VIDEO_MODELS, DEFAULT_MODEL, normalize  # noqa: E402

try:
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl._create_unverified_context()

API = "https://api.apimart.ai"
_WAN_SPEECH_FIELD = "prompt"  # where the spoken script goes (verify per API)


def _key() -> str:
    for line in open(".env", encoding="utf-8"):
        if line.startswith("APIMART_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("APIMART_API_KEY not in .env")


def _clip_seconds(path: str) -> float:
    """Real output duration of the mp4 (ffprobe), 0.0 if unavailable."""
    import subprocess
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def _first_mp4(obj):
    if isinstance(obj, str) and obj.startswith("http") and ".mp4" in obj:
        return obj
    if isinstance(obj, dict):
        for v in obj.values():
            u = _first_mp4(v)
            if u:
                return u
    if isinstance(obj, list):
        for v in obj:
            u = _first_mp4(v)
            if u:
                return u
    return None


def speech_prompt(script: str) -> str:
    """The one prompt both models get: what she does, how she sounds, what she
    says. Identical across models so a switch changes the engine, not the read."""
    return (
        "A young woman looks at the camera and speaks naturally and confidently, with "
        "clear lip-sync and matching hand gestures, in a casual home setting, handheld "
        "phone realism. VOICE: a young woman's voice that is SOFT, gentle, slightly "
        "WHISPERY and cute, warm and friendly, a little breathy and intimate as if "
        "talking close to the mic — natural casual American English, clear and "
        "consistent, unhurried. AUDIO: "
        "ONLY her clean spoken voice — absolutely NO background music, no song, and no "
        "sound effects. She says exactly this, in English: \"" + script.strip() + "\""
    )


def _body(model: str, image_url: str, prompt: str, resolution: str, seconds: int) -> dict:
    """The request body for one talking-head clip, shaped per model."""
    if model == "MiniMax-H3":
        # Image-to-video: the start frame is the FIRST FRAME, and H3 takes the
        # aspect ratio from it (an aspect_ratio field is ignored in this mode),
        # which is what keeps the 9:16 start frame 9:16. It generates the voice
        # from the prompt like Wan does, so there is no `audio` flag to set.
        return {
            "model": model,
            "prompt": prompt,
            "first_frame_image": image_url,
            "duration": seconds,
            "resolution": resolution,
        }
    return {
        "model": model,
        "image_urls": [image_url],
        _WAN_SPEECH_FIELD: prompt,
        "resolution": resolution,
        "size": "9:16",
        "duration": seconds,
        "audio": True,          # Wan 3.0 generates the spoken voice itself
    }


def talking_clip(image_url: str, script: str, key: str, *, model=DEFAULT_MODEL,
                 resolution="720P", seconds=30,
                 out="talkinghead.mp4") -> tuple[str, float, float | None]:
    """One continuous talking-head clip that SPEAKS `script` (audio ON).

    Returns (path, output seconds, cost apimart reported or None)."""
    body = _body(model, image_url, speech_prompt(script), resolution, seconds)
    req = urllib.request.Request(API + "/v1/videos/generations",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        data=json.dumps(body).encode())
    resp = json.loads(urllib.request.urlopen(req, timeout=120, context=_CTX).read().decode())
    data = resp.get("data", resp)
    tid = (data[0] if isinstance(data, list) else data).get("task_id")
    # Persist the task id immediately so a timed-out/interrupted run is still recoverable
    # (apimart has no task-list endpoint; without this the job becomes an orphan).
    os.makedirs(".media/tutorial", exist_ok=True)
    open(os.path.join(".media/tutorial", out + ".task.txt"), "w").write(tid or "")
    print(f"  submitted task_id: {tid}", flush=True)
    deadline = time.time() + 3600
    while time.time() < deadline:
        # apimart async tasks (image AND video) are polled at /v1/tasks/{id}.
        d = json.loads(urllib.request.urlopen(
            urllib.request.Request(API + f"/v1/tasks/{tid}",
                                   headers={"Authorization": f"Bearer {key}"}),
            timeout=60, context=_CTX).read().decode())
        node = d.get("data", d)
        st = node.get("status")
        if st in ("completed", "succeeded", "success"):
            url = _first_mp4(node.get("result") or node)
            os.makedirs(".media/tutorial", exist_ok=True)
            path = os.path.join(".media/tutorial", out)
            with urllib.request.urlopen(url, timeout=600, context=_CTX) as r, open(path, "wb") as fh:
                fh.write(r.read())
            cost = node.get("cost")
            return path, float(node.get("actual_time", seconds)), (
                float(cost) if isinstance(cost, (int, float)) else None)
        if st in ("failed", "error"):
            sys.exit(f"{model} failed: {json.dumps(node)[:300]}")
        time.sleep(8)
    sys.exit(f"{model} timed out")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image-url", required=True, help="hosted creator start-frame URL")
    ap.add_argument("--script", default=".media/tutorial/script.txt")
    ap.add_argument("--seconds", type=int, default=0,
                    help="clip length; defaults to the model's own (Wan 30s, H3 15s)")
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(VIDEO_MODELS),
                    help="which apimart video model speaks the script")
    ap.add_argument("--resolution", default="",
                    help="model-specific (Wan 480P/720P/1080P, H3 768P/2K); "
                         "defaults to the model's own")
    ap.add_argument("--out", default="talkinghead.mp4")
    args = ap.parse_args()

    model, resolution, model_seconds = normalize(args.model, args.resolution)
    seconds = args.seconds if args.seconds > 0 else model_seconds
    spec = VIDEO_MODELS[model]

    script = open(args.script, encoding="utf-8").read().strip()
    if not script:
        sys.exit("empty script")
    print(f"{spec['label']} talking-head (audio ON), {seconds}s @ {resolution}, "
          f"speaking {len(script.split())} words …", flush=True)
    path, _secs, cost = talking_clip(args.image_url, script, _key(), model=model,
                                     resolution=resolution, seconds=seconds, out=args.out)
    # These models bill per second of OUTPUT video, not GPU/render time. Use the
    # clip's real duration (the API's actual_time is render time and would
    # wildly overstate the cost).
    out_seconds = _clip_seconds(path) or float(seconds)
    rate = (spec["rates"] or {}).get(resolution)
    if cost is not None:
        amount = f"${cost:.4f}"          # what apimart itself charged
    elif rate:
        amount = f"${out_seconds * rate:.4f}"
    else:
        amount = "cost not reported by apimart — check the account ledger"
    print("\n===== DONE =====")
    print(f"  video: {path}")
    print(f"  {spec['label']} ({resolution}, audio): {amount}  ({out_seconds:.0f}s output)")


if __name__ == "__main__":
    main()
