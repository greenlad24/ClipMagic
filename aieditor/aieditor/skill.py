"""THE SKILL FOLDER — one home for the editor's know-how (recommendation step 2).

aieditor/.claude/skills/jake-editor/ holds the RULEBOOK (Jake's rulings + reference rules), the technique
catalogue, the lessons, the scoring rubric, the machine numbers (rules.json), the plan/playbook schemas
and one playbook per app. Code and prompts read it ONLY through this module, so there is never a second,
drifting copy (the retired screencast copy lacked C7, L4 and R7-R10).

Precedence: Jake rulings > RULEBOOK > TECHNIQUES > rest.

The folder lies under aieditor/, so a container that mounts the code at /a sees it at
/a/.claude/skills/jake-editor/. AIEDITOR_SKILL_DIR points at another copy (tests, a droplet snapshot).
"""
import functools
import json
import os
from pathlib import Path

from . import config

ROOT = Path(os.environ.get("AIEDITOR_SKILL_DIR") or (config.CODE / ".claude" / "skills" / "jake-editor"))


def _text(name):
    return (ROOT / name).read_text()


def rulebook_text():
    """RULEBOOK.md — the rules every plan, recording and judgement follows."""
    return _text("RULEBOOK.md")


def techniques_text():
    """TECHNIQUES.md — the reference technique catalogue (ids CUT/TR/ZM/PN/…)."""
    return _text("TECHNIQUES.md")


def insights_text():
    return _text("INSIGHTS.md")


def rubric_text():
    """rubric.md — D1-D10 (references = 100 %) and the ship rule."""
    return _text("rubric.md")


@functools.lru_cache(maxsize=None)
def rules():
    """rules.json — the machine numbers; every group carries 'src'. Cached: treat as read-only."""
    return json.loads(_text("rules.json"))


def schema(name):
    """schemas/<name>.schema.json ('plan' | 'playbook')."""
    return json.loads(_text(f"schemas/{name}.schema.json"))


def playbook_path(app):
    return ROOT / "playbooks" / f"{app}.json"


def playbook(app):
    """playbooks/<app>.json as stored (use aieditor.playbook.load for the validated form)."""
    return json.loads(playbook_path(app).read_text())


def playbooks():
    """The app ids that have a playbook."""
    return sorted(p.stem for p in (ROOT / "playbooks").glob("*.json"))
