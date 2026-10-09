"""RECORDING + COMPOSE GATES (gap list G4): nothing planned silently becomes A-roll.

Jake (2026-10-09): "it didn't screencast the right things and didn't put them in the right timings";
"the references are the 100% mark score". In the reviewed edit 290 of 668 planned screencast seconds
became A-roll because one OCR hit dropped or prefix-cut a segment and nothing was ever re-recorded
(43 % screencast vs the references' 72-76 %, REFERENCE-BASELINE §1a). This module decides, from the
guard and content QA, what happens to each recorded segment. Pure functions, no I/O beyond reading
small JSON files, so the decisions are unit-tested and can be dry-run on any job.

  take gate     a take counts as recorded only when the extended frame guard (qa_frames.py: walls,
                errors, foreign account, idle tail, empty canvas, garbled field text) and content QA
                (qa_content.py: delivered / must / typed / no_challenge) pass  ->  else RETAKE
  salvage       only after MAX_TAKES failed takes: excise just the bad spans, snap every kept edge to a
                sentence start (CUT04/CUT05: 72-98 % of screen<->face cuts within 0.6 s of a sentence
                start, picture ~0.1 s ahead, BASELINE §1d/§2d), never drop a whole segment for one hit
                with clean frames on both sides; every lost second is reported as a D1 fail
  structure     blocks.json against the reference structure (BASELINE §1a/§1b, rubric D7): screencast
                share >= 72 % (hard floor 68 %), A-roll block p50 5-6.5 s, screencast span p50 10-18 s,
                3-6 screen<->face boundaries per minute. A failing structure blocks 'compose done'.
  coverage      the recommendation's coverage gate (§4 checkpoint 3, migration step 1): the screencast
                share sits in the reference band 72-76 % AND >= 95 % of the planned screencast seconds
                are kept. A job that misses it does not pass: it is HELD (never shipped quietly).
  take_verdict  the pure per-take verdict the scripted recorder (p7) calls after each take: guard spans
                + content checks (+ privacy hits) -> ok / reasons / the remedy-table action to try next.

Architecture alignment (RECOMMENDATION §3-§4, Jake 2026-10-09): code decides; nothing here calls a model.
Salvage only ever trims SCREEN pieces: the narration (edl, words, pauses) is never touched, never cut and
never re-timed (Jake: "G1 trims pauses - I don't want that at all"); every second it loses is a D1 failure
that lands in the job's held reasons.
"""
import difflib
import json
import re
import statistics
from pathlib import Path

MAX_TAKES = 3              # 1 take + 2 retakes, then salvage (spec G4.4: "only after N failed retakes")
SNAP_S = 0.6               # BASELINE §1d/§2d: a screen<->face cut within 0.6 s of a sentence start
LEAD_S = 0.1               # ... the picture leads the sentence by ~0.1 s (CUT04 r3 0:22.75)
MIN_PIECE_S = 2.5          # RULEBOOK §4 P4: no screencast piece shorter than this
GUARD_EVERY_S = 0.5        # the extended guard samples every 0.5 s (spec G4.2)
IDLE_S = 3.0               # RULEBOOK §4 P1 / BASELINE §4: no still > 3 s (camera-still p50 0.77-1.4 s)

# reference structure (REFERENCE-BASELINE §1a/§1b; refs r2-r5)
SHARE_MIN, SHARE_FLOOR = 0.72, 0.68
AROLL_P50 = (5.0, 6.5)
SPAN_P50 = (10.0, 18.0)
BOUNDS_PER_MIN = (3.0, 6.0)
LONG_FORM_S = 120.0        # the structure rules are for tutorials, not 20 s tests
# coverage gate (RECOMMENDATION §4.3 / migration step 1; skill rules.json "structure"/"coverage")
COVER_SHARE = (0.72, 0.76)
COVER_KEPT_MIN = 0.95

# what a take may never contain (frame guard kinds)
WALL_KINDS = ("challenge", "error", "account")
SPAN_KINDS = WALL_KINDS + ("idle", "idle_tail", "empty", "garbled", "privacy")
# content QA checks that make a take fail (on_word / nav need the camera: judged after compose, scored D2)
TAKE_CHECKS = ("delivered", "must", "typed", "no_challenge", "brand")


class RetakeNeeded(RuntimeError):
    """compose found takes that fail the gate while retakes remain: re-record them, never A-roll them."""

    def __init__(self, segs, why):
        super().__init__(f"retakes needed for screencast(s) {', '.join(f'{i:02d}' for i in segs)}: {why}")
        self.segs = list(segs)
        self.why = why


class StructureGateError(RuntimeError):
    """blocks.json is outside the reference structure (rubric D7): the edit is not done."""


# ───────────────────────────── words / sentences ─────────────────────────────

_END = re.compile(r"[.?!][\"'’”)\]]*$")


