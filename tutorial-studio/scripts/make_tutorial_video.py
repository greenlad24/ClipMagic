#!/usr/bin/env python3
"""v2 talking-head tutorial: ONE continuous Wan 3.0 clip that SPEAKS the script.

Wan 3.0 generates the voice itself (audio ON) from the full script — no ElevenLabs,
no AI director, no 5-scene pool. Feed it a creator start-frame URL + the script.

    .venv/bin/python scripts/make_tutorial_video.py --image-url <hosted.png> \
        --script .media/tutorial/script.txt --seconds 30

NOTE (verify on first paid run): the exact field Wan 3.0 reads the spoken script from
may be the prompt (used here) or a dedicated 'audio_script'/'dialogue' field, and the
max single-clip duration may cap below 30s (then stitch same-framing clips). Adjust the
_WAN_SPEECH_FIELD / duration handling once tested.
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


def wan_talking(image_url: str, script: str, key: str, *, resolution="720P",
                seconds=30, out="talkinghead.mp4") -> tuple[str, float]:
    """One continuous Wan 3.0 talking-head clip that SPEAKS `script` (audio ON)."""
    speech_prompt = (
        "A young woman looks at the camera and speaks naturally and confidently, with "
        "clear lip-sync and matching hand gestures, in a casual home setting, handheld "
        "phone realism. VOICE: a young woman's voice that is SOFT, gentle, slightly "
        "WHISPERY and cute, warm and friendly, a little breathy and intimate as if "
        "talking close to the mic — natural casual American English, clear and "
        "consistent, unhurried. AUDIO: "
        "ONLY her clean spoken voice — absolutely NO background music, no song, and no "
        "sound effects. She says exactly this, in English: \"" + script.strip() + "\""
    )
    body = {
        "model": "wan3.0-video",
        "image_urls": [image_url],
        _WAN_SPEECH_FIELD: speech_prompt,
        "resolution": resolution,
        "size": "9:16",
        "duration": seconds,
        "audio": True,          # Wan 3.0 generates the spoken voice itself
    }
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
            return path, float(node.get("actual_time", seconds))
        if st in ("failed", "error"):
            sys.exit(f"Wan failed: {json.dumps(node)[:300]}")
        time.sleep(8)
    sys.exit("Wan timed out")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image-url", required=True, help="hosted creator start-frame URL")
    ap.add_argument("--script", default=".media/tutorial/script.txt")
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--resolution", default="720P")
    ap.add_argument("--out", default="talkinghead.mp4")
    args = ap.parse_args()

    script = open(args.script, encoding="utf-8").read().strip()
    if not script:
        sys.exit("empty script")
    print(f"Wan 3.0 talking-head (audio ON), {args.seconds}s, speaking {len(script.split())} words …",
          flush=True)
    path, secs = wan_talking(args.image_url, script, _key(),
                             resolution=args.resolution, seconds=args.seconds, out=args.out)
    rate = 0.0686 if args.resolution == "720P" else (0.0343 if args.resolution == "480P" else 0.1371)
    # Wan bills per second of OUTPUT video, not GPU/render time. Use the clip's real
    # duration (secs from the API is render time and would wildly overstate the cost).
    out_seconds = _clip_seconds(path) or float(args.seconds)
    print("\n===== DONE =====")
    print(f"  video: {path}")
    print(f"  Wan 3.0 ({args.resolution}, audio): ${out_seconds * rate:.4f}  ({out_seconds:.0f}s output)")


if __name__ == "__main__":
    main()
