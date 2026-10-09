"""Narration integrity (rubric D9): which spoken words a cut removed, and whether anyone
approved removing them — plus a word-timing validator.

Jake 2026-10-09, on the factory edit he watched: "it also did cuts inside the narration that
I didn't ask for". The creative edit kept everything; every cut he heard came from its
SOURCE, an automatic cut nobody reviewed (factory-e2e-test: 53 joins — 32 "So", 6 "uh",
1 "um", 3 whole sentences, 3 asides, 8 pause-only). The references cannot license removing
words (REFERENCE-BASELINE §7 JAKE>REF: "the approved narration must keep all of its words");
only silence trimming is reference behaviour.

  diff()          source transcript vs the cut's EDL words -> wordiff.json
                  (every removed word with its source time, its join, its category, and
                  whether it was approved: by Jake's review, or by the factory takes policy)
  check_words()   overlapping / duplicated words in a transcript (a hallucinated repeat
                  drives word-cued beats onto the wrong moment: RULEBOOK §1 C1)
  check_joins()   joins whose source spans overlap (src_a < src_b: audio plays twice)

Pure functions over plain dicts: no audio, no model, no files (the worker writes the result).
"""
import re

UH = {"uh", "uhh", "uhm", "er", "erm"}
UM = {"um", "umm", "mm", "hmm", "mhm", "mm-hmm"}
SO = {"so"}
WORD_OVERLAP_TOL = 0.05     # aligned words may touch; more than this backwards is an overlap
DUP_MIN = 3                 # a duplicate is a run of at least this many words...
DUP_LOOKBACK = 60.0         # ...repeating words said within this many seconds before it


def _norm(t):
    return re.sub(r"[^\w%'-]", "", str(t).lower())


def _w(x):
    """A word in either shape: takes.load_words {i, w, s, e} or edl words {i, word, start, end}."""
    return {"i": x["i"], "w": x.get("w", x.get("word", "")),
            "s": float(x.get("s", x.get("start", 0.0))), "e": float(x.get("e", x.get("end", 0.0)))}


def _kept_ids(video):
    if video.get("pieces"):
        return [i for p in video["pieces"] for i in p.get("word_ids", ())]
    return [w["i"] for w in video.get("words", ())]


def category(removed, sent_of, sent_ids, allowed=None):
    """The kind of one removal (the words removed at one join, in order):
    pause (nothing) | sentence (whole sentences) | so | uh | um | <allowed reason> | aside."""
    if not removed:
        return "pause"
    ids = [w["i"] for w in removed]
    sents = {sent_of.get(i) for i in ids}
    if None not in sents and all(set(sent_ids[s]) <= set(ids) for s in sents):
        return "sentence"
    toks = [_norm(w["w"]) for w in removed]
    if all(t in SO for t in toks):
        return "so"
    if all(t in UH for t in toks):
        return "uh"
    if all(t in UM for t in toks):
        return "um"
    whys = {(allowed or {}).get(i) for i in ids}
    if len(whys) == 1 and None not in whys:
        return next(iter(whys))
    return "aside"


def diff(words, sentences, videos, allowed=None, approved_by=None):
    """Source transcript vs the output EDL.
      words       the source transcript ({i, w, s, e} or {i, word, start, end})
      sentences   lists of words (takes.sentences) — to tell a whole sentence from an aside
      videos      edl.json "videos" (pieces with word_ids, or words with i)
      allowed     {word id: reason} the takes policy itself removed (plan.json "allowed")
      approved_by "review" when Jake reviewed/approved the cut: every removal is approved
    Returns the wordiff.json document. A removal = the words removed at one place in the
    cut (one join, or the head/tail of a video); "unapproved" counts removals."""
    allowed = {int(k): v for k, v in (allowed or {}).items()}
    by = {x["i"]: _w(x) for x in words}
    order = sorted(by)
    sent_of, sent_ids = {}, []
    for n, s in enumerate(sentences):
        ids = [x["i"] for x in s]
        sent_ids.append(ids)
        for i in ids:
            sent_of[i] = n
    kept_all = set()
    removals, removed_words = [], []
    out_videos = []
    single = len(videos) == 1
    for k, v in enumerate(videos):
        kept = _kept_ids(v)
        kept_all |= set(kept)
        j_at = {(j.get("left_id"), j.get("right_id")): j for j in v.get("joins") or []}
        # the gaps between consecutive kept words (by source id) = the removals of this
        # video; a join with nothing removed is a pause-only cut
        spans = []
        if single and kept:
            spans.append(("head", None, [i for i in order if i < kept[0]], None))
        pos = {i: n for n, i in enumerate(order)}
        for a, b in zip(kept, kept[1:]):
            gone = order[pos[a] + 1:pos[b]] if a in pos and b in pos and pos[b] > pos[a] else []
            if gone or (a, b) in j_at:
                spans.append(("join", a, gone, b))
        if single and kept:
            spans.append(("tail", kept[-1], [i for i in order if i > kept[-1]], None))
        for kind, left, gone, right in spans:
            j = j_at.get((left, right)) if kind == "join" else None
            if kind == "join" and not gone and j is None:
                continue                                   # consecutive words, no cut
            if kind != "join" and not gone:
                continue
            ws = [by[i] for i in gone]
            cat = category(ws, sent_of, sent_ids, allowed)
            ok = bool(approved_by) or (bool(ws) and all(i in allowed for i in gone))
            rec = {"video": k + 1, "at": kind, "out": j.get("out") if j else None,
                   "left_id": left, "right_id": right, "category": cat,
                   "removed": " ".join(w["w"] for w in ws)[:300], "n_words": len(ws),
                   "src": [round(ws[0]["s"], 3), round(ws[-1]["e"], 3)] if ws else None,
                   "approved": ok if ws else None,
                   "why": (approved_by or (allowed.get(gone[0]) if ws and ok else None))}
            removals.append(rec)
            for w in ws:
                removed_words.append({"i": w["i"], "w": w["w"], "s": round(w["s"], 3), "e": round(w["e"], 3),
                                      "video": k + 1, "category": cat,
                                      "approved": bool(approved_by) or w["i"] in allowed,
                                      "why": approved_by or allowed.get(w["i"])})
        out_videos.append({"video": k + 1, "words_out": len(kept)})
    counts = {}
    for r in removals:
        counts[r["category"]] = counts.get(r["category"], 0) + 1
    unapproved = [r for r in removals if r["n_words"] and not r["approved"]]
    return {
        "words_in": len(by), "words_out": len(kept_all), "videos": out_videos,
        "approved_by": approved_by, "joins": sum(1 for r in removals if r["at"] == "join"),
        "counts": counts, "removals": removals, "removed_words": removed_words,
        "removed": sum(1 for r in removals if r["n_words"]),
        "unapproved": len(unapproved), "unapproved_words": sum(r["n_words"] for r in unapproved),
    }