def sentence_starts(words, pause_s=0.9):
    """Start times of sentences: the first word, a word after . ? ! and a word after a >= 0.9 s pause
    (the same unit as planfit.sentences / takes.sentences)."""
    out = []
    prev = None
    for w in words:
        if prev is None or _END.search(str(prev["word"])) or w["start"] - prev["end"] > pause_s:
            out.append(round(float(w["start"]), 3))
        prev = w
    return out


def nearest(starts, t):
    return min(starts, key=lambda s: abs(s - t)) if starts else None


# ───────────────────────────── guard spans ─────────────────────────────

def merge(spans, gap=0.0):
    out = []
    for a, b, *rest in sorted(spans, key=lambda s: s[0]):
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
            if rest:
                out[-1][2] = out[-1][2] if len(out[-1]) > 2 else rest[0]
        else:
            out.append([a, b] + list(rest[:1]))
    return out


def spans_from_hits(hits, every, dur=None):
    """Point hits (an OCR sample at t) -> conservative spans: the bad state may have begun just after
    the last clean sample and may last until the next one, so each run of hits is widened by one
    sampling interval on both sides (the margin that covers every red-text frame)."""
    pts = sorted(hits, key=lambda h: float(h.get("t", 0)))
    out = []
    for h in pts:
        t = float(h.get("t", 0))
        a, b = max(0.0, t - every), t + every
        if dur is not None:
            b = min(b, dur)
        if out and a <= out[-1]["t1"] + 1e-6 and out[-1]["kind"] == h.get("kind"):
            out[-1]["t1"] = max(out[-1]["t1"], b)
            out[-1]["n"] += 1
        else:
            out.append({"t0": round(a, 3), "t1": round(b, 3), "kind": h.get("kind"), "why": h.get("why"), "n": 1})
    return out


def guard_spans(qa, key):
    """The bad spans of one segment from a frames-qa.json document (old point format or v2 spans)."""
    every = float(qa.get("every_s", 1.5))
    dur = (qa.get("dur") or {}).get(key)
    if "spans" in qa:
        return [dict(s) for s in qa["spans"].get(key, [])]
    return spans_from_hits(qa.get("segments", {}).get(key, []), every, dur)


# ───────────────────────────── take verdict ─────────────────────────────

def load_state(sd):
    try:
        return json.loads((Path(sd) / "gate.json").read_text())
    except (OSError, ValueError):
        return {}


def takes_of(sd):
    """Takes recorded so far: gate.json counts them; a recording without one is take 1."""
    st = load_state(sd)
    n = int(st.get("takes", 0))
    return max(n, 1 if (Path(sd) / "rec" / "events.json").exists() else 0)


def content_fails(checks):
    return [c for c in checks or [] if not c.get("ok") and c.get("check") in TAKE_CHECKS]


def verdict(spans, checks=None, walls=None):
    """One take: ok / the reasons it fails (spec G4.1). walls = the recorder's live events.json walls."""
    reasons = []
    for s in spans:
        if s.get("kind") in SPAN_KINDS:
            reasons.append(f"{s['kind']} {s['t0']:.1f}-{s['t1']:.1f}s" + (f" ({s.get('why')})" if s.get("why") else ""))
    for w in walls or []:
        if w.get("kind") in WALL_KINDS:
            reasons.append(f"{w.get('kind')} at {float(w.get('t', 0)):.1f}s (recorder)")
    for c in content_fails(checks):
        what = c.get("must") or c.get("want") or c.get("why") or c.get("beat") or ""
        reasons.append(f"beat failed: {c['check']} at {c.get('at', c.get('t', '?'))} {str(what)[:60]}")
    return {"ok": not reasons, "reasons": reasons}


def decide(segs, qa, rec_dirs, checks_by_seg=None, max_takes=MAX_TAKES):
    """compose's decision for every recorded segment (pure): {"retake": [i], "clean": [i], "salvage": [i],
    "verdicts": {i: verdict}}. A failing take with retakes left is RETAKEN, never turned into A-roll."""
    out = {"retake": [], "clean": [], "salvage": [], "verdicts": {}}
    for i, _ in enumerate(segs):
        sd = rec_dirs.get(i)
        if sd is None or not (Path(sd) / "rec" / "events.json").exists():
            continue
        key = f"{i:02d}"
        try:
            walls = json.loads((Path(sd) / "rec" / "events.json").read_text()).get("walls", [])
        except (OSError, ValueError):
            walls = []
        v = verdict(guard_spans(qa, key), (checks_by_seg or {}).get(i), walls if isinstance(walls, list) else [])
        v["takes"] = takes_of(sd)
        out["verdicts"][i] = v
        if v["ok"]:
            out["clean"].append(i)
        elif v["takes"] < max_takes:
            out["retake"].append(i)
        else:
            out["salvage"].append(i)
    return out


# ───────────────────────────── salvage ─────────────────────────────

SNAP_MAX_MOVE_S = 4.5      # an edge with no sentence start within 0.6 s moves inward to one at most this far
                           # (387.41 -> 383.59 in the failed job); further than that, a clause start or the
                           # clean edge itself: clean footage is never thrown away just to snap


