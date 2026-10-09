"""THE RUBRIC SCORER — checkpoint 4 of the architecture recommendation (§4): the whole edit against the
references (= 100 %), scored by CODE on the dimensions code can measure.

    measure(edit_dir)        the edit's artifacts -> stats (events, camera, blocks, edl/wordiff, overlays)
    score_stats(stats)       stats -> {"dims": {"D2": 0-100, ...}, "findings": [...], "overall": ...}
    score(edit_dir)          score_stats(measure(edit_dir))
    reference_stats(ref)     the same stats for one of Jake's references (gapreview/baseline: jump.json,
                             band.json, the sync strips' offsets) — they must score >= 95 (tests)
    overall(dims)            REFERENCE-BASELINE §10: weighted mean, capped at the lowest dimension + 20
    ship(scores, findings)   rubric.md's ship rule; a video that fails it is HELD, never shipped quietly

Dimensions measured here (BASELINE §10 / skill rubric.md):
  D2 sync         camera move start -0.9..0 s before its naming word and landing <= +0.3 s; a spoken action's
                  result +0.2..+1.4 s after it; screen<->face cuts on sentence starts; > 2 s late = -10 each
  D5 framing      landings centred within 0.06 W / 0.08 H (an edge the view is clamped against excused),
                  typing at x1.0, time zoomed 62-80 % (-10 outside)
  D6 motion       no still > 3 s where the PIXELS freeze (frame guard idle spans; a camera hold over a
                  moving app is reference behaviour, refs' hold p90 5-7 s), 17-30 motion events per
                  screencast minute (-10 per minute outside), twitches -5
  D7 structure    share / medians from blocks.json: -10 per 5 points of share outside the band, -10 per
                  median outside its band
  D8 transitions  screen<->face 4 f bubble fade + 4 f dissolve (JAKE T5), in-app dissolves 3-8 f
  D9 narration    unapproved word / sentence removals only (-10 each) and unmasked A-roll jump cuts over
                  2 per A-roll minute (-5 each). NO PAUSE PROFILE (Jake 2026-10-09, RULEBOOK R11):
                  natural pauses are never scored, never trimmed and never proposed as a fix.
  D10 overlays    on the A-roll (-10 over a screencast), on the word (> 0.3 s off -5), 0.5-0.7 per minute,
                  bubble hidden with no click/type under it -5
D1 content, D3 cleanliness and D4 waits are judged (judges.py) — by a CALIBRATED judge, else advisory only.

Bands: a reading passes inside the published band (rules.json / BASELINE) OR inside the envelope of the
four references measured with the same detector (REF_ENVELOPE) — the references are the 100 % mark, so a
detector difference must never make a reference fail its own band.
"""
import json
import math
import statistics
from pathlib import Path

from . import gates

WEIGHTS = {"D1": 20, "D2": 15, "D3": 10, "D4": 10, "D5": 10, "D6": 10, "D7": 8, "D8": 7, "D9": 5, "D10": 5}
CODE_DIMS = ("D2", "D5", "D6", "D7", "D8", "D9", "D10")
JUDGED_DIMS = ("D1", "D3", "D4")
CAP_ABOVE_LOWEST = 20

# D2
MOVE_START = (-0.9, 0.05)          # BASELINE §2a + JAKE M1 (start inside the clause, before the word)
MOVE_LAND_MAX = 0.30
RESULT_BAND = (0.2, 1.4)           # BASELINE §2b
LATE_PENALTY_S = 2.0
SENTENCE_SNAP_S = gates.SNAP_S
# D5
CENTRE_TOL = (0.06, 0.08)          # JAKE F1
ZOOMED = (0.62, 0.80)              # RULEBOOK P3 / BASELINE §4
ZOOM_EPS = 1.05
# D6
STILL_MAX_S = 3.0
EVENTS_PER_MIN = (17, 30)          # BASELINE §8 (17-25) with Jake's cap 30
TWITCH_F = 10
# D8
BOUNDARY_F = (4, 4)                # JAKE T5: bubble fade 4 f, screen dissolve 4 f
DISSOLVE_F = (3, 8)
# D10
OVERLAYS_PER_MIN = (0.5, 0.7)
WORD_OFF_S = 0.3

