"""The two workflows + the structured event log, with every docker / API call stubbed.

  workflow "creative" (Creative Edit an edited narration): no takes/cut/sound check, the
      whole timeline is kept (edl.passthrough), "preprod" (aieditor/preprod.py) decides what can be screencast
      does not exist and CALLED when it does
  workflow "cut" (the default): takes → cut → listen, as before
  events.jsonl: every line is JSON, filed under the stage it happened in; API calls carry
      model + $; per-stage cost / progress land in status.json

Run: python3 tests/test_workflows.py
"""
import importlib.machinery
import importlib.util
import json
import struct
import sys
import tempfile
import types
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import edl, events  # noqa: E402

N = 0


def check(cond, msg):
    global N
    N += 1
    if not cond:
        raise AssertionError(msg)


def load_worker():
    loader = importlib.machinery.SourceFileLoader("aieditor_worker", str(ROOT / "bin" / "aieditor-worker"))
    spec = importlib.util.spec_from_loader("aieditor_worker", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def write_wav(path, seconds):
    with wave.open(str(path), "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        frames = bytearray()
        for i in range(int(seconds * 16000)):
            v = 3000 if (i // 4000) % 2 == 0 else 20          # 0.25 s "speech", 0.25 s quiet
            frames += struct.pack("<h", v if i % 2 else -v)
        w.writeframes(bytes(frames))


def make_job(root, workflow, fmt="long"):
    d = Path(tempfile.mkdtemp(dir=root))
    req = {"id": d.name, "format": fmt, "sponsored": False, "source": {"url": "x"}, "title": "T"}
    if workflow:
        req["workflow"] = workflow
    (d / "request.json").write_text(json.dumps(req))
    (d / "source.mp4").write_bytes(b"")
    fps = 30.0
    (d / "source.json").write_text(json.dumps({"width": 1920, "height": 1080, "fps": fps, "fps_num": 30,
                                                "fps_den": 1, "duration": 6.0}))
    for f in ("audio16k.mp3", "full48k.wav"):
        (d / f).write_bytes(b"")
    write_wav(d / "audio16k.wav", 6.0)
    texts = "Hello there. This is the edited narration. It stays exactly as it is.".split()
    ws, t = [], 0.1
    for k, w in enumerate(texts):
        ws.append({"word": w, "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += 0.45
    (d / "words.json").write_text(json.dumps({"words": ws, "repairs": []}))
    (d / "aligned.json").write_text(json.dumps({"words": ws}))
    return d


def read_events(d):
    out = []
    for line in (d / "events.jsonl").read_text().splitlines():
        out.append(json.loads(line))                       # every line must be JSON
    return out


def preprod_factory(root):
    """G2: preprod.run for a factory request runs the FULL pre-production with a fake adapter (no
    browser, no Claude, no image API) and writes the six files; every shot-list beat sits on its edl word."""
    from aieditor import agentrec, preprod
    from aieditor import sites as sites_mod
    d = Path(tempfile.mkdtemp(dir=root))
    text = ("Now look at this, a bottle I drew. Here's the one I'm using, a phone photo of a hot sauce bottle. "
            "Now let's draw the scene. I want a squat bottle in the middle, a wonky sun up in the top right corner. "
            "I see a stray napkin sitting next to the bottle and I want it gone. Click the erase feature.").split()
    ws, t = [], 0.2
    for k, w in enumerate(text):
        ws.append({"i": k, "word": w, "start": round(t, 3), "end": round(t + 0.3, 3)})
        t += 0.42
    req = {"id": d.name, "workflow": "creative", "format": "long", "sites": [{"url": "https://chatgpt.com/", "note": ""}]}
    (d / "request.json").write_text(json.dumps(req))
    edl_doc = {"fps": 30.0, "videos": [{"title": "T", "duration": round(t + 0.5, 2), "words": ws, "pieces": []}]}
    (d / "edl.json").write_text(json.dumps(edl_doc))
    sents = preprod.takes.sentences([{"i": w["i"], "w": w["word"], "s": w["start"], "e": w["end"]} for w in ws])
    sid = lambda word: next(n for n, s in enumerate(sents) if any(x["w"].strip(".,") == word for x in s))
    nap = next(w for w in ws if w["word"] == "napkin")
    sun = next(w for w in ws if w["word"] == "sun")

    def fake_call(content, system, **kw):
        shots = [{"id": "R1-01", "sentences": list(range(sid("napkin"))), "kind": "screencast", "opens_on": "fresh_chat",
                  "beats": [{"word_id": sun["i"], "action": "read", "target": "image:doodle", "what": "zoom on the sun",
                             "technique_ids": ["ZM05"]}], "transition_in": "CUT05", "needs": ["photo", "doodle"]},
                 {"id": "R1-02", "sentences": list(range(sid("napkin"), len(sents))), "kind": "screencast",
                  "opens_on": "fresh_chat", "beats": [{"word_id": nap["i"], "action": "read", "target": "image:photo",
                                                       "what": "zoom on the napkin", "technique_ids": ["ZM05"]}],
                  "transition_in": "CUT05", "needs": ["photo"]}]
        assets = [{"id": "photo", "kind": "photo", "desc": "phone photo of a hot sauce bottle", "prompt": "a hot sauce bottle on a counter"},
                  {"id": "doodle", "kind": "sketch", "desc": "mouse doodle", "doodle": [{"shape": "bottle", "box": [400, 300, 230, 400]}]}]
        return {"shots": shots, "assets": assets}, {"usd": 0.01, "seconds": 0}

    class P:
        scout = {"slug": "chatgpt", "logged_in_at": 1}

        def close(self):
            pass

    class Fake(preprod.ChatGPT):
        def probe(self, workdir):
            return P()

        def readiness(self, p, out):
            ok = ["logged_in", "plan", "theme_dark", "chat_mode", "upload", "sketch_plus_menu", "tb_erase"]
            return ([{"id": c, "label": c, "status": "pass", "where": {"text": c}} for c in ok]
                    + [{"id": "at_sketch", "label": "@Sketch", "status": "not_found", "note": "no @ picker"}]
                    + [dict(c) for c in self.STATIC_CHECKS])

        def dry_run(self, job, sl, assets, setd, out, max_gens):
            return {"generations_used": 0, "actions": [], "produced": {},
                    "set_dressing": [{"shot": x["shot"], "ok": True, "steps": []} for x in setd["segments"]]}

    saved = (preprod.director.call, preprod.gen_photo, preprod.rasterize, sites_mod.resolve, agentrec.scout_for)
    prof = d / "profile"
    (prof / "Default").mkdir(parents=True)
    try:
        preprod.director.call = fake_call
        preprod.gen_photo = lambda prompt, dst, **kw: (Path(dst).write_bytes(b"\x89PNG"), 0.0)[1]
        preprod.rasterize = lambda src, dst, w, h: (Path(dst).write_bytes(b"\x89PNG"), Path(dst))[1]
        sites_mod.resolve = lambda d_, r_, v_, log=print: ([{"url": "https://chatgpt.com/", "note": ""}], 0.0)
        agentrec.scout_for = lambda url: {"slug": "chatgpt", "profile": str(prof), "logged_in_at": 1, "report": ""}
        res = preprod.run(d, adapter=Fake(), log=lambda m: None)
    finally:
        (preprod.director.call, preprod.gen_photo, preprod.rasterize, sites_mod.resolve, agentrec.scout_for) = saved
    out = d / "preprod"
    for f in ("readiness.json", "shotlist.json", "assets.json", "set_dressing.json", "dryrun.json", "expect.json"):
        check((out / f).exists(), f"factory pre-production wrote {f}")
    sl = json.loads((out / "shotlist.json").read_text())
    beats = [b for sh in sl["shots"] for b in sh["beats"]]
    check(beats and all(b["t_word"] == ws[b["word_id"]]["start"] for b in beats), "every beat on its edl word start")
    check(all({"clause_start", "subject", "technique_id", "must_text", "typed_text", "result_assertion"} <= set(b) for b in beats),
          "ledger fields on every beat")
    rd = json.loads((out / "readiness.json").read_text())
    feats = {f["id"]: f for f in rd["features"]}
    check(feats["at_sketch"]["exists"] is False and feats["at_sketch"]["alternative"], "features: @Sketch missing, '+' route")
    check(feats["pricing_in_app"]["alternative"]["route"] == "public", "features: pricing → public page")
    objs = {o["object"]: o for o in json.loads((out / "assets.json").read_text())["objects"]}
    check(objs["napkin"]["asset"] == "photo" and objs["napkin"]["status"] == "added", f"napkin produced in the photo: {objs.get('napkin')}")
    check(objs["sun"]["asset"] == "doodle", f"the drawn sun goes into the doodle: {objs.get('sun')}")
    a = {x["id"]: x for x in json.loads((out / "assets.json").read_text())["assets"]}
    check("napkin" in a["photo"]["source"]["prompt"], "the photo is generated with the napkin in it")
    g = json.loads((out / "gate.json").read_text())
    check(g["sites"] and g["flow"]["files"] and res["usd"] >= 0.01, f"gate keeps the sites + the flow: {g.get('flow')}")


def main():
    W = load_worker()
    rendered = []

    def fake_render(job, video, fps, out_name, size, **kw):
        with events.proc(f"render {out_name}"):
            Path(job, f"{out_name}.mp4").write_bytes(b"x")
        rendered.append(out_name)
        return Path(job, f"{out_name}.mp4")

    W.render.render = fake_render
    calls = {"plan": 0}

    def fake_plan(d, k, v, sites, sponsored, fps, progress, cancelled, log):
        calls["plan"] += 1
        progress("Claude is planning the edit…", 0.1)
        events.api("claude-opus-5-5", 0.25, 3.0, "Claude director (high effort)",
                   {"input_tokens": 1000, "output_tokens": 500})
        for i in range(2):
            events.set_sub(f"screencast {i + 1}/2")
            events.emit("step", f"agent step 1 of screencast {i + 1}")
            log(f"edit {k}: screencast {i + 1} recording stopped early: test")   # a warning
        events.set_sub(None)
        return "2 screencast(s), 0 overlay(s)", 0.25

    W.longedit.plan_and_record = fake_plan
    W.longedit.compose = lambda d, k, base, fps, size, cancelled, progress, out_name, **kw: Path(d, f"{out_name}.mp4").write_bytes(b"x")

    # pre-production derives the sites from the narration: no Scout app, no Claude call here
    from aieditor import sites as sites_mod
    sites_mod.scout_tools = lambda: []
    asked = []
    sites_mod._ask_claude = lambda text: (asked.append(text) or ({"tools": []}, 0.01))
    seen_sites = []
    _fp = fake_plan

    def fake_plan2(d, k, v, sites, *a):
        seen_sites.append(list(sites))
        return _fp(d, k, v, sites, *a)
    W.longedit.plan_and_record = fake_plan2

    with tempfile.TemporaryDirectory() as root:
        root = Path(root)

        # ── workflow 2: creative ──
        d = make_job(root, "creative")
        job = W.Job(d)
        check(set(job.st["stages"]) >= set(W.CREATIVE_STAGES), "creative job carries the creative stages")
        check("takes" not in job.st["stages"] and "listen" not in job.st["stages"], "no takes/listen stage in creative")
        events.set_sink(job.event)
        try:
            W.run_job(job, "run")
        finally:
            events.set_sink(None)
        st = job.st["stages"]
        check(st["timeline"]["state"] == "done", f"timeline done: {st['timeline']}")
        check(st["preprod"]["state"] == "done", f"preprod ran: {st['preprod']}")
        gate = json.loads((d / "preprod" / "gate.json").read_text())
        check(gate["status"] == "aroll_only" and gate["sites"] == [], f"nothing to screencast → A-roll gate: {gate}")
        check(asked and "edited narration" in asked[0], "the narration was read to find the tools")
        check(seen_sites == [[]], f"the edit got the gate's (empty) sites: {seen_sites}")
        check("A-roll + overlays only" in (d / "log.txt").read_text(), "the job log says there is no screencast")
        check(st["preview"]["state"] == "done" and st["graphics"]["state"] == "done" and st["compose"]["state"] == "done",
              "preview + graphics + compose ran")
        check(not (d / "listen-01.mp4").exists() and "listen-01" not in rendered, "no sound check in creative")
        e = json.loads((d / "edl.json").read_text())
        v = e["videos"][0]
        check(v["cuts"] == 0 and len(v["pieces"]) == 1, "one piece, no cuts")
        check(v["pieces"][0]["src_frame"] == 0 and v["pieces"][0]["frames"] == 180, f"whole timeline: {v['pieces'][0]['frames']}")
        check(len(v["words"]) == 13, "every word kept")
        rv = json.loads((d / "review.json").read_text())
        check(len(rv["videos"][0]["segments"]) == len(rv["sentences"]) and not rv["reasons"], "review: all sentences kept")
        evs = read_events(d)
        check(all({"t", "stage", "kind", "level", "msg"} <= set(x) for x in evs), "event fields")
        api = [x for x in evs if x["kind"] == "api"]
        check(api and api[0]["stage"] == "graphics" and api[0]["model"] == "claude-opus-5-5" and api[0]["usd"] == 0.25,
              f"API call filed under graphics with model + $: {api}")
        check(st["graphics"]["cost_usd"] == 0.25 and st["graphics"]["api_calls"] == 1, f"stage cost: {st['graphics']}")
        check(st["graphics"].get("warnings", 0) == 2, f"two warnings counted: {st['graphics']}")
        subs = {x.get("sub") for x in evs if x["stage"] == "graphics"}
        check({"screencast 1/2", "screencast 2/2"} <= subs, f"sub-processes grouped: {subs}")
        procs = [x for x in evs if x["kind"] == "proc" and x["stage"] == "preview"]
        check(len(procs) == 2 and procs[-1]["phase"] == "done", f"render proc start/done under preview: {procs}")
        stage_evs = [x for x in evs if x["kind"] == "stage"]
        check(any(x["stage"] == "preprod" and x["state"] == "done" for x in stage_evs), "preprod done event")
        check(abs(job.st["cost_live_usd"] - 0.26) < 1e-6, f"live cost {job.st.get('cost_live_usd')}")

        # preprod present → called, with only the kwargs it names; its $ joins the cost
        got = {}
        fake = types.ModuleType("aieditor.preprod")

        def run(job_dir, req, progress, log):
            got.update(dir=job_dir, fmt=req["format"])
            progress("brief written", 0.5)
            log("preprod: wrote preprod.json")
            return "brief + shot list", 0.1
        fake.run = run
        sys.modules["aieditor.preprod"] = fake
        try:
            job2 = W.Job(d)
            events.set_sink(job2.event)
            try:
                W.run_preprod(job2, job2.req, json.loads((d / "source.json").read_text()), 30.0)
            finally:
                events.set_sink(None)
        finally:
            del sys.modules["aieditor.preprod"]
        check(got == {"dir": d, "fmt": "long"}, f"preprod called: {got}")
        check(job2.st["stages"]["preprod"]["state"] == "done" and "brief + shot list" in job2.st["stages"]["preprod"]["note"],
              f"preprod done: {job2.st['stages']['preprod']}")
        check(abs(job2.st["stages"]["preprod"]["cost_usd"] - 0.1) < 1e-6, "preprod cost on its stage")

        # ── workflow 1: cut (no "workflow" field = the default, as every older job) ──
        d = make_job(root, None)
        job = W.Job(d)
        check("takes" in job.st["stages"] and "timeline" not in job.st["stages"], "cut job carries the cut stages")

        def fake_pick(words, sents, feats, fmt, sponsored, script):
            events.api("claude-opus-5-5", 0.5, 10, "Claude (high effort)", {"input_tokens": 9, "output_tokens": 9})
            plan = {"videos": [{"title": "V", "segments": [{"s": 0, "drop": []}, {"s": 2, "drop": []}]}],
                    "removed": [{"s": 1, "why": "retake"}], "notes": ""}
            return plan, "{}", {"usd": 0.5, "seconds": 10}
        W.takes.pick = fake_pick
        W.takes.features = lambda sents, audio: []
        events.set_sink(job.event)
        try:
            W.run_job(job, "run")
        finally:
            events.set_sink(None)
        st = job.st["stages"]
        for s in ("takes", "cut", "listen", "preview", "graphics", "compose"):
            check(st[s]["state"] == "done", f"cut path: {s} {st[s]}")
        check(st["takes"]["cost_usd"] == 0.5, f"takes cost {st['takes']}")
        check("listen-01" in rendered, "sound check rendered")
        e = json.loads((d / "edl.json").read_text())
        check(e["videos"][0]["cuts"] >= 1, "the cut path cuts")
        evs = read_events(d)
        check(any(x["kind"] == "api" and x["stage"] == "takes" for x in evs), "takes API call logged")

        preprod_factory(root)

    print(f"test_workflows: {N} checks passed")


if __name__ == "__main__":
    main()
