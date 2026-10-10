"""MOTION TEMPLATES — the motion-design language Jake added on 2026-10-09 from four reference clips
(/opt/aieditor-work/reference/motion-2026-10-09; specs /opt/aieditor-work/reference/specs/<id>.md):

  MO01 verb_swap       "Grok Bot can now ⟨search|read|analyze⟩ X" — the verb rolls and swaps, its own colour each
  MO02 tagline_build   "Every agent. One inbox." — words build one by one, blue dots settle as selection handles, bar wipe
  MO03 prompt_menu     a composer's "/" menu: the cursor hovers down the rows, picks one, the menu collapses
  MO04 prompt_card_3d  a tilted frosted prompt card: the prompt types in, file chips fly in, "Working"
  MO05 prompt_result   (hook only) the prompt card, then the app's REAL result in the app's own result UI
  MO06 prompt_highlight the app's prompt box (camera push-in, prompt typing) with marker highlights on the key
                       phrases as the narration says them (5th clip, Claude.ai composer, 2026-10-09)
  MO07 long_prompt_scroll a long structured prompt/message: zoom in, slow readable scroll, marker highlights
                       accumulating on the phrases he calls out (6th clip, Claude chat view)

Jake's words (binding): "add them as options to overlays"; "The prompt boxes should always look like the actual UI
that the narration is prompting (… 1 to 1 …)"; "add specific instructions to how to use each one of them"; the
prompt motion can show the RESULT "instead of plain boring screencast" when the narration says "you just type one
sentence in plain English and it…" — "in the hook part".

What lives where:
  rules.json "motion_templates"           the hard limits this module ENFORCES (durations, counts, text, hook zone)
  templates/<id>.md                       the usage instructions the overlay planner READS (director.overlay_prompt)
  motion/templates/<id>.js                the renderer (runtime.js; render.mjs renders a scene with "template")
  motion/templates/<id>.kf.json           the measured keyframes (design-free; merged into keyframes.json "templates")
  motion/templates/<id>.style.json        the swappable look
  ui-kits/<app>/kit.json                  the real app UI the prompt boxes draw (aieditor/uikits.py); none → neutral box

Every template is a full-frame hook graphic (its own backdrop): it counts as a PLATE in the structure gate
(plate_frac <= 1.5 %, first 40 s only, REFERENCE-BASELINE §1a) and as an overlay of the 'first' zone in the G7 budget.
In the body, a prompt moment stays a screencast (the default); motion templates there are refused.
"""
import base64
import json
import mimetypes
import re
from pathlib import Path

from . import skill, uikits

MOTION = Path(__file__).resolve().parent.parent / "motion"
TDIR = MOTION / "templates"


def rules():
    return skill.rules().get("motion_templates") or {}


def approved():
    """The templates Jake has approved one by one (rules.json motion_templates.approved). Jake 2026-10-10 approved
    verb_swap (Roboto 500) and tagline_build after the round-2 preview; the others stay off until he approves them."""
    if rules().get("enabled", False):
        return set(IDS)
    return {t for t in (rules().get("approved") or []) if t in IDS}


def enabled():
    """Any motion template on? (rules.json motion_templates.enabled = all; else the per-template 'approved' list.)
    None on: the overlay planner never offers or accepts one, the hook PROMPT → RESULT (MO05) is never placed or
    generated, the structure gate is as before."""
    return bool(approved())


def is_on(tid):
    return tid in approved()


def ids():
    return tuple((rules().get("ids") or {}).keys())


IDS = ("verb_swap", "tagline_build", "prompt_menu", "prompt_card_3d", "prompt_highlight", "long_prompt_scroll",
       "prompt_result")
TECHNIQUE = {"verb_swap": "MO01", "tagline_build": "MO02", "prompt_menu": "MO03", "prompt_card_3d": "MO04",
             "prompt_highlight": "MO06", "long_prompt_scroll": "MO07",
             "prompt_result": "MO05"}


