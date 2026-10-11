"""PER-VIDEO PRE-PRODUCTION ROUTING — Jake's 5-point design (RULEBOOK R14, 2026-10-10, binding):

  "1. It needs to plan first what are the things exactly that it needs to show
   2. It needs to record each part that it doesn't have in the playbook and extand the playbook for this video only.
      Next video will have a different playbook. Even if it's a chatgpt (the UI might change almost every week)
   3. It needs to generate the assets it's showing before recording. Or if it's a demonstration it should be
      recording it and then cut to the results. Or it can decide to use the motion graphics and just add the actual
      results in the motion graphics
   4. If ChatGPT or the tool doesn't have (after verification) - showcase it still with Motion Graphics instead of
      screencast.
   5. Have screencasts a little bit longer (slower pace a little bit) automatically"
  + on P4 (Jake, same day): "it should look it's working but with our approved motion design workflows. That would be
    true to any other app (it would use the exact UI of that other app with the same motion design rules)".

The plan (P1, director: every beat with what it NEEDS — an action, an asset, a result) leaves NEEDS; this module
fills every one of them off camera, for THIS video, before anything is recorded:

  group A  an ACTION the playbook lacks (or one that no longer replays for this video)
           → P2 ONBOARDING: a capped Opus agent loop over the recorder's observe / find / act commands (click guard,
             Scout profile COPY, account lock, fresh chats only) records how to do it; the action is written into
             THIS video's playbook copy (job/preprod/playbook-<app>.json — never the shared skill playbook) and proven
             3/3 from fresh sessions with playbook.replay. The recorder only ever plays proven steps.
  group B  an ASSET never produced (his phone photo, a blurry photo, great-grandma's photo + the colorized result…)
           → P3: produced before recording IN THE APP (Jake 2026-10-10: no image API) by the producer agent
             (aieditor/producer.py): the learned / hint recipe first, then it diagnoses each failed try and picks the
             next route itself; every picture vision-checked; the route that works is learned into this video's
             playbook; <= 10 tries / 12 min per asset, >= 45 s apart, <= 35 generations per app per 24 h (genledger:
             the job WAITS at the cap); never silently dropped.
  group C  a FEATURE the app does not have (an 'Updated' badge, '/newbg', '/add_object', Sketch on the toolbar…)
           → P4: absence VERIFIED in the live app ("/" and "+" menus, the toolbar, page text); then shown WORKING with
             an approved motion template (prompt_highlight / long_prompt_scroll) in the app's own UI kit (this video's
             kit; captured first when the app has none) — and the RESULT is REAL: the same outcome made off camera in
             plain words, vision-checked against what he says. Never a fake screencast, never a hold.
  group D  a gate near-miss (share within 3 points, a beat too short to be on screen, an uncovered screen reference)
           → fixed by code in planfit (R14 D); whatever is left is a warning for the edit's structure gate, not a hold.

needs_primitive never ends a job any more: a job holds only when a route genuinely fails (onboarding could not prove
the action, an asset failed all its tries on every producer, a P4 result could not be made) — with the reason.

Budget: every model call goes through llm.messages (the API ledger + the job cap); onboarding of one app in one video
stops at rules.json caps.onboarding_app_usd ($9.50). Hard rules: no delete, buy, upgrade, billing, publish, share,
invite or log out; never Jake's existing chats; generations spaced >= 45 s, <= 10 tries per needed asset.

Everything live is behind Ctx (session_factory, llm, image_api, in_app, check, kit_capture), so the tests run with fakes.
"""
import base64
import copy
import json
import re
import shutil
import time
from pathlib import Path

from . import clickguard, config, director, llm, playbook, skill

GROUPS = ("A", "B", "C", "D")
GROUP_NAME = {"A": "action missing from the playbook (P2 onboarding)", "B": "asset never produced (P3)",
              "C": "feature the app does not have (P4 motion graphics)", "D": "gate near-miss (code fix)"}
CODE_GROUP = {"onboard": "A", "action": "A", "new_asset": "B", "asset": "B", "feature": "C", "missing": "C",
              "structure": "D", "lost": "D", "screen_ref": "D", "plate": "D", "instruction": "D", "mo05": "D",
              "invented": "D", "session": "D", "coverage": "D", "ledger": "D"}
KIND_GROUP = {"action": "A", "asset": "B", "feature": "C", "other": "D"}
FEATURE_RX = re.compile(r"\b(?:no ['\"‘’/@]?[\w /@'-]{1,40}['\"’]? (?:skill|badge|label|option|button|plugin|exists?)|"
                        r"toolbar \w+ missing|no @\w+|"
                        r"does not exist|doesn't exist|not on the (?:image )?toolbar|is not (?:in|on) the|no '?/|"
                        r"has no (?:background|add)|slash_\w+|\bupdated\b|does nothing)", re.I)
ASSET_RX = re.compile(r"\b(?:asset|photo|picture|image|logo)\b[^.]{0,60}\b(?:missing|not produced|no produced|does not "
                      r"exist|needs the file)|\bno produced\b|\bphone_photo is missing\b|\bno (?:\w+[ -]){0,3}(?:photo|picture|"
                      r"image|asset)\b|\bnot (?:a |any )?(?:listed )?produced asset|\bamong the produced assets\b", re.I)
ACTION_RX = re.compile(r"\b(?:no (?:\w+[ -]){0,3}action|no primitive|not in the closed list|closed list|cannot be placed|"
                       r"only targets|no action|not a proven action|unproven)\b", re.I)
STRUCT_RX = re.compile(r"\bstructure \w+ =|not on screen after the span structure|refers to the screen|too short", re.I)
GEN_LABELS = re.compile(r"^(?:send|remove bg|regenerate|square 1:1|portrait 3:4|story 9:16|landscape 4:3|widescreen 16:9|"
                        r"create|generate|submit)$", re.I)
CHAT_RX = re.compile(r"/c/[\w-]+")


def _jdump(obj, path):
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def onboarding_rules():
    return skill.rules().get("onboarding") or {}


def app_cap():
    return float((skill.rules().get("caps") or {}).get("onboarding_app_usd", 9.5))


# ────────────────────────────── P1: the needs, grouped ──────────────────────────────

# WHAT a need is decides its route, not the group a check gave it (TEST v3 21:58: a 'structure' error on a camera.zoom
# beat, "Close on the bottle's label", was routed to the app and ChatGPT was asked to GENERATE "Zoom in close on the
# label"). A camera move / framing / structure / timing need is D (code or a warning): never a generation, never an
# onboarding. Matched on the need's own fields (what to do), never on the narration sentence.
CAMERA_RX = re.compile(r"\bcamera\.\w+|\bzoom(?:s|ed|ing)?\b|\bclose[- ]?up\b|^\W*close (?:in )?on\b|\bpush(?:es)?[- ]in\b|"
                       r"\bpull(?:s)?[- ]back\b|\bpan(?:s|ned)? (?:to|across|over|down|up)\b|\bframing\b|\breframe\b|"
                       r"\bstructure \w+ =|\bspan\b.{0,30}\b(?:too short|share)\b|\btiming\b|\bhold (?:on|the shot)\b|"
                       r"\bcut (?:to|away)\b", re.I)


def is_camera_need(row):
    """True when a needs row asks for a camera move / framing / structure / timing (route D, never the app)."""
    pr = row.get("proposed") if isinstance(row.get("proposed"), dict) else {}
    act = str(pr.get("action") or row.get("action") or "")
    if act.startswith("camera.") or str(pr.get("needs_primitive") or "").startswith("camera."):
        return True
    fields = [pr.get("need"), pr.get("desc"), row.get("need"), pr.get("body")]
    if row.get("code") in ("structure", "lost", "plate", "coverage", "session"):
        fields.append(row.get("why"))
    return any(CAMERA_RX.search(str(f)) for f in fields if f)


def not_a_picture(desc):
    """The guard before ANY generation: the need must be a picture the video shows. → None (it is) or why not."""
    d = re.sub(r"^\W*(?:the|a|an)\s+", "", str(desc or "").strip(), flags=re.I)
    if not d:
        return "no description of a picture"
    if CAMERA_RX.match(d) or re.match(r"(?:zoom|close|push|pull|pan|cut|hold|frame|reframe)\b", d, re.I):
        return f"'{d[:60]}' is a camera move / framing in the edit, not a picture the app makes"
    return None


def classify(row):
    """A needs row (director needs_primitive shape: {sentence, word_ids, why, proposed, code?, kind?, need?}) → its
    group A/B/C/D. A camera / framing / structure / timing need is always D (is_camera_need). Otherwise a structured
    row (the R14 plan schema: kind / code) wins; a free-text one (older plans, e.g. the test-v2 job's 43 rows) is
    read by its words."""
    if is_camera_need(row):
        return "D"
    if row.get("kind") in KIND_GROUP and row.get("kind") != "other":
        return KIND_GROUP[row["kind"]]
    code = row.get("code")
    why = str(row.get("why") or "") + " " + str(row.get("sentence") or "")
    if code == "coverage" and re.search(r"\bhe names \w+", why):
        return "C"
    if code == "ledger":
        return "B" if re.search(r"no produced asset contains|invents", why) else "D"
    if code in CODE_GROUP:
        return CODE_GROUP[code]
    if STRUCT_RX.search(why):
        return "D"
    if ASSET_RX.search(why):
        return "B"
    if FEATURE_RX.search(why):
        return "C"
    if ACTION_RX.search(why):
        return "A"
    return "D" if row.get("kind") == "other" else "A"


def needs_report(rows):
    """{group: [rows]} with each row's group set."""
    out = {g: [] for g in GROUPS}
    for r in rows:
        g = classify(r)
        out[g].append({**r, "group": g})
    return out


# ────────────────────────────── P2: the per-video playbook ──────────────────────────────

def playbook_path(out, app):
    return Path(out) / f"playbook-{app}.json"


def job_playbook(out, app, base=None):
    """THIS video's playbook: job/preprod/playbook-<app>.json. Made from the shared skill playbook (the starting hint
    only — the UI changes weekly) the first time; afterwards this copy is the truth for this job. Nothing is ever
    written back to the shared playbook."""
    p = playbook_path(out, app)
    if p.exists():
        return playbook.load(p)
    src = base if base is not None else playbook.load(app)
    pb = copy.deepcopy(src)
    pb.pop("_path", None)
    pb["per_video"] = {"job": Path(out).parent.name, "from": f"skill playbooks/{app}.json (hint only)",
                       "made": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "rule": "Jake R14 P2: extended for this video only; next video gets a fresh one"}
    for a in pb["actions"].values():
        a["video_proof"] = None                       # proven for THIS video? (set by reprove / onboarding)
    playbook.save(pb, p)
    return playbook.load(p)


def save_job_playbook(pb, out, app):
    p = playbook_path(out, app)
    assert Path(p).resolve() != skill.playbook_path(app).resolve(), "never the shared playbook"
    playbook.save(pb, p)
    return playbook.load(p)


class BudgetSpent(RuntimeError):
    pass


class Budget:
    """Onboarding $ of ONE app in ONE video (caps.onboarding_app_usd); the job cap is llm.messages' own check."""

    def __init__(self, cap=None, spent=0.0):
        self.cap = app_cap() if cap is None else float(cap)
        self.spent = float(spent)

    def left(self):
        return round(self.cap - self.spent, 4)

    def need(self, est):
        if self.spent + est > self.cap:
            raise BudgetSpent(f"onboarding budget: ${self.spent:.2f} of ${self.cap:.2f} spent for this app in this video, "
                              f"the next call needs about ${est:.2f}")

    def add(self, usd):
        self.spent = round(self.spent + float(usd or 0), 6)


# ────────────────────────────── the live tools (guarded) ──────────────────────────────

class Guarded:
    """A recorder transport (agent_rec.mjs protocol: send({"cmd": ...})) with the onboarding rules on top:
    the Python click guard (+ the onboarding forbidden words), no generating press unless allowed (spaced),
    never one of Jake's existing chats (only chats this job created), set-dressing after every open."""

    DRESS = ("chat_mode", "hide_sidebar", "close_menus")

    def __init__(self, transport, pb=None, allowed_chats=(), allow_generate=False, spacer=None, log=None):
        self.t = transport
        self.pb = pb
        self.allowed = {CHAT_RX.search(u).group(0) for u in allowed_chats if u and CHAT_RX.search(u)}
        self.allow_generate = allow_generate
        self.spacer = spacer
        self.log = log or (lambda m: None)
        self.refusals, self.generations = [], 0
        rules_ = onboarding_rules().get("forbidden") or []
        self.forbid = [clickguard.phrase_re(w) for w in rules_]

    def _gen_press(self, a):
        lab = str(a.get("target") or a.get("text") or "")
        if a.get("type") == "key" and str(a.get("key", "")).lower() in ("enter", "numpadenter"):
            return True
        if a.get("type") == "click" and GEN_LABELS.match(lab.strip()):
            return True
        sel = str(a.get("selector") or "")
        for x in ((self.pb or {}).get("actions") or {}).values():
            if x.get("generates") and sel and sel in (x.get("selectors") or []):
                return True
        return False

    def refuse(self, why):
        self.refusals.append(why)
        self.log(f"onboarding: REFUSED — {why}")
        return {"ok": False, "refused": why, "error": why}

    def check_act(self, a):
        g = clickguard.check({k: v for k, v in a.items() if k not in ("alt", "playbook")}, None, "logged_in")
        if not g.get("ok"):
            return f"click guard: {g.get('why')}"
        lab = " ".join(str(a.get(k) or "") for k in ("target", "text", "selector", "url", "key"))
        if a.get("type") != "type":
            for rx in self.forbid:
                if rx.search(lab):
                    return f"forbidden in onboarding: {rx.pattern}"
        if a.get("type") in ("goto", "open"):
            m = CHAT_RX.search(str(a.get("url") or ""))
            if m and m.group(0) not in self.allowed:
                return "never one of Jake's existing chats (only chats this job created)"
        if a.get("selector") and re.search(r"href\*?=.?['\"]?/c/", str(a["selector"])):
            return "never one of Jake's existing chats (sidebar chat links are never clicked)"
        if self._gen_press(a) and not self.allow_generate:
            return "this step would start a generation — not allowed for this need"
        return None

    def send(self, msg):
        cmd = msg.get("cmd")
        if cmd == "open":
            m = CHAT_RX.search(str(msg.get("url") or ""))
            if m and m.group(0) not in self.allowed:
                return self.refuse("never one of Jake's existing chats (only chats this job created)")
        if cmd == "act":
            why = self.check_act(msg.get("action") or {})
            if why:
                return self.refuse(why)
            if self._gen_press(msg.get("action") or {}):
                if self.spacer:
                    self.spacer.wait()
                self.generations += 1
        r = self.t.send(msg)
        if cmd in ("act", "open"):
            u = str((r or {}).get("url") or "")
            m = CHAT_RX.search(u)
            if m and m.group(0) not in self.allowed:
                if self.generations or (msg.get("action") or {}).get("type") == "key":
                    self.allowed.add(m.group(0))      # a chat this run just created (a send in a fresh chat)
                else:
                    self.refusals.append(f"landed in an existing chat {m.group(0)} — left it")
                    self.t.send({"cmd": "open", "url": (self.pb or {}).get("start_state", {}).get("url") or "about:blank",
                                 "settle": 3})
                    return {**(r or {}), "ok": False, "error": "an existing chat opened — left it (never touched)"}
        return r

    def close(self):
        c = getattr(self.t, "close", None)
        if c:
            c()


