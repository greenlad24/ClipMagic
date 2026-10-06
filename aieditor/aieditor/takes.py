"""Pick the best take of every line — Claude reads the whole sentence-indexed transcript.

Claude never returns timestamps: it returns sentence ids and word ids, and code maps
them back to (forced-aligned) times. Validated on Jake's raw Cowork recording
against his own hand cut (2026-10-04): 94% of his kept words, the rest were lines
he cut for pace — and on five raw shorts Jake judged the takes "picked right".

Jake's rules (2026-10-04), all in SYSTEM below:
  * his manual cleanup: best take per line; delete crew talk / restarts / slates;
    delete all "uh" unless unnatural without it; delete "um"; delete most stacked "so".
  * "The tool shouldn't trim good lines."
  * "In case of a video that is not sponsored ... you can cut redundant or repetitive
    sentences." -> the job's `sponsored` flag (required, never guessed).
"""
import json
import re
import time
import urllib.request

from . import config

FILLERS = {"um", "uh", "umm", "uhh", "uhm", "erm", "mm-hmm", "mhm", "hmm"}


def norm(t):
    return re.sub(r"[^\w%'-]", "", t.lower())


def load_words(path):
    words = json.load(open(path))["words"]
    # ws/we = Whisper's OWN times, kept after the aligned times are swapped into s/e:
    # collapsed Whisper timestamps are how invented words are recognised (phantoms())
    return [{"i": i, "w": w["word"].strip(), "s": float(w["start"]), "e": float(w["end"]),
             "ws": float(w["start"]), "we": float(w["end"])}
            for i, w in enumerate(words) if w["word"].strip()]


def sentences(words):
    """Punctuation or a > 0.9 s pause ends a sentence. ALWAYS run on Whisper's own
    times so ids stay stable when aligned times are swapped in afterwards."""
    out, cur = [], []
    for w in words:
        if cur and w["s"] - cur[-1]["e"] > 0.9:
            out.append(cur); cur = []
        cur.append(w)
        if re.search(r"[.?!]$", w["w"]):
            out.append(cur); cur = []
    if cur:
        out.append(cur)
    return out


# ---- LEARNED FROM LINEARITY (Jake's hand corrections of linearity-10050728-8866) ----

PHANTOM_DUR = 0.03        # Whisper word this short = a collapsed timestamp, not a spoken word
PHANTOM_RUN = 3           # ...and at least this many in a row
FUSED_SO_DB = 25          # a removed "so" whose quietest 10 ms before the next word is louder
                          # than floor + this is run together with it: no clean cut exists


def _speech_secs(audio, a, b):
    """Seconds of [a, b] louder than floor + PAUSE_SPEECH_DB — speech, not a breath/click."""
    from .edl import PAUSE_SPEECH_DB
    thr, t, n = audio.floor() + PAUSE_SPEECH_DB, a, 0
    while t + 0.01 <= b + 1e-9:
        n += audio.rms_db(t, t + 0.01) > thr
        t += 0.01
    return n * 0.01


def phantoms(flat, audio):
    """Words Whisper INVENTED or mis-heard where its timestamps collapsed: >= 3 words in a
    row each <= 30 ms long (plus the word before them when its start overlaps its own
    predecessor — the collapse begins there — and the one after them when it starts
    where they end). Returns (marked, silent): every such word,
    and the trailing ones the aligner could only lay over SILENCE (no speech > 80 ms).
    ⚠️ Linearity S380 (30:57): a clean take ended "...are vector artwork" + 8 invented
    words over the silence after it ("That was a very good idea of the vector artwork.",
    each 20 ms). Claude rejected the take as "flawed take: garbled" and kept a muttered
    rehearsal (S377) instead -> Jake swapped the take by hand ("a take that was not real
    take"), then trimmed 500 ms of dead air the invented words had left at the cut.
    The same collapse over REAL speech is Cowork's 1:21 ("ahead and do that" = "by hand"):
    those words are sound and must stay — only the silent tail is dropped."""
    if not flat or "ws" not in flat[0]:
        return set(), set()
    marked, silent = set(), set()
    k = 0
    while k < len(flat):
        m = k
        while m < len(flat) and flat[m]["we"] - flat[m]["ws"] <= PHANTOM_DUR:
            m += 1
        if m - k >= PHANTOM_RUN:
            run = flat[k:m]
            if k >= 2 and flat[k - 1]["ws"] < flat[k - 2]["we"] - 0.01:
                run = [flat[k - 1]] + run
            # ...and the word right after them when it starts inside the collapse (S380's
            # last invented word "artwork." got the leftover 0.72 s)
            if m < len(flat) and flat[m]["ws"] <= flat[m - 1]["we"] + 0.01:
                run = run + [flat[m]]
            marked |= {w["i"] for w in run}
            for w in reversed(run):
                if audio is None or _speech_secs(audio, w["s"], w["e"]) > 0.08:
                    break
                silent.add(w["i"])
        k = max(m, k + 1)
    return marked, silent


