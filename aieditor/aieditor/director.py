"""Long-form DIRECTOR: the whole edit plan for a 16:9 narration video — which spans become
SCREENCASTS (recorded live, camera-zoomed, presenter in the bubble) and which A-roll
moments carry text/CTA graphics. Then, per screencast, a RECORDING SCRIPT written against
the real page (inventory + screenshot), timed so each action lands on its spoken word.

Look + pacing = reference 2 (kwysV2smgfY, Jake's own screencast tutorial): A-roll stretches
~6–12 s, screencast stretches ~15–35 s, hard cuts, graphics on the A-roll only, no
captions. Claude decides WHAT and WHERE (word ids); every motion comes from the measured
keyframes. Nothing is invented: a screencast shows only pages from the job's `sites`.
"""
import base64
import json
import re
import time
import urllib.request

from . import config

MODEL = config.TAKES_MODEL
PRIORITY = {"link": 2, "subscribe": 2, "lower_title": 2, "socials": 2}
LEAD_S = 0.2

OVERLAYS = """OVERLAY TEMPLATES (on the A-roll only — never while a screencast is on):
- lower_title: white text, lower centre, 1-2 short lines (<= 5 words each). For the intro ("Hey everyone / welcome back to the channel", "I'm Jake Dawson") and a section's opening line. fields: line1, line2 (may be "").
- link: the "Link in the description" caption — ONLY when the speaker points to a link/description. fields: text (default "Link in the description").
- subscribe: the animated SUBSCRIBE → SUBSCRIBED button — ONLY when the speaker asks to subscribe. fields: {}.
- socials: TikTok + Instagram icons — ONLY when the speaker mentions following on those. fields: {}.
- keyword: 1-2 lines of a punchy phrase the speaker SAYS (line1 white, line2 accent). For the hook and real punchlines only. fields: line1, line2.
- list: 2-4 short items the speaker enumerates (each 1-4 words), anchored on the first item. fields: items.
- number: a figure the speaker SAYS. fields: label, value, prefix, suffix."""

SYSTEM = """You are the video editor for Jake Dawson's YouTube tutorials (AI tools for business owners).
You get an already-cut talking-head narration as numbered words with times, plus the websites
the video is about. You decide where the edit cuts to SCREENCASTS of those websites and where
text graphics go. Return ONLY JSON."""