class Session(playbook.RecorderSession):
    """playbook.replay's session on a Guarded transport: set-dressing after open (Chat mode, sidebar hidden, menus
    closed — never deleting anything), the action under proof left out of it."""

    skip = None

    def __init__(self, guarded, pb):
        super().__init__(guarded)
        self.pb = pb

    def open(self, url):
        ok, why = super().open(url)
        if not ok:
            return ok, why
        for a in Guarded.DRESS:
            if a == self.skip or a not in (self.pb.get("actions") or {}):
                continue
            for st in playbook.resolve(self.pb, a, {"optional": True} if a == "hide_sidebar" else {}):
                self.act(st)
        return True, None


class LiveTransport:
    """A live agent_rec.mjs session (agentrec.Session) on a COPY of the Scout profile, dark: screenshots mapped to host
    paths for the agent, the profile copy removed on close (disk)."""

    def __init__(self, workdir, profile, dark=True):
        import shutil
        from . import agentrec
        self.workdir = Path(workdir)
        if self.workdir.exists():
            shutil.rmtree(self.workdir, ignore_errors=True)
        self.s = agentrec.Session(self.workdir, profile, dark=dark)

    def send(self, msg):
        r = self.s.send(msg)
        if isinstance(r, dict) and str(r.get("shot", "")).startswith("/w/"):
            r["shot"] = str(self.workdir / r["shot"][3:])
        return r

    def close(self):
        import shutil
        try:
            self.s.close()
        finally:
            shutil.rmtree(self.workdir / "profile", ignore_errors=True)


# ────────────────────────────── P2: the onboarding agent ──────────────────────────────

EXPLORE_SYSTEM = """You onboard ONE user-interface action of a web app for an automated video factory, OFF CAMERA, in a
logged-in browser (a copy of the account's profile). Find out exactly how a person does the step, then PROPOSE it as a
playbook action that code will replay 3 times from fresh sessions. Rules (code enforces them too):
- never delete, buy, upgrade, touch billing, publish, share, invite or log out; never open or change an existing
  chat of the account (only the start page or a chat the factory created); no step that starts a generation
  (send / Enter in the composer / regenerate / Remove BG / resize) unless the goal says generating is allowed
- prefer stable selectors: [aria-label="…"], [data-testid="…"], then text=<exact label>; use `find` to learn them
- an action on a spot of an image/canvas is element-relative: click {"selector", "rel": [fx, fy]}, drag
  {"selector", "rel_from": [fx, fy], "rel_to": [fx, fy]} (fractions 0-1 of the element's box)
- `requires` = existing playbook action ids that must run first (e.g. open_image_viewer, viewer_markup)
- selectors are plain CSS for document.querySelectorAll (no Playwright '>>', 'nth=', ':has-text'); test one with
  `count` before you rely on it; a drag/draw on an element uses its LARGEST visible match (the viewer image, not the
  chat thumbnail behind it); `observe` refs (r12) work while exploring but never in a proposal
- the post assert must prove the step LANDED: something that appears only after it (look before and after)
- if the control does not exist anywhere (after looking in the '/' and '+' menus, the toolbar, the page), answer
  "absent" with what you searched
Answer ONE JSON object per turn, nothing else: {"do": "observe|find|act|propose|absent|give_up", "note": "<short>",
"texts": [...] (find: labels; count: CSS selectors), "action": "<a JSON object, as text>" (act),
"proposal": "<a JSON object, as text>" (propose)}."""
EXPLORE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["do", "note"],
    "properties": {
        "do": {"type": "string", "enum": ["observe", "find", "count", "act", "propose", "absent", "give_up"]},
        "note": {"type": "string"},
        "texts": {"type": "array", "items": {"type": "string"}},
        # free-form objects travel as JSON TEXT: structured outputs refuses an object without fixed properties
        # (HTTP 400 on every explorer call, found live 2026-10-10 by tests/test_schemas_api_valid.py)
        "action": {"type": "string"},
        "proposal": {"type": "string"},
    }}
KINDS_OK = ("click", "drag", "key", "paste", "type", "scroll", "draw")


def _shot_block(path):
    try:
        data = Path(path).read_bytes()
    except (OSError, TypeError):
        return None
    mt = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(data).decode()}}


def _pb_summary(pb):
    out = []
    for k, a in (pb.get("actions") or {}).items():
        out.append(f"- {k} [{a.get('kind')}] {a.get('label')} selectors={a.get('selectors', [])[:2]}"
                   + (f" requires={a['requires']}" if a.get("requires") else "") + (" GENERATES" if a.get("generates") else ""))
    return "\n".join(out)


def _slug(text):
    w = [x for x in re.sub(r"[^a-z0-9 ]", " ", str(text).lower()).split() if x not in
         {"the", "a", "an", "in", "on", "of", "to", "and", "then", "it", "its", "with", "box", "that", "this", "over"}]
    return ("ob_" + "_".join(w[:4]))[:40] or "ob_action"


_POINT_KEYS = ("from", "to", "rel_from", "rel_to", "drag_from", "drag_to", "rel", "at", "point")


def norm_points(d):
    """Coordinates the agent wrote as text ("0.3, 0.4", "[0.3,0.4]", {"x":…,"y":…}) → [x, y] numbers, in place.
    Since actions travel as JSON text (EXPLORE_SCHEMA), a drag's points arrived as strings and every drag failed
    ("drag needs from/to [x, y]" — re-run 9, the Markup box). Generic: any action, any app."""
    if not isinstance(d, dict):
        return d
    for k in _POINT_KEYS:
        v = d.get(k)
        if isinstance(v, str):
            nums = re.findall(r"-?\d+(?:\.\d+)?", v)
            if len(nums) >= 2:
                d[k] = [float(nums[0]), float(nums[1])]
        elif isinstance(v, dict) and {"x", "y"} <= set(v):
            d[k] = [float(v["x"]), float(v["y"])]
        elif isinstance(v, (list, tuple)) and len(v) >= 2:
            try:
                d[k] = [float(v[0]), float(v[1])]
            except (TypeError, ValueError):
                pass
    return d


def normalize_proposal(p, pb, need):
    """The agent's proposal → a playbook action (or ValueError). Code fills what the schema needs."""
    if not isinstance(p, dict):
        raise ValueError("no proposal object")
    norm_points(p)
    kind = p.get("kind")
    if kind not in KINDS_OK:
        raise ValueError(f"kind {kind!r} not one of {KINDS_OK}")
    sels = [s for s in (p.get("selectors") or []) if isinstance(s, str) and s.strip()]
    if kind in ("click", "paste", "type", "drag", "draw") and not sels:
        raise ValueError("a click/type/drag needs selectors")
    req = [r for r in (p.get("requires") or []) if isinstance(r, str)]
    bad = [r for r in req if r not in pb["actions"]]
    if bad:
        raise ValueError(f"requires unknown actions {bad}")
    aid = re.sub(r"[^a-z0-9_]", "_", str(p.get("id") or _slug(need)).lower())[:40] or _slug(need)
    if not aid.startswith("ob_"):
        aid = "ob_" + aid
    params = {}
    for k, v in (p.get("params") or {}).items():
        if isinstance(v, dict):
            params[k] = {kk: vv for kk, vv in v.items() if kk in ("type", "required", "default", "enum")}
    for k in ("rel", "rel_from", "rel_to", "text", "key"):
        if k in p and k not in params:
            params[k] = {"type": "array" if k.startswith("rel") else "string", "default": p[k]}
    act = {"kind": kind, "label": str(p.get("label") or need)[:80], "selectors": sels, "params": params,
           "requires": req, "pre": [a for a in (p.get("pre") or []) if isinstance(a, dict)],
           "post": [a for a in (p.get("post") or []) if isinstance(a, dict)],
           "intents": [x for x in (p.get("intents") or []) if isinstance(x, str)][:4],
           "typical_latency_s": float(p.get("typical_latency_s") or 1.0), "generates": bool(p.get("generates")),
           "proven": False, "source": f"R14 P2 onboarding (per video): {need[:160]}"}
    if p.get("start") == "chat_with_image":
        act["start_url"] = "{chat_url}"
        act["params"].setdefault("chat_url", {"type": "string", "required": True})
    trial = copy.deepcopy({k: v for k, v in pb.items() if not k.startswith("_")})
    trial["actions"][aid] = act
    errs = [e for e in playbook.validate(trial) if aid in e] + [e for e in playbook.check_guard(trial) if aid in e]
    if errs:
        raise ValueError("; ".join(errs))
    return aid, act


class Explorer:
    """The capped agent loop. Each turn is ONE stateless call (the goal + this app's playbook + a short log of the
    previous turns + the CURRENT screen only), so a turn costs the same at turn 1 and turn 14 (cached prefix)."""

    def __init__(self, ctx, budget):
        self.ctx, self.budget = ctx, budget
        r = onboarding_rules()
        self.model = r.get("model") or config.PLAN_MODEL
        self.effort = r.get("effort") or "medium"
        self.max_turns = int(r.get("max_turns_per_action", 14))

    def _call(self, static, dynamic, label):
        msgs = [{"role": "user", "content": [{"type": "text", "text": static, "cache_control": {"type": "ephemeral"}},
                                             *dynamic]}]
        est = llm.estimate(self.model, EXPLORE_SYSTEM, msgs, 6000)
        self.budget.need(est)
        # free-form JSON (action / proposal are open objects — no strict output schema), parsed leniently
        r = self.ctx.llm(self.model, EXPLORE_SYSTEM, None, 6000, effort=self.effort, msgs=msgs,
                         stage=f"preprod.onboard.{self.ctx.app}", purpose=f"onboarding {label} (Opus agent turn)")
        self.budget.add(r.get("usd"))
        txt = (r.get("text") or "").strip()
        m = re.search(r"\{.*\}", txt, re.S)
        try:
            ans = json.loads(m.group(0) if m else txt)
            if isinstance(ans, dict):
                for f_ in ("action", "proposal"):            # JSON text → object (see EXPLORE_SCHEMA)
                    if isinstance(ans.get(f_), str) and ans[f_].strip():
                        try:
                            ans[f_] = json.loads(ans[f_])
                        except ValueError:
                            ans[f_] = {}
            return ans if isinstance(ans, dict) else {"do": "observe", "note": "the reply was not an object"}
        except ValueError:
            return {"do": "observe", "note": "the reply was not JSON"}

    def run(self, need, start_url, transport, feedback=None, allow_generate=False):
        """→ {"status": "proposed"|"absent"|"failed", "action_id", "action", "turns", "log", "why"}"""
        pb = self.ctx.pb
        static = (f"APP: {pb['app']} ({', '.join(pb.get('hosts', []))}). GOAL — the step to onboard: {need}\n"
                  f"Generating allowed: {'yes (spaced, counted)' if allow_generate else 'no'}.\n"
                  f"START: {start_url} (set-dressed: Chat mode, sidebar hidden, menus closed).\n"
                  f"THIS VIDEO'S PLAYBOOK (actions you may name in requires):\n{_pb_summary(pb)}\n"
                  "TOOLS (one per turn): observe | find {texts: labels} | count {texts: CSS selectors → how many match} | act {action: {type: click|drag|key|type|hover|scroll|"
                  "goto|hold, ...}} | propose {proposal: {id, kind, label, selectors, params, requires, pre, post, intents,"
                  " start: home|chat_with_image, typical_latency_s}} | absent | give_up.\n"
                  "Asserts: {kind: selector|absent|text, selector|value}. A good post assert proves the step LANDED.")
        log = []
        sess = Session(transport, pb)                  # open + set-dressing (sidebar with the old chats hidden)
        ok, why = sess.open(start_url)
        obs = transport.send({"cmd": "observe"}) if ok else {"error": f"start: {why}"}
        if feedback:
            log.append(f"previous proposal failed its replays: {feedback}")
        for turn in range(1, self.max_turns + 1):
            check = getattr(self.ctx, "check_cancel", None)
            if check:
                check()
            dyn = [{"type": "text", "text": "LOG:\n" + "\n".join(log[-12:]) + f"\nTURN {turn}/{self.max_turns}. "
                    f"CURRENT: {json.dumps({k: obs.get(k) for k in ('url', 'ok', 'error', 'refused', 'found', 'counts')}, default=str)[:3000]}"}]
            if obs.get("items"):
                dyn.append({"type": "text", "text": "ELEMENTS: " + json.dumps([{k: i.get(k) for k in ("ref", "tag", "text", "box")}
                                                                             for i in obs["items"][:120]])[:9000]})
            img = _shot_block(obs.get("shot"))
            if img:
                dyn.append(img)
            try:
                ans = self._call(static, dyn, f"'{need[:40]}' turn {turn}")
            except BudgetSpent as e:
                return {"status": "failed", "why": str(e), "turns": turn - 1, "log": log, "budget": True}
            do = ans.get("do")
            log.append(f"{turn}: {do} — {str(ans.get('note'))[:160]}")
            if do == "observe":
                obs = transport.send({"cmd": "observe"})
            elif do == "count":
                sels = list(ans.get("texts") or ([ans.get("selector")] if ans.get("selector") else []))[:6]
                obs = {"counts": {x: transport.send({"cmd": "count", "selector": x}).get("n") for x in sels}}
                log[-1] += f" → {obs['counts']}"
            elif do == "find":
                obs = {"found": transport.send({"cmd": "find", "texts": list(ans.get("texts") or [])[:6]}).get("found", {})}
            elif do == "act":
                obs = transport.send({"cmd": "act", "action": norm_points(dict(ans.get("action") or {}))})
                log[-1] += f" → {'ok' if obs.get('ok', True) and not obs.get('error') else obs.get('error') or obs.get('refused')}"
                if obs.get("ok", True) and not obs.get("error"):
                    obs = {**transport.send({"cmd": "observe"}), "act": obs}
            elif do == "propose":
                try:
                    aid, act = normalize_proposal(ans.get("proposal"), pb, need)
                except ValueError as e:
                    log[-1] += f" → proposal refused: {e}"
                    obs = {"error": f"proposal refused: {e}"}
                    continue
                return {"status": "proposed", "action_id": aid, "action": act, "turns": turn, "log": log}
            elif do == "absent":
                return {"status": "absent", "why": ans.get("note"), "turns": turn, "log": log}
            else:
                return {"status": "failed", "why": ans.get("note") or "gave up", "turns": turn, "log": log}
        return {"status": "failed", "why": f"no proposal in {self.max_turns} turns", "turns": self.max_turns, "log": log}


