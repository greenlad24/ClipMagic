"""Reference 2 recipes (kwysV2smgfY — Jake's own screencast tutorial), measured frame by
frame (motion/reference-specs/kwys-text-cta.{md,json}). Per-frame tables ARE the
keyframes; frames are the reference's 29.97 fps frames (scene fps = FPS2; the renderer
resamples to the output fps). px are at 1080p.

Motion is the asset; STYLE2 (faces, colours, logos) is swappable — Jake: "save mostly the
animation keyframes - we might change the design later".
"""
import base64
import json
from pathlib import Path

MOTION = Path(__file__).resolve().parent.parent / "motion"
SPEC = json.loads((MOTION / "reference-specs" / "kwys-text-cta.json").read_text())
R = SPEC["recipes"]
FPS2 = 30000 / 1001

STYLE2 = {
    "title_font": "Roboto", "title_sizes": (94, 75.5), "title_fill": "#FFFFFF",
    "link_font": "Open Sans", "link_size": 90, "link_glow": {"x": 0, "y": 0, "sigma": 7.5, "alpha": 0.7, "colour": "#FFFFFF"},
    "sub_red": "#FD1728", "sub_white": "#F9F9F9", "sub_label_grey": "#B2B2B2", "sub_font": "Roboto",
}


def _table(k, pairs, scale=1.0):
    return {"table": {round(k + f, 3): v * scale for f, v in pairs if not isinstance(v, str)}}


def _svg_uri(svg):
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


# ── lower-centre title: per-character fade + 36 px drop, stagger normalised to the line ──
def title_line(k0, text, size, baseline, exit_k=None, cx=960, font=None, fill=None, id="t"):
    """One line → one layer per non-space character. Char i (spaces counted) starts at
    k0 + 4.15·i/(N−1); exit (if exit_k) uses the same stagger from exit_k."""
    font = font or STYLE2["title_font"]
    fill = fill or STYLE2["title_fill"]
    cin, cout = R["title_char_in"]["per_char"], R["title_char_out"]["per_char"]
    n = len(text)
    out = []
    for i, ch in enumerate(text):
        if ch == " ":
            continue
        d = 4.15 * i / max(1, n - 1)
        op = dict(_table(k0 + d, cin["opacity"])["table"])
        ty = dict(_table(k0 + d, cin["translateY_px"])["table"])
        if exit_k is not None:
            op.update(_table(exit_k + d, cout["opacity"])["table"])
            ty.update(_table(exit_k + d, cout["translateY_px"])["table"])
        out.append({"id": f"{id}{i}", "text": ch, "font": {"family": font, "weight": 700, "size": size, "tracking": 0},
                    "fill": fill, "place": {"chars": {"line": text, "i": i, "x": cx, "baseline": baseline, "align": "centre"}},
                    "tracks": {"opacity": {"table": op}, "ty": {"table": ty}}})
    return out


def lower_title(k1, line1, line2="", k2=None, exit_k=None, big=False):
    """Reference layouts: 'UGC AI videos / Made easy' (94 px, baselines 903/1004) or
    'Hey everyone / welcome back to the channel' (75.5 px, baselines 873/965); a single
    line sits on baseline 904. Line 2 enters with its own words (k2)."""
    s94, s75 = STYLE2["title_sizes"]
    size = s94 if big else s75
    if line2:
        b1, b2 = (903, 1004) if big else (873, 965)
        return (title_line(k1, line1, size, b1, exit_k, id="a") +
                title_line(k2 if k2 is not None else k1 + 21, line2, size, b2, exit_k, id="b"))
    return title_line(k1, line1, size, 904, exit_k, id="a")