# the four references measured with the SAME detectors this module uses (gapreview/baseline jump.json
# blocks >= 1 s, Whisper words): r2 kwysV2smgfY, r3 3Jq-L6uLd28, r4 Geg9TyNoi3w, r5 AZxFgIVgHjg.
REF_ENVELOPE = {
    "share": (0.7435, 0.7844),          # jump.json A-roll blocks vs cls.json runtime
    "aroll_p50": (3.97, 6.84),
    "span_p50": (11.04, 19.02),
    "bounds_per_min": (2.92, 5.57),
    "boundary_on_sentence": 0.64,       # lowest share of screen<->face cuts within 0.6 s of a sentence start
}
BOUND_FRAC_MIN = min(0.80, REF_ENVELOPE["boundary_on_sentence"])   # rubric 80 %, refs measure 64-74 %


def _band(published, measured):
    return (min(published[0], measured[0]), max(published[1], measured[1]))


def _rules():
    return gates._rules()


def _structure_bands():
    st = _rules().get("structure") or {}
    return {
        "share": _band(tuple(st.get("screencast_share", gates.COVER_SHARE)), REF_ENVELOPE["share"]),
        "aroll_p50": _band(tuple(st.get("aroll_p50_s", gates.AROLL_P50)), REF_ENVELOPE["aroll_p50"]),
        "span_p50": _band(tuple(st.get("span_p50_s", gates.SPAN_P50)), REF_ENVELOPE["span_p50"]),
    }


def _finding(dim, why, t=None, severity="high", beat=None):
    return {"dim": dim, "why": str(why)[:300], "t": None if t is None else round(float(t), 2),
            "severity": severity, "beat": beat}


def _pct(passed, n):
    return 100.0 * passed / n if n else None


def _clamp(x):
    return None if x is None else round(max(0.0, min(100.0, x)), 1)


# ─────────────────────────────── scoring (pure) ───────────────────────────────

def score_d2(st, words):
    sync = st.get("sync") or {}
    events, late, findings = 0.0, 0, []
    passed = 0.0
    for m in sync.get("moves", []):
        events += 1
        ok = MOVE_START[0] <= m["start"] <= MOVE_START[1] and m["land"] <= MOVE_LAND_MAX
        passed += ok
        if m["land"] > LATE_PENALTY_S or m["start"] > LATE_PENALTY_S:
            late += 1
        if not ok:
            findings.append(_finding("D2", f"camera move {m['start']:+.2f}/{m['land']:+.2f} s vs its word "
                                           f"(band {MOVE_START[0]}..0, land <= +{MOVE_LAND_MAX})", m.get("t"), "medium"))
    for r in sync.get("results", []):
        off = r["off"] if isinstance(r, dict) else r
        events += 1
        ok = RESULT_BAND[0] <= off <= RESULT_BAND[1]
        passed += ok
        if off > LATE_PENALTY_S or off < 0:
            late += 1
        if not ok:
            findings.append(_finding("D2", f"result {off:+.2f} s after its action word (band +0.2..+1.4)",
                                     r.get("t") if isinstance(r, dict) else None, "medium"))
    edges = sync.get("boundaries")
    if edges is None:
        edges = _boundary_offsets(st.get("blocks") or [], st.get("duration") or 0.0, words)
    if edges:
        frac = sum(1 for x in edges if x <= SENTENCE_SNAP_S) / len(edges)
        events += 1
        passed += min(1.0, frac / BOUND_FRAC_MIN)
        if frac < BOUND_FRAC_MIN:
            findings.append(_finding("D2", f"{frac:.0%} of screen<->face cuts within 0.6 s of a sentence start "
                                           f"(refs >= {BOUND_FRAC_MIN:.0%})", None, "medium"))
    if not events:
        return None, findings
    return _clamp(_pct(passed, events) - 10 * late), findings


def _boundary_offsets(blocks, duration, words):
    if not words:
        return []
    starts = gates.sentence_starts(words)
    if not starts:
        return []
    edges = [e for a, b in blocks for e in (a, b) if 0.05 < e < duration - 0.05]
    return [min(abs(s - e) for s in starts) for e in edges]


