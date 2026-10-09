"""The background music of a long-form edit: the library, the per-job choice, and "Change music".

LIBRARY  /opt/aieditor-work/music/ (the Lab mounts it as /aieditor-work/music — lab/server/src/aieditor/music.ts
         lists it, imports the Lab's own music tracks into it, takes uploads and deletes):
           <id>                 the track (id = its file name: [A-Za-z0-9_-]+.(wav|mp3|m4a|ogg|flac))
           <id>.lufs            its integrated loudness, measured once (the format pick_music always used)
           library.json         {"default": id | null, "tracks": {id: {title, added_at, origin, lab_id?}},
                                 "removed_lab": [Lab track ids Jake deleted here — never re-imported]}
         A factory server's image carries a copy of the folder from its build (cloud.py), so a track added
         later travels WITH the job: materialise() links the chosen track into <job>/music/ before the job is
         sent, and on a factory server pick() takes it from there.

CHOICE   request.json "music": {"track": id | null | "none", "gain_lu": n}
           null (or no field)  "Auto": the library default (else the first track — the old behaviour)
           "none"              no music bed at all
           gain_lu             −6 … +6 LU relative to the default bed, which sits ~23 LU under the voice
                               (reference 2, compose_long.MUSIC_UNDER_VOICE_DB): a fixed gain, no ducking

CHANGE   remusic(): queue action "remusic" on a finished long-form job. Music only touches the SOUND, so the
         picture of every finished output is kept bit for bit (a stream copy) and only the soundtrack is
         rebuilt with the production graph (compose_long.soundtrack: voice + bed + SFX):
           edit-NN.mp4 / draft-NN.mp4 / final-NN.mp4   new soundtrack, remuxed under the same video stream
           handoff-NN/                                 audio/music.wav re-rendered, preview.mp4 re-mixed from
                                                       the stems, the zip re-packed (the timelines point at
                                                       audio/music.wav with the same length: unchanged)
         Nothing is re-recorded, re-planned, re-aligned or re-cut. The voice is the cut the output was made
         from: the preview-NN.mp4 an edit-NN.mp4 was composed on, else the cut's exact sound (render
         audio_only — a 23-min cut in ~3 min on the box). An output older than the current cut, or whose
         length does not match, is skipped and said so — never a voice out of sync with the picture.
"""
import json
import math
import os
import re
import shutil
import time
import zipfile
from pathlib import Path

from . import compose_long, config, events as ev_log, media

LIB = Path(os.environ.get("AIEDITOR_MUSIC_DIR", str(config.WORK / "music")))
EXTS = (".wav", ".mp3", ".m4a", ".ogg", ".flac")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(wav|mp3|m4a|ogg|flac)$")
LIBRARY_JSON = "library.json"
JOB_SUB = "music"                       # <job>/music/: the chosen track a factory run takes along
APPLIED = "music-applied.json"          # <job>/music-applied.json: what the outputs carry now
GAIN_LU_MIN, GAIN_LU_MAX = -6.0, 6.0
VOICE_LUFS = -14.0                      # render.py normalises the voice to −14 LUFS
FADE_S = 1.0


# ── the library ────────────────────────────────────────────────────────────────────────────────────────────

