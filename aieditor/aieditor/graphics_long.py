"""Long-form (16:9) overlay graphics in the reference-2 look (kwysV2smgfY): director
overlays → engine layers → PNG sequences for compose_long.

Anchoring follows the reference's own timing to speech (kwys-text-cta.json instances; gap list G7):
  title     text leads the first spoken word OF ITS OWN TEXT (line 1's first word, found inside the
            event span) by ~6 f — not the event's first word (ev-01 'Editing photos' came in 0.6 s early);
            exits with the per-char rise, the block leaving together ~6 f before the last word ends
  list      ONE item per line, each line entering on its own spoken word (first token match), at most
            3 lines on screen (a 4th item starts a new block as the first exits)
  link      the 69-frame slide, k0 = the spoken word "link"
  subscribe the pill appears ON the spoken word "subscribe" (TX05 ref 4 0:46.20: first red frame +0.35 s
            after 'subscribe' 46.06; reference 2's box starts on the line's first word instead — see
            SUBSCRIBE_DECISION); its click (k+73) and bell follow the reference-2 recipe
  socials   TikTok rises on "TikTok"/"follow", Instagram on "Instagram"; the icons then ride outward
            with the AR02 punch to the lower corners (TX06 ref 5 15:00.5 / ref 3 13:10.5: TikTok ~0.05 W,
            Instagram ~0.93 W)
keyword/list/number have no counterpart in reference 2: they use its title animation
(Jake: make every animation replicate the reference).
"""
import json
import re
from pathlib import Path

from . import compose, events as ev_log, motiontemplates, recipes2 as R2, uikits


def _log(msg):
    ev_log.emit("log", msg)

FPS2 = R2.FPS2
# TODO(p2): read these from the skill's rules.json through aieditor/skill.py once p2 merges (same values).
TITLE_LEAD_F = 6
EXIT_BEFORE_END_F = 6
LIST_MAX_LINES = 3                 # G7 step 2: one item per line, at most 3 on screen
LIST_PITCH_PX = 92                 # the reference two-line title's line pitch (baselines 873 / 965)
LIST_LAST_BASELINE = 965
SOCIALS_FINAL_X = (0.05, 0.93)     # G7 step 6: TikTok / Instagram centres as a share of the width (TX06)
SUBSCRIBE_DECISION = (
    "CHANGED (G7 step 3, verified 2026-10-09): TX05_subscribe__ref4_0m46.20 shows the red pill's first frame at "
    "~46.40 s, +0.35 s after the spoken 'subscribe' (46.06, Geg9TyNoi3w words) — ON the word. The old k0 = click − 73 f "
    "came from reference 2 (kwys-text-cta.json instance k0 1971 on 'So', 'subscribe' f2032.8: 2.07 s early), which put "
    "ev-03 2.4 s before 'subscribe' (gap item 81; RULEBOOK X3 / D10: an overlay > 0.3 s off its word). The pill now "
    "appears on the word; the reference-2 click/bell animation follows from there.")


def _norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def _words_between(video, t0, t1):
    return [w for w in video["words"] if t0 - 0.3 <= w["start"] <= t1 + 0.3]


def _find(words, *keys):
    for w in words:
        if _norm(w["word"]) in keys:
            return w
    return None


