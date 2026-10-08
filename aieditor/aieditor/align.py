"""Run the forced aligner (aligner/align.py in the aieditor-aligner image).

Whisper's word times drift 0.1-0.4 s (a word gets stretched over the silence before
it), so cutting a single "so" left it audible in the first previews. wav2vec2
(torchaudio MMS_FA) re-times every word against the audio; ~0.4x realtime on 3 cores.
"""
import subprocess
from pathlib import Path

from . import config, events as ev_log


def align(job, progress=lambda done, total: None):
    job = Path(job).resolve()
    threads = str(len(config.CPUSET.split(",")))
    cmd = ["docker", "run", "--rm", "--cpuset-cpus", config.CPUSET, "--memory", config.MEMORY,
           "-e", f"THREADS={threads}", "-e", "TORCH_HOME=/models",
           "-v", f"{config.MODELS}:/models", "-v", f"{config.CODE / 'aligner'}:/code:ro",
           "-v", f"{job}:/job", config.ALIGNER_IMAGE,
           "python", "/code/align.py", "/job/audio16k.wav", "/job/words.json", "/job/aligned.json"]
    with ev_log.proc("forced aligner (wav2vec2)", f"{threads} threads"):
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        tail = []
        for line in p.stdout:
            line = line.strip()
            if line.startswith("progress "):
                done, total = line.split()[1].split("/")
                progress(int(done), int(total))
            elif line and "%" not in line:
                tail = (tail + [line])[-15:]
                ev_log.emit("log", f"aligner: {line[:300]}", level=ev_log.level_of(line))
        if p.wait() != 0 or not (job / "aligned.json").exists():
            raise RuntimeError("forced alignment failed: " + " | ".join(tail[-5:]))
    return tail[-1] if tail else ""
