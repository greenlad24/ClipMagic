"""THE DRIFT-REPAIR AGENT — the self-healing layer's fixer for an app's weekly UI drift (Jake 2026-10-11: "I want to fix it
for all future videos so we don't do these sessions again"; the pre-production agent must "find the ways itself").

When the preflight (aieditor/preflight.py) sees the SAME check fail on >= 2 screencasts (a systematic drift, not a
segment problem), this capped Opus loop looks at the live page OFF CAMERA (observe / find / count / act — the click
guard, the onboarding forbidden words, no generating press, never one of Jake's chats) and decides ONE of:

  (a) resting_ui     the page shows this at rest (ChatGPT's new home-page suggestions; a logged-out page's Log in /
                     Sign up) → start_state.allow: resting_texts / resting_selectors / resting_popups / walls / reasons
  (b) dismiss        a new popup / banner that closes → start_state.dismiss: the steps that close it (proven)
  (c) moved_control  a playbook action's control moved / was renamed → that action is RE-ONBOARDED for this video
  (d) real_problem   a real fault (a challenge, another account, a chat that will not load…) → nothing is accepted;
                     the affected screencasts degrade to an approved motion template (logged, never silent)

The fix is DATA in THIS video's playbook (job/preprod/playbook-<app>.json) — never code, never the shared skill
playbook (that is only a hint). preflight then PROVES it on 2 of the failing screencasts and reverts it if it does not
hold. The rules that protect Jake (screencast/first_frame.py SAFE_RX: his account, Chat mode, an empty composer, the
hidden sidebar, no challenge) can never be allowed away — code refuses such an allowance whatever the agent says.
"""
import base64
import copy
import json
import re
import time
from pathlib import Path

from . import clickguard, config, llm

MODEL = config.PLAN_MODEL                    # Opus 5.5 (Jake 2026-10-09: every AI call on Opus 5.5)
MAX_TURNS = 8
CLUSTER_USD = 0.90                           # one drift cluster
VIDEO_USD = 2.50                             # every drift repair of one video
VERDICTS = ("resting_ui", "dismiss", "moved_control", "real_problem")

SYSTEM = """You repair UI DRIFT for an automated screencast factory, OFF CAMERA, in a browser on a copy of the account's
profile. A check that passed last week now fails on SEVERAL screencasts with the same reason: the app's UI changed. Look
at the live page and decide what the failure really is:
  resting_ui     the page simply shows this now, at rest, for everyone (e.g. suggestion chips under the composer, a
                 logged-out page's 'Log in' / 'Sign up' buttons). It is harmless in a first frame. Give the exact
                 texts (resting_texts, short, as on screen) and/or stable CSS selectors of the element (resting_selectors)
                 and/or how many such popups are normal (resting_popups), or wall kinds that are the view (walls).
  dismiss        a NEW popup / banner / dialog that should be closed before recording, and how (dismiss: a list of
                 actions — {"type":"key","key":"Escape"} or {"type":"click","selector":"<css>"}). Test them with act
                 first. Never a delete / buy / upgrade / billing / publish / share / invite / log-out control.
  moved_control  a control a playbook action uses moved or was renamed (the action's selector finds nothing): name
                 the action (action_id) and describe the step in plain words (need) — it is re-learned separately.
  real_problem   anything else: a bot check, another account, a chat that will not load, an error page, Work mode, a
                 draft left in the composer. Never accept a real problem as resting UI.
Rules: never press anything that sends / generates; never open one of the account's existing chats; one tool per turn.
Answer ONE JSON object per turn, nothing else:
{"do": "observe|find|count|act|decide", "note": "<short>", "texts": [...] (find: labels; count: CSS selectors),
 "action": "<a JSON object, as text>" (act), "decision": "<a JSON object, as text>" (decide: {"verdict":
 "resting_ui|dismiss|moved_control|real_problem", "resting_texts": [...], "resting_selectors": [...],
 "resting_popups": 0, "walls": [...], "reasons": [...], "dismiss": [...], "action_id": "", "need": "", "why": ""})}"""


class Budget:
    def __init__(self, cap=VIDEO_USD, spent=0.0):
        self.cap, self.spent = float(cap), float(spent)

    def left(self):
        return round(self.cap - self.spent, 4)


def _shot(path):
    try:
        data = Path(path).read_bytes()
    except (OSError, TypeError):
        return None
    mt = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(data).decode()}}


def _json_obj(txt):
    m = re.search(r"\{.*\}", str(txt or ""), re.S)
    try:
        ans = json.loads(m.group(0) if m else txt)
    except (ValueError, TypeError):
        return {"do": "observe", "note": "the reply was not JSON"}
    if not isinstance(ans, dict):
        return {"do": "observe", "note": "the reply was not an object"}
    for f in ("action", "decision"):
        if isinstance(ans.get(f), str) and ans[f].strip():
            try:
                ans[f] = json.loads(ans[f])
            except ValueError:
                ans[f] = {}
    return ans


