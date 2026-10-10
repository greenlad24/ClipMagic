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

def classify(row):
    """A needs row (director needs_primitive shape: {sentence, word_ids, why, proposed, code?, kind?, need?}) → its
    group A/B/C/D. A structured row (the R14 plan schema: kind / code) wins; a free-text one (older plans, e.g. the
    test-v2 job's 43 rows) is read by its words."""
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


def normalize_proposal(p, pb, need):
    """The agent's proposal → a playbook action (or ValueError). Code fills what the schema needs."""
    if not isinstance(p, dict):
        raise ValueError("no proposal object")
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
                obs = transport.send({"cmd": "act", "action": dict(ans.get("action") or {})})
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


def onboard_action(ctx, need, params=None, generates=False):
    """P2 for one needed action: explore → propose → prove 3/3 (fix rounds feed the failures back). → row."""
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
        ctx.pb["actions"][aid] = act
        p = dict(params or {})
        if act.get("start_url") and ctx.image_chat:
            p.setdefault("chat_url", ctx.image_chat)
        pr = prove(ctx, aid, p)
        row["attempts"][-1]["replays"] = pr["replays"]
        if pr["proven"]:
            act["video_proof"] = {"mode": "onboarded", "replays": pr["replays"], "ok": pr["ok"], "n": pr["n"]}
            ctx.pb = save_job_playbook(ctx.pb, ctx.out, ctx.app)
            row.update(status="proven", action_id=aid, replays=f"{pr['ok']}/{pr['n']}")
            return row
        ctx.pb["actions"].pop(aid, None)
        feedback = "; ".join(str(x.get("why")) for x in pr["replays"] if not x["ok"])[:600]
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


def produce_asset(ctx, aid, desc, made_from=(), prompt=None):
    """P3: one needed asset, made IN THE APP before recording, off camera, checked against its description; never
    silently dropped. Jake 2026-10-10: "it needs to generate images in the ChatGPT UI" — no image API here.
      live (ctx.producer set, preprod.make_ctx): the producer AGENT (aieditor/producer.py) — the learned / hint recipe
        first, then it diagnoses every failed try and picks the next route itself; a route that works is learned into
        THIS video's playbook. Raises genledger.QuotaWait at the daily cap / a wall (the job waits, never holds).
      no producer (tests, a hand run): the app adapter's own in-app call (ctx.in_app), spaced, <= max tries, checked.
    An asset an earlier run of this job already produced and checked (assets/<id>.produced.json) is reused: a job
    that waited for the daily cap does not pay for it twice.
    → assets.json row {id, kind, desc, status ready|needs_asset, file, source, attempts, checks}."""
    dst = Path(ctx.out) / "assets" / f"{aid}.png"
    dst.parent.mkdir(parents=True, exist_ok=True)
    side = dst.with_suffix(".produced.json")
    try:
        old = json.loads(side.read_text())
        if old.get("desc") == desc and old.get("status") == "ready" and Path(old.get("file") or "").exists():
            ctx.asset_files[aid] = old["file"]
            ctx.log(f"{aid}: already made and checked by an earlier run of this job — reused")
            return old
    except (OSError, ValueError):
        pass
    # a picture MADE FROM other pictures (a merge of three photos, an edit of a reference) is made for real: its source
    # pictures first, then the app's own edit with all of them attached — never a single invented "merge" (TEST v3)
    if not made_from and not getattr(ctx, "_composing", False):
        plan_in = source_inputs(ctx, desc, sorted(ctx.asset_files))
        if plan_in.get("needs_inputs") and plan_in.get("inputs"):
            ids = []
            ctx._composing = True
            try:
                for inp in plan_in["inputs"][:4]:
                    iid = re.sub(r"[^a-z0-9_]+", "_", str(inp.get("id") or "").lower()).strip("_")[:32] or f"{aid}_src{len(ids) + 1}"
                    if iid not in ctx.asset_files:
                        ctx.log(f"{aid}: needs its source picture '{iid}' first — making it")
                        r_in = produce_asset(ctx, iid, str(inp.get("desc") or iid))
                        if r_in.get("status") != "ready":
                            return {"id": aid, "kind": "app_generation", "desc": desc, "status": "needs_asset",
                                    "file": None, "source": None, "attempts": [f"source picture {iid} failed"],
                                    "checks": [], "why": f"its source picture '{iid}' could not be made: {r_in.get('why')}"[:400]}
                    ids.append(iid)
            finally:
                ctx._composing = False
            made_from, prompt = tuple(ids), (plan_in.get("instruction") or desc)
    inputs = [ctx.asset_files.get(m) for m in made_from if ctx.asset_files.get(m)]
    from . import preprod
    new_photo = not made_from and not prompt
    if getattr(ctx, "producer", None) is not None:
        style = preprod.PHONE_STYLE if new_photo and asset_kind(desc) == "photo" else ""
        subject = image_prompt(ctx, desc) if new_photo else desc
        row = ctx.producer.produce(aid, desc, dst, inputs, prompt=prompt, subject=subject, style=style)
        row["made_from"] = list(made_from)
    else:
        row = _produce_in_app(ctx, aid, desc, dst, made_from, inputs, prompt, new_photo)
    if row.get("status") == "ready":
        ctx.asset_files[aid] = row["file"]
        side.write_text(json.dumps(row, indent=1, ensure_ascii=False))
    return row


def _produce_in_app(ctx, aid, desc, dst, made_from, inputs, prompt, new_photo):
    """The simple path without the agent: the adapter's in-app call, spaced, up to max_tries_per_asset, checked."""
    from . import preprod
    tries = int(onboarding_rules().get("max_tries_per_asset", 10))
    base = prompt or ("Create an image: " + preprod.PHONE_STYLE + image_prompt(ctx, desc) if new_photo else desc)
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
        res = ctx.check({"id": aid, "desc": desc}, dst, [desc])
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


