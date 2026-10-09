"""Gap list G4 + architecture §4 checkpoints 3/4: take gate, salvage, structure + coverage gates, rubric,
ship rule, remedy table and the held verdict — offline, on a compact copy of the failed job's edit-01
(tests/fixtures/g4: blocks, segment times, recorder walls, the stored 1.5 s guard and the extended 0.5 s
guard's output on scratch copies). No video, no job, no model call."""
import ast
import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import gates, remedy, rubric  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "g4"
N = 0


def check(name, cond):
    global N
    N += 1
    if not cond:
        raise SystemExit(f"FAIL: {name}")


def load(name):
    return json.loads((FX / name).read_text())


JOB = load("failed_job.json")
WORDS = [{"i": n, "word": w, "start": s, "end": e} for n, (w, s, e) in enumerate(JOB["words"])]
SEGS = JOB["segments"]
QA1 = load("frames-qa-v1.json")          # the stored guard (1.5 s point hits) — the failed run's frames-qa.json
QA3 = load("frames-qa-v3.json")          # the extended 0.5 s guard run on scratch copies (qa_frames.py)
STARTS = gates.sentence_starts(WORDS)


def seg_dirs(td):
    out = {}
    for i, _ in enumerate(SEGS):
        k = f"{i:02d}"
        rec = Path(td) / f"seg-{k}" / "rec"
        rec.mkdir(parents=True)
        (rec / "events.json").write_text(json.dumps({"end": JOB["rec_end"][k], "walls": JOB["walls"][k], "events": []}))
        out[i] = rec.parent
    return out


def at_output(qa, i):
    return [(s["kind"], round(SEGS[i]["t0"] + s["t0"], 1), round(SEGS[i]["t0"] + s["t1"], 1))
            for s in gates.guard_spans(qa, f"{i:02d}")]


# ── 1. dry decide on the stored guard: retakes, never an A-roll replacement ──
with tempfile.TemporaryDirectory() as td:
    dirs = seg_dirs(td)
    d = gates.decide(SEGS, QA1, dirs)
    check("dry decide: retakes for 02 04 05 06 07 08 09 12", d["retake"] == [2, 4, 5, 6, 7, 8, 9, 12])
    check("dry decide: builds no A-roll replacement while retakes remain", d["salvage"] == [])
    check("dry decide: the clean takes", d["clean"] == [0, 1, 3, 10, 11])
    forced = gates.decide(SEGS, QA1, dirs, max_takes=1)
    check("retakes exhausted -> salvage, not A-roll", forced["salvage"] == d["retake"] and not forced["retake"])
    # a recorded take counts its retakes in gate.json
    (dirs[2] / "gate.json").write_text(json.dumps({"takes": 3}))
    check("takes_of reads gate.json", gates.takes_of(dirs[2]) == 3)
    check("after MAX_TAKES the take is salvaged", 2 in gates.decide(SEGS, QA1, dirs)["salvage"])


def salv(qa, i):
    k = f"{i:02d}"
    return gates.salvage(SEGS[i], gates.guard_spans(qa, k), WORDS, rec_end=JOB["rec_end"][k])


# ── 2. salvage with retakes exhausted ──
s7 = salv(QA1, 7)
T7 = SEGS[7]["t0"]
check("seg-07 keeps footage before the hits (~5.5 s)", s7["pieces"] and s7["pieces"][0]["src0"] < 1.0
      and gates.MIN_PIECE_S <= s7["pieces"][0]["t1"] - T7 <= 5.6)
check("seg-07 keeps footage after the hits (~9.5 s)", len(s7["pieces"]) == 2 and 9.0 <= s7["pieces"][1]["src0"] <= 11.0
      and s7["pieces"][1]["t1"] > T7 + 50)