def clause_starts(words, pause_s=0.25):
    """Starts of clauses: a sentence start, a word after , ; : or a dash, a word after a >= 0.25 s pause."""
    out, prev = [], None
    for w in words:
        if prev is None or re.search(r"[,;:\u2014\u2013-][\"'\u2019\u201d)\]]*$", str(prev["word"])) or \
                _END.search(str(prev["word"])) or w["start"] - prev["end"] >= pause_s:
            out.append(round(float(w["start"]), 3))
        prev = w
    return out


def _first_valid(cands, ok):
    for c in cands:
        if c is not None and ok(c):
            return round(c, 3)
    return None


def snap_end(edge, lo, starts, limit=None, clauses=(), max_move=SNAP_MAX_MOVE_S, snap=SNAP_S, lead=LEAD_S):
    """The cut for a piece that ENDS near `edge` (A-roll or a bad span after it), never later than `limit`
    (the last clean, recorded second). In order: ~0.1 s before a sentence start within 0.6 s; the previous
    sentence start (picture leads by 0.1 s) within `max_move`; a clause start within 0.6 s; the clean edge
    itself. The first that leaves a piece of >= MIN_PIECE_S wins. None = no piece."""
    limit = edge if limit is None else min(edge, limit)
    near = sorted((s for s in starts if abs(s - edge) <= snap), key=lambda s: abs(s - edge))
    c1 = [s - lead if s - lead <= limit else (limit if abs(s - limit) <= snap else None) for s in near]
    c2 = [max([s - lead for s in starts if s - lead <= limit and edge - (s - lead) <= max_move], default=None)]
    c3 = [c - lead for c in sorted(clauses, key=lambda c: abs(c - edge)) if abs(c - edge) <= snap and c - lead <= limit]
    return _first_valid(c1 + c2 + c3 + [limit], lambda c: c - lo >= MIN_PIECE_S)


def snap_start(edge, hi, starts, floor=None, clauses=(), max_move=SNAP_MAX_MOVE_S, snap=SNAP_S, lead=LEAD_S):
    """The cut for a piece that STARTS near `edge` (after A-roll or a bad span), never earlier than `floor`
    (the first clean, recorded second): a sentence start within 0.6 s; the next sentence start within
    `max_move`; a clause start within 0.6 s; the clean edge itself — the first leaving >= MIN_PIECE_S."""
    floor = edge if floor is None else max(edge, floor)
    near = sorted((s for s in starts if abs(s - edge) <= snap), key=lambda s: abs(s - edge))
    c1 = [s - lead if s - lead >= floor else (floor if abs(s - floor) <= snap else None) for s in near]
    c2 = [min([s - lead for s in starts if s - lead >= floor and (s - lead) - edge <= max_move], default=None)]
    c3 = [max(c - lead, floor) for c in sorted(clauses, key=lambda c: abs(c - edge)) if abs(c - edge) <= snap]
    return _first_valid(c1 + c2 + c3 + [floor], lambda c: hi - c >= MIN_PIECE_S)


def salvage(seg, spans, words, rec_end=None, snap_planned=True, keep_start=False, keep_end=False):
    """Excise only the bad spans of a segment (spec G4.4) — the sentence-snapped fallback.

    seg: {t0, t1} on the output timeline; spans: recording-relative [{t0, t1, kind}]; rec_end: how long
    the recording runs. Every edge next to A-roll is snapped (snap_start / snap_end); keep_start /
    keep_end leave an edge that abuts another screencast where it is. Only SCREEN pieces are cut: the
    narration under them plays on untouched (the A-roll shows the presenter over the same words).
    Returns {"pieces": [{t0, t1, src0}], "lost": [{t0, t1, why}], "lost_s"}: src0 = where the piece
    starts on the recording's clock (camera.py --from)."""
    T0, T1 = float(seg["t0"]), float(seg["t1"])
    rec_hi = T0 + (rec_end if rec_end is not None else T1 - T0 + 0.5)
    starts = sentence_starts(words)
    clauses = clause_starts(words)
    if any(s.get("kind") == "account" for s in spans):
        # another person's account (the 'Keith' greeting) is the WHOLE take, whatever frames the OCR read:
        # nothing of it may be shown (RULEBOOK §S / C7) — the segment is lost and re-recorded or held
        return {"pieces": [], "lost": [{"t0": round(T0, 3), "t1": round(T1, 3), "why": "account"}],
                "lost_s": round(T1 - T0, 2)}
    bad = merge([[T0 + float(s["t0"]), T0 + float(s["t1"]), s.get("kind")] for s in spans], gap=0.05)
    bad = [b for b in bad if b[1] > T0 and b[0] < T1]
    clean, t = [], T0
    for a, b, _ in bad:
        if a > t:
            clean.append([t, a, "planned" if t == T0 else "bad", "bad"])
        t = max(t, b)
    if t < T1:
        clean.append([t, T1, "planned" if t == T0 else "bad", "planned"])
    pieces = []
    for a, b, a_kind, b_kind in clean:
        if a_kind == "planned" and (keep_start or not snap_planned):
            s0 = a if b - a >= MIN_PIECE_S else None
        else:
            s0 = snap_start(a, b, starts, floor=a, clauses=clauses)
        if s0 is None:
            continue
        if b_kind == "planned" and (keep_end or not snap_planned):
            s1 = min(b, rec_hi)
        else:
            s1 = snap_end(b, s0, starts, limit=min(b, rec_hi), clauses=clauses)
        if s1 is None or s1 - s0 < MIN_PIECE_S:
            continue
        pieces.append({"t0": round(s0, 3), "t1": round(s1, 3), "src0": round(s0 - T0, 3)})
    lost, t = [], T0
    for p in pieces:
        if p["t0"] > t + 0.05:
            lost.append({"t0": round(t, 3), "t1": p["t0"]})
        t = p["t1"]
    if T1 > t + 0.05:
        lost.append({"t0": round(t, 3), "t1": round(T1, 3)})
    for x in lost:
        x["why"] = ", ".join(sorted({str(b[2]) for b in bad if b[0] < x["t1"] and b[1] > x["t0"]})) or "sentence snap"
    return {"pieces": pieces, "lost": lost, "lost_s": round(sum(x["t1"] - x["t0"] for x in lost), 2)}


