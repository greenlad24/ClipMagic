"""THE SCRIPTED RECORDER — code records, no model acts on camera (architecture recommendation §3.4-3.5, §4
checkpoints 2-3, §6 "replace"; gap list G3 #20-#41).

Per screencast segment of the plan (plan-schema beats naming PLAYBOOK actions):

  compile    beatscript.compile_segment: presses on their words, one paste per type beat, results made off
             camera and revealed with a K2 dissolve, <= 1 live generation per video held only while Jake
             talks about the wait. An action the playbook lacks / has not proven = NEEDS_PRIMITIVE -> held.
  rehearse   a DRY RUN of the compiled script OFF camera (generations blocked: dry presses, no wait), every
             beat asserted; each beat's end-state fingerprint (64-bit dHash) is captured here. A failed beat
             goes to the capped off-camera REPAIR agent ($0.50/beat, $3/video, typed tools = playbook
             actions + observe, generation blocked); its proposal is recompiled and must pass the dry run,
             else the beat is needs_primitive and the job is held. A beat is never silently dropped and
             never replaced by A-roll.
  open_clean the playbook start_state: set-dressing actions (Chat mode, sidebar hidden), empty composer, no
             attachment, dark theme, the account pinned to Jake (switched back — never a log-out); then the
             FIRST-FRAME gate (DOM facts + pixels + the start_state asserts). A dirty frame is never recorded.
  record     play_script in virtual time, every action through the click guard, every beat asserted. No
             model call is possible while Session.recording is set (llm.OnCameraCall).
  verdict    gates.take_verdict (frame guard + content QA + privacy). A failing beat is re-recorded ON ITS OWN
             from its start state (reset off camera + fingerprint check), up to 2 times; then remedy.next_action
             decides (repair agent, salvage at compose, held).
  assemble   the elastic assembler: only motionless frames move, each press lands on its word +-1 frame,
             each result +0.2..+1.4 s. Too few idle frames = a timing failure (reassemble -> re-record beat).

Outside-view segments (pricing / visitor pages, RULEBOOK L4/R9/R10) run in the separate never-logged-in
Chrome through the job's US route (usroute.outside_chrome_env); without a route they are held.
"""
import base64
import json
import os
import random
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from . import beatscript as B
from . import clickguard, config, events, gates, llm, remedy

MAX_BEAT_RETAKES = 2                     # a failing beat is re-recorded on its own up to 2 times (§4.3)
MAX_TAKE_RESTARTS = 3                    # whole-segment restarts (a wall / a first beat that fails)
RETAKE_COOLDOWN_S = float(os.environ.get("AIEDITOR_RETAKE_COOLDOWN", "20"))
WALL_COOLDOWN_S = float(os.environ.get("AIEDITOR_WALL_COOLDOWN", "180"))
HUMAN_PACE_S = (0.8, 2.0)               # off-camera actions at human pace (no burst -> no 'Unusual activity')
ACCOUNT = os.environ.get("AIEDITOR_ACCOUNT", "Jake")
REPAIR_BEAT_USD = 0.50                   # recommendation §3 agent 3
REPAIR_VIDEO_USD = 3.00
REPAIR_MODEL = "claude-sonnet-5-5"
REPAIR_TURNS = 8
DROP_KINDS = ("challenge", "account", "error")
MAX_TAKE_STEPS = 400                     # a compiled take never needs more actions (a runaway script = step exhaustion)
# compile-time keys the browser never sees
WIRE_DROP = {"assert", "camera_only", "generates", "result_of", "playbook", "filler", "alt", "payoff_t", "cursor_at"}


class Retake(RuntimeError):
    """This take (or beat) must not be kept. beat = the compiled beat id that failed."""

    def __init__(self, why, wall=None, beat=None):
        self.why, self.wall, self.beat = why, wall, beat
        super().__init__(why)


class SetupError(RuntimeError):
    """The start state could not be proven (first frame / reset fingerprint): nothing is recorded."""

    def __init__(self, why, wall=None):
        self.wall = wall
        super().__init__(why)


def human_pause(lo=None, hi=None):
    if os.environ.get("AIEDITOR_HUMAN_PACE") == "0":
        return
    time.sleep(random.uniform(lo or HUMAN_PACE_S[0], hi or HUMAN_PACE_S[1]))


