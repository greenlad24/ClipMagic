"""A CUT AFTER THE RUN for a graphics-only job — the sequences and the preview only (Jake 2026-10-12: "allow me to cut
sentences/words after the preview or run is done … No need to do reproduction on cuts - only cutting the sequences
and the preview").

Nothing of the package is made again: the A-roll, the graphics, the bubble, the stems and the pictures stay exactly
as built (on the job's whole timeline). A cut is applied to what POINTS at them:

  timeline.xml / timeline.fcpxml   every clip keeps only the frames he kept, rippled together (a clip across a cut
                                   becomes two clips with their own in-points); slot markers move / shrink / go
  screencasts/BRIEF.html, slots.csv, slots.json   the slots' timecodes, beats and words on the cut timeline
  preview-NN.mp4                   the same frames cut out (re-encoded once, on the main box — no server)

Every cut (and Undo) starts from the ORIGINALS kept aside on the first cut (handoff-NN.orig/), so cutting again or
restoring words never degrades anything. The kept ranges are edl.creative_cut's pieces: whole source frames, the
package's own sequence frames (a graphics-only package is built on the job's whole timeline from frame 0).

Pure code + one ffmpeg (Docker) for the preview. Tests: tests/test_handoff.py test_handoff_cut."""
import json
import os
import shutil
import time
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from . import edl, handoff, nlexml, takes

ORIG = "handoff-{k:02d}.orig"
KEEP = ("timeline.xml", "timeline.fcpxml", "screencasts/BRIEF.html", "screencasts/slots.csv", "screencasts/slots.json")


def jload(p, default=None):
    try:
        return json.loads(Path(p).read_text())
    except (OSError, ValueError):
        return default


def jdump(p, obj):
    tmp = Path(str(p) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False))
    os.replace(tmp, p)


# ════════════════════════════ the timeline model back from the Premiere XML ════════════════════════════

def _i(el, tag, default=0):
    x = el.find(tag)
    try:
        return int(float(x.text)) if x is not None and x.text is not None else default
    except ValueError:
        return default


def read_xmeml(text):
    """nlexml.xmeml()'s output → the neutral timeline it was written from (what a cut needs: clips with start /
    frames / in / media_frames / file / alpha / enabled / placement, the tracks in order, the markers)."""
    root = ET.fromstring(text.encode())
    seq = root.find("sequence")
    rate = seq.find("rate")
    tb, ntsc = int(rate.findtext("timebase")), rate.findtext("ntsc") == "TRUE"
    fps_num, fps_den = (tb * 1000, 1001) if ntsc else (tb, 1)
    sc = seq.find("media/video/format/samplecharacteristics")
    W, H = int(sc.findtext("width")), int(sc.findtext("height"))
    tl = {"name": seq.findtext("name") or "", "fps_num": fps_num, "fps_den": fps_den, "width": W, "height": H,
          "frames": int(seq.findtext("duration")), "video": [], "audio": [], "markers": []}
    files = {}

    def clip(ci, kind):
        f = ci.find("file")
        if f is not None and f.find("pathurl") is not None:
            files[f.get("id")] = f
        elif f is not None:
            f = files.get(f.get("id"), f)
        path = unquote(f.findtext("pathurl")) if f is not None and f.findtext("pathurl") else ""
        start, end, cin = _i(ci, "start"), _i(ci, "end"), _i(ci, "in")
        c = {"name": ci.findtext("name") or "", "file": path, "start": start, "frames": end - start, "in": cin,
             "media_frames": _i(ci, "duration", cin + end - start)}
        if ci.findtext("enabled") == "FALSE":
            c["enabled"] = False
        if kind == "video":
            if ci.findtext("alphatype") == "straight":
                c["alpha"] = True
            vs = f.find("media/video/samplecharacteristics") if f is not None else None
            w, h = (_i(vs, "width", W), _i(vs, "height", H)) if vs is not None else (W, H)
            ctr = ci.find("filter/effect/parameter[parameterid='center']/value")
            if ctr is not None:
                x, y = nlexml.from_xmeml_center(float(ctr.findtext("horiz")), float(ctr.findtext("vert")), w, h, W, H)
                c.update(x=round(x), y=round(y), width=w, height=h)
        else:
            c["channels"] = _i(ci, "file/media/audio/channelcount", 2) or 2
        return c

    for n, tr in enumerate(seq.findall("media/video/track")):
        tl["video"].append({"name": f"V{n + 1}", "clips": [clip(ci, "video") for ci in tr.findall("clipitem")]})
    roles = ("dialogue", "music", "effects")
    for n, tr in enumerate(seq.findall("media/audio/track")):
        cs = [clip(ci, "audio") for ci in tr.findall("clipitem")]
        for c in cs:
            c["role"] = roles[n] if n < len(roles) else "effects"
        tl["audio"].append({"name": f"A{n + 1}", "clips": cs})
    for m in seq.findall("marker"):
        a, b = _i(m, "in"), _i(m, "out", -1)
        tl["markers"].append({"frame": a, "frames": (b - a) if b > a else 0, "name": m.findtext("name") or "",
                              "note": m.findtext("comment") or ""})
    return tl


