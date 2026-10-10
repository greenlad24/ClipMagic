"""THE JUDGES — content (D1), screen cleanliness (D3) and waits/generations (D4): the dimensions code
cannot measure (architecture recommendation §3/§4, migration step 7).

Tiered, one strict-JSON model call per question, OFF camera only (after recording, on still frames):

    tier 1  Haiku   yes/no per beat: "is <the named thing> the framed subject / is the screen clean /
                    is the generation shown as the reference does it?"
    tier 2  Sonnet  only where Haiku DISAGREES with code QA (qa_content / the frame guard)
    tier 3  Opus    confirms every item that ends up flagged (a hold needs Opus's yes)

Every call goes through aieditor/llm.py (p1: the ONE place that talks to the Claude API — ledger, caps,
no call while a screencast records). Until that module is merged the judges raise instead of calling.

THE JUDGES MUST EARN THE RIGHT TO DECIDE (recommendation §4). calibrate() replays the gap review: the
880 human per-second verdicts (gapreview/chunk0..7/per-second.txt) and the frames of those seconds go
through a judge; its verdicts are mapped to span scores exactly as the human verdicts are, and compared
with GAP-LIST §1 (+-10 points per span) — and second by second (agreement >= AGREE_MIN, so a judge that
only gets the averages right cannot pass) — and on Jake's references (a judge must call >= 95 % of the
reference seconds clean). calibrated.json records pass/fail per dimension. An UNCALIBRATED judge may only
ADVISE: its verdicts are logged as advice and never pass or hold a video (rubric.ship then sees the
dimension as "not measured" and the job is held for that reason, not for the judge's opinion).

The paid calibration run is a CLI flag:  python3 -m aieditor.judges calibrate --allow-spend  (not run in
this round: it costs real API money). Fake judges (tests) exercise the whole harness for free.
"""
import json
import re
from pathlib import Path

from . import config

# Jake 2026-10-09: "I want all of them to use Opus 5.5" — every judge tier runs Opus 5.5 (the tiers stay as
# escalation steps: a first look, a second look on disagreement, a confirmation)
HAIKU = SONNET = OPUS = "claude-opus-5-5"
DIMS = ("D1", "D3", "D4")
SPAN_S = 110                       # the gap review scored 8 spans of 110 s
TOL = 10.0                         # +-10 points per span (recommendation §4)
AGREE_MIN = 0.80                   # second-by-second agreement with the human verdicts
REF_CLEAN_MIN = 0.95               # share of reference seconds a judge must call right
CALIBRATED = config.WORK / "judges" / "calibrated.json"

# GAP-LIST §1: the human span scores of the failed job (references = 100). D4 span 660-770 had no
# generation beat (excluded).
GAP_S1 = {
    "D1": [15, 10, 12, 15, 15, 15, 15, 8],
    "D3": [15, 15, 20, 35, 40, 20, 15, 60],
    "D4": [35, 20, 5, 10, 0, 10, None, 5],
}

# The mapping from per-second verdicts to a span score. Fixed constants, fitted ONCE (least squares) to
# the gap review's human verdicts vs its human span scores; a judge is then measured through the same
# mapping, so "reproduces the span scores" means "agrees with the humans where it matters".
#   D1 = a + b * (share of seconds whose content is right)
#   D3 = a + b * (A-roll share) + c * (share of screencast seconds that are dirty) + d * (an unrelated
#        account / billing / private page in the span)            (A-roll seconds have nothing to dress)
#   D4 = a + b * (share of generation/wait seconds shown the reference way)
MAPPING = {
    "D1": {"a": 9.81, "ok": 8.33},
    "D3": {"a": 16.02, "aroll": 40.63, "dirty": -49.83, "severe": -7.29},
    "D4": {"a": 2.09, "ok": 60.21},
}

