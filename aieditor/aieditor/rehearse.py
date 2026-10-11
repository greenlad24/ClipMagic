"""THE REHEARSAL AGENT — an agent finds the way to do each screencast OFF CAMERA and writes the presentation script;
code proves it and records it (Jake 2026-10-11: "there's no reason to use code for both. The agents finds the way to do
the screencast and writes the code to present the screencast in the best way" — and "the agents should [not] be writing
all of his improvisations until he got to the answer — just the pure flow of what needs to be recorded").

Per screencast segment (switch: rules.json rehearsal.mode / env AIEDITOR_REHEARSAL = agent | playbook):

  1. REHEARSE  a capped vision agent drives the live off-camera agent_rec session (observe / find / count / act) from
               the segment's proven start state (recorder.open_clean: set dressing, first-frame gate) and performs
               the plan's beats like a person would, handling whatever the app shows (two controls with the same
               label, a viewer reopening in its last mode, rotating chips, renamed labels, slow loads). The playbook is
               a HINT only. Every action goes through the code guard below (click guard, deny words, never Jake's
               chats / Library, pricing only in the outside view, no edit keys, his on-screen words typed VERBATIM,
               generating presses DRY unless the beat needs a real result — genledger spacing). Every turn is logged.
  2. DISTILL   the full trial log (dead ends, wrong clicks, retries, exploratory opens) is NOT the script. One model
               call picks the minimal clean ordered sequence from the start state (by step index — it can only keep
               steps that really worked, never invent one) and says why each is needed; code checks the answer.
               Things the app forces on every load belong to the start state's dismiss / set dressing, never here.
  3. WRITE     the distilled steps become THIS segment's playbook actions (stable selectors re-derived from the
               element really pressed: data-testid / aria-label / exact label, never coordinates when an element
               exists) and plan beats anchored on the narration words; beatscript.compile_segment turns them into the
               SAME script format the recorder plays (press on the word, one paste per prompt, K2 reveals, the one
               live generation, camera holds) — no timing is invented here and no narration is trimmed.
  4. PROVE     one off-camera replay of that script from a FRESH start (recorder.play_script record=False). A
               distilled path that silently relied on a dead end's state (a mode toggled, a chip added) fails here:
               it is distilled again with the failure, else the agent works on from the divergence point.
  5. RECORD    recorder.Recorder.record_compiled — the existing path, unchanged (first frame, privacy blur, walls,
               account lock, per-beat retakes, verdict, elastic assembler).

A replay or a recording that diverges → one more agent pass from the divergence point → record again. After 2
failures the segment returns a non-ok status and preflight.fallbacks shows its approved motion template (logged,
never a silent drop). The full trial log is kept (seg-NN/rehearsal-log.json, the audit trail) and summarised into a
per-app hints ledger (what worked / what not to do) for the next video — it never goes into a recorded script.
"""
import base64
import copy
import json
import os
import re
import time
from pathlib import Path

from . import beatscript as B
from . import clickguard, config, events, llm, skill

DEFAULTS = {"mode": "agent", "model": "claude-sonnet-5-5", "escalate_model": "claude-opus-5-5", "effort": "medium",
            "max_turns_per_segment": 25, "stuck_after": 3, "max_redo_per_segment": 2, "segment_usd": 0.75,
            "video_usd": 8.0, "attempts": 2, "redistill": 1, "hint_rows": 6}
ENV_MODE = "AIEDITOR_REHEARSAL"
ENV_HINTS = "AIEDITOR_REHEARSAL_HINTS"
CODE_KINDS = ("goto", "reveal", "wait_for")         # playbook kinds code runs itself (no agent turn)
AGENT_TYPES = ("click", "type", "key", "scroll", "upload", "drag", "draw", "goto")
PRESS_TYPES = ("click", "type", "key", "upload", "drag", "draw", "scroll", "goto")
GEN_LABELS = re.compile(r"^(?:send|send prompt|remove bg|remove background|regenerate|square 1:1|portrait 3:4|story 9:16|"
                        r"landscape 4:3|widescreen 16:9|create|create image|generate|submit)$", re.I)
CHAT_RX = re.compile(r"/c/[\w-]+")
MAX_TOKENS = 1500


def rules():
    try:
        r = skill.rules().get("rehearsal") or {}
    except Exception:  # noqa: BLE001 — limits must never break a job
        r = {}
    return {**DEFAULTS, **{k: v for k, v in r.items() if not k.endswith("src")}}


def mode():
    """'agent' (default) or 'playbook' (the old compiled-playbook path, the fallback when the switch is off)."""
    v = (os.environ.get(ENV_MODE) or "").strip().lower()
    if v in ("agent", "playbook"):
        return v
    return "playbook" if str(rules().get("mode")).lower() == "playbook" else "agent"


class Capped(RuntimeError):
    pass


class WallHit(RuntimeError):
    def __init__(self, wall):
        self.wall = wall or {}
        super().__init__(f"{self.wall.get('kind')}: {self.wall.get('why')}")


# ───────────────────────── caps ─────────────────────────

class Budget:
    """$ per segment and per video (rules.json rehearsal), persisted in the edit dir; every call is also in the API
    ledger (llm.py), whose job / daily caps still apply on top."""

    def __init__(self, path=None, seg_cap=None, video_cap=None):
        r = rules()
        self.path = Path(path) if path else None
        self.seg_cap = float(r["segment_usd"] if seg_cap is None else seg_cap)
        self.video_cap = float(r["video_usd"] if video_cap is None else video_cap)
        doc = {}
        if self.path and self.path.exists():
            try:
                doc = json.loads(self.path.read_text())
            except (OSError, ValueError):
                doc = {}
        self.segs = dict(doc.get("segments") or {})

    @property
    def video_usd(self):
        return round(sum(self.segs.values()), 6)

    def spent(self, seg):
        return float(self.segs.get(str(seg), 0.0))

    def room(self, seg):
        return min(self.seg_cap - self.spent(seg), self.video_cap - self.video_usd)

    def charge(self, seg, usd):
        self.segs[str(seg)] = round(self.spent(seg) + float(usd or 0.0), 6)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"segments": self.segs, "video_usd": self.video_usd,
                                             "caps": {"segment": self.seg_cap, "video": self.video_cap}}, indent=1))


# ───────────────────────── the guard (code, never the prompt alone) ─────────────────────────

def _norm(t):
    return re.sub(r"\s+", " ", str(t or "")).strip()