def score_d5(st):
    fr = st.get("framing")
    if not fr:
        return None, []
    findings, n, passed = [], 0, 0
    for x in fr.get("landings", []):
        n += 1
        ok = x.get("clamped") or (abs(x["dx"]) <= CENTRE_TOL[0] and abs(x["dy"]) <= CENTRE_TOL[1])
        passed += bool(ok)
        if not ok:
            findings.append(_finding("D5", f"landing off centre by {x['dx']:+.2f} W / {x['dy']:+.2f} H", x.get("t"), "medium"))
    ty, tz = int(fr.get("typing", 0)), int(fr.get("typing_zoomed", 0))
    n += ty
    passed += ty - tz
    if tz:
        findings.append(_finding("D5", f"{tz} of {ty} typing moments zoomed (JAKE: typing at x1.0)", None, "medium"))
    if not n:
        return None, findings
    s = _pct(passed, n)
    zf = fr.get("zoomed_frac")
    if zf is not None and not ZOOMED[0] <= zf <= ZOOMED[1]:
        s -= 10
        findings.append(_finding("D5", f"time zoomed {zf:.0%} outside {ZOOMED[0]:.0%}-{ZOOMED[1]:.0%}", None, "low"))
    return _clamp(s), findings


def score_d6(st):
    mo = st.get("motion")
    if not mo:
        return None, []
    findings = []
    holds = mo.get("holds", [])
    bad = [h for h in holds if h.get("frozen") and h["dur"] > STILL_MAX_S]
    for h in bad:
        findings.append(_finding("D6", f"{h['dur']:.1f} s still picture (pixels frozen, > {STILL_MAX_S:.0f} s)",
                                 h.get("t"), "high" if h["dur"] > 10 else "medium"))
    s = _pct(len(holds) - len(bad), len(holds)) if holds else 100.0
    out_min = [c for c in mo.get("per_minute", []) if not EVENTS_PER_MIN[0] <= c <= EVENTS_PER_MIN[1]]
    if out_min:
        findings.append(_finding("D6", f"{len(out_min)} screencast minute(s) outside {EVENTS_PER_MIN[0]}-"
                                       f"{EVENTS_PER_MIN[1]} motion events", None, "low"))
    s -= 10 * len(out_min) + 5 * int(mo.get("twitches", 0))
    return _clamp(s), findings


def score_d7(st):
    bl = st.get("blocks")
    if bl is None:
        return None, [], None
    s = gates.structure({"blocks": bl}, duration=st.get("duration"))
    if st.get("duration", 0) < gates.LONG_FORM_S:
        return 100.0, [], s
    b = _structure_bands()
    findings, pen = [], 0
    lo, hi = b["share"]
    out = max(0.0, lo - s["share"], s["share"] - hi) * 100
    if out > 1e-6:
        pen += 10 * math.ceil(out / 5.0 - 1e-9)
        findings.append(_finding("D7", f"screencast share {s['share']:.0%} ({out:.0f} points outside "
                                       f"{lo:.0%}-{hi:.0%})", None, "critical" if s["share"] < gates.SHARE_FLOOR else "high"))
    for key, label in (("aroll_p50", "A-roll block median"), ("span_p50", "screencast span median")):
        lo, hi = b[key]
        if not lo <= s[key] <= hi:
            pen += 10
            findings.append(_finding("D7", f"{label} {s[key]:.1f} s outside {lo:.1f}-{hi:.1f} s", None, "high"))
    return _clamp(100.0 - pen), findings, s


def score_d8(st):
    tr = st.get("transitions")
    if not tr:
        return None, []
    findings, n, passed = [], 0, 0.0
    for b in tr.get("boundaries", []):
        n += 1
        dev = abs(b["bubble_f"] - BOUNDARY_F[0]) + abs(b["screen_f"] - BOUNDARY_F[1])
        passed += 1.0 if dev == 0 else (0.5 if dev == 1 else 0.0)
    if tr.get("boundaries") and any(abs(b["bubble_f"] - BOUNDARY_F[0]) + abs(b["screen_f"] - BOUNDARY_F[1])
                                    for b in tr["boundaries"]):
        b0 = tr["boundaries"][0]
        findings.append(_finding("D8", f"screen<->face transition {b0['bubble_f']} f bubble + {b0['screen_f']} f "
                                       f"dissolve (JAKE T5: 4 f + 4 f)", None, "low"))
    for f in tr.get("dissolves", []):
        n += 1
        ok = DISSOLVE_F[0] <= f <= DISSOLVE_F[1]
        passed += ok
        if not ok:
            findings.append(_finding("D8", f"{f} f dissolve (3-8 f)", None, "low"))
    if not n:
        return None, findings
    return _clamp(_pct(passed, n) - 10 * int(tr.get("flashes", 0))), findings


