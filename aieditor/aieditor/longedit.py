"""Long-form FULL EDIT (phase 2+3): the cut → a produced video in the reference-2 look.

  plan      director.plan: screencast segments on the job's `sites` + A-roll overlays,
            anchored to word ids (direct-NN.json; reused while edl.json is unchanged)
  record    recorder.record_all — the plan's playbook beats compiled onto the words (beatscript), rehearsed off
            camera, recorded by code in VIRTUAL TIME with per-beat asserts + single-beat retakes, re-timed by the
            elastic assembler (logged-in app through the Scout profile copy; outside views in the separate
            never-logged-in Chrome through the job's US route)
  camera    screencast/camera.py — the measured zoom/pan, highlight wipes, bubble-hide spans
  overlays  graphics_long — titles / link / subscribe / socials / keyword / list / number
  compose   aroll_camera (opening zoom-out, slow push-ins, end fade) + compose_long
            (screencasts, facecam bubble, overlays, music bed ~23 LU under, subscribe clicks)

Everything lives in the job dir under edit-NN/ so a recut never mixes old and new parts.
"""
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

from . import agentrec, compose_long, config, director, events as ev_log, gates, graphics_long, media, playbook, rubric, usroute

SC_IMAGE = config.SC_IMAGE
SCREENCAST = config.CODE / "screencast"
MUSIC_DIR = Path("/opt/aieditor-work/music")
VOICE_LUFS = -14.0                   # render.py normalises the voice to −14 LUFS


def _docker(args, mounts, cancelled, name="aieditor-sc", cpus=None, tz="Asia/Bangkok", env=None):
    cname = f"{name}-{uuid.uuid4().hex[:8]}"
    env = dict(env or {})
    cmd = ["docker", "run", "--rm", "--name", cname, "--cpuset-cpus", cpus or config.CPUSET, "--shm-size", "1g",
           "--memory", config.MEMORY, "-e", f"TZ={env.pop('TZ', tz)}",
           "-e", f"AGENT_PROXY={env.pop('AGENT_PROXY', config.EGRESS_PROXY)}"]
    for k, val in env.items():
        cmd += ["-e", f"{k}={val}"]
    for a, b in mounts:
        cmd += ["-v", f"{a}:{b}"]
    cmd += [SC_IMAGE] + args
    script = next((a for a in args if isinstance(a, str) and a.endswith((".mjs", ".py"))), "")
    labels = {"inventory.mjs": "page inventory (screenshot + elements)", "vrecord.mjs": "screencast recorder (virtual time)",
              "camera.py": "screencast camera (zoom/pan)", "facecam.py": "face finder",
              "aroll_camera.py": "A-roll camera (zoom-out, push-ins, end fade)",
              "privacy.py": "privacy blur / legibility check (C7)"}
    with ev_log.proc(labels.get(script.rsplit("/", 1)[-1], script.rsplit("/", 1)[-1] or name), cname):
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        import time
        while p.poll() is None:
            if cancelled():
                subprocess.run(["docker", "kill", cname], capture_output=True)
                p.wait()
                raise InterruptedError()
            time.sleep(1)
        out, err = p.communicate()
        if p.returncode != 0:
            raise RuntimeError(f"{args[:3]} failed: {err[-800:]}")
    return out


def _tz(seg):
    """RULEBOOK L4: a public (outside-the-account) view runs on a US timezone."""
    return (seg.get("session") or {}).get("timezone") or "Asia/Bangkok"


# ── HELD: a job that cannot honestly be finished stops with its reasons (never quiet A-roll) ──
# p4 renders the held state in the Lab; until then the worker ends the job with these messages.
HELD = "held.json"


def _held_doc(d):
    try:
        doc = json.loads((Path(d) / HELD).read_text())
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_held_doc(d, doc):
    """held.json is shared with gates.write_held (p4 "failures"): keep every key, drop the file when empty."""
    if not doc.get("reasons") and not doc.get("failures"):
        (Path(d) / HELD).unlink(missing_ok=True)
    else:
        (Path(d) / HELD).write_text(json.dumps(doc, indent=1))


def add_held(d, reason, detail=""):
    doc = _held_doc(d)
    cur = list(doc.get("reasons") or [])
    item = {"reason": reason, "detail": detail}
    if item not in cur:
        cur.append(item)
        _write_held_doc(d, {**doc, "reasons": cur})
    return cur


def held_reasons(d):
    return list(_held_doc(d).get("reasons") or [])


def clear_held(d, reason=None):
    """All reasons, or only those of one kind (the worker drops "API cap" when a run starts). The edit
    verdicts' "failures" (gates.write_held) are left for the worker's ship decision to rewrite."""
    doc = _held_doc(d)
    keep = [] if reason is None else [r for r in doc.get("reasons") or [] if r.get("reason") != reason]
    _write_held_doc(d, {**doc, "reasons": keep})


def _outside(seg):
    """A pricing / visitor view (planfit routes these to a never-logged-in session, RULEBOOK L4)."""
    return (seg.get("session") or {}).get("kind") in ("public", "outside")


def _not_recorded(sd, status, seg, why):
    sd.mkdir(parents=True, exist_ok=True)
    json.dump({"status": status, "t0": seg.get("t0"), "t1": seg.get("t1"), "url": seg.get("url"),
               "intent": seg.get("intent"), "why": why}, open(sd / "recording.json", "w"), indent=1)


def _fresh(path, than):
    return path.exists() and path.stat().st_mtime >= than


def preprod_facts(d, scouts=None):
    """planfit.Facts from the job's pre-production (readiness.json + assets.json) and the Scout's
    known pages; empty facts (no checks) when pre-production did not run."""
    pre = Path(d) / "preprod"

    def load(name):
        try:
            return json.loads((pre / name).read_text())
        except (OSError, ValueError):
            return None
    pages = []
    for x in (scouts or {}).values():
        try:
            pages += agentrec.known_pages(x["profile"])
        except Exception:  # noqa: BLE001 — a page list is a nicety
            pass
    return director.planfit.Facts(load("readiness.json"), load("assets.json"), pages)


