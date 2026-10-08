"""Phase 2 render for shorts: graphics frames per event + the composite.

Graphics: each planned event is its own scene (graphics.scene_for) rendered by
motion/render.mjs in the clipmagic-lab image (Chromium + the bundled fonts), transparent
PNGs numbered by OUTPUT frame. Composite: the cut's preview + every event's frames at
their place on the timeline + the Lab's word-by-word captions (motion/captions.mjs —
the short-form editor's own engine, keepClear = bottom band) → edit-NN.mp4.
"""
import os
import json
import shutil
import subprocess
import uuid
from pathlib import Path

from . import config, events as ev_log, graphics, sfx

# The motion renderer (motion/render.mjs + Chromium + fonts) from the Lab image, pinned under its
# own tag: factory servers carry it in their snapshot (cloud.IMAGES), and a moving "latest"
# would make every Lab deploy invalidate that snapshot. Re-tag + `aieditor-factory image`
# when motion/render.mjs changes.
LAB_IMAGE = os.environ.get("AIEDITOR_MOTION_IMAGE", "aieditor-motion:1")
MOTION = config.CODE / "motion"
CAPTION_STYLE = {"template": "white-mont", "overrides": {"wordColor": "#FF2E6A"}}   # t7: active word pink


def _docker(args, cancelled, mounts):
    name = f"aieditor-gfx-{uuid.uuid4().hex[:10]}"
    cmd = ["docker", "run", "--rm", "--name", name, "--cpuset-cpus", config.CPUSET, "--memory", config.MEMORY]
    for a, b in mounts:
        cmd += ["-v", f"{a}:{b}"]
    cmd += args
    script = next((a for a in args if isinstance(a, str) and a.endswith((".mjs", ".py"))), None)
    label = f"graphics container ({script.rsplit('/', 1)[-1]})" if script else "ffmpeg composite"
    with ev_log.proc(label, name):
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        import time
        while p.poll() is None:
            if cancelled():
                subprocess.run(["docker", "kill", name], capture_output=True)
                p.wait()
                raise InterruptedError()
            time.sleep(1)
        out, err = p.communicate()
        if p.returncode != 0:
            raise RuntimeError(f"{args[-3:]} failed: {err[-800:]}")
    return out


def render_events(job, n, events, fps_out, scale=1, cancelled=lambda: False, progress=lambda m, f: None, tag="gfx"):
    """→ job/<tag>-NN/ev-MM/fXXXXX.png for every event (output-frame numbered).
    scale 1 = the 1080×1920 preview, 2 = the 2160×3840 final."""
    job = Path(job)
    g = job / f"{tag}-{n:02d}"
    shutil.rmtree(g, ignore_errors=True)
    g.mkdir()
    for m, ev in enumerate(events):
        progress(f"Rendering graphic {m + 1} of {len(events)} ({ev['template']})…", m / max(1, len(events)))
        sc = graphics.scene_for(ev, fps_out, scale=scale)
        (g / f"ev-{m:02d}.json").write_text(json.dumps(sc))
        _docker(["--entrypoint", "node", LAB_IMAGE, "/app/motion/render.mjs", f"/g/ev-{m:02d}.json", f"/g/ev-{m:02d}"],
                cancelled, [(MOTION, "/app/motion"), (g, "/g"), (job, "/job")])
    return g


def captions(job, n, video, width, height, tag="captions"):
    """The Lab's own caption engine → job/<tag>-NN.ass (sized for width×height)."""
    job = Path(job)
    tmp = job / "tmp-captions"
    tmp.mkdir(exist_ok=True)
    req = {"words": [{"word": w["word"], "start": w["start"], "end": w["end"]} for w in video["words"]],
           "width": width, "height": height, "duration": video["duration"], **CAPTION_STYLE}
    (job / f"{tag}-{n:02d}.json").write_text(json.dumps(req))
    _docker(["--env-file", str(config.ENV_FILE), "--entrypoint", "node", LAB_IMAGE, "/app/motion/captions.mjs",
             f"/job/{tag}-{n:02d}.json", f"/job/{tag}-{n:02d}.ass"],
            lambda: False, [(MOTION, "/app/motion"), (job, "/job"), (tmp, "/data/tmp")])
    shutil.rmtree(tmp, ignore_errors=True)
    return job / f"{tag}-{n:02d}.ass"


def composite(job, n, events, base, fps_out, out_name, cancelled=lambda: False, tag="gfx", cap="captions", crf=18):
    """base (the cut, with its audio) + event frames + captions + SFX → out_name.mp4."""
    job = Path(job)
    g = job / f"{tag}-{n:02d}"
    ins, chain = [f"-i /job/{base}"], []
    cur = "0:v"
    for m, ev in enumerate(events):
        d = g / f"ev-{m:02d}"
        files = sorted(d.glob("f*.png"))
        if not files:
            continue
        start = int(files[0].stem[1:])
        ins.append(f"-framerate {fps_out} -start_number {start} -i /g/ev-{m:02d}/f%05d.png")
        k = len(ins) - 1
        chain.append(f"[{k}:v]setpts=PTS-STARTPTS+{start}/({fps_out}*TB)[g{k}];"
                     f"[{cur}][g{k}]overlay=eof_action=pass:format=auto[v{k}]")
        cur = f"v{k}"
    ass = f"/job/{cap}-{n:02d}.ass"
    chain.append(f"[{cur}]ass={ass}:fontsdir=/app/assets/fonts,format=yuv420p[out]")
    # sound effects on the measured cues (+60 ms pops etc.), mixed under the voice
    s_ins, s_graph = sfx.filter_for(events, len(ins))
    ins += s_ins
    chain.append(s_graph)
    script = ";".join(chain)
    (job / f"compose-{n:02d}.txt").write_text(script)
    cmd = (f"ffmpeg -v error -y {' '.join(ins)} -filter_complex_script /job/compose-{n:02d}.txt "
           f"-map [out] -map [aout] -c:v libx264 -preset veryfast -crf {crf} -c:a aac -b:a 192k -movflags +faststart "
           f"/job/{out_name}.part.mp4")
    _docker(["--entrypoint", "sh", LAB_IMAGE, "-c", cmd], cancelled, [(job, "/job"), (g, "/g"), (sfx.LIB, "/sfx")])
    (job / f"{out_name}.part.mp4").replace(job / f"{out_name}.mp4")
    return job / f"{out_name}.mp4"