# what the human tags mean per dimension
TAG_D1 = {"wrong-content", "missing-screencast"}
TAG_D3 = {"set-dressing", "privacy-or-unwanted-page"}
TAG_D4 = {"loading-or-waiting", "waits", "wrong-content", "missing-screencast"}
TAG_SEVERE = {"privacy-or-unwanted-page"}
# a second is a generation/wait second when the reference column describes one (the plan's generation
# beats in production)
GEN_RE = re.compile(r"time-skip|dissolve|generat|result|K2|in-progress|spinner|\bsend\b", re.I)
AROLL_RE = re.compile(r"^\s*a-roll", re.I)


class SpendNotAllowed(RuntimeError):
    """A paid judge was asked to run without --allow-spend."""


class JudgeError(RuntimeError):
    """A model answer that is not the strict JSON asked for."""


# ─────────────────────────────── the gap review's per-second verdicts ───────────────────────────────

def parse_per_second(per_second_dir):
    """gapreview/chunk0..7/per-second.txt -> [{t, words, screen, ref, verdict, tags, aroll, gen, severe}]."""
    rows = []
    root = Path(per_second_dir)
    for c in range(8):
        p = root / f"chunk{c}" / "per-second.txt"
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if not re.match(r"^\d", line):
                continue
            parts = [x.strip() for x in line.split(" | ")]
            if len(parts) > 5:                   # a ' | ' inside the screen description
                parts = parts[:2] + [" | ".join(parts[2:-2])] + parts[-2:]
            if len(parts) < 5:
                parts += [""] * (5 - len(parts))
            t, words, screen, ref, verdict = parts[:5]
            tags = set(re.findall(r"GAP:([a-z-]+)", verdict))
            rows.append({"t": float(t), "words": words, "screen": screen, "ref": ref, "verdict": verdict,
                         "tags": sorted(tags), "aroll": bool(AROLL_RE.match(screen)), "gen": bool(GEN_RE.search(ref)),
                         "severe": bool(tags & TAG_SEVERE)})
    return sorted(rows, key=lambda r: r["t"])


def human_verdict(rec):
    """The reviewer's verdict of one second, per judged dimension (True = matches the reference)."""
    tags = set(rec.get("tags") or [])
    return {"D1": not (tags & TAG_D1), "D3": not (tags & TAG_D3),
            "D4": (not (tags & TAG_D4)) if rec.get("gen") else None}