def build_prompt(video, sites, sponsored, knowledge=None):
    access_rule = (
        "We are LOGGED IN to the app (the UX Scout's account), so every screen the speaker describes can be "
        "shown for real — inside the app, not the marketing site. A walkthrough of the app is below; plan "
        "screencasts for every stretch where he describes, shows or walks through the product."
        if knowledge else
        "If the speaker refers to screens that need an account (inside the app after logging in), show the "
        "closest PUBLIC page that honestly matches and say so in \"intent\" — never pretend.")
    walkthrough = ("APP WALKTHROUGH (UX Scout report — what exists and where):\n" + knowledge[:14000] + "\n") if knowledge else ""
    words = " ".join(f'{w["i"]}:{w["word"]}@{w["start"]:.1f}' for w in video["words"])
    site_lines = "\n".join(f"- {s['url']}  ({s.get('note', '')})" for s in sites) or \
        "(none were given for this video — plan NO screencasts, overlays only)"
    return f"""{OVERLAYS}

SCREENCASTS
A screencast segment replaces the A-roll picture (the voice continues; the presenter shows in a
small circle). Use one whenever the speaker describes, shows or walks through something on a
website: the product, a page, a button, a form, pricing. Only these sites can be recorded:
{site_lines}
For each segment give "url" (one of the sites or a page under it) and "intent": a short plain
description of what the viewer should see happening, in order, tied to the words (e.g. "the home
page hero; then the cursor moves to Log in at the top right and clicks it as he says 'login'").
{access_rule}
THE OPENING (Jake 2026-10-06, and reference 2 does it): the first minute shows THE RESULT of the
video — the finished thing the viewer will be able to make (the generated designs/campaign/output) —
so people understand what they get by watching. While he describes what he made or what the viewer
will make, the screen shows that finished result, from the very first words. The first two minutes
are MOSTLY screencast: A-roll only for his welcome/name, the subscribe ask and the link line.

INTENT = BEATS (the recording agent follows it literally): write each segment's "intent" as beats
tied to his words — "on '<word>': <what fills the screen>" — about one beat per 4-6 s, each a calm
screen (a page, a panel, a design, a form being typed into), never several tiny targets at once.
Only ask for what EXISTS in the account (the walkthrough and the page list below) or what the
segment itself makes on screen — never a document/brand/campaign that is not there. Logged in,
screencasts use the APP's address; the marketing site only when he says to go to the website.

RULES
1. Pacing like the reference (Jake's own tutorial): about three quarters of a tutorial is screencast.
   A-roll stretches 6-12 s (his intro, the subscribe/link asks, opinions, transitions), screencast
   stretches 15-35 s or longer while he walks through steps.
2. Segments: "start"/"end" = word ids (the segment starts slightly before "start" and ends after
   "end"). Never overlap; at least 3 s of A-roll between two screencasts.
3. Overlays sit on A-roll only, one at a time, 1.5-4.5 s, >= 0.6 s apart. Text must be what is said.
4. Do not cover the first word or the last 1.5 s with an overlay unless it is a link/subscribe.
5. The presenter's own moments stay A-ROLL: the welcome/intro, the subscribe ask, the "link in the
   description" line and the sign-off — put their overlays there, never a screencast over them.
{"6. SPONSORED video: no claims beyond what is said." if sponsored else ""}

{walkthrough}
TRANSCRIPT (id:word@seconds) — "{video['title']}", {video['duration']:.1f} s:
{words}

Return {{"segments": [{{"start": <id>, "end": <id>, "url": "...", "intent": "..."}}],
 "overlays": [{{"template": "...", "start": <id>, "end": <id>, "fields": {{...}}, "why": "<6-12 words>"}}]}}"""