INPUTS_SYSTEM = """A video needs a picture made in an app. Decide whether that picture is honestly the app's EDIT of other
pictures the person brings (e.g. "merge these three photos: the person, the market stall, the bottle", "make my photo
look like this reference", "restore this old photo"). If so, list each SOURCE picture as a separate photo to make first
(visible-only description; reuse an AVAILABLE id when one fits) and the instruction he types with them attached.
A plain new photo, or a result of a single edit whose source is obvious and available, needs no inputs. JSON only."""
INPUTS_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["needs_inputs", "inputs", "instruction"],
                 "properties": {"needs_inputs": {"type": "boolean"}, "instruction": {"type": "string"},
                                "inputs": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                      "required": ["id", "desc"],
                                                                      "properties": {"id": {"type": "string"},
                                                                                     "desc": {"type": "string"}}}}}}


def source_inputs(ctx, desc, available):
    """Generic (any app): does this picture need source pictures made first? → {needs_inputs, inputs[{id,desc}],
    instruction}. One cheap call; without a model, or on any error: no inputs."""
    if getattr(ctx, "llm", None) is None:
        return {"needs_inputs": False, "inputs": [], "instruction": ""}
    model = config.OVERLAY_MODEL if hasattr(config, "OVERLAY_MODEL") else config.VISION_MODEL
    msgs = [{"role": "user", "content": f"PICTURE: {desc}\nAVAILABLE pictures (ids): {', '.join(available) or 'none'}"}]
    try:
        ctx.budget.need(llm.estimate(model, INPUTS_SYSTEM, msgs, 500))
        r = ctx.llm(model, INPUTS_SYSTEM, None, 500, effort="low", msgs=msgs, schema=INPUTS_SCHEMA,
                    stage=f"preprod.onboard.{ctx.app}", purpose="P3 source pictures of a composite")
        ctx.budget.add(r.get("usd"))
        j = json.loads(r.get("text") or "{}")
        return j if isinstance(j, dict) else {"needs_inputs": False, "inputs": [], "instruction": ""}
    except Exception:  # noqa: BLE001 — treated as a plain picture
        return {"needs_inputs": False, "inputs": [], "instruction": ""}


IMAGE_SYSTEM = """A video narration describes a picture he shows (a photo he brings, a result). Rewrite it as ONE image
prompt that describes only what is VISIBLE in the picture: the subject, the setting, the light, the style. Drop fillers
("uh"), what he does with it ("I drag it into the chat"), and anything about the video. Answer with the JSON only."""
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


PLAIN_SYSTEM = """A video narration names a feature an app does not have (e.g. a '/newbg rustic kitchen' command). Write
the equivalent request in PLAIN WORDS that the app can really do (e.g. "Replace the background of this photo with a
rustic kitchen"), and what the result must visibly show. Answer with the JSON only."""
PLAIN_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["prompt", "expect"],
                "properties": {"prompt": {"type": "string"}, "expect": {"type": "string"}}}


def plain_request(ctx, feature, text, sentence):
    """The command he says → a plain-words request the app can do + what the result must show (one cheap call)."""
    content = f"Feature: {feature}\nWhat he types/says: {text}\nThe sentence: {sentence}"
    model = config.OVERLAY_MODEL if hasattr(config, "OVERLAY_MODEL") else config.VISION_MODEL
    msgs = [{"role": "user", "content": content}]
    ctx.budget.need(llm.estimate(model, PLAIN_SYSTEM, msgs, 600))
    r = ctx.llm(model, PLAIN_SYSTEM, None, 600, effort="low", msgs=msgs, schema=PLAIN_SCHEMA,
                stage=f"preprod.onboard.{ctx.app}", purpose="P4 plain-words request (real result)")
    ctx.budget.add(r.get("usd"))
    try:
        j = json.loads(r.get("text") or "{}")
        return {"prompt": str(j.get("prompt") or text), "expect": str(j.get("expect") or text)}
    except ValueError:
        return {"prompt": str(text or feature), "expect": str(text or feature)}


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

    # assets the manifest could not make (or left to the dry run) are needs too — retried and re-routed (P3), never
    # silently dropped (the old go_with_fallbacks path)
    for a in list(assets.get("assets", [])):
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
        if not made_from and asset_kind(desc) == "app_generation":
            prior = _prior_asset(answer, pr.get("word_id") or (r.get("word_ids") or [None])[0], pos, usable)
            made_from = [prior] if prior else []
        row = produce_asset(ctx, aid, desc, made_from)
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
            try:
                req = plain_request(ctx, feature, text, sentence)
            except BudgetSpent as e:
                req = {"prompt": str(text), "expect": str(text)}
                warnings.append(str(e))
            prior = _prior_asset(answer, wid, pos, usable) if wid is not None else None
            res = produce_asset(ctx, res_id, req["expect"], [prior] if prior else [], prompt=req["prompt"])
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
                       "result_asset": res_id, "how": how, "kit_dir": (kit or {}).get("dir"),
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
        key = re.sub(r"\W+", " ", need.lower()).strip()[:120]
        if key not in seen:
            try:
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
                    hit = True
            if not hit and wid is not None:
                seg = next((s for s in answer.get("segments") or [] if pos.get(s["start_word"], 1e9) <= pos.get(wid, -1)
                            <= pos.get(s["end_word"], -1)), None)
                bt = {"word_id": wid, "action": aid, "body": need[:140], "subject": "screen", "text": pr.get("text"),
                      "url": None, "asset_id": None, "live": False, "wait_end_word": None}
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
