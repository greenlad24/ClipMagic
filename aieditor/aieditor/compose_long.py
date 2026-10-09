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

from . import config, events as ev_log, media, sfx

SC_IMAGE = config.SC_IMAGE
SCREENCAST = config.CODE / "screencast"

# reference 2 facecam (kwys-screencast.json), px at 1080p
FACECAM = {"centre": [1701.9, 253.7], "video_d": 344.6, "outer_d": 358.6, "crop_px": 715,
           "fade_out_s": 7 / 29.97, "fade_in_s": 11 / 29.97}
MUSIC_UNDER_VOICE_DB = 23       # reference 2: bed ~23 LU under the voice, no ducking
XFADE_REF_FRAMES = 5            # screencast → screencast dissolve (refs 2–5: 3–8 f, SYSTEM.md §3b)
# screencast ↔ full-screen narration (Jake #5, SYSTEM.md §0 rule 5; refs 2–5 dissolve variant):
# the BUBBLE fades first (3 f), then the screencast dissolves (10 f linear) — and mirrored on entry
# (the refs' "3 f" was read with the ring-blue test, which drops below its threshold half-way
# through a fade: through the same test our true 3 f fade read as 1 f, a true 6 f fade reads 3 f)
# LOOP ROUND 1 (2026-10-07, review v12 #13): the 10 f screen dissolve showed a 50/50 ghost of the face
# through the app and a milky wash on white pages — "noticed". TECHNIQUES.md CUT04/CUT05: the refs cut
# screencast ↔ A-roll HARD in ≈ 99 % of 262 boundaries; TR05 (bubble-first, ref 5 0:35.8) is Jake's rule 5.
# → bubble out over 4 f ENDING on t1 (gone before the screen changes), then a 4 f screen dissolve
# (50 % at 2 f — under the TR01 3–8 f band's low end, so it reads as a soft cut); entry mirrored:
# the screen in over 4 f, the bubble in over 4 f right after it.
# GAP LIST G6 step 3 (RULEBOOK T5, JAKE>REF: 4 f bubble fade + 4 f dissolve; refs: the picture changes ~0.1 s
# AHEAD of the sentence, CUT04/CUT05 over 262 boundaries): the screen dissolve is 4 f and it COMPLETES
# AROLL_LEAD_S before the sentence start — exit: the screen dissolves out over [t1 − 0.1 − 4 f, t1 − 0.1] after
# the bubble has faded over the 4 f before that; entry (mirrored): the screen dissolves in over
# [t0 − 0.1 − 4 f, t0 − 0.1] (its first frame held) and the bubble fades in over the next 4 f.
# TODO(p2): read these from the skill's rules.json through aieditor/skill.py once p2 merges (same values).
AROLL_BUBBLE_F = 4
AROLL_SCREEN_F = 4
AROLL_BUBBLE_LEAD_F = 4          # exit: the bubble starts fading 4 f before the screencast does
AROLL_LEAD_S = 0.1               # the picture change completes this long before the sentence start
# black → transparent gradient behind every text overlay (Jake #6; ref 2 f1720–1822, f13548–13620)
TEXT_GRADIENT = {"opacity": 0.63, "top": 0.15, "power": 1.23, "in_f": 22, "out_f": 8, "merge_gap_s": 1.0,
                 "templates": ("lower_title", "link", "keyword", "list", "number")}


def xfade_s(fps=30000 / 1001):
    return round(XFADE_REF_FRAMES / (30000 / 1001), 4)


def aroll_tail_s():
    """The screen dissolve between a screencast and the full-screen narration (4 f, T5). Since G6 step 3 the
    dissolve completes AROLL_LEAD_S before t1 (screen_window), so a clip no longer needs to run past t1."""
    return round(AROLL_SCREEN_F / (30000 / 1001), 4)


def _f(n):
    return n / (30000 / 1001)


def entry_lead_s(s):
    """How long before its t0 a screencast coming out of the full-screen narration starts dissolving in
    (its first frame held): 4 f + AROLL_LEAD_S, never before the video's start."""
    if not s.get("aroll_in") or s.get("fade_in"):
        return 0.0
    return round(max(0.0, min(_f(AROLL_SCREEN_F) + AROLL_LEAD_S, s["t0"])), 4)


def screen_window(s):
    """(a, b) output seconds the screencast clip is on screen (its overlay enable window)."""
    a = s["t0"] - entry_lead_s(s)
    b = s["t1"] - AROLL_LEAD_S if s.get("aroll_out") else s["t1"] + s.get("tail", 0)
    return round(a, 4), round(max(b, a + _f(AROLL_SCREEN_F)), 4)