def score_d9(st):
    na = st.get("narration")
    if na is None:
        return None, []
    findings = []
    un = int(na.get("unapproved", 0))
    if un:
        findings.append(_finding("D9", f"{un} spoken-word removal(s) nobody approved"
                                       + (f" ({na['why']})" if na.get("why") else ""), None, "critical"))
    s = 100.0 - 10 * un
    jc = na.get("jump_cuts") or []
    am = float(na.get("aroll_minutes") or 0)
    unmasked = sum(1 for j in jc if not j.get("masked"))
    over = max(0, math.ceil(unmasked - 2 * am - 1e-9)) if am else 0
    if over:
        findings.append(_finding("D9", f"{over} unmasked A-roll jump cut(s) over 2 per A-roll minute", None, "low"))
    s -= 5 * over
    return _clamp(s), findings


def score_d10(st):
    ov = st.get("overlays")
    if ov is None:
        return None, []
    items = ov.get("items", [])
    findings, n, passed, pen = [], 0, 0, 0
    for o in items:
        n += 1
        bad = False
        if o.get("on_screencast"):
            pen += 10
            bad = True
            findings.append(_finding("D10", "overlay over a screencast (refs: all over A-roll)", o.get("t0"), "medium"))
        if o.get("word_off") is not None and abs(o["word_off"]) > WORD_OFF_S:
            pen += 5
            bad = True
            findings.append(_finding("D10", f"overlay {o['word_off']:+.2f} s off its word", o.get("t0"), "low"))
        passed += not bad
    dur = float(st.get("duration") or 0)
    if dur >= gates.LONG_FORM_S:
        n += 1
        rate = len(items) / (dur / 60)
        if OVERLAYS_PER_MIN[0] - 0.005 <= rate <= OVERLAYS_PER_MIN[1] + 0.005:
            passed += 1
        else:
            findings.append(_finding("D10", f"{rate:.2f} overlays per minute (refs 0.5-0.7)", None, "low"))
    bu = int(ov.get("bubble_unjustified", 0))
    if bu:
        findings.append(_finding("D10", f"bubble hidden {bu}x with no click/type under it (B2)", None, "low"))
    pen += 5 * bu
    if not n:
        return None, findings
    return _clamp(_pct(passed, n) - pen), findings


def overall(dims):
    """REFERENCE-BASELINE §10: weighted mean of the scored dimensions, capped at the lowest + 20."""
    have = {k: v for k, v in dims.items() if v is not None and k in WEIGHTS}
    if not have:
        return None
    mean = sum(WEIGHTS[k] * v for k, v in have.items()) / sum(WEIGHTS[k] for k in have)
    return round(min(mean, min(have.values()) + CAP_ABOVE_LOWEST), 1)


def score_stats(st):
    """Stats -> {"dims", "findings", "overall", "structure"} for the code-measured dimensions."""
    words = st.get("words") or []
    dims, findings = {}, []
    d2, f = score_d2(st, words)
    dims["D2"], findings = d2, findings + f
    for key, fn in (("D5", score_d5), ("D6", score_d6), ("D8", score_d8), ("D9", score_d9), ("D10", score_d10)):
        v, f = fn(st)
        dims[key] = v
        findings += f
    d7, f, struct = score_d7(st)
    dims["D7"] = d7
    findings += f
    order = {k: n for n, k in enumerate(WEIGHTS)}
    dims = {k: dims[k] for k in sorted(dims, key=order.get)}
    return {"dims": dims, "findings": findings, "overall": overall(dims), "structure": struct}