def summary(doc):
    """One log line: 'D9 unapproved removals: N (So 32, uh 6, ...)'."""
    c = doc.get("counts") or {}
    parts = ", ".join(f"{k} {v}" for k, v in sorted(c.items(), key=lambda x: (-x[1], x[0])))
    return (f"D9 unapproved removals: {doc.get('unapproved', 0)}"
            f" ({doc.get('unapproved_words', 0)} words; {doc.get('joins', 0)} joins: {parts or 'none'})")


def check_words(words, tol=WORD_OVERLAP_TOL):
    """Word-timing integrity of a transcript (source or output timeline). Flags
      overlap    a word that starts more than `tol` before the previous one ends
      duplicate  a run of DUP_MIN+ words laid back over the words after it in time AND
                 repeating words said shortly before (a hallucinated repeat: the creative
                 transcript's "that's the obvious way to say it" at 659.9-660.7, laid over
                 "That is the phrasing")
    Returns a list of {kind, ids, t0, t1, text, ...}."""
    ws = [_w(x) for x in words]
    out, seen = [], set()
    for k in range(len(ws) - 1):
        a, b = ws[k], ws[k + 1]
        if b["s"] >= a["e"] - tol:
            continue
        # the run that b's start falls back into: words j..k whose start is at/after b's
        j = k
        while j - 1 >= 0 and ws[j - 1]["s"] >= b["s"] - tol and k - j < 30:
            j -= 1
        run = ws[j:k + 1]
        rt = [_norm(w["w"]) for w in run]
        rep = None
        if len(run) >= DUP_MIN:
            for m in range(j - len(run), -1, -1):
                if ws[m]["s"] < run[0]["s"] - DUP_LOOKBACK:
                    break
                if [_norm(w["w"]) for w in ws[m:m + len(run)]] == rt:
                    rep = ws[m]
                    break
        key = (run[0]["i"], run[-1]["i"])
        if key in seen:
            continue
        seen.add(key)
        if rep is not None:
            out.append({"kind": "duplicate", "ids": [w["i"] for w in run], "t0": round(run[0]["s"], 3),
                        "t1": round(run[-1]["e"], 3), "text": " ".join(w["w"] for w in run),
                        "repeats": round(rep["s"], 3), "overlaps": b["i"]})
        else:
            out.append({"kind": "overlap", "ids": [a["i"], b["i"]], "t0": round(b["s"], 3),
                        "t1": round(a["e"], 3), "seconds": round(a["e"] - b["s"], 3),
                        "text": f"{a['w']} / {b['w']}"})
    return out


def check_joins(video, tol=0.001):
    """Joins whose source spans overlap: the right piece starts (src_a) before the left one
    ends (src_b), so that stretch of audio plays twice."""
    out = []
    for j in video.get("joins") or []:
        a, b = j.get("a"), j.get("b")
        if a is None or b is None:
            continue
        if a < b - tol and j.get("right_id", 0) > j.get("left_id", 0):
            out.append({"kind": "join_overlap", "k": j.get("k"), "out": j.get("out"), "a": a, "b": b,
                        "seconds": round(b - a, 3), "text": f"{j.get('left_text', '')} | {j.get('right_text', '')}"})
    return out
