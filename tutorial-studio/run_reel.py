#!/usr/bin/env python3
"""Tutorial Studio — one command, topic to finished reel.

    python run_reel.py "how to <thing> with <tool>"
    python run_reel.py "..." --reuse-base        # skip the paid video step, reuse the last talking-head
    python run_reel.py "..." --video-model MiniMax-H3 --video-resolution 768P

Pipeline: script (Qwen) -> talking-head start frame (GPT Image 2) -> talking clip
(with its own voice) -> whisper word timings -> carousel (Claude API) -> slides + grid +
prompt screenshot (headless browser) -> assemble overlays + memes + SFX -> reel.mp4.

The talking clip is Wan 3.0 by default or MiniMax H3 (see scripts/video_models.py).
The model decides the reel's length, so it is chosen BEFORE the script is written:
H3 renders 15s clips, so it gets a 15s script, not a 30s one it would cut off.

Run from the package root (so .media/tutorial/... paths resolve). Needs .env with
APIMART_API_KEY + ANTHROPIC_API_KEY. The video step is the only large spend (~$2 on Wan).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

from scripts.video_models import VIDEO_MODELS, DEFAULT_MODEL, normalize

PY = sys.executable
T = ".media/tutorial"


def run(*args):
    print("\n$ " + " ".join(str(a) for a in args), flush=True)
    if subprocess.run([PY, *args]).returncode != 0:
        sys.exit(f"step failed: {' '.join(map(str, args))}")


def sh(cmd):
    print("\n$ " + cmd, flush=True)
    if subprocess.run(cmd, shell=True).returncode != 0:
        sys.exit("failed: " + cmd)


def transcribe(base):
    try:
        import json
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print("whisper unavailable -> phrase-level captions:", e); return
    subprocess.run(["ffmpeg", "-y", "-i", base, "-vn", "-ac", "1", "-ar", "16000",
                    f"{T}/vo.wav"], capture_output=True)
    m = WhisperModel("base.en", device="cpu", compute_type="int8")
    segs, _ = m.transcribe(f"{T}/vo.wav", word_timestamps=True)
    words = [{"w": w.word.strip(), "a": round(w.start, 2), "b": round(w.end, 2)}
             for s in segs for w in (s.words or [])]
    json.dump(words, open(f"{T}/vo_words.json", "w"))
    print(f"word timings: {len(words)} words")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("topic")
    ap.add_argument("--reuse-base", action="store_true",
                    help="reuse the existing talking-head clip (skip the paid video step)")
    ap.add_argument("--video-model", default=DEFAULT_MODEL, choices=sorted(VIDEO_MODELS),
                    help="which apimart model renders (and speaks) the talking-head clip")
    ap.add_argument("--video-resolution", default="",
                    help="model-specific (Wan 480P/720P/1080P, H3 768P/2K); "
                         "defaults to the model's own")
    ap.add_argument("--outfit", default="a comfy cream knit sweater")
    ap.add_argument("--scene", default="a cozy living-room corner with a leafy plant, framed wall art and a warm lamp")
    ap.add_argument("--out", default=f"{T}/reel.mp4")
    ap.add_argument("--ref-image", default="",
                    help="uploaded avatar image used as the identity reference for the start frame")
    ap.add_argument("--environment", default="",
                    help="the ONE place every video is shot in (a different corner of it each time)")
    ap.add_argument("--script-json", default="",
                    help="an already-written script.json (batch flow: approved before rendering). "
                         "Skips the Qwen scripting step.")
    a = ap.parse_args()
    os.makedirs(f"{T}/assets", exist_ok=True)
    model, resolution, seconds = normalize(a.video_model, a.video_resolution)

    # 1. script — unless the caller brings one that has already been approved.
    if a.script_json:
        import json as _json
        import shutil as _shutil
        obj = _json.load(open(a.script_json, encoding="utf-8"))
        if not (obj.get("script") or "").strip():
            sys.exit(f"--script-json has no script text: {a.script_json}")
        _shutil.copyfile(a.script_json, f"{T}/script.json")
        with open(f"{T}/script.txt", "w", encoding="utf-8") as fh:
            fh.write(obj["script"])
        print(f"\n$ (approved script: {len(obj['script'].split())} words — skipping Qwen)", flush=True)
    else:
        run("scripts/make_tutorial_script.py", a.topic, "--seconds", str(seconds))

    # 2 & 3. talking-head: start frame -> video model (voice included). Skip with --reuse-base.
    base = f"{T}/talkinghead2.mp4"
    if not (a.reuse_base and os.path.exists(base)):
        frame_args = ["scripts/make_talkinghead_frame.py", "--outfit", a.outfit,
                      "--scene", a.scene, "--out", "start.png"]
        if a.ref_image:
            frame_args += ["--ref-image", a.ref_image]
        if a.environment:
            frame_args += ["--environment", a.environment]
        run(*frame_args)
        url = open(f"{T}/shots_in/start_url.txt").read().strip()
        run("scripts/make_tutorial_video.py", "--image-url", url,
            "--script", f"{T}/script.txt", "--seconds", str(seconds),
            "--model", model, "--resolution", resolution, "--out", "talkinghead2.mp4")

    # 4. word timings (word-by-word captions + word-synced elements)
    transcribe(base)

    # 5. real carousel (Claude API) + slides (headless browser)
    run("scripts/generate_carousel.py", a.topic)
    run("scripts/render_slides.py")

    # 6. examples grid montage
    sh(f"ffmpeg -y -pattern_type glob -i '{T}/assets/slide_*.png' "
       f"-filter_complex \"scale=360:-1,tile=3x4:margin=8:padding=8:color=0x14141a\" {T}/assets/grid.png")

    # 7. prompt-in-chat screenshot
    run("scripts/make_prompt_shot.py")

    # 8. assemble everything (memes auto-normalized inside)
    run("scripts/assemble_reel.py", "--base", base, "--out", a.out)
    print(f"\n✅ reel -> {a.out}")


if __name__ == "__main__":
    main()
