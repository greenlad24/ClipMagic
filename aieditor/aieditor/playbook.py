"""APP PLAYBOOKS — the closed list of what the recorder may do in an app (recommendation §3.1, step 4).

A playbook (skill folder playbooks/<app>.json, format schemas/playbook.schema.json) lists the app's
actions with selectors (+ fallbacks), params, pre/post asserts and the replay record. The plan may only
name actions of the segment's playbook; an action is usable on camera only when `proven`: it replayed
n/n (rules.json playbooks.replays_required, 3) from a fresh session — start_state -> pre -> action -> post.
A sentence that needs something the playbook lacks is a `needs_primitive` candidate (unknown()), never an
improvised step: that is how '@Sketch', '/background', 'Updated', a Free card inside a Plus account and an
invented 'Bakery Image Prompt' chat reached the screen in the failed end-to-end run (gap 8/10/11/14/19).

Hard rules: load() rejects any action whose label or url hits the click guard deny rules (shared
screencast/clickguard.rules.json when present, plus the inline copy below — Delete, Buy, Upgrade,
Subscribe, Checkout, Publish, Share, Invite, Billing, Log out …). URLs matching `outside_only` are shown
only from the separate never-logged-in US Chrome (RULEBOOK L4/R9/R10).

  load(app_or_path)                 validated playbook (PlaybookError on a bad one)
  actions(app, proven_only=True)    {id: action}
  resolve(app, action_id, params)   -> agent_rec.mjs steps ({"type": …} actions)
  match_beat(app, text, session)    what a beat's text maps to (action | missing | outside | camera | unknown)
  unknown(beat_texts, app, session) -> needs_primitive candidates
  replay(session_factory, app, action_id, n=3)   the proving harness (no live site in tests)
"""
import copy
import datetime
import json
import re
from pathlib import Path

from . import config, skill

KINDS = {"click", "type", "paste", "key", "upload", "drag", "draw", "goto", "wait_for", "reveal", "scroll"}
ASSERT_KINDS = {"text", "selector", "absent", "theme", "account"}
CLICKGUARD_JSON = config.CODE / "screencast" / "clickguard.rules.json"
# inline copy of the click guard deny words (recommendation §3.7; RULEBOOK S5, L4, R10) — used together
# with the shared json so a missing or partial file never weakens the guard
DENY_LABELS = ["delete", "remove account", "delete account", "buy", "purchase", "upgrade", "subscribe", "checkout",
               "check out", "publish", "share", "invite", "billing", "payment", "log out", "logout", "log-out",
               "sign out", "signout", "sign-out", "cancel subscription", "cancel plan", "manage subscription"]
DENY_URLS = [r"/log-?out\b", r"/sign-?out\b", r"/billing\b", r"/checkout\b", r"/payments?\b", r"/upgrade\b",
             r"/subscribe\b", r"/account/delete\b"]
# (pricing pages are not click-guarded here: a logged-in session never shows them because the playbook's
# outside_only list routes them to the separate never-logged-in US Chrome, RULEBOOK L4)
DARK_LUM = 60          # mean screen luminance below this = dark theme (preprod.DARK_LUM)
ACTION_VERBS = re.compile(r"\b(click|clicks|press|type|typed|typing|paste|pasted|open|opens|select|pick|picked|drag|"
                          r"upload|attach|send|cut to|go to|goto|scroll|draw|close|closes|hit)\b|'/'", re.I)


class PlaybookError(ValueError):
    pass


# ────────────────────────────── click guard (shared rules + inline copy) ──────────────────────────────

def _collect(obj, want, acc, avoid=()):
    """Strings under keys that mention `want` (and none of `avoid`), any depth."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower()
            if any(w in kl for w in want) and not any(w in kl for w in avoid) and isinstance(v, list):
                acc += [x for x in v if isinstance(x, str)]
            elif isinstance(v, (dict, list)):
                _collect(v, want, acc, avoid)
    elif isinstance(obj, list):
        for v in obj:
            _collect(v, want, acc, avoid)
    return acc


def _rx(entry):
    """A plain word/phrase is matched as a whole word; anything else is a regex."""
    if re.fullmatch(r"[\w &'-]+", entry):
        return re.compile(r"(?<![a-z])" + re.escape(entry.strip()).replace(r"\ ", r"\s*") + r"(?![a-z])", re.I)
    try:
        return re.compile(entry, re.I)
    except re.error:
        return re.compile(re.escape(entry), re.I)


def _phrase(entry):
    """p1's phrase match (clickguard.phrase_re): word boundaries, a space also matches '-', '_' or nothing."""
    words = [re.escape(w) for w in re.split(r"[\s_-]+", str(entry).lower().strip()) if w]
    return re.compile(r"(?<![a-z0-9])" + r"[\s_-]*".join(words) + r"(?![a-z0-9])", re.I)