def _jload(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def _jdump(p, obj):
    tmp = Path(str(p) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    os.replace(tmp, p)


def tracks(lib=None):
    """The library's track files, by name."""
    lib = Path(lib or LIB)
    return sorted(p for p in lib.glob("*") if p.is_file() and p.suffix.lower() in EXTS and ID_RE.match(p.name))


def library_doc(lib=None):
    doc = _jload(Path(lib or LIB) / LIBRARY_JSON, {})
    return doc if isinstance(doc, dict) else {}


def default_id(lib=None):
    """The library default ("Set as default"), else the first track (what pick_music always took)."""
    names = [p.name for p in tracks(lib)]
    d = library_doc(lib).get("default")
    if d in names:
        return d
    return names[0] if names else None


def title_of(tid, lib=None):
    t = ((library_doc(lib).get("tracks") or {}).get(tid) or {}).get("title")
    return t or (Path(tid).stem if tid else "")


def choice(req):
    """request.json "music" → {"track": None (Auto) | "none" | id, "gain_lu": float in −6 … +6}."""
    m = (req or {}).get("music")
    m = m if isinstance(m, dict) else {}
    t = m.get("track")
    if t == "none":
        track = "none"
    elif isinstance(t, str) and ID_RE.match(t):
        track = t
    else:
        track = None
    try:
        g = float(m.get("gain_lu") or 0.0)
    except (TypeError, ValueError):
        g = 0.0
    if not math.isfinite(g):
        g = 0.0
    return {"track": track, "gain_lu": round(min(GAIN_LU_MAX, max(GAIN_LU_MIN, g)), 2)}


def lufs_of(path):
    """Integrated loudness of a track, cached next to it as <name>.lufs."""
    path = Path(path)
    meta = path.parent / f"{path.name}.lufs"
    try:
        return float(meta.read_text())
    except (OSError, ValueError):
        pass
    p = media._docker("sh", ["-c", f"ffmpeg -hide_banner -nostats -i '/m/{path.name}' -af ebur128 -f null - 2>&1 "
                                   f"| grep -E '^ +I:' | tail -1"], [(path.parent, "/m", "ro")], check=False)
    parts = (p.stdout or "").split()
    try:
        lufs = float(parts[1])
    except (IndexError, ValueError):
        lufs = VOICE_LUFS
    try:
        meta.write_text(str(lufs))
    except OSError:
        pass
    return lufs


def _packed(d):
    """The track materialise() put in the job folder: (path, lufs) or None."""
    doc = _jload(Path(d) / JOB_SUB / "choice.json")
    if not isinstance(doc, dict) or not ID_RE.match(str(doc.get("id") or "")):
        return None
    p = Path(d) / JOB_SUB / doc["id"]
    if not p.is_file():
        return None
    try:
        return p, float(doc["lufs"])
    except (KeyError, TypeError, ValueError):
        return p, None


def resolve(d, req=None, lib=None, packed=None):
    """The track file this job's music choice means, or None (no music). On a factory server
    (packed=None → config.FACTORY_SERVER) the copy in <job>/music/ wins: the image's library may be older."""
    req = req if req is not None else _jload(Path(d) / "request.json", {})
    c = choice(req)
    if c["track"] == "none":
        return None
    if packed is None:
        packed = config.FACTORY_SERVER
    if packed:
        pk = _packed(d)
        if pk:
            return pk[0]
    lib = Path(lib or LIB)
    if c["track"] and (lib / c["track"]).is_file():
        return lib / c["track"]
    if c["track"]:
        pk = _packed(d)                      # a deleted library track still in the job folder
        if pk and pk[0].name == c["track"]:
            return pk[0]
        ev_log.emit("log", f"music: the chosen track {c['track']} is no longer in the library — the default instead",
                    level="warn")
    tid = default_id(lib)
    return lib / tid if tid else None


def pick(d, req=None, lib=None, packed=None):
    """compose_long's music dict for job `d` ({path, gain_db, fade_in, fade_out} + id/title/gain_lu), or None
    for "No music" / an empty library. The bed is loudness-matched ~23 LU under the voice + the job's gain_lu."""
    req = req if req is not None else _jload(Path(d) / "request.json", {})
    t = resolve(d, req, lib, packed)
    if t is None:
        return None
    lufs = None
    pk = _packed(d)
    if pk and pk[0] == t:
        lufs = pk[1]
    if lufs is None:
        lufs = lufs_of(t)
    g = choice(req)["gain_lu"]
    return {"path": str(t), "gain_db": round(compose_long.music_gain(VOICE_LUFS, lufs) + g, 2),
            "fade_in": FADE_S, "fade_out": FADE_S, "id": t.name, "title": title_of(t.name, lib), "gain_lu": g,
            "lufs": lufs}


def describe(m):
    if not m:
        return "no music"
    g = m.get("gain_lu") or 0
    return f"“{m.get('title') or m.get('id')}”" + (f" {g:+g} LU" if g else "")


def materialise(d, req=None, lib=None):
    """Before a job leaves for a factory server: its track (Auto resolved HERE, on the box) linked into
    <job>/music/ with its loudness, so the server mixes exactly what the box would. Returns the id or None."""
    d = Path(d)
    req = req if req is not None else _jload(d / "request.json", {})
    sub = d / JOB_SUB
    shutil.rmtree(sub, ignore_errors=True)
    t = resolve(d, req, lib, packed=False)
    if t is None:
        return None
    sub.mkdir(exist_ok=True)
    try:
        os.link(t, sub / t.name)
    except OSError:
        shutil.copy2(t, sub / t.name)
    _jdump(sub / "choice.json", {"id": t.name, "lufs": lufs_of(t), "title": title_of(t.name, lib), "at": time.time()})
    return t.name


# ── "Change music" on a finished job ─────────────────────────────────────────────────────────────────────

def _duration(path):
    """Container duration (s) of any media file (media.probe needs a video stream)."""
    path = Path(path).resolve()
    p = media._docker("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", f"/in/{path.name}"],
                      [(path.parent, "/in", "ro")])
    return float(json.loads(p.stdout)["format"]["duration"])


def composed_outputs(d, k):
    """The finished outputs of video k that carry a music bed (made by compose_long, so a soundtrack graph):
    edit-NN / draft-NN / final-NN whose filter script is in edit-NN/. A long-form final of the plain cut (no
    edit) has no bed and is not touched."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    if not (w / "direct.json").exists():
        return []
    out = []
    for name in (f"edit-{k:02d}", f"draft-{k:02d}", f"final-{k:02d}"):
        if (d / f"{name}.mp4").is_file() and ((w / f"{name}.filter.txt").exists() or (w / f"{name}.audio.filter.txt").exists()):
            out.append(name)
    return out


def handoff_packages(d, n):
    d = Path(d)
    return [k for k in range(1, n + 1)
            if (d / f"handoff-{k:02d}" / "audio" / "voice.wav").is_file() and (d / f"handoff-{k:02d}.json").is_file()]


def plan(d):
    """What a music change would rebuild: {"outputs": {k: [names]}, "handoffs": [k]}."""
    d = Path(d)
    e = _jload(d / "edl.json", {}) or {}
    n = len(e.get("videos") or [])
    return {"outputs": {k: composed_outputs(d, k) for k in range(1, n + 1) if composed_outputs(d, k)},
            "handoffs": handoff_packages(d, n)}


def sfx_events(d, k, W):
    """The overlay events whose SFX the output at width W carries — the same list compose gave the soundtrack:
    edit-NN/overlays.json, plus the motion plates for an output rendered at another size."""
    from . import longedit
    w = Path(d) / f"edit-{k:02d}"
    events = _jload(w / "overlays.json", []) or []
    if W != 1920:
        try:
            plan_ = json.load(open(w / "direct.json"))["plan"]
            seen = {(e.get("template"), e.get("t0")) for e in events}
            events = events + [e for e in longedit.motion_plate_events(d, plan_) if (e.get("template"), e.get("t0")) not in seen]
        except (OSError, ValueError, KeyError):
            pass
    return events


def _voice(d, k, v, name, fps, info, cancelled, progress):
    """The sound of the cut `name` was made from → (file in d, made_here). edit-NN (the 1080 compose) was
    composed on preview-NN.mp4: its sound. Everything else: the current cut's exact sound (render audio_only)
    — and the caller checks the output is not older than the cut."""
    from . import render
    d = Path(d)
    if name.startswith("edit-"):
        pv = d / f"preview-{k:02d}.mp4"
        if pv.is_file() and pv.stat().st_mtime <= (d / f"{name}.mp4").stat().st_mtime:
            return pv, False
    lp, ep = d / f"listen-{k:02d}.mp4", d / "edl.json"
    if lp.is_file() and lp.stat().st_mtime >= ep.stat().st_mtime:
        return lp, False                                 # the sound check IS the cut's exact sound
    out = d / f"remusic-voice-{k:02d}.mp4"
    if out.is_file() and out.stat().st_mtime >= ep.stat().st_mtime:
        return out, True
    rts = 0.0
    if not (d / "roomtone.wav").exists():
        from . import edl
        rts = edl.Audio(d / "audio16k.wav").room_tone()
    progress("The cut's sound (no picture)…", None)
    render.render(d, v, fps, out.stem, render.listen_size(info["width"], info["height"]), cancelled=cancelled,
                  room_tone_start=rts, audio_only=True)
    return out, True


def remix_output(d, k, name, voice, mus, fps, end_fade, cancelled):
    """One finished output with a new soundtrack under the SAME picture (stream copy). -> (ok, why)."""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    out = d / f"{name}.mp4"
    W = media.probe(out)["width"]
    vlink = w / "remusic-voice.mp4"
    vlink.unlink(missing_ok=True)
    try:
        os.link(voice, vlink)
    except OSError:
        shutil.copy2(voice, vlink)
    tag = f"remusic-{name}"
    try:
        (w / "gfx").mkdir(exist_ok=True)
        snd = compose_long.soundtrack(w, vlink.name, sfx_events(d, k, W), mus, tag, fps, end_fade, cancelled,
                                      None, "gfx", w)
        a, b = _duration(snd), _duration(out)
        if abs(a - b) > 0.15:
            snd.unlink(missing_ok=True)
            return False, f"{name}: its picture is {b:.2f} s, the cut's sound {a:.2f} s — not the same cut, left as it was"
        part = d / f"{name}.remusic.part.mp4"
        compose_long._run(f"ffmpeg -v error -y -i /d/{out.name} -i /w/{snd.name} -map 0:v -map 1:a -c copy "
                          f"-movflags +faststart /d/{part.name}", [(d, "/d"), (w, "/w")], cancelled)
        os.replace(part, out)
        snd.unlink(missing_ok=True)
        return True, ""
    finally:
        vlink.unlink(missing_ok=True)
        (w / f"{tag}.audio.filter.txt").unlink(missing_ok=True)
        (w / f"{tag}.audio.part.m4a").unlink(missing_ok=True)


def music_stem_cmd(mus, vdur, out_dur, out):
    """The hand-off's audio/music.wav (exactly handoff.build's: the bed from 0, the sequence's length)."""
    if not mus:
        return f"ffmpeg -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t {out_dur:.6f} -c:a pcm_s24le {out}"
    fo = mus.get("fade_out", FADE_S)
    return (f"ffmpeg -v error -y -stream_loop -1 -i '/music/{Path(mus['path']).name}' -vn "
            f"-af \"aresample=48000,atrim=0:{vdur:.3f},asetpts=PTS-STARTPTS,volume={mus['gain_db']:.1f}dB,"
            f"afade=t=in:d={mus.get('fade_in', FADE_S)},afade=t=out:st={max(0, vdur - fo):.3f}:d={fo},apad\" "
            f"-t {out_dur:.6f} -ac 2 -c:a pcm_s24le {out}")


def _pack_zip(d, pkg, zp):
    """handoff.build's zip, again (stored media, deflated text), written beside and swapped in."""
    zpart = Path(str(zp) + ".part")
    with zipfile.ZipFile(zpart, "w", allowZip64=True) as z:
        for f in sorted(pkg.rglob("*")):
            if f.is_file():
                comp = zipfile.ZIP_DEFLATED if f.suffix in (".xml", ".fcpxml", ".html", ".csv", ".json", ".txt") else zipfile.ZIP_STORED
                z.write(f, f"{pkg.name}/{f.relative_to(pkg)}", compress_type=comp)
    os.replace(zpart, zp)


def remix_handoff(d, k, v, mus, fps, cancelled, progress):
    """The hand-off package of video k with the new bed: music.wav, the preview's sound, the zip."""
    d = Path(d)
    pkg = d / f"handoff-{k:02d}"
    summ_p = d / f"handoff-{k:02d}.json"
    summ = _jload(summ_p, {}) or {}
    num, den = (summ.get("fps") or [None, None])[:2]
    pfps = num / den if num and den else fps
    total = int(summ.get("frames") or 0)
    out_dur = total / pfps if total else _duration(pkg / "audio" / "voice.wav")
    vdur = sum(p["frames"] for p in v["pieces"]) / fps          # the cut's own length (the bed fades out there)
    work = d / f"edit-{k:02d}" / "remusic-work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        progress("Hand-off: the music stem…", None)
        mounts = [(work, "/o")] + ([(Path(mus["path"]).parent, "/music")] if mus else [])
        compose_long._run(music_stem_cmd(mus, vdur, out_dur, "/o/music.wav"), mounts, cancelled)
        pv = pkg / "preview.mp4"
        if pv.is_file():
            progress("Hand-off: the preview's sound…", None)
            compose_long._run("ffmpeg -v error -y -i /p/preview.mp4 -i /p/audio/voice.wav -i /p/audio/sfx.wav -i /o/music.wav "
                              "-filter_complex \"[1:a][2:a][3:a]amix=inputs=3:normalize=0:duration=first[a]\" "
                              "-map 0:v -map [a] -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart /o/preview.mp4",
                              [(pkg, "/p"), (work, "/o")], cancelled)
        zp = d / f"handoff-{k:02d}.zip"
        need = (zp.stat().st_size if zp.exists() else 0) + 1e9
        free = shutil.disk_usage(d).free
        if free < need:
            raise RuntimeError(f"not enough disk to re-pack the hand-off zip: {free / 1e9:.1f} GB free, needs {need / 1e9:.1f} GB")
        old_pv = pv.stat().st_ino if pv.is_file() else None
        os.replace(work / "music.wav", pkg / "audio" / "music.wav")
        if (work / "preview.mp4").is_file():
            os.replace(work / "preview.mp4", pv)
            lab_pv = d / f"preview-{k:02d}.mp4"             # the Lab's player opens on it (a hard link)
            if lab_pv.is_file() and lab_pv.stat().st_ino == old_pv:
                lab_pv.unlink()
                os.link(pv, lab_pv)
        progress("Hand-off: packing the zip…", None)
        _pack_zip(d, pkg, zp)
        if summ:
            summ["files"] = {str(f.relative_to(pkg)): f.stat().st_size for f in sorted(pkg.rglob("*")) if f.is_file()}
            summ["zip_bytes"] = zp.stat().st_size
            summ["music"] = {"track": (mus or {}).get("id"), "gain_lu": (mus or {}).get("gain_lu", 0), "at": time.time()}
            _jdump(summ_p, summ)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def remusic(d, cancelled=lambda: False, progress=lambda m, f=None: None, log=print):
    """Queue action "remusic": every finished output of the job with the music request.json now asks for.
    -> a one-line note. Raises when there is nothing to change."""
    d = Path(d)
    req = _jload(d / "request.json", {}) or {}
    if req.get("format") != "long":
        raise RuntimeError("only long-form edits have a music bed")
    e = _jload(d / "edl.json")
    info = _jload(d / "source.json")
    if not e or not info:
        raise RuntimeError("there is no cut yet")
    fps = info["fps"]
    todo = plan(d)
    n_steps = sum(len(x) for x in todo["outputs"].values()) + len(todo["handoffs"])
    if not n_steps:
        raise RuntimeError("no finished edit with music yet — build the edit (or the hand-off package) first")
    mus = pick(d, req)
    log(f"music: {describe(mus)} → {n_steps} output(s)")
    ev_log.emit("log", f"music: {describe(mus)}" + (f", bed {mus['gain_db']:+.1f} dB (track {mus['lufs']:.1f} LUFS)" if mus else ""))
    done, skipped, step = [], [], 0

    def prog(msg, f=None):
        progress(msg, min(0.99, (step + (f or 0.0)) / n_steps))

    made = []
    try:
        for k, v in enumerate(e["videos"], 1):
            end_fade = max((x["end"] for x in v["words"]), default=None)
            voices = {}
            for name in todo["outputs"].get(k, []):
                out = d / f"{name}.mp4"
                if not name.startswith("edit-") and out.stat().st_mtime < (d / "edl.json").stat().st_mtime:
                    skipped.append(f"{name}: made before the latest cut edits — re-render it")
                    step += 1
                    continue
                prog(f"{name}: the cut's sound…")
                vf, here = _voice(d, k, v, name, fps, info, cancelled, prog)
                if here:
                    made.append(vf)
                voices[name] = vf
                prog(f"{name}: new soundtrack, same picture…", 0.5)
                ok, why = remix_output(d, k, name, vf, mus, fps, end_fade, cancelled)
                (done if ok else skipped).append(name if ok else why)
                step += 1
            if k in todo["handoffs"]:
                remix_handoff(d, k, v, mus, fps, cancelled, lambda m, f=None, k=k: prog(f"Video {k}: {m}", f))
                done.append(f"handoff-{k:02d}")
                step += 1
    finally:
        for f in made:
            Path(f).unlink(missing_ok=True)
    for s in skipped:
        log(f"music: skipped {s}")
        ev_log.emit("log", f"music: skipped {s}", level="warn")
    _jdump(d / APPLIED, {"track": (mus or {}).get("id"), "title": (mus or {}).get("title"),
                          "gain_lu": choice(req)["gain_lu"], "none": mus is None, "outputs": done,
                          "skipped": skipped, "at": time.time()})
    if not done:
        raise RuntimeError("no output could take the new music: " + "; ".join(skipped)[:400])
    return f"{describe(mus)} in {', '.join(done)}" + (f" ({len(skipped)} skipped)" if skipped else "")
