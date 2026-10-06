"""9:16 short-form templates: layout only — every animation comes from recipes.py, i.e.
from the reference's measured keyframes (Jake 2026-10-05: "save mostly the animation
keyframes - we might change the design later" — a redesign edits this file + STYLE).

Design space is 1080×1920 (render at scale 2 → 2160×3840). Jake's face fills the upper
middle of a vertical frame, so there is no empty wall like the 16:9 reference: graphics
live on the dark SHIRT zone (y ≈ 760–1300) and captions in the bottom band (y ≈ 1536,
captions.mjs keepClear). k = the element's first visible frame, in REFERENCE frames
(24 fps); the renderer resamples to the output fps.
"""
from . import recipes as R

W, H = 1080, 1920
ZONE_TOP, ZONE_BOTTOM = 760, 1300          # the shirt zone
CX = W / 2
SHADOW = {"x": -4, "y": 6, "sigma": 16, "alpha": 0.65}   # keyword spec: soft dark shadow
MAXW = W * 0.88                            # a line wider than this shrinks to fit


def _text(id, text, size, x, y, fill, align="centre", tracking=-0.017, shadow=True, **motion):
    L = {"id": id, "text": text, "font": {"family": R.FONT, "weight": 700, "size": size, "tracking": tracking},
         "fill": fill, "place": {"x": x, "y": y, "align": align, "maxWidth": MAXW}, **motion}
    if shadow:
        L["shadow"] = SHADOW
    return L


def keyword(k, line1, line2, size=118, y=880):
    """t1 — two-line keyword: white line + pink keyword, rise recipe, line 2 +2 f."""
    return [_text("kw1", line1.upper(), size, CX, y, R.WHITE, **R.keyword_rise(k)),
            _text("kw2", line2.upper(), size, CX, y + size * 1.10, R.pink(0), **R.keyword_rise(k + 2))]


def number(k, label, value, count_from=None, label_k=None, size=168, y=860, prefix="", suffix=""):
    """t2 — floating number: white label + pink value (drop-in; pink fades 1 f early),
    optional count-up (easeInOutCubic, the REACH recipe, 33 f)."""
    lk = k if label_k is None else label_k
    L = [_text("n_label", label.upper(), 64, CX, y, R.WHITE, **R.dropin(lk))]
    v = _text("n_value", f"{prefix}{value:,}{suffix}" if isinstance(value, (int, float)) else str(value),
              size, CX, y + 64 * 0.9 + 34, R.pink(1), **R.dropin(k + (0 if label_k is None else 0), pink=True))
    if count_from is not None and isinstance(value, (int, float)):
        v["count"] = R.count(k, 33, count_from, value, prefix=prefix, suffix=suffix)
    return L + [v]


def card(k, image, kind="portal", width=560, height=None, y=780, near="right"):
    """t3 — floating card (a screenshot/product shot): 'portal' swing-open (7:44) or
    'rise' pink-reveal (3:29). Static once settled (the reference has 0 px idle drift)."""
    height = height or round(width * 1.4)
    box = [CX - width / 2, y, CX + width / 2, y + height]
    if kind == "rise":
        return [R.card_pink_rise(k, box, image=image)]
    return [R.card_portal(k, box, image=image, near=near)]


def title(k, line1, line2, y=900, s1=72, s2=118):
    """t4 — chapter/hook title: words rise one by one (+1.5 f), line 2 +3 f, pink line
    leads its fade 1.5 f, underline +2.5 f with an 8 % overshoot."""
    out, kk = [], k
    def line(words, size, yy, fill_pink, k0):
        # words flow side by side by their measured widths (engine place.group), centred
        return [_text(f"t{yy}_{i}", w, size, CX, yy, R.pink(i) if fill_pink else R.WHITE, align="centre", tracking=0,
                      shadow=False, **R.word_rise(k0 + 1.5 * i, pink=fill_pink)) | {"place": {"x": CX, "y": yy, "align": "centre",
                      "group": f"line{yy}", "gap": 0.28, "maxWidth": MAXW}} for i, w in enumerate(words)]
    out += line(line1.upper().split(), s1, y, False, kk)
    out += line(line2.upper().split(), s2, y + s1 + 46, True, kk + 3)
    uy = y + s1 + 46 + s2 + 40
    out.append({"id": "underline", "kind": "box", "box": {0: [CX - 420, uy, CX + 420, uy + 7]}, "radius": 2,
                "fill": "linear-gradient(90deg,#FE1A86,#FD0A3D 50%,#FE1A86)", **R.underline_rise(kk + 2.5)})
    return out


def numbered_list(k, items, y=800, size=74, gap=110, step=24):
    """t5 — numbered list: each row = pink number + white text, word-rise per word; rows
    `step` frames apart (speech-paced in production: pass each row's own k)."""
    out = []
    ks = k if isinstance(k, (list, tuple)) else [k + i * step for i in range(len(items))]
    for i, (item, kr) in enumerate(zip(items, ks)):
        yy = y + i * gap
        out.append(_text(f"l{i}_n", f"{i + 1:02d}", size, 150, yy, R.pink(i), align="left", tracking=0, shadow=True,
                         **R.word_rise(kr, pink=True)))
        for j, w in enumerate(item.upper().split()):
            out.append(_text(f"l{i}_{j}", w, size, 300, yy, R.WHITE, align="left", tracking=0, shadow=True,
                             **R.word_rise(kr + 1.5 * (j + 1))) | {"place": {"x": 300, "y": yy, "align": "left",
                             "group": f"row{i}", "gap": 0.28, "maxWidth": W - 300 - 60}})
    return out


def cta(k, text="LINK IN THE DESCRIPTION", y=1170, width=820, height=150):
    """t6 — CTA pill: the measured sparkle → glass tile → stretch → text recipe."""
    return R.cta_pill(k, [CX - width / 2, y, CX + width / 2, y + height], text=text)


def prompt(k, text, y=900, width=980, height=None, mode="overlay"):
    """t8 — prompt bar typing over the presenter (P5): fade 4 f, linear typing."""
    lines = text.count("\n") + 1
    height = height or 120 + 41 * (lines - 1)
    # the measured bar is laid out for a 16:9 frame; a vertical short reads it at 1.5×
    height = height * 1.5
    layers, end = R.prompt_bar(k, [CX - width / 2, y, CX + width / 2, y + height], text, mode=mode, res=1.5)
    return layers
