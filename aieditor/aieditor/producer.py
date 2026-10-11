"""THE PRE-PRODUCTION PRODUCER AGENT — "produce asset X that matches description D (optionally made from inputs Y) in
app A's UI, off camera" (Jake 2026-10-10, binding):

  "It doesn't need an image key — it needs to generate images in the ChatGPT UI."
  "I want this pre production agent to be smart and find the ways itself instead of you always fixing it - so the
   solutions that you will come up with should be scalable."

What happened before it (TEST v3): the raw narration was pasted into a plain chat, ChatGPT answered in TEXT, and the
old producer polled 240 s x 10 tries (~28 min) without ever asking why. This agent asks why after EVERY failed try.

The loop (same family as onboard.Explorer: a capped model loop behind the click guard, on a Scout-profile COPY, under
the account lock the dispatcher holds, in fresh chats only):

  1. FAST PATH: the route this video already learned (job playbook "recipes") — else the app's hint recipe (the
     shared playbook's "produce.recipes", i.e. the proven hand route) — executed step by step from the playbook's own
     actions, each step's post assert polled (an upload that did not attach is caught BEFORE a generation is spent).
  2. WAIT: the result selector, the progress texts, the new thread text, walls/limits — polled; fail fast: no image
     and no progress after 90 s → diagnosed now (TEST v3 waited 240 s).
  3. DIAGNOSE the page after a failed try → one class: text_answer | refusal | limit_wall | still_generating |
     upload_missing | wrong_mode | mismatch | no_progress | ui_step_failed. Hard signals are classified by code
     (a wall/limit always stops: code, not the model).
  4. PICK ANOTHER ROUTE ITSELF: one model call (Opus, the planning key) sees the goal, the diagnosis, the reply text,
     the routes already tried, this video's playbook actions + the app's produce roles + UI kit, and the CURRENT
     screen (screenshot + elements) → a new route (playbook action ids and/or guarded raw acts, a prompt). Without a
     model or with an invalid answer, a generic fallback planner builds routes from the playbook's produce ROLES
     (image mode, images page, upload, rephrase, the app's own tool on a prior result...).
  5. Every image is VISION-CHECKED against D; a failed check feeds its missing objects into the next route.
  6. LEARN: the route that worked is written as a recipe into THIS video's playbook (job/preprod/playbook-<app>.json:
     recipes.produce_photo / produce_edit / produce_edit:<tool>) — the shared skill playbook is only read. The next
     asset of the job tries the learned recipe first.

FIDELITY (Jake 2026-10-10, TEST v3 — every "resize result" was a new, different bottle, the planner's internal
description was typed into the composer, and the vision check passed them all):
  - a tool result ("the result of the app's <tool> on <source>") runs the TOOL: the playbook's produce.tools picks it
    from the description (data, not the planner); the route opens the source picture in the chat where this job made
    it and runs the tool's actions; a tool step this video's playbook lacks is onboarded first (P2 explorer); only
    when the tool route fails every try does it fall back to a described edit (logged);
  - continuity: a result made from a source is vision-checked WITH the source attached; "different_subject" is its
    own failure class whose next route is the edit / tool on the source, never a fresh generation;
  - the look (real | impressive | faithful) is scored by the same check; "wrong_look" rewords the next try (an
    on-screen prompt stays verbatim);
  - a picture that is not a picture the video shows (a camera move) never reaches the app (onboard.not_a_picture).

Nothing app-specific lives in this file: selectors, roles, progress/limit/refusal texts and the hint recipes come from
the app's playbook ("produce" section), so the same agent runs Claude, Gemini or Canva with a different playbook.

Limits (code): per-asset time budget (default 12 min); genledger daily generations per app (default 35 / 24 h for
chatgpt, across jobs) → QuotaWait (the job WAITS in the queue, never held); a wall or a limit message stops every
generation of the app at once (a ledger block); generations >= 45 s apart (across jobs); every try logged in plain
words; the status line "Making assets: 3/14 ready (phone_photo: try 2, Create image mode)".
Hard rules (Guarded + clickguard): no delete/buy/upgrade/billing/publish/share/invite/log out; never one of the
account's existing chats; profile copies only.
"""
import copy
import json
import re
import shutil
import time
from pathlib import Path

from . import config, genledger, llm, playbook, skill

CLASSES = ("text_answer", "refusal", "limit_wall", "still_generating", "upload_missing", "wrong_mode", "mismatch",
           "no_progress", "ui_step_failed", "logged_out", "different_subject", "wrong_look", "not_clean")
CLASS_WORDS = {"text_answer": "answered in text", "refusal": "refused the request",
               "limit_wall": "showed a limit / wall message", "still_generating": "was still generating",
               "upload_missing": "did not attach the upload", "wrong_mode": "was not in the right mode",
               "mismatch": "made a picture that does not match", "no_progress": "showed no image and no progress",
               "ui_step_failed": "a step did not land", "logged_out": "is not logged in (the session, not a limit)",
               "different_subject": "made a different subject than its source picture",
               "wrong_look": "made a picture with the wrong look",
               "not_clean": "put UI chrome / captions / a collage into the picture"}
CLEAN_ASK = "One single plain picture: no text, captions, labels, arrows, app interface, before/after split or collage."
FIDELITY_V = 2            # a stored row checked for look + continuity + no UI chrome (reuse needs it)
DEFAULT_REFUSAL = [r"I can(?:'|’)t (?:help|create|make|generate)", r"I(?:'|’)m (?:not able|unable) to", r"content polic"]
DEFAULT_LIMIT = [r"\blimit\b.{0,40}\b(?:reached|hit)\b", r"\b(?:reached|hit)\b.{0,30}\blimit\b", r"Too many requests"]
CHAT_RX = re.compile(r"/c/[\w-]+")
RAW_TYPES = ("click", "type", "key", "hover", "scroll", "upload", "hold")
PEOPLE_RX = re.compile(r"\b(?:person|people|man|woman|child|kid|face|celebrity|brand|logo of [A-Z]\w+)\b", re.I)


def rules():
    return (skill.rules().get("onboarding") or {}).get("producer") or {}


def _hint_produce(app):
    try:
        pb = playbook.load(app)
        return {**copy.deepcopy(pb.get("produce") or {}), **({"name": pb["name"]} if pb.get("name") else {})}
    except Exception:  # noqa: BLE001 — an app with no shared playbook: only this video's
        return {}


def _strip_kit(o, depth=0):
    if isinstance(o, dict):
        return {k: _strip_kit(v, depth + 1) for k, v in o.items()
                if k not in ("css", "html", "item_html", "row_html", "screenshots", "private_check", "tokens", "fonts")}
    if isinstance(o, list):
        return [_strip_kit(v, depth + 1) for v in o[:12]]
    return o