def plan_and_record(d, k, v, sites, sponsored, fps, progress, cancelled, log):
    """Plan + scripts + recordings + overlays for video k. Returns (summary, usd)."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    w.mkdir(exist_ok=True)
    edl_at = (d / "edl.json").stat().st_mtime
    video = {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}
    usd = 0.0
    # a site the UX Scout is logged in to → the real app, driven by the agent recorder (one browser per
    # app; several apps in one video each get their own); any other site → the scripted recorder
    scouts = {}
    for s in sites:
        x = agentrec.scout_for(s["url"])
        if x and x["slug"] not in scouts:
            scouts[x["slug"]] = {**x, "home": s["url"]}
    gate = {}
    if (d / "preprod" / "gate.json").exists():
        gate = {r.get("scout"): r for r in json.load(open(d / "preprod" / "gate.json")).get("sites", []) if r.get("scout")}
    knowledge = None
    for x in scouts.values():
        # what already EXISTS in the account (its own browser history): the plan may only ask
        # the screen for things that exist or that the segment itself makes (v5: the plan asked
        # for "a campaign generated beforehand with Jake's own brand" that was never made)
        part = (x["report"] or "")
        pages = agentrec.known_pages(x["profile"])
        if pages:
            part += "\n\nPAGES THAT EXIST IN THIS ACCOUNT (from its history):\n" + \
                "\n".join(f"- {u}  ({t})" for u, t in pages)
        x["knowledge"] = part
        knowledge = (knowledge + "\n\n" if knowledge else "") + (f"=== {x['slug']} ===\n" if len(scouts) > 1 else "") + part
    scout = next(iter(scouts.values()), None)
    # what pre-production measured and produced (readiness features + assets): the plan may only ask
    # for beats the account can show, about objects a produced asset holds (gap list G2)
    facts = preprod_facts(d, scouts)
    plan_p = w / "direct.json"
    pre_plan = d / "preprod" / "plan.json"
    if not _fresh(plan_p, edl_at):
        if k == 1 and _fresh(pre_plan, edl_at):
            # pre-production already made THE plan (one Opus call + check + one Sonnet overlay call): reuse it
            pdoc = json.load(open(pre_plan))
            plan, raw, meta = pdoc["plan"], pdoc["raw"], {**pdoc.get("meta", {}), "usd": 0.0, "from": "preprod/plan.json"}
            sites = pdoc.get("sites") or sites
        else:
            progress("Claude is planning the edit (screencasts + graphics)…", 0.02)
            plan, raw, meta = director.plan(video, sites, sponsored, knowledge, facts=facts)
            usd += meta["usd"]
        json.dump({"plan": plan, "raw": raw, "meta": meta, "sites": sites}, open(plan_p, "w"), indent=1)
        for x in plan["dropped"]:
            log(f"edit {k}: dropped {x.get('template', 'screencast')} ({x['dropped']})")
        for old in w.glob("seg-*"):                       # a new plan invalidates every recording
            shutil.rmtree(old, ignore_errors=True)
    doc = json.load(open(plan_p))
    # re-validate the cached answer every run: a fixed rule reaches existing jobs, and a trim
    # only ever shortens a segment, so its recording stays valid
    plan = director.validate(doc["raw"], video, doc.get("sites", sites), facts)
    for key in ("needs_primitive", "held", "schema_plan", "plan_check"):     # the plan call's verdict rides along
        if key in doc["plan"]:
            plan[key] = doc["plan"][key]
    for n in plan.get("needs_primitive") or []:
        # the plan check left something no proven action can show: held, never recorded as A-roll filler
        add_held(d, "needs_primitive", str(n.get("why") or n.get("sentence"))[:300])
    if plan != doc["plan"]:
        old = [(x.get("start"), x.get("url"), x.get("session")) for x in doc["plan"].get("segments", [])]
        if old != [(x.get("start"), x.get("url"), x.get("session")) for x in plan["segments"]]:
            # the segments were re-cut (structure / readiness): recordings are indexed by segment
            log(f"edit {k}: the plan was re-cut ({len(old)} → {len(plan['segments'])} screencasts) — recordings redone")
            for old_seg in w.glob("seg-*"):
                shutil.rmtree(old_seg, ignore_errors=True)
        doc["plan"] = plan
        json.dump(doc, open(plan_p, "w"), indent=1)
        os.utime(plan_p, (edl_at + 1, edl_at + 1)) if plan_p.stat().st_mtime < edl_at else None
    json.dump({"beats": plan.get("beats", []), "plates": plan.get("plates", []), "objects": plan.get("objects", {}),
               "aroll_actions": plan.get("aroll_actions", []), "structure": plan.get("structure", {})},
              open(w / "beats.json", "w"), indent=1)
    write_expect(w, plan, video)
    segs = plan["segments"]
    n_recorded, n_held = 0, 0
    # EVERY screencast — the logged-in app and the outside view alike — goes through the scripted recorder
    # (recommendation §3.5, step 5): compiled from the plan's playbook beats, rehearsed off camera, recorded
    # by code with per-beat asserts and single-beat retakes, re-timed by the elastic assembler. No model acts
    # on camera (the per-step agent loop is gone; config.RECORDER "on_camera_agent" has nothing to switch on).
    if config.recorder().get("on_camera_agent"):
        log(f"edit {k}: AIEDITOR_ON_CAMERA_AGENT is set but no on-camera agent exists any more — ignored")
    from . import recorder, skill
    playbooks = {}
    for app in skill.playbooks():
        try:
            playbooks[app] = playbook.load(app)
        except playbook.PlaybookError as e:
            log(f"edit {k}: playbook {app} refused ({e}) — its screencasts are held")
    sched = recorder.schema_segments(plan, video["words"], playbooks, allow_intent=recorder.intent_ledger_allowed())
    us_proxy = usroute.route_for_job()
    todo = []
    for i, seg in enumerate(sched):
        sd = w / f"seg-{i:02d}"
        if (sd / "rec" / "events.json").exists() and (recorder._load(sd / "recording.json", {}) or {}).get("status") == "ok":
            n_recorded += 1
            continue
        why, reason = None, None
        if seg["session"] == "outside" and not us_proxy:
            # RULEBOOK L4 / R10: an outside view never goes out through the Singapore box
            why, reason, status = "pricing / visitor view needs the job's US route", usroute.NO_ROUTE, "no_us_route"
        elif seg["session"] == "logged_in":
            x = agentrec.scout_for(seg.get("url", ""))
            if not (x and x["slug"] in scouts):
                why, reason, status = "no logged-in UX Scout account for this app", "no logged-in account", "no_scout_login"
        if why:
            _not_recorded(sd, status, seg, why)
            msg = (f"edit {k}: screencast {i + 1} ({seg['t0']:.1f}–{seg['t1']:.1f}s, {seg.get('url', '')}) is not recorded — "
                   f"{why}; the job is held")
            log(msg)
            ev_log.emit("log", msg, level="warn")
            add_held(d, reason, f"edit {k} screencast {i + 1}")
            n_held += 1
            continue
        todo.append(i)
    # one job per logged-in account: on a factory server the dispatcher holds the lock (cloud.run_remote);
    # a run on this box takes it here, for the recording only
    lock = None
    slugs = sorted({x["slug"] for x in scouts.values()})
    if todo and slugs and not config.FACTORY_SERVER:
        from . import accountlock
        lock = accountlock.AccountLock(slugs, d.name)
        busy = lock.try_acquire()
        if busy:
            add_held(d, "account busy", f"another job is using the {busy} account")
            log(f"edit {k}: the {busy} account is in use by another job — screencasts not recorded, held")
            todo, lock = [], None
    if todo:
        assets = recorder._load(d / "preprod" / "assets.json", None) or {"assets": []}
        multi = len({sched[i].get("app") for i in todo if sched[i]["session"] == "logged_in"}) > 1

        def new_session(app, kind, fresh):
            if kind == "outside":
                prof = usroute.fresh_profile(w / "outside")          # a NEW, empty, never-logged-in profile
                return agentrec.Session(w, None, cancelled, env=usroute.outside_chrome_env(us_proxy, prof))
            x = next((s for s in scouts.values() if recorder.app_for(s.get("home") or "", playbooks) == app
                      or s["slug"] == app), None) or next(iter(scouts.values()))
            pname = f"profile-{x['slug']}" if multi else "profile"
            if fresh:
                shutil.rmtree(w / pname, ignore_errors=True)        # a fresh COPY of the Scout profile after a wall
            # RULEBOOK S7: the playbook's start state names the theme (ChatGPT: dark)
            dark = bool(gate.get(x["slug"], {}).get("dark")) or any(
                a.get("kind") == "theme" and a.get("value") == "dark"
                for a in ((playbooks.get(app) or {}).get("start_state") or {}).get("asserts", []))
            return agentrec.Session(w, x["profile"], cancelled, dark=dark, profile_name=pname)

        res = recorder.record_all(
            plan, playbooks, assets, w=w, video=video, new_session=new_session,
            verdict=lambda w_, i, sc: recorder.docker_verdict(w_, i, w / "expect.json", recorder.ACCOUNT, cancelled),
            media=recorder.DockerMedia(cancelled), log=log, cancelled=cancelled, only=set(todo),
            allow_intent=recorder.intent_ledger_allowed(),
            progress=lambda m, f: progress(m, f), held=lambda reason, detail: add_held(d, reason, f"edit {k} {detail}"))
        usd += res["usd"]
        if lock:
            lock.release()
        for i, doc in res["segments"].items():
            if doc.get("status") == "ok":
                n_recorded += 1
            else:
                n_held += 1
                ev_log.emit("log", f"edit {k}: screencast {i + 1} held — {doc.get('status')}: {str(doc.get('why'))[:200]}",
                            level="warn")
    ev_log.set_sub(None)
    progress("Rendering the overlays…", 0.88)
    evs = graphics_long.render(w, plan["overlays"] + motion_plate_events(d, plan, log), video, fps, tag="gfx",
                               cancelled=cancelled)
    json.dump(evs, open(w / "overlays.json", "w"), indent=1)
    n_ok = sum(1 for i in range(len(segs)) if (w / f"seg-{i:02d}" / "rec" / "events.json").exists())
    if not segs:
        log(f"edit {k}: no screencast in the plan — "
            + ("no site could be screencast (A-roll + overlays only)" if not sites else "the director placed none"))
    return (f"{n_ok}/{len(segs)} screencast(s)" + (f" ({n_recorded} in the logged-in app)" if n_recorded else "")
            + (f", {n_held} held" if n_held else "") + f", {len(evs)} overlay(s)"), usd


def motion_plate_events(d, plan, log=None):
    """The hook PROMPT → RESULT plates (MO05, planfit.hook_prompt_result) as motion overlay events, each with the
    REAL result produced off camera (preprod assets.json). A plate whose result file is gone is NOT rendered (the
    A-roll shows) and the reason is logged — never an invented result."""
    from . import motiontemplates as MT
    if not MT.enabled():
        return []
    assets = {}
    p = Path(d) / "preprod" / "assets.json"
    if p.exists():
        assets = {a.get("id"): a for a in json.load(open(p)).get("assets", [])}
    out = []
    for pl in plan.get("plates") or []:
        if pl.get("technique") != "MO05":
            continue
        a = next((assets[x] for x in pl.get("assets", []) if x in assets), None)
        rv = MT.result_view(a) if a and a.get("status") == "ready" else None
        if not rv:
            if log:
                log(f"MO05 prompt → result at {pl['t0']:.1f} s not rendered: the real result "
                    f"({', '.join(pl.get('assets', [])) or 'none'}) is not on disk — the A-roll stays (never invented)")
            continue
        params, errs = MT.validate_params("prompt_result", {"prompt": pl.get("prompt"), "app": pl.get("app"),
                                                            "result_asset": a["id"]})
        if errs:
            if log:
                log(f"MO05 at {pl['t0']:.1f} s not rendered: {'; '.join(errs)}")
            continue
        out.append({"template": "prompt_result", "technique": "MO05", "t0": pl["t0"], "t1": pl["t1"],
                    "start": pl.get("start"), "end": pl.get("end"), "fields": {"prompt": pl.get("prompt"), "app": pl.get("app")},
                    "params": {**params, "result": rv}, "why": pl.get("why", "")})
    return out


GUARD_EVERY_S = gates.GUARD_EVERY_S     # qa_frames.py samples every 0.5 s (gap list G4.2)


def write_expect(w, plan, video):
    """edit-NN/expect.json: per-segment beat expectations (word time, must / typed text, result beats)
    from the plan-schema beats (single plan call), else the beat ledger (beats.json), else the segment
    intents — what qa_content.py and the frame guard's empty-canvas rule check every take against."""
    w = Path(w)
    ledger = None
    try:
        ledger = json.loads((w / "beats.json").read_text()).get("beats")
    except (OSError, ValueError, AttributeError):
        pass
    exp = gates.expectations(plan, video["words"], ledger)
    p = w / "expect.json"
    try:
        same = json.loads(p.read_text()) == exp
    except (OSError, ValueError):
        same = False
    if not same:
        p.write_text(json.dumps(exp, indent=1))
    return p


