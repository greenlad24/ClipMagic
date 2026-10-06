"""Motion recipes: the reference video's animations as engine layers.

Every number here was MEASURED frame by frame off the reference (gVPZU1btFA8, 24 fps;
specs copied to motion/reference-specs/) and checked by a replica test that renders
the recipe over the reference's own frames and compares them pixel by pixel. Jake
2026-10-04: "all of the animations should match exactly the reference in keyframes".

A recipe returns `tracks` (+ motion blur) for one layer of motion/engine.js, keyed on k =
the FIRST VISIBLE frame of the element (what you see on the video), in that scene's
frame numbers. Text should appear 140–300 ms BEFORE its spoken word (keyword-text spec).
"""

import json
from pathlib import Path

# MOTION: the measured keyframes, design-free (motion/keyframes.json, built from the
# reference specs + replica-verified overrides). Jake 2026-10-05: "save mostly the
# animation keyframes - we might change the design later" — so nothing below the STYLE
# block hard-codes a colour or font, and STYLE can be swapped without touching motion.
KF = json.loads((Path(__file__).resolve().parent.parent / "motion" / "keyframes.json").read_text())
V = KF["verified"]

# STYLE: the first look = the reference's pink/black. A redesign replaces this block only.
STYLE = {
    "font": "Space Grotesk",            # every word in the reference's graphics
    "white": "#FFFFFF",
    # pink = horizontal base (magenta ends, hot-red core) + soft highlight blobs drifting
    # across the word (read off the reference's "= $250" hold f8830–8919). Colours measured;
    # blob paths fitted by eye — the look and pace, not exact per-frame colours.
    "pink_base": [[0, "#FE1A86"], [0.32, "#FD0A3D"], [0.58, "#FD0A3D"], [1, "#FE1A86"]],
    "pink_blobs": {"yellow": "#FDDF71", "pale": "#FECADE", "light": "#FD55B6"},
}
FONT, WHITE = STYLE["font"], STYLE["white"]
PINK_BASE = STYLE["pink_base"]
YELLOW, PALE, LIGHT = (STYLE["pink_blobs"][k] for k in ("yellow", "pale", "light"))


def pink(seed=0):
    """Generic pink fill: each blob wanders slowly and fades in and out on its own
    (periods 3–6 s like the reference; `seed` de-syncs neighbouring words)."""
    def w(px, py, pa, a0, a1, ph):
        return {"ax": 0.55, "ay": 0.35, "px": px, "py": py, "pa": pa, "a0": a0, "a1": a1,
                "phx": ph + seed * 1.7, "phy": ph * 2 + seed, "pha": ph * 3 + seed * 2.3}
    return {"mesh": {"base": PINK_BASE, "blobs": [
        {"colour": YELLOW, "radius": 0.9, "wander": w(131, 97, 113, -0.15, 1.0, 0.0)},
        {"colour": PALE, "radius": 0.9, "wander": w(157, 89, 101, -0.10, 1.0, 2.1)},
        {"colour": LIGHT, "radius": 1.1, "wander": w(173, 109, 127, -0.30, 1.0, 4.2)},
    ]}}


def _tween(start, dur, a, b, ease):
    return {"tween": [{"start": start, "dur": dur, "from": a, "to": b, "ease": list(ease)}]}


def keyword_rise(k):
    """Keyword text (SAVE THE / BUDGET…): fade + rise in em, 360° motion blur. Line 2 = k+2.
    Replica A: ≤0.016 opacity / ≤0.7 px on every frame."""
    m = V["keyword_rise"]
    o, y = m["opacity"], m["translateY_em"]
    return {
        "tracks": {
            "opacity": _tween(k + o["start"], o["dur"], 0, 1, o["ease"]),
            "ty": {"unit": "em", **_tween(k + y["start"], y["dur"], y["from"], y["to"], y["ease"])},
        },
        "motionBlur": {"shutter": 360},
    }


