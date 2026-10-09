"""The beat compiler + the elastic assembler's map (aieditor/beatscript.py) — offline, no video job, no browser.

Fixtures (read-only copies, never the live job): tests/fixtures/g3 holds the rejected job's plan (segments
t0/t1/url/intent) + output words and SCRATCH copies of seg-03 / seg-10 / seg-11 agent-steps.json
(factory-end-to-end-test-mac-rec-10082332-63de, "it didn't screencast the right things and didn't put them in
the right timings"); tests/fixtures/g3/loop_r2 holds a read-only copy of the loop round-2 hand-made beat
scripts (/opt/aieditor-work/loop/tools/scripts_r2.py) and that narration's words.

Expectations (REFERENCE-BASELINE §2b/§2c, RULEBOOK C1-C5/K1/K2/M1, recommendation §3.3):
  · a press lands within -0.15..0 s of its action word (today 25/60 in -0.2..+1.4 s, median +0.23 s)
  · the cursor starts 0.5-0.9 s before the word, never before the clause
  · typed text = the script, pasted whole into a cleared field, never retyped
  · <= 1 live generation per video, held 3.5-6 s while he talks about the wait, dissolving on the payoff;
    every other result = an assets.json id + a K2 reveal 6 f at word + 0.65 s
  · every beat carries a start state and an expected end state (text asserts + a fingerprint slot)
  · an action the playbook lacks / has not proven = needs_primitive (never improvised)
  · step 5 check: compiled presses agree with the loop round-2 hand-made beats within 1 frame
  · the elastic map moves ONLY motionless frames, presses on the word +-1 frame, results +0.2..+1.4 s

Run: python3 tests/test_beatscript.py
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import beatscript as B  # noqa: E402
from aieditor import playbook as PB  # noqa: E402
from aieditor import preprod  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


FX = ROOT / "tests" / "fixtures" / "g3"
JOB = Path("/opt/aieditor-work/jobs/factory-end-to-end-test-mac-rec-10082332-63de")
P = json.loads((FX / "plan.json").read_text())
WORDS = [{"i": i, "word": w, "start": s, "end": e} for i, w, s, e in P["words"]]
SEGS = P["segments"]
ASSETS = json.loads((FX / "assets.json").read_text())
DOODLES = B.doodles_from(ASSETS, preprod.doodle_svg)
FPS = B.FPS


def assets():
    return json.loads(json.dumps(ASSETS))


def steps_of(k):
    return json.loads((FX / f"seg-{k:02d}.agent-steps.json").read_text())


# the fixtures ARE scratch copies of the stored job's files (read-only; the job is never written)
for k in (3, 10, 11):
    live = JOB / "edit-01" / f"seg-{k:02d}" / "rec" / "agent-steps.json"
    if live.exists():
        check(json.loads(live.read_text()) == steps_of(k), f"fixture seg-{k:02d} = a copy of the job's agent-steps.json")


def proven(pb):
    for a in pb["actions"].values():
        a["proven"] = True
    return pb


PBX = proven(PB.playbook_copy("chatgpt"))
# a fixture extension: a Sketch-canvas draw and a markup drag (the real ChatGPT playbook has neither yet,
# so with it those beats are needs_primitive — tested below)
PBD = proven(PB.playbook_copy("chatgpt"))
PBD["actions"]["sketch_draw"] = {"kind": "draw", "label": "Draw on the Sketch canvas", "selectors": ["canvas"],
                                 "params": {"strokes": {"type": "array"}}, "proven": True, "source": "test fixture"}
PBD["actions"]["markup_drag"] = {"kind": "drag", "label": "Drag a markup box", "proven": True, "source": "test fixture"}
PBD["actions"]["sketch_submit"] = {"kind": "click", "label": "Submit the sketch", "selectors": ['button[aria-label="Done"]'],
                                   "intents": [r"\bcheck ?mark\b"], "proven": True, "source": "test fixture"}


def schema(k, pb=PBX):
    s = dict(SEGS[k], app="chatgpt", session="logged_in")
    s["beats"] = B.beats_from_intent(SEGS[k], WORDS, pb, k)
    return s


# ── 1. the rehearsal / repair cleaner: the agent's fumbles never reach a script ──
for k in (10, 11):
    st = steps_of(k)
    raw_types = [a["action"] for a in st if a.get("result") == "ok" and a["action"].get("type") == "type"]
    cr = B.compile_rehearsal(st)
    types = [a for a in cr if a["type"] == "type"]
    check(all(a.get("clear") and a.get("paste") for a in types), f"seg-{k:02d}: 0 append-type steps (all clear + paste)")
    check(not any(a["type"] == "key" and B.EDIT_KEYS.match(str(a.get("key"))) for a in cr), f"seg-{k:02d}: no select-all / Backspace")
    texts = [a["text"] for a in types]
    check(len(texts) == len(set(texts)), f"seg-{k:02d}: no retype {texts}")
    check(len(types) < len(raw_types), f"seg-{k:02d}: the agent's retypes collapsed ({len(raw_types)} -> {len(types)})")
st3 = B.compile_rehearsal(steps_of(3))
check(sum(1 for a in st3 if a["type"] == "type" and a.get("text") == "@Sketch") == 1, "seg-03 rehearsal: '@Sketch' once (was 5 tries)")
check(not any(a["type"] == "goto" and a.get("url") == "https://chatgpt.com/" for a in st3), "seg-03: the fumble reload is gone")
check(sum(1 for a in st3 if a["type"] == "click" and a.get("ref") == "r95") == 1, "seg-03: the check mark pressed once (gap #29)")

# ── 2. compiled segments (legacy intents -> playbook beats -> script): typed text = the script ──
for k in (3, 10, 11):
    seg = schema(k, PBD)
    sc = B.compile_segment(seg, WORDS, PBD, k, assets=assets(), doodles=DOODLES, rehearsal=steps_of(k))
    want = [b["typed_text"] for b in seg["beats"] if b.get("typed_text")]
    typed = [s for s in sc["steps"] if s["type"] == "type"]
    check(typed and all(s.get("clear") and s.get("paste") for s in typed), f"seg-{k:02d}: 0 append-type steps")
    check([s["text"] for s in typed] == want, f"seg-{k:02d}: typed text == the script {[s['text'] for s in typed]} vs {want}")
    check(all(s["assert"]["field_equals"] == s["text"] for s in typed), f"seg-{k:02d}: each paste asserts field == script")
    if k == 3:
        check(sum(1 for s in typed if s["text"] == "@Sketch") == 1, "seg-03 compiles with 0 '@Sketch' retypes")
sc3 = B.compile_segment(schema(3, PBD), WORDS, PBD, 3, assets=assets(), doodles=DOODLES)
draws = [s for s in sc3["steps"] if s["type"] == "draw"]
check(len(draws) == 4 and all(s["strokes"] for s in draws), f"seg-03: bottle, table, sun, pepper drawn on their words (gap #23: {len(draws)})")
check([s["word"].lower().strip(",.") for s in draws] == ["squat", "picnic", "wonky", "chili"], "seg-03: draws on their words")
check(any(s["type"] == "reveal" for s in sc3["steps"]), "seg-03: the sketch->photo result is a K2 reveal (gap #24)")
try:
    B.compile_segment(schema(3, PBD), WORDS, PBD, 3, assets=assets(), doodles=[])
    check(False, "a draw beat without a sketch asset compiles")
except B.CompileError as e:
    check("never a blank canvas" in str(e), "no sketch strokes -> not recorded (never a blank canvas, gap #23)")
# with the real ChatGPT playbook (no draw / drag action) those beats are needs_primitive, never improvised
try:
    B.compile_segment(schema(3), WORDS, PBX, 3, assets=assets(), doodles=DOODLES)
    check(False, "a draw beat compiles without a playbook draw action")
except B.NeedsPrimitive as e:
    check(any(m["status"] == "missing" and "draw" in str(m["action"]) for m in e.beats), f"draw -> needs_primitive: {e.beats}")
sc9 = B.compile_segment(schema(9), WORDS, PBX, 9, assets=assets())
up = [s for s in sc9["steps"] if s["type"] == "upload"]
check(up and up[0]["asset"] == "hot_sauce_photo", "seg-09: 'Upload the photo' attaches the hot sauce photo (gap #35)")
reh4 = [{"action": {"type": "drag", "from": [600, 330], "to": [700, 420]}, "result": "ok"}]
sc4 = B.compile_segment(schema(4, PBD), WORDS, PBD, 4, assets=assets(), rehearsal=reh4)
dg = next(s for s in sc4["steps"] if s["type"] == "drag")
check(dg["drag_from"] == [600, 330] and dg["word"].lower() == "drag", "seg-04: the markup box dragged on 'drag' (gap #31)")
sc10 = B.compile_segment(schema(10), WORDS, PBX, 10)
rm = next(s for s in sc10["steps"] if s["type"] == "type" and s["text"] == "Remove the man")
check(-0.15 <= B.pressed_frame(rm["at"]) / FPS - rm["word_t"] <= 0, "seg-10: 'Remove the man' pasted on its word, never before (gap #36)")

# ── 3. the whole plan ──
SCHEMA = [schema(k, PBD) for k in range(len(SEGS))]
C = B.compile_plan(SCHEMA, WORDS, {"chatgpt": PBD}, assets=assets(), doodles=DOODLES, rehearsals={4: reh4})
blocked = {k: v["kind"] for k, v in C["blocked"].items()}
check(set(blocked.values()) <= {"needs_primitive", "compile"}, f"what does not compile is held: {C['blocked']}")
# 0 / 2 name the pricing page inside the logged-in plan (outside_only, RULEBOOK L4), 5 drops pins (no pin action),
# 6 brushes the napkin with the Erase tool (no strokes exist for it: never invented)
check(set(blocked) == {0, 2, 5, 6}, f"blocked segments: {sorted(blocked)} {C['blocked']}")
offs = B.press_offsets(C)
check(len(offs) >= 30, f"named presses compiled ({len(offs)})")
check(all(B.PRESS_BAND[0] - 1e-9 <= o <= B.PRESS_BAND[1] + 1e-9 for o in offs),
      f"100 % of named presses within -0.15..0 s of their word: {B.summary(offs)}")
check(all(-0.05 - 1e-9 <= o <= 0 for o in offs), "the press frame is the frame just before the word (word - 0.05 s on the grid)")
check(C["live_sends"] <= 1, f"<= 1 live generation per video ({C['live_sends']})")
ids = {a["id"] for a in C["assets"]["assets"]}
n_res = 0
for sc in C["segments"]:
    for s in sc["steps"]:
        if s.get("generates") and not s.get("live"):
            check(s.get("press") is False, f"seg {sc['seg']}: a non-live result press is a dry press")
        if s["type"] == "reveal":
            n_res += 1
            check(s["asset"] in ids, f"seg {sc['seg']}: a reveal references an assets.json id")
            check(s["frames"] == 6, "K2 dissolve 6 f")
            check(abs(round(s["at"] - s["word_t"], 3) - 0.65) < 1e-6, f"K2 at word + 0.65 s ({s['at'] - s['word_t']:.3f})")
        if s["type"] == "read":
            check(s["ms"] <= B.MAX_STILL * 1000, "no read > 3 s")
        if s.get("beat") and s["type"] in B.PRESS_KINDS:
            check(s["from"] <= s["at"] + 1e-4, f"seg {sc['seg']}: a move never starts after its press")
    for s in [x for x in sc["steps"] if x.get("generates") and not x.get("live")]:
        check(any(x["type"] == "reveal" and x["at"] >= s["at"] for x in sc["steps"]),
              f"seg {sc['seg']}: every dry press is followed by its K2 reveal")
    # no still > 3 s: consecutive timed steps (or the segment end) never more than 3 s apart outside a live wait
    timed = [s["at"] for s in sc["steps"] if s.get("at") is not None]
    lives = [(s["at"], s["until"]) for s in sc["steps"] if s.get("live") and s["type"] == "wait_for"]
    for x, y in zip(timed, timed[1:] + [sc["t1"] - sc["t0"]] if timed else []):
        if not any(a - 0.01 <= x <= b + 0.01 for a, b in lives):
            check(y - x <= B.MAX_STILL + 1e-6, f"seg {sc['seg']}: a {y - x:.2f} s still at {x:.2f}")
check(n_res >= 5, f"results revealed off camera ({n_res})")
live = [(sc, s) for sc in C["segments"] for s in sc["steps"] if s["type"] == "wait_for" and s.get("live")]
check(len(live) == 1, "one live wait (the progress-counter beat)")
sc, w = live[0]
check(sc["seg"] == 1, "the live beat is the % counter in segment 1 (\"a percentage counter while it works … 40%, then 65\")")
check(B.LIVE_SHOW[0] <= w["show"] <= B.LIVE_SHOW[1], f"in-progress state held 3.5-6 s ({w['show']})")
lb = next(b for b in SCHEMA[1]["beats"] if b.get("live"))
wt0, wt1 = lb["wait_talk"]["t0"] - SEGS[1]["t0"], lb["wait_talk"]["t1"] - SEGS[1]["t0"]
nxt = next(x for x in WORDS if x["start"] - SEGS[1]["t0"] >= wt1 - 1e-6)            # the first word after the wait talk
check(abs(w["until"] - (nxt["start"] - SEGS[1]["t0"] + B.K2_AFTER)) < 0.01 and w["until"] > wt1,
      f"gap #22: the finished live image dissolves after the wait talk, on its payoff word '{nxt['word']}' (+K2) — "
      f"not 13 s early before the counter is ever framed ({w['until']})")
check(B.LIVE_SHOW[0] <= w["word_t"] - wt0 <= B.LIVE_SHOW[1] + 1e-6, "the payoff lands 3.5-6 s into the wait talk")
check(w["until"] - B.K2_AFTER >= wt0 + B.LIVE_SHOW[0] - 1e-6, "the in-progress state is held at least 3.5 s")
# cursor lead: 0.5-0.9 s before the word when the clause allows, never before the clause's lead-in
leads = []
for sc in C["segments"]:
    for s in sc["steps"]:
        if s.get("beat") and s["type"] in ("click", "type", "drag") and s.get("cursor_at") is not None:
            lead = s["word_t"] - s["cursor_at"]
            check(lead <= B.CURSOR_BAND[1] + 1e-6, f"cursor lead {lead:.2f} <= 0.9 s")
            leads.append(lead)
            if s.get("travel_ms") is not None:
                check(abs(s["at"] - (s["travel_ms"] / 1000 + s["settle_s"]) - s["cursor_at"]) < 0.002,
                      "agent_rec starts the cursor at cursor_at (travel + settle before the press)")
check(sum(1 for x in leads if B.CURSOR_BAND[0] - 1e-6 <= x <= B.CURSOR_BAND[1] + 1e-6) >= 0.6 * len(leads),
      f"most cursor moves start 0.5-0.9 s before the word ({sorted(round(x, 2) for x in leads)})")
check(sum(1 for x in leads if abs(x - 0.8) < 0.01) >= 5, "the aim is word - 0.8 s")
# every beat: start state + expected end state (asserts + a fingerprint slot filled by the rehearsal)
for sc in C["segments"]:
    for k, b in enumerate(sc["beats"]):
        check("start_state" in b and "end_state" in b and "fingerprint" in b["end_state"], f"seg {sc['seg']} beat {b['id']}: states")
        if k == 0:
            check(b["start_state"].get("url") and b["start_state"].get("set_dressing"), "beat 0 starts from the playbook start_state")
        else:
            check(b["start_state"]["after"] == sc["beats"][k - 1]["id"], "beat k starts where beat k-1 ended")
sc10 = next(s for s in C["segments"] if s["seg"] == 10)
pb_ = next(b for b in sc10["beats"] if b["action"] == "paste_prompt")
check({"kind": "text", "selector": '[contenteditable="true"]', "value": next(sc10["steps"][i]["text"] for i in pb_["steps"]
                                                                          if sc10["steps"][i]["type"] == "type")}
      in pb_["end_state"]["asserts"], "a paste beat's end state: the field holds exactly the script (playbook post)")

# ── 4. the plan may only name proven playbook actions ──
real = PB.playbook_copy("chatgpt")
for _a in real["actions"].values():                         # proven: false until it replays 3/3 (the real file is
    _a["proven"] = False                                    # proven since the 2026-10-09 proving run)
try:
    B.compile_segment(schema(10, PBX), WORDS, real, 10, allow_unproven=False)
    check(False, "an unproven action compiles")
except B.NeedsPrimitive as e:
    check(all(m["status"] == "unproven" for m in e.beats) and e.beats, f"unproven -> needs_primitive: {e.beats[:2]}")
bad = dict(SEGS[10], app="chatgpt", session="logged_in",
           beats=[{"id": "x1", "word_id": 1, "t_word": SEGS[10]["t0"] + 1.0, "action": "invent_background_skill"}])
try:
    B.compile_segment(bad, WORDS, PBX, 10)
    check(False, "an invented action compiles")
except B.NeedsPrimitive as e:
    check(e.beats[0]["status"] == "missing" and e.kind == B.NEEDS_PRIMITIVE, "an invented action -> needs_primitive")
try:
    B.compile_segment(dict(SEGS[10], app="chatgpt", beats=[]), WORDS, PBX, 10)
    check(False, "a segment without plan-schema beats compiles")
except B.NeedsPrimitive:
    check(True, "")

# ── 5. hard rules of a script ──
for badst in ([{"type": "type", "text": "x", "clear": False, "paste": True}],
              [{"type": "hold", "s": 4.0}],
              [{"type": "key", "key": "Control+a"}],
              [{"type": "type", "text": "a", "clear": True, "paste": True}, {"type": "type", "text": "a", "clear": True, "paste": True}]):
    try:
        B.validate_script(badst)
        check(False, f"validate_script accepts {badst}")
    except B.CompileError:
        check(True, "")
check(B.clamp_action({"type": "hold", "s": 9})["s"] == 3.0, "a hold > 3 s is clamped to 3 s")
check(B.clamp_action({"type": "read", "ms": 9000})["ms"] == 3000, "a read > 3 s is clamped")

# ── 6. STEP 5 CHECK: compiled presses vs the loop round-2 hand-made beats (within 1 frame) ──
R2 = json.loads((FX / "loop_r2" / "words.json").read_text())
RW = [{"i": i, "word": w, "start": s, "end": e} for i, w, s, e in R2["words"]]
src = (FX / "loop_r2" / "scripts_r2.py.txt").read_text()
parts = re.split(r"\ndef (seg\d)\(", src)
hand = []
for name, body in zip(parts[1::2], parts[2::2]):
    for m in re.finditer(r'"type": "(\w+)"((?:(?!"type": ).)*?)"at": rel\(wt\("([^"]+)", ([\d.]+)\)(\s*[+-]\s*[\d.]+)?\)', body, re.S):
        if m.group(5):
            continue                                       # deliberately offset from the word (inside a cut)
        hand.append((int(name[3:]), m.group(1), m.group(3), float(m.group(4))))
check(len(hand) >= 30, f"round-2 hand-made beats parsed ({len(hand)})")


def wt(word, near):
    """= scripts_r2.wt: start of `word` closest to `near`."""
    nm = lambda s: "".join(c for c in s.lower() if c.isalnum() or c == "-")
    c = [w for w in RW if nm(w["word"]) == nm(word) and abs(w["start"] - near) < 1.5]
    return min(c, key=lambda w: abs(w["start"] - near))


LIN = {"app": "linearity-r2", "hosts": ["linearity.io"], "version": "test", "start_state": {"url": "https://cloud.linearity.io/", "asserts": []},
       "set_dressing": [], "features": {}, "actions": {
           "click_target": {"kind": "click", "label": "Click", "selectors": ["text={label}"], "params": {"label": {"type": "string"}}, "proven": True, "source": "test"},
           "paste_text": {"kind": "paste", "label": "Paste", "selectors": ["textarea"], "params": {"text": {"type": "string"}}, "proven": True, "source": "test"},
           "goto_page": {"kind": "goto", "label": "Go", "url": "https://www.linearity.io/", "proven": True, "source": "test"},
           "key_escape": {"kind": "key", "label": "Escape", "params": {"key": {"type": "string", "default": "Escape"}}, "proven": True, "source": "test"}}}
KIND = {"click": "click_target", "dblclick": "click_target", "type": "paste_text", "goto": "goto_page", "read": "camera", "key": "key_escape"}
diffs = []
for si, seg in enumerate(R2["segments"]):
    rows = [h for h in hand if h[0] == si]
    if not rows:
        continue
    beats = []
    for n, (_, typ, word, near) in enumerate(rows):
        w = wt(word, near)
        b = {"id": f"r{si}{n:02d}", "word_id": w["i"], "t_word": w["start"], "action": KIND[typ], "word": w["word"], "params": {}}
        if typ in ("click", "dblclick"):
            b["params"]["label"] = w["word"]
        if typ == "type":
            b["params"]["text"] = f"text {n}"
        beats.append((b, typ))
    # beats on the same word (a goto + its read): one compiled beat each, in order
    sc = B.compile_segment({**seg, "app": "linearity-r2", "session": "logged_in", "beats": [b for b, _ in beats]}, RW, LIN, si)
    for (b, typ) in beats:
        hand_at = round(b["t_word"] - seg["t0"], 3)
        cs = next(s for s in sc["steps"] if s.get("beat_id") == b["id"] and s.get("beat"))
        d = B.pressed_frame(cs["at"]) - B.pressed_frame(hand_at)
        diffs.append((b["id"], typ, b["word"], d))
check(all(abs(d) <= 1 for *_, d in diffs), f"compiled presses within 1 frame of the round-2 hand-made beats: "
      f"{[x for x in diffs if abs(x[3]) > 1]}")
check(sum(1 for *_, d in diffs if d == 0) >= 10 and all(d in (-1, 0) for *_, d in diffs),
      "camera/goto beats land on the same frame; presses exactly one frame earlier (the frame before the word)")
print(f"  step-5 check: {len(diffs)} round-2 beats — frame differences {sorted(set(d for *_, d in diffs))}")

# ── 7. fingerprints ──
img = [((x // 8) * 37 + (y // 6) * 11) % 255 for y in range(36) for x in range(64)]
h1 = B.dhash(img, 64, 36)
img2 = list(img)
img2[5] = (img2[5] + 3) % 255                               # a caret / a cursor pixel
check(len(h1) == 16 and B.hamming(h1, B.dhash(img2, 64, 36)) <= B.FP_MAX_DIST, "a near-identical screen keeps its fingerprint")
flip = [255 - v for v in img]
check(B.hamming(h1, B.dhash(flip, 64, 36)) > B.FP_MAX_DIST and not B.same_state(h1, B.dhash(flip, 64, 36)), "another screen does not")

# ── 8. the elastic map (pure): only motionless frames move ──
fps = FPS
n = int(20 * fps)
motion = [None] + [0.0] * (n - 1)
moving = [(2.0, 3.0), (6.0, 6.8), (11.0, 12.5), (16.0, 16.4)]          # cursor travel / typing / a glide
for a, b in moving:
    for i in range(int(a * fps), int(b * fps)):
        motion[i] = 9.0
words_t = [3.0, 7.5, 12.0, 16.0]                                        # the action words
late = [0.4, 1.3, 2.5, 0.9]                                             # presses recorded late
anchors = []
for wt_, lt in zip(words_t, late):
    src = int(round((wt_ + lt) * fps))
    motion[src] = 25.0                                                  # the press itself changes the screen
    anchors.append({"src": src, "want": int(round(wt_ * fps)), "kind": "press", "beat": f"p{wt_}"})
res_src = int(round((7.5 + 1.3 + 0.3) * fps))                           # a result 0.3 s after the late press
motion[res_src] = 30.0
anchors.append({"src": res_src, "want": int(round((7.5 + B.K2_AFTER) * fps)), "kind": "result",
                "lo": math.ceil((7.5 + 0.2) * fps), "hi": math.floor((7.5 + 1.4) * fps), "beat": "r"})
em = B.elastic_map(motion, anchors, int(round(16.0 * fps)) + int(4 * fps))
idle = B.idle_frames(motion)
check(em["ok"], f"every anchor reachable: {em['failures']}")
for a in em["anchors"]:
    if a["kind"] == "press":
        check(abs(a["got"] - a["want"]) <= 1, f"press on its word +-1 frame ({a})")
    else:
        check(math.ceil((7.5 + 0.2) * fps) <= a["got"] <= math.floor((7.5 + 1.4) * fps), f"result +0.2..+1.4 s ({a})")
check(all(idle[i] for i in em["dropped"]) and all(idle[i] for i in em["duplicated"]),
      "every dropped / repeated frame is motionless")
check(not any(motion[i] and motion[i] >= B.MOTION_THR for i in em["dropped"] + em["duplicated"]), "never a moving frame")
kept_moving = [i for a, b in moving for i in range(int(a * fps), int(b * fps))]
check(all(i in em["frames"] for i in kept_moving), "all motion is kept (never cut)")
check(em["frames"] == sorted(em["frames"]), "time never runs backwards")
# not enough idle frames: a timing failure, reported (never a cut through motion)
busy = [None] + [9.0] * (n - 1)
em2 = B.elastic_map(busy, [{"src": int(5 * fps), "want": int(3 * fps), "kind": "press", "beat": "b"}], n)
check(not em2["ok"] and em2["failures"][0]["dim"] == "D2" and not em2["dropped"], "no idle frames -> timing failure, nothing cut")
# early press: idle frames repeated before it
em3 = B.elastic_map(motion[:], [{"src": int(4 * fps), "want": int(5 * fps), "kind": "press", "beat": "e"}], n)
check(em3["ok"] and em3["duplicated"] and all(idle[i] for i in em3["duplicated"]), "an early press waits on repeated still frames")
# anchors from recorder events
evs = [{"t": 3.3, "press": 3.4, "type": "click", "word_t": 3.0, "beat": True, "beat_id": "b0"},
       {"t": 4.1, "type": "nav", "k2": {"frames": 6}, "word_t": 3.0, "beat_id": "b0"},
       {"t": 9.0, "type": "wait", "until": 9.0, "word_t": 8.35, "beat_id": "b1"},
       {"t": 5.0, "type": "read", "word_t": 5.0}]
an = B.anchors_from(evs)
check([a["kind"] for a in an] == ["press", "result", "result"], f"anchors: presses + K2 / live results ({an})")
check(an[0]["want"] == round(3.0 * fps) and an[1]["lo"] == math.ceil(3.2 * fps), "press wants its word, a result its band")
ev = {"events": [{"t": 1.0, "end": 2.0, "type": "click", "press": 1.5}], "cursor": [[i / fps, 1, 2] for i in range(60)], "walls": []}
rt = B.retime_events(ev, list(range(0, 60, 2)))
check(rt["events"][0]["t"] == round(15 / fps, 4) and len(rt["cursor"]) == 30, "events + cursor follow the map")

print(f"test_beatscript: {N} checks passed")