def _first_frame():
    import importlib.util
    spec = importlib.util.spec_from_file_location("first_frame", config.CODE / "screencast" / "first_frame.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _set_recording(sess, on):
    """Session.recording (agentrec) flips llm's on-camera lock; any other transport gets it set directly."""
    try:
        if hasattr(type(sess), "recording") or hasattr(sess, "recording"):
            sess.recording = on
            return
    except AttributeError:
        pass
    llm.set_recording(sess, on)


# ───────────────────────── the click layer ─────────────────────────

def wire(step, record=True):
    """A compiled step -> the agent_rec.mjs action. Off camera (record=False) nothing is timed and nothing
    generates: a generating press is a dry press, a live wait is skipped, a K2 reveal is a plain goto."""
    a = {k: v for k, v in step.items() if k not in WIRE_DROP}
    if a.get("type") == "upload":
        a.pop("asset", None)
    a = B.clamp_action(a)
    if not record:
        for k in ("at", "until", "show"):
            a.pop(k, None)
        if step.get("generates"):
            a["press"] = False
        if a.get("type") == "reveal":
            a = {"type": "goto", "url": a.get("url"), "beat_id": step.get("beat_id")}
    return a


def act(sess, a, session="logged_in", alt=()):
    """One action through the click guard (Python side; agent_rec.mjs checks again in the page). A refusal is
    a beat failure, never retried with the same target. alt = the playbook's fallback targets."""
    ty = a.get("type")
    ga = {"type": "goto", "url": a.get("url")} if ty == "reveal" else {**a, "type": "click"} if ty == "drag" else a
    g = clickguard.check(ga, None, session)
    if not g.get("ok"):
        return {"ok": False, "refused": g.get("refused"), "error": f"refused by the click guard: {g.get('why')}"}
    r = sess.send({"cmd": "act", "action": a})
    if r.get("ok") or r.get("refused") or not alt:
        return r
    for t in alt:
        b = {k: v for k, v in a.items() if k not in ("selector", "target", "ref")}
        b.update(t)
        if not clickguard.check(b, None, session).get("ok"):
            continue
        r2 = sess.send({"cmd": "act", "action": b})
        if r2.get("ok"):
            return r2
    return r


def _composer(pb):
    for a in (pb or {}).get("actions", {}).values():
        if a.get("kind") == "paste" and a.get("selectors"):
            return a["selectors"][0]
    return None


def clear_composer(sess, pb, session="logged_in"):
    """S3/C3: the message box is empty (editing commands first — the browser says Mac, Cmd+A not Ctrl+A)."""
    sel = _composer(pb)
    if not sel:
        return
    act(sess, {"type": "type", "selector": sel, "text": "", "clear": True, "paste": True}, session)
    act(sess, {"type": "key", "key": "Escape"}, session)


def clear_attachments(sess, session="logged_in", limit=6):
    """S3: no leftover attachment in the composer DRAFT (removing it from a draft deletes nothing)."""
    for _ in range(limit):
        r = act(sess, {"type": "click", "selector": 'button[aria-label^="Remove "][aria-label*="."]'}, session)
        if not r.get("ok"):
            break


def pin_account(sess, account, log=print, session="logged_in"):
    """C4: the profile may hold a second account ('Hey, Keith'). Switch back to Jake's through the profile
    menu — a switch, never a log-out (no logout action exists; the click guard refuses one)."""
    act(sess, {"type": "click", "selector": '[data-testid="accounts-profile-button"], button[aria-label="Open profile menu"]'}, session)
    f = sess.send({"cmd": "find", "texts": [account]}).get("found", {})
    hits = [h for h in f.get(account, []) if h.get("tag") != "p"]
    if hits:
        b = hits[0]["box"]
        r = act(sess, {"type": "click", "x": (b[0] + b[2] / 2) / 1.2, "y": (b[1] + b[3] / 2) / 1.2, "target": account}, session)
        if r.get("ok"):
            log(f"recorder: switched the session back to {account}'s account")
    act(sess, {"type": "key", "key": "Escape"}, session)


# ───────────────────────── checkpoint 2: the start state + first frame ─────────────────────────

def pixel_facts(sess, shot):
    """The pixel half of the first-frame gate, run INSIDE the recorder's own container (tesseract + cv2)."""
    if not shot or not getattr(sess, "name", None):
        return None
    r = subprocess.run(["docker", "exec", sess.name, "python3", "/app/screencast/first_frame.py", shot,
                        "--account", getattr(sess, "account", None) or ACCOUNT], capture_output=True, text=True, timeout=180)
    try:
        return json.loads(r.stdout).get("facts")
    except (ValueError, AttributeError):
        return None


def first_frame_check(sess, start_state=None, account=None, pixels=True, outside=False):
    """-> (ok, reasons, state). DOM facts ({"cmd": "state"}) + the pixels of that frame + the playbook
    start_state asserts (selectors checked in the page). The outside view (never logged in, a public page)
    has no account and no app theme to prove — only a loaded, clean, wall-free first frame."""
    ff = _first_frame()
    account = "" if outside else (account or ff.account_of(start_state, getattr(sess, "account", None) or ACCOUNT))
    st = sess.send({"cmd": "state"})
    keys = ("h1", "popups", "tooltips", "loading", "blank", "text") if outside else \
        ("account", "h1", "sidebar", "draft", "attachments", "popups", "tooltips", "mode", "loading", "blank", "dark", "text")
    dom = {k: st.get(k) for k in keys}
    if outside:
        dom["require_account"] = False
    if st.get("wall"):
        dom["wall"] = f"{st['wall'].get('kind')}: {st['wall'].get('why')}"
    facts = {"dom": dom, "text": " ".join(st.get("h1") or [])}
    if pixels:
        px = pixel_facts(sess, st.get("shot"))
        if px:
            facts.update(px)
    ok, why = ff.verdict_for(facts, start_state, account)
    sels = [a["selector"] for a in (start_state or {}).get("asserts") or [] if a.get("kind") == "selector" and a.get("selector")]
    if sels:
        r = sess.send({"cmd": "assert", "selector_present": sels})
        if not r.get("ok", True):
            why = why + [f"start state: {f}" for f in r.get("fail", [])]
            ok = False
    shot = st.get("shot")
    if shot and str(shot).startswith("/w/") and ok and getattr(sess, "workdir", None):
        (Path(sess.workdir) / shot[3:]).unlink(missing_ok=True)
    return ok, why, st


def open_clean(sess, pb, seg, start_state=None, log=print, tries=3, account=None, pixels=True, session="logged_in"):
    """Set-dress OFF CAMERA from the playbook start_state, then prove the first frame before any recording.
    A failed check redoes the set-up; after `tries` -> SetupError (nothing recorded)."""
    from . import playbook as PB
    ss = start_state or (pb or {}).get("start_state") or {}
    url = seg.get("url") or ss.get("url")
    why, st = [], {}
    for k in range(tries):
        if url:
            r = sess.send({"cmd": "open", "url": url, "settle": 3})
            if (r.get("wall") or {}).get("kind") in DROP_KINDS:
                raise SetupError(f"wall on open: {r['wall'].get('why')}", wall=r["wall"])
        for aid in (pb or {}).get("set_dressing", []) if session == "logged_in" else []:
            for step in PB.resolve(pb, aid, {}):
                human_pause(0.3, 0.9)
                act(sess, wire(step, record=False), session, alt=step.get("alt") or ())
        if session == "logged_in":
            clear_composer(sess, pb, session)
            clear_attachments(sess, session)
        ok, why, st = first_frame_check(sess, ss, account, pixels=pixels, outside=session == "outside")
        if ok:
            if k:
                log(f"recorder: clean first frame after {k + 1} set-ups")
            return st
        if (st.get("wall") or {}).get("kind") in DROP_KINDS:
            raise SetupError("first frame: " + "; ".join(why), wall=st["wall"])
        log(f"recorder: first frame not clean ({'; '.join(why)[:300]}) — set-up again ({k + 1}/{tries})")
        if session == "logged_in" and any("account" in w.lower() or "greet" in w.lower() for w in why):
            pin_account(sess, account or getattr(sess, "account", None) or ACCOUNT, log, session)
    raise SetupError("first frame never clean: " + "; ".join(why))


# ───────────────────────── assets ─────────────────────────

def resolve_assets(script, assets, workdir=None):
    """$asset_url[id] -> the page the asset was made on (off camera); upload files copied into
    <workdir>/upload (the recorder sees /w/upload/<name>). -> ids that are not ready (never made live)."""
    by = {a.get("id"): a for a in (assets or {}).get("assets", [])}
    missing = []
    for s in script["steps"]:
        if s["type"] == "reveal":
            a = by.get(s.get("asset")) or {}
            url = (a.get("source") or {}).get("chat_url") or a.get("url")
            if not url or not B.asset_ready(assets, s.get("asset")):
                missing.append(s.get("asset"))
            else:
                s["url"] = url
                s.setdefault("selector", '[data-testid="generated-image-preview"]')
                s["nth"] = (a.get("source") or {}).get("image_index", -1)
        if s["type"] == "upload" and s.get("asset") and not s.get("files"):
            f = (by.get(s["asset"]) or {}).get("file")
            if f and workdir is not None and Path(f).is_file():
                (Path(workdir) / "upload").mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, Path(workdir) / "upload" / Path(f).name)
            if f and (workdir is None or (Path(workdir) / "upload" / Path(f).name).is_file()):
                s["files"] = [f"/w/upload/{Path(f).name}"]
            else:
                missing.append(s["asset"])
    return missing


# ───────────────────────── beats: windows, asserts, playing ─────────────────────────

def beat_windows(script, dur):
    """[(beat id, t0, t1)]: the slice of segment time each beat owns — from the first movement of its cursor /
    camera (never before the previous beat's last action) to the next beat's start."""
    steps, beats = script["steps"], script["beats"]
    starts = []
    prev_last = 0.0
    for k, b in enumerate(beats):
        st = [steps[i] for i in b["steps"]]
        first = min([s.get("cursor_at", s.get("at", 0.0)) for s in st] + [s.get("from", 1e9) for s in st if s.get("from") is not None]
                    + [s.get("at", 0.0) - 0.35 for s in st if s.get("type") == "type"]) if st else b.get("at", 0.0)
        press = min([s["at"] for s in st if s.get("at") is not None] or [first])
        t = 0.0 if k == 0 else min(max(first, prev_last + 0.05), press - 0.05)
        starts.append(max(t, starts[-1] + 0.01 if starts else 0.0))
        prev_last = max([s.get("at", 0.0) for s in st if s.get("at") is not None] + [prev_last])
    out = []
    for k, b in enumerate(beats):
        out.append((b["id"], round(starts[k], 4), round(starts[k + 1], 4) if k + 1 < len(beats) else round(dur + 0.5, 4)))
    return out