class Guard:
    """Every agent action is checked HERE before it reaches the browser (agent_rec.mjs checks the click guard again
    in the page): the click guard deny-list (delete / buy / upgrade / bill / publish / share / invite / log out), the
    onboarding forbidden words, Jake's own pages (private_urls: his Library) and his existing chats (only chats this
    job created), pricing pages only from the never-logged-in outside view, no private field, no edit keys, no Enter
    (it sends), typing only his on-screen words verbatim."""

    def __init__(self, pb, session="logged_in", allowed_chats=()):
        self.pb = pb or {}
        self.session = clickguard.norm_session(session)
        self.allowed = {CHAT_RX.search(u).group(0) for u in allowed_chats or () if u and CHAT_RX.search(u)}
        try:
            words = (skill.rules().get("onboarding") or {}).get("forbidden") or []
        except Exception:  # noqa: BLE001
            words = []
        words = list(dict.fromkeys(list(words) + ["delete", "buy", "purchase", "upgrade", "billing", "payment", "publish",
                                                  "share", "invite", "log out", "sign out", "library"]))
        self.forbid = [clickguard.phrase_re(w) for w in words]

    def allow_chat(self, url):
        m = CHAT_RX.search(str(url or ""))
        if m:
            self.allowed.add(m.group(0))

    def _rx_any(self, key, s):
        for rx in self.pb.get(key) or []:
            try:
                if re.search(rx, str(s or ""), re.I):
                    return True
            except re.error:
                continue
        return False

    def url_why(self, url):
        if not url:
            return None
        if self._rx_any("private_urls", url):
            return "never one of Jake's own pages (playbook private_urls: his Library / his items)"
        m = CHAT_RX.search(str(url))
        if m and m.group(0) not in self.allowed:
            return "never one of Jake's existing chats (only chats this job created)"
        if self.session == "logged_in" and self._rx_any("outside_only", url):
            return "pricing pages are shown only from the never-logged-in outside (US) view"
        if self.session == "logged_in" and re.search(r"/pricing\b|#pricing", str(url), re.I):
            return "pricing pages are shown only from the never-logged-in outside (US) view"
        hosts = self.pb.get("hosts") or []
        if self.session == "logged_in" and hosts and re.match(r"https?://", str(url)):
            host = re.sub(r"^https?://", "", str(url)).split("/")[0].lower()
            if not any(host == h or host.endswith("." + h) for h in hosts):
                return f"a logged-in rehearsal stays in the app ({', '.join(hosts)})"
        return None

    def check(self, a, item=None, typed=None):
        """-> None (allowed) or the reason it is refused. item = the element the agent named (observe row)."""
        ty = a.get("type")
        if ty not in AGENT_TYPES:
            return f"'{ty}' is not an action a screencast may contain ({', '.join(AGENT_TYPES)})"
        target = {k: v for k, v in (item or {}).items() if k in ("text", "href", "tag", "aria", "label")}
        g = clickguard.check({k: v for k, v in a.items() if k not in ("alt", "ref")}, target or None, self.session)
        if not g.get("ok"):
            return f"click guard: {g.get('why')}"
        # a DRAG / DRAW lands on a surface (a picture, a canvas), it presses no button: the deny words are checked on what
        # it names, not on the surface's whole inner text (run 20: the viewer panel's text holds 'Share' and the Erase
        # hint, so every Erase brush stroke over the picture was refused as "share is never pressed")
        own = (item or {}).get("text") if ty not in ("drag", "draw") else \
            " ".join(str((item or {}).get(k) or "") for k in ("aria", "label"))
        labels = " ".join(str(x) for x in (a.get("target"), a.get("selector"), a.get("url"), own,
                                           (item or {}).get("href")) if x)
        if ty != "type":
            for rx in self.forbid:
                if rx.search(labels):
                    return f"forbidden: '{rx.pattern}' is never pressed or opened"
        for u in (a.get("url"), (item or {}).get("href")):
            why = self.url_why(u)
            if why:
                return why
        if a.get("selector") and re.search(r"href\*?=.?['\"]?/c/", str(a["selector"])):
            return "never one of Jake's existing chats (sidebar chat links are never clicked)"
        if a.get("selector") and str(a["selector"]).strip() in [str(s).strip() for s in self.pb.get("private_selectors") or []]:
            return "never a private field (email / password / card) — it is blurred, never used"
        if ty == "key":
            k = str(a.get("key") or "")
            if B.EDIT_KEYS.match(k):
                return f"edit key {k}: fields are cleared by the type step itself (C3), never by keys"
            if k.lower() in ("enter", "numpadenter", "meta+enter", "control+enter"):
                return "Enter sends — press the app's Send / Create control instead (a generating press, dry here)"
        if ty == "type":
            if typed is None:
                return "nothing may be typed in this beat: only his on-screen words, in a beat that types them"
            if a.get("text") not in (None, "") and _norm(a.get("text")) != _norm(typed):
                return "the typed text must be his on-screen words VERBATIM (code types them; never a rewrite or a note)"
        return None


# ───────────────────────── hints memory (what worked / what not to do) ─────────────────────────

def hints_path():
    return Path(os.environ.get(ENV_HINTS) or (config.WORK / "ledger" / "rehearsal-hints.jsonl"))


def remember(app, rows):
    """Append this video's lessons: [{"action", "worked": [targets], "avoid": [{target, why}]}]."""
    if not rows:
        return
    p = hints_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as f:
            for r in rows:
                f.write(json.dumps({"ts": round(time.time(), 3), "app": app, **r}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def hints_for(app, actions=(), n=None):
    n = n or int(rules()["hint_rows"])
    try:
        lines = hints_path().read_text().splitlines()
    except OSError:
        return []
    out = []
    for ln in reversed(lines):
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if r.get("app") == app and (not actions or r.get("action") in actions):
            out.append(r)
        if len(out) >= n:
            break
    return out


def lessons(log, beats):
    """The trial log → hint rows: per beat action, the targets that worked in the clean path and the ones that failed."""
    out = []
    for b in beats:
        steps = [s for s in log if s.get("beat") == b.get("id") and not s.get("code")]
        if not steps:
            continue
        worked = [_desc(s["action"]) for s in steps if s.get("kept")]
        avoid = [{"target": _desc(s["action"]), "why": str(s.get("error") or s.get("refused") or "a dead end")[:120]}
                 for s in steps if not s.get("kept")][:6]
        out.append({"action": b.get("action"), "worked": worked[:6], "avoid": avoid})
    return out


def _desc(a):
    a = a or {}
    tgt = a.get("selector") or (f"text={a['target']}" if a.get("target") else None) or \
        (f"({a.get('x')},{a.get('y')})" if a.get("x") is not None else "")
    return f"{a.get('type')} {tgt}".strip() + (f" key={a['key']}" if a.get("key") else "")


# ───────────────────────── the plan beats ─────────────────────────

def beat_role(b, pb):
    """'camera' | 'code' (goto / reveal / wait_for / outside.goto: code runs it) | 'agent' (a press the agent finds)."""
    aid = b.get("action")
    if B.is_camera(aid):
        return "camera"
    if aid == B.OUTSIDE_GOTO:
        return "code"
    a = ((pb or {}).get("actions") or {}).get(aid) or {}
    if a.get("kind") in CODE_KINDS:
        return "code"
    return "agent"


def typed_of(b):
    t = b.get("typed_text") or (b.get("params") or {}).get("text")
    return t if isinstance(t, str) and t.strip() else None


def hint_of(b, pb):
    a = ((pb or {}).get("actions") or {}).get(b.get("action")) or {}
    if not a:
        return f"(no playbook action '{b.get('action')}' — find the control yourself)"
    return (f"playbook hint '{b.get('action')}': {a.get('kind')} '{a.get('label')}' selectors={a.get('selectors', [])[:3]}"
            + (f" requires={a['requires']}" if a.get("requires") else "") + (" GENERATES" if a.get("generates") else "")
            + (" (proven)" if a.get("proven") else " (NOT proven — may be stale)"))


def _assets_by(assets):
    return {a.get("id"): a for a in (assets or {}).get("assets") or []}


def result_asset(b, prev_typed, assets, seg_idx):
    """The assets.json row a generating beat's result is (made off camera) — looked up on a COPY (no 'needed' row is
    added here; compile adds it as before)."""
    tmp = copy.deepcopy(assets or {"assets": []})
    aid = B.asset_for(b, prev_typed, tmp, seg_idx)
    return aid, _assets_by(assets).get(aid)


def upload_file(b, assets):
    aid = B.upload_asset({**b, **(b.get("params") or {})}, assets or {"assets": []})
    row = _assets_by(assets).get(aid) or {}
    return aid, row.get("file")


# ───────────────────────── the agent ─────────────────────────

SYSTEM = """You rehearse ONE screencast of Jake Dawson's tutorial OFF CAMERA (nothing you do is recorded) in a live
browser. Code will later record a clean script of what you did, timed to his narration. Perform the beats in order like
a person would, handling whatever the app shows (popups, a viewer that reopens in its last mode, two controls with the
same label, renamed buttons, slow loads). The playbook entries are HINTS — trust what you see on the screen.

Rules (code enforces them — a refused action is reported back):
- never delete, buy, upgrade, open billing, publish, share, invite or log out; never open an existing chat of the
  account or its Library; pricing pages only in the logged-out outside view
- type ONLY in a beat that has TYPED TEXT, and only that text verbatim: send {"type":"type","ref":"rN"} and code types
  it (never your own words, never a note)
- a generating press (Send, Create image, Remove BG, a resize option) is pressed DRY here unless code says otherwise —
  just press it; code shows the result made off camera
- no edit keys (Cmd+A, Backspace…) and no Enter; Escape is fine to close something you opened
- prefer elements from the ELEMENTS list by ref; a press on an image spot is {"type":"click","ref":"rN","rel":[fx,fy]};
  a drag on an element {"type":"drag","ref":"rN","rel_from":[fx,fy],"rel_to":[fx,fy]} (fractions 0-1 of its box)
- when a beat is done (the screen shows what the beat must show), say beat_done; if what the beat needs is ALREADY on
  screen, say beat_done with "already": true
- if you took a wrong turn and the page is messy, say redo_beat (code resets to the beat's start; at most twice)

Answer ONE JSON object per turn, nothing else:
{"do": "act|observe|find|count|beat_done|redo_beat|give_up", "note": "<short>",
 "actions": "<a JSON list of actions, as text>" (act: {"type": "click|type|key|scroll|upload|drag|draw|goto", "ref"|
 "target"|"selector", ...}), "texts": [...] (find: labels; count: CSS selectors),
 "proof_text": "<a short text now on screen that proves the beat landed, optional>", "already": false}"""

DISTILL = """A screencast was rehearsed off camera. Below is the FULL trial log: every action, including dead ends, wrong
clicks, retries, exploratory opens/closes and dismissals of popups that only appeared because of a misstep. Code will
RECORD a script from it, so it must be the PURE FLOW: the minimal ordered sequence of actions that produces each beat's
result from the start state — nothing a viewer would see as fumbling.

Keep a step only if the result needs it. Drop: failed / refused steps (code drops them anyway), dead ends and what undid
them, a menu opened only to look, a duplicate press, a focus click right before typing into the same field, Escapes
that closed something a misstep opened. Every beat's MAIN step must stay. You can only keep steps by their index i.
Answer ONE JSON object: {"keep": [{"i": <index>, "why": "<why the result needs it>"}], "note": "<short>"}"""


def _json_obj(txt):
    m = re.search(r"\{.*\}", str(txt or ""), re.S)
    try:
        ans = json.loads(m.group(0) if m else txt)
    except (ValueError, TypeError):
        return {}
    if not isinstance(ans, dict):
        return {}
    if isinstance(ans.get("actions"), str):
        try:
            ans["actions"] = json.loads(ans["actions"]) if ans["actions"].strip() else []
        except ValueError:
            ans["actions"] = []
    if isinstance(ans.get("actions"), dict):
        ans["actions"] = [ans["actions"]]
    return ans


def _shot_block(path):
    try:
        data = Path(path).read_bytes()
    except (OSError, TypeError):
        return None
    mt = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(data).decode()}}