def prove(ctx, aid, params=None, n=None):
    """THIS video's proof: n fresh sessions (playbook.replay on the job playbook, never saved to the skill)."""
    n = n or int(onboarding_rules().get("replays_required", 3))
    gen = bool(ctx.pb["actions"][aid].get("generates"))

    def factory():
        s = Session(ctx.guarded(allow_generate=gen), ctx.pb)
        s.skip = aid
        return s
    return playbook.replay(factory, ctx.pb, aid, n=n, params=params or {}, allow_generate=gen)


def onboard_action(ctx, need, params=None, generates=False, generating=False):
    """P2 for one needed action: explore → propose → prove 3/3 (fix rounds feed the failures back). → row.
    generating=True: the step STARTS a generation (a tool's submit): the explorer finds it without pressing it, and
    it is proven by presence (its requires + selector + pre asserts), never pressed 3x (3 generations) — the
    producer presses it once, counted, when it makes the asset."""
    ex = Explorer(ctx, ctx.budget)
    row = {"need": need, "status": "failed", "attempts": []}
    feedback = None
    start = ctx.start_url(need)
    for rnd in range(int(onboarding_rules().get("fix_rounds", 2)) + 1):
        tr = ctx.guarded(allow_generate=generates)
        try:
            res = ex.run(need, start, tr, feedback=feedback, allow_generate=generates)
        finally:
            tr.close()
        row["attempts"].append({k: res.get(k) for k in ("status", "why", "turns", "action_id", "log")})
        if res["status"] == "absent":
            row.update(status="absent", why=res.get("why"))
            return row
        if res["status"] != "proposed":
            row.update(why=res.get("why"), budget=bool(res.get("budget")))
            return row
        aid, act = res["action_id"], res["action"]
        if generating:
            act["generates"] = True
        ctx.pb["actions"][aid] = act
        p = dict(params or {})
        if act.get("start_url") and ctx.image_chat:
            p.setdefault("chat_url", ctx.image_chat)
        if act.get("kind") == "drag" and not any(isinstance(act.get(k), list) for k in ("rel_from", "from", "points")) \
                and not any(isinstance(p.get(k), list) for k in ("rel_from", "from")):
            # a drag whose points are DATA at use time (a located region): proven with a neutral centre box — the
            # proof checks that a box lands, the producer passes the real located points when it uses the action
            p.update(rel_from=[0.38, 0.42], rel_to=[0.62, 0.58])
        if generating:
            ok, why = presence(ctx, aid, p)
            pr = {"proven": ok, "ok": int(ok), "n": 1, "replays": [{"ok": ok, "why": why, "mode": "presence (generating)"}]}
        else:
            pr = prove(ctx, aid, p)
        row["attempts"][-1]["replays"] = pr["replays"]
        if pr["proven"]:
            act["video_proof"] = {"mode": "onboarded", "replays": pr["replays"], "ok": pr["ok"], "n": pr["n"]}
            ctx.pb = save_job_playbook(ctx.pb, ctx.out, ctx.app)
            row.update(status="proven", action_id=aid, replays=f"{pr['ok']}/{pr['n']}")
            return row
        ctx.pb["actions"].pop(aid, None)
        row["attempts"][-1]["proposal"] = act             # what was proposed, for the log when it is not proven
        feedback = "; ".join(str(x.get("why")) for x in pr["replays"] if not x["ok"])[:600]
        ctx.log(f"onboarding '{need[:60]}': proposal not proven — WHY: {feedback[:400]} — PROPOSAL: "
                f"{json.dumps({k: v for k, v in act.items() if k not in ('replays', 'intents', 'source')})[:1400]}")
    row["why"] = f"not proven after {len(row['attempts'])} round(s): {feedback}"
    return row


def reprove_existing(ctx, ids, params=None):
    """Per-video re-proof of the shared actions this video uses (the UI changes weekly): non-generating ones replay
    reprove_existing_replays time(s) from a fresh session; a generating one is checked for presence (its requires +
    pre asserts) — never pressed. A failure is re-onboarded (P2) for this video. → {id: row}."""
    n = int(onboarding_rules().get("reprove_existing_replays", 1))
    out = {}
    for aid in ids:
        a = ctx.pb["actions"].get(aid)
        if a is None or (a.get("video_proof") or {}).get("ok"):
            continue
        prm = dict((params or {}).get(aid) or {})
        if a.get("start_url") and ctx.image_chat:
            prm.setdefault("chat_url", ctx.image_chat)
        if a.get("generates"):
            ok, why = presence(ctx, aid, prm)
            a["video_proof"] = {"mode": "presence (generating: never pressed off its asset)", "ok": ok, "why": why}
        else:
            try:
                pr = prove(ctx, aid, prm, n=n)
                ok, why = pr["proven"], "; ".join(str(x["why"]) for x in pr["replays"] if not x["ok"])
            except playbook.PlaybookError as e:
                ok, why = False, str(e)
            a["video_proof"] = {"mode": f"replay {n}x", "ok": ok, "why": why or None}
        out[aid] = {"ok": ok, "why": why}
        if not ok:
            r = onboard_action(ctx, f"{a.get('label')} — the existing '{aid}' step ({a.get('kind')}) no longer replays: "
                                    f"{why}", prm, generates=False)
            out[aid]["reonboarded"] = r
            if r.get("status") == "proven":
                new = ctx.pb["actions"].pop(r["action_id"])
                new["video_proof"] = {**(new.get("video_proof") or {}), "replaces": aid}
                new["generates"] = a.get("generates", False)
                ctx.pb["actions"][aid] = {**new, "intents": a.get("intents", []), "proven": True}
                out[aid]["ok"] = True
    ctx.pb = save_job_playbook(ctx.pb, ctx.out, ctx.app)
    return out


def presence(ctx, aid, params=None):
    pb = ctx.pb
    a = pb["actions"][aid]
    s = Session(ctx.guarded(allow_generate=False), pb)
    try:
        ok, why = s.open(playbook._fill(a.get("start_url") or pb["start_state"]["url"], dict(params or {})))
        if not ok:
            return False, f"start: {why}"
        for r in a.get("requires", []):
            for st in playbook.resolve(pb, r, params or {}):
                ok, why = s.act(st)
                if not ok:
                    return False, f"requires {r}: {why}"
        sels = a.get("selectors") or []
        if sels and not sels[0].startswith("text="):
            n = s.t.send({"cmd": "count", "selector": sels[0]}).get("n", 0)
            if n <= 0:
                return False, f"no {sels[0]} on the page"
        for c in a.get("pre", []):
            ok, why = s.check(playbook._fill_assert(c, playbook._params(a, dict(params or {}))))
            if not ok:
                return False, f"pre: {why}"
        return True, None
    finally:
        s.close()


# ────────────────────────────── P4: verify absence ──────────────────────────────

def _feature_words(feature, text=None):
    out = []
    for s in (text, feature):
        s = str(s or "")
        m = re.search(r"[/@][\w-]+", s)
        if m:
            out.append(m.group(0))
        q = re.findall(r"['\"‘“]([^'\"’”]{2,30})['\"’”]", s)
        out += q
    if not out and feature:
        out.append(re.sub(r"^(?:the|a|an)\s+", "", str(feature)).split(" (")[0][:30])
    return [w for w in dict.fromkeys(x.strip() for x in out) if w]


def verify_feature(ctx, feature, text=None):
    """P4 step 1: is the feature REALLY absent in the live app? Searches what a person would: the composer's '/' menu
    (typing the command), the '+' menu, the page (and the toolbar the start page shows). Readiness' own live check
    for the same feature (this job, today) counts as a search too. → {"absent", "searched", "hits"}."""
    words = _feature_words(feature, text)
    searched, hits = [], []
    for c in (ctx.readiness or {}).get("checks", []) or []:
        lab = str(c.get("label") or "") + " " + str(c.get("id"))
        if any(w.lower().strip("/@") in lab.lower() for w in words if len(w) > 2):
            searched.append(f"readiness {c['id']} (live, this job): {c.get('status')}")
            if c.get("status") == "pass":
                hits.append({"readiness": c["id"]})
    pb = ctx.pb
    tr = ctx.guarded(allow_generate=False)
    try:
        tr.send({"cmd": "open", "url": pb["start_state"]["url"], "settle": 4})
        comp = next((s for s in (pb["actions"].get("paste_prompt") or {}).get("selectors", [])), '[contenteditable="true"]')
        for w in words:
            if w.startswith(("/", "@")):
                tr.send({"cmd": "act", "action": {"type": "type", "selector": comp, "text": w, "paste": True}})
                f = tr.send({"cmd": "find", "texts": [w.strip("/@")]}).get("found", {})
                rows = [h for h in f.get(w.strip("/@"), []) if "contenteditable" not in str(h.get("selector"))
                        and str(h.get("text", "")).strip().lower() != w.lower()]
                searched.append(f"typed {w!r} in the composer → {len(rows)} menu hit(s)")
                hits += rows
                tr.send({"cmd": "act", "action": {"type": "key", "key": "Escape"}})
                tr.send({"cmd": "act", "action": {"type": "type", "selector": comp, "text": "", "paste": True, "clear": True}})
        if "open_plus_menu" in pb["actions"]:
            for st in playbook.resolve(pb, "open_plus_menu", {}):
                tr.send({"cmd": "act", "action": {k: v for k, v in st.items() if k not in ("alt", "playbook")}})
            for w in words:
                f = tr.send({"cmd": "find", "texts": [w.strip("/@")], "exact": False}).get("found", {})
                rows = [h for h in f.get(w.strip("/@"), []) if "contenteditable" not in str(h.get("selector"))]
                searched.append(f"'+' menu: {w!r} → {len(rows)} hit(s)")
                hits += rows
            tr.send({"cmd": "act", "action": {"type": "key", "key": "Escape"}})
        tx = tr.send({"cmd": "text"}).get("text", "")
        for w in words:
            if len(w) > 3 and not w.startswith(("/", "@")) and re.search(rf"\b{re.escape(w)}\b", tx):
                hits.append({"page_text": w})
            searched.append(f"page text: {w!r}")
    finally:
        tr.close()
    return {"absent": not hits, "searched": searched, "hits": hits[:6], "words": words}


# ────────────────────────────── P3: assets before recording ──────────────────────────────

RESULT_RX = re.compile(r"\b(result|colori[sz]ed|restored|edited|generated|made by|merge[ds]?|combined|logo|cutout|"
                       r"after|turned into|fixed|sharpened|redesign\w*|version)\b", re.I)


def asset_kind(desc):
    """An input he brings (a phone photo, a blurry photo, his great-grandma's photo) → 'photo' (image API);
    something the app MADE (the colorized result, the merge, the logo) → 'app_generation' (the app itself)."""
    return "app_generation" if RESULT_RX.search(str(desc or "")) else "photo"


def _remember(ctx, aid, row):
    """What later assets need to know about a ready one: its file, its description, the chat (+ index) it was made in
    (a chat this job's producer created — the app's own tools run on it there)."""
    ctx.asset_files[aid] = row["file"]
    ctx.asset_descs[aid] = str(row.get("desc") or "")[:200]
    src = row.get("source") or {}
    if src.get("chat_url"):
        ctx.asset_chats[aid] = {"chat": src["chat_url"], "nth": src.get("nth")}
        ctx.allowed_chats.add(src["chat_url"])


PAIR_RX = re.compile(r"^(?P<inp>.{6,160}?\b(?:photo|picture|image|scan|snapshot|sketch|drawing)\b[^+→>]{0,60}?)\s*"
                     r"(?:\+|→|->|=>|\band (?:then )?(?:its|the|a|an)\b|\bthen\b|\bnext to (?:its|the)\b)\s*"
                     r"(?P<res>.{0,60}?\b(?:result|version|colori[sz]ed|restored|edited|fixed|after)\b.*)$", re.I)


def split_pair(desc):
    """'b/w photo + colorized result' → (input description, result description), else None."""
    d = str(desc or "").strip()
    if ":" in d[:60]:
        d = d.split(":", 1)[1].strip()
    m = PAIR_RX.match(d)
    if not m or re.search(r"\b(?:result|version|colori[sz]ed|restored)\b", m.group("inp"), re.I):
        return None
    return m.group("inp").strip(" ,;"), m.group("res").strip(" ,;")


def reuse_ok(ctx, aid, old):
    """A stored row is reused only when it passes TODAY's checks (look, continuity, no UI chrome): a row the new
    producer checked carries fidelity v>=2; an older one is re-checked once (one vision call) — so a dropped or redo
    asset is never resurrected by its old side file."""
    from . import producer as prod_mod
    fid = old.get("fidelity") or {}
    if fid.get("v", 0) >= prod_mod.FIDELITY_V and all(fid.get(k, True) for k in ("look_ok", "clean", "same_subject")):
        return True
    if getattr(ctx, "check", None) is None:
        return False
    desc = str(old.get("desc") or "")
    p_ = getattr(ctx, "producer", None)
    look = old.get("look") or ("faithful" if p_ is not None and p_.tool_of(desc) else
                               "real" if asset_kind(desc) == "photo" else "impressive")
    srcs = [ctx.asset_files[m] for m in old.get("made_from") or [] if ctx.asset_files.get(m)]
    try:
        chk = ctx.check({"id": aid, "desc": desc, "look": look, **({"source_files": srcs} if srcs else {})},
                        old["file"], [desc])
        ctx.budget.add(chk.get("usd"))
    except Exception as e:  # noqa: BLE001 — not checkable: made again
        ctx.log(f"{aid}: the stored picture could not be re-checked ({e})")
        return False
    ok = bool(chk.get("matches")) and all(chk.get(k, True) is not False for k in ("same_subject", "look_ok", "clean"))
    if ok:
        old["fidelity"] = {"v": prod_mod.FIDELITY_V, "look": look, "look_ok": True, "clean": True, "rechecked": True,
                           **({"same_subject": True} if srcs else {})}
        old["look"] = look
    return ok


def _row(aid, desc, status, why, **kw):
    return {"id": aid, "kind": "app_generation", "desc": desc, "status": status, "file": None, "source": None,
            "attempts": [why], "checks": [], "why": why, **kw}


