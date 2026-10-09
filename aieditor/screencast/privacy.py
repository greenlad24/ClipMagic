"""PRIVACY BLUR (RULEBOOK C7, Jake 2026-10-09 R8): private information never reaches an edit legibly.

    "all private information like emails, passwords, private apis, should be blurred on screen"

Two detectors, one tracked blur, one check:
  * DOM   — the recorder samples privacy_dom.mjs every 0.25 s while a segment records:
            rec/privacy.json [{t, boxes: [{x, y, w, h, kind}]}] (events.json time + capture px)
  * OCR   — tesseract over raw.mp4 every 0.5 s: emails, sk-/sk-ant- keys, 32+ char tokens after
            key/token/secret/Bearer, webhook URLs with key paths, phone numbers, Luhn-valid card
            numbers, street addresses, account/invoice IDs. "Jake Dawson" is NOT private (ruled
            2026-10-08); his email address IS.
  * TRACK — DOM + OCR boxes merged by IoU, padded 12 px, held 0.5 s either side, interpolated
            between samples. An OCR hit without a stable box over 2 samples blurs its whole panel
            (else the frame quadrant) and holds the beat (remedy "widen_blur -> cut_beat").
  * APPLY — ffmpeg crop + gblur (sigma >= 20) + overlay with enable windows: raw.mp4 -> raw.blur.mp4,
            BEFORE camera.py, so every later zoom/pan carries the blur (longedit.compose).
  * QA    — legible(video_or_frames) -> hits[]. Any hit on the camera output fails the take
            (p4: take_verdict privacy_out, ship rule "0 legible private frames").

    python3 privacy.py blur <recdir> [--every 0.5] [--frames-dir D]   -> raw.blur.mp4 + privacy.blur.json
    python3 privacy.py scan <recdir> [--every 0.5] [--frames-dir D]   -> hits only (no video written)
    python3 privacy.py legible <video|image...> [--every 0.5] [--out J] [--frames-dir D]

Runs inside aieditor-screencast (tesseract + opencv + ffmpeg). The pure parts (patterns, rows,
tracks, filter graph) import without cv2 so the host test suite checks them.
Matched text is never written out in clear: every report carries a masked form only.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PAD = 12                 # px around every private box
EXTEND_S = 0.5           # held this long before the first / after the last detection
SIGMA = 24               # gblur sigma (>= 20: unreadable at any camera zoom up to x2)
DOM_EVERY = 0.25         # recorder sampling (privacy_dom.mjs)
OCR_EVERY = 0.5
MERGE_IOU = 0.3          # a detection joins a track when its box overlaps the track's last box this much
STABLE_IOU = 0.5         # an OCR box is "stable" when 2 samples in a row overlap this much
GAP_S = 1.0              # a track ends when nothing was seen for this long
MOVE_PX = 24             # a blur window is split when the box moves more than this
MAX_WINDOWS = 120        # filter graph cap: past it, windows of one track merge
REMEDY = "widen_blur -> cut_beat"

# ── patterns ─────────────────────────────────────────────────────────────────────
# OCR reads "@" as "©" or "®" now and then: still an email
EMAIL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._%+\-]*[@©®][A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
API_KEY = re.compile(r"\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|"
                     r"xox[abpr]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}|"
                     r"(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,})")
TOKEN = re.compile(r"(?i)\b(?:api[ _-]?key|key|token|secret|bearer|password|passwd)\b[\s:=\"'`]{0,4}"
                   r"([A-Za-z0-9_\-\.+/=]{32,})")
WEBHOOK = re.compile(r"(?i)(?:https?://)?[A-Za-z0-9.\-]*(?:hook|webhook)[A-Za-z0-9.\-]*\.[a-z]{2,}"
                     r"(?:/[A-Za-z0-9_\-.]+)*?/[A-Za-z0-9_\-]{16,}[^\s]*|"
                     r"(?:https?://)?[A-Za-z0-9.\-]+\.[a-z]{2,}/\S*(?:webhooks?|hooks?)/\S*[A-Za-z0-9_\-]{16,}\S*|"
                     r"https?://\S+[?&](?:key|api_key|apikey|token|access_token|secret|sig|signature)=[^\s&]{8,}")
PHONE = re.compile(r"(?<![\w+])(?:\+\d{1,3}[\s.\-]?(?:\(?\d{1,4}\)?[\s.\-]?){2,5}\d{2,4}|"
                   r"\(\d{3}\)\s?\d{3}[\s.\-]\d{4}|\b\d{3}[.\-]\d{3}[.\-]\d{4}|\b0\d{1,2}[\s\-]\d{3}[\s\-]\d{4})(?![\w])")
CARD = re.compile(r"(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)")
ADDRESS = re.compile(r"\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z'\.]+\s+){1,3}"
                     r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|"
                     r"Terrace|Parkway|Pkwy|Highway|Hwy|Square|Sq|Soi|Alley|Circle|Cir)\b\.?")
ACCOUNT_ID = re.compile(r"(?i)\b(?:account|acct|invoice|inv|customer|billing|order)\b\s*(?:id|no\.?|number|#)?\s*[:#]?\s*"
                        r"([A-Z0-9][A-Z0-9_\-]{4,})")
KINDS = ("email", "api_key", "token", "webhook", "card", "phone", "address", "account_id")


def luhn(digits):
    d = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(d) <= 19:
        return False
    s = 0
    for i, v in enumerate(reversed(d)):
        if i % 2:
            v *= 2
            if v > 9:
                v -= 9
        s += v
    return s % 10 == 0


def mask(s):
    """What a report may show of a matched string: its kind is enough, never the secret."""
    s = str(s)
    return (s[:3] + "…" + f"({len(s)})") if len(s) > 3 else "…"


def find_private(text):
    """[(kind, start, end)] — non-overlapping, the longest/most specific kind wins."""
    out = []

    def add(kind, a, b):
        out.append((kind, a, b))

    for m in EMAIL.finditer(text):
        add("email", m.start(), m.end())
    for m in API_KEY.finditer(text):
        add("api_key", m.start(), m.end())
    for m in TOKEN.finditer(text):
        tok = m.group(1)
        if sum(c.isdigit() for c in tok) >= 2 or tok.startswith(("sk-", "ey")):
            add("token", m.start(1), m.end(1))
    for m in WEBHOOK.finditer(text):
        add("webhook", m.start(), m.end())
    for m in CARD.finditer(text):
        if luhn(m.group(0)):
            add("card", m.start(), m.end())
    for m in PHONE.finditer(text):
        nd = sum(c.isdigit() for c in m.group(0))
        if 8 <= nd <= 15:
            add("phone", m.start(), m.end())
    for m in ADDRESS.finditer(text):
        add("address", m.start(), m.end())
    for m in ACCOUNT_ID.finditer(text):
        if any(c.isdigit() for c in m.group(1)):
            add("account_id", m.start(1), m.end(1))
    # overlaps: a card number is not also a phone number; a key inside a webhook URL is one hit
    pri = {k: i for i, k in enumerate(("api_key", "webhook", "email", "card", "token", "account_id", "phone", "address"))}
    out.sort(key=lambda h: (pri[h[0]], -(h[2] - h[1])))
    keep = []
    for h in out:
        if all(h[2] <= k[1] or h[1] >= k[2] for k in keep):
            keep.append(h)
    return sorted(keep, key=lambda h: h[1])


# ── OCR words -> rows -> hits with boxes ────────────────────────────────────────
def rows(words):
    """Group OCR words [{text, x, y, w, h}] into text lines: same baseline band, small horizontal gaps.
    (tesseract --psm 11 often splits one line into blocks, so its own line ids are not trusted.)"""
    ws = sorted((w for w in words if w["text"].strip()), key=lambda w: w["y"] + w["h"] / 2)
    bands = []                                     # same baseline band
    for w in ws:
        cy = w["y"] + w["h"] / 2
        for b in bands:
            if abs(cy - b["cy"]) <= 0.5 * max(b["h"], w["h"]):
                b["ws"].append(w)
                b["cy"] = sum(x["y"] + x["h"] / 2 for x in b["ws"]) / len(b["ws"])
                b["h"] = max(b["h"], w["h"])
                break
        else:
            bands.append({"cy": cy, "h": w["h"], "ws": [w]})
    lines = []
    for b in bands:                                # split a band where the horizontal gap is large
        cur = []
        for w in sorted(b["ws"], key=lambda w: w["x"]):
            if cur and w["x"] - (cur[-1]["x"] + cur[-1]["w"]) > 2.2 * max(cur[-1]["h"], w["h"]):
                lines.append(cur)
                cur = []
            cur.append(w)
        if cur:
            lines.append(cur)
    return lines


def row_hits(words):
    """Private hits on OCR words: [{kind, text, box: [x, y, w, h]}] (box = union of the matched words)."""
    hits = []
    for ln in rows(words):
        ln.sort(key=lambda w: w["x"])
        text, spans = "", []
        for w in ln:
            if text:
                text += " "
            spans.append((len(text), len(text) + len(w["text"]), w))
            text += w["text"]
        for kind, a, b in find_private(text):
            ws = [w for s, e, w in spans if s < b and e > a]
            if not ws:
                continue
            x0 = min(w["x"] for w in ws)
            y0 = min(w["y"] for w in ws)
            x1 = max(w["x"] + w["w"] for w in ws)
            y1 = max(w["y"] + w["h"] for w in ws)
            hits.append({"kind": kind, "text": mask(text[a:b]), "box": [x0, y0, x1 - x0, y1 - y0]})
    return hits


# ── tracks ───────────────────────────────────────────────────────────────────────
def iou(a, b):
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    u = aw * ah + bw * bh - inter
    return inter / u if u > 0 else 0.0


def contains(outer, inner, slack=4):
    return (outer[0] - slack <= inner[0] and outer[1] - slack <= inner[1]
            and inner[0] + inner[2] <= outer[0] + outer[2] + slack and inner[1] + inner[3] <= outer[1] + outer[3] + slack)


def pad_box(b, W, H, pad=PAD):
    x0 = max(0, b[0] - pad)
    y0 = max(0, b[1] - pad)
    x1 = min(W, b[0] + b[2] + pad)
    y1 = min(H, b[1] + b[3] + pad)
    return [x0, y0, max(0, x1 - x0), max(0, y1 - y0)]


def quadrant(box, W, H):
    """The frame quadrant(s) a box sits in (a box across the middle gets both halves)."""
    cx_, cy_ = W / 2, H / 2
    x0 = 0 if box[0] < cx_ else cx_
    x1 = W if box[0] + box[2] > cx_ else cx_
    y0 = 0 if box[1] < cy_ else cy_
    y1 = H if box[1] + box[3] > cy_ else cy_
    return [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


def detections(dom, ocr):
    """dom: [{t, boxes: [{x, y, w, h, kind}]}], ocr: [{t, hits: [{kind, box}], panel?}] -> flat list."""
    out = []
    for s in dom or []:
        for b in s.get("boxes", []):
            if b.get("w", 0) > 1 and b.get("h", 0) > 1:
                out.append({"t": float(s["t"]), "box": [b["x"], b["y"], b["w"], b["h"]], "kind": b.get("kind", "dom"), "src": "dom"})
    for s in ocr or []:
        for h in s.get("hits", []):
            out.append({"t": float(s["t"]), "box": list(h["box"]), "kind": h["kind"], "src": "ocr",
                        "panel": h.get("panel")})
    return sorted(out, key=lambda d: d["t"])


def build_tracks(dets, ocr_every=OCR_EVERY):
    """Greedy IoU association in time order. A track = {kind, src: {dom, ocr}, pts: [(t, box)]}."""
    tracks = []
    for d in dets:
        best, bi = None, 0.0
        for tr in tracks:
            lt, lb = tr["pts"][-1]
            if d["t"] - lt > GAP_S + 1e-6:
                continue
            v = iou(lb, d["box"])
            if v >= MERGE_IOU and v > bi:
                best, bi = tr, v
        if best is None:
            best = {"kinds": set(), "srcs": set(), "pts": [], "ocr_pts": [], "panels": []}
            tracks.append(best)
        best["kinds"].add(d["kind"])
        best["srcs"].add(d["src"])
        if best["pts"] and abs(best["pts"][-1][0] - d["t"]) < 1e-6:
            # two detections at one sample (a DOM box + its OCR text): one box covering both
            lt, lb = best["pts"][-1]
            best["pts"][-1] = (lt, union(lb, d["box"]))
        else:
            best["pts"].append((d["t"], d["box"]))
        if d["src"] == "ocr":
            best["ocr_pts"].append((d["t"], d["box"]))
            if d.get("panel"):
                best["panels"].append(d["panel"])
    for tr in tracks:
        tr["stable"] = "dom" in tr["srcs"] or stable(tr["ocr_pts"], ocr_every)
    return tracks


def stable(pts, every):
    """2 consecutive OCR samples with overlapping boxes = a box we can trust."""
    for (t0, b0), (t1, b1) in zip(pts, pts[1:]):
        if t1 - t0 <= every * 1.5 + 1e-6 and iou(b0, b1) >= STABLE_IOU:
            return True
    return False


def union(a, b):
    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return [x0, y0, x1 - x0, y1 - y0]


def box_at(pts, t):
    """Linear interpolation of a track's box at t (held flat outside its samples)."""
    if t <= pts[0][0]:
        return list(pts[0][1])
    for (t0, b0), (t1, b1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            u = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return [b0[k] + (b1[k] - b0[k]) * u for k in range(4)]
    return list(pts[-1][1])


def windows(tracks, W, H, every=OCR_EVERY, pad=PAD, extend=EXTEND_S, dur=None):
    """Tracks -> blur windows [{t0, t1, box, kind, widened}] in recording time. A stable track gets
    interpolated, padded boxes; between samples the window box is the union of the interpolated boxes
    (so a moving box is covered all the way). An unstable OCR-only track blurs its panel (or quadrant)."""
    out, held = [], []
    for tr in tracks:
        pts = tr["pts"]
        t0, t1 = pts[0][0] - extend, pts[-1][0] + extend
        if dur is not None:
            t0, t1 = max(0.0, t0), min(dur, t1)
        kind = "/".join(sorted(tr["kinds"]))
        if not tr["stable"]:
            # one look only: we cannot follow it. Blur what holds it, and hold the beat.
            base = pts[0][1]
            panel = next((p for p in tr["panels"] if p and contains(p, base)), None)
            area = panel if panel and panel[2] * panel[3] < 0.5 * W * H else quadrant(base, W, H)
            # an isolated look may have been on screen up to one sample interval earlier/later
            out.append({"t0": max(0.0, t0 - every), "t1": t1 + every if dur is None else min(dur, t1 + every),
                        "box": pad_box(area, W, H, pad), "kind": kind, "widened": "panel" if area is panel else "quadrant"})
            held.append({"t": round(pts[0][0], 2), "kind": kind, "reason": "private text without a stable box",
                         "remedy": REMEDY})
            continue
        # sub-windows: split where the box has moved more than MOVE_PX since the window began
        # (the box is linear between steps, so the union of its two ends covers every frame between them)
        step = min(DOM_EVERY, every) / 2
        t = t0
        cur, cs, ref = None, t0, None
        while t <= t1 + 1e-9:
            b = pad_box(box_at(pts, t), W, H, pad)
            if cur is None:
                cur, cs, ref = b, t, b
            elif max(abs(b[0] - ref[0]), abs(b[1] - ref[1]), abs(b[0] + b[2] - ref[0] - ref[2]),
                     abs(b[1] + b[3] - ref[1] - ref[3])) > MOVE_PX:
                out.append({"t0": cs, "t1": t, "box": union(cur, b), "kind": kind, "widened": None})
                cur, cs, ref = b, t, b
            else:
                cur = union(cur, b)
            t += step
        if cur is not None:
            out.append({"t0": cs, "t1": t1, "box": cur, "kind": kind, "widened": None})
    out = cap_windows(out)
    for w in out:
        w["box"] = int_box(w["box"], W, H)
        w["t0"], w["t1"] = round(w["t0"], 3), round(w["t1"], 3)
    return [w for w in out if w["box"][2] >= 2 and w["box"][3] >= 2 and w["t1"] > w["t0"]], held


def int_box(b, W, H):
    """Whole pixels, outward, inside the frame."""
    x0, y0 = max(0, int(math.floor(b[0]))), max(0, int(math.floor(b[1])))
    x1, y1 = min(W, int(math.ceil(b[0] + b[2]))), min(H, int(math.ceil(b[1] + b[3])))
    return [x0, y0, max(0, x1 - x0), max(0, y1 - y0)]


def cap_windows(ws, cap=MAX_WINDOWS):
    """Past `cap` windows the filter graph gets slow: merge the closest neighbours (union box, union time)."""
    ws = sorted(ws, key=lambda w: w["t0"])
    while len(ws) > cap:
        best, bi = None, None
        for i in range(len(ws) - 1):
            a, b = ws[i], ws[i + 1]
            cost = union(a["box"], b["box"])
            c = cost[2] * cost[3] - a["box"][2] * a["box"][3] - b["box"][2] * b["box"][3] + max(0, b["t0"] - a["t1"]) * 1e5
            if best is None or c < best:
                best, bi = c, i
        a, b = ws[bi], ws[bi + 1]
        ws[bi:bi + 2] = [{"t0": min(a["t0"], b["t0"]), "t1": max(a["t1"], b["t1"]), "box": union(a["box"], b["box"]),
                          "kind": a["kind"] if a["kind"] == b["kind"] else f"{a['kind']}+{b['kind']}",
                          "widened": a["widened"] or b["widened"] or "merged"}]
    return ws


def lanes(wins, grow=2.5):
    """Windows that never overlap in time share one filter branch ("lane"): a branch costs ~1 ms per
    frame whether it is enabled or not (25 branches = 0.7x realtime at 1080p), so the graph has as many
    branches as there are boxes AT ONCE, not boxes in total. A lane's crop has one size (its largest
    window); a window joins a lane only when that size stays within `grow` x its own area."""
    out = []
    for w in sorted(wins, key=lambda w: (w["t0"], w["t1"])):
        a = max(1, w["box"][2] * w["box"][3])
        best = None
        for ln in out:
            if ln["t1"] > w["t0"] + 1e-6:
                continue
            lw, lh = max(ln["w"], w["box"][2]), max(ln["h"], w["box"][3])
            if lw * lh <= grow * min(a, ln["amin"]):
                if best is None or lw * lh < best[1]:
                    best = (ln, lw * lh, lw, lh)
        if best is None:
            out.append({"wins": [w], "t1": w["t1"], "w": w["box"][2], "h": w["box"][3], "amin": a})
        else:
            ln, _, lw, lh = best
            ln["wins"].append(w)
            ln.update(t1=w["t1"], w=lw, h=lh, amin=min(ln["amin"], a))
    return out


def blur_filter(wins, offset=0.0, sigma=SIGMA, size=None):
    """ffmpeg filter graph: per lane crop -> gblur -> overlay; the crop/overlay position follows the lane's
    windows (per-frame expressions) and both are enabled only inside them.
    offset: video seconds of recording t=0 (vrecord's pre-frames). size: (W, H) of the video."""
    if not wins:
        return "[0:v]null[v]"
    W, H = size or (max(w["box"][0] + w["box"][2] for w in wins), max(w["box"][1] + w["box"][3] for w in wins))
    ls = lanes(wins)
    n = len(ls)
    parts = [f"[0:v]split={n + 1}[base]" + "".join(f"[s{i}]" for i in range(n))]
    prev = "base"
    for i, ln in enumerate(ls):
        lw, lh = min(W - W % 2, ln["w"] + ln["w"] % 2), min(H - H % 2, ln["h"] + ln["h"] % 2)   # yuv420p: even
        xs, ys, en = [], [], []
        for w in ln["wins"]:
            x, y, bw, bh = w["box"]
            # the window's box inside the lane-sized crop (centred, kept in frame, even offsets)
            cx = min(max(0, x - (lw - bw) // 2), W - lw)
            cy = min(max(0, y - (lh - bh) // 2), H - lh)
            cx, cy = cx - cx % 2, cy - cy % 2
            span = f"between(t,{w['t0'] + offset:.3f},{w['t1'] + offset:.3f})"
            xs.append((span, cx))
            ys.append((span, cy))
            en.append(span)

        def pick(vals):
            e = str(vals[-1][1])
            for span, v in reversed(vals[:-1]):
                e = f"if({span},{v},{e})"
            return e
        enable = "+".join(en)
        parts.append(f"[s{i}]crop={lw}:{lh}:'{pick(xs)}':'{pick(ys)}',gblur=sigma={sigma}:steps=3:enable='{enable}'[b{i}]")
        out = "v" if i == n - 1 else f"o{i}"
        parts.append(f"[{prev}][b{i}]overlay=x='{pick(xs)}':y='{pick(ys)}':eval=frame:enable='{enable}'[{out}]")
        prev = out
    return ";".join(parts)


def beat_of(events, t):
    """The recorded action a second belongs to: the last action event at or before t."""
    acts = [(i, e) for i, e in enumerate(events or []) if e.get("type") not in ("begin", "error", "cut", "nav", "pan", "end")]
    last = None
    for i, e in acts:
        if float(e.get("t", 0)) <= t + 1e-6:
            last = {"i": i, "type": e.get("type"), "t": round(float(e.get("t", 0)), 2),
                    **({"at": e["at"]} if "at" in e else {})}
    return last


# ── image side (cv2 + tesseract; inside the screencast image) ───────────────────
def _cv2():
    import cv2  # noqa: WPS433 (lazy: the host tests import this module without cv2)
    return cv2


def _tess_words(gray, scale):
    cv2 = _cv2()
    ok, png = cv2.imencode(".png", gray)
    env = dict(os.environ, OMP_THREAD_LIMIT="1")
    r = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11", "-l", "eng", "tsv"], input=png.tobytes(),
                       capture_output=True, timeout=180, env=env)
    words = []
    for line in r.stdout.decode("utf-8", "replace").splitlines()[1:]:
        c = line.split("\t")
        if len(c) < 12 or not c[11].strip():
            continue
        try:
            conf = float(c[10])
        except ValueError:
            continue
        if conf < 0:
            continue
        x, y, w, h = (int(v) for v in c[6:10])
        words.append({"text": c[11].strip(), "x": x / scale, "y": y / scale, "w": w / scale, "h": h / scale, "conf": conf})
    return words


def ocr_words(img, max_w=2560):
    """Word boxes in the image's own pixels. Dark-theme pages are inverted (tesseract reads dark-on-
    light far better, as qa_frames.ocr does); a page that is part dark, part light is read both ways."""
    cv2 = _cv2()
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = g.shape
    scale = 1.0
    if w > max_w:
        scale = max_w / w
        g = cv2.resize(g, (max_w, int(h * scale)), interpolation=cv2.INTER_AREA)
    dark = float((g < 110).mean())
    passes = [255 - g] if g.mean() < 110 else [g]
    if 0.2 < dark < 0.8:
        passes.append(g if passes[0] is not g else 255 - g)
    words = []
    for p in passes:
        words += _tess_words(p, scale)
    return words


def panel_of(img, box):
    """The smallest rectangular panel (an edge-bounded region) that holds the box, or None."""
    cv2 = _cv2()
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    H, W = g.shape
    e = cv2.Canny(g, 30, 90)
    e = cv2.dilate(e, None, iterations=1)
    cnts, _ = cv2.findContours(e, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < box[2] * box[3] * 1.5 or w * h > 0.5 * W * H:
            continue
        if contains([x, y, w, h], box, slack=0):
            if best is None or w * h < best[2] * best[3]:
                best = [x, y, w, h]
    return best


def frame_hits(img, with_panel=False):
    hits = row_hits(ocr_words(img))
    if with_panel:
        for h in hits:
            h["panel"] = panel_of(img, h["box"])
    return hits


def sample(video, every):
    """[(t_video, frame)] every `every` seconds, decoded in one sequential pass."""
    cv2 = _cv2()
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 29.97
    step = max(1, int(round(every * fps)))
    out, f = [], 0
    while True:
        if f % step == 0:
            ok, img = cap.read()
            if not ok:
                break
            out.append((round(f / fps, 3), img))
        else:
            if not cap.grab():
                break
        f += 1
    cap.release()
    return out, fps


def _same(a, b):
    cv2 = _cv2()
    if a is None or b is None or a.shape != b.shape:
        return False
    sa = cv2.resize(a, (320, 180), interpolation=cv2.INTER_AREA)
    sb = cv2.resize(b, (320, 180), interpolation=cv2.INTER_AREA)
    return float(cv2.absdiff(sa, sb).max()) < 6


def scan_frames(shots, with_panel=False, workers=None):
    """[(t, img)] -> [{t, hits}] — a frame identical to the one before reuses its result (a held screen
    is read once)."""
    workers = workers or max(1, (os.cpu_count() or 2))
    uniq, idx, prev = [], [], None
    for t, img in shots:
        if prev is not None and _same(prev, img):
            idx.append(len(uniq) - 1)
        else:
            uniq.append(img)
            idx.append(len(uniq) - 1)
            prev = img
    with ThreadPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(lambda im: frame_hits(im, with_panel), uniq))
    return [{"t": t, "hits": [dict(h) for h in res[k]]} for (t, _), k in zip(shots, idx)]


def legible(video_or_frames, every=OCR_EVERY, max_w=1920, frames_dir=None, label="legible"):
    """QA: private text a viewer could read. A video path is sampled every `every` s at up to 1920 px
    wide (what a viewer sees); a list of images (paths or arrays) is read as is. -> [{t, kind, text, box}]"""
    cv2 = _cv2()
    if isinstance(video_or_frames, (str, Path)) and Path(video_or_frames).suffix.lower() in (".mp4", ".mov", ".mkv", ".webm"):
        shots, _ = sample(video_or_frames, every)
    else:
        items = video_or_frames if isinstance(video_or_frames, (list, tuple)) else [video_or_frames]
        shots = [(float(i), cv2.imread(str(x)) if isinstance(x, (str, Path)) else x) for i, x in enumerate(items)]
    small = []
    for t, img in shots:
        h, w = img.shape[:2]
        if w > max_w:
            img = cv2.resize(img, (max_w, int(h * max_w / w)), interpolation=cv2.INTER_AREA)
        small.append((t, img))
    res = scan_frames(small)
    hits = [{"t": s["t"], **h} for s in res for h in s["hits"]]
    if frames_dir and hits:
        save_hit_frames(small, hits, frames_dir, label)
    return hits


def save_hit_frames(shots, hits, frames_dir, label):
    cv2 = _cv2()
    d = Path(frames_dir)
    d.mkdir(parents=True, exist_ok=True)
    by_t = dict(shots)
    for t in sorted({h["t"] for h in hits}):
        img = by_t[t].copy()
        for h in (h for h in hits if h["t"] == t):
            x, y, w, hh = (int(v) for v in h["box"])
            cv2.rectangle(img, (x - 3, y - 3), (x + w + 3, y + hh + 3), (0, 0, 255), 3)
        cv2.imwrite(str(d / f"{label}-{t:08.2f}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])


# ── the pass over one recording ─────────────────────────────────────────────────
def _probe(raw):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration",
                        "-of", "csv=p=0", str(raw)], capture_output=True, text=True)
    w, h, d = r.stdout.strip().split(",")[:3]
    return int(w), int(h), float(d)


def apply_blur(raw, out, wins, offset=0.0, crf=14, preset="superfast"):
    """raw -> out with every window blurred. No window: out is a hard link (no re-encode)."""
    raw, out = Path(raw), Path(out)
    tmp = out.with_name(out.stem + ".part" + out.suffix)
    if not wins:
        if out.exists():
            out.unlink()
        try:
            os.link(raw, out)
        except OSError:
            shutil.copyfile(raw, out)
        return 0.0
    graph = blur_filter(wins, offset, size=_probe(raw)[:2])
    t = time.time()
    script = out.with_name(out.stem + ".filter.txt")
    script.write_text(graph)
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-filter_complex_script", str(script), "-map", "[v]",
                        "-an", "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
                        "-threads", str(max(2, os.cpu_count() or 2)), str(tmp)], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"blur pass failed: {r.stderr[-600:]}")
    os.replace(tmp, out)
    script.unlink(missing_ok=True)
    return time.time() - t


def run(recdir, every=OCR_EVERY, frames_dir=None, write_video=True, label=None):
    """DOM + OCR -> tracks -> raw.blur.mp4, then the same frames re-read through the blur; whatever is
    still legible is widened to its quadrant (round 2) and, if still legible, its beat is held."""
    recdir = Path(recdir)
    raw = recdir / "raw.mp4"
    ev = json.loads((recdir / "events.json").read_text()) if (recdir / "events.json").exists() else {}
    fps_ev = (ev.get("capture") or {}).get("fps") or 29.97
    offset = (ev.get("pre_frames") or 0) / fps_ev if ev.get("virtual_time") else 0.0
    W, H, dur_v = _probe(raw)
    dur = dur_v - offset
    dom = json.loads((recdir / "privacy.json").read_text()) if (recdir / "privacy.json").exists() else []
    t_start = time.time()
    shots, _ = sample(raw, every)
    shots = [(round(t - offset, 3), img) for t, img in shots]
    ocr = scan_frames(shots, with_panel=True)
    t_ocr = time.time() - t_start
    tracks = build_tracks(detections(dom, ocr), every)
    wins, held = windows(tracks, W, H, every=every, dur=dur)
    label = label or recdir.parent.name
    ocr_hits = [{"t": s["t"], **{k: v for k, v in h.items() if k != "panel"}} for s in ocr for h in s["hits"]]
    if frames_dir and ocr_hits:
        save_hit_frames(shots, ocr_hits, frames_dir, f"{label}-raw")
    doc = {"every_s": every, "offset_s": round(offset, 4), "size": [W, H], "duration_s": round(dur, 3),
           "dom_samples": len(dom), "ocr_samples": len(ocr), "ocr_hits": ocr_hits,
           "tracks": len(tracks), "windows": wins, "held": held, "ocr_s": round(t_ocr, 2)}
    if not write_video:
        return doc
    out = recdir / "raw.blur.mp4"
    doc["blur_s"] = round(apply_blur(raw, out, wins, offset), 2)
    # verification: re-read the sampled seconds that had a hit, now through the blur
    hit_t = sorted({h["t"] for h in ocr_hits})
    residual = verify(out, hit_t, offset)
    if residual:
        # round 2 (remedy "widen_blur"): the quadrant around each residual hit, its whole sample interval
        extra = [{"t0": max(0.0, h["t"] - every - EXTEND_S), "t1": min(dur, h["t"] + every + EXTEND_S),
                  "box": pad_box(quadrant(h["box"], W, H), W, H), "kind": h["kind"], "widened": "quadrant"} for h in residual]
        wins = cap_windows(wins + extra)
        doc["windows"] = wins
        doc["blur_s"] += round(apply_blur(raw, out, wins, offset), 2)
        residual = verify(out, hit_t, offset)
        for h in residual:   # remedy "cut_beat": the blur cannot hold it — never ship it quietly
            held.append({"t": h["t"], "kind": h["kind"], "reason": "still legible after widening", "remedy": "cut_beat"})
    doc["residual"] = residual
    for h in held:
        h["beat"] = beat_of(ev.get("events"), h["t"])
    doc["held"] = held
    doc["ok"] = not residual
    (recdir / "privacy.blur.json").write_text(json.dumps(doc, indent=1))
    return doc


def verify(video, times, offset=0.0):
    """Private hits at the given recording seconds of a (blurred) video."""
    if not times:
        return []
    cv2 = _cv2()
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 29.97
    shots = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round((t + offset) * fps)))
        ok, img = cap.read()
        if ok:
            shots.append((t, img))
    cap.release()
    res = scan_frames(shots)
    return [{"t": s["t"], **{k: v for k, v in h.items() if k != "panel"}} for s in res for h in s["hits"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["blur", "scan", "legible"])
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--every", type=float, default=OCR_EVERY)
    ap.add_argument("--out", default=None)
    ap.add_argument("--frames-dir", default=None)
    a = ap.parse_args()
    if a.cmd in ("blur", "scan"):
        doc = run(a.paths[0], a.every, a.frames_dir, write_video=a.cmd == "blur")
        res = {k: doc[k] for k in ("ok", "ocr_hits", "windows", "held", "residual", "ocr_s", "blur_s", "duration_s") if k in doc}
    else:
        src = a.paths[0] if len(a.paths) == 1 else a.paths
        res = {"hits": legible(src, a.every, frames_dir=a.frames_dir), "every_s": a.every}
    if a.out:
        Path(a.out).write_text(json.dumps(res, indent=1))
    else:
        json.dump(res, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