def _overlap(a, b):
    try:
        x0, y0 = max(a[0], b[0]), max(a[1], b[1])
        x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
        inter = max(0, x1 - x0) * max(0, y1 - y0)
        return inter / max(1.0, min(a[2] * a[3], b[2] * b[3]))
    except (TypeError, IndexError):
        return 0.0


class SegmentAgent:
    """One screencast segment's rehearsal agent (off camera). run(beats) → the full trial log + the main step of each
    beat. Turns, $ and model are capped per segment; every turn is logged to the job log."""

    def __init__(self, sess, seg, pb, *, seg_idx=0, kind="logged_in", assets=None, call=None, budget=None, log=print,
                 allowed_chats=(), job=None, sleep=time.sleep, turns_left=None, open_start=None):
        r = rules()
        self.sess, self.seg, self.pb, self.i, self.kind = sess, seg, pb or {}, seg_idx, kind
        self.assets = assets if assets is not None else {"assets": []}
        self.call = call or llm.messages
        self.budget = budget or Budget()
        self.log = log
        self.job, self.sleep = job, sleep
        self.app = self.pb.get("app") or seg.get("app")
        chats = list(allowed_chats or []) + [(a.get("source") or {}).get("chat_url") for a in self.assets.get("assets") or []]
        self.guard = Guard(self.pb, kind, [c for c in chats if c])
        self.model, self.esc_model, self.effort = r["model"], r["escalate_model"], r["effort"]
        self.turns_left = int(r["max_turns_per_segment"] if turns_left is None else turns_left)
        self.stuck_after, self.max_redo = int(r["stuck_after"]), int(r["max_redo_per_segment"])
        self.open_start = open_start            # () -> None: the proven start state (recorder.open_clean)
        self.steps = []                         # THE FULL TRIAL LOG (audit trail; never a script)
        self.main = {}                          # beat id -> index of its main step in self.steps
        self.proof = {}                         # beat id -> proof text
        self.notes = []
        self.usd, self.turns, self.escalated, self.redos = 0.0, 0, False, 0
        self.obs = {}
        self.prev_typed = None

    # ── the browser, through the guard ──
    def _send(self, msg):
        r = self.sess.send(msg) or {}
        w = r.get("wall")
        if isinstance(w, dict) and w.get("kind") in ("challenge", "account", "error"):
            raise WallHit(w)
        return r

    def observe(self):
        o = self._send({"cmd": "observe"})
        self.obs = o
        return o

    def _item(self, ref):
        return next((x for x in self.obs.get("items") or [] if x.get("ref") == ref), None)

    def stable_target(self, item, typ):
        """The element the agent named (an observe ref) → a target that survives a fresh page: a unique
        data-testid / aria-label selector, else its exact label, else (an element with neither) its centre."""
        text = _norm((item or {}).get("text"))
        if text:
            r = self._send({"cmd": "find", "texts": [text], "exact": True})
            hits = ((r.get("found") or {}).get(text)) or []
            best = max(hits, key=lambda h: _overlap(h.get("box") or [0, 0, 0, 0], item.get("box") or [0, 0, 0, 0]),
                       default=None)
            sel = (best or {}).get("selector") or ""
            if sel and ":has-text" not in sel and _overlap(best.get("box") or [0, 0, 0, 0], item.get("box") or [0, 0, 0, 0]) > 0.5:
                n = self._send({"cmd": "count", "selector": sel}).get("n")
                if n == 1:
                    return {"selector": sel}, "selector"
            if typ != "type" and len(text) <= 60 and len(hits) <= 1:
                # a label is a stable target only when it is UNIQUE (run 20: two pictures both labelled "Generated image
                # 1", one off screen — the label always hit that one, the viewer never opened, 25 turns lost)
                return {"target": text, "exact": True}, "label"
        if typ == "type":
            for sel in self._composer_sels():
                if (self._send({"cmd": "count", "selector": sel}).get("n") or 0) >= 1:
                    return {"selector": sel}, "selector"
        b = (item or {}).get("box")
        f = float(self.obs.get("f") or 1.5)
        if b:
            return {"x": round((b[0] + b[2] / 2) / f, 1), "y": round((b[1] + b[3] / 2) / f, 1)}, "point"
        return {}, "none"

    def _composer_sels(self):
        out = []
        for a in (self.pb.get("actions") or {}).values():
            if a.get("kind") in ("paste", "type"):
                out += [s for s in a.get("selectors") or [] if not str(s).startswith("text=")]
        return out + ['[contenteditable="true"]', "textarea"]

    def _is_gen(self, a, item, beat):
        lab = _norm(a.get("target") or (item or {}).get("text") or "")
        if a.get("type") in ("click", "dblclick") and GEN_LABELS.match(lab):
            return True
        sel = str(a.get("selector") or "")
        for x in (self.pb.get("actions") or {}).values():
            if x.get("generates") and sel and sel in (x.get("selectors") or []):
                return True
        hint = (self.pb.get("actions") or {}).get(beat.get("action")) or {}
        if hint.get("generates") and a.get("type") == "click" and lab and \
                _norm(hint.get("label")).lower() == lab.lower():
            return True
        return False

    def _needs_real(self, beat, todo):
        """A generating press is REAL in rehearsal only when the beat's result is not made yet AND a later beat of
        this segment acts on it (a tool on the result). Otherwise it is a dry press (the K2 reveal shows the asset)."""
        aid, row = result_asset(beat, self.prev_typed, self.assets, self.i)
        if row and B.asset_ready(self.assets, aid):
            return False, aid
        k = next((j for j, b in enumerate(todo) if b.get("id") == beat.get("id")), len(todo))
        later = [b for b in todo[k + 1:] if beat_role(b, self.pb) == "agent"]
        return bool(later), aid

    def perform(self, a, beat, todo):
        """One agent action: guard → stable target → (dry / real generation) → the browser. Logged in the trial log."""
        from . import onboard
        a = onboard.norm_points(dict(a or {}))
        ty = a.get("type")
        item = self._item(a["ref"]) if a.get("ref") else None
        if a.get("ref") and item is None:
            return self._logstep(beat, a, ok=False, error=f"unknown ref {a.get('ref')} — observe again")
        typed = typed_of(beat)
        why = self.guard.check(a, item, typed=typed if ty == "type" else None)
        if why:
            return self._logstep(beat, a, ok=False, refused=why)
        step = {k: v for k, v in a.items() if k in ("type", "key", "by", "rel", "rel_from", "rel_to", "url", "selector",
                                                     "target", "exact", "x", "y", "from", "to")}
        if ty == "drag" and not (isinstance(step.get("from"), list) and isinstance(step.get("to"), list)) \
                and isinstance(a.get("rel_from"), list) and isinstance(a.get("rel_to"), list) and item and item.get("box"):
            # fractions of the element's box → SCREENSHOT px points the browser takes for every drag (run 18: the asset
            # agent's Markup box arrived as rel_from/rel_to on a ref, the derived target dropped the box, and all 20
            # drags failed "drag needs from/to [x, y]"). The box is CSS px; the agent's screenshot is CSS / f.
            f = float(self.obs.get("f") or 1.5)
            bx, by, bw, bh = (float(v) for v in item["box"][:4])
            step["from"] = [round((bx + a["rel_from"][0] * bw) / f, 1), round((by + a["rel_from"][1] * bh) / f, 1)]
            step["to"] = [round((bx + a["rel_to"][0] * bw) / f, 1), round((by + a["rel_to"][1] * bh) / f, 1)]
        how = None
        if a.get("ref") and ty in ("click", "type", "drag", "draw"):
            tgt, how = self.stable_target(item, ty)
            for k in ("selector", "target", "exact", "x", "y"):
                step.pop(k, None)
            step.update(tgt)
        if ty == "type":
            if not step.get("selector") and not step.get("target"):
                sels = self._composer_sels()
                step["selector"] = sels[0]
            step.update(text=typed, paste=True, clear=True, enter=False)
        if ty == "upload":
            aid, f = upload_file(beat, self.assets)
            if not f:
                return self._logstep(beat, a, ok=False, refused="no asset file for this upload (assets.json) — "
                                                                  "only the job's own source files are uploaded")
            name = Path(f).name
            wd = getattr(self.sess, "workdir", None)
            if wd is not None and Path(f).is_file():
                import shutil
                (Path(wd) / "upload").mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, Path(wd) / "upload" / name)
            step = {"type": "upload", "files": [f"/w/upload/{name}"], "asset": aid}
        gen = ty == "click" and self._is_gen(step, item, beat)
        real = False
        wire = dict(step)
        wire.pop("asset", None)
        if gen:
            real, raid = self._needs_real(beat, todo)
            if real:
                from . import genledger
                wait = genledger.gate(self.app)          # QuotaWait: the job waits (never held)
                if wait:
                    self.log(f"rehearsal: waiting {wait:.0f} s between generations ({self.app})")
                    self.sleep(wait)
            else:
                wire["press"] = False                   # a DRY press: the cursor clicks, the page is not pressed
        if a.get("ref") and ty in ("click", "dblclick", "type", "drag", "draw"):
            # LIVE the element the agent named is pressed (its ref) — the derived stable target is what the SCRIPT
            # keeps, proven by the fresh replay. Run 20: the derived label hit an off-screen duplicate 20 times while
            # the agent kept naming the visible one.
            wire = {k: v for k, v in wire.items() if k not in ("selector", "target", "exact", "x", "y")}
            wire["ref"] = a["ref"]
        r = self._send({"cmd": "act", "action": wire})
        if not r.get("ok", True) and a.get("ref") and how in ("selector", "label", "point"):
            # the derived target did not resolve: the element the agent named, by ref — then its own hint
            alt = {k: v for k, v in wire.items() if k not in ("selector", "target", "exact", "x", "y")}
            r2 = self._send({"cmd": "act", "action": {**alt, "ref": a["ref"]}})
            if r2.get("ok", True) and not r2.get("error"):
                res = r2.get("resolved") or {}
                for k in ("selector", "target", "exact", "x", "y"):
                    step.pop(k, None)
                if res.get("hint"):
                    step["selector"] = res["hint"]
                elif res.get("label"):
                    step.update(target=_norm(res["label"]), exact=True)
                step["unproven_target"] = True
                r = r2
        ok = bool(r.get("ok", True)) and not r.get("error") and not r.get("refused")
        url = r.get("url")
        if ok and url and CHAT_RX.search(str(url)) and CHAT_RX.search(str(url)).group(0) not in self.guard.allowed:
            if real:
                self.guard.allow_chat(url)               # the chat this rehearsal's own generation just created
            else:
                self._send({"cmd": "open", "url": (self.pb.get("start_state") or {}).get("url") or self.seg.get("url"),
                            "settle": 3})
                return self._logstep(beat, step, ok=False, error="an existing chat opened — left it (never touched)")
        if ok and real:
            from . import genledger
            genledger.record(self.app, self.job, raid, None, "rehearsal")
            ws = ((self.pb.get("actions") or {}).get("wait_generation") or {}).get("selectors") or \
                ['[data-testid="generated-image-preview"]']
            wr = self._send({"cmd": "act", "action": {"type": "wait_for", "selector": ws[0], "timeout": 300}})
            st = self._send({"cmd": "state"}) if wr.get("ok", True) else {}
            curl = st.get("url") or wr.get("url") or url
            if wr.get("ok", True) and curl:
                self.guard.allow_chat(curl)
                self._register(raid, curl)
        if ty == "type" and ok:
            self.prev_typed = typed
        return self._logstep(beat, step, ok=ok, error=None if ok else (r.get("error") or r.get("refused")),
                             generates=gen, real=real, url_after=url)

    def _register(self, aid, url):
        rows = self.assets.setdefault("assets", [])
        row = next((x for x in rows if x.get("id") == aid), None)
        new = {"id": aid, "kind": "app_generation", "status": "ready",
               "source": {"chat_url": url, "prompt": self.prev_typed, "image_index": -1, "made_by": "rehearsal agent"}}
        if row is None:
            rows.append(new)
        else:
            row.update(status="ready", source={**(row.get("source") or {}), **new["source"]})
        self.log(f"rehearsal: screencast {self.i + 1}: the result of {aid} was made live off camera (a later beat acts on it)")

    def _logstep(self, beat, action, ok, error=None, refused=None, **kw):
        s = {"i": len(self.steps), "beat": beat.get("id"), "turn": self.turns, "action": action, "ok": bool(ok),
             **({"error": str(error)[:200]} if error else {}), **({"refused": refused} if refused else {}),
             **{k: v for k, v in kw.items() if v not in (None, False)}}
        self.steps.append(s)
        if refused:
            events.emit("step", f"rehearsal screencast {self.i + 1} {beat.get('id')}: REFUSED {_desc(action)} — {refused}",
                        level="warn")
        return s

    # ── code beats (no agent turn) ──
    def code_beat(self, b):
        from . import playbook as PB
        from . import recorder as R
        aid = b.get("action")
        if aid == B.OUTSIDE_GOTO:
            steps = [{"type": "goto", "url": (b.get("params") or {}).get("url")}]
        else:
            a = (self.pb.get("actions") or {}).get(aid) or {}
            if a.get("kind") == "wait_for":
                return
            if a.get("kind") == "reveal":
                rid, row = result_asset(b, self.prev_typed, self.assets, self.i)
                url = ((row or {}).get("source") or {}).get("chat_url") or (row or {}).get("url")
                if url and B.asset_ready(self.assets, rid) and url != self.obs.get("url"):
                    self.guard.allow_chat(url)
                    r = self._send({"cmd": "act", "action": {"type": "goto", "url": url}})
                    self._logstep(b, {"type": "goto", "url": url}, ok=r.get("ok", True), code=True)
                return
            try:
                steps = PB.resolve(self.pb, aid, dict(b.get("params") or {}))
            except PB.PlaybookError as e:
                self._logstep(b, {"type": "goto"}, ok=False, error=str(e), code=True)
                return
        for st in steps:
            w = R.wire(st, record=False)
            why = self.guard.url_why(w.get("url")) if self.kind == "logged_in" else None
            if why:
                self._logstep(b, w, ok=False, refused=why, code=True)
                continue
            r = self._send({"cmd": "act", "action": w})
            self._logstep(b, w, ok=r.get("ok", True) and not r.get("error"), error=r.get("error"), code=True)

    def reveal_after(self, b):
        """After a DRY generating press the script shows the result made off camera (K2 reveal → its chat): the
        rehearsal goes there too, so the next beats act on what the recording will show."""
        rid, row = result_asset(b, self.prev_typed, self.assets, self.i)
        url = ((row or {}).get("source") or {}).get("chat_url") or (row or {}).get("url")
        if url and B.asset_ready(self.assets, rid):
            self.guard.allow_chat(url)
            r = self._send({"cmd": "act", "action": {"type": "goto", "url": url}})
            self._logstep(b, {"type": "goto", "url": url, "reveal_of": rid}, ok=r.get("ok", True), code=True)

    # ── the model ──
    def _static(self, todo, feedback):
        words = " ".join(str(b.get("word") or "") for b in todo)
        lines = []
        for b in todo:
            role = beat_role(b, self.pb)
            t = typed_of(b)
            up = upload_file(b, self.assets)[0] if (((self.pb.get("actions") or {}).get(b.get("action")) or {}).get("kind")
                                                    == "upload") else None
            lines.append(f"- {b.get('id')} on the word '{b.get('word')}' (t={float(b.get('t_word', 0)) - float(self.seg['t0']):.1f}s"
                         f" into the screencast): {'CODE does it' if role != 'agent' else 'YOU do it'} — "
                         f"{hint_of(b, self.pb)}"
                         + (f"; MUST SHOW: {b.get('must_text')}" if b.get("must_text") else "")
                         + (f"; subject: {b.get('subject')}" if b.get("subject") else "")
                         + (f"; TYPED TEXT (verbatim, code types it): {t!r}" if t else "")
                         + (f"; uploads the job's file {up}" if up else "")
                         + (f"; what he says: {b.get('body')}" if b.get("body") else ""))
        hints = hints_for(self.app, [b.get("action") for b in todo])
        mem = "\n".join(f"- {h.get('action')}: worked {h.get('worked')}; avoid {[x.get('target') for x in h.get('avoid') or []]}"
                        for h in hints)
        return (f"APP: {self.app} ({self.kind} session; start {self.seg.get('url') or (self.pb.get('start_state') or {}).get('url')})\n"
                f"BEATS (in order):\n" + "\n".join(lines)
                + (f"\nLESSONS FROM EARLIER VIDEOS (hints):\n{mem}" if mem else "")
                + (f"\nTHE LAST ATTEMPT FAILED: {feedback}" if feedback else "")
                + f"\nNARRATION WORDS: {words}")

    def _ask(self, static, dyn, label):
        model = self.esc_model if self.escalated else self.model
        msgs = [{"role": "user", "content": [{"type": "text", "text": static, "cache_control": {"type": "ephemeral"}}, *dyn]}]
        est = llm.estimate(model, SYSTEM, msgs, MAX_TOKENS)
        if est > self.budget.room(self.i):
            raise Capped(f"rehearsal cap: ${self.budget.spent(self.i):.2f} of ${self.budget.seg_cap:.2f} on this screencast, "
                         f"${self.budget.video_usd:.2f} of ${self.budget.video_cap:.2f} on the video")
        r = self.call(model, SYSTEM, None, MAX_TOKENS, effort=self.effort, msgs=msgs, thinking=False,
                      stage="rehearse", purpose=f"rehearsal {label} (off camera)")
        u = float(r.get("usd", 0.0) or 0.0)
        self.usd += u
        self.budget.charge(self.i, u)
        return _json_obj(r.get("text", ""))

    def _dyn(self, beat, last):
        o = self.obs or {}
        tail = [f"{s['i']}: [{s['beat']}] {_desc(s['action'])} → {'ok' if s['ok'] else (s.get('refused') or s.get('error'))}"
                for s in self.steps[-12:]]
        dyn = [{"type": "text", "text": f"NOW: beat {beat.get('id')} (word '{beat.get('word')}'). TURNS LEFT: {self.turns_left}.\n"
                f"LOG:\n" + ("\n".join(tail) or "(nothing yet)") + f"\nLAST: {json.dumps(last, default=str)[:1500]}\n"
                f"URL: {o.get('url')}"}]
        if o.get("items"):
            dyn.append({"type": "text", "text": "ELEMENTS: " + json.dumps([{k: i.get(k) for k in ("ref", "tag", "text", "box")}
                                                                         for i in o["items"][:150]])[:9000]})
        img = _shot_block(o.get("shot"))
        if img:
            dyn.append(img)
        return dyn

    def _verify_beat(self, b, done):
        """beat_done → code checks the beat really landed (typed text equal to the script, must_text, proof text)."""
        mine = [s for s in self.steps if s["beat"] == b["id"] and s["ok"] and not s.get("code")]
        if not mine and not done.get("already"):
            return "no action of this beat worked yet"
        t = typed_of(b)
        if t:
            ty = [s for s in mine if s["action"].get("type") == "type"]
            if not ty:
                return "this beat types his words: send {\"type\":\"type\",\"ref\":...} on the field"
            r = self._send({"cmd": "assert", "field": ty[-1]["action"].get("selector"), "field_equals": t})
            if not r.get("ok", True):
                return "the field does not hold his words verbatim: " + "; ".join(r.get("fail") or [])[:200]
        gen = any(s.get("generates") for s in mine)
        present = [] if gen or b.get("live") else list(b.get("must_text") or [])
        pt = _norm(done.get("proof_text"))[:80]
        if pt:
            present.append(pt)
        if present:
            r = self._send({"cmd": "assert", "present": present})
            if not r.get("ok", True):
                return "not on screen: " + "; ".join(r.get("fail") or [])[:200]
        return None

    def reset_to(self, k, todo):
        """redo_beat: the start state again, then every earlier beat's working steps (dry) — the page as the beat began."""
        if self.open_start:
            self.open_start()
        done_ids = {b["id"] for b in todo[:k]}
        for s in [s for s in self.steps if s["beat"] in done_ids and s["ok"] and not s.get("abandoned")]:
            a = {k2: v for k2, v in s["action"].items() if k2 not in ("asset", "unproven_target", "reveal_of")}
            if s.get("generates"):
                a["press"] = False
            self._send({"cmd": "act", "action": a})

    def run(self, todo, feedback=None):
        """Perform the beats `todo` (plan beats, in order). → {"ok", "why", "steps", "main", "usd", "turns"}."""
        self.observe()
        last = {}
        for k, b in enumerate(todo):
            role = beat_role(b, self.pb)
            if role == "camera":
                continue
            if role == "code":
                self.code_beat(b)
                self.observe()
                continue
            stuck = 0
            while True:
                if self.turns_left <= 0:
                    return self._out(False, f"no clean rehearsal within the segment's turn cap ({rules()['max_turns_per_segment']} "
                                                  f"turns; {self.turns} in this pass), stopped at beat {b['id']}")
                self.turns_left -= 1
                self.turns += 1
                if stuck >= self.stuck_after and not self.escalated:
                    self.escalated = True
                    self.log(f"rehearsal: screencast {self.i + 1} stuck at {b['id']} — escalating to {self.esc_model}")
                ans = self._ask(self._static(todo, feedback), self._dyn(b, last), f"screencast {self.i + 1} {b['id']} turn {self.turns}")
                do = ans.get("do")
                note = str(ans.get("note") or "")[:160]
                events.emit("step", f"rehearsal screencast {self.i + 1} {b['id']} turn {self.turns}: {do} — {note}")
                self.notes.append({"turn": self.turns, "beat": b["id"], "do": do, "note": note,
                                   "model": self.esc_model if self.escalated else self.model})
                if do == "act":
                    res = []
                    for a in list(ans.get("actions") or [])[:6]:
                        if not isinstance(a, dict):
                            continue
                        s = self.perform(a, b, todo)
                        res.append({"i": s["i"], "ok": s["ok"], **({"why": s.get("refused") or s.get("error")} if not s["ok"] else {})})
                        if not s["ok"]:
                            break
                    stuck = stuck + 1 if (not res or not res[-1]["ok"]) else 0
                    last = {"acted": res}
                    self.observe()
                elif do == "observe":
                    self.observe()
                    last = {"observed": True}
                elif do == "find":
                    last = {"found": self._send({"cmd": "find", "texts": list(ans.get("texts") or [])[:6]}).get("found", {})}
                elif do == "count":
                    last = {"counts": {x: self._send({"cmd": "count", "selector": x}).get("n")
                                       for x in list(ans.get("texts") or [])[:6]}}
                elif do == "beat_done":
                    why = self._verify_beat(b, ans)
                    if why:
                        stuck += 1
                        last = {"beat_done_refused": why}
                        continue
                    mine = [s for s in self.steps if s["beat"] == b["id"] and s["ok"] and not s.get("code")]
                    if mine:
                        self.main[b["id"]] = mine[-1]["i"]
                    if _norm(ans.get("proof_text")):
                        self.proof[b["id"]] = _norm(ans.get("proof_text"))[:80]
                    if any(s.get("generates") and not s.get("real") for s in mine[-1:]):
                        self.reveal_after(b)
                    self.observe()
                    last = {"beat_done": b["id"]}
                    break
                elif do == "redo_beat":
                    if self.redos >= self.max_redo:
                        last = {"refused": "no redo left — continue from here"}
                        continue
                    self.redos += 1
                    for s in self.steps:
                        if s["beat"] == b["id"]:
                            s["abandoned"] = True
                    self.reset_to(k, todo)
                    self.observe()
                    last = {"reset": f"back at the start of {b['id']}"}
                elif do == "give_up":
                    return self._out(False, f"the agent gave up at {b['id']}: {note or 'no reason'}")
                else:
                    # no usable answer (empty / unparsable JSON) is never a give-up — asked again, the turn counts
                    last = {"error": "your answer had no valid \"do\" — answer ONLY the JSON object with do = "
                                     "act|observe|find|count|beat_done|redo_beat|give_up"}
        return self._out(True, "")

    def _out(self, ok, why):
        return {"ok": ok, "why": why, "steps": self.steps, "main": dict(self.main), "proof": dict(self.proof),
                "usd": round(self.usd, 6), "turns": self.turns, "escalated": self.escalated, "notes": self.notes}