def fused_so(flat, audio):
    """Ids of every "so" with NO quiet point between it and the next word (> floor +
    FUSED_SO_DB all the way). Removing one cuts into sound — Linearity: Claude dropped 9
    "So"s; Jake put back exactly the 4 run into the next word (valley 33-40 dB over the
    floor, his nudges -121/-198/-146/-320 ms = back to the onset of "So") and left the 4
    with real silence after them (valley <= 0 dB) removed; one at 16 dB stayed removed."""
    out = set()
    if audio is None:
        return out
    fl = audio.floor()
    for w, nx in zip(flat, flat[1:]):
        if norm(w["w"]) != "so":
            continue
        lo, hi = w["e"] - 0.03, nx["s"] + 0.03
        t, m = lo, None
        while t <= hi + 1e-9:
            d = audio.rms_db(t - 0.005, t + 0.005)
            m = d if m is None else min(m, d)
            t += 0.005
        if m is not None and m > fl + FUSED_SO_DB:
            out.add(w["i"])
    return out


def features(sents, audio):
    flat = [w for s in sents for w in s]
    ph, ph_silent = phantoms(flat, audio)
    fso = fused_so(flat, audio)
    feats, prev_end = [], 0.0
    for s in sents:
        gaps = [b["s"] - a["e"] for a, b in zip(s, s[1:])]
        toks = [norm(w["w"]) for w in s]
        dur = s[-1]["e"] - s[0]["s"]
        feats.append({
            "pb": round(s[0]["s"] - prev_end, 2),
            "mip": round(max(gaps), 2) if gaps else 0,
            "fil": sum(t in FILLERS for t in toks),
            "rep": sum(1 for a, b in zip(toks, toks[1:]) if a == b and a),
            "wps": round(len(s) / dur, 2) if dur > 0 else 0,
            "db": round(audio.rms_db(s[0]["s"], s[-1]["e"]), 1),
            # not shown as features in the prompt; read by build_prompt / post-processing
            "ph": [w["i"] for w in s if w["i"] in ph],
            "ph_silent": [w["i"] for w in s if w["i"] in ph_silent],
            "fused_so": [w["i"] for w in s if w["i"] in fso],
        })
        prev_end = s[-1]["e"]
    return feats


