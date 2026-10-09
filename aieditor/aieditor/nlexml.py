"""NLE timelines for the hand-off package (aieditor/handoff.py — "Graphics only, the editor adds the
screencasts", Jake 2026-10-09). His editor works in Premiere Pro or DaVinci Resolve, so the same timeline is
written twice:

  xmeml(tl)   Final Cut Pro 7 XML, version 4 ("Premiere XML") — Premiere's own import, Resolve reads it too
  fcpxml(tl)  FCPXML 1.10 — Resolve's most reliable import path

Pure code (no media, no Docker): the package builder hands in a neutral timeline and gets the XML text back.

THE TIMELINE (frames on the sequence clock; every path RELATIVE to the folder the XML sits in):
  {"name": str, "fps_num": 30000, "fps_den": 1001, "width": 1920, "height": 1080, "frames": total,
   "video": [track, ...],      V1 first; a track = {"name": str, "clips": [clip, ...]}
   "audio": [track, ...],      A1 first
   "markers": [{"frame", "frames", "name", "note"}]}
  clip = {"name", "file" (relative path), "start" (sequence frame), "frames" (length on the timeline),
          "in" (first media frame, default 0), "media_frames" (the file's own length, default in + frames),
          "alpha" (ProRes 4444 with straight alpha), "enabled" (default True), "channels" (audio, default 2),
          "role" (FCPXML audioRole: dialogue | music | effects)}

An EMPTY track stays in the Premiere XML (V2 = the screencast track the editor fills). FCPXML has no empty
lanes: a track's clips with "enabled": False (the labelled placeholder cards) keep its lane in Resolve.
"""
from fractions import Fraction
from urllib.parse import quote
from xml.etree import ElementTree as ET

AUDIO_RATE = 48000
AUDIO_DEPTH = 24


# ── rates and times ──

def rate_of(fps_num, fps_den):
    """FCP7 <rate>: (timebase, ntsc). 30000/1001 → (30, True), 25/1 → (25, False), 24000/1001 → (24, True)."""
    fps = Fraction(int(fps_num), int(fps_den))
    if fps.denominator == 1:
        return int(fps), False
    tb = round(float(fps) * 1.001)
    if abs(Fraction(tb * 1000, 1001) - fps) < Fraction(1, 10000):
        return tb, True
    return round(float(fps)), False


def fcp_time(frames, fps_num, fps_den):
    """FCPXML rational seconds for a whole number of frames ("0s", "1001/1000s", "2s")."""
    t = Fraction(int(frames) * int(fps_den), int(fps_num))
    if t == 0:
        return "0s"
    return f"{t.numerator}s" if t.denominator == 1 else f"{t.numerator}/{t.denominator}s"


def parse_time(s):
    """'1001/1000s' | '2s' | '0s' → Fraction seconds (tests, validation)."""
    s = str(s)
    if not s.endswith("s"):
        raise ValueError(f"not an FCPXML time: {s!r}")
    body = s[:-1]
    if "/" in body:
        n, d = body.split("/")
        return Fraction(int(n), int(d))
    return Fraction(int(body))


def tc_string(frame, fps_num, fps_den):
    """HH:MM:SS:FF, non-drop (the brief and the markers)."""
    tb, _ = rate_of(fps_num, fps_den)
    f = int(frame)
    return f"{f // (tb * 3600):02d}:{f // (tb * 60) % 60:02d}:{f // tb % 60:02d}:{f % tb:02d}"


def url_of(path):
    """A relative URI reference for a package path ('graphics/01 title.mov' → 'graphics/01%20title.mov')."""
    return quote(str(path).replace("\\", "/"), safe="/-_.~")


def _clips(tl, kind):
    for n, tr in enumerate(tl.get(kind) or [], 1):
        for c in tr.get("clips") or []:
            yield n, tr, c


def check(tl):
    """Timeline sanity → [problem]: clips inside the sequence, no overlap inside one track, sources long enough."""
    out = []
    total = int(tl["frames"])
    for kind in ("video", "audio"):
        for n, tr in enumerate(tl.get(kind) or [], 1):
            last = None
            for c in sorted(tr.get("clips") or [], key=lambda c: c["start"]):
                a, b = int(c["start"]), int(c["start"]) + int(c["frames"])
                if c["frames"] <= 0:
                    out.append(f"{kind} {n} {c['name']}: no frames")
                if a < 0 or b > total:
                    out.append(f"{kind} {n} {c['name']}: {a}-{b} outside the sequence 0-{total}")
                if last is not None and a < last[1]:
                    out.append(f"{kind} {n} {c['name']}: overlaps {last[0]}")
                mf = c.get("media_frames")
                if mf is not None and int(c.get("in", 0)) + int(c["frames"]) > int(mf):
                    out.append(f"{kind} {n} {c['name']}: uses {int(c.get('in', 0)) + int(c['frames'])} of {mf} media frames")
                last = (c["name"], b)
    for m in tl.get("markers") or []:
        if not 0 <= int(m["frame"]) <= total:
            out.append(f"marker {m['name']}: frame {m['frame']} outside the sequence")
    return out


