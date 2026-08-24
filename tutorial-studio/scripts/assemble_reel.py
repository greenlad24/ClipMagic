#!/usr/bin/env python3
"""Assemble the finished reel: base talking-head + animated overlay layer + SFX.

Builds a timeline from the script + rendered slides + word/segment timings, drives the
HTML overlay engine (overlay_engine.html) frame-by-frame via Playwright to a transparent
PNG sequence, then composites over the base with ffmpeg and mixes synthesized SFX on the
cuts. No music. Every overlay is a real asset.

    .venv/bin/python scripts/assemble_reel.py --base .media/tutorial/talkinghead2.mp4 \
        --out .media/tutorial/reel_v2.mp4
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

FPS = 30



def _launch(p):
    """Launch system Chrome if present, else Playwright's bundled Chromium."""
    for kw in ({"channel": "chrome"}, {}):
        try:
            return p.chromium.launch(headless=True, **kw)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("no Chrome/Chromium available (run: playwright install chromium)")

def _dur(p):
    o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip()
    return float(o) if o else 30.0


def abs_file(p):
    return "file://" + os.path.abspath(p)


def data_uri(p):
    import base64
    ext = os.path.splitext(p)[1].lstrip(".").lower().replace("jpg", "jpeg")
    return f"data:image/{ext};base64," + base64.b64encode(open(p, "rb").read()).decode()