def dropin(k, pink=False, res=1.0):
    """R1 floating drop-in (numbers/labels beside the presenter). From k−2: fade over 9 f,
    drop 15.4 px, blur σ 4→0 over 6 f. The travel is FIXED, not per font size (the 98 px
    "= $250" drops the same 15.4 px as the 59 px lines); `res` = output height / 1080.
    White lines: replica ≤0.05 opacity / ≤0.4 px on every frame. pink=True: a gradient
    line's FADE starts 1 f earlier than its drop (measured on 5 of 5 pink lines)."""
    m = V["dropin"]
    o, y, b = m["opacity"], m["translateY_px"], m["blur_sigma_px"]
    lead = m["gradient_line_fade_lead_f"] if pink else 0
    sc = res
    return {
        "tracks": {
            "opacity": _tween(k + o["start"] - lead, o["dur"], 0, 1, o["ease"]),
            "ty": _tween(k + y["start"], y["dur"], y["from"] * sc, y["to"], y["ease"]),
            "blurX": _tween(k + b["start"], b["dur"], b["from"] * sc, b["to"], b["ease"]),
            "blurY": _tween(k + b["start"], b["dur"], b["from"] * sc, b["to"], b["ease"]),
        },
    }


def fade_out(tracks, cut, table=tuple(V["dropin"]["exit_fade_3f"])):
    """The 3-frame exit fade of R1 stacks (E: starts ON the cut frame `cut`, plays over the
    new shot). Appends to an existing opacity tween as a per-frame table."""
    op = tracks["tracks"]["opacity"]["tween"]
    for i, (a, b) in enumerate(zip(table, table[1:])):
        op.append({"start": cut - 1 + i, "dur": 1, "from": a, "to": b})
    return tracks


def count(start, dur, a, b, **fmt):
    """Count-up: easeInOutCubic, Math.round, en-US grouping (REACH 1,200→48,000 over 33 f
    reproduced EXACTLY on all 33 frames). fmt: prefix, suffix, pad, decimals."""
    return {"from": a, "to": b, "start": start, "dur": dur, "ease": V["count_up"]["ease"], **fmt}


# ---- CTA pill ("LINK IN THE DESCRIPTION"): sparkle pair → glass tile → stretch → text ----
STYLE["cta_pill"] = {
    "glass_fill": "rgba(207,186,182,0.40)", "glass_blur": 14,          # spec: ±15 / 12–16 px
    "rim": {"colour": "rgba(255,46,79,0.55)", "width": 1.5, "glow": 6},
    "beams": {"colour": "#FF2E4F", "length": 300, "speed": 7, "width": 3, "glow": 4},
    "radius_of_height": 0.235,                                          # r28 at 119 px, r16 at the tile
    "sparkle": "#FFFFFF", "sparkle_glow": 6,
    "font": {"family": "Inter", "weight": 600, "size": 33, "tracking": 0.044},
    "text_colour": "#FFFFFF",
}


def _sparkle_angles(per_offset, k, shift):
    """The pair's turn, read from its MEASURED box shape each frame: the pair is 1.6:1
    flat (0°) and 1:1.6 upright (90°), so its width:height ratio gives |angle| (the glow,
    ~6 % of the long side, is taken off first). Negative = big star turning upward."""
    import math
    out = {}
    for off, (x0, y0, x1, y1) in per_offset.items():
        off = int(off)
        if off < 2:                       # too small to read
            continue
        w, h = x1 - x0, y1 - y0
        g = 0.06 * max(w, h)
        r = max(0.625, min(1.6, (w - 2 * g) / max(1, h - 2 * g)))
        best = min(range(0, 91), key=lambda a: abs((1.6 * math.cos(math.radians(a)) + math.sin(math.radians(a)))
                                                  / (math.cos(math.radians(a)) + 1.6 * math.sin(math.radians(a))) - r))
        out[k + off + (shift if off >= 12 else 0)] = -best
    return out