# ───────────────────────── distill: the pure flow ─────────────────────────

def candidates(steps):
    """Steps a script may contain at all: worked, the agent's own (not code), not from an abandoned attempt."""
    return [s for s in steps if s.get("ok") and not s.get("code") and not s.get("abandoned")]


def prune(keep, steps):
    """Code rules on any kept list: a focus click right before a type into the same field goes (the type focuses), a
    press repeated on the same target goes."""
    by = {s["i"]: s for s in steps}
    out = []
    for i in sorted(set(keep)):
        s = by[i]
        if out:
            p = by[out[-1]]
            pa, sa = p["action"], s["action"]
            if p["beat"] == s["beat"] and pa.get("type") == "click" and sa.get("type") == "type" and \
                    any(pa.get(f) and pa.get(f) == sa.get(f) for f in ("selector", "target")):
                out.pop()
            elif p["beat"] == s["beat"] and pa == sa and sa.get("type") == "click":
                continue
        if s["action"].get("type") == "type":
            # a later paste of his words into the same field supersedes an earlier one (never a retype on camera)
            out = [j for j in out if not (by[j]["action"].get("type") == "type" and by[j]["beat"] == s["beat"])]
        out.append(i)
    return out


def distill(run, beats, *, call=None, budget=None, seg_idx=0, feedback=None, previous=None, log=print):
    """The full trial log → the minimal clean step indices per beat ({"keep": [i...], "why": {i: why}, "forced": [...],
    "usd"}). ONE model call (re-asked with the replay's failure as feedback); code validates the answer: only steps
    that worked, in order, every beat's main step kept. Without a usable answer the code rules alone decide."""
    steps = run["steps"]
    cand = {s["i"]: s for s in candidates(steps)}
    mains = {b: i for b, i in (run.get("main") or {}).items() if i in cand}
    usd, why, note = 0.0, {}, ""
    keep = None
    if cand:
        listing = "\n".join(
            f"{s['i']}: [{s['beat']}] {_desc(s['action'])}" + (" (typed his words)" if s["action"].get("type") == "type" else "")
            + (" GENERATING" if s.get("generates") else "") + (" ← MAIN of its beat" if mains.get(s["beat"]) == s["i"] else "")
            + ("" if s.get("ok") else f" FAILED: {s.get('refused') or s.get('error')}") + (" (abandoned attempt)" if s.get("abandoned") else "")
            for s in steps if not s.get("code"))
        bl = "\n".join(f"- {b.get('id')} on '{b.get('word')}': {b.get('action')}" for b in beats if beat_role(b, {}) != "camera")
        content = (f"BEATS:\n{bl}\n\nTRIAL LOG:\n{listing}"
                   + (f"\n\nYOUR PREVIOUS PICK {previous} FAILED A FRESH REPLAY: {feedback}\nA dead end may have changed state "
                      "the path relied on (a mode toggled, a chip added): add back ONLY the step(s) the result needs." if feedback else ""))
        r = rules()
        model = r["model"]
        est = llm.estimate(model, DISTILL, [{"role": "user", "content": content}], 1200)
        if budget is None or est <= budget.room(seg_idx):
            try:
                rep = (call or llm.messages)(model, DISTILL, content, 1200, effort=r["effort"], thinking=False,
                                             stage="rehearse", purpose=f"rehearsal distill screencast {seg_idx + 1} (off camera)")
                usd = float(rep.get("usd", 0.0) or 0.0)
                if budget is not None:
                    budget.charge(seg_idx, usd)
                ans = _json_obj(rep.get("text", ""))
                note = str(ans.get("note") or "")[:200]
                picks = [x for x in ans.get("keep") or [] if isinstance(x, dict) and isinstance(x.get("i"), int)]
                keep = [x["i"] for x in picks if x["i"] in cand]
                why = {x["i"]: str(x.get("why") or "")[:160] for x in picks if x["i"] in cand}
                if not picks:
                    keep = None
            except llm.OnCameraCall:
                raise
            except Exception as e:  # noqa: BLE001 — a failed distill call falls back to the code rules, logged
                if type(e).__name__ in ("BudgetExceeded",):
                    raise
                log(f"rehearsal: distill call failed ({type(e).__name__}: {str(e)[:120]}) — code rules only")
    forced = []
    if keep is None:
        # the code rules alone: each beat's attempt that reached beat_done (abandoned attempts are already out)
        keep = list(cand)
        note = note or "code rules only"
    for b, i in mains.items():
        if i not in keep:
            keep.append(i)
            forced.append(i)
    keep = prune(keep, steps)
    return {"keep": keep, "why": why, "forced": forced, "note": note, "usd": round(usd, 6)}