def snap_clean(seg, words, rec_end=None, keep_start=False, keep_end=False):
    """A clean segment's edges next to A-roll on sentence starts (salvage with no bad span)."""
    return salvage(seg, [], words, rec_end, keep_start=keep_start, keep_end=keep_end)


def beats_lost(expect_beats, seg, lost):
    """Planned beats whose word falls inside a lost span — each a D1 fail (the named thing never shown)."""
    out = []
    for b in expect_beats or []:
        t = float(seg["t0"]) + float(b["at"])
        if any(x["t0"] <= t < x["t1"] for x in lost):
            out.append({**b, "t": round(t, 2)})
    return out


# ───────────────────────────── structure gate ─────────────────────────────

def structure(blocks, duration=None):
    """blocks.json -> the reference structure numbers and verdict (rubric D7, BASELINE §1a/§1b)."""
    bl = blocks.get("blocks", blocks) if isinstance(blocks, dict) else blocks
    bl = sorted([float(a), float(b)] for a, b in bl)
    dur = float(duration if duration is not None else (bl[-1][1] if bl else 0.0))
    if isinstance(blocks, dict) and duration is None and blocks.get("words"):
        dur = max(dur, max(float(w["end"]) for w in blocks["words"]))
    aroll = [b - a for a, b in bl if b - a > 0.05]
    spans, t = [], 0.0
    for a, b in bl:
        if a - t > 0.05:
            spans.append(a - t)
        t = max(t, b)
    if dur - t > 0.05:
        spans.append(dur - t)
    edges = sum((a > 0.05) + (b < dur - 0.05) for a, b in bl)
    if not bl:
        edges = 0
    share = sum(spans) / dur if dur else 0.0
    s = {"duration": round(dur, 2), "share": round(share, 4),
         "aroll_p50": round(statistics.median(aroll), 2) if aroll else 0.0,
         "span_p50": round(statistics.median(spans), 2) if spans else 0.0,
         "bounds_per_min": round(edges / (dur / 60), 2) if dur else 0.0,
         "aroll_blocks": len(aroll), "spans": len(spans)}
    fails, warns = [], []
    if dur < LONG_FORM_S:
        s.update(ok=True, fails=[], warns=[f"{dur:.0f} s video: structure gate applies from {LONG_FORM_S:.0f} s"])
        return s
    if share < SHARE_FLOOR:
        fails.append(f"screencast share {share:.0%} < {SHARE_FLOOR:.0%} hard floor (refs 72-76 %)")
    elif share < SHARE_MIN:
        warns.append(f"screencast share {share:.0%} under the reference 72-76 % (D7 -10)")
    if not AROLL_P50[0] <= s["aroll_p50"] <= AROLL_P50[1]:
        fails.append(f"A-roll block median {s['aroll_p50']:.1f} s outside {AROLL_P50[0]}-{AROLL_P50[1]} s")
    if not SPAN_P50[0] <= s["span_p50"] <= SPAN_P50[1]:
        fails.append(f"screencast span median {s['span_p50']:.1f} s outside {SPAN_P50[0]:.0f}-{SPAN_P50[1]:.0f} s")
    if not BOUNDS_PER_MIN[0] <= s["bounds_per_min"] <= BOUNDS_PER_MIN[1]:
        fails.append(f"{s['bounds_per_min']:.1f} screen<->face boundaries/min outside {BOUNDS_PER_MIN[0]:.0f}-"
                     f"{BOUNDS_PER_MIN[1]:.0f}")
    s.update(ok=not fails, fails=fails, warns=warns)
    return s


def _rules():
    """The skill folder's rules.json (p2: aieditor/.claude/skills/jake-editor) when it is installed."""
    try:
        from . import skill  # noqa: WPS433 (optional until the skill package is merged)
        return skill.rules() or {}
    except Exception:                                      # noqa: BLE001
        return {}