def cta_pill(k, final_box, text="LINK IN THE DESCRIPTION", morph_start=12, text_start=40, res=1.0):
    """The measured CTA-pill entrance mapped onto `final_box` [x0,y0,x1,y1] (any size).
    k = first visible frame (the sparkle). Vertical travel and the tile scale with the pill's
    HEIGHT; the stretch fills whatever width the new pill has. morph_start shifts the stretch
    (reference: 12 at 0:32, 10 at 3:58, 15 at 9:58); text_start: 40 (0:32) / 38 (9:58)."""
    m = KF["measured"]["cta_pill_link"]
    RX0, RY0, RX1, RY1 = m["final_box_px"]
    rcx, rcy, rw, rh = (RX0 + RX1) / 2, (RY0 + RY1) / 2, RX1 - RX0, RY1 - RY0
    X0, Y0, X1, Y1 = final_box
    cx, cy, W, H = (X0 + X1) / 2, (Y0 + Y1) / 2, X1 - X0, Y1 - Y0
    sH, T = H / rh, 36.0                    # T = the tile's half-width at the reference
    shift = morph_start - 12                # stretch keys (+12 on) move with morph_start

    def hx(hw):
        return hw * sH if hw <= T else T * sH + (hw - T) * (W / 2 - T * sH) / (rw / 2 - T)

    box = {}
    for off, (x0, y0, x1, y1) in sorted(m["box_px_per_offset"].items(), key=lambda kv: int(kv[0])):
        off = int(off)
        if x0 is None:
            x0 = 2 * rcx - x1               # the pill is centred: mirror the right edge
        o = off + (shift if off >= 12 else 0)
        hw = hx((x1 - x0) / 2)
        # the tile starts off-centre (over the laptop logo, x≈925) and slides to the
        # centre during the stretch: keep that offset, scaled with the pill height
        dc = ((x0 + x1) / 2 - rcx) * sH
        box[k + o] = [cx + dc - hw, cy + (y0 - rcy) * sH, cx + dc + hw, cy + (y1 - rcy) * sH]
    first = min(box)
    S = STYLE["cta_pill"]
    pill = {"id": "cta_box", "kind": "box", "box": box, "radius": {"ofHeight": S["radius_of_height"]},
            "fill": S["glass_fill"], "glass": {"blur": S["glass_blur"]}, "rim": S["rim"], "beams": S["beams"],
            "tracks": {"opacity": {"table": {first - 1: 0, first: 1}}}}
    # sparkle: tracked bbox, relative to the final icon, which sits at the pill's left end
    sp = m["sparkle_pair_px"]
    ix0, iy0, ix1, iy1 = sp["final_icon_px"]
    icx, icy = (ix0 + ix1) / 2, (iy0 + iy1) / 2
    ncx, ncy = X0 + (icx - RX0) * sH, cy + (icy - rcy) * sH
    sbox = {}
    for off, (x0, y0, x1, y1) in sorted(sp["per_offset"].items(), key=lambda kv: int(kv[0])):
        off = int(off)
        o = off + (shift if off >= 12 else 0)
        sbox[k + o] = [ncx + (x0 - icx) * sH, ncy + (y0 - icy) * sH, ncx + (x1 - icx) * sH, ncy + (y1 - icy) * sH]
    sparkle = {"id": "cta_sparkle", "kind": "sparkle", "box": sbox, "colour": S["sparkle"], "glow": S["sparkle_glow"] * sH,
               "tracks": {"angle": {"table": _sparkle_angles(sp["per_offset"], k, shift)},
                          "opacity": {"table": {k - 1: 0, k: 1}}}}
    # text: measured opacity / rise / blur tables, left edge at the reference's inset
    t = m["text"]
    ks = k + text_start
    tx0 = X0 + (t["final_ink_px"][0] - RX0) * sH
    ty0 = cy + (t["final_ink_px"][1] - rcy) * sH
    f = dict(S["font"], size=S["font"]["size"] * sH)
    label = {"id": "cta_text", "text": text, "font": f, "fill": S["text_colour"], "place": {"x": tx0, "y": ty0},
             "tracks": {"opacity": {"table": {ks - 1: 0, **{ks + a: v for a, v in t["opacity"]}}},
                        "ty": {"table": {ks + a: v * sH * res for a, v in t["translateY_px"]}},
                        "blurX": {"table": {ks + a: v * sH * res / 2 for a, v in t["blur_px"]}},
                        "blurY": {"table": {ks + a: v * sH * res / 2 for a, v in t["blur_px"]}}}}
    return [pill, sparkle, label]


# ---- floating cards: portal swing-open (7:44) and pink-reveal rise (3:29) ----
STYLE["card"] = {"tint": "#FF2E9A", "radius": 18}


