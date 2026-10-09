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

Factory mode (recommendation step 8): plan_chunks cuts the timeline into 30–90 s chunks only where nothing
transitions; composite(..., t0, t1) renders one chunk's picture, composite_chunked runs them in parallel,
joins them with the concat demuxer (stream copy) and muxes the soundtrack rendered ONCE for the whole
timeline; chunk_hashes lets a remedy round re-render only the chunks whose inputs changed.
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


def _end_fade(vdur, end_fade_from, fps):
    """TR08 end: (fade start, fade length, output duration, total output frames). The cut ends 0.23 s after
    the last word, so the picture is EXTENDED (last frame held) to fit the whole 30 f fade + 3 black frames."""
    # TECHNIQUES TR08 (every ref ends on a 30 f fade to black — ref 2 11:38.1, ref 5 15:42.3): the A-roll
    # camera fades the BASE, but a screencast running to the last frame sat on top unfaded and the
    # bubble was caught mid-fade (review v12 #28) → the fade applies to the whole composite
    # ROUND 2 (review D20): TR08 triggers on the LAST WORD — the fade starts when it ends (never earlier),
    # 30 f at most
    # ROUND 3 (review N16): TR08 = ~30 f near-linear fade + 3 black frames (ref 2 11:37.6–11:38.7)
    f_st = end_fade_from if end_fade_from else vdur - 30 / (30000 / 1001)
    fd = 30 / (30000 / 1001)
    out_dur = max(vdur, f_st + fd + 3 / (30000 / 1001))
    return f_st, fd, out_dur, int(round(out_dur * fps))


def _shift_seg(s, off):
    return {**s, "t0": s["t0"] - off, "t1": s["t1"] - off}