def frame_guard(w, cancelled, expect_p=None):
    """screencast/qa_frames.py over every recorded segment, every 0.5 s (cached in frames-qa.json until a
    raw.mp4 changes) -> its document: "spans" {"03": [{t0, t1, kind, why}]} (challenge / error / account /
    idle / idle_tail / empty / garbled / privacy) and the point "segments" hits."""
    w = Path(w)
    raws = list(w.glob("seg-*/rec/raw.mp4"))
    if not raws:
        return {}
    cache = w / "frames-qa.json"
    stale = not cache.exists() or cache.stat().st_mtime < max(r.stat().st_mtime for r in raws)
    if not stale:
        try:
            stale = "spans" not in json.loads(cache.read_text())      # a 1.5 s point-hit guard from before G4
        except (OSError, ValueError):
            stale = True
    if stale:
        accts = [json.load(open(r.parent / "events.json")).get("account") for r in raws if (r.parent / "events.json").exists()]
        acct = max(set(a for a in accts if a), key=accts.count, default=None)
        # the result goes to a FILE: a big JSON on the pipe would block a container nobody reads yet
        _docker(["python3", "/a/screencast/qa_frames.py", "/w", "--out", f"/w/{cache.name}", "--every", str(GUARD_EVERY_S)]
                + (["--expect", f"/w/{Path(expect_p).name}"] if expect_p else [])
                + (["--account", acct] if acct else []), [(config.CODE, "/a"), (w, "/w")], cancelled, "aieditor-qaframes")
    try:
        return json.loads(cache.read_text())
    except (OSError, ValueError):
        return {}


