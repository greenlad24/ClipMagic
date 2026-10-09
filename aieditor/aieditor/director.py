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

from . import config, events, llm, planfit

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


def facts_block(facts):
    """What pre-production measured (readiness features) and produced (assets) — the only things a
    beat may ask the screen for (gap list G2)."""
    if facts is None or facts.empty:
        return ""
    out = ["APP FACTS (measured on screen in Jake's account before planning — a beat may NEVER ask for a "
           "feature marked MISSING; use the honest route given, or leave those words to the presenter):"]
    for f in facts.features:
        alt = f.get("alternative") or {}
        route = alt.get("how") or ({"public": f"the PUBLIC page {alt.get('url')} (we record it in a separate "
                                              "never-logged-in US browser)"}.get(alt.get("route")))
        out.append(f"- {f['id']} ({f.get('label')}): {'exists' if f.get('exists') else 'MISSING'}"
                   + (f" — {f['note']}" if f.get("note") and not f.get("exists") else "")
                   + (f" → instead: {route}" if route and not f.get("exists") else ""))
    out.append("PRODUCED ASSETS (the only pictures/files that exist; every object you name in a picture must be "
               "in one of them; never name a chat, document or picture that is not here):")
    for a in facts.assets:
        out.append(f"- {a.get('id')} [{a.get('kind')}, {a.get('status')}]: {a.get('desc', '')}"
                   + (f" — prompt: {str(a.get('prompt') or (a.get('source') or {}).get('prompt') or '')[:240]}"
                      if (a.get('prompt') or (a.get('source') or {}).get('prompt')) else ""))
    return "\n".join(out) + "\n"


def build_prompt(video, sites, sponsored, knowledge=None, facts=None):
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

JAKE'S SCREENCAST RULES (his review of the v11 sample, 2026-10-07 — they override anything below):
- REVEAL THE TOOL: the moment he names the tool ("this tool called Linearity"), the screen REVEALS it:
  either cut to full-screen narration (no segment over those words) or show the tool's LANDING page
  (its marketing home, logo visible, unzoomed). Never a random app page on the tool's name.
- NO PURPOSELESS PAGES: every beat shows exactly what the words say. Never a Home/dashboard page as a
  way-through to something else (go to the thing directly), never a page "because we are here".
- NEVER THE WHOLE CANVAS: do not ask for "all artboards zoomed to fit"/"zoomed out on the canvas" as a
  beat. Go straight to the main section/design he names (zoomed), or leave that moment to the
  full-screen narration for a bigger wow.
- PRICING (RULEBOOK L3/L4): on the plan/price talk use the product's PUBLIC pricing page (we record it in a
  separate never-logged-in US browser, US dollars): top of the page unzoomed with the logo, then CUT straight
  to the FREE (or the named) plan card, zoomed. Never the in-account upgrade/billing modal, never all prices.
- CLEAN SCREENS: an address/name is pasted whole (no letter-by-letter), no popups or search
  suggestions left open, no cookie banners.
- NO UNNECESSARY SCROLL: never scroll to "show more" of a page; only to reach the one thing he names.
- PROMPTS: typing a prompt is shown zoomed OUT (the whole box), then the edit DISSOLVES to all the
  designs together (the finished document) — no click on the designs, no waiting.
- ON THE WORD: every zoom/click lands when he says the thing ("click the login" → the Log in button
  on "login", not before). When he gives a UI instruction ("click brand in the left sidebar"), a
  screencast is ON for those words and goes straight to that element.
- CONSTANT MOTION: about one new beat every 3-5 s (a new part of the same screen, a click, a cut) —
  never one static screen for long; but every beat must still be one of the above.