def end_checks(beat):
    """A beat's expected end state (playbook post asserts + must_text) -> the agent_rec 'assert' fields."""
    chk = {"present": [], "absent": [], "selector_present": []}
    for a in (beat.get("end_state") or {}).get("asserts") or []:
        k, v = a.get("kind"), a.get("value")
        if k == "text" and a.get("selector"):
            if v in ("", None):
                chk["field"], chk["field_empty"] = a["selector"], True
            else:
                chk["field"], chk["field_equals"] = a["selector"], v
        elif k in ("text", "account") and v:
            chk["present"].append(v)
        elif k == "absent" and v:
            chk["absent"].append(v)
        elif k == "absent" and a.get("selector"):
            chk.setdefault("selector_absent", []).append(a["selector"])
        elif k == "selector" and a.get("selector"):
            chk["selector_present"].append(a["selector"])
    return {k: v for k, v in chk.items() if v not in ([], None)}


def play_script(sess, script, out_rel=None, dur=None, record=True, log=print, session="logged_in", beats=None,
                t_start=0.0, until=None, fingerprints=False):
    """Play compiled beats. record=False = the off-camera dry run (no generation, nothing timed).
    beats = the beat ids to play (default all, in order); t_start = the recorder clock at the first frame of a
    piece (a single-beat retake). Each step is checked (field = script, url whitelist, walls), each beat's end
    state too. Any failure raises Retake(beat=...). A recorded take that fails is NOT aborted here: the caller
    decides (keep the frames before the failing beat, or drop the take)."""
    steps = script["steps"]
    order = [b for b in script["beats"] if beats is None or b["id"] in beats]
    allow = [u for u in script.get("url_allow", []) if u]
    dur = dur if dur is not None else script["t1"] - script["t0"]
    if record:
        r = sess.send({"cmd": "segment", "out": out_rel, "t0": round(t_start, 4)})
        _set_recording(sess, True)
    played = []
    n_steps = sum(len(b["steps"]) for b in order)
    if n_steps > MAX_TAKE_STEPS:
        raise Retake(f"step exhaustion: {n_steps} steps > {MAX_TAKE_STEPS} in one take", beat=order[0]["id"] if order else None)
    for b in order:
        idx = list(b["steps"])
        # fillers (camera holds on long quiet gaps) belong to their beat
        for i in idx:
            s = steps[i]
            if not record and s.get("type") == "wait_for":
                continue                                   # the live generation happens only in the recorded take
            if not record and s.get("camera_only"):
                continue                                   # a camera hold changes nothing in the app
            a = wire(s, record)
            res = act(sess, a, session, alt=s.get("alt") or ())
            if not res.get("ok") and s.get("camera_only") and a.get("target"):
                a = {k: v for k, v in a.items() if k != "target"}
                a.update(box=list(B.FULL_SCREEN), glide=False)
                res = act(sess, a, session)
            if not res.get("ok"):
                raise Retake(f"beat {b['id']} ({b.get('word')}) {a.get('type')} failed: {str(res.get('error', ''))[:160]}",
                             wall=res.get("wall"), beat=b["id"])
            if record and isinstance(res.get("t"), (int, float)) and res["t"] > dur + 0.5 and b is not order[-1]:
                # step exhaustion: the take ran past the segment's end with beats still to show
                raise Retake(f"step exhaustion: the take reached {res['t']:.1f}s of {dur:.1f}s at beat {b['id']} "
                             f"with {len(order) - order.index(b) - 1} beat(s) left", beat=b["id"])
            want = s.get("assert") or {}
            chk = {"cmd": "assert", "url_allow": allow}
            if "field_equals" in want:
                chk.update(field=a.get("selector"), field_equals=want["field_equals"])
            r = sess.send(chk)
            if not r.get("ok", True):
                raise Retake(f"beat {b['id']} ({b.get('word')}) assertion: {'; '.join(r.get('fail', []))[:200]}",
                             wall=r.get("wall"), beat=b["id"])
        # the beat's expected end state (text asserts) — not after a live wait in a dry run (nothing generated)
        if not (not record and b.get("live")):
            ec = end_checks(b)
            if ec:
                r = sess.send({"cmd": "assert", "url_allow": allow, **ec})
                if not r.get("ok", True):
                    raise Retake(f"beat {b['id']} ({b.get('word')}) end state: {'; '.join(r.get('fail', []))[:200]}",
                                 wall=r.get("wall"), beat=b["id"])
        if fingerprints and not record:
            fp = sess.send({"cmd": "fp"}).get("fp")
            b.setdefault("end_state", {})["fingerprint"] = None if b.get("live") else fp
        played.append(b["id"])
    if record:
        g = sess.send({"cmd": "guard"}).get("wall")
        if g and g.get("kind") in DROP_KINDS:
            raise Retake(f"{g.get('kind')}: {g.get('why')}", wall=g, beat=played[-1] if played else None)
        sess.send({"cmd": "end", "until": round(until if until is not None else dur + 0.5, 4)})
        _set_recording(sess, False)
    return played


def record_take(sess, pb, seg, script, out_rel, log=print, session="logged_in", pixels=True, account=None):
    """ONE whole take of a compiled segment from its proven start state. A failed wait_for, a failed action or
    assertion, a wall ('Unusual activity has been detected', an error banner) or step exhaustion DROPS the take:
    -> {"status": "retake", "why", "wall", "beat"} and NO events.json (nothing downstream can mistake it for a
    finished recording). -> {"status": "ok"} with events.json written."""
    dur = script["t1"] - script["t0"]
    try:
        open_clean(sess, pb, seg, script.get("start_state"), log, account=account, pixels=pixels, session=session)
        play_script(sess, script, out_rel, dur, record=True, log=log, session=session)
        return {"status": "ok", "why": ""}
    except (Retake, SetupError) as e:
        _set_recording(sess, False)
        sess.send({"cmd": "abort"})
        if getattr(sess, "workdir", None) and out_rel:
            shutil.rmtree(Path(sess.workdir) / out_rel, ignore_errors=True)
        return {"status": "retake", "why": str(e), "wall": getattr(e, "wall", None), "beat": getattr(e, "beat", None)}


# ───────────────────────── take files: pieces, merge ─────────────────────────