class Producer:
    """One app, one job. produce() → an assets.json row; raises genledger.QuotaWait (wait, never hold) or
    InterruptedError (the job was cancelled)."""

    def __init__(self, ctx, clock=time.time, sleep=time.sleep):
        self.ctx, self.clock, self.sleep = ctx, clock, sleep
        r = rules()
        hint = _hint_produce(ctx.app)
        self.spec = {**hint, **(ctx.pb.get("produce") or {})}
        self.hint_recipes = hint.get("recipes") or {}
        self.time_budget = float(r.get("asset_time_budget_s", 720))
        self.max_tries = int(r.get("max_tries_per_asset", 10))
        self.fail_fast = float(r.get("fail_fast_s", 90))
        self.max_wait = float(r.get("max_wait_s", 240))
        self.poll = float(r.get("poll_s", 3))
        self.model = r.get("model") or config.PLAN_MODEL
        self.app_name = ctx.pb.get("name") or self.spec.get("name") or ctx.app
        self.chats = []
        self.job = Path(ctx.out).parent.name
        self.cur = {}                                  # this asset: source, tool, look, wording
        self.tool_tries = int(r.get("tool_tries", 2))

    # ── small helpers ──
    def _log(self, msg):
        self.ctx.log(msg)

    def _status(self, msg):
        fn = getattr(self.ctx, "status", None)
        if fn:
            fn(msg)

    def _cancel(self):
        fn = getattr(self.ctx, "cancelled", None)
        if fn and fn():
            raise InterruptedError("cancelled")

    def _rx(self, key, default=()):
        out = []
        for p in list(self.spec.get(key) or default):
            try:
                out.append(re.compile(p, re.I))
            except re.error:
                pass
        return out

    def roles(self):
        return self.spec.get("roles") or {}

    # ── the app's own tools (data: playbook produce.tools) ──
    def tools(self):
        return self.spec.get("tools") or {}

    def tool_spec(self, tool):
        return copy.deepcopy(self.tools().get(tool) or {})

    def tool_of(self, desc):
        """The app tool an asset is the result of, from the playbook's data (first match wins), or None."""
        d = str(desc or "")
        best = None                                     # the tool NAMED FIRST wins ("Resize result: same bottle cutout…"
        for k, t in self.tools().items():               # is a resize, not a remove-BG — re-run 13)
            for rx in t.get("match") or []:
                try:
                    m = re.search(rx, d, re.I)
                except re.error:
                    continue
                if m and (best is None or m.start() < best[0]):
                    best = (m.start(), k)
        return best[1] if best else None

    def ensure_tool_action(self, tool, i, st, params):
        """A tool step named by its NEED (not yet an action of this video's playbook) → onboarded once (P2 explorer,
        on the source's chat) and remembered in this video's playbook (produce.tool_actions). → (action id, why)."""
        from . import onboard
        # the per-param target is the OBJECT only — action verbs from the narration ("…, and click send") are never
        # folded into a step's need (re-run 15: the erase brush need became "brush … AND click Send")
        params = onboard.clean_tool_params(self.tool_spec(tool), params)
        slot = f"{tool}.{i}" + (f".{_slug(params.get(st['per_param']))}" if st.get("per_param") else "")
        known = ((self.ctx.pb.get("produce") or {}).get("tool_actions") or {}).get(slot)
        if known and known in (self.ctx.pb.get("actions") or {}):
            return known, None
        need = playbook._fill(st["need"], {k: v for k, v in params.items() if isinstance(v, str)})
        reuse = self.proven_for(tool, i, need)
        if reuse:
            self._log(f"producer: the {tool} tool's step {i} is already proven in this video's playbook ('{reuse}') — reused")
            self.ctx.pb.setdefault("produce", {}).setdefault("tool_actions", {})[slot] = reuse
            self.ctx.pb = onboard.save_job_playbook(self.ctx.pb, self.ctx.out, self.ctx.app)
            return reuse, None
        if st.get("text"):
            need += " (the note text is DATA given at record time: param 'text')"
        chat = (self.cur.get("source") or {}).get("chat")
        old = self.ctx.image_chat
        if chat:
            self.ctx.image_chat = chat
            self.ctx.allowed_chats.add(chat)
        self._log(f"producer: the {tool} tool needs a step this video's playbook does not have yet — onboarding it: {need[:120]}")
        self._status(f"Learning the {tool} tool: {need[:70]}")      # the status line never freezes on the last asset
        try:
            row = onboard.onboard_action(self.ctx, need, {"text": params.get("prompt")} if st.get("text") else None,
                                         generates=False, generating=bool(st.get("generates")),
                                         chain=list(getattr(self, "_chain", []) or []))
        except Exception as e:  # noqa: BLE001 — BudgetSpent / a broken explorer: the tool route is not available
            row = {"status": "failed", "why": str(e)}
        finally:
            self.ctx.image_chat = old
        if row.get("status") == "absent" and st.get("text") and self.roles().get("prompt") in (self.ctx.pb.get("actions") or {}):
            # the app has no separate note box for this tool (re-run 13: Markup's instruction goes in the composer) —
            # its text step IS the app's normal prompt action; generic, any app
            self._log(f"producer: the {tool} tool has no separate note box — its text goes in the prompt "
                      f"('{self.roles()['prompt']}')")
            return self.roles()["prompt"], None
        if row.get("status") != "proven":
            return None, f"step '{need[:80]}' could not be onboarded: {row.get('why') or row.get('status')}"
        aid = row["action_id"]
        self.ctx.pb.setdefault("produce", {}).setdefault("tool_actions", {})[slot] = aid
        self.ctx.pb = onboard.save_job_playbook(self.ctx.pb, self.ctx.out, self.ctx.app)
        return aid, None

    def proven_for(self, tool, i, need):
        """A step of this tool already PROVEN in this video's playbook that serves this need: the same need text (the
        action's onboarding source), or the same tool step whose target is data at use time (a drag / draw / brush:
        the located points are passed in, so one proven action serves every object). → action id or None."""
        from . import onboard
        acts = self.ctx.pb.get("actions") or {}
        key = onboard._need_key(need)

        def proven(aid):
            a = acts.get(aid) or {}
            vp = a.get("video_proof") or {}
            return bool(a) and (vp.get("ok") or vp.get("mode") in ("onboarded",) or str(vp.get("mode", "")).startswith("reused")
                                or a.get("proven"))
        for aid, a in acts.items():
            src = str(a.get("source") or "")
            if src.startswith("R14 P2 onboarding") and onboard._need_key(src.split(":", 1)[-1]) == key and proven(aid):
                return aid
        for slot, aid in ((self.ctx.pb.get("produce") or {}).get("tool_actions") or {}).items():
            if slot.split(".")[:2] == [tool, str(i)] and proven(aid) and (acts.get(aid) or {}).get("kind") in ("drag", "draw"):
                return aid
        return None

    def tool_route(self, tool, params):
        """The route that RUNS the app's tool (on the source picture when the tool acts on one). → (route, why)."""
        t = self.tool_spec(tool)
        if not t:
            return None, f"no tool '{tool}' in the playbook"
        on_source = t.get("on_source", True)
        src = self.cur.get("source") or {}
        if on_source and not src.get("chat"):
            return None, "the source picture has no chat this job made it in (nothing to open it in)"
        steps = []
        for i, st in enumerate(t.get("steps") or []):
            if st.get("action"):
                steps.append({"action": st["action"], **({"params": dict(st["params"])} if st.get("params") else {})})
                continue
            # the steps already in this tool's chain are what this step needs first (the Logo name box only exists
            # after "open the card → Try it" — re-run 14): its proof replays them
            self._chain = [s_["action"] for s_ in steps if s_.get("action")]
            aid, why = self.ensure_tool_action(tool, i, st, params)
            if not aid:
                return None, why
            steps.append({"action": aid, **({"params": {"text": "{prompt}"}} if st.get("text") else {})})
        acts = self.ctx.pb.get("actions") or {}
        if steps and not any(self._is_gen(s_) for s_ in steps):
            return None, f"the {tool} tool's steps start no generation"
        for s_ in steps:
            if s_.get("action") and s_["action"] not in acts:
                return None, f"the {tool} tool's step '{s_['action']}' is not in this video's playbook"
        return {"name": f"the app's {t.get('label') or tool} tool" + (" on the source picture" if on_source else ""),
                "start": "source_chat" if on_source else (t.get("start") or "home"), "steps": steps, "via": "tool",
                "key": f"produce_edit:{tool}", "tool": tool, "no_prompt": not t.get("typed")}, None

    def described_edit(self, why):
        """The last resort for a tool result: the source uploaded + the change asked in words (logged)."""
        ro = self.roles()
        steps = ([{"action": ro["upload"], "params": {"files": "{files}"}}] if ro.get("upload") else []) + \
            ([{"action": ro["prompt"], "params": {"text": "{prompt}"}}] if ro.get("prompt") else []) + \
            ([{"action": ro["generate"]}] if ro.get("generate") else [])
        r = {"name": "a described edit (the tool route failed)", "start": "home", "steps": steps, "via": "fallback",
             "key": "produce_edit", "prompt": self.cur.get("as_words") or self.cur.get("prompt") or "", "described": True}
        self._log(f"producer: {why} — falling back to a described edit (the source uploaded + the change in words)")
        return r

    # ── routes ──
    def recipe_key(self, inputs, tool=None):
        return f"produce_edit:{tool}" if tool else ("produce_edit" if inputs else "produce_photo")

    def first_route(self, key):
        learned = (self.ctx.pb.get("recipes") or {}).get(key)
        if learned:
            return {**copy.deepcopy(learned), "via": "learned", "key": key}
        hint = self.hint_recipes.get(key)
        if hint:
            return {**copy.deepcopy(hint), "via": "hint", "key": key}
        return self.fallback_routes("no_progress", key, bool(key != "produce_photo"))[0]

    def _gen_steps(self, inputs):
        ro = self.roles()
        steps = []
        if inputs and ro.get("upload"):
            steps.append({"action": ro["upload"], "params": {"files": "{files}"}})
        if ro.get("prompt"):
            steps.append({"action": ro["prompt"], "params": {"text": "{prompt}"}})
        if ro.get("generate"):
            steps.append({"action": ro["generate"]})
        return steps

    def fallback_routes(self, cls, key, inputs, last=None, missing=None, subject=None):
        """Generic routes built from the app's produce ROLES (no app names): the agent's fallback planner."""
        ro = self.roles()
        mode = [{"action": a} for a in (ro.get("image_mode") or [])]
        out = []
        img_mode = {"name": "image mode" if not mode else f"{self._label(ro['image_mode'][-1])} mode", "start": "home",
                    "steps": mode + self._gen_steps(inputs), "via": "fallback", "key": key}
        page = ({"name": f"{self._label(ro['images_page'])}", "start": ro["images_page"],
                 "steps": self._gen_steps(inputs), "via": "fallback", "key": key} if ro.get("images_page") else None)
        plain = {"name": "a fresh chat, asked for the picture", "start": "home", "steps": self._gen_steps(inputs),
                 "prompt_template": "Make a picture (an image, not a description) of this: {style}{subject}",
                 "via": "fallback", "key": key}
        rephrase = {**copy.deepcopy(img_mode if mode else plain), "name": "a rephrased, visible-only prompt",
                    "rephrase": True}
        if cls in ("different_subject", "wrong_look", "not_clean") or (inputs and cls == "mismatch" and (last or {}).get("via") == "tool"):
            # never a fresh generation for a picture made FROM a source: the tool / the edit on the source again
            src = self.cur.get("source") or {}
            if self.cur.get("tool") and src.get("chat"):
                tr, _ = self.tool_route(self.cur["tool"], self.cur.get("params") or {})
                if tr:
                    out.append({**tr, "name": tr["name"] + " (again)", "again": 1})
            if inputs:
                edit = {"name": "the source uploaded + the change asked (same subject)", "start": "home",
                        "steps": self._gen_steps(True), "via": "fallback", "key": key, "keep_subject": True}
                out.append(edit)
                out.append({**edit, "name": "the source in the image mode + the change asked", "steps": mode + self._gen_steps(True)})
            elif cls in ("wrong_look", "not_clean"):
                out += ([img_mode] if mode else []) + [plain]
            return [dict(r, look_boost=1) if cls == "wrong_look" else dict(r, clean_boost=1) if cls == "not_clean" else r
                    for r in out if r]
        if cls == "mismatch" and last:
            again = copy.deepcopy(last)
            again.update(name=f"{last.get('name')} + the missing objects named", via="fallback", missing=missing or [])
            out.append(again)
            if page:
                out.append({**page, "missing": missing or []})
            out.append({**rephrase, "missing": missing or []})
        elif cls == "refusal":
            out += [rephrase] + ([page] if page else [])
        elif cls == "upload_missing" and last:
            out += [{**copy.deepcopy(last), "name": f"{last.get('name')} (upload again)", "via": "fallback"}, img_mode]
        else:                                    # text_answer / wrong_mode / no_progress / ui_step_failed
            out += ([img_mode] if mode else []) + ([page] if page else []) + [plain, rephrase]
        return [r for r in out if r]

    def _label(self, aid):
        a = (self.ctx.pb.get("actions") or {}).get(aid) or {}
        return str(a.get("label") or aid)

    def _sig(self, route):
        return json.dumps([route.get("start"), route.get("steps"), route.get("prompt"), route.get("rephrase"),
                           route.get("prompt_template"), sorted(route.get("missing") or []), route.get("again"),
                           route.get("look_boost"), route.get("keep_subject"), route.get("clean_boost")], sort_keys=True, default=str)

    # ── prompts ──
    def make_prompt(self, route, subject, style, inputs, missing):
        from . import onboard
        if route.get("no_prompt"):
            return ""                                  # the tool's click: no text at all
        if self.cur.get("verbatim") and self.cur.get("prompt"):
            # his on-screen prompt (+ the impressive paragraph): NO route may rewrite it (TEST v3 re-run 4: the planner
            # swapped it for "a single-line prompt naming all objects"); a miss may only add its objects at the end
            p = str(self.cur["prompt"]).strip()
            miss = [m for m in (missing or route.get("missing") or []) if m]
            if miss:
                p = p.rstrip(". ") + ". It must clearly show " + ", ".join(miss) + "."
            return " ".join(p.split())                 # one line: a newline in a composer can send early
        if route.get("prompt") is not None and route.get("prompt") != "" and (self.cur.get("verbatim") or not route.get("look_boost")):
            p = route["prompt"]
        elif route.get("look_boost") and not self.cur.get("verbatim"):
            base = self.cur.get("base") or route.get("prompt") or subject
            look = self.cur.get("look") or "real"
            if self.cur.get("new_photo") and not route.get("prompt"):
                tpl = self.spec.get("prompt_template") or "{style}{subject}"
                p = tpl.replace("{style}", onboard.look_style(look, boost=1)).replace("{subject}", onboard.with_look(subject, look, cues=False))
            else:
                p = onboard.with_look(base, look, boost=1)
        elif route.get("keep_subject") and inputs:
            p = (self.cur.get("as_words") or self.cur.get("prompt") or subject or "").strip()
            p = f"Keep the exact same subject as in the attached picture (same object, same label, same scene); change only this: {p}"
        else:
            tpl = route.get("prompt_template") or (self.spec.get("edit_template") if inputs else None) \
                or self.spec.get("prompt_template") or "{style}{subject}"
            subj = rephrase(subject) if route.get("rephrase") else subject
            p = tpl.replace("{style}", style or "").replace("{subject}", subj)
        miss = [m for m in (missing or route.get("missing") or []) if m]
        if miss:
            p = p.rstrip(". ") + ". It must clearly show " + ", ".join(miss) + "."
        if route.get("clean_boost") and not self.cur.get("verbatim"):
            p = p.rstrip(". ") + ". " + CLEAN_ASK
        return " ".join(p.split())                     # one line: a newline in a composer can send early

    # ── one try ──
    def _start_url(self, route):
        st = route.get("start") or "home"
        acts = self.ctx.pb.get("actions") or {}
        if st == "result_chat" and self.chats:
            return self.chats[-1]
        if st == "source_chat" and (self.cur.get("source") or {}).get("chat"):
            return self.cur["source"]["chat"]
        if st in acts and acts[st].get("kind") == "goto":
            return acts[st]["url"]
        return self.ctx.pb["start_state"]["url"]

    def _is_gen(self, step):
        acts = self.ctx.pb.get("actions") or {}
        if step.get("action"):
            return bool((acts.get(step["action"]) or {}).get("generates"))
        a = step.get("act") or {}
        return a.get("type") == "key" and str(a.get("key", "")).lower() in ("enter", "numpadenter")

    def _role_of(self, aid):
        ro = self.roles()
        if aid == ro.get("upload"):
            return "upload_missing"
        if aid in (ro.get("image_mode") or []):
            return "wrong_mode"
        return "ui_step_failed"

    def _gate(self, aid, n, route):
        """The generation ledger: spaced across jobs, capped per day, stopped by a block → QuotaWait."""
        w = genledger.gate(self.ctx.app, self.clock())
        if w > 0:
            self.sleep(w)
        genledger.record(self.ctx.app, self.job, aid, n, route.get("name"), now=self.clock())

    def attempt(self, route, aid, n, prompt, inputs, deadline):
        """→ {"file", "chat_url", "diag": {class, why, evidence}, "obs", "generated": bool}"""
        ctx = self.ctx
        tr = ctx.guarded(allow_generate=True)
        res = {"file": None, "chat_url": None, "diag": None, "generated": False, "obs": None}
        try:
            sess = _session(tr, ctx.pb)
            wd = Path(getattr(getattr(tr, "t", None), "workdir", None) or (Path(ctx.out) / "producer" / "w"))
            sel = self.spec.get("result_selector") or ""
            if route.get("wait_only") and self.chats:
                ok, why = sess.open(self.chats[-1])
                n0, text0 = 0, ""
            else:
                ok, why = sess.open(self._start_url(route))
                n0 = int(tr.send({"cmd": "count", "selector": sel}).get("n", 0) or 0) if sel else 0
                text0 = (tr.send({"cmd": "text"}) or {}).get("text", "")
            if not ok:
                res["diag"] = {"class": _wall_class(why) if "wall" in str(why) else "ui_step_failed", "why": f"start: {why}"}
                return res
            w = (tr.send({"cmd": "guard"}) or {}).get("wall")
            if w:
                res["diag"] = {"class": _wall_class(w), "why": f"wall on open: {w}"}
                return res
            files = []
            for f in inputs or []:
                (wd / "upload").mkdir(parents=True, exist_ok=True)
                d = wd / "upload" / Path(f).name
                shutil.copyfile(f, d)
                files.append(f"/w/upload/{d.name}")
            src = self.cur.get("source") or {}
            params = {**{k: v for k, v in (self.cur.get("params") or {}).items()}, "prompt": prompt, "files": files,
                      "nth": int(src.get("nth") or 0)}
            if not route.get("wait_only"):
                done = set()
                for st in route.get("steps") or []:
                    self._cancel()
                    if self._is_gen(st):
                        self._gate(aid, n, route)
                        res["generated"] = True
                    bad = self._step(sess, tr, st, params, done)
                    if bad:
                        res["diag"] = bad
                        res["obs"] = tr.send({"cmd": "observe"})
                        return res
                if not res["generated"]:
                    res["diag"] = {"class": "ui_step_failed", "why": "the route has no step that starts a generation"}
                    return res
            # a tool run from an overlay (the image viewer) shows its result IN the overlay while the thread — where
            # results are counted and progress is read — is hidden behind it: close the overlay after the generating
            # press (re-run 12: Remove BG's cutout was misread as "a text reply" 3x). Data, per app: produce.overlay_close
            for oc in (self.spec.get("overlay_close") or []):
                try:
                    if (tr.send({"cmd": "count", "selector": oc}) or {}).get("n"):
                        self.sleep(1.5)
                        tr.send({"cmd": "act", "action": {"type": "click", "selector": oc}})
                        self.sleep(1.0)
                except Exception:  # noqa: BLE001 — the wait still runs
                    pass
            out = self._wait(tr, sel, n0, text0, prompt, deadline, wd, aid, n)
            res.update(out)
            if not res.get("file"):
                res["obs"] = tr.send({"cmd": "observe"})
            return res
        finally:
            u = str(((tr.send({"cmd": "text"}) or {}).get("url")) if hasattr(tr, "send") else "")
            m = CHAT_RX.search(u or "")
            if m and (res.get("generated") or route.get("wait_only")):
                url = u if u.startswith("http") else self.ctx.pb["start_state"]["url"].rstrip("/") + m.group(0)
                res["chat_url"] = url
                if url not in self.chats:
                    self.chats.append(url)
                self.ctx.allowed_chats.add(url)
            if res.get("obs") and res["obs"].get("shot"):
                try:
                    ev = Path(self.ctx.out) / "producer" / "shots"
                    ev.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(res["obs"]["shot"], ev / f"{aid}-try{n}.jpg")
                    res["shot"] = str(ev / f"{aid}-try{n}.jpg")
                except (OSError, TypeError):
                    pass
            tr.close()

    def _step(self, sess, tr, st, params, done):
        pb = self.ctx.pb
        files = params.get("files") or []
        if st.get("action") and st["action"] == self.roles().get("upload") and len(files) > 1:
            # several pictures: ONE upload per file, each confirmed before the next (re-run 9: three files in one go
            # never showed as attached — "did not attach the upload" twice); any app with a single-file input works
            for i, f in enumerate(files):
                bad = self._step(sess, tr, st, {**params, "files": [f]}, done)
                if bad:
                    return {**bad, "why": f"file {i + 1} of {len(files)}: {bad.get('why')}"}
                time.sleep(1.0)
            return None
        if st.get("action"):
            aid = st["action"]
            if aid not in (pb.get("actions") or {}):
                return {"class": "ui_step_failed", "why": f"no action '{aid}' in this video's playbook"}
            a = pb["actions"][aid]
            p = {k: (params[v[1:-1]] if isinstance(v, str) and re.fullmatch(r"\{\w+\}", v) and v[1:-1] in params else
                     playbook._fill(v, params) if isinstance(v, str) else v) for k, v in (st.get("params") or {}).items()}
            if a.get("kind") == "drag" and not any(isinstance(p.get(k), list) for k in ("rel_from", "from")) \
                    and not any(isinstance(a.get(k), list) for k in ("rel_from", "from", "points")):
                # a drag whose points are data (a box over the label, a brush over the napkin): locate the target on
                # the source picture (vision), else a centre box — never a drag without points (re-run 12)
                box, src_file = None, (self.cur.get("source") or {}).get("file")
                tgt = str(params.get("target") or (self.cur.get("params") or {}).get("target") or "")
                if tgt and src_file and callable(getattr(self.ctx, "locate", None)):
                    try:
                        box = self.ctx.locate(src_file, tgt)
                    except Exception:  # noqa: BLE001 — the centre box
                        box = None
                if box and len(box) == 4:
                    x0, y0, x1, y1 = [max(0.0, min(1.0, float(v))) for v in box]
                    p.update(rel_from=[x0, y0], rel_to=[x1, y1])
                else:
                    p.update(rel_from=[0.38, 0.42], rel_to=[0.62, 0.58])
            for r in a.get("requires", []):
                if r not in done and not any(x.get("action") == r for x in [st]):
                    try:
                        req_steps = playbook.resolve(pb, r, {**params, **p})
                    except playbook.PlaybookError as e:
                        # a required step that cannot be built is a failed step, never a crash of pre-production
                        # (re-run 14: "param 'text' is required" ended the whole route)
                        return {"class": "ui_step_failed", "why": f"requires {r}: {e}"}
                    for s in req_steps:
                        sess.act(s)
                    done.add(r)
            try:
                steps = playbook.resolve(pb, aid, p)
            except playbook.PlaybookError as e:
                return {"class": self._role_of(aid), "why": f"{aid}: {e}"}
            for s in steps:
                ok, why = sess.act(s)
                if not ok:
                    return {"class": _wall_class(why) if "wall" in str(why) else self._role_of(aid), "why": f"{aid}: {why}"}
            done.add(aid)
            if a.get("generates"):
                return None                    # its result is watched by _wait
            rp = playbook._params(a, p)
            wait = playbook._wait(a) if sess.polls else 0
            if sess.polls and aid == self.roles().get("upload"):
                # a photo upload lands only after the bytes are sent: give it time by size (a 2 MB PNG took > 4 s)
                mb = sum((Path(str(f).replace("/w/", str(getattr(tr, "workdir", "")) + "/", 1)).stat().st_size
                          if Path(str(f).replace("/w/", str(getattr(tr, "workdir", "")) + "/", 1)).exists() else 2_000_000)
                         for f in (p.get("files") or [])) / 1e6
                wait = max(wait, min(45.0, 8.0 + 4.0 * mb))
            for c in a.get("post", []):
                ok, why = playbook._poll(sess, playbook._fill_assert(c, rp), wait)
                if not ok:
                    return {"class": self._role_of(aid), "why": f"{aid} did not land: {why}"}
            return None
        act = dict(st.get("act") or {})
        if act.get("type") not in RAW_TYPES:
            return {"class": "ui_step_failed", "why": f"raw step type {act.get('type')!r} not allowed"}
        for k in ("text",):
            if isinstance(act.get(k), str):
                act[k] = act[k].replace("{prompt}", params["prompt"])
        if act.get("type") == "upload":
            act["files"] = params["files"]
        r = tr.send({"cmd": "act", "action": act})
        if not r.get("ok", True) or r.get("error"):
            return {"class": "upload_missing" if act.get("type") == "upload" else "ui_step_failed",
                    "why": f"{act.get('type')}: {r.get('error') or r.get('refused')}"}
        return None

    def _wait(self, tr, sel, n0, text0, prompt, deadline, wd, aid, n):
        """Watch the page after the generating press → {"file"} or {"diag"}."""
        prog_rx, lim_rx = self._rx("progress_patterns"), self._rx("limit_patterns", DEFAULT_LIMIT)
        wall_rx = [re.compile(p, re.I) for p in (self.ctx.pb.get("walls") or [])]
        ref_rx = self._rx("refusal_patterns", DEFAULT_REFUSAL)
        tg = self.clock()
        calm, last_new, stable, seen_prog, last_change = 0, None, 0, False, tg
        new = ""
        while True:
            self._cancel()
            now = self.clock()
            if now - tg >= self.max_wait or now >= deadline:
                break
            self.sleep(self.poll)
            n1 = int(tr.send({"cmd": "count", "selector": sel}).get("n", 0) or 0) if sel else 0
            tx = tr.send({"cmd": "text"}) or {}
            body = tx.get("text", "") or ""
            new = new_text(text0, body, prompt)
            tail = body[-1500:]
            prog = any(r.search(tail) for r in prog_rx)
            seen_prog = seen_prog or prog
            if any(r.search(new) for r in lim_rx + wall_rx):
                return {"diag": {"class": "limit_wall", "why": "limit / wall message", "evidence": new[-600:]}}
            if n1 > n0 and not prog:
                calm += 1
                if calm >= 2:
                    return self._grab(tr, sel, n1, wd, aid, n)
                continue
            calm = 0
            if new != last_new:
                last_new, stable, last_change = new, 0, self.clock()
            else:
                stable += 1
            if n1 <= n0 and not prog and any(r.search(new) for r in ref_rx) and stable >= 1:
                return {"diag": {"class": "refusal", "why": "the app refused", "evidence": new[-600:]}}
            if n1 <= n0 and not prog and len(new) >= 40 and stable >= 2:
                return {"diag": {"class": "text_answer", "why": "a text reply and no picture", "evidence": new[-600:]}}
            if n1 <= n0 and not prog and not seen_prog and self.clock() - tg >= self.fail_fast:
                return {"diag": {"class": "text_answer" if len(new) >= 40 else "no_progress",
                                 "why": f"no image and no progress after {self.fail_fast:.0f} s", "evidence": new[-600:]}}
            if n1 <= n0 and not prog and seen_prog and self.clock() - last_change >= self.fail_fast:
                return {"diag": {"class": "no_progress", "why": "progress stopped without an image", "evidence": new[-600:]}}
        return {"diag": {"class": "still_generating" if seen_prog else "no_progress",
                         "why": f"no finished image after {self.clock() - tg:.0f} s", "evidence": new[-600:]}}

    def _grab(self, tr, sel, n1, wd, aid, n):
        self.sleep(2)
        g = tr.send({"cmd": "grab", "selector": sel, "nth": n1 - 1, "out": f"/w/{aid}-try{n}.png"}) or {}
        f = str(g.get("file") or "")
        src = wd / f[3:] if f.startswith("/w/") else Path(f) if f else None
        if not g.get("ok", True) or not src or not src.exists():
            return {"diag": {"class": "ui_step_failed", "why": f"the image could not be saved: {g.get('error')}"}}
        keep = Path(self.ctx.out) / "assets" / "tries"
        keep.mkdir(parents=True, exist_ok=True)
        dst = keep / f"{aid}-try{n}.png"
        shutil.copyfile(src, dst)
        return {"file": str(dst), "nth": n1 - 1}

    # ── the agent: diagnose + pick the next route ──
    PLAN_SYSTEM = """You are the pre-production producer of an automated video factory. You make ONE picture inside a web
app's own UI (off camera, a fresh chat or a chat this run made), never with an image API. A try just failed. Read the
diagnosis, the reply text and the CURRENT screen, then choose the next ROUTE yourself from what this app offers: its
playbook actions (ids), its produce roles, what you see on screen (raw acts with plain CSS selectors from the elements,
or text=<exact label>). Ideas, not rules: the app's image mode, its dedicated images page, a rephrased prompt
(visible-only, concrete, no real people, no brands), uploading the input and asking for an edit, the app's own tool on
the prior result (start "result_chat") or on the SOURCE picture where it was made (start "source_chat": the TOOLS listed
are first-class options), splitting a composite into steps, asking plainly in a fresh chat. A picture made FROM a source
must keep the source's subject: after "different_subject" choose the tool / an edit on the source (start
"source_chat", or the source uploaded) — NEVER a fresh generation. Keep every word he narrates; never type internal
words ("result", "in-app", ids). Never repeat a
route that already failed the same way. Never: delete, buy, upgrade, billing, publish, share, invite, log out, or open an
existing chat. Exactly ONE step must start the generation (the playbook's generating action, or Enter in the composer),
and it is the last step. Use "{prompt}" as the text of the prompt step. Answer with the JSON only."""
    KV = {"type": "object", "additionalProperties": False, "required": ["key", "value"],
          "properties": {"key": {"type": "string"}, "value": {"type": "string"}}}
    PLAN_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["failure", "diagnosis", "give_up", "route"],
                   "properties": {
                       "failure": {"type": "string", "enum": list(CLASSES)},
                       "diagnosis": {"type": "string"},
                       "give_up": {"type": "boolean"},
                       "route": {"type": "object", "additionalProperties": False,
                                 "required": ["name", "start", "steps", "prompt", "use_result", "learn_as"],
                                 "properties": {
                                     "name": {"type": "string"},
                                     "start": {"type": "string"},
                                     "steps": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                               "required": ["action", "params", "act"],
                                               # key/value lists, not open objects: structured outputs refuses
                                              # "additionalProperties: <schema>" (HTTP 400 live, TEST v3 2026-10-10)
                                              "properties": {"action": {"type": "string"},
                                                              "params": {"type": "array", "items": KV},
                                                              "act": {"type": "array", "items": KV}}}},
                                     "prompt": {"type": "string"},
                                     "use_result": {"type": "boolean"},
                                     "learn_as": {"type": "string"}}}}}

    def plan_next(self, goal, diag, tried, last, obs, key):
        if getattr(self.ctx, "llm", None) is None:
            return None
        from . import onboard
        kit = {}
        try:
            kp = Path(self.ctx.out) / "ui-kits" / self.ctx.kit_app / "kit.json"
            if not kp.exists():
                from . import uikits
                kp = uikits.root() / self.ctx.kit_app / "kit.json"
            kit = _strip_kit(json.loads(kp.read_text())) if kp.exists() else {}
        except (OSError, ValueError):
            kit = {}
        tools = {k: {"label": t.get("label"), "on_source": t.get("on_source", True), "typed": t.get("typed"),
                     "steps": t.get("steps")} for k, t in self.tools().items()}
        static = (f"APP: {self.app_name}. GOAL: {goal}\nTHIS VIDEO'S PLAYBOOK:\n{onboard._pb_summary(self.ctx.pb)}\n"
                  f"PRODUCE ROLES: {json.dumps(self.roles())}\nTHE APP'S TOOLS (first-class routes; the tool actions "
                  f"this video has: {json.dumps((self.ctx.pb.get('produce') or {}).get('tool_actions') or {})}): "
                  f"{json.dumps(tools)[:2500]}\nUI KIT (summary): {json.dumps(kit)[:2500]}\n"
                  "Step shape: {\"action\": \"<playbook id>\", \"params\": {...}, \"act\": {}} or "
                  "{\"action\": \"\", \"params\": {}, \"act\": {\"type\": \"click|type|key|hover|scroll\", \"selector\"|\"target\": ..., \"text\"|\"key\": ...}}. "
                  "start: home | result_chat | source_chat | <a goto action id>.")
        src = self.cur.get("source") or {}
        dyn = [{"type": "text", "text": f"FAILURE CLASS: {diag.get('class')}\nSOURCE picture: "
                + (f"'{src.get('id')}' (" + ("start source_chat to open it where it was made" if src.get("chat") else "upload it")
                   + ")" if src.get("id") else "none")
                + (f"; the app tool for this picture: {self.cur.get('tool')}" if self.cur.get("tool") else "")
                + f"\nFAILED TRY: {json.dumps(diag)[:1500]}\nLAST ROUTE: {json.dumps(_route_view(last))[:1500]}\n"
                                        f"ROUTES TRIED: {json.dumps(tried)[:2500]}\n"
                                        f"SCREEN url={(obs or {}).get('url')}"}]
        if (obs or {}).get("items"):
            dyn.append({"type": "text", "text": "ELEMENTS: " + json.dumps([{k: i.get(k) for k in ("ref", "tag", "text", "box")}
                                                                          for i in obs["items"][:100]])[:7000]})
        from .onboard import _shot_block
        sb = _shot_block(src.get("file")) if src.get("file") else None
        if sb:
            dyn += [{"type": "text", "text": "THE SOURCE PICTURE (its subject must stay):"}, sb]
        img = _shot_block((obs or {}).get("shot"))
        if img:
            dyn += [{"type": "text", "text": "THE CURRENT SCREEN:"}, img]
        msgs = [{"role": "user", "content": [{"type": "text", "text": static, "cache_control": {"type": "ephemeral"}}, *dyn]}]
        try:
            self.ctx.budget.need(llm.estimate(self.model, self.PLAN_SYSTEM, msgs, 3000))
            r = self.ctx.llm(self.model, self.PLAN_SYSTEM, None, 3000, effort="low", msgs=msgs, schema=self.PLAN_SCHEMA,
                             stage=f"preprod.produce.{self.ctx.app}", purpose="P3 producer: diagnose + next route")
            self.ctx.budget.add(r.get("usd"))
            ans = json.loads(r.get("text") or "{}")
            for st_ in ((ans.get("route") or {}).get("steps") or []):
                for f_ in ("params", "act"):
                    if isinstance(st_.get(f_), list):         # [{key, value}] → {key: value}
                        st_[f_] = {kv.get("key"): kv.get("value") for kv in st_[f_] if isinstance(kv, dict) and kv.get("key")}
        except Exception as e:  # noqa: BLE001 — the fallback planner takes over
            self._log(f"producer: the route planner failed ({str(e)[:160]}) — generic fallback route")
            return None
        if ans.get("give_up"):
            return {"give_up": True, "diagnosis": ans.get("diagnosis"), "failure": ans.get("failure")}
        rt = ans.get("route") or {}
        steps = []
        for s in rt.get("steps") or []:
            if s.get("action"):
                steps.append({"action": s["action"], **({"params": s["params"]} if s.get("params") else {})})
            elif s.get("act"):
                steps.append({"act": dict(s["act"])})
        route = {"name": str(rt.get("name") or "agent route")[:80], "start": rt.get("start") or "home", "steps": steps,
                 "via": "agent", "key": rt.get("learn_as") or key, "diagnosis": ans.get("diagnosis"),
                 "failure": ans.get("failure")}
        if rt.get("prompt") and rt["prompt"] != "{prompt}":
            route["prompt"] = str(rt["prompt"])
        if rt.get("use_result"):
            route["use_result"] = True
        why = self.validate(route)
        if why:
            self._log(f"producer: the planned route was refused ({why}) — generic fallback route")
            return None
        return route

    def validate(self, route):
        acts = self.ctx.pb.get("actions") or {}
        if not route.get("steps"):
            return "no steps"
        gens = [i for i, s in enumerate(route["steps"]) if self._is_gen(s)]
        if len(gens) != 1 or gens[0] != len(route["steps"]) - 1:
            return "exactly one generating step, last"
        for s in route["steps"]:
            if s.get("action") and s["action"] not in acts:
                return f"unknown action {s['action']}"
            if s.get("act"):
                a = s["act"]
                if a.get("type") not in RAW_TYPES:
                    return f"raw type {a.get('type')}"
                lab = " ".join(str(a.get(k) or "") for k in ("target", "selector", "url", "key"))
                for w in (skill.rules().get("onboarding") or {}).get("forbidden") or []:
                    if re.search(rf"\b{re.escape(w)}\b", lab, re.I):
                        return f"forbidden word {w!r}"
        st = route.get("start") or "home"
        if st not in ("home", "result_chat", "source_chat") and (acts.get(st) or {}).get("kind") != "goto":
            return f"start {st!r} is not home / result_chat / source_chat / a goto action"
        if st == "source_chat" and not (self.cur.get("source") or {}).get("chat"):
            return "no source chat to start in"
        if self.cur.get("needs_source") and st not in ("source_chat", "result_chat") and not any(
                s_.get("action") == self.roles().get("upload") or (s_.get("act") or {}).get("type") == "upload"
                for s_ in route["steps"]):
            return "a picture made from a source must start on the source or upload it (never a fresh generation)"
        return None

    def learn(self, route, aid, n, diag_hist):
        from . import onboard
        key = route.get("key") or "produce_photo"
        rec = {k: copy.deepcopy(route[k]) for k in ("name", "start", "steps", "prompt_template", "rephrase") if route.get(k)}
        rec["learned"] = {"job": self.job, "asset": aid, "try": n, "via": route.get("via"),
                          "after": [d.get("class") for d in diag_hist], "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                          "rule": "R14 P2: learned for THIS video only (the shared playbook is a read-only hint)"}
        old = (self.ctx.pb.get("recipes") or {}).get(key)
        if old and self._sig(old) == self._sig(rec):
            old.setdefault("worked", []).append({"asset": aid, "try": n})
        else:
            self.ctx.pb.setdefault("recipes", {})[key] = rec
        self.ctx.pb = onboard.save_job_playbook(self.ctx.pb, self.ctx.out, self.ctx.app)
        return key

    # ── the loop ──
    def produce(self, aid, desc, dst, inputs=(), prompt=None, objects=None, subject=None, style="", tool=None,
                tool_params=None, source=None, look=None, verbatim=False, as_words=None, base=None):
        """→ an assets.json row. tool = the app tool this asset is the result of (tool_of), source = {id, file, chat,
        nth} of the picture it is made from, look = real | impressive | faithful, verbatim = the prompt is his on-screen
        text (never reworded), as_words = the change in words (the described-edit fallback only)."""
        from . import onboard
        ctx = self.ctx
        inputs = [str(f) for f in inputs or [] if f]
        why_not = onboard.not_a_picture(desc)
        if why_not:                                    # the guard before ANY generation
            return {"id": aid, "kind": "app_generation", "desc": desc, "status": "not_a_picture", "file": None,
                    "source": None, "attempts": [why_not], "checks": [], "tries": [], "why": why_not}
        params = dict(tool_params or {})
        if prompt:
            params.setdefault("prompt", prompt)
        self.cur = {"needs_source": bool(inputs), "source": dict(source or {}), "tool": tool, "params": params, "look": look, "verbatim": bool(verbatim),
                    "as_words": as_words, "prompt": prompt, "base": base or prompt,
                    "new_photo": not inputs and not tool and not prompt}
        if self.cur["source"].get("chat"):
            ctx.allowed_chats.add(self.cur["source"]["chat"])
        key = self.recipe_key(inputs, tool)
        subject = subject or desc
        row = {"id": aid, "kind": "app_generation", "desc": desc, "status": "needs_asset", "file": None, "source": None,
               "attempts": [], "checks": [], "tries": [], "prompt": prompt if prompt is not None else subject, "made_from": [],
               "for": "R14 P3", "producer": "producer agent (aieditor/producer.py)", "look": look,
               **({"tool": tool} if tool else {})}
        t0 = self.clock()
        deadline = t0 + self.time_budget
        tool_n, tool_fail = 0, None
        route = None
        if tool:
            # the FIRST choice for a tool result comes from data: the learned tool recipe, else the playbook's tool
            learned = (ctx.pb.get("recipes") or {}).get(key)
            if learned and (not self.tool_spec(tool).get("on_source", True) or self.cur["source"].get("chat")):
                route = {**copy.deepcopy(learned), "via": "learned", "key": key, "tool": tool,
                         "no_prompt": not self.tool_spec(tool).get("typed")}
            else:
                route, tool_fail = self.tool_route(tool, params)
            if route is None:
                route = self.described_edit(f"the {tool} tool route is not available ({tool_fail})") if inputs else None
                row["attempts"].append(f"tool route not available: {tool_fail}"[:300])
        if route is None:
            route = self.first_route(key if not tool else self.recipe_key(inputs))
            if prompt:
                route["prompt"] = prompt
        tried, seen, diag_hist, missing, last_file = [], set(), [], [], None
        tally = getattr(ctx, "tally", None) or (0, 1)
        for n in range(1, self.max_tries + 1):
            self._cancel()
            if self.clock() >= deadline:
                row["attempts"].append(f"time budget {self.time_budget / 60:.0f} min used up")
                break
            seen.add(self._sig(route))
            p = self.make_prompt(route, subject, style, inputs, missing)
            use = [last_file] if route.get("use_result") and last_file else inputs
            self._status(f"Making assets: {tally[0]}/{tally[1]} ready ({aid}: try {n}, {route.get('name')})")
            if route.get("via") == "tool":
                tool_n += 1
            res = self.attempt(route, aid, n, p, use, deadline)
            diag = res.get("diag")
            if res.get("file"):
                ask = {"id": aid, "desc": desc, **({"look": look} if look else {}),
                       **({"source_files": inputs[:3], "change": as_words or prompt or desc} if inputs else {})}
                chk = ctx.check(ask, res["file"], objects or [desc])
                ctx.budget.add(chk.get("usd"))
                same = chk.get("same_subject", True) is not False
                look_ok = chk.get("look_ok", True) is not False
                clean = chk.get("clean", True) is not False
                row["checks"].append({"try": n, "route": route.get("name"), "matches": chk.get("matches"),
                                      "missing": chk.get("missing_objects"),
                                      **({"same_subject": same, "subject_diff": chk.get("subject_diff")} if inputs else {}),
                                      **({"look_ok": look_ok, "look_why": chk.get("look_why")} if look else {}),
                                      "clean": clean, **({"chrome": chk.get("chrome")} if not clean else {})})
                last_file = res["file"]
                if chk.get("matches") and same and look_ok and clean:
                    Path(dst).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(res["file"], dst)
                    k = self.learn(route, aid, n, diag_hist)
                    row["fidelity"] = {"v": FIDELITY_V, "look": look, "look_ok": True, "clean": True,
                                       **({"same_subject": True} if inputs else {})}
                    row.update(status="ready", file=str(dst), source={
                        "type": "in-app generation (off camera, producer agent)", "app": ctx.app, "route": route.get("name"),
                        "via": route.get("via"), "recipe": k, "prompt": p, "try": n, "chat_url": res.get("chat_url"),
                        "nth": res.get("nth"), **({"tool": tool} if tool else {}),
                        **({"made_from_chat": self.cur["source"].get("chat")} if self.cur["source"].get("chat") else {}),
                        **({"fallback": "described edit"} if route.get("described") else {})})
                    row["tries"].append({"try": n, "route": route.get("name"), "via": route.get("via"), "ok": True,
                                         "chat_url": res.get("chat_url")})
                    self._log(f"{aid} try {n}: made in {self.app_name} via {route.get('name')} — the picture matches"
                              + (" (same subject as its source)" if inputs else "") + (f", {look} look" if look else "")
                              + f" (learned as {k} for this video)")
                    return row
                if not same:
                    diag = {"class": "different_subject", "why": "the vision check against the source: "
                            + (chk.get("subject_diff") or "not the same subject"), "evidence": chk.get("subject_diff") or ""}
                    missing = []
                elif not clean:
                    diag = {"class": "not_clean", "why": "the vision check: " + (chk.get("chrome") or "UI chrome / captions / a collage"),
                            "evidence": chk.get("chrome") or ""}
                elif not chk.get("matches"):
                    missing = [str(m) for m in chk.get("missing_objects") or []]
                    diag = {"class": "mismatch", "why": "the vision check: missing " + ", ".join(missing or ["the description"]),
                            "missing": missing}
                else:
                    diag = {"class": "wrong_look", "why": f"the vision check: not a {look} look — {chk.get('look_why') or ''}".strip(" —"),
                            "evidence": chk.get("look_why") or ""}
            diag = diag or {"class": "no_progress", "why": "nothing came back"}
            diag_hist.append(diag)
            row["tries"].append({"try": n, "route": route.get("name"), "via": route.get("via"), "ok": False,
                                 "class": diag["class"], "why": diag.get("why"), "evidence": (diag.get("evidence") or "")[:300],
                                 "generated": res.get("generated"), "chat_url": res.get("chat_url"), "shot": res.get("shot")})
            row["attempts"].append(f"try {n} ({route.get('name')}): {CLASS_WORDS.get(diag['class'])} — {diag.get('why')}"[:300])
            if diag["class"] == "logged_out":
                # a login wall is not a usage limit: no block for other jobs; no route can fix it in this session
                row["attempts"].append("the app session is not logged in — no route can make it here")
                self._log(f"{aid} try {n}: {self.app_name} {CLASS_WORDS['logged_out']} — stopped (no ledger block)")
                break
            if diag["class"] == "limit_wall":
                cool = float(self.spec.get("wall_cooldown_s" if "wall" in str(diag.get("why")) else "limit_cooldown_s")
                             or 21600)
                until = self.clock() + cool
                genledger.block(ctx.app, until, f"{self.app_name}: {diag.get('evidence') or diag.get('why')}"[:200],
                                job=self.job, now=self.clock())
                self._log(f"{aid} try {n}: {self.app_name} {CLASS_WORDS['limit_wall']} — every generation stops now")
                raise genledger.QuotaWait(ctx.app, until, f"{self.app_name} showed a limit / wall message")
            tried.append({"route": route.get("name"), "start": route.get("start"), "failure": diag["class"],
                          "why": diag.get("why"), "prompt": p[:200]})
            nxt = None
            if diag["class"] == "still_generating" and not route.get("wait_only") and res.get("chat_url"):
                nxt = {**route, "name": f"{route.get('name')} — waiting longer", "wait_only": True}
            elif tool and route.get("via") in ("tool", "learned") and route.get("key") == key:
                # the tool route again (a step that did not land, a different subject) — then the described edit
                if tool_n < self.tool_tries:
                    tr, why_t = self.tool_route(tool, params)
                    if tr:
                        nxt = {**tr, "name": tr["name"] + " (again)", "again": tool_n}
                if nxt is None and inputs:
                    nxt = self.described_edit(f"the {tool} tool route failed {tool_n}x ({diag['class']})")
                    row["attempts"].append(f"the {tool} tool route failed {tool_n}x — fell back to a described edit")
            if nxt is None and diag["class"] not in ("wrong_look", "not_clean"):       # a wrong look: the reworded try first (fallback)
                goal = (f"a picture matching: {desc}" + (f" (made from {len(inputs)} input file(s): keep their subject)" if inputs else "")
                        + (f"; look: {look}" if look else "") + f". Prompt used: {p[:300]}")
                nxt = self.plan_next(goal, diag, tried, route, res.get("obs"), key)
                if nxt and nxt.get("give_up"):
                    row["attempts"].append(f"the agent gave up: {nxt.get('diagnosis')}"[:300])
                    break
                if nxt and self._sig(nxt) in seen:
                    nxt = None
            if nxt is None:
                nxt = next((r for r in self.fallback_routes(diag["class"], key, bool(inputs), route, missing)
                            if self._sig(r) not in seen), None)
            if nxt and route.get("wait_only") and nxt is not route:
                nxt.pop("wait_only", None)
            if nxt is None:
                row["attempts"].append("no untried route left")
                self._log(f"{aid} try {n}: {self.app_name} {CLASS_WORDS[diag['class']]} — no untried route left")
                break
            what = (f" ({', '.join(missing)})" if diag["class"] == "mismatch" and missing else "")
            self._log(f"{aid} try {n}: {self.app_name} {CLASS_WORDS[diag['class']]}{what} → switching to {nxt.get('name')}"
                      + (f" [{nxt.get('via')}]" if nxt.get("via") else ""))
            route = nxt
        row["why"] = (f"{len(row['tries'])} tries in {self.app_name}, none matched: "
                      + "; ".join(row["attempts"][-3:]))[:400]
        return row


def _wall_class(w):
    """A recorder wall → logged_out (a login page: the session, not the account's limit) or limit_wall."""
    return "logged_out" if re.search(r"\blog ?in\b|sign ?up|'kind': 'login'|\"kind\": \"login\"", str(w), re.I) else "limit_wall"


def _slug(v):
    return re.sub(r"[^a-z0-9]+", "_", str(v or "").lower()).strip("_")[:30]


def _route_view(r):
    return {k: (r or {}).get(k) for k in ("name", "start", "steps", "via", "prompt_template", "rephrase")}


def _session(tr, pb):
    from . import onboard
    return onboard.Session(tr, pb)


def new_text(before, after, prompt=""):
    """The lines the page gained since the try started, without the prompt itself (the thread's reply)."""
    have = {ln.strip() for ln in str(before or "").splitlines() if ln.strip()}
    pl = {ln.strip() for ln in str(prompt or "").splitlines() if ln.strip()}
    out = [ln.strip() for ln in str(after or "").splitlines()
           if ln.strip() and ln.strip() not in have and ln.strip() not in pl and not (prompt and ln.strip() in prompt)]
    return "\n".join(out)


def rephrase(subject):
    """Deterministic visible-only rephrase (the fallback when no model plans): no people / brands, concrete."""
    s = PEOPLE_RX.sub("", str(subject or ""))
    s = re.sub(r"\s{2,}", " ", s).strip(" ,.")
    return f"A realistic photograph showing only objects: {s}. No people, no brand names, no text."