def _video_graph(job, base, segments, events, size, fps, face, side, gname, bubble_src, vdur, end_fade_from,
                 f0=0, f1=None):
    """The picture's inputs + filter chain (→ [vout]) for output frames [f0, f1) of the timeline. f0 = 0 and
    f1 = None is the whole video (the original single render); a chunk shifts every time by f0/fps and
    seeks its two base inputs, so the chunk's frame n is the whole render's frame f0 + n. A chunk boundary
    must never fall inside a screencast's window or an overlay's span (plan_chunks guarantees it)."""
    W, H = size
    k = W / 1920
    P = FACECAM
    f_st, fd, out_dur, total = _end_fade(vdur, end_fade_from, fps)
    f1 = total if f1 is None else min(f1, total)
    off = f0 / fps
    t_end = f1 / fps
    chunk = not (f0 == 0 and f1 == total)
    dv = int(round(P["video_d"] * k)) // 2 * 2
    bx = int(round(P["centre"][0] * k - side / 2))
    by = int(round(P["centre"][1] * k - side / 2))
    # the presenter square around the face, in base px
    fx, fy, fw, fh = face[0] * W, face[1] * H, face[2] * W, face[3] * H
    sq = int(round(P["crop_px"] * k)) // 2 * 2
    sx = int(min(max(0, fx + fw / 2 - sq / 2), W - sq)) // 2 * 2
    sy = int(min(max(0, fy + fh * 0.62 - sq / 2), H - sq)) // 2 * 2

    if f0 > 0:
        # an accurate input seek: frames before (f0 − ½)/fps are decoded and dropped, frame f0 comes first
        seek = f"-ss {(f0 - 0.5) / fps:.6f} -t {(f1 - f0 + 2) / fps:.6f} "
    elif chunk:
        seek = f"-t {(f1 + 2) / fps:.6f} "
    else:
        seek = ""
    ins = [f"{seek}-i /job/{base}", f"{seek}-i /job/{bubble_src or base}"]
    # ONE working format for the whole main path, whatever is drawn on it: an overlay on format=auto with an
    # rgba input had turned the main picture into rgba from that point on (a lossy yuv→rgb→yuv trip), so a
    # stretch with no overlay came out ~25 levels different in a chunk than in the single render. yuv444p
    # throughout (every overlay on format=auto follows the main format) = the same pixels either way.
    chain = ["[0:v]setpts=PTS-STARTPTS,format=yuv444p[b0]"]
    cur = "b0"

    def inside(a, b, what):
        """[a, b] (seconds) against this chunk: True = draw it, False = another chunk's; straddling = a bug."""
        if b <= off + 1e-6 or a >= t_end - 1e-6:
            return False
        if chunk and (a < off - 1e-6 or b > t_end + 1e-6):
            raise ValueError(f"chunk {off:.3f}-{t_end:.3f} s cuts through {what} {a:.3f}-{b:.3f} s")
        return True

    segs = [_shift_seg(s, off) for s in segments if inside(*screen_window(s), "a screencast")]
    for i, s in enumerate(segs):
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
                     f"[{cur}][sc{i}]overlay=eof_action=pass:format=auto:enable='between(t,{w0:.4f},{w1:.4f})'[vs{i}]")
        cur = f"vs{i}"
    bub = [s for s in segs if s.get("bubble", True)]
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
        off_px = (side - dv) // 2
        chain.append(f"[1:v]setpts=PTS-STARTPTS,crop={sq}:{sq}:{sx}:{sy},scale={dv}:{dv}:flags=lanczos,format=rgba,"
                     f"pad={side}:{side}:{off_px}:{off_px}:color=black@0[fv];"
                     f"[{mi}:v]format=gray[fm];[fv][fm]alphamerge[fd];"
                     f"[{ri}:v]format=rgba[ring];[fd][ring]overlay=shortest=1:format=auto,format=rgba"
                     + (f",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({vis})'" if hides else "")
                     + f"[bub];[{cur}][bub]overlay={bx}:{by}:shortest=1:format=auto:enable='{en}'[vb]")
        cur = "vb"
    # the gradient behind the text overlays (Jake #6), under the text
    gspans = [(a - off, b - off) for a, b in gradient_spans(events, fps) if inside(a, b, "a text gradient")]
    if gspans:
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
    m = 0
    for ev in events:
        a, b = ev["start_frame"] / fps, (ev["start_frame"] + ev.get("n_frames", 0)) / fps
        if not inside(a, max(b, a + 1 / fps), "an overlay"):
            continue
        ins.append(f"-framerate {fps} -start_number {ev['start_frame']} -i /g/{ev['frames_dir']}/f%05d.png")
        n = len(ins) - 1
        chain.append(f"[{n}:v]setpts=PTS-STARTPTS+{ev['start_frame'] - f0}/({fps}*TB)[g{m}];"
                     f"[{cur}][g{m}]overlay=eof_action=pass:format=auto[vg{m}]")
        cur = f"vg{m}"
        m += 1
    # the last frame is held under the end fade; a chunk also holds a couple of spare frames (its seek
    # window is cut to the frame) — the output stops at exactly f1 − f0 frames either way
    pad = max(0.0, out_dur - vdur + 0.05) if f1 >= total else 3 / fps
    chain.append(f"[{cur}]tpad=stop_mode=clone:stop_duration={pad:.3f},fade=t=out:st={f_st - off:.4f}:d={fd:.4f},"
                 f"format=yuv420p[vout]")
    return ins, chain, f1 - f0


def _audio_graph(events, music, vdur, voice, first):
    """The soundtrack (voice from input `voice`, + the music bed, + the SFX cues; their inputs numbered from
    `first`) → [aout], for the WHOLE timeline (a chunked render muxes it once: no AAC priming gap at a seam)."""
    ins, chain = [], []
    if music:
        ins.append(f"-stream_loop -1 -i /music/{Path(music['path']).name}")
        mu = first
        fo = music.get("fade_out", 1.0)
        chain.append(f"[{mu}:a]aresample=48000,atrim=0:{vdur:.3f},asetpts=PTS-STARTPTS,volume={music['gain_db']:.1f}dB,"
                     f"afade=t=in:d={music.get('fade_in', 1.0)},afade=t=out:st={max(0, vdur - fo):.3f}:d={fo}[mus]")
    a_ins, a_graph = sfx.filter_for(events, first + len(ins))
    # the voice comes from the untouched cut (input `voice`), not the camera pass's re-encode
    a_graph = a_graph.replace("[0:a]", f"[{voice}:a]")
    ins += a_ins
    if music:
        chain.append(a_graph.replace("[aout]", "[asfx]"))
        chain.append("[asfx][mus]amix=inputs=2:normalize=0:duration=first[aout]")
    else:
        chain.append(a_graph)
    chain[-1] = chain[-1].replace("[aout]", "[aout0]")
    chain.append("[aout0]apad[aout]")                    # silence under the extended end fade
    return ins, chain


