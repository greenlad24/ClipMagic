"""The talking-head video models this pipeline can render with.

One table, because three separate things need the same facts: `run_reel.py`
(how long a script to write), `make_tutorial_video.py` (how to shape the request
body) and the sidecar's job API (what to accept).

`seconds` is the ONE clip length a model renders here, not a maximum the caller
may lower. It exists because MiniMax-H3 caps a single clip at 15s while Wan 3.0
does the 30s the reel format was built around — so choosing H3 chooses a 15s
reel, and the scripter is told to write for that length rather than producing
30s of words that get cut off mid-sentence.

Kept in step with lab/server/src/tutorial/videoModels.ts: the Lab offers these
choices, this validates them, and a drift is a model the UI offers and the
pipeline refuses.
"""

from __future__ import annotations

# rate = USD per second of OUTPUT video, per resolution, or None where apimart
# publishes no rate. A None rate is not a guess dressed up as a number: the run
# prints the cost apimart itself reports on the finished task instead.
VIDEO_MODELS: dict[str, dict] = {
    "wan3.0-video": {
        "label": "Wan 3.0",
        "seconds": 30,
        "resolutions": ("480P", "720P", "1080P"),
        "default_resolution": "720P",
        "rates": {"480P": 0.0343, "720P": 0.0686, "1080P": 0.1371},
    },
    "MiniMax-H3": {
        "label": "MiniMax H3",
        "seconds": 15,
        "resolutions": ("768P", "2K"),
        "default_resolution": "768P",
        "rates": {"768P": None, "2K": None},
    },
}

DEFAULT_MODEL = "wan3.0-video"


def spec(model: str) -> dict:
    """The table entry for `model`, or the default model's."""
    return VIDEO_MODELS.get(model) or VIDEO_MODELS[DEFAULT_MODEL]


def normalize(model: str, resolution: str = "") -> tuple[str, str, int]:
    """(model, resolution, seconds) — anything unknown falls back to a default
    rather than reaching the API as a 400."""
    name = model if model in VIDEO_MODELS else DEFAULT_MODEL
    s = VIDEO_MODELS[name]
    res = resolution if resolution in s["resolutions"] else s["default_resolution"]
    return name, res, int(s["seconds"])
