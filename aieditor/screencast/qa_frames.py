"""FRAME GUARD (Jake 2026-10-08/09; extended for gap list G4): what the recorder's live checks miss must
still never reach an edit.

Reads the RECORDED pixels of every screencast segment, every 0.5 s on every frame, and flags:
  * challenge — Cloudflare "Verify you are human" / "Just a moment", captchas, ChatGPT's
                "Unusual activity has been detected from your device", "too many requests"
  * error     — an error line the viewer would read ("Message delivery timed out",
                "Something went wrong", "Try again later", "Unable to load …")
  * account   — a greeting to ANOTHER person than the session's ("How can I help, Keith?" while every
                other greeting says Jake; a Scout profile can hold two accounts) — on ANY frame, not frame 0
  * idle      — the pixels freeze for > 3 s with no agent event (RULEBOOK §4 P1; refs' camera-still p50
                0.77-1.4 s, BASELINE §4); `idle_tail` when it runs to the end (the agent stopped)
  * empty     — an empty canvas/page where the plan's beat expects a result (expect.json "content")
  * garbled   — a field shows text that differs from what was typed (events.json type value != text;
                RULEBOOK §1 C3), for as long as the OCR still reads the stale text
  * privacy   — legible private information (RULEBOOK C7), from p5's screencast/privacy.py when installed

Text is read from the brightest channel (red error text on a dark page is low-contrast in plain gray —
the 1.5 s gray OCR missed "Unusual activity…" at 5:20.7) and a run of hits is widened by one sampling
interval each side, so the span covers every red-text frame.

    python3 qa_frames.py <edit-dir> [--every 0.5] [--only 03,07] [--expect expect.json] [--out frames.json]

Output: {"version": 2, "every_s": 0.5, "account": "Jake",
         "segments": {"03": [{"t": 41.5, "kind": "challenge", "why": "..."}]},          (point hits)
         "spans":    {"03": [{"t0": 41.0, "t1": 42.5, "kind": "challenge", "why": "..."}]},
         "dur":      {"03": 78.9}}
Runs inside aieditor-screencast (tesseract + opencv); decodes each raw.mp4 in this one process.
"""
import argparse
import collections
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import cv2
except ImportError:          # the pattern/span logic is importable (and unit-tested) without OpenCV
    cv2 = None

CHALLENGE = re.compile(r"verify you are human|just a moment\W|attention required|are you a robot|"
                       r"performing security verification|unusual activ\w*\s+has\s+been|"
                       r"activ\w*\s+has\s+been\s+detected\s+from\s+your|has\s+been\s+detected\s+from\s+your\s+dev|"
                       r"too many requests|complete the captcha", re.I)
ERROR = re.compile(r"message delivery timed out|something went wrong|unable to load [a-z ]{0,20}files|"
                   r"network error|an error occurred|try again later|error generating|failed to (?:load|generate)", re.I)
# OCR reads "I" as | l 1 ]: the greeting tolerates it
GREET = re.compile(r"\b(?:Hey|Hi|Hello|Welcome back|How can [I|l1\]!] help(?: you)?(?: today)?|"
                   r"Good (?:morning|afternoon|evening)|Nice to see you|Ready when you are)[,!]?\s+"
                   r"([A-Z][a-z]{2,})\b")
NOT_NAMES = {"Today", "There", "What", "Where", "How", "Ready", "Welcome", "Let", "Here", "The", "This", "Back"}
# agent events that are not activity (a cut is the recorder's own bookkeeping)
QUIET = ("begin", "cut", "end")

FREEZE_FRAC = 0.0015        # < 0.15 % of thumbnail pixels changed by > 10 levels = a frozen frame
IDLE_S = 3.0
FLAT_FRAC = 0.92            # >= 92 % of the central view flat = an empty canvas / page (measured on the failed
                            # job: the never-filled ChatGPT sketch canvas = 0.934; a result photo is < 0.5)
TH_W, TH_H = 320, 180


# ───────────────────────────── pixels ─────────────────────────────

