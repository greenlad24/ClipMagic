"""Background music: the library + per-job choice (aieditor/music.py) and the "remusic" queue action.

  1 pure: the request.json "music" choice (Auto / a track / "none", gain clamped to ±6 LU), the library
    default, the bed gain (loudness-matched ~23 LU under the voice + gain_lu), a deleted track → the default,
    the factory copy (materialise) winning on a factory server, longedit.pick_music reading the job
  2 media (docker, a throwaway job tree in a temp dir — no real job is touched): the worker's "remusic"
    action on a fake finished job: edit-01 / final-01 get a new soundtrack under the SAME video packets, a
    draft older than the cut is skipped, "none" removes the bed, the hand-off's music stem / preview / zip
    are rebuilt, nothing else in the job changes.

    python3 tests/test_music.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import compose_long, config, longedit, music  # noqa: E402

N = 0


def check(name, cond):
    global N
    N += 1
    if not cond:
        raise SystemExit(f"FAIL: {name}")


# ── 1 pure ────────────────────────────────────────────────────────────────────────────────────────────
check("no field = Auto at the default level", music.choice({}) == {"track": None, "gain_lu": 0.0})
check("none", music.choice({"music": {"track": "none"}})["track"] == "none")
check("a track id", music.choice({"music": {"track": "abc_1.wav", "gain_lu": 2}}) == {"track": "abc_1.wav", "gain_lu": 2.0})
check("a path is not a track id", music.choice({"music": {"track": "../x.wav"}})["track"] is None)
check("gain clamped to +6", music.choice({"music": {"gain_lu": 40}})["gain_lu"] == 6.0)
check("gain clamped to -6", music.choice({"music": {"gain_lu": -9.5}})["gain_lu"] == -6.0)
check("garbage gain = 0", music.choice({"music": {"gain_lu": "loud"}})["gain_lu"] == 0.0)
check("NaN gain = 0", music.choice({"music": {"gain_lu": float("nan")}})["gain_lu"] == 0.0)

tmp = Path(tempfile.mkdtemp(prefix="aieditor-music-test-"))
try:
    lib = tmp / "lib"
    lib.mkdir()
    for name, lufs in (("aaa.wav", -20.0), ("bbb.mp3", -10.0)):
        (lib / name).write_bytes(b"x")
        (lib / f"{name}.lufs").write_text(str(lufs))
    (lib / "notes.txt").write_text("not a track")
    job = tmp / "job"
    job.mkdir()
    check("the library lists tracks only", [p.name for p in music.tracks(lib)] == ["aaa.wav", "bbb.mp3"])
    check("no default set = the first track (the old behaviour)", music.default_id(lib) == "aaa.wav")
    m = music.pick(job, {}, lib, packed=False)
    check("Auto = the first track", m["id"] == "aaa.wav")
    check("the bed sits 23 LU under the voice", abs(m["gain_db"] - ((-14 - 23) - (-20))) < 1e-6)
    check("fades as before", m["fade_in"] == 1.0 and m["fade_out"] == 1.0)
    (lib / "library.json").write_text(json.dumps({"default": "bbb.mp3", "tracks": {"bbb.mp3": {"title": "Cello"}}}))
    m = music.pick(job, {}, lib, packed=False)
    check("Auto = the library default", m["id"] == "bbb.mp3" and m["title"] == "Cello")
    m = music.pick(job, {"music": {"track": "aaa.wav", "gain_lu": -3}}, lib, packed=False)
    check("a chosen track", m["id"] == "aaa.wav")
    check("gain_lu moves the bed by exactly that many dB", abs(m["gain_db"] - (-17 - 3)) < 1e-6)
    check("No music", music.pick(job, {"music": {"track": "none", "gain_lu": 4}}, lib, packed=False) is None)
    m = music.pick(job, {"music": {"track": "gone.wav"}}, lib, packed=False)
    check("a deleted track falls back to the default", m["id"] == "bbb.mp3")
    (lib / "library.json").write_text(json.dumps({"default": "zzz.wav"}))
    check("a default that is gone = the first track", music.default_id(lib) == "aaa.wav")
    check("an empty library = no music", music.pick(job, {}, tmp / "empty", packed=False) is None)

    # materialise: the box resolves Auto and links the track into the job; a factory server takes that copy
    (lib / "library.json").write_text(json.dumps({"default": "bbb.mp3"}))
    check("materialise resolves Auto on the box", music.materialise(job, {}, lib) == "bbb.mp3")
    check("the track is in the job folder", (job / "music" / "bbb.mp3").is_file())
    (lib / "library.json").write_text(json.dumps({"default": "aaa.wav"}))
    other = tmp / "factory-lib"
    other.mkdir()
    (other / "old.wav").write_bytes(b"x")
    (other / "old.wav.lufs").write_text("-30")
    m = music.pick(job, {}, other, packed=True)
    check("on a factory server the job's copy wins over the image's library", m["id"] == "bbb.mp3")
    check("…with the loudness measured on the box", abs(m["gain_db"] - (-37 + 10)) < 1e-6)
    check("on the box the library decides", music.pick(job, {}, lib, packed=False)["id"] == "aaa.wav")
    check("materialise for No music empties the folder", music.materialise(job, {"music": {"track": "none"}}, lib) is None
          and not (job / "music").exists())

    # longedit.pick_music reads the job's request.json (the compose / hand-off entry point)
    saved = music.LIB
    music.LIB = lib
    try:
        (job / "request.json").write_text(json.dumps({"music": {"track": "none"}}))
        check("pick_music: none", longedit.pick_music(job / "preview-01.mp4") is None)
        (job / "request.json").write_text(json.dumps({"music": {"track": "bbb.mp3", "gain_lu": 6}}))
        m = longedit.pick_music(job / "preview-01.mp4")
        check("pick_music: the job's track + gain", m["id"] == "bbb.mp3" and abs(m["gain_db"] - (-27 + 6)) < 1e-6)
    finally:
        music.LIB = saved
finally:
    shutil.rmtree(tmp, ignore_errors=True)
from aieditor import chain  # noqa: E402
cr = chain.creative_request("cut-x", {"format": "long", "music": {"track": "none", "gain_lu": 0}}, "t", "j")
check("a Full edit's creative job keeps the music choice", cr["music"] == {"track": "none", "gain_lu": 0})
check("…and no field when none was chosen", "music" not in chain.creative_request("cut-x", {"format": "long"}, "t", "j"))
print(f"  pure: {N} checks passed")


# ── 2 media: the remusic action on a fake finished job ──────────────────────────────────────────────────
def ff(cmd, d):
    """ffmpeg in the screencast image, `d` mounted at /d."""
    return subprocess.run(["docker", "run", "--rm", "-v", f"{d}:/d", config.SC_IMAGE, "sh", "-c", cmd],
                          capture_output=True, text=True, check=True).stdout


def vhash(d, name):
    return ff(f"ffmpeg -v error -i /d/{name} -map 0:v -c copy -f md5 -", d).strip()


def ahash(d, name):
    return ff(f"ffmpeg -v error -i /d/{name} -map 0:a -f md5 -", d).strip()


def media_check():
    if not shutil.which("docker"):
        print("  (media check skipped: no docker here)")
        return
    tmp = Path(tempfile.mkdtemp(prefix="aieditor-remusic-test-"))
    saved = music.LIB
    try:
        lib = tmp / "lib"
        d = tmp / "jobs" / "fake-remusic-job"
        w = d / "edit-01"
        (w / "gfx").mkdir(parents=True)
        lib.mkdir()
        music.LIB = lib
        fps = 30.0
        # a 4 s 640x360 "cut" with a voice (440 Hz) — the preview and the sound check carry the same sound
        ff("ffmpeg -v error -f lavfi -i testsrc=s=640x360:r=30:d=4 -f lavfi -i sine=f=440:r=48000:d=4 "
           "-c:v libx264 -preset ultrafast -c:a aac -shortest /d/preview-01.mp4", d)
        shutil.copy(d / "preview-01.mp4", d / "listen-01.mp4")
        ff("ffmpeg -v error -y -f lavfi -i sine=f=880:r=48000:d=3 -ac 2 /d/m.wav", d)
        os.replace(d / "m.wav", lib / "cello.wav")
        ff("ffmpeg -v error -y -f lavfi -i sine=f=220:r=48000:d=3 -ac 2 /d/m.wav", d)
        os.replace(d / "m.wav", lib / "piano.wav")
        words = [{"word": "hi", "start": 0.2, "end": 0.5}, {"word": "there", "start": 3.0, "end": 3.4}]
        edl = {"videos": [{"title": "t", "duration": 4.0, "words": words,
                           "pieces": [{"src_frame": 0, "frames": 120, "samples": 192000}]}]}
        (d / "edl.json").write_text(json.dumps(edl))
        (d / "source.json").write_text(json.dumps({"fps": fps, "width": 640, "height": 360, "duration": 4.0}))
        (d / "request.json").write_text(json.dumps({"id": d.name, "format": "long", "sponsored": False,
                                                    "workflow": "creative", "music": {"track": "cello.wav"}}))
        (w / "direct.json").write_text(json.dumps({"plan": {"segments": [], "overlays": []}}))
        (w / "overlays.json").write_text("[]")
        # the finished outputs as compose made them: picture + (voice + piano bed); the draft is OLDER than the cut
        old = {"path": str(lib / "piano.wav"), "gain_db": -10.0, "fade_in": 1.0, "fade_out": 1.0}
        for name in ("edit-01", "final-01", "draft-01"):
            ff("ffmpeg -v error -y -f lavfi -i testsrc2=s=640x360:r=30:d=4.2 -c:v libx264 -preset ultrafast /d/pic.mp4", d)
            os.link(d / "preview-01.mp4", w / "voice.mp4")
            snd = compose_long.soundtrack(w, "voice.mp4", [], old, name, fps, 3.4, fdir=w)
            (w / "voice.mp4").unlink()
            ff(f"ffmpeg -v error -y -i /d/pic.mp4 -i /d/edit-01/{snd.name} -map 0:v -map 1:a -c copy /d/{name}.mp4", d)
            snd.unlink()
            (w / f"{name}.filter.txt").write_text("[1:a]…")      # the compose marker
        (d / "pic.mp4").unlink()
        t_old = time.time() - 3600
        os.utime(d / "draft-01.mp4", (t_old, t_old))
        os.utime(d / "edl.json", (t_old + 60, t_old + 60))
        # a hand-off package (stems from 0, a preview, the zip)
        pkg = d / "handoff-01"
        (pkg / "audio").mkdir(parents=True)
        ff("ffmpeg -v error -i /d/preview-01.mp4 -vn -af apad -t 4.2 -ac 2 -c:a pcm_s24le /d/handoff-01/audio/voice.wav && "
           "ffmpeg -v error -f lavfi -i anullsrc=r=48000:cl=stereo -t 4.2 -c:a pcm_s24le /d/handoff-01/audio/sfx.wav && "
           "ffmpeg -v error -f lavfi -i anullsrc=r=48000:cl=stereo -t 4.2 -c:a pcm_s24le /d/handoff-01/audio/music.wav && "
           "cp /d/edit-01.mp4 /d/handoff-01/preview.mp4", d)
        (pkg / "timeline.xml").write_text("<xmeml/>")
        (d / "handoff-01.json").write_text(json.dumps({"dir": "handoff-01", "zip": "handoff-01.zip", "frames": 126,
                                                       "fps": [30, 1], "files": {}}))
        with zipfile.ZipFile(d / "handoff-01.zip", "w") as z:
            z.writestr("handoff-01/timeline.xml", "<xmeml/>")
        before = {n: (vhash(d, f"{n}.mp4"), ahash(d, f"{n}.mp4")) for n in ("edit-01", "final-01", "draft-01")}
        stem_before = ahash(d, "handoff-01/audio/music.wav")
        untouched = {p: p.stat().st_mtime for p in (d / "edl.json", w / "direct.json", w / "overlays.json", d / "listen-01.mp4")}

        check("plan: edit, draft and final carry a bed; the hand-off package", music.plan(d) ==
              {"outputs": {1: ["edit-01", "draft-01", "final-01"]}, "handoffs": [1]})

        # the worker's action, exactly as the main loop runs it (minus the claim)
        loader = importlib.machinery.SourceFileLoader("aieditor_worker", str(ROOT / "bin" / "aieditor-worker"))
        spec = importlib.util.spec_from_loader("aieditor_worker", loader)
        wk = importlib.util.module_from_spec(spec)
        loader.exec_module(wk)
        (d / "status.json").write_text(json.dumps({"state": "done", "stages": {}}))
        job = wk.Job(d)
        wk.run_job(job, "remusic")
        st = json.loads((d / "status.json").read_text())
        check("the music stage is done", st["stages"]["music"]["state"] == "done")
        for n in ("edit-01", "final-01"):
            v, a = vhash(d, f"{n}.mp4"), ahash(d, f"{n}.mp4")
            check(f"{n}: the same picture, packet for packet", v == before[n][0])
            check(f"{n}: a new soundtrack", a != before[n][1])
        check("the draft older than the cut is left alone", (vhash(d, "draft-01.mp4"), ahash(d, "draft-01.mp4")) == before["draft-01"])
        applied = json.loads((d / music.APPLIED).read_text())
        check("music-applied.json says what the outputs carry", applied["track"] == "cello.wav"
              and "edit-01" in applied["outputs"] and any("draft-01" in s for s in applied["skipped"]))
        check("the hand-off music stem was re-rendered", ahash(d, "handoff-01/audio/music.wav") != stem_before)
        with zipfile.ZipFile(d / "handoff-01.zip") as z:
            names = z.namelist()
        check("the zip was re-packed with the new stem", "handoff-01/audio/music.wav" in names and "handoff-01/preview.mp4" in names)
        summ = json.loads((d / "handoff-01.json").read_text())
        check("the package summary records the music", summ["music"]["track"] == "cello.wav" and summ["files"]["audio/music.wav"] > 0)
        check("nothing upstream was touched", all(p.stat().st_mtime == t for p, t in untouched.items()))
        check("no temp files left", not list(d.glob("remusic-*")) and not list(w.glob("remusic-*")) and not list(d.glob("*.part.mp4")))
        a_cello = ahash(d, "edit-01.mp4")

        # "No music": the bed goes, the picture stays
        req = json.loads((d / "request.json").read_text())
        req["music"] = {"track": "none", "gain_lu": 0}
        (d / "request.json").write_text(json.dumps(req))
        wk.run_job(wk.Job(d), "remusic")
        check("none: a different soundtrack", ahash(d, "edit-01.mp4") != a_cello)
        check("none: the same picture", vhash(d, "edit-01.mp4") == before["edit-01"][0])
        silent = ff("ffmpeg -i /d/handoff-01/audio/music.wav -af volumedetect -f null - 2>&1 | grep max_volume || true", d)
        check("none: the hand-off music stem is silence", "-91" in silent or "-inf" in silent)
        check("none: recorded", json.loads((d / music.APPLIED).read_text())["none"] is True)

        # nothing to change → the action fails loudly (never "done" with nothing done)
        bare = tmp / "jobs" / "bare-job"
        bare.mkdir()
        for f in ("edl.json", "source.json", "request.json"):
            shutil.copy(d / f, bare / f)
        try:
            music.remusic(bare)
            check("a job without a finished edit refuses", False)
        except RuntimeError as e:
            check("a job without a finished edit refuses", "no finished edit" in str(e))
        print(f"  media: remusic checks passed ({N} total)")
    finally:
        music.LIB = saved
        subprocess.run(["docker", "run", "--rm", "-v", f"{tmp}:/t", config.SC_IMAGE, "sh", "-c", "rm -rf /t/*"],
                       capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)


media_check()
print(f"test_music: {N} checks passed")