# ── "Link in the description": the same 69-frame rigid slide every time ──
def link(k0, text="Link in the description"):
    ls = R["link_slide"]
    ty = dict(_table(k0, ls["translateY_px_from_final"])["table"])
    ty.update(_table(k0, [(f, v) for f, v in ls["out_translateY_px"]])["table"])
    ty[k0 - 1] = 320                          # off frame before k0 (ascenders cross the bottom at k0)
    ty[k0 + 69] = 320
    return [{"id": "link", "text": text, "font": {"family": STYLE2["link_font"], "weight": 700, "size": STYLE2["link_size"],
             "tracking": 0}, "fill": "#FFFFFF", "shadow": STYLE2["link_glow"],
             "place": {"x": 959.5, "y": 893, "align": "centre", "maxWidth": 1700},
             "tracks": {"ty": {"table": ty}}, "visible": [k0, k0 + 68]}]


# ── Subscribe → Subscribed + bell, with the cursor that clicks both ──
CURSOR_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 34"><path d="M2 2 L2 27 L8.2 21.4 L12 30.5 '
              'L16.2 28.6 L12.4 19.6 L20.5 19.6 Z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>')
BELL_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="{c}" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1z"/></svg>')


def subscribe(k):
    """k = first visible frame of the red box (the reference: ~2.4 s before the click,
    which lands at k+73 inside the spoken 'subscribe'). Hard cut exit (t1)."""
    S = R["subscribe"]
    cx, y0, y1 = 959.5, 877, 1000
    red_w = S["box_scaleX_from_centre"]["width_px"]
    red_box = {k + f: [cx - w / 2, y0, cx + w / 2, y1] for f, w in red_w}
    sc = S["state_change"]
    prog = sc["red_to_white_progress"]
    off = sc["main_box_centre_x_offset_px"]
    fin_cx = (587 + 1135) / 2                                   # 861: the settled white box
    main_box = dict(red_box)
    for f, o in off:
        main_box[k + f] = [fin_cx + o - 274, y0, fin_cx + o + 274, y1]
    main_box[k + 26] = [cx - 276, y0, cx + 276, y1]
    red_op = {k - 0.01: 1.0, **{k + f: 1 - p for f, p in prog}}
    white_op = {k + 73.99: 0.0, **{k + f: p for f, p in prog}}
    bell_off = S["bell_box"]["centre_x_offset_px"]
    bell_cx = (1152 + 1270) / 2
    bell_box = {k + f: [bell_cx + o - 59, 878, bell_cx + o + 59, 999] for f, o in bell_off}
    lab_scale = {k + 10: 0.0, **{k + f: v for f, v in S["label_scale_uniform"]["scale"]}}
    out = [
        {"id": "sub_red", "kind": "box", "box": red_box | {k + f: v for f, v in main_box.items() if f >= k + 72},
         "radius": 7, "fill": STYLE2["sub_red"], "tracks": {"opacity": {"table": red_op}}},
        {"id": "sub_white", "kind": "box", "box": main_box, "radius": 7, "fill": STYLE2["sub_white"],
         "tracks": {"opacity": {"table": white_op}}},
        {"id": "sub_bell", "kind": "box", "box": bell_box, "radius": 7, "fill": STYLE2["sub_white"],
         "tracks": {"opacity": {"table": {k + 79.99: 0.0, k + 80: 1.0}}}},
        {"id": "sub_bell_icon", "kind": "box", "image": _svg_uri(BELL_SVG.format(c="#2F2F2F")),
         "box": {k + f: [bell_cx + o - 26, 912, bell_cx + o + 26, 964] for f, o in bell_off},
         "tracks": {"opacity": {"table": {k + 79.99: 0.0, k + 80: 1.0, k + 119: 1.0, k + 121: 0.0}}}},
        {"id": "sub_bell_icon_on", "kind": "box", "image": _svg_uri(BELL_SVG.format(c="#C8C8C8")),
         "box": {k + 87: [bell_cx - 26, 912, bell_cx + 26, 964]},
         "tracks": {"opacity": {"table": {k + 119: 0.0, k + 121: 1.0}}}},
        {"id": "sub_label", "text": "SUBSCRIBE", "font": {"family": STYLE2["sub_font"], "weight": 900, "size": 56},
         "fill": "#FFFFFF", "place": {"x": cx, "y": 912, "align": "centre"},
         "tracks": {"scale": {"table": lab_scale}, "opacity": {"table": {k + 10: 0.0, k + 11: 1.0, **red_op}}}},
        {"id": "sub_label2", "text": "SUBSCRIBED", "font": {"family": STYLE2["sub_font"], "weight": 900, "size": 56},
         "fill": STYLE2["sub_label_grey"], "place": {"x": fin_cx, "y": 912, "align": "centre"},
         "tracks": {"opacity": {"table": white_op},
                    "tx": {"table": {k + f: o for f, o in off}}}},
    ]
    # cursor: tip tables (the arrow's tip = the sprite's top-left + (2, 2) of 24×34 at 1.4×)
    tip = {}
    tip.update({k + f: p for f, p in S["cursor_in"]["tip_px"]})
    tip.update({k + f: p for f, p in S["cursor_to_bell"]["tip_px"]})
    tip.update({k + f: p for f, p in S["cursor_out"]["tip_px"] if not isinstance(p, str)})
    tip[k + 59] = [986, 1003]
    W, H = 24 * 1.4, 34 * 1.4
    cbox = {f: [x - 2.8, y - 2.8, x - 2.8 + W, y - 2.8 + H] for f, (x, y) in tip.items()}
    out.append({"id": "sub_cursor", "kind": "box", "image": _svg_uri(CURSOR_SVG), "box": cbox,
                "tracks": {"opacity": {"table": {k + 58.9: 0.0, k + 59: 0.2, k + 67: 1.0, k + 132: 1.0, k + 133: 0.0}},
                           "scale": {"table": {k + 72.9: 1.0, k + 73: 0.9, k + 74: 1.0, k + 118.9: 1.0, k + 119: 0.9, k + 120: 1.0}}}})
    return out