def _load(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def set_state(sd, **kw):
    """seg-NN/gate.json — the take/remedy state gates.take_verdict reads (from fix/G4)."""
    st = gates.load_state(sd)
    st.update(kw)
    Path(sd).mkdir(parents=True, exist_ok=True)
    (Path(sd) / "gate.json").write_text(json.dumps(st, indent=1))
    return st


def archive_take(sd, n):
    """Keep a rejected take: seg-NN/rec -> seg-NN/takes/take-N (from fix/G4)."""
    sd = Path(sd)
    dst = sd / "takes" / f"take-{n}"
    shutil.rmtree(dst, ignore_errors=True)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if (sd / "rec").exists():
        os.replace(sd / "rec", dst)
    return dst


def keep_best_take(sd):
    """After the retakes: the take with the fewest bad seconds becomes rec (from fix/G4)."""
    sd = Path(sd)
    best, best_bad = None, None
    for d_ in [sd / "rec"] + sorted((sd / "takes").glob("take-*")):
        bad = (_load(d_ / "take.json", {}) or {}).get("bad_s")
        if bad is None or not (d_ / "events.json").exists():
            continue
        if best_bad is None or float(bad) < best_bad:
            best, best_bad = d_, float(bad)
    if best is None or best == sd / "rec":
        return "last"
    archive_take(sd, f"{gates.takes_of(sd)}-last")
    os.replace(best, sd / "rec")
    return best.name


def merge_pieces(rec, pieces):
    """rec/events.json + rec/privacy.json from the pieces (each keeps only its own window) + pieces.json."""
    rec = Path(rec)
    base = None
    evs, cur, walls, priv = [], [], [], []
    for pc in pieces:
        d = rec / Path(pc["file"]).parent
        ev = _load(d / "events.json", {}) or {}
        base = base or ev
        inside = lambda t: t is not None and pc["t0"] - 1e-6 <= t < pc["t1"] - 1e-6
        evs += [{**e, **({"piece": pc["name"]} if pc.get("name") else {})} for e in ev.get("events", []) if inside(e.get("t"))]
        cur += [c for c in ev.get("cursor", []) if inside(c[0])]
        walls += [w for w in ev.get("walls", []) if inside(w.get("t"))]
        priv += [p for p in (_load(d / "privacy.json", []) or []) if inside(p.get("t"))]
    out = dict(base or {})
    out.update(events=evs, cursor=cur, walls=walls, t0=0.0, pieces=pieces,
               end=max([pc["t1"] for pc in pieces] + [0.0]))
    (rec / "events.json").write_text(json.dumps(out, indent=1))
    (rec / "privacy.json").write_text(json.dumps(priv))
    (rec / "pieces.json").write_text(json.dumps({"pieces": pieces}, indent=1))
    return out


class DockerMedia:
    """The frame side of a take, one short-lived screencast-image container per call (never compose)."""

    def __init__(self, cancelled=lambda: False):
        self.cancelled = cancelled

    def _run(self, rec, args):
        name = f"aieditor-assemble-{uuid.uuid4().hex[:8]}"
        cmd = ["docker", "run", "--rm", "--name", name, "--cpuset-cpus", config.CPUSET, "--memory", "2g", "--network", "none",
               "-v", f"{config.CODE / 'screencast'}:/app/screencast:ro", "-v", f"{rec}:/r", "--entrypoint", "python3",
               config.SC_IMAGE, "/app/screencast/assemble.py"] + args
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if r.returncode:
            raise RuntimeError(f"assemble {args[0]} failed: {r.stderr[-400:]}")
        return r.stdout

    def concat(self, rec, pieces):
        if len(pieces) == 1 and pieces[0].get("file_t0", 0.0) == 0.0 and pieces[0]["t0"] == 0.0:
            shutil.copyfile(Path(rec) / pieces[0]["file"], Path(rec) / "raw.mp4")
            return
        self._run(rec, ["concat", "/r/raw.mp4", "--pieces", "/r/pieces.json"])

    def motion(self, rec, src="raw.take.mp4"):
        self._run(rec, ["motion", f"/r/{src}", "--out", "/r/motion.json"])
        return (_load(Path(rec) / "motion.json", {}) or {}).get("motion", [])

    def render(self, rec, frames, src="raw.take.mp4"):
        (Path(rec) / "frames.json").write_text(json.dumps({"frames": frames, "fps": B.FPS}))
        self._run(rec, ["render", f"/r/{src}", "--frames", "/r/frames.json", "--out", "/r/raw.mp4"])


def assemble(rec, script, dur, media, log=print):
    """The elastic assembler on the composed take: rec/raw.mp4 is kept as raw.take.mp4 (events.take.json),
    the re-timed screen clip replaces raw.mp4. -> the elastic_map report (failures = timing)."""
    rec = Path(rec)
    ev = _load(rec / "events.take.json") or _load(rec / "events.json", {}) or {}
    if not (rec / "raw.take.mp4").exists():
        shutil.copyfile(rec / "raw.mp4", rec / "raw.take.mp4")
        (rec / "events.take.json").write_text(json.dumps(ev, indent=1))
    motion = media.motion(rec, "raw.take.mp4")
    fps = (ev.get("capture") or {}).get("fps") or B.FPS
    cur = {int(round(c[0] * fps)): (c[1], c[2]) for c in ev.get("cursor", []) if len(c) >= 3}
    cursor = [cur.get(i) for i in range(len(motion))]
    anchors = B.anchors_from(ev.get("events", []), fps)
    out_frames = int(round(dur * fps))
    em = B.elastic_map(motion, anchors, out_frames, cursor=cursor, fps=fps)
    media.render(rec, em["frames"], "raw.take.mp4")
    new = B.retime_events(ev, em["frames"], fps)
    new["retime"] = {k: em[k] for k in ("dropped", "duplicated", "anchors", "ok", "failures", "trimmed_tail", "held_tail")}
    (rec / "events.json").write_text(json.dumps(new, indent=1))
    priv = _load(rec / "privacy.json", []) or []
    for p in priv:
        p["t"] = B.remap_time(p.get("t", 0.0), em["frames"], fps)
    (rec / "privacy.json").write_text(json.dumps(priv))
    log(f"recorder: assembled {rec.parent.name}: {len(em['dropped'])} idle frame(s) dropped, {len(em['duplicated'])} "
        f"repeated, {sum(1 for a in em['anchors'] if a['ok'])}/{len(em['anchors'])} anchors on their word")
    return em


# ───────────────────────── agent 3: the capped OFF-CAMERA beat repair ─────────────────────────

class RepairBudget:
    """$0.50 per beat, $3 per video (recommendation §3 agent 3); persisted in the edit dir, every call is also
    in the API ledger (llm.py)."""

    def __init__(self, path=None, beat_cap=REPAIR_BEAT_USD, video_cap=REPAIR_VIDEO_USD):
        self.path = Path(path) if path else None
        self.beat_cap, self.video_cap = beat_cap, video_cap
        doc = _load(self.path, {}) if self.path else {}
        self.beats = dict((doc or {}).get("beats") or {})

    @property
    def video_usd(self):
        return round(sum(self.beats.values()), 6)

    def spent(self, beat):
        return self.beats.get(beat, 0.0)

    def charge(self, beat, usd):
        self.beats[beat] = round(self.beats.get(beat, 0.0) + float(usd or 0.0), 6)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"beats": self.beats, "video_usd": self.video_usd,
                                             "caps": {"beat": self.beat_cap, "video": self.video_cap}}, indent=1))

    def room(self, beat):
        return min(self.beat_cap - self.spent(beat), self.video_cap - self.video_usd)


REPAIR_SYSTEM = """You repair ONE beat of a screencast for Jake Dawson's tutorial, OFF CAMERA (nothing you do is
recorded). The beat failed its dry run. You may ONLY use the app's proven playbook actions listed below, plus
"observe". Generations are blocked (a generating action is a dry press). Never invent a selector, a URL or a step
that is not in the list; never log out, delete, buy, upgrade, share or open billing.

Reply with ONE JSON object and nothing else:
  {"tool": "observe"}                                    see the page (elements + url)
  {"tool": "<action id>", "params": {...}}                run one playbook action now (to test it)
  {"propose": [{"action": "<id>", "params": {...}}, ...], "why": "..."}
        the playbook actions that make the beat work, in order, ENDING with the beat's own action
  {"give_up": "<why>"}                                   no playbook action can show it (needs_primitive)"""


def _parse_json(text):
    i = (text or "").find("{")
    while i != -1:
        try:
            v, _ = json.JSONDecoder().raw_decode(text[i:])
            return v if isinstance(v, dict) else {}
        except json.JSONDecodeError:
            i = text.find("{", i + 1)
    return {}