# ───────────────────────── write: the script in the recorder's format ─────────────────────────

def _action_of(step, beat, app, idx, generates=False, proof=None):
    a = step["action"]
    ty = a.get("type")
    base = {"label": _norm(a.get("target") or a.get("selector") or ty)[:80], "proven": True, "params": {},
            "source": f"rehearsal agent (per video, proven by its off-camera replay): beat {beat.get('id')} step {idx}",
            "generates": bool(generates), "agent": True}
    sel = a.get("selector") or (f"text={a['target']}" if a.get("target") else None)
    extra = {k: a[k] for k in ("x", "y", "rel") if a.get(k) is not None}
    if ty == "click":
        act = {**base, "kind": "click", "selectors": [sel] if sel else []}
        if a.get("exact"):
            act["exact"] = True
    elif ty == "type":
        act = {**base, "kind": "paste", "selectors": [sel or '[contenteditable="true"]'], "label": "Paste the prompt"}
    elif ty == "key":
        act = {**base, "kind": "key", "selectors": []}
    elif ty == "scroll":
        act = {**base, "kind": "scroll", "selectors": []}
    elif ty == "upload":
        act = {**base, "kind": "upload", "selectors": ["input[type=file]"]}
    elif ty == "drag":
        act = {**base, "kind": "drag", "selectors": [sel] if sel else []}
    elif ty == "draw":
        act = {**base, "kind": "draw", "selectors": [sel] if sel else []}
    elif ty == "goto":
        act = {**base, "kind": "goto", "url": a.get("url"), "selectors": []}
    else:
        raise ValueError(f"step type {ty}")
    if proof:
        act["post"] = [{"kind": "text", "value": proof}]
    if extra:
        act["_extra"] = extra
    return act


