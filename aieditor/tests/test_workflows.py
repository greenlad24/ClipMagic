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
import os  # noqa: E402
# never the live API ledger / caps: preprod_factory's fake Claude calls are priced and logged like real ones
os.environ.setdefault("AIEDITOR_API_LEDGER", str(Path(tempfile.mkdtemp(prefix="wf-ledger-")) / "api.jsonl"))
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
    """G2 + p6: preprod.run for a factory request runs the FULL pre-production with a fake adapter and a fake
    Claude transport (no browser, no API, no image API) in the recommended ORDER — readiness → assets (content
    first: manifest from the narration, generation check) → ONE Opus plan call → plan check → ONE Sonnet overlay
    call — and writes its files; every plan beat sits on its edl word."""
    from aieditor import agentrec, config, llm, preprod
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
    wid = lambda word: next(w["i"] for w in ws if w["word"].strip(".,") == word)
    calls = []

    def fake_transport(body, stream, timeout):
        fmt = (body.get("output_config") or {}).get("format", {}).get("schema", {})
        props = fmt.get("properties", {})
        if "segments" in props:                   # the plan call (every call is Opus 5.5 — route by its schema)
            calls.append("plan")
            # R13/C8: "Now look at this…" refers to the screen, so the screencast starts on it
            ans = {"segments": [{"start_word": ws[0]["i"], "end_word": ws[-1]["i"], "app": "chatgpt", "session": "logged_in",
                                 "beats": [{"word_id": wid("phone"), "action": "camera.zoom", "body": "the produced phone photo, framed",
                                            "subject": "asset:phone_photo", "text": None, "url": None, "asset_id": "phone_photo",
                                            "live": False, "wait_end_word": None},
                                           {"word_id": wid("napkin"), "action": "camera.zoom", "body": "zoom on the napkin in the photo",
                                            "subject": "asset:phone_photo", "text": None, "url": None, "asset_id": "phone_photo",
                                            "live": False, "wait_end_word": None}]}],
                   "aroll": [], "plates": [], "needs_primitive": []}
        elif "overlays" in props:
            calls.append("overlays")
            ans = {"overlays": []}
        else:
            calls.append("gencheck")
            ans = {"matches": True, "missing_objects": []}
        return {"content": [{"type": "text", "text": json.dumps(ans)}], "stop_reason": "end_turn",
                "usage": {"input_tokens": 1000, "output_tokens": 200}}

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

    saved = (llm.TRANSPORT, preprod.gen_photo, preprod.rasterize, sites_mod.resolve, agentrec.scout_for, config.GEN_SPACING_S)
    prof = d / "profile"
    (prof / "Default").mkdir(parents=True)
    try:
        llm.TRANSPORT = fake_transport
        config.GEN_SPACING_S = 0.0
        preprod.gen_photo = lambda prompt, dst, **kw: (Path(dst).write_bytes(b"\x89PNG"), 0.0)[1]
        preprod.rasterize = lambda src, dst, w, h: (Path(dst).write_bytes(b"\x89PNG"), Path(dst))[1]
        sites_mod.resolve = lambda d_, r_, v_, log=print: ([{"url": "https://chatgpt.com/", "note": ""}], 0.0)
        agentrec.scout_for = lambda url: {"slug": "chatgpt", "profile": str(prof), "logged_in_at": 1, "report": ""}
        res = preprod.run(d, adapter=Fake(), log=lambda m: None)
    finally:
        (llm.TRANSPORT, preprod.gen_photo, preprod.rasterize, sites_mod.resolve, agentrec.scout_for,
         config.GEN_SPACING_S) = saved
    out = d / "preprod"
    for f in ("readiness.json", "manifest.json", "assets.json", "plan.json", "shotlist.json", "set_dressing.json",
              "dryrun.json", "expect.json"):
        check((out / f).exists(), f"factory pre-production wrote {f}")
    pdoc = json.loads((out / "plan.json").read_text())
    check(calls and calls.count("plan") == 1 and calls.count("overlays") == 1,
          f"one plan + one overlay call: {calls} {pdoc['plan'].get('plan_check')}")
    first_plan = calls.index("plan")
    check(all(c == "gencheck" for c in calls[:first_plan]) and calls[first_plan + 1:] == ["overlays"],
          f"order: assets (generation checks) → plan call → overlay call: {calls}")
    pdoc = json.loads((out / "plan.json").read_text())
    check(pdoc["order"] == ["assets", "plan_call", "plan_check", "overlay_plan"] and not pdoc["held"], f"plan.json: {pdoc['held']}")
    sl = json.loads((out / "shotlist.json").read_text())
    beats = [b for sh in sl["shots"] for b in sh["beats"]]
    check(beats and all(b["t_word"] == ws[b["word_id"]]["start"] for b in beats), "every beat on its edl word start")
    check(all({"clause_start", "subject", "technique_id", "must_text", "typed_text", "result_assertion"} <= set(b) for b in beats),
          "ledger fields on every beat")
    check(all(b["playbook_action"] == "camera.zoom" for b in beats), "the closed list (chatgpt.json proves nothing yet)")
    rd = json.loads((out / "readiness.json").read_text())
    feats = {f["id"]: f for f in rd["features"]}
    check(feats["at_sketch"]["exists"] is False and feats["at_sketch"]["alternative"], "features: @Sketch missing, '+' route")
    check(feats["pricing_in_app"]["alternative"]["route"] == "public", "features: pricing → public page")
    adoc = json.loads((out / "assets.json").read_text())
    objs = {}
    for o in adoc["objects"]:
        objs.setdefault(o["object"], o)
    check(objs["napkin"]["asset"] == "phone_photo" and objs["napkin"]["status"] == "added", f"napkin produced in the photo: {objs.get('napkin')}")
    check(objs["sun"]["asset"] == "sketch", f"the drawn sun goes into the doodle: {objs.get('sun')}")
    a = {x["id"]: x for x in adoc["assets"]}
    check("napkin" in a["phone_photo"]["source"]["prompt"], "the photo is generated with the napkin in it")
    check(a["phone_photo"]["checks"] and a["phone_photo"]["checks"][0]["matches"], "the generation was checked")
    g = json.loads((out / "gate.json").read_text())
    check(g["sites"] and g["flow"]["files"] and "plan.json" in g["flow"]["files"] and g["held"] == [] and res["usd"] > 0,
          f"gate keeps the sites + the flow: {g.get('flow')}")


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

        # p6: the plan still needs a primitive / an asset failed its check → HELD right after pre-production
        def run_held(job_dir, req, progress, log):
            (Path(job_dir) / "preprod").mkdir(exist_ok=True)
            (Path(job_dir) / "preprod" / "gate.json").write_text(json.dumps({"sites": [], "held": [
                {"reason": "needs_primitive", "detail": "'/new BG': no proven action"},
                {"reason": "needs_asset", "detail": "photo: misses napkin"}]}))
            return "plan held", 0.0
        fake.run = run_held
        sys.modules["aieditor.preprod"] = fake
        try:
            job3 = W.Job(d)
            raised = None
            try:
                W.run_preprod(job3, job3.req, json.loads((d / "source.json").read_text()), 30.0)
            except W.Held as exc:
                raised = exc
        finally:
            del sys.modules["aieditor.preprod"]
        check(raised is not None and {r["reason"] for r in raised.reasons} == {"needs_primitive", "needs_asset"},
              f"held after pre-production: {raised}")
        held_doc = json.loads((d / "held.json").read_text())
        check(len(held_doc["reasons"]) == 2, f"held.json lists both: {held_doc}")
        (d / "preprod" / "gate.json").write_text(json.dumps({"sites": [], "held": []}))
        W.longedit.clear_held(d)

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