def produce_asset(ctx, aid, desc, made_from=(), prompt=None, sentence=None, window=None, look=None, verbatim=False,
                  source_hint=None):
    """P3: one needed asset, made IN THE APP before recording, off camera, checked against its description; never
    silently dropped. Jake 2026-10-10: "it needs to generate images in the ChatGPT UI" — no image API here.
      live (ctx.producer set, preprod.make_ctx): the producer AGENT (aieditor/producer.py) — the learned / hint recipe
        first, then it diagnoses every failed try and picks the next route itself; a route that works is learned into
        THIS video's playbook. Raises genledger.QuotaWait at the daily cap / a wall (the job waits, never holds).
      no producer (tests, a hand run): the app adapter's own in-app call (ctx.in_app), spaced, <= max tries, checked.
    FIDELITY (Jake 2026-10-10, TEST v3):
      - the guard: it must be a picture the video shows (not_a_picture) — a camera move never reaches the app;
      - the request is what the PERSON types (person_request), never the planner's internal description; a tool result
        with no typed text is just the tool's click; every concrete detail he narrates is kept;
      - the look (real | impressive | faithful) rides on the request and is scored by the vision check;
      - "the result of the app's <tool> on <source>" runs the tool (playbook produce.tools) on the source picture;
      - a new picture of a subject the video already has (the hero bottle) is an EDIT of that picture (source_inputs).
    An asset an earlier run of this job already produced and checked (assets/<id>.produced.json) is reused: a job
    that waited for the daily cap does not pay for it twice.
    → assets.json row {id, kind, desc, status ready|needs_asset|not_a_picture, file, source, attempts, checks}."""
    dst = Path(ctx.out) / "assets" / f"{aid}.png"
    dst.parent.mkdir(parents=True, exist_ok=True)
    side = dst.with_suffix(".produced.json")
    try:
        old = json.loads(side.read_text())
        if old.get("desc") == desc and old.get("status") == "ready" and Path(old.get("file") or "").exists():
            if reuse_ok(ctx, aid, old):
                _remember(ctx, aid, old)
                side.write_text(json.dumps(old, indent=1, ensure_ascii=False))
                ctx.log(f"{aid}: already made and checked by an earlier run of this job — reused")
                return old
            ctx.log(f"{aid}: an earlier run made it, but it fails today's fidelity checks — made again")
    except (OSError, ValueError):
        pass
    why = not_a_picture(desc)
    if why:
        ctx.log(f"{aid}: not made — {why} (no generation)")
        return _row(aid, desc, "not_a_picture", why, made_from=list(made_from))
    # an input AND its result in one description ("b/w photo + colorized result"): TWO pictures — the input (a real
    # photo he brings) first, then the result made FROM it (TEST v3: a before/after collage with a caption baked in)
    # a merge of SEVERAL sources is not an input+result pair: its sources are made one by one below (re-run 5: "three
    # source photos and the merged result" became ONE input picture of three photos — a collage)
    pair = split_pair(desc) if not made_from and not getattr(ctx, "_composing", False) \
        and not _multi_source(" ".join(str(x or "") for x in (desc, sentence, window))) else None
    if pair:
        iid = f"{aid}_input"[:40]
        ctx.log(f"{aid}: names an input and its result — making the input '{iid}' first, then the result from it")
        if iid not in ctx.asset_files:
            ctx._composing = True
            try:
                r_in = produce_asset(ctx, iid, pair[0], sentence=sentence, window=window, look="real")
            finally:
                ctx._composing = False
            if r_in.get("status") != "ready":
                return _row(aid, desc, "needs_asset", f"its input picture '{iid}' could not be made: {r_in.get('why')}"[:400])
        made_from = (iid,)
    prod = getattr(ctx, "producer", None)
    tool = prod.tool_of(desc) if prod is not None else None
    tspec = prod.tool_spec(tool) if tool else {}
    on_source = bool(tool) and tspec.get("on_source", True)
    # a picture MADE FROM other pictures (a merge of three photos, an edit of a reference, a tool on a photo, a new shot
    # of the video's hero product) is made for real: its source pictures first (reusing one the video already has),
    # then the app's own edit / tool on them — never a single invented "merge" (TEST v3)
    multi = _multi_source(" ".join(str(x or "") for x in (desc, sentence, window)))
    if (not made_from or multi) and not getattr(ctx, "_composing", False) and (not tool or on_source):
        # a linked single prior picture is not enough when the narration merges several (TEST v3 re-run 4: the 3-photo
        # merge was made as one edit of the bottle photo — the person and the stall were never made)
        plan_in = source_inputs(ctx, " ".join(x for x in (str(desc), str(window or "")) if x)
                                + (f"\n(The picture shown just before is '{source_hint}' — use it ONLY if this picture is "
                                   f"really made from it.)" if source_hint else "")
                                + (f"\n(The plan linked: {', '.join(made_from)} — keep the ones that really are sources, and "
                                   f"add every source the narration names that is not available yet.)" if made_from else ""),
                                {k: ctx.asset_descs.get(k, "") for k in sorted(ctx.asset_files)}, tool=tool)
        if not (plan_in.get("needs_inputs") and plan_in.get("inputs")) and not plan_in.get("same_as") \
                and source_hint and not plan_in.get("decided"):
            made_from = (source_hint,)                    # no answer from the source step: the hint stands
        same = str(plan_in.get("same_as") or "")
        if same and same in ctx.asset_files and not tool:
            shutil.copyfile(ctx.asset_files[same], dst)
            row = {"id": aid, "kind": "app_generation", "desc": desc, "status": "ready", "file": str(dst),
                   "source": {**((json.loads(dst.with_name(f"{same}.produced.json").read_text()).get("source") or {})
                                 if dst.with_name(f"{same}.produced.json").exists() else {}),
                              "reused": same, "type": f"the same picture as '{same}' (reused, no generation)"},
                   "attempts": [], "checks": [], "made_from": [same], "for": "R14 P3"}
            ctx.log(f"{aid}: the same picture as '{same}' — reused (no generation)")
            _remember(ctx, aid, row)
            side.write_text(json.dumps(row, indent=1, ensure_ascii=False))
            return row
        if plan_in.get("needs_inputs") and plan_in.get("inputs"):
            ids = []
            ctx._composing = True
            try:
                for inp in plan_in["inputs"][:4]:
                    iid = re.sub(r"[^a-z0-9_]+", "_", str(inp.get("id") or "").lower()).strip("_")[:32] or f"{aid}_src{len(ids) + 1}"
                    if iid not in ctx.asset_files:
                        ctx.log(f"{aid}: needs its source picture '{iid}' first — making it")
                        r_in = produce_asset(ctx, iid, str(inp.get("desc") or iid), sentence=sentence, window=window)
                        if r_in.get("status") != "ready":
                            return _row(aid, desc, "needs_asset", f"its source picture '{iid}' could not be made: "
                                                                  f"{r_in.get('why')}"[:400])
                    elif iid != aid:
                        ctx.log(f"{aid}: made from the picture the video already has: '{iid}'")
                    ids.append(iid)
            finally:
                ctx._composing = False
            made_from = tuple(ids)
            if not prompt and plan_in.get("instruction") and not tool:
                prompt = str(plan_in["instruction"])
    inputs = [ctx.asset_files.get(m) for m in made_from if ctx.asset_files.get(m)]
    from . import preprod
    new_photo = not made_from and not prompt and not tool
    req = person_request(ctx, desc, sentence, window, tool=tool, tool_spec=tspec, new_photo=new_photo,
                         typed_hint=None if verbatim else prompt)
    look = look or req["look"]
    on_screen = verbatim or bool(req.get("on_screen") and req.get("typed"))
    if prod is not None:
        src = None
        if made_from:
            m0 = made_from[0]
            ch = ctx.asset_chats.get(m0) or {}
            src = {"id": m0, "file": ctx.asset_files.get(m0), "chat": ch.get("chat"), "nth": ch.get("nth")}
        if new_photo and not on_screen:
            style, subject, final = look_style(look), with_look(image_prompt(ctx, desc), look, cues=False), None
        else:
            typed = (prompt if verbatim else req["typed"]) if (not tool or tspec.get("typed")) else ""
            if tool and not tspec.get("typed"):
                final = None                               # the tool's click, no text at all
            elif on_screen:
                # his on-screen words VERBATIM first; off camera an IMPRESSIVE result may get one added paragraph after
                # them (Jake 2026-10-10: "it needs to be word by word like in the script - but you can add a paragraph
                # to it to make it look impressive"). On camera he types only his words.
                final = verbatim_plus(typed or prompt, look)
            else:
                final = with_look(typed or prompt or req["as_words"], look)
            style, subject = "", final or req["as_words"]
        row = prod.produce(aid, desc, dst, inputs, prompt=final, subject=subject, style=style,
                           # his on-screen prompt IS what the picture must show — not an internal object list
                           # (re-run 5: "does not match (label, window)" — words his prompt never says)
                           objects=([req.get("typed") or prompt] if on_screen and (req.get("typed") or prompt)
                                    else [req["expect"]] if req.get("expect") else None), tool=tool,
                           tool_params=req.get("params") or {}, source=src, look=look, verbatim=on_screen,
                           as_words=with_look(req["as_words"], look) if not on_screen else req["as_words"])
        row["made_from"] = list(made_from)
    else:
        base = verbatim_plus(prompt, look) if on_screen else (with_look(prompt or req["typed"] or req["as_words"], look) if not new_photo else None)
        row = _produce_in_app(ctx, aid, desc, dst, made_from, inputs, base, new_photo, look=look)
    row["look"] = look
    if row.get("status") == "ready":
        _remember(ctx, aid, row)
        side.write_text(json.dumps(row, indent=1, ensure_ascii=False))
    return row


def _produce_in_app(ctx, aid, desc, dst, made_from, inputs, prompt, new_photo, look="real"):
    """The simple path without the agent: the adapter's in-app call, spaced, up to max_tries_per_asset, checked."""
    tries = int(onboarding_rules().get("max_tries_per_asset", 10))
    base = prompt or ("Create an image: " + look_style(look) + with_look(image_prompt(ctx, desc), look, cues=False)
                      if new_photo else desc)
    row = {"id": aid, "kind": "app_generation", "desc": desc, "status": "needs_asset", "file": None, "source": None,
           "attempts": [], "checks": [], "prompt": base, "made_from": list(made_from), "for": "R14 P3"}
    if ctx.in_app is None:
        row["attempts"].append("in-app producer: no app session")
        row["why"] = "no app session to make it in (no image API: Jake 2026-10-10)"
        return row
    p = base
    for k in range(tries):
        ctx.spacer.wait()
        try:
            r = ctx.in_app({"id": aid, "prompt": p, "desc": desc, "made_from": list(made_from)}, dst, inputs)
            if not r:
                raise RuntimeError("the app made no image")
            src = {"type": "in-app generation (off camera)", "prompt": p, "attempt": k + 1, **(r if isinstance(r, dict) else {})}
        except Exception as e:  # noqa: BLE001 — the next try
            row["attempts"].append(f"in-app try {k + 1}: {e}"[:240])
            continue
        res = ctx.check({"id": aid, "desc": desc, "look": look,
                         **({"source_files": [f for f in inputs if f]} if inputs else {})}, dst, [desc])
        row["checks"].append({"producer": "app_generation", "try": k + 1, "matches": res.get("matches"),
                              "missing": res.get("missing_objects")})
        ctx.budget.add(res.get("usd"))
        if res.get("matches"):
            row.update(status="ready", file=str(dst), source=src)
            return row
        p = base.rstrip(". ") + ". It must clearly show " + ", ".join(res.get("missing_objects") or [desc]) + "."
    row["attempts"].append(f"in-app: {tries} tries did not pass the check")
    row["why"] = f"every try failed ({'; '.join(row['attempts'][-2:])})"[:400]
    return row


# ── the LOOK (Jake 2026-10-10): "it should look impressive when it needs to look impressive, and it should look real
#    when it needs to look real. Make sure the prompts match it every time." ──
LOOKS = ("real", "impressive", "faithful")
LOOK_CUES = {
    "real": ("Casual phone snapshot, handheld, slightly uneven framing, ordinary indoor light, a little noise and "
             "softness, everyday clutter, unedited, the kind of photo anyone takes. "),
    "impressive": ("Striking composition, beautiful natural light, rich fine detail, sharp focus, vivid but believable "
                   "colour, the kind of picture that makes people stop scrolling. "),
    "faithful": "",
}
LOOK_BOOST = {
    "real": "Make it look like a real amateur phone photo, not a polished or AI-looking image. ",
    "impressive": "Make it look genuinely impressive: a bold, well-lit, detailed shot worth showing off. ",
    "faithful": "",
}
# words that make a "real" photo look staged / AI-made, and any styling on a "faithful" tool result
GLOSS_RX = re.compile(r",?\s*\b(?:professional(?:ly)?|cinematic|studio(?:[- ]lit| lighting| shot)?|glossy|polished|"
                      r"award[- ]winning|masterpiece|ultra[- ]?(?:detailed|realistic|hd)|hyper[- ]?realistic|8k|4k|hdr|"
                      r"dramatic lighting|commercial|editorial|magazine[- ]quality|high[- ]end|premium)\b", re.I)
STYLE_RX = re.compile(r",?\s*\b(?:stunning|beautiful|striking|vivid|gorgeous|moody|vibrant|dramatic|artistic|stylish|"
                      r"professional(?:ly)?|cinematic|studio|glossy|polished|award[- ]winning|masterpiece|"
                      r"ultra[- ]?(?:detailed|realistic|hd)|hyper[- ]?realistic|8k|4k|hdr|high[- ]end|premium)\b", re.I)


def look_style(look, boost=0):
    """The look's cue line for a NEW picture's prompt (plain words a person might type)."""
    return LOOK_CUES.get(look, "") + (LOOK_BOOST.get(look, "") if boost else "")


IMPRESSIVE_PARAGRAPH = ("Make this a genuinely impressive, photoreal image: a strong, well-balanced composition, beautiful "
                        "natural light with depth and soft shadows, rich fine detail and texture, sharp focus on the "
                        "subject, vivid but believable colour. No text, captions, borders or collage panels.")


def verbatim_plus(words, look):
    """An on-screen prompt off camera: his words exactly as the script has them, then — for an impressive look only —
    ONE added paragraph that lifts the result. His words are never edited, reordered or trimmed."""
    w = str(words or "").strip()
    if look == "impressive" and w:
        return f"{w} {IMPRESSIVE_PARAGRAPH}"            # one line: a newline typed in a composer can send early
    return w