def spec(tid):
    s = (rules().get("ids") or {}).get(tid)
    if s is None:
        raise KeyError(f"unknown motion template {tid}")
    return s


def is_motion(tid):
    return tid in IDS


def hook_s():
    return float(rules().get("hook_s", 40.0))


# ─────────────────────────────── parameters (limits from rules.json) ───────────────────────────────

def _words(s):
    return [w for w in str(s or "").split() if w]


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, str):
        return [x.strip() for x in re.split(r"[|,\n]", v) if x.strip()]
    return list(v)


def validate_params(tid, fields):
    """fields (the overlay's fields) → (params with defaults, [errors]). Errors are the hard limits of rules.json;
    a plan with any is refused (the overlay is dropped and the reason logged)."""
    sp = spec(tid)
    out, errs = {}, []
    for name, lim in (sp.get("params") or {}).items():
        v = (fields or {}).get(name)
        t = lim.get("type")
        if v is None or v == "" or v == []:
            if "default" in lim:
                out[name] = lim["default"]
                continue
            if t == "list" and lim.get("min", 1) == 0:
                out[name] = []
                continue
            errs.append(f"{tid}: '{name}' is required")
            continue
        if t == "string":
            v = str(v).strip()
            if "max_chars" in lim and len(v) > lim["max_chars"]:
                errs.append(f"{tid}: '{name}' is {len(v)} characters (max {lim['max_chars']})")
            if "min_chars" in lim and len(v) < lim["min_chars"]:
                errs.append(f"{tid}: '{name}' is {len(v)} characters (min {lim['min_chars']})")
            n = len(_words(v))
            if "max_words" in lim and n > lim["max_words"]:
                errs.append(f"{tid}: '{name}' has {n} words (max {lim['max_words']})")
            if "min_words" in lim and n < lim["min_words"]:
                errs.append(f"{tid}: '{name}' has {n} words (min {lim['min_words']})")
        elif t == "list" and v == "kit" and lim.get("kit_ok"):
            pass                                           # the app's real menu rows from its UI kit
        elif t == "list":
            v = _as_list(v)
            labels = [x.get("label", x.get("text", x.get("name", ""))) if isinstance(x, dict) else str(x) for x in v]
            if len(v) < lim.get("min", 0) or len(v) > lim.get("max", 99):
                errs.append(f"{tid}: '{name}' has {len(v)} items ({lim.get('min', 0)}-{lim.get('max')})")
            long = [x for x in labels if len(x) > lim.get("max_chars", 999)]
            if long:
                errs.append(f"{tid}: '{name}' item '{long[0][:40]}' is over {lim['max_chars']} characters")
        elif t == "int":
            try:
                v = int(v)
            except (TypeError, ValueError):
                errs.append(f"{tid}: '{name}' must be a whole number")
                continue
            if v < lim.get("min", -10 ** 9) or v > lim.get("max", 10 ** 9):
                errs.append(f"{tid}: '{name}' = {v} is out of range")
        elif t == "bool":
            v = bool(v)
        elif t == "object":
            if not isinstance(v, dict):
                errs.append(f"{tid}: '{name}' must be an object")
                continue
        elif t == "number":
            try:
                v = float(v)
            except (TypeError, ValueError):
                errs.append(f"{tid}: '{name}' must be a number")
                continue
            if v < lim.get("min", -1e9) or v > lim.get("max", 1e9):
                errs.append(f"{tid}: '{name}' = {v} is out of range ({lim.get('min')}-{lim.get('max')})")
        out[name] = v
    if tid == "prompt_menu" and not errs and out["items"] != "kit" and not 0 <= out["pick"] < len(out["items"]):
        errs.append(f"prompt_menu: pick {out['pick']} is not one of the {len(out['items'])} items")
    if tid in ("prompt_highlight", "long_prompt_scroll") and not errs:
        miss = [p for p in out["phrases"] if str(p) not in str(out["prompt"])]
        if miss:
            errs.append(f"{tid}: phrase '{str(miss[0])[:40]}' is not in the prompt (phrases are exact substrings)")
    if tid == "tagline_build" and not errs:
        out["words"] = str(out["words"])
    return out, errs


