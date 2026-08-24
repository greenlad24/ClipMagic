#!/usr/bin/env python3
"""Synthesized editing SFX (royalty-free, no licensed clips) — click / pop / whoosh.

Generates the individual sounds and, given a list of (time, type) cut events, renders a
full-length SFX track the compositor mixes under the voice (music stays OFF). Numpy only.

    .venv/bin/python scripts/sfx.py --track cuts.json --dur 30 --out sfx_track.wav
    .venv/bin/python scripts/sfx.py --demo          # write one of each to .media/tutorial/sfx/
"""

from __future__ import annotations

import argparse
import json
import os
import wave

import numpy as np

SR = 44100


def _env(n, attack=0.002, decay=0.05):
    a = int(SR * attack); d = int(SR * decay)
    e = np.ones(n)
    if a:
        e[:a] = np.linspace(0, 1, a)
    if d and d < n:
        e[-d:] = np.linspace(1, 0, d)
    return e


def click(gain=0.95):
    """A dry, snappy mouse click — sharp attack, ~18ms, mechanical."""
    n = int(SR * 0.018)
    t = np.arange(n) / SR
    env = np.exp(-t * 260)                              # fast decay
    x = np.random.uniform(-1, 1, n) * env               # broadband snap
    x += 0.6 * np.sin(2 * np.pi * 2600 * t) * np.exp(-t * 420)   # resonant tick
    n2 = int(SR * 0.006)                                # tiny leading mechanical transient
    x[:n2] += 0.5 * np.random.uniform(-1, 1, n2) * np.exp(-np.arange(n2) / SR * 600)
    return (x / np.max(np.abs(x))) * gain


def pop(gain=0.9):
    n = int(SR * 0.07)
    t = np.arange(n) / SR
    f = np.linspace(520, 300, n)
    x = np.sin(2 * np.pi * f * t) * _env(n, 0.001, 0.06)
    return (x / np.max(np.abs(x))) * gain


def whoosh(gain=0.8):
    n = int(SR * 0.22)
    x = np.random.uniform(-1, 1, n)
    # simple one-pole sweep (dull -> bright -> dull) via moving average window shrink
    env = np.hanning(n)
    # bandpass-ish by differencing (brightens) then envelope
    x = np.diff(x, prepend=0) * env
    return (x / np.max(np.abs(x))) * gain


_SOUNDS = {"click": click, "pop": pop, "whoosh": whoosh}


def build_track(events, dur, gain_db=-8.0):
    """events: [{"t": seconds, "type": "click|pop|whoosh"}]. Returns float mono array."""
    track = np.zeros(int(SR * dur) + SR)
    for e in events:
        s = _SOUNDS.get(e.get("type", "click"), click)()
        i = int(SR * float(e["t"]))
        j = min(i + len(s), len(track))
        track[i:j] += s[: j - i]
    track *= 10 ** (gain_db / 20.0)
    peak = np.max(np.abs(track)) or 1.0
    if peak > 1.0:
        track /= peak
    return track[: int(SR * dur)]


def _write_wav(path, x):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", help="JSON list of {t,type} cut events")
    ap.add_argument("--dur", type=float, default=30.0)
    ap.add_argument("--gain-db", type=float, default=-8.0)
    ap.add_argument("--out", default=".media/tutorial/sfx/sfx_track.wav")
    ap.add_argument("--demo", action="store_true")
    args = ap.parse_args()

    if args.demo:
        for name, fn in _SOUNDS.items():
            _write_wav(f".media/tutorial/sfx/{name}.wav", fn())
        print("wrote click.wav pop.wav whoosh.wav -> .media/tutorial/sfx/")
        return
    events = json.load(open(args.track)) if args.track else []
    _write_wav(args.out, build_track(events, args.dur, args.gain_db))
    print(f"  -> {args.out}  ({len(events)} hits over {args.dur:.1f}s)")


if __name__ == "__main__":
    main()