def content_qa(w, expect_p, cancelled):
    """screencast/qa_content.py with the camera plans (on_word / late_s / nav_on_word / must / typed) ->
    qa-content.json; its D1/D2 scores go into the job log (gap list G4.3)."""
    w = Path(w)
    out = w / "qa-content.json"
    try:
        # qa_content exits 1 on a failed check: the verdict is read from its JSON, not its exit code
        _docker(["sh", "-c", f"python3 /a/screencast/qa_content.py /w /w/{Path(expect_p).name} --out /w/{out.name}"
                 " > /dev/null; true"], [(config.CODE, "/a"), (w, "/w")], cancelled, "aieditor-qacontent")
        return json.loads(out.read_text())
    except (OSError, ValueError, RuntimeError):
        # no content QA = D1 stays "not measured" in the verdict (held), never a silent pass
        return {}


def screen_pieces(w, allsegs, qa, words, expect=None):
    """compose's take decisions (gap list G4.4): a segment whose frames are clean is kept whole (its edges next
    to A-roll on sentence starts); one with
    bad spans (frame guard + the recorder's live walls) keeps the clean footage on BOTH sides, its edges
    snapped to sentence starts (gates.salvage). Only screen pieces are cut — the narration never is.
    -> (pieces [{i, n, t0, t1, src0}], lost [held failure lines, every lost second a D1 failure])"""
    w = Path(w)
    pieces, lost = [], []
    for i, seg in enumerate(allsegs):
        sd = w / f"seg-{i:02d}"
        beats = ((expect or {}).get("segments") or {}).get(str(i))
        if not (sd / "rec" / "events.json").exists():
            lost.append(gates.failure("D1", f"screencast {i + 1}: {seg['t1'] - seg['t0']:.1f} s planned, never recorded",
                                      t=seg["t0"], remedies_tried=gates.load_state(sd).get("remedies", [])))
            continue
        ev = json.load(open(sd / "rec" / "events.json"))
        walls = [x for x in ev.get("walls", []) if x.get("kind") in agentrec.DROP_KINDS]
        spans = gates.guard_spans(qa or {}, f"{i:02d}") + gates.spans_from_hits(walls, GUARD_EVERY_S, ev.get("end"))
        spans = [x for x in spans if x.get("kind") in gates.SPAN_KINDS]
        # an edge that abuts another screencast stays (screen -> screen dissolve); every edge next to A-roll
        # goes onto a sentence start (CUT04/CUT05), clean segment or not
        abut_prev = i > 0 and abs(float(allsegs[i - 1]["t1"]) - float(seg["t0"])) < 0.05
        abut_next = i + 1 < len(allsegs) and abs(float(allsegs[i + 1]["t0"]) - float(seg["t1"])) < 0.05
        sv = gates.salvage(seg, spans, words, rec_end=ev.get("end"), keep_start=abut_prev, keep_end=abut_next)
        for n, p in enumerate(sv["pieces"]):
            pieces.append({"i": i, "n": n, **p})
        tried = gates.load_state(sd).get("remedies", []) + (["salvage"] if spans else [])
        lost += gates.salvage_failures(i, seg, sv, beats, tried)
        if not spans:
            continue
        kinds = ", ".join(sorted({x["kind"] for x in spans}))
        ev_log.emit("log", f"screencast {i + 1}: {kinds} — kept {len(sv['pieces'])} clean piece(s) on sentence starts, "
                           f"{sv['lost_s']:.1f} s lost (D1, the edit is held)", level="warn")
    return sorted(pieces, key=lambda p: p["t0"]), lost


