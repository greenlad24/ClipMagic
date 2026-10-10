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
# single model calls of pre-production (recommendation §3): ONE Opus plan call (effort high, strict JSON,
# re-asked at most PLAN_REASKS times with the plan check's errors), the overlay plan and the generation
# check (vision) on Sonnet. Off-camera generations are spaced GEN_SPACING_S apart (ChatGPT's "Unusual
# activity" block) and regenerated at most GEN_REGENS times when they miss what the narration names.
PLAN_MODEL = "claude-opus-5-5"
OVERLAY_MODEL = "claude-opus-5-5"   # Jake 2026-10-09: "I want all of them to use Opus 5.5"
VISION_MODEL = "claude-opus-5-5"
PLAN_REASKS = 2
GEN_REGENS = 9                 # Jake 2026-10-09 (decision 5): "try again until succeeding (up to 10 tries)" = 1 + 9 regenerations
GEN_SPACING_S = float(os.environ.get("AIEDITOR_GEN_SPACING_S") or 45)
GROQ_MODEL = "whisper-large-v3-turbo"

# ── recorder mode (architecture recommendation step 1, "stop the bleeding") ──────────────────
# Code records, single model calls decide, agents work ONLY off camera. The per-step AI loop that
# chose each action on camera (agentrec.record_segment) is switched OFF; a logged-in segment waits
# for the scripted recorder (package p7) and the job is held, never filled with A-roll quietly.
RECORDER = {"mode": "scripted", "on_camera_agent": False}
# a factory server (cloud.run_remote exports this) ignores every override below
FACTORY_SERVER = os.environ.get("AIEDITOR_FACTORY_SERVER") == "1"


def recorder(factory=None):
    """The recorder mode in force. Off the factory a developer may set AIEDITOR_ON_CAMERA_AGENT=1
    for a manual experiment; in factory mode the env is ignored and the defaults above hold."""
    factory = FACTORY_SERVER if factory is None else factory
    out = dict(RECORDER)
    if not factory and os.environ.get("AIEDITOR_ON_CAMERA_AGENT") == "1":
        out["on_camera_agent"] = True
    return out


# ── Claude API spend: one ledger line per call (aieditor/llm.py → apiledger.py) ──────────────
# On a factory server cloud.run_remote points this at <job>/api-ledger.jsonl and merges it back.
API_LEDGER = Path(os.environ.get("AIEDITOR_API_LEDGER", str(WORK / "ledger" / "api.jsonl")))
# $ per million tokens (claude-api skill, cached 2026-09-25). Cache writes are 1.25× input
# (5-minute TTL), cache reads as listed. An unknown model is priced as Opus (the dearest we use).
API_PRICES = {
    "claude-opus-5-5":   {"in": 4.0, "out": 20.0, "cache_read": 0.20, "cache_write": 5.0},
    "claude-sonnet-5-5": {"in": 2.0, "out": 10.0, "cache_read": 0.20, "cache_write": 2.5},
    "claude-haiku-4-5":  {"in": 1.0, "out": 5.0, "cache_read": 0.10, "cache_write": 1.25},
}
API_PRICE_DEFAULT = "claude-opus-5-5"
# a factory server reaches US-only pages (pricing / visitor views) through the job's US proxy
US_PROXY = os.environ.get("AIEDITOR_US_PROXY", "")


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
