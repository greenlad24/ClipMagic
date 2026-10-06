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

from . import agentrec, compose_long, config, director, graphics_long, media

SC_IMAGE = "aieditor-screencast:0.1"
SCREENCAST = config.CODE / "screencast"
MUSIC_DIR = Path("/opt/aieditor-work/music")
VOICE_LUFS = -14.0                   # render.py normalises the voice to −14 LUFS


def _docker(args, mounts, cancelled, name="aieditor-sc", cpus=None):
    cname = f"{name}-{uuid.uuid4().hex[:8]}"
    cmd = ["docker", "run", "--rm", "--name", cname, "--cpuset-cpus", cpus or config.CPUSET, "--shm-size", "1g",
           "--memory", config.MEMORY]
    for a, b in mounts:
        cmd += ["-v", f"{a}:{b}"]
    cmd += [SC_IMAGE] + args
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


def _fresh(path, than):
    return path.exists() and path.stat().st_mtime >= than


def plan_and_record(d, k, v, sites, sponsored, fps, progress, cancelled, log):
    """Plan + scripts + recordings + overlays for video k. Returns (summary, usd)."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    w.mkdir(exist_ok=True)
    edl_at = (d / "edl.json").stat().st_mtime
    video = {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}
    usd = 0.0
    # a site the UX Scout is logged in to → the real app, driven by the agent recorder
    scout = next((x for x in (agentrec.scout_for(s["url"]) for s in sites) if x), None)
    knowledge = scout["report"] if scout else None
    plan_p = w / "direct.json"
    if not _fresh(plan_p, edl_at):
        progress("Claude is planning the edit (screencasts + graphics)…", 0.02)
        plan, raw, meta = director.plan(video, sites, sponsored, knowledge)
        usd += meta["usd"]
        json.dump({"plan": plan, "raw": raw, "meta": meta, "sites": sites}, open(plan_p, "w"), indent=1)
        for x in plan["dropped"]:
            log(f"edit {k}: dropped {x.get('template', 'screencast')} ({x['dropped']})")
        for old in w.glob("seg-*"):                       # a new plan invalidates every recording
            shutil.rmtree(old, ignore_errors=True)
    doc = json.load(open(plan_p))
    # re-validate the cached answer every run: a fixed rule reaches existing jobs, and a trim
    # only ever shortens a segment, so its recording stays valid
    plan = director.validate(doc["raw"], video, doc.get("sites", sites))
    if plan != doc["plan"]:
        doc["plan"] = plan
        json.dump(doc, open(plan_p, "w"), indent=1)
        os.utime(plan_p, (edl_at + 1, edl_at + 1)) if plan_p.stat().st_mtime < edl_at else None
    segs = plan["segments"]
    n_recorded = 0
    if scout:
        log(f"edit {k}: logged in to {scout['slug']} through the UX Scout — recording the real app")
        sess = None
        try:
            for i, seg in enumerate(segs):
                if (w / f"seg-{i:02d}" / "rec" / "events.json").exists():
                    continue
                if sess is None:
                    sess = agentrec.Session(w, scout["profile"], cancelled)
                progress(f"Screencast {i + 1} of {len(segs)}: Claude is showing it in {scout['slug']} "
                         f"({seg['t1'] - seg['t0']:.0f} s, frame by frame)…", 0.1 + 0.75 * i / max(1, len(segs)))
                try:
                    usd += agentrec.record_segment(sess, seg, video, knowledge, f"seg-{i:02d}/rec", log=log, first=(i == 0))
                except RuntimeError as err:
                    # a stuck/dead browser: a fresh session and one more try for this segment
                    log(f"edit {k}: screencast {i + 1} — {err}; restarting the browser and trying again")
                    sess.close()
                    sess = agentrec.Session(w, scout["profile"], cancelled)
                    usd += agentrec.record_segment(sess, seg, video, knowledge, f"seg-{i:02d}/rec", log=log, first=True)
        finally:
            if sess:
                sess.close()
        n_recorded = len(segs)
        segs = []                                   # recorded: skip the scripted path below
    for i, seg in enumerate(segs):
        sd = w / f"seg-{i:02d}"
        sd.mkdir(exist_ok=True)
        base = 0.1 + 0.75 * i / max(1, len(segs))
        if not (sd / "script.json").exists():
            progress(f"Screencast {i + 1} of {len(segs)}: reading {seg['url']}…", base)
            _docker(["node", "/app/screencast/inventory.mjs", seg["url"], "/s/inventory.json", "/s/inventory.jpg"],
                    [(SCREENCAST, "/app/screencast"), (sd, "/s")], cancelled, "aieditor-inv")
            script, meta = director.write_script(seg, video, json.load(open(sd / "inventory.json")),
                                                 (sd / "inventory.jpg").read_bytes())
            usd += meta["usd"]
            script["until"] = round(seg["t1"] - seg["t0"] + 0.5, 2)
            json.dump(script, open(sd / "script.json", "w"), indent=1)
        if not (sd / "rec" / "events.json").exists():
            progress(f"Screencast {i + 1} of {len(segs)}: recording {seg['t1'] - seg['t0']:.0f} s (frame by frame)…", base + 0.05)
            (sd / "rec").mkdir(exist_ok=True)
            _docker(["node", "/app/screencast/vrecord.mjs", "/s/script.json", "/s/rec"],
                    [(SCREENCAST, "/app/screencast"), (sd, "/s")], cancelled, "aieditor-rec")
        ev = json.load(open(sd / "rec" / "events.json"))
        if ev.get("failed"):
            log(f"edit {k}: screencast {i + 1} recording stopped early: {ev['failed']}")
    progress("Rendering the overlays…", 0.88)
    evs = graphics_long.render(w, plan["overlays"], video, fps, tag="gfx", cancelled=cancelled)
    json.dump(evs, open(w / "overlays.json", "w"), indent=1)
    n = n_recorded if scout else len(segs)
    return f"{n} screencast(s){' in the logged-in app' if scout else ''}, {len(evs)} overlay(s)", usd


def compose(d, k, base, fps, size, cancelled, progress, out_name, bubble_src=None, face_src=None):
    """Camera per segment at `size`, the A-roll camera on `base`, then the composite."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    plan = json.load(open(w / "direct.json"))["plan"]
    W, H = size
    segs = []
    for i, seg in enumerate(plan["segments"]):
        sd = w / f"seg-{i:02d}"
        if not (sd / "rec" / "events.json").exists():
            continue
        progress(f"Screencast {i + 1}: camera…", 0.1 + 0.4 * i / max(1, len(plan["segments"])))
        clip = f"sc-{i:02d}-{W}.mp4"
        _docker(["python3", "/a/screencast/camera.py", f"/w/seg-{i:02d}/rec", f"/w/{clip}", "--size", f"{W}x{H}",
                 "--from", "0", "--to", f"{seg['t1'] - seg['t0']:.3f}", "--fps", f"{fps:.8f}"],
                [(config.CODE, "/a"), (w, "/w")], cancelled, "aieditor-cam")
        cam = json.load(open(w / f"{clip}.camera.json"))
        kept = compose_long.trim_blank({"t0": seg["t0"], "t1": seg["t1"], "clip": clip, "bubble": True,
                                        "bubble_hide": cam["bubble_hide"]}, cam)
        if kept:
            segs.append(kept)
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
    json.dump({"blocks": blocks, "fps": fps}, open(w / "blocks.json", "w"))
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
    if W != 1920:                                        # overlays re-rendered at the output size
        progress("Overlays at full resolution…", 0.65)
        events = graphics_long.render(w, plan["overlays"], _video(d, k), fps, size=size, tag=f"gfx-{W}",
                                      cancelled=cancelled)
    music = pick_music(d / base)
    progress("Compositing (screencasts, bubble, overlays, music)…", 0.75)
    out = compose_long.composite(w, cam_base, segs, events, music, out_name, size, fps, face,
                                 bubble_src=plain.name, crf=17 if W == 1920 else 16, cancelled=cancelled,
                                 gfx_tag="gfx" if W == 1920 else f"gfx-{W}")
    final = d / f"{out_name}.mp4"
    Path(out).replace(final)
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