def with_look(text, look, cues=True, boost=0):
    """A request carrying its look: real → no gloss words (+ phone-snapshot cues), impressive → light/composition/detail
    cues, faithful → no styling words at all. (Never called on an on-screen prompt: that one is verbatim.)"""
    t = str(text or "").strip()
    if look == "real":
        t = re.sub(r"\s{2,}", " ", GLOSS_RX.sub("", t)).strip(" ,")
    elif look == "faithful":
        t = re.sub(r"\s{2,}", " ", STYLE_RX.sub("", t)).strip(" ,")
    if not cues or look == "faithful" or not t:
        return t
    tail = (LOOK_CUES.get(look) or "").strip()
    if boost:
        tail = (tail + " " + LOOK_BOOST.get(look, "")).strip()
    return f"{t.rstrip('. ')}. {tail}" if tail else t


STOP = set("""a an the and or but of to in on at by for with from into onto over under this that these those it its is are
be been was were he she i i'm i'll you your my me we our they them his her just so then now also very really make made
let let's lets it's can could would should will do does did done have has had not no yes as like there here what which who
how why when where some any all more most one two up out off about than too only even still get got gonna want photo
picture image please okay ok uh um um, right well""".split())


def content_words(text):
    """The concrete words of a narrated request (rustic, kitchen, golden, 9:16, regret …), lower-case."""
    t = re.sub(r"(?:^|\s)[/@][\w-]+", " ", str(text or ""))           # a /command itself is not a detail to keep
    out = []
    for w in re.findall(r"[a-z0-9][a-z0-9:'’-]*", t.lower()):
        w = w.strip("'’-").replace("’", "'")
        w = re.sub(r"'s$", "", w)
        if len(w) >= 3 and w not in STOP or re.match(r"^\d+:\d+$", w):
            out.append(w)
    return list(dict.fromkeys(out))


def missing_words(narrated, request):
    """The narrated request's content words the rewrite dropped (or substituted). A word counts as kept when the
    request has it or its stem (charred ~ char, aged ~ age)."""
    have = " " + " ".join(content_words(request)) + " "
    out = []
    for w in content_words(narrated):
        stem = re.sub(r"(?:ed|ing|es|s)$", "", w) if len(w) > 4 else w
        if f" {w} " not in have and not re.search(rf"\b{re.escape(stem)}\w*", have):
            out.append(w)
    return out


def keep_details(narrated, request):
    """The deterministic repair when a rewrite still drops narrated details: his words go back in, verbatim."""
    miss = missing_words(narrated, request)
    if not miss:
        return request
    return f"{str(request).rstrip('. ')} ({narrated.strip()})"


PERSON_SYSTEM = """A video shows a person using an app. A picture in the video must be MADE in that app, off camera, the way
the person does it. From the planner's INTERNAL description (never shown to the app) and the narration, write:
- typed: exactly what the person types into the app for this picture, in his words. When the narration reads or shows
  the prompt he types, copy it VERBATIM and set on_screen=true. When the picture comes from a tool button with no
  typed text (e.g. a remove-background or resize click), typed is "". Never internal words: "result", "in-app", the
  app's name, ids, "same X as" — a person never types those.
- narrated: the request words as he SAYS them in the narration (verbatim span; "" if he says none).
- as_words: the same change asked plainly in a chat with the picture attached (used only if the tool fails).
- look: "real" = an ordinary input he brings (a phone photo, a blurry or old photo, "my product on a desk"): amateur,
  believable, unpolished. "impressive" = a showcase result the video sells (sketch → photo, a merge, a logo, a hero
  shot): striking, high quality. "faithful" = a tool result that must show exactly what he narrates, artefacts
  included (a partial erase, soft cut-out edges): honest, not prettified.
- expect: what the picture must visibly show (objects, and for a tool result the narrated artefacts).
- params: values a tool needs, from the options given (e.g. shape, target = the thing to brush/box/pin).
RULE: every concrete detail he narrates (materials, light, time of day, colours, ratios like 9:16, names in quotes,
an on-screen prompt's wording) is kept EXACTLY; you may only add what the app needs, never substitute. JSON only."""
KV_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["key", "value"],
             "properties": {"key": {"type": "string"}, "value": {"type": "string"}}}
PERSON_SCHEMA = {"type": "object", "additionalProperties": False,
                 "required": ["typed", "on_screen", "narrated", "as_words", "look", "expect", "params"],
                 "properties": {"typed": {"type": "string"}, "on_screen": {"type": "boolean"},
                                "narrated": {"type": "string"}, "as_words": {"type": "string"},
                                "look": {"type": "string", "enum": list(LOOKS)}, "expect": {"type": "string"},
                                "params": {"type": "array", "items": KV_SCHEMA}}}
INTERNAL_RX = re.compile(r"\bin-app\b|\bresults?\b|\basset\b|\b[a-z]+_[a-z_]+\b|\bsame (?:\w+ ){0,2}as\b|"
                         r"\b(?:the app|the planner)\b", re.I)


def _strip_internal(desc, app_name=""):
    """Without a model: the internal description → plain words (never the description itself)."""
    t = str(desc or "")
    if ":" in t[:80]:
        t = t.split(":", 1)[1]
    t = re.sub(rf"\b(?:{re.escape(app_name)}(?:'s)?|in-app|the app's|results?|asset)\b" if app_name else
               r"\b(?:in-app|the app's|results?|asset)\b", " ", t, flags=re.I)
    t = re.sub(r"\bsame\s+", "this ", t, flags=re.I)
    t = re.sub(r"\s{2,}", " ", t).strip(" ,.;:-")
    return f"Edit this picture so it shows {t}" if t else "Edit this picture"


def _is_internal(text, desc):
    t = str(text or "").strip()
    return bool(t) and (t.lower() == str(desc or "").strip().lower() or bool(INTERNAL_RX.search(t)))


def _param_defaults(ctx, tspec, desc, sentence):
    """Tool params from the words (data: an enum of a playbook action, e.g. resize_option.shape)."""
    out, said = {}, f"{desc} {sentence or ''}".lower()
    for name, spec in (tspec.get("params") or {}).items():
        enum = (((ctx.pb.get("actions") or {}).get(spec.get("enum_of") or "") or {}).get("params") or {}).get(name, {}).get("enum")
        if enum:
            hits = [v for v in enum if any(tok.lower() in said for tok in str(v).split() if ":" in tok)]
            hits = hits or [v for v in enum if str(v).split()[0].lower() in said]
            if len(hits) == 1:
                out[name] = hits[0]
    return out


_PROMPT_RX = re.compile(r"THE\s+PROMPT\s*:?\s*[\"“]([^\"”]{8,600})[\"”]|[\"“]([^\"”]{24,600})[\"”]", re.I | re.S)


def script_prompts(script):
    """Every prompt the script has him READ ON SCREEN ("THE PROMPT: '…'", or a quoted request of 5+ words), whitespace
    normalised, in script order. Generic: any app, any video whose script quotes what is typed."""
    out = []
    for m in _PROMPT_RX.finditer(str(script or "")):
        t = " ".join((m.group(1) or m.group(2) or "").split()).strip(" —-")
        if len(t.split()) >= 5 and t not in out:
            out.append(t)
    return out


def onscreen_prompt(ctx, desc, sentence=None, window=None):
    """The script prompt this step types, when there is one: the quoted prompt that shares the most content words with
    this step's description + sentence + narration window (>= 40 % of the prompt's words). TEST v3 2026-10-10: the
    sketch → photo request ignored his on-screen prompt and invented 'a glass' — ChatGPT drew a whisky glass."""
    cands = script_prompts(getattr(ctx, "script", ""))
    if not cands:
        return None
    ctx_text = " ".join(str(x or "") for x in (desc, sentence, window))
    ctxw = set(_content_words(ctx_text))
    ctx_seq = " ".join(_content_words(ctx_text))
    best, score = None, 0.0
    for c in cands:
        cw = _content_words(c)
        if not cw:
            continue
        sc = len([w for w in cw if w in ctxw]) / len(cw)
        if len(cw) >= 4 and " ".join(cw[:4]) in ctx_seq:
            sc = max(sc, 0.9)                            # his prompt's opening words name this step
        if sc > score:
            best, score = c, sc
    return best if score >= 0.4 else None


def _content_words(text):
    stop = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "with", "this", "that", "it", "is", "for", "at", "as",
            "by", "from", "my", "your", "into", "so", "just", "then", "now", "here", "there", "be", "are", "was"}
    return [w for w in re.findall(r"[a-z0-9']+", str(text).lower()) if w not in stop and len(w) > 2]


def person_request(ctx, desc, sentence=None, window=None, tool=None, tool_spec=None, new_photo=False, typed_hint=None):
    """(A) The asset's request to the app = what the PERSON would do or type, derived by ONE cheap call from the
    internal description + the narration (sentence, ±3 sentences around it), with its LOOK. Code then checks it:
    never the internal description (else plain-words fallback), every narrated detail kept (else one retry, then his
    words go back in verbatim), no typed text for a tool that has none.
    → {"typed", "on_screen", "narrated", "as_words", "look", "expect", "params"}."""
    tspec = tool_spec or {}
    app_name = str(ctx.pb.get("name") or ctx.app)
    # his on-screen prompt makes the RESULT; a picture he BRINGS (a new input photo) is never made with it (re-run 6:
    # the b/w input was asked as "Restore this old photo…" and ChatGPT replied "please upload the old photo")
    said = None if ((tool and not (tool_spec or {}).get("typed")) or new_photo) else \
        onscreen_prompt(ctx, " ".join(x for x in (str(desc or ""), str(typed_hint or "")) if x), sentence, window)
    if said:
        # his on-screen prompt beats ANY internal prompt (the manifest's object-list prompt invented "a glass" — TEST v3)
        typed_hint = said
    look0 = "faithful" if tool else ("real" if asset_kind(desc) == "photo" else "impressive")
    quoted = re.findall(r"['\"‘“]([^'\"’”]{2,60})['\"’”]", str(desc))
    base = {"typed": typed_hint or (quoted[0] if tool and tspec.get("typed") and quoted else ""), "on_screen": False,
            "narrated": "", "as_words": typed_hint or _strip_internal(desc, app_name), "look": look0, "expect": "",
            "params": _param_defaults(ctx, tspec, desc, sentence)}
    if getattr(ctx, "llm", None) is None:
        return base
    opts = {}
    for name, spec in (tspec.get("params") or {}).items():
        enum = (((ctx.pb.get("actions") or {}).get(spec.get("enum_of") or "") or {}).get("params") or {}).get(name, {}).get("enum")
        opts[name] = enum or "free text from the narration"
    content = (f"INTERNAL description: {desc}\nTHE SENTENCE: {sentence or ''}\nNARRATION AROUND IT: {window or ''}\n"
               + (f"TOOL: the app's {tspec.get('label') or tool} — "
                  + ("he types text in it" if tspec.get("typed") else "a click, NO typed text (typed must be \"\")")
                  + f"; params: {json.dumps(opts)}\n" if tool else "")
               + ("A NEW picture (no source).\n" if new_photo else "")
               + (f"What the plan says he types: {typed_hint}\n" if typed_hint else ""))
    model = config.OVERLAY_MODEL if hasattr(config, "OVERLAY_MODEL") else config.VISION_MODEL
    msgs = [{"role": "user", "content": content}]
    out = None
    for k in range(2):
        try:
            ctx.budget.need(llm.estimate(model, PERSON_SYSTEM, msgs, 700))
            r = ctx.llm(model, PERSON_SYSTEM, None, 700, effort="low", msgs=msgs, schema=PERSON_SCHEMA,
                        stage=f"preprod.onboard.{ctx.app}", purpose="P3 person request + look (what he types)")
            ctx.budget.add(r.get("usd"))
            j = json.loads(r.get("text") or "{}")
        except Exception:  # noqa: BLE001 — the plain-words fallback
            break
        if not isinstance(j, dict) or not any(j.get(x) for x in ("typed", "as_words", "look")):
            break
        out = dict(base)
        for f_ in ("typed", "narrated", "as_words", "expect"):
            if isinstance(j.get(f_), str):
                out[f_] = j[f_].strip()
        out["on_screen"] = bool(j.get("on_screen"))
        if j.get("look") in LOOKS:
            out["look"] = j["look"]
        for kv in j.get("params") or []:
            if isinstance(kv, dict) and kv.get("key") and kv.get("value"):
                out["params"][str(kv["key"])] = str(kv["value"])
        miss = []
        if out["narrated"]:
            miss = (missing_words(out["narrated"], out["typed"]) if out["typed"] else []) \
                + missing_words(out["narrated"], out["as_words"])
        if not miss or k == 1:
            break
        msgs = msgs + [{"role": "assistant", "content": json.dumps(j)},
                       {"role": "user", "content": f"You dropped or changed narrated details: {', '.join(dict.fromkeys(miss))}. "
                                                   "Keep every one of his words exactly; only add. Answer again."}]
    if said:                                             # code, not the model, decides: his words, verbatim
        for r_ in (base, out) if out is not None else (base,):
            r_.update(typed=said, as_words=said, on_screen=True, narrated=said)
    if out is None:
        return base
    if tool and not tspec.get("typed"):
        out["typed"], out["on_screen"] = "", False
    if out["on_screen"] and out["narrated"] and missing_words(out["narrated"], out["typed"]):
        out["typed"] = out["narrated"]                         # the on-screen prompt is his, verbatim
    for f_ in ("typed", "as_words"):
        if _is_internal(out[f_], desc) and not out["on_screen"]:
            out[f_] = "" if f_ == "typed" else _strip_internal(desc, app_name)
        if out["narrated"] and out[f_] and not out["on_screen"]:
            out[f_] = keep_details(out["narrated"], out[f_])
    if not out["as_words"]:
        out["as_words"] = out["typed"] or _strip_internal(desc, app_name)
    return out


INPUTS_SYSTEM = """A video needs a picture made in an app. Decide whether that picture is honestly the app's EDIT of other
pictures (e.g. "merge these three photos: the person, the market stall, the bottle", "make my photo look like this
reference", "restore this old photo", the app's remove-background / resize / erase tool on a photo). If so, list
each SOURCE picture (visible-only description) and the instruction he types with them attached.
CONTINUITY: the video has ONE hero subject per thing (the same bottle, the same person). When the picture shows a
subject an AVAILABLE picture already shows, its source IS that available picture (reuse its id): a new shot of the
same product is an edit of the first photo ("put this exact bottle on a desk"), never a new invention. When the picture
is the very same picture as an available one (same subject, same scene, same moment), set same_as to that id.
A plain new photo of a new subject needs no inputs. JSON only."""
INPUTS_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["needs_inputs", "inputs", "instruction", "same_as"],
                 "properties": {"needs_inputs": {"type": "boolean"}, "instruction": {"type": "string"},
                                "same_as": {"type": "string"},
                                "inputs": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                      "required": ["id", "desc"],
                                                                      "properties": {"id": {"type": "string"},
                                                                                     "desc": {"type": "string"}}}}}}


