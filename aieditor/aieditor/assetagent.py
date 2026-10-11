"""THE ASSET AGENT — pre-production pictures are made by an agent in the app's own UI, off camera, the way a person would
(Jake 2026-10-11: "Getting the pictures right — should only be made by an agent not by code").

It replaces the producer's code routes (recipes, route planning, described-edit fallbacks — aieditor/producer.py, still
the fallback when the switch is off: rules.json rehearsal.mode / AIEDITOR_REHEARSAL=playbook) with the rehearsal
agent's loop (aieditor/rehearse.py): it looks at the screen and acts — a plain generation, an edit of a source picture
(the job's own file uploaded), or the app's tool on a source (Markup / Erase / Comment / Remove BG / Resize / Sketch /
a template such as Logo) — handling whatever the UI shows. When its generating press lands, CODE waits for the result
and saves it (the producer's own wait / grab mechanics), then CODE verifies it.

The rules stay in code, around the agent:
  - no image API key, ever: the only way a picture is made is a press in the app's UI;
  - the text typed is decided by code (his on-screen prompt VERBATIM + the one-line look paragraph: onboard.verbatim_plus
    / onscreen_prompt / script_prompts via onboard.produce_asset, then Producer.make_prompt) — the agent can only ask
    code to type it, and code checks the field holds exactly that text; never an internal note;
  - generations spaced and capped by genledger; the app's own limit message stops every generation (QuotaWait);
  - no temporary chat; never Jake's existing chats or Library (only chats this job created) — rehearse.Guard +
    onboard.Guarded;
  - the VERIFIER after every result: the vision fidelity check (same subject as the source, the look, no UI chrome /
    collage — preprod.gen_check) and the code audit (preflight.audit_asset: verbatim, internal words, a tool result
    really made by that tool). A rejected picture → the reason goes back to the agent → another try, capped per asset
    (tries and $, rules.json assets_agent); after the cap the asset is needs_asset and the beats that use it fall back.
  - reuse: an asset already made and checked by an earlier run is reused unchanged (onboard.produce_asset → reuse_ok,
    before this agent is ever called).
The full trial log of every try is kept (preprod/producer/agent-<id>.json) and summarised into the hints ledger.
"""
import json
import re
import shutil
import time
from pathlib import Path

from . import genledger, llm, preflight, producer, rehearse, skill

DEFAULTS = {"max_tries": 4, "max_turns_per_try": 12, "asset_usd": 1.50}
FORBID_EXTRA = [r"\btemporary chat\b", r"temporary-chat=true", r"\btemporary\b"]
SYSTEM = """You make ONE picture inside a web app's own UI (OFF CAMERA, a fresh chat or a chat this job made), the way a
person would — never with an image API. Look at the screen and act; handle whatever the app shows. The playbook steps
are HINTS. A tool result (Markup, Erase, Comment, Remove BG, Resize, Sketch, a template) must be made WITH that tool on
the source picture — a plain new generation of a similar picture is rejected.

Rules (code enforces them — a refused action is reported back):
- the text is decided by code: send {"type":"type","ref":"rN"} and code types it exactly (never your own words)
- an upload attaches the job's own source file(s): {"type":"upload"}
- never delete, buy, upgrade, billing, publish, share, invite, log out; never a temporary chat; never an existing chat
  of the account or its Library
- no edit keys (Cmd+A, Backspace…) and no Enter: press the app's Send / Create / tool button
- a press on an image spot: {"type":"click","ref":"rN","rel":[fx,fy]}; a drag over a part of the image:
  {"type":"drag","ref":"rN","rel_from":[fx,fy],"rel_to":[fx,fy]} (fractions 0-1 of the element's box)
- the press that STARTS the generation ends your work for this try: code waits for the picture and checks it

Answer ONE JSON object per turn, nothing else:
{"do": "act|observe|find|count|give_up", "note": "<short>", "actions": "<a JSON list of actions, as text>",
 "texts": [...] (find: labels; count: CSS selectors)}"""


def rules():
    try:
        r = skill.rules().get("assets_agent") or {}
    except Exception:  # noqa: BLE001
        r = {}
    return {**DEFAULTS, **{k: v for k, v in r.items() if not k.endswith("src")}}


def _norm(t):
    return re.sub(r"\s+", " ", str(t or "")).strip()