def _card_box(table, k, final_box, near=None, near_cx=None):
    X0, Y0, X1, Y1 = final_box
    W, H = X1 - X0, Y1 - Y0
    box = {}
    for off, v in table.items():
        dx = v["cx"]
        if near_cx is not None and off in near_cx:   # perspective: edge-on centre leans to the near edge
            dx = (1 if near == "right" else -1) * near_cx[off]
        cx = (X0 + X1) / 2 + dx * W
        hw = v["width"] * W / 2
        box[k + int(off)] = [cx - hw, Y0 + v["top"] * H, cx + hw, Y1 + v["bottom"] * H]
    return box


def card_portal(k, final_box, image=None, pink=True, near="right", id="card"):
    """7:44 portal card. k = first clearly visible frame (opacity .7; k−1 a faint sliver).
    Edge-on slab widening 4 f, a 6 f swing open with ~1 % overshoot, the top settling back
    by +15; pink (~0.72 max) clears with the swing — pink=False = the 8:37 variant.
    near = the card's nearer edge in its pose (the slab leans that way). Next card +3 f
    (+2 f without pink). Replica (both cards, one table): width/top ≤2 px every frame."""
    m = KF["measured"]["card_portal_open"]
    box = _card_box(m["average"], k, final_box, near, m["near_side_cx"])
    box[k - 1] = box[k]
    L = {"id": id, "kind": "box", "box": box, "radius": STYLE["card"]["radius"], "fill": "#FFFFFF",
         "tracks": {"opacity": {"table": {k - 2: 0, **{k + int(o): v for o, v in m["opacity"].items()}}}}}
    if image:
        L["image"] = image
    if pink:
        L["tint"] = {"colour": STYLE["card"]["tint"], "track": {"table": {k - 1: m["tint"]["0"], **{k + int(o): v for o, v in m["tint"].items()}}}}
    return L


def card_pink_rise(k, final_box, image=None, id="card"):
    """3:29 callout card. k = first clearly visible frame. Fades in over 5 f at full pink,
    rises ~50 px while growing ~2 %, the pink clears over 12 f."""
    m = KF["measured"]["card_pink_reveal_rise"]
    box = _card_box(m["frames"], k, final_box)
    box[k - 1] = box[k]
    L = {"id": id, "kind": "box", "box": box, "radius": STYLE["card"]["radius"], "fill": "#FFFFFF",
         "tracks": {"opacity": {"table": {k - 2: 0, **{k + int(o): v for o, v in m["opacity"].items()}}}},
         "tint": {"colour": STYLE["card"]["tint"], "track": {"table": {k - 1: 1.0, **{k + int(o): v for o, v in m["tint"].items()}}}}}
    if image:
        L["image"] = image
    return L


# ---- titles & lists (titles-lists spec; offsets from each word's FIRST VISIBLE frame) ----
def _box_sigma(r):
    """the spec measured blur as a box radius r; the engine blurs with a Gaussian σ of the same variance"""
    return ((2 * r + 1) ** 2 - 1) ** 0.5 / 12 ** 0.5


def word_rise(k, res=1.0, pink=False, lead=1.5):
    """One word of a title/list line: fade over 12 f, rise 30 px (fixed, any font size),
    box-blur r 4→0 by +8. Words 1.5–2 f apart; line 2 starts 3 f after line 1's first word.
    Replica (chapter card 'AD FORMAT #1 / CALLOUT DIAGRAM'): see keyframes 'verified'."""
    r = KF["text"]["titles_lists"]["keyframes"]["word_rise_reveal"]["keyframes_rel_first_visible_frame"]
    op, ty = r["opacity"], r["translateY_px"]
    blur = {k + b["f"]: _box_sigma(b["v"]) * res for b in r["blur_box_r"]}
    return {"tracks": {
        "opacity": _tween(k + op[0]["f"] - (lead if pink else 0), op[1]["f"] - op[0]["f"], op[0]["v"], op[1]["v"], (0.248, 0.115, 0.48, 1.0)),
        "ty": _tween(k + ty[0]["f"], ty[1]["f"] - ty[0]["f"], ty[0]["v"] * res, ty[1]["v"], (0.383, 0.261, 0.219, 0.701)),
        "blurX": {"table": blur}, "blurY": {"table": blur}}}