def build(seg, pb, run, kept, words, *, seg_idx=0, assets=None, live_left=1, doodles=None):
    """The distilled steps → (this segment's playbook, the plan segment with one beat per kept step, the compiled
    script). The beat's MAIN step keeps the beat's id + word (the press lands on it); its other kept steps become
    beats a moment before it (cursor and press timing from beatscript — nothing timed here)."""
    spb = copy.deepcopy({k: v for k, v in (pb or {}).items() if not k.startswith("_")})
    for a in spb.get("actions", {}).values():
        if a.get("kind") in CODE_KINDS:
            a["proven"] = True                   # a goto / reveal / generation wait is code's own (a url / a selector)
    app = spb.get("app") or seg.get("app")
    by = {s["i"]: s for s in run["steps"]}
    keep = list(kept["keep"])
    mains = run.get("main") or {}
    new_beats = []
    plan = sorted([dict(b) for b in seg.get("beats") or [] if b.get("t_word") is not None], key=lambda b: b["t_word"])
    prev_t, prev_gen = float(seg["t0"]), False
    for b in plan:
        role = beat_role(b, pb)
        if role != "agent":
            new_beats.append(b)
            prev_t, prev_gen = float(b["t_word"]), False
            continue
        mine = [by[i] for i in keep if by[i]["beat"] == b["id"]]
        if not mine:
            # nothing to press: the state was already there — the beat frames what is on screen
            new_beats.append({**b, "action": "camera", "subject": b.get("subject") if str(b.get("subject") or "").startswith("ui:")
                              else "screen", "params": {}})
            prev_t, prev_gen = float(b["t_word"]), False
            continue
        main_i = mains.get(b["id"]) if mains.get(b["id"]) in [s["i"] for s in mine] else mine[-1]["i"]
        pre = [s for s in mine if s["i"] != main_i]
        post = [s for s in mine if s["i"] > main_i]
        pre = [s for s in pre if s not in post]
        main = by[main_i]
        n = len(pre)
        # a step never goes before the previous beat's result is on screen (a K2 reveal lands at its word + 0.65 s)
        floor = prev_t + (B.K2_AFTER + 0.25 if prev_gen else 0.0)
        for j, s in enumerate(pre):
            aid = f"ag_s{seg_idx:02d}_{b['id']}_{s['i']}"
            spb["actions"][aid] = _action_of(s, b, app, s["i"], generates=bool(s.get("generates")))
            t = float(b["t_word"]) - 0.9 - 0.45 * (n - j)
            t = max(t, floor + 0.15 * (j + 1))
            t = round(min(t, float(b["t_word"]) - 0.2), 3)
            nb = {"id": f"{b['id']}p{j}", "t_word": t, "clause_start": t, "action": aid, "word": b.get("word"),
                  "params": _params_of(s), "pre_of": b["id"]}
            if s["action"].get("type") == "type":
                nb["typed_text"] = s["action"].get("text")
            if s["action"].get("type") == "upload":
                nb["asset_id"] = s["action"].get("asset")
            new_beats.append(nb)
        aid = f"ag_s{seg_idx:02d}_{b['id']}_{main_i}"
        spb["actions"][aid] = _action_of(main, b, app, main_i, generates=bool(main.get("generates")),
                                         proof=(run.get("proof") or {}).get(b["id"]))
        fb = {**b, "action": aid, "params": {**_params_of(main)}}
        if main["action"].get("type") == "type":
            fb["typed_text"] = main["action"].get("text")
        if main["action"].get("type") == "upload":
            fb["asset_id"] = main["action"].get("asset")
        new_beats.append(fb)
        prev_t, prev_gen = float(b["t_word"]), bool(main.get("generates"))
        for j, s in enumerate(post):                 # steps after the main press (closing a menu it opened)
            aid = f"ag_s{seg_idx:02d}_{b['id']}_{s['i']}"
            spb["actions"][aid] = _action_of(s, b, app, s["i"], generates=bool(s.get("generates")))
            t = round(float(b["t_word"]) + 0.6 * (j + 1), 3)
            new_beats.append({"id": f"{b['id']}q{j}", "t_word": t, "clause_start": t, "action": aid, "word": b.get("word"),
                              "params": _params_of(s), "post_of": b["id"]})
    seg2 = {**seg, "beats": sorted(new_beats, key=lambda x: float(x["t_word"]))}
    sc = B.compile_segment(seg2, words, spb, seg_idx, assets=assets, live_left=live_left, doodles=doodles,
                           allow_unproven=False, outside_actions=True)
    # what the playbook format cannot carry (a point inside an element, an exact label): onto the compiled steps
    ext = {f"{spb.get('app')}:{k}": a.get("_extra") for k, a in spb["actions"].items() if a.get("_extra")}
    for st in sc["steps"]:
        if st.get("playbook") in ext:
            st.update(ext[st["playbook"]])
    sc["rehearsal"] = {"by": "agent", "kept": keep, "why": {str(k): v for k, v in (kept.get("why") or {}).items()},
                       "forced": kept.get("forced") or []}
    return spb, seg2, sc


