"""Graphics only — the editor adds the screencasts (aieditor/handoff.py + aieditor/nlexml.py), no Docker, no API:

  nlexml     the Premiere XML (xmeml v4) and FCPXML 1.10 builders: rates, rational times, relative paths, the
             EMPTY V2 screencast track + one marker per slot, alpha clips, stereo stems, lanes, the validators
  slots      the plan's screencast segments → the editor's slots with compose's own transition windows
  brief      every slot listed with its exact words, its beats on their words, zoom targets, app/URL, the rules
  worker     a long-form creative job with request.json "handoff": the hand-off stages only, ONE plan call + ONE
             overlay call (fake transport), never held, no recording, no preview/compose stage

Run: python3 tests/test_handoff.py
"""
import csv
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
from fractions import Fraction
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AIEDITOR_API_LEDGER", str(Path(tempfile.mkdtemp(prefix="handoff-ledger-")) / "api.jsonl"))
from aieditor import compose_long, events, handoff, nlexml  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


# ════════════════════════════ nlexml ════════════════════════════

def sample_timeline():
    """60 s at 29.97: A-roll, two slots, two overlapping overlays, gradient, bubbles, end fade, three stems."""
    total = 1800
    graphics = [
        {"group": "overlay", "name": "01-keyword-a", "file": "graphics/01-keyword-a.mov", "start": 100, "frames": 90, "media_frames": 90, "alpha": True},
        {"group": "overlay", "name": "02-link-b", "file": "graphics/02-link-b.mov", "start": 150, "frames": 60, "media_frames": 60, "alpha": True},
        {"group": "gradient", "name": "03-text-gradient", "file": "graphics/03-text-gradient.mov", "start": 95, "frames": 120, "media_frames": 120, "alpha": True},
        {"group": "bubble", "name": "04-facecam-bubble-slot01", "file": "graphics/04-facecam-bubble-slot01.mov", "start": 400, "frames": 305, "media_frames": 305, "alpha": True},
        {"group": "bubble", "name": "05-facecam-bubble-slot02", "file": "graphics/05-facecam-bubble-slot02.mov", "start": 700, "frames": 300, "media_frames": 300, "alpha": True},
        {"group": "fade", "name": "06-end-fade", "file": "graphics/06-end-fade.mov", "start": 1760, "frames": 40, "media_frames": 40, "alpha": True},
    ]
    slots = [{"n": 1, "label": "open the chat", "start": 400, "frames": 305, "note": "00:00:14:00 open: the chat"},
             {"n": 2, "label": "paste the prompt", "start": 700, "frames": 300, "note": ""}]
    ph = [{"name": "slot-01 placeholder", "file": "screencasts/placeholders/slot-01.mp4", "start": 400, "frames": 305, "media_frames": 305},
          {"name": "slot-02 placeholder", "file": "screencasts/placeholders/slot-02.mp4", "start": 700, "frames": 300, "media_frames": 300}]
    return handoff.timeline_model("Test & <video> — hand-off", 30000, 1001, 1920, 1080, total, 1775, graphics, slots, ph, total)