def underline_rise(k, res=1.0):
    """Chapter-card underline: full width from its first frame (no wipe); fade 5.2 f, rise
    30 px with an 8 % overshoot (backOut) over 22.9 f."""
    return {"tracks": {"opacity": _tween(k, 5.2, 0, 1, (0.349, 0.313, 0.15, 0.779)),
                       "ty": _tween(k, 22.9, 30 * res, 0, (0.332, 0.0, 0.182, 1.425))}}


def chapter_exit(tracks, k):
    """Everything together: rise 30 px accelerating over 17.3 f, fade from +2.75 to +9."""
    t = tracks["tracks"]
    t["opacity"]["tween"].append({"start": k + 2.75, "dur": 6.25, "from": 1, "to": 0, "ease": [0.441, 0.686, 0.346, 0.845]})
    t["ty"]["tween"].append({"start": k, "dur": 17.3, "from": 0, "to": -30, "ease": [0.356, 0.169, 0.16, 0.408]})
    return tracks


def _table_track(k, values):
    return {"table": {k + i: v for i, v in enumerate(values)}}


def acronym_snap(k):
    """P/R/O/O/F rows: 3 f per row, rows 1 f apart."""
    return {"tracks": {"opacity": _table_track(k, [0.0, 0.29, 0.83, 1.0]),
                       "ty": _table_track(k, [12, 6, 0, 0]),
                       "blurX": _table_track(k, [_box_sigma(r) for r in (6, 1, 1, 0)]),
                       "blurY": _table_track(k, [_box_sigma(r) for r in (6, 1, 1, 0)])}}


def drop_in_word(k):
    """EXCLUSIVITY / SPEED / RESULTS: comes DOWN 16 px, one word per spoken cue."""
    d = KF["text"]["titles_lists"]["keyframes"]["drop_in_word"]
    b = [_box_sigma(r) for r in d["blur_r"]]
    return {"tracks": {"opacity": _table_track(k, d["opacity"]), "ty": _table_track(k, d["dy"]),
                       "blurX": _table_track(k, b), "blurY": _table_track(k, b)}}


TYPEWRITER_FRAMES_PER_CHAR = 1.6     # attention_x_list: ~15 chars/s


# ---- prompt bar (ChatGPT-style composer): P5 9:13 over the presenter, P2 1:35 pre-filled ----
STYLE["prompt_bar"] = {"fill": "#202020", "radius": 40, "shadow": "0 4px 16px rgba(0,0,0,0.12)",
                       "button": "#2D66C2", "button_d": 52, "font": {"family": "Inter", "weight": 400, "size": 27, "tracking": 0},
                       "pitch": 41, "pad_x": 30, "text_top": 38, "text": "#FFFFFF"}