def guard_rules(path=None):
    """(label regexes, url regexes, allow regexes): the shared clickguard.rules.json (p1) when present +
    the inline copy. p1's schema is read by its keys — playbook actions run in the logged-in session, so
    deny_labels / deny_urls_logged_in / deny_hosts apply and allow_labels ('Remove background') are taken
    out before the deny check; any other shape falls back to collecting deny words by key name."""
    labels, urls, allow = list(DENY_LABELS), list(DENY_URLS), []
    p = Path(path) if path else CLICKGUARD_JSON
    if p.exists():
        try:
            shared = json.loads(p.read_text())
            if isinstance(shared, dict) and "deny_labels" in shared:
                lab_p1 = [x for x in shared.get("deny_labels") or [] if isinstance(x, str)]
                allow = [x for x in shared.get("allow_labels") or [] if isinstance(x, str)]
                url_p1 = [x for x in shared.get("deny_urls_logged_in") or [] if isinstance(x, str)]
                hosts = [x for x in shared.get("deny_hosts") or [] if isinstance(x, str)]
                return ([_rx(x) for x in dict.fromkeys(labels)] + [_phrase(x) for x in dict.fromkeys(lab_p1)],
                        [_rx(x) for x in dict.fromkeys(urls)]
                        + [re.compile(r"(?<![\w.-])" + re.escape(x.lstrip("#")) + r"(?![\w-])", re.I)
                           for x in dict.fromkeys(url_p1)]
                        + [re.compile(r"//([\w-]+\.)*" + re.escape(h) + r"(?![\w.-])", re.I) for h in dict.fromkeys(hosts)],
                        [_phrase(x) for x in dict.fromkeys(allow)])
            labels += _collect(shared, ("label", "word", "text", "deny"), [], avoid=("url", "path", "href", "host", "allow"))
            urls += _collect(shared, ("url", "path", "href"), [])
        except (ValueError, OSError):
            pass
    return [_rx(x) for x in dict.fromkeys(labels)], [_rx(x) for x in dict.fromkeys(urls)], []


def guard_hit(label=None, url=None, rules=None):
    """The deny rule an action's label/url hits, or None."""
    rules = rules or guard_rules()
    lab_rx, url_rx = rules[0], rules[1]
    allow_rx = rules[2] if len(rules) > 2 else []
    if label:
        label = str(label)
        for a in allow_rx:
            label = a.sub(" ", label)
    for r in lab_rx:
        if label and r.search(label):
            return f"label {label!r} hits deny rule {r.pattern!r}"
    for r in url_rx:
        if url and r.search(url):
            return f"url {url!r} hits deny rule {r.pattern!r}"
    return None


# ────────────────────────────── load + validate ──────────────────────────────