def screen_time(blocks, duration):
    """[(t0, t1)] seconds that are NOT A-roll (the screencast/plate time of the edit)."""
    bl = sorted([float(a), float(b)] for a, b in blocks)
    out, t = [], 0.0
    for a, b in bl:
        if a - t > 0.05:
            out.append((t, a))
        t = max(t, b)
    if duration - t > 0.05:
        out.append((t, float(duration)))
    return out


def coverage(blocks, plan, duration=None):
    """The coverage gate (RECOMMENDATION §4 checkpoint 3): screencast share of the edit inside the
    reference band (72-76 %) AND >= 95 % of the planned screencast seconds kept. -> {share, kept_frac,
    planned_s, kept_s, ok, fails}. A plan with no screencast segments is not gated (applies: False)."""
    r = _rules()
    lo, hi = (r.get("structure") or {}).get("screencast_share", COVER_SHARE)
    kept_min = float((r.get("coverage") or {}).get("min_kept_frac", COVER_KEPT_MIN))
    bl = blocks.get("blocks", blocks) if isinstance(blocks, dict) else blocks
    segs = (plan or {}).get("segments", []) if isinstance(plan, dict) else list(plan or [])
    if duration is None:
        duration = max([float(b) for _, b in bl] + [float(s["t1"]) for s in segs] + [0.0])
        if isinstance(blocks, dict) and blocks.get("words"):
            duration = max(duration, max(float(w["end"]) for w in blocks["words"]))
    scr = screen_time(bl, duration)
    share = sum(b - a for a, b in scr) / duration if duration else 0.0
    planned = sum(max(0.0, float(s["t1"]) - float(s["t0"])) for s in segs)
    kept = sum(max(0.0, min(float(s["t1"]), b) - max(float(s["t0"]), a)) for s in segs for a, b in scr)
    out = {"share": round(share, 4), "planned_s": round(planned, 2), "kept_s": round(kept, 2),
           "kept_frac": round(kept / planned, 4) if planned else 1.0, "band": [lo, hi], "kept_min": kept_min}
    if not segs:
        out.update(ok=True, applies=False, fails=[])
        return out
    fails = []
    if not lo <= share <= hi:
        fails.append(f"screencast share {share:.0%} outside the reference {lo:.0%}-{hi:.0%}")
    if out["kept_frac"] < kept_min:
        fails.append(f"kept {kept:.0f} of {planned:.0f} planned screencast seconds = {out['kept_frac']:.2f} "
                     f"< {kept_min:.2f}")
    out.update(ok=not fails, applies=True, fails=fails)
    return out


# ───────────────────────────── per-take verdict (p7 calls this after every take) ─────────────────────────────

def _seg_key(seg_dir):
    name = Path(seg_dir).name
    m = re.search(r"(\d+)$", name)
    return f"{int(m.group(1)):02d}" if m else name


def _privacy_spans(priv, key):
    if not priv:
        return []
    if isinstance(priv, list):
        return priv
    if isinstance(priv.get("segments"), dict):
        return priv["segments"].get(key, [])
    sp = priv.get("spans")
    return sp.get(key, []) if isinstance(sp, dict) else list(sp or [])


def take_verdict(seg_dir, expect, qa_frames_out, qa_content_out, privacy_out=None):
    """The take gate as a pure function of the stage outputs (no I/O except events.json walls):

      seg_dir         seg-NN (its rec/events.json "walls" are the recorder's live checks)
      expect          this segment's expectation beats (list) or the whole expect.json document
      qa_frames_out   qa_frames.py output (v2 spans or v1 point hits)
      qa_content_out  qa_content.py output ({"segments": {"seg-NN": [checks]}}) or that segment's list
      privacy_out     p5's privacy check for this take: [{"t0","t1","why"}] legible private spans, or
                      {"spans": [...]} / {"segments": {"NN": [...]}}; None = not run

    -> {"ok", "reasons": [str], "problems": [{kind, problem, t0, t1, why}], "remedy": next action | None}
    The remedy is the first step of remedy.TABLE for the most serious problem (remedy.plan_for gives the
    full sequence); the narration is never a remedy target."""
    from . import remedy
    key = _seg_key(seg_dir)
    spans = guard_spans(qa_frames_out or {}, key)
    if isinstance(qa_content_out, dict):
        segs = qa_content_out.get("segments", {})
        checks = segs.get(f"seg-{key}", segs.get(key, segs.get(str(int(key)) if key.isdigit() else key, [])))
    else:
        checks = list(qa_content_out or [])
    spans = spans + [{"t0": float(p["t0"]), "t1": float(p["t1"]), "kind": "privacy",
                      "why": p.get("why", "legible private information")} for p in _privacy_spans(privacy_out, key)]
    try:
        walls = json.loads((Path(seg_dir) / "rec" / "events.json").read_text()).get("walls", [])
    except (OSError, ValueError):
        walls = []
    v = verdict(spans, checks, walls if isinstance(walls, list) else [])
    problems = []
    for s in spans:
        if s.get("kind") in SPAN_KINDS:
            problems.append({"kind": s["kind"], "problem": remedy.classify(s["kind"]), "t0": s.get("t0"),
                             "t1": s.get("t1"), "why": s.get("why")})
    for w in walls if isinstance(walls, list) else []:
        if w.get("kind") in WALL_KINDS:
            problems.append({"kind": w["kind"], "problem": remedy.classify(w["kind"]), "t0": w.get("t"),
                             "t1": w.get("t"), "why": w.get("why")})
    for c in content_fails(checks):
        problems.append({"kind": c["check"], "problem": remedy.classify(c["check"]),
                         "t0": c.get("at", c.get("t")), "t1": c.get("at", c.get("t")),
                         "why": c.get("why") or c.get("must") or c.get("want")})
    beats = expect if isinstance(expect, list) else \
        ((expect or {}).get("segments", {}).get(str(int(key)) if key.isdigit() else key, []))
    for p in problems:
        if p.get("t0") is None:
            continue
        before = [b for b in beats or [] if float(b.get("at", 0)) <= float(p["t0"]) + 0.3]
        p["beat"] = before[-1].get("cue") or before[-1].get("id") if before else None
    worst = remedy.worst([p["problem"] for p in problems])
    tried = load_state(seg_dir).get("remedies", [])
    v.update(problems=problems, problem=worst, remedy=remedy.next_action(worst, tried) if worst else None)
    return v