# ════════════════════════════ the cut (pure) ════════════════════════════

def offsets(kept):
    """[(a, b)] old frames → [(a, b, new_a)]."""
    out, t = [], 0
    for a, b in kept:
        out.append((a, b, t))
        t += b - a
    return out


def map_frame(f, kept):
    """An old sequence frame → its frame on the cut timeline, or None when it was cut."""
    for a, b, na in offsets(kept):
        if a <= f < b:
            return na + f - a
    return None


def map_span(f0, n, kept):
    """An old [f0, f0 + n) → (new start, new length) of what is left of it (kept parts become contiguous), or None."""
    parts = [(max(f0, a), min(f0 + n, b), na + max(f0, a) - a) for a, b, na in offsets(kept) if max(f0, a) < min(f0 + n, b)]
    if not parts:
        return None
    return parts[0][2], sum(e - s for s, e, _ in parts)


def cut_clips(clips, kept):
    """Every clip → the pieces of it he kept, each at its new place with its own in-point (rippled)."""
    out = []
    for c in clips:
        s0, n, cin = int(c["start"]), int(c["frames"]), int(c.get("in", 0))
        for a, b, na in offsets(kept):
            s, e = max(s0, a), min(s0 + n, b)
            if s < e:
                out.append({**c, "start": na + s - a, "frames": e - s, "in": cin + s - s0})
    return out


def cut_timeline(tl, kept):
    total = sum(b - a for a, b in kept)
    t2 = {**tl, "frames": total,
          "video": [{**tr, "clips": cut_clips(tr.get("clips") or [], kept)} for tr in tl.get("video") or []],
          "audio": [{**tr, "clips": cut_clips(tr.get("clips") or [], kept)} for tr in tl.get("audio") or []],
          "markers": []}
    for m in tl.get("markers") or []:
        sp = map_span(int(m["frame"]), max(1, int(m.get("frames") or 1)), kept)
        if sp:
            t2["markers"].append({**m, "frame": sp[0], "frames": sp[1] if m.get("frames") else 0})
    return t2


def placeholders_of(tl):
    """The FCPXML twin's disabled placeholder cards on V2 (handoff.timeline_model), from the slot markers."""
    out = []
    for m in tl.get("markers") or []:
        nm = m["name"]
        if not nm.startswith("Screencast "):
            continue
        try:
            n = int(nm.split()[1])
        except (IndexError, ValueError):
            continue
        out.append({"name": f"slot-{n:02d} placeholder", "file": f"screencasts/placeholders/slot-{n:02d}.mp4",
                    "start": int(m["frame"]), "frames": int(m["frames"]), "media_frames": int(m["frames"]), "enabled": False})
    return out