def bubble_env_expr(segments):
    """Bubble opacity over time: 1 on a screencast, with the bubble-first fades where a screencast
    meets the full-screen narration (exit: out over 4 f ending as the 4 f screen dissolve starts;
    entry: in over 4 f once the screencast has dissolved in), untouched between back-to-back screencasts."""
    terms = []
    for s in segments:
        a, b = screen_window(s)
        f_in = (f"clip((T-{a + _f(AROLL_SCREEN_F):.4f})/{_f(AROLL_BUBBLE_F):.4f},0,1)"
                if s.get("aroll_in") else "1")
        f_out = (f"(1-clip((T-{b - _f(AROLL_SCREEN_F) - _f(AROLL_BUBBLE_LEAD_F):.4f})/{_f(AROLL_BUBBLE_F):.4f},0,1))"
                 if s.get("aroll_out") else "1")
        terms.append(f"between(T,{a:.4f},{b:.4f})*{f_in}*{f_out}")
    return f"min(1,{'+'.join(terms)})" if terms else "1"


def gradient_spans(events, fps):
    """[(t0, t1)] output seconds where the text gradient shows: each text overlay's on-screen span
    (its PNG frames), back-to-back overlays merged (ref 2 keeps it across 'Hey everyone' → 'I'm
    Jake Dawson')."""
    spans = []
    for ev in sorted(events, key=lambda e: e.get("start_frame", 0)):
        if ev.get("template") not in TEXT_GRADIENT["templates"]:
            continue
        a = ev["start_frame"] / fps
        n = ev.get("n_frames")
        b = (ev["start_frame"] + n) / fps if n else ev["t1"]
        if spans and a - spans[-1][1] < TEXT_GRADIENT["merge_gap_s"]:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    return spans


def gradient_png(job, W, H):
    """The full-frame gradient (black, alpha = 0.63·((y/H − 0.15)/0.85)^1.23) at the output size."""
    out = Path(job) / f"textgrad-{W}.png"
    if not out.exists():
        g = TEXT_GRADIENT
        _run(f"python3 -c \"import numpy as np, cv2; H={H}; W={W}; y=(np.arange(H)+0.5)/H; "
             f"a=np.clip((y-{g['top']})/(1-{g['top']}),0,1)**{g['power']}*{g['opacity']}; "
             f"img=np.zeros((H,W,4),np.uint8); img[:,:,3]=(a*255).round().astype(np.uint8)[:,None]; "
             f"cv2.imwrite('/job/{out.name}', img)\"", [(Path(job), "/job")])
    return out.name


