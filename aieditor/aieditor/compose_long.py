"""Long-form (16:9) composite: the cut + screencast segments + facecam bubble + graphics
+ music bed + SFX → one edited video.

The look is reference 2 (kwysV2smgfY, Jake's own screencast tutorial): screencasts play
FULL FRAME, hard cuts in and out, the presenter in a circle top-right while a screencast
is on; text/CTA graphics over the A-roll; a quiet music bed under the voice for the whole
video; SFX on graphic entrances. Every timing is in OUTPUT seconds (the cut's own clock,
the same clock as edl words), so a segment anchored to word ids follows any recut.

Inputs (all inside the job dir):
  base                     the cut (preview-NN.mp4 or the full-res cut), with its audio
  segments  [{t0, t1, clip, bubble}]   clip = a camera-rendered screencast at output size
  events    [{t0, t1, frames_dir, start_frame, template}]   graphics PNG sequences (compose.render_events)
  music     {path, gain_db, fade_in, fade_out}
"""
import json
import subprocess
import uuid
from pathlib import Path

from . import config, media, sfx

SC_IMAGE = "aieditor-screencast:0.1"
SCREENCAST = config.CODE / "screencast"

# reference 2 facecam (kwys-screencast.json), px at 1080p
FACECAM = {"centre": [1701.9, 253.7], "video_d": 344.6, "outer_d": 358.6, "crop_px": 715,
           "fade_out_s": 7 / 29.97, "fade_in_s": 11 / 29.97}
MUSIC_UNDER_VOICE_DB = 23       # reference 2: bed ~23 LU under the voice, no ducking
XFADE_REF_FRAMES = 5            # screencast → screencast dissolve (refs 2–5: 3–8 f, SYSTEM.md §3b)


def xfade_s(fps=30000 / 1001):
    return round(XFADE_REF_FRAMES / (30000 / 1001), 4)


def _run(cmd, mounts, cancelled=lambda: False, image=SC_IMAGE, memory=None):
    name = f"aieditor-long-{uuid.uuid4().hex[:10]}"
    full = ["docker", "run", "--rm", "--name", name, "--cpuset-cpus", config.CPUSET, "--memory", memory or config.MEMORY]
    for a, b in mounts:
        full += ["-v", f"{a}:{b}"]
    full += [image, "sh", "-c", cmd]
    p = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    import time
    while p.poll() is None:
        if cancelled():
            subprocess.run(["docker", "kill", name], capture_output=True)
            p.wait()
            raise InterruptedError()
        time.sleep(1)
    out, err = p.communicate()
    if p.returncode != 0:
        raise RuntimeError(f"compose_long failed: {err[-1200:]}")
    return out


def bubble_assets(job, W, H):
    job = Path(job)
    out = job / "facecam"
    out.mkdir(exist_ok=True)
    side = json.loads(_run(f"python3 /sc/facecam.py assets {W / 1920:.6f} /out", [(SCREENCAST, "/sc"), (out, "/out")]))["side"]
    return out, side


def _vis_expr(spans, fo, fi):
    """1 = bubble shown; each hide span fades out over fo and back in over fi (reference)."""
    terms = [f"(1-clip((T-{a:.3f})/{fo:.3f},0,1)*(1-clip((T-{b:.3f})/{fi:.3f},0,1)))" for a, b in spans]
    return "*".join(terms) if terms else "1"