def repair_beat(sess, pb, script, beat, failure, budget, log=print, session="logged_in", call=None, turns=REPAIR_TURNS):
    """The capped off-camera repair agent for ONE failed beat. -> {"ok", "proposal", "usd", "why", "capped"}.
    Every call goes through llm.messages (API ledger + caps; refused while recording); the spend is checked
    against $0.50 for this beat and $3 for the video BEFORE each call and charged AFTER it."""
    from . import playbook as PB
    call = call or llm.messages
    bid = beat["id"]
    acts = {k: a for k, a in pb.get("actions", {}).items()}
    usable = {k for k, a in acts.items() if a.get("proven") or PB.skill.rules().get("playbooks", {}).get("allow_unproven")}
    if budget.video_usd >= budget.video_cap:
        return {"ok": False, "proposal": None, "usd": 0.0, "why": f"video repair cap ${budget.video_cap:.2f} reached",
                "capped": "video"}
    listing = "\n".join(f"- {k}: {a.get('kind')} '{a.get('label')}'" + (f" params {json.dumps(a.get('params'))}" if a.get("params") else "")
                        + (" (generates: dry press here)" if a.get("generates") else "") for k, a in acts.items() if k in usable)
    steps = [script["steps"][i] for i in beat["steps"]]
    history = []
    usd = 0.0
    for _ in range(turns):
        content = (f"PLAYBOOK ACTIONS ({pb.get('app')}):\n{listing}\n\nTHE BEAT: {bid} on the word '{beat.get('word')}': "
                   f"action {beat.get('action')} -> compiled steps {json.dumps([wire(s, False) for s in steps])[:1500]}\n"
                   f"IT FAILED: {failure}\n\nSO FAR:\n" + ("\n".join(history[-10:]) or "(nothing)") + "\n\nNext?")
        system = [{"type": "text", "text": REPAIR_SYSTEM}]
        est = llm.estimate(REPAIR_MODEL, system, [{"role": "user", "content": content}], 1200)
        if est > budget.room(bid):
            capped = "video" if budget.video_cap - budget.video_usd <= budget.beat_cap - budget.spent(bid) else "beat"
            return {"ok": False, "proposal": None, "usd": usd, "capped": capped,
                    "why": f"repair cap reached for {'the video' if capped == 'video' else 'this beat'} "
                           f"(${budget.spent(bid):.2f} on {bid}, ${budget.video_usd:.2f} on the video)"}
        try:
            r = call(REPAIR_MODEL, system, content, 1200, effort="medium", thinking=False,
                     purpose=f"beat repair {bid} (off camera)", stage="repair")
        except llm.OnCameraCall:
            raise
        u = float(r.get("usd", 0.0) or 0.0)
        usd += u
        budget.charge(bid, u)
        reply = _parse_json(r.get("text", ""))
        if budget.spent(bid) > budget.beat_cap or budget.video_usd > budget.video_cap:
            capped = "video" if budget.video_usd > budget.video_cap else "beat"
            return {"ok": False, "proposal": None, "usd": usd, "capped": capped,
                    "why": f"repair spend passed the {'video $3' if capped == 'video' else 'beat $0.50'} cap "
                           f"(${budget.spent(bid):.2f} on {bid})"}
        if reply.get("give_up"):
            return {"ok": False, "proposal": None, "usd": usd, "why": f"repair agent: {str(reply['give_up'])[:200]}"}
        if isinstance(reply.get("propose"), list):
            prop = [p for p in reply["propose"] if isinstance(p, dict)]
            bad = [p.get("action") for p in prop if p.get("action") not in usable]
            if bad or not prop or prop[-1].get("action") != beat.get("action"):
                history.append(f"- proposal refused: {'unknown/unproven ' + str(bad) if bad else 'must end with ' + str(beat.get('action'))}")
                continue
            return {"ok": True, "proposal": prop, "usd": usd, "why": str(reply.get("why", ""))[:200]}
        tool = reply.get("tool")
        if tool == "observe":
            o = sess.send({"cmd": "observe"})
            items = "; ".join(f'{i.get("tag")} "{str(i.get("text"))[:40]}"' for i in (o.get("items") or [])[:60])
            shot = o.get("shot")
            if shot and str(shot).startswith("/w/") and getattr(sess, "workdir", None):
                (Path(sess.workdir) / shot[3:]).unlink(missing_ok=True)
            history.append(f"- observe: {o.get('url', '')} :: {items}"[:1500])
        elif tool in usable:
            try:
                res_all = []
                for st in PB.resolve(pb, tool, reply.get("params") or {}):
                    a = wire({**st, "generates": acts[tool].get("generates")}, record=False)
                    if a.get("type") == "wait_for":
                        res_all.append("skipped (generation blocked)")
                        continue
                    human_pause()
                    res = act(sess, a, session, alt=st.get("alt") or ())
                    res_all.append("ok" if res.get("ok") else str(res.get("error", "failed"))[:120])
                history.append(f"- {tool} {json.dumps(reply.get('params') or {})[:120]} -> {', '.join(res_all)}")
            except Exception as e:  # noqa: BLE001 — a bad param is the agent's mistake, reported back to it
                history.append(f"- {tool}: {e}")
        else:
            history.append(f"- refused: '{tool}' is not a proven playbook action (typed tools only)")
    return {"ok": False, "proposal": None, "usd": usd, "why": f"no working proposal in {turns} turns"}


def apply_repair(seg, beat_id, proposal):
    """A repair proposal -> the plan segment with the beat's action/params replaced and its pre-actions added
    as plan beats a hair before it (they are recompiled and must pass the dry run like any beat)."""
    seg = json.loads(json.dumps(seg))
    beats = seg.get("beats") or []
    k = next((i for i, b in enumerate(beats) if (b.get("id") or f"b{i:02d}") == beat_id), None)
    if k is None:
        return seg
    b = beats[k]
    *pre, last = proposal
    b["params"] = {**(b.get("params") or {}), **(last.get("params") or {})}
    prev_t = beats[k - 1]["t_word"] if k else seg["t0"]
    new = []
    for j, p in enumerate(pre):
        t = b["t_word"] - 0.9 - 0.45 * (len(pre) - j)
        t = max(t, prev_t + 0.15 * (j + 1))
        new.append({"id": f"{beat_id}r{j}", "t_word": round(min(t, b["t_word"] - 0.2), 3),
                    "clause_start": round(min(t, b["t_word"] - 0.2), 3), "action": p["action"],
                    "params": p.get("params") or {}, "word": b.get("word"), "repair_of": beat_id})
    seg["beats"] = beats[:k] + new + beats[k:]
    return seg


# ───────────────────────── plan -> plan-schema segments ─────────────────────────

def app_for(url, playbooks):
    host = re.sub(r"^https?://", "", url or "").split("/")[0].lower()
    for app, pb in (playbooks or {}).items():
        if any(host == h or host.endswith("." + h) for h in pb.get("hosts", [])):
            return app
    return None


def schema_segments(plan, words, playbooks, allow_intent=False):
    """plan["segments"] -> plan-schema segments {t0, t1, app, session, url, beats}. Beats come from the plan
    (single plan call). The regex intent ledger is used ONLY when allow_intent (offline / dev opt-in) — in
    factory mode a segment without plan-schema beats is needs_primitive, never improvised."""
    out = []
    for i, s in enumerate(plan.get("segments") or []):
        seg = dict(s)
        sess = s.get("session")
        seg["session"] = "outside" if (sess.get("kind") if isinstance(sess, dict) else sess) in ("public", "outside", "visitor") else "logged_in"
        seg["app"] = s.get("app") or app_for(s.get("url"), playbooks)
        beats = gates.plan_beats(s)              # the single plan call's schema beats (director.validate "actions")
        if not beats and allow_intent and seg["app"] in (playbooks or {}):
            beats = B.beats_from_intent(s, words, playbooks[seg["app"]], i)
        seg["beats"] = [dict(b, id=b.get("id") or f"s{i:02d}b{k:02d}") for k, b in enumerate(beats or [])]
        out.append(seg)
    return out