def validate(pb):
    """Hand validator for schemas/playbook.schema.json (no dependency). → list of error strings."""
    errs = []

    def need(obj, keys, where):
        for k in keys:
            if k not in obj:
                errs.append(f"{where}: missing '{k}'")

    def asserts(lst, where):
        if not isinstance(lst, list):
            errs.append(f"{where}: must be a list")
            return
        for i, a in enumerate(lst):
            if not isinstance(a, dict) or a.get("kind") not in ASSERT_KINDS:
                errs.append(f"{where}[{i}]: kind must be one of {sorted(ASSERT_KINDS)}")
            elif a["kind"] in ("text", "account", "theme") and "value" not in a:
                errs.append(f"{where}[{i}]: '{a['kind']}' needs 'value'")
            elif a["kind"] == "selector" and not a.get("selector"):
                errs.append(f"{where}[{i}]: 'selector' needs 'selector'")
            elif a["kind"] == "absent" and not (a.get("value") or a.get("selector")):
                errs.append(f"{where}[{i}]: 'absent' needs 'value' or 'selector'")

    if not isinstance(pb, dict):
        return ["playbook must be an object"]
    need(pb, ["app", "hosts", "version", "start_state", "actions", "features"], "playbook")
    if errs:
        return errs
    if not re.fullmatch(r"[a-z0-9_-]+", str(pb["app"])):
        errs.append("app: lower-case id")
    if not isinstance(pb["hosts"], list) or not pb["hosts"]:
        errs.append("hosts: non-empty list")
    ss = pb["start_state"]
    if not isinstance(ss, dict):
        errs.append("start_state: object")
    else:
        need(ss, ["url", "asserts"], "start_state")
        asserts(ss.get("asserts", []), "start_state.asserts")
    acts = pb["actions"]
    if not isinstance(acts, dict):
        return errs + ["actions: object"]
    for aid in pb.get("set_dressing", []):
        if aid not in acts:
            errs.append(f"set_dressing: unknown action '{aid}'")
    for aid, a in acts.items():
        w = f"actions.{aid}"
        if not isinstance(a, dict):
            errs.append(f"{w}: object")
            continue
        need(a, ["kind", "label", "proven", "source"], w)
        if a.get("kind") not in KINDS:
            errs.append(f"{w}: kind {a.get('kind')!r} not in {sorted(KINDS)}")
        if not isinstance(a.get("proven"), bool):
            errs.append(f"{w}: proven must be a boolean")
        if not str(a.get("source", "")).strip():
            errs.append(f"{w}: source must say where the action comes from")
        if a.get("kind") in ("click", "paste", "type", "upload", "wait_for") and not a.get("selectors"):
            errs.append(f"{w}: a {a.get('kind')} needs selectors")
        if a.get("kind") == "goto" and not a.get("url"):
            errs.append(f"{w}: a goto needs url")
        if not isinstance(a.get("selectors", []), list):
            errs.append(f"{w}: selectors must be a list")
        for k in ("pre", "post"):
            asserts(a.get(k, []), f"{w}.{k}")
        for r in a.get("requires", []):
            if r not in acts:
                errs.append(f"{w}: requires unknown action '{r}'")
        for rp in a.get("replays", []):
            if not isinstance(rp, dict) or "ts" not in rp or not isinstance(rp.get("ok"), bool):
                errs.append(f"{w}: replays entries need ts + ok")
        for p in a.get("intents", []):
            try:
                re.compile(p)
            except re.error as e:
                errs.append(f"{w}: bad intent regex {p!r}: {e}")
    for fid, f in (pb.get("features") or {}).items():
        if not isinstance(f, dict) or not isinstance(f.get("exists"), bool):
            errs.append(f"features.{fid}: needs exists (bool)")
            continue
        hr = f.get("honest_route")
        if hr and not hr.startswith("outside:") and hr not in acts:
            errs.append(f"features.{fid}: honest_route '{hr}' is not an action")
        for p in f.get("patterns", []):
            try:
                re.compile(p)
            except re.error as e:
                errs.append(f"features.{fid}: bad pattern {p!r}: {e}")
    for k in ("walls", "outside_only", "private_selectors"):
        if not isinstance(pb.get(k, []), list):
            errs.append(f"{k}: list")
    for p in pb.get("walls", []) + pb.get("outside_only", []):
        try:
            re.compile(p)
        except re.error as e:
            errs.append(f"bad regex {p!r}: {e}")
    return errs


def check_guard(pb, rules=None):
    """Every action label/url against the click guard → list of rejections."""
    rules = rules or guard_rules()
    out = []
    for aid, a in pb.get("actions", {}).items():
        texts = [a.get("label")] + [x[5:] for x in a.get("selectors", []) if isinstance(x, str) and x.startswith("text=")]
        hit = next((h for h in (guard_hit(t, None, rules) for t in texts if t) if h), None) or guard_hit(None, a.get("url"), rules)
        if hit:
            out.append(f"actions.{aid}: {hit}")
    return out


