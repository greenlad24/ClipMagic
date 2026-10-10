"""The judges must earn the right to decide (architecture recommendation §4, migration step 7): the
calibration harness on the gap review's 880 human per-second verdicts (tests/fixtures/judges = a copy
of gapreview/chunk0..7/per-second.txt), the tiered Haiku -> Sonnet -> Opus judge with a FAKE model,
strict JSON, no spend without --allow-spend, and "uncalibrated = advisory only". No API call is made."""
import ast
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import judges  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "judges"
N = 0


def check(name, cond):
    global N
    N += 1
    if not cond:
        raise SystemExit(f"FAIL: {name}")


recs = judges.parse_per_second(FX)
check(f"880 reviewed seconds ({len(recs)})", len(recs) == 880)
check("seconds 0..879 in order", recs[0]["t"] == 0 and recs[-1]["t"] == 879)
check("A-roll and generation seconds recognised", sum(r["aroll"] for r in recs) > 300 and sum(r["gen"] for r in recs) > 200)
check("the human verdict per dimension", judges.human_verdict({"tags": ["wrong-content"], "gen": False})
      == {"D1": False, "D3": True, "D4": None})

# ── a judge that replays the human verdicts reproduces GAP-LIST §1 ──
with tempfile.TemporaryDirectory() as td:
    out = Path(td) / "calibrated.json"
    res = judges.calibrate(FX, None, judges.replay_judge, out=out)
    for d in judges.DIMS:
        x = res["dims"][d]
        check(f"replay judge {d}: span scores within +-10 of GAP-LIST s1 ({x['max_err']})", x["max_err"] <= 10)
        check(f"replay judge {d}: agreement 100 %", x["agreement"] == 1.0)
        check(f"replay judge {d}: calibrated", x["pass"] is True)
        tg = judges.GAP_S1[d]
        check(f"replay judge {d}: every span compared", all((t is None) or (s is not None and abs(s - t) <= 10)
                                                            for s, t in zip(x["span_scores"], tg)))
    check("calibrated.json written", json.loads(out.read_text())["passed"] == list(judges.DIMS))
    check("calibrated() reads it", judges.calibrated(out) == {"D1": True, "D3": True, "D4": True})
    binding, advisory = judges.authority({"D1": 70.0, "D3": 90.0}, out)
    check("a calibrated judge binds", binding == {"D1": 70.0, "D3": 90.0} and not advisory)

    # ── a random judge fails calibration ──
    res = judges.calibrate(FX, None, judges.random_judge(), out=out)
    check("random judge: no dimension calibrated", res["passed"] == [])
    check("random judge: second-by-second agreement near chance",
          all(res["dims"][d]["agreement"] < judges.AGREE_MIN for d in judges.DIMS))
    check("uncalibrated -> advisory only", judges.authority({"D1": 99.0}, out) == ({}, {"D1": 99.0}))
    check("no calibrated.json -> nothing binds", judges.calibrated(Path(td) / "missing.json") == {d: False for d in judges.DIMS})

    # ── an always-yes judge gets the averages wrong and fails ──
    res = judges.calibrate(FX, None, lambda r, f: {"D1": True, "D3": True, "D4": True if r["gen"] else None})
    check("an always-yes judge fails D1/D3/D4", res["passed"] == [])

    # ── the references: a judge must call >= 95 % of Jake's reference seconds right ──
    refs = [{"t": float(t), "frame": None} for t in range(40)]
    picky = lambda r, f: judges.replay_judge(r) if "verdict" in r else {"D1": False, "D3": False, "D4": None}  # noqa: E731
    res = judges.calibrate(FX, None, picky, refs=refs)
    check("a judge that fails the references is not calibrated", res["passed"] == [] or
          all(res["dims"][d]["ref_clean"] in (None, 0.0) for d in res["passed"]))
    check("reference seconds counted", res["n_ref_seconds"] == 40 and res["dims"]["D1"]["ref_clean"] == 0.0)
    fair = lambda r, f: judges.replay_judge(r) if "verdict" in r else {"D1": True, "D3": True, "D4": None}  # noqa: E731
    res = judges.calibrate(FX, None, fair, refs=refs)
    check("a judge that passes the references and the review calibrates D1/D3", {"D1", "D3"} <= set(res["passed"]))

    # ── an answer that is not strict JSON counts against the judge ──
    def bad(r, f):
        raise judges.JudgeError("prose")
    res = judges.calibrate(FX, None, bad)
    check("unusable answers never calibrate", res["passed"] == [])