class AssetAgent(producer.Producer):
    """producer.Producer's interface (produce() → an assets.json row; tools() / tool_of() for the audits), with the
    routes replaced by the agent. Raises genledger.QuotaWait (the job waits) or InterruptedError (cancelled)."""

    def __init__(self, ctx, clock=time.time, sleep=time.sleep, call=None):
        super().__init__(ctx, clock=clock, sleep=sleep)
        rr, ra = rehearse.rules(), rules()
        self.call = call or getattr(ctx, "llm", None) or llm.messages
        self.model, self.esc_model, self.effort = rr["model"], rr["escalate_model"], rr["effort"]
        self.stuck_after = int(rr["stuck_after"])
        self.max_tries = int(ra["max_tries"])
        self.max_turns = int(ra["max_turns_per_try"])
        self.asset_usd = float(ra["asset_usd"])

    # ── what the tool's presses are called (data: the playbook's produce.tools + its actions' labels) ──
    def tool_labels(self, tool, params=None):
        t = self.tool_spec(tool)
        acts = self.ctx.pb.get("actions") or {}
        ro = self.roles()
        generic = {ro.get("prompt"), ro.get("generate"), ro.get("upload"), ro.get("open_result"), ro.get("images_page")}
        out = {_norm(t.get("label")).lower(), tool.replace("_", " ").lower()}
        for st in t.get("steps") or []:
            a = acts.get(st.get("action")) or {}
            if st.get("action") and st["action"] not in generic and a.get("label"):
                lab = re.sub(r"\{(\w+)\}", lambda m: str((params or {}).get(m.group(1), "")), a["label"])
                out.add(_norm(lab).lower())
        return {x for x in out if x and len(x) >= 3}

    def _gen_press(self, a, item, tool):
        lab = _norm(a.get("target") or (item or {}).get("text") or "")
        if a.get("type") == "click" and rehearse.GEN_LABELS.match(lab):
            return True
        sel = str(a.get("selector") or "")
        for x in (self.ctx.pb.get("actions") or {}).values():
            if x.get("generates") and ((sel and sel in (x.get("selectors") or [])) or
                                       (lab and _norm(x.get("label")).lower() == lab.lower())):
                return True
        return False

    # ── one try: the agent in a fresh browser until its generating press lands ──
    def _try(self, n, aid, typed, inputs, tool, deadline, feedback, log, spent):
        from . import onboard
        ctx = self.ctx
        tr = ctx.guarded(allow_generate=True)
        guard = rehearse.Guard(ctx.pb, "logged_in", list(getattr(ctx, "allowed_chats", ()) or ()))
        res = {"file": None, "chat_url": None, "diag": None, "generated": False, "tool_pressed": False, "usd": 0.0,
               "turns": 0, "typed_ok": None}
        try:
            sess = producer._session(tr, ctx.pb)
            wd = Path(getattr(getattr(tr, "t", None), "workdir", None) or (Path(ctx.out) / "producer" / "w"))
            src = self.cur.get("source") or {}
            start = src.get("chat") if tool and self.tool_spec(tool).get("on_source", True) and src.get("chat") else \
                (ctx.pb.get("start_state") or {}).get("url")
            ok, why = sess.open(start)
            if not ok:
                res["diag"] = {"class": "ui_step_failed", "why": f"start: {why}"}
                return res
            sel = self.spec.get("result_selector") or ""
            n0 = int(tr.send({"cmd": "count", "selector": sel}).get("n", 0) or 0) if sel else 0
            res["n0"] = n0
            text0 = (tr.send({"cmd": "text"}) or {}).get("text", "")
            files = []
            for f in inputs or []:
                (wd / "upload").mkdir(parents=True, exist_ok=True)
                d = wd / "upload" / Path(f).name
                shutil.copyfile(f, d)
                files.append(f"/w/upload/{d.name}")
            tl = self.tool_labels(tool, self.cur.get("params")) if tool else set()
            static = self._static(aid, typed, inputs, tool, feedback, start)
            obs = tr.send({"cmd": "observe"}) or {}
            last, stuck, esc = {}, 0, False
            for turn in range(1, self.max_turns + 1):
                self._cancel()
                if self.clock() >= deadline:
                    res["diag"] = {"class": "no_progress", "why": "the asset's time budget is used up"}
                    return res
                res["turns"] = turn
                if stuck >= self.stuck_after:
                    esc = True
                model = self.esc_model if esc else self.model
                dyn = [{"type": "text", "text": f"TURN {turn}/{self.max_turns}. LOG:\n" + "\n".join(log[-12:])
                        + f"\nLAST: {json.dumps(last, default=str)[:1200]}\nURL: {obs.get('url')}"}]
                if obs.get("items"):
                    dyn.append({"type": "text", "text": "ELEMENTS: " + json.dumps(
                        [{k: i.get(k) for k in ("ref", "tag", "text", "box")} for i in obs["items"][:150]])[:9000]})
                img = rehearse._shot_block(obs.get("shot"))
                if img:
                    dyn.append(img)
                msgs = [{"role": "user", "content": [{"type": "text", "text": static, "cache_control": {"type": "ephemeral"}}, *dyn]}]
                est = llm.estimate(model, SYSTEM, msgs, rehearse.MAX_TOKENS)
                if spent() + res["usd"] + est > self.asset_usd:
                    res["diag"] = {"class": "capped", "why": f"the asset's ${self.asset_usd:.2f} agent cap is reached"}
                    return res
                try:
                    ctx.budget.need(est)
                except onboard.BudgetSpent as e:
                    res["diag"] = {"class": "capped", "why": str(e)}
                    return res
                r = self.call(model, SYSTEM, None, rehearse.MAX_TOKENS, effort=self.effort, msgs=msgs, thinking=False,
                              stage=f"preprod.asset.{ctx.app}", purpose=f"asset agent {aid} try {n} turn {turn} (off camera)")
                u = float(r.get("usd", 0.0) or 0.0)
                res["usd"] += u
                ctx.budget.add(u)
                ans = rehearse._json_obj(r.get("text", ""))
                do = ans.get("do")
                log.append(f"try {n} turn {turn}: {do} — {str(ans.get('note') or '')[:140]}")
                if do == "observe":
                    obs = tr.send({"cmd": "observe"}) or {}
                    last = {"observed": True}
                    continue
                if do == "find":
                    last = {"found": (tr.send({"cmd": "find", "texts": list(ans.get("texts") or [])[:6]}) or {}).get("found", {})}
                    continue
                if do == "count":
                    last = {"counts": {x: (tr.send({"cmd": "count", "selector": x}) or {}).get("n")
                                       for x in list(ans.get("texts") or [])[:6]}}
                    continue
                if do not in ("act", "give_up"):
                    # no usable answer (empty / unparsable JSON — run 18: "try 1 turn 2: None" ended the try as "gave up:
                    # no reason") is never a give-up: the agent is told and asked again, the turn counts
                    last = {"error": "your answer had no valid \"do\" — answer ONLY the JSON object with do = "
                                     "act|observe|find|count|give_up"}
                    stuck += 1
                    continue
                if do == "give_up":
                    res["diag"] = {"class": "ui_step_failed", "why": f"the agent gave up: {ans.get('note') or 'no reason'}"}
                    return res
                acted = []
                for a in list(ans.get("actions") or [])[:6]:
                    if not isinstance(a, dict):
                        continue
                    out = self._act(tr, guard, a, obs, typed, files, tool, tl, res, aid, n)
                    acted.append(out)
                    log.append(f"  {out['what']} → {'ok' if out['ok'] else out['why']}")
                    if not out["ok"] or out.get("generated"):
                        break
                stuck = stuck + 1 if (not acted or not acted[-1]["ok"]) else 0
                last = {"acted": acted}
                if res["generated"]:
                    # CODE waits for the picture and saves it (the producer's mechanics), then closes the tool overlay
                    for oc in (self.spec.get("overlay_close") or []):
                        try:
                            if (tr.send({"cmd": "count", "selector": oc}) or {}).get("n"):
                                self.sleep(1.5)
                                tr.send({"cmd": "act", "action": {"type": "click", "selector": oc}})
                                self.sleep(1.0)
                        except Exception:  # noqa: BLE001 — the wait still runs
                            pass
                    res.update(self._wait(tr, sel, n0, text0, typed or "", deadline, wd, aid, n))
                    return res
                obs = tr.send({"cmd": "observe"}) or {}
            res["diag"] = {"class": "no_progress", "why": f"no generation started in {self.max_turns} turns"}
            return res
        finally:
            try:
                u = str(((tr.send({"cmd": "text"}) or {}).get("url")) or "")
            except Exception:  # noqa: BLE001
                u = ""
            m = producer.CHAT_RX.search(u)
            if m and res.get("generated"):
                url = u if u.startswith("http") else ctx.pb["start_state"]["url"].rstrip("/") + m.group(0)
                res["chat_url"] = url
                if url not in self.chats:
                    self.chats.append(url)
                ctx.allowed_chats.add(url)
            tr.close()

    def _wait_only(self, n, aid, typed, deadline, pending):
        """The last try's generation was still running when its wait ended (run 18: Comment mode worked, ChatGPT took
        more than 4 min, the next tries found the picture FINISHED and had nothing left to press): no agent — code
        reopens that chat and collects the picture when it lands."""
        ctx = self.ctx
        tr = ctx.guarded(allow_generate=False)
        res = {"file": None, "chat_url": pending["chat"], "diag": None, "generated": True,
               "tool_pressed": pending.get("tool_pressed", False), "usd": 0.0, "turns": 0, "typed_ok": None}
        try:
            sess = producer._session(tr, ctx.pb)
            ok, why = sess.open(pending["chat"])
            if not ok:
                res["diag"] = {"class": "ui_step_failed", "why": f"reopen the generating chat: {why}"}
                return res
            wd = Path(getattr(getattr(tr, "t", None), "workdir", None) or (Path(ctx.out) / "producer" / "w"))
            sel = self.spec.get("result_selector") or ""
            res.update(self._wait(tr, sel, pending.get("n0", 0), "", typed or "", deadline, wd, aid, n))
            if not res.get("file"):
                # run 20: the Markup result was FINISHED on screen (a chili on the label) while the wait kept saying
                # "still generating" twice — the finished-picture signal did not fire for this kind of result. The
                # generation was pressed minutes ago in THIS chat: the newest picture in the chat is taken, and the
                # VERIFIER decides (same subject, the tool's result) — a wrong grab is rejected there, never shipped
                for bsel in [x for x in (sel, 'img[alt^="Generated image"]', 'div[data-message-author-role="assistant"] img')
                             if x]:
                    k = int((tr.send({"cmd": "count", "selector": bsel}) or {}).get("n", 0) or 0)
                    if k:
                        g = self._grab(tr, bsel, k, wd, aid, n)
                        if g.get("file"):
                            self._log(f"{aid} try {n}: the wait missed the finished picture — took the newest one in "
                                      f"that chat ({bsel}); the verifier decides")
                            res.update(g)
                            res["diag"] = None
                            break
            return res
        finally:
            tr.close()

    def _act(self, tr, guard, a, obs, typed, files, tool, tool_labels, res, aid, n):
        from . import onboard
        a = onboard.norm_points(dict(a))
        ty = a.get("type")
        item = next((x for x in obs.get("items") or [] if x.get("ref") == a.get("ref")), None) if a.get("ref") else None
        what = f"{ty} {a.get('ref') or a.get('target') or a.get('selector') or ''} {(item or {}).get('text') or ''}".strip()
        if a.get("ref") and item is None:
            return {"ok": False, "what": what, "why": "unknown ref — observe again"}
        if ty == "goto":
            return {"ok": False, "what": what, "why": "no navigation: the try starts where code opened it"}
        labels = " ".join(str(x) for x in (a.get("target"), a.get("selector"), a.get("url"), (item or {}).get("text"),
                                           (item or {}).get("href")) if x)
        if any(re.search(rx, labels, re.I) for rx in FORBID_EXTRA):
            return {"ok": False, "what": what, "why": "never a temporary chat"}
        why = guard.check(a, item, typed=(typed or None) if ty == "type" else None)
        if why:
            return {"ok": False, "what": what, "why": why}
        wire = {k: v for k, v in a.items() if k in ("type", "ref", "target", "selector", "key", "by", "rel", "rel_from",
                                                     "rel_to", "x", "y", "exact", "from", "to")}
        if ty == "drag" and not (isinstance(wire.get("from"), list) and isinstance(wire.get("to"), list)) \
                and isinstance(a.get("rel_from"), list) and isinstance(a.get("rel_to"), list) and item and item.get("box"):
            # run 18: every Markup box failed "drag needs from/to [x, y]" (20 drags, 4 tries) — the browser takes a drag
            # as SCREENSHOT px points only: the element's box (CSS px) / f
            f = float(obs.get("f") or 1.5)
            bx, by, bw, bh = (float(v) for v in item["box"][:4])
            wire["from"] = [round((bx + a["rel_from"][0] * bw) / f, 1), round((by + a["rel_from"][1] * bh) / f, 1)]
            wire["to"] = [round((bx + a["rel_to"][0] * bw) / f, 1), round((by + a["rel_to"][1] * bh) / f, 1)]
        if ty == "type":
            wire.update(text=typed, paste=True, clear=True, enter=False)
        if ty == "upload":
            if not files:
                return {"ok": False, "what": what, "why": "this picture has no source file to upload"}
            wire["files"] = files
        gen = ty == "click" and self._gen_press(wire, item, tool)
        lab = _norm(a.get("target") or (item or {}).get("text") or "").lower()
        if tool and lab and any(t in lab or lab in t for t in tool_labels):
            res["tool_pressed"] = True
        if gen:
            self._gate(aid, n, {"name": "asset agent"})       # genledger: spacing, the daily cap, a block → QuotaWait
            if hasattr(tr, "generations"):
                tr.generations += 1                           # onboard.Guarded: the chat this press creates is the job's
        r = tr.send({"cmd": "act", "action": wire}) or {}
        ok = bool(r.get("ok", True)) and not r.get("error") and not r.get("refused")
        if ok and ty == "type":
            chk = tr.send({"cmd": "assert", "field_equals": typed}) or {}
            res["typed_ok"] = bool(chk.get("ok", True))
            if not res["typed_ok"]:
                return {"ok": False, "what": what, "why": "the field does not hold the exact text code typed: "
                        + "; ".join(chk.get("fail") or [])[:160]}
        if ok and gen:
            res["generated"] = True
        return {"ok": ok, "what": what, "why": None if ok else (r.get("error") or r.get("refused")), "generated": ok and gen}

    def _static(self, aid, typed, inputs, tool, feedback, start):
        t = self.tool_spec(tool) if tool else {}
        acts = self.ctx.pb.get("actions") or {}
        steps = "; ".join((f"{s['action']} ('{(acts.get(s['action']) or {}).get('label')}')" if s.get("action") else
                           f"need: {s.get('need')}") for s in t.get("steps") or [])
        hints = rehearse.hints_for(self.ctx.app, [f"asset:{tool or ('edit' if inputs else 'photo')}"])
        mem = "; ".join(f"worked {h.get('worked')} avoid {[x.get('target') for x in h.get('avoid') or []]}" for h in hints)
        return (f"APP: {self.app_name}. PICTURE '{aid}': {self.cur.get('desc')}\n"
                f"LOOK: {self.cur.get('look') or 'any'}. START: {start}\n"
                + (f"TOOL: {t.get('label') or tool} — playbook hint steps: {steps}\n" if tool else "")
                + (f"SOURCE: the picture in this chat (#{(self.cur.get('source') or {}).get('nth')})\n"
                   if tool and (self.cur.get("source") or {}).get("chat") else "")
                + (f"UPLOAD: {len(inputs)} source file(s) of the job — attach with {{\"type\":\"upload\"}}\n" if inputs else "")
                + (f"TEXT (code types it verbatim): {typed!r}\n" if typed else "NO TEXT: this result is the tool's click alone\n")
                + (f"LESSONS FROM EARLIER VIDEOS: {mem}\n" if mem else "")
                + (f"THE LAST TRY WAS REJECTED: {feedback}\n" if feedback else ""))

    # ── produce(): tries until the verifier accepts, capped ──
    def produce(self, aid, desc, dst, inputs=(), prompt=None, objects=None, subject=None, style="", tool=None,
                tool_params=None, source=None, look=None, verbatim=False, as_words=None, base=None):
        from . import onboard
        ctx = self.ctx
        inputs = [str(f) for f in inputs or [] if f]
        why_not = onboard.not_a_picture(desc)
        if why_not:
            return {"id": aid, "kind": "app_generation", "desc": desc, "status": "not_a_picture", "file": None,
                    "source": None, "attempts": [why_not], "checks": [], "tries": [], "why": why_not}
        params = dict(tool_params or {})
        if prompt:
            params.setdefault("prompt", prompt)
        self.cur = {"needs_source": bool(inputs), "source": dict(source or {}), "tool": tool, "params": params, "look": look,
                    "verbatim": bool(verbatim), "as_words": as_words, "prompt": prompt, "base": base or prompt, "desc": desc,
                    "new_photo": not inputs and not tool and not prompt}
        if self.cur["source"].get("chat"):
            ctx.allowed_chats.add(self.cur["source"]["chat"])
        tspec = self.tool_spec(tool) if tool else {}
        subject = subject or desc
        row = {"id": aid, "kind": "app_generation", "desc": desc, "status": "needs_asset", "file": None, "source": None,
               "attempts": [], "checks": [], "tries": [], "prompt": None, "made_from": [], "for": "R14 P3",
               "producer": "asset agent (aieditor/assetagent.py)", "look": look, **({"tool": tool} if tool else {})}
        deadline = self.clock() + self.time_budget
        log, missing, feedback, usd = [], [], None, 0.0
        script_prompts = onboard.script_prompts(getattr(ctx, "script", "") or "")
        tally = getattr(ctx, "tally", None) or (0, 1)
        pending = None
        for n in range(1, self.max_tries + 1):
            self._cancel()
            if self.clock() >= deadline:
                row["attempts"].append(f"time budget {self.time_budget / 60:.0f} min used up")
                break
            # the text is CODE's: his words verbatim (+ the look paragraph) — a miss may only add what must be shown
            typed = "" if tool and not tspec.get("typed") else \
                self.make_prompt({"name": "asset agent"}, subject, style, inputs if not tool else [], missing)
            row["prompt"] = typed or None
            self._status(f"Making assets: {tally[0]}/{tally[1]} ready ({aid}: try {n}, the asset agent)")
            if pending:
                self._log(f"{aid} try {n}: the last try's picture was still generating — waiting for it in that chat")
                res = self._wait_only(n, aid, typed, deadline, pending)
                pending = None
            else:
                res = self._try(n, aid, typed, inputs if not (tool and self.cur["source"].get("chat")) else [], tool,
                                deadline, feedback, log, lambda: usd)
            usd += res["usd"]
            diag = res.get("diag")
            if not res.get("file") and (diag or {}).get("class") == "still_generating" and res.get("chat_url"):
                pending = {"chat": res["chat_url"], "n0": res.get("n0", 0), "tool_pressed": res.get("tool_pressed")}
            entry = {"try": n, "ok": False, "turns": res["turns"], "usd": round(res["usd"], 6), "generated": res["generated"],
                     "tool_pressed": res["tool_pressed"], "chat_url": res.get("chat_url")}
            if res.get("file"):
                src = {"type": "in-app generation (off camera, asset agent)", "app": ctx.app, "agent": True,
                       "via": "tool" if tool and res["tool_pressed"] else ("generation" if not tool else "plain generation"),
                       "recipe": f"produce_edit:{tool}" if tool and res["tool_pressed"] else "asset agent",
                       "prompt": typed, "try": n, "chat_url": res.get("chat_url"), "nth": res.get("nth"),
                       **({"tool": tool} if tool else {}),
                       **({"made_from_chat": self.cur["source"].get("chat")} if self.cur["source"].get("chat") else {})}
                cand = {**row, "status": "ready", "file": res["file"], "source": src,
                        "made_from": [self.cur["source"].get("id")] if self.cur["source"].get("id") else ["(uploaded)"] * len(inputs)}
                # THE VERIFIER (code first, then vision): verbatim / internal words / a tool result made by the tool
                probs = preflight.audit_asset(cand, script_prompts, self.tool_of, self.tools())
                if tool and not res["tool_pressed"]:
                    probs.append({"rule": "tool_not_tool", "why": f"a {tool} result made without pressing the {tool} tool"})
                chk = {}
                if not probs:
                    ask = {"id": aid, "desc": desc, **({"look": look} if look else {}),
                           **({"source_files": [f for f in ([self.cur['source'].get('file')] + inputs) if f][:3],
                               "change": as_words or prompt or desc} if (inputs or self.cur["source"].get("file")) else {})}
                    chk = ctx.check(ask, res["file"], objects or [desc])
                    ctx.budget.add(chk.get("usd"))
                    usd += float(chk.get("usd") or 0.0)
                    if chk.get("same_subject", True) is False:
                        probs.append({"rule": "different_subject", "why": "not the same subject as its source: "
                                      + str(chk.get("subject_diff") or "")})
                    if chk.get("clean", True) is False:
                        probs.append({"rule": "not_clean", "why": "UI chrome / captions / a collage: " + str(chk.get("chrome") or "")})
                    if chk.get("look_ok", True) is False:
                        probs.append({"rule": "wrong_look", "why": f"not a {look} look: {chk.get('look_why') or ''}"})
                    if not chk.get("matches"):
                        missing = [str(m) for m in chk.get("missing_objects") or []]
                        probs.append({"rule": "mismatch", "why": "missing " + ", ".join(missing or ["the description"])})
                row["checks"].append({"try": n, "matches": chk.get("matches"), "problems": [p["rule"] for p in probs]})
                if not probs:
                    Path(dst).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(res["file"], dst)
                    row.update(status="ready", file=str(dst), source=src, made_from=[])
                    row["fidelity"] = {"v": producer.FIDELITY_V, "look": look, "look_ok": True, "clean": True,
                                       **({"same_subject": True} if inputs or self.cur["source"].get("file") else {})}
                    entry["ok"] = True
                    row["tries"].append(entry)
                    self._log(f"{aid} try {n}: made in {self.app_name} by the asset agent"
                              + (f" with the {tool} tool" if tool else "") + " — the verifier accepts it")
                    self._remember(aid, tool, inputs, log, ok=True)
                    self._save(aid, row, log, usd)
                    return row
                feedback = "the verifier rejected the picture: " + "; ".join(p["why"] for p in probs)[:400]
                entry.update(rejected=[p["rule"] for p in probs])
            else:
                diag = diag or {"class": "no_progress", "why": "nothing came back"}
                if diag["class"] == "limit_wall":
                    until = self.clock() + float(self.spec.get("limit_cooldown_s") or 21600)
                    genledger.block(ctx.app, until, f"{self.app_name}: {diag.get('evidence') or diag.get('why')}"[:200],
                                    job=self.job, now=self.clock())
                    self._save(aid, row, log, usd)
                    raise genledger.QuotaWait(ctx.app, until, f"{self.app_name} showed a limit / wall message")
                feedback = f"{producer.CLASS_WORDS.get(diag['class'], diag['class'])}: {diag.get('why')}"
                entry.update(cls=diag["class"], why=str(diag.get("why"))[:300])
                if diag["class"] == "capped":
                    row["tries"].append(entry)
                    row["attempts"].append(f"try {n}: {diag.get('why')}")
                    break
            row["tries"].append(entry)
            row["attempts"].append(f"try {n}: {feedback}"[:300])
            self._log(f"{aid} try {n}: {feedback[:200]} — " + ("another try" if n < self.max_tries else "no try left"))
        row["why"] = (f"{len(row['tries'])} asset-agent tries in {self.app_name}, none accepted: "
                      + "; ".join(row["attempts"][-3:]))[:400]
        self._remember(aid, tool, inputs, log, ok=False)
        self._save(aid, row, log, usd)
        return row

    def _remember(self, aid, tool, inputs, log, ok):
        rehearse.remember(self.ctx.app, [{"action": f"asset:{tool or ('edit' if inputs else 'photo')}", "asset": aid,
                                          "worked": [x for x in log if "→ ok" in x][-6:] if ok else [],
                                          "avoid": [{"target": x.split(" → ")[0].strip(), "why": x.split(" → ")[-1]}
                                                    for x in log if " → " in x and "→ ok" not in x][-6:]}])

    def _save(self, aid, row, log, usd):
        try:
            d = Path(self.ctx.out) / "producer"
            d.mkdir(parents=True, exist_ok=True)
            (d / f"agent-{aid}.json").write_text(json.dumps({"asset": aid, "status": row.get("status"), "usd": round(usd, 6),
                                                             "tries": row.get("tries"), "log": log}, indent=1, default=str))
        except OSError:
            pass