INTENT = BEATS (the recording agent follows it literally): write each segment's "intent" as beats
tied to his words — "on '<word>': <what fills the screen>" — about one beat per 4-6 s, each a calm
screen (a page, a panel, a design, a form being typed into), never several tiny targets at once.
Only ask for what EXISTS in the account (the walkthrough and the page list below) or what the
segment itself makes on screen — never a document/brand/campaign that is not there. Logged in,
screencasts use the APP's address; the marketing site only when he says to go to the website.

RULES
1. Pacing like the references (REFERENCE-BASELINE §1): 72-76 % of the runtime is screencast; screencast
   spans of 10-18 s (never over 30 s) separated by 5-7 s A-roll beats (his opinions, transitions, the
   intro, the subscribe/link asks) — 3-6 screen<->face switches per minute. Leave his opinion lines to the
   A-roll; every stretch where he tells the viewer to upload/click/type/drag/select/open is a screencast,
   or give the reason in "aroll_why": [{{"start": <id>, "end": <id>, "why": "..."}}].
   HOOK: if the first 40 s point at a thing ("look at this", "on the left/right"), plan NO screencast over
   those words — a full-screen plate of the produced asset is placed there.
2. Segments: "start"/"end" = word ids (the segment starts slightly before "start" and ends after
   "end"). Never overlap; at least 3 s of A-roll between two screencasts.
3. Overlays sit on A-roll only, one at a time, 1.5-4.5 s, >= 0.6 s apart. Text must be what is said.
4. Do not cover the first word or the last 1.5 s with an overlay unless it is a link/subscribe.
5. The presenter's own moments stay A-ROLL: the welcome/intro, the subscribe ask, the "link in the
   description" line and the sign-off — put their overlays there, never a screencast over them.
{"6. SPONSORED video: no claims beyond what is said." if sponsored else ""}

{walkthrough}
{facts_block(facts)}
TRANSCRIPT (id:word@seconds) — "{video['title']}", {video['duration']:.1f} s:
{words}