def build_timeline(base):
    D = _dur(base)
    meta = json.load(open(".media/tutorial/script.json")) if os.path.exists(".media/tutorial/script.json") else {}
    slides = sorted(glob.glob(".media/tutorial/assets/slide_*.png"))
    grid = ".media/tutorial/assets/grid.png"
    grid_du = data_uri(grid) if os.path.exists(grid) else None
    rots = [-2, 2, -3, 1.5, -1.5, 2.5, -2, 1, -2.5, 2, -1.5, 2, -2, 1.5]

    # --- word timings (drive BOTH captions and content-aware element placement) ---
    wp = ".media/tutorial/vo_words.json"
    words = []
    if os.path.exists(wp) and json.load(open(wp)):
        for w in json.load(open(wp)):
            t = w["w"].strip().lstrip("-–—.,").rstrip(",").strip()
            if t:
                words.append({"w": t, "a": w["a"], "b": w["b"]})

    # captions: word-by-word. Emphasis words get <b> → the brush-stroke underline.
    EMPH = {"claude", "carousel", "carousels", "slide", "slides", "faster", "convert",
            "hook", "headlines", "prompt", "machine", "tighten", "minute"}

    def wrap(w):
        return "<b>" + w + "</b>" if w.lower().strip('.,!?') in EMPH else w

    caps = []
    if words:
        i = 0
        while i < len(words):
            grp = words[i:i + 2]
            caps.append({"html": " ".join(wrap(w["w"]) for w in grp),
                         "t0": round(grp[0]["a"], 2), "t1": round(grp[-1]["b"] + 0.05, 2)})
            i += 2
    else:
        caps = [{"html": "how to make carousels with Claude", "t0": 0.0, "t1": 3.0}]

    ws = [w["w"].lower().strip('.,!?"\'') for w in words]

    def wtime(*alts):
        """Start time of the first matching phrase (any alt); None if unseen."""
        for alt in alts:
            seq = [a.lower() for a in alt]
            for i in range(len(ws) - len(seq) + 1):
                if ws[i:i + len(seq)] == seq:
                    return words[i]["a"]
        return None

    def slide(i):
        return data_uri(slides[i]) if 0 <= i < len(slides) else grid_du

    # --- element cues: element shown EXACTLY when she says the relevant thing ---
    cues = []  # [t0, img, kind, zoom]
    # Title alone for ~1s; screenshots come in from 1s. ALL cards are centered (same spot).
    prompt_p = ".media/tutorial/assets/prompt.png"
    prompt_du = data_uri(prompt_p) if os.path.exists(prompt_p) else None
    hook = [(1.05, slide(0), "", False), (1.5, slide(1), "", True),
            (1.95, slide(2), "", False), (2.4, slide(3), "", True)]
    cues += [[t, im, k, z] for t, im, k, z in hook if im]

    def cue(img, kind, zoom, *alts):
        t = wtime(*alts)
        if t is not None and img and t > 2.7:
            cues.append([t, img, kind, zoom])

    cue(slide(1), "", False, ["niche"], ["offer"], ["audience"], ["tone"])
    cue(prompt_du, "", False, ["ask"], ["ten", "slide"], ["10", "slide"])   # PROMPT screenshot (every video)
    cue(slide(0), "", False, ["hook"], ["scroll"])
    cue(slide(2), "", False, ["headlines"], ["headline"])
    cue(slide(3), "", True, ["body"], ["copy"])
    cue(slide(4), "", False, ["layout"])
    cue(slide(5), "", False, ["image"], ["prompts"])
    cue(slide(6), "", False, ["tighten"])
    cue(slide(7), "", True, ["contrast"], ["rhythm"])
    cue(slide(8), "", False, ["post"], ["faster"])
    cue(slide(9), "", False, ["convert"], ["viewers"])

    cues.sort(key=lambda c: c[0])
    cards = []
    for idx, (t0, img, kind, zoom) in enumerate(cues):
        nxt = cues[idx + 1][0] if idx + 1 < len(cues) else D - 3.0
        t1 = min(nxt, t0 + 2.2)
        if t1 - t0 < 0.3:
            t1 = t0 + 0.4
        cards.append({"img": img, "kind": kind, "zoom": zoom,
                      "t0": round(t0, 2), "t1": round(t1, 2), "rot": 0})   # straight, never tilted

    # paper NOTES — pick the torn-paper element by TEXT LENGTH; text set in FunClub ink.
    EL = ".media/tutorial/elements/"

    def note_style(text):
        n = len(text)
        if n <= 15:
            p, w, h, lines = "short CTA.png", 430, 150, 1
        elif n <= 28:
            p, w, h, lines = "longer CTA.png", 580, 196, 1
        else:
            p, w, h, lines = "2-lines.png", 580, 230, 2
        return {"paper": data_uri(EL + p), "w": w, "h": h, "lines": lines}   # fixed box; engine fits the font

    def two_lines(text):
        """Balance text into EXACTLY two lines (split at the most even word boundary)."""
        ws = text.split()
        if len(ws) < 2:
            return text
        best = None
        for i in range(1, len(ws)):
            a, b = " ".join(ws[:i]), " ".join(ws[i:])
            s = abs(len(a) - len(b))
            if best is None or s < best[0]:
                best = (s, a + "<br>" + b)
        return best[1]

    def note_html(text, lines):
        return two_lines(text) if lines > 1 else text

    labels = []

    def label(text, y, rot, *alts):
        t = wtime(*alts)
        if t is None:
            return
        ns = note_style(text)
        labels.append({"text": note_html(text, ns["lines"]), "t0": round(t, 2),
                       "t1": round(min(D - 3.2, t + 2.0), 2), "y": y, "rot": rot, **ns})

    label("paste your brief", 150, -3, ["niche"], ["give"])
    label("ask for 10 slides", 150, 3, ["ten", "slide"], ["10", "slide"])
    label("tighten each slide", 150, -2, ["tighten"])

    tc = wtime(["comment"])
    # two-part title: small lead-in (Fruity Cake) + main title (Rozanova Geo Black)
    title = {"small": meta.get("title_small", "how to make"),
             "main": meta.get("title_main", "carousels with Claude"), "t1": 3.0}
    ctatext = meta.get("cta", "Comment CAROUSEL for the prompt")
    cns = note_style(ctatext)
    cta = {"html": note_html(ctatext, cns["lines"]), "t0": round(tc if tc else D - 3.2, 2),
           "center": True, "rot": -2, **cns}   # center-middle, exactly 2 lines

    # meme GIFs — matched by sentiment to the words, overlaid as looping clips (main()).
    MEMEDIR = ".media/tutorial/memes/"
    memes = []

    def meme(fname, *alts):
        t = wtime(*alts)
        base = os.path.splitext(fname)[0]
        ready = ".media/tutorial/memes_ready/" + base + ".mp4"   # normalized, render-ready
        src = ready if os.path.exists(ready) else (MEMEDIR + fname)
        if t is not None and os.path.exists(src):
            memes.append({"gif": src, "t0": round(t, 2), "t1": round(min(D - 3.2, t + 1.6), 2)})

    meme("mind blowing.gif", ["machine"], ["minute"])
    meme("excited.gif", ["carousel"], ["slide"])
    meme("add that into the mix.gif", ["image"], ["prompts"], ["layout"])
    meme("being smart about it.gif", ["tighten"], ["contrast"])
    meme("excited to watch what happens.gif", ["faster"], ["convert"], ["viewers"])

    # never more than 2 memes; keep them spread (earliest + latest)
    memes.sort(key=lambda m: m["t0"])
    if len(memes) > 2:
        memes = [memes[0], memes[-1]]

    # never a meme on top of a card: clip/drop cards that overlap a meme window
    mw = [(m["t0"], m["t1"]) for m in memes]
    kept = []
    for c in cards:
        drop = False
        for w0, w1 in mw:
            if not (c["t1"] <= w0 or c["t0"] >= w1):        # overlaps a meme
                if c["t0"] < w0:
                    c["t1"] = round(w0, 2)                  # end the card before the meme
                else:
                    drop = True
                    break                                   # card starts inside meme -> drop it
        if not drop and c["t1"] - c["t0"] > 0.2:
            kept.append(c)
    cards = kept

    # SFX: a MOUSE CLICK on every element entrance (per operator).
    cuts = [{"t": c["t0"], "type": "click"} for c in cards] + \
           [{"t": l["t0"], "type": "click"} for l in labels] + \
           [{"t": m["t0"], "type": "click"} for m in memes] + \
           [{"t": cta["t0"], "type": "pop"}]
    return D, {"title": title, "cards": cards, "caps": caps, "labels": labels,
               "cta": cta}, cuts, memes


