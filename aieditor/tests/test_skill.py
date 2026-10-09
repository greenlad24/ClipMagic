"""The ONE skill folder (aieditor/.claude/skills/jake-editor/, recommendation step 2).

  · exactly one RULEBOOK.md under aieditor/ — the skill copy (the drifted screencast copy is gone)
  · it holds Jake's newest rulings: C7, L4, R7-R10 (2026-10-09), R11 (natural pauses never trimmed)
    and the old live copy's A-roll measurement note as M1 (flagged: conflicts with A2)
  · rules.json loads and every group carries a 'src'; key numbers match the spec
  · rubric.md keeps D1-D10 + the 'lowest + 20' cap and has NO pause-profile scoring (Jake 2026-10-09)
  · no file still points at the retired copy; skill.py reads the folder (and AIEDITOR_SKILL_DIR wins)
  · preprod's shot prompt reads the RULEBOOK through skill.py

Run: python3 tests/test_skill.py
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import skill  # noqa: E402

N = 0
SKILL = ROOT / ".claude" / "skills" / "jake-editor"
RETIRED = "screencast/" + "RULEBOOK.md"          # spelled in two parts so this file does not match itself


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def main():
    # 1 exactly one RULEBOOK
    found = subprocess.run(["find", str(ROOT), "-name", "RULEBOOK.md", "-not", "-path", "*/node_modules/*"],
                           capture_output=True, text=True).stdout.split()
    check([Path(f).resolve() for f in found] == [(SKILL / "RULEBOOK.md").resolve()], f"one RULEBOOK, the skill copy: {found}")
    check(skill.ROOT.resolve() == SKILL.resolve(), f"skill.ROOT {skill.ROOT}")
    for f in ("SKILL.md", "RULEBOOK.md", "TECHNIQUES.md", "INSIGHTS.md", "rubric.md", "rules.json",
              "schemas/playbook.schema.json", "schemas/plan.schema.json", "playbooks/chatgpt.json"):
        check((SKILL / f).is_file(), f"skill folder has {f}")
    for gone in ("RULEBOOK.md", "TECHNIQUES.md", "INSIGHTS.md"):
        check(not (ROOT / "screencast" / gone).exists(), f"screencast/{gone} removed")

    # 2 the rulings
    rb = skill.rulebook_text()
    for rid in ("C7", "L4"):
        check(re.search(rf"^\| {rid} \|", rb, re.M), f"RULEBOOK has {rid}")
    check("PRIVATE INFORMATION IS ALWAYS BLURRED" in rb and "US dollars" in rb, "C7/L4 text")
    for r in ("R7", "R8", "R9", "R10"):
        check(re.search(rf"^- {r} \(2026-10-09, Jake\)", rb, re.M), f"{r} dated 2026-10-09 (Jake)")
    check(re.search(r"^- R11 \(2026-10-09, Jake\).*Natural pauses are never trimmed and no cut is added to Jake's narration"
                    r".*pauses <= 0\.70 s as recorded", rb, re.M), "R11 pause ruling")
    m1 = re.search(r"^- M1 \(.*conflicts with A2; reviewer to re-confirm.*$", rb, re.M)
    check(m1 and "106 presenter→presenter jump cuts" in m1.group(0), "M1 = the live copy's A-roll measurement note, flagged")
    check("CUT07" in re.search(r"^\| A2 \|.*$", rb, re.M).group(0), "A2 keeps CUT07 (loop copy wins)")
    loop = Path("/opt/aieditor-work/loop/RULEBOOK.md")
    if loop.exists():
        n = len(loop.read_text().splitlines())
        check(rb.splitlines()[:n] == loop.read_text().splitlines(), "the loop RULEBOOK line-for-line, then the appendix")
    check("Jake rulings > RULEBOOK > TECHNIQUES > rest" in (SKILL / "SKILL.md").read_text(), "SKILL.md precedence")
    check(re.match(r"---\nname: jake-editor\ndescription: .+\n---\n", (SKILL / "SKILL.md").read_text()), "SKILL.md frontmatter")
    check("SYSTEM.md" in (SKILL / "SKILL.md").read_text(), "SKILL.md points to SYSTEM.md")
    check("CUT07" in skill.techniques_text() and skill.insights_text().count("\n") > 10, "techniques + insights readable")

    # 3 rules.json
    rules = json.loads((SKILL / "rules.json").read_text())
    groups = {k: v for k, v in rules.items() if isinstance(v, dict)}
    check(len(groups) >= 10, f"groups: {sorted(groups)}")
    for k, g in groups.items():
        check(isinstance(g.get("src"), str) and g["src"].strip(), f"rules.json {k} has src")
    check(skill.rules() is skill.rules(), "rules() cached")
    check(rules["structure"]["screencast_share"] == [0.72, 0.76] and rules["structure"]["span_max_s"] == 30.0, "structure")
    check(rules["sync"]["press_offset_s"] == [-0.15, 0.0] and rules["sync"]["max_still_s"] == 3.0, "sync")
    check(rules["camera"]["zoom_cap"] == 1.65 and rules["camera"]["bubble_disc"]["r"] == 179.3, "camera")
    check(rules["aroll"]["cut07"]["enabled"] is True, "CUT07 switch on (A2 wins until M1 is re-confirmed)")
    check(rules["narration"] == {"src": rules["narration"]["src"], "pause_keep_s": 0.70, "never_trim": True}, "narration")
    check(rules["coverage"]["min_kept_frac"] == 0.95 and rules["caps"]["server_daily_usd"] == 20, "coverage + caps")
    check(rules["playbooks"]["allow_unproven"] is False and rules["ship"]["threshold"] == 0.80, "playbooks + ship")
    from aieditor import edl
    check(abs(edl.LONG_PAUSE_KEEP - rules["narration"]["pause_keep_s"]) < 1e-9, "rules.json pause_keep == edl.LONG_PAUSE_KEEP")

    # 4 rubric: D1-D10, the cap, the ship rule, no pause profile
    rub = skill.rubric_text()
    for d in range(1, 11):
        check(re.search(rf"^\| \*\*D{d}\*\* \|", rub, re.M), f"rubric D{d}")
    weights = [int(w) for w in re.findall(r"^\| \*\*D\d+\*\* \| \*\*[^*]+\*\*[^|]*\((\d+)\) \|", rub, re.M)]
    check(sum(weights) == 100 and len(weights) == 10, f"weights {weights}")
    check("capped at the lowest dimension + 20" in rub, "overall capped at lowest + 20")
    check(not re.search(r"pauses?:\s*none|≥ 0\.5 s at 2.?4 per minute|none ≥ 1\.0 s", rub, re.I), "no pause-profile scoring")
    d9 = re.search(r"^\| \*\*D9\*\*.*$", rub, re.M).group(0)
    check("NOT scored" in d9 and "R11" in d9, "D9 says pauses are not scored")
    ship = rub[rub.index("## Ship rule"):]
    for need in ("ship.threshold", "0.80", "≥ 80", "no critical finding", "0 narration words removed without approval",
                 "0 legible private frames"):
        check(need in ship, f"ship rule has {need!r}")

    # 5 nothing points at the retired copy
    hits = subprocess.run(["grep", "-rIl", "--exclude-dir=node_modules", "--exclude-dir=__pycache__", RETIRED, str(ROOT)],
                          capture_output=True, text=True).stdout.split()
    check(hits == [], f"files still reference {RETIRED}: {hits}")
    pp = (ROOT / "aieditor" / "preprod.py").read_text()
    check("skill.rulebook_text()" in pp and "LOOP" not in pp, "preprod reads the RULEBOOK through skill.py")

    # 6 AIEDITOR_SKILL_DIR overrides the folder (fresh interpreter)
    out = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); from aieditor import skill; "
                          "print(skill.ROOT)", str(ROOT)], capture_output=True, text=True,
                         env={**os.environ, "AIEDITOR_SKILL_DIR": "/tmp/elsewhere"}).stdout.strip()
    check(out == "/tmp/elsewhere", f"env override: {out}")
    check(skill.schema("plan")["title"].startswith("Edit plan") and "chatgpt" in skill.playbooks(), "schemas + playbooks")
    print(f"test_skill: {N} checks passed")


if __name__ == "__main__":
    main()