def _ff():
    from . import recorder
    return recorder._first_frame()


def safe_dismiss(steps, guarded=None):
    """Only key presses and plain clicks the click guard (and the onboarding rules, when a Guarded is given) accept;
    never a generating press. → (kept, refused)."""
    kept, refused = [], []
    for st in steps or []:
        if not isinstance(st, dict) or st.get("type") not in ("key", "click"):
            refused.append([st, "only key / click steps close a popup"])
            continue
        st = {k: v for k, v in st.items() if k in ("type", "key", "selector", "target", "x", "y")}
        if st["type"] == "key" and str(st.get("key", "")).lower() in ("enter", "numpadenter"):
            refused.append([st, "Enter can send"])
            continue
        g = clickguard.check(st, None, "logged_in")
        why = None if g.get("ok") else f"click guard: {g.get('why')}"
        if why is None and guarded is not None:
            why = guarded.check_act(st)
        if why:
            refused.append([st, why])
        else:
            kept.append(st)
    return kept[:4], refused


def to_patch(decision, reasons, guarded=None):
    """The agent's decision → a playbook patch (data) or None, every field validated by code:
    {"verdict", "allow": {...}, "dismiss": [...], "reonboard": {"action_id", "need"}, "why", "refused": [...]}."""
    d = decision if isinstance(decision, dict) else {}
    v = d.get("verdict")
    if v not in VERDICTS:
        return {"verdict": "real_problem", "why": f"no valid verdict ({v!r})", "refused": []}
    out = {"verdict": v, "why": str(d.get("why") or "")[:300], "refused": []}
    ff = _ff()
    if v == "resting_ui":
        allow = {}
        texts = [str(t).strip()[:80] for t in d.get("resting_texts") or [] if str(t).strip()][:8]
        sels = [str(s).strip()[:160] for s in d.get("resting_selectors") or [] if str(s).strip()][:6]
        walls = [str(w).lower() for w in d.get("walls") or [] if str(w).lower() not in ("challenge", "account", "error")][:3]
        rx = []
        for r in d.get("reasons") or []:
            try:
                re.compile(str(r))
            except re.error:
                out["refused"].append([r, "not a regex"])
                continue
            rx.append(str(r)[:160])
        if texts:
            allow["resting_texts"] = texts
        if sels:
            allow["resting_selectors"] = sels
        if walls:
            allow["walls"] = walls
        if rx:
            allow["reasons"] = rx
        try:
            n = int(d.get("resting_popups") or 0)
        except (TypeError, ValueError):
            n = 0
        if 0 < n <= 3:
            allow["resting_popups"] = n
        # the allowance must accept the failing reasons — and never one of the rules that protect Jake
        for r in reasons:
            if ff.SAFE_RX.search(r) and not r.lower().startswith("wall: login"):
                return {"verdict": "real_problem", "why": f"'{r[:80]}' is a rule that protects the recording — never "
                                                          "accepted as resting UI", "refused": [[r, "safe rule"]]}
        if not allow:
            return {"verdict": "real_problem", "why": "resting_ui without any allowance", "refused": out["refused"]}
        out["allow"] = allow
    elif v == "dismiss":
        kept, refused = safe_dismiss(d.get("dismiss"), guarded)
        out["refused"] += refused
        if not kept:
            return {"verdict": "real_problem", "why": "no safe dismiss step", "refused": out["refused"]}
        out["dismiss"] = kept
    elif v == "moved_control":
        aid, need = str(d.get("action_id") or "").strip(), str(d.get("need") or "").strip()
        if not need:
            return {"verdict": "real_problem", "why": "moved_control without the step in words", "refused": []}
        out["reonboard"] = {"action_id": aid, "need": need[:300]}
    return out


def apply_patch(pb, patch, where="start_state", by="drift-repair agent"):
    """Write a patch into a playbook dict (this video's) → the new playbook (a copy). where: 'start_state' (logged in)
    or 'outside_view' (the never-logged-in page)."""
    pb = copy.deepcopy(pb)
    tgt = pb.setdefault(where, {}) if where != "start_state" else pb["start_state"]
    if patch.get("allow"):
        al = tgt.setdefault("allow", {})
        for k, v in patch["allow"].items():
            if isinstance(v, list):
                al[k] = list(dict.fromkeys((al.get(k) or []) + v))
            else:
                al[k] = max(int(al.get(k) or 0), int(v))
        al.setdefault("learned", []).append({"by": by, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                             "why": patch.get("why"), "allow": patch["allow"]})
    if patch.get("dismiss"):
        tgt["dismiss"] = (tgt.get("dismiss") or []) + [s for s in patch["dismiss"] if s not in (tgt.get("dismiss") or [])]
    return pb