# ───────────────────────────── held failures (RECOMMENDATION §4: never shipped quietly) ─────────────────────────────

def failure(dim, why, beat=None, t=None, remedies_tried=None):
    """One line of held.json "failures" (the Lab's failure list)."""
    return {"dim": dim, "beat": beat, "t": None if t is None else round(float(t), 2), "why": str(why)[:300],
            "remedies_tried": list(remedies_tried or [])}


def salvage_failures(i, seg, sv, expect_beats=None, remedies_tried=None):
    """Every second a salvage loses is a D1 failure (rubric D1: dropped planned screencast seconds count
    as fails) — one line per lost span, naming the planned beats it took with it. (A trim of <= 0.6 s that
    only puts a cut on its sentence start is cut placement, not lost content; the coverage gate still
    counts those seconds.)"""
    out = []
    lost_all = [x for x in sv.get("lost", []) if not (x.get("why") == "sentence snap" and x["t1"] - x["t0"] <= SNAP_S)]
    lost_beats = beats_lost(expect_beats, seg, lost_all)
    for x in lost_all:
        names = [str(b.get("cue")) for b in lost_beats if x["t0"] <= b["t"] < x["t1"] and b.get("cue")]
        out.append(failure("D1", f"screencast {i + 1}: {x['t1'] - x['t0']:.1f} s of planned screencast lost "
                                 f"({x.get('why') or 'bad take'})" + (f" — beats: {', '.join(names[:4])}" if names else ""),
                           beat=names[0] if names else None, t=x["t0"], remedies_tried=remedies_tried))
    return out


HELD = "held.json"


def held_doc(d):
    """The job's held.json: {"reasons": [{reason, detail}] (p1/p5/p6/p7 pre-compose holds),
    "failures": [{dim, beat, t, why, remedies_tried}] (this module: the edit's verdicts)}."""
    try:
        doc = json.loads((Path(d) / HELD).read_text())
    except (OSError, ValueError):
        doc = {}
    return {"reasons": list(doc.get("reasons") or []), "failures": list(doc.get("failures") or [])}


def write_held(d, failures):
    """Record the edit verdicts' failures in held.json, keeping every other package's reasons."""
    doc = held_doc(d)
    doc["failures"] = list(failures)
    if not doc["failures"] and not doc["reasons"]:
        (Path(d) / HELD).unlink(missing_ok=True)
        return doc
    (Path(d) / HELD).write_text(json.dumps(doc, indent=1))
    return doc


def held_list(d):
    """Every reason the job is held, as failure lines (the Lab's list): pre-compose reasons first."""
    doc = held_doc(d)
    pre = [failure("held", r.get("reason", "") + (f" ({r['detail']})" if r.get("detail") else ""))
           for r in doc["reasons"]]
    return pre + doc["failures"]


