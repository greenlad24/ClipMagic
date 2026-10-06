"""ffmpeg/ffprobe through the hyperframes-runner image (the host has no ffmpeg).

Every call mounts exactly the directories it needs and runs on the cores the
media work is allowed (config.CPUSET).
"""
import json
import subprocess
from pathlib import Path

from . import config


def _docker(entry, args, mounts, check=True, capture=True):
    cmd = ["docker", "run", "--rm", "--cpuset-cpus", config.CPUSET, "--memory", config.MEMORY]
    for host, inner, mode in mounts:
        cmd += ["-v", f"{host}:{inner}:{mode}"]
    cmd += ["--entrypoint", entry, config.FFMPEG_IMAGE, *args]
    p = subprocess.run(cmd, capture_output=capture, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"{entry} failed: {(p.stderr or '')[-800:]}")
    return p


def probe(path):
    path = Path(path).resolve()
    p = _docker("ffprobe", ["-v", "error", "-show_entries",
                            "stream=codec_type,width,height,r_frame_rate:format=duration",
                            "-of", "json", f"/in/{path.name}"], [(path.parent, "/in", "ro")])
    j = json.loads(p.stdout)
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    n, d = v["r_frame_rate"].split("/")
    return {"width": v["width"], "height": v["height"], "fps_num": int(n), "fps_den": int(d),
            "fps": int(n) / int(d), "duration": float(j["format"]["duration"]),
            "has_audio": any(s["codec_type"] == "audio" for s in j["streams"])}


def extract_audio(src, job):
    """16 kHz mono WAV (analysis + alignment), 16 kHz 32 kb/s MP3 (Groq), 48 kHz stereo
    PCM (every audio piece is cut from this: seeking inside AAC is not frame-exact)."""
    src = Path(src).resolve()
    job = Path(job).resolve()
    _docker("ffmpeg", ["-v", "error", "-y", "-i", f"/in/{src.name}",
                       "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/job/audio16k.wav",
                       "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "/job/audio16k.mp3",
                       "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "/job/full48k.wav"],
            [(src.parent, "/in", "ro"), (job, "/job", "rw")])