def cut_rows(rows, kept, fps_num, fps_den, words):
    """slots.json rows → the same slots on the cut timeline: times / timecodes / beats moved, the words he kept; a slot
    he cut away entirely goes."""
    tc = lambda f: nlexml.tc_string(int(f), fps_num, fps_den)
    fps = fps_num / fps_den
    out = []
    for r in rows:
        f0, f1 = int(round(r["start_s"] * fps)), int(round(r["end_s"] * fps))
        sp = map_span(f0, max(1, f1 - f0), kept)
        if not sp:
            continue
        a, n = sp
        beats = []
        for b in r.get("beats") or []:
            t = b.get("t")
            if t is not None:
                nf = map_frame(int(round(t * fps)), kept)
                if nf is None:
                    continue
                b = {**b, "t": round(nf / fps, 3), "tc": tc(nf)}
            beats.append(b)
        ws = [w["word"] for w in words if a / fps - 0.05 <= w["start"] < (a + n) / fps]
        out.append({**r, "start_tc": tc(a), "end_tc": tc(a + n), "start_s": round(a / fps, 3), "end_s": round((a + n) / fps, 3),
                    "duration_s": round(n / fps, 2), "beats": beats, "words": " ".join(ws),
                    "steps": [] if r.get("steps") else r.get("steps", [])})
    return out


# ════════════════════════════ the job ════════════════════════════

def kept_ranges(d):
    """plan.edit.json → (kept [(a, b)] in the package's sequence frames, the cut timeline's words, removed word ids),
    or (None, words, []) when there is no cut (the whole timeline)."""
    d = Path(d)
    e = jload(d / "edl.json")
    v = e["videos"][0]
    fps = float(e["fps"])
    total = int(v["frames"])
    words = takes.load_words(d / "words.json")
    by_id = {w["i"]: w for w in words}
    edit = jload(d / "plan.edit.json")
    if not edit:
        return None, v["words"], []
    sents = takes.sentences(words)
    keep = {w["i"] for w in edl.kept_words(takes.validate(edit, sents)["videos"][0], sents)}
    cut = edl.creative_cut(words, by_id, total / fps, fps, [w["i"] for w in words if w["i"] not in keep], v.get("title") or "")
    kept = [(int(p["src_frame"]), min(total, int(p["src_frame"]) + int(p["frames"]))) for p in cut["pieces"]]
    return [(a, b) for a, b in kept if b > a], cut["words"], cut.get("removed") or []


def trim_preview(src, dst, kept, fps, cancelled=lambda: False):
    """The preview with only the kept frames (trim/atrim per range → concat), H.264 + AAC."""
    parts, labels = [], ""
    for n, (a, b) in enumerate(kept):
        parts.append(f"[0:v]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS[v{n}];"
                     f"[0:a]atrim=start={a / fps:.6f}:end={b / fps:.6f},asetpts=PTS-STARTPTS[a{n}]")
        labels += f"[v{n}][a{n}]"
    graph = ";".join(parts) + f";{labels}concat=n={len(kept)}:v=1:a=1[v][a]"
    Path(dst).parent.joinpath("trim-preview.txt").write_text(graph)
    work = Path(dst).parent
    handoff._run(f"ffmpeg -v error -y -i /s/{Path(src).name} -filter_complex_script /w/trim-preview.txt -map [v] -map [a] "
                 f"-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart /w/{Path(dst).name}",
                 [(Path(src).parent, "/s"), (work, "/w")], cancelled)
    (work / "trim-preview.txt").unlink(missing_ok=True)