def intent_ledger_allowed():
    return (not config.FACTORY_SERVER) and os.environ.get("AIEDITOR_INTENT_LEDGER") == "1"


# ───────────────────────── checkpoint 3: the per-take verdict ─────────────────────────

def docker_verdict(w, i, expect_p=None, account=None, cancelled=lambda: False):
    """gates.take_verdict on one take: qa_frames.py (--only) + qa_content.py (--only) in short-lived containers."""
    w = Path(w)
    sd = w / f"seg-{i:02d}"
    outf, outc = sd / "take-frames.json", sd / "take-content.json"
    base = ["docker", "run", "--rm", "--cpuset-cpus", config.CPUSET, "--memory", config.MEMORY, "--network", "none",
            "-v", f"{config.CODE}:/a:ro", "-v", f"{w}:/w", "--entrypoint", "sh", config.SC_IMAGE, "-c"]
    exp = f" --expect /w/{Path(expect_p).name}" if expect_p else ""
    acc = f" --account {account}" if account else ""
    subprocess.run(base + [f"python3 /a/screencast/qa_frames.py /w --only {i} --every {gates.GUARD_EVERY_S} "
                           f"--out /w/seg-{i:02d}/{outf.name}{exp}{acc} > /dev/null; true"], capture_output=True, timeout=3600)
    if expect_p:
        subprocess.run(base + [f"python3 /a/screencast/qa_content.py /w /w/{Path(expect_p).name} --only {i} --no-camera "
                               f"--out /w/seg-{i:02d}/{outc.name} > /dev/null; true"], capture_output=True, timeout=3600)
    expect = _load(expect_p, {}) if expect_p else {}
    return gates.take_verdict(sd, expect, _load(outf, {}), _load(outc, {}), _load(sd / "rec" / "privacy.run.json"))


def beat_at(windows, t):
    """The compiled beat whose window holds segment second t."""
    if t is None:
        return None
    for bid, a, b in windows:
        if a - 1e-6 <= float(t) < b:
            return bid
    return windows[-1][0] if windows else None


# ───────────────────────── one segment ─────────────────────────