# ─────────────────────────────── timing: beats on the spoken words ───────────────────────────────

def _norm(w):
    return re.sub(r"[^a-z0-9]", "", str(w).lower())


def _find_word(ws, text, after=None):
    """The first spoken word (at/after `after` s) that starts `text` (first content token, plural-tolerant)."""
    toks = [_norm(t) for t in _words(text) if _norm(t)]
    if not toks:
        return None
    small = {"a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "my", "your", "it", "is", "can", "now"}
    k = next((i for i, t in enumerate(toks) if t not in small), 0)
    for w in ws:
        if after is not None and w["start"] < after - 1e-6:
            continue
        n = _norm(w["word"])
        if n == toks[k] or (len(toks[k]) > 3 and n.rstrip("s") == toks[k].rstrip("s")) or \
                (len(toks[k]) > 4 and n.startswith(toks[k][:5])):
            return w
    return None


def window(ev, video):
    """(t0, t1) output seconds for a motion overlay: from its start word − lead to its end word, clamped to the
    template's duration limits (a too-short span is lengthened, a too-long one cut at the max)."""
    sp = spec(ev["template"])
    lo, hi = sp["duration_s"]
    pos = {w["i"]: w for w in video["words"]}
    a, b = pos.get(ev.get("start")), pos.get(ev.get("end"))
    t0 = ev.get("t0") if ev.get("t0") is not None else max(0.0, (a["start"] if a else 0.0) - float(rules().get("lead_s", 0.2)))
    t1 = ev.get("t1") if ev.get("t1") is not None else ((b["end"] + 0.3) if b else t0 + lo)
    t1 = min(max(t1, t0 + lo), t0 + hi, video.get("duration", t0 + hi))
    return round(t0, 3), round(t1, 3)


def beats(ev, video, t0=None, t1=None):
    """{beat: seconds from the clip start}. Explicit beats ({name: word id} or [{name, word}]) win; the rest are
    found on the spoken words (each verb / tagline word / the picked row / the prompt's first words)."""
    if t0 is None:
        t0, t1 = window(ev, video)
    ws = [w for w in video["words"] if t0 - 0.05 <= w["start"] <= t1 + 0.05]
    pos = {w["i"]: w for w in video["words"]}
    out = {}
    raw = ev.get("beats") or {}
    if isinstance(raw, list):
        raw = {x.get("name"): x.get("word") for x in raw if isinstance(x, dict)}
    for name, wid in raw.items():
        if wid in pos and t0 - 0.05 <= pos[wid]["start"] <= t1:
            out[name] = round(max(0.0, pos[wid]["start"] - t0), 3)
    f, tid = ev.get("params") or ev.get("fields") or {}, ev["template"]
    out.setdefault("in", round(min(float(rules().get("lead_s", 0.2)), t1 - t0), 3))
    if tid == "verb_swap":
        prev = None
        for k, v in enumerate(_as_list(f.get("verbs"))):
            w = _find_word(ws, v.get("text") if isinstance(v, dict) else v, prev)
            if w and f"verb_{k}" not in out:
                out[f"verb_{k}"] = round(w["start"] - t0, 3)
            prev = w["end"] if w else prev
    elif tid == "tagline_build":
        prev = None
        for k, word in enumerate(_words(f.get("words"))):
            w = _find_word(ws, word, prev)
            if w and f"word_{k}" not in out:
                out[f"word_{k}"] = round(w["start"] - t0, 3)
            prev = w["end"] if w else prev
    elif tid == "prompt_menu":
        items = _as_list(f.get("items"))
        try:
            lab = items[int(f.get("pick", 0))]
            w = _find_word(ws, lab.get("label") if isinstance(lab, dict) else lab)
            if w and "pick" not in out:
                out["pick"] = round(w["start"] - t0, 3)
        except (ValueError, IndexError, TypeError):
            pass
    elif tid in ("prompt_highlight", "long_prompt_scroll"):
        prev = None
        for k, ph in enumerate(_as_list(f.get("phrases")) if not isinstance(f.get("phrases"), str) else [f["phrases"]]):
            w = _find_word(ws, ph, prev)
            if w and f"hl_{k}" not in out:
                out[f"hl_{k}"] = round(w["start"] - t0, 3)
            prev = w["end"] if w else prev
        w = _find_word(ws, " ".join(_words(f.get("prompt"))[:3]))
        if w and "type" not in out:
            out["type"] = round(w["start"] - t0, 3)
    elif tid in ("prompt_card_3d", "prompt_result"):
        w = _find_word(ws, " ".join(_words(f.get("prompt"))[:3]))
        if w and "type" not in out:
            out["type"] = round(w["start"] - t0, 3)
    return dict(sorted(out.items(), key=lambda kv: kv[1]))


# ─────────────────────────────── the PROMPT → RESULT hook moment (MO05) ───────────────────────────────

PROMPT_RESULT_RE = re.compile(
    r"\b(?:(?:you\s+)?just\s+(?:type|write|say|describe|tell\s+it|ask(?:\s+it)?)|type\s+(?:one|a|a\s+single)\s+(?:sentence|line|prompt)|"
    r"(?:one|a\s+single)\s+(?:sentence|line|prompt)|in\s+plain\s+english)\b[^.?!]*?\b(?:and|then)\s+it\b", re.I)
_VERB_3RD = re.compile(r"^(\w+?)(ies|es|s)$")


def is_prompt_result_line(text):
    """'you just type one sentence in plain English and it …' (Jake 2026-10-09)."""
    return bool(PROMPT_RESULT_RE.search(str(text or "")))


def derive_prompt(text):
    """The prompt the hook line implies, for the OFF-CAMERA generation (never shown unless the app really answered):
    '… and it builds you a full landing page for a coffee shop' → 'Build me a full landing page for a coffee shop'.
    A quoted prompt in the line wins. None when nothing usable follows 'and it'."""
    s = str(text or "")
    q = re.search(r"[\"“]([^\"”]{8,220})[\"”]", s)
    if q:
        return q.group(1).strip()
    m = re.search(r"\b(?:and|then)\s+it\s+(?:will\s+|can\s+|just\s+)?(.+)$", s, re.I)
    if not m:
        return None
    rest = re.split(r"[.?!;]|\s+—\s+|\s+-\s+", m.group(1))[0].strip()
    words = rest.split()
    if len(words) < 2:
        return None
    v = words[0].lower()
    mm = _VERB_3RD.match(v)
    if mm and v not in ("is", "was", "has", "does"):
        stem, suf = mm.group(1), mm.group(2)
        v = stem + ("y" if suf == "ies" else "e" if suf == "es" and not re.search(r"(sh|ch|x|ss|zz|o)$", stem) else "")
    v = {"ha": "have", "doe": "do", "give": "give"}.get(v, v)
    body = " ".join(words[1:])
    body = re.sub(r"^(you|u)\b", "me", body, flags=re.I)
    body = re.sub(r"\byour\b", "my", body, flags=re.I)
    out = (v[:1].upper() + v[1:] + " " + body).strip().rstrip(",")
    return out[:220] if len(out) >= 8 else None


def hook_prompt_moments(sentences, hook=None):
    """[(sentence, prompt)] for the hook lines that say 'you just type one sentence … and it …'.
    sentences: [[word…]] (planfit.sentences); only sentences that START inside the hook count."""
    hook = hook_s() if hook is None else hook
    out = []
    for s in sentences:
        if not s or s[0]["start"] >= hook:
            continue
        txt = " ".join(w["word"] for w in s)
        if is_prompt_result_line(txt):
            out.append((s, derive_prompt(txt)))
    return out


def result_asset(facts, prompt=None, ready_only=False):
    """The REAL result for MO05: a produced app_generation asset (pre-production made it in the app, spaced, up
    to 10 tries) — the one made for the hook (for == 'MO05') first. None when there is none: never invented."""
    if facts is None:
        return None
    ok = ("ready",) if ready_only else ("ready", "pending_in_app")
    cands = [a for a in facts.assets if a.get("kind") == "app_generation" and a.get("status") in ok]
    if not cands:
        return None
    mine = [a for a in cands if a.get("for") == "MO05" or (a.get("source") or {}).get("for") == "MO05"]
    return (mine or cands)[0]


# ─────────────────────────────── the plan check for motion overlays (code-enforced) ───────────────────────────────

def check(evs, video, segments=(), plates=(), kits=None, facts=None, log=None):
    """The hard limits on motion overlays ({template, t0, t1, fields, …} already timed):
      - hook only: the whole clip inside the first rules.motion_templates.hook_s (40 s)
      - never over a screencast; not within min_apart_s of another motion template; at most max_per_video
      - plates + motion templates <= structure.plates_max_frac of the runtime (they are full-frame hook graphics)
      - parameters within their limits (validate_params); duration within duration_s
      - prompt_result: an app with a UI KIT and a REAL result asset (else refused, the honest route = a screencast)
      - prompt_menu / prompt_card_3d: kit when the app has one, else the neutral box (logged, never another app's UI)
    → (kept, dropped) — dropped rows carry "dropped": why."""
    R = rules()
    kept, dropped = [], []
    if not enabled():
        return [], [{**e, "dropped": "motion templates are switched off (rules.json motion_templates.enabled = false)"}
                    for e in evs]
    off = [e for e in evs if not is_on(e.get("template"))]
    dropped += [{**e, "dropped": f"motion template {e.get('template')} is not approved yet (rules.json motion_templates.approved)"}
                for e in off]
    evs = [e for e in evs if is_on(e.get("template"))]
    hook = hook_s()
    cap = float(skill.rules().get("structure", {}).get("plates_max_frac", 0.015)) * float(video.get("duration") or 0)
    used = sum(max(0.0, (p.get("t1") or 0) - (p.get("t0") or 0)) for p in plates)
    kits = kits if kits is not None else {}
    for ev in sorted(evs, key=lambda e: e.get("t0", 0)):
        tid = ev.get("template")
        why = None
        params, perrs = validate_params(tid, ev.get("fields") or {})
        lo, hi = spec(tid)["duration_s"]
        d = (ev.get("t1") or 0) - (ev.get("t0") or 0)
        if perrs:
            why = "; ".join(perrs)
        elif ev["t0"] >= hook or ev["t1"] > hook + 0.5:
            why = (f"{tid} at {ev['t0']:.1f}-{ev['t1']:.1f} s is outside the hook (first {hook:.0f} s): in the body a prompt "
                   "moment stays a screencast (Jake 2026-10-09: 'in the hook part')")
        elif d < lo - 1e-6 or d > hi + 1e-6:
            why = f"{tid} lasts {d:.2f} s (limits {lo}-{hi} s)"
        elif any(s["t0"] - 0.2 < ev["t1"] and ev["t0"] < s["t1"] + 0.2 for s in segments):
            why = "overlaps a screencast"
        elif len(kept) >= int(R.get("max_per_video", 2)):
            why = f"over the motion-template budget ({R.get('max_per_video', 2)} per video)"
        elif kept and ev["t0"] < kept[-1]["t1"] + float(R.get("min_apart_s", 4.0)):
            why = f"within {R.get('min_apart_s', 4.0)} s of the previous motion template"
        elif cap and used + d > cap + 0.25:
            why = (f"plates + motion templates would be {used + d:.1f} s > {cap:.1f} s (structure.plates_max_frac of the "
                   "runtime; REFERENCE-BASELINE §1a)")
        if why is None and tid in ("prompt_menu", "prompt_card_3d", "prompt_highlight", "long_prompt_scroll", "prompt_result"):
            app = params.get("app")
            kit = kits.get(app) if app in kits else uikits.for_app(app)[0] if app else None
            if tid == "prompt_result":
                if not kit:
                    why = (f"prompt_result needs the app's UI kit ({app or 'no app named'} has none) — the honest route is "
                           "a screencast; never another app's UI")
                elif not result_asset(facts, params.get("prompt")):
                    why = ("prompt_result needs a REAL result made off camera in the app (a produced app_generation asset) — "
                           "none exists; the honest route is a screencast, never an invented result")
                else:
                    params["result_asset"] = params.get("result_asset") or result_asset(facts)["id"]
            ev = {**ev, "kit": app if kit else None}
            if not kit and tid != "prompt_result" and log:
                log(f"{tid} at {ev['t0']:.1f} s: no ui kit for {app or 'the app'} — neutral box")
        if why:
            dropped.append({**ev, "dropped": why})
            continue
        ev = {**ev, "params": params, "technique": TECHNIQUE[tid]}
        kept.append(ev)
        used += d
    return kept, dropped


# ─────────────────────────────── scenes + rendering ───────────────────────────────

def _json(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def keyframes(tid):
    """The measured keyframes of a template: templates/<id>.kf.json (the source), else keyframes.json "templates"
    (build_keyframes.py merges the sources into the one library)."""
    base = "prompt_card_3d" if tid == "prompt_result" else tid
    kf = _json(TDIR / f"{base}.kf.json")
    return kf if kf is not None else (_json(MOTION / "keyframes.json", {}) or {}).get("templates", {}).get(base, {})


def style(tid):
    base = "prompt_card_3d" if tid == "prompt_result" else tid
    return _json(TDIR / f"{base}.style.json", {})


def _data_uri(path):
    p = Path(path)
    mt = mimetypes.guess_type(p.name)[0] or "image/png"
    return f"data:{mt};base64," + base64.b64encode(p.read_bytes()).decode()


def scene(ev, video, fps, size=(1920, 1080), kit=None, result=None):
    """The render.mjs scene of one motion overlay (frames numbered by OUTPUT frame from ev's t0)."""
    tid = ev["template"]
    base = "prompt_card_3d" if tid == "prompt_result" else tid
    t0, t1 = ev["t0"], ev["t1"]
    first_out = int(round(t0 * fps))
    n = max(1, int(round((t1 - t0) * fps)))
    params = dict(ev.get("params") or validate_params(tid, ev.get("fields") or {})[0])
    if tid == "prompt_result" and result:
        params["result"] = result
    fonts = {"Inter": "Inter.ttf"}
    st = style(tid)
    fonts.update({k: v for k, v in (st.get("fonts") or {}).items() if isinstance(v, str)})
    sk = uikits.scene_kit(kit)
    if sk:
        fonts.update(sk.get("fonts") or {})
    return {"template": base, "variant": tid, "width": 1920, "height": 1080, "scale": size[0] / 1920, "fps": fps,
            "first": 0, "last": n - 1, "outFirst": first_out, "fonts": fonts, "params": params,
            "beats": beats(ev, video, t0, t1), "duration": round(t1 - t0, 3), "kf": keyframes(tid), "style": st,
            "kit": sk}


def result_view(asset):
    """A produced asset → the params.result the template shows (REAL file / text only)."""
    if not asset:
        return None
    f = asset.get("file")
    src = asset.get("source") or {}
    if f and Path(f).exists():
        return {"kind": "image", "src": _data_uri(f), "alt": asset.get("desc", "")[:120]}
    if src.get("result_html"):           # a REAL artifact (e.g. Claude's single-file app) + the reply around it
        return {"kind": "artifact", "html": str(src["result_html"]), "text": str(src.get("result_text") or "")[:6000]}
    if src.get("result_text"):
        return {"kind": "text", "text": str(src["result_text"])[:6000]}
    return None