def run(d, log=print, progress=lambda m, f=None: None, cancelled=lambda: False):
    """Apply plan.edit.json (or its absence: the whole timeline) to every hand-off package of the job → note."""
    d = Path(d)
    e = jload(d / "edl.json")
    fps_num, fps_den = int(e.get("fps_num") or round(float(e["fps"]) * 1000)), int(e.get("fps_den") or 1000)
    fps = fps_num / fps_den
    kept, words, removed = kept_ranges(d)
    notes = []
    for k in range(1, len(e["videos"]) + 1):
        man_p = d / f"{handoff.PKG.format(k=k)}.json"
        pkg = d / handoff.PKG.format(k=k)
        man = jload(man_p)
        if not man or not pkg.is_dir():
            continue
        orig = d / ORIG.format(k=k)
        if not orig.exists():                         # the first cut: the originals aside (never in the zip)
            tmp = Path(str(orig) + ".part")
            shutil.rmtree(tmp, ignore_errors=True)
            for rel in KEEP:
                if (pkg / rel).exists():
                    (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(pkg / rel, tmp / rel)
            pv = d / f"preview-{k:02d}.mp4"
            if pv.exists():
                os.link(pv, tmp / "preview.mp4")
            jdump(tmp / "manifest.json", man)
            os.replace(tmp, orig)
        oman = jload(orig / "manifest.json")
        total0 = int(oman.get("frames") or 0)
        kk = kept or [(0, total0)]
        progress("Cutting the timelines…", 0.1)
        tl = read_xmeml((orig / "timeline.xml").read_text())
        t2 = cut_timeline(tl, kk)
        fcp = json.loads(json.dumps(t2))
        if len(fcp["video"]) > 1 and not fcp["video"][1]["clips"]:
            fcp["video"][1]["clips"] = handoff._abut(placeholders_of(t2))
        probs = nlexml.check(t2) + nlexml.check(fcp)
        xm, fx = nlexml.xmeml(t2), nlexml.fcpxml(fcp)
        probs += nlexml.validate_xmeml(xm) + nlexml.validate_fcpxml(fx)
        if probs:
            raise RuntimeError("cut timeline check failed: " + "; ".join(probs[:6]))
        (pkg / "timeline.xml").write_text(xm)
        (pkg / "timeline.fcpxml").write_text(fx)
        rows = jload(orig / "screencasts" / "slots.json") or []
        if rows:
            rows2 = cut_rows(rows, kk, fps_num, fps_den, words) if kept else rows
            jdump(pkg / "screencasts" / "slots.json", rows2)
            (pkg / "screencasts" / "slots.csv").write_text(handoff.slots_csv(rows2))
            meta = {"title": (jload(d / "request.json") or {}).get("title") or d.name, "width": tl["width"],
                    "height": tl["height"], "fps_label": handoff._fps_label(fps_num, fps_den)}
            (pkg / "screencasts" / "BRIEF.html").write_text(handoff.brief_html(rows2, meta))
        # the preview: the same frames cut out of the ORIGINAL preview
        pv, opv = d / f"preview-{k:02d}.mp4", orig / "preview.mp4"
        if opv.exists():
            progress("Cutting the preview…", 0.3)
            if kept:
                trim_preview(opv, d / f".preview-{k:02d}.cut.mp4", kk, fps, cancelled)
                os.replace(d / f".preview-{k:02d}.cut.mp4", pv)
            else:
                pv.unlink(missing_ok=True)
                os.link(opv, pv)
        # the manifest: the sizes the Lab checks before it zips (handoffZip.ts)
        for rel in KEEP:
            if (pkg / rel).exists():
                man["files"][rel] = (pkg / rel).stat().st_size
        if "preview.mp4" in man["files"] and pv.exists():
            man["files"]["preview.mp4"] = pv.stat().st_size
        man["bytes"] = sum(man["files"].values())
        man["frames"] = sum(b - a for a, b in kk)
        man["slots"] = [{**s_} for s_ in (oman.get("slots") or [])] if not kept else [
            {"n": r["slot"], "start_tc": r["start_tc"], "end_tc": r["end_tc"], "label": r["label"],
             "steps": len(r.get("steps") or []) or 1} for r in (jload(pkg / "screencasts" / "slots.json") or [])]
        man["cut"] = {"at": time.time(), "removed_words": len(removed), "kept_frames": man["frames"],
                      "original_frames": total0} if kept else None
        jdump(man_p, man)
        if kept:
            notes.append(f"package {k}: {len(removed)} word(s) cut — {total0 / fps:.0f}s → {man['frames'] / fps:.0f}s, "
                         f"{len(man['slots'])} slot(s); timelines, brief and preview cut (no media re-made)")
        else:
            notes.append(f"package {k}: back to the whole timeline ({total0 / fps:.0f}s)")
    note = "; ".join(notes) or "no hand-off package to cut"
    log(note)
    return note