def edit_verdict(d, k, w, plan, lost, qa=None, content=None, draft="output"):
    """The compose tail (recommendation §4 checkpoints 3+4): structure gate + coverage gate + the rubric's
    code dimensions on the edit -> edit-NN/verdict.json. The worker holds the job when it says held.
    (Judged dimensions D1/D3/D4 count only from a calibrated judge — judges.py; none runs here yet, so
    rubric.ship sees them as not measured and the edit is held, never shipped quietly.)"""
    w = Path(w)
    blocks = json.load(open(w / "blocks.json"))
    struct = gates.structure(blocks)
    cov = gates.coverage(blocks, plan)
    rb = rubric.score(w, qa)
    private = sum(1 for sp in ((qa or {}).get("spans") or {}).values() for x in sp if x.get("kind") == "privacy")
    # p5 (RULEBOOK C7): legible private frames left in the CAMERA output after the blur, + unresolved boxes
    try:
        pq = json.loads((w / "privacy-qa.json").read_text())
        private += sum(len(h or []) for h in (pq.get("segments") or {}).values()) + len(pq.get("held") or [])
    except (OSError, ValueError, AttributeError):
        pass
    v = gates.edit_verdict(struct, cov, rb, judged=None, salvage_lost=lost,
                           held_reasons=gates.held_doc(d)["reasons"], unapproved=rb["measured"]["unapproved"],
                           private_frames=private, draft=draft)
    if content:
        v["content_qa"] = gates.scores(content, lost_beats=sum(1 for f in lost if f.get("beat")))
    (w / "verdict.json").write_text(json.dumps(v, indent=1))
    ev_log.emit("log", f"edit {k}: verdict {'HELD' if v['held'] else 'ship'} — "
                       + ", ".join(f"{x} {y:.0f}" for x, y in v["dims"].items() if y is not None)
                       + f"; share {cov['share']:.0%}, kept {cov['kept_s']:.0f}/{cov['planned_s']:.0f} s planned"
                       + (f"; {len(v['failures'])} failure(s)" if v["failures"] else ""),
                level="warn" if v["held"] else "info")
    return v


PRIVACY_EVERY_S = 0.5     # privacy.py OCR sampling (RULEBOOK C7)