def edit_verdict(structure_out, coverage_out, rubric_out, judged=None, salvage_lost=(), held_reasons=(),
                 unapproved=0, private_frames=0, draft="output"):
    """The edit's verdict (edit-NN/verdict.json), pure: structure gate + coverage gate + rubric (code
    dimensions; judged dimensions only from a CALIBRATED judge — `judged` = the binding scores) +
    rubric.ship. Held when ship fails, a gate fails, or any package left a held reason. Every failure is
    one line {dim, beat, t, why, remedies_tried}; nothing is dropped silently."""
    from . import rubric
    dims = dict((rubric_out or {}).get("dims") or {})
    for k, v in (judged or {}).items():
        dims[k] = v
    findings = list((rubric_out or {}).get("findings") or [])
    fails = []
    for f in salvage_lost:
        fails.append(f if "dim" in f else failure("D1", f.get("why", "planned screencast lost"), f.get("beat"), f.get("t")))
    if coverage_out and not coverage_out.get("ok", True):
        for why in coverage_out.get("fails", []):
            fails.append(failure("D7" if why.startswith("screencast share") else "D1", f"coverage: {why}"))
    if structure_out and not structure_out.get("ok", True):
        for why in structure_out.get("fails", []):
            fails.append(failure("D7", f"structure: {why}"))
    sh = rubric.ship(dims, findings, unapproved=unapproved, private_frames=private_frames)
    for why in sh["fails"]:
        dim = why.split(" ", 1)[0] if why[:1] == "D" else ("D9" if "narration" in why else
                                                            "privacy" if "private" in why else "critical")
        fails.append(failure(dim, f"ship rule: {why}"))
    for f in findings:
        if f.get("severity") == "critical":
            fails.append(failure(f["dim"], f["why"], f.get("beat"), f.get("t")))
    for r in held_reasons:
        fails.append(failure("held", r.get("reason", "") + (f" ({r['detail']})" if r.get("detail") else "")))
    held = bool(fails) or not sh["ship"]
    return {"held": held, "ship": sh, "dims": dims, "overall": rubric.overall(dims),
            "structure": structure_out, "coverage": coverage_out, "findings": findings,
            "failures": fails, "draft": draft}


# ───────────────────────────── expectations (beats) ─────────────────────────────

CUE_RE = re.compile(r"""\b[Oo]n\s+['‘"“]((?:[^'’"”;]|'(?=[a-z]))+?)['’"”]\s*:\s*""")
QUOTE_RE = re.compile(r"""['‘"“]((?:[^'"‘’“”]|'(?=[a-z]))+?)['’"”](?![a-z])""")
TYPED_RE = re.compile(r"""['‘"“]((?:[^'"‘’“”]|'(?=[a-z]))+?)['’"”]\s+(?:is\s+|are\s+)?(?:pasted|typed)""")
# a beat that shows a RESULT (a photo / logo / generated thing): an empty canvas there is a defect
CONTENT_RE = re.compile(r"\b(dissolves?|finished|result|generated|edited|the (?:new |full |whole |final )?"
                        r"(?:photo|image|picture|logo|poster|portrait))\b"
                        r"(?!\s+(?:tile|template|tab|button|option|box|icon|card|panel|menu|page|grid|list)s?\b)", re.I)
# a camera-only beat keeps whatever the screen was expected to hold
CAMERA_RE = re.compile(r"^\s*(?:the cursor|zoom|ease|push|hold|pan|tighter|framed|stay)", re.I)


def _norm(w):
    return re.sub(r"[^a-z0-9]", "", str(w).lower())


def _resolve(cue, ws, after):
    target = _norm(cue)
    best, score = None, 0.0
    for k in range(after + 1, len(ws)):
        acc = ""
        for j in range(k, min(len(ws), k + 12)):
            acc += _norm(ws[j]["word"])
            if len(acc) >= len(target):
                break
        r = difflib.SequenceMatcher(None, target, acc[:len(target) + 2]).ratio()
        if _norm(ws[k]["word"])[:2] != target[:2]:
            r -= 0.15
        if r > score + 1e-9:
            best, score = k, r
            if r >= 0.98:
                break
    return best if score >= 0.62 else None


def parse_beats(seg, words):
    """Fallback when the planner wrote no beat ledger: "on '<cue>': <body>" beats of the intent, each
    resolved to its word (segment-relative `at`), with typed / must text and whether it shows a result."""
    intent = str(seg.get("intent") or "")
    ms = list(CUE_RE.finditer(intent))
    pre = intent[:ms[0].start()] if ms else intent
    ws = [w for w in words if seg["t0"] - 2 <= w["start"] <= seg["t1"] + 2]
    out, after = [], -1
    for n, m in enumerate(ms):
        body = intent[m.end():ms[n + 1].start() if n + 1 < len(ms) else len(intent)].strip().rstrip(";. ")
        k = _resolve(m.group(1), ws, after)
        if k is None:
            continue
        after = k
        typed = [q.group(1) for q in TYPED_RE.finditer(body)]
        quotes = [q.group(1) for q in QUOTE_RE.finditer(body)]
        if not typed and quotes and re.fullmatch(r"""\s*['‘"“].*['’"”]\s*""", body, re.S) and re.search(r"past|typ", pre, re.I):
            typed = quotes[:1]
        must = [q for q in quotes if q not in typed and not q.startswith(("http", "/"))]
        content = True if CONTENT_RE.search(body) else (None if CAMERA_RE.search(body) else False)
        out.append({"at": round(ws[k]["start"] - seg["t0"], 2), "cue": m.group(1), "must": must,
                    "typed": typed[0] if typed else None, "content": content})
    return out