# ── TikTok + Instagram icons: rise from below with a ~1 % back overshoot, fade together ──
def _icon_svg(kind, size, radius):
    if kind == "tiktok":
        g = (MOTION / "assets" / "tiktok.svg").read_text()
        path = g.split('d="')[1].split('"')[0]
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#010101"/>'
                f'<g transform="translate(17.2,17.2) scale(2.73)"><path d="{path}" fill="#25F4EE" transform="translate(-0.5,-0.4)"/>'
                f'<path d="{path}" fill="#FE2C55" transform="translate(0.5,0.4)"/><path d="{path}" fill="#fff"/></g></svg>')
    g = (MOTION / "assets" / "instagram.svg").read_text()
    path = g.split('d="')[1].split('"')[0]
    r = radius / size * 100
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g" cx="0.3" cy="1.07" r="1.3">'
            f'<stop offset="0" stop-color="#FFDD55"/><stop offset="0.1" stop-color="#FFDD55"/><stop offset="0.5" stop-color="#FF543E"/>'
            f'<stop offset="1" stop-color="#C837AB"/></radialGradient></defs><rect width="100" height="100" rx="{r}" fill="url(#g)"/>'
            f'<g transform="translate(19,19) scale(2.58)"><path d="{path}" fill="#fff"/></g></svg>')


def socials(k_tiktok, k_insta=None, k_fade=None):
    I = R["icons"]
    k_insta = k_tiktok + 29 if k_insta is None else k_insta
    out = []
    for name, k, (cx, cy), size, rad in (("tiktok", k_tiktok, (379, 793), 296, 148),
                                          ("instagram", k_insta, (1522, 795), 280, 52)):
        ty = {k - 0.01: 400, **{k + f: v for f, v in I["rise_comp_px_from_final"][name]}}
        op = {k - 0.01: 0.0, k: 1.0}
        if k_fade is not None:
            op.update({k_fade + f: v for f, v in I["fade_out_both"]["opacity"]})
        out.append({"id": name, "kind": "box", "image": _svg_uri(_icon_svg(name, size, rad)),
                    "box": {k: [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2]},
                    "tracks": {"ty": {"table": ty}, "opacity": {"table": op}}})
    return out