def frame_for(frames_dir, t):
    """The still of output second t from the gap review (chunkN/L/f_NNNN.jpg, 1 fps), or None."""
    if frames_dir is None:
        return None
    c, k = int(t // SPAN_S), int(round(t - SPAN_S * int(t // SPAN_S)))
    for p in (Path(frames_dir) / f"chunk{c}" / "L" / f"f_{k + 1:04d}.jpg",
              Path(frames_dir) / f"chunk{c}" / f"f_{k + 1:04d}.jpg"):
        if p.exists():
            return p
    return None


# ─────────────────────────────── verdicts -> span scores ───────────────────────────────

def _clamp(x):
    return round(max(0.0, min(100.0, x)), 1)


def span_features(recs, verdicts):
    n = len(recs)
    sc = [(r, v) for r, v in zip(recs, verdicts) if not r["aroll"]]
    gen = [(r, v) for r, v in zip(recs, verdicts) if r["gen"] and v.get("D4") is not None]
    return {
        "ok1": sum(1 for v in verdicts if v.get("D1")) / n if n else None,
        "aroll": sum(1 for r in recs if r["aroll"]) / n if n else 0.0,
        "dirty": sum(1 for _, v in sc if v.get("D3") is False) / len(sc) if sc else 0.0,
        "severe": 1.0 if any(v.get("severe") for v in verdicts) else 0.0,
        "ok4": sum(1 for _, v in gen if v["D4"]) / len(gen) if gen else None,
    }


def span_scores(recs, verdicts, span_s=SPAN_S, n_spans=8):
    """Per-second verdicts -> {"D1": [score per span], "D3": [...], "D4": [... None where no gen beat]}."""
    out = {d: [] for d in DIMS}
    for sp in range(n_spans):
        idx = [n for n, r in enumerate(recs) if sp * span_s <= r["t"] < (sp + 1) * span_s]
        f = span_features([recs[n] for n in idx], [verdicts[n] for n in idx])
        m = MAPPING
        out["D1"].append(None if f["ok1"] is None else _clamp(m["D1"]["a"] + m["D1"]["ok"] * f["ok1"]))
        out["D3"].append(_clamp(m["D3"]["a"] + m["D3"]["aroll"] * f["aroll"] + m["D3"]["dirty"] * f["dirty"]
                                + m["D3"]["severe"] * f["severe"]))
        out["D4"].append(None if f["ok4"] is None else _clamp(m["D4"]["a"] + m["D4"]["ok"] * f["ok4"]))
    return out


# ─────────────────────────────── calibration ───────────────────────────────

def _norm_verdict(v, rec):
    v = dict(v or {})
    out = {}
    for d in DIMS:
        x = v.get(d)
        out[d] = None if x is None else bool(x)
    if not rec.get("gen"):
        out["D4"] = None
    out["severe"] = bool(v.get("severe"))
    return out


def calibrate(per_second_dir, frames_dir, judge_fn, refs=None, out=None, targets=None, n_spans=8):
    """Run judge_fn over the 880 reviewed seconds (and the reference seconds) and decide, per dimension,
    whether the judge may decide on its own.

      judge_fn(rec, frame_path) -> {"D1": bool, "D3": bool, "D4": bool|None, "severe": bool}
      refs     [{"t", "frame", ...}] seconds of Jake's references (all of them are the 100 % mark)
      out      where calibrated.json goes (None = do not write)

    -> {"dims": {D: {"pass", "span_scores", "targets", "max_err", "agreement", "ref_clean"}}, "passed": [D]}"""
    targets = targets or GAP_S1
    recs = parse_per_second(per_second_dir)
    if not recs:
        raise ValueError(f"no per-second verdicts under {per_second_dir}")
    human = [human_verdict(r) for r in recs]
    got = []
    for r in recs:
        try:
            v = judge_fn(r, frame_for(frames_dir, r["t"]))
        except (JudgeError, ValueError) as exc:                 # an unusable answer counts as a disagreement
            v = {"error": str(exc)[:200]}
        got.append(_norm_verdict(v, r))
    scores = span_scores(recs, got, n_spans=n_spans)
    ref_ok = {}
    if refs:
        rv = []
        for r in refs:
            try:
                rv.append(judge_fn({**r, "gen": r.get("gen", False), "aroll": r.get("aroll", False), "tags": []},
                                   r.get("frame")))
            except (JudgeError, ValueError):
                rv.append({})
        for d in DIMS:
            ys = [x.get(d) for x in rv if x.get(d) is not None]
            ref_ok[d] = sum(1 for y in ys if y) / len(ys) if ys else None
    res = {"dims": {}, "passed": [], "n_seconds": len(recs), "n_ref_seconds": len(refs or [])}
    for d in DIMS:
        tg = targets[d]
        errs = [abs(s - t) for s, t in zip(scores[d], tg) if t is not None and s is not None]
        missing = [i for i, (s, t) in enumerate(zip(scores[d], tg)) if t is not None and s is None]
        pairs = [(g[d], h[d]) for g, h in zip(got, human) if h[d] is not None]
        agree = sum(1 for g, h in pairs if g == h) / len(pairs) if pairs else None
        ok = (bool(errs) and not missing and max(errs) <= TOL and agree is not None and agree >= AGREE_MIN
              and (ref_ok.get(d) is None or ref_ok[d] >= REF_CLEAN_MIN))
        res["dims"][d] = {"pass": ok, "span_scores": scores[d], "targets": tg,
                          "max_err": round(max(errs), 1) if errs else None, "agreement": None if agree is None else round(agree, 3),
                          "ref_clean": ref_ok.get(d), "tol": TOL, "agree_min": AGREE_MIN}
        if ok:
            res["passed"].append(d)
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(res, indent=1))
    return res


