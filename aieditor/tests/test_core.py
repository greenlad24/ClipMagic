"""Unit checks for the cut logic and plan validation. Run: python3 tests/test_core.py"""
import json
import math
import struct
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aieditor import edl, takes  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def silent_wav(seconds):
    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(f.name, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        # quiet noise floor with "speech" bursts every 0.5 s
        frames = []
        for i in range(int(seconds * 16000)):
            t = i / 16000
            amp = 8000 if (t % 0.5) < 0.3 else 30
            frames.append(int(amp * math.sin(2 * math.pi * 200 * t)))
        w.writeframes(struct.pack(f"<{len(frames)}h", *frames))
    return f.name


def speech_wav(spec, seconds):
    """Sound exactly where the words are, quiet room elsewhere."""
    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(f.name, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        fr = []
        for i in range(int(seconds * 16000)):
            t = i / 16000
            amp = 8000 if any(a <= t < b for _, a, b in spec) else 20
            fr.append(int(amp * math.sin(2 * math.pi * 180 * t)))
        w.writeframes(struct.pack(f"<{len(fr)}h", *fr))
    return f.name


def words(spec):
    return [{"i": i, "w": w, "s": s, "e": e} for i, (w, s, e) in enumerate(spec)]


# ---- sentences: punctuation and long pauses split; ids are stable
ws = words([("Hello", 0.0, 0.3), ("there.", 0.35, 0.7), ("So", 2.0, 2.2), ("we", 2.25, 2.4), ("go", 2.45, 2.7)])
ss = takes.sentences(ws)
check(len(ss) == 2 and [w["w"] for w in ss[1]] == ["So", "we", "go"], "sentence split")

# ---- pieces: frame-exact and the audio sample grid never drifts
for fps in (30.0, 30000 / 1001, 24.0, 25.0):
    rng = [(0.123 + k * 1.7, 0.123 + k * 1.7 + 0.913 + (k % 3) * 0.211, [{"i": k}], []) for k in range(200)]
    pieces, frames = edl.pieces_for(rng, fps)
    total_samples = sum(p["samples"] for p in pieces)
    check(total_samples == round(frames * 48000 / fps), f"sample grid exact at {fps}")
    for p in pieces:
        exact = p["frames"] * 48000 / fps
        check(abs(p["samples"] - exact) <= 1, f"piece within a sample of its frames at {fps}")
    check(all(pieces[k + 1]["out_frame"] == pieces[k]["out_frame"] + pieces[k]["frames"] for k in range(199)),
          "pieces tile the output")

# ---- gap cap: a 2 s pause inside a run becomes 0.35 s; a cut gets head/tail pads
wav = silent_wav(12)
audio = edl.Audio(wav)
ws = words([("one", 1.0, 1.3), ("two", 3.3, 3.6), ("three", 3.65, 3.9), ("four", 8.0, 8.3)])
by = {w["i"]: w for w in ws}
audio = edl.Audio(speech_wav([(w["w"], w["s"], w["e"]) for w in ws], 12))   # real silence between words
r = edl.ranges_for(ws, by, audio)
check(len(r) == 3, f"long pause splits into ranges: {len(r)}")
gap = (r[1][0] - ws[1]["s"]) * -1 + (r[0][1] - ws[0]["e"])
check(abs(gap - 0.35) < 0.09, f"capped silence ~0.35 s, got {gap:.3f}")
check(r[0][0] <= ws[0]["s"] and r[-1][1] >= ws[-1]["e"], "ranges cover their words")
check(all(x[1] > x[0] for x in r), "ranges are forward")
# dropping a word makes a cut that never reaches into the dropped word
kept = [ws[0], ws[2], ws[3]]
r2 = edl.ranges_for(kept, by, audio)
check(all(not (x[0] < ws[1]["e"] and x[1] > ws[1]["s"]) for x in r2), "dropped word stays out (shorts)")

# ---- output words land inside their piece, in order
pieces, frames = edl.pieces_for(r2, 30.0)
ow = edl.output_words(pieces, by, 30.0)
check([w["i"] for w in ow] == [0, 2, 3], "output word order")
check(all(ow[k]["start"] <= ow[k + 1]["start"] for k in range(len(ow) - 1)), "output words ascend")
check(ow[-1]["end"] <= frames / 30.0 + 1e-6, "output words inside the video")

# ---- validate: bad ids, duplicates and foreign drops are removed; reasons complete
# six two-word sentences: sentence n holds word ids 2n, 2n+1
ws = words([(f"a{k}" if k % 2 == 0 else f"b{k}.", k * 0.5, k * 0.5 + 0.3) for k in range(12)])
ss = takes.sentences(ws)
check(len(ss) == 6, "six sentences")
plan = {"videos": [{"title": "A", "segments": [{"s": 0, "drop": []}, {"s": 0, "drop": []}, {"s": 9},
                                                {"s": 2, "drop": [4, 11]}]},
                   {"title": "B", "segments": [{"s": 2}, {"s": 4, "drop": [8, 9]}]}],
        "removed": [{"s": 1, "why": "earlier take"}]}
v = takes.validate(plan, ss)
check([s["s"] for s in v["videos"][0]["segments"]] == [0, 2], "dedupe + bad id")
check(v["videos"][0]["segments"][1]["drop"] == [4], "foreign drop removed")
check(len(v["videos"]) == 1, "video whose only sentences are used/fully dropped disappears")
check({r["s"]: r["why"] for r in v["removed"]} == {1: "earlier take", 3: "not used", 4: "not used", 5: "not used"},
      "every unkept sentence has a reason")
try:
    takes.validate({"videos": []}, ss)
    check(False, "empty plan must fail")
except RuntimeError:
    check(True, "empty plan fails")

# ---- prompts carry Jake's sponsored rule
check("SPONSORED" in takes.CONTENT_RULE[True] and "Never cut a good line" in takes.CONTENT_RULE[True], "sponsored rule")
check("redundant" in takes.CONTENT_RULE[False] and "shorter" in takes.CONTENT_RULE[False], "unsponsored rule")

# ---- skipped speech: a 30 s "word" over continuous speech is flagged; real pauses are not
from aieditor import transcribe  # noqa: E402
loud = silent_wav(40)            # bursts every 0.5 s = continuous "speech"
la = edl.Audio(loud)
ws = [{"word": "hello", "start": 1.0, "end": 1.3}, {"word": "Umm,", "start": 1.4, "end": 31.0},
      {"word": "there", "start": 31.1, "end": 31.4}]
sp = transcribe.suspect_spans(ws, la)
check(any(a <= 1.5 and b >= 30.5 for a, b in sp), f"30 s fake word flagged: {sp}")
quiet = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
with wave.open(quiet, "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    fr = [int((8000 if (1 <= i / 16000 < 2 or 6 <= i / 16000 < 7) else 20) * math.sin(i / 10)) for i in range(16000 * 8)]
    w.writeframes(struct.pack(f"<{len(fr)}h", *fr))
ws = [{"word": "one", "start": 1.0, "end": 2.0}, {"word": "two", "start": 6.0, "end": 7.0}]
check(transcribe.suspect_spans(ws, edl.Audio(quiet)) == [], "a real silent pause is not flagged")

# ---- restart across a join: "... Claude Code." + "Claude Code is ..." drops the first copy
ws = words([("trip", 0, .2), ("people", .2, .4), ("up,", .4, .6), ("Claude", .6, .8), ("Code.", .8, 1.0),
            ("Claude", 5, 5.2), ("Code", 5.2, 5.4), ("is", 5.4, 5.5), ("great.", 5.5, 5.8)])
ss = takes.sentences(ws)
res = {"videos": [{"title": "x", "segments": [{"s": 0, "drop": []}, {"s": 1, "drop": []}]}], "removed": []}
check(takes.fix_seams(res, ss) == 1 and res["videos"][0]["segments"][0]["drop"] == [3, 4], "seam restart dropped")
ws = words([("we", 0, .2), ("love", .2, .4), ("it", .4, .6), ("so.", .6, .8), ("So", 2, 2.2), ("here", 2.2, 2.4), ("goes.", 2.4, 2.6)])
res = {"videos": [{"title": "x", "segments": [{"s": 0, "drop": []}, {"s": 1, "drop": []}]}], "removed": []}
takes.sentences(ws)
check(takes.fix_seams(res, takes.sentences(ws)) == 0, "a lone stopword repeat is left alone")

# ---- 5:00 rule: "redundant" before 5:00 goes back in; after 5:00 it may stay cut; sponsored = never
ws = words([(f"w{k}." , k * 10.0, k * 10.0 + 9.5) for k in range(60)])   # 60 x ~10 s sentences
ss = takes.sentences(ws)
def mk():
    return {"videos": [{"title": "x", "segments": [{"s": n, "drop": []} for n in range(60) if n not in (5, 50)]}],
            "removed": [{"s": 5, "why": "redundant: repeats point"}, {"s": 50, "why": "redundant: repeats point"}]}
r = mk(); back = takes.protect_opening(r, ss, sponsored=False)
check(back == [5], f"early redundant cut restored, late one kept cut: {back}")
check([g["s"] for g in r["videos"][0]["segments"]][:7] == [0, 1, 2, 3, 4, 5, 6], "restored in order")
r = mk(); check(sorted(takes.protect_opening(r, ss, sponsored=True)) == [5, 50], "sponsored restores every redundant cut")
r = mk(); r["removed"][0]["why"] = "retake: earlier take"
check(takes.protect_opening(r, ss, sponsored=False) == [], "retakes before 5:00 are still cut")

# ---- long-form: pauses under 0.5 s play as recorded; 0.5-0.9 s ones within the reference
# budget (REFERENCE-BASELINE §7: 1.9-4.0 per minute) too; longer ones and cuts are exactly 0.35 s
ws = words([("a", 1.0, 1.3), ("b", 1.75, 2.2), ("c", 4.0, 4.3), ("d", 9.0, 9.3)])   # pauses 0.45, 1.8, 4.7
by = {w["i"]: w for w in ws}
wav = speech_wav([(w["w"], w["s"], w["e"]) for w in ws], 12)
rl = edl.ranges_for(ws, by, edl.Audio(wav), exact_gap=True)
check(len(rl) == 3 and [w["i"] for w in rl[0][2]] == [0, 1], f"0.45 s pause kept inside the run: {[[w['i'] for w in r[2]] for r in rl]}")
for r1, r2 in zip(rl, rl[1:]):
    pause = (r1[1] + r1[5] - r1[2][-1]["e"]) + (r2[2][0]["s"] - r2[0] + r2[4])
    check(abs(pause - 0.35) < 0.051 or pause > 0.35, f"rebuilt pause is 0.35 s (or the words' own sound needs more): {pause:.3f}")
check(all(x[1] - x[0] > 0 for x in rl), "long-form ranges forward")
rs = edl.ranges_for(ws, by, edl.Audio(wav), exact_gap=False)
check(len(rs) == 4, "shorts still split every pause over 0.35 s")

# ---- the reference pause budget: ~68 s of speech with eleven 0.55-0.80 s pauses. The refs
# allow 1.9-4.0 pauses >= 0.5 s a minute (3/min budget): the 3 SHORTEST stay natural, the
# rest are rebuilt to 0.35 s; a 1.2 s pause is always rebuilt (refs: none >= 1.0 s)
spec, t = [], 0.5
for k in range(60):
    spec.append((f"w{k}", t, t + 0.9))
    gap = 0.55 + 0.025 * (k // 5) if k % 5 == 4 else (1.2 if k == 31 else 0.12)
    t += 0.9 + gap
ws = words(spec)
by = {w["i"]: w for w in ws}
pb_wav = speech_wav([(w["w"], w["s"], w["e"]) for w in ws], 12)
kb = edl.pause_budget(ws, edl.Audio(pb_wav))
long_ones = [w["i"] for w, n in zip(ws, ws[1:]) if n["s"] - w["e"] >= 0.5 and n["s"] - w["e"] <= edl.LONG_PAUSE_KEEP]
check(len(long_ones) == 11 and len(kb) == 11 - 3, f"budget keeps 3 of 11 natural pauses: {len(long_ones)} / {len(kb)}")
check(all(i not in kb for i in long_ones[:3]), "the 3 shortest pauses are the ones kept")
rb = edl.ranges_for(ws, by, edl.Audio(pb_wav), exact_gap=True)
pp_b, nf_b = edl.pieces_for(rb, 30.0)
ow_b = edl.output_words(pp_b, by, 30.0)
gb = [b["start"] - a["end"] for a, b in zip(ow_b, ow_b[1:])]
mins_b = nf_b / 30.0 / 60
check(sum(g >= 0.5 for g in gb) / mins_b <= 4.0, f"pauses >= 0.5 s within the refs' 4.0/min: {sum(g >= 0.5 for g in gb) / mins_b:.2f}")
check(max(gb) < 0.92 and not any(g >= 1.0 for g in gb), f"longest pause within the refs' 0.92 s: {max(gb):.2f}")

# ---- transcript repair splices in place and never reorders the rest
doc = {"words": [{"word": "using", "start": 10.0, "end": 10.3}, {"word": "in", "start": 10.5, "end": 10.6},
                 {"word": "this", "start": 10.45, "end": 10.7}, {"word": "video", "start": 10.4, "end": 11.0}]}
orig = [w["word"] for w in doc["words"]]
ws = doc["words"]
lo, hi, new = 20.0, 22.0, [{"word": "x", "start": 20.1, "end": 20.3}]
at = next((k for k, w in enumerate(ws) if lo <= w["start"] < hi), next((k for k, w in enumerate(ws) if w["start"] >= hi), len(ws)))
check(at == 4 and [w["word"] for w in ws[:at] + new] == orig + ["x"], "splice keeps Whisper's word order")
import inspect
check("sorted(keep + new" not in inspect.getsource(transcribe.repair), "repair does not re-sort the transcript")

# ---- 0:51 / 1:21 regressions: a removed word right after a kept one is never inside the
# range (the pause is held instead); long loud stretches are never muted as "clicks"
ws = words([("I", 1.0, 1.2), ("help", 1.25, 1.6), ("small", 1.62, 1.95), ("small", 2.0, 2.3), ("businesses", 2.35, 2.9)])
by = {w["i"]: w for w in ws}
kept = [ws[0], ws[1], ws[3], ws[4]]                     # the first "small" is removed
rr = edl.ranges_for(kept, by, edl.Audio(wav), exact_gap=True)
check(all(not (x[0] < ws[2]["e"] - 0.01 and x[1] > ws[2]["s"] + 0.01) for x in rr), f"removed 'small' outside every range: {[(round(x[0],2), round(x[1],2)) for x in rr]}")
check(len(rr) == 2 and all(x[4] == 0 and x[5] == 0 for x in rr), "never a held frame (Jake)")
check(rr[0][1] <= ws[2]["s"] + 0.03 and rr[1][0] >= ws[2]["e"] - 0.03, "join stays inside the real silence around the removed word")
check(all(x[4] == 0 and x[5] == 0 for x in edl.ranges_for(ws, by, edl.Audio(wav), exact_gap=True)), "no holds anywhere")
check(all(y - x <= edl.CLICK_MAX + 0.031 for x, y in edl._clicks(edl.Audio(loud), 0, 10)), "only short blips are muted")
pp, nf = edl.pieces_for(rr, 30.0)
check(all(p["frames"] == p["hold_head"] + p["src_frames"] + p["hold_tail"] for p in pp), "piece frames = holds + source")
check(any(t[0] == 0.0 for t in pp[1]["tone"]) or pp[1]["hold_head"] == 0, "held head is room tone")

# ---- 2:37 regression: an aligned neighbour overlapping the kept word never shortens it
w_inst = {"i": 0, "w": "installed.", "s": 1.0, "e": 1.6}
w_uh = {"i": 1, "w": "Uh,", "s": 1.4, "e": 1.55}
check(edl._sound_end(edl.Audio(loud), w_inst, w_uh["s"]) >= 1.6, "overlapping neighbour does not end the word early")
check(edl._sound_start(edl.Audio(loud), {"i": 1, "w": "x", "s": 2.0, "e": 2.3}, 2.2) <= 2.0, "overlapping neighbour does not start the word late")

# ---- filler-only joins: no 0.35 s minimum — the pause before the filler, then flow
ws = words([("we", 1.0, 1.2), ("should", 1.3, 1.6), ("uh,", 1.75, 2.1), ("go", 2.3, 2.5), ("now.", 2.55, 2.9),
            ("Next", 6.0, 6.3), ("line.", 6.4, 6.8)])
by = {w["i"]: w for w in ws}
kept = [ws[0], ws[1], ws[3], ws[4], ws[5], ws[6]]          # the "uh" removed
rf = edl.ranges_for(kept, by, edl.Audio(speech_wav([(w["w"], w["s"], w["e"]) for w in ws], 8)), exact_gap=True)
j = (rf[0][1] - ws[1]["e"]) + (ws[3]["s"] - rf[1][0])
check(j < 0.3, f"filler join is tighter than 0.35 s: {j:.3f}")
check(j <= 0.16, f"filler join closes up to a normal word gap: {j:.3f}")
j2 = (rf[1][1] - ws[4]["e"]) + (ws[5]["s"] - rf[2][0])
check(j2 >= 0.349, f"a real pause (> 0.7 s) still becomes >= 0.35 s: {j2:.3f}")

# ---- v3 Cowork: no cut lands on sound. A removed "uh" touching the kept word, and a
# drawn-out "ummm" running past its aligned end, are cut at the quiet point between.
ws = words([("go", 1.0, 1.4), ("uh", 1.42, 1.6), ("now", 1.62, 2.0), ("um", 3.0, 3.1), ("next", 4.2, 4.6)])
by = {w["i"]: w for w in ws}
# real sound: "uh" actually ends at 1.56, a 40 ms gap before "now"; "um" really rings to 3.9
aw = edl.Audio(speech_wav([("go", 1.0, 1.4), ("uh", 1.42, 1.56), ("now", 1.62, 2.0), ("um", 3.0, 3.9), ("next", 4.2, 4.6)], 6))
rv = edl.ranges_for([ws[0], ws[2], ws[4]], by, aw, exact_gap=True)
check(aw.rms_db(rv[1][0], rv[1][0] + 0.01) <= aw.floor() + edl.SPEECH_REL_DB, f"'now' starts in quiet: {rv[1][0]:.3f}")
check(1.56 <= rv[1][0] <= 1.63, f"'now' starts between the uh and its own sound: {rv[1][0]:.3f}")
check(rv[2][0] >= 3.9 or any(x <= rv[2][0] + 0.001 and y >= 3.9 - 0.011 for x, y in rv[2][3]),
      f"the ringing 'ummm' is out or room tone: {rv[2][0]:.3f} {rv[2][3]}")
# frame widening never brings a removed word's sound back: that sliver is room tone
pv, _ = edl.pieces_for(rv, 30.0, aw)
for p, x in zip(pv, rv):
    sl = x[0] - p["src_frame"] / 30.0
    if sl > 0.002 and aw.rms_db(p["src_frame"] / 30.0, x[0]) > aw.floor() + edl.SPEECH_REL_DB - 4:
        check(any(t0 <= 0.0005 and t1 >= sl - 0.0005 for t0, t1 in p["tone"]), "widened sliver is room tone")

# ---- 1:21 regression: words the transcript missed ("…by hand") sit in what looks like a
# pause between two kept words; they are played, never cut or room-toned
ws = words([("do", 1.0, 1.2), ("that.", 1.25, 1.5), ("Right?", 2.6, 2.9), ("Next", 6.0, 6.3)])
by = {w["i"]: w for w in ws}
aw = edl.Audio(speech_wav([("do", 1.0, 1.2), ("that.", 1.25, 1.5), ("by hand", 1.55, 2.2),
                           ("Right?", 2.6, 2.9), ("Next", 6.0, 6.3)], 7))
rh = edl.ranges_for(ws, by, aw, exact_gap=True)
inside = lambda t: any(x[0] <= t <= x[1] and not any(m0 <= t <= m1 for m0, m1 in x[3]) for x in rh)
check(all(inside(1.55 + k * 0.05) for k in range(13)), f"untranscribed 'by hand' is played: {[(round(x[0],2), round(x[1],2), x[3]) for x in rh]}")
check(len(rh) == 2, "the 0.4 s of real silence after it is a natural pause, not a cut")

# ---- Jake's hand nudges (review page): an edge moves by exactly his ms, keyed by word
ws = words([("one", 1.0, 1.3), ("two", 1.35, 1.6), ("three", 3.0, 3.3), ("four", 3.35, 3.6)])
by = {w["i"]: w for w in ws}
aw = edl.Audio(speech_wav([(w["w"], w["s"], w["e"]) for w in ws], 5))
base = edl.ranges_for(ws, by, aw, exact_gap=True)
nud = edl.ranges_for(ws, by, aw, exact_gap=True, nudges={"b:1": 20, "a:2": -15})
check(abs((nud[0][1] - base[0][1]) - 0.020) < 1e-6, "end nudged +20 ms")
check(abs((nud[1][0] - base[1][0]) + 0.015) < 1e-6, "start nudged -15 ms")
check(nud[0][6]["auto_b"] == base[0][1], "the automatic edge is remembered")
pz, _ = edl.pieces_for(nud, 30.0, aw)
jz = edl.joins_for(pz, by, 30.0)
check(len(jz) == 1 and jz[0]["left_id"] == 1 and jz[0]["right_id"] == 2 and abs(jz[0]["b"] - nud[0][1]) < 1e-3, "join data for the cut editor")
check(edl.ranges_for(ws, by, aw, exact_gap=True, nudges={"a:0": 5000})[0][0] < ws[0]["e"], "a nudge never swallows the word")

# ==== LEARNED FROM LINEARITY (Jake's corrections of linearity-10050728-8866) ====
def level_wav(spans, seconds, room=20):
    """(a, b, amp) spans over a quiet room; amp 8000 = speech, ~200 = a breath (+20 dB)."""
    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(f.name, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        fr = []
        for i in range(int(seconds * 16000)):
            t = i / 16000
            amp = next((am for a, b, am in spans if a <= t < b), room)
            fr.append(int(amp * math.sin(2 * math.pi * 180 * t)))
        w.writeframes(struct.pack(f"<{len(fr)}h", *fr))
    return f.name

# ---- consecutive kept words the aligner overlapped play as ONE run (no doubled audio)
ws = words([("list.", 1.0, 1.5), ("I'm", 1.1, 2.0), ("going", 2.05, 2.4)])
by = {w["i"]: w for w in ws}
aw = edl.Audio(level_wav([(1.0, 2.4, 8000)], 4))
ro = edl.ranges_for(ws, by, aw, exact_gap=True)
check(all(ro[k + 1][0] >= ro[k][1] for k in range(len(ro) - 1)), f"no range starts before the previous one ends: {[(round(x[0],2), round(x[1],2)) for x in ro]}")
check(len(ro) == 1, "overlapping consecutive words stay one run")

# ---- a sentence start that lands inside an in-breath keeps the WHOLE breath (<= 0.5 s)
ws = words([("end.", 1.0, 1.4), ("Next", 3.0, 3.3), ("line.", 3.35, 3.7)])
by = {w["i"]: w for w in ws}
br = [(1.0, 1.4, 8000), (2.5, 2.92, 200), (3.0, 3.7, 8000)]          # breath 2.50-2.92, +20 dB
aw = edl.Audio(level_wav(br, 5))
r_plain = edl.ranges_for(ws, by, aw, exact_gap=True)
r_br = edl.ranges_for(ws, by, aw, exact_gap=True, starts={1})
check(r_plain[1][0] > 2.6, f"without sentence starts the head is the plain 0.35 s join: {r_plain[1][0]:.3f}")
check(2.48 <= r_br[1][0] <= 2.51, f"head starts at the breath onset: {r_br[1][0]:.3f}")
check(3.0 - r_br[1][0] <= edl.BREATH_HEAD_MAX + 1e-6, "breath head capped")
check(not any(2.5 <= x < 2.92 for x, _ in r_br[1][3]), f"no part of the kept breath is muted: {r_br[1][3]}")
check(abs(r_br[0][1] - r_plain[0][1]) < 1e-6, "the tail before it is unchanged")
# the same breath far from the word (head already starts in quiet after it) is left alone
aw2 = edl.Audio(level_wav([(1.0, 1.4, 8000), (2.2, 2.6, 200), (3.0, 3.7, 8000)], 5))
r2 = edl.ranges_for(ws, by, aw2, exact_gap=True, starts={1})
check(abs(r2[1][0] - edl.ranges_for(ws, by, aw2, exact_gap=True)[1][0]) < 1e-6, "head in quiet: untouched")
# a short murmur (90 ms) the head lands in is left OUT, the lost pause goes to the tail
aw3 = edl.Audio(level_wav([(1.0, 1.4, 8000), (2.80, 2.89, 400), (3.0, 3.7, 8000)], 5))
r3 = edl.ranges_for(ws, by, aw3, exact_gap=True, starts={1})
check(r3[1][0] >= 2.89, f"head moved past the murmur: {r3[1][0]:.3f}")
check((r3[0][1] - 1.4) + (3.0 - r3[1][0]) >= 0.349, "pause still >= 0.35 s")
# speech before the word (louder than a breath) is never treated as a breath
aw4 = edl.Audio(level_wav([(1.0, 1.4, 8000), (2.5, 2.92, 8000), (3.0, 3.7, 8000)], 5))
r4 = edl.ranges_for(ws, by, aw4, exact_gap=True, starts={1})
check(abs(r4[1][0] - edl.ranges_for(ws, by, aw4, exact_gap=True)[1][0]) < 1e-6,
      f"loud sound before the word is not a breath (untranscribed speech keeps the 1:21 rule): {r4[1][0]:.3f}")

# ---- a dropped "So" run straight into the next word goes back in; one before silence stays out
ws = words([("kit.", 1.0, 1.4), ("So", 1.8, 1.95), ("that", 1.97, 2.3), ("works.", 2.35, 2.7),
            ("So", 4.0, 4.15), ("it", 4.6, 4.9), ("goes.", 4.95, 5.3),
            ("Uh,", 6.5, 6.7), ("you", 6.71, 7.0), ("see.", 7.05, 7.4)])
aw = edl.Audio(level_wav([(1.0, 1.4, 8000), (1.8, 2.7, 8000), (4.0, 4.15, 8000), (4.6, 5.3, 8000), (6.5, 7.4, 8000)], 8))
ss = takes.sentences(ws)
ft = takes.features(ss, aw)
check([i for f in ft for i in f["fused_so"]] == [1], f"only the run-together So is fused: {[f['fused_so'] for f in ft]}")
res = {"videos": [{"title": "x", "segments": [{"s": n, "drop": [i for i in (1, 4, 7) if any(w['i'] == i for w in ss[n])]}
                                               for n in range(len(ss))]}], "removed": []}
check(takes.keep_fused_so(res, ss, ft) == 1, "one So restored")
dr = sorted(i for g in res["videos"][0]["segments"] for i in g["drop"])
check(dr == [4, 7], f"fused So back, So before silence and the fused 'Uh' stay dropped: {dr}")
res2 = {"videos": [{"title": "x", "segments": [{"s": 0, "drop": []}, {"s": 1, "drop": [1, 2, 3]}]}], "removed": []}
ss2 = takes.sentences(ws[:4])
check(takes.keep_fused_so(res2, ss2, takes.features(ss2, aw)) == 0, "So stays dropped when the next word is dropped too")

# ---- phantom words: Whisper's collapsed timestamps (<= 30 ms each, >= 3 in a row)
raw = [("are", 1.0, 1.2, 1.0, 1.2), ("vector", 1.25, 1.6, 1.25, 1.6),
       ("That", 1.62, 1.9, 1.5, 1.6),          # overlaps "vector" in Whisper = the collapse starts
       ("was", 1.9, 2.05, 1.6, 1.62), ("a", 2.2, 2.25, 1.62, 1.64), ("good", 2.3, 2.5, 1.64, 1.66),
       ("idea.", 2.5, 2.8, 1.66, 2.3),         # starts where the collapse ends: part of it
       ("Real", 4.0, 4.3, 4.0, 4.3), ("pieces.", 4.35, 4.8, 4.35, 4.8)]
pw = [{"i": i, "w": w, "s": s_, "e": e_, "ws": a_, "we": b_} for i, (w, s_, e_, a_, b_) in enumerate(raw)]
aw = edl.Audio(level_wav([(1.0, 2.05, 8000), (4.0, 4.8, 8000)], 6))
mk_, sil_ = takes.phantoms(pw, aw)
check(mk_ == {2, 3, 4, 5, 6}, f"phantom run marked: {sorted(mk_)}")
check(sil_ == {4, 5, 6}, f"only the ones over silence are droppable: {sorted(sil_)}")
mk2, sil2 = takes.phantoms(pw, edl.Audio(level_wav([(1.0, 2.8, 8000), (4.0, 4.8, 8000)], 6)))
check(mk2 == mk_ and sil2 == set(), "mis-heard words over real speech (Cowork 'by hand') are never droppable")
check(takes.phantoms(words([("a", 0, .01), ("b", .01, .02), ("c", .02, .03)]), aw) == (set(), set()), "no Whisper times: no-op")
ss = takes.sentences(pw)
ft = takes.features(ss, aw)
pr = takes.build_prompt(ss, ft)
check("[3]~was" in pr and "[1]vector" in pr, "phantoms marked ~ in the prompt")
check("~" in takes.SYSTEM and "garbled" in takes.SYSTEM, "prompt explains ~ words")
res = {"videos": [{"title": "x", "segments": [{"s": 0, "drop": [1, 2, 3]}]}], "removed": []}
takes.fix_phantoms(res, ss, ft)
check(res["videos"][0]["segments"][0]["drop"] == [1, 2, 3, 4, 5, 6], "a mis-heard word is not put back after a dropped word")
res = {"videos": [{"title": "x", "segments": [{"s": 0, "drop": [1]}]}], "removed": []}
takes.fix_phantoms(res, ss, ft)
check(res["videos"][0]["segments"][0]["drop"] == [1, 2, 3, 4, 5, 6], f"mis-heard words left out of drop follow the cut word before them: {res['videos'][0]['segments'][0]['drop']}")
res = {"videos": [{"title": "x", "segments": [{"s": 0, "drop": [2]}, {"s": 1, "drop": []}]}], "removed": []}
check(takes.fix_phantoms(res, ss, ft) == 1, "phantoms fixed")
check(res["videos"][0]["segments"][0]["drop"] == [4, 5, 6], f"silent phantoms dropped, mis-heard word over sound kept: {res['videos'][0]['segments'][0]['drop']}")
res = {"videos": [{"title": "x", "segments": [{"s": 1, "drop": []}]}], "removed": []}
check(takes.fix_phantoms(res, ss, ft) == 0, "sentences without phantoms untouched")

print(f"test_core: {N} checks passed")