SYSTEM = """You are Jake Dawson's narration editor. Jake records talking-head narration in one long RAW take: he reads a script, flubs, restarts lines, re-reads whole run-throughs, and talks to the crew between takes ("rolling", "is that it?", "my tablet died"). Your job is exactly what Jake does by hand in Descript after recording: pick the BEST take of every line of the script and delete everything else, so the result plays as one clean, natural read.

Input: the raw transcript split into numbered sentences. Each line shows its id, start time, features, then its words as [word_id]word.
Features: pb = pause before (s), mip = longest pause inside (s), fil = filler count, rep = immediate word repeats, wps = words/second, db = loudness.

How Jake edits (follow exactly):
1. One recording can contain SEVERAL different scripts (several shorts, or several sections). Identify each distinct script. {format_rule}
2. For each script, rebuild the final read line by line. Where a line was said several times, keep the BEST take: complete, fluent (no stumble, restart, or trailing off), confident, natural pace, wording that reads best. The LAST complete take is often the best because the presenter improved, but judge — don't assume. Mixing lines from different run-throughs is fine and normal.
3. Delete all off-script talk: crew talk, self-corrections ("no, no, no", "let me redo that", "I'm going to finish and then do it again"), false starts, abandoned sentences, slate words, "okay"/"all right" between takes.
4. Drop words that are a stumble: a restarted phrase ("the MIT, the MIT" -> keep one), a doubled word. Drop the earlier copy, keep the clean one. This also happens ACROSS sentences: a sentence that trails off into the first words of the next one ("...this does trip people up, Claude Code." then "Claude Code is the one built for programmers...") — drop the dangling words from the first sentence.
5. Fillers: delete ALL "uh" unless the sentence sounds unnatural without it. Delete "um". "So" starting a sentence: Jake keeps a FEW but deletes most — delete it when sentences in a row keep starting with "So", or when "so"/"um"/"uh" pile up next to each other. Keep a "So" only where it carries the logic (e.g. a conclusion). Never change any other word.
6. {content_rule}
7. THE FIRST 5:00 OF THE FINISHED VIDEO IS NEVER TRIMMED FOR CONTENT (Jake). Before the 5-minute mark of the final cut, remove only retakes, flawed takes, false starts, off-script talk and fillers — never a good line, even a repetitive one and even when the video is not sponsored. Content cuts ("redundant") may only happen after 5:00.
8. Words marked ~ (e.g. [812]~very) are where the transcriber's timestamps collapsed: they are probably MIS-HEARD or invented over a silence, not what was said. Never reject a take as garbled/flawed because of ~ words — judge it by the rest of the line, and never list ~ words in "drop" (code handles them).
9. Keep the script's order. Don't invent or reorder for effect. If a needed line exists ONLY as a flawed take, keep it and list it in "warnings".

Return ONLY JSON:
{"videos":[{"title":"short name of this script","segments":[{"s":<sentence id>,"drop":[<word ids to delete inside this sentence>]}],"warnings":["..."]}],
 "removed":[{"s":<sentence id>,"why":"<category>: <2-5 words>"}],
 "notes":"2-4 sentences on what was cut and why"}
Every kept sentence appears once, in final playback order. Every sentence you did not keep appears once in "removed"."""

FORMAT_RULE = {
    "short": "These are SHORTS: each distinct script becomes its own video. Output one entry in 'videos' per script, in recording order.",
    "long": "This is ONE long-form video: output exactly one entry in 'videos' containing the whole script in order, even if it was recorded across several files.",
}
CONTENT_RULE = {
    True: "This video is SPONSORED. Never cut a good line: remove only retakes, flawed takes, false starts, off-script talk and fillers. Every line of the script that has a usable take stays, even if it repeats an earlier point.",
    False: "This video is NOT sponsored. Besides retakes and junk you MAY also cut a sentence that is redundant or repetitive — one that says again what a kept line already said — but ONLY after the 5:00 mark of the finished video (rule 7). Never cut a good line just to make the video shorter or faster.",
}


def build_prompt(sents, feats, script=None):
    lines = []
    for n, (s, f) in enumerate(zip(sents, feats)):
        ph = set(f.get("ph", ()))
        ws = " ".join(f"[{w['i']}]{'~' if w['i'] in ph else ''}{w['w']}" for w in s)
        lines.append(f"S{n} @{s[0]['s']:.1f}s pb={f['pb']} mip={f['mip']} fil={f['fil']} "
                     f"rep={f['rep']} wps={f['wps']} db={f['db']}: {ws}")
    body = "\n".join(lines)
    if script and script.strip():
        body = ("JAKE'S SCRIPT (what he meant to say — use it to recognise the lines and their order; "
                "the narration may word things differently, and what was SAID is what you keep):\n"
                + script.strip() + "\n\nRAW TRANSCRIPT:\n" + body)
    return body