check("seg-07 is not dropped (was 0 s)", sum(p["t1"] - p["t0"] for p in s7["pieces"]) > 40)
s2 = salv(QA1, 2)
check("seg-02 (one hit at 6.01 s) keeps both sides", len(s2["pieces"]) == 2
      and s2["pieces"][0]["src0"] < 1.0 and s2["pieces"][1]["t1"] > SEGS[2]["t1"] - 1)
check("seg-02 loses only the bad span", s2["lost_s"] < 4.0)
s2b = salv(QA3, 2)
check("seg-02 on the extended guard keeps both sides too", len(s2b["pieces"]) == 2)


def edge_near(T, svs):
    edges = [e for sv in svs for p in sv["pieces"] for e in (p["t0"], p["t1"])]
    return min(edges, key=lambda e: abs(e - T))


all_sv = []
for i, seg in enumerate(SEGS):
    all_sv.append(salv(QA1, i))
for T in (387.41, 525.97, 688.50):
    e = edge_near(T, all_sv)
    near = min(abs(s - e) for s in STARTS)
    check(f"the cut at {T} moves within 0.6 s of a sentence start ({e} -> {near:.2f})", near <= gates.SNAP_S and abs(e - T) < 6)
    check(f"the picture leads the sentence at {T}", any(abs((s - gates.LEAD_S) - e) < 0.02 for s in STARTS))
s12 = salv(QA1, 12)
check("a foreign account loses the whole take (nothing of 'Keith' is shown)", not s12["pieces"] and s12["lost"][0]["why"] == "account")
# every lost second is a D1 failure; a <= 0.6 s sentence-snap trim is cut placement
f7 = gates.salvage_failures(7, SEGS[7], s7, load("expect.json")["segments"]["7"], ["rerecord_beat", "rerecord_beat", "salvage"])
check("every lost span is a D1 failure line", f7 and all(f["dim"] == "D1" and f["remedies_tried"][-1] == "salvage" for f in f7))
check("lost seconds name the bad kind", any("challenge" in f["why"] for f in f7))
clean = gates.salvage(SEGS[1], [], WORDS, rec_end=JOB["rec_end"]["01"])
check("a clean segment's snap trim is not a failure", gates.salvage_failures(1, SEGS[1], clean) == [])
check("keep_start/keep_end leave an abutting edge alone",
      gates.salvage({"t0": 100.0, "t1": 110.0}, [], WORDS, keep_start=True, keep_end=True)["pieces"][0]["t0"] == 100.0)

# SALVAGE ONLY TRIMS SCREEN PIECES: the narration timing is never changed
w_before = json.dumps(WORDS)
for i in range(len(SEGS)):
    sv = salv(QA3, i)
    for p in sv["pieces"]:
        check("a piece lies inside its segment", SEGS[i]["t0"] - 1e-6 <= p["t0"] < p["t1"] <= SEGS[i]["t1"] + 1e-6)
        check("a piece plays its recording at 1x (src0 = output offset)", abs(p["src0"] - (p["t0"] - SEGS[i]["t0"])) < 1e-6)
        check("no piece shorter than 2.5 s (P4)", p["t1"] - p["t0"] >= gates.MIN_PIECE_S - 1e-6)
    check("salvage returns no narration field", set(sv) == {"pieces", "lost", "lost_s"})
check("salvage never touches the words", json.dumps(WORDS) == w_before)
src = (ROOT / "aieditor" / "gates.py").read_text()
fn = src[src.index("def salvage("):src.index("def snap_clean(")]
check("salvage writes no edl / words / audio", not re.search(r"edl\.|words\[[^\]]*\]\s*=|\.pop\(|audio|write", fn))

# ── 3. the extended guard (qa_frames.py on scratch copies of the failed run, every 0.5 s) ──
check("the guard sampled every 0.5 s", QA3["every_s"] == 0.5 and QA3["account"] == "Jake")


def flags(i, kind, lo, hi):
    return any(k == kind and a <= hi and b >= lo for k, a, b in at_output(QA3, i))