def _params_of(s):
    a = s["action"]
    ty = a.get("type")
    if ty == "type":
        return {"text": a.get("text")}
    if ty == "key":
        return {"keys": [a.get("key")]}
    if ty == "scroll":
        return {"by": a.get("by", 0)}
    if ty == "drag":
        return {k: a[k] for k in ("rel_from", "rel_to", "from", "to") if a.get(k) is not None}
    return {}                                    # an upload's file comes from assets.json (recorder.resolve_assets)


def plan_beat_of(compiled_id, seg):
    """A compiled beat id (b3, b3p0, b3q1) → the plan beat it was written for."""
    ids = [b.get("id") for b in seg.get("beats") or []]
    if compiled_id in ids:
        return compiled_id
    m = re.match(r"^(.*?)[pq]\d+$", str(compiled_id or ""))
    return m.group(1) if m and m.group(1) in ids else None


# ───────────────────────── the orchestration (used by recorder.Recorder) ─────────────────────────

def rehearse_segment(rec, i, seg, pb, sess, kind, *, feedback=None, prior=None, from_beat=None):
    """Agent pass → distill → write → fresh replay (re-distilled once with the failure). → dict:
    {"ok": True, "script", "pb", "seg", "run"} | {"ok": False, "status", "why", "wall", "beat"}.
    prior = the previous attempt's {"run", "kept"}: its steps for the beats BEFORE from_beat are kept as they were and
    replayed dry to reach the divergence point; the agent works on from there."""
    from . import recorder as R
    sd = rec.w / f"seg-{i:02d}"
    sd.mkdir(parents=True, exist_ok=True)
    r = rules()
    plan = sorted([dict(b) for b in seg.get("beats") or [] if b.get("t_word") is not None], key=lambda b: b["t_word"])
    k0 = next((k for k, b in enumerate(plan) if b.get("id") == from_beat), 0) if from_beat else 0

    def open_start():
        R.open_clean(sess, pb, seg, B.start_state_for(seg, pb, rec.assets), rec.log, account=rec.account, pixels=rec.pixels, session=kind)

    agent = SegmentAgent(sess, seg, pb, seg_idx=i, kind=kind, assets=rec.assets, call=rec.rehearse_call, budget=rec.rehearsal_budget,
                         log=rec.log, job=llm.context().get("job"), sleep=rec.sleep, open_start=open_start,
                         turns_left=max(0, int(r["max_turns_per_segment"]) - rec.rehearsal_turns.get(i, 0)))
    try:
        open_start()
        prefix_keep = []
        if prior and k0:
            # the kept steps of the beats before the divergence point: replayed dry, kept as they were
            done = {b["id"] for b in plan[:k0]}
            old = prior["run"]["steps"]
            for s in old:
                if s["beat"] in done and (s["i"] in prior["kept"]["keep"] or s.get("code")):
                    ns = {**s, "i": len(agent.steps)}
                    if s["i"] in prior["kept"]["keep"]:
                        prefix_keep.append(ns["i"])
                        if prior["run"].get("main", {}).get(s["beat"]) == s["i"]:
                            agent.main[s["beat"]] = ns["i"]
                    agent.steps.append(ns)
                    a = {k: v for k, v in s["action"].items() if k not in ("asset", "unproven_target", "reveal_of")}
                    if s.get("generates"):
                        a["press"] = False
                    agent._send({"cmd": "act", "action": a})
            agent.proof.update({b: p for b, p in (prior["run"].get("proof") or {}).items() if b in done})
        out = agent.run(plan[k0:], feedback=feedback)
    except R.SetupError as e:
        if e.wall:
            return {"ok": False, "status": "wall", "why": str(e), "wall": e.wall}
        return {"ok": False, "status": "held", "why": f"start state: {e}"}
    except WallHit as e:
        return {"ok": False, "status": "wall", "why": str(e), "wall": e.wall}
    except Capped as e:
        return {"ok": False, "status": "rehearsal_capped", "why": str(e), "final": True}
    finally:
        rec.rehearsal_turns[i] = rec.rehearsal_turns.get(i, 0) + agent.turns
        rec.usd += agent.usd
        _save_log(sd, agent, feedback, from_beat)
        rec.log(f"rehearsal: screencast {i + 1}: {agent.turns} agent turn(s), ${agent.usd:.3f}"
                + (f" (escalated to {agent.esc_model})" if agent.escalated else ""))
    if not out["ok"]:
        return {"ok": False, "status": "rehearsal_failed", "why": out["why"]}
    run = out
    previous, fb = None, None
    for attempt in range(1 + int(r["redistill"])):
        kept = distill(run, plan, call=rec.rehearse_call, budget=rec.rehearsal_budget, seg_idx=i, feedback=fb,
                       previous=previous, log=rec.log)
        rec.usd += kept.get("usd", 0.0)
        if prior and k0:
            kept["keep"] = prune(sorted(set(kept["keep"]) | set(prefix_keep)), run["steps"])
        for s in run["steps"]:
            s["kept"] = s["i"] in kept["keep"]
        try:
            spb, seg2, sc = build(seg, pb, run, kept, rec.words, seg_idx=i, assets=rec.assets, live_left=rec.live_left,
                                  doodles=rec._doodles())
        except B.CompileError as e:
            return {"ok": False, "status": "rehearsal_failed", "why": f"the agent's script does not compile: {e}"}
        missing = R.resolve_assets(sc, rec.assets, getattr(sess, "workdir", None))
        if missing:
            return {"ok": False, "status": B.NEEDS_ASSET, "why": "results not made off camera yet (assets.json): "
                    + ", ".join(sorted(set(map(str, missing)))), "final": True}
        bad = prove(sess, spb, seg2, sc, kind, rec)
        _save_script(sd, sc, kept, attempt, bad)
        if bad is None:
            remember(spb.get("app"), lessons(run["steps"], plan))
            return {"ok": True, "script": sc, "pb": spb, "seg": seg2, "run": run, "kept": kept}
        if bad.get("status") == "wall":
            return bad
        rec.log(f"rehearsal: screencast {i + 1}: the distilled script failed its fresh replay at {bad.get('beat')} "
                f"({str(bad.get('why'))[:140]})" + (" — distilling again with the failure" if attempt < int(r["redistill"]) else ""))
        previous, fb = kept["keep"], f"beat {bad.get('beat')}: {bad.get('why')}"
    return {"ok": False, "status": "replay_failed", "why": fb, "beat": plan_beat_of(bad.get("beat"), seg), "run": run, "kept": kept}


