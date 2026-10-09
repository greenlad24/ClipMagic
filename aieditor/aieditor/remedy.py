"""THE REMEDY TABLE (architecture recommendation §4 "On failure"): a fixed table in code, not a model's idea.

When a take (gates.take_verdict) or a whole edit (rubric.ship) fails, the problem is classified and the
next action is read from this table — at most MAX_ROUNDS automatic rounds per job, then the job is HELD
with its failure list (never shipped quietly, never sent to Jake as notes).

    problem               remedies, in order
    wrong_content         rerecord_beat (<= 2) -> repair_agent -> salvage (sentence-snapped)
    timing                reassemble
    framing               resolve_camera
    generation_missing    regenerate (<= 2)
    privacy               widen_blur -> cut_beat
    challenge             retry_once -> fallback

HARD RULE (Jake 2026-10-09, "G1 trims pauses - I don't want that at all"; RULEBOOK R11): no remedy trims
the narration, cuts a pause or adds a cut to it. Every action below works on the SCREEN side only (a
recording, the camera plan, the blur, an off-camera asset, the screen pieces); tests/test_gates.py checks
the table statically. Narration integrity (D9) has no automatic remedy at all: it is held for Jake.

Who executes an action: p7's recorder (rerecord_beat, retry_once, reassemble), p7's capped off-camera
repair agent (repair_agent), p6's off-camera content step (regenerate), p5's blur (widen_blur), the
compose stage (resolve_camera, cut_beat, salvage, fallback). This module only decides.
"""

MAX_ROUNDS = 2              # automatic rounds per job (recommendation §4)

# action -> what it may change. Only screen-side artifacts: never the edl, the words or the audio.
ACTIONS = {
    "rerecord_beat":  {"by": "recorder", "changes": ["seg_recording"],
                       "what": "reset the beat to its start state and record it again"},
    "repair_agent":   {"by": "repair", "changes": ["playbook_beat", "seg_recording"],
                       "what": "the capped off-camera repair agent fixes the beat's selectors/state, then re-record"},
    "salvage":        {"by": "compose", "changes": ["screen_pieces"],
                       "what": "keep the clean footage on both sides of the bad span, edges on sentence starts; "
                               "every lost second is a D1 failure in the held list"},
    "reassemble":     {"by": "recorder", "changes": ["screen_assembly"],
                       "what": "re-run the elastic assembler (only motionless screen frames move)"},
    "resolve_camera": {"by": "compose", "changes": ["camera_plan"],
                       "what": "solve the camera again from the beat target boxes"},
    "regenerate":     {"by": "preprod", "changes": ["asset"],
                       "what": "generate the result off camera again and re-check it against the narration"},
    "widen_blur":     {"by": "privacy", "changes": ["blur_mask"],
                       "what": "grow the tracked blur over the legible private text"},
    "cut_beat":       {"by": "compose", "changes": ["screen_pieces"],
                       "what": "drop the beat's screen piece (a D1 failure, held)"},
    "retry_once":     {"by": "recorder", "changes": ["seg_recording"],
                       "what": "wait, then record the beat once more in a fresh session"},
    "fallback":       {"by": "compose", "changes": ["screen_pieces"],
                       "what": "the sentence-snapped fallback (salvage); the loss is a D1 failure, held"},
}

# narration-side artifacts no action may name (checked by tests/test_gates.py)
FORBIDDEN_CHANGES = ("edl", "words", "narration", "audio", "pauses", "joins", "cut")

TABLE = {
    "wrong_content":      ["rerecord_beat", "rerecord_beat", "repair_agent", "salvage"],
    "timing":             ["reassemble"],
    "framing":            ["resolve_camera"],
    "generation_missing": ["regenerate", "regenerate"],
    "privacy":            ["widen_blur", "cut_beat"],
    "challenge":          ["retry_once", "fallback"],
    "narration":          [],             # D9: never an automatic remedy — held for Jake
}

# most serious first: what a take with several problems is remedied for
SEVERITY = ["privacy", "challenge", "narration", "wrong_content", "generation_missing", "timing", "framing"]

# frame-guard kinds / content-QA checks / rubric dimensions -> problem
KIND_PROBLEM = {
    "challenge": "challenge", "error": "challenge",
    "account": "wrong_content",            # another person's account (the 'Keith' greeting): record again
    "privacy": "privacy", "brand": "privacy",   # Blue Bottle Coffee is kept out of frame by the blur
    "idle": "wrong_content", "idle_tail": "wrong_content", "garbled": "wrong_content",
    "empty": "generation_missing",
    "delivered": "wrong_content", "must": "wrong_content", "typed": "wrong_content",
    "no_challenge": "challenge",
    "on_word": "timing", "nav_on_word": "timing", "late": "timing",
    "framing": "framing",
}
DIM_PROBLEM = {
    "D1": "wrong_content", "D2": "timing", "D3": "wrong_content", "D4": "generation_missing",
    "D5": "framing", "D6": "framing", "D7": "wrong_content", "D8": "timing", "D9": "narration",
    "D10": "timing", "coverage": "wrong_content", "structure": "wrong_content", "privacy": "privacy",
}


def classify(kind):
    """A guard kind, a content check or a rubric dimension -> its problem class."""
    k = str(kind or "")
    return KIND_PROBLEM.get(k) or DIM_PROBLEM.get(k) or "wrong_content"


def worst(problems):
    """The most serious problem of a list (None for an empty list)."""
    ps = [p for p in problems if p]
    if not ps:
        return None
    return min(ps, key=lambda p: SEVERITY.index(p) if p in SEVERITY else len(SEVERITY))


def plan_for(problem):
    """The full remedy sequence of a problem (a copy)."""
    return list(TABLE.get(problem, []))


def next_action(problem, tried=()):
    """The next action of `problem`'s sequence given the actions already tried for it (a list of action
    names, repeats counted) — None when the table is exhausted: the beat/job is held."""
    seq = plan_for(problem)
    used = list(tried or [])
    for a in seq:
        if a in used:
            used.remove(a)
            continue
        return a
    return None


def rounds_left(rounds_done):
    return max(0, MAX_ROUNDS - int(rounds_done or 0))


def plan_round(failures, rounds_done=0, tried=None):
    """One automatic round for a list of failures ({dim|kind, beat, ...}): -> [{"failure", "problem",
    "action"}] for every failure that still has a remedy, [] when MAX_ROUNDS are used up or none has.
    `tried` maps a beat (or None) to the actions already tried for it."""
    if rounds_left(rounds_done) <= 0:
        return []
    tried = tried or {}
    out = []
    for f in failures or []:
        prob = classify(f.get("kind") or f.get("dim"))
        act = next_action(prob, tried.get(f.get("beat"), []))
        if act:
            out.append({"failure": f, "problem": prob, "action": act})
    return out
