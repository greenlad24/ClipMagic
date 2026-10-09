"""p8 speed (recommendation step 8): the chunk planner, chunk hashes (only changed chunks re-rendered),
factory mode (no preview / 1080p compose; a 540p draft, the 4K final only when it ships) and — in ONE
short-lived aieditor-screencast container with ffmpeg testsrc/sine — a synthetic 20 s timeline rendered as
3 chunks + concat against a single render: same frame count, PSNR > 45 dB, no audio gap at the seams.

Offline only: the failed job's edit-01 blocks/overlays/cuts/camera files are a SCRATCH COPY in
tests/fixtures/p8 (copied read-only from the job); no job, server or Lab API is touched.

    python3 tests/test_chunks.py              (host: pure checks, then the render check in a container)
    python3 tests/test_chunks.py --render DIR (inside the container: the synthetic render check only)
"""
import gzip
import importlib.machinery
import importlib.util
import json
import math
import os
import shutil
import subprocess
import threading
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from aieditor import compose_long, config, longedit, render  # noqa: E402

N = 0
FPS = 30000 / 1001


def check(name, cond):
    global N
    N += 1
    if not cond:
        raise SystemExit(f"FAIL: {name}")


def kept_segments(blocks, dur):
    """The screencasts on screen = the gaps between the A-roll blocks, with compose's transition flags."""
    gaps, t = [], 0.0
    for a, b in blocks:
        if a - t > 0.05:
            gaps.append((t, a))
        t = b
    if dur - t > 0.05:
        gaps.append((t, dur))
    segs = []
    for i, (t0, t1) in enumerate(gaps):
        into_next = i + 1 < len(gaps) and abs(gaps[i + 1][0] - t1) < 0.05
        s = {"t0": t0, "t1": t1, "clip": f"sc-{i:02d}-1920.mp4", "i": i, "bubble": True, "bubble_hide": [],
             "tail": compose_long.xfade_s() if into_next else compose_long.aroll_tail_s()}
        if not into_next and t1 < dur - 0.05:
            s["aroll_out"] = True
        if segs and segs[-1].get("tail") and not segs[-1].get("aroll_out") and abs(segs[-1]["t1"] - t0) < 0.05:
            s["fade_in"] = segs[-1]["tail"]
        elif t0 > 0.05:
            s["aroll_in"] = True
        segs.append(s)
    return segs


