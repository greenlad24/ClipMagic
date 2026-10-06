"""Phase 2 for shorts: the GRAPHICS PLAN (Claude) and the scenes it becomes.

Claude only decides WHAT goes WHERE — which template, on which spoken words, with which
text — anchored to the cut's WORD IDS so a later nudge/recut moves the graphic with its
words. Everything about HOW it moves comes from the measured recipes (recipes.py via
templates916.py), never from the model.

Pacing = the reference explainer (gVPZU1btFA8, Jake's chosen look for shorts): ~7
graphic events a minute, one at a time, keyword text leading its spoken word by
140–300 ms, exits on a hard cut.
"""
import json
import re

from . import takes, templates916 as T

FPS_REF = 24                 # recipes are keyed in the reference's frames
LEAD_S = 0.2                 # text appears 140–300 ms before its word (keyword spec)
MIN_HOLD_S, MAX_HOLD_S = 1.5, 4.5
PER_MIN = (5, 9)             # events per minute band

CATALOG = """TEMPLATES (pick by what is SAID; one on screen at a time):
- keyword: 2 short lines, line1 white (1-4 words), line2 the pink punch word(s) (1-2 words). The words must be SAID (or a tight paraphrase) at that moment. Use for the hook and for punchlines.
- number: a figure the speaker SAYS. fields: label (2-4 words, e.g. "upgraded in 14 days"), value (number exactly as spoken: 4, 17, 48000), prefix ("$" or ""), suffix ("%", "x", "K" or ""), count (true = count up from a smaller start, only for values >= 100 or percentages).
- title: a chapter/section label when the speaker moves to a new point. fields: line1 (2-3 small words, e.g. "version two"), line2 (1-2 big words).
- list: 2-3 short items the speaker enumerates (each 1-4 words). Anchor on the first item; it stays while all items are said.
- prompt: the speaker describes typing a prompt / instruction into an AI tool. field: text (the prompt, <= 110 chars, max 2 lines split by \\n).
- cta: "LINK IN THE DESCRIPTION" style pill — ONLY when the speaker points to a link/comment/follow. field: text (<= 26 chars, caps).
"""

SYSTEM = """You are the motion-graphics editor for Jake Dawson's vertical shorts (AI tools channel).
You place on-screen graphics on top of an already-cut talking-head short. You receive the
transcript as numbered words with their times. Return ONLY JSON."""


def build_prompt(video, fmt, sponsored):
    words = video["words"]
    dur = video["duration"]
    lo, hi = max(1, round(dur / 60 * PER_MIN[0])), max(2, round(dur / 60 * PER_MIN[1]))
    lines = []
    for w in words:
        lines.append(f'{w["i"]}:{w["word"]}@{w["start"]:.2f}')
    return f"""{CATALOG}
RULES
1. {lo}-{hi} events for this {dur:.0f}-second short. Never two at once; leave >= 0.6 s between one ending and the next starting.
2. The first event lands in the first 2 seconds (the hook) — usually a keyword.
3. Each event: "start" = the word id where it APPEARS (the graphic shows ~0.2 s before that word), "end" = the word id after which it LEAVES. Hold 1.5-4.5 s.
4. Text must come from what is said at that moment. Numbers must be spoken in that span exactly. Never invent facts.
5. Prefer variety: no template twice in a row unless the content demands it.
6. Do not cover the very last 1.5 s unless it is a cta.
{"7. This video is SPONSORED: do not add graphics about the sponsor beyond what is said." if sponsored else ""}

TRANSCRIPT (id:word@seconds) — title "{video['title']}", {dur:.1f} s:
{' '.join(lines)}

Return {{"events": [{{"template": "...", "start": <word id>, "end": <word id>, "fields": {{...}}, "why": "<6-12 words>"}}]}}"""


def _num(s):
    return float(re.sub(r"[^\d.]", "", s) or "nan")


_UNITS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                      "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()) if w != "_"}
_SCALE = {"hundred": 100, "thousand": 1000, "million": 1_000_000, "billion": 1_000_000_000}


def spoken_numbers(text):
    """Every number said in `text`, digits ("4%", "48,000", "1.5") AND words ("three",
    "seventeen", "forty two", "two hundred thousand") — Whisper writes both."""
    out = [_num(x) for x in re.findall(r"\d[\d,.]*", text)]
    toks = [re.sub(r"[^a-z]", "", t) for t in re.split(r"[\s-]+", text.lower())]
    total, cur, any_ = 0, 0, False
    for t in toks + [""]:
        if t in _UNITS:
            cur += _UNITS[t]; any_ = True
        elif t in _TENS:
            cur += _TENS[t]; any_ = True
        elif t in _SCALE and any_:
            if t == "hundred":
                cur *= 100
            else:
                total += cur * _SCALE[t]; cur = 0
        elif t == "and" and any_:
            continue
        else:
            if any_:
                out.append(float(total + cur))
            total, cur, any_ = 0, 0, False
    return out