def beats_from_ledger(ledger, si, seg):
    """G2's beat ledger rows (edit-NN/beats.json "beats") for segment si -> expectation beats."""
    out = []
    for r in ledger:
        if r.get("seg") != si or r.get("t_word") is None or r.get("route") not in ("keep", "rewrite", "public"):
            continue
        body = str(r.get("body", ""))
        content = True if (r.get("action") == "dissolve" or CONTENT_RE.search(body)) else \
            (None if r.get("action") in ("zoom", "push", "hold", "release", "hover") else False)
        out.append({"at": round(float(r["t_word"]) - float(seg["t0"]), 2), "cue": r.get("cue"),
                    "must": list(r.get("must_text") or []), "typed": r.get("typed_text"), "content": content})
    return out


# playbook actions whose beat ends on a RESULT (a generated image, a finished render): the frame guard's
# empty-canvas rule applies from that beat on (p2 playbooks; G2 ledger action "dissolve")
RESULT_ACTIONS = ("dissolve", "reveal", "show_result", "generate", "send", "submit", "upload_result")
CAMERA_ACTIONS = ("zoom", "push", "hold", "release", "hover", "pan", "read")


def beats_from_plan(seg):
    """Plan-schema beats (skill schemas/plan.schema.json: segments[].beats[] with t_word, action,
    must_text, typed_text, result_assertion, asset_id, subject) -> expectation beats."""
    out = []
    for b in seg.get("beats") or []:
        if b.get("t_word") is None:
            continue
        act = str(b.get("action") or "")
        subj = str(b.get("subject") or "")
        if b.get("result_assertion") or b.get("asset_id") or subj.startswith("asset:") or \
                any(act == a or act.endswith("." + a) or act.endswith("_" + a) for a in RESULT_ACTIONS):
            content = True
        elif any(act == a or act.endswith("." + a) for a in CAMERA_ACTIONS):
            content = None
        else:
            content = False
        must = list(b.get("must_text") or [])
        if b.get("result_assertion") and not must and isinstance(b["result_assertion"], str) and \
                len(b["result_assertion"]) <= 60 and not re.search(r"\s(is|are|shows?)\s", b["result_assertion"]):
            must = [b["result_assertion"]]
        out.append({"at": round(float(b["t_word"]) - float(seg["t0"]), 2), "cue": b.get("id") or subj or act,
                    "must": must, "typed": b.get("typed_text"), "content": content, "action": act,
                    "live": bool(b.get("live"))})
    return out


def expectations(plan, words, ledger=None, forbid=("Blue Bottle",)):
    """expect.json for qa_content.py / qa_frames.py: {"forbid": [...], "segments": {"3": [beat]}}.
    Source, in order: the plan-schema beats (p2/p6 single plan call), the G2 beat ledger (beats.json),
    the segment intents. `must` beats only where the plan names a text; RULEBOOK hard rule: Blue Bottle
    Coffee never in frame."""
    segs = {}
    for i, seg in enumerate(plan.get("segments", [])):
        beats = beats_from_plan(seg) if seg.get("beats") else []
        if not beats and ledger:
            beats = beats_from_ledger(ledger, i, seg)
        if not beats:
            beats = parse_beats(seg, words)
        segs[str(i)] = beats
    return {"forbid": list(forbid), "segments": segs}


def content_windows(beats, dur):
    """[(t0, t1)] recording seconds where a result must be on screen: from a result beat until a beat
    that changes the page (camera-only beats inherit)."""
    out, cur = [], None
    for b in sorted(beats or [], key=lambda b: b["at"]):
        c = b.get("content")
        if c is True and cur is None:
            cur = float(b["at"])
        elif c is False and cur is not None:
            out.append((cur, float(b["at"])))
            cur = None
    if cur is not None:
        out.append((cur, dur))
    return out


# ───────────────────────────── scores ─────────────────────────────

D1_CHECKS = ("delivered", "must", "typed", "brand", "no_challenge")
D2_CHECKS = ("on_word", "nav_on_word")


def scores(qa_content, lost_beats=0):
    """Rubric D1 (content match) and D2 (sync) from a qa_content.py result; every planned beat lost to
    salvage counts as a D1 fail (rubric D1: dropped planned screencast seconds count as fails)."""
    allc = [c for v in (qa_content or {}).get("segments", {}).values() for c in v]
    d1 = [c for c in allc if c.get("check") in D1_CHECKS]
    d2 = [c for c in allc if c.get("check") in D2_CHECKS]
    n1 = len(d1) + lost_beats
    p1 = sum(1 for c in d1 if c.get("ok"))
    late = sum(1 for c in d2 if c.get("check") == "on_word" and (c.get("late_s") is None or c["late_s"] > 2.0))
    s1 = round(100.0 * p1 / n1, 1) if n1 else None
    s2 = round(max(0.0, 100.0 * sum(1 for c in d2 if c.get("ok")) / len(d2) - 10 * late), 1) if d2 else None
    return {"D1": s1, "D2": s2, "d1_checks": n1, "d1_failed": n1 - p1, "d2_checks": len(d2),
            "d2_failed": sum(1 for c in d2 if not c.get("ok"))}
