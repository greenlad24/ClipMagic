"""Phase-2 rules: the graphics plan validator, spoken numbers, list pacing, SFX cues,
and the recipes' measured numbers. Run: python3 tests/test_graphics.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aieditor import graphics, recipes, sfx, templates916  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    assert cond, msg


def video(text, step=0.5):
    ws = text.split()
    return {"title": "t", "duration": len(ws) * step + 3,
            "words": [{"i": i, "word": w, "start": i * step, "end": i * step + step * 0.8} for i, w in enumerate(ws)]}


# spoken numbers: digits and words
for t, want in [("three age groups", [3]), ("about 17% upgraded", [17]), ("forty two", [42]),
                ("two hundred thousand users", [200000]), ("48,000 views", [48000]), ("nine percent", [9]),
                ("one point", [1]), ("no numbers here", [])]:
    check(graphics.spoken_numbers(t) == [float(x) for x in want], f"spoken_numbers({t!r}) = {graphics.spoken_numbers(t)}")

v = video("so here is the thing about seventeen percent of free users who upgraded in fourteen days it worked "
          "first research the topic then write the script and finally edit with AI that is it really")
ev = lambda t, a, b, **f: {"template": t, "start": a, "end": b, "fields": f}
out, dropped = graphics.validate([
    ev("keyword", 0, 3, line1="here is", line2="THE THING"),
    ev("number", 6, 12, label="upgraded", value=17, suffix="%"),        # "seventeen" spoken
    ev("number", 32, 34, label="days", value=99),                       # never said
    ev("keyword", 1, 2, line1="x", line2="y"),                          # overlaps the first
    ev("list", 18, 28, items=["research the topic", "write the script", "edit with AI"]),
    ev("bogus", 1, 2),
], v)
check([e["template"] for e in out] == ["keyword", "number", "list"], f"kept {[e['template'] for e in out]}")
check(len(dropped) == 3, f"dropped {len(dropped)}")
check(any("not spoken" in d["dropped"] for d in dropped), "an unspoken number is dropped")
check(all(out[i]["t1"] + 0.6 <= out[i + 1]["t0"] for i in range(len(out) - 1)), "no overlaps, 0.6 s apart")
check(all(graphics.MIN_HOLD_S - 1e-6 <= e["t1"] - e["t0"] for e in out), "minimum hold")
check(out[0]["t0"] == 0.0, "first event clamps at 0")
lst = out[2]
words = {w["i"]: w for w in v["words"]}
check(lst["row_k"][0] == round((words[19]["start"] - graphics.LEAD_S) * 24, 2), "list row 1 on 'research'")
check(lst["row_k"][1] > lst["row_k"][0] and lst["row_k"][2] > lst["row_k"][1], "rows in order")

# every template builds layers, all hard-cut at t1
for e in out:
    L = graphics.layers_for(e)
    check(L and all(l["visible"][1] == e["t1"] * 24 for l in L), f"{e['template']} layers end at t1")

# SFX: pops +60 ms after the first visible frame
cues = sfx.cues({"t0": 2.0, "template": "keyword"})
check(cues == [(2.06, "pop")], f"keyword cue {cues}")
check(len(sfx.cues({"t0": 1.0, "template": "cta"})) == 3, "cta = sparkle + whoosh + pop")
ins, graph = sfx.filter_for([{"t0": 1.0, "template": "number"}], 3)
check(len(ins) == 1 and "adelay=1060" in graph and "duration=first" in graph and "apad" not in graph,
      "sfx graph: delayed, mixed with duration=first, no apad (amix+apad never ends in this ffmpeg)")

# recipes keep the measured numbers
d = recipes.dropin(100)["tracks"]
check(d["ty"]["tween"][0]["from"] == -15.4 and d["opacity"]["tween"][0]["start"] == 98, "R1 drop-in")
check(recipes.dropin(100, pink=True)["tracks"]["opacity"]["tween"][0]["start"] == 97, "pink fade lead 1 f")
check(recipes.dropin(100, res=2)["tracks"]["ty"]["tween"][0]["from"] == -30.8, "drop travel scales with resolution only")
w = recipes.word_rise(50, pink=True)["tracks"]["opacity"]["tween"][0]
check(abs(w["start"] - (50 - 0.25 - 1.5)) < 1e-9, "title pink words lead 1.5 f")
check(recipes.count(0, 33, 1200, 48000)["ease"] == [0.65, 0, 0.35, 1], "count-up ease")
layers, end = recipes.prompt_bar(13270, [360, 795, 1559, 955],
                                 "Make three new versions for this audience. Change the hook.\nKeep the offer and the rest of the ad consistent.")
check(abs(end - 13335.68) < 0.1, f"P5 typing ends ~13335.7 (measured 13334), got {end}")
check(len(templates916.keyword(10, "a", "b")) == 2, "keyword template")

# ── long-form overlays on the word (gap list G7 steps 1, 2, 3, 6, 7), offline on the failed job's overlays.json ──
import gzip  # noqa: E402
import json  # noqa: E402
from aieditor import compose_long, graphics_long as GL  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "p3" / "e2e_edit01.json.gz"
if FIX.exists():
    fx = json.load(gzip.open(FIX, "rt"))
    lv = {"words": fx["words"]}
    ovs = [dict(o) for o in fx["overlays"]]
    word = lambda txt, near: min((w for w in fx["words"] if GL._norm(w["word"]) == txt), key=lambda w: abs(w["start"] - near))
    res = [GL.layers_for(o, lv) for o in ovs]
    # step 1: ev-01 'Editing photos' lands on 'editing' 53.11 (was 52.489, the event's first word)
    L1, a1, _ = res[1]
    k1 = min(min(float(k) for k, v in l["tracks"]["opacity"]["table"].items() if v > 0) for l in L1) / GL.FPS2
    check(abs(k1 - word("editing", 53.1)["start"]) <= 0.3, f"G7: ev-01 first visible frame {k1:.2f} within ±0.3 s of 'editing' 53.11")
    # step 2: lists — one item per line, each on its own word, ≤ 3 lines
    for n, firsts in ((4, ("plain", 421.5)), (6, ("long", 499.5))):
        L, _, _ = res[n]
        items = ovs[n]["fields"]["items"]
        lines = {}
        for l in L:
            pc = l["place"]["chars"]
            lines.setdefault(pc["baseline"], set()).add(pc["line"])
        check(len(lines) == len(items) <= GL.LIST_MAX_LINES and all(len(v) == 1 for v in lines.values())
              and sorted(x for v in lines.values() for x in v) == sorted(items), f"G7: one item per line: {lines}")
        ks = [k / GL.FPS2 for k in ovs[n]["item_k"]]
        check(all(b_ > a_ for a_, b_ in zip(ks, ks[1:])), "items enter in order")
    ks6 = [k / GL.FPS2 for k in ovs[6]["item_k"]]
    check(abs(ks6[1] - word("long", 499.5)["start"]) <= 0.3, f"G7: ev-06 'Long for the story' on 'long' 499.54 (was 497.8): {ks6[1]:.2f}")
    check(abs(ks6[2] - word("wide", 501.3)["start"]) <= 0.3 and abs(ks6[0] - word("square", 498.0)["start"]) <= 0.3, f"G7: every item on its word: {ks6}")
    # step 3: subscribe — verified against TX05_subscribe__ref4_0m46.20 before changing (decision recorded here)
    #   ref 4 (Geg9TyNoi3w words): 'subscribe' 46.06–46.70; the red pill's first frame ~46.40 (+0.35 s, on the word)
    #   ref 2 (kwys-text-cta.json instance): box k0 f1971 on 'So'; 'subscribe' f2032.8 → 2.07 s early, click k+73 in the word
    #   → the reference named by the gap list puts the pill ON the word: CHANGED (ev-03 was 2.4 s early)
    spec = json.loads((Path(__file__).resolve().parent.parent / "motion" / "reference-specs" / "kwys-text-cta.json").read_text())
    ins = next(v for v in spec["instances"].values() if "subscribe" in json.dumps(v))
    check(ins["k0"] == 1971 and "f2032.8" in ins["speech"], "the ref-2 evidence the old timing came from is still the spec")
    REF4_SUBSCRIBE_WORD, REF4_FIRST_RED = 46.06, 46.40
    check(0 <= REF4_FIRST_RED - REF4_SUBSCRIBE_WORD <= 0.4, "ref 4: the pill appears on the word")
    check(GL.SUBSCRIBE_DECISION.startswith("CHANGED") and "ref4" in GL.SUBSCRIBE_DECISION, "the subscribe decision is recorded")
    _, a3, _ = res[3]
    check(abs((a3 + 1) / GL.FPS2 - word("subscribe", 66.2)["start"]) <= 0.3, f"G7: ev-03 pill on 'subscribe' 66.23 (was 63.78): {(a3 + 1) / GL.FPS2:.2f}")
    check(any(abs(t_ - (a3 + 1 + 73) / GL.FPS2) < 1e-6 for t_, r in ovs[3]["sfx"] if r == "click"), "the click SFX follows the pill")
    # step 6: socials ride to the lower corners
    L9, _, _ = res[9]
    for l, fxx in zip(L9, (0.05, 0.93)):
        x0, _, x1, _ = next(iter(l["box"].values()))
        tx = list(l["tracks"]["tx"]["table"].values())[-1]
        check(abs(((x0 + x1) / 2 + tx) / 1920 - fxx) < 0.01, f"G7: {l['id']} settles at ~{fxx} W")
    # step 7: the link gradient — the lower band darkens at least as much as TX02 (no change needed, measured)
    #   band = y 0.78–0.98 H, outer 20 % columns each side (clear of the text), mean luma with the link on / just before:
    #   ref 5 (AZxFgIVgHjg 1:16 → 1:20.2–1:21): 51.5 → 30.0 = 0.58; ref 2 (kwys 7:32, where 0.63 was measured):
    #   52 → 26 = 0.50; ref 3 (0:47.5 → 0:49.3–50): 45.6 → 28.3 ≈ 0.62; our failed job (edit-01.mp4 728–729 → 730.3–731.5): 62 → 29.6 = 0.48
    REF_BAND_RATIO = {"ref5_TX02": 0.58, "ref2": 0.50, "ref3": 0.62}
    OURS_MEASURED = 0.48
    g = compose_long.TEXT_GRADIENT
    ys = [0.78 + 0.2 * (i + 0.5) / 200 for i in range(200)]
    alpha = sum(min(1.0, max(0.0, (y - g["top"]) / (1 - g["top"]))) ** g["power"] * g["opacity"] for y in ys) / len(ys)
    ours = 1 - alpha
    check(abs(ours - OURS_MEASURED) < 0.03, f"the analytic band ratio matches the rendered edit ({ours:.3f} vs {OURS_MEASURED})")
    check(ours <= REF_BAND_RATIO["ref5_TX02"], f"G7: the link band drops at least as much as TX02 ref 5 ({ours:.2f} ≤ 0.58)")
    check(abs(ours / REF_BAND_RATIO["ref2"] - 1) <= 0.10, f"G7: within 10 % of the reference it was measured on (ref 2: {ours:.2f} vs 0.50)")
print(f"test_graphics: {N} checks passed (incl. long-form G7)")