Return {{"segments": [{{"start": <id>, "end": <id>, "url": "...", "intent": "..."}}],
 "aroll_why": [{{"start": <id>, "end": <id>, "why": "..."}}],
 "overlays": [{{"template": "...", "start": <id>, "end": <id>, "fields": {{...}}, "why": "<6-12 words>"}}]}}"""


def call(content, system, max_tokens=24000, effort="high"):
    """One director call through llm.py (the API ledger + caps). → (JSON object, meta)."""
    t0 = time.time()
    total = 0.0
    msgs = [{"role": "user", "content": content}]
    # Factory rule: retry, don't fail. A malformed answer (2026-10-08: "Expecting ',' delimiter"
    # sank a creative job at graphics) gets one more call that asks for strictly valid JSON.
    for attempt in (1, 2):
        r = llm.messages(MODEL, system, None, max_tokens, effort=effort, msgs=msgs,
                         purpose=f"Claude director ({effort} effort)" + (" — retry for valid JSON" if attempt == 2 else ""))
        text = r["text"]
        total += r["usd"]
        m = re.search(r"\{.*\}", text, re.S)
        try:
            if not m:
                raise ValueError("no JSON object in the answer")
            return json.loads(m.group(0)), {"usd": round(total, 4), "seconds": round(time.time() - t0)}
        except ValueError as e:                       # json.JSONDecodeError is a ValueError
            if attempt == 2:
                raise RuntimeError(f"Claude returned invalid JSON twice: {e}") from None
            events.emit("log", f"director answer was not valid JSON ({e}) — asking again", level="warn")
            msgs = [{"role": "user", "content": content},
                    {"role": "assistant", "content": text or "(empty)"},
                    {"role": "user", "content": f"That was not valid JSON ({e}). Reply with the "
                     "complete answer again as ONE valid JSON object only — no prose, no code fence, "
                     "every string escaped."}]


def validate(plan, video, sites, facts=None):
    """The director's answer → a plan the edit can honestly record. Word ids and hosts are checked
    here; planfit then resolves every "on 'X'" beat to its word (the beat ledger), rewrites or routes
    each beat the account / produced assets cannot show (facts = readiness + assets from
    pre-production), adds the hook plate and re-cuts the screencast into the reference span
    structure (REFERENCE-BASELINE §1: spans p50 10-18 s, max 30 s, A-roll beats 5-7 s, 72-76 %)."""
    ids = {w["i"]: w for w in video["words"]}
    order = [w["i"] for w in video["words"]]
    pos = {i: n for n, i in enumerate(order)}
    dur = video["duration"]
    hosts = [".".join(re.sub(r"^https?://(www\.)?", "", s["url"]).split("/")[0].split(".")[-2:]) for s in sites]
    facts = facts if facts is not None else planfit.Facts()
    raw_segs, dropped = [], []
    for s in sorted(plan.get("segments", []), key=lambda s: pos.get(s.get("start"), 1e9)):
        a, b = s.get("start"), s.get("end")
        why = None
        if a not in ids or b not in ids or pos[b] < pos[a]:
            why = "word ids not in this cut"
        elif not any(h and h in str(s.get("url", "")) for h in hosts):
            why = "url is not one of the job's sites"
        elif raw_segs and pos[a] <= pos[raw_segs[-1]["end"]]:
            why = "overlaps the previous screencast"
        if why:
            dropped.append({**s, "dropped": why})
            continue
        raw_segs.append(s)
    fitted = planfit.fit(raw_segs, video, facts, aroll_why=plan.get("aroll_why"),
                         site_url=sites[0]["url"] if sites else None)
    dropped += [{"start": None, "end": None, "dropped": f"beat seg-{d['seg']:02d} '{d['cue']}': {d['dropped']}"}
                for d in fitted["dropped"]]
    segs = []
    for s in fitted["segments"]:
        if s["t1"] - s["t0"] < planfit.MIN_SPAN:
            dropped.append({**s, "dropped": "shorter than 2.5 s"})
            continue
        if segs and 0.05 < s["t0"] - segs[-1]["t1"] < planfit.MIN_GAP:
            segs[-1]["t1"] = s["t0"]               # < 3 s of A-roll is a flash: the screens join instead
        segs.append(s)
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
    return {"segments": segs, "overlays": ovs, "dropped": dropped, "plates": fitted["plates"],
            "beats": fitted["beats"], "objects": fitted["objects"], "aroll_actions": fitted["aroll_actions"],
            "structure": fitted["structure"]}


def plan(video, sites, sponsored, knowledge=None, facts=None):
    prompt = build_prompt(video, sites, sponsored, knowledge, facts)
    raw, meta = call(prompt, SYSTEM)
    out = validate(raw, video, sites, facts)
    # G2 spec 5: an instructional stretch left on the presenter gets ONE repair call — segments for it,
    # or the reason why not
    todo = [x for x in out.get("aroll_actions", []) if x.get("segment") is None and not x.get("compiled")]
    if todo and sites:
        ask = "\n".join(f'- words {x["start"]}-{x["end"]} ({x["t0"]:.1f}-{x["t1"]:.1f} s): "{x["words"]}"' for x in todo)
        more, m2 = call(prompt + f"""

YOUR PLAN LEFT THESE INSTRUCTIONAL STRETCHES ON THE PRESENTER (he tells the viewer to upload/click/type/
drag/select/open). Plan a screencast for each, using only existing features and produced assets, or say why
it cannot be shown:
{ask}
Return ONLY {{"segments": [...], "aroll_why": [...]}} for these stretches.""", SYSTEM)
        meta = {"usd": round(meta["usd"] + m2["usd"], 4), "seconds": meta["seconds"] + m2["seconds"]}
        raw = {**raw, "segments": list(raw.get("segments", [])) + list(more.get("segments", [])),
               "aroll_why": list(raw.get("aroll_why", [])) + list(more.get("aroll_why", []))}
        out = validate(raw, video, sites, facts)
    return out, raw, meta


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