def privacy_pass(w, idxs, cancelled, progress=None):
    """RULEBOOK C7: screencast/privacy.py on every recording the edit uses — DOM boxes (rec/privacy.json)
    + OCR -> tracked blur -> rec/raw.blur.mp4, BEFORE the camera, so every zoom/pan carries the blur.
    Cached until raw.mp4 changes. Always runs (a factory edit never skips it). -> {"03": privacy.blur.json}"""
    w = Path(w)
    todo, res = [], {}
    for i in idxs:
        rd = w / f"seg-{i:02d}" / "rec"
        raw, blur, doc = rd / "raw.mp4", rd / "raw.blur.mp4", rd / "privacy.blur.json"
        if not raw.exists():
            continue
        if not (_fresh(blur, raw.stat().st_mtime) and _fresh(doc, raw.stat().st_mtime)):
            todo.append(i)

    def one(i):
        _docker(["python3", "/a/screencast/privacy.py", "blur", f"/w/seg-{i:02d}/rec", "--every", str(PRIVACY_EVERY_S),
                 "--out", f"/w/seg-{i:02d}/rec/privacy.run.json"], [(config.CODE, "/a"), (w, "/w")], cancelled,
                "aieditor-privacy")
    if todo:
        if progress:
            progress(f"Privacy blur (C7) on {len(todo)} recording(s)…", 0.05)
        par = max(1, min(len(todo), config.cpu_count() // 4))
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(par) as ex:
            list(ex.map(one, todo))
    for i in idxs:
        doc = w / f"seg-{i:02d}" / "rec" / "privacy.blur.json"
        if doc.exists():
            res[f"{i:02d}"] = json.loads(doc.read_text())
            for h in res[f"{i:02d}"].get("held", []):
                ev_log.emit("log", f"screencast {i + 1}: private {h['kind']} at {h['t']:.1f}s — {h['reason']} "
                                   f"(remedy {h['remedy']})", level="warn")
    return res


def privacy_qa(w, clips, cancelled, passed=None):
    """The 'no legible private frame' check on the CAMERA output (every PRIVACY_EVERY_S, at <= 1920 px):
    any hit fails (p4 reads privacy-qa.json: take_verdict privacy_out, ship rule '0 legible private frames')."""
    w = Path(w)
    out = {"every_s": PRIVACY_EVERY_S, "segments": {}, "held": []}
    for i, clip in clips:
        res = w / f"{clip}.privacy.json"
        if not _fresh(res, (w / clip).stat().st_mtime):
            _docker(["python3", "/a/screencast/privacy.py", "legible", f"/w/{clip}", "--every", str(PRIVACY_EVERY_S),
                     "--out", f"/w/{res.name}"], [(config.CODE, "/a"), (w, "/w")], cancelled, "aieditor-privacy-qa")
        hits = json.loads(res.read_text()).get("hits", [])
        out["segments"][f"{i:02d}"] = hits
        if hits:
            out["held"].append({"seg": f"{i:02d}", "t": hits[0]["t"], "kind": hits[0]["kind"], "remedy": "widen_blur -> cut_beat",
                                "reason": f"{len(hits)} legible private frame(s) in the camera output"})
            ev_log.emit("log", f"screencast {i + 1}: {len(hits)} legible private frame(s) after the blur "
                               f"(first {hits[0]['kind']} at {hits[0]['t']:.1f}s)", level="error")
    for k, doc in (passed or {}).items():
        out["held"] += [{"seg": k, **h} for h in doc.get("held", [])]
    out["ok"] = not any(out["segments"].values())
    (w / "privacy-qa.json").write_text(json.dumps(out, indent=1))
    return out


def compose(d, k, base, fps, size, cancelled, progress, out_name, bubble_src=None, face_src=None,
            chunked=False, workers=None, verdict=True, crf=None, preset="veryfast", draft="output"):
    """Camera per segment at `size`, the A-roll camera on `base`, then the composite.

    chunked (factory mode, recommendation step 8): the composite renders in chunks (compose_long.plan_chunks)
    in parallel, `workers` at once, joined by a stream copy; edit-NN/<out_name>.chunks.json keeps each
    chunk's hash and a later round re-renders only the chunks whose inputs changed. verdict=False (the 4K
    final after a draft that shipped): no new verdict — but a legible private frame in the 4K camera output
    still holds the edit, and then no final is written (returns None)."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    plan = json.load(open(w / "direct.json"))["plan"]
    W, H = size
    segs = []
    allsegs = plan["segments"]
    xf_s = compose_long.xfade_s(fps)
    jobs = []
    # GUARD (Jake 2026-10-08/09; gap list G4): a bot check, an app error, another account, an idle tail,
    # an empty canvas or garbled text never reaches an edit — the recorder's live checks (events.json
    # "walls") + the frame guard (OCR + pixels every 0.5 s). The bad SPAN is cut out, the clean footage on
    # both sides stays (sentence-snapped), and every lost second holds the job (never silent A-roll).
    video = _video(d, k)
    expect_p = write_expect(w, plan, video)
    expect = json.loads(expect_p.read_text())
    qa = frame_guard(w, cancelled, expect_p)
    pieces, lost = screen_pieces(w, allsegs, qa, video["words"], expect)
    usable = {}
    for p in pieces:
        seg = allsegs[p["i"]]
        usable[(p["i"], p["n"])] = {**seg, "t0": p["t0"], "t1": p["t1"], "src0": p["src0"], "i": p["i"]}
    order = sorted(usable, key=lambda key: usable[key]["t0"])
    for n_, key in enumerate(order):
        i, pn = key
        seg = usable[key]
        clip = f"sc-{i:02d}{'' if pn == 0 else chr(ord('a') + pn)}-{W}.mp4"
        # two screencasts back to back = a change of world (a new recording): the next one
        # DISSOLVES in over this one (SYSTEM.md §3b), so this clip runs a few frames longer
        nxt = usable[order[n_ + 1]] if n_ + 1 < len(order) else None
        into_next = bool(nxt and abs(nxt["t0"] - seg["t1"]) < 0.05)
        # the clip also runs past its end for the dissolve back into the full-screen narration
        # (Jake #5: the bubble fades first, then the screencast) — both need extra frames
        tail = xf_s if into_next else compose_long.aroll_tail_s()
        jobs.append((i, seg, clip, into_next, tail))

    # PRIVACY (RULEBOOK C7): blur private boxes in the RECORDING first; the camera then reads raw.blur.mp4
    passed = privacy_pass(w, sorted({jb[0] for jb in jobs}), cancelled, progress)

    # G5 step 2 (p3): the camera times each named target from its spoken word — the narration words on
    # the RECORDING's clock go next to events.json (camera.load_words reads <recdir>/words.json). Written
    # once per recording (not per salvaged piece, p4): every piece of one recording shares the rec dir,
    # and a piece's camera window starts at its src0 on that same clock.
    words_all = _video(d, k)["words"]
    for i in sorted({jb[0] for jb in jobs}):
        rec0 = float(allsegs[i]["t0"]) - float(allsegs[i].get("src0", 0.0))
        rec1 = max(float(usable[key]["t1"]) for key in usable if key[0] == i)
        (w / f"seg-{i:02d}" / "rec" / "words.json").write_text(json.dumps(
            [{"word": x["word"], "start": round(x["start"] - rec0, 3), "end": round(x["end"] - rec0, 3)}
             for x in words_all if rec0 - 1.0 <= x["start"] <= rec1 + 1.0]))

    def camera(job):
        i, seg, clip, _, tail = job
        src0 = float(seg.get("src0", 0.0))
        blurred = w / f"seg-{i:02d}" / "rec" / "raw.blur.mp4"
        # camera.py reads <recdir>/raw.mp4: the blurred recording is mounted over it (read only)
        over = [(blurred, f"/w/seg-{i:02d}/rec/raw.mp4:ro")] if blurred.exists() else []
        _docker(["python3", "/a/screencast/camera.py", f"/w/seg-{i:02d}/rec", f"/w/{clip}", "--size", f"{W}x{H}",
                 "--from", f"{src0:.3f}", "--to", f"{src0 + seg['t1'] - seg['t0'] + tail:.3f}", "--fps", f"{fps:.8f}"],
                [(config.CODE, "/a"), (w, "/w")] + over, cancelled, "aieditor-cam")
    # the camera renders are independent: several at once on a factory server (1 on the box)
    par = max(1, min(len(jobs), config.cpu_count() // 4))
    progress(f"Screencasts: camera on {len(jobs)} clip(s), {par} at a time…", 0.1)
    if par == 1:
        for n, jb in enumerate(jobs):
            ev_log.set_sub(f"screencast {jb[0] + 1}/{len(allsegs)}")
            progress(f"Screencast {jb[0] + 1}: camera…", 0.1 + 0.4 * n / max(1, len(jobs)))
            camera(jb)
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(par) as ex:
            for n, _ in enumerate(ex.map(camera, jobs)):
                progress(f"Screencast cameras: {n + 1}/{len(jobs)} done", 0.1 + 0.4 * (n + 1) / max(1, len(jobs)))
    pq = privacy_qa(w, [(jb[0], jb[2]) for jb in jobs], cancelled, passed)
    if not verdict and not pq.get("ok", True):
        # the draft shipped, but the full-size camera output shows a private frame: held, no final
        progress("Private frame in the full-size camera output — held, no final", 1.0)
        edit_verdict(d, k, w, plan, lost, qa, None, draft=f"{W}x{H}")
        return None
    for i, seg, clip, into_next, tail in jobs:
        cam = json.load(open(w / f"{clip}.camera.json"))
        kept = compose_long.trim_blank({"t0": seg["t0"], "t1": seg["t1"], "clip": clip, "bubble": True,
                                        "bubble_hide": cam["bubble_hide"], "i": i, "src0": seg.get("src0", 0.0)}, cam)
        if kept:
            if into_next and kept["t1"] == seg["t1"]:
                kept["tail"] = xf_s
            elif not into_next and kept["t1"] < media.probe(d / base)["duration"] - 0.05:
                kept["tail"] = compose_long.aroll_tail_s()
                kept["aroll_out"] = True
            # (a screencast that runs to the video's last frame has no A-roll after it: no bubble-first
            # exit — the whole frame fades to black instead, TR08; review v12 #28)
            if segs and segs[-1].get("tail") and not segs[-1].get("aroll_out") and abs(segs[-1]["t1"] - kept["t0"]) < 0.05:
                kept["fade_in"] = segs[-1]["tail"]
            elif kept["t0"] > 0.05:
                kept["aroll_in"] = True              # (the video's own first frame does not fade in)
            segs.append(kept)
    ev_log.set_sub(None)
    # the presenter's face (for the bubble crop and the A-roll push anchor)
    face_p = d / "face.json"
    if not face_p.exists():
        _docker(["python3", "/a/screencast/facecam.py", "face", f"/j/{face_src or base}", "/j/face.json", "--samples", "20"],
                [(config.CODE, "/a"), (d, "/j")], cancelled, "aieditor-face")
    face = json.load(open(face_p))["face"]
    # the kept screen pieces (the rubric reads them: which recording second is on screen when)
    json.dump([{"i": s_["i"], "t0": s_["t0"], "t1": s_["t1"], "src0": s_.get("src0", 0.0), "clip": s_["clip"]}
               for s_ in segs], open(w / "pieces.json", "w"), indent=1)
    # A-roll camera: blocks = everything that is not a screencast
    dur = media.probe(d / base)["duration"]
    blocks, t = [], 0.0
    for s in segs:
        if s["t0"] > t:
            blocks.append([t, s["t0"]])
        t = s["t1"]
    if t < dur:
        blocks.append([t, dur])
    # the A-roll MOTION PLAN (screencast/aroll_plan.py) is word-timed: sentence starts are its reset
    # points, the overlays its AR02 beats — measured on Jake's references 2–5
    json.dump({"blocks": blocks, "fps": fps, "words": _video(d, k)["words"],
               "overlays": [{"template": o.get("template"), "t0": o["t0"], "t1": o["t1"]} for o in plan["overlays"]]},
              open(w / "blocks.json", "w"))
    progress("A-roll camera (opening zoom, slow push-ins, end fade)…", 0.55)
    anchor = f"{(face[0] + face[2] / 2) * W:.1f},{(face[1] + face[3] * 0.8) * H:.1f}"
    cam_base = f"base-cam-{W}.mp4"
    _docker(["python3", "/a/screencast/aroll_camera.py", f"/j/{base}", f"/w/{cam_base}", "/w/blocks.json", "--anchor", anchor],
            [(config.CODE, "/a"), (d, "/j"), (w, "/w")], cancelled, "aieditor-aroll")
    # the bubble shows the presenter WITHOUT the A-roll push: link the plain base in
    # a HARD link: a symlink's absolute host path does not exist inside the container
    plain = w / f"plain-{W}{Path(bubble_src or base).suffix}"
    plain.unlink(missing_ok=True)
    os.link(d / (bubble_src or base), plain)
    events = json.load(open(w / "overlays.json"))
    if graphics_long.repair_frame_names(w / "gfx", events):
        progress("Overlay frame names repaired", 0.6)
    if W != 1920:                                        # overlays re-rendered at the output size
        progress("Overlays at full resolution…", 0.65)
        events = graphics_long.render(w, plan["overlays"] + motion_plate_events(d, plan), _video(d, k), fps, size=size,
                                      tag=f"gfx-{W}", cancelled=cancelled)
    music = pick_music(d / base)
    progress("Compositing (screencasts, bubble, overlays, music)…", 0.75)
    crf = crf or (17 if W == 1920 else 16)
    gfx_tag = "gfx" if W == 1920 else f"gfx-{W}"
    end_fade = max((w_["end"] for w_ in _video(d, k)["words"]), default=None)
    if chunked:
        out = _compose_chunked(d, k, w, cam_base, segs, events, music, out_name, size, fps, face, plan, plain.name,
                               crf, preset, gfx_tag, end_fade, workers, cancelled, progress)
    else:
        out = compose_long.composite(w, cam_base, segs, events, music, out_name, size, fps, face,
                                     bubble_src=plain.name, crf=crf, preset=preset, cancelled=cancelled,
                                     gfx_tag=gfx_tag, end_fade_from=end_fade)
    final = d / f"{out_name}.mp4"
    Path(out).replace(final)
    for ext in (".plan.json", ".cuts.json"):            # keep the motion plan with the edit (QA reads it)
        if (w / f"{cam_base}{ext}").exists():
            os.replace(w / f"{cam_base}{ext}", w / f"aroll{ext}")
    (w / cam_base).unlink(missing_ok=True)
    plain.unlink(missing_ok=True)
    # checkpoints 3+4: the edit against the references -> verdict.json (the worker holds a failing job)
    if verdict:
        progress("Checking the edit against the references…", 0.98)
        edit_verdict(d, k, w, plan, lost, qa, content_qa(w, expect_p, cancelled), draft=draft)
    return final


CHUNK_FORMAT = 1          # bump when compose_long's chunk graph changes: every chunk hash changes with it


def _compose_chunked(d, k, w, cam_base, segs, events, music, out_name, size, fps, face, plan, bubble_src, crf, preset,
                     gfx_tag, end_fade, workers, cancelled, progress):
    """plan_chunks on this edit's windows (seams at the A-roll's real picture cuts first), a hash per chunk,
    then compose_long.composite_chunked (only chunks whose hash changed are rendered)."""
    import hashlib
    from . import skill
    W, H = size
    dur = media.probe(w / cam_base)["duration"]
    compose_long.count_frames(w, events, gfx_tag)
    cuts, shots = [], []
    try:
        cuts = json.loads((w / f"{cam_base}.cuts.json").read_text()).get("cuts") or []
        shots = json.loads((w / f"{cam_base}.plan.json").read_text()).get("shots") or []
    except (OSError, ValueError, AttributeError):
        pass
    blocks = json.load(open(w / "blocks.json"))
    chunks = compose_long.plan_chunks(blocks, segs, events, cuts, fps, dur, end_fade)
    v = json.load(open(d / "edl.json"))["videos"][k - 1]
    cut_id = hashlib.sha256(json.dumps(v.get("pieces"), sort_keys=True).encode()).hexdigest()
    extra = {"format": CHUNK_FORMAT, "size": [W, H], "fps": round(fps, 6), "crf": crf, "preset": preset, "cut": cut_id,
             "face": face, "end_fade": end_fade, "dur": round(dur, 4)}
    hplan = {"segments": plan.get("segments") or [], "overlays": plan.get("overlays") or [],
             "aroll_shots": shots, "aroll_cuts": [{"t0": c, "t1": c} for c in cuts]}
    hashes = compose_long.chunk_hashes(w, chunks, segs, events, hplan, skill.ROOT / "rules.json", extra, fps)
    progress(f"Compositing in {len(chunks)} chunk(s)…", 0.75)
    out, man = compose_long.composite_chunked(w, cam_base, segs, events, music, out_name, size, fps, face, chunks,
                                              cancelled, crf, preset, bubble_src, gfx_tag, end_fade, workers, hashes,
                                              log=lambda m: ev_log.emit("log", m))
    return out


# ── factory mode (recommendation step 8): no preview, no 1080p compose; a 540p draft is judged and the 4K
# final is rendered only when the draft ships ────────────────────────────────────────────────────────────
def factory_mode(req):
    """request.json "factory": true/false decides (bin/aieditor-factory trial --factory sets it); without it,
    a creative-workflow job on a factory server is a factory job. Jake's own cut workflow keeps its 1080p
    previews (he reviews them)."""
    req = req or {}
    if isinstance(req.get("factory"), bool):
        return req["factory"]
    if os.environ.get("AIEDITOR_FACTORY_MODE") in ("0", "1"):
        return os.environ["AIEDITOR_FACTORY_MODE"] == "1"
    return config.FACTORY_SERVER and req.get("workflow") == "creative"


def chunk_workers_of(req):
    """request.json "chunk_workers" (bin/aieditor-factory trial --workers N) or AIEDITOR_CHUNK_WORKERS; None = auto
    (compose_long.chunk_workers: one 4K chunk per 8 cores — 4 on a c-32)."""
    for v in ((req or {}).get("chunk_workers"), os.environ.get("AIEDITOR_CHUNK_WORKERS")):
        try:
            if v and int(v) > 0:
                return int(v)
        except (TypeError, ValueError):
            pass
    return None


def wants_preview(req, fmt):
    """The 1080p preview-NN render: never for a long-form factory job (the 540p draft replaces it)."""
    return not (fmt == "long" and factory_mode(req))


def verdict_of(d, k):
    try:
        return json.loads((Path(d) / f"edit-{k:02d}" / "verdict.json").read_text())
    except (OSError, ValueError):
        return None


def factory_edit(d, k, v, fps, src_size, cancelled, progress, room_tone_start=0.0, workers=None, final=True):
    """One video in factory mode: the cut at 540p (fast) → the whole edit composed in chunks at 540p
    (draft-NN.mp4) → p4's verdict on it (rubric + gates + judges) → only if it ships, the cut at the source
    size → the 4K edit composed in chunks (final-NN.mp4). A held edit gets no 4K render.
    -> {"draft": path, "held": bool, "final": path | None}"""
    from . import render
    d = Path(d)
    W, H = src_size
    dw, dh = (int(x) for x in render.draft_size(W, H).split(":"))
    cut = f"cut{dh}-{k:02d}"
    progress("Draft: the cut at 540p…", 0.0)
    try:
        render.render(d, v, fps, cut, f"{dw}:{dh}", crf=20, preset="veryfast", cancelled=cancelled,
                      room_tone_start=room_tone_start, direct=True)
        draft = compose(d, k, f"{cut}.mp4", fps, (dw, dh), cancelled, lambda m, f: progress(f"Draft: {m}", 0.05 + 0.4 * f),
                        f"draft-{k:02d}", chunked=True, workers=workers, crf=23, preset="veryfast", draft=f"{dw}x{dh}")
    finally:
        (d / f"{cut}.mp4").unlink(missing_ok=True)
    vd = verdict_of(d, k) or {"held": True}
    if vd.get("held") or not final:
        if vd.get("held"):
            ev_log.emit("log", f"edit {k}: the 540p draft is held — no 4K render", level="warn")
        return {"draft": draft, "held": bool(vd.get("held")), "final": None}
    return {"draft": draft, "held": False, "final": factory_final(d, k, v, fps, src_size, cancelled, progress,
                                                                  room_tone_start, workers)}


def factory_final(d, k, v, fps, src_size, cancelled, progress, room_tone_start=0.0, workers=None):
    """The 4K final of a draft that shipped (chunked; unchanged chunks of an earlier round reused). None when
    the edit is held (no verdict, a held verdict, or a private frame in the full-size camera output)."""
    from . import render
    d = Path(d)
    vd = verdict_of(d, k)
    if not vd or vd.get("held"):
        return None
    W, H = src_size
    done = d / f"final-{k:02d}.mp4"
    vp, ep = d / f"edit-{k:02d}" / "verdict.json", d / "edl.json"
    if done.exists() and all(not p.exists() or done.stat().st_mtime >= p.stat().st_mtime for p in (vp, ep)):
        return done                                  # already made for this verdict (the compose step's 4K)
    cut = f"cutfull-{k:02d}"
    progress(f"Final: the cut at {W}×{H}…", 0.5)
    try:
        render.render(d, v, fps, cut, f"{W}:{H}", crf=14, preset="medium", cancelled=cancelled,
                      room_tone_start=room_tone_start, direct=True)
        return compose(d, k, f"{cut}.mp4", fps, (W, H), cancelled, lambda m, f: progress(f"Final: {m}", 0.55 + 0.45 * f),
                       f"final-{k:02d}", chunked=True, workers=workers, verdict=False)
    finally:
        (d / f"{cut}.mp4").unlink(missing_ok=True)


def _video(d, k):
    v = json.load(open(Path(d) / "edl.json"))["videos"][k - 1]
    return {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}


def pick_music(base_path):
    """Jake's library (Lab music tracks copied to /opt/aieditor-work/music). The bed sits
    ~23 LU under the voice (reference 2), no ducking. None if the library is empty."""
    tracks = sorted(p for p in MUSIC_DIR.glob("*") if p.suffix.lower() in (".wav", ".mp3", ".m4a", ".ogg", ".flac"))
    if not tracks:
        return None
    t = tracks[0]
    meta = MUSIC_DIR / f"{t.name}.lufs"
    if meta.exists():
        lufs = float(meta.read_text())
    else:
        out = subprocess.run(["docker", "run", "--rm", "-v", f"{MUSIC_DIR}:/m", "--entrypoint", "sh", config.FFMPEG_IMAGE, "-c",
                              f"ffmpeg -hide_banner -nostats -i '/m/{t.name}' -af ebur128 -f null - 2>&1 | grep -E '^ +I:' | tail -1"],
                             capture_output=True, text=True).stdout
        lufs = float(out.split()[1]) if out.split() else -14.0
        meta.write_text(str(lufs))
    return {"path": str(t), "gain_db": compose_long.music_gain(VOICE_LUFS, lufs), "fade_in": 1.0, "fade_out": 1.0}
