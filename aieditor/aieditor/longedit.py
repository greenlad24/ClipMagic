"""Long-form FULL EDIT (phase 2+3): the cut → a produced video in the reference-2 look.

  plan      director.plan: screencast segments on the job's `sites` + A-roll overlays,
            anchored to word ids (direct-NN.json; reused while edl.json is unchanged)
  scripts   per segment: page inventory + screenshot → director.write_script
  record    screencast/vrecord.mjs — VIRTUAL TIME, frame-exact on this CPU box
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

from . import agentrec, compose_long, config, director, events as ev_log, graphics_long, media

SC_IMAGE = config.SC_IMAGE
SCREENCAST = config.CODE / "screencast"
MUSIC_DIR = Path("/opt/aieditor-work/music")
VOICE_LUFS = -14.0                   # render.py normalises the voice to −14 LUFS


def _docker(args, mounts, cancelled, name="aieditor-sc", cpus=None, tz="Asia/Bangkok"):
    cname = f"{name}-{uuid.uuid4().hex[:8]}"
    cmd = ["docker", "run", "--rm", "--name", cname, "--cpuset-cpus", cpus or config.CPUSET, "--shm-size", "1g",
           "--memory", config.MEMORY, "-e", f"TZ={tz}", "-e", f"AGENT_PROXY={config.EGRESS_PROXY}"]
    for a, b in mounts:
        cmd += ["-v", f"{a}:{b}"]
    cmd += [SC_IMAGE] + args
    script = next((a for a in args if isinstance(a, str) and a.endswith((".mjs", ".py"))), "")
    labels = {"inventory.mjs": "page inventory (screenshot + elements)", "vrecord.mjs": "screencast recorder (virtual time)",
              "camera.py": "screencast camera (zoom/pan)", "facecam.py": "face finder",
              "aroll_camera.py": "A-roll camera (zoom-out, push-ins, end fade)"}
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
            scouts[x["slug"]] = x
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
    if not _fresh(plan_p, edl_at):
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
    segs = plan["segments"]
    n_recorded = 0
    by_scout = {}
    for i, seg in enumerate(segs):
        x = agentrec.scout_for(seg.get("url", ""))
        # RULEBOOK L4: a public (logged-out) beat is never recorded in the logged-in browser — it goes to the
        # scripted recorder's fresh, never-logged-in Chrome (en-US)
        if x and x["slug"] in scouts and (seg.get("session") or {}).get("kind") != "public":
            by_scout.setdefault(x["slug"], []).append(i)
    for slug, idx in by_scout.items():
        x = scouts[slug]
        dark = bool(gate.get(slug, {}).get("dark"))
        log(f"edit {k}: logged in to {slug} through the UX Scout — recording the real app"
            f"{' (dark theme)' if dark else ''}: {len(idx)} screencast(s)")
        sess = None
        try:
            for n, i in enumerate(idx):
                seg = segs[i]
                if (w / f"seg-{i:02d}" / "rec" / "events.json").exists():
                    continue
                ev_log.set_sub(f"screencast {i + 1}/{len(segs)}")
                ev_log.emit("step", f"screencast {i + 1}/{len(segs)}: {seg['t0']:.1f}–{seg['t1']:.1f}s on {seg.get('url', '')}"
                            f" — {str(seg.get('intent', ''))[:160]}")
                if sess is None:
                    sess = agentrec.Session(w, x["profile"], cancelled, dark=dark,
                                            profile_name="profile" if len(by_scout) == 1 else f"profile-{slug}")
                progress(f"Screencast {i + 1} of {len(segs)}: Claude is showing it in {slug} "
                         f"({seg['t1'] - seg['t0']:.0f} s, frame by frame)…", 0.1 + 0.75 * i / max(1, len(segs)))
                out_rel = f"seg-{i:02d}/rec"
                try:
                    usd += agentrec.record_segment(sess, seg, video, x["knowledge"], out_rel,
                                                   log=log, first=(n == 0))
                except RuntimeError as err:
                    # a stuck/dead browser or a bot check: a fresh session and one more try for this segment
                    # (a bot check / login wall → also a FRESH copy of the Scout profile)
                    log(f"edit {k}: screencast {i + 1} — {err}; restarting the browser and trying again")
                    sess.close()
                    pname = "profile" if len(by_scout) == 1 else f"profile-{slug}"
                    if isinstance(err, agentrec.WallError):
                        shutil.rmtree(w / pname, ignore_errors=True)
                    shutil.rmtree(w / f"seg-{i:02d}" / "rec", ignore_errors=True)
                    sess = agentrec.Session(w, x["profile"], cancelled, dark=dark, profile_name=pname)
                    try:
                        usd += agentrec.record_segment(sess, seg, video, x["knowledge"], out_rel,
                                                       log=log, first=True)
                    except RuntimeError as err2:
                        # factory rule: route, don't fail — this moment stays A-roll
                        shutil.rmtree(w / f"seg-{i:02d}" / "rec", ignore_errors=True)
                        if isinstance(err2, agentrec.WallError):
                            msg = agentrec.wall_message(slug, err2.wall)
                            log(f"edit {k}: screencast {i + 1}: {msg} ({err2})")
                            ev_log.emit("log", msg, level="warn")
                        else:
                            log(f"edit {k}: screencast {i + 1} failed twice ({err2}) — that moment stays A-roll")
        finally:
            ev_log.set_sub(None)
            if sess:
                sess.close()
        n_recorded += len(idx)
    done = {i for idx in by_scout.values() for i in idx}
    scripted = [(i, seg) for i, seg in enumerate(segs) if i not in done]
    for i, seg in scripted:
        sd = w / f"seg-{i:02d}"
        sd.mkdir(exist_ok=True)
        base = 0.1 + 0.75 * i / max(1, len(segs))
        ev_log.set_sub(f"screencast {i + 1}/{len(segs)}")
        ev_log.emit("step", f"screencast {i + 1}/{len(segs)}: {seg['t0']:.1f}–{seg['t1']:.1f}s on {seg.get('url', '')}"
                    + (" (recorded earlier — reused)" if (sd / "rec" / "events.json").exists() else ""))
        if not (sd / "script.json").exists():
            progress(f"Screencast {i + 1} of {len(segs)}: reading {seg['url']}…", base)
            _docker(["node", "/app/screencast/inventory.mjs", seg["url"], "/s/inventory.json", "/s/inventory.jpg"],
                    [(SCREENCAST, "/app/screencast"), (sd, "/s")], cancelled, "aieditor-inv", tz=_tz(seg))
            script, meta = director.write_script(seg, video, json.load(open(sd / "inventory.json")),
                                                 (sd / "inventory.jpg").read_bytes())
            usd += meta["usd"]
            script["until"] = round(seg["t1"] - seg["t0"] + 0.5, 2)
            json.dump(script, open(sd / "script.json", "w"), indent=1)
        if not (sd / "rec" / "events.json").exists():
            progress(f"Screencast {i + 1} of {len(segs)}: recording {seg['t1'] - seg['t0']:.0f} s (frame by frame)…", base + 0.05)
            (sd / "rec").mkdir(exist_ok=True)
            _docker(["node", "/app/screencast/vrecord.mjs", "/s/script.json", "/s/rec"],
                    [(SCREENCAST, "/app/screencast"), (sd, "/s")], cancelled, "aieditor-rec", tz=_tz(seg))
        ev = json.load(open(sd / "rec" / "events.json"))
        if ev.get("failed"):
            log(f"edit {k}: screencast {i + 1} recording stopped early: {ev['failed']}")
    ev_log.set_sub(None)
    progress("Rendering the overlays…", 0.88)
    evs = graphics_long.render(w, plan["overlays"], video, fps, tag="gfx", cancelled=cancelled)
    json.dump(evs, open(w / "overlays.json", "w"), indent=1)
    n_ok = sum(1 for i in range(len(segs)) if (w / f"seg-{i:02d}" / "rec" / "events.json").exists())
    if not segs:
        log(f"edit {k}: no screencast in the plan — "
            + ("no site could be screencast (A-roll + overlays only)" if not sites else "the director placed none"))
    return (f"{n_ok}/{len(segs)} screencast(s)" + (f" ({n_recorded} in the logged-in app)" if n_recorded else "")
            + f", {len(evs)} overlay(s)"), usd


MIN_KEEP_S = 6.0          # a screencast cut short by the guard keeps at least this much, else A-roll
GUARD_EVERY_S = 1.5       # qa_frames.py sampling interval


def frame_guard(w, cancelled):
    """screencast/qa_frames.py over every recorded segment (cached in frames-qa.json until a raw.mp4
    changes): {"03": [{"t", "kind", "why"}]} — challenge / error / account hits by recorded second."""
    w = Path(w)
    raws = list(w.glob("seg-*/rec/raw.mp4"))
    if not raws:
        return {}
    cache = w / "frames-qa.json"
    if not cache.exists() or cache.stat().st_mtime < max(r.stat().st_mtime for r in raws):
        accts = [json.load(open(r.parent / "events.json")).get("account") for r in raws if (r.parent / "events.json").exists()]
        acct = max(set(a for a in accts if a), key=accts.count, default=None)
        # the result goes to a FILE: a big JSON on the pipe would block a container nobody reads yet
        _docker(["python3", "/a/screencast/qa_frames.py", "/w", "--out", f"/w/{cache.name}", "--every", str(GUARD_EVERY_S)]
                + (["--account", acct] if acct else []), [(config.CODE, "/a"), (w, "/w")], cancelled, "aieditor-qaframes")
    try:
        return json.loads(cache.read_text()).get("segments", {})
    except (OSError, ValueError):
        return {}


def compose(d, k, base, fps, size, cancelled, progress, out_name, bubble_src=None, face_src=None):
    """Camera per segment at `size`, the A-roll camera on `base`, then the composite."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    plan = json.load(open(w / "direct.json"))["plan"]
    W, H = size
    segs = []
    allsegs = plan["segments"]
    xf_s = compose_long.xfade_s(fps)
    jobs = []
    # GUARD (Jake 2026-10-08/09): a bot check, an app error or another account can never reach an edit —
    # the recorder's live checks (events.json "walls") + the frame guard (OCR of the recorded pixels)
    bad = frame_guard(w, cancelled)
    usable = {}
    for i, seg in enumerate(allsegs):
        sd = w / f"seg-{i:02d}"
        if not (sd / "rec" / "events.json").exists():
            continue
        ev = json.load(open(sd / "rec" / "events.json"))
        hits = [x for x in ev.get("walls", []) if x.get("kind") in agentrec.DROP_KINDS] + bad.get(f"{i:02d}", [])
        if not hits:
            usable[i] = seg
            continue
        first = min(float(x.get("t", 0)) for x in hits)
        why = next(x for x in hits if float(x.get("t", 0)) == first)
        # frames are OCR'd every GUARD_EVERY_S: the bad state may have begun up to one interval earlier
        keep = first - (GUARD_EVERY_S + 0.5 if why in bad.get(f"{i:02d}", []) else 0.5)
        if keep >= MIN_KEEP_S:
            # the clean beginning stays; the screencast ends before the bad frame, A-roll takes over
            usable[i] = {**seg, "t1": seg["t0"] + keep}
            msg = (f"screencast {i + 1}: {why.get('kind')} at {first:.1f}s ({why.get('why')}) — cut to its first "
                   f"{keep:.1f}s, A-roll after")
        else:
            msg = f"screencast {i + 1}: {why.get('kind')} at {first:.1f}s ({why.get('why')}) — dropped, A-roll used"
        ev_log.emit("log", msg, level="warn")
    for i, seg in sorted(usable.items()):
        clip = f"sc-{i:02d}-{W}.mp4"
        # two screencasts back to back = a change of world (a new recording): the next one
        # DISSOLVES in over this one (SYSTEM.md §3b), so this clip runs a few frames longer
        nxt = usable.get(i + 1)
        into_next = bool(nxt and abs(nxt["t0"] - seg["t1"]) < 0.05)
        # the clip also runs past its end for the dissolve back into the full-screen narration
        # (Jake #5: the bubble fades first, then the screencast) — both need extra frames
        tail = xf_s if into_next else compose_long.aroll_tail_s()
        jobs.append((i, seg, clip, into_next, tail))

    def camera(job):
        i, seg, clip, _, tail = job
        _docker(["python3", "/a/screencast/camera.py", f"/w/seg-{i:02d}/rec", f"/w/{clip}", "--size", f"{W}x{H}",
                 "--from", "0", "--to", f"{seg['t1'] - seg['t0'] + tail:.3f}", "--fps", f"{fps:.8f}"],
                [(config.CODE, "/a"), (w, "/w")], cancelled, "aieditor-cam")
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
    for i, seg, clip, into_next, tail in jobs:
        cam = json.load(open(w / f"{clip}.camera.json"))
        kept = compose_long.trim_blank({"t0": seg["t0"], "t1": seg["t1"], "clip": clip, "bubble": True,
                                        "bubble_hide": cam["bubble_hide"]}, cam)
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
        events = graphics_long.render(w, plan["overlays"], _video(d, k), fps, size=size, tag=f"gfx-{W}",
                                      cancelled=cancelled)
    music = pick_music(d / base)
    progress("Compositing (screencasts, bubble, overlays, music)…", 0.75)
    out = compose_long.composite(w, cam_base, segs, events, music, out_name, size, fps, face,
                                 bubble_src=plain.name, crf=17 if W == 1920 else 16, cancelled=cancelled,
                                 gfx_tag="gfx" if W == 1920 else f"gfx-{W}",
                                 end_fade_from=max((w_["end"] for w_ in _video(d, k)["words"]), default=None))
    final = d / f"{out_name}.mp4"
    Path(out).replace(final)
    for ext in (".plan.json", ".cuts.json"):            # keep the motion plan with the edit (QA reads it)
        if (w / f"{cam_base}{ext}").exists():
            os.replace(w / f"{cam_base}{ext}", w / f"aroll{ext}")
    (w / cam_base).unlink(missing_ok=True)
    plain.unlink(missing_ok=True)
    return final


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