_SMALL = {"a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "my", "your", "i", "im", "it", "is"}


def _spoken(words, text, after=None):
    """The spoken word where `text` starts: its first content token matched in order (from `after`), moved
    back over the text's leading small words when they are spoken right before it. None if not spoken."""
    toks = [_norm(t) for t in str(text).split() if _norm(t)]
    if not toks:
        return None
    k = next((i for i, t in enumerate(toks) if t not in _SMALL), 0)
    start = 0 if after is None else next((i for i, w in enumerate(words) if w["start"] > after["start"]), len(words))
    for i in range(start, len(words)):
        if _norm(words[i]["word"]) == toks[k] or (len(toks[k]) > 3 and _norm(words[i]["word"]).rstrip("s") == toks[k].rstrip("s")):
            j = i
            for back in range(k - 1, -1, -1):
                if j - 1 >= start and _norm(words[j - 1]["word"]) == toks[back]:
                    j -= 1
                else:
                    break
            return words[j]
    return None


def _bez(x1, y1, x2, y2):
    def f(x):
        if x <= 0:
            return 0.0
        if x >= 1:
            return 1.0
        lo, hi = 0.0, 1.0
        for _ in range(40):
            u = (lo + hi) / 2
            bx = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3
            lo, hi = (u, hi) if bx < x else (lo, u)
        u = (lo + hi) / 2
        return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3
    return f


def list_layers(items, words, k_first, k_out):
    """G7 step 2: one item per line, each entering on its own spoken word; pages of at most LIST_MAX_LINES
    lines (the next page enters as the previous one exits). → (layers, [(item, k_in)])"""
    size = R2.STYLE2["title_sizes"][1]
    ks, prev = [], None
    for n, it in enumerate(items):
        hit = _spoken(words, it, prev)
        k = hit["start"] * FPS2 - TITLE_LEAD_F if hit else (ks[-1] + 24 if ks else k_first)
        if ks:
            k = max(k, ks[-1] + 6)
        ks.append(k)
        prev = hit or prev
    pages = [list(range(i, min(i + LIST_MAX_LINES, len(items)))) for i in range(0, len(items), LIST_MAX_LINES)]
    out = []
    for p, idx in enumerate(pages):
        exit_k = (ks[pages[p + 1][0]] - 8) if p + 1 < len(pages) else max(k_out, ks[idx[-1]] + 30)
        for j, i in enumerate(idx):
            base = LIST_LAST_BASELINE - (len(idx) - 1 - j) * LIST_PITCH_PX
            out += R2.title_line(ks[i], items[i], size, base, exit_k, id=f"l{i}")
    return out, list(zip(items, ks))


def layers_for(ev, video):
    """→ (layers, first_frame, last_frame) in reference-2 frames (output seconds × FPS2)."""
    t, f = ev["template"], ev.get("fields") or {}
    ev["sfx"] = []                       # reference 2: silent overlays (subscribe sets its clicks)
    ws = _words_between(video, ev["t0"], ev["t1"])
    first_word = ws[0]["start"] if ws else ev["t0"] + 0.2
    last_word = ws[-1]["end"] if ws else ev["t1"]
    k_in = first_word * FPS2 - TITLE_LEAD_F
    k_out = max(k_in + 30, last_word * FPS2 - EXIT_BEFORE_END_F)
    if t in ("lower_title", "keyword"):
        l1, l2 = str(f.get("line1", "")).strip(), str(f.get("line2", "")).strip()
        # G7 step 1: the title lands on the first word of its OWN text (line 1), not the event's first word
        h1 = _spoken(ws, l1)
        if h1 is not None:
            k_in = h1["start"] * FPS2 - TITLE_LEAD_F
            k_out = max(k_in + 30, k_out)
        k2 = None
        if l2:
            hit = _spoken(ws, l2, h1)
            k2 = (hit["start"] * FPS2 - TITLE_LEAD_F) if hit and hit["start"] * FPS2 - TITLE_LEAD_F > k_in + 6 else k_in + 12
        L = R2.lower_title(k_in, l1, l2, k2=k2, exit_k=k_out, big=(t == "keyword"))
        return L, k_in - 1, k_out + 16
    if t == "list":
        items = [str(i) for i in (f.get("items") or [])][:4]
        wide = [w for w in video["words"] if ev["t0"] - 0.3 <= w["start"] <= ev["t1"] + 1.0]
        L, ks = list_layers(items, wide, k_in, k_out)
        ev["item_k"] = [round(k, 2) for _, k in ks]
        k_first = min(k for _, k in ks) if ks else k_in
        return L, k_first - 1, max(k_out, max(k for _, k in ks) + 30 if ks else k_out) + 16
    if t == "number":
        val = f.get("value")
        txt = f"{f.get('prefix', '')}{val:,}{f.get('suffix', '')}" if isinstance(val, (int, float)) else str(val)
        L = R2.lower_title(k_in, txt, str(f.get("label", "")), k2=k_in + 8, exit_k=k_out, big=True)
        return L, k_in - 1, k_out + 16
    if t == "link":
        hit = _find(ws, "link", "links")
        k0 = (hit["start"] * FPS2 if hit else k_in + TITLE_LEAD_F) - 1
        return R2.link(k0, f.get("text") or "Link in the description"), k0 - 1, k0 + 70
    if t == "subscribe":
        # G7 step 3 (SUBSCRIBE_DECISION): the pill appears on the spoken word 'subscribe' (TX05 ref 4)
        hit = _find(ws, "subscribe", "subscribed")
        k0 = hit["start"] * FPS2 if hit else k_in + TITLE_LEAD_F
        end = max(ev["t1"] * FPS2, k0 + 140)
        L = R2.subscribe(k0)
        for layer in L:
            layer["visible"] = [k0 - 1, end]                     # hard cut exit
        ev["sfx"] = [((k0 + 73) / FPS2, "click"), ((k0 + 119) / FPS2, "click")]
        return L, k0 - 1, end
    if t == "socials":
        tk = _find(ws, "tiktok", "follow")
        ig = _find(ws, "instagram", "insta")
        k1 = (tk["end"] if tk else ev["t0"] + 0.3) * FPS2
        k2 = (ig["end"] * FPS2) if ig else k1 + 29
        kf = max(k2 + 30, ev["t1"] * FPS2 - 22)
        L = R2.socials(k1, max(k2, k1 + 8), kf)
        # G7 step 6 / AR02: the icons ride the outro punch to the lower corners (TikTok ~0.05 W, IG ~0.93 W),
        # over the AR02 beat's 32 f on its curve, from the beat start (the overlay's t0 = aroll_plan's beat)
        e = _bez(0.317, 0.093, 0.238, 1.0)
        ka = ev["t0"] * FPS2
        for layer, fx in zip(L, SOCIALS_FINAL_X):
            x0, _, x1, _ = next(iter(layer["box"].values()))
            dx = fx * 1920 - (x0 + x1) / 2
            layer["tracks"]["tx"] = {"table": {round(ka + i, 3): round(dx * e(i / 32), 2) for i in range(33)}}
        return L, k1 - 1, kf + 23
    return [], 0, 0


def render(job, events, video, fps_out, size=(1920, 1080), cancelled=lambda: False, progress=lambda m, f: None,
           tag="gfx-long"):
    """Every overlay → job/<tag>/ev-MM/fNNNNN.png (numbered by OUTPUT frame) and the
    compose_long event list."""
    job = Path(job)
    g = job / tag
    g.mkdir(exist_ok=True)
    scale = size[0] / 1920
    out = []
    for m, ev in enumerate(events):
        if motiontemplates.is_motion(ev.get("template")) and not motiontemplates.enabled():
            _log(f"overlay {m + 1} ({ev.get('template')}) not rendered: motion templates are switched off")
            continue
        if motiontemplates.is_motion(ev.get("template")):
            # a motion TEMPLATE (verb_swap … prompt_result): its own DOM renderer on the shared runtime, timed by the
            # spoken words (motiontemplates.beats), the prompt box in the app's UI kit (none → neutral box, logged)
            p = (ev.get("params") or {})
            kit = uikits.for_app(p.get("app"), log=lambda msg: _log(f"overlay {m + 1}: {msg}"))[0] \
                if ev.get("template") in ("prompt_menu", "prompt_card_3d", "prompt_highlight", "prompt_result") else None
            sc = motiontemplates.scene(ev, video, fps_out, size, kit=kit, result=p.get("result"))
            d = g / f"ev-{m:02d}"
            (g / f"ev-{m:02d}.json").write_text(json.dumps(sc))
            progress(f"Rendering overlay {m + 1} of {len(events)} ({ev['template']})…", m / max(1, len(events)))
            compose._docker(["--entrypoint", "node", compose.LAB_IMAGE, "/app/motion/render.mjs", f"/g/ev-{m:02d}.json",
                             f"/g/ev-{m:02d}"], cancelled, [(compose.MOTION, "/app/motion"), (g, "/g")])
            out.append({**{k: v for k, v in ev.items() if k != "params"}, "frames_dir": f"ev-{m:02d}",
                        "start_frame": sc["outFirst"], "full_frame": bool((sc["params"] or {}).get("backdrop", True))})
            continue
        L, a, b = layers_for(ev, video)
        if not L:
            continue
        out_first = max(0, int(a / FPS2 * fps_out))
        sc = {"width": 1920, "height": 1080, "scale": scale, "fps": FPS2, "outFps": fps_out,
              "first": out_first / fps_out * FPS2, "last": b, "outFirst": out_first, "layers": L}
        d = g / f"ev-{m:02d}"
        (g / f"ev-{m:02d}.json").write_text(json.dumps(sc))
        progress(f"Rendering overlay {m + 1} of {len(events)} ({ev['template']})…", m / max(1, len(events)))
        compose._docker(["--entrypoint", "node", compose.LAB_IMAGE, "/app/motion/render.mjs", f"/g/ev-{m:02d}.json",
                         f"/g/ev-{m:02d}"], cancelled, [(compose.MOTION, "/app/motion"), (g, "/g")])
        out.append({**ev, "frames_dir": f"ev-{m:02d}", "start_frame": out_first})
    return out


def repair_frame_names(g, events):
    """Overlay frames rendered before the render.mjs fix (2026-10-09) can be named by a float
    ("f1920.0000000000002.png"): rename them to the integer OUTPUT frame compose expects.
    Returns the number of renamed files."""
    import re
    n = 0
    for ev in events:
        d = Path(g) / ev.get("frames_dir", "")
        if not ev.get("frames_dir") or not d.is_dir():
            continue
        for f in list(d.glob("f*.png")):
            m = re.fullmatch(r"f(\d+\.\d+)\.png", f.name)
            if m:
                f.rename(d / f"f{round(float(m.group(1))):05d}.png")
                n += 1
    return n