check("sc-03 idle tail 203.6-243.4", any(k == "idle_tail" and a <= 204.5 and b >= 243.0 for k, a, b in at_output(QA3, 3)))
check("sc-10 idle tail 632.4-671.4", any(k == "idle_tail" and a <= 633.0 and b >= 671.0 for k, a, b in at_output(QA3, 10)))
check("sc-05 'Unusual activity' frames 321-322", any(k == "challenge" and a <= 321.1 and b >= 322.0 for k, a, b in at_output(QA3, 5)))
check("sc-11 'How can I help, Keith?' 707.5-710.7", any(k == "account" and a <= 707.5 and b >= 710.7 for k, a, b in at_output(QA3, 11)))
check("sc-10 garbled field text at 640", flags(10, "garbled", 640, 640))
check("sc-03 empty canvas 220-243", any(k == "empty" and a <= 221.0 and b >= 243.0 for k, a, b in at_output(QA3, 3)))
check("0 frames flagged on the sc-08 Templates grid 506-525",
      not any(a < 525.0 and b > 506.0 for _, a, b in at_output(QA3, 8)))
check("the old 1.5 s guard missed the idle tails", not any(k.startswith("idle") for i in range(13) for k, _, _ in at_output(QA1, i)))

# ── 4. content QA (qa_content.py on the hand-written expectations, run in the screencast image) ──
CQ = load("content-hand.json")


def must(seg, at):
    return next(c for c in CQ["segments"][seg] if c["check"] == "must" and abs(c["at"] - at) < 0.01)


check("FAIL 'toolbar' at 17.1 (the Library is shown)", must("seg-00", 2.39)["ok"] is False and abs(SEGS[0]["t0"] + 2.39 - 17.1) < 0.05)
check("FAIL 'Updated' at 89.2", must("seg-01", 18.13)["ok"] is False and abs(SEGS[1]["t0"] + 18.13 - 89.2) < 0.05)
check("FAIL 'percentage counter' at 108.9", must("seg-01", 37.83)["ok"] is False and abs(SEGS[1]["t0"] + 37.83 - 108.9) < 0.05)
check("PASS 'templates' at 506.9", must("seg-08", 1.45)["ok"] is True and abs(SEGS[8]["t0"] + 1.45 - 506.9) < 0.05)
sc = gates.scores(CQ, lost_beats=3)
check("content QA scores D1 (lost beats count as fails)", sc["D1"] is not None and sc["d1_failed"] >= 3 + 3)

# plan-schema beats are the expectation source (qa_content.load_expect / gates.expectations)
plan = {"segments": [{"t0": 10.0, "t1": 30.0, "app": "chatgpt", "session": "logged_in", "beats": [
    {"id": "b1", "word_id": 3, "t_word": 12.0, "action": "chatgpt.open_tool", "subject": "ui:Sketch", "must_text": ["Sketch"]},
    {"id": "b2", "word_id": 9, "t_word": 15.5, "action": "chatgpt.type_prompt", "typed_text": "Turn this into a photo"},
    {"id": "b3", "word_id": 12, "t_word": 18.0, "action": "chatgpt.send", "result_assertion": "a realistic photo is shown"},
    {"id": "b4", "word_id": 15, "t_word": 21.0, "action": "zoom", "subject": "screen"}]}]}
ex = gates.expectations(plan, [])
b = ex["segments"]["0"]
check("plan beats -> expectation beats (segment-relative)", [x["at"] for x in b] == [2.0, 5.5, 8.0, 11.0])
check("must_text and typed_text carried", b[0]["must"] == ["Sketch"] and b[1]["typed"] == "Turn this into a photo")
check("a result beat expects content, a camera beat inherits", b[2]["content"] is True and b[3]["content"] is None)
check("Blue Bottle is a forbidden brand", "Blue Bottle" in ex["forbid"])
sys.path.insert(0, str(ROOT / "screencast"))
import qa_content  # noqa: E402
check("qa_content reads a plan as its expectations", qa_content.load_expect({"plan": plan})["segments"]["0"] == b)
check("qa_content reads a G2 expect.json as it is", qa_content.load_expect(load("expect-hand.json")) == load("expect-hand.json"))

