"""Per-app UI KITS — the real app's composer / menu / chip / working state / result views, captured from the live
DOM (computed styles + icon SVGs + a screenshot), so a motion template's prompt box looks exactly like the app the
narration is prompting (Jake 2026-10-09: "The prompt boxes should always look like the actual UI that the narration
is prompting (it should understand how the UI looks 1 to 1 and replicate it in the motion design)").

A kit lives in the skill folder: .claude/skills/jake-editor/ui-kits/<app>/kit.json (+ assets/, screenshots,
replica-compare.png, NOTES.md); ui-kits/README.md says how to capture one, schemas/uikit.schema.json is its form.

Rules (code-enforced here):
  - no kit for the app → None: the template draws the NEUTRAL box (the reference clips' own generic, unbranded
    composer) and the caller logs it — never another app's UI (for_app never falls back to a different app)
  - a kit holds nothing private beyond the display name "Jake Dawson" (RULEBOOK C7): load() refuses a kit whose
    text carries an e-mail address, a key/token or a phone number
"""
import json
import re
from pathlib import Path

from . import skill

MOTION_FONTS = Path(__file__).resolve().parent.parent / "motion" / "fonts"

# app id ← hosts (the kit's own "hosts" list wins; this is the fallback for the first kits)
HOSTS = {"chatgpt": ("chatgpt.com", "chat.openai.com"), "claude": ("claude.ai",)}

PRIVATE_RES = [
    ("e-mail address", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("API key / token", re.compile(r"\b(sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|"
                                   r"(?:api[_-]?key|bearer|token)\s*[:=]\s*[A-Za-z0-9_\-]{12,})", re.I)),
    ("phone number", re.compile(r"(?<![\d.#-])\+?\d[\d ()-]{8,}\d(?![\d.])")),
]
ALLOWED_NAME = "Jake Dawson"


class KitError(ValueError):
    pass


def root():
    return skill.ROOT / "ui-kits"


def apps():
    """App ids that have a kit."""
    r = root()
    return sorted(p.parent.name for p in r.glob("*/kit.json")) if r.is_dir() else []


def _strip_svg_paths(text):
    # path data / base64 font or image data are numbers and letters — never private, and they trip the phone regex
    text = re.sub(r'\sd="[^"]*"', " ", text)
    text = re.sub(r"data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+", " ", text)
    text = re.sub(r"\b(viewBox|points|transform|matrix)\b=?\"?[^\"]*\"?", " ", text)
    return text


def privacy_issues(kit):
    """[(what, sample)] of private-looking text in a kit (C7). Only "Jake Dawson" may appear as a name."""
    text = _strip_svg_paths(json.dumps(kit, ensure_ascii=False))
    out = []
    for what, rx in PRIVATE_RES:
        for m in rx.finditer(text):
            out.append((what, m.group(0)[:40]))
    return out


def _check(kit, app):
    for k in ("app", "composer"):
        if k not in kit:
            raise KitError(f"ui kit {app}: missing '{k}'")
    if kit["app"] != app:
        raise KitError(f"ui kit {app}: it says it is '{kit['app']}' — never another app's UI")
    comp = kit["composer"]
    for k in ("html", "css", "width", "height"):
        if k not in comp:
            raise KitError(f"ui kit {app}: composer.{k} missing")
    bad = privacy_issues(kit)
    if bad:
        raise KitError(f"ui kit {app}: private-looking text ({', '.join(w for w, _ in bad[:3])}) — RULEBOOK C7; "
                       "a kit holds nothing private beyond the display name 'Jake Dawson'")


def load(app, base=None):
    """The kit dict for app (validated), or None when there is none. Raises KitError for a broken/private kit."""
    p = Path(base or root()) / app / "kit.json"
    if not p.exists():
        return None
    try:
        kit = json.loads(p.read_text())
    except ValueError as e:
        raise KitError(f"ui kit {app}: kit.json is not JSON ({e})") from None
    _check(kit, app)
    kit["_dir"] = str(p.parent)
    return kit


def app_for_url(url, base=None):
    """The kit app id for a site url (kit 'hosts' first, then HOSTS) or None."""
    host = re.sub(r"^https?://(www\.)?", "", str(url or "")).split("/")[0].lower()
    if not host:
        return None
    r = Path(base or root())
    for p in sorted(r.glob("*/kit.json")) if r.is_dir() else []:
        try:
            hosts = json.loads(p.read_text()).get("hosts") or []
        except ValueError:
            continue
        if any(host == h or host.endswith("." + h) for h in hosts):
            return p.parent.name
    for app, hs in HOSTS.items():
        if any(host == h or host.endswith("." + h) for h in hs):
            return app
    return None


def for_app(app, log=None, base=None):
    """→ (kit | None, note). None = the neutral box; the note says why (for the job log). Never another app's kit."""
    if not app:
        note = "no app named for this prompt box — neutral box"
    else:
        try:
            kit = load(app, base)
        except KitError as e:
            kit, note = None, f"{e} — neutral box"
        else:
            note = f"ui kit {app}" if kit else f"no ui kit for {app} — neutral box (never another app's UI)"
            if kit:
                if log:
                    log(note)
                return kit, note
    if log:
        log(note)
    return None, note


def _inline_assets(obj, d):
    """'{{file:assets/x.svg}}' inside kit html / an item's "icon": "assets/x.svg" → the file's svg text."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("icon", "icon_file") and isinstance(v, str) and v.endswith(".svg") and (d / v).exists():
                out["icon_html"] = (d / v).read_text()
            else:
                out[k] = _inline_assets(v, d)
        return out
    if isinstance(obj, list):
        return [_inline_assets(x, d) for x in obj]
    if isinstance(obj, str) and "{{file:" in obj:
        return re.sub(r"\{\{file:([^}]+)\}\}", lambda m: (d / m.group(1)).read_text() if (d / m.group(1)).exists() else "", obj)
    return obj


def scene_kit(kit):
    """The kit as a motion scene carries it: assets inlined, only fonts that exist in motion/fonts, no paths."""
    if not kit:
        return None
    d = Path(kit.get("_dir") or ".")
    out = _inline_assets({k: v for k, v in kit.items() if not k.startswith("_") and k not in ("captured",)}, d)
    out["fonts"] = {fam: f for fam, f in (kit.get("fonts") or {}).items()
                    if isinstance(f, str) and (MOTION_FONTS / f).exists()}
    return out