def composite(job, base, segments, events, music, out_name, size, fps, face, cancelled=lambda: False, crf=18,
              preset="veryfast", bubble_src=None, gfx_tag="gfx-long"):
    """base: the cut with the A-roll camera already applied (aroll_camera.py); bubble_src:
    the cut WITHOUT it (the bubble shows the presenter steady). segments carry t0, t1, clip
    and bubble_hide (clip-relative spans from camera.py)."""
    job = Path(job)
    W, H = size
    k = W / 1920
    P = FACECAM
    fdir, side = bubble_assets(job, W, H)
    dv = int(round(P["video_d"] * k)) // 2 * 2
    bx = int(round(P["centre"][0] * k - side / 2))
    by = int(round(P["centre"][1] * k - side / 2))
    # the presenter square around the face, in base px
    fx, fy, fw, fh = face[0] * W, face[1] * H, face[2] * W, face[3] * H
    sq = int(round(P["crop_px"] * k)) // 2 * 2
    sx = int(min(max(0, fx + fw / 2 - sq / 2), W - sq)) // 2 * 2
    sy = int(min(max(0, fy + fh * 0.62 - sq / 2), H - sq)) // 2 * 2

    ins = [f"-i /job/{base}", f"-i /job/{bubble_src or base}"]
    chain = []
    cur = "0:v"
    for i, s in enumerate(segments):
        ins.append(f"-i /job/{s['clip']}")
        n = len(ins) - 1
        # a screencast that follows another back to back dissolves in over its tail (linear)
        fin = (f",format=rgba,fade=t=in:st=0:d={s['fade_in']:.4f}:alpha=1" if s.get("fade_in") else "")
        t1 = s["t1"] + s.get("tail", 0)
        chain.append(f"[{n}:v]setpts=PTS-STARTPTS{fin},setpts=PTS+{s['t0']:.4f}/TB[sc{i}];"
                     f"[{cur}][sc{i}]overlay=eof_action=pass{':format=auto' if fin else ''}:enable='between(t,{s['t0']:.4f},{t1:.4f})'[vs{i}]")
        cur = f"vs{i}"
    bub = [s for s in segments if s.get("bubble", True)]
    if bub:
        ins.append("-loop 1 -i /fc/mask.png")
        mi = len(ins) - 1
        ins.append("-loop 1 -i /fc/ring.png")
        ri = len(ins) - 1
        en = "+".join(f"between(t,{s['t0']:.4f},{s['t1']:.4f})" for s in bub)
        hides = [(s["t0"] + a, s["t0"] + b) for s in bub for a, b in s.get("bubble_hide", [])]
        vis = _vis_expr(hides, P["fade_out_s"], P["fade_in_s"])
        off = (side - dv) // 2
        chain.append(f"[1:v]crop={sq}:{sq}:{sx}:{sy},scale={dv}:{dv}:flags=lanczos,format=rgba,"
                     f"pad={side}:{side}:{off}:{off}:color=black@0[fv];"
                     f"[{mi}:v]format=gray[fm];[fv][fm]alphamerge[fd];"
                     f"[{ri}:v]format=rgba[ring];[fd][ring]overlay=shortest=1:format=auto,format=rgba"
                     + (f",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({vis})'" if hides else "")
                     + f"[bub];[{cur}][bub]overlay={bx}:{by}:shortest=1:enable='{en}'[vb]")
        cur = "vb"
    for m, ev in enumerate(events):
        ins.append(f"-framerate {fps} -start_number {ev['start_frame']} -i /g/{ev['frames_dir']}/f%05d.png")
        n = len(ins) - 1
        chain.append(f"[{n}:v]setpts=PTS-STARTPTS+{ev['start_frame']}/({fps}*TB)[g{m}];"
                     f"[{cur}][g{m}]overlay=eof_action=pass:format=auto[vg{m}]")
        cur = f"vg{m}"
    chain.append(f"[{cur}]format=yuv420p[vout]")

    a_ins, a_graph = sfx.filter_for(events, len(ins) + (1 if music else 0))
    # the voice comes from input 1 (the untouched cut), not the camera pass's re-encode
    a_graph = a_graph.replace("[0:a]", "[1:a]")
    if music:
        ins.append(f"-stream_loop -1 -i /music/{Path(music['path']).name}")
        mu = len(ins) - 1
        dur = media.probe(job / base)["duration"]
        fo = music.get("fade_out", 1.0)
        chain.append(f"[{mu}:a]aresample=48000,atrim=0:{dur:.3f},asetpts=PTS-STARTPTS,volume={music['gain_db']:.1f}dB,"
                     f"afade=t=in:d={music.get('fade_in', 1.0)},afade=t=out:st={max(0, dur - fo):.3f}:d={fo}[mus]")
    ins += a_ins
    if music:
        chain.append(a_graph.replace("[aout]", "[asfx]"))
        chain.append("[asfx][mus]amix=inputs=2:normalize=0:duration=first[aout]")
    else:
        chain.append(a_graph)
    (job / f"{out_name}.filter.txt").write_text(";".join(chain))
    big = W > 1920
    if big:
        # 4K: a dozen inputs each holding a few 4K frames + x264's look-ahead went past 3 GB
        # (OOM-killed at 3.1 GB, 2026-10-06): one decoder thread per input, short look-ahead
        ins = [f"-threads 1 {x}" if not x.startswith("-loop") else x for x in ins]
    cmd = (f"ffmpeg -v error -y {' '.join(ins)} -filter_complex_script /job/{out_name}.filter.txt "
           f"-map [vout] -map [aout] -r {fps} -c:v libx264 -preset {preset} -crf {crf} "
           + ("-filter_complex_threads 2 -threads 3 -x264-params rc-lookahead=8:sync-lookahead=0 " if big else "")
           + f"-c:a aac -b:a 192k "
           f"-movflags +faststart -t {media.probe(job / base)['duration']:.3f} "
           f"/job/{out_name}.part.mp4")
    mounts = [(job, "/job"), (fdir, "/fc"), (sfx.LIB, "/sfx")]
    if events:
        mounts.append((job / gfx_tag, "/g"))
    if music:
        mounts.append((Path(music["path"]).parent, "/music"))
    _run(cmd, mounts, cancelled, memory="4500m" if big else None)
    (job / f"{out_name}.part.mp4").replace(job / f"{out_name}.mp4")
    return job / f"{out_name}.mp4"


def trim_blank(seg, cam, min_blank=1.0, min_len=2.5):
    """Cut a screencast back to the presenter where it goes blank (>= min_blank s of an empty
    screen — an animated page scrolled into nothing). None if too little is left."""
    for a, b in cam.get("blank", []):
        if b - a >= min_blank:
            # only a blank a SCROLL led into (an animated page scrolled into nothing). An app
            # loading a document is white for a moment too — that is not a dead screencast
            # (2026-10-06: the Linearity canvas loading cut the opening at 4.6 s)
            scrolls = [x for x in cam.get("scrolls", []) if a - 3.0 <= x <= a]
            if not scrolls:
                continue
            cut = max(scrolls)
            if cut < min_len:
                return None
            return {**seg, "t1": round(seg["t0"] + cut, 3), "trimmed_blank": [a, b]}
    return seg


def music_gain(voice_lufs, track_lufs, under_db=MUSIC_UNDER_VOICE_DB):
    """Gain (dB) that puts the bed `under_db` below the voice's integrated loudness."""
    return (voice_lufs - under_db) - track_lufs