def pure_checks():
    fx = json.load(gzip.open(ROOT / "tests" / "fixtures" / "p8" / "e2e_edit01_chunks.json.gz", "rt"))
    with tempfile.TemporaryDirectory(prefix="p8-chunks-") as td:
        w = Path(td)
        # the scratch copy, written out as the edit dir's own files
        (w / "blocks.json").write_text(json.dumps(fx["blocks"]))
        (w / "overlays.json").write_text(json.dumps(fx["overlays"]))
        (w / "aroll.cuts.json").write_text(json.dumps({"cuts": fx["cuts"]}))
        blocks = json.loads((w / "blocks.json").read_text())
        overlays = json.loads((w / "overlays.json").read_text())
        cuts = json.loads((w / "aroll.cuts.json").read_text())["cuts"]
        dur = blocks["blocks"][-1][1]

        # 1 planner on the blocks/overlays document alone (segments = the gaps between the blocks)
        ch = compose_long.plan_chunks(blocks, None, overlays, cuts)
        lens = [c["t1"] - c["t0"] for c in ch]
        check(f"plan: every chunk 30-90 s ({[round(x) for x in lens]})", all(30 <= x <= 90 for x in lens))
        check("plan: contiguous, frame-aligned, covering the whole video",
              ch[0]["f0"] == 0 and all(a["f1"] == b["f0"] for a, b in zip(ch, ch[1:]))
              and all(abs(c["t0"] - c["f0"] / FPS) < 1e-5 for c in ch) and ch[-1]["t1"] >= dur)
        segs = kept_segments(blocks["blocks"], dur)
        # windows computed independently of the planner: dissolves / xfades / bubble envelope / overlays
        wins = []
        for s in segs:
            a, b = compose_long.screen_window(s)
            wins.append((a - 4 / FPS, b + 4 / FPS, "screencast"))
        for o in overlays:
            wins.append((o["start_frame"] / FPS, o["t1"] + 0.5, "overlay " + o["template"]))
        for a, b in compose_long.gradient_spans([{**o, "n_frames": None} for o in overlays], FPS):
            wins.append((a, b, "text gradient"))
        seams = [c["t0"] for c in ch[1:]]
        bad = [(t, n) for t in seams for a, b, n in wins if a < t < b]
        check(f"plan: no seam inside a dissolve / bubble / overlay window ({bad[:3]})", not bad)
        check("plan: no seam inside a screencast at all", all(not (s["t0"] - 0.2 < t < s["t1"] + 0.2) for t in seams for s in segs))
        kinds = [c["seam"] for c in ch[1:]]
        check("plan: seams prefer the A-roll's real picture cuts / sentence starts", sum(k in ("cut", "sentence") for k in kinds) >= 1)
        # with compose's flagged segments (as longedit passes them) the plan is the same kind
        ch2 = compose_long.plan_chunks(blocks, segs, overlays, cuts, duration=dur)
        check("plan (flagged segments): 30-90 s chunks", all(30 <= c["t1"] - c["t0"] <= 90 for c in ch2))
        check("plan: a short video is one chunk", len(compose_long.plan_chunks({"blocks": [[0, 40]]}, [], [])) == 1)
        print(f"  plan_chunks (failed job edit-01): {len(ch)} chunks {[round(x, 1) for x in lens]}, seams {kinds}")

        # 2 hashes: one segment's camera.json changes -> only the chunks overlapping it
        for name, cam in fx["cameras"].items():
            (w / name).write_text(json.dumps(cam))
        for s in segs:
            if not (w / f"{s['clip']}.camera.json").exists():
                (w / f"{s['clip']}.camera.json").write_text(json.dumps({"moves": [], "seg": s["i"]}))
        rules = w / "rules.json"
        rules.write_text(json.dumps({"version": "2026-10-09", "x": 1}))
        plan = {"segments": [{"t0": s["t0"], "t1": s["t1"]} for s in segs], "overlays": overlays,
                "aroll_cuts": [{"t0": c, "t1": c} for c in cuts]}
        extra = {"size": [3840, 2160], "crf": 16}
        h1 = compose_long.chunk_hashes(w, ch2, segs, overlays, plan, rules, extra)
        check("hash: deterministic", h1 == compose_long.chunk_hashes(w, ch2, segs, overlays, plan, rules, extra))
        check("hash: one per chunk, all distinct", len(set(h1)) == len(ch2))
        tgt = segs[3]
        p = w / f"{tgt['clip']}.camera.json"
        cam = json.loads(p.read_text())
        cam["moves"] = (cam.get("moves") or []) + [{"t": 1.0, "zoom": 1.7}]
        p.write_text(json.dumps(cam))
        h2 = compose_long.chunk_hashes(w, ch2, segs, overlays, plan, rules, extra)
        changed = [i for i, (a, b) in enumerate(zip(h1, h2)) if a != b]
        a_, b_ = compose_long.screen_window(tgt)
        overl = [c["i"] for c in ch2 if c["t1"] > a_ and c["t0"] < b_]
        check(f"hash: a camera.json change invalidates only the chunk(s) it overlaps ({changed} vs {overl})",
              changed == overl and len(changed) == 1)
        # the blurred recording changing (size/mtime) does the same
        rd = w / f"seg-{tgt['i']:02d}" / "rec"
        rd.mkdir(parents=True)
        (rd / "raw.blur.mp4").write_bytes(b"x" * 10)
        h3 = compose_long.chunk_hashes(w, ch2, segs, overlays, plan, rules, extra)
        check("hash: a new blurred recording invalidates only its chunk",
              [i for i, (a, b) in enumerate(zip(h2, h3)) if a != b] == overl)
        ov2 = [dict(o) for o in overlays]
        ov2[-1]["fields"] = {"line1": "changed"}
        h4 = compose_long.chunk_hashes(w, ch2, segs, ov2, plan, rules, extra)
        last = ov2[-1]["start_frame"] / FPS
        check("hash: an overlay change invalidates only the chunk holding it",
              [i for i, (a, b) in enumerate(zip(h3, h4)) if a != b] == [c["i"] for c in ch2 if c["t0"] <= last < c["t1"]])
        rules.write_text(json.dumps({"version": "2026-10-10", "x": 1}))
        h5 = compose_long.chunk_hashes(w, ch2, segs, overlays, plan, rules, extra)
        check("hash: a rules.json version change invalidates every chunk", all(a != b for a, b in zip(h3, h5)))
        check("hash: a different output size is a different chunk",
              all(a != b for a, b in zip(h5, compose_long.chunk_hashes(w, ch2, segs, overlays, plan, rules, {**extra, "size": [960, 540]}))))

        # 3 composite_chunked reuses unchanged chunks (docker stubbed: files only)
        reuse_check(w, segs, overlays)