def ocr_ready(img):
    # the brightest channel: red / orange / blue text keeps its contrast (plain gray put red error text
    # 133 vs 235 after the dark-theme inversion and tesseract lost it)
    g = img.max(axis=2)
    if g.mean() < 110:                       # dark theme: tesseract reads dark-on-light far better
        g = 255 - g
    h, w = g.shape
    if w > 1920:
        g = cv2.resize(g, (1920, int(h * 1920 / w)), interpolation=cv2.INTER_AREA)
    return g


def ocr(img, ready=False):
    g = img if ready else ocr_ready(img)
    ok, png = cv2.imencode(".png", g)
    r = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11", "-l", "eng"], input=png.tobytes(),
                       capture_output=True, timeout=120)
    return r.stdout.decode("utf-8", "replace")


def thumb(img):
    return cv2.cvtColor(cv2.resize(img, (TH_W, TH_H), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)


def changed(a, b):
    """Fraction of thumbnail pixels that changed by > 10 levels."""
    return float((cv2.absdiff(a, b) > 10).mean())


def flat_fraction(th):
    """How much of the central view (x 25-75 %, y 12-88 %) is flat (4x4 blocks with std < 2.5)."""
    import numpy as np
    c = th[int(TH_H * 0.12):int(TH_H * 0.88), int(TH_W * 0.25):int(TH_W * 0.75)].astype(np.float32)
    h, w = c.shape[0] // 4 * 4, c.shape[1] // 4 * 4
    blocks = c[:h, :w].reshape(h // 4, 4, w // 4, 4).swapaxes(1, 2).reshape(h // 4, w // 4, 16)
    return float((blocks.std(axis=2) < 2.5).mean())


def frames(video, every):
    """(t, image) every `every` seconds, decoded sequentially (seeking is slow and inexact)."""
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 29.97
    step = max(1, int(round(every * fps)))
    f = 0
    while True:
        if f % step == 0:
            ok, img = cap.read()
            if not ok:
                break
            yield round(f / fps, 2), img
        else:
            if not cap.grab():
                break
        f += 1
    cap.release()


# ───────────────────────────── text rules (pure) ─────────────────────────────

def text_hits(t, txt):
    flat = " ".join(txt.split())
    out = []
    m = CHALLENGE.search(flat)
    if m:
        out.append({"t": t, "kind": "challenge", "why": m.group(0)})
    else:
        m = ERROR.search(flat)
        if m:
            out.append({"t": t, "kind": "error", "why": m.group(0)})
    for g in GREET.finditer(flat):
        if g.group(1) not in NOT_NAMES:
            out.append({"t": t, "kind": "greeting", "who": g.group(1)})
    return out


def hit_spans(hits, every, dur):
    """Runs of point hits of one kind -> spans widened by one sampling interval each side."""
    out = []
    for h in sorted(hits, key=lambda h: h["t"]):
        a, b = max(0.0, h["t"] - every), min(dur, h["t"] + every)
        if out and out[-1]["kind"] == h["kind"] and a <= out[-1]["t1"] + 1e-6:
            out[-1]["t1"] = round(b, 2)
        else:
            out.append({"t0": round(a, 2), "t1": round(b, 2), "kind": h["kind"], "why": h.get("why")})
    return out


def _tokens(s):
    return [x for x in re.sub(r"[^a-z0-9 ]", " ", str(s).lower()).split() if len(x) >= 3]


def garble_signature(value, text):
    """Words a garbled field shows that the typed text does not have ("photTurn", "portraito")."""
    want = set(_tokens(text))
    return [x for x in _tokens(value) if x not in want]


def garbled_spans(events, texts, every, dur):
    """A typed field whose value != the typed text, from its type event until the OCR no longer reads
    the stale words (or the field is typed clean again)."""
    out = []
    types = [e for e in events if e.get("type") == "type" and e.get("value") is not None and e.get("text") is not None]
    for n, e in enumerate(types):
        if " ".join(str(e["value"]).split()) == " ".join(str(e["text"]).split()):
            continue
        sig = garble_signature(e["value"], e["text"])
        if not sig:
            continue
        t0 = float(e["t"])
        nxt = next((float(x["t"]) for x in types[n + 1:] if " ".join(str(x["value"]).split()) == " ".join(str(x["text"]).split())), dur)
        t1 = max(float(e.get("end", t0)), t0 + every)
        for t, txt in texts:
            if t <= t1:
                continue
            if t >= nxt:
                break
            seen = set(_tokens(txt))
            if sum(1 for x in sig if x in seen) * 2 >= len(sig):
                t1 = t + every
            else:
                break
        t1 = min(t1, nxt, dur)
        out.append({"t0": round(t0, 2), "t1": round(t1, 2), "kind": "garbled",
                    "why": f"field shows '{str(e['value'])[:60]}' for '{str(e['text'])[:40]}'"})
    return out


def idle_spans(stills, events, dur, every):
    """stills: [(t, changed_frac)] per sample. A freeze >= 3 s with no agent event inside it."""
    acts = [(float(e["t"]), float(e.get("end", e["t"]))) for e in events if e.get("type") not in QUIET]
    out, run = [], None
    for t, frac in stills:
        if frac < FREEZE_FRAC:
            run = run if run is not None else t - every          # frozen since the previous sample
        else:
            if run is not None and t - every - run >= IDLE_S:
                out.append((run, t - every))
            run = None
    if run is not None and dur - run >= IDLE_S:
        out.append((run, dur))
    res = []
    for a, b in out:
        if any(a < y and x < b for x, y in acts):
            # an agent event inside the freeze: only what follows the last one can be idle
            last = max(y for x, y in acts if a < y and x < b)
            if b - last < IDLE_S:
                continue
            a = last
        tail = dur - b < 1.0
        res.append({"t0": round(a, 2), "t1": round(b, 2), "kind": "idle_tail" if tail else "idle",
                    "why": f"screen frozen {b - a:.1f}s with no agent action"})
    return res


def content_windows(beats, dur):
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


def empty_spans(flats, windows, every):
    """Samples inside a content window whose central view is flat -> spans."""
    out = []
    for t, f in flats:
        if f < FLAT_FRAC or not any(a <= t < b for a, b in windows):
            continue
        if out and t - out[-1]["t1"] <= every + 1e-6:
            out[-1]["t1"] = round(t + every, 2)
        else:
            out.append({"t0": round(t, 2), "t1": round(t + every, 2), "kind": "empty",
                        "why": "empty canvas where the beat expects a result"})
    return out


def merge_kind(spans):
    """Overlapping spans of the SAME kind become one (several stale type events read the same garble)."""
    out = []
    for s in sorted(spans, key=lambda s: (s["kind"], s["t0"])):
        if out and out[-1]["kind"] == s["kind"] and s["t0"] <= out[-1]["t1"] + 1e-6:
            out[-1]["t1"] = max(out[-1]["t1"], s["t1"])
        else:
            out.append(dict(s))
    return sorted(out, key=lambda s: (s["t0"], s["kind"]))


def privacy_spans(seg_dir, every):
    """RULEBOOK C7 (p5 privacy blur): legible private information on the recorded frames is one more
    guard kind. Uses screencast/privacy.py when it is installed — its legible_spans(seg_dir, every) ->
    [{"t0", "t1", "why"}] — and adds nothing otherwise (the guard never fails for a missing module)."""
    try:
        import privacy  # noqa: WPS433 (p5; same directory)
    except ImportError:
        return []
    fn = getattr(privacy, "legible_spans", None)
    if fn is None:
        return []
    try:
        found = fn(seg_dir, every) or []
    except Exception as exc:                               # noqa: BLE001 — a broken check is reported, not hidden
        return [{"t0": 0.0, "t1": 0.0, "kind": "privacy", "why": f"privacy check failed: {exc}"[:200]}]
    return [{"t0": round(float(x["t0"]), 2), "t1": round(float(x["t1"]), 2), "kind": "privacy",
             "why": x.get("why", "legible private information")} for x in found]


# ───────────────────────────── per segment ─────────────────────────────

def scan(seg_dir, every, beats=None):
    """-> (point hits incl. greetings, spans without the account rule, recording length)."""
    sd = Path(seg_dir)
    v = sd / "rec" / "raw.mp4"
    if not v.exists():
        return [], [], 0.0
    try:
        ev = json.loads((sd / "rec" / "events.json").read_text())
    except (OSError, ValueError):
        ev = {}
    events = ev.get("events", [])
    times, stills, flats, prev, futs = [], [], [], None, {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for t, img in frames(v, every):
            th = thumb(img)
            c = 1.0 if prev is None else changed(prev, th)
            stills.append((t, c))
            flats.append((t, flat_fraction(th)))
            times.append(t)
            # an unchanged frame reads the same: reuse the previous OCR (idle stretches cost nothing)
            if c >= FREEZE_FRAC or not futs:
                futs[t] = ex.submit(ocr, ocr_ready(img), True)
                pending = [f for f in futs.values() if not f.done()]
                if len(pending) > 8:                       # bounded memory: ~2 MB per queued frame
                    pending[0].result()
            prev = th
        read = {t: f.result() for t, f in futs.items()}
    dur = max(float(ev.get("end") or 0), (times[-1] + every) if times else 0.0)
    texts, last = [], ""
    for t in times:
        last = read.get(t, last)
        texts.append((t, last))
    hits = [h for t, txt in texts for h in text_hits(t, txt)]
    spans = hit_spans([h for h in hits if h["kind"] in ("challenge", "error")], every, dur)
    spans += idle_spans(stills, events, dur, every)
    spans += empty_spans(flats, content_windows(beats, dur), every)
    spans += garbled_spans(events, texts, every, dur)
    spans += privacy_spans(sd, every)
    return hits, merge_kind(spans), round(dur, 2)


def account_rule(res, every, given=None):
    """Greetings -> 'account' hits/spans for a name that is not the session's."""
    names = collections.Counter(n for hs, _, _ in res.values() for n in {h["who"] for h in hs if h["kind"] == "greeting"})
    account = given or (names.most_common(1)[0][0] if names else None)
    seg_hits, seg_spans = {}, {}
    for k, (hs, spans, dur) in res.items():
        keep = [h for h in hs if h["kind"] != "greeting"]
        foreign = [{"t": h["t"], "kind": "account", "why": f"greeting to {h['who']}, not {account}"}
                   for h in hs if h["kind"] == "greeting" and account and h["who"] != account]
        seg_hits[k] = sorted(keep + foreign, key=lambda h: h["t"])
        seg_spans[k] = sorted(spans + hit_spans(foreign, every, dur), key=lambda s: s["t0"])
    return account, seg_hits, seg_spans


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("edit_dir")
    ap.add_argument("--every", type=float, default=0.5)
    ap.add_argument("--out", default=None, help="write the JSON here (not stdout)")
    ap.add_argument("--account", default=None, help="the session's first name (recorder events.json 'account')")
    ap.add_argument("--only", default=None, help="comma-separated segment numbers (a take's gate)")
    ap.add_argument("--expect", default=None, help="expect.json: per-segment beats with 'content' (result) flags")
    a = ap.parse_args()
    only = {x.zfill(2) for x in a.only.split(",")} if a.only else None
    expect = json.loads(Path(a.expect).read_text()) if a.expect and Path(a.expect).exists() else {}
    segs = sorted(p for p in Path(a.edit_dir).glob("seg-*") if (p / "rec" / "raw.mp4").exists()
                  and (only is None or p.name.split("-")[1] in only))
    res = {s.name.split("-")[1]: scan(s, a.every, expect.get("segments", {}).get(str(int(s.name.split("-")[1])), []))
           for s in segs}
    # the session's account: given, else the name greeted in the MOST SEGMENTS (not frames: one long
    # segment on the wrong account out-counted the right one, 2026-10-09)
    account, hits, spans = account_rule(res, a.every, a.account)
    out = {"version": 2, "segments": hits, "spans": spans, "dur": {k: v[2] for k, v in res.items()},
           "account": account, "every_s": a.every}
    if a.out:
        Path(a.out).write_text(json.dumps(out, indent=1))
    else:
        json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