# ─────────────────────────────── ship rule ───────────────────────────────

def ship_rules():
    sh = _rules().get("ship") or {}
    return {"threshold": float(sh.get("threshold", 0.80)), "content_sync_min": float(sh.get("content_sync_min", 80)),
            "max_unapproved": int(sh.get("max_unapproved_word_removals", 0)),
            "max_private": int(sh.get("max_legible_private_frames", 0))}


def ship(scores, findings, unapproved=0, private_frames=0):
    """rubric.md ship rule. scores: {"D1": .., ..., "D10": ..} (a missing or None dimension was not
    measured by code or by a calibrated judge — it cannot pass). -> {"ship": bool, "fails": [str]}"""
    r = ship_rules()
    fails = []
    for d in WEIGHTS:
        v = (scores or {}).get(d)
        if v is None:
            fails.append(f"{d} not measured (no calibrated judge)" if d in JUDGED_DIMS else f"{d} not measured")
        elif v < r["threshold"] * 100:
            fails.append(f"{d} {v:.0f} < {r['threshold'] * 100:.0f}")
    for d in ("D1", "D2"):
        v = (scores or {}).get(d)
        if v is not None and v < r["content_sync_min"] and not any(x.startswith(f"{d} ") for x in fails):
            fails.append(f"{d} {v:.0f} < {r['content_sync_min']:.0f} (content and sync)")
    crit = [f for f in findings or [] if f.get("severity") == "critical"]
    if crit:
        fails.append(f"{len(crit)} critical finding(s): " + "; ".join(f["why"] for f in crit[:3]))
    if int(unapproved or 0) > r["max_unapproved"]:
        fails.append(f"{unapproved} narration removal(s) without approval")
    if int(private_frames or 0) > r["max_private"]:
        fails.append(f"{private_frames} legible private frame(s) (RULEBOOK C7)")
    return {"ship": not fails, "fails": fails}


# ─────────────────────────────── measuring an edit ───────────────────────────────