def _pretty(root, doctype):
    ET.indent(root, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + doctype + ET.tostring(root, encoding="unicode") + "\n"


def _sub(parent, tag, text=None, **attrs):
    e = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    if text is not None:
        e.text = str(text)
    return e


# ── Premiere XML (FCP7 xmeml v4) ──

def _rate(parent, tb, ntsc):
    r = _sub(parent, "rate")
    _sub(r, "timebase", tb)
    _sub(r, "ntsc", "TRUE" if ntsc else "FALSE")
    return r


def xmeml(tl):
    """The timeline as FCP7 XML v4. Every clip names its own file (relative pathurl), video clips with alpha
    say <alphatype>straight</alphatype>, audio stems are stereo clips on stereo tracks, slots are sequence markers."""
    tb, ntsc = rate_of(tl["fps_num"], tl["fps_den"])
    root = ET.Element("xmeml", {"version": "4"})
    seq = _sub(root, "sequence", id="sequence-1")
    _sub(seq, "uuid", tl.get("uuid") or "00000000-0000-0000-0000-000000000001")
    _sub(seq, "duration", int(tl["frames"]))
    _rate(seq, tb, ntsc)
    _sub(seq, "name", tl["name"])
    media = _sub(seq, "media")
    video = _sub(media, "video")
    fmt = _sub(video, "format")
    sc = _sub(fmt, "samplecharacteristics")
    _rate(sc, tb, ntsc)
    _sub(sc, "width", tl["width"])
    _sub(sc, "height", tl["height"])
    _sub(sc, "anamorphic", "FALSE")
    _sub(sc, "pixelaspectratio", "square")
    _sub(sc, "fielddominance", "none")
    ids = {"clip": 0, "file": 0}

    def clipitem(track, c, kind):
        ids["clip"] += 1
        ids["file"] += 1
        n = ids["clip"]
        start = int(c["start"])
        frames = int(c["frames"])
        cin = int(c.get("in", 0))
        mf = int(c.get("media_frames") or cin + frames)
        ci = _sub(track, "clipitem", id=f"clipitem-{n}")
        _sub(ci, "masterclipid", f"masterclip-{n}")
        _sub(ci, "name", c["name"])
        _sub(ci, "enabled", "TRUE" if c.get("enabled", True) else "FALSE")
        _sub(ci, "duration", mf)
        _rate(ci, tb, ntsc)
        _sub(ci, "start", start)
        _sub(ci, "end", start + frames)
        _sub(ci, "in", cin)
        _sub(ci, "out", cin + frames)
        if kind == "video" and c.get("alpha"):
            _sub(ci, "alphatype", "straight")
        f = _sub(ci, "file", id=f"file-{ids['file']}")
        _sub(f, "name", str(c["file"]).rsplit("/", 1)[-1])
        _sub(f, "pathurl", url_of(c["file"]))
        _rate(f, tb, ntsc)
        _sub(f, "duration", mf)
        fm = _sub(f, "media")
        if kind == "video":
            v = _sub(_sub(fm, "video"), "samplecharacteristics")
            _rate(v, tb, ntsc)
            _sub(v, "width", c.get("width") or tl["width"])
            _sub(v, "height", c.get("height") or tl["height"])
        else:
            a = _sub(fm, "audio")
            s = _sub(a, "samplecharacteristics")
            _sub(s, "depth", AUDIO_DEPTH)
            _sub(s, "samplerate", AUDIO_RATE)
            _sub(a, "channelcount", int(c.get("channels", 2)))
            st = _sub(ci, "sourcetrack")
            _sub(st, "mediatype", "audio")
            _sub(st, "trackindex", 1)
        return ci

    for tr in tl.get("video") or []:
        t = _sub(video, "track")
        for c in sorted(tr.get("clips") or [], key=lambda c: c["start"]):
            clipitem(t, c, "video")
        _sub(t, "enabled", "TRUE")
        _sub(t, "locked", "FALSE")
    audio = _sub(media, "audio")
    _sub(audio, "numOutputChannels", 2)
    af = _sub(_sub(audio, "format"), "samplecharacteristics")
    _sub(af, "depth", AUDIO_DEPTH)
    _sub(af, "samplerate", AUDIO_RATE)
    for tr in tl.get("audio") or []:
        t = _sub(audio, "track", premiereTrackType="Stereo")
        for c in sorted(tr.get("clips") or [], key=lambda c: c["start"]):
            clipitem(t, c, "audio")
        _sub(t, "enabled", "TRUE")
        _sub(t, "locked", "FALSE")
        _sub(t, "outputchannelindex", 1)
    tc = _sub(seq, "timecode")
    _rate(tc, tb, ntsc)
    _sub(tc, "string", "00:00:00:00")
    _sub(tc, "frame", 0)
    _sub(tc, "displayformat", "NDF")
    for m in tl.get("markers") or []:
        mk = _sub(seq, "marker")
        _sub(mk, "comment", m.get("note", ""))
        _sub(mk, "name", m["name"])
        _sub(mk, "in", int(m["frame"]))
        _sub(mk, "out", int(m["frame"]) + int(m["frames"]) if m.get("frames") else -1)
    return _pretty(root, "<!DOCTYPE xmeml>\n")


# ── FCPXML 1.10 ──

_RATE_TOKEN = {(24000, 1001): "2398", (24, 1): "24", (25, 1): "25", (30000, 1001): "2997", (30, 1): "30",
               (50, 1): "50", (60000, 1001): "5994", (60, 1): "60"}


def format_name(w, h, fps_num, fps_den):
    """FCP's format name when it has one (FFVideoFormat1080p2997, FFVideoFormat3840x2160p2997), else None."""
    f = Fraction(int(fps_num), int(fps_den))
    tok = _RATE_TOKEN.get((f.numerator, f.denominator))
    if not tok:
        return None
    if (w, h) in ((1920, 1080), (1280, 720)):
        return f"FFVideoFormat{h}p{tok}"
    return f"FFVideoFormat{w}x{h}p{tok}"


def fcpxml(tl):
    """The timeline as FCPXML 1.10: one format, one asset per file (media-rep with a relative src), the A-roll on
    the primary storyline (a gap fills to the sequence end), every other clip connected to it on its lane
    (V2 → lane 1, V3 → lane 2 …; A1 → lane -1 …), the slots as markers on the A-roll."""
    num, den = int(tl["fps_num"]), int(tl["fps_den"])
    T = lambda f: fcp_time(f, num, den)
    root = ET.Element("fcpxml", {"version": "1.10"})
    res = _sub(root, "resources")
    fa = {"id": "r1", "frameDuration": T(1), "width": tl["width"], "height": tl["height"],
          "colorSpace": "1-1-1 (Rec. 709)"}
    name = format_name(int(tl["width"]), int(tl["height"]), num, den)
    if name:
        fa["name"] = name
    _sub(res, "format", **fa)
    assets = {}

    def asset_of(c, kind):
        key = c["file"]
        if key in assets:
            return assets[key]
        rid = f"r{len(assets) + 2}"
        mf = int(c.get("media_frames") or int(c.get("in", 0)) + int(c["frames"]))
        a = {"id": rid, "name": str(c["file"]).rsplit("/", 1)[-1].rsplit(".", 1)[0], "start": "0s", "duration": T(mf)}
        if kind == "video":
            a.update(hasVideo="1", format="r1", videoSources="1", hasAudio="0")
        else:
            a.update(hasVideo="0", hasAudio="1", audioSources="1", audioChannels=str(int(c.get("channels", 2))),
                     audioRate=str(AUDIO_RATE))
        el = _sub(res, "asset", **a)
        _sub(el, "media-rep", kind="original-media", src=url_of(c["file"]))
        assets[key] = rid
        return rid

    lib = _sub(root, "library")
    ev = _sub(lib, "event", name=tl.get("event") or tl["name"])
    proj = _sub(ev, "project", name=tl["name"])
    seq = _sub(proj, "sequence", format="r1", duration=T(tl["frames"]), tcStart="0s", tcFormat="NDF",
               audioLayout="stereo", audioRate="48k")
    spine = _sub(seq, "spine")
    # the primary storyline: V1's clips in order, gaps between them and up to the sequence end
    items, t = [], 0
    for c in sorted((tl.get("video") or [{}])[0].get("clips") or [], key=lambda c: c["start"]):
        if c["start"] > t:
            items.append({"offset": t, "frames": c["start"] - t, "local0": 0, "gap": True})
        items.append({"offset": int(c["start"]), "frames": int(c["frames"]), "local0": int(c.get("in", 0)), "clip": c})
        t = int(c["start"]) + int(c["frames"])
    if t < int(tl["frames"]):
        items.append({"offset": t, "frames": int(tl["frames"]) - t, "local0": 0, "gap": True})
    for it in items:
        if it.get("gap"):
            it["el"] = _sub(spine, "gap", name="Gap", offset=T(it["offset"]), start="0s", duration=T(it["frames"]))
        else:
            c = it["clip"]
            attrs = {"ref": asset_of(c, "video"), "offset": T(it["offset"]), "name": c["name"],
                     "start": T(it["local0"]), "duration": T(it["frames"]), "tcFormat": "NDF"}
            if not c.get("enabled", True):
                attrs["enabled"] = "0"
            it["el"] = _sub(spine, "asset-clip", **attrs)
        it["anchors"], it["markers"] = [], []

    def host(frame):
        for it in items:
            if it["offset"] <= frame < it["offset"] + it["frames"]:
                return it
        return items[-1]

    def local(it, frame):
        return it["local0"] + (frame - it["offset"])

    lanes = [(n, "video", tr) for n, tr in enumerate((tl.get("video") or [])[1:], 1)] + \
            [(-n, "audio", tr) for n, tr in enumerate(tl.get("audio") or [], 1)]
    for lane, kind, tr in lanes:
        for c in sorted(tr.get("clips") or [], key=lambda c: c["start"]):
            it = host(int(c["start"]))
            attrs = {"ref": asset_of(c, kind), "lane": str(lane), "offset": T(local(it, int(c["start"]))),
                     "name": c["name"], "start": T(int(c.get("in", 0))), "duration": T(int(c["frames"]))}
            if kind == "audio":
                attrs["audioRole"] = c.get("role") or "dialogue"
            else:
                attrs["tcFormat"] = "NDF"
            if not c.get("enabled", True):
                attrs["enabled"] = "0"
            it["anchors"].append(attrs)
    for m in tl.get("markers") or []:
        it = host(int(m["frame"]))
        it["markers"].append({"start": T(local(it, int(m["frame"]))), "duration": T(max(1, int(m.get("frames") or 1))),
                              "value": m["name"], **({"note": m["note"]} if m.get("note") else {})})
    for it in items:                      # DTD order: anchored clips before markers
        for a in it["anchors"]:
            _sub(it["el"], "asset-clip", **a)
        for m in it["markers"]:
            _sub(it["el"], "marker", **m)
    return _pretty(root, "<!DOCTYPE fcpxml>\n")


# ── validation (tests + the package builder's own self-check) ──

FCPXML_CHILDREN = {
    "fcpxml": ("import-options", "resources", "library"),
    "resources": ("format", "asset", "effect", "media"),
    "asset": ("media-rep", "metadata"),
    "library": ("event", "smart-collection"),
    "event": ("project", "asset-clip", "clip", "keyword-collection"),
    "project": ("sequence",),
    "sequence": ("note", "spine", "metadata"),
    "spine": ("asset-clip", "gap", "clip", "title", "video", "ref-clip", "sync-clip", "transition"),
    "gap": ("note", "asset-clip", "clip", "title", "video", "marker", "chapter-marker", "metadata"),
    "asset-clip": ("note", "asset-clip", "clip", "title", "video", "marker", "chapter-marker", "keyword", "metadata"),
}
FCPXML_REQUIRED = {
    "format": ("id", "frameDuration", "width", "height"),
    "asset": ("id", "start", "duration"),
    "media-rep": ("kind", "src"),
    "sequence": ("format", "duration", "tcStart"),
    "asset-clip": ("ref", "offset", "duration"),
    "gap": ("offset", "duration"),
    "marker": ("start", "value"),
}


def validate_fcpxml(text):
    """The FCPXML 1.10 structure this builder relies on → [problem] (empty = fine): element nesting, required
    attributes, refs that resolve, every time a whole number of frames, anchored clips before markers, the
    spine filling the sequence, every connected clip inside it."""
    probs = []
    root = ET.fromstring(text)
    if root.tag != "fcpxml" or root.get("version") != "1.10":
        return [f"root is <{root.tag} version={root.get('version')}>, not fcpxml 1.10"]
    fmt = root.find("resources/format")
    if fmt is None:
        return ["no resources/format"]
    fd = parse_time(fmt.get("frameDuration"))
    ids = {e.get("id"): e for e in root.iter() if e.get("id")}

    def walk(e):
        allowed = FCPXML_CHILDREN.get(e.tag)
        seen_marker = False
        for ch in e:
            if allowed is not None and ch.tag not in allowed:
                probs.append(f"<{ch.tag}> is not allowed in <{e.tag}>")
            if ch.tag in ("marker", "chapter-marker"):
                seen_marker = True
            elif seen_marker and ch.tag in ("asset-clip", "clip", "title", "video"):
                probs.append(f"<{ch.tag} name={ch.get('name')}> comes after a marker in <{e.tag}>")
            walk(ch)
        for a in FCPXML_REQUIRED.get(e.tag, ()):
            if e.get(a) is None:
                probs.append(f"<{e.tag}> has no {a}")
        for a in ("offset", "start", "duration", "tcStart"):
            v = e.get(a)
            if v is None or e.tag in ("asset",) and a == "duration":
                continue
            try:
                t = parse_time(v)
            except ValueError as x:
                probs.append(f"<{e.tag}> {a}: {x}")
                continue
            if (t / fd).denominator != 1:
                probs.append(f"<{e.tag} name={e.get('name')}> {a}={v} is not a whole frame")
        ref = e.get("ref")
        if ref is not None and ref not in ids:
            probs.append(f"<{e.tag}> ref {ref} does not resolve")
        if e.tag == "sequence" and e.get("format") not in ids:
            probs.append("sequence format does not resolve")
    walk(root)
    for seq in root.iter("sequence"):
        total = parse_time(seq.get("duration"))
        spine = seq.find("spine")
        t = Fraction(0)
        for it in spine:
            off, dur = parse_time(it.get("offset")), parse_time(it.get("duration"))
            if off != t:
                probs.append(f"spine item {it.get('name')} starts at {off}, expected {t}")
            for ch in it:
                if ch.tag != "asset-clip":
                    continue
                st = parse_time(it.get("start") or "0s")
                abs0 = off + parse_time(ch.get("offset")) - st
                if abs0 < 0 or abs0 + parse_time(ch.get("duration")) > total:
                    probs.append(f"connected clip {ch.get('name')} runs outside the sequence")
                if ch.get("lane") in (None, "0"):
                    probs.append(f"connected clip {ch.get('name')} has no lane")
            t = off + dur
        if t != total:
            probs.append(f"the spine ends at {t}, the sequence at {total}")
    return probs


def validate_xmeml(text):
    """The xmeml v4 structure Premiere needs → [problem]: one sequence with rate/duration/media, every clipitem
    with name/start/end/in/out/file(pathurl) and consistent lengths, nothing past the sequence."""
    probs = []
    root = ET.fromstring(text)
    if root.tag != "xmeml" or root.get("version") != "4":
        return [f"root is <{root.tag} version={root.get('version')}>, not xmeml 4"]
    seq = root.find("sequence")
    if seq is None:
        return ["no sequence"]
    for tag in ("duration", "rate/timebase", "rate/ntsc", "name", "media/video/format/samplecharacteristics/width",
                "media/video/format/samplecharacteristics/height"):
        if seq.find(tag) is None:
            probs.append(f"sequence has no {tag}")
    total = int(seq.findtext("duration") or 0)
    tb = seq.findtext("rate/timebase")
    for kind in ("video", "audio"):
        for n, tr in enumerate(seq.findall(f"media/{kind}/track"), 1):
            last_end = -1
            for ci in tr.findall("clipitem"):
                name = ci.findtext("name")
                for tag in ("name", "start", "end", "in", "out", "duration", "rate/timebase", "file/pathurl"):
                    if ci.find(tag) is None:
                        probs.append(f"{kind} {n} clipitem {name} has no {tag}")
                s, e = int(ci.findtext("start")), int(ci.findtext("end"))
                i, o = int(ci.findtext("in")), int(ci.findtext("out"))
                if e - s != o - i or e <= s:
                    probs.append(f"{kind} {n} {name}: start/end {s}-{e} vs in/out {i}-{o}")
                if o > int(ci.findtext("duration")):
                    probs.append(f"{kind} {n} {name}: out {o} past the media length {ci.findtext('duration')}")
                if s < 0 or e > total:
                    probs.append(f"{kind} {n} {name}: {s}-{e} outside the sequence (0-{total})")
                if s < last_end:
                    probs.append(f"{kind} {n} {name}: overlaps the previous clip")
                if ci.findtext("rate/timebase") != tb:
                    probs.append(f"{kind} {n} {name}: timebase differs from the sequence")
                last_end = e
    return probs