def prompt_bar(k, box, text, mode="overlay", cpf=None, res=1.0, id="bar"):
    """k = first visible frame of the bar. mode 'overlay' (P5): pure 4 f fade, then typing at
    1.706 chars/f from k+0.87 (linear, no caret, glyphs fade ~1.5 f; P5 fit rms 0.8 chars);
    'showcase' (P1/P3): types the WHOLE prompt in 28 f. 'prefilled' (P2): rise 20 px +
    scale .97→1 + blur-in over 9 f, no typing. When a line wraps the bar grows one line over
    6 f (bottom +12 px, top −(pitch−12)). Returns layers [box, text, button] + `end` (typing end)."""
    S = STYLE["prompt_bar"]
    X0, Y0, X1, Y1 = box
    lines = text.split("\n")
    pitch = S["pitch"] * res
    n_chars = len(text)
    if mode == "showcase":
        cpf = n_chars / 28.0
    cpf = cpf or 1.706
    t0 = k + 0.87
    # box height: grows when each further line starts
    one = (Y1 - Y0) - (len(lines) - 1) * pitch       # final box minus the extra lines
    boxtab, starts, i = {}, [], 0
    for li, l in enumerate(lines):
        starts.append(t0 + i / cpf)
        i += len(l) + 1
    def box_at(nl):
        grow = (nl - 1) * pitch
        return [X0, Y1 - one - grow + (len(lines) - nl) * 0 - 0, X1, Y1]
    # bottom fixed at its 1-line position + 12 px per added line, top moves the rest
    base_bottom = Y1 - (len(lines) - 1) * 12 * res
    boxtab[k - 1] = [X0, base_bottom - one, X1, base_bottom]
    for nl in range(2, len(lines) + 1):
        s = starts[nl - 1]
        prev = boxtab[max(boxtab)]
        bottom = base_bottom + (nl - 1) * 12 * res
        boxtab[s - 0.01] = prev
        boxtab[s + 6] = [X0, bottom - one - (nl - 1) * pitch, X1, bottom]
    if mode == "prefilled":
        boxtab = {k: [X0, Y0, X1, Y1]}
    # entrance tracks
    if mode == "prefilled":
        ent = {"opacity": {"table": {k - 1: 0, k: 0.09, k + 1: 0.34, k + 2: 0.66, k + 3: 0.80, k + 4: 0.95, k + 5: 0.97, k + 6: 1}},
               "ty": {"table": {k: 20 * res, k + 1: 18 * res, k + 2: 16 * res, k + 3: 12 * res, k + 4: 10 * res, k + 5: 6 * res,
                                k + 6: 4 * res, k + 7: 2 * res, k + 9: 0}},
               "blur": {"table": {k: 8 * res, k + 1: 6 * res, k + 2: 2.5 * res, k + 3: 1 * res, k + 4: 0}}}
        scale = {"table": {k + 1: 0.97, k + 2: 0.98, k + 4: 0.99, k + 6: 1.0}}
    else:
        ent = {"opacity": {"table": {k - 1: 0, k: 0.27, k + 1: 0.49, k + 2: 0.75, k + 3: 1.0}}}
        scale = 1
    bar = {"id": id, "kind": "box", "box": boxtab, "radius": S["radius"] * res, "fill": S["fill"], "shadow": S["shadow"],
           "tracks": {**ent, "scale": scale}}
    f = dict(S["font"], size=S["font"]["size"] * res)
    tx, tyy = X0 + S["pad_x"] * res, None
    txt = {"id": id + "_text", "text": text, "font": f, "fill": S["text"],
           "typing": {"start": t0 if mode != "prefilled" else k - 100, "cpf": cpf if mode != "prefilled" else 1e9,
                      "fade": 1.5, "pitch": pitch},
           # text is anchored to the bar's top edge, which moves when a line is added
           "place": {"x": tx, "y": boxtab[min(boxtab)][1] + S["text_top"] * res - f["size"] * 0.95},
           "tracks": {k2: v for k2, v in ent.items() if k2 in ("opacity", "ty")}}
    if len(boxtab) > 1:
        tops = {fr: b[1] - boxtab[min(boxtab)][1] for fr, b in boxtab.items()}
        txt["tracks"]["ty"] = {"table": tops}
    d = S["button_d"] * res
    def btn_at(b):
        return [b[2] - 14 * res - d, b[3] - 14 * res - d, b[2] - 14 * res, b[3] - 14 * res]
    button = {"id": id + "_send", "kind": "box", "box": {fr: btn_at(b) for fr, b in boxtab.items()}, "radius": d / 2,
              "fill": S["button"], "tracks": {**{k2: v for k2, v in ent.items() if k2 == "opacity"}}}
    end = t0 + (n_chars - 1) / cpf + 1.5
    return [bar, txt, button], end


def button_press(layer, k):
    """P2 click: the send button shrinks 42→38→37 px (×0.905, ×0.88) over 2 f and holds."""
    layer["tracks"]["scale"] = {"table": {k - 1: 1.0, k: 0.905, k + 1: 0.88}}
    return layer


def bar_exit(layers, k, mode="overlay"):
    """overlay (P5): fade 1 → 0 starting k (cut-off by the camera cut); prefilled (P2):
    fade + rise 18 px over 6 f (opacity .92 .53 .33 .20 .09 .03)."""
    for L in layers:
        op = L["tracks"].setdefault("opacity", {"table": {}})
        tab = op.setdefault("table", {})
        if mode == "overlay":
            tab.update({k - 1: 1.0, k: 0.93, k + 1: 0.72, k + 2: 0.48, k + 3: 0.30, k + 4: 0.12, k + 5: 0.0})
        else:
            tab.update({k - 1: 1.0, k: 0.92, k + 1: 0.53, k + 2: 0.33, k + 3: 0.20, k + 4: 0.09, k + 5: 0.03, k + 6: 0})
    return layers