# ── 5. the per-take verdict p7 calls after each take ──
with tempfile.TemporaryDirectory() as td:
    dirs = seg_dirs(td)
    v = gates.take_verdict(dirs[5], load("expect.json"), QA3, {"segments": {}})
    check("take_verdict: seg-05 fails", v["ok"] is False and v["reasons"])
    check("take_verdict: the challenge is the worst problem", v["problem"] == "challenge" and v["remedy"] == "retry_once")
    v = gates.take_verdict(dirs[8], load("expect.json"), {"spans": {"08": []}, "every_s": 0.5}, CQ)
    check("take_verdict: a clean take with passing beats is ok", v["ok"] is True and v["remedy"] is None)
    v = gates.take_verdict(dirs[1], load("expect.json"), {"spans": {"01": []}, "every_s": 0.5}, CQ)
    check("take_verdict: a failed must beat -> re-record the beat", not v["ok"] and v["problem"] == "wrong_content"
          and v["remedy"] == "rerecord_beat")
    v = gates.take_verdict(dirs[8], [], {"spans": {}}, [], privacy_out=[{"t0": 3.0, "t1": 4.5, "why": "email address"}])
    check("take_verdict: a legible private frame -> widen the blur", v["problem"] == "privacy" and v["remedy"] == "widen_blur")
    (dirs[1] / "gate.json").write_text(json.dumps({"remedies": ["rerecord_beat", "rerecord_beat"]}))
    v = gates.take_verdict(dirs[1], load("expect.json"), {"spans": {"01": []}}, CQ)
    check("take_verdict: after two re-records the repair agent", v["remedy"] == "repair_agent")
    v = gates.take_verdict(dirs[11], load("expect.json"), QA3, None)
    check("take_verdict: names the beat a problem falls in", any(p.get("beat") for p in v["problems"]))

# ── 6. structure + coverage gates ──
st = gates.structure({"blocks": JOB["blocks"]}, duration=JOB["duration"])
check("structure FAILS on the failed job", st["ok"] is False)
check("structure numbers: 43 %, 23.1 s, 29.9 s, 1.4/min",
      round(st["share"] * 100) == 43 and st["aroll_p50"] == 23.11 and st["span_p50"] == 29.91 and round(st["bounds_per_min"], 1) == 1.4)
# a synthetic edit at the reference medians: 600 s, A-roll blocks 5.5 s, screencast spans 14 s
bl, t = [], 0.0
while t < 600:
    t += 14.0
    if t + 5.5 > 600:
        break
    bl.append([round(t, 2), round(t + 5.5, 2)])
    t += 5.5
ref_st = gates.structure({"blocks": bl}, duration=600.0)
check(f"structure PASSES a reference-median fixture {ref_st}", ref_st["ok"] is True and 0.72 <= ref_st["share"] <= 0.76)
cov = gates.coverage({"blocks": JOB["blocks"]}, {"segments": SEGS}, duration=JOB["duration"])
check(f"coverage: kept 378/668 = 0.57 -> fail ({cov})", round(cov["planned_s"]) == 668 and round(cov["kept_s"]) == 378
      and round(cov["kept_frac"], 2) == 0.57 and cov["ok"] is False and len(cov["fails"]) == 2)
segs_ok = [{"t0": a + 0.0, "t1": b} for a, b in gates.screen_time(bl, 600.0)]
cov2 = gates.coverage({"blocks": bl}, {"segments": segs_ok}, duration=600.0)
check("coverage passes when all planned screencast is kept at the reference share", cov2["ok"] is True)
check("coverage does not gate a plan with no screencast", gates.coverage({"blocks": [[0, 60]]}, {"segments": []}, 60)["ok"])

