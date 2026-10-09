"""THE SCREEN-REFERENCE DETECTOR (RULEBOOK R13 / C8, Jake 2026-10-09 after the first graphics-only hand-off:
"everytime the narrator shows something on the screens or refer to the screen there should be a screencast").

Deterministic, sentence level: every sentence of the narration (planfit.sentences) whose words match one of the
skill's cues (rules.json "screen_reference".cues — deixis "look at this", "here's", "this one", "you can see",
"on the left", "right there", "this button/menu/image…", a named UI element, a UI step "click/open/type/paste/
select/drag/scroll/upload/hit send", reading the screen "it says") is FLAGGED. The presenter's own lines
(planfit.PRESENTER_RE: calls to action, the sign-off) are never flagged.

A flagged sentence is COVERED when screencast spans cover at least min_cover (0.8) of its time. The plan check
(director.check_plan) turns every uncovered one into a "screen_ref" error (re-asked like the others); the hand-off
(handoff.py) gives a still-uncovered one its own slot. Nothing here removes or shrinks a planned screencast.
"""
import re

from . import planfit, skill

_CACHE = {}


def config():
    """rules.json "screen_reference" → {"min_cover", "cues": [(id, compiled re)]} (cached)."""
    if "c" not in _CACHE:
        g = skill.rules().get("screen_reference") or {}
        _CACHE["c"] = {"min_cover": float(g.get("min_cover", 0.8)),
                       "cues": [(c["id"], re.compile(c["re"], re.I)) for c in g.get("cues") or []]}
    return _CACHE["c"]


def _text(sent):
    return re.sub(r"\s+", " ", " ".join(str(w["word"]) for w in sent)).strip()


def cues_in(text):
    """The cue ids that match one sentence's text ([] = a plain talking sentence)."""
    if planfit.PRESENTER_RE.search(text):
        return []
    return [cid for cid, rx in config()["cues"] if rx.search(text)]


def flag(words):
    """Every sentence that shows or refers to the screen → [{t0, t1, text, word_ids, cues}] in time order."""
    out = []
    for s in planfit.sentences(words or []):
        if not s:
            continue
        txt = _text(s)
        cues = cues_in(txt)
        if cues:
            out.append({"t0": float(s[0]["start"]), "t1": float(s[-1]["end"]), "text": txt,
                        "word_ids": [w["i"] for w in s if "i" in w], "cues": cues})
    return out


def covered_frac(t0, t1, spans):
    """How much of [t0, t1] the (possibly overlapping) spans cover, 0..1."""
    if t1 <= t0:
        return 1.0
    iv = sorted((max(t0, float(a)), min(t1, float(b))) for a, b in spans if float(b) > t0 and float(a) < t1)
    tot, cur_a, cur_b = 0.0, None, None
    for a, b in iv:
        if cur_b is None or a > cur_b:
            if cur_b is not None:
                tot += cur_b - cur_a
            cur_a, cur_b = a, b
        else:
            cur_b = max(cur_b, b)
    if cur_b is not None:
        tot += cur_b - cur_a
    return tot / (t1 - t0)


def uncovered(flags, spans, min_cover=None):
    """The flagged sentences the screencast spans [(t0, t1)] leave (mostly) on the A-roll."""
    m = config()["min_cover"] if min_cover is None else min_cover
    return [f for f in flags if covered_frac(f["t0"], f["t1"], spans) < m]