class Recorder:
    """Records every screencast of one edit (edit-NN dir `w`) from the plan-schema segments."""

    def __init__(self, w, playbooks, assets, video, *, new_session, verdict=None, media=None, log=print,
                 cancelled=lambda: False, sleep=time.sleep, pixels=True, repair_call=None, expect_p=None,
                 account=ACCOUNT, progress=None, outside_env=None):
        self.w = Path(w)
        self.playbooks = playbooks or {}
        self.assets = assets if assets is not None else {"assets": []}
        self.video = video
        self.words = video["words"]
        self.new_session = new_session          # (app, session_kind, fresh) -> a Session-like transport
        self.verdict = verdict
        self.media = media
        self.log = log
        self.cancelled = cancelled
        self.sleep = sleep
        self.pixels = pixels
        self.repair_call = repair_call
        self.expect_p = expect_p
        self.account = account
        self.progress = progress or (lambda m, f: None)
        self.live_left = 1
        self.sessions = {}
        self.budget = RepairBudget(self.w / "repair-budget.json")
        self.usd = 0.0

    # sessions: one browser per (app, session kind); a wall -> a FRESH one after a cooldown
    def session(self, app, kind, fresh=False):
        key = (app, kind)
        if fresh and key in self.sessions:
            try:
                self.sessions.pop(key).close()
            except Exception:  # noqa: BLE001
                pass
        if key not in self.sessions:
            self.sessions[key] = self.new_session(app, kind, fresh)
        return self.sessions[key]

    def close(self):
        for s in self.sessions.values():
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass
        self.sessions.clear()

    def _status(self, sd, status, seg, why, **extra):
        sd.mkdir(parents=True, exist_ok=True)
        doc = {"status": status, "t0": seg.get("t0"), "t1": seg.get("t1"), "url": seg.get("url"), "app": seg.get("app"),
               "session": seg.get("session"), "why": why, **extra}
        (sd / "recording.json").write_text(json.dumps(doc, indent=1))
        return doc

    # the dry run (rehearsal) + repair loop -> a script that passed it, or a held status
    def rehearse(self, i, seg, pb, sess, kind):
        sd = self.w / f"seg-{i:02d}"
        sd.mkdir(parents=True, exist_ok=True)
        tried_repair = set()
        for attempt in range(4):
            try:
                sc = B.compile_segment(seg, self.words, pb, i, assets=self.assets, live_left=self.live_left,
                                       doodles=self._doodles())
            except B.CompileError as e:
                return None, {"status": e.kind if e.kind == B.NEEDS_PRIMITIVE else B.NEEDS_PRIMITIVE, "why": str(e),
                              "beats": e.beats}
            missing = resolve_assets(sc, self.assets, getattr(sess, "workdir", None))
            if missing:
                return None, {"status": B.NEEDS_ASSET, "why": "results not made off camera yet (assets.json): "
                              + ", ".join(sorted(set(map(str, missing)))), "beats": []}
            try:
                open_clean(sess, pb, seg, sc.get("start_state"), self.log, account=self.account, pixels=self.pixels, session=kind)
                sc["start_state"]["fingerprint"] = sess.send({"cmd": "fp"}).get("fp")
                play_script(sess, sc, record=False, log=self.log, session=kind, fingerprints=True)
                (sd).mkdir(parents=True, exist_ok=True)
                (sd / "script.compiled.json").write_text(json.dumps({k: v for k, v in sc.items() if k != "assets"}, indent=1))
                return sc, None
            except SetupError as e:
                if e.wall:
                    return None, {"status": "wall", "why": str(e), "wall": e.wall}
                return None, {"status": "held", "why": f"start state: {e}", "beats": []}
            except Retake as e:
                if e.wall and (e.wall or {}).get("kind") in DROP_KINDS:
                    return None, {"status": "wall", "why": e.why, "wall": e.wall}
                bid = e.beat
                beat = next((b for b in sc["beats"] if b["id"] == bid), None)
                if beat is None or bid in tried_repair:
                    return None, {"status": B.NEEDS_PRIMITIVE, "why": f"rehearsal: {e.why} (repair did not pass the dry run)",
                                  "beats": [{"beat": bid, "status": "repair_failed", "why": e.why}]}
                tried_repair.add(bid)
                self.log(f"recorder: rehearsal of screencast {i + 1} failed at {bid} ({e.why[:160]}) — off-camera repair")
                try:
                    open_clean(sess, pb, seg, sc.get("start_state"), self.log, account=self.account, pixels=self.pixels, session=kind)
                    if beat["n"]:
                        play_script(sess, sc, record=False, session=kind, beats=[b["id"] for b in sc["beats"][:beat["n"]]])
                except (SetupError, Retake) as e2:
                    return None, {"status": B.NEEDS_PRIMITIVE, "why": f"rehearsal: {e.why}; reset for repair failed: {e2}",
                                  "beats": [{"beat": bid, "status": "repair_failed", "why": str(e2)}]}
                rp = repair_beat(sess, pb, sc, beat, e.why, self.budget, self.log, kind, call=self.repair_call)
                self.usd += rp.get("usd", 0.0)
                (sd / "repair.json").write_text(json.dumps({"beat": bid, "failure": e.why, **rp}, indent=1))
                if not rp["ok"]:
                    return None, {"status": B.NEEDS_PRIMITIVE, "why": f"beat {bid}: {e.why}; repair: {rp['why']}",
                                  "beats": [{"beat": bid, "status": "repair_failed", "why": rp["why"],
                                             "capped": rp.get("capped")}]}
                seg = apply_repair(seg, bid, rp["proposal"])
        return None, {"status": B.NEEDS_PRIMITIVE, "why": "rehearsal did not pass", "beats": []}

    def _doodles(self):
        try:
            from . import preprod
            return B.doodles_from(self.assets, preprod.doodle_svg)
        except Exception:  # noqa: BLE001
            return []

    def reset_to(self, sess, pb, seg, sc, k, kind):
        """Single-beat retake: the start state of beat k OFF camera — set-dressed start, beats < k dry, then the
        fingerprint must match beat k-1's rehearsed end state."""
        open_clean(sess, pb, seg, sc.get("start_state"), self.log, account=self.account, pixels=self.pixels, session=kind)
        if k == 0:
            return
        ids = [b["id"] for b in sc["beats"][:k]]
        play_script(sess, sc, record=False, session=kind, beats=ids)
        want = (sc["beats"][k - 1].get("end_state") or {}).get("fingerprint")
        fp = sess.send({"cmd": "fp"}).get("fp")
        if not B.same_state(fp, want):
            raise SetupError(f"reset to {sc['beats'][k]['id']}: screen differs from the rehearsed end of "
                             f"{ids[-1]} (dHash distance {B.hamming(fp, want)})")

    def record_segment(self, i, seg):
        sd = self.w / f"seg-{i:02d}"
        rec = sd / "rec"
        kind = seg.get("session") or "logged_in"
        app = seg.get("app")
        pb = self.playbooks.get(app)
        dur = float(seg["t1"]) - float(seg["t0"])
        if not pb:
            return self._status(sd, B.NEEDS_PRIMITIVE, seg, f"no proven playbook for app {app!r} ({seg.get('url')})")
        if not seg.get("beats"):
            return self._status(sd, B.NEEDS_PRIMITIVE, seg, "the plan names no playbook beats for this screencast "
                                "(single plan call; the regex intent ledger is off in factory mode)")
        sess = self.session(app, kind)
        walls = 0
        sc = None
        for _ in range(MAX_TAKE_RESTARTS):
            sc, bad = self.rehearse(i, seg, pb, sess, kind)
            if bad and bad["status"] == "wall":
                walls += 1
                self.log(f"recorder: {app} wall while rehearsing screencast {i + 1} ({bad['why'][:120]}) — fresh session after a cooldown")
                self.sleep(WALL_COOLDOWN_S * walls)
                sess = self.session(app, kind, fresh=True)
                continue
            break
        if sc is None:
            st = bad["status"] if bad["status"] != "wall" else "challenge"
            return self._status(sd, st, seg, bad["why"], beats=bad.get("beats", []))
        windows = beat_windows(sc, dur)
        state = {"beat_retakes": {}, "takes": 0, "remedies": []}
        shutil.rmtree(rec, ignore_errors=True)
        rec.mkdir(parents=True, exist_ok=True)
        pieces = []
        restarts = 0
        # ── the take (and, on a failing beat, the piece from that beat on) ──
        k_from = 0
        while k_from < len(sc["beats"]):
            bid = sc["beats"][k_from]["id"]
            t_start = windows[k_from][1]
            whole = k_from == 0 and not pieces
            # a whole take of the segment, or a PIECE from the failing beat on (earlier beats are kept)
            name = f"take-{state['takes'] + 1}" if whole else f"beats/{bid}-t{state['beat_retakes'].get(bid, 0) + 1}"
            out_rel = f"seg-{i:02d}/rec/{name}"
            shutil.rmtree(self.w / out_rel, ignore_errors=True)
            try:
                if whole:
                    state["takes"] += 1
                self.reset_to(sess, pb, seg, sc, k_from, kind)
                played = play_script(sess, sc, out_rel, dur, record=True, log=self.log, session=kind,
                                     beats=[b["id"] for b in sc["beats"][k_from:]], t_start=t_start)
                pieces.append({"name": name, "file": f"{name}/raw.mp4", "file_t0": t_start, "t0": t_start,
                               "t1": round(dur + 0.5, 4), "beats": played})
                break
            except (Retake, SetupError) as e:
                _set_recording(sess, False)
                wall = getattr(e, "wall", None)
                fb = getattr(e, "beat", None)
                kf = next((k for k, b in enumerate(sc["beats"]) if b["id"] == fb), k_from)
                if isinstance(e, Retake) and kf > k_from and not (wall and wall.get("kind") in DROP_KINDS):
                    # keep the frames BEFORE the failing beat; re-record from that beat on, on its own
                    sess.send({"cmd": "end", "until": windows[kf][1]})
                    pieces.append({"name": name, "file": f"{name}/raw.mp4", "file_t0": t_start, "t0": t_start,
                                   "t1": windows[kf][1], "beats": [b["id"] for b in sc["beats"][k_from:kf]]})
                else:
                    sess.send({"cmd": "abort"})
                    shutil.rmtree(self.w / out_rel, ignore_errors=True)
                if isinstance(e, Retake) and sc["beats"][kf].get("live"):
                    # the ONE live generation was already pressed on camera: a retake would generate a second time
                    # in the account (spacing / 'Unusual activity', <= 1 live generation per video) -> held
                    shutil.rmtree(rec, ignore_errors=True)
                    set_state(sd, takes=state["takes"], beat_retakes=state["beat_retakes"], beat_log=state.get("log", []))
                    return self._status(sd, "held", seg, f"the live generation beat {sc['beats'][kf]['id']} failed after its "
                                        f"press ({str(e)[:200]}); a second live generation is not allowed", beats=[{"beat": sc["beats"][kf]["id"]}])
                n = state["beat_retakes"].get(sc["beats"][kf]["id"], 0) + 1
                state["beat_retakes"][sc["beats"][kf]["id"]] = n
                ev = {"beat": sc["beats"][kf]["id"], "retake": n, "why": str(e)[:300]}
                state.setdefault("log", []).append(ev)
                self.log(f"recorder: screencast {i + 1} beat {ev['beat']} failed ({ev['why'][:160]}) — "
                         f"re-recording it on its own ({n}/{MAX_BEAT_RETAKES})")
                events.emit("step", f"retake screencast {i + 1} beat {ev['beat']}: {ev['why'][:160]}", level="warn")
                if wall and wall.get("kind") in DROP_KINDS:
                    walls += 1
                    self.sleep(WALL_COOLDOWN_S * walls)
                    sess = self.session(app, kind, fresh=True)
                else:
                    self.sleep(RETAKE_COOLDOWN_S)
                if n > MAX_BEAT_RETAKES or restarts >= MAX_TAKE_RESTARTS * 3:
                    shutil.rmtree(rec, ignore_errors=True)
                    set_state(sd, **{k: v for k, v in state.items() if k != "log"}, beat_log=state.get("log", []))
                    nxt = remedy.next_action("wrong_content", ["rerecord_beat"] * MAX_BEAT_RETAKES)
                    return self._status(sd, "held", seg, f"beat {ev['beat']} failed {n} takes ({ev['why'][:200]}); next remedy "
                                        f"{nxt} needs the repair loop before recording", beats=[ev], remedy=nxt)
                restarts += 1
                k_from = kf
        merge_pieces(rec, pieces)
        if self.media:
            self.media.concat(rec, pieces)
        retakes = [x for x in state.get("log", [])]
        set_state(sd, takes=state["takes"], beat_retakes=state["beat_retakes"], beat_log=retakes)
        # ── checkpoint 3: the take verdict; a failing beat is re-recorded ON ITS OWN ──
        v = None
        for _ in range(MAX_BEAT_RETAKES + 1):
            if not self.verdict:
                break
            v = self.verdict(self.w, i, sc)
            fails = [p for p in v.get("problems", []) if p.get("problem") in ("wrong_content", "challenge")]
            if v.get("ok") or not fails:
                break
            todo = []
            for p in fails:
                bid = beat_at(windows, p.get("t0"))
                if bid and bid not in [x[0] for x in todo]:
                    tried = gates.load_state(sd).get("remedies_by_beat", {}).get(bid, [])
                    nxt = remedy.next_action(p["problem"], tried)
                    todo.append((bid, nxt, p))
            did = False
            for bid, nxt, p in todo:
                st = gates.load_state(sd)
                rb = st.get("remedies_by_beat", {})
                rb.setdefault(bid, []).append(nxt)
                set_state(sd, remedies_by_beat=rb, remedies=st.get("remedies", []) + [nxt])
                if nxt not in ("rerecord_beat", "retry_once"):
                    self.log(f"recorder: screencast {i + 1} beat {bid}: {p.get('kind')} — next remedy {nxt} (compose / held)")
                    continue
                k = next(k for k, b in enumerate(sc["beats"]) if b["id"] == bid)
                ok = self.retake_beat(i, seg, pb, sc, k, windows, pieces, kind, dur, state, why=p.get("why"))
                did = did or ok
            if not did:
                break
            merge_pieces(rec, pieces)
            if self.media:
                self.media.concat(rec, pieces)
        # ── the elastic assembler (timing) ──
        em = None
        if self.media:
            em = assemble(rec, sc, dur, self.media, self.log)
            tries = 0
            while not em["ok"] and tries < MAX_BEAT_RETAKES:
                tries += 1
                late = [a for a in em["anchors"] if not a["ok"] and a.get("beat")]
                bid = next((b["id"] for b in sc["beats"] if b["id"] == late[0]["beat"]), None) if late else None
                if bid is None:
                    break
                k = next(k for k, b in enumerate(sc["beats"]) if b["id"] == bid)
                self.log(f"recorder: screencast {i + 1} beat {bid} cannot be re-timed onto its word with idle frames — "
                         "re-recording that beat (remedy: reassemble -> rerecord_beat)")
                if not self.retake_beat(i, seg, pb, sc, k, windows, pieces, kind, dur, state, why="timing"):
                    break
                for f in ("raw.take.mp4", "events.take.json"):
                    (rec / f).unlink(missing_ok=True)
                merge_pieces(rec, pieces)
                self.media.concat(rec, pieces)
                em = assemble(rec, sc, dur, self.media, self.log)
        self.live_left -= sc.get("live", 0)
        set_state(sd, takes=state["takes"], beat_retakes=state["beat_retakes"], beat_log=state.get("log", []),
                  pieces=[p["name"] for p in pieces], timing_ok=None if em is None else em["ok"])
        doc = self._status(sd, "ok" if em is None or em["ok"] else "timing", seg,
                           "" if em is None or em["ok"] else "; ".join(f["why"] for f in em["failures"])[:400],
                           beats=[{"id": b["id"], "word": b.get("word"), "action": b.get("action")} for b in sc["beats"]],
                           beat_retakes=state["beat_retakes"], pieces=[p["name"] for p in pieces],
                           verdict=(v or {}).get("reasons") if v else None,
                           timing=None if em is None else {"ok": em["ok"], "failures": em["failures"], "reachable": em["reachable"]})
        return doc

    def retake_beat(self, i, seg, pb, sc, k, windows, pieces, kind, dur, state, why=""):
        """Re-record beat k ON ITS OWN: reset off camera, record its window as a piece, splice it in."""
        bid, t0, t1 = windows[k]
        n = state["beat_retakes"].get(bid, 0) + 1
        if n > MAX_BEAT_RETAKES:
            return False
        if sc["beats"][k].get("live"):
            self.log(f"recorder: beat {bid} is the live generation — not re-recorded (a second live generation is not "
                     "allowed); compose salvages around it")
            return False
        state["beat_retakes"][bid] = n
        state.setdefault("log", []).append({"beat": bid, "retake": n, "why": str(why)[:300]})
        name = f"beats/{bid}-t{n + 1}"
        out_rel = f"seg-{i:02d}/rec/{name}"
        sess = self.session(seg.get("app"), kind)
        try:
            self.reset_to(sess, pb, seg, sc, k, kind)
            play_script(sess, sc, out_rel, dur, record=True, log=self.log, session=kind, beats=[bid], t_start=t0,
                        until=t1 + 0.2)
        except (Retake, SetupError) as e:
            _set_recording(sess, False)
            sess.send({"cmd": "abort"})
            self.log(f"recorder: retake of beat {bid} failed ({e})")
            return False
        piece = {"name": name, "file": f"{name}/raw.mp4", "file_t0": t0, "t0": t0, "t1": t1, "beats": [bid]}
        new = []
        for p in pieces:
            if p["t1"] <= t0 or p["t0"] >= t1:
                new.append(p)
                continue
            if p["t0"] < t0:
                new.append({**p, "t1": t0})
            if p["t1"] > t1:
                new.append({**p, "t0": t1})
        new.append(piece)
        pieces[:] = sorted(new, key=lambda p: p["t0"])
        self.log(f"recorder: beat {bid} re-recorded on its own ({t0:.2f}-{t1:.2f}s of screencast {i + 1})")
        return True