def test_nlexml():
    check(nlexml.rate_of(30000, 1001) == (30, True), "29.97 → timebase 30 NTSC")
    check(nlexml.rate_of(24000, 1001) == (24, True), "23.976 → 24 NTSC")
    check(nlexml.rate_of(25, 1) == (25, False) and nlexml.rate_of(60, 1) == (60, False), "integer rates")
    check(nlexml.fcp_time(0, 30000, 1001) == "0s" and nlexml.fcp_time(30, 30000, 1001) == "1001/1000s",
          f"rational times: {nlexml.fcp_time(30, 30000, 1001)}")
    check(nlexml.fcp_time(50, 25, 1) == "2s", "whole seconds")
    check(nlexml.parse_time("1001/1000s") == Fraction(1001, 1000), "parse a time")
    check(nlexml.tc_string(30 * 61 + 5, 30000, 1001) == "00:01:01:05", "timecode")
    check(nlexml.url_of("graphics/01 a&b.mov") == "graphics/01%20a%26b.mov", "relative URL, escaped")
    check(nlexml.format_name(1920, 1080, 30000, 1001) == "FFVideoFormat1080p2997", "FCP format name 1080p")
    check(nlexml.format_name(3840, 2160, 30000, 1001) == "FFVideoFormat3840x2160p2997", "FCP format name UHD")

    tl, fcp = sample_timeline()
    check(nlexml.check(tl) == [] and nlexml.check(fcp) == [], f"timeline sane: {nlexml.check(tl)} {nlexml.check(fcp)}")
    names = [t["name"] for t in tl["video"]]
    check(names[0] == "A-roll" and names[1].startswith("Screencasts") and tl["video"][1]["clips"] == [],
          f"V1 A-roll, V2 the empty screencast track: {names}")
    check(names[2] == "gradient" and names[3] == "overlay" and names[4] == "overlay 2", f"V3 gradient, V4+ overlays: {names}")
    check(len(tl["video"][3]["clips"]) == 1 and len(tl["video"][4]["clips"]) == 1, "overlapping overlays → two tracks")
    check([t["name"] for t in tl["audio"]] == ["Voice", "Music", "SFX"], "A1 voice, A2 music, A3 SFX")
    check(all(not c.get("enabled", True) for c in fcp["video"][1]["clips"]) and len(fcp["video"][1]["clips"]) == 2,
          "FCPXML: disabled placeholder per slot keeps V2")

    xm = nlexml.xmeml(tl)
    root = ET.fromstring(xm)                                  # well-formed
    check(xm.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>'), "xml declaration + doctype")
    check(nlexml.validate_xmeml(xm) == [], f"xmeml valid: {nlexml.validate_xmeml(xm)}")
    seq = root.find("sequence")
    check(seq.findtext("name") == "Test & <video> — hand-off", "escaped name round-trips")
    check(seq.findtext("duration") == "1800" and seq.findtext("rate/timebase") == "30" and seq.findtext("rate/ntsc") == "TRUE",
          "sequence length + rate")
    vtracks = seq.findall("media/video/track")
    check(len(vtracks) == len(tl["video"]) and vtracks[1].find("clipitem") is None, "V2 is an empty track in the Premiere XML")
    v1 = vtracks[0].find("clipitem")
    check(v1.findtext("file/pathurl") == "a-roll.mov" and v1.findtext("start") == "0" and v1.findtext("end") == "1775",
          "V1 = a-roll.mov from 0")
    gfx = [c for t in vtracks[2:] for c in t.findall("clipitem")]
    check(len(gfx) == 6 and all(c.findtext("alphatype") == "straight" for c in gfx), "every graphic says straight alpha")
    check(all(not c.findtext("file/pathurl").startswith(("/", "file:")) for t in vtracks for c in t.findall("clipitem")),
          "every path relative")
    kw = next(c for c in gfx if c.findtext("name") == "01-keyword-a")
    check((kw.findtext("start"), kw.findtext("end"), kw.findtext("in"), kw.findtext("out")) == ("100", "190", "0", "90"),
          "an overlay at its own frame")
    b1 = next(c for c in gfx if c.findtext("name") == "04-facecam-bubble-slot01")
    check(b1.findtext("end") == "700", f"back-to-back bubbles abut, no overlap: {b1.findtext('end')}")
    atr = seq.findall("media/audio/track")
    check(len(atr) == 3 and all(t.get("premiereTrackType") == "Stereo" for t in atr), "three stereo audio tracks")
    a1 = atr[0].find("clipitem")
    check(a1.findtext("file/pathurl") == "audio/voice.wav" and a1.findtext("file/media/audio/channelcount") == "2"
          and a1.findtext("sourcetrack/mediatype") == "audio", "A1 voice stem")
    mk = seq.findall("marker")
    check(len(mk) == 2 and mk[0].findtext("name").startswith("Screencast 1") and mk[0].findtext("in") == "400"
          and mk[0].findtext("out") == "705", "one marker per slot with its range")

    fx = nlexml.fcpxml(fcp)
    froot = ET.fromstring(fx)
    check(nlexml.validate_fcpxml(fx) == [], f"fcpxml 1.10 structure: {nlexml.validate_fcpxml(fx)}")
    check(froot.get("version") == "1.10", "version 1.10")
    fmt = froot.find("resources/format")
    check(fmt.get("frameDuration") == "1001/30000s" and fmt.get("width") == "1920", "format")
    sq = froot.find("library/event/project/sequence")
    check(nlexml.parse_time(sq.get("duration")) == Fraction(1800 * 1001, 30000), "sequence duration = 1800 frames")
    spine = list(sq.find("spine"))
    check([e.tag for e in spine] == ["asset-clip", "gap"], f"A-roll then a gap to the end: {[e.tag for e in spine]}")
    ar = spine[0]
    assets = {a.get("id"): a for a in froot.iter("asset")}
    check(assets[ar.get("ref")].find("media-rep").get("src") == "a-roll.mov", "A-roll asset, relative src")
    lanes = sorted({int(c.get("lane")) for c in ar.findall("asset-clip")})
    check(lanes == [-3, -2, -1, 1, 2, 3, 4, 5, 6], f"lanes: placeholders 1, graphics 2+, stems -1..-3: {lanes}")
    ph = [c for c in ar.findall("asset-clip") if c.get("lane") == "1"]
    check(len(ph) == 2 and all(c.get("enabled") == "0" for c in ph), "placeholders disabled on lane 1")
    roles = {c.get("audioRole") for c in ar.findall("asset-clip") if int(c.get("lane")) < 0}
    check(roles == {"dialogue", "music", "effects"}, f"audio roles: {roles}")
    kids = [c.tag for c in ar]
    check(kids.index("marker") > max(i for i, t in enumerate(kids) if t == "asset-clip"), "markers after the anchored clips")
    check(len(ar.findall("marker")) == 2, "one marker per slot")
    fade = next(c for c in ar.findall("asset-clip") if c.get("name") == "06-end-fade")
    check(nlexml.parse_time(fade.get("offset")) == Fraction(1760 * 1001, 30000), "a connected clip at its timeline frame")
    # the validators catch what they promise
    import re
    bad = re.sub(r'<marker start="[^"]+"', '<marker start="1/30000s"', fx, count=1)
    check(bad != fx and any("whole frame" in p for p in nlexml.validate_fcpxml(bad)), "a non-frame time flagged")
    check(nlexml.validate_fcpxml(fx.replace('version="1.10"', 'version="1.9"', 1)), "wrong version flagged")
    over = json.loads(json.dumps(tl))
    over["video"][3]["clips"].append({**over["video"][3]["clips"][0], "name": "dup"})
    check(any("overlaps" in p for p in nlexml.check(over)), "an overlap inside one track flagged")
    broken = xm.replace("<end>1775</end>", "<end>1900</end>", 1)
    check(nlexml.validate_xmeml(broken), "inconsistent start/end vs in/out flagged")


# ════════════════════════════ slots + brief ════════════════════════════

def words_of(text, t0=0.2, step=0.4):
    ws, t = [], t0
    for i, w in enumerate(text.split()):
        ws.append({"i": i, "word": w, "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += step
    return ws


TEXT = ("Welcome back to the channel. Open ChatGPT and click the image so the editor opens. "
        "Now check the pricing page for the Plus plan. Then type the prompt and hit send. That is it, see you next time.")


def test_slots_and_brief():
    ws = words_of(TEXT)
    at = lambda w: next(x for x in ws if x["word"].strip(".,") == w)
    s1 = {"t0": at("Open")["start"] - 0.1, "t1": at("Now")["start"] - 0.1, "url": "https://chatgpt.com/",
          "intent": "on 'Open ChatGPT': the ChatGPT start screen, unzoomed; on 'click the image': the picture opens in the editor, zoom on the top toolbar"}
    s2 = {"t0": s1["t1"], "t1": at("Then")["start"] - 0.1, "url": "https://chatgpt.com/pricing",
          "session": {"kind": "public", "currency": "USD"},
          "actions": [{"t_word": at("pricing")["start"], "cue": "pricing page", "action": "outside.goto",
                       "subject": "screen", "body": "the public pricing page, top unzoomed", "params": {"url": "https://chatgpt.com/pricing"}},
                      {"t_word": at("Plus")["start"], "cue": "Plus plan", "action": "camera.zoom", "subject": "ui:Plus",
                       "body": "zoom on the Plus card", "params": {}}]}
    s3 = {"t0": at("type")["start"] - 0.1, "t1": 99.0, "url": "https://chatgpt.com/",
          "beats": [{"t_word": at("type")["start"], "cue": "type the prompt", "action": "chatgpt.paste_prompt",
                     "subject": "ui:message box", "typed_text": "a cup of coffee on a wooden table"},
                    {"t_word": 150.0, "cue": "after the end", "action": "camera.zoom", "subject": "screen"}],
          "intent": "on 'type the prompt': the whole message box, zoomed out, with 'a cup of coffee on a wooden table' pasted in whole"}
    vdur = ws[-1]["end"] + 0.3
    slots = handoff.slots_of([s3, s1, s2], vdur)
    check([s["n"] for s in slots] == [1, 2, 3], "slots numbered in time order")
    check(slots[2]["t1"] == round(vdur, 3), "a slot past the video is clipped to it (an excerpt)")
    a, b, c = slots
    check(a.get("aroll_in") and not a.get("aroll_out") and a.get("tail") == compose_long.xfade_s(),
          f"slot 1: from the presenter, dissolves INTO slot 2: {a}")
    check(b.get("fade_in") == a["tail"] and b.get("aroll_out"), f"slot 2: dissolves in over slot 1, out to the presenter: {b}")
    check(not c.get("aroll_out") and not c.get("tail"), "the last slot runs to the end")
    for s in slots:
        check((s["a"], s["b"]) == compose_long.screen_window(s) or s["b"] == round(vdur, 3) or s["b"] == vdur,
              "the slot window is compose's own screen window")
    check(a["a"] < a["t0"] and abs(a["t0"] - a["a"] - (compose_long._f(4) + compose_long.AROLL_LEAD_S)) < 1e-3,
          "the entry dissolve leads the words by 4 f + 0.1 s")

    notes = [{"sentence": "x", "why": "no proven action shows the toolbar", "word_ids": [at("click")["i"]]}]
    rows = handoff.brief_rows(slots, ws, notes=notes)
    check(len(rows) == 3 and [r["slot"] for r in rows] == [1, 2, 3], "every slot has a row")
    check(rows[0]["words"].startswith("Open ChatGPT and click the image"), f"slot 1 words: {rows[0]['words']}")
    check(all(r["words"] for r in rows), "every slot carries its exact words")
    check([bt["cue"] for bt in rows[0]["beats"]] == ["Open ChatGPT", "click the image"]
          and rows[0]["beats"][1]["word"] == "click", f"intent cues resolved onto their words: {rows[0]['beats']}")
    check(any("top toolbar" in z for z in rows[0]["zoom"]), f"zoom target from the intent: {rows[0]['zoom']}")
    check(rows[1]["logged_out_us"] and "Pricing" in rows[1]["flags"], "pricing slot → logged-out US browser rule")
    check(rows[1]["beats"][0]["url"] == "https://chatgpt.com/pricing" and rows[1]["beats"][1]["zoom"] == "Plus",
          f"schema beats: url + ui zoom target: {rows[1]['beats']}")
    check(rows[1]["beats"][0]["action"].startswith("open the public page"), "camera/outside actions in plain words")
    check(rows[2]["beats"][0]["text"] == "a cup of coffee on a wooden table" and "Prompts pasted whole" in rows[2]["flags"],
          "typed text + the paste rule")
    check([bt["cue"] for bt in rows[2]["beats"]] == ["type the prompt"], "a clipped slot drops the beats past the video's end")
    check(rows[0]["notes"] == ["no proven action shows the toolbar"], "a needs_primitive line becomes a note on its slot")
    check(rows[0]["start_tc"] < rows[0]["end_tc"] and rows[0]["duration_s"] > 0, "time range")

    text = handoff.slots_csv(rows)
    table = list(csv.reader(io.StringIO(text)))
    check(len(table) == 4 and table[0][0] == "slot", "slots.csv: header + one row per slot")
    check(table[1][9].startswith("Open ChatGPT") and "click" in table[1][11], "csv carries the words and the beats")
    page = handoff.brief_html(rows, {"title": "T <1>", "width": 1920, "height": 1080, "fps_label": "29.97 fps"})
    check("T &lt;1&gt;" in page and page.count("<section class=slot>") == 3, "brief: escaped, one card per slot")
    for r in rows:
        check(r["words"].split()[0] in page and f"Screencast {r['slot']}" in page, f"brief lists slot {r['slot']} with its words")
    for title, _ in handoff.RULES:
        check(title in page, f"brief rule: {title}")
    check("never log out" in page.lower() and "USD" in page and "Blur" in page, "privacy, US pricing, never log out")


# ════════════════════════════ worker: the hand-off workflow ════════════════════════════

def load_worker():
    loader = importlib.machinery.SourceFileLoader("aieditor_worker_h", str(ROOT / "bin" / "aieditor-worker"))
    spec = importlib.util.spec_from_loader("aieditor_worker_h", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_worker():
    import struct
    import wave
    from aieditor import config, graphics_long, llm
    from aieditor import sites as sites_mod
    W = load_worker()
    root = Path(tempfile.mkdtemp(prefix="handoff-wf-"))
    d = root / "job-handoff-test"
    d.mkdir()
    (d / "request.json").write_text(json.dumps({"id": d.name, "workflow": "creative", "format": "long", "sponsored": False,
                                                "handoff": True, "source": {"url": "x"}, "title": "T",
                                                "sites": [{"url": "https://example-tool.com/", "note": ""}]}))
    (d / "source.mp4").write_bytes(b"")
    (d / "source.json").write_text(json.dumps({"width": 1920, "height": 1080, "fps": 30.0, "fps_num": 30, "fps_den": 1,
                                               "duration": 12.0}))
    for f in ("audio16k.mp3", "full48k.wav"):
        (d / f).write_bytes(b"")
    with wave.open(str(d / "audio16k.wav"), "w") as wv:
        wv.setnchannels(1)
        wv.setsampwidth(2)
        wv.setframerate(16000)
        wv.writeframes(b"".join(struct.pack("<h", 1000 if (i // 4000) % 2 else -1000) for i in range(16000 * 12)))
    text = "Welcome back. Here is the example tool home page. It shows the dashboard right away. Thanks for watching."
    ws = [{"word": w, "start": round(0.2 + 0.5 * i, 3), "end": round(0.5 + 0.5 * i, 3)} for i, w in enumerate(text.split())]
    (d / "words.json").write_text(json.dumps({"words": ws, "repairs": []}))
    (d / "aligned.json").write_text(json.dumps({"words": ws}))
    calls = []

    def fake_transport(body, stream, timeout):
        props = ((body.get("output_config") or {}).get("format", {}).get("schema", {}) or {}).get("properties", {})
        if "overlays" in props:                   # the overlay call (its model may be the plan's: config)
            calls.append("overlays")
            ans = {"overlays": []}
        elif "segments" in props:                 # the plan call (route by schema: every call is Opus 5.5)
            calls.append("plan")
            ans = {"segments": [{"start_word": 2, "end_word": 13, "app": "web:example-tool.com", "session": "logged_in",
                                 "beats": [{"word_id": 4, "action": "camera.zoom", "body": "the home page, unzoomed",
                                            "subject": "screen", "text": None, "url": None, "asset_id": None, "live": False,
                                            "wait_end_word": None}]}],
                   "aroll": [], "plates": [], "needs_primitive": [{"sentence": "It shows the dashboard right away.",
                                                                   "word_ids": [10, 11], "why": "no proven action opens the dashboard",
                                                                   "proposed": None}]}
        elif "overlays" in props:
            calls.append("overlays")
            ans = {"overlays": []}
        else:
            calls.append("other")
            ans = {}
        return {"content": [{"type": "text", "text": json.dumps(ans)}], "stop_reason": "end_turn",
                "usage": {"input_tokens": 1000, "output_tokens": 200}}

    built = []
    saved = (llm.TRANSPORT, graphics_long.render, W.handoff.build, sites_mod.scout_tools)
    browser = []
    try:
        llm.TRANSPORT = fake_transport
        graphics_long.render = lambda w, evs, video, fps, **kw: []
        sites_mod.scout_tools = lambda: browser.append("scout") or []

        def fake_build(d_, k, v, fps, info, cancelled, progress, log, **kw):
            built.append((k, kw.get("aroll_codec")))
            (Path(d_) / f"handoff-{k:02d}.zip").write_bytes(b"PK")
            return {"note": "1 slot(s) for the editor, 3 graphic(s), zip 0.00 GB"}
        W.handoff.build = fake_build
        job = W.Job(d)
        check(list(job.st["stages"]) == handoff.STAGES, f"the hand-off stages only: {list(job.st['stages'])}")
        events.set_sink(job.event)
        try:
            W.run_job(job, "run")
        finally:
            events.set_sink(None)
    finally:
        llm.TRANSPORT, graphics_long.render, W.handoff.build, sites_mod.scout_tools = saved
    st = job.st["stages"]
    for s in ("timeline", "preprod", "assets", "graphics", "handoff"):
        check(st[s]["state"] == "done", f"{s} done: {st[s]}")
    check("no logged-in app" in st["assets"]["note"], f"a site without a picture producer: no pictures, never a stop: {st['assets']}")
    check("preview" not in st and "compose" not in st, "no preview / compose stage (nothing is recorded)")
    check(calls.count("overlays") == 1 and 1 <= calls.count("plan") <= 1 + config.PLAN_REASKS and "other" not in calls,
          f"one plan call (+ re-asks) and one overlay call: {calls}")
    pdoc = json.loads((d / "preprod" / "plan.json").read_text())
    check(pdoc["handoff"] and pdoc["held"] == [] and pdoc["editor_notes"], f"never held; notes for the brief: {pdoc['held']}")
    gate = json.loads((d / "preprod" / "gate.json").read_text())
    check(gate["status"] == "handoff" and gate["held"] == [] and gate["sites"][0]["scout"] is None, f"gate: {gate}")
    check(not (d / "held.json").exists(), "no held.json")
    direct = json.loads((d / "edit-01" / "direct.json").read_text())
    check(direct["handoff"] and direct["plan"]["segments"], "edit-01/direct.json = the hand-off plan")
    check(built == [(1, "h264")], f"the package was built once, H.264 A-roll by default: {built}")
    check(not browser, "no Scout lookup")
    check("slot" in st["preprod"]["note"] and st["preprod"]["cost_usd"] > 0, f"plan note + cost: {st['preprod']}")

    # a second run reuses the plan (no new call), rebuilds the package
    calls.clear()
    built.clear()
    saved = (llm.TRANSPORT, graphics_long.render, W.handoff.build)
    try:
        llm.TRANSPORT = fake_transport
        graphics_long.render = lambda w, evs, video, fps, **kw: []
        W.handoff.build = lambda *a, **kw: built.append(1) or {"note": "again"}
        job = W.Job(d)
        W.run_job(job, "render")
    finally:
        llm.TRANSPORT, graphics_long.render, W.handoff.build = saved
    check(calls == [] and built == [1], f"render reuses the plan, rebuilds the package: {calls} {built}")

    # Jake 2026-10-12: he CUTS words after the run (the Lab's transcript → plan.edit.json, queued "render"): the timeline
    # loses only those words (every other pause as recorded), the SAME plan is re-timed by code — no plan call, no
    # pictures — and the package is rebuilt; undoing the cut brings the original plan back
    def run_render():
        calls.clear()
        built.clear()
        saved_ = (llm.TRANSPORT, graphics_long.render, W.handoff.build)
        try:
            llm.TRANSPORT = fake_transport
            graphics_long.render = lambda w, evs, video, fps, **kw: []
            W.handoff.build = lambda *a, **kw: built.append(1) or {"note": "again"}
            W.run_job(W.Job(d), "render")
        finally:
            llm.TRANSPORT, graphics_long.render, W.handoff.build = saved_
    (d / "plan.edit.json").write_text(json.dumps({"videos": [{"title": "T", "segments": [
        {"s": 1, "drop": [4]}, {"s": 2, "drop": []}, {"s": 3, "drop": []}]}]}))
    run_render()
    e_ = json.loads((d / "edl.json").read_text())
    v_ = e_["videos"][0]
    check(v_["removed"] == [0, 1, 4] and 4 not in [w["i"] for w in v_["words"]] and v_["cuts"] >= 1,
          f"the timeline lost exactly his words: {v_.get('removed')}, {v_['cuts']} cut(s)")
    check(v_["duration"] < 12.0 and e_["cut_at"], f"shorter, and marked with the cut it was made from: {v_['duration']}")
    check(calls == [] and built == [1], f"no plan call (re-timed by code), the package rebuilt: {calls} {built}")
    pd_ = json.loads((d / "preprod" / "plan.json").read_text())
    beats_ = [b["word_id"] for sg in pd_["plan"]["answer"]["segments"] for b in sg.get("beats") or []]
    check(pd_.get("retimed") and 4 not in beats_ and pd_["original"]["answer"]["segments"][0]["beats"][0]["word_id"] == 4,
          f"the beat on a removed word goes; the original plan is kept: {beats_}")
    check(json.loads((d / "review.json").read_text())["edited"], "the transcript shows his cut")
    check(handoff.plan_fresh(d) and not handoff.can_retime(d), "the re-timed plan is current (a Continue makes no new plan)")
    (d / "plan.edit.json").unlink()
    run_render()
    v_ = json.loads((d / "edl.json").read_text())["videos"][0]
    pd_ = json.loads((d / "preprod" / "plan.json").read_text())
    check(not v_.get("removed") and v_["cuts"] == 0 and calls == [], "undo: the whole timeline again, still no plan call")
    check([b["word_id"] for sg in pd_["plan"]["answer"]["segments"] for b in sg.get("beats") or []] == [4],
          "undo: the original plan's beats come back")
    check(handoff.wanted({"handoff": True, "workflow": "creative", "format": "long"}), "wanted")
    check(not handoff.wanted({"handoff": True, "workflow": "cut", "format": "long"})
          and not handoff.wanted({"handoff": True, "workflow": "creative", "format": "short"}), "creative long-form only")


# ════════════════════════════ the smaller package: merged slots, one cropped bubble, cropped overlays ════════════════════════════

def test_package_maths():
    # merging: same app, no presenter between them (or < 2 s) → one slot; another app or a real gap → its own slot
    A = lambda t0, t1, app="chatgpt", **kw: {"t0": t0, "t1": t1, "app": app, "url": "https://chatgpt.com/", **kw}
    segs = [A(10, 20), A(20, 25), A(26.5, 30), A(33, 40), A(40, 45, "claude"), A(45, 50, "claude")]
    m = handoff.merge_segments(segs)
    check([(x["t0"], x["t1"], len(x["parts"])) for x in m] == [(10, 30, 3), (33, 40, 1), (40, 50, 2)],
          f"merged: {[(x['t0'], x['t1'], len(x['parts'])) for x in m]}")
    check(m[0]["parts"][1] is segs[1], "a merged slot keeps its parts (the brief's steps)")
    check(handoff.merge_segments([]) == [], "nothing to merge")

    # one bubble clip: every slot's piece back to back in the clip, abutting on the timeline
    fps = 30000 / 1001
    F = lambda t: int(round(t * fps))
    slots = [{"n": 1, "a": 1.0, "b": 5.0}, {"n": 2, "a": 4.9, "b": 8.0}, {"n": 3, "a": 20.0, "b": 25.0}]
    pcs = handoff.bubble_pieces(slots, F)
    check([p["in"] for p in pcs] == [0, pcs[0]["frames"], pcs[0]["frames"] + pcs[1]["frames"]], "pieces back to back")
    check(pcs[0]["start"] + pcs[0]["frames"] == pcs[1]["start"], "back-to-back slots abut, no overlap")
    check(pcs[2]["start"] == F(20.0) and pcs[2]["frames"] == F(25.0) - F(20.0), "a piece = its slot's frames")

    # an overlay's content box → an even crop, or full frame when it covers most of the frame
    check(handoff.crop_box([101, 51, 301, 151], 1920, 1080) == (100, 50, 202, 102), "even crop around the box")
    check(handoff.crop_box([0, 0, 1900, 1000], 1920, 1080) is None, "a near full-frame overlay stays full frame")
    check(handoff.crop_box(None, 1920, 1080) is None, "no content → full frame")

    # placement maths: Premiere XML center + FCPXML position put the cropped bubble back where compose puts it
    W, H, side = 3840, 2160, 806
    P = compose_long.FACECAM
    bx, by = int(round(P["centre"][0] * 2 - side / 2)), int(round(P["centre"][1] * 2 - side / 2))
    hz, vt = nlexml.xmeml_center(bx, by, side, side, W, H)
    check(all(abs(a - b) < 1e-6 for a, b in zip(nlexml.from_xmeml_center(hz, vt, side, side, W, H), (bx, by))),
          "xmeml center round-trips to the bubble's top-left")
    check(hz > 0 and vt < 0, "the bubble is right of and above the centre (y down)")
    check(abs(nlexml.xmeml_center(0, 0, W, H, W, H)[0]) < 1e-9, "a full-frame clip sits at the centre")
    px, py = nlexml.fcpxml_position(bx, by, side, side, W, H)
    check(all(abs(a - b) < 1e-6 for a, b in zip(nlexml.from_fcpxml_position(px, py, side, side, W, H), (bx, by))),
          "fcpxml position round-trips")
    check(py > 0 and abs(px - (bx + side / 2 - W / 2) / H * 100) < 1e-9, "FCPXML: % of the frame height, y up")
    total = 1800
    pieces = [{"group": "bubble", "name": "03-facecam-bubble (slot 1)", "file": "graphics/03-facecam-bubble.mov", "start": 400,
               "frames": 300, "in": 0, "media_frames": 600, "alpha": True, "x": bx, "y": by, "width": side, "height": side},
              {"group": "bubble", "name": "03-facecam-bubble (slot 2)", "file": "graphics/03-facecam-bubble.mov", "start": 900,
               "frames": 300, "in": 300, "media_frames": 600, "alpha": True, "x": bx, "y": by, "width": side, "height": side},
              {"group": "overlay", "name": "04-keyword", "file": "graphics/04-keyword.mov", "start": 100, "frames": 60,
               "media_frames": 60, "alpha": True, "x": 200, "y": 1600, "width": 1200, "height": 300}]
    slots_tl = [{"n": 1, "label": "a", "start": 400, "frames": 300}, {"n": 2, "label": "b", "start": 900, "frames": 300}]
    tl, fcp = handoff.timeline_model("T", 30000, 1001, W, H, total, total, pieces, slots_tl, [], total)
    check(nlexml.check(tl) == [], f"sane: {nlexml.check(tl)}")
    xm = nlexml.xmeml(tl)
    check(nlexml.validate_xmeml(xm) == [], f"xmeml valid: {nlexml.validate_xmeml(xm)}")
    root = ET.fromstring(xm)
    bub = [c for c in root.iter("clipitem") if c.findtext("name", "").startswith("03-facecam-bubble")]
    check(len(bub) == 2 and {c.findtext("file/pathurl") for c in bub} == {"graphics/03-facecam-bubble.mov"},
          "ONE bubble file, one clip per slot")
    check([(c.findtext("in"), c.findtext("out")) for c in bub] == [("0", "300"), ("300", "600")], "each piece's in-point")
    for c in bub:
        eff = c.find("filter/effect")
        check(eff is not None and eff.findtext("effectid") == "basic", "Basic Motion on the bubble")
        params = {p.findtext("parameterid"): p for p in eff.findall("parameter")}
        check(params["scale"].findtext("value") == "100", "scale 100 (native size)")
        h_, v_ = float(params["center"].findtext("value/horiz")), float(params["center"].findtext("value/vert"))
        x_, y_ = nlexml.from_xmeml_center(h_, v_, side, side, W, H)
        check(abs(x_ - bx) < 0.01 and abs(y_ - by) < 0.01, f"Premiere XML places it at ({x_:.2f}, {y_:.2f}) = ({bx}, {by})")
        check(c.findtext("file/media/video/samplecharacteristics/width") == str(side), "the file's own size")
    fx = nlexml.fcpxml(fcp)
    check(nlexml.validate_fcpxml(fx) == [], f"fcpxml valid: {nlexml.validate_fcpxml(fx)}")
    froot = ET.fromstring(fx)
    fmts = {f.get("id"): f for f in froot.iter("format")}
    check(len(fmts) == 3 and [f.tag for f in froot.find("resources")][:3] == ["format"] * 3,
          "a format per media size, all before the assets")
    basset = next(a for a in froot.iter("asset") if a.get("name") == "03-facecam-bubble")
    check(fmts[basset.get("format")].get("width") == str(side), "the bubble asset has its own (cropped) format")
    for c in [c for c in froot.iter("asset-clip") if c.get("name", "").startswith("03-facecam-bubble")]:
        check(c.find("adjust-conform").get("type") == "none", "FCPXML: no fit to the frame")
        tx, ty = (float(v) for v in c.find("adjust-transform").get("position").split())
        x_, y_ = nlexml.from_fcpxml_position(tx, ty, side, side, W, H)
        check(abs(x_ - bx) < 0.01 and abs(y_ - by) < 0.01, f"FCPXML places it at ({x_:.2f}, {y_:.2f}) = ({bx}, {by})")
    kw = next(c for c in froot.iter("asset-clip") if c.get("name") == "04-keyword")
    tx, ty = (float(v) for v in kw.find("adjust-transform").get("position").split())
    check(all(abs(a - b) < 0.01 for a, b in zip(nlexml.from_fcpxml_position(tx, ty, 1200, 300, W, H), (200, 1600))),
          "a cropped overlay at its box")


def test_screen_templates():
    """Jake 2026-10-12: the graphics-only lane uses our motion templates for what goes on screen — OPTIONAL for the
    editor (own track, OFF), shown in the preview; a step with nothing to show keeps its card."""
    words = [{"i": i, "word": w, "start": 10 + i * 0.4, "end": 10.3 + i * 0.4} for i, w in enumerate(
        "now type a hot sauce bottle on a picnic table and send it".split())]
    video = {"title": "T", "duration": 60.0, "words": words, "script": ""}
    segs = [{"t0": 10.0, "t1": 18.0, "app": "chatgpt", "beats": [
                {"action": "show"}, {"action": "type", "params": {"text": "A hot sauce bottle on a picnic table"}}]},
            {"t0": 30.0, "t1": 36.0, "app": "chatgpt", "beats": [{"action": "show"}, {"action": "show"}]}]
    evs = handoff.screen_templates(segs, video, None, log=lambda *a: None)
    from aieditor import motiontemplates as MT
    if any(MT.is_on(t) for t in ("prompt_highlight", "long_prompt_scroll", "prompt_menu", "prompt_card_3d")):
        check(len(evs) == 1 and evs[0]["screen_template"]["seg"] == 0, f"only the step with his words gets one: {evs}")
        check(evs[0]["fields"]["prompt"] == "A hot sauce bottle on a picnic table", "his prompt, verbatim")
        check("fallback" not in evs[0] and evs[0]["t0"] == 10.0, "marked as a screen template, timed on its step")
    # the timeline: its own track right above the editor's screencasts, every clip OFF (both formats)
    g = [{"group": "screen", "name": "01-screen-template-slot-01-prompt_highlight",
          "file": "graphics/01-screen-template-slot-01-prompt_highlight.mov", "start": 300, "frames": 240,
          "media_frames": 240, "alpha": True, "enabled": False}]
    slots = [{"n": 1, "label": "type the prompt", "start": 300, "frames": 300, "note": ""}]
    tl, fcp = handoff.timeline_model("T", 30000, 1001, 1920, 1080, 1800, 1800, g, slots, [], 1800)
    check(tl["video"][2]["name"] == handoff.SCREEN_TRACK and tl["video"][1]["name"] == "Screencasts (editor)",
          f"the optional track sits right above the editor's: {[t['name'] for t in tl['video']]}")
    check(tl["video"][1]["clips"] == [], "the editor's screencast track stays empty")
    xm, fx = nlexml.xmeml(tl), nlexml.fcpxml(fcp)
    check(not nlexml.validate_xmeml(xm) and not nlexml.validate_fcpxml(fx), "both timelines still validate")
    clip = [c for c in ET.fromstring(xm).iter("clipitem") if "screen-template" in (c.findtext("name") or "")]
    check(clip and clip[0].findtext("enabled") == "FALSE", "Premiere: the template clip is OFF")
    check('enabled="0"' in fx and "screen-template" in fx, "FCPXML: the template clip is OFF")
    # the brief names it per slot
    rows = [{"slot": 1, "label": "x", "start_tc": "00:00:10:00", "end_tc": "00:00:18:00", "duration_s": 8.0, "start_s": 10.0, "end_s": 18.0, "enter": "cut in",
             "exit": "runs to the end", "app": "chatgpt", "url": "", "logged_out_us": False, "words": "w", "on_screen": "",
             "steps": [], "beats": [], "zoom": [], "flags": ["Privacy"], "notes": [],
             "template": "graphics/01-screen-template-slot-01-prompt_highlight.mov"}]
    page = handoff.brief_html(rows, {"title": "T", "width": 1920, "height": 1080, "fps_label": "29.97 fps"})
    check("Optional motion template" in page and "switched off" in page and "preview shows it" in page, "the brief says it is optional")
    check(list(csv.reader(io.StringIO(handoff.slots_csv(rows))))[1][-1].endswith("prompt_highlight.mov"), "slots.csv lists it")


def test_assets():
    """Jake 2026-10-12: the graphics-only lane makes the pre-production pictures as a full run does (the asset agent in
    the logged-in app, the picture needs only) and the package carries them in assets/."""
    from aieditor import agentrec, cloud, onboard, preflight, preprod, rehearse
    plan = {"answer": {"segments": [{"beats": [
        {"asset_id": "hook_sketch", "new_asset": "Rough mouse sketch of a hot sauce bottle", "word_id": 3, "subject": "asset:hook_sketch"},
        {"asset_id": "hook_photo", "new_asset": "ChatGPT's realistic photo of the sketch", "word_id": 9},
        {"subject": "asset:hook_photo", "word_id": 12},
        {"subject": "asset:mystery", "word_id": 14}]}]},
        "needs_primitive": [{"code": "onboard", "why": "the Markup tool"}]}
    rows, bare = handoff.asset_needs(plan)
    check([r["proposed"]["asset_id"] for r in rows] == ["hook_sketch", "hook_photo"] and all(r["group"] == "B" for r in rows),
          f"each described picture once, as a P3 row; screencast needs are not pictures: {rows}")
    check(rows[1]["proposed"]["word_id"] == 9 and bare == ["mystery"], f"its first describing beat; a bare id is listed: {bare}")
    # the login: a graphics-only job uses the logged-in app for its pictures — unless it asks for none
    r = {"workflow": "creative", "handoff": True}
    check(cloud.logged_in_job(r, "run") and not cloud.logged_in_job({**r, "handoff_assets": False}, "run"),
          "graphics only + pictures → logged in; handoff_assets false → no login")
    check(handoff.assets_wanted({}) and not handoff.assets_wanted({"handoff_assets": False}), "pictures on by default")

    # make_assets end to end with fakes: readiness → manifest → the router with the picture needs ONLY → assets.json
    d = Path(tempfile.mkdtemp(prefix="handoff-assets-"))
    (d / "preprod" / "assets").mkdir(parents=True)
    pdoc = {"plan": plan, "handoff": True, "sites": [{"url": "https://chatgpt.com/"}]}
    (d / "preprod" / "plan.json").write_text(json.dumps(pdoc))
    edl_ = {"videos": [{"title": "T", "duration": 20.0, "words": [{"i": i, "word": "w", "start": i * 0.5, "end": i * 0.5 + 0.4} for i in range(30)]}]}
    pic = d / "preprod" / "assets" / "hook_photo.png"
    pic.write_bytes(b"\x89PNG fake")
    seen = {}

    class App:
        site = "https://chatgpt.com/"
        def readiness(self, p, out):
            return [{"id": x, "status": "pass"} for x in preprod.REQUIRED_GLOBAL]

    class Probe:
        scout = {"slug": "chatgpt", "logged_in_at": "now"}
        def __init__(self, *a, **k): pass
        def close(self): pass

    def fake_route(ctx, pd, video, sites, assets, facts_fn, held_reasons=None):
        seen["rows"] = pd["plan"]["needs_primitive"]
        assets["assets"].append({"id": "hook_photo", "status": "ready", "file": str(pic), "kind": "app_generation",
                                 "desc": "ChatGPT's realistic photo", "prompt": "Turn this rough sketch into a realistic photo",
                                 "source": {"type": "in-app generation (off camera, asset agent)"}})
        assets["assets"].append({"id": "hook_sketch", "status": "needs_asset", "why": "4 tries failed"})
        return {"plan": {"rewritten": True}, "held": [{"detail": "hook_sketch: 4 tries failed"}], "usd": 0.42}
    saved = (agentrec.scout_for, preprod.adapter_for, preprod.Probe, preprod.asset_manifest, preprod.build_assets,
             preprod.make_ctx, onboard.route, preflight.headroom, rehearse.mode)
    try:
        agentrec.scout_for = lambda url: {"slug": "chatgpt", "profile": "/x"}
        preprod.adapter_for = lambda url: App() if "chatgpt" in url else None
        preprod.Probe = Probe
        preprod.asset_manifest = lambda job: {"shots": [], "assets": [], "objects": []}
        preprod.build_assets = lambda man, out, el, budget, app=None: {"assets": [], "image_api_usd": 0}
        preprod.make_ctx = lambda *a, **k: object()
        onboard.route = fake_route
        preflight.headroom = lambda *a, **k: None
        rehearse.mode = lambda: "agent"
        out = handoff.make_assets(d, {"handoff": True, "workflow": "creative"}, edl_, log=lambda *a: None)
    finally:
        (agentrec.scout_for, preprod.adapter_for, preprod.Probe, preprod.asset_manifest, preprod.build_assets,
         preprod.make_ctx, onboard.route, preflight.headroom, rehearse.mode) = saved
    check([r["proposed"]["asset_id"] for r in seen["rows"]] == ["hook_sketch", "hook_photo"], f"the router got the pictures only: {seen}")
    check(json.loads((d / "preprod" / "plan.json").read_text()) == pdoc, "the hand-off plan is NOT rewritten by the router")
    check(out["usd"] == 0.42 and "1 picture(s) ready" in out["note"] and "1 could not" in out["note"], f"note: {out}")
    check(handoff.assets_fresh(d), "the mark makes the stage reusable")
    # new pictures → the overlays (screen templates with the real result) are made again
    (d / "edit-01").mkdir()
    (d / "edit-01" / "overlays.json").write_text("[]")
    (d / "edit-01" / "direct.json").write_text("{}")
    os.utime(d / "edit-01" / "overlays.json", (1, 1))
    check(not handoff.overlays_fresh(d, 1), "overlays older than the pictures are rendered again")
    # the package: every ready picture + what it is; a failed one listed with why
    n = handoff.package_assets(d, d / "pkg" / "assets")
    check(n == 1 and (d / "pkg" / "assets" / "hook_photo.png").read_bytes() == pic.read_bytes(), "the ready picture is copied")
    rows_ = list(csv.reader(io.StringIO((d / "pkg" / "assets" / "assets.csv").read_text())))
    check(rows_[1][0] == "hook_photo.png" and "realistic photo" in rows_[1][4] and rows_[2][6] == "4 tries failed",
          f"assets.csv: what it shows, its prompt; a failed one with why: {rows_}")
    check(handoff.package_assets(Path(tempfile.mkdtemp()), d / "none") == 0 and not (d / "none").exists(), "no pictures → no folder")


def test_creative_cut():
    """edl.creative_cut: only his removed words go; every other pause stays as recorded."""
    from aieditor import edl
    ws = [{"i": i, "w": f"w{i}", "s": s_, "e": e_} for i, (s_, e_) in enumerate(
        [(0.5, 0.9), (1.0, 1.4), (2.4, 2.8), (2.9, 3.3), (5.0, 5.4), (5.5, 5.9)])]
    by = {w["i"]: w for w in ws}
    full = edl.passthrough(ws, by, 8.0, 30.0)
    same = edl.creative_cut(ws, by, 8.0, 30.0, [])
    check(same["duration"] == full["duration"] and same["cuts"] == 0, "no cut = the whole timeline")
    v = edl.creative_cut(ws, by, 8.0, 30.0, [2, 3])
    check(v["cuts"] == 1 and [w["i"] for w in v["words"]] == [0, 1, 4, 5], f"two pieces, his words gone: {v['words']}")
    a_end = v["pieces"][0]["src_b"] if "src_b" in v["pieces"][0] else None
    gap = next(w for w in v["words"] if w["i"] == 4)["start"] - next(w for w in v["words"] if w["i"] == 1)["end"]
    check(0.3 <= gap <= 0.42, f"the join keeps ~0.21 + 0.14 s of his own silence (whole frames): {gap:.3f}")
    w1 = next(w for w in v["words"] if w["i"] == 1)
    w0 = next(w for w in v["words"] if w["i"] == 0)
    check(abs((w1["start"] - w0["end"]) - 0.1) < 0.04, "a pause he did not cut is untouched")
    tail = edl.creative_cut(ws, by, 8.0, 30.0, [5])
    check(tail["cuts"] == 0 and tail["words"][-1]["i"] == 4 and tail["duration"] < 6.0, "a cut at the end just ends earlier")
    try:
        edl.creative_cut(ws, by, 8.0, 30.0, [w["i"] for w in ws])
        check(False, "cutting every word must fail")
    except ValueError:
        pass
    # snapping the plan to the words that are left
    ans = {"segments": [{"start_word": 1, "end_word": 4, "beats": [{"word_id": 2}, {"word_id": 4, "wait_end_word": 3}]},
                        {"start_word": 2, "end_word": 3, "beats": []}],
           "aroll": [{"start_word": 0, "end_word": 1}]}
    a2, o2, n = handoff.snap_answer(ans, [{"template": "x", "start": 2, "end": 3}, {"template": "y", "start": 3, "end": 5}], {0, 1, 4, 5})
    check([(s_["start_word"], s_["end_word"]) for s_ in a2["segments"]] == [(1, 4)] and n["segments"] == 1,
          f"spans snap inward; one with nothing left goes: {a2['segments']}")
    check(a2["segments"][0]["beats"] == [{"word_id": 4, "wait_end_word": None}] and n["beats"] == 1, "beats on removed words go")
    check([(o["start"], o["end"]) for o in o2] == [(4, 5)] and n["overlays"] == 1, f"overlays snap / go: {o2}")


if __name__ == "__main__":
    test_nlexml()
    test_slots_and_brief()
    test_package_maths()
    test_worker()
    test_screen_templates()
    test_assets()
    test_creative_cut()
    print(f"test_handoff: {N} checks passed")