# ── strict JSON ──
check("strict JSON parsed", judges.parse_answer('{"yes": false, "why": "Library shown"}') == {"yes": False, "why": "Library shown"})
check("a fenced JSON answer parsed", judges.parse_answer('```json\n{"yes": true}\n```')["yes"] is True)
for txt in ("Yes, it is.", '{"yes": "no"}', "[]", ""):
    try:
        judges.parse_answer(txt)
        check(f"rejects {txt!r}", False)
    except judges.JudgeError:
        check(f"rejects {txt!r}", True)


# ── the tiers, with a fake model ──
# Jake 2026-10-09: every judge tier runs Opus 5.5. The tier LOGIC (escalation) is tested with stand-in names,
# so a tier is still identifiable in the log; the real constants must all be Opus.
check("every judge tier is Opus 5.5", judges.HAIKU == judges.SONNET == judges.OPUS == "claude-opus-5-5")
judges.HAIKU, judges.SONNET, judges.OPUS = "tier1-first-look", "tier2-second-look", "tier3-confirm"


def fake(answers):
    log = []

    def call(model, system, content):
        check("the system prompt asks for strict JSON", "ONLY with one JSON object" in system)
        log.append(model)
        return json.dumps({"yes": answers[model], "why": model})
    return call, log


call, log = fake({judges.HAIKU: True, judges.SONNET: True, judges.OPUS: True})
r = judges.TieredJudge(call=call).judge("D1", {"words": "click Sketch", "expect": "the Sketch tool"}, code_ok=True)
check("tier 1: Haiku agrees with code QA -> one call", log == [judges.HAIKU] and r["ok"] and r["tier"] == 1)
call, log = fake({judges.HAIKU: False, judges.SONNET: True, judges.OPUS: True})
r = judges.TieredJudge(call=call).judge("D1", {"words": "x"}, code_ok=True)
check("tier 2: Sonnet settles a disagreement with code QA", log == [judges.HAIKU, judges.SONNET] and r["ok"] and r["tier"] == 2)
call, log = fake({judges.HAIKU: False, judges.SONNET: False, judges.OPUS: False})
r = judges.TieredJudge(call=call).judge("D3", {}, code_ok=True)
check("tier 3: Opus confirms a flag", log == [judges.HAIKU, judges.SONNET, judges.OPUS] and r["flagged"] and r["tier"] == 3)
call, log = fake({judges.HAIKU: False, judges.SONNET: True, judges.OPUS: True})
r = judges.TieredJudge(call=call).judge("D3", {}, code_ok=False)
check("Haiku agreeing with a failed code check still goes to Opus", log == [judges.HAIKU, judges.OPUS] and r["ok"] is True)
check("Opus clearing a flag passes the beat", r["flagged"] is False)
fn = judges.TieredJudge(call=fake({judges.HAIKU: True, judges.SONNET: True, judges.OPUS: True})[0]).as_judge_fn()
check("as_judge_fn skips D4 on a non-generation second", fn({"t": 1.0, "gen": False}, None)["D4"] is None)

# ── no spend without the flag; every real call goes through llm.py ──
try:
    judges.TieredJudge().ask(judges.HAIKU, "q")
    check("a paid judge without --allow-spend refuses", False)
except judges.SpendNotAllowed:
    check("a paid judge without --allow-spend refuses", True)
try:
    judges.main(["calibrate", "--per-second", str(FX)])
    check("the CLI refuses the tiered judge without --allow-spend", False)
except SystemExit as e:
    check("the CLI refuses the tiered judge without --allow-spend", e.code == 2)
try:
    rc = judges.main(["calibrate", "--per-second", str(FX), "--judge", "replay", "--out", str(Path(tempfile.gettempdir()) / "p4-judges-cal.json")])
    check("the CLI calibrates a free fake judge", rc == 0)
finally:
    (Path(tempfile.gettempdir()) / "p4-judges-cal.json").unlink(missing_ok=True)
src = (ROOT / "aieditor" / "judges.py").read_text()
tree = ast.parse(src)
mods = {(n.module or "") if isinstance(n, ast.ImportFrom) else a.name for n in ast.walk(tree)
        if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
check("judges.py never talks HTTP itself (llm.py is the only API caller)",
      not mods & {"urllib", "urllib.request", "http", "http.client", "requests", "anthropic"})
check("judges.py calls llm.messages", "llm.messages(" in src)
check("the three tiers all run Opus 5.5 in judges.py (Jake 2026-10-09)",
      'HAIKU = SONNET = OPUS = "claude-opus-5-5"' in src)
if judges._llm() is None:
    try:
        judges.TieredJudge(allow_spend=True).ask(judges.HAIKU, "q")
        check("without p1's llm.py no call is possible", False)
    except RuntimeError as e:
        check("without p1's llm.py no call is possible", "llm.py" in str(e))

print(f"test_judges: {N} checks passed")