_MULTI_RX = re.compile(r"\b(?:two|three|four|several|multiple|both|these)\s+(?:\w+\s+){0,2}(?:photos|images|pictures|sources|"
                       r"shots)\b|\bmerge\b|\bcombine\b|\bblend\b", re.I)


def _multi_source(text):
    """Does the narration make ONE picture out of several (a merge, three photos)? Generic wording, any app."""
    return bool(_MULTI_RX.search(str(text or "")))


def source_inputs(ctx, desc, available, tool=None):
    """Generic (any app): does this picture need source pictures made first — or is its subject one the video already
    has (the hero product)? available = {id: desc} (or ids). → {needs_inputs, inputs[{id,desc}], instruction, same_as}.
    One cheap call; without a model, or on any error: no inputs."""
    none = {"needs_inputs": False, "inputs": [], "instruction": "", "same_as": ""}
    if getattr(ctx, "llm", None) is None:
        return none
    if not isinstance(available, dict):
        available = {k: "" for k in available or []}
    av = "\n".join(f"- {k}: {v}" if v else f"- {k}" for k, v in available.items()) or "none"
    model = config.OVERLAY_MODEL if hasattr(config, "OVERLAY_MODEL") else config.VISION_MODEL
    msgs = [{"role": "user", "content": f"PICTURE: {desc}\n" + (f"It is the app's {tool} tool applied to a source picture: "
                                                                 "name exactly that one source.\n" if tool else "")
             + f"AVAILABLE pictures:\n{av}"}]
    try:
        j = {}
        for k in range(2):
            ctx.budget.need(llm.estimate(model, INPUTS_SYSTEM, msgs, 700))
            r = ctx.llm(model, INPUTS_SYSTEM, None, 700, effort="medium", msgs=msgs, schema=INPUTS_SCHEMA,
                        stage=f"preprod.onboard.{ctx.app}", purpose="P3 source pictures of a composite")
            ctx.budget.add(r.get("usd"))
            j = json.loads(r.get("text") or "{}")
            if not isinstance(j, dict):
                return none
            if not (j.get("needs_inputs") and not j.get("inputs")):
                break
            # "needs inputs" with NONE listed is not an answer (re-run 8: the merge went to a single invented picture)
            msgs = msgs + [{"role": "assistant", "content": json.dumps(j)},
                           {"role": "user", "content": "You said it needs source pictures but listed none. List EVERY "
                            "source picture by id + visible description (reuse an AVAILABLE id when it fits), and the "
                            "instruction he types with them attached."}]
        if j.get("needs_inputs") and not j.get("inputs"):
            return none                                   # still empty: not decided (a hint, if any, stands)
        return {**none, **j, "decided": True}
    except Exception:  # noqa: BLE001 — treated as a plain picture
        return none


IMAGE_SYSTEM = """A video narration describes a picture he shows (a photo he brings, a result). Rewrite it as ONE image
prompt that describes only what is VISIBLE in the picture: the subject, the setting, the light, the style. Drop fillers
("uh"), what he does with it ("I drag it into the chat"), and anything about the video. Keep every concrete detail he
says. Answer with the JSON only."""
IMAGE_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["prompt"],
                "properties": {"prompt": {"type": "string"}}}


def image_prompt(ctx, desc):
    """The narrated description of an asset → a clean, visible-only image prompt (one cheap call). Falls back to the
    description with the obvious fillers stripped when there is no model."""
    text = re.sub(r"^.*?:\s*", "", str(desc or ""), count=1) if ":" in str(desc or "")[:60] else str(desc or "")
    text = re.sub(r"\b(?:uh|um|erm)\b,?\s*", "", text, flags=re.I).strip()
    # what HE does with the picture is not in the picture ("I just drag it into a normal chat")
    keep = [x for x in re.split(r"(?<=[.!?])\s+", text)
            if x and not re.match(r"(?:and\s+)?(?:I|I'm|I'll|we|you|then|so)\b", x.strip(), re.I)
            and not re.search(r"\b(?:drag|drop|upload|paste|chat|video|click|type)\w*\b", x, re.I)]
    text = " ".join(keep).strip() or text
    if getattr(ctx, "llm", None) is None:
        return text
    model = config.OVERLAY_MODEL if hasattr(config, "OVERLAY_MODEL") else config.VISION_MODEL
    msgs = [{"role": "user", "content": f"Narration: {desc}"}]
    try:
        ctx.budget.need(llm.estimate(model, IMAGE_SYSTEM, msgs, 400))
        r = ctx.llm(model, IMAGE_SYSTEM, None, 400, effort="low", msgs=msgs, schema=IMAGE_SCHEMA,
                    stage=f"preprod.onboard.{ctx.app}", purpose="P3 image prompt from the narration")
        ctx.budget.add(r.get("usd"))
        return str(json.loads(r.get("text") or "{}").get("prompt") or text)
    except Exception:  # noqa: BLE001 — the stripped description still works
        return text


PLAIN_SYSTEM = """A video narration names a feature an app does not have (e.g. a '/newbg rustic kitchen' command). Read the
NARRATION AROUND IT and decide what the feature does in the video:
- result_kind "image": it produces a PICTURE he shows (e.g. /newbg → the photo with a new background). Then write the
  equivalent request in PLAIN WORDS the app can really do ("Replace the background of this photo with a rustic
  kitchen") and what the result must visibly show.
- result_kind "ui_state": it opens or changes the app's INTERFACE (a blank canvas he draws on, a menu, a badge, a
  counter, a picker). Nothing is generated; prompt "". If a picture appears inside that UI (his doodle on the canvas),
  name the AVAILABLE picture that is it in uses_asset.
- result_kind "none": nothing to show.
RULE: every concrete detail he says (rustic, golden hour, charred, 9:16, a quoted name) is kept EXACTLY — you may only
ADD what makes the app do it, never substitute. narrated = his request words verbatim. look: "real" | "impressive" |
"faithful" (see: an input he brings / a showcase result / an honest tool result). Answer with the JSON only."""
PLAIN_SCHEMA = {"type": "object", "additionalProperties": False,
                "required": ["result_kind", "prompt", "expect", "narrated", "look", "uses_asset"],
                "properties": {"result_kind": {"type": "string", "enum": ["image", "ui_state", "none"]},
                               "prompt": {"type": "string"}, "expect": {"type": "string"},
                               "narrated": {"type": "string"}, "look": {"type": "string", "enum": list(LOOKS)},
                               "uses_asset": {"type": "string"}}}


def plain_request(ctx, feature, text, sentence, window="", available=()):
    """The feature he names → what it produces in the video (result_kind: image | ui_state | none, read from the
    narration ±3 sentences) and, for an image, a plain-words request the app can do + what it must show — every detail
    he narrates kept (checked; one retry; then his words go back in). TEST v3: 'Sketch' (a blank canvas he draws on)
    was misread as "turn the photo into a pencil sketch" and two generations were wasted; /newbg's "rustic kitchen"
    became "a bright, modern kitchen".
    → {"result_kind", "prompt", "expect", "narrated", "look", "uses_asset"}"""
    content = (f"Feature: {feature}\nWhat he types/says: {text}\nThe sentence: {sentence}\n"
               f"NARRATION AROUND IT: {window or sentence}\nAVAILABLE pictures: {', '.join(available) or 'none'}")
    model = config.OVERLAY_MODEL if hasattr(config, "OVERLAY_MODEL") else config.VISION_MODEL
    msgs = [{"role": "user", "content": content}]
    narrated0 = str(text or "")
    out = {"result_kind": "image", "prompt": str(text or feature), "expect": str(text or feature), "narrated": narrated0,
           "look": "impressive", "uses_asset": ""}
    for k in range(2):
        ctx.budget.need(llm.estimate(model, PLAIN_SYSTEM, msgs, 600))
        r = ctx.llm(model, PLAIN_SYSTEM, None, 600, effort="low", msgs=msgs, schema=PLAIN_SCHEMA,
                    stage=f"preprod.onboard.{ctx.app}", purpose="P4 plain-words request (real result)")
        ctx.budget.add(r.get("usd"))
        try:
            j = json.loads(r.get("text") or "{}")
        except ValueError:
            break
        if not isinstance(j, dict):
            break
        out = {"result_kind": j.get("result_kind") if j.get("result_kind") in ("image", "ui_state", "none") else "image",
               "prompt": str(j.get("prompt") or text), "expect": str(j.get("expect") or text),
               "narrated": str(j.get("narrated") or narrated0), "look": j.get("look") if j.get("look") in LOOKS else "impressive",
               "uses_asset": str(j.get("uses_asset") or "")}
        if out["result_kind"] != "image":
            out["prompt"] = ""
            break
        miss = missing_words(out["narrated"], out["prompt"]) + missing_words(narrated0, out["prompt"])
        if not miss or k == 1:
            break
        msgs = msgs + [{"role": "assistant", "content": json.dumps(j)},
                       {"role": "user", "content": f"You dropped or changed what he says: {', '.join(dict.fromkeys(miss))}. "
                                                   "Keep every one of his words exactly; only add. Answer again."}]
    if out["result_kind"] == "image":
        for nar in (out["narrated"], narrated0):
            if nar and missing_words(nar, out["prompt"]):
                out["prompt"] = keep_details(nar, out["prompt"])
    if out["uses_asset"] and out["uses_asset"] not in available:
        out["uses_asset"] = ""
    return out


def window_of(video, wid, k=3):
    """The narration around a word: its sentence ± k sentences (what the feature / picture is, in context)."""
    from . import planfit
    ss = planfit.sentences(video["words"])
    i = next((n for n, s in enumerate(ss) if any(w["i"] == wid for w in s)), None)
    if i is None:
        return ""
    return " ".join(" ".join(w["word"] for w in s) for s in ss[max(0, i - k): i + k + 1])


# ────────────────────────────── P4: the app's UI kit, per video ──────────────────────────────

def ensure_kit(ctx):
    """THIS video's UI kit: job/preprod/ui-kits/<app>/kit.json. The shared skill kit is the starting hint (copied);
    an app with no kit gets a CAPTURE scheduled first (ctx.kit_capture: live DOM + computed styles + icons + screenshot
    through a Scout profile copy, or the outside Chrome for a public app; privacy rules C7). Only when a capture truly
    fails: the neutral box, logged. → {"app", "dir", "status": copied|captured|existing|neutral, "note"}"""
    from . import uikits
    base = Path(ctx.out) / "ui-kits"
    mine = base / ctx.kit_app / "kit.json"
    if mine.exists():
        return {"app": ctx.kit_app, "dir": str(mine.parent), "status": "existing", "note": "this video's kit"}
    shared = uikits.root() / ctx.kit_app
    if (shared / "kit.json").exists():
        import shutil
        shutil.copytree(shared, mine.parent, dirs_exist_ok=True)
        d = json.loads(mine.read_text())
        d["per_video"] = {"from": f"skill ui-kits/{ctx.kit_app} (hint)", "job": Path(ctx.out).parent.name}
        mine.write_text(json.dumps(d, indent=1, ensure_ascii=False))
        return {"app": ctx.kit_app, "dir": str(mine.parent), "status": "copied", "note": "shared kit copied as the hint"}
    ctx.log(f"P4: no UI kit for {ctx.kit_app} — capture scheduled first (live DOM, Scout profile copy, C7)")
    row = {"app": ctx.kit_app, "dir": None, "status": "capture_scheduled", "note": "no kit: capture scheduled"}
    if ctx.kit_capture is not None:
        try:
            p = ctx.kit_capture(ctx.kit_app, mine.parent, ctx.site_url)
            if p and Path(p).exists():
                uikits.load(ctx.kit_app, base)            # validated + privacy-screened (C7) or KitError
                return {**row, "dir": str(mine.parent), "status": "captured", "note": "captured live for this video"}
            row["note"] = "capture made no kit"
        except Exception as e:  # noqa: BLE001
            row["note"] = f"capture failed: {e}"[:300]
    row["status"] = "neutral"
    ctx.log(f"P4: {ctx.kit_app} kit could not be captured ({row['note']}) — the neutral box")
    return row


# ────────────────────────────── the router ──────────────────────────────

class Ctx:
    """What routing needs. Live defaults are wired by preprod (make_ctx); tests hand in fakes."""

    def __init__(self, out, app, site_url, pb, transport_factory=None, llm_call=None, image_api=None, in_app=None,
                 check=None, spacer=None, kit_capture=None, readiness=None, budget=None, image_chat=None,
                 asset_files=None, log=None, kit_app=None, allowed_chats=(), status=None, cancelled=None,
                 producer=False):
        from . import preprod
        self.out, self.app, self.site_url, self.pb = Path(out), app, site_url, pb
        self.transport_factory = transport_factory
        self.llm = llm_call or llm.messages
        self.image_api = image_api or (lambda prompt, dst, q: preprod.gen_photo(prompt, dst, quality=q))
        self.in_app = in_app
        self.check = check or (lambda a, f, objs: preprod.gen_check(a, f, objs))
        self.spacer = spacer or preprod.Spacer(float(onboarding_rules().get("generation_spacing_s", config.GEN_SPACING_S)))
        self.kit_capture = kit_capture
        self.readiness = readiness or {}
        self.budget = budget or Budget()
        self.image_chat = image_chat
        self.asset_files = dict(asset_files or {})
        self.asset_descs = {}                              # id → description (the source picker's AVAILABLE list)
        self.asset_chats = {}                              # id → {"chat", "nth"}: where this job's producer made it
        self.locate = None                                 # (image, target) → [x0, y0, x1, y1] fractions (vision)
        self.log = log or (lambda m: None)
        self.kit_app = kit_app or app
        self.allowed_chats = set(allowed_chats or ())
        if image_chat:
            self.allowed_chats.add(image_chat)
        self.status = status or (lambda m: None)
        self.cancelled = cancelled or (lambda: False)
        self.tally = (0, 1)                               # (assets ready, assets needed) for the status line
        self.producer = None
        if producer:
            from . import producer as prod
            self.producer = prod.Producer(self) if producer is True else producer

    def check_cancel(self):
        if self.cancelled():
            raise InterruptedError("cancelled")

    def guarded(self, allow_generate=False):
        return Guarded(self.transport_factory(), self.pb, self.allowed_chats, allow_generate, self.spacer, self.log)

    IMAGE_NEED = re.compile(r"\b(image|photo|picture|viewer|markup|comment|erase|pin|brush|toolbar|regenerate|download)\b", re.I)
    STARTER_PROMPT = "Create an image: a single glass bottle of hot sauce on a plain wooden table, soft daylight, realistic photo"

    def start_url(self, need):
        if self.IMAGE_NEED.search(need):
            if not self.image_chat and self.in_app is not None:
                # a chat with an image that THIS job owns (one generation, spaced) — never one of Jake's chats
                self.spacer.wait()
                dst = self.out / "assets" / "onboard_start.png"
                dst.parent.mkdir(parents=True, exist_ok=True)
                try:
                    r = self.in_app({"id": "onboard_start", "prompt": self.STARTER_PROMPT}, dst, [])
                except Exception as e:  # noqa: BLE001
                    r = None
                    self.log(f"onboarding: the start chat could not be made ({e})")
                if r and r.get("chat_url"):
                    self.image_chat = r["chat_url"]
                    self.allowed_chats.add(r["chat_url"])
            if self.image_chat:
                return self.image_chat
        return self.pb["start_state"]["url"]


