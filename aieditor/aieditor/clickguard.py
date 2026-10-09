"""The click guard in Python — the SAME rules file and the same logic as screencast/clickguard.mjs
(architecture recommendation §3.7). The recorders enforce it in the browser; this side replays recorded
steps (an audit of a stored job), checks plans before recording, and backs the tests.

    check(action, target=None, session="logged_in") -> {"ok": True} | {"ok": False, "refused": "deny:<rule>", "why"}
    replay(steps, session="logged_in") -> [{"i", "t", "action", "refused", "why"}]   (agent-steps.json)
"""
import json
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote, urlsplit

from . import config

RULES_PATH = config.CODE / "screencast" / "clickguard.rules.json"
ENTER = {"enter", "numpadenter", " ", "space"}


@lru_cache(maxsize=1)
def rules():
    return json.loads(Path(RULES_PATH).read_text())


@lru_cache(maxsize=512)
def phrase_re(p):
    words = [re.escape(w) for w in re.split(r"[\s_-]+", str(p).lower().strip()) if w]
    return re.compile(r"(?<![a-z0-9])" + r"[\s_-]*".join(words) + r"(?![a-z0-9])", re.I)


def norm_session(s):
    return "outside" if str(s or "").lower() in ("outside", "public", "visitor") else "logged_in"


def labels_of(target, action=None):
    r, t, a = rules(), target or {}, action or {}
    out = []
    for f in r["label_fields"]:
        v = t.get(f)
        if v in (None, ""):
            continue
        v = re.sub(r"\s+", " ", str(v)).strip()
        if f == "text" and len(v) > r["max_text_len"]:
            v = str(t[f]).split("\n")[0].strip()
            if len(v) > r["max_text_len"]:
                continue
        out.append(v)
    if isinstance(a.get("target"), str) and a.get("target"):
        out.append(a["target"])
    if a.get("text") and a.get("type") != "type":
        out.append(str(a["text"]))
    if isinstance(a.get("click"), dict) and a["click"].get("text"):
        out.append(str(a["click"]["text"]))
    return out


def match_label(strings, deny, allow):
    for s in strings:
        s = str(s).lower()
        for p in allow:
            s = phrase_re(p).sub(" ", s)
        for d in deny:
            if phrase_re(d).search(s):
                return d
    return None


def _segs(s):
    return [x.strip() for x in str(s or "").lower().split("/") if x.strip()]


def _contains(hay, needle):
    n = len(needle)
    return bool(n) and any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def parse_url(u):
    """(host, path, fragment) — a relative URL resolves like JS new URL(u, base)."""
    u = str(u)
    try:
        x = urlsplit(u if "://" in u else "https://relative.invalid" + ("" if u.startswith(("/", "#")) else "/") + u)
        return (x.hostname or "").lower(), x.path, re.sub(r"^/", "", x.fragment)
    except ValueError:
        return "", u, ""


def match_url(url, url_rules):
    if not url:
        return None
    host, path, frag = parse_url(url)
    for h in rules()["deny_hosts"]:
        if host == h or host.endswith("." + h):
            return h
    p, f = _segs(unquote(path)), _segs(unquote(frag))
    for r in url_rules:
        if r.startswith("#"):
            if _contains(f, _segs(r[1:])):
                return r
        elif _contains(p, _segs(r)) or _contains(f, _segs(r)):
            return r
    return None


def _refuse(rule, why):
    return {"ok": False, "refused": f"deny:{rule}", "why": why}


def check(action, target=None, session="logged_in"):
    r = rules()
    a = action or {}
    t = a.get("type")
    typ = (t if isinstance(t, str) else "goto" if a.get("goto") else "click" if a.get("click")
           else "key" if a.get("key") else "type" if t else "").lower()
    sess = norm_session(session)
    for w in r["forbidden_action_words"]:
        if phrase_re(w).search(typ):
            return _refuse("action-type", f'no action may log out ("{t}")')
    url_rules = r["deny_urls_outside"] if sess == "outside" else r["deny_urls_logged_in"]
    label_rules = r["deny_labels"] + (r["outside_deny_labels"] if sess == "outside" else [])
    urls = []
    if typ in ("goto", "open", "reload"):
        urls.append(a.get("url") or a.get("goto"))
    if isinstance(a.get("goto"), str) and a["goto"] not in urls:
        urls.append(a["goto"])
    if typ in ("click", "dblclick", "key") and (target or {}).get("href"):
        urls.append(target["href"])
    for u in urls:
        hit = match_url(u, url_rules)
        if hit:
            return _refuse(hit, f"{'the outside view' if sess == 'outside' else 'a logged-in browser'} never opens {u}")
    if typ in ("click", "dblclick") or (typ == "key" and str(a.get("key") or "").lower() in ENTER):
        hit = match_label(labels_of(target, {} if typ == "key" else a), label_rules, r["allow_labels"])
        if hit:
            return _refuse(hit, f'"{hit}" is never pressed ({sess})')
    if typ == "type" and target:
        f = [str(target[k]) for k in ("autocomplete", "name", "id", "placeholder", "aria", "label", "type") if target.get(k)]
        if match_label(f, r["payment_input"], []):
            return _refuse("payment-input", "nothing is typed into a payment field")
    return {"ok": True}


def replay(steps, session="logged_in"):
    """Every step of a recorded agent-steps.json the guard would have refused."""
    out = []
    for i, s in enumerate(steps or []):
        a = s.get("action") if isinstance(s, dict) and "action" in s else s
        if not isinstance(a, dict):
            continue
        res = check(a, s.get("target") if isinstance(s, dict) else None, session)
        if not res["ok"]:
            out.append({"i": i, "t": s.get("t") if isinstance(s, dict) else None, "action": a,
                        "refused": res["refused"], "why": res["why"]})
    return out
