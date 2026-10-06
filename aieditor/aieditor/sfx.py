"""Sound effects for the graphics — timing MEASURED on the reference, sounds CC0.

Reference (prompt-camera-sfx spec, C_sfx_mix): of 20 graphic/UI events, 9 carry a short
non-voice pop/click whose transient peaks ≈ +60 ms (+2 f) after the element's first
visible frame (30–90 ms envelopes); the two longer whoosh-like ones LEAD the visual by
4–8 f. Music bed ≈ 15 dB under the voice, no ducking.

Sounds: Kenney "Interface Sounds" (CC0 1.0, /opt/aieditor-work/sfx/kenney_interface —
License.txt kept). Jake 2026-10-04: "I source a free CC0 pack, he approves by ear" —
ROLES are my picks until he does (audition reel: aieditor-sfx-audition-v1.mp4).
"""
from pathlib import Path

LIB = Path("/opt/aieditor-work/sfx/kenney_interface/Audio")
POP_AFTER_S = 0.06            # transient +60 ms after the first visible frame
WHOOSH_LEAD_S = 0.25          # ~6 f before
GAIN_DB = -9.0                # samples peak ≈ −1 dBFS → pops peak ≈ −10, ~5 dB under the voice peaks
                              # (−14 was inaudible under speech: RMS around a cue moved 0.03 dB)

ROLES = {
    # the reference's pops are bright HF transients (HF−mid +6…+12 dB): picked by energy
    # above 4 kHz — pluck_001 −4.9 dB vs drop_001 −20 dB (a dull drop, masked by speech)
    "pop": "pluck_001.ogg",         # text / number / title / list entrance
    "whoosh": "maximize_003.ogg",   # card swing, CTA stretch
    "sparkle": "glass_005.ogg",     # CTA sparkle (glass_002/003 have almost no HF)
    "click": "tick_004.ogg",        # button press
}
CANDIDATES = {
    "pop": ["pluck_001.ogg", "toggle_004.ogg", "tick_004.ogg", "drop_001.ogg"],
    "whoosh": ["maximize_003.ogg", "open_001.ogg", "maximize_001.ogg"],
    "sparkle": ["glass_005.ogg", "glass_006.ogg", "glass_002.ogg"],
    "click": ["tick_004.ogg", "click_001.ogg", "select_001.ogg"],
}


def cues(ev):
    """(seconds on the output timeline, role) for one planned graphic (graphics.validate)."""
    if "sfx" in ev:                 # explicit cues (long-form: the subscribe clicks only —
        return ev["sfx"]            # reference 2 has no SFX on its titles)
    t0, t = ev["t0"], ev["template"]
    if t in ("keyword", "title", "number", "list", "prompt"):
        return [(t0 + POP_AFTER_S, "pop")]
    if t == "cta":
        # sparkle pops in at k, the tile stretches at +12 f, the text lands at +40 f
        return [(t0 + POP_AFTER_S, "sparkle"), (t0 + 12 / 24 - WHOOSH_LEAD_S / 2, "whoosh"), (t0 + 40 / 24 + POP_AFTER_S, "pop")]
    return []


def filter_for(events, first_input):
    """ffmpeg inputs + an amix graph adding every cue to [0:a] → [aout]."""
    ins, parts, labels = [], [], []
    n = first_input
    for ev in events:
        for t, role in cues(ev):
            ins.append(f"-i /sfx/{ROLES[role]}")
            ms = max(0, int(round(t * 1000)))
            parts.append(f"[{n}:a]aresample=48000,volume={GAIN_DB}dB,adelay={ms}|{ms}[s{n}]")
            labels.append(f"[s{n}]")
            n += 1
    if not labels:
        return ins, "[0:a]anull[aout]"
    graph = ";".join(parts) + f";[0:a]{''.join(labels)}amix=inputs={len(labels) + 1}:normalize=0:duration=first[aout]"
    return ins, graph