def _beats(answer):
    for si, s in enumerate(answer.get("segments") or []):
        for bt in s.get("beats") or []:
            yield si, s, bt


def _sentence_ids(video, wid):
    from . import planfit
    for s in planfit.sentences(video["words"]):
        if any(w["i"] == wid for w in s):
            return s[0]["i"], s[-1]["i"], " ".join(w["word"] for w in s)
    return wid, wid, ""


def _prior_asset(answer, wid, pos, usable):
    """The picture shown just before this word (the photo a command acts on)."""
    best = None
    for _, _, bt in _beats(answer):
        a = bt.get("asset_id") or (str(bt.get("subject", ""))[6:] if str(bt.get("subject", "")).startswith("asset:") else None)
        if a and a in usable and pos.get(bt.get("word_id"), 1e9) <= pos.get(wid, -1):
            best = a
    return best


STROKE_RX = re.compile(r"\b(?:draw|drew|drawing|doodle|scribble|pick the pen|start a stroke|pen stroke|brush(?:es)? over|"
                       r"highlight(?:s|ed)? (?:the|over)|drag (?:a )?box|box over|circle (?:the|around))\b", re.I)
MODE_RX = re.compile(r"\b(markup|erase|eraser|comment|sketch|canvas|whiteboard|paint)\b", re.I)


def stroke_need(need):
    """A P2 need that is a STROKE (draw a shape on a canvas, box a region in Markup, brush a region in Erase) →
    {"key", "surface", "how", "target", "onboard", "params"}, else None. TEST v3 22:01: "draw a squat bottle" was
    onboarded as its own action and the explorer improvised one straight drag (3 rounds, 3/3 never passed). The tool
    + the surface are onboarded ONCE; the strokes are data (the doodle asset's shapes / the target's region)."""
    n = str(need or "")
    if not STROKE_RX.search(n):
        return None
    if re.search(r"\b(?:click|press|tap|submit|send|type|paste|download)\b", n, re.I) and \
            not re.search(r"\b(?:draw|drew|brush|drag|pen|stroke)\b", n, re.I):
        return None                                        # a click on the canvas UI (the check mark), not a stroke
    m = MODE_RX.search(n)
    mode = (m.group(1).lower() if m else "image").replace("eraser", "erase")
    canvas = mode in ("sketch", "canvas", "whiteboard", "paint") or (re.search(r"\b(?:draw|drew|doodle|pen)\b", n, re.I)
                                                                   and not re.search(r"\b(?:photo|image|viewer)\b", n, re.I))
    tm = re.search(r"\b(?:over|around|on)\s+((?:the|a|an)\s+[^,;.]{2,60}?)(?:\s+(?:so|to|in|as|and|that|then|next|beside|near|by|with)\b|[,;.]|$)", n, re.I)
    target = tm.group(1).strip() if tm and not canvas else ""
    if canvas:
        where = f"the {mode} canvas" if mode not in ("image",) else "the drawing canvas"
        return {"key": "stroke:canvas:draw", "surface": where, "how": "draw", "target": "",
                "params": {"strokes": [[[420, 512], [520, 470], [610, 520]]], "space": 1024},
                "onboard": (f"THE STROKE TOOL on {where} (context: {n[:160]}). Get to the drawing surface, pick the pen, "
                            "and propose ONE action of kind 'draw' whose selector is the drawing surface. Its strokes are "
                            "DATA supplied at record time (the doodle's shapes, scaled to the surface): never draw or "
                            "invent a shape. Prove it with ONE short test stroke (params strokes / space as given); the "
                            "post assert must show the stroke landed. Then undo or close; never submit.")}
    how = "box" if re.search(r"\bbox\b|\bcircle\b", n, re.I) else "brush"
    return {"key": f"stroke:{mode}:{how}", "surface": f"the picture in the {mode} mode", "how": how, "target": target,
            "params": {"rel_from": [0.42, 0.45], "rel_to": [0.58, 0.55]},
            "onboard": (f"THE {mode.upper()} STROKE on the picture in the image viewer (context: {n[:160]}). Get to the "
                        f"{mode} mode and propose ONE action of kind 'drag' on the viewer image's selector with params "
                        "rel_from / rel_to (fractions of the image box). The region is DATA supplied at record time (where "
                        "the target is in the picture): never choose it yourself. Prove it with the test drag given in the "
                        "params; the post assert must show the selection landed. Never send.")}


def bind_stroke(ctx, bt, sk, image_asset=None):
    """The data of one stroke beat: the doodle shape it draws (beatscript binds that shape's strokes from the sketch
    asset, scaled to the canvas), or the target's region in the picture (vision: ctx.locate) as rel_from / rel_to."""
    from . import beatscript
    if sk["how"] == "draw":
        # the shape DRAWN is the first one named ("a picnic table under the bottle" draws the table)
        t = " " + beatscript.norm(str(bt.get("need") or bt.get("body") or "")) + " "
        hits = [(m.start(), shp) for w, shp in beatscript.SHAPES for m in [re.search(rf" {re.escape(w)}s? ", t)] if m]
        shape = min(hits)[1] if hits else None
        if shape:
            bt["subject"] = f"shape:{shape}"
        return bt
    target = sk.get("target") or ""
    f = ctx.asset_files.get(image_asset) if image_asset else None
    box = None
    if target and f and callable(getattr(ctx, "locate", None)):
        try:
            box = ctx.locate(f, target)
        except Exception as e:  # noqa: BLE001 — the beat keeps the proven default
            ctx.log(f"P2: could not locate '{target}' in {image_asset}: {e}")
    if box and len(box) == 4:
        x0, y0, x1, y1 = [max(0.0, min(1.0, float(v))) for v in box]
        params = ({"rel_from": [x0, y0], "rel_to": [x1, y1]} if sk["how"] == "box"
                  else {"rel_from": [x0, (y0 + y1) / 2], "rel_to": [x1, (y0 + y1) / 2]})
        bt["params"] = {**(bt.get("params") or {}), **params}
        bt["region"] = {"target": target, "in": image_asset, "box": [x0, y0, x1, y1]}
    return bt