def prove(sess, spb, seg2, sc, kind, rec):
    """ONE off-camera replay of the script from a FRESH start (open_clean + play_script record=False, fingerprints
    captured for single-beat retakes). → None (it reproduces) or {"beat", "why", "status"}."""
    from . import recorder as R
    try:
        R.open_clean(sess, spb, seg2, sc.get("start_state"), rec.log, account=rec.account, pixels=rec.pixels, session=kind)
        sc["start_state"]["fingerprint"] = (sess.send({"cmd": "fp"}) or {}).get("fp")
        R.play_script(sess, sc, record=False, log=rec.log, session=kind, fingerprints=True)
        return None
    except R.SetupError as e:
        return {"beat": None, "why": f"start state: {e}", "status": "wall" if e.wall else "replay", "wall": e.wall}
    except R.Retake as e:
        if e.wall and e.wall.get("kind") in R.DROP_KINDS:
            return {"beat": e.beat, "why": e.why, "status": "wall", "wall": e.wall}
        return {"beat": e.beat, "why": e.why, "status": "replay"}


def _save_log(sd, agent, feedback, from_beat):
    p = Path(sd) / "rehearsal-log.json"
    try:
        doc = json.loads(p.read_text()) if p.exists() else {"passes": []}
    except (OSError, ValueError):
        doc = {"passes": []}
    doc["passes"].append({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "from_beat": from_beat,
                          "feedback": feedback, "turns": agent.turns, "usd": round(agent.usd, 6),
                          "escalated": agent.escalated, "steps": agent.steps, "main": agent.main, "notes": agent.notes})
    try:
        p.write_text(json.dumps(doc, indent=1, default=str))
    except OSError:
        pass


def _save_script(sd, sc, kept, attempt, bad):
    try:
        (Path(sd) / "script.compiled.json").write_text(json.dumps({k: v for k, v in sc.items() if k != "assets"}, indent=1))
        (Path(sd) / f"rehearsal-distill-{attempt + 1}.json").write_text(json.dumps({**kept, "replay": bad or "ok"}, indent=1,
                                                                                   default=str))
    except OSError:
        pass
