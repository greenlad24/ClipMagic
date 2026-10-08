"""A-roll motion plan (screencast/aroll_plan.py) — the reference numbers, word-timed resets, AR02.

  · a block shorter than one push stays one AR01 shot from ×1.00
  · a long A-roll stretch (the creative test: one 964 s block) is split at sentence starts into
    reference-length pushes; the picture is never still > 3 s (Jake rule 2 / RULEBOOK P1)
  · a picture jump cut near a sentence start is the preferred reset point
  · jump cuts alone never change the framing (refs: scale ratio 0.97–1.01)
  · TR07 opening ×1.548 → 1.0 in 31 f; AR02 ×1.22 while the social icons are on
  · zoom_at stays inside [1.0, cap] outside the opening/beats and is continuous inside a shot

Run: python3 tests/test_motion.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "screencast"))
import aroll_plan as A  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def narration(dur, sent_every=7):
    ws, t, k = [], 0.2, 0
    while t < dur - 0.5:
        end = (k % sent_every) == sent_every - 1
        ws.append({"word": "word." if end else "word", "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += 0.42 + (0.35 if end else 0)
        k += 1
    return ws


def main():
    R = A.RULES
    check(0.018 <= R["rate_per_s"] <= 0.027 and 1.10 <= R["cap"] <= 1.15, "AR01 numbers inside the measured ref band")
    # 1 short block: one push
    p = A.plan([[0.0, 5.0]], narration(5.0))
    check(len(p["shots"]) == 1 and p["shots"][0]["z0"] == 1.0, f"one shot: {p['shots']}")
    # 2 the creative test: one 964 s block
    ws = narration(964.0)
    p = A.plan([[0.0, 964.0]], ws, cuts=[100.0, 412.3])
    st = p["stats"]
    starts = set(round(x, 3) for x in A.sentence_starts(ws))
    check(st["resets"] >= 964 / A.RULES["max_block_s"], f"split into reference-length pushes: {st}")
    check(st["longest_still_s"] <= 3.0, f"never still > 3 s: {st}")
    check(0.72 <= st["moving_frac"] <= 0.9, f"moving share near the refs' 77–84 %: {st}")
    lens = [s["t1"] - s["t0"] for s in p["shots"]]
    check(max(lens) <= R["max_block_s"] + 0.01 and min(lens) >= 1.0, f"shot lengths {min(lens):.1f}–{max(lens):.1f}")
    resets = [s["t0"] for s in p["shots"][1:]]
    check(all(round(r, 3) in starts or any(abs(r - c) < 1e-6 for c in (100.0, 412.3)) for r in resets),
          "every reset sits on a sentence start (or the jump cut next to one)")
    # still: sample the plan and measure the longest run with no scale change
    fps, prev, still, longest = 29.97, None, 0.0, 0.0
    for n in range(int(964 * fps)):
        z = A.zoom_at(n / fps, p)
        if prev is not None and abs(z - prev) < 1e-6:
            still += 1 / fps
            longest = max(longest, still)
        else:
            still = 0.0
        prev = z
    check(longest <= 3.05, f"rendered plan: longest still {longest:.2f} s")
    # 3 a picture jump cut near a sentence start is used as the reset
    ws = narration(30.0)
    s0 = A.sentence_starts(ws)
    target = next(s for s in s0 if s > 6.0)
    p = A.plan([[0.0, 30.0]], ws, cuts=[target + 0.2])
    check(any(abs(s["t0"] - (target + 0.2)) < 1e-6 for s in p["shots"]), f"jump cut used: {[s['t0'] for s in p['shots']]}")
    # 4 jump cuts alone never re-frame: inside one shot the scale is continuous across a cut
    p = A.plan([[0.0, 5.5]], narration(5.5), cuts=[2.0, 3.1])
    check(len(p["shots"]) == 1 and abs(A.zoom_at(2.01, p) - A.zoom_at(1.99, p)) < 0.002, "no framing jump on a cut")
    # 5 TR07 + AR02 + block-end hold
    check(abs(A.zoom_at(0.0, p) - 1.548) < 1e-3 and abs(A.zoom_at(31 / 29.97 + 0.01, p) - (1 + R["rate_per_s"] * 1.045)) < 0.01,
          "opening eases 1.548 → the push")
    ov = [{"template": "socials", "t0": 20.0, "t1": 24.0}, {"template": "keyword", "t0": 5.0, "t1": 7.0}]
    p = A.plan([[0.0, 30.0]], narration(30.0), overlays=ov)
    check(len(p["beats"]) == 1 and p["beats"][0]["technique"] == "AR02", f"one AR02 beat: {p['beats']}")
    base = next(s for s in p["shots"] if s["t0"] <= 22.0 < s["t1"])
    z_base = min(base["cap"], 1 + base["rate"] * (22.0 - base["t0"]))
    check(abs(A.zoom_at(22.0, p) / z_base - 1.22) < 0.01, "×1.22 while the icons are on")
    p = A.plan([[0.0, 5.0], [9.0, 14.0]], narration(14.0))
    check(abs(A.zoom_at(5.1, p) - A.zoom_at(4.999, p)) < 0.002 and A.zoom_at(9.0, p) == 1.0,
          "the block's last framing holds into the screencast; the next block enters at ×1.00 (no pop)")
    print(f"test_motion: {N} checks passed")


if __name__ == "__main__":
    main()