def call_claude(prompt, system, max_tokens=64000):
    key = config.env_key("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set in /opt/clipmagic/.env")
    body = {"model": config.TAKES_MODEL, "max_tokens": max_tokens, "thinking": {"type": "adaptive"},
            "output_config": {"effort": "high"}, "stream": True,
            "system": system, "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                 headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                          "content-type": "application/json"})
    t0 = time.time()
    text, usage, stop = [], {}, None
    with urllib.request.urlopen(req, timeout=1800) as resp:
        for raw in resp:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if ev["type"] == "message_start":
                usage.update(ev["message"]["usage"])
            elif ev["type"] == "content_block_delta" and ev["delta"].get("type") == "text_delta":
                text.append(ev["delta"]["text"])
            elif ev["type"] == "message_delta":
                usage.update(ev.get("usage", {}))
                stop = ev["delta"].get("stop_reason")
            elif ev["type"] == "error":
                raise RuntimeError(f"Claude error: {ev.get('error')}")
    if stop == "max_tokens":
        raise RuntimeError("Claude's answer was cut off (max_tokens)")
    text = "".join(text)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError("Claude returned no JSON")
    usd = usage.get("input_tokens", 0) * 4e-6 + usage.get("output_tokens", 0) * 20e-6
    return json.loads(m.group(0)), {"usage": usage, "usd": round(usd, 4), "seconds": round(time.time() - t0)}


def validate(plan, sents):
    """Enforce in code what the model was asked: ids exist, each sentence used once,
    drops belong to their sentence, every unkept sentence has a reason."""
    used, videos = set(), []
    for v in plan.get("videos", []):
        segs = []
        for seg in v.get("segments", []):
            try:
                n = int(seg["s"])
            except (KeyError, TypeError, ValueError):
                continue
            if n < 0 or n >= len(sents) or n in used:
                continue
            ids = {w["i"] for w in sents[n]}
            drop = sorted({int(d) for d in seg.get("drop", []) if int(d) in ids})
            if len(drop) == len(ids):
                continue
            used.add(n)
            segs.append({"s": n, "drop": drop})
        if segs:
            videos.append({"title": str(v.get("title") or f"Video {len(videos) + 1}")[:120],
                           "segments": segs, "warnings": [str(x) for x in v.get("warnings", [])][:20]})
    if not videos:
        raise RuntimeError("Claude kept nothing usable")
    why = {}
    for r in plan.get("removed", []):
        try:
            why[int(r["s"])] = str(r.get("why") or "")[:60]
        except (KeyError, TypeError, ValueError):
            pass
    removed = [{"s": n, "why": why.get(n) or "not used"} for n in range(len(sents)) if n not in used]
    return {"videos": videos, "removed": removed, "notes": str(plan.get("notes") or "")}


PROTECTED_SECONDS = 300      # Jake: content cuts only after the 5:00 mark of the finished video
STOPWORDS = {"the", "a", "an", "and", "so", "to", "of", "in", "it", "is", "i", "you", "that", "this", "on"}


def _approx_out_times(segments, sents):
    """Rough start time of each kept sentence on the finished timeline (the gap rule
    caps pauses at 0.35 s), good enough to tell which side of 5:00 a line falls on."""
    t, out = 0.0, {}
    for g in segments:
        ws = [w for w in sents[g["s"]] if w["i"] not in set(g["drop"])]
        out[g["s"]] = t
        if ws:
            t += min(ws[-1]["e"] - ws[0]["s"], sum(w["e"] - w["s"] for w in ws) + 0.35 * len(ws)) + 0.35
    return out


def protect_opening(result, sents, sponsored):
    """Enforce in code: a sentence dropped as 'redundant' that would have played before
    5:00 goes back in (and every 'redundant' cut goes back when the video is sponsored)."""
    restored = []
    for v in result["videos"]:
        times = _approx_out_times(v["segments"], sents)
        kept = [g["s"] for g in v["segments"]]
        for r in list(result["removed"]):
            if not r["why"].lower().startswith("redundant"):
                continue
            n = r["s"]
            if not kept or not (min(kept) <= n <= max(kept)):
                continue                      # belongs to another video / outside this one
            prev = [k for k in kept if k < n]
            at = times.get(max(prev), 0.0) if prev else 0.0
            if sponsored or at < PROTECTED_SECONDS:
                pos = next((i for i, g in enumerate(v["segments"]) if g["s"] > n), len(v["segments"]))
                v["segments"].insert(pos, {"s": n, "drop": []})
                kept.insert(pos, n)
                result["removed"].remove(r)
                restored.append(n)
                times = _approx_out_times(v["segments"], sents)
    return restored


def fix_seams(result, sents):
    """A restart across a join ("...people up, Claude Code." + "Claude Code is the one...")
    survives when each sentence looks fine on its own. Check every join of the final cut:
    if the 2-5 words before it repeat the words right after it, drop the earlier copy."""
    fixed = 0
    for v in result["videos"]:
        segs = v["segments"]
        for k in range(len(segs) - 1):
            a, b = segs[k], segs[k + 1]
            wa = [w for w in sents[a["s"]] if w["i"] not in set(a["drop"])]
            wb = [w for w in sents[b["s"]] if w["i"] not in set(b["drop"])]
            ta, tb = [norm(w["w"]) for w in wa], [norm(w["w"]) for w in wb]
            for n in range(min(5, len(ta) - 1, len(tb)), 0, -1):
                if ta[-n:] == tb[:n] and (n >= 2 or ta[-1] not in STOPWORDS):
                    a["drop"] = sorted(set(a["drop"]) | {w["i"] for w in wa[-n:]})
                    fixed += 1
                    break
    return fixed


def fix_phantoms(result, sents, feats):
    """Kept sentences: invented words over silence are dropped (they only add dead air —
    Jake trimmed 500 ms of it by hand on Linearity); mis-heard words over real sound are
    never dropped (they ARE the line: Linearity's "artwork", Cowork's "by hand")."""
    n = 0
    for v in result["videos"]:
        for g in v["segments"]:
            f = feats[g["s"]] if g["s"] < len(feats) else {}
            silent, ph = set(f.get("ph_silent", ())), set(f.get("ph", ()))
            if not ph:
                continue
            ids = [w["i"] for w in sents[g["s"]]]
            drop = set(g["drop"]) | silent
            # a mis-heard word over sound follows the word before it: kept after a kept
            # word, cut after a cut one (Claude is told to leave ~ words out of "drop")
            for i in ids:
                if i in ph and i not in silent and i - 1 in ids:
                    if i - 1 in drop:
                        drop.add(i)
                    else:
                        drop.discard(i)
            if len(drop) < len(ids) and drop != set(g["drop"]):
                g["drop"] = sorted(drop)
                n += 1
    return n


def keep_fused_so(result, sents, feats):
    """A dropped "so" run straight into the next KEPT word goes back in (fused_so)."""
    n = 0
    for v in result["videos"]:
        kept = set()
        for g in v["segments"]:
            kept |= {w["i"] for w in sents[g["s"]] if w["i"] not in set(g["drop"])}
        for g in v["segments"]:
            f = feats[g["s"]] if g["s"] < len(feats) else {}
            back = [i for i in f.get("fused_so", ()) if i in g["drop"] and i + 1 in kept]
            if back:
                g["drop"] = [i for i in g["drop"] if i not in back]
                n += len(back)
    return n


def pick(words, sents, feats, fmt, sponsored, script=None):
    system = (SYSTEM.replace("{format_rule}", FORMAT_RULE[fmt])
              .replace("{content_rule}", CONTENT_RULE[bool(sponsored)]))
    raw, meta = call_claude(build_prompt(sents, feats, script), system)
    result = validate(raw, sents)
    meta["restored_opening"] = protect_opening(result, sents, sponsored)
    meta["phantoms_fixed"] = fix_phantoms(result, sents, feats)
    meta["seams_fixed"] = fix_seams(result, sents)
    meta["fused_so_kept"] = keep_fused_so(result, sents, feats)
    return result, raw, meta
