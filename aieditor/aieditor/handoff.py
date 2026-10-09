"""GRAPHICS ONLY — THE EDITOR ADDS THE SCREENCASTS (Jake 2026-10-09: "a mode where the AI can creative edit
everything but without adding the screencasts - so I can send an editor all of the motion graphic parts and he
only does the screencast"; the editor works in Premiere Pro or DaVinci Resolve).

request.json "handoff": true on a long-form creative job (control.ts sets it from the Lab's third creative
option). The architecture recommendation still holds — code renders, ONE plan call decides, no AI on camera —
and here nothing is recorded at all: no browser starts, no Scout profile is needed (a factory server gets none).

  stage     what runs
  preprod   plan(): the single plan call + plan check + overlay call (director.plan) — PLAN ONLY: no readiness,
            asset generation, set dressing or dry run (those exist for the recorder). needs_primitive never
            holds the job here: a person records the screen, so those lines go to the brief as notes.
  graphics  overlays(): every planned overlay rendered (graphics_long, the measured reference-2 recipes)
  handoff   build(): the hand-off package below; every screencast slot of the plan stays a marked gap

THE PACKAGE (job dir: handoff-NN/ + handoff-NN.zip; every path relative, nothing to relink):
  timeline.xml          Premiere XML (xmeml v4; Resolve imports it too)        ┐ V1 A-roll (camera baked in)
  timeline.fcpxml       FCPXML 1.10 (Resolve's most reliable path)            │ V2 screencasts — EMPTY, one marker
  a-roll.mov            the cut at source resolution, A-roll camera baked in  │    per slot (FCPXML: disabled cards)
  graphics/NN-*.mov     ProRes 4444 + alpha, full frame: overlays, text       │ V3+ graphics at their times
                        gradient, facecam bubble per slot, end fade           │ A1 voice, A2 music, A3 SFX
  audio/{voice,music,sfx}.wav   48 kHz stems from 0, all the sequence's length┘
  screencasts/BRIEF.html (+ BRIEF.pdf when Chromium prints it), slots.csv, placeholders/slot-NN.mp4
  preview.mp4           the whole edit with a labelled card in every slot (the Lab plays it: preview-NN.mp4)
  README.txt            how to open it

No narration cut is added (the A-roll is the edited timeline, frame for frame) and no pause is trimmed.
"""
import csv
import html
import io
import json
import os
import re
import shutil
import textwrap
import time
import zipfile
from pathlib import Path

from . import compose_long, config, director, events as ev_log, graphics_long, longedit, media, planfit, render, sfx, skill

PKG = "handoff-{k:02d}"
STAGES = ["download", "audio", "transcribe", "align", "timeline", "preprod", "graphics", "handoff"]
AROLL_CODECS = ("h264", "prores")          # request.json "handoff_aroll": h264 (default, source quality) | prores (422 HQ)
PRORES_4444 = "-c:v prores_ks -profile:v 4 -vendor apl0 -pix_fmt yuva444p10le"
FONT = ("F=$(ls /usr/share/fonts/opentype/inter/Inter-SemiBold.otf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf "
        "2>/dev/null | head -1)")
CARD_BG = "0x161b22"

# what the editor must keep, whatever the slot (Jake's rulings + RULEBOOK; the brief prints them)
RULES = [
    ("Do not touch the narration", "The voice (A1) is final: no cuts, no trims, no pauses removed or added. Fit the "
     "screen recording to the words (speed up, hold a frame, cut inside the recording) — never the other way round."),
    ("Privacy", "Blur anything private before export: e-mail addresses, other people's names and faces, API keys, "
     "account menus, notifications, browser tabs and bookmarks. Only Jake's own account is ever on screen."),
    ("Pricing", "Prices come only from the PUBLIC pricing page in a logged-out browser set to the United States "
     "(US VPN / US region, English), shown in USD: the top of the page unzoomed first, then a cut or zoom to the plan "
     "card he names. Never an in-account upgrade or billing screen, never all prices at once."),
    ("Never log out", "Do not log out of any account and never click Delete, Buy, Upgrade, Subscribe, Checkout, "
     "Publish, Share, Invite or Billing."),
    ("On the word", "Each click lands on the word that names it (within ±0.15 s); its result shows 0.2–1.4 s later. "
     "A generation is the click on its word, then a cut or dissolve straight to the finished result (no spinner) — "
     "unless he talks about the wait, then the progress stays on screen while he talks about it."),
    ("Clean, moving screens", "Dark theme for ChatGPT, a fresh chat, no pop-ups or cookie banners, prompts pasted "
     "whole, no needless scrolling. Something moves (a zoom, a pan, a click) every 3–5 s; nothing still for more than "
     "3 s. Zoom on what he names, ease back out after."),
    ("Fit the slot", "Fill the whole slot on V2, full frame 16:9, at least the timeline's resolution. Where a slot "
     "meets the presenter, dissolve over 4 frames inside the slot's first / last frames; two slots back to back "
     "dissolve over 5 frames. The facecam bubble (V-track above) is already timed and fades by itself."),
]


def wanted(req):
    """A long-form creative job that asked for the hand-off package."""
    req = req or {}
    return bool(req.get("handoff")) and req.get("workflow") == "creative" and req.get("format") == "long"


