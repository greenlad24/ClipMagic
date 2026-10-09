"""Motion templates (MO01-MO06, Jake 2026-10-09): parameter limits, UI kits (loading, privacy refusal, neutral
fallback, never another app's UI), the hook PROMPT → RESULT routing (MO05) vs the body screencast, and the plan
check's refusals (over budget, overlapping, outside the hook, missing kit / missing real result).
Run: python3 tests/test_motion_templates.py"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from aieditor import director, motiontemplates as MT, planfit, skill, uikits  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    assert cond, msg


def video(text, step=0.4, dur=None):
    ws = text.split()
    return {"title": "t", "duration": dur or len(ws) * step + 3,
            "words": [{"i": i, "word": w, "start": round(i * step, 3), "end": round(i * step + step * 0.8, 3)}
                      for i, w in enumerate(ws)]}


# ── rules.json + registry ──
R = skill.rules()["motion_templates"]
check(set(R["ids"]) == set(MT.IDS), f"rules.json ids {sorted(R['ids'])} != module {sorted(MT.IDS)}")
check(R["hook_s"] == 40.0, "hook = first 40 s (REFERENCE-BASELINE §1a)")
for t in MT.IDS:
    check(MT.spec(t)["technique"] == MT.TECHNIQUE[t], f"{t} technique id")
check(set(director.MOTION_OVERLAYS) == set(MT.IDS) - {"prompt_result"},
      "every motion template but MO05 is an overlay option; MO05 is placed by code only")
for t in director.MOTION_OVERLAYS:
    check(t in director.OVERLAY_TEMPLATES and t in director.overlay_schema()["properties"]["overlays"]["items"][
        "properties"]["template"]["enum"], f"{t} in the overlay schema enum")

# ── parameter limits ──
p, e = MT.validate_params("verb_swap", {"prefix": "Grok Bot can now", "verbs": ["search", "read", "analyze"], "suffix": "X"})
check(not e and p["backdrop"] is True and p["verbs"] == ["search", "read", "analyze"], f"verb_swap ref content ok {e}")
_, e = MT.validate_params("verb_swap", {"prefix": "Grok", "verbs": ["search"]})
check(any("verbs" in x for x in e), "verb_swap needs >= 2 verbs")
_, e = MT.validate_params("verb_swap", {"prefix": "Grok", "verbs": ["a", "b", "c", "d", "e"]})
check(any("verbs" in x for x in e), "verb_swap <= 4 verbs")
_, e = MT.validate_params("verb_swap", {"prefix": "one two three four five six seven", "verbs": ["a", "b"]})
check(any("words" in x for x in e), "verb_swap prefix <= 6 words")
_, e = MT.validate_params("tagline_build", {"words": "Every agent. One inbox."})
check(not e, f"tagline ref content ok {e}")
_, e = MT.validate_params("tagline_build", {"words": "Hi"})
check(any("min 2" in x for x in e), "tagline needs >= 2 words")
_, e = MT.validate_params("prompt_menu", {"items": ["A", "B", "C"], "pick": 5})
check(any("pick" in x for x in e), "prompt_menu pick must be one of the items")
_, e = MT.validate_params("prompt_menu", {"items": ["A", "B"], "pick": 0})
check(any("items" in x for x in e), "prompt_menu >= 3 rows")
_, e = MT.validate_params("prompt_card_3d", {"prompt": "x" * 221})
check(any("221" in x for x in e), "prompt_card_3d prompt <= 220 chars")
_, e = MT.validate_params("prompt_card_3d", {"prompt": "Write a launch email", "chips": [f"f{i}.pdf" for i in range(7)]})
check(any("chips" in x for x in e), "prompt_card_3d <= 6 chips")
_, e = MT.validate_params("prompt_highlight", {"prompt": "Put her face in the portrait panel and crop it",
                                                "phrases": ["face in the portrait panel"]})
check(not e, f"prompt_highlight phrase is a substring {e}")
_, e = MT.validate_params("prompt_highlight", {"prompt": "Put her face in the portrait panel", "phrases": ["not there"]})
check(any("not in the prompt" in x for x in e), "prompt_highlight phrases must be exact substrings")
_, e = MT.validate_params("prompt_highlight", {"prompt": "a b c d e f g h", "phrases": ["a", "b", "c", "d"]})
check(any("phrases" in x for x in e), "prompt_highlight <= 3 phrases")
_, e = MT.validate_params("prompt_highlight", {"prompt": "abcdefgh ij", "phrases": ["ij"], "push_in": 3})
check(any("push_in" in x for x in e), "prompt_highlight push_in range")

# ── beats on the spoken words ──
v = video("so Grok Bot can now search read and analyze X today")
ev = {"template": "verb_swap", "start": 1, "end": 9, "fields": {"prefix": "Grok Bot can now", "verbs": ["search", "read", "analyze"],
                                                              "suffix": "X"}}
t0, t1 = MT.window(ev, v)
lo, hi = MT.spec("verb_swap")["duration_s"]
check(lo - 1e-6 <= t1 - t0 <= hi + 1e-6, f"window within limits {t0}-{t1}")
b = MT.beats(ev, v, t0, t1)
check(abs(b["verb_0"] - (2.0 - t0)) < 1e-6 and abs(b["verb_2"] - (3.2 - t0)) < 1e-6, f"verbs on their words {b}")
ev2 = dict(ev, beats={"verb_1": 6})
check(abs(MT.beats(ev2, v, t0, t1)["verb_1"] - (2.4 - t0)) < 1e-6, "explicit beat (word id) wins")
v2 = video("every agent one inbox that is the pitch")
b = MT.beats({"template": "tagline_build", "start": 0, "end": 3, "fields": {"words": "Every agent. One inbox."}}, v2, 0.0, 2.0)
check([round(b[f"word_{k}"], 2) for k in range(4)] == [0.0, 0.4, 0.8, 1.2], f"tagline words on their words {b}")

# ── MO05 line detection + prompt derivation ──
check(MT.is_prompt_result_line("You just type one sentence in plain English and it builds you a full landing page."),
      "the hook prompt line")
check(MT.is_prompt_result_line("Type a single prompt and it writes the whole email"), "variant")
check(not MT.is_prompt_result_line("Then click the send button and wait"), "a UI step is not a prompt→result line")
check(MT.derive_prompt("You just type one sentence and it builds you a full landing page for a coffee shop.")
      == "Build me a full landing page for a coffee shop", MT.derive_prompt("…and it builds you a full landing page for a coffee shop."))
check(MT.derive_prompt('You just type "Make a logo for Blue Bottle" and it does the rest') == "Make a logo for Blue Bottle",
      "a quoted prompt wins")
check(MT.derive_prompt("you just type and it") is None, "nothing usable → None (no invented prompt)")

# ── UI kits: load, privacy, neutral fallback, never another app ──
tmp = Path(tempfile.mkdtemp(prefix="uikits-"))
good = {"app": "demo", "name": "Demo", "theme": "dark", "hosts": ["demo.example"],
        "composer": {"width": 700, "height": 120, "css": ".c{color:#fff}", "html": "<div class=c>{{prompt}}</div>",
                     "placeholder": "Ask anything"},
        "menu": {"items": [{"label": "Create image", "icon": "assets/i.svg"}]}, "display_name": "Jake Dawson"}
(tmp / "demo" / "assets").mkdir(parents=True)
(tmp / "demo" / "assets" / "i.svg").write_text('<svg viewBox="0 0 24 24"><path d="M1 2 3 4"/></svg>')
(tmp / "demo" / "kit.json").write_text(json.dumps(good))
k = uikits.load("demo", tmp)
check(k and k["app"] == "demo", "kit loads")
sk = uikits.scene_kit(k)
check(sk["menu"]["items"][0]["icon_html"].startswith("<svg") and "_dir" not in sk, "scene kit inlines icons, no paths")
check(uikits.load("nothere", tmp) is None, "no kit → None")
kit, note = uikits.for_app("other", base=tmp)
check(kit is None and "neutral box" in note and "never another app" in note, f"neutral fallback, logged: {note}")
(tmp / "wrong").mkdir()
(tmp / "wrong" / "kit.json").write_text(json.dumps({**good, "app": "demo"}))
kit, note = uikits.for_app("wrong", base=tmp)
check(kit is None and "another app" in note, "a kit claiming another app is refused")
(tmp / "leaky").mkdir()
(tmp / "leaky" / "kit.json").write_text(json.dumps({**good, "app": "leaky", "account": "someone@example.com"}))
try:
    uikits.load("leaky", tmp)
    check(False, "a kit with an e-mail must be refused (C7)")
except uikits.KitError as ex:
    check("C7" in str(ex), str(ex))
(tmp / "keyed").mkdir()
(tmp / "keyed" / "kit.json").write_text(json.dumps({**good, "app": "keyed", "x": "sk-abcdefghijklmnopqrstu"}))
check(uikits.for_app("keyed", base=tmp)[0] is None, "a kit with a key falls back to neutral")
check(uikits.app_for_url("https://demo.example/c/1", tmp) == "demo", "app from the kit's hosts")
check(uikits.app_for_url("https://chatgpt.com/", tmp) == "chatgpt", "built-in host map")
for a in uikits.apps():                 # the real kits in the skill folder are clean
    check(uikits.load(a) is not None, f"real kit {a} loads and passes the privacy check")

# ── planner routing: MO05 in the hook vs the body screencast ──
orig_root = uikits.root
uikits.root = lambda: tmp


def facts_with(result=True):
    a = [{"id": "hook_result", "kind": "app_generation", "status": "ready", "for": "MO05", "file": None,
          "prompt": "Build me a landing page"}] if result else []
    return planfit.Facts({}, {"assets": a})


words = ("Hey there. You just type one sentence in plain English and it builds you a full landing page. "
         + "Then we open the editor and click on the publish settings. " * 150).split()
long_v = {"title": "t", "duration": 0.4 * len(words) + 1,
          "words": [{"i": i, "word": w, "start": round(0.4 * i, 3), "end": round(0.4 * i + 0.3, 3)} for i, w in enumerate(words)]}
U = planfit.units(long_v)
for u in U:
    u["label"] = "A"
plate, notes = planfit.hook_prompt_result(U, long_v, facts_with(), "https://demo.example/")
check(plate and plate["technique"] == "MO05" and plate["t0"] < 40 and plate["app"] == "demo"
      and plate["assets"] == ["hook_result"], f"hook prompt line → MO05 plate {plate} {notes}")
lo, hi = MT.spec("prompt_result")["duration_s"]
check(lo - 1e-6 <= plate["t1"] - plate["t0"] <= hi + 1e-6, "MO05 within its duration limits")
check(any(u["label"] == "P" for u in U), "its units are plates (structure gate)")
U = planfit.units(long_v)
for u in U:
    u["label"] = "A"
plate, notes = planfit.hook_prompt_result(U, long_v, facts_with(result=False), "https://demo.example/")
check(plate is None and notes[0]["code"] == "no_result", "no REAL result → no MO05, honest route (never invented)")
plate, notes = planfit.hook_prompt_result(U, long_v, facts_with(), "https://nokit.example/")
check(plate is None and notes[0]["code"] == "no_kit", "no kit → no MO05 (never another app's UI)")
U = planfit.units(long_v)
for u in U:
    u["label"] = "S"
plate, notes = planfit.hook_prompt_result(U, long_v, facts_with(), "https://demo.example/")
check(plate is None and notes[0]["code"] == "covered" and notes[0]["eligible"], "covered by a screencast → re-ask (eligible)")
# the same line in the BODY stays a screencast
body_words = ("Intro line here. " * 40 + "You just type one sentence in plain English and it builds you a page. "
              + "More words follow here. " * 10).split()
body_v = {"title": "t", "duration": 0.4 * len(body_words) + 1,
          "words": [{"i": i, "word": w, "start": round(0.4 * i, 3), "end": round(0.4 * i + 0.3, 3)} for i, w in enumerate(body_words)]}
U = planfit.units(body_v)
for u in U:
    u["label"] = "A"
plate, notes = planfit.hook_prompt_result(U, body_v, facts_with(), "https://demo.example/")
check(plate is None and not notes, "a prompt line after the hook is not MO05 (body: screencast default)")
# plate cap: a 60 s video allows 0.9 s of plates → refused
short = dict(long_v, duration=60.0)
U = planfit.units(short)
for u in U:
    u["label"] = "A"
plate, notes = planfit.hook_prompt_result(U, short, facts_with(), "https://demo.example/")
check(plate is None and notes[0]["code"] in ("plate_cap", "short"), f"over the plate share → refused {notes}")

# ── the plan check for motion overlays ──
mv = video(" ".join(["word"] * 400), step=0.5, dur=800.0)


def ov(t, a, b, **f):
    return {"template": t, "t0": a, "t1": b, "fields": f}


ok_v = ov("verb_swap", 2.0, 5.0, prefix="Grok Bot can now", verbs=["search", "read"], suffix="X")
kept, dropped = MT.check([ok_v], mv)
check(len(kept) == 1 and kept[0]["technique"] == "MO01" and kept[0]["params"]["verbs"] == ["search", "read"], f"kept {dropped}")
kept, dropped = MT.check([ov("verb_swap", 120.0, 123.0, prefix="a b", verbs=["x", "y"])], mv)
check(not kept and "outside the hook" in dropped[0]["dropped"], "body → refused (screencast stays the default)")
kept, dropped = MT.check([ov("tagline_build", 1.0, 3.0, words="Every agent. One inbox."),
                          ov("verb_swap", 8.0, 11.0, prefix="a b", verbs=["x", "y"]),
                          ov("tagline_build", 20.0, 22.0, words="One more line")], mv)
check(len(kept) == 2 and "budget" in dropped[0]["dropped"], f"max 2 per video {dropped}")
kept, dropped = MT.check([ov("tagline_build", 1.0, 3.0, words="Every agent. One inbox."),
                          ov("tagline_build", 4.0, 6.0, words="Two words")], mv)
check(len(kept) == 1 and "within" in dropped[0]["dropped"], "min spacing between motion templates")
kept, dropped = MT.check([ov("verb_swap", 2.0, 5.0, prefix="a b", verbs=["x", "y"])], mv, segments=[{"t0": 4.0, "t1": 20.0}])
check(not kept and "screencast" in dropped[0]["dropped"], "never over a screencast")
kept, dropped = MT.check([ov("verb_swap", 2.0, 5.0, prefix="a b", verbs=["x", "y"])], mv,
                         plates=[{"t0": 0.0, "t1": 10.5}])
check(not kept and "plates" in dropped[0]["dropped"], "plates + motion over 1.5 % of the runtime → refused")
kept, dropped = MT.check([ov("verb_swap", 2.0, 2.5, prefix="a b", verbs=["x", "y"])], mv)
check(not kept and "lasts" in dropped[0]["dropped"], "too short → refused")
kept, dropped = MT.check([ov("prompt_result", 2.0, 9.0, prompt="Build me a landing page", app="nokit")], mv,
                         facts=facts_with())
check(not kept and "UI kit" in dropped[0]["dropped"], "prompt_result without a kit → refused")
kept, dropped = MT.check([ov("prompt_result", 2.0, 9.0, prompt="Build me a landing page", app="demo")], mv,
                         facts=facts_with(result=False))
check(not kept and "REAL result" in dropped[0]["dropped"], "prompt_result without a real result → refused")
kept, dropped = MT.check([ov("prompt_result", 2.0, 9.0, prompt="Build me a landing page", app="demo")], mv, facts=facts_with())
check(kept and kept[0]["params"]["result_asset"] == "hook_result" and kept[0]["kit"] == "demo", "prompt_result kept with kit + result")
logs = []
kept, dropped = MT.check([ov("prompt_menu", 2.0, 7.0, items=["A", "B", "C"], pick=1, app="nokit")], mv, log=logs.append)
check(kept and kept[0]["kit"] is None and any("neutral box" in m for m in logs), "prompt_menu without a kit → neutral box, logged")

# ── director: overlay validation keeps motion templates whole and refuses an overlap ──
dv = video("Grok Bot can now search read and analyze X " + "filler " * 40, step=0.4)
o, d = director.validate_overlays([{"template": "verb_swap", "start": 0, "end": 8, "fields": {"prefix": "Grok Bot can now",
                                                                                            "verbs": ["search", "read", "analyze"], "suffix": "X"}}], dv,
                                  [{"t0": 2.0, "t1": 9.0}])
check(not o and d[0]["dropped"] == "overlaps a screencast", "director refuses a motion template over a screencast")
o, d = director.validate_overlays([{"template": "verb_swap", "start": 0, "end": 8, "fields": {}}], dv, [])
check(o and o[0]["t1"] - o[0]["t0"] >= MT.spec("verb_swap")["duration_s"][0], "director times it by its own limits")
check("verb_swap" in director.overlay_prompt(dv, [], apps=["chatgpt"]) and "chatgpt" in director.overlay_prompt(dv, [], apps=["chatgpt"]),
      "the overlay call sees the motion templates + the job's apps")

# ── scenes ──
sc = MT.scene({**ok_v, "params": MT.validate_params("verb_swap", ok_v["fields"])[0]}, mv, 29.97, size=(3840, 2160))
check(sc["template"] == "verb_swap" and sc["scale"] == 2 and sc["outFirst"] == round(2.0 * 29.97) and sc["last"] == round(3 * 29.97) - 1,
      f"scene numbers frames by output frame {sc['outFirst']} {sc['last']}")
sc = MT.scene({"template": "prompt_result", "t0": 1.0, "t1": 8.0, "params": {"prompt": "Build", "app": "demo"}}, mv, 30,
              kit=uikits.load("demo", tmp), result={"kind": "text", "text": "Done"})
check(sc["template"] == "prompt_card_3d" and sc["variant"] == "prompt_result" and sc["params"]["result"]["text"] == "Done"
      and sc["kit"]["app"] == "demo", "MO05 renders on prompt_card_3d with the real result + kit")
check(MT.result_view({"file": None, "source": {}}) is None, "no file, no text → no result (never invented)")

uikits.root = orig_root
print(f"test_motion_templates: {N} checks passed")
