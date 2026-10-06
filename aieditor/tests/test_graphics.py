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
print(f"test_graphics: {N} checks passed")