def calibrated(path=None):
    """{dim: True/False} from calibrated.json (missing file = nothing calibrated)."""
    try:
        doc = json.loads(Path(path or CALIBRATED).read_text())
    except (OSError, ValueError):
        return {d: False for d in DIMS}
    return {d: bool((doc.get("dims") or {}).get(d, {}).get("pass")) for d in DIMS}


def authority(dim_scores, path=None):
    """Judged dimension scores -> (binding, advisory): only a calibrated dimension's score may pass or
    hold a video; the rest is advice for the log (rubric.ship sees it as not measured)."""
    cal = calibrated(path)
    binding = {d: v for d, v in (dim_scores or {}).items() if cal.get(d)}
    advisory = {d: v for d, v in (dim_scores or {}).items() if not cal.get(d)}
    return binding, advisory


# ─────────────────────────────── the tiered model judge ───────────────────────────────

SYSTEM = (
    "You judge one moment of a screencast tutorial edit against Jake Dawson's reference editor "
    "(the references are the 100 % mark). Answer ONLY with one JSON object, no prose: "
    '{"yes": true|false, "why": "<= 20 words"}.')

QUESTIONS = {
    "D1": "The narrator says: \"{words}\". Expected on screen: {expect}. Is the thing he names (or the result "
          "of the action he names) the framed subject of this frame?",
    "D3": "Is this screen clean the way the references are: the narrator's own account and content only, no "
          "other person's account, no billing/pricing/credentials page in a logged-in app, no error, popup, "
          "toast or tooltip, no sidebar of unrelated chats?",
    "D4": "The narrator says: \"{words}\". Is this generation/wait shown the reference way: a press, then the "
          "finished result (a time-skip), or the in-progress state only while he talks about the wait?",
}


def _llm():
    try:
        from . import llm  # noqa: WPS433 — p1's single caller of the Claude API
        return llm
    except ImportError:
        return None


def parse_answer(text):
    """The strict JSON answer -> {"yes": bool, "why": str}; anything else raises JudgeError."""
    s = str(text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
    try:
        doc = json.loads(s)
    except ValueError as exc:
        raise JudgeError(f"not JSON: {s[:120]}") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("yes"), bool):
        raise JudgeError(f"no boolean 'yes': {s[:120]}")
    return {"yes": doc["yes"], "why": str(doc.get("why") or "")[:200]}


class TieredJudge:
    """Haiku yes/no per beat -> Sonnet where Haiku disagrees with code QA -> Opus confirms flags.

    call(model, system, content) -> text; defaults to llm.messages. allow_spend must be True for a real
    call (the CLI's --allow-spend); tests pass a fake `call`."""

    def __init__(self, call=None, allow_spend=False, job=None):
        self.allow_spend = allow_spend
        self.job = job
        self._call = call
        self.calls = []

    def ask(self, model, question, frame=None):
        if self._call is None:
            if not self.allow_spend:
                raise SpendNotAllowed("the model judges cost API money: run with --allow-spend")
            llm = _llm()
            if llm is None:
                raise RuntimeError("aieditor/llm.py (p1) is not installed: no judge call is possible")
            content = [{"type": "text", "text": question}]
            if frame is not None:
                import base64
                content.insert(0, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                                "data": base64.b64encode(Path(frame).read_bytes()).decode()}})
            reply = llm.messages(model, SYSTEM, content, 200, job=self.job, stage="judge", purpose="judge")
            text = reply.text if hasattr(reply, "text") else reply["text"]
        else:
            text = self._call(model, SYSTEM, {"question": question, "frame": str(frame) if frame else None})
        self.calls.append(model)
        return parse_answer(text)

    def judge(self, dim, item, frame=None, code_ok=None):
        """One beat/second for one dimension -> {"ok": bool, "tier": 1|2|3, "why", "flagged"}.
        code_ok: what code QA said about the same moment (None = no code check)."""
        q = QUESTIONS[dim].format(words=item.get("words", ""), expect=item.get("expect") or item.get("ref", ""))
        a = self.ask(HAIKU, q, frame)
        ok, tier, why = a["yes"], 1, a["why"]
        if code_ok is not None and a["yes"] != bool(code_ok):
            b = self.ask(SONNET, q, frame)
            ok, tier, why = b["yes"], 2, b["why"]
        if not ok:
            # Opus confirms the flag by answering "no" too; its "yes" clears it
            c = self.ask(OPUS, q + " (A second judge flagged this. Answer no only if you are sure.)", frame)
            ok, tier, why = bool(c["yes"]), 3, c["why"]
        return {"ok": ok, "tier": tier, "why": why, "flagged": not ok}

    def as_judge_fn(self, code_qa=None):
        """A calibrate()-compatible judge_fn (one question per dimension per second)."""
        def fn(rec, frame):
            out = {}
            for d in DIMS:
                if d == "D4" and not rec.get("gen"):
                    out[d] = None
                    continue
                code_ok = (code_qa or {}).get((d, rec.get("t")))
                out[d] = self.judge(d, rec, frame, code_ok)["ok"]
            return out
        return fn


