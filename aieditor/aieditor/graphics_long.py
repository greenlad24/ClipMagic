"""Long-form (16:9) overlay graphics in the reference-2 look (kwysV2smgfY): director
overlays → engine layers → PNG sequences for compose_long.

Anchoring follows the reference's own timing to speech (kwys-text-cta.json instances):
  title     text leads its first spoken word by ~6 f; exits with the per-char rise, the
            block leaving together ~6 f before the last word ends
  link      the 69-frame slide, k0 = the spoken word "link"
  subscribe the click (k+73) lands inside the word "subscribe"
  socials   TikTok rises on "TikTok"/"follow", Instagram on "Instagram"
keyword/list/number have no counterpart in reference 2: they use its title animation
(Jake: make every animation replicate the reference).
"""
import json
import re
from pathlib import Path

from . import compose, recipes2 as R2

FPS2 = R2.FPS2
TITLE_LEAD_F = 6
EXIT_BEFORE_END_F = 6


def _norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def _words_between(video, t0, t1):
    return [w for w in video["words"] if t0 - 0.3 <= w["start"] <= t1 + 0.3]


def _find(words, *keys):
    for w in words:
        if _norm(w["word"]) in keys:
            return w
    return None


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
        k2 = None
        if l2:
            hit = _find(ws, _norm(l2.split()[0]))
            k2 = (hit["start"] * FPS2 - TITLE_LEAD_F) if hit and hit["start"] * FPS2 - TITLE_LEAD_F > k_in + 6 else k_in + 12
        L = R2.lower_title(k_in, l1, l2, k2=k2, exit_k=k_out, big=(t == "keyword"))
        return L, k_in - 1, k_out + 16
    if t == "list":
        items = [str(i) for i in (f.get("items") or [])][:4]
        half = (len(items) + 1) // 2
        lines = [" · ".join(items[:half]), " · ".join(items[half:])]
        hit = _find(ws, _norm(items[half].split()[0])) if len(items) > half else None
        k2 = hit["start"] * FPS2 - TITLE_LEAD_F if hit else k_in + 24
        L = R2.lower_title(k_in, lines[0], lines[1], k2=max(k2, k_in + 6), exit_k=k_out)
        return L, k_in - 1, k_out + 16
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
        hit = _find(ws, "subscribe", "subscribed")
        click = (hit["start"] + 0.45 * (hit["end"] - hit["start"])) * FPS2 if hit else k_in + 80
        k0 = click - 73
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
        return R2.socials(k1, max(k2, k1 + 8), kf), k1 - 1, kf + 23
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