class Repairer:
    """One video's drift repairs (capped). transport: an agent_rec-protocol session (onboard.Guarded on top: click
    guard, no generation, only this job's chats); call: llm.messages-compatible (tests hand in a fake)."""

    def __init__(self, call=None, budget=None, log=print, max_turns=MAX_TURNS, model=MODEL):
        self.call = call or llm.messages
        self.budget = budget or Budget()
        self.log = log
        self.max_turns = max_turns
        self.model = model

    def decide(self, cluster, transport, start_state, pb_summary="", guarded=None):
        """→ {"verdict", "allow"|"dismiss"|"reonboard", "why", "turns", "usd", "log"}."""
        reasons = list(cluster.get("reasons") or [cluster.get("reason")])
        static = (f"THE FAILING CHECK (on {len(cluster.get('segments') or [])} screencasts): "
                  + " | ".join(str(r)[:200] for r in reasons[:4])
                  + f"\nSTART STATE (url + asserts): {json.dumps({k: start_state.get(k) for k in ('url', 'asserts', 'allow', 'dismiss')}, default=str)[:2500]}"
                  + (f"\nPLAYBOOK ACTIONS:\n{pb_summary[:4000]}" if pb_summary else ""))
        log, usd, spent0 = [], 0.0, self.budget.spent
        obs = transport.send({"cmd": "state"}) or {}
        for turn in range(1, self.max_turns + 1):
            if self.budget.spent - spent0 >= CLUSTER_USD or self.budget.left() <= 0:
                return {"verdict": "real_problem", "why": f"drift budget spent (${self.budget.spent:.2f})", "turns": turn - 1,
                        "usd": usd, "log": log, "capped": True}
            dyn = [{"type": "text", "text": "LOG:\n" + "\n".join(log[-10:]) + f"\nTURN {turn}/{self.max_turns}. CURRENT: "
                    + json.dumps({k: obs.get(k) for k in ("url", "h1", "popups", "popup_texts", "wall", "ok", "error",
                                                          "found", "counts")}, default=str)[:3000]
                    + ("\nPAGE TEXT: " + str(obs.get("text") or "")[:1500] if obs.get("text") else "")}]
            if obs.get("items"):
                dyn.append({"type": "text", "text": "ELEMENTS: " + json.dumps(
                    [{k: i.get(k) for k in ("ref", "tag", "text", "box")} for i in obs["items"][:100]])[:7000]})
            img = _shot(obs.get("shot"))
            if img:
                dyn.append(img)
            msgs = [{"role": "user", "content": [{"type": "text", "text": static, "cache_control": {"type": "ephemeral"}}, *dyn]}]
            try:
                r = self.call(self.model, SYSTEM, None, 4000, effort="medium", msgs=msgs, stage="preflight.drift",
                              purpose=f"drift repair turn {turn}")
            except Exception as e:  # noqa: BLE001 — a refused call (cap) ends the repair as a real problem
                return {"verdict": "real_problem", "why": f"drift agent call failed: {e}", "turns": turn - 1, "usd": usd,
                        "log": log}
            u = float((r or {}).get("usd") or 0)
            usd += u
            self.budget.spent = round(self.budget.spent + u, 6)
            ans = _json_obj((r or {}).get("text"))
            do = ans.get("do")
            log.append(f"{turn}: {do} — {str(ans.get('note'))[:160]}")
            if do == "observe":
                obs = {**(transport.send({"cmd": "state"}) or {}), **(transport.send({"cmd": "observe"}) or {})}
            elif do == "find":
                obs = {"found": (transport.send({"cmd": "find", "texts": list(ans.get("texts") or [])[:6]}) or {}).get("found", {})}
            elif do == "count":
                obs = {"counts": {x: (transport.send({"cmd": "count", "selector": x}) or {}).get("n") for x in list(ans.get("texts") or [])[:6]}}
                log[-1] += f" → {obs['counts']}"
            elif do == "act":
                a = dict(ans.get("action") or {})
                kept, refused = safe_dismiss([a], guarded)
                if refused:
                    obs = {"ok": False, "error": f"refused: {refused[0][1]}"}
                else:
                    obs = transport.send({"cmd": "act", "action": kept[0]}) or {}
                    obs = {**(transport.send({"cmd": "state"}) or {}), "act": obs}
                log[-1] += f" → {obs.get('error') or 'ok'}"
            elif do == "decide":
                p = to_patch(ans.get("decision"), reasons, guarded)
                return {**p, "turns": turn, "usd": round(usd, 6), "log": log}
            else:
                obs = transport.send({"cmd": "observe"}) or {}
        return {"verdict": "real_problem", "why": f"no decision in {self.max_turns} turns", "turns": self.max_turns,
                "usd": round(usd, 6), "log": log}