def load(app_or_path, guard_path=None):
    """A validated playbook: by app id (skill folder) or by file path. Raises PlaybookError."""
    p = Path(app_or_path)
    if p.suffix != ".json":
        p = skill.playbook_path(str(app_or_path))
    pb = json.loads(p.read_text())
    errs = validate(pb) + check_guard(pb, guard_rules(guard_path))
    if errs:
        raise PlaybookError(f"{p.name}: " + "; ".join(errs))
    pb["_path"] = str(p)
    return pb


def _pb(app):
    return app if isinstance(app, dict) else load(app)


def save(pb, path=None):
    out = {k: v for k, v in pb.items() if not k.startswith("_")}
    Path(path or pb["_path"]).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")


def actions(app, proven_only=True):
    """{id: action}; proven_only drops every action not replayed n/n (rules.json playbooks)."""
    pb = _pb(app)
    allow = skill.rules().get("playbooks", {}).get("allow_unproven", False)
    return {k: a for k, a in pb["actions"].items() if a.get("proven") or not proven_only or allow}


def outside_only(app, url):
    """True when the URL may only be shown from the separate never-logged-in US Chrome (L4)."""
    return any(re.search(p, url or "", re.I) for p in _pb(app).get("outside_only", []))


# ────────────────────────────── resolve: action -> recorder steps ──────────────────────────────

def _fill(s, params):
    return re.sub(r"\{(\w+)\}", lambda m: str(params.get(m.group(1), m.group(0))), s) if isinstance(s, str) else s


def _params(a, params):
    out = {}
    for name, spec in (a.get("params") or {}).items():
        if name in params:
            v = params[name]
        elif "default" in spec:
            v = spec["default"]
        elif spec.get("required"):
            raise PlaybookError(f"{a.get('label')}: param '{name}' is required")
        else:
            continue
        if spec.get("enum") and v not in spec["enum"]:
            raise PlaybookError(f"{a.get('label')}: param {name}={v!r} not in {spec['enum']}")
        out[name] = v
    for k, v in params.items():            # extra params pass through (e.g. "at")
        out.setdefault(k, v)
    return out


def _target(sel, params):
    sel = _fill(sel, params)
    if sel.startswith("text="):
        return {"target": sel[5:]}
    return {"selector": sel}


def resolve(app, action_id, params=None):
    """A playbook action → agent_rec.mjs 'act' actions (list). The first selector is the target; the
    others ride along as "alt" (the session tries them in order when the first finds nothing)."""
    pb = _pb(app)
    if action_id not in pb["actions"]:
        raise PlaybookError(f"{pb['app']}: no action '{action_id}' (needs_primitive)")
    a = pb["actions"][action_id]
    p = _params(a, dict(params or {}))
    sels = [_fill(s, p) for s in a.get("selectors", [])]
    tgt = _target(sels[0], p) if sels else {}
    alt = [_target(s, p) for s in sels[1:]]
    extra = {k: p[k] for k in ("at",) if k in p}
    k = a["kind"]
    if k == "click":
        st = [{"type": "click", **tgt, **({"nth": p["nth"]} if "nth" in p else {})}]
    elif k in ("paste", "type"):
        st = [{"type": "type", **tgt, "text": p.get("text", ""), "paste": k == "paste", "clear": True, "enter": False}]
    elif k == "key":
        keys = p.get("keys") or [p.get("key", "Escape")]
        st = [{"type": "key", "key": key} for key in keys]
        if tgt:                                   # a key typed INTO a field: focus it first (no text)
            st = [{"type": "click", **tgt}] + st
    elif k == "goto":
        st = [{"type": "goto", "url": _fill(a["url"], p)}]
    elif k == "upload":
        st = [{"type": "upload", "files": list(p.get("files", []))}]
    elif k == "wait_for":
        st = [{"type": "wait_for", **({"text": tgt["target"]} if "target" in tgt else {"selector": tgt.get("selector")}),
               "timeout": p.get("timeout", 60)}]
    elif k == "scroll":
        st = [{"type": "scroll", "by": p.get("by", 0)}]
    elif k == "drag":
        st = [{"type": "drag", "from": p.get("from"), "to": p.get("to")}]
    elif k == "draw":
        st = [{"type": "draw", "strokes": p.get("strokes", []), **({"box": p["box"]} if "box" in p else {})}]
    elif k == "reveal":
        st = [{"type": "reveal", "asset": p.get("asset"), **({"url": p["url"]} if "url" in p else {})}]
    else:  # pragma: no cover - validate() refuses other kinds
        raise PlaybookError(f"unknown kind {k}")
    for s in st:
        s.update(extra)
        if alt and s["type"] in ("click", "type"):
            s["alt"] = alt
        s["playbook"] = f"{pb['app']}:{action_id}"
    return st