# ── 7. rubric on the stored failed job (compact copy) + the ship rule + the held verdict ──
with tempfile.TemporaryDirectory() as td:
    jobs = Path(td)
    src = jobs / "factory-e2e-test"
    src.mkdir()
    # the source: an unreviewed automatic cut with 45 word-removing joins (factory-e2e-test, 53 joins)
    joins = [{"left_id": n, "right_id": n + 2, "removed": "So" if n < 45 else ""} for n in range(53)]
    (src / "edl.json").write_text(json.dumps({"videos": [{"joins": joins}]}))
    (src / "review.json").write_text(json.dumps({"edited": False}))
    (src / "request.json").write_text(json.dumps({"workflow": "cut"}))
    job = jobs / "failed-job"
    w = job / "edit-01"
    w.mkdir(parents=True)
    (job / "request.json").write_text(json.dumps({"workflow": "creative", "source": {
        "kind": "job", "job": "factory-e2e-test", "file": "preview-01.mp4"}}))
    (w / "blocks.json").write_text(json.dumps({"blocks": JOB["blocks"], "words": WORDS, "overlays": JOB["overlays"]}))
    (w / "direct.json").write_text(json.dumps({"plan": {"segments": SEGS, "overlays": []}}))
    rb = rubric.score(w, QA1)
    check(f"rubric D7 within +-10 of 20 ({rb['dims']['D7']})", abs(rb["dims"]["D7"] - 20) <= 10)
    check(f"rubric D9 within +-10 of 5 ({rb['dims']['D9']})", abs(rb["dims"]["D9"] - 5) <= 10)
    check("D9 counts unapproved removals of the unreviewed source", rb["measured"]["unapproved"] == 45)
    check("D9 has no pause profile", not any("pause" in f["why"].lower() for f in rb["findings"]))
    sh = rubric.ship(rb["dims"], rb["findings"], unapproved=rb["measured"]["unapproved"])
    check("ship() = false on the failed job", sh["ship"] is False)
    check("judged dims missing -> not measured (no calibrated judge)", any("no calibrated judge" in x for x in sh["fails"]))
    v = gates.edit_verdict(st, cov, rb, salvage_lost=f7, unapproved=rb["measured"]["unapproved"])
    check("the verdict is HELD", v["held"] is True)
    dims = {f["dim"] for f in v["failures"]}
    check("held failures carry D1 (lost seconds), D7 (structure) and D9", {"D1", "D7", "D9"} <= dims)
    check("every failure line has dim/beat/t/why/remedies_tried",
          all(set(f) >= {"dim", "beat", "t", "why", "remedies_tried"} for f in v["failures"]))
    # held.json keeps p1's reasons next to the failures
    (job / "held.json").write_text(json.dumps({"reasons": [{"reason": "needs_scripted_recorder", "detail": "edit 1 screencast 3"}]}))
    gates.write_held(job, v["failures"])
    hd = gates.held_doc(job)
    check("write_held keeps the other packages' reasons", hd["reasons"] and hd["failures"] == v["failures"])
    check("held_list puts the pre-compose reasons first", gates.held_list(job)[0]["dim"] == "held")
    gates.write_held(job, [])
    check("clearing the failures keeps the reasons", gates.held_doc(job)["reasons"] and not gates.held_doc(job)["failures"])

full = {d: 100.0 for d in rubric.WEIGHTS}
check("ship: all 100 ships", rubric.ship(full, [])["ship"] is True)
check("ship: one dimension under 80 holds", rubric.ship({**full, "D8": 79.0}, [])["ship"] is False)
check("ship: a critical finding holds", rubric.ship(full, [{"severity": "critical", "why": "x", "dim": "D1"}])["ship"] is False)
check("ship: an unapproved word removal holds", rubric.ship(full, [], unapproved=1)["ship"] is False)
check("ship: a legible private frame holds", rubric.ship(full, [], private_frames=1)["ship"] is False)
check("overall = weighted mean capped at lowest + 20", rubric.overall({**full, "D9": 10.0}) == 30.0)
check("verdict ships when everything passes",
      gates.edit_verdict(ref_st, cov2, {"dims": full, "findings": []}, judged=None)["held"] is False)

