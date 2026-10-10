"""The screen-reference detector (aieditor/screenref.py, RULEBOOK R13 / C8) and its plan-check coverage rule:

  cues       the skill's rules.json "screen_reference" cue list flags deixis / screen language per sentence; a plain
             talking sentence and the presenter's own calls to action are never flagged
  coverage   covered_frac / uncovered against screencast spans (min_cover 0.8)
  plan check director.check_plan reports an uncovered flagged sentence as "screen_ref"; a segment over it clears it;
             a planned segment is never shrunk or removed by the rule
  hand-off   an uncovered sentence becomes its own slot (handoff.screen_ref_segments), merged with an adjacent slot
             of the same app, and the brief notes "Narrator refers to the screen here"

Run: python3 tests/test_screenref.py
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AIEDITOR_API_LEDGER", str(Path(tempfile.mkdtemp(prefix="screenref-ledger-")) / "api.jsonl"))
from aieditor import handoff, screenref, skill  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def words_of(text, t0=0.2, step=0.4):
    ws, t = [], t0
    for i, w in enumerate(text.split()):
        ws.append({"i": i, "word": w, "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += step
    return ws


def test_cues():
    g = skill.rules().get("screen_reference") or {}
    check(g.get("src") and g.get("cues") and 0 < g.get("min_cover", 0) <= 1, "rules.json carries the screen_reference group")
    flagged = [
        "Look at this, on the left a hot sauce bottle that I drew with a mouse.",
        "Now look at that.",
        "Here's the one I'm using.",
        "And there it is.",
        "You can see the word updated sitting right there next to it.",
        "As you can see, it kept the label.",
        "And on the right, what ChatGPT gave back to me.",
        "Click the erase feature and highlight the napkin.",
        "Open up Sketch from the plus menu.",
        "Type the change into the box and hit send.",
        "Paste the prompt in whole.",
        "Drag a box over the label.",
        "Scroll down to the templates.",
        "Upload the photo into a normal chat.",
        "This button does the whole thing.",
        "That toolbar has every tool.",
        "Choose the resize feature on the image.",
        "Watch this.",
        "Every one of these is on screen.",
        "It says updated.",
        "Check this out.",
        "Over here you get the comments.",
    ]
    for s in flagged:
        check(screenref.cues_in(s), f"flagged: {s}")
    plain = [
        "I help business owners use AI without it turning into another full-time job.",
        "That is the thing that OpenAI put front and center with this update.",
        "Here's what really got me.",
        "So here's where that leaves you.",
        "Now, here's the part that's really easy to miss.",
        "There is a version of this where my great grandma comes back looking like a highlighter.",
        "Three separate prompts means three separate generations.",
        "I've been there.",
        "What type of business do you run?",
    ]
    for s in plain:
        check(not screenref.cues_in(s), f"not flagged: {s} → {screenref.cues_in(s)}")
    presenter = ["Click on the video to my left and you will see exactly what I mean.",
                 "Click that notification bell to catch the latest show.",
                 "Hit that subscribe and smash that like button."]
    for s in presenter:
        check(not screenref.cues_in(s), f"the presenter's own line is never forced onto a screencast: {s}")
    ws = words_of("Look at this, on the left a hot sauce bottle. I drew it myself with a mouse. Here is the result.")
    fl = screenref.flag(ws)
    check([f["text"] for f in fl] == ["Look at this, on the left a hot sauce bottle.", "Here is the result."],
          f"sentence level: {[f['text'] for f in fl]}")
    check(fl[0]["word_ids"] == list(range(10)) and fl[0]["t0"] == ws[0]["start"] and fl[0]["t1"] == ws[9]["end"],
          "word ids and times of the sentence")
    check("look_at" in fl[0]["cues"] and "position" in fl[0]["cues"], f"cue ids: {fl[0]['cues']}")


def test_coverage():
    check(screenref.covered_frac(0, 10, [(0, 5), (4, 9)]) == 0.9, "overlapping spans merged")
    check(screenref.covered_frac(0, 10, []) == 0.0 and screenref.covered_frac(2, 4, [(0, 10)]) == 1.0, "none / all")
    fl = [{"t0": 0.0, "t1": 10.0}, {"t0": 20.0, "t1": 30.0}]
    check(screenref.uncovered(fl, [(0, 9)]) == [fl[1]], "90 % covered is covered (min 0.8)")
    check(screenref.uncovered(fl, [(0, 7)]) == fl, "70 % covered is not")


def plan_check_errors(segments):
    """director.check_plan on a tiny one-app plan → its error codes + messages."""
    from aieditor import director
    text = ("Welcome back to the channel. Look at this, on the left a hot sauce bottle. "
            "I drew it in ten seconds with a mouse. Then I asked for a real photo of it.")
    ws = words_of(text)
    video = {"title": "t", "duration": ws[-1]["end"] + 0.5, "words": ws}
    apps = {"chatgpt": {"actions": [], "pb": None, "hosts": ["chatgpt.com"], "url": "https://chatgpt.com/"}}
    ans = {"segments": segments, "aroll": [], "plates": [], "needs_primitive": []}
    errs, info = director.check_plan(ans, video, apps)
    return errs, info, ws


def test_plan_check():
    errs, _, ws = plan_check_errors([])
    sr = [e for e in errs if e["code"] == "screen_ref"]
    check(len(sr) == 1 and "Look at this" in sr[0]["msg"] and sr[0]["sentence"].startswith("Look at this"),
          f"an uncovered screen reference is a screen_ref error: {[e['msg'][:80] for e in errs]}")
    check(sr[0]["word_ids"] == list(range(5, 15)), f"its words: {sr[0]['word_ids']}")
    check(not any("drew it in ten seconds" in (e.get("sentence") or "") for e in sr) and
          not any("Welcome back" in (e.get("sentence") or "") for e in sr), "plain talking is never forced")
    seg = {"start_word": 5, "end_word": 14, "app": "chatgpt", "session": "logged_in",
           "beats": [{"word_id": 5, "action": "camera.zoom", "body": "the sketch and the photo side by side",
                      "subject": "screen", "text": None, "url": None, "asset_id": None, "live": False, "wait_end_word": None}]}
    errs, info, _ = plan_check_errors([seg])
    check(not [e for e in errs if e["code"] == "screen_ref"], f"covered by a screencast: {[e['msg'][:80] for e in errs]}")
    check(len(info["plan"]["segments"]) == 1 and info["plan"]["segments"][0]["start_word"] == 5,
          "the planned segment is kept as it is (never removed or shrunk)")


def test_handoff_slots():
    text = ("Welcome back to the channel. Look at this, on the left a hot sauce bottle. "
            "Open the image toolbar and click erase. I like how clean that came out. Thanks for watching.")
    ws = words_of(text)
    at = lambda w: next(x for x in ws if x["word"].strip(".,") == w)
    planned = [{"t0": at("Open")["start"], "t1": at("erase")["end"], "app": "chatgpt", "url": "https://chatgpt.com/",
                "intent": "on 'click erase': the Erase button"}]
    added = handoff.screen_ref_segments(planned, ws)
    check(len(added) == 1 and added[0]["screen_ref"].startswith("Look at this") and added[0]["app"] == "chatgpt",
          f"the uncovered sentence becomes its own segment with the neighbour's app: {added}")
    check(added[0]["t0"] == at("Look")["start"] and added[0]["t1"] <= planned[0]["t0"], "never overlaps a planned segment")
    merged, n_planned, n_added = handoff.editor_segments(planned, ws)
    check((n_planned, n_added, len(merged)) == (1, 1, 1), f"merged with the adjacent slot of the same app: {merged}")
    check(merged[0]["t0"] == added[0]["t0"] and merged[0]["t1"] == planned[0]["t1"] and len(merged[0]["parts"]) == 2,
          "one slot from the first sentence to the end of the planned one")
    slots = handoff.slots_of(merged, ws[-1]["end"] + 0.3)
    rows = handoff.brief_rows(slots, ws)
    check(len(rows) == 1 and len(rows[0]["steps"]) == 2, f"two numbered steps: {rows[0].get('steps')}")
    st1, st2 = rows[0]["steps"]
    check(st1["screen_ref"] and st1["on_screen"].startswith(handoff.SCREEN_REF_NOTE) and st1["words"].startswith("Look at this"),
          f"step 1 = the screen reference: {st1}")
    check(st2["words"].startswith("Open the image toolbar") and st2["start_tc"] < st2["end_tc"], "step 2 with its words and time")
    check(any(n.startswith(handoff.SCREEN_REF_NOTE) for n in rows[0]["notes"]), f"the brief notes it: {rows[0]['notes']}")
    page = handoff.brief_html(rows, {"title": "T", "width": 1920, "height": 1080, "fps_label": "29.97 fps"})
    check("Step 1" in page and "Step 2" in page and handoff.SCREEN_REF_NOTE in page, "the brief shows the steps + note")


if __name__ == "__main__":
    test_cues()
    test_coverage()
    test_plan_check()
    test_handoff_slots()
    print(f"test_screenref: {N} checks passed")