def record_all(plan, playbooks, assets, *, w, video, new_session, verdict=None, media=None, log=print,
               cancelled=lambda: False, sleep=time.sleep, pixels=True, repair_call=None, expect_p=None,
               allow_intent=None, only=None, progress=None, held=None, skip_done=True):
    """Every screencast segment of the plan, logged-in and outside alike. -> {"segments": {i: recording doc},
    "held": [{reason, detail}], "usd"}. A segment that cannot be shown honestly is HELD with its reason
    (needs_primitive / needs_asset / challenge / timing) — never quietly left as A-roll."""
    allow_intent = intent_ledger_allowed() if allow_intent is None else allow_intent
    segs = schema_segments(plan, video["words"], playbooks, allow_intent=allow_intent)
    r = Recorder(w, playbooks, assets, video, new_session=new_session, verdict=verdict, media=media, log=log,
                 cancelled=cancelled, sleep=sleep, pixels=pixels, repair_call=repair_call, expect_p=expect_p,
                 progress=progress)
    out, hold = {}, []
    try:
        for i, seg in enumerate(segs):
            if only is not None and i not in only:
                continue
            if cancelled():
                raise InterruptedError()
            sd = Path(w) / f"seg-{i:02d}"
            if skip_done and (sd / "rec" / "events.json").exists() and (_load(sd / "recording.json", {}) or {}).get("status") == "ok":
                out[i] = _load(sd / "recording.json")
                continue
            (r.progress or (lambda m, f: None))(f"Screencast {i + 1} of {len(segs)}: rehearse + record "
                                                f"({seg['t1'] - seg['t0']:.0f} s)", 0.1 + 0.75 * i / max(1, len(segs)))
            events.set_sub(f"screencast {i + 1}/{len(segs)}")
            try:
                doc = r.record_segment(i, seg)
            finally:
                events.set_sub(None)
            out[i] = doc
            if doc["status"] != "ok":
                reason = {"needs_primitive": "needs_primitive", "needs_asset": "needs_asset",
                          "challenge": "challenge page", "timing": "timing", "held": "beat failed"}.get(doc["status"], doc["status"])
                hold.append({"reason": reason, "detail": f"screencast {i + 1} ({seg.get('app')}): {str(doc.get('why'))[:300]}"})
                if held:
                    held(reason, hold[-1]["detail"])
    finally:
        r.close()
    return {"segments": out, "held": hold, "usd": round(r.usd, 6), "live_used": 1 - r.live_left,
            "repair_usd": r.budget.video_usd}