def _run(cmd, mounts, cancelled=lambda: False, image=SC_IMAGE, memory=None):
    name = f"aieditor-long-{uuid.uuid4().hex[:10]}"
    full = ["docker", "run", "--rm", "--name", name, "--cpuset-cpus", config.CPUSET, "--memory", memory or config.MEMORY]
    for a, b in mounts:
        full += ["-v", f"{a}:{b}"]
    full += [image, "sh", "-c", cmd]
    with ev_log.proc("long-form composite (ffmpeg)", name):
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
              preset="veryfast", bubble_src=None, gfx_tag="gfx-long", end_fade_from=None):
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
        # a screencast that follows another back to back dissolves in over its tail (linear); one
        # that comes out of / goes back to the full-screen narration dissolves too (Jake #5)
        fade = []
        w0, w1 = screen_window(s)
        lead = entry_lead_s(s)
        pad = f",tpad=start_duration={lead:.4f}:start_mode=clone" if lead > 0 else ""
        if s.get("fade_in"):
            fade.append(f"fade=t=in:st=0:d={s['fade_in']:.4f}:alpha=1")
        elif s.get("aroll_in"):
            fade.append(f"fade=t=in:st=0:d={_f(AROLL_SCREEN_F):.4f}:alpha=1")
        if s.get("aroll_out"):
            fade.append(f"fade=t=out:st={w1 - _f(AROLL_SCREEN_F) - w0:.4f}:d={_f(AROLL_SCREEN_F):.4f}:alpha=1")
        fin = ("," + ",".join(["format=rgba"] + fade)) if fade else ""
        chain.append(f"[{n}:v]setpts=PTS-STARTPTS{pad}{fin},setpts=PTS+{w0:.4f}/TB[sc{i}];"
                     f"[{cur}][sc{i}]overlay=eof_action=pass{':format=auto' if fin else ''}:enable='between(t,{w0:.4f},{w1:.4f})'[vs{i}]")
        cur = f"vs{i}"
    bub = [s for s in segments if s.get("bubble", True)]
    if bub:
        ins.append("-loop 1 -i /fc/mask.png")
        mi = len(ins) - 1
        ins.append("-loop 1 -i /fc/ring.png")
        ri = len(ins) - 1
        en = "+".join("between(t,{:.4f},{:.4f})".format(*screen_window(s)) for s in bub)
        hides = [(s["t0"] + a, s["t0"] + b) for s in bub for a, b in s.get("bubble_hide", [])]
        vis = _vis_expr(hides, P["fade_out_s"], P["fade_in_s"])
        env = bubble_env_expr(bub)
        if env != "1":
            vis = f"({vis})*{env}"
            hides = hides or [None]                      # the geq alpha pass is needed
        off = (side - dv) // 2
        chain.append(f"[1:v]crop={sq}:{sq}:{sx}:{sy},scale={dv}:{dv}:flags=lanczos,format=rgba,"
                     f"pad={side}:{side}:{off}:{off}:color=black@0[fv];"
                     f"[{mi}:v]format=gray[fm];[fv][fm]alphamerge[fd];"
                     f"[{ri}:v]format=rgba[ring];[fd][ring]overlay=shortest=1:format=auto,format=rgba"
                     + (f",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({vis})'" if hides else "")
                     + f"[bub];[{cur}][bub]overlay={bx}:{by}:shortest=1:enable='{en}'[vb]")
        cur = "vb"
    # the gradient behind the text overlays (Jake #6), under the text
    for ev in events:
        if "n_frames" not in ev:
            ev["n_frames"] = len(list((job / gfx_tag / ev["frames_dir"]).glob("f*.png")))
    gspans = gradient_spans(events, fps)
    if gspans:
        gname = gradient_png(job, W, H)
        G = TEXT_GRADIENT
        for j, (a, b) in enumerate(gspans):
            d = b - a
            ins.append(f"-loop 1 -framerate {fps} -t {d:.4f} -i /job/{gname}")
            n = len(ins) - 1
            fo = min(_f(G["out_f"]), d / 3)
            chain.append(f"[{n}:v]format=rgba,fade=t=in:st=0:d={min(_f(G['in_f']), d / 2):.4f}:alpha=1,"
                         f"fade=t=out:st={d - fo:.4f}:d={fo:.4f}:alpha=1,setpts=PTS-STARTPTS+{a:.4f}/TB[tg{j}];"
                         f"[{cur}][tg{j}]overlay=eof_action=pass:format=auto:enable='between(t,{a:.4f},{b:.4f})'[vtg{j}]")
            cur = f"vtg{j}"
    for m, ev in enumerate(events):
        ins.append(f"-framerate {fps} -start_number {ev['start_frame']} -i /g/{ev['frames_dir']}/f%05d.png")
        n = len(ins) - 1
        chain.append(f"[{n}:v]setpts=PTS-STARTPTS+{ev['start_frame']}/({fps}*TB)[g{m}];"
                     f"[{cur}][g{m}]overlay=eof_action=pass:format=auto[vg{m}]")
        cur = f"vg{m}"
    # TECHNIQUES TR08 (every ref ends on a 30 f fade to black — ref 2 11:38.1, ref 5 15:42.3): the A-roll
    # camera fades the BASE, but a screencast running to the last frame sat on top unfaded and the
    # bubble was caught mid-fade (review v12 #28) → the fade applies to the whole composite
    vdur = media.probe(job / base)["duration"]
    # ROUND 2 (review D20): TR08 triggers on the LAST WORD — the fade starts when it ends (never earlier),
    # 30 f at most
    # ROUND 3 (review N16): TR08 = ~30 f near-linear fade + 3 black frames (ref 2 11:37.6–11:38.7). The cut ends
    # 0.23 s after the last word, so the picture is EXTENDED (last frame held) to fit the whole fade after it
    f_st = end_fade_from if end_fade_from else vdur - 30 / (30000 / 1001)
    fd = 30 / (30000 / 1001)
    out_dur = max(vdur, f_st + fd + 3 / (30000 / 1001))
    pad = max(0.0, out_dur - vdur + 0.05)
    chain.append(f"[{cur}]tpad=stop_mode=clone:stop_duration={pad:.3f},fade=t=out:st={f_st:.4f}:d={fd:.4f},format=yuv420p[vout]")

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
    chain[-1] = chain[-1].replace("[aout]", "[aout0]")
    chain.append("[aout0]apad[aout]")                    # silence under the extended end fade
    (job / f"{out_name}.filter.txt").write_text(";".join(chain))
    big = W > 1920
    if big:
        # 4K: a dozen inputs each holding a few 4K frames + x264's look-ahead went past 3 GB
        # (OOM-killed at 3.1 GB, 2026-10-06): one decoder thread per input, short look-ahead
        ins = [f"-threads 1 {x}" if not x.startswith("-loop") else x for x in ins]
    # threads follow the cores this machine may use: 3 here, 32 on a factory server
    cores = config.cpu_count()
    ft, xt = max(2, cores // 4), max(3, cores)
    cmd = (f"ffmpeg -v error -y {' '.join(ins)} -filter_complex_script /job/{out_name}.filter.txt "
           f"-map [vout] -map [aout] -r {fps} -c:v libx264 -preset {preset} -crf {crf} "
           + (f"-filter_complex_threads {ft} -threads {xt} -x264-params rc-lookahead=8:sync-lookahead=0 " if big else "")
           + f"-c:a aac -b:a 192k "
           f"-movflags +faststart -t {out_dur:.3f} "
           f"/job/{out_name}.part.mp4")
    mounts = [(job, "/job"), (fdir, "/fc"), (sfx.LIB, "/sfx")]
    if events:
        mounts.append((job / gfx_tag, "/g"))
    if music:
        mounts.append((Path(music["path"]).parent, "/music"))
    _run(cmd, mounts, cancelled, memory="4500m" if big and cores < 16 else None)
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