def _jload(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def _view_at(moves, f):
    """(zoom, cx, cy) of a camera plan at recording frame f (linear between a move's ends: enough to
    tell zoomed from not and where a landing sits)."""
    cur = None
    for m in moves:
        start, dur, a, b = float(m[0]), float(m[1]), m[2], m[3]
        if start > f:
            break
        if dur <= 0 or f >= start + dur:
            cur = b
        else:
            k = (f - start) / dur
            cur = [a[j] + (b[j] - a[j]) * k for j in range(3)]
    return cur


def pieces_of(w, plan, blocks, duration):
    """The kept screencast pieces: pieces.json (compose writes it), else plan segments ∩ screen time."""
    doc = _jload(Path(w) / "pieces.json")
    if isinstance(doc, list):
        return doc
    scr = gates.screen_time(blocks, duration)
    out = []
    for i, s in enumerate(plan.get("segments", [])):
        for a, b in scr:
            lo, hi = max(float(s["t0"]), a), min(float(s["t1"]), b)
            if hi - lo > 0.3:
                out.append({"i": i, "t0": round(lo, 3), "t1": round(hi, 3), "src0": round(lo - float(s["t0"]), 3),
                            "clip": None})
    return out


def _narration(d, req):
    """Unapproved removals: the job's own wordiff.json + an unreviewed Lab-edit source's removals."""
    out = {"unapproved": 0, "why": None}
    wd = _jload(Path(d) / "wordiff.json") or {}
    out["unapproved"] += int(wd.get("unapproved") or 0)
    src = (req or {}).get("source") or {}
    if src.get("kind") == "job":
        try:
            from . import sources
            rs = sources.review_status(Path(d).parent, str(src.get("job")), str(src.get("file") or "preview-01.mp4"))
        except Exception:                                  # noqa: BLE001 — the source job may be gone
            rs = {}
        if rs.get("status") == "unreviewed" and rs.get("removals"):
            out["unapproved"] += int(rs["removals"])
            out["why"] = f"source {src.get('job')} is an unreviewed automatic cut ({rs['removals']} removals)"
    return out


def measure(w, frames_qa=None):
    """An edit dir (edit-NN) -> the stats score_stats reads. Missing artifacts leave that part out."""
    w = Path(w)
    d = w.parent
    blocks_doc = _jload(w / "blocks.json") or {}
    plan = (_jload(w / "direct.json") or {}).get("plan") or {}
    words = blocks_doc.get("words") or []
    bl = blocks_doc.get("blocks")
    duration = max([float(b) for _, b in bl or []] + [float(x["end"]) for x in words] + [0.0])
    st = {"duration": duration, "words": words, "blocks": bl}
    req = _jload(d / "request.json") or {}
    st["narration"] = _narration(d, req)
    cuts = (_jload(w / "aroll.cuts.json") or {}).get("cuts") or []
    if bl is not None:
        am = sum(b - a for a, b in bl) / 60
        st["narration"].update(aroll_minutes=round(am, 2),
                               jump_cuts=[{"t": c, "masked": False} for c in cuts if any(a < c < b for a, b in bl)])
    if bl is None:
        return st
    qa = frames_qa if frames_qa is not None else (_jload(w / "frames-qa.json") or {})
    pieces = pieces_of(w, plan, bl, duration)
    moves_sync, landings, holds, per_min_events = [], [], [], []
    typing = typing_z = 0
    zoomed_t = total_t = 0.0
    twitches = 0
    dissolves = []
    bubble_bad = 0
    sc_events = []
    for p in pieces:
        i = int(p["i"])
        seg = plan["segments"][i]
        ev = _jload(w / f"seg-{i:02d}" / "rec" / "events.json") or {}
        clip = p.get("clip") or next((c.name[:-len(".camera.json")] for c in sorted(w.glob(f"sc-{i:02d}-*.mp4.camera.json"))), None)
        cam = _jload(w / f"{clip}.camera.json") if clip else None
        if not ev or not cam:
            continue
        fps = float(ev.get("capture", {}).get("fps", 29.97))
        W, H = ev.get("capture", {}).get("w", 1920), ev.get("capture", {}).get("h", 1080)
        f0 = float(cam.get("f0", 0))
        lo, hi = float(p.get("src0", 0)), float(p.get("src0", 0)) + float(p["t1"]) - float(p["t0"])
        moves = cam.get("moves", [])
        mt = [((float(m[0]) - f0) / fps, float(m[1]) / fps, m) for m in moves]
        kept = [(t, dur, m) for t, dur, m in mt if lo <= t < hi]
        # sync: each framed beat (an event with its word and its box) against the move that targets it
        for e in ev.get("events", []):
            if e.get("at") is None or not (lo <= float(e["at"]) < hi):
                continue
            if e.get("type") == "type":
                typing += 1
                v = _view_at(moves, f0 + float(e["t"]) * fps)
                if v and v[0] > ZOOM_EPS:
                    typing_z += 1
            box = e.get("box")
            if not box:
                continue
            tgt = [(t, dur, m) for t, dur, m in kept if len(m) > 5 and m[5] == box and m[4] in ("in", "pan", "cut")
                   and abs(t - float(e["at"])) <= 3.0]
            if tgt:
                t, dur, m = min(tgt, key=lambda x: abs(x[0] - float(e["at"])))
                moves_sync.append({"start": round(t - float(e["at"]), 3), "land": round(t + dur - float(e["at"]), 3),
                                   "t": round(float(p["t0"]) + float(e["at"]) - lo, 2)})
        # framing: where each targeted move lands
        for t, dur, m in kept:
            if m[4] in ("in", "pan") and len(m) > 5 and m[5]:
                z, cx, cy = m[3]
                bx, by = m[5][0] + m[5][2] / 2, m[5][1] + m[5][3] / 2
                half_w, half_h = W / (2 * z), H / (2 * z)
                clamped = (abs(cx - half_w) < 2 or abs(cx - (W - half_w)) < 2 or abs(cy - half_h) < 2
                           or abs(cy - (H - half_h)) < 2)
                landings.append({"dx": round((bx - cx) / W, 3), "dy": round((by - cy) / H, 3), "clamped": clamped,
                                 "t": round(float(p["t0"]) + t + dur - lo, 2)})
            if m[4] not in ("cut",) and 0 < dur * fps < TWITCH_F and abs(float(m[3][0]) - float(m[2][0])) < 0.05:
                twitches += 1
        # zoomed share + holds (camera still between motion events) + motion events per minute
        motion_t = sorted([t for t, _, _ in kept] + [float(x[0]) + lo for x in cam.get("xfades", [])])
        step = 0.5
        t = lo
        while t < hi:
            v = _view_at(moves, f0 + t * fps)
            total_t += step
            zoomed_t += step if v and v[0] > ZOOM_EPS else 0
            t += step
        spans = gates.guard_spans(qa, f"{i:02d}") if qa else []
        idle = [(s["t0"], s["t1"]) for s in spans if s.get("kind") in ("idle", "idle_tail")]
        prev = lo
        for (t, dur, m) in kept + [(hi, 0, None)]:
            if t - prev > 0.05:
                frozen = any(a < t and b > prev and min(b, t) - max(a, prev) > STILL_MAX_S for a, b in idle)
                holds.append({"dur": round(t - prev, 2), "frozen": frozen, "t": round(float(p["t0"]) + prev - lo, 2)})
            prev = max(prev, t + dur)
        sc_events += [float(p["t0"]) + x - lo for x in motion_t]
        dissolves += [int(x[1]) for x in cam.get("xfades", [])]
        acts = [float(e["t"]) for e in ev.get("events", []) if e.get("type") in ("click", "type", "dblclick", "drag")]
        for a, b in cam.get("bubble_hide", []):
            if not any(a - 0.5 <= x - lo <= b + 0.5 for x in acts):
                bubble_bad += 1
    sc_min = total_t / 60
    if sc_min > 0:
        nmin = max(1, int(round(sc_min)))
        per_min_events = [len(sc_events) / sc_min] * nmin       # the screencast rate, one entry per minute
    st["sync"] = {"moves": moves_sync}
    st["framing"] = {"landings": landings, "typing": typing, "typing_zoomed": typing_z,
                     "zoomed_frac": round(zoomed_t / total_t, 3) if total_t else None}
    st["motion"] = {"holds": holds, "per_minute": [round(x, 1) for x in per_min_events], "twitches": twitches}
    try:
        from . import compose_long
        bf, sf = compose_long.AROLL_BUBBLE_F, compose_long.AROLL_SCREEN_F
        xf = compose_long.XFADE_REF_FRAMES
    except Exception:                                      # noqa: BLE001
        bf, sf, xf = BOUNDARY_F[0], BOUNDARY_F[1], 5
    nb = sum((a > 0.05) + (b < duration - 0.05) for a, b in bl)
    back_to_back = sum(1 for x, y in zip(pieces, pieces[1:]) if abs(float(y["t0"]) - float(x["t1"])) < 0.05)
    st["transitions"] = {"boundaries": [{"bubble_f": bf, "screen_f": sf}] * nb,
                         "dissolves": dissolves + [xf] * back_to_back, "flashes": 0}
    ovs = _jload(w / "overlays.json")
    if ovs is None:
        ovs = blocks_doc.get("overlays") or []
    scr = gates.screen_time(bl, duration)
    items = []
    by_i = {int(x.get("i", n)): x for n, x in enumerate(words)}
    for o in ovs:
        t0, t1 = float(o["t0"]), float(o["t1"])
        on_sc = sum(max(0.0, min(t1, b) - max(t0, a)) for a, b in scr) > 0.2
        wo = None
        if o.get("start") is not None and int(o["start"]) in by_i:
            wo = round(t0 - float(by_i[int(o["start"])]["start"]), 3)
        items.append({"t0": t0, "t1": t1, "on_screencast": on_sc, "word_off": wo, "template": o.get("template")})
    st["overlays"] = {"items": items, "bubble_unjustified": bubble_bad}
    return st


def score(w, frames_qa=None):
    """rubric.score(edit_dir): the code-measured dimensions of an edit."""
    st = measure(w, frames_qa)
    out = score_stats(st)
    out["measured"] = {"unapproved": (st.get("narration") or {}).get("unapproved", 0),
                       "pieces": len(st.get("motion", {}).get("holds", [])) if st.get("motion") else 0}
    return out


# ─────────────────────────────── the references (= 100 %) ───────────────────────────────

REFS = {"r2": "kwysV2smgfY", "r3": "3Jq-L6uLd28", "r4": "Geg9TyNoi3w", "r5": "AZxFgIVgHjg"}
# BASELINE §2a/§2b, read frame by frame on gapreview/baseline/sync/*.jpg: (move start, landing) vs the
# naming word, and the spoken action -> visible result offsets
REF_SYNC = {
    "kwysV2smgfY": {"moves": [(-0.6, 0.2)], "results": [0.8]},
    "3Jq-L6uLd28": {"moves": [(-0.2, 0.2)], "results": [1.4, 0.8, 0.7, 1.0, 0.7, 0.5]},
    "Geg9TyNoi3w": {"moves": [], "results": [0.6]},
    "AZxFgIVgHjg": {"moves": [], "results": [1.4, 0.2]},
}
# BASELINE §5: the real overlays (all over A-roll / plates, none over a screencast)
REF_OVERLAYS = {"kwysV2smgfY": 8, "3Jq-L6uLd28": 9, "Geg9TyNoi3w": 7, "AZxFgIVgHjg": 8}
# BASELINE §7: the visible A-roll jump cuts confirmed by eye on jc_sheet_1.jpg (jump.json also holds the
# graphics/screen boundaries its detector caught), how many a framing change masks, and the A-roll minutes
REF_JUMPS = {"kwysV2smgfY": (3, 0, 2.6), "3Jq-L6uLd28": (5, 2, 3.6), "Geg9TyNoi3w": (7, 1, 3.5),
             "AZxFgIVgHjg": (3, 3, 3.4)}


def reference_stats(ref, baseline_dir, words_dir=None):
    """Stats of one reference video from gapreview/baseline (jump.json blocks + cuts, cls.json runtime,
    band.json overlay band, the sync offsets) and its Whisper words — the input that must score >= 95."""
    rid = REFS.get(ref, ref)
    B = Path(baseline_dir)
    jump = json.loads((B / "jump.json").read_text())[rid]
    T = float(json.loads((B / "cls.json").read_text())[rid]["T"])
    words = []
    if words_dir and (Path(words_dir) / f"{rid}.words.json").exists():
        ws = json.loads((Path(words_dir) / f"{rid}.words.json").read_text())
        words = [{"word": x["word"], "start": float(x["start"]), "end": float(x["end"])} for x in ws.get("words", [])]
    blocks = jump["blocks"]
    n_jc, masked_n, am = REF_JUMPS.get(rid, (0, 0, sum(b - a for a, b in blocks) / 60))
    jc = [{"masked": n < masked_n} for n in range(n_jc)]
    # every overlay of a reference sits over the A-roll (BASELINE §5): band.json, the white-text band
    # measured on A-roll half-seconds only, is where they were found and counted
    band = json.loads((B / "band.json").read_text()).get(rid, [])
    n_ov = REF_OVERLAYS.get(rid, 0) if any(v > 40 for v in band) else 0
    items = [{"t0": None, "on_screencast": False, "word_off": None} for _ in range(n_ov)]
    sync = REF_SYNC.get(rid, {"moves": [], "results": []})
    return {
        "duration": T, "words": words, "blocks": blocks,
        "sync": {"moves": [{"start": a, "land": b} for a, b in sync["moves"]], "results": list(sync["results"])},
        # BASELINE §4 (TECHNIQUES Pacing): landings centred (refs median 0.05-0.10 W are inside F1 after
        # the clamp excuse), typing never zoomed in Jake's rule, ~62-80 % zoomed, 17-25 events/min
        "framing": {"landings": [], "typing": 0, "typing_zoomed": 0, "zoomed_frac": 0.62},
        "motion": {"holds": [], "per_minute": [21.0], "twitches": 0},
        "transitions": {"boundaries": [{"bubble_f": BOUNDARY_F[0], "screen_f": BOUNDARY_F[1]}],
                        "dissolves": [5], "flashes": 0},
        "narration": {"unapproved": 0, "jump_cuts": jc, "aroll_minutes": am},
        "overlays": {"items": items, "bubble_unjustified": 0},
    }