def jdump(path, obj):
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def jload(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def _fresh(path, than):
    return Path(path).exists() and Path(path).stat().st_mtime >= than


def _edl_at(d):
    p = Path(d) / "edl.json"
    return p.stat().st_mtime if p.exists() else 0.0


# ════════════════════════════ stage "preprod": the plan only ════════════════════════════

def plan_fresh(d):
    doc = jload(Path(d) / "preprod" / "plan.json") or {}
    return bool(doc.get("handoff")) and _fresh(Path(d) / "preprod" / "plan.json", _edl_at(d))


def plan(d, req, edl, log=print, progress=None):
    """THE plan for the hand-off: the single plan call + check (re-asks) + the overlay call — and nothing that
    needs a browser. → {"note", "usd"}; writes preprod/plan.json (the same shape pre-production writes, so
    longedit / the Lab read it unchanged) and preprod/gate.json (status "handoff", never held)."""
    from . import sites as sites_mod
    d = Path(d)
    out = d / "preprod"
    out.mkdir(exist_ok=True)
    v = edl["videos"][0]
    video = {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}
    if progress:
        progress("Hand-off plan: which apps the screencasts show…", 0.05)
    sites, usd = sites_mod.resolve(d, req, video, log=log)
    if progress:
        progress("Claude is planning the edit (screencast slots + overlays)…", 0.2)
    p, raw, meta = director.plan(video, sites, bool(req.get("sponsored")), None, facts=planfit.Facts(),
                                 rulebook=director.rulebook_digest(skill.rulebook_text()), handoff=True)
    usd += float(meta.get("usd") or 0)
    notes = [{"sentence": n.get("sentence"), "why": n.get("why"), "word_ids": n.get("word_ids") or []}
             for n in p.get("needs_primitive") or []]
    jdump(out / "plan.json", {"plan": p, "raw": raw, "meta": meta, "sites": sites, "held": [], "handoff": True,
                              "editor_notes": notes, "order": ["plan_call", "plan_check", "overlay_plan"]})
    jdump(out / "gate.json", {"go": True, "status": "handoff", "next_stage": "handoff",
                              "sites": [{"url": s["url"], "note": s.get("note", ""), "scout": None, "ready": True,
                                         "why": "the editor records it"} for s in sites],
                              "fallbacks": [], "held": [], "costs": {"claude_usd": round(usd, 4)}})
    note = (f"{len(p['segments'])} screencast slot(s) for the editor, {len(p['overlays'])} overlay(s)"
            + (f", {len(notes)} note(s) for the brief" if notes else ""))
    log(f"hand-off plan: {note}")
    return {"note": note, "usd": round(usd, 4)}


# ════════════════════════════ stage "graphics": the overlays ════════════════════════════

def overlays_fresh(d, n_videos):
    d = Path(d)
    return all(_fresh(d / f"edit-{k:02d}" / "overlays.json", _edl_at(d)) and _fresh(d / f"edit-{k:02d}" / "direct.json", _edl_at(d))
               for k in range(1, n_videos + 1))


def overlays(d, k, v, fps, size, cancelled=lambda: False, progress=lambda m, f=None: None, log=print):
    """edit-NN/direct.json (the plan) + every overlay rendered at 1920 (the preview, tag gfx) and at the source
    width when it differs (the package, tag gfx-W). → (note, usd)"""
    d = Path(d)
    w = d / f"edit-{k:02d}"
    w.mkdir(exist_ok=True)
    video = {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}
    usd = 0.0
    pre = d / "preprod" / "plan.json"
    if k == 1 and _fresh(pre, _edl_at(d)):
        doc = jload(pre)
        jdump(w / "direct.json", {"plan": doc["plan"], "raw": doc["raw"], "meta": {**doc.get("meta", {}), "usd": 0.0,
                                                                                    "from": "preprod/plan.json"},
                                  "sites": doc.get("sites") or [], "handoff": True})
    elif not _fresh(w / "direct.json", _edl_at(d)):
        p, raw, meta = director.plan(video, [], False, None, facts=planfit.Facts())
        usd += float(meta.get("usd") or 0)
        jdump(w / "direct.json", {"plan": p, "raw": raw, "meta": meta, "sites": [], "handoff": True})
    plan_ = jload(w / "direct.json")["plan"]
    progress("Rendering the overlays…", 0.1)
    evs = graphics_long.render(w, plan_.get("overlays") or [], video, fps, tag="gfx", cancelled=cancelled,
                               progress=lambda m, f: progress(m, 0.1 + 0.4 * f))
    jdump(w / "overlays.json", evs)
    W, H = size
    if W != 1920:
        progress(f"Overlays at {W}×{H}…", 0.5)
        graphics_long.render(w, plan_.get("overlays") or [], video, fps, size=(W, H), tag=f"gfx-{W}", cancelled=cancelled,
                             progress=lambda m, f: progress(m, 0.5 + 0.5 * f))
    return f"{len(plan_.get('segments') or [])} slot(s), {len(evs)} overlay(s)", usd


# ════════════════════════════ slots and the brief (pure) ════════════════════════════

def _norm(s):
    return re.sub(r"[^a-z0-9%']", "", str(s or "").lower())


def slots_of(segments, vdur, fps=30000 / 1001):
    """The plan's screencast segments → the editor's slots, with the SAME transition flags compose gives a
    recording (compose_long.screen_window: the dissolve lead, the bubble-first exit, screen→screen tails).
    Clipped to the video (an excerpt). → [{n, t0, t1, a, b, aroll_in, aroll_out, fade_in, tail, seg}]"""
    segs = []
    for s in sorted(segments or [], key=lambda s: float(s["t0"])):
        t0, t1 = max(0.0, float(s["t0"])), min(float(vdur), float(s["t1"]))
        if t1 - t0 >= 0.5:
            segs.append((t0, t1, s))
    out = []
    xf, at = compose_long.xfade_s(fps), compose_long.aroll_tail_s()
    for i, (t0, t1, s) in enumerate(segs):
        slot = {"n": i + 1, "t0": round(t0, 3), "t1": round(t1, 3), "seg": s}
        into_next = i + 1 < len(segs) and abs(segs[i + 1][0] - t1) < 0.05
        if into_next:
            slot["tail"] = xf
        elif t1 < vdur - 0.05:
            slot["tail"] = at
            slot["aroll_out"] = True
        prev = out[-1] if out else None
        if prev and prev.get("tail") and not prev.get("aroll_out") and abs(prev["t1"] - t0) < 0.05:
            slot["fade_in"] = prev["tail"]
        elif t0 > 0.05:
            slot["aroll_in"] = True
        slot["a"], slot["b"] = compose_long.screen_window(slot)
        slot["b"] = min(slot["b"], float(vdur))
        out.append(slot)
    return out


ZOOM_RE = re.compile(r"\b(?:zoom(?:ed|s)?(?: in)?|tighter(?: zoom)?|push(?:es)?(?: in)?)\s+(?:on|to|along)\s+([^;,.(]+)", re.I)


def _zoom_of(subject, body):
    s = str(subject or "")
    if s.startswith("ui:"):
        return s[3:].strip()
    if s.startswith("asset:"):
        return f"the {s[6:].strip()} picture"
    m = ZOOM_RE.search(str(body or ""))
    return m.group(1).strip() if m else ""


def _human_action(a):
    if not a:
        return ""
    if a == "camera.zoom":
        return "camera only (no click): frame it"
    if a == "outside.goto":
        return "open the public page in a logged-out US browser"
    return a.split(".", 1)[-1].replace("_", " ")


def beats_of(seg, words):
    """What the plan says lands on which word, for one segment → (preamble, [{t, cue, action, what, zoom, text,
    url}]). The plan call's schema beats ("actions") first, then the fitted beat ledger, else the intent's
    "on 'X': …" cues resolved onto the narration (old plans)."""
    pre, parsed = planfit.parse_intent(seg.get("intent"))
    body_by_cue = {_norm(p["cue"]): p["body"] for p in parsed}
    out = []
    src = seg.get("actions") or seg.get("beats") or []
    if src:
        for b in src:
            cue = b.get("cue") or ""
            what = b.get("body") or body_by_cue.get(_norm(cue)) or ""
            params = b.get("params") or {}
            out.append({"t": b.get("t_word"), "cue": cue, "action": _human_action(b.get("action")), "what": what,
                        "zoom": _zoom_of(b.get("subject"), what), "text": b.get("typed_text") or params.get("text"),
                        "url": params.get("url") or b.get("url")})
    else:
        lo = [x for x in words if float(seg.get("t0", 0)) - 1.0 <= x["start"] <= float(seg.get("t1", 1e9)) + 1.0]
        after = -1
        for p in parsed:
            k, _ = planfit.resolve_cue(p["cue"], lo, 0, len(lo), after)
            if k is not None:
                after = k
            typed = planfit.TYPED_RE.search(p["body"])
            url = planfit.URL_RE.search(p["body"])
            out.append({"t": lo[k]["start"] if k is not None else None, "cue": p["cue"], "action": "", "what": p["body"],
                        "zoom": _zoom_of(None, p["body"]), "text": typed.group(1) if typed else None,
                        "url": url.group(0).rstrip(".") if url else None})
    return pre, out


def _first_sentence(s, limit=70):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    if len(s) <= limit:
        return s
    cut = s[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


def brief_rows(slots, words, fps_num=30000, fps_den=1001, notes=()):
    """One row per slot for slots.csv / BRIEF.html: the time range, the exact words, what must be on screen,
    each beat on its word, the zoom targets, the app/URL and the rules that apply to THIS slot."""
    from .nlexml import tc_string
    fps = fps_num / fps_den
    rows = []
    for s in slots:
        seg = s["seg"]
        ws = [x for x in words if s["t0"] - 0.05 <= x["start"] < s["t1"]]
        pre, beats = beats_of(seg, words)
        clipped = float(seg.get("t1", s["t1"])) > s["t1"] + 0.05
        # a slot cut short by the video's end (an excerpt) keeps only the beats that still happen in it
        beats = [b for b in beats if (b["t"] is None and not clipped) or (b["t"] is not None and b["t"] <= s["b"])]
        url = seg.get("url") or ""
        outside = (seg.get("session") or {}).get("kind") in ("public", "outside") if isinstance(seg.get("session"), dict) \
            else seg.get("session") == "outside"
        text_all = " ".join([pre] + [b["what"] for b in beats]).lower()
        flags = []
        if outside or "pricing" in url or re.search(r"\bpric(e|es|ing)\b|\bplan card\b|\bfree plan\b", text_all):
            flags.append("Pricing")
        if re.search(r"\b(type|typed|paste|pasted|prompt)\b", text_all):
            flags.append("Prompts pasted whole")
        flags.append("Privacy")
        first = next((b["what"] for b in beats if b["what"]), pre)
        label = _first_sentence(re.sub(r"^(the|a)\s+", "", first, flags=re.I), 60) if first else (url or "screen")
        my_notes = [n for n in notes if n.get("word_ids") and any(x["i"] in n["word_ids"] for x in ws)]
        rows.append({
            "slot": s["n"], "label": label,
            "start_tc": tc_string(round(s["a"] * fps), fps_num, fps_den), "end_tc": tc_string(round(s["b"] * fps), fps_num, fps_den),
            "start_s": round(s["a"], 3), "end_s": round(s["b"], 3), "duration_s": round(s["b"] - s["a"], 2),
            "words_from_s": round(s["t0"], 3), "words_to_s": round(s["t1"], 3),
            "app": seg.get("app") or "", "url": url, "logged_out_us": bool(outside),
            "words": " ".join(x["word"] for x in ws),
            "on_screen": pre,
            "beats": [{**b, "tc": tc_string(round(b["t"] * fps), fps_num, fps_den) if b.get("t") is not None else "",
                       "word": next((x["word"] for x in ws if b.get("t") is not None and abs(x["start"] - b["t"]) < 0.02), "")}
                      for b in beats],
            "zoom": [b["zoom"] for b in beats if b.get("zoom")],
            "flags": flags,
            "enter": "dissolve from the presenter" if s.get("aroll_in") else "dissolve from the previous screencast" if s.get("fade_in") else "cut in",
            "exit": "dissolve to the presenter" if s.get("aroll_out") else "the next screencast dissolves over it" if s.get("tail") else "runs to the end",
            "notes": [n.get("why") or n.get("sentence") for n in my_notes],
        })
    return rows


def slots_csv(rows):
    f = io.StringIO()
    wr = csv.writer(f)
    wr.writerow(["slot", "start_tc", "end_tc", "start_s", "end_s", "duration_s", "app", "url", "logged_out_us_browser",
                 "words", "on_screen", "beats (time - word: action / what / typed text)", "zoom_targets", "rules", "enter", "exit"])
    for r in rows:
        beats = " | ".join(
            f"{b['tc']} '{b['cue']}': " + " / ".join(x for x in (b["action"], b["what"], f"type: {b['text']}" if b.get("text") else "",
                                                               b.get("url") or "") if x)
            for b in r["beats"])
        wr.writerow([r["slot"], r["start_tc"], r["end_tc"], r["start_s"], r["end_s"], r["duration_s"], r["app"], r["url"],
                     "yes" if r["logged_out_us"] else "no", r["words"], r["on_screen"], beats, "; ".join(r["zoom"]),
                     "; ".join(r["flags"]), r["enter"], r["exit"]])
    return f.getvalue()


def brief_html(rows, meta):
    """The editor's brief: plain language, one card per slot, printable."""
    e = html.escape
    rules = "".join(f"<li><b>{e(a)}.</b> {e(b)}</li>" for a, b in RULES)
    cards = []
    for r in rows:
        beats = "".join(
            f"<tr><td class=tc>{e(b['tc'])}</td><td>“{e(b['cue'])}”</td><td>{e(b['what'])}"
            + (f"<div class=sub>Action: {e(b['action'])}</div>" if b.get("action") else "")
            + (f"<div class=sub>Paste exactly: <code>{e(b['text'])}</code></div>" if b.get("text") else "")
            + (f"<div class=sub>Page: <code>{e(b['url'])}</code></div>" if b.get("url") else "")
            + (f"<div class=sub>Zoom on: {e(b['zoom'])}</div>" if b.get("zoom") else "")
            + "</td></tr>" for b in r["beats"])
        cards.append(f"""<section class=slot>
<h2>Screencast {r['slot']} <span>{e(r['label'])}</span></h2>
<p class=time><b>{e(r['start_tc'])} – {e(r['end_tc'])}</b> ({r['duration_s']:.1f} s) · {e(r['enter'])}, {e(r['exit'])}</p>
<p><b>App / page:</b> {e(r['app'] or '')} <code>{e(r['url'])}</code>{' — <b>logged-out browser, United States, prices in USD</b>' if r['logged_out_us'] else ''}</p>
<p><b>What he says over it:</b></p><blockquote>{e(r['words'])}</blockquote>
{f'<p><b>On screen:</b> {e(r["on_screen"])}</p>' if r['on_screen'] else ''}
{f'<table><tr><th>Time</th><th>On the word</th><th>What happens</th></tr>{beats}</table>' if beats else ''}
{('<p><b>Zoom targets:</b> ' + e('; '.join(r['zoom'])) + '</p>') if r['zoom'] else ''}
<p class=flags><b>Rules here:</b> {e(', '.join(r['flags']))}</p>
{''.join(f'<p class=note>Note: {e(n)}</p>' for n in r['notes'])}
</section>""")
    total = sum(r["duration_s"] for r in rows)
    return f"""<!doctype html>
<html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Screencast brief — {e(meta.get('title', ''))}</title>
<style>
:root{{--fg:#16181d;--muted:#5b6270;--line:#d9dde3;--accent:#2457d6;--bg:#fff;--card:#f6f7f9}}
body{{font:15px/1.5 -apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);max-width:900px;margin:0 auto;padding:24px 16px}}
h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:18px;margin:0 0 6px}} h2 span{{font-weight:400;color:var(--muted)}}
.lead{{color:var(--muted);margin:0 0 18px}} code{{background:var(--card);padding:1px 4px;border-radius:4px;word-break:break-all}}
.slot{{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0;page-break-inside:avoid}}
.time{{color:var(--accent);margin:0 0 8px}} blockquote{{margin:4px 0 10px;padding:8px 12px;background:var(--card);border-left:3px solid var(--accent);border-radius:4px}}
table{{border-collapse:collapse;width:100%;margin:6px 0}} th,td{{text-align:left;vertical-align:top;border-top:1px solid var(--line);padding:6px 8px}}
th{{font-size:12px;color:var(--muted);font-weight:600}} td.tc{{white-space:nowrap;font-variant-numeric:tabular-nums}}
.sub{{font-size:13px;color:var(--muted)}} .flags{{font-size:13px}} .note{{font-size:13px;color:#9a5b00}}
ol li{{margin:4px 0}}
</style></head><body>
<h1>Screencast brief</h1>
<p class=lead>{e(meta.get('title', ''))} · {len(rows)} screencast slot(s), {total:.0f} s in total · timeline {e(meta.get('fps_label', ''))}, {meta.get('width')}×{meta.get('height')}</p>
<p>Everything else is already edited: the presenter with his camera moves (V1), the overlays, the facecam bubble, music and sound effects. Your job is the screen recordings only. Put each one on <b>V2</b> exactly over its slot — the markers named “Screencast N” show where. <b>preview.mp4</b> shows the finished edit with a card in every slot.</p>
<h2>Rules for every slot</h2><ol>{rules}</ol>
{''.join(cards)}
</body></html>
"""


README = """HAND-OFF PACKAGE — {title}

Open in Premiere Pro:  File > Import > timeline.xml
Open in DaVinci Resolve: File > Import > Timeline > timeline.fcpxml  (or timeline.xml)
Keep this folder together: every file is referenced by a path relative to the timeline file. If your app asks
where a file is, point it to this folder once and let it find the rest.

  V1  a-roll.mov            the presenter, camera moves baked in ({w}x{h}, {fps})
  V2  (empty)               YOUR SCREENCASTS — one marker "Screencast N" per slot
  V3+ graphics/*.mov        overlays, text gradient, facecam bubble, end fade (ProRes 4444, straight alpha)
  A1  audio/voice.wav       the narration — final, do not cut it
  A2  audio/music.wav       music bed
  A3  audio/sfx.wav         sound effects
  screencasts/BRIEF.html    what to record for every slot, on which word (also slots.csv)
  preview.mp4               the whole edit with a placeholder card in every slot

{n} slot(s), {total:.0f} s of screencast in a {dur:.0f} s video.
"""


# ════════════════════════════ stage "handoff": the package ════════════════════════════

def _slug(s, n=28):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:n].strip("-") or "clip"


def _run(cmd, mounts, cancelled):
    return compose_long._run(cmd, mounts, cancelled)


def _fps_label(num, den):
    f = num / den
    return f"{f:.3f}".rstrip("0").rstrip(".") + " fps"


def _cards_text(slot_label, n, rng):
    lines = [f"SCREENCAST {n}"] + textwrap.wrap(slot_label, 34)[:3] + [rng, "The editor adds this — see screencasts/BRIEF.html"]
    return lines


def card_cmd(lines, W, H, fps, seconds, out_rel, txt_dir_rel):
    """ffmpeg (sh) that renders a labelled placeholder card: big 'SCREENCAST N', the slot's label, its time."""
    k = H / 1080
    sizes = [int(64 * k)] + [int(46 * k)] * (len(lines) - 3) + [int(30 * k), int(26 * k)]
    gap = int(22 * k)
    heights = [s + gap for s in sizes]
    y = (H - sum(heights)) // 2
    draws = []
    for i, (ln, sz) in enumerate(zip(lines, sizes)):
        col = "0x7aa2ff" if i == 0 else "white" if i < len(lines) - 2 else "0xaab3c0"
        draws.append(f"drawtext=fontfile=$F:textfile={txt_dir_rel}/l{i}.txt:fontsize={sz}:fontcolor={col}:"
                     f"x=(w-text_w)/2:y={y}")
        y += heights[i]
    bw = max(4, int(6 * k))
    vf = (f"drawbox=x={bw * 4}:y={bw * 4}:w=iw-{bw * 8}:h=ih-{bw * 8}:color=0x7aa2ff@0.55:t={bw}," + ",".join(draws)
          + ",format=yuv420p")
    return (f"ffmpeg -v error -y -f lavfi -i color=c={CARD_BG}:s={W}x{H}:r={fps:.6f}:d={seconds:.4f} -vf \"{vf}\" "
            f"-c:v libx264 -preset veryfast -tune stillimage -crf 20 -an -movflags +faststart {out_rel}")


def _write_lines(dirp, lines):
    dirp.mkdir(parents=True, exist_ok=True)
    for i, ln in enumerate(lines):
        # drawtext textfile: a literal file, no escaping needed (a % would be expanded: doubled)
        (dirp / f"l{i}.txt").write_text(ln.replace("%", "%%"))


def _alloc_tracks(clips):
    """Greedy: clips sorted by start, each on the first track whose last clip ended → [[clip, ...], ...]."""
    tracks = []
    for c in sorted(clips, key=lambda c: c["start"]):
        for t in tracks:
            if t[-1]["start"] + t[-1]["frames"] <= c["start"]:
                t.append(c)
                break
        else:
            tracks.append([c])
    return tracks


def _abut(clips):
    """Clips of one track that may be trimmed (bubbles, placeholders): end each where the next starts."""
    cs = sorted(clips, key=lambda c: c["start"])
    for a, b in zip(cs, cs[1:]):
        if a["start"] + a["frames"] > b["start"]:
            a["frames"] = max(1, b["start"] - a["start"])
    return cs


def timeline_model(name, fps_num, fps_den, W, H, total, aroll_frames, graphics, slots_tl, placeholders, audio_frames):
    """The neutral timeline nlexml writes: V1 A-roll, V2 screencasts (empty; placeholders disabled for FCPXML),
    V3 text gradient, V4+ overlays, then the facecam bubble and the end fade; A1 voice, A2 music, A3 SFX."""
    by = {}
    for g in graphics:
        by.setdefault(g["group"], []).append(g)
    video = [{"name": "A-roll", "clips": [{"name": "a-roll", "file": "a-roll.mov", "start": 0, "frames": aroll_frames,
                                            "media_frames": aroll_frames}]},
             {"name": "Screencasts (editor)", "clips": []}]
    for grp in ("gradient", "overlay", "bubble", "fade"):
        cs = by.get(grp) or []
        if not cs:
            continue
        if grp in ("bubble",):
            video.append({"name": grp, "clips": _abut(cs)})
        else:
            for n, t in enumerate(_alloc_tracks(cs)):
                video.append({"name": grp + (f" {n + 1}" if n else ""), "clips": t})
    audio = [{"name": "Voice", "clips": [{"name": "voice", "file": "audio/voice.wav", "start": 0, "frames": audio_frames,
                                          "media_frames": audio_frames, "role": "dialogue"}]},
             {"name": "Music", "clips": [{"name": "music", "file": "audio/music.wav", "start": 0, "frames": audio_frames,
                                          "media_frames": audio_frames, "role": "music"}]},
             {"name": "SFX", "clips": [{"name": "sfx", "file": "audio/sfx.wav", "start": 0, "frames": audio_frames,
                                        "media_frames": audio_frames, "role": "effects"}]}]
    markers = [{"frame": s["start"], "frames": s["frames"], "name": f"Screencast {s['n']} — {s['label']}",
                "note": s.get("note", "")} for s in slots_tl]
    tl = {"name": name, "fps_num": fps_num, "fps_den": fps_den, "width": W, "height": H, "frames": total,
          "video": video, "audio": audio, "markers": markers}
    fcp = json.loads(json.dumps(tl))
    fcp["video"][1]["clips"] = _abut([{**p, "enabled": False} for p in placeholders])
    return tl, fcp


def build(d, k, v, fps, info, cancelled=lambda: False, progress=lambda m, f=None: None, log=print, room_tone_start=0.0,
          workers=None, aroll_codec="h264", preview=True, keep_work=False):
    """The hand-off package of video k → {"dir", "zip", "files": {path: bytes}, "slots", "frames", "note"}."""
    from . import nlexml
    d = Path(d)
    w = d / f"edit-{k:02d}"
    pkg = d / PKG.format(k=k)
    W, H = int(info["width"]), int(info["height"])
    e = jload(d / "edl.json") or {}
    fps_num, fps_den = int(e.get("fps_num") or info.get("fps_num") or round(fps * 1000)), int(e.get("fps_den") or info.get("fps_den") or 1000)
    doc = jload(w / "direct.json")
    if not doc:
        raise RuntimeError(f"edit {k} has no plan (edit-{k:02d}/direct.json) — the graphics stage makes it")
    plan_ = doc["plan"]
    video = {"title": v.get("title", ""), "duration": v["duration"], "words": v["words"]}
    work = w / "handoff-work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    tmp_pkg = d / (PKG.format(k=k) + ".part")
    shutil.rmtree(tmp_pkg, ignore_errors=True)
    for sub in ("graphics", "audio", "screencasts/placeholders"):
        (tmp_pkg / sub).mkdir(parents=True, exist_ok=True)
    need = 3 * v["duration"] * longedit_mbps(W) / 8 * 1e6 + 2e9
    free = shutil.disk_usage(d).free
    if free < need:
        raise RuntimeError(f"not enough disk for the hand-off package: {free / 1e9:.1f} GB free, needs about {need / 1e9:.0f} GB")
    F = lambda t: int(round(t * fps))

    # 1 the cut at source resolution (the edited timeline as it is — no cut, no pause trimmed)
    cut = f"handoff-cut-{k:02d}"
    progress(f"The cut at {W}×{H}…", 0.02)
    try:
        render.render(d, v, fps, cut, f"{W}:{H}", crf=14, preset="medium", cancelled=cancelled,
                      room_tone_start=room_tone_start, direct=True,
                      progress=lambda f: progress(f"The cut at {W}×{H}…", 0.02 + 0.18 * f))
    except render.RenderCancelled:
        raise InterruptedError()
    vdur = media.probe(d / f"{cut}.mp4")["duration"]
    end_fade = max((x["end"] for x in video["words"]), default=None)
    f_st, fd, out_dur, total = compose_long._end_fade(vdur, end_fade, fps)

    # 2 the slots (the plan's screencast segments, with compose's transition flags) and the A-roll blocks
    slots = slots_of(plan_.get("segments") or [], vdur, fps)
    blocks, t = [], 0.0
    for s in slots:
        if s["t0"] > t:
            blocks.append([t, s["t0"]])
        t = s["t1"]
    if t < vdur:
        blocks.append([t, vdur])
    events = [x for x in jload(w / "overlays.json", []) if x.get("start_frame", 0) < F(vdur)]
    graphics_long.repair_frame_names(w / "gfx", events)
    gfx_pkg = "gfx" if W == 1920 else f"gfx-{W}"
    pev = [{kk: vv for kk, vv in x.items() if kk != "n_frames"} for x in events]     # the preview's (1920) frames
    compose_long.count_frames(w, events, gfx_pkg)

    # 3 the presenter's face (bubble crop + A-roll push anchor) and the A-roll camera, baked in
    face_p = d / "face.json"
    if not face_p.exists():
        longedit._docker(["python3", "/a/screencast/facecam.py", "face", f"/j/{cut}.mp4", "/j/face.json", "--samples", "20"],
                         [(config.CODE, "/a"), (d, "/j")], cancelled, "aieditor-face")
    face = jload(face_p)["face"]
    jdump(w / "handoff-blocks.json", {"blocks": blocks, "fps": fps, "words": video["words"],
                                      "overlays": [{"template": o.get("template"), "t0": o["t0"], "t1": o["t1"]}
                                                   for o in plan_.get("overlays") or []]})
    progress("A-roll camera (opening zoom, slow push-ins, end fade)…", 0.22)
    anchor = f"{(face[0] + face[2] / 2) * W:.1f},{(face[1] + face[3] * 0.8) * H:.1f}"
    cam = f"handoff-aroll-{W}.mp4"
    longedit._docker(["python3", "/a/screencast/aroll_camera.py", f"/j/{cut}.mp4", f"/w/{cam}", "/w/handoff-blocks.json",
                      "--anchor", anchor], [(config.CODE, "/a"), (d, "/j"), (w, "/w")], cancelled, "aieditor-aroll")
    aroll_frames = int(round(media.probe(w / cam)["duration"] * fps))
    # the camera pass writes its rate as a decimal (29.970030 → 979001/32666): the package says exactly
    # fps_num/fps_den, so Premiere / Resolve conform nothing (H.264 re-muxed through Annex B, no re-encode)
    rate = f"{fps_num}/{fps_den}"
    if aroll_codec == "prores":
        _run(f"ffmpeg -v error -y -i /w/{cam} -map 0:v -r {rate} -c:v prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le "
             f"-an /p/a-roll.mov", [(w, "/w"), (tmp_pkg, "/p")], cancelled)
    else:
        _run(f"ffmpeg -v error -y -i /w/{cam} -map 0:v -c:v copy -bsf:v h264_mp4toannexb -f h264 /w/handoff-work/aroll.h264 && "
             f"ffmpeg -v error -y -framerate {rate} -i /w/handoff-work/aroll.h264 -c:v copy -video_track_timescale {fps_num} "
             f"-movflags +faststart /p/a-roll.mov && rm -f /w/handoff-work/aroll.h264", [(w, "/w"), (tmp_pkg, "/p")], cancelled)

    # 4 the graphics, ProRes 4444 with alpha, full frame, each at its own time
    progress("Graphics: overlays, text gradient, facecam bubble, end fade (ProRes 4444)…", 0.4)
    fdir, side = compose_long.bubble_assets(w, W, H)
    gname = compose_long.gradient_png(w, W, H) if compose_long.gradient_spans(events, fps) else None
    gfx = []                                       # {group, name, file, start, frames, alpha}
    for ev in events:
        n = ev.get("n_frames") or 0
        if not n:
            continue
        n = min(n, total - ev["start_frame"])
        gfx.append({"group": "overlay", "kind": "overlay", "ev": ev, "start": ev["start_frame"], "frames": n,
                    "label": f"{ev.get('template')}-{_slug(' '.join(str(x) for x in (ev.get('fields') or {}).values() if isinstance(x, str)) or ev.get('template'), 22)}"})
    for a, b in compose_long.gradient_spans(events, fps):
        if a < vdur:
            gfx.append({"group": "gradient", "kind": "gradient", "start": F(a), "frames": max(1, min(F(b), total) - F(a)),
                        "span": (a, b), "label": "text-gradient"})
    for s in slots:
        gfx.append({"group": "bubble", "kind": "bubble", "slot": s, "start": F(s["a"]), "frames": max(1, F(s["b"]) - F(s["a"])),
                    "label": f"facecam-bubble-slot{s['n']:02d}"})
    if total - F(f_st) > 0:
        gfx.append({"group": "fade", "kind": "fade", "start": F(f_st), "frames": total - F(f_st), "label": "end-fade"})
    gfx.sort(key=lambda g: (g["start"], g["group"]))
    P = compose_long.FACECAM
    kx = W / 1920
    dv = int(round(P["video_d"] * kx)) // 2 * 2
    bx = int(round(P["centre"][0] * kx - side / 2))
    by = int(round(P["centre"][1] * kx - side / 2))
    fx, fy, fw, fh = face[0] * W, face[1] * H, face[2] * W, face[3] * H
    sq = int(round(P["crop_px"] * kx)) // 2 * 2
    sx = int(min(max(0, fx + fw / 2 - sq / 2), W - sq)) // 2 * 2
    sy = int(min(max(0, fy + fh * 0.62 - sq / 2), H - sq)) // 2 * 2
    f4 = compose_long._f(compose_long.AROLL_BUBBLE_F)
    for i, g in enumerate(gfx, 1):
        if cancelled():
            raise InterruptedError()
        g["name"] = f"{i:02d}-{g['label']}"
        g["file"] = f"graphics/{g['name']}.mov"
        out = f"/p/{g['file']}"
        L = g["frames"] / fps
        progress(f"Graphic {i} of {len(gfx)}: {g['label']}…", 0.4 + 0.25 * (i - 1) / max(1, len(gfx)))
        if g["kind"] == "overlay":
            ev = g["ev"]
            _run(f"ffmpeg -v error -y -framerate {fps:.8f} -start_number {ev['start_frame']} -i /g/{ev['frames_dir']}/f%05d.png "
                 f"-frames:v {g['frames']} -vf format=rgba {PRORES_4444} {out}", [(w / gfx_pkg, "/g"), (tmp_pkg, "/p")], cancelled)
        elif g["kind"] == "gradient":
            G = compose_long.TEXT_GRADIENT
            a, b = g["span"]
            dd = b - a
            fo = min(compose_long._f(G["out_f"]), dd / 3)
            _run(f"ffmpeg -v error -y -loop 1 -framerate {fps:.8f} -i /w/{gname} -frames:v {g['frames']} "
                 f"-vf \"format=rgba,fade=t=in:st=0:d={min(compose_long._f(G['in_f']), dd / 2):.4f}:alpha=1,"
                 f"fade=t=out:st={dd - fo:.4f}:d={fo:.4f}:alpha=1\" {PRORES_4444} {out}", [(w, "/w"), (tmp_pkg, "/p")], cancelled)
        elif g["kind"] == "bubble":
            s = g["slot"]
            fades = []
            if s.get("aroll_in"):
                fades.append(f"fade=t=in:st={f4:.4f}:d={f4:.4f}:alpha=1")
            if s.get("aroll_out"):
                fades.append(f"fade=t=out:st={max(0.0, L - 2 * f4):.4f}:d={f4:.4f}:alpha=1")
            fz = ("," + ",".join(fades)) if fades else ""
            off_px = (side - dv) // 2
            fc = (f"[0:v]setpts=PTS-STARTPTS,crop={sq}:{sq}:{sx}:{sy},scale={dv}:{dv}:flags=lanczos,format=rgba,"
                  f"pad={side}:{side}:{off_px}:{off_px}:color=black@0[fv];[1:v]format=gray[fm];[fv][fm]alphamerge[fd];"
                  f"[2:v]format=rgba[ring];[fd][ring]overlay=shortest=1:format=auto,format=rgba{fz}[bub];"
                  f"color=c=black@0.0:s={W}x{H}:r={fps:.8f}:d={L + 1:.4f},format=rgba[bg];"
                  f"[bg][bub]overlay={bx}:{by}:format=auto:eof_action=pass[v]")
            (work / f"bubble-{s['n']:02d}.txt").write_text(fc)
            _run(f"ffmpeg -v error -y -ss {s['a']:.6f} -t {L + 0.5:.6f} -i /j/{cut}.mp4 -loop 1 -i /fc/mask.png -loop 1 -i /fc/ring.png "
                 f"-filter_complex_script /w/handoff-work/bubble-{s['n']:02d}.txt -map [v] -frames:v {g['frames']} "
                 f"{PRORES_4444} {out}", [(d, "/j"), (w, "/w"), (fdir, "/fc"), (tmp_pkg, "/p")], cancelled)
        else:
            _run(f"ffmpeg -v error -y -f lavfi -i color=c=black:s={W}x{H}:r={fps:.8f}:d={L + 0.5:.4f} -frames:v {g['frames']} "
                 f"-vf \"format=rgba,fade=t=in:st=0:d={fd:.4f}:alpha=1\" {PRORES_4444} {out}", [(tmp_pkg, "/p")], cancelled)

    # 5 the sound, as stems from 0 (voice / music bed / SFX), the sequence's length each
    progress("Audio stems: voice, music, SFX…", 0.66)
    music = longedit.pick_music(d / f"{cut}.mp4")
    out_dur = total / fps                          # every stem is exactly the sequence's length
    lines = [f"ffmpeg -v error -y -i /j/{cut}.mp4 -vn -af aresample=48000,apad -t {out_dur:.6f} -ac 2 -c:a pcm_s24le /p/audio/voice.wav"]
    mounts = [(d, "/j"), (tmp_pkg, "/p"), (sfx.LIB, "/sfx")]
    if music:
        fo = music.get("fade_out", 1.0)
        lines.append(f"ffmpeg -v error -y -stream_loop -1 -i '/music/{Path(music['path']).name}' -vn "
                     f"-af \"aresample=48000,atrim=0:{vdur:.3f},asetpts=PTS-STARTPTS,volume={music['gain_db']:.1f}dB,"
                     f"afade=t=in:d={music.get('fade_in', 1.0)},afade=t=out:st={max(0, vdur - fo):.3f}:d={fo},apad\" "
                     f"-t {out_dur:.6f} -ac 2 -c:a pcm_s24le /p/audio/music.wav")
        mounts.append((Path(music["path"]).parent, "/music"))
    else:
        lines.append(f"ffmpeg -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t {out_dur:.6f} -c:a pcm_s24le /p/audio/music.wav")
    s_ins, s_graph = sfx.filter_for(events, 1)
    (work / "sfx.txt").write_text(s_graph.replace("[aout]", "[amx]") + ";[amx]aformat=channel_layouts=stereo,apad[aout]")
    lines.append(f"ffmpeg -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo {' '.join(s_ins)} "
                 f"-filter_complex_script /w/handoff-work/sfx.txt -map [aout] -t {out_dur:.6f} -ac 2 -c:a pcm_s24le /p/audio/sfx.wav")
    _run(" && ".join(lines), mounts + [(w, "/w")], cancelled)
    audio_frames = total

    # 6 the brief + the placeholder cards
    progress("The screencast brief…", 0.7)
    pdoc = jload(d / "preprod" / "plan.json") or {}
    rows = brief_rows(slots, video["words"], fps_num, fps_den, notes=pdoc.get("editor_notes") or [])
    for s, r in zip(slots, rows):
        s["label"] = r["label"]
    meta = {"title": v.get("title") or (jload(d / "request.json") or {}).get("title") or d.name, "width": W, "height": H,
            "fps_label": _fps_label(fps_num, fps_den)}
    (tmp_pkg / "screencasts" / "slots.csv").write_text(slots_csv(rows))
    (tmp_pkg / "screencasts" / "BRIEF.html").write_text(brief_html(rows, meta))
    jdump(tmp_pkg / "screencasts" / "slots.json", [{kk: vv for kk, vv in r.items()} for r in rows])
    placeholders = []
    for s in slots:
        lines_ = _cards_text(s["label"], s["n"], f"{rows[s['n'] - 1]['start_tc']} – {rows[s['n'] - 1]['end_tc']}")
        _write_lines(work / f"card-{s['n']:02d}", lines_)
        frames = max(1, F(s["b"]) - F(s["a"]))
        rel = f"screencasts/placeholders/slot-{s['n']:02d}.mp4"
        _run(FONT + "; " + card_cmd(lines_, W, H, fps, frames / fps + 0.2, f"/p/{rel}", f"/w/handoff-work/card-{s['n']:02d}"),
             [(tmp_pkg, "/p"), (w, "/w")], cancelled)
        placeholders.append({"name": f"slot-{s['n']:02d} placeholder", "file": rel, "start": F(s["a"]), "frames": frames,
                             "media_frames": frames})

    # 7 the timelines
    progress("Timelines (Premiere XML + FCPXML)…", 0.72)
    clips = [{"group": g["group"], "name": g["name"], "file": g["file"], "start": g["start"], "frames": g["frames"],
              "media_frames": g["frames"], "alpha": True} for g in gfx]
    slots_tl = [{"n": s["n"], "label": s["label"], "start": F(s["a"]), "frames": max(1, F(s["b"]) - F(s["a"])),
                 "note": "; ".join(f"{b['tc']} {b['cue']}: {b['what']}" for b in rows[s['n'] - 1]["beats"])[:900]} for s in slots]
    name = f"{meta['title']} — hand-off"
    tl, tl_fcp = timeline_model(name, fps_num, fps_den, W, H, total, min(aroll_frames, total), clips, slots_tl,
                                placeholders, audio_frames)
    probs = nlexml.check(tl) + nlexml.check(tl_fcp)
    xm, fx_ = nlexml.xmeml(tl), nlexml.fcpxml(tl_fcp)
    probs += nlexml.validate_xmeml(xm) + nlexml.validate_fcpxml(fx_)
    if probs:
        raise RuntimeError("hand-off timeline check failed: " + "; ".join(probs[:8]))
    (tmp_pkg / "timeline.xml").write_text(xm)
    (tmp_pkg / "timeline.fcpxml").write_text(fx_)
    (tmp_pkg / "README.txt").write_text(README.format(title=meta["title"], w=W, h=H, fps=meta["fps_label"], n=len(slots),
                                                      total=sum(r["duration_s"] for r in rows), dur=out_dur))

    # 8 the preview: the whole edit (compose_long, the production graph) with a labelled card in every slot
    if preview:
        progress("Preview with placeholder cards…", 0.75)
        pw, ph = (int(x) for x in render.preview_size(W, H).split(":"))
        base, bub = cam, f"handoff-plain-{pw}.mp4"
        (w / bub).unlink(missing_ok=True)
        if (pw, ph) == (W, H):
            os.link(d / f"{cut}.mp4", w / bub)
        else:
            base = f"handoff-aroll-{pw}.mp4"
            _run(f"ffmpeg -v error -y -i /w/{cam} -vf scale={pw}:{ph}:flags=lanczos -c:v libx264 -preset veryfast -crf 18 "
                 f"-an /w/{base} && ffmpeg -v error -y -i /j/{cut}.mp4 -vf scale={pw}:{ph}:flags=lanczos -c:v libx264 "
                 f"-preset veryfast -crf 18 -c:a copy /w/{bub}", [(w, "/w"), (d, "/j")], cancelled)
        segs = []
        for s in slots:
            seconds = s["t1"] - s["t0"] + float(s.get("tail") or 0) + 0.3
            lines_ = _cards_text(s["label"], s["n"], f"{rows[s['n'] - 1]['start_tc']} – {rows[s['n'] - 1]['end_tc']}")
            clip = f"handoff-work/card-{s['n']:02d}-{pw}.mp4"
            _run(FONT + "; " + card_cmd(lines_, pw, ph, fps, seconds, f"/w/{clip}", f"/w/handoff-work/card-{s['n']:02d}"),
                 [(w, "/w")], cancelled)
            segs.append({k2: s[k2] for k2 in ("t0", "t1", "aroll_in", "aroll_out", "fade_in", "tail") if k2 in s}
                        | {"clip": clip, "bubble": True, "bubble_hide": [], "i": s["n"] - 1})
        compose_long.count_frames(w, pev, "gfx")
        cuts = (jload(w / f"{cam}.cuts.json") or {}).get("cuts") or []
        chunks = compose_long.plan_chunks({"blocks": blocks, "words": video["words"], "fps": fps}, segs, pev, cuts, fps,
                                          media.probe(w / base)["duration"], end_fade)
        compose_long.composite_chunked(w, base, segs, pev, music, "handoff-preview", (pw, ph), fps, face, chunks, cancelled,
                                       20, "veryfast", bub, "gfx", end_fade, workers,
                                       log=lambda m: ev_log.emit("log", m))
        os.replace(w / "handoff-preview.mp4", tmp_pkg / "preview.mp4")
        shutil.rmtree(w / "chunks-handoff-preview", ignore_errors=True)
        (w / "handoff-preview.chunks.json").unlink(missing_ok=True)
        (w / bub).unlink(missing_ok=True)

    # 9 swap the finished folder in, then the zip (stored: the media is compressed already)
    progress("Packing the zip…", 0.95)
    shutil.rmtree(pkg, ignore_errors=True)
    os.replace(tmp_pkg, pkg)
    zp = d / f"{PKG.format(k=k)}.zip"
    zpart = d / f"{PKG.format(k=k)}.zip.part"
    with zipfile.ZipFile(zpart, "w", allowZip64=True) as z:
        for f in sorted(pkg.rglob("*")):
            if f.is_file():
                comp = zipfile.ZIP_DEFLATED if f.suffix in (".xml", ".fcpxml", ".html", ".csv", ".json", ".txt") else zipfile.ZIP_STORED
                z.write(f, f"{pkg.name}/{f.relative_to(pkg)}", compress_type=comp)
    os.replace(zpart, zp)
    if preview:
        pv = d / f"preview-{k:02d}.mp4"            # the Lab's player opens on it
        pv.unlink(missing_ok=True)
        os.link(pkg / "preview.mp4", pv)
    files = {str(f.relative_to(pkg)): f.stat().st_size for f in sorted(pkg.rglob("*")) if f.is_file()}
    summary = {"dir": pkg.name, "zip": zp.name, "zip_bytes": zp.stat().st_size, "files": files, "frames": total,
               "fps": [fps_num, fps_den], "size": [W, H], "slots": [{"n": r["slot"], "start_tc": r["start_tc"], "end_tc": r["end_tc"],
                                                                     "label": r["label"]} for r in rows],
               "graphics": len(gfx), "built_at": time.time()}
    jdump(d / f"{PKG.format(k=k)}.json", summary)
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
        (d / f"{cut}.mp4").unlink(missing_ok=True)
        for x in w.glob(f"handoff-aroll-*.mp4"):
            x.unlink()
    note = (f"{len(slots)} slot(s) for the editor, {len(gfx)} graphic(s), zip {zp.stat().st_size / 1e9:.2f} GB")
    log(f"hand-off package {pkg.name}: {note}")
    return {**summary, "note": note}


def longedit_mbps(W):
    """Disk budget per second of package (A-roll + ProRes graphics + stems + preview), Mbit/s."""
    return 160 if W > 1920 else 60