# ─────────────────────────────── fakes (tests, dry runs) ───────────────────────────────

def replay_judge(rec, frame=None):
    """A fake judge that answers exactly what the human reviewer wrote (the calibration ceiling)."""
    v = human_verdict(rec)
    v["severe"] = bool(rec.get("severe"))
    return v


def random_judge(seed=7):
    import random
    rnd = random.Random(seed)

    def fn(rec, frame=None):
        return {"D1": rnd.random() < 0.5, "D3": rnd.random() < 0.5,
                "D4": (rnd.random() < 0.5) if rec.get("gen") else None, "severe": rnd.random() < 0.05}
    return fn


def reference_seconds(baseline_dir, refs=("kwysV2smgfY", "3Jq-L6uLd28", "Geg9TyNoi3w", "AZxFgIVgHjg"), every=10):
    """Seconds of Jake's references (gapreview/baseline/<ref>/s/sNNNN.jpg, 1 fps) for the >= 95 % check."""
    out = []
    for r in refs:
        d = Path(baseline_dir) / r / "s"
        for p in sorted(d.glob("s*.jpg"))[::every]:
            out.append({"t": float(int(p.stem[1:]) - 1), "ref_id": r, "frame": p, "words": "", "ref": "",
                        "aroll": False, "gen": False})
    return out


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="aieditor.judges")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("calibrate", help="calibrate the tiered judge on the gap review")
    c.add_argument("--per-second", required=True, help="gapreview dir with chunk0..7/per-second.txt")
    c.add_argument("--frames", default=None, help="dir with chunkN/L/f_NNNN.jpg (default: --per-second)")
    c.add_argument("--baseline", default=None, help="gapreview/baseline (reference seconds)")
    c.add_argument("--out", default=str(CALIBRATED))
    c.add_argument("--judge", choices=("tiered", "replay", "random"), default="tiered")
    c.add_argument("--allow-spend", action="store_true", help="REQUIRED for the tiered (paid) judge")
    a = ap.parse_args(argv)
    if a.judge == "tiered":
        if not a.allow_spend:
            ap.error("the tiered judge calls Claude (Haiku/Sonnet/Opus) and costs money: add --allow-spend")
        fn = TieredJudge(allow_spend=True).as_judge_fn()
    else:
        fn = replay_judge if a.judge == "replay" else random_judge()
    refs = reference_seconds(a.baseline) if a.baseline else None
    res = calibrate(a.per_second, a.frames or a.per_second, fn, refs=refs, out=a.out)
    print(json.dumps({d: {k: v for k, v in x.items() if k != "span_scores"} for d, x in res["dims"].items()}, indent=1))
    return 0 if res["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