def _mounts(job, fdir, events, music, gfx_tag):
    mounts = [(job, "/job"), (fdir, "/fc"), (sfx.LIB, "/sfx")]
    if events:
        mounts.append((job / gfx_tag, "/g"))
    if music:
        mounts.append((Path(music["path"]).parent, "/music"))
    return mounts


def _x264(W, preset, crf, threads=None):
    """x264 options; at 4K a short look-ahead + bounded threads (a dozen 4K inputs + x264's look-ahead went
    past 3 GB — OOM-killed at 3.1 GB, 2026-10-06). `threads` = the cores one encode may use."""
    big = W > 1920
    cores = threads or config.cpu_count()
    ft, xt = max(2, cores // 4), max(3, cores)
    return (f"-c:v libx264 -preset {preset} -crf {crf} "
            + (f"-filter_complex_threads {ft} -threads {xt} -x264-params rc-lookahead=8:sync-lookahead=0 " if big else ""))


def _thin_inputs(ins, W):
    # 4K: one decoder thread per input (memory, see _x264)
    return [f"-threads 1 {x}" if not x.startswith("-loop") else x for x in ins] if W > 1920 else ins


def count_frames(job, events, gfx_tag):
    """Each overlay event's PNG frame count (its visible span), once."""
    for ev in events:
        if "n_frames" not in ev:
            ev["n_frames"] = len(list((Path(job) / gfx_tag / ev["frames_dir"]).glob("f*.png")))
    return events


def _prepare(job, events, size, fps, gfx_tag, assets=None):
    """Once per output (never per chunk — the chunks run at the same time): bubble assets, the overlays'
    frame counts, the gradient PNG."""
    W, H = size
    fdir, side = assets or bubble_assets(job, W, H)
    count_frames(job, events, gfx_tag)
    gname = gradient_png(job, W, H) if gradient_spans(events, fps) else None
    return fdir, side, gname


def composite(job, base, segments, events, music, out_name, size, fps, face, cancelled=lambda: False, crf=18,
              preset="veryfast", bubble_src=None, gfx_tag="gfx-long", end_fade_from=None, t0=None, t1=None,
              assets=None, threads=None, memory=None, out_path=None):
    """base: the cut with the A-roll camera already applied (aroll_camera.py); bubble_src:
    the cut WITHOUT it (the bubble shows the presenter steady). segments carry t0, t1, clip
    and bubble_hide (clip-relative spans from camera.py).

    t0/t1 (output seconds, on frame boundaries — plan_chunks): render ONE chunk's PICTURE only, at the
    target size, to `out_path` (MPEG-TS, joined later by composite_chunked with a stream copy; the sound
    is rendered once for the whole timeline). Without them: the whole video, picture + sound (as before)."""
    job = Path(job)
    W, H = size
    fdir, side, gname = _prepare(job, events, size, fps, gfx_tag, assets)
    vdur = media.probe(job / base)["duration"]
    _, _, out_dur, total = _end_fade(vdur, end_fade_from, fps)
    chunk = t0 is not None or t1 is not None
    f0 = int(round((t0 or 0.0) * fps))
    f1 = total if t1 is None else int(round(t1 * fps))
    ins, chain, nfr = _video_graph(job, base, segments, events, size, fps, face, side, gname, bubble_src, vdur,
                                   end_fade_from, f0, f1)
    mounts = _mounts(job, fdir, events, music, gfx_tag)
    mem = memory or ("4500m" if W > 1920 and config.cpu_count() < 16 else None)
    if chunk:
        out = Path(out_path or job / f"{out_name}.c{f0:07d}.ts")
        filt = out.parent / f"{out.stem}.filter.txt"
        filt.write_text(";".join(chain))
        rel = lambda p: "/job/" + str(Path(p).resolve().relative_to(job.resolve()))
        cmd = (f"ffmpeg -v error -y {' '.join(_thin_inputs(ins, W))} -filter_complex_script {rel(filt)} "
               f"-map [vout] -an -r {fps} -frames:v {nfr} " + _x264(W, preset, crf, threads)
               + f"-f mpegts {rel(out)}.part")
        _run(cmd, mounts, cancelled, memory=mem)
        Path(f"{out}.part").replace(out)
        return out
    a_ins, a_chain = _audio_graph(events, music, vdur, 1, len(ins))
    chain += a_chain
    ins += a_ins
    (job / f"{out_name}.filter.txt").write_text(";".join(chain))
    cmd = (f"ffmpeg -v error -y {' '.join(_thin_inputs(ins, W))} -filter_complex_script /job/{out_name}.filter.txt "
           f"-map [vout] -map [aout] -r {fps} -frames:v {nfr} " + _x264(W, preset, crf, threads)
           + f"-c:a aac -b:a 192k "
           f"-movflags +faststart -t {out_dur:.3f} "
           f"/job/{out_name}.part.mp4")
    _run(cmd, mounts, cancelled, memory=mem)
    (job / f"{out_name}.part.mp4").replace(job / f"{out_name}.mp4")
    return job / f"{out_name}.mp4"


def soundtrack(job, base, events, music, out_name, fps, end_fade_from=None, cancelled=lambda: False,
               bubble_src=None, gfx_tag="gfx-long", fdir=None):
    """The whole timeline's sound ONCE (voice + music bed + SFX, AAC) → <out_name>.audio.m4a. Its length
    is the picture's (the extended end fade included)."""
    job = Path(job)
    vdur = media.probe(job / base)["duration"]
    _, _, out_dur, _ = _end_fade(vdur, end_fade_from, fps)
    a_ins, a_chain = _audio_graph(events, music, vdur, 0, 1)
    (job / f"{out_name}.audio.filter.txt").write_text(";".join(a_chain))
    cmd = (f"ffmpeg -v error -y -i /job/{bubble_src or base} {' '.join(a_ins)} "
           f"-filter_complex_script /job/{out_name}.audio.filter.txt -map [aout] -vn -c:a aac -b:a 192k "
           f"-t {out_dur:.3f} -f mp4 /job/{out_name}.audio.part.m4a")
    _run(cmd, _mounts(job, fdir or job, events, music, gfx_tag), cancelled)
    (job / f"{out_name}.audio.part.m4a").replace(job / f"{out_name}.audio.m4a")
    return job / f"{out_name}.audio.m4a"


# ── chunked compose (recommendation step 8: chunked 4K, a 540p draft, only changed chunks re-rendered) ──
CHUNK_MIN_S = 30.0
CHUNK_MAX_S = 90.0
CHUNK_TARGET_S = 60.0
CHUNK_MARGIN_S = 0.25            # a seam stays this far from any window (a dissolve's first/last frame)
OVERLAY_TAIL_S = 1.0             # an overlay with no frame count yet: its exit animation may run past t1


def _merge(spans):
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def busy_windows(segments, overlays, fps=30000 / 1001, duration=None, end_fade_from=None):
    """[(a, b)] output seconds no chunk seam may fall inside: every screencast's on-screen window (its
    dissolves, the bubble envelope and any K2 reveal inside it), every overlay's visible span with the text
    gradient that merges neighbours, and the end fade."""
    spans = []
    for s in segments:
        if any(k in s for k in ("aroll_in", "aroll_out", "fade_in", "tail")):
            a, b = screen_window(s)
        else:      # planned/kept spans before compose set the flags: the widest transition either way
            a = s["t0"] - _f(AROLL_SCREEN_F) - AROLL_LEAD_S
            b = s["t1"] + max(xfade_s(), aroll_tail_s())
        spans.append([a, b])
        for k2 in s.get("k2") or []:
            spans.append([s["t0"] + k2[0], s["t0"] + k2[1]] if s.get("k2_rel") else list(k2))
    for o in overlays:
        if "start_frame" in o and o.get("n_frames"):
            a, b = o["start_frame"] / fps, (o["start_frame"] + o["n_frames"]) / fps
        else:
            a = o["start_frame"] / fps if "start_frame" in o else o["t0"]
            b = max(o["t1"], a) + OVERLAY_TAIL_S
        spans.append([a, b])
    # the text gradient spans back-to-back text overlays (< 1 s apart): no seam between them either
    gs = [{**o, "start_frame": o.get("start_frame", int(round(o["t0"] * fps)))} for o in overlays]
    for a, b in gradient_spans([g for g in gs if g.get("n_frames") or "t1" in g], fps):
        spans.append([a, b + OVERLAY_TAIL_S])
    if duration is not None:
        f_st, fd, out_dur, _ = _end_fade(duration, end_fade_from, fps)
        spans.append([f_st, out_dur + 1.0])
    return [(round(a - CHUNK_MARGIN_S, 4), round(b + CHUNK_MARGIN_S, 4)) for a, b in _merge(spans)]


def _free(t, busy):
    return all(not (a < t < b) for a, b in busy)


def plan_chunks(blocks, segments=None, overlays=(), cuts=(), fps=30000 / 1001, duration=None, end_fade_from=None,
                min_s=CHUNK_MIN_S, max_s=CHUNK_MAX_S, target_s=CHUNK_TARGET_S):
    """Chunks of min_s–max_s output seconds for a parallel render, cut ONLY where nothing transitions:
    never inside a screencast window (dissolve / xfade / K2), a bubble envelope, an overlay's visible span
    or its text gradient, or the end fade. Seams prefer the A-roll's real picture cuts (`cuts`, aroll.cuts.json
    — a hard cut hides the encoder's fresh keyframe); then a sentence start in clean A-roll; then any clean
    A-roll frame. Chosen by a small DP that keeps every chunk inside the band and close to target_s.

    blocks: the A-roll blocks [[t0, t1]] or the blocks.json document ({blocks, words, overlays, fps});
    segments: the screencasts on screen (default: the gaps between the blocks).
    → [{i, t0, t1, f0, f1, seam}] on frame boundaries (seam = how the chunk's START was chosen)."""
    doc = blocks if isinstance(blocks, dict) else {"blocks": blocks}
    fps = doc.get("fps") or fps
    blk = [list(map(float, b)) for b in doc.get("blocks") or []]
    words = doc.get("words") or []
    if duration is None:
        duration = max([b[1] for b in blk] + [s["t1"] for s in segments or []] + [0.0])
    if segments is None:
        segments, t = [], 0.0
        for a, b in blk:
            if a - t > 0.05:
                segments.append({"t0": t, "t1": a})
            t = b
        if duration - t > 0.05:
            segments.append({"t0": t, "t1": duration})
    ovs = list(overlays or doc.get("overlays") or [])
    busy = busy_windows(segments, ovs, fps, duration, end_fade_from)
    _, _, out_dur, total = _end_fade(duration, end_fade_from, fps)
    end = total / fps
    if end <= max_s:
        return [{"i": 0, "t0": 0.0, "t1": round(end, 6), "f0": 0, "f1": total, "seam": "start"}]

    def snap(t):
        return int(round(t * fps))

    in_aroll = lambda t: any(a + 0.05 <= t <= b - 0.05 for a, b in blk) if blk else True
    tiers = [
        ("cut", [c for c in cuts]),
        ("sentence", [w["start"] for k, w in enumerate(words)
                      if k == 0 or str(words[k - 1]["word"])[-1:] in ".?!" or w["start"] - words[k - 1]["end"] > 0.9]),
        ("aroll", [x / 4 for x in range(int(end * 4))]),
    ]
    cand = {}                                             # frame -> seam kind (the best tier wins)
    for rank, (kind, ts) in enumerate(tiers):
        for t in ts:
            f = snap(t)
            if 0 < f < total and in_aroll(t) and _free(f / fps, busy) and f not in cand:
                cand[f] = (rank, kind)
    for relax in ((min_s, max_s), (min_s / 2, max_s), (0.0, max_s * 1.5), (0.0, float("inf"))):
        lo, hi = relax
        pts = [0] + sorted(cand) + [total]
        best = {0: (0.0, None)}
        for j in range(1, len(pts)):
            fj = pts[j]
            for i in range(j - 1, -1, -1):
                fi = pts[i]
                L = (fj - fi) / fps
                if L > hi:
                    break
                if L < lo or fi not in best:
                    continue
                # length off target, + a small price for a seam that is not a real picture cut
                cost = best[fi][0] + (L - target_s) ** 2 + (cand.get(fj, (0,))[0] * 25.0 if fj != total else 0)
                if fj not in best or cost < best[fj][0]:
                    best[fj] = (cost, fi)
        if total in best:
            seq, f = [], total
            while f:
                seq.append(f)
                f = best[f][1]
            seq = [0] + seq[::-1]
            return [{"i": n, "t0": round(a / fps, 6), "t1": round(b / fps, 6), "f0": a, "f1": b,
                     "seam": "start" if a == 0 else cand[a][1]} for n, (a, b) in enumerate(zip(seq, seq[1:]))]
    return [{"i": 0, "t0": 0.0, "t1": round(end, 6), "f0": 0, "f1": total, "seam": "start"}]


def _file_sig(p):
    try:
        st = Path(p).stat()
        return [st.st_size, int(st.st_mtime)]
    except OSError:
        return None


def chunk_hashes(job, chunks, segments, events, plan=None, rules_path=None, extra=None, fps=30000 / 1001):
    """sha256 per chunk of everything that draws it: the camera.json of every screencast on screen in it,
    the overlay events in range, the plan's segments/overlays in range, the blurred recording's size+mtime,
    the skill's rules.json version + size, and `extra` (output size, encoder settings, the cut's identity).
    A remedy round re-renders only chunks whose hash changed."""
    import hashlib
    job = Path(job)
    rules = None
    if rules_path and Path(rules_path).exists():
        try:
            rules = [json.loads(Path(rules_path).read_text()).get("version"), Path(rules_path).stat().st_size]
        except (OSError, ValueError):
            rules = [None, Path(rules_path).stat().st_size]
    out = []
    for c in chunks:
        a, b = c["t0"], c["t1"]
        hit = lambda x0, x1: x1 > a and x0 < b
        doc = {"t": [c.get("f0", a), c.get("f1", b)], "rules": rules, "extra": extra, "segs": [], "events": [], "plan": {}}
        for s in segments:
            w0, w1 = screen_window(s) if any(k in s for k in ("aroll_in", "aroll_out", "fade_in", "tail")) else (s["t0"], s["t1"])
            if not hit(w0, w1):
                continue
            cam = None
            if s.get("clip"):
                try:
                    cam = json.loads((job / f"{s['clip']}.camera.json").read_text())
                except (OSError, ValueError):
                    cam = None
            i = s.get("i")
            raw = None
            if i is not None:
                rd = job / f"seg-{int(i):02d}" / "rec"
                raw = _file_sig(rd / "raw.blur.mp4") or _file_sig(rd / "raw.mp4")
            doc["segs"].append({k: v for k, v in s.items() if k != "clip"} | {"camera": cam, "raw": raw})
        for ev in events:
            x0 = ev["start_frame"] / fps if "start_frame" in ev else ev.get("t0", 0)
            x1 = (ev["start_frame"] + ev["n_frames"]) / fps if ev.get("n_frames") and "start_frame" in ev else ev.get("t1", x0)
            if hit(x0, max(x1, x0 + 1e-3)):
                doc["events"].append(ev)
        # the plan slice: every timed list it carries (segments, overlays, the A-roll shots and cuts…)
        for key, xs in sorted((plan or {}).items()):
            if isinstance(xs, list):
                doc["plan"][key] = [x for x in xs if isinstance(x, dict) and "t0" in x
                                    and hit(float(x["t0"]), max(float(x.get("t1", x["t0"])), float(x["t0"]) + 1e-3))]
        out.append(hashlib.sha256(json.dumps(doc, sort_keys=True, default=str).encode()).hexdigest())
    return out


def chunk_workers(W, n_chunks, workers=None):
    """Chunks rendered at once: a 4K x264 encode saturates ~8 cores (4 on a c-32), ≤1080p ~4, a 540p
    draft ~2. Override with `workers` (bin/aieditor-factory --workers / request.json chunk_workers)."""
    if workers:
        return max(1, min(int(workers), n_chunks))
    per = 8 if W > 1920 else 4 if W > 960 else 2
    return max(1, min(n_chunks, config.cpu_count() // per))


def _mem_split(n):
    """config.MEMORY ("54g", "3g", "3000m") shared by n containers running at once."""
    s = str(config.MEMORY).strip().lower()
    mult = {"g": 1024, "m": 1, "k": 1 / 1024}.get(s[-1:], None)
    try:
        mb = float(s[:-1]) * mult if mult else float(s) / 2 ** 20
    except ValueError:
        return None
    return f"{max(1024, int(mb / max(1, n)))}m"


def composite_chunked(job, base, segments, events, music, out_name, size, fps, face, chunks, cancelled=lambda: False,
                      crf=18, preset="veryfast", bubble_src=None, gfx_tag="gfx-long", end_fade_from=None,
                      workers=None, hashes=None, log=None):
    """The video in chunks rendered in parallel (each chunk's picture only), joined with the concat demuxer
    (stream copy), and the whole timeline's sound rendered ONCE and muxed at the end. Writes
    <out_name>.chunks.json [{i, t0, t1, f0, f1, hash}]; with `hashes`, a chunk whose hash matches the previous
    chunks.json (and whose file is still there) is reused — a remedy round re-renders only what changed."""
    from concurrent.futures import ThreadPoolExecutor
    job = Path(job)
    W, H = size
    cdir = job / f"chunks-{out_name}"
    cdir.mkdir(exist_ok=True)
    man_p = job / f"{out_name}.chunks.json"
    try:
        old = {(c["f0"], c["f1"]): c for c in json.loads(man_p.read_text())}
    except (OSError, ValueError, KeyError, TypeError):
        old = {}
    fdir, side, _ = _prepare(job, events, size, fps, gfx_tag)
    todo, man = [], []
    for n, c in enumerate(chunks):
        h = hashes[n] if hashes else None
        f = cdir / f"c{c['f0']:07d}-{c['f1']:07d}.ts"
        prev = old.get((c["f0"], c["f1"]))
        reuse = bool(h and prev and prev.get("hash") == h and f.exists())
        man.append({"i": n, "t0": c["t0"], "t1": c["t1"], "f0": c["f0"], "f1": c["f1"], "hash": h,
                    "file": f.name, "reused": reuse})
        if not reuse:
            todo.append((c, f))
    par = chunk_workers(W, max(1, len(todo)), workers)
    threads = max(2, config.cpu_count() // par)
    mem = _mem_split(par + 1)

    def one(item):
        c, f = item
        composite(job, base, segments, events, music, out_name, size, fps, face, cancelled, crf, preset, bubble_src,
                  gfx_tag, end_fade_from, t0=c["f0"] / fps, t1=c["f1"] / fps, assets=(fdir, side), threads=threads,
                  memory=mem, out_path=f)
    if log:
        log(f"{out_name}: {len(chunks)} chunk(s), {len(todo)} to render ({len(chunks) - len(todo)} unchanged), "
            f"{par} at a time, {threads} threads each")
    with ThreadPoolExecutor(par + 1) as ex:
        snd = ex.submit(soundtrack, job, base, events, music, out_name, fps, end_fade_from, cancelled, bubble_src,
                        gfx_tag, fdir)
        list(ex.map(one, todo))
        snd.result()
    keep = {m["file"] for m in man}
    for stale in cdir.glob("*.ts"):                     # chunks of an older plan
        if stale.name not in keep:
            stale.unlink()
    (cdir / "list.txt").write_text("".join(f"file '{m['file']}'\n" for m in man))
    rel = cdir.relative_to(job)
    _run(f"ffmpeg -v error -y -f concat -safe 0 -i /job/{rel}/list.txt -i /job/{out_name}.audio.m4a "
         f"-map 0:v -map 1:a -c copy -movflags +faststart /job/{out_name}.part.mp4", [(job, "/job")], cancelled)
    (job / f"{out_name}.part.mp4").replace(job / f"{out_name}.mp4")
    (job / f"{out_name}.audio.m4a").unlink(missing_ok=True)
    man_p.write_text(json.dumps([{k: v for k, v in m.items() if k != "reused"} for m in man], indent=1))
    return job / f"{out_name}.mp4", man


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