def validate(events, video):
    """Keeps only events the cut can actually carry: real word ids in order, no overlap,
    holds within bounds, numbers that were spoken, text within the template's limits."""
    ids = {w["i"]: w for w in video["words"]}
    order = [w["i"] for w in video["words"]]
    pos = {i: n for n, i in enumerate(order)}
    out, last_end = [], -1.0
    dropped = []
    for ev in sorted(events, key=lambda e: pos.get(e.get("start"), 1e9)):
        t, a, b, f = ev.get("template"), ev.get("start"), ev.get("end"), ev.get("fields") or {}
        why = None
        if t not in ("keyword", "number", "title", "list", "prompt", "cta"):
            why = f"unknown template {t}"
        elif a not in ids or b not in ids or pos[b] < pos[a]:
            why = "word ids not in this cut"
        if why is None:
            t0 = max(0.0, ids[a]["start"] - LEAD_S)
            t1 = ids[b]["end"] + 0.1
            if t1 - t0 < MIN_HOLD_S:
                t1 = min(video["duration"], t0 + MIN_HOLD_S)
            if t1 - t0 > MAX_HOLD_S and t != "list" and t != "prompt":
                t1 = t0 + MAX_HOLD_S
            if t0 < last_end + 0.6:
                why = "overlaps the previous graphic"
            elif t != "cta" and t1 > video["duration"] - 1.0:
                t1 = video["duration"] - 1.0
                if t1 - t0 < 1.0:
                    why = "too close to the end"
        if why is None and t == "number":
            spoken = " ".join(ids[i]["word"] for i in order[pos[a]:pos[b] + 1])
            nums = spoken_numbers(spoken)
            val = f.get("value")
            if not isinstance(val, (int, float)) or not any(abs(val - n) < 1e-6 or abs(val - n * 1000) < 1e-6 for n in nums):
                why = f"number {val} not spoken in '{spoken}'"
        if why is None and t == "keyword" and (len(str(f.get("line1", "")).split()) > 5 or len(str(f.get("line2", "")).split()) > 3):
            why = "keyword lines too long"
        if why:
            dropped.append({**ev, "dropped": why})
            continue
        item = {**ev, "t0": round(t0, 3), "t1": round(t1, 3)}
        if t == "list":
            # each row appears when it is SAID (reference lists are speech-paced): find the
            # first word of every item inside the event's span
            span = [ids[i] for i in order[pos[a]:pos[b] + 1]]
            rows, at = [], 0
            for it in (f.get("items") or [])[:3]:
                first = re.sub(r"[^a-z0-9]", "", str(it).lower().split()[0]) if str(it).split() else ""
                hit = next((n for n in range(at, len(span)) if re.sub(r"[^a-z0-9]", "", span[n]["word"].lower()) == first), None)
                if hit is None:
                    rows.append(None)
                else:
                    rows.append(round(max(t0, span[hit]["start"] - LEAD_S) * FPS_REF, 2))
                    at = hit + 1
            prev = t0 * FPS_REF
            for n, r in enumerate(rows):          # unmatched rows: 1 s after the previous one
                rows[n] = r if r is not None and r >= prev else prev + (24 if n else 0)
                prev = rows[n]
            item["row_k"] = rows
        out.append(item)
        last_end = t1
    return out, dropped


def plan(video, fmt, sponsored):
    raw, meta = takes.call_claude(build_prompt(video, fmt, sponsored), SYSTEM, max_tokens=16000)
    events, dropped = validate(raw.get("events", []), video)
    return {"events": events, "dropped": dropped}, raw, meta


def layers_for(ev):
    """One event → engine layers, keyed so its first visible frame is k = t0 in reference
    frames; everything hard-cuts at t1 (the reference's usual exit)."""
    k = ev["t0"] * FPS_REF
    f = ev["fields"]
    t = ev["template"]
    if t == "keyword":
        L = T.keyword(k, f.get("line1", ""), f.get("line2", ""))
    elif t == "number":
        v = f.get("value")
        cnt = None
        if f.get("count") and isinstance(v, (int, float)):
            cnt = 0 if v < 100 else round(v * 0.025)
        L = T.number(k + 4, f.get("label", ""), int(v) if float(v).is_integer() else v, count_from=cnt, label_k=k,
                     prefix=f.get("prefix", ""), suffix=f.get("suffix", ""))
    elif t == "title":
        L = T.title(k, f.get("line1", ""), f.get("line2", ""))
    elif t == "list":
        items = f.get("items", [])[:3]
        L = T.numbered_list(ev.get("row_k") or k, items)
    elif t == "prompt":
        L = T.prompt(k, f.get("text", ""))
    elif t == "cta":
        L = T.cta(k, text=f.get("text", "LINK IN THE DESCRIPTION"))   # sparkle at t0, text ~1.7 s later
    else:
        return []
    last = ev["t1"] * FPS_REF
    for layer in L:
        vis = layer.get("visible")
        layer["visible"] = [vis[0] if vis else -1e9, last]
    return L


def scene_for(ev, fps_out, scale=1, width=T.W, height=T.H):
    """The event's own scene: frames t0−0.3 s … t1 at the output fps, files numbered by
    OUTPUT frame so the compositor can drop them in at their place on the timeline."""
    first = max(0.0, ev["t0"] - 0.3)
    out_first = int(round(first * fps_out))
    return {"width": width, "height": height, "fps": FPS_REF, "outFps": fps_out, "scale": scale,
            "first": out_first / fps_out * FPS_REF, "last": ev["t1"] * FPS_REF, "outFirst": out_first,
            "layers": layers_for(ev)}
