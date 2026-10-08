"""Paths, images and keys. Keys come from the SAME .env the Lab container reads,
so there is one place to rotate them."""
import os
from pathlib import Path

WORK = Path(os.environ.get("AIEDITOR_WORK", "/opt/aieditor-work"))
JOBS = WORK / "jobs"
MODELS = WORK / "models"                      # torch hub cache for the aligner
ENV_FILE = Path(os.environ.get("AIEDITOR_ENV", "/opt/clipmagic/.env"))
CODE = Path(__file__).resolve().parent.parent

FFMPEG_IMAGE = "hyperframes-runner:0.8.30"    # the host has no ffmpeg; this image has 6.x
ALIGNER_IMAGE = "aieditor-aligner:0.1"
# recorder + camera image. 0.2 = 0.1 + Google Chrome stable + the macOS font look (screencast/Dockerfile;
# Jake 2026-10-08 "it should be acting like a real chrome on Mac not chromium")
SC_IMAGE = os.environ.get("AIEDITOR_SC_IMAGE", "aieditor-screencast:0.2")
# on a factory server the recorder's browser leaves the internet through the main box (cloud.py EGRESS)
EGRESS_PROXY = os.environ.get("AIEDITOR_EGRESS_PROXY", "")
# The box also serves the Lab, Postiz and Postgres: media work gets 3 of 4 cores.
CPUSET = os.environ.get("AIEDITOR_CPUSET", "1,2,3")
MEMORY = os.environ.get("AIEDITOR_MEMORY", "3g")


def cpu_count():
    """Cores in CPUSET ("1,2,3" here; "0-31" on a factory server)."""
    n = 0
    for part in CPUSET.split(","):
        a, _, b = part.strip().partition("-")
        n += (int(b) - int(a) + 1) if b else 1
    return max(1, n)

TAKES_MODEL = "claude-opus-5-5"
GROQ_MODEL = "whisper-large-v3-turbo"


def env_key(name):
    v = os.environ.get(name)
    if v:
        return v
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""
