"""Render a video's pieces to an MP4 — frame-exact A/V sync, proven by a flash/beep test.

How the sync was lost and won back (2026-10-04, measured with tests/sync_test.py):
  1. rounding each piece separately (video = whole frames, audio = exact)  ~0.5 s drift
  2. joining A/V pieces with the concat demuxer                             ~1 frame
  3. seeking inside AAC (~21 ms packets)
  4. one-pass `loudnorm` (3 s look-ahead) shifted the last seconds a frame late
So: video pieces are exactly N frames; audio pieces are exactly the samples those
frames cover, cut from a PCM decode; video and audio are joined SEPARATELY and muxed
once; loudness is a measured fixed gain + a latency-compensated limiter.
"""
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from . import camera, config, events as ev_log

FADE = 0.012               # 12 ms fade at every audio join: no clicks
TONE_RAMP = 0.006          # speech <-> room tone crossfade inside a muted span
LIMIT = 0.79               # sample peak ~-2 dBFS: the AAC true peak measured -0.4..-0.7 dBTP at 0.84


class RenderCancelled(Exception):
    pass


def render(job, video, fps, out_name, size, source="source.mp4", crf=20, preset="veryfast",
           cancelled=lambda: False, room_tone_start=0.0, audio_only=False, src_size=None,
           direct=False, progress=None):
    """audio_only: the exact soundtrack over the video's first frame, held — a 23-minute
    cut in ~3 minutes instead of ~35, for judging the cuts by ear (Jake: "can you
    preview without render?" / "the cut should be based on the sound anyways").

    direct: encode every piece ONCE at the final crf/preset and join them with a stream
    copy straight into the output. The default path writes near-lossless ultrafast
    intermediates and then copies them again — fine for a 40 s short, ~40 GB for a
    16-minute 4K long-form, which the box does not have. Peak disk here ≈ 2× the output.
    progress(fraction): called while the pieces encode."""
    job = Path(job).resolve()
    tmp = job / f"tmp-{out_name}"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    lines = ["set -e"]
    pieces = []                      # one script per piece: run several at once on a big box
    if not (job / "roomtone.wav").exists():
        # the room's own noise, never digital silence: a muted click or a held frame
        # used to drop to -120 dB, which Jake heard as a dropout at 0:51
        lines.append(f"ffmpeg -v error -y -ss {room_tone_start:.3f} -t 2 -i /job/full48k.wav "
                     f"-c:a pcm_s16le /job/roomtone.wav")
    for k, p in enumerate(video["pieces"]):
        start = len(lines)
        t = p["src_frame"] / fps
        dur = p["frames"] / fps
        hf, tf = p.get("hold_head", 0), p.get("hold_tail", 0)
        n_src = p.get("src_frames", p["frames"])
        # picture: n_src source frames, the first/last frame held hf/tf times
        if not audio_only:
            # shorts: the piece's camera framing (camera.py) — a crop of the 4K source,
            # taken BEFORE the scale so a close-up keeps full detail
            crop = camera.crop_filter(p["framing"], *src_size) if p.get("framing") and src_size else None
            lines.append(
                f"ffmpeg -v error -y -ss {t:.6f} -i /job/{source} -an "
                f"-vf \"trim=end_frame={n_src},tpad=start={hf}:stop={tf}:start_mode=clone:stop_mode=clone,"
                f"{crop + ',' if crop else ''}scale={size}:flags=lanczos,setsar=1\" -frames:v {p['frames']} "
                + (f"-c:v libx264 -preset {preset} -crf {crf} -pix_fmt yuv420p -f mpegts /tmp-dir/{k:05d}.ts" if direct else
                   f"-c:v libx264 -preset ultrafast -crf 12 /tmp-dir/{k:05d}.mkv"))
        # sound: the source under the picture's source frames, silence under held frames;
        # every "tone" span (held frames + muted clicks) is room tone instead
        src_samples = p.get("src_samples", p["samples"])
        head = p.get("head_samples", 0)
        tone = [x for x in p.get("tone", p.get("mute", [])) if x[1] > x[0]]
        # 1 ms audio frames: the tone mask below is evaluated once a frame
        base = (f"[0:a]atrim=end_sample={src_samples},"
                + (f"adelay=delays={head}S:all=1," if head else "")
                + f"apad,atrim=end_sample={p['samples']},asetnsamples=n=48:p=0")
        fades = f"afade=t=in:d={FADE},afade=t=out:st={max(0.0, dur - FADE):.6f}:d={FADE}"
        if tone:
            # each span ramps tone in/out over TONE_RAMP INSIDE itself (a hard switch
            # clicks); a span touching the piece edge needs no ramp there (the fade does it)
            spans = [(-1.0 if x <= 0.0005 else x, dur + 1.0 if y >= dur - 0.0005 else y) for x, y in tone]
            mask = "min(1," + "+".join(f"clip(min(t-{x:.4f},{y:.4f}-t)/{TONE_RAMP},0,1)" for x, y in spans) + ")"
            graph = (f"{base},volume='1-{mask}':eval=frame[s];"
                     f"[1:a]atrim=end_sample={p['samples']},asetnsamples=n=48:p=0,volume='{mask}':eval=frame[r];"
                     f"[s][r]amix=inputs=2:normalize=0:duration=first,{fades}[out]")
            lines.append(
                f"ffmpeg -v error -y -ss {t:.6f} -i /job/full48k.wav -stream_loop -1 -i /job/roomtone.wav "
                f"-filter_complex \"{graph}\" -map \"[out]\" -c:a pcm_s16le /tmp-dir/{k:05d}.wav")
        else:
            lines.append(
                f"ffmpeg -v error -y -ss {t:.6f} -i /job/full48k.wav "
                f"-filter_complex \"{base},{fades}[out]\" -map \"[out]\" -c:a pcm_s16le /tmp-dir/{k:05d}.wav")
        pieces.append(lines[start:])
        del lines[start:]
    n = len(video["pieces"])
    # x264 at 4K saturates ~8 cores per encode; the factory's 32 cores run 4 pieces at once.
    # On the 3-core box this is 1 — exactly the old serial order.
    # A 1080p preview from a 4K source is decode-bound (~4 cores each): twice as many at once.
    try:
        wide = int(str(size).split(":")[0]) > 1920
    except ValueError:
        wide = True
    par = max(1, config.cpu_count() // (8 if wide else 4))
    for k, cmds in enumerate(pieces):
        (tmp / f"p{k:05d}.sh").write_text("set -e\n" + "\n".join(cmds) + "\n")
    lines.append(f"ls /tmp-dir/p*.sh | sort | xargs -P {par} -n 1 sh" if pieces else "true")
    (tmp / "v.txt").write_text("".join(f"file '{k:05d}.{'ts' if direct else 'mkv'}'\n" for k in range(n)))
    (tmp / "a.txt").write_text("".join(f"file '{k:05d}.wav'\n" for k in range(n)))
    total = sum(p["frames"] for p in video["pieces"]) / fps
    lines += [
        # the cut is judged by ear: the picture is the video's first frame, held (Jake)
        (f"ffmpeg -v error -y -ss {video['pieces'][0]['src_frame'] / fps:.6f} -i /job/{source} -frames:v 1 "
         f"-vf scale={size}:flags=lanczos,setsar=1 /tmp-dir/still.png && "
         f"ffmpeg -v error -y -loop 1 -framerate 1 -i /tmp-dir/still.png -t {total:.6f} -c:v libx264 "
         f"-preset ultrafast -tune stillimage -pix_fmt yuv420p /tmp-dir/v.mkv") if audio_only else
        "true" if direct else
        "ffmpeg -v error -y -f concat -safe 0 -i /tmp-dir/v.txt -c copy /tmp-dir/v.mkv",
        "ffmpeg -v error -y -f concat -safe 0 -i /tmp-dir/a.txt -c copy /tmp-dir/a.wav",
        "I=$(ffmpeg -hide_banner -nostats -i /tmp-dir/a.wav -af ebur128 -f null - 2>&1 | grep -E '^ +I:' | tail -1 | awk '{print $2}')",
        "G=$(awk -v i=\"$I\" 'BEGIN{ if (i == \"\" || i < -70) print 0; else print -14 - i }')",
        # ⚠️ MPEG-TS pieces (90 kHz clock: a 30 or 30000/1001 fps frame is a whole number
        # of ticks). MKV's 1 ms clock rounded every piece and the concat demuxer summed the
        # error — 11 ms over 30 cuts in sync_test --direct; raw H.264 lost frames.
        (f"ffmpeg -v error -y -f concat -safe 0 -i /tmp-dir/v.txt "
         f"-i /tmp-dir/a.wav -map 0:v -map 1:a "
         if direct else f"ffmpeg -v error -y -i /tmp-dir/v.mkv -i /tmp-dir/a.wav -map 0:v -map 1:a ")
        + f"-af volume=${{G}}dB,alimiter=limit={LIMIT}:attack=5:release=50:latency=1:level=false "
        + ("-c:v copy " if direct else f"-c:v libx264 -preset {preset} -crf {crf} -pix_fmt yuv420p ")
        + f"-c:a aac -b:a 192k -movflags +faststart /job/{out_name}.part.mp4",
    ]
    (tmp / "run.sh").write_text("\n".join(lines) + "\n")
    # a named container, polled: a 22-minute render is one step, and Cancel has to be
    # able to stop it mid-way (the first version only checked between steps)
    name = f"aieditor-render-{uuid.uuid4().hex[:10]}"
    cmd = ["docker", "run", "--rm", "--name", name, "--cpuset-cpus", config.CPUSET, "--memory", config.MEMORY,
           "-v", f"{job}:/job", "-v", f"{tmp}:/tmp-dir", "--entrypoint", "sh",
           config.FFMPEG_IMAGE, "/tmp-dir/run.sh"]
    ev_log.emit("proc", f"render {out_name} — started ({n} piece(s), {size}, "
                f"{'sound only' if audio_only else ('direct ' if direct else '') + preset + ' crf ' + str(crf)}, {total:.0f}s of video)",
                proc=name, phase="start")
    t_start = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    while p.poll() is None:
        if cancelled():
            subprocess.run(["docker", "kill", name], capture_output=True)
            p.wait()
            shutil.rmtree(tmp, ignore_errors=True)
            ev_log.emit("proc", f"render {out_name} — cancelled after {time.time() - t_start:.0f}s", level="warn",
                        proc=name, phase="cancelled")
            raise RenderCancelled()
        if progress and not audio_only:
            # a piece file appears when its encode starts, so the count lags by one
            try:   # a progress hook that raises (job cancelled) must not orphan the container
                progress(max(0, len(list(tmp.glob("*.ts" if direct else "*.mkv"))) - par) / max(1, n))
            except Exception:                                 # noqa: BLE001
                pass   # the cancelled() check above kills it on the next pass
        time.sleep(2)
    err = p.stderr.read() if p.stderr else ""
    if p.returncode != 0:
        ev_log.emit("proc", f"render {out_name} — FAILED after {time.time() - t_start:.0f}s: {err[-600:]}", level="error",
                    proc=name, phase="failed")
        raise RuntimeError("render failed: " + err[-800:])
    ev_log.emit("proc", f"render {out_name} — done in {time.time() - t_start:.0f}s", proc=name, phase="done",
                secs=round(time.time() - t_start, 2))
    os.replace(job / f"{out_name}.part.mp4", job / f"{out_name}.mp4")
    shutil.rmtree(tmp, ignore_errors=True)
    return job / f"{out_name}.mp4"


def listen_size(width, height):
    """Small still for the sound check, in the source's orientation."""
    return "360:640" if height > width else "640:360"


def preview_size(width, height):
    """1080p preview in the source's orientation. (Not rendered for a long-form factory job: the 540p
    draft below replaces it — recommendation step 8, longedit.wants_preview.)"""
    return "1080:1920" if height > width else "1920:1080"


DRAFT_SHORT_SIDE = 540


def draft_size(width, height):
    """The factory's QA draft: 540 px on the short side (960:540 for a 16:9 source), even sizes. The rubric
    and the judges score this draft (recommendation §4 checkpoint 4); the 4K final follows only if it ships."""
    s = DRAFT_SHORT_SIDE
    if width >= height:
        return f"{round(s * width / height) // 2 * 2}:{s}"
    return f"{s}:{round(s * height / width) // 2 * 2}"