def route(ctx, pdoc, video, sites, assets, facts_fn, held_reasons=None):
    """Fill every need of the plan (P2/P3/P4, D is code) and check the patched plan again with THIS video's playbook.
    pdoc = preprod/plan.json ({"plan": director.plan() output incl. "answer", "raw"}); assets = assets.json (updated
    in place with what P3/P4 produced); facts_fn(assets) → planfit.Facts.
    → {"plan", "raw", "needs": [rows with group/route/status], "held": [genuine failures], "warnings", "usd"}"""
    plan = pdoc["plan"]
    answer = copy.deepcopy(plan.get("answer") or {})
    if not answer:
        return {"plan": plan, "raw": pdoc.get("raw"), "needs": [], "held": [], "warnings": ["no answer to route"],
                "usd": 0.0}
    pos = {w["i"]: n for n, w in enumerate(video["words"])}
    rows = list(plan.get("needs_primitive") or [])
    report = needs_report(rows)
    done, held, warnings, p4 = [], [], list(plan.get("warnings") or []), []
    t0_usd = ctx.budget.spent
    by_asset = {a["id"]: a for a in assets.get("assets", [])}
    usable = {k for k, a in by_asset.items() if a.get("status") in ("ready", "pending_in_app")}
    ctx.asset_files.update({k: a["file"] for k, a in by_asset.items() if a.get("file")})
    # every picture an earlier run of THIS job already made and checked (incl. sources a merge made: person, stall) is
    # known to the source step, so it is reused, never made again under a new name (re-run 10: person_portrait existed,
    # the source step named a new 'person_photo' and generated it again)
    for side in sorted((Path(ctx.out) / "assets").glob("*.produced.json")):
        try:
            row_ = json.loads(side.read_text())
        except (OSError, ValueError):
            continue
        if row_.get("status") == "ready" and Path(row_.get("file") or "").exists() and side.name.split(".")[0] not in ctx.asset_files:
            _remember(ctx, side.name.split(".")[0], row_)
    for k, a in by_asset.items():
        if a.get("file") and a.get("status") == "ready":
            _remember(ctx, k, a) if str((a.get("source") or {}).get("type", "")).startswith("in-app generation") \
                else ctx.asset_descs.setdefault(k, str(a.get("desc") or "")[:200])

    # assets the manifest could not make (or left to the dry run) are needs too — retried and re-routed (P3), never
    # silently dropped (the old go_with_fallbacks path)
    for a in list(assets.get("assets", [])):
        made_here = str((a.get("source") or {}).get("type", "")).startswith("in-app generation")
        side_ = Path(ctx.out) / "assets" / f"{a['id']}.produced.json"
        if a.get("status") == "ready" and made_here and not side_.exists():
            a["status"] = "needs_asset"                   # its .produced.json was removed: a redo, never resurrected
            ctx.log(f"{a['id']}: marked for a redo (no stored check) — made again")
        if a.get("status") in ("missing", "needs_asset") or (a.get("status") == "pending_in_app" and ctx.in_app):
            assets["assets"].remove(a)
            by_asset.pop(a["id"], None)
            usable.discard(a["id"])
            report["B"].insert(0, {"group": "B", "code": "asset", "why": f"asset '{a['id']}' is {a.get('status')}",
                                   "need": a.get("desc"), "proposed": {"asset_id": a["id"], "desc": a.get("prompt") or a.get("desc"),
                                                                       "made_from": a.get("made_from") or []}})

    def note(r, route_, status, **kw):
        done.append({**{k: r.get(k) for k in ("group", "code", "kind", "why", "sentence", "word_ids", "need")},
                     "route": route_, "status": status, **kw})

    # ── B (P3) first: the pictures the other routes act on ──
    def _aid_of(r):
        pr_ = r.get("proposed") if isinstance(r.get("proposed"), dict) else {}
        m_ = re.search(r"asset '([\w-]+)'", str(r.get("why")))
        return pr_.get("asset_id") or (m_.group(1) if m_ else None) or str(r.get("need") or r.get("sentence") or "")[:60]
    # the plan names an asset once per beat that shows it: count and make each asset ONCE (TEST v3: 45 rows, ~15 assets)
    n_need = len(usable | {_aid_of(r) for r in report["B"]})
    failed = {}
    for r in report["B"]:
        ctx.check_cancel()
        ctx.tally = (len([a for a in usable if (by_asset.get(a) or {}).get("status") == "ready"]), max(1, n_need))
        pr = r.get("proposed") if isinstance(r.get("proposed"), dict) else {}
        aid = pr.get("asset_id")
        desc = pr.get("desc") or r.get("need")
        if not aid:
            m = re.search(r"asset '([\w-]+)'", str(r.get("why")))
            aid = m.group(1) if m else re.sub(r"[^a-z0-9]+", "_", str(desc or r.get("sentence") or "asset").lower())[:24].strip("_")
        if not desc:
            desc = (re.sub(r"^.*?—\s*", "", str(r.get("why")))[:200] + " — as he says: " + str(r.get("sentence") or ""))[:300]
        if aid in usable:
            note(r, "P3", "already produced", asset=aid)
            continue
        if aid in failed:                                  # already tried with every route: not again per beat
            note(r, "P3", "failed", asset=aid, why2=failed[aid])
            continue
        made_from = [m for m in pr.get("made_from") or [] if m in usable]
        hint = None
        if not made_from and asset_kind(desc) == "app_generation":
            # the picture shown just before is only a HINT: the source step decides (re-run 5: the great-grandma restore
            # was run on the hot-sauce photo because the nearest earlier picture was taken as its source)
            hint = _prior_asset(answer, pr.get("word_id") or (r.get("word_ids") or [None])[0], pos, usable)
        wid0 = pr.get("word_id") or (r.get("word_ids") or [None])[0]
        row = produce_asset(ctx, aid, desc, made_from, sentence=r.get("sentence"),
                            window=window_of(video, wid0) if wid0 is not None else r.get("sentence"), source_hint=hint)
        if row["status"] == "not_a_picture":            # a camera move / framing: the edit's job (D), not the app's
            note(r, "D", "not a picture — camera / framing in the edit (no generation)", asset=aid, why2=row.get("why"))
            continue
        assets.setdefault("assets", []).append(row)
        by_asset[aid] = row
        if row["status"] == "ready":
            usable.add(aid)
            note(r, "P3", "produced", asset=aid, producer=row["kind"])
        else:
            failed[aid] = row.get("why")
            held.append({"reason": "asset_failed", "detail": f"{aid}: {row.get('why')}"[:300]})
            note(r, "P3", "failed", asset=aid, why2=row.get("why"))

    # ── C (P4): verify absence, then motion graphics with a REAL result ──
    kit = {}
    pending_a = list(report["A"])

    def handle_c(r, allow_a=True):
            pr = r.get("proposed") if isinstance(r.get("proposed"), dict) else {}
            wid = pr.get("word_id") or (r.get("word_ids") or [None])[0]
            feature = pr.get("need") or r.get("need") or re.sub(r"\s+—.*$", "", str(r.get("why")))[:120]
            text = pr.get("text") or (re.search(r"(/[\w-]+(?: [\w ]{1,40})?)", str(r.get("sentence") or "")) or [None])[0] \
                or feature
            v = verify_feature(ctx, feature, text)
            if not v["absent"] and allow_a:
                pending_a.append({**r, "group": "A", "need": f"use the feature '{feature}' as he says: {text}",
                                  "verified_present": v})
                note(r, "P4→P2", "present after verification — onboarded as an action", verify=v)
                return
            if not kit:
                kit.update(ensure_kit(ctx))
            a, b, sentence = _sentence_ids(video, wid) if wid is not None else (None, None, r.get("sentence"))
            res_id = f"p4_{re.sub(r'[^a-z0-9]+', '_', str(text).lower()).strip('_')[:20]}"
            win = window_of(video, wid) if wid is not None else sentence
            try:
                req = plain_request(ctx, feature, text, sentence, win, sorted(usable))
            except BudgetSpent as e:
                req = {"result_kind": "image", "prompt": str(text), "expect": str(text), "look": "impressive",
                       "uses_asset": "", "narrated": str(text)}
                warnings.append(str(e))
            prior = _prior_asset(answer, wid, pos, usable) if wid is not None else None
            if req.get("result_kind") != "image":
                # the feature changes the app's UI (a canvas, a menu, a badge): shown from the UI kit, NO generation;
                # a picture inside it (his doodle on the canvas) is an asset the video already has
                res_id = req.get("uses_asset") or None
                how = f"{req.get('result_kind')} — the app's UI from the kit" + (f", with '{res_id}' in it" if res_id else "")
                ctx.log(f"feature {feature}: {req.get('result_kind')} (from the narration around it) — no generation")
            else:
                res = produce_asset(ctx, res_id, req["expect"], [prior] if prior else [], prompt=req["prompt"],
                                    sentence=sentence, window=win, look=req.get("look"))
                if res["status"] == "not_a_picture":
                    note(r, "D", "not a picture — camera / framing in the edit (no generation)", verify=v)
                    return
                res["kind"] = res["kind"] if res["status"] == "ready" else "app_generation"
                res["for"] = "R14 P4"
                assets.setdefault("assets", []).append(res)
                if res["status"] != "ready":
                    held.append({"reason": "p4_result_failed", "detail": f"feature {feature}: the real result could not be made "
                                                                          f"({res.get('why')})"[:300]})
                    note(r, "P4", "failed: no real result", verify=v)
                    return
                usable.add(res_id)
                how = f"{res['kind']} — \"{req['prompt'][:120]}\"" + (f" on {prior}" if prior else "")
            if a is None:
                warnings.append(f"P4 {feature}: no words to place it on")
                note(r, "P4", "no window", verify=v)
                return
            from . import director as D
            tid = D.p4_template(text)
            phrases = [str(text)[:70]]
            prompt = str(text) if len(str(text)) >= 8 else f"{text} "
            if tid == "long_prompt_scroll" and len(prompt) < 200:
                tid = "prompt_highlight"
            p4.append({"start": a, "end": b, "template": tid, "feature": feature, "verified": v["searched"][:6],
                       "result_asset": res_id if req.get("result_kind", "image") == "image" else None,
                       "ui_asset": res_id if req.get("result_kind", "image") != "image" else None,
                       "how": how, "result_kind": req.get("result_kind", "image"), "kit_dir": (kit or {}).get("dir"),
                       "fields": {"prompt": prompt[:440].ljust(8), "phrases": phrases, "app": ctx.kit_app}})
            # the beat that asked for it leaves the screencast (no fake screencast of a missing feature)
            for si, s, bt in list(_beats(answer)):
                if bt.get("word_id") == wid and bt.get("action") == director.MOTION_FEATURE:
                    s["beats"].remove(bt)
            answer["needs_primitive"] = [x for x in answer.get("needs_primitive") or [] if not
                                         (x.get("word_ids") and wid in x.get("word_ids"))]
            ctx.log(f"feature {feature} not in {ctx.app} (verified) — shown working via motion graphics; the result is real, "
                    f"made with {how}")
            note(r, "P4", "motion graphics", verify=v, template=tid, result=res_id, how=how, kit=(kit or {}).get("status"))


    for r in report["C"]:
        ctx.check_cancel()
        handle_c(r)

    # ── A (P2): onboard every missing action, once per distinct need ──
    seen = {}
    for r in pending_a:
        ctx.check_cancel()
        pr = r.get("proposed") if isinstance(r.get("proposed"), dict) else {}
        need = pr.get("need") or r.get("need") or str(r.get("why"))
        # a draw / markup box / erase brush is ONE stroke tool per surface, onboarded once; the shapes are DATA
        sk = stroke_need(need)
        key = sk["key"] if sk else re.sub(r"\W+", " ", need.lower()).strip()[:120]
        if key not in seen:
            try:
                if sk:
                    ctx.log(f"P2: '{need[:60]}' is a stroke on {sk['surface']} — onboarding the stroke tool once ({sk['key']}); "
                            "the strokes are data")
                    seen[key] = onboard_action(ctx, sk["onboard"], sk["params"])
                else:
                    seen[key] = onboard_action(ctx, need, {"text": pr.get("text")} if pr.get("text") else None)
            except BudgetSpent as e:
                seen[key] = {"status": "failed", "why": str(e), "budget": True}
        res = seen[key]
        wid = pr.get("word_id") or (r.get("word_ids") or [None])[0]
        if res.get("status") == "proven":
            aid = res["action_id"]
            hit = False
            for _, s, bt in _beats(answer):
                if bt.get("action") == director.ONBOARD_ACTION and (bt.get("word_id") == wid or
                                                                    (bt.get("need") or "") == need):
                    bt["action"] = aid
                    if sk:
                        bind_stroke(ctx, bt, sk, _prior_asset(answer, bt.get("word_id"), pos, usable))
                    hit = True
            if not hit and wid is not None:
                seg = next((s for s in answer.get("segments") or [] if pos.get(s["start_word"], 1e9) <= pos.get(wid, -1)
                            <= pos.get(s["end_word"], -1)), None)
                bt = {"word_id": wid, "action": aid, "body": need[:140], "subject": "screen", "text": pr.get("text"),
                      "url": None, "asset_id": None, "live": False, "wait_end_word": None}
                if sk:
                    bind_stroke(ctx, bt, sk, _prior_asset(answer, wid, pos, usable))
                if seg is None:
                    a, b, _ = _sentence_ids(video, wid)
                    seg = {"start_word": a, "end_word": b, "app": ctx.app, "session": "logged_in", "beats": []}
                    answer.setdefault("segments", []).append(seg)
                    answer["segments"].sort(key=lambda s: pos.get(s["start_word"], 1e9))
                seg["beats"] = sorted(seg["beats"] + [bt], key=lambda x: pos.get(x["word_id"], 1e9))
            answer["needs_primitive"] = [x for x in answer.get("needs_primitive") or [] if not
                                         (wid is not None and x.get("word_ids") and wid in x["word_ids"])]
            note(r, "P2", "onboarded + proven 3/3", action=aid)
        elif res.get("status") == "absent":
            # the explorer found no such control anywhere: P4 (motion graphics with a real result) next round
            note(r, "P2→P4", "absent after exploration", why2=res.get("why"))
            warnings.append(f"'{need[:80]}': absent after exploration — shown as motion graphics on the next pass")
            handle_c({**r, "group": "C", "need": need}, allow_a=False)
        else:
            held.append({"reason": "onboarding_failed", "detail": f"'{need[:120]}': {res.get('why')}"[:300]})
            note(r, "P2", "failed", why2=res.get("why"))

    # ── D: code fixed them in planfit (R14 D); what is left is a warning for the edit's structure gate ──
    for r in report["D"]:
        note(r, "D", "code fix (planfit) / warning")

    # the actions this video uses, re-proven for THIS video (the shared playbook is only a hint)
    used = sorted({bt["action"] for _, _, bt in _beats(answer)
                   if bt.get("action") in ctx.pb["actions"] and not str(bt["action"]).startswith("ob_")})
    try:
        rep = reprove_existing(ctx, used, {bt["action"]: {"text": bt.get("text")} for _, _, bt in _beats(answer)
                                           if bt.get("text")})
    except BudgetSpent as e:
        rep = {}
        warnings.append(str(e))
    for aid, x in rep.items():
        if not x.get("ok"):
            held.append({"reason": "onboarding_failed", "detail": f"{aid} does not replay for this video: {x.get('why')}"[:300]})

    # leftover needs pseudo-beats (a route failed): never recorded — the hold above names why
    for _, s, bt in list(_beats(answer)):
        if bt.get("action") in director.NEED_ACTIONS:
            s["beats"].remove(bt)
    facts = facts_fn(assets)
    pbs = {ctx.app: ctx.pb}
    new_plan, raw = director.recheck(answer, video, sites, facts, playbooks=pbs,
                                     overlays=(pdoc.get("raw") or {}).get("overlays") or [], p4=p4)
    left = needs_report(new_plan.get("needs_primitive") or [])
    for g in ("A", "B", "C"):
        for r in left[g]:
            if not any(h["detail"].startswith(str(r.get("why"))[:40]) for h in held):
                warnings.append(f"after routing, still open ({GROUP_NAME[g]}): {str(r.get('why'))[:200]}")
    for r in left["D"]:
        warnings.append(f"D (structure gate decides): {str(r.get('why'))[:200]}")
    new_plan["needs_primitive"] = []          # R14: never a hold by itself — the routes' genuine failures are in held
    new_plan["held"] = bool(held)
    new_plan["routing"] = {"needs": done, "warnings": warnings, "p4": p4}
    return {"plan": new_plan, "raw": raw, "needs": done, "held": held, "warnings": warnings, "p4": p4,
            "usd": round(ctx.budget.spent - t0_usd, 4), "report": {g: len(v) for g, v in report.items() if g in GROUPS}}


# ────────────────────────────── P4: a live UI-kit capture for an app with none ──────────────────────────────

KIT_JS = r"""
const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 20; };
const ed = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(vis);
if (!ed) return { error: "no composer on the page" };
let box = ed;
for (let i = 0; i < 6 && box.parentElement; i++) {
  const p = box.parentElement, r = p.getBoundingClientRect();
  if (r.width > 900 || r.height > 400) break;
  box = p;
}
const PROPS = ["display","position","box-sizing","width","height","min-height","padding","margin","border","border-radius",
  "background-color","background","color","font-family","font-size","font-weight","line-height","letter-spacing","gap",
  "align-items","justify-content","flex-direction","grid-template-columns","box-shadow","opacity","overflow"];
const clone = box.cloneNode(true);
const src = [box, ...box.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
src.forEach((s, i) => { const cs = getComputedStyle(s); const d = dst[i];
  d.setAttribute("style", PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  for (const a of [...d.attributes]) if (!["style","viewBox","d","fill","stroke","stroke-width","xmlns","width","height","points","transform"].includes(a.name)) d.removeAttribute(a.name);
  if (s === ed) { d.textContent = "{{prompt}}"; d.setAttribute("data-kit", "prompt"); }
  else if (!d.children.length && d.textContent && d.textContent.length > 40) d.textContent = "";
});
const r = box.getBoundingClientRect();
return { width: Math.round(r.width), height: Math.round(r.height), html: clone.outerHTML,
         placeholder: (ed.getAttribute("placeholder") || ed.getAttribute("aria-label") || ed.dataset.placeholder || "").slice(0, 60),
         box: [r.x, r.y, r.width, r.height], dark: matchMedia("(prefers-color-scheme: dark)").matches };
"""


def capture_kit_live(app, dst, site_url, profile=None, timeout=240):
    """A minimal live UI kit (composer: DOM + computed styles, a screenshot) through the kit-capture driver
    (ui-kits/_tools/cap.mjs, read only), a COPY of the Scout profile (logged-in apps) or no profile (public pages).
    Enter is never pressed there; the kit is privacy-screened by uikits.load (C7). → kit.json path | None."""
    import shutil
    import subprocess
    import uuid
    from . import agentrec, uikits
    dst = Path(dst)
    w = dst.parent / f".cap-{uuid.uuid4().hex[:6]}"
    (w / "q").mkdir(parents=True)
    (w / "js").mkdir()
    (w / "js" / "kit.js").write_text(KIT_JS)
    prof = None
    if profile:
        prof = w / "profile"
        shutil.copytree(profile, prof, symlinks=True, ignore=shutil.ignore_patterns("Singleton*", "*.lock"))
    tools = uikits.root() / "_tools"
    name = f"aieditor-kitcap-{uuid.uuid4().hex[:6]}"
    cmd = ["docker", "run", "--rm", "--name", name, "--cpuset-cpus", config.CPUSET, "--shm-size", "1g", "-v", f"{w}:/w",
           "-v", f"{tools}:/k:ro", "-v", f"{config.CODE / 'screencast'}:/app/screencast:ro"] + \
          (["-v", f"{prof}:/prof"] if prof else []) + [agentrec.SC_IMAGE, "node", "/k/cap.mjs"] + (["/prof"] if prof else [])
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    n = [0]

    def q(msg):
        n[0] += 1
        f = w / "q" / f"{n[0]:04d}.json"
        f.write_text(json.dumps(msg))
        o = w / "q" / f"{n[0]:04d}.out.json"
        t0 = time.time()
        while not o.exists() and time.time() - t0 < timeout:
            time.sleep(0.5)
        return json.loads(o.read_text()) if o.exists() else {"ok": False, "error": "timeout"}
    try:
        q({"cmd": "open", "url": site_url, "settle": 6})
        r = q({"cmd": "eval", "file": "kit.js", "out": "composer.json"})
        comp = json.loads((w / "composer.json").read_text()) if r.get("ok") and (w / "composer.json").exists() else {}
        if not comp or comp.get("error"):
            return None
        dst.mkdir(parents=True, exist_ok=True)
        q({"cmd": "shot", "out": "screenshot.png"})
        if (w / "screenshot.png").exists():
            shutil.copyfile(w / "screenshot.png", dst / "screenshot-page.png")
        host = re.sub(r"^https?://(www\.)?", "", site_url).split("/")[0]
        kit = {"app": app, "name": app, "hosts": [host], "theme": "dark" if comp.get("dark") else "light",
               "source": "live DOM" if profile else "public DOM",
               "captured": {"date": time.strftime("%Y-%m-%d"), "theme": "dark" if comp.get("dark") else "light",
                            "url_paths": ["/"], "viewport": {"css_w": 1536, "css_h": 864, "device_scale_factor": 1.6667}},
               "fonts": {}, "tokens": {}, "private_check": "uikits C7 screen at load (R14 P4 per-video capture)",
               "composer": {"width": comp["width"], "height": comp["height"], "css": "", "html": comp["html"],
                            "placeholder": comp.get("placeholder") or ""},
               "per_video": {"captured_by": "onboard.capture_kit_live (R14 P4)"}}
        (dst / "kit.json").write_text(json.dumps(kit, indent=1, ensure_ascii=False))
        return dst / "kit.json"
    finally:
        try:
            q({"cmd": "quit"}) if proc.poll() is None else None
            proc.wait(timeout=30)
        except Exception:  # noqa: BLE001
            subprocess.run(["docker", "kill", name], capture_output=True)
        shutil.rmtree(w, ignore_errors=True)