# ── 8. the references score >= 95 on the code dimensions (gapreview/baseline stats, when on disk) ──
BASE = Path("/tmp/claude-0/-root/556be0d9-0723-5fb1-837b-51a17b53a242/scratchpad/gapreview/baseline")
AUD = Path("/opt/aieditor-work/reference/work/tech/aud")
if (BASE / "jump.json").exists():
    for ref in rubric.REFS:
        o = rubric.score_stats(rubric.reference_stats(ref, BASE, AUD if AUD.exists() else None))
        for dim in ("D2", "D6", "D7", "D8", "D9", "D10"):
            check(f"reference {ref} {dim} >= 95 ({o['dims'][dim]})", o["dims"][dim] is not None and o["dims"][dim] >= 95)
else:
    print("test_gates: gapreview/baseline not on this machine — reference scoring skipped")
# the reference envelope keeps the bands honest: the failed job still fails them
check("D7 band from refs never passes the failed job", rubric.score_d7({"blocks": JOB["blocks"], "duration": JOB["duration"]})[0] <= 30)

# ── 9. the remedy table ──
check("wrong content: re-record twice, repair, salvage", remedy.TABLE["wrong_content"] == ["rerecord_beat", "rerecord_beat", "repair_agent", "salvage"])
check("timing / framing / generation / privacy / challenge",
      remedy.TABLE["timing"] == ["reassemble"] and remedy.TABLE["framing"] == ["resolve_camera"]
      and remedy.TABLE["generation_missing"] == ["regenerate", "regenerate"]
      and remedy.TABLE["privacy"] == ["widen_blur", "cut_beat"] and remedy.TABLE["challenge"] == ["retry_once", "fallback"])
check("at most 2 automatic rounds", remedy.MAX_ROUNDS == 2 and remedy.plan_round([{"dim": "D2"}], rounds_done=2) == [])
check("a round plans the next action", remedy.plan_round([{"dim": "D5", "beat": "b1"}])[0]["action"] == "resolve_camera")
check("narration integrity has NO automatic remedy", remedy.TABLE["narration"] == []
      and remedy.plan_round([{"dim": "D9"}]) == [])
check("exhausted -> None (held)", remedy.next_action("timing", ["reassemble"]) is None)
# static: no remedy may touch the narration (no edl, words, audio, pauses, joins, cuts in the narration)
for name, a in remedy.ACTIONS.items():
    for ch in a["changes"]:
        check(f"remedy {name} changes {ch}: screen side only", not any(f in ch.lower() for f in remedy.FORBIDDEN_CHANGES))
for seq in remedy.TABLE.values():
    check("every table action is defined", all(x in remedy.ACTIONS for x in seq))
tree = ast.parse((ROOT / "aieditor" / "remedy.py").read_text())
imports = {n.names[0].name if isinstance(n, ast.Import) else (n.module or "") for n in ast.walk(tree)
           if isinstance(n, (ast.Import, ast.ImportFrom))}
check("remedy.py imports nothing that edits the narration", not imports & {"edl", "takes", "wordiff", "render", "aieditor.edl"})
code = "".join(ast.get_source_segment((ROOT / "aieditor" / "remedy.py").read_text(), n) or ""
               for n in tree.body if isinstance(n, (ast.FunctionDef,)))
check("remedy functions never open or write a file", "open(" not in code and "write" not in code)
for word in ("trim", "pause", "silence"):
    check(f"no remedy action is a {word}", not any(word in k for k in remedy.ACTIONS))

print(f"test_gates: {N} checks passed")