# ────────────────────────────── beats -> actions / needs_primitive ──────────────────────────────

def _urls(text):
    return re.findall(r"https?://[^\s'\",;)]+", text or "")


def match_beat(app, text, session="logged_in"):
    """What a beat's text ("<cue> :: <body>" or free text) honestly maps to in this app:
       {"status": "action", "action": id}                 a playbook action shows it
       {"status": "outside", "why", "proposed"}           only the never-logged-in US Chrome may show it (L4)
       {"status": "missing", "feature", "why", "proposed"} the app/account does not have it (honest route in proposed)
       {"status": "camera"}                               no UI action: framing/hold on what is already there
       {"status": "unknown", "why"}                       no action covers it: needs_primitive"""
    pb = _pb(app)
    t = text or ""
    if session == "logged_in":
        out = [u for u in _urls(t) if outside_only(pb, u)]
        if out:
            return {"status": "outside", "action": None, "why": f"{out[0]} is outside_only (RULEBOOK L4): the separate "
                    "never-logged-in en-US Chrome through the US route", "proposed": {"session": "outside", "url": out[0]}}
    for fid, f in pb.get("features", {}).items():
        if f.get("exists"):
            continue
        if fid == "pricing_in_app" and session == "outside":
            continue
        for p in f.get("patterns", []):
            if re.search(p, t, re.I):
                hr = f.get("honest_route")
                prop = ({"session": "outside", "url": hr.split(":", 1)[1]} if hr and hr.startswith("outside:")
                        else {"action": hr} if hr else None)
                return {"status": "missing", "action": None, "feature": fid, "why": f.get("fact", fid), "proposed": prop}
    best = None                      # the most specific (longest) intent match wins; ties keep playbook order
    for aid, a in pb["actions"].items():
        for p in a.get("intents", []):
            m = re.search(p, t, re.I)
            if m and (best is None or len(m.group(0)) > best[0]):
                best = (len(m.group(0)), aid)
    if best:
        return {"status": "action", "action": best[1], "proven": bool(pb["actions"][best[1]].get("proven"))}
    if not ACTION_VERBS.search(t):
        return {"status": "camera", "action": None}
    return {"status": "unknown", "action": None, "why": "no playbook action shows this"}


def unknown(beat_texts, app="chatgpt", session="logged_in"):
    """Beat texts that map to NO playbook action → needs_primitive candidates
    ({sentence, why, proposed, feature?}) in the plan schema's needs_primitive shape."""
    out = []
    for t in beat_texts:
        m = match_beat(app, t, session)
        if m["status"] in ("missing", "outside", "unknown"):
            out.append({"sentence": t, "why": m.get("why"), "proposed": m.get("proposed"),
                        **({"feature": m["feature"]} if m.get("feature") else {}), "status": m["status"]})
    return out


# ────────────────────────────── replay: the proving harness ──────────────────────────────