def reuse_check(w, segs, overlays):
    rendered = []

    def fake_run(cmd, mounts, cancelled=lambda: False, image=None, memory=None):
        out = cmd.split()[-1]
        if out.startswith("/job/"):
            Path(w / out[5:]).parent.mkdir(parents=True, exist_ok=True)
            Path(w / out[5:]).write_bytes(b"")
        if "-f mpegts" in cmd:
            rendered.append(out)
        return ""
    saved = (compose_long._run, compose_long.media.probe, compose_long.bubble_assets, compose_long.gradient_png)
    compose_long._run = fake_run
    compose_long.media.probe = lambda p: {"duration": 120.0}
    compose_long.bubble_assets = lambda job, W, H: (Path(job), 358)
    compose_long.gradient_png = lambda job, W, H: "textgrad.png"
    try:
        sg = [{"t0": 10.0, "t1": 40.0, "clip": "a.mp4", "i": 0, "aroll_in": True, "aroll_out": True, "tail": 0.13},
              {"t0": 70.0, "t1": 95.0, "clip": "b.mp4", "i": 1, "aroll_in": True, "aroll_out": True, "tail": 0.13}]
        ev = [{"template": "keyword", "t0": 50.0, "t1": 52.0, "start_frame": 1499, "n_frames": 60, "frames_dir": "ev-00", "sfx": []}]
        ch = compose_long.plan_chunks({"blocks": [[0, 10], [40, 70], [95, 120]]}, sg, ev, [], duration=120.0)
        check(f"reuse: the synthetic plan has 2+ chunks ({len(ch)})", len(ch) >= 2)
        for n in ("a", "b"):
            (w / f"{n}.mp4.camera.json").write_text(json.dumps({"moves": [n]}))
        hs = lambda: compose_long.chunk_hashes(w, ch, sg, ev, None, None, {"size": [640, 360]})
        _, man = compose_long.composite_chunked(w, "base.mp4", sg, ev, None, "out", (640, 360), FPS, [0.4, 0.2, 0.2, 0.3],
                                                ch, hashes=hs(), workers=2)
        check("reuse: first round renders every chunk", len(rendered) == len(ch))
        mf = json.loads((w / "out.chunks.json").read_text())
        check("chunks.json: {i, t0, t1, hash} per chunk", len(mf) == len(ch) and all({"i", "t0", "t1", "hash"} <= set(m) for m in mf))
        rendered.clear()
        compose_long.composite_chunked(w, "base.mp4", sg, ev, None, "out", (640, 360), FPS, [0.4, 0.2, 0.2, 0.3],
                                       ch, hashes=hs(), workers=2)
        check("reuse: nothing changed -> no chunk re-rendered", rendered == [])
        (w / "b.mp4.camera.json").write_text(json.dumps({"moves": ["b", "moved"]}))
        compose_long.composite_chunked(w, "base.mp4", sg, ev, None, "out", (640, 360), FPS, [0.4, 0.2, 0.2, 0.3],
                                       ch, hashes=hs(), workers=2)
        hit = [c for c in ch if c["t1"] > 70 and c["t0"] < 95]
        check(f"reuse: a remedy round re-renders only the changed chunk ({len(rendered)})",
              len(rendered) == 1 and f"c{hit[0]['f0']:07d}" in rendered[0])
    finally:
        compose_long._run, compose_long.media.probe, compose_long.bubble_assets, compose_long.gradient_png = saved