def call(content, system, max_tokens=24000, effort="high"):
    key = config.env_key("ANTHROPIC_API_KEY")
    body = {"model": MODEL, "max_tokens": max_tokens, "thinking": {"type": "adaptive"},
            "output_config": {"effort": effort}, "system": system,
            "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                          "content-type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        res = json.load(r)
    text = "".join(b.get("text", "") for b in res["content"] if b["type"] == "text")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError("Claude returned no JSON")
    u = res.get("usage", {})
    usd = u.get("input_tokens", 0) * 4e-6 + u.get("output_tokens", 0) * 20e-6
    return json.loads(m.group(0)), {"usd": round(usd, 4), "seconds": round(time.time() - t0)}


def validate(plan, video, sites):
    ids = {w["i"]: w for w in video["words"]}
    order = [w["i"] for w in video["words"]]
    pos = {i: n for n, i in enumerate(order)}
    dur = video["duration"]
    hosts = [".".join(re.sub(r"^https?://(www\.)?", "", s["url"]).split("/")[0].split(".")[-2:]) for s in sites]
    # the presenter's own moments stay A-roll (rule 5 — Claude does not always keep it):
    # a spoken "subscribe", "link … description", "I'm Jake Dawson"
    norm = [re.sub(r"[^a-z]", "", w["word"].lower()) for w in video["words"]]
    keep_out = []
    for i, n in enumerate(norm):
        w = video["words"][i]
        # windows = what those graphics really occupy (graphics_long / recipes2): the link slide
        # runs 69 f (2.3 s) from "link"; the subscribe button appears ~2.4 s before its click
        if n in ("subscribe", "subscribed"):
            keep_out.append((w["start"] - 2.8, w["end"] + 2.6))
        elif n in ("link", "links") and "description" in norm[i:i + 12]:
            keep_out.append((w["start"] - 0.6, w["start"] + 2.6))
        elif n == "dawson" and i and norm[i - 1] == "jake":
            keep_out.append((w["start"] - 1.5, w["end"] + 1.2))
        elif n == "welcome" and norm[i + 1:i + 2] == ["back"]:
            # "Hey everyone, welcome back to the channel" — the welcome title starts on "hey"
            hey = next((video["words"][j] for j in range(max(0, i - 3), i) if norm[j] in ("hey", "hi", "hello")), w)
            keep_out.append((hey["start"] - 0.6, w["end"] + 1.5))
    segs, dropped, last = [], [], -1e9
    for s in sorted(plan.get("segments", []), key=lambda s: pos.get(s.get("start"), 1e9)):
        a, b = s.get("start"), s.get("end")
        why = None
        if a not in ids or b not in ids or pos[b] < pos[a]:
            why = "word ids not in this cut"
        elif not any(h and h in str(s.get("url", "")) for h in hosts):
            why = "url is not one of the job's sites"
        if why is None:
            t0 = max(0.0, ids[a]["start"] - 0.25)
            t1 = min(dur, ids[b]["end"] + 0.35)
            for a, b in keep_out:
                if t0 < b and a < t1:
                    if a - t0 >= 3.0:
                        t1 = a                     # end the screencast before the moment
                    elif t1 - b >= 3.0:
                        t0 = b                     # or start it after
                    else:
                        why = "covers a presenter moment (subscribe / link / name)"
            if why is None and t1 - t0 < 2.5:
                why = "shorter than 2.5 s"
            elif t0 < last + 3.0:
                why = "less than 3 s of A-roll after the previous screencast"
        if why:
            dropped.append({**s, "dropped": why})
            continue
        segs.append({**s, "t0": round(t0, 3), "t1": round(t1, 3)})
        last = t1
    ovs, last_end = [], -1e9
    for ev in sorted(plan.get("overlays", []), key=lambda e: pos.get(e.get("start"), 1e9)):
        a, b, t = ev.get("start"), ev.get("end"), ev.get("template")
        why = None
        if t not in ("lower_title", "link", "subscribe", "socials", "keyword", "list", "number"):
            why = f"unknown template {t}"
        elif a not in ids or b not in ids or pos[b] < pos[a]:
            why = "word ids not in this cut"
        if why is None:
            t0 = max(0.0, ids[a]["start"] - LEAD_S)
            t1 = min(max(ids[b]["end"] + 0.1, t0 + 1.5), t0 + (6.0 if t in ("list", "subscribe", "socials") else 4.5))
            span = [ids[i] for i in order[pos[a]:pos[b] + 1]]
            hit = lambda *ks: next((w for w in span if re.sub(r"[^a-z]", "", w["word"].lower()) in ks), None)
            if t == "link" and hit("link", "links"):
                t0, t1 = hit("link", "links")["start"] - 0.05, hit("link", "links")["start"] + 2.35
            elif t == "subscribe" and hit("subscribe", "subscribed"):
                w_ = hit("subscribe", "subscribed")
                t0, t1 = max(0.0, w_["start"] - 2.45), max(w_["end"] + 2.3, t1)
            if any(s["t0"] - 0.2 < t1 and t0 < s["t1"] + 0.2 for s in segs):
                why = "overlaps a screencast"
            elif t0 < last_end + 0.6:
                # the presenter's own moments win over a decorative keyword/list/number
                prev = ovs[-1] if ovs else None
                if prev and PRIORITY.get(t, 0) > PRIORITY.get(prev["template"], 0):
                    dropped.append({**ovs.pop(), "dropped": f"gave way to {t}"})
                    last_end = ovs[-1]["t1"] if ovs else -1e9
                    if t0 < last_end + 0.6:
                        why = "overlaps the previous overlay"
                else:
                    why = "overlaps the previous overlay"
        if why:
            dropped.append({**ev, "dropped": why})
            continue
        ovs.append({**ev, "t0": round(t0, 3), "t1": round(t1, 3)})
        last_end = t1
    return {"segments": segs, "overlays": ovs, "dropped": dropped}


def plan(video, sites, sponsored, knowledge=None):
    raw, meta = call(build_prompt(video, sites, sponsored, knowledge), SYSTEM)
    return validate(raw, video, sites), raw, meta


# ── recording scripts ─────────────────────────────────────────────────────────
SCRIPT_SYSTEM = """You direct a screen recording for a YouTube tutorial. You write the exact browser
steps a recorder will perform, timed against the narration. Use ONLY targets that exist in the page
inventory you are given (match their visible text exactly or by a distinctive part). Return ONLY JSON."""

STEP_DOC = """STEP TYPES (CSS px of a 1920x1080 desktop):
- {"begin": true}  — REQUIRED once, right after the first page has loaded: the segment's t=0.
- {"goto": "<url>", "settle": 2500}
- {"move": {"text": "..."}}  /  {"hover": {"text": "..."}}
- {"click": {"text": "...", "exact": false}, "navigates": true|false}
- {"type": {"target": {"text": "<placeholder or label>"}, "text": "...", "cps": 14}}
- {"scroll": {"by": <px, + = down>, "ms": 900}}
- {"read": {"text": "..."}, "ms": 2000}   — no action; the camera frames this text while it is talked about
- {"highlight": {"text": "..."}, "ms": 1800} — a marker highlight over this text (use for a phrase the speaker reads out)
- any step may carry "at": <seconds after begin> = when its ACTION should land (the click/the read starts),
  and "optional": true (skip if the target is missing).
Targets: {"text": "..."} or {"selector": "..."} (CSS) — prefer text from the inventory."""


def script_prompt(seg, video, inventory):
    ws = [w for w in video["words"] if seg["t0"] - 0.01 <= w["start"] <= seg["t1"]]
    said = " ".join(f'{w["word"]}@{w["start"] - seg["t0"]:.1f}' for w in ws)
    inv = "\n".join(f'- {i["tag"]} "{i["text"]}" at {i["box"]}{"" if i.get("above_fold") else " (below the fold)"}'
                    for i in inventory["items"][:140])
    return f"""{STEP_DOC}

SEGMENT: {seg['t1'] - seg['t0']:.1f} s of screencast. What the viewer should see: {seg['intent']}
Start page: {seg['url']}

NARRATION during the segment (word@seconds after begin):
{said}

PAGE INVENTORY of the start page ("{inventory.get('title', '')}", page height {inventory.get('height')} px):
{inv}

Write steps that:
- begin with goto (the start page), then {{"begin": true}};
- make each action land on the words that describe it (use "at"); something visible should change
  every 3-6 s (a read, a scroll, a hover, a highlight) — the camera zooms to every target, so pick
  targets that matter;
- fill the whole {seg['t1'] - seg['t0']:.1f} s (the last step may be a read that holds);
- never log in, submit forms, buy, or type personal data; navigation to public pages is fine;
- scroll sparingly: animated marketing pages often scroll into empty or black sections (their
  effects are switched off while recording). Prefer reads, hovers and clicks on what the inventory
  shows above the fold; scroll only to reach a listed element below the fold, then read it.
Return {{"steps": [...]}}"""


def write_script(seg, video, inventory, screenshot_jpg=None):
    content = [{"type": "text", "text": script_prompt(seg, video, inventory)}]
    if screenshot_jpg:
        content.insert(0, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                       "data": base64.b64encode(screenshot_jpg).decode()}})
    raw, meta = call(content, SCRIPT_SYSTEM, max_tokens=12000, effort="medium")
    steps = raw.get("steps", [])
    if not any(s.get("begin") for s in steps):
        k = next((n for n, s in enumerate(steps) if s.get("goto")), -1)
        steps.insert(k + 1, {"begin": True})
    for s in steps:                        # a missing target must never kill the recording
        if any(k in s for k in ("move", "hover", "click", "read", "highlight", "type")):
            s.setdefault("optional", True)
    return {"steps": steps, "tail": 1500}, meta