class RecorderSession:
    """A replay session on any agent_rec.mjs-compatible transport (`send(msg) -> dict`, e.g.
    agentrec.Session). The harness needs: open(url), act(step) -> (ok, why), check(assert) -> (ok, why),
    close()."""

    def __init__(self, transport):
        self.t = transport

    def open(self, url):
        r = self.t.send({"cmd": "open", "url": url, "settle": 1.0})
        if r.get("wall"):
            return False, f"wall: {r['wall']}"
        return bool(r.get("ok")), r.get("error")

    def act(self, step):
        tries = [step] + [{**{k: v for k, v in step.items() if k not in ("selector", "target", "alt")}, **a}
                          for a in step.get("alt", [])]
        why = None
        for s in tries:
            s = {k: v for k, v in s.items() if k not in ("alt", "playbook")}
            r = self.t.send({"cmd": "act", "action": s})
            if r.get("ok", True) and not r.get("error"):
                return True, None
            why = r.get("error") or "act failed"
        return False, why

    def _text(self):
        return self.t.send({"cmd": "text"})

    def check(self, a):
        k = a["kind"]
        if k == "selector":
            n = self.t.send({"cmd": "count", "selector": a["selector"]}).get("n", 0)
            return n > 0, None if n > 0 else f"no element {a['selector']}"
        if k == "absent" and a.get("selector"):
            n = self.t.send({"cmd": "count", "selector": a["selector"]}).get("n", 0)
            return n == 0, None if n == 0 else f"{a['selector']} still present"
        if k == "theme":
            lum = self.t.send({"cmd": "observe"}).get("lum")
            dark = lum is not None and lum < DARK_LUM
            ok = dark if a["value"] == "dark" else (lum is not None and not dark)
            return ok, None if ok else f"theme {a['value']} not met (lum {lum})"
        tx = self._text()
        body = tx.get("text", "")
        if k == "text" and a.get("selector"):
            have = tx.get("draft", "") if "contenteditable" in a["selector"] else body
            ok = have.strip() == a["value"].strip() if "contenteditable" in a["selector"] else a["value"] in have
            return ok, None if ok else f"field text {have[:80]!r} != {a['value'][:80]!r}"
        if k in ("text", "account"):
            ok = a["value"] in body
            return ok, None if ok else f"{a['value']!r} not on the page"
        if k == "absent":
            ok = a["value"] not in body
            return ok, None if ok else f"{a['value']!r} is on the page"
        return False, f"unknown assert {k}"

    def close(self):
        try:
            self.t.close()
        except Exception:  # noqa: BLE001
            pass


def _fill_assert(a, params):
    return {k: _fill(v, params) for k, v in a.items()}


def _run_once(session, pb, action_id, params):
    a = pb["actions"][action_id]
    ok, why = session.open(pb["start_state"]["url"])
    if not ok:
        return False, f"start: {why}"
    for c in pb["start_state"].get("asserts", []):
        ok, why = session.check(c)
        if not ok:
            return False, f"start_state: {why}"
    for r in a.get("requires", []):
        for st in resolve(pb, r, params if r == action_id else {}):
            ok, why = session.act(st)
            if not ok:
                return False, f"requires {r}: {why}"
    p = _params(a, dict(params or {}))
    for c in a.get("pre", []):
        ok, why = session.check(_fill_assert(c, p))
        if not ok:
            return False, f"pre: {why}"
    for st in resolve(pb, action_id, params):
        ok, why = session.act(st)
        if not ok:
            return False, f"action: {why}"
    for c in a.get("post", []):
        ok, why = session.check(_fill_assert(c, p))
        if not ok:
            return False, f"post: {why}"
    return True, None


def replay(session_factory, app, action_id, n=None, params=None, save_to=None, allow_generate=False, now=None):
    """Prove one action: n FRESH sessions (session_factory() each), every one start_state -> requires ->
    pre -> action -> post. proven = n/n. The replays are appended to the action (and written back to
    the playbook file when save_to is given — a path, or True for the playbook's own file).
    A generating action costs the account a generation per replay: refused unless allow_generate."""
    pb = _pb(app)
    n = n or skill.rules().get("playbooks", {}).get("replays_required", 3)
    a = pb["actions"].get(action_id)
    if a is None:
        raise PlaybookError(f"{pb['app']}: no action '{action_id}'")
    if a.get("generates") and not allow_generate:
        raise PlaybookError(f"{action_id} starts a generation: replay it only with allow_generate (off camera, spaced)")
    rows = []
    for _ in range(n):
        s = None
        try:
            s = session_factory()
            ok, why = _run_once(s, pb, action_id, params)
        except Exception as e:  # noqa: BLE001 - a crashed session is a failed replay, not a crashed harness
            ok, why = False, f"session error: {e}"
        finally:
            close = getattr(s, "close", None)
            if close:
                close()
        rows.append({"ts": (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds"),
                     "ok": ok, "why": why})
    a.setdefault("replays", []).extend(rows)
    a["proven"] = all(r["ok"] for r in rows) and len(rows) == n
    if save_to:
        save(pb, None if save_to is True else save_to)
    return {"action": action_id, "ok": sum(r["ok"] for r in rows), "n": n, "proven": a["proven"], "replays": rows}


def playbook_copy(app):
    """A deep copy to replay against (a fixture page, a scratch file) without touching the original."""
    return copy.deepcopy(_pb(app))