def capture_frames(timeline, D, outdir):
    from playwright.sync_api import sync_playwright
    os.makedirs(outdir, exist_ok=True)
    n = int(D * FPS)
    # Inject the timeline + FunClub font + brush element into the engine before scripts run.
    import base64
    def font_du(p):
        return "data:font/ttf;base64," + base64.b64encode(open(p, "rb").read()).decode()
    brush_du = data_uri(".media/tutorial/elements/brush-stroke.png")
    html = (open("scripts/overlay_engine.html").read()
            .replace("window.TIMELINE || {cards:[],caps:[],labels:[],title:null,cta:null}",
                     json.dumps(timeline))
            .replace("FONT_DATAURI", font_du(".media/tutorial/fonts/FunClub-Italic.ttf"))
            .replace("FONT2_DATAURI", font_du(".media/tutorial/fonts/FruityCake.ttf"))
            .replace("FONT3_DATAURI", font_du(".media/tutorial/fonts/rozanova-geo-black.ttf"))
            .replace("BRUSH_DATAURI", brush_du))
    with sync_playwright() as p:
        b = _launch(p)
        pg = b.new_page(viewport={"width": 720, "height": 1280}, device_scale_factor=1)
        pg.set_content(html, wait_until="networkidle")
        pg.wait_for_timeout(1000)   # let fonts + card images load
        for f in range(n):
            pg.evaluate("t => window.render(t)", f / FPS)
            pg.screenshot(path=os.path.join(outdir, f"f{f:05d}.png"), omit_background=True)
        b.close()
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=".media/tutorial/talkinghead2.mp4")
    ap.add_argument("--out", default=".media/tutorial/reel_v2.mp4")
    args = ap.parse_args()

    # ensure every meme GIF is normalized to a short render-ready clip (never stalls)
    import glob as _glob
    if _glob.glob(".media/tutorial/memes/*.gif"):
        try:
            from scripts import prep_memes as _pm
            print("normalizing memes …", flush=True)
            _pm.main()
        except Exception as e:  # noqa: BLE001
            print("meme prep skipped:", e, flush=True)

    D, timeline, cuts, memes = build_timeline(args.base)
    print(f"timeline: {len(timeline['cards'])} cards, {len(timeline['caps'])} caps, "
          f"{len(timeline['labels'])} labels, {len(memes)} memes, {len(cuts)} sfx, {D:.1f}s",
          flush=True)

    frames = ".media/tutorial/frames"
    import shutil
    if os.path.exists(frames):
        shutil.rmtree(frames)
    print("capturing overlay frames …", flush=True)
    n = capture_frames(timeline, D, frames)
    print(f"  captured {n} frames", flush=True)

    # SFX track
    from scripts import sfx as _sfx  # type: ignore
    sfx_wav = ".media/tutorial/sfx/sfx_track.wav"
    _sfx._write_wav(sfx_wav, _sfx.build_track(cuts, D))
    print(f"  sfx track -> {sfx_wav}", flush=True)

    print("compositing static overlays …", flush=True)
    static = args.out if not memes else ".media/tutorial/_static.mp4"
    cmd = ["ffmpeg", "-y", "-i", args.base, "-framerate", str(FPS), "-i",
           os.path.join(frames, "f%05d.png"), "-i", sfx_wav,
           "-filter_complex",
           "[0:v]scale=720:1280[b];[b][1:v]overlay=0:0:shortest=1[v];"
           "[0:a][2:a]amix=inputs=2:duration=first:normalize=0[a]",
           "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-crf", "18", "-c:a", "aac", static]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("ffmpeg failed:\n" + r.stderr[-2000:])

    if memes:
        print(f"overlaying {len(memes)} meme GIFs …", flush=True)
        inputs = ["-i", static]
        for m in memes:
            inputs += ["-i", m["gif"]]      # play the GIF once through its window (no infinite loop)
        fc, prev = [], "[0:v]"
        for i, m in enumerate(memes):
            # meme clip: straight, centered in the card band; shifted to start at t0.
            fc.append(f"[{i+1}:v]scale=360:-1,setpts=PTS-STARTPTS+{m['t0']}/TB,format=yuva420p[m{i}]")
            out = f"[o{i}]"
            fc.append(f"{prev}[m{i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,{m['t0']},{m['t1']})'"
                      f":eof_action=pass{out}")
            prev = out
        cmd2 = ["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(fc),
                "-map", prev, "-map", "0:a", "-preset", "veryfast",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "copy", args.out]
        r2 = subprocess.run(cmd2, capture_output=True, text=True)
        if r2.returncode != 0:
            sys.exit("meme overlay failed:\n" + r2.stderr[-2000:])
    print(f"  done -> {args.out}")


if __name__ == "__main__":
    main()