def factory_checks():
    check("render.draft_size: 960x540 for 4K and 1080p 16:9", render.draft_size(3840, 2160) == "960:540"
          and render.draft_size(1920, 1080) == "960:540" and render.draft_size(1080, 1920) == "540:960")
    old_env = {k: os.environ.pop(k, None) for k in ("AIEDITOR_FACTORY_MODE", "AIEDITOR_CHUNK_WORKERS")}
    try:
        check("factory mode: request.json factory=true", longedit.factory_mode({"factory": True}))
        check("factory mode: explicit false wins", not longedit.factory_mode({"factory": False, "workflow": "creative"}))
        fs = config.FACTORY_SERVER
        config.FACTORY_SERVER = True
        check("factory mode: a creative job on a factory server", longedit.factory_mode({"workflow": "creative"}))
        check("factory mode: Jake's cut workflow keeps its previews", not longedit.factory_mode({"workflow": "cut"}))
        config.FACTORY_SERVER = fs
        check("no preview for a long-form factory job", not longedit.wants_preview({"factory": True}, "long")
              and longedit.wants_preview({}, "long") and longedit.wants_preview({"factory": True}, "short"))
        check("chunk workers from the request", longedit.chunk_workers_of({"chunk_workers": 6}) == 6
              and longedit.chunk_workers_of({}) is None)
    finally:
        for k, v in old_env.items():
            if v is not None:
                os.environ[k] = v
    check("chunk workers default: one 4K chunk per 8 cores, at least 1", compose_long.chunk_workers(3840, 20) == max(1, config.cpu_count() // 8)
          and compose_long.chunk_workers(3840, 20, 3) == 3 and compose_long.chunk_workers(960, 1) == 1)

    # the factory flow with every render monkeypatched: which sizes are rendered, held vs shipped
    calls = []
    saved = (render.render, longedit.compose, render.preview_size)

    def no_preview(*a, **k):
        raise AssertionError("preview_size called in factory mode")

    with tempfile.TemporaryDirectory(prefix="p8-factory-") as td:
        d = Path(td)
        (d / "edit-01").mkdir()
        verdict = {"held": True}

        def fake_render(job, video, fps, out_name, size, **kw):
            calls.append(("render", out_name, size, kw.get("preset")))
            (Path(job) / f"{out_name}.mp4").write_bytes(b"")
            return Path(job) / f"{out_name}.mp4"

        def fake_compose(dd, k, base, fps, size, cancelled, progress, out_name, **kw):
            calls.append(("compose", out_name, tuple(size), kw.get("chunked"), kw.get("verdict", True)))
            if kw.get("verdict", True):
                (Path(dd) / "edit-01" / "verdict.json").write_text(json.dumps(verdict))
            return Path(dd) / f"{out_name}.mp4"
        render.render, longedit.compose, render.preview_size = fake_render, fake_compose, no_preview
        try:
            r = longedit.factory_edit(d, 1, {"pieces": []}, FPS, (3840, 2160), lambda: False, lambda m, f: None)
            check("factory: held draft -> no 4K render", r["held"] and r["final"] is None
                  and [c[2] for c in calls] == ["960:540", (960, 540)])
            check("factory: the draft is composed in chunks at 960x540 (draft-01)",
                  calls[1] == ("compose", "draft-01", (960, 540), True, True))
            check("factory: the 540p cut is removed afterwards", not (d / "cut540-01.mp4").exists())
            calls.clear()
            verdict = {"held": False}
            r = longedit.factory_edit(d, 1, {"pieces": []}, FPS, (3840, 2160), lambda: False, lambda m, f: None, workers=4)
            sizes = [c[2] for c in calls]
            check("factory: a shipped draft -> the 4K final, chunked, no new verdict",
                  r["final"] is not None and sizes == ["960:540", (960, 540), "3840:2160", (3840, 2160)]
                  and calls[-1] == ("compose", "final-01", (3840, 2160), True, False))
            check("factory: never a 1080p render or compose, never a preview-NN",
                  not any("1920" in str(c[2]) or "1080" in str(c[2]) or "preview" in c[1] for c in calls))
            calls.clear()
            (d / "edit-01" / "verdict.json").write_text(json.dumps({"held": True}))
            check("factory_final: a held verdict renders nothing",
                  longedit.factory_final(d, 1, {}, FPS, (3840, 2160), lambda: False, lambda m, f: None) is None and not calls)
        finally:
            render.render, longedit.compose, render.preview_size = saved

    # the worker + CLI wiring (static: the worker is a script with a main loop)
    wk = (ROOT / "bin" / "aieditor-worker").read_text()
    check("worker: the preview step is skipped through wants_preview", "longedit.wants_preview(req, fmt)" in wk)
    check("worker: factory compose = draft + 4K", "do_compose_factory if factory else do_compose_long" in wk
          and "longedit.factory_edit(" in wk and "longedit.factory_final(" in wk)
    loader = importlib.machinery.SourceFileLoader("aieditor_factory_cli", str(ROOT / "bin" / "aieditor-factory"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    cli = importlib.util.module_from_spec(spec)
    try:
        loader.exec_module(cli)
    except ImportError as exc:                           # the CLI's cloud imports are unavailable here
        print(f"  (aieditor-factory CLI parse check skipped: {exc})")
        return
    jd, acts, upd = cli.trial_options(["--factory", "--workers", "4", "/x/job", "run", "final"])
    check("aieditor-factory trial: --factory --workers N", jd == "/x/job" and acts == ["run", "final"]
          and upd == {"factory": True, "chunk_workers": 4})
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "request.json").write_text(json.dumps({"workflow": "creative"}))
        cli.set_request(td, upd)
        req = json.loads((Path(td) / "request.json").read_text())
        check("aieditor-factory: the flag + worker count travel in request.json",
              req == {"workflow": "creative", "factory": True, "chunk_workers": 4}
              and longedit.factory_mode(req) and longedit.chunk_workers_of(req) == 4)


# ── the synthetic render (inside ONE aieditor-screencast container) ─────────────────────────────────────
def sh(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(f"{cmd[:200]}: {p.stderr[-800:]}")
    return p.stdout + p.stderr


_LINK_LOCK = threading.Lock()


def local_run(cmd, mounts, cancelled=lambda: False, image=None, memory=None):
    """compose_long._run without docker: the container paths are symlinks to the mounted dirs (we ARE in a
    container). Every chunk shares the same mounts, so the links are made once."""
    with _LINK_LOCK:                   # parallel chunks call this from threads: link under one lock
        for a, b in mounts:
            b = b.split(":")[0]
            link = Path(b)
            if link.is_symlink() and os.readlink(link) == str(a):
                continue
            if link.is_symlink() or link.exists():
                link.unlink(missing_ok=True)
            link.parent.mkdir(parents=True, exist_ok=True)
            try:
                link.symlink_to(a)
            except FileExistsError:
                pass
    return sh(cmd)


def local_probe(p):
    j = json.loads(sh(f"ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate:format=duration "
                      f"-of json {p}"))
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    return {"width": v["width"], "height": v["height"], "duration": float(j["format"]["duration"])}


def frames(p):
    return int(sh(f"ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 {p}").strip())


def pcm(p):
    import numpy as np
    raw = subprocess.run(f"ffmpeg -v error -i {p} -vn -ac 1 -ar 48000 -f s16le -", shell=True, capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def synth_job(w, W, H, label):
    """A 20 s timeline at W×H: base = testsrc2 + a 440 Hz sine (the 'voice'), one screencast with A-roll
    dissolves + the bubble at 3–8 s, one keyword overlay (gradient + an SFX pop) at 11–13 s, the end fade."""
    sh(f"ffmpeg -v error -y -f lavfi -i testsrc2=s={W}x{H}:r=30000/1001:d=20 -f lavfi -i sine=f=440:r=48000:d=20 "
       f"-c:v libx264 -preset ultrafast -crf 8 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest {w}/base-{label}.mp4")
    shutil.copy(w / f"base-{label}.mp4", w / f"plain-{label}.mp4")
    sh(f"ffmpeg -v error -y -f lavfi -i testsrc=s={W}x{H}:r=30000/1001:d=6 -c:v libx264 -preset ultrafast -crf 8 "
       f"-pix_fmt yuv420p {w}/sc-{label}.mp4")
    g = w / f"gfx-{label}" / "ev-00"
    g.mkdir(parents=True, exist_ok=True)
    sf = int(round(11.0 * FPS))
    sh(f"ffmpeg -v error -y -f lavfi -i color=c=red@0.6:s={W // 3}x{H // 6}:r=30000/1001,format=rgba -frames:v 60 "
       f"-start_number {sf} {g}/f%05d.png")
    segs = [{"t0": 3.0, "t1": 8.0, "clip": f"sc-{label}.mp4", "i": 0, "bubble": True, "bubble_hide": [[1.0, 2.0]],
             "aroll_in": True, "aroll_out": True, "tail": compose_long.aroll_tail_s()}]
    events = [{"template": "keyword", "t0": 11.0, "t1": 13.0, "start_frame": sf, "frames_dir": "ev-00",
               "sfx": [[11.06, "pop"]]}]
    return segs, events, f"gfx-{label}"


def render_check(w):
    import numpy as np
    w = Path(w)
    compose_long._run = local_run
    compose_long.media.probe = local_probe
    face = [0.4, 0.2, 0.2, 0.3]
    end_fade = 18.5
    segs, events, gtag = synth_job(w, 640, 360, "360")
    kw = dict(bubble_src="plain-360.mp4", gfx_tag=gtag, end_fade_from=end_fade, crf=10, preset="veryfast")
    full = compose_long.composite(w, "base-360.mp4", segs, [dict(e) for e in events], None, "full", (640, 360), FPS, face, **kw)
    vdur = local_probe(w / "base-360.mp4")["duration"]
    ch = compose_long.plan_chunks({"blocks": [[0, 3], [8, 20]]}, segs, events, [], FPS, vdur, end_fade,
                                  min_s=4, max_s=9, target_s=7)
    check(f"render: the synthetic timeline plans as 3 chunks ({[(c['t0'], c['t1']) for c in ch]})", len(ch) == 3)
    out, man = compose_long.composite_chunked(w, "base-360.mp4", segs, [dict(e) for e in events], None, "chunked", (640, 360),
                                              FPS, face, ch, workers=2, **kw)
    nf, nc = frames(full), frames(out)
    total = compose_long._end_fade(vdur, end_fade, FPS)[3]
    check(f"render: chunked frame count == single render ({nc} vs {nf}, expected {total})", nf == nc == total)
    ps = sh(f"ffmpeg -i {full} -i {out} -lavfi '[0:v][1:v]psnr' -f null - 2>&1 | grep -o 'average:[a-z0-9.]*' | tail -1")
    v = ps.strip().split(":")[1]
    psnr = math.inf if v == "inf" else float(v)
    check(f"render: chunked vs single PSNR > 45 dB ({v})", psnr > 45)
    a_full, a_ch = pcm(full), pcm(out)
    check(f"render: the audio is as long as the picture ({len(a_ch) / 48000:.3f} s vs {nc / FPS:.3f} s)",
          abs(len(a_ch) / 48000 - nc / FPS) < 0.05)
    rms = lambda x: float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    ref = rms(a_ch[48000:96000])
    gaps = []
    for c in ch[1:]:
        s = int(c["t0"] * 48000)
        for k in range(s - 2400, s + 2400, 240):          # 5 ms windows ±50 ms around the seam
            if rms(a_ch[k:k + 240]) < 0.5 * ref:
                gaps.append(round(k / 48000, 3))
    check(f"render: no audio gap at the seams ({gaps[:4]})", not gaps)
    n = min(len(a_full), len(a_ch))
    corr = float(np.corrcoef(a_full[:n], a_ch[:n])[0, 1])
    check(f"render: the soundtrack matches the single render's (r={corr:.4f})", corr > 0.99)
    # the draft: the same chunk graph at 960x540
    segs5, events5, gtag5 = synth_job(w, 960, 540, "540")
    d_out, _ = compose_long.composite_chunked(w, "base-540.mp4", segs5, events5, None, "draft-01", (960, 540), FPS, face,
                                              ch, workers=2, bubble_src="plain-540.mp4", gfx_tag=gtag5,
                                              end_fade_from=end_fade, crf=23, preset="veryfast")
    pr = local_probe(d_out)
    check(f"render: the draft is 960x540 ({pr['width']}x{pr['height']})", (pr["width"], pr["height"]) == (960, 540))
    print(f"  synthetic render: 3 chunks + concat == single render ({nc} frames, PSNR {v} dB), "
          f"no audio gap at {len(ch) - 1} seams, draft 960x540")


def container_render():
    """One short-lived container (the aieditor-screencast image: ffmpeg + numpy/cv2 + facecam.py)."""
    if not shutil.which("docker"):
        print("  (render check skipped: no docker here)")
        return
    td = tempfile.mkdtemp(prefix="p8-render-", dir=os.environ.get("TMPDIR") or None)
    try:
        cmd = ["docker", "run", "--rm", "--name", f"aieditor-p8test-{os.getpid()}", "--cpuset-cpus", config.CPUSET,
               "--memory", "2g", "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", f"{ROOT}:/a:ro", "-v", f"{td}:/t", "--entrypoint", "python3"]
        if compose_long.sfx.LIB.exists():
            cmd[-2:-2] = ["-v", f"{compose_long.sfx.LIB}:{compose_long.sfx.LIB}:ro"]
        cmd += [config.SC_IMAGE, "/a/tests/test_chunks.py", "--render", "/t"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        sys.stdout.write(p.stdout)
        if p.returncode:
            raise SystemExit(f"FAIL: synthetic render in the container:\n{p.stderr[-2000:]}")
        check("render: the container's checks passed", "synthetic render:" in p.stdout)
    finally:
        shutil.rmtree(td, ignore_errors=True)


if __name__ == "__main__":
    if "--render" in sys.argv:
        out_dir = sys.argv[sys.argv.index("--render") + 1]
        if not compose_long.sfx.LIB.exists():
            # no SFX library mounted: the pop cue is dropped, the rest of the check stands
            compose_long.sfx.cues = lambda ev: []
        sys.dont_write_bytecode = True
        render_check(out_dir)
        print(f"test_chunks (render): {N} checks passed")
        sys.exit(0)
    sys.dont_write_bytecode = True
    pure_checks()
    factory_checks()
    if os.environ.get("AIEDITOR_SKIP_RENDER_TESTS") != "1":
        container_render()
    print(f"test_chunks: {N} checks passed")
